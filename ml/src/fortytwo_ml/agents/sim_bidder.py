"""Bidding by simulation: deal the unseen dominoes many times, play each deal out with the
Stage 1 play model, and bid on the estimated chance of making each (bid, trump) option.
v1 looks only at its own hand (plus two public facts: who holds the high bid, and that a
plunger holds four doubles)."""
import random
import time
from pathlib import Path

import numpy as np
import torch

from ..engine.enums import PASS, PLUNGE
from ..engine.hand_state import Contract, HandState
from ..model import QNet, load_checkpoint
from ..sim.deal import deal_unseen
from ..sim.decide import DEFAULT_MAKE_THRESHOLD, BidDecision, DecideConfig, Option, choose_bid
from ..sim.probe import kinds_for, options_from_table, simulate_hand, table_from_sims
from ..sim.rollout import rollout
from .bid_support import BidPlans, bid_context
from .model_agent import ModelAgent


def estimate_options(
    model: QNet, state: HandState, seat: int, n_deals: int, rng: random.Random, device=None
) -> list[Option]:
    legal = state.legal_actions()
    if not any(b != PASS for b in legal):
        return []
    sims = simulate_hand(model, seat, state.hand(seat), n_deals, rng, device, kinds_for(legal))
    return options_from_table(table_from_sims(sims), legal)


class SimBidder:
    name = "sim"

    def __init__(self, model: QNet, n_deals: int = 200, make_threshold: float = DEFAULT_MAKE_THRESHOLD,
                 overbid_partner_threshold: float = 0.9, seed: int = 0, device=None):
        self.model = model.eval()
        self.n_deals = n_deals
        self.config = DecideConfig(make_threshold, overbid_partner_threshold)
        self.rng = random.Random(f"sim-bidder:{seed}")
        self.device = torch.device(device) if device is not None else next(model.parameters()).device
        self.plans = BidPlans()
        self.last_decision: BidDecision | None = None
        self.decision_seconds: list[float] = []

    def reseed(self, key: str) -> None:
        """Restart the simulation stream from `key`, so a hand's simulations don't depend on what
        this bidder simulated before (the arena reseeds per hand; results then don't depend on how
        deals are split across workers)."""
        self.rng = random.Random(f"sim-bidder:{key}")

    def predicted_make(self, state: HandState, seat: int) -> float | None:
        return self.plans.predicted_make(state, seat)

    def bid(self, state: HandState, seat: int) -> int:
        start = time.perf_counter()
        options = estimate_options(self.model, state, seat, self.n_deals, self.rng, self.device)
        ctx = bid_context(state, seat)
        decision = choose_bid(options, ctx, self.config)
        self.decision_seconds.append(time.perf_counter() - start)
        self.last_decision = decision
        self.plans.record(state, seat, decision)
        return decision.bid

    def trump(self, state: HandState, seat: int) -> int:
        legal = state.legal_actions()
        if state.high_bid == PLUNGE and state.bidder != seat:
            return self._best_trump(state, seat, legal, require=(state.bidder, 4), bidder=state.bidder)
        plan = self.plans.current(state, seat)
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

    def reseed(self, key: str) -> None:
        self.bidder.reseed(key)

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
