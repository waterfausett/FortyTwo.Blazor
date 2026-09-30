import numpy as np

from fortytwo_ml.engine.bidding import CONTRACT_BIDS
from fortytwo_ml.engine.dominoes import from_id
from fortytwo_ml.engine.enums import ALL_TRUMPS, PLUNGE, Suit
from fortytwo_ml.engine.hand_state import HandState
from fortytwo_ml.features import (
    BID, BIDDER, HAND, INPUT_DIM, LED, OBS_DIM, PLAYED, PLUNGE_FLAG, SCALARS, SITS_OUT, TRICK, TRUMP,
    VOIDS, encode_actions, encode_observation,
)
from conftest import deal_with

d = from_id
HANDS = {
    0: ["0/1", "6/6", "5/6", "4/6", "3/6", "2/6", "1/6"],
    1: ["1/5", "1/1", "1/2", "1/3", "1/4", "0/0", "0/2"],
    2: ["0/3", "0/4", "0/5", "2/2", "2/3", "2/4", "2/5"],
    3: ["0/6", "3/3", "3/4", "3/5", "4/4", "4/5", "5/5"],
}
DEAL = [d(x) for seat in range(4) for x in HANDS[seat]]


def test_dimensions():
    assert OBS_DIM == 325 and INPUT_DIM == 353
    assert SCALARS + 3 == OBS_DIM


def test_own_hand_and_contract_blocks():
    state = HandState.from_contract(DEAL, bidder=0, bid=35, trump=Suit.SIXES)
    x = encode_observation(state, 1)
    assert x.dtype == np.float32 and x.shape == (OBS_DIM,)
    assert {i for i in range(28) if x[HAND + i]} == {d(s) for s in HANDS[1]}
    assert x[TRUMP + ALL_TRUMPS.index(Suit.SIXES)] == 1 and x[TRUMP:TRUMP + 11].sum() == 1
    assert x[BID + CONTRACT_BIDS.index(35)] == 1
    assert x[BIDDER + 3] == 1  # bidder seat 0 is seat 1's right-hand opponent (relative seat 3)
    assert x[LED + 8] == 1  # no trick started
    assert x[PLUNGE_FLAG] == 0 and x[SITS_OUT] == 0


def test_seats_are_relative_to_the_actor():
    state = HandState.from_contract(DEAL, bidder=0, bid=35, trump=Suit.SIXES)
    state.apply(d("0/1"))
    x = encode_observation(state, 1)
    assert x[PLAYED + 3 * 28 + d("0/1")] == 1
    assert x[TRICK + 3 * 28 + d("0/1")] == 1
    assert x[LED + Suit.ACES] == 1


def test_voids_are_inferred_from_failing_to_follow():
    state = HandState.from_contract(DEAL, bidder=0, bid=35, trump=Suit.SIXES)
    for s in ("0/1", "1/5", "0/3"):
        state.apply(d(s))
    x = encode_observation(state, 3)
    # Seat 2 is relative seat 3 from seat 3, so its row is (3 - 1) in the voids block.
    assert x[VOIDS + 2 * 8 + Suit.ACES] == 1
    assert x[VOIDS:VOIDS + 24].sum() == 1


def test_plunge_and_sits_out_flags():
    deal = deal_with({1: [(0, 0), (1, 1), (2, 2), (3, 3)]})
    x = encode_observation(HandState.from_contract(deal, bidder=1, bid=PLUNGE, trump=Suit.NONE), 3)
    assert x[PLUNGE_FLAG] == 1
    low = HandState.from_contract(DEAL, bidder=0, bid=42, trump=Suit.LOW)
    assert encode_observation(low, 0)[SITS_OUT] == 1
    assert encode_observation(low, 1)[SITS_OUT] == 0


def test_scalars_track_points_and_tricks():
    state = HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.SIXES)
    for s in ("0/1", "1/5", "0/3", "3/3"):
        state.apply(d(s))
    x = encode_observation(state, 1)
    assert np.allclose(x[SCALARS:SCALARS + 3], [1 / 42, 0, 1 / 7])


def test_encode_actions_appends_a_one_hot_candidate():
    state = HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.SIXES)
    legal = state.legal_actions()
    xs = encode_actions(state, 0, legal)
    assert xs.shape == (len(legal), INPUT_DIM)
    for row, a in zip(xs, legal):
        assert row[OBS_DIM + a] == 1 and row[OBS_DIM:].sum() == 1
        assert np.array_equal(row[:OBS_DIM], xs[0, :OBS_DIM])
