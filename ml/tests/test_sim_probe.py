import random
from collections import defaultdict

import numpy as np
import pytest
import torch

from conftest import deal_with
from fortytwo_ml.agents.base import run_hand
from fortytwo_ml.agents.heuristic_bot import best_suit
from fortytwo_ml.agents.model_agent import ModelAgent
from fortytwo_ml.agents.sim_bidder import estimate_options
from fortytwo_ml.engine.enums import LOW_TRUMPS, NAMED_SUITS, PASS, PLUNGE, Suit
from fortytwo_ml.engine.hand_state import Contract, HandState, partner, team_of
from fortytwo_ml.model import QNet
from fortytwo_ml.sim.deal import deal_unseen
from fortytwo_ml.sim.decide import Option
from fortytwo_ml.sim.probe import (
    BidTable, HandSims, HIGH_TRUMPS, can_plunge, options_from_table, simulate_hand, table_from_sims,
)
from fortytwo_ml.sim.rollout import rollout


def tiny():
    torch.manual_seed(0)
    return QNet(hidden=16, layers=1).eval()


def _stage2_estimate_options(model, state, seat, n_deals, rng, device=None):
    legal = [b for b in state.legal_actions() if b != PASS]
    if not legal:
        return []
    hand = state.hand(seat)
    deals = [deal_unseen(seat, hand, rng) for _ in range(n_deals)]
    points_bids = [b for b in legal if b < 42]
    high_bids = [b for b in legal if b >= 42 and b != PLUNGE]
    jobs, keys = [], []

    def add(kind, trump_for_deal):
        for d in deals:
            trump = trump_for_deal(d)
            jobs.append((d, Contract(seat, {"points": 30, "plunge": PLUNGE}.get(kind, 42), trump)))
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
    points, took = defaultdict(list), defaultdict(list)
    for key, p, t in zip(keys, result.bidder_points, result.bidder_took_trick):
        points[key].append(int(p))
        took[key].append(bool(t))
    options = []
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


def _states():
    opening = HandState.deal(list(range(28)), opener=0)
    plunge = HandState.deal(deal_with({0: [(0, 0), (1, 1), (2, 2), (3, 3)]}), opener=0)
    forced = HandState.deal(list(range(28)), opener=0)
    for _ in range(3):
        forced.apply(PASS)
    high_only = HandState.deal(list(range(28)), opener=0)
    high_only.apply(41)
    return [(opening, 0), (plunge, 0), (forced, 3), (high_only, 1)]


@pytest.mark.parametrize("index", range(4))
def test_estimate_options_matches_stage2(index):
    state, seat = _states()[index]
    model = tiny()
    assert estimate_options(model, state, seat, 6, random.Random(7)) == _stage2_estimate_options(
        model, state, seat, 6, random.Random(7)
    )


def test_simulate_hand_counts_match_one_at_a_time_play():
    model = tiny()
    hand = deal_with({0: [(0, 0), (1, 1), (2, 2), (3, 3)]})[:7]
    sims = simulate_hand(model, 0, hand, 3, random.Random(5))
    rng = random.Random(5)  # the same stream simulate_hand used, so the same deals
    deals = [deal_unseen(0, hand, rng) for _ in range(3)]
    agent = ModelAgent(model)

    def play(deal, bid, trump):
        state = HandState.from_contract(deal, 0, bid, trump, play_to_end=True)
        run_hand(state, [agent] * 4)
        return state.points[team_of(0)], any(team_of(t.winner) == team_of(0) for t in state.tricks)

    for t in NAMED_SUITS:
        expected = np.bincount([play(d, 30, t)[0] for d in deals], minlength=43)
        assert (sims.points_hist[t] == expected).all()
    for i, t in enumerate(HIGH_TRUMPS):
        assert sims.high_made[i] == sum(play(d, 42, t)[0] == 42 for d in deals)
    for i, v in enumerate(LOW_TRUMPS):
        assert sims.low_clean[i] == sum(not play(d, 42, v)[1] for d in deals)
    plunge_trumps = [best_suit(list(d[14:21]))[0] for d in deals]
    assert sims.plunge_made == sum(play(d, PLUNGE, t)[0] == 42 for d, t in zip(deals, plunge_trumps))


def test_plunge_is_simulated_only_with_four_doubles():
    model = tiny()
    weak = [1, 2, 3, 4, 5, 6, 8]  # one double (0/0 is index 0, not held; 1/1 is index 7, not held)
    assert not can_plunge(weak)
    assert simulate_hand(model, 0, weak, 2, random.Random(0)).plunge_made is None
    strong = deal_with({0: [(0, 0), (1, 1), (2, 2), (3, 3)]})[:7]
    assert can_plunge(strong)
    assert simulate_hand(model, 0, strong, 2, random.Random(0)).plunge_made is not None


def test_kinds_limit_the_probes():
    sims = simulate_hand(tiny(), 0, [1, 2, 3, 4, 5, 6, 8], 2, random.Random(0), kinds=frozenset({"points"}))
    assert sims.points_hist is not None and sims.high_made is None and sims.low_clean is None


def test_options_from_table_reads_a_hand_built_table():
    points = np.zeros((7, 12))
    points[Suit.SIXES] = np.linspace(0.9, 0.35, 12)  # 30 -> 0.9 ... 41 -> 0.35
    table = BidTable(points, np.full(8, 0.2), np.array([0.1, 0.6, 0.3]), None)
    options = options_from_table(table, [PASS, 32, 42, 84])
    assert Option(32, Suit.SIXES, pytest.approx(0.8)) in options
    assert Option(84, Suit.LOW_DOUBLES_LOW, 0.6) in options and Option(42, Suit.NONE, 0.2) in options
    assert not any(o.bid == PLUNGE for o in options)


def test_table_from_sims_turns_counts_into_probabilities():
    hist = np.zeros((7, 43), dtype=np.int64)
    hist[:, 29] = 1  # one deal with 29 points
    hist[:, 35] = 3  # three with 35
    table = table_from_sims(HandSims(4, hist, np.full(8, 2), np.full(3, 1), None))
    assert table.points[0, 0] == 0.75 and table.points[0, 35 - 30] == 0.75 and table.points[0, 36 - 30] == 0.0
    assert (table.high == 0.5).all() and (table.low == 0.25).all() and table.plunge is None
