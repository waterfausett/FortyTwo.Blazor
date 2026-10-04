"""Bidding by simulation: deal the unseen dominoes many times, play each deal out with the
Stage 1 play model, and bid on the estimated chance of making each (bid, trump) option.
v1 looks only at its own hand (plus two public facts: who holds the high bid, and that a
plunger holds four doubles)."""
import random
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch

from ..engine.enums import LOW_TRUMPS, NAMED_SUITS, PASS, PLUNGE, Suit
from ..engine.hand_state import Contract, HandState, partner
from ..model import QNet, load_checkpoint
from ..sim.deal import deal_unseen
from ..sim.decide import BidContext, BidDecision, DecideConfig, Option, choose_bid
from ..sim.rollout import rollout
from .heuristic_bot import best_suit
from .model_agent import ModelAgent

POINTS_PROBE = 30  # suits played as a 30 bid answer every points bid (30..41)
HIGH_PROBE = 42    # suits, follow-me and Low played as a 42 bid answer 42 and the marks bids


def estimate_options(
    model: QNet, state: HandState, seat: int, n_deals: int, rng: random.Random, device=None
) -> list[Option]:
    legal = [b for b in state.legal_actions() if b != PASS]
    if not legal:
        return []
    hand = state.hand(seat)
    deals = [deal_unseen(seat, hand, rng) for _ in range(n_deals)]
    points_bids = [b for b in legal if b < HIGH_PROBE]
    high_bids = [b for b in legal if b >= HIGH_PROBE and b != PLUNGE]

    jobs: list[tuple[list[int], Contract]] = []
    keys: list[tuple[str, int]] = []

    def add(kind: str, trump_for_deal) -> None:
        for d in deals:
            trump = trump_for_deal(d)
            jobs.append((d, Contract(seat, {"points": POINTS_PROBE, "plunge": PLUNGE}.get(kind, HIGH_PROBE), trump)))
            keys.append((kind, trump if kind != "plunge" else -1))

    if points_bids:
        for t in NAMED_SUITS:
            add("points", lambda d, t=t: t)
    if high_bids:
        for t in (*NAMED_SUITS, Suit.NONE):
            add("high", lambda d, t=t: t)
        for v in LOW_TRUMPS:
            add("low", lambda d, v=v: v)
    if PLUNGE in legal:
        mate = partner(seat)
        add("plunge", lambda d: best_suit(list(d[mate * 7:(mate + 1) * 7]))[0])

    result = rollout(model, jobs, device)
    points: dict[tuple[str, int], list[int]] = defaultdict(list)
    took: dict[tuple[str, int], list[bool]] = defaultdict(list)
    for key, p, t in zip(keys, result.bidder_points, result.bidder_took_trick):
        points[key].append(int(p))
        took[key].append(bool(t))

    options: list[Option] = []
    for t in NAMED_SUITS if points_bids else ():
        pts = np.array(points[("points", t)])
        options += [Option(b, t, float(np.mean(pts >= b))) for b in points_bids]
    if high_bids:
        for t in (*NAMED_SUITS, Suit.NONE):
            p = float(np.mean(np.array(points[("high", t)]) == 42))
            options += [Option(b, t, p) for b in high_bids]
        for v in LOW_TRUMPS:
            p = float(np.mean(~np.array(took[("low", v)])))
            options += [Option(b, v, p) for b in high_bids]
    if PLUNGE in legal:
        options.append(Option(PLUNGE, Suit.NONE, float(np.mean(np.array(points[("plunge", -1)]) == 42))))
    return options


# Tuned on stage1-c: over the same 300 deals, 0.5/0.55/0.6 scored +0.390/+0.467/+0.497 marks/deal
# against heuristic bidding. Fewer coin-flip bids, a higher made rate, and the auctions given up cost nothing.
DEFAULT_MAKE_THRESHOLD = 0.6


