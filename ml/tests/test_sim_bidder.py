import random

import torch

from conftest import deal_with
from fortytwo_ml.agents.base import run_hand
from fortytwo_ml.agents import sim_bidder as sb
from fortytwo_ml.agents.sim_bidder import SimAgent, SimBidder, estimate_options
from fortytwo_ml.engine.enums import LOW_TRUMPS, PASS, PLUNGE, Suit
from fortytwo_ml.engine.hand_state import HandState, Phase
from fortytwo_ml.model import QNet


def tiny():
    torch.manual_seed(0)
    return QNet(hidden=16, layers=1).eval()


def test_estimate_options_covers_every_legal_bid_with_probabilities():
    state = HandState.deal(list(range(28)), opener=0)
    options = estimate_options(tiny(), state, 0, 4, random.Random(0))
    bids = {o.bid for o in options}
    assert set(range(30, 43)) <= bids and 84 in bids
    assert all(0.0 <= o.p_make <= 1.0 for o in options)
    assert {o.trump for o in options if o.bid == 42} >= {Suit.NONE, *LOW_TRUMPS}
    assert {o.trump for o in options if o.bid == 30} == set(range(7))


def test_estimate_options_includes_plunge_when_legal():
    deal = deal_with({0: [(0, 0), (1, 1), (2, 2), (3, 3)]})
    state = HandState.deal(deal, opener=0)
    options = estimate_options(tiny(), state, 0, 4, random.Random(0))
    assert any(o.bid == PLUNGE for o in options)


def test_sim_agents_play_full_auctions_legally():
    agent = SimAgent(tiny(), n_deals=4)
    rng = random.Random(1)
    for _ in range(3):
        order = list(range(28))
        rng.shuffle(order)
        state = HandState.deal(order, rng.randrange(4))
        run_hand(state, [agent] * 4)
        assert state.phase is Phase.DONE
    assert len(agent.decision_seconds) >= 3 and agent.last_decision is not None


def test_trump_reuses_the_bid_time_choice(monkeypatch):
    bidder = SimBidder(tiny(), n_deals=4)
    state = HandState.deal(deal_with({0: [(6, 6), (5, 6), (4, 6), (3, 6), (2, 6), (1, 6), (0, 6)]}), opener=0)
    bid = bidder.bid(state, 0)
    assert bid != PASS
    planned = bidder.last_decision.trump
    state.apply(bid)
    for _ in range(3):
        state.apply(PASS)
    monkeypatch.setattr(sb, "rollout", lambda *a, **k: (_ for _ in ()).throw(AssertionError("simulated")))
    assert bidder.trump(state, 0) == planned


def test_trump_plan_only_used_for_the_winning_bid():
    bidder = SimBidder(tiny(), n_deals=4)
    state = HandState.deal(list(range(28)), opener=0)
    bidder._planned[bidder._key(state, 0)] = (30, Suit.SIXES, 0.9)
    for bid in (30, 31, PASS, PASS):  # seat 1 outbids; seat 0 never wins at 30
        state.apply(bid)
    assert state.bidder == 1
    assert bidder._plan_for(state, 0) is None


def test_partner_plunge_trump_uses_constrained_deals():
    deal = deal_with({1: [(0, 0), (1, 1), (2, 2), (3, 3)]})
    state = HandState.deal(deal, opener=0)
    for bid in (PASS, PLUNGE, PASS, PASS):
        state.apply(bid)
    assert state.to_act == 3
    trump = SimBidder(tiny(), n_deals=4).trump(state, 3)
    assert trump in state.legal_actions()
