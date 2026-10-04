"""Bidding in milliseconds: BidNet predicts the hand's P(make) table, and the same choose_bid rules
the simulation bidder uses decide from it."""
import time
from pathlib import Path

from ..engine.enums import PLUNGE
from ..engine.hand_state import HandState
from ..model import QNet, load_checkpoint
from ..bidding.data import checkpoint_label
from ..bidding.model import BidNet, load_bidnet
from ..sim.decide import DEFAULT_MAKE_THRESHOLD, BidDecision, DecideConfig, choose_bid
from ..sim.probe import options_from_table
from .bid_support import BidPlans, bid_context
from .heuristic_bot import best_suit
from .model_agent import ModelAgent


class FastBidder:
    name = "fast"

    def __init__(self, bidnet: BidNet, make_threshold: float = DEFAULT_MAKE_THRESHOLD,
                 overbid_partner_threshold: float = 0.9):
        self.bidnet = bidnet.eval()
        self.config = DecideConfig(make_threshold, overbid_partner_threshold)
        self.plans = BidPlans()
        self.last_decision: BidDecision | None = None
        self.decision_seconds: list[float] = []

    def reseed(self, key: str) -> None:
        """Deterministic already; here so the arena can treat every bidder alike."""

    def bid(self, state: HandState, seat: int) -> int:
        start = time.perf_counter()
        options = options_from_table(self.bidnet.table(state.hand(seat)), state.legal_actions())
        decision = choose_bid(options, bid_context(state, seat), self.config)
        self.decision_seconds.append(time.perf_counter() - start)
        self.last_decision = decision
        self.plans.record(state, seat, decision)
        return decision.bid

    def trump(self, state: HandState, seat: int) -> int:
        legal = state.legal_actions()
        if state.high_bid == PLUNGE and state.bidder != seat:
            return best_suit(state.hand(seat))[0]  # partner's plunge: rare, so the heuristic suit
        plan = self.plans.current(state, seat)
        if plan is not None and plan[1] in legal:
            return plan[1]
        at_bid = [o for o in options_from_table(self.bidnet.table(state.hand(seat)), [state.high_bid]) if o.trump in legal]
        return max(at_bid, key=lambda o: o.p_make).trump if at_bid else legal[0]

    def play(self, state: HandState, seat: int) -> int:
        raise NotImplementedError("FastBidder only bids and names trump; use FastAgent to play")


class FastAgent:
    """A complete bot: BidNet bidding and trump, Stage 1 model play."""

    def __init__(self, bidnet: BidNet, play_model: QNet, name: str = "fast", meta: dict | None = None, **kwargs):
        self.name = name
        self.meta = meta or {}
        self.bidder = FastBidder(bidnet, **kwargs)
        self.player = ModelAgent(play_model)

    @classmethod
    def from_files(cls, bidnet_path: str | Path, play_path: str | None = None, **kwargs) -> "FastAgent":
        bidnet, meta = load_bidnet(bidnet_path)
        play_path = play_path or meta["play_path"]
        if not Path(play_path).is_file():
            raise FileNotFoundError(f"no play checkpoint at {play_path} (recorded in {bidnet_path})")
        play_model, _ = load_checkpoint(play_path)
        return cls(bidnet, play_model, name=f"fast:{Path(bidnet_path).parent.name}", meta=meta, **kwargs)

    def bid(self, state: HandState, seat: int) -> int:
        return self.bidder.bid(state, seat)

    def trump(self, state: HandState, seat: int) -> int:
        return self.bidder.trump(state, seat)

    def play(self, state: HandState, seat: int) -> int:
        return self.player.play(state, seat)

    def reseed(self, key: str) -> None:
        self.bidder.reseed(key)

    @property
    def decision_seconds(self) -> list[float]:
        return self.bidder.decision_seconds

    @property
    def last_decision(self) -> BidDecision | None:
        return self.bidder.last_decision

    def predicted_make(self, state: HandState, seat: int) -> float | None:
        return self.bidder.plans.predicted_make(state, seat)


def play_checkpoint_mismatch(meta: dict, model_path: str) -> str | None:
    """A warning when a bidnet's training data came from a different play model than `model_path`."""
    _, info = load_checkpoint(model_path)
    here = (checkpoint_label(model_path), info["step"])
    there = (meta.get("play_checkpoint"), meta.get("play_step"))
    if here == there:
        return None
    return (f"warning: this bidnet was trained on simulations by {there[0]} (step {there[1]}), "
            f"but the play model is {here[0]} (step {here[1]}); the comparison still isolates bidding")
