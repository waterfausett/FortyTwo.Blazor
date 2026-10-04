import random

import numpy as np
import torch

from conftest import deal_with
from fortytwo_ml.agents.base import run_hand
from fortytwo_ml.agents.bid_support import bid_context
from fortytwo_ml.agents.fast_bidder import FastAgent, FastBidder, play_checkpoint_mismatch
from fortytwo_ml.agents.heuristic_bot import best_suit
from fortytwo_ml.bidding.model import BidNet
from fortytwo_ml.engine.enums import PASS, PLUNGE, Suit
from fortytwo_ml.engine.hand_state import HandState, Phase
from fortytwo_ml.model import QNet, save_checkpoint
from fortytwo_ml.sim.decide import BidDecision, DecideConfig, choose_bid
from fortytwo_ml.sim.probe import BidTable, options_from_table


class StubNet:
    """A BidNet stand-in that predicts one fixed table."""

    def __init__(self, table):
        self._table = table

    def eval(self):
        return self

    def table(self, hand):
        return self._table


def _table(sixes_30=0.9):
    points = np.full((7, 12), 0.1)
    points[Suit.SIXES] = np.linspace(sixes_30, 0.2, 12)
    return BidTable(points, np.full(8, 0.1), np.full(3, 0.1), None)


def test_bids_what_choose_bid_picks_for_the_table():
    state = HandState.deal(list(range(28)), opener=0)
    table = _table()
    expected = choose_bid(options_from_table(table, state.legal_actions()), bid_context(state, 0), DecideConfig(0.6, 0.9))
    bidder = FastBidder(StubNet(table))
    assert bidder.bid(state, 0) == expected.bid != PASS
    assert bidder.last_decision == expected and len(bidder.decision_seconds) == 1


def test_names_the_planned_trump_for_its_winning_bid():
    bidder = FastBidder(StubNet(_table()))
    state = HandState.deal(list(range(28)), opener=0)
    bid = bidder.bid(state, 0)
    for b in (bid, PASS, PASS, PASS):
        state.apply(b)
    assert bidder.trump(state, 0) == Suit.SIXES and bidder.plans.predicted_make(state, 0) is not None


def test_plan_only_used_for_the_winning_bid():
    bidder = FastBidder(StubNet(_table()))
    state = HandState.deal(list(range(28)), opener=0)
    bidder.plans.record(state, 0, BidDecision(30, Suit.FIVES, 0.9, ()))
    for b in (30, 31, PASS, PASS):
        state.apply(b)
    assert bidder.plans.current(state, 0) is None


def test_trump_without_a_plan_uses_the_table_at_the_actual_bid():
    bidder = FastBidder(StubNet(_table()))
    state = HandState.deal(list(range(28)), opener=0)
    for b in (PASS, PASS, PASS, 30):  # seat 3 bids 30 without asking this bidder
        state.apply(b)
    assert bidder.trump(state, 3) == Suit.SIXES


def test_partner_plunge_trump_is_the_heuristic_suit():
    state = HandState.deal(deal_with({1: [(0, 0), (1, 1), (2, 2), (3, 3)]}), opener=0)
    for b in (PASS, PLUNGE, PASS, PASS):
        state.apply(b)
    assert FastBidder(StubNet(_table())).trump(state, 3) == best_suit(state.hand(3))[0]


def test_fast_agents_play_full_auctions_legally():
    torch.manual_seed(0)
    agent = FastAgent(BidNet(hidden=16, layers=1), QNet(hidden=16, layers=1))
    rng = random.Random(1)
    for _ in range(5):
        order = list(range(28))
        rng.shuffle(order)
        state = HandState.deal(order, rng.randrange(4))
        run_hand(state, [agent] * 4)
        assert state.phase is Phase.DONE
    assert len(agent.decision_seconds) >= 5


def test_play_checkpoint_mismatch(tmp_path):
    path = tmp_path / "run" / "m.pt"
    path.parent.mkdir()
    save_checkpoint(path, QNet(hidden=16, layers=1), step=7, config={})
    assert play_checkpoint_mismatch({"play_checkpoint": "run/m.pt", "play_step": 7}, str(path)) is None
    assert "step 3" in play_checkpoint_mismatch({"play_checkpoint": "run/m.pt", "play_step": 3}, str(path))