class SimBidder:
    name = "sim"

    def __init__(self, model: QNet, n_deals: int = 200, make_threshold: float = DEFAULT_MAKE_THRESHOLD,
                 overbid_partner_threshold: float = 0.9, seed: int = 0, device=None):
        self.model = model.eval()
        self.n_deals = n_deals
        self.config = DecideConfig(make_threshold, overbid_partner_threshold)
        self.rng = random.Random(f"sim-bidder:{seed}")
        self.device = torch.device(device) if device is not None else next(model.parameters()).device
        self._planned: dict[tuple, tuple[int, int | None, float]] = {}  # (seat, hand) -> (bid, trump, p_make)
        self.last_decision: BidDecision | None = None
        self.decision_seconds: list[float] = []

    @staticmethod
    def _key(state: HandState, seat: int) -> tuple:
        return seat, tuple(sorted(state.dealt[seat]))

    def _plan_for(self, state: HandState, seat: int) -> tuple[int, int | None, float] | None:
        plan = self._planned.get(self._key(state, seat))
        return plan if plan is not None and state.bidder == seat and plan[0] == state.high_bid else None

    def predicted_make(self, state: HandState, seat: int) -> float | None:
        plan = self._plan_for(state, seat)
        return plan[2] if plan else None

    def bid(self, state: HandState, seat: int) -> int:
        start = time.perf_counter()
        options = estimate_options(self.model, state, seat, self.n_deals, self.rng, self.device)
        others = [s for s in range(4) if s != seat]
        ctx = BidContext(
            legal=state.legal_actions(),
            partner_holds=state.bidder is not None and state.bidder == partner(seat),
            last_to_bid=all(state.bids[s] is not None for s in others),
        )
        decision = choose_bid(options, ctx, self.config)
        self.decision_seconds.append(time.perf_counter() - start)
        self.last_decision = decision
        if decision.bid != PASS:
            trump = None if decision.bid == PLUNGE else decision.trump
            self._planned[self._key(state, seat)] = (decision.bid, trump, decision.p_make)
        return decision.bid

    def trump(self, state: HandState, seat: int) -> int:
        legal = state.legal_actions()
        if state.high_bid == PLUNGE and state.bidder != seat:
            return self._best_trump(state, seat, legal, require=(state.bidder, 4), bidder=state.bidder)
        plan = self._plan_for(state, seat)
        if plan is not None and plan[1] in legal:
            return plan[1]
        return self._best_trump(state, seat, legal, require=None, bidder=seat)

    def _best_trump(self, state: HandState, seat: int, legal, require, bidder: int) -> int:
        hand = state.hand(seat)
        deals = [deal_unseen(seat, hand, self.rng, require=require) for _ in range(self.n_deals)]
        jobs = [(d, Contract(bidder, state.high_bid, t)) for t in legal for d in deals]
        won = rollout(self.model, jobs, self.device).bidders_won.reshape(len(legal), len(deals))
        return legal[int(np.argmax(won.mean(axis=1)))]

    def play(self, state: HandState, seat: int) -> int:
        raise NotImplementedError("SimBidder only bids and names trump; use SimAgent to play")


class SimAgent:
    """A complete bot: simulation bidding and trump, Stage 1 model play."""

    def __init__(self, model: QNet, name: str = "sim", **kwargs):
        self.name = name
        self.bidder = SimBidder(model, **kwargs)
        self.player = ModelAgent(model)

    @classmethod
    def from_checkpoint(cls, path: str | Path, **kwargs) -> "SimAgent":
        model, _ = load_checkpoint(path)
        return cls(model, name=f"sim:{Path(path).name}", **kwargs)

    def bid(self, state: HandState, seat: int) -> int:
        return self.bidder.bid(state, seat)

    def trump(self, state: HandState, seat: int) -> int:
        return self.bidder.trump(state, seat)

    def play(self, state: HandState, seat: int) -> int:
        return self.player.play(state, seat)

    @property
    def decision_seconds(self) -> list[float]:
        return self.bidder.decision_seconds

    @property
    def last_decision(self) -> BidDecision | None:
        return self.bidder.last_decision

    def predicted_make(self, state: HandState, seat: int) -> float | None:
        return self.bidder.predicted_make(state, seat)
