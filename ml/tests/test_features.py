import numpy as np

from fortytwo_ml.engine.bidding import CONTRACT_BIDS
from fortytwo_ml.engine.dominoes import from_id
from fortytwo_ml.engine.enums import ALL_TRUMPS, PLUNGE, Suit
from fortytwo_ml.engine.hand_state import HandState
from fortytwo_ml.features import (
    A_BOSS, A_CLOSES, A_COUNT, A_FOLLOWS, A_IS_DOUBLE, A_IS_TRUMP, A_OVERTAKES_PARTNER, A_RANK, A_TRICK_POINTS,
    A_WINS_NOW, ACTION_DIM, BID, BIDDER, HAND, INPUT_DIM, LED, OBS_DIM, PLAYED, PLUNGE_FLAG, SCALARS, SITS_OUT,
    TRICK, TRUMP, VOIDS, encode_actions, encode_observation,
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
    assert OBS_DIM == 325 and ACTION_DIM == 38 and INPUT_DIM == 363
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
        assert row[OBS_DIM + a] == 1 and row[OBS_DIM:OBS_DIM + 28].sum() == 1
        assert np.array_equal(row[:OBS_DIM], xs[0, :OBS_DIM])


F0 = OBS_DIM + 28  # first action-feature column


def _features(state, seat, domino):
    row = encode_actions(state, seat, [domino])[0]
    return row[F0:F0 + 10]


def test_lead_features_for_the_top_trump():
    state = HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.SIXES)
    f = _features(state, 0, d("6/6"))
    assert f[A_IS_TRUMP] == 1 and f[A_IS_DOUBLE] == 1 and f[A_COUNT] == 0
    assert f[A_FOLLOWS] == 0 and f[A_WINS_NOW] == 0 and f[A_CLOSES] == 0
    assert np.isclose(f[A_RANK], 8 / 18)
    assert f[A_BOSS] == 1  # the only unseen six is 0/6, which ranks below the double
    assert np.isclose(f[A_TRICK_POINTS], 1 / 42)


def test_lead_features_for_a_low_off_suit_domino():
    state = HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.SIXES)
    f = _features(state, 0, d("0/1"))
    assert f[A_IS_TRUMP] == 0 and np.isclose(f[A_RANK], 1 / 18)
    assert f[A_BOSS] == 0  # unseen aces like 1/1 outrank it


def test_following_features():
    state = HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.SIXES)
    state.apply(d("0/1"))
    f = _features(state, 1, d("1/4"))
    assert f[A_FOLLOWS] == 1 and f[A_WINS_NOW] == 1 and f[A_OVERTAKES_PARTNER] == 0
    assert np.isclose(f[A_RANK], 5 / 18) and np.isclose(f[A_COUNT], 0.5)
    assert np.isclose(f[A_TRICK_POINTS], 6 / 42) and f[A_BOSS] == 0


def test_overtaking_partner_and_closing_the_trick():
    state = HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.SIXES)
    for x in ("0/1", "1/2", "0/3"):
        state.apply(d(x))
    f = _features(state, 3, d("0/6"))  # seat 3 has no aces; 0/6 trumps partner seat 1's 1/2
    assert f[A_WINS_NOW] == 1 and f[A_OVERTAKES_PARTNER] == 1 and f[A_CLOSES] == 1
    assert f[A_FOLLOWS] == 0 and f[A_IS_TRUMP] == 1
    g = _features(state, 3, d("3/3"))
    assert g[A_WINS_NOW] == 0 and g[A_OVERTAKES_PARTNER] == 0 and g[A_RANK] == 0


def test_low_trick_closes_at_three():
    state = HandState.from_contract(DEAL, bidder=0, bid=42, trump=Suit.LOW)
    state.apply(d("6/6"))
    state.apply(d("0/0"))
    assert _features(state, 3, d("0/6"))[A_CLOSES] == 1


def test_hidden_hands_never_change_the_encoding():
    # Seats 0 and 1 keep their hands; seats 2 and 3 swap theirs. Seat 1's view must not change.
    swapped = [d(x) for seat in (0, 1, 3, 2) for x in HANDS[seat]]
    views = []
    for deal in (DEAL, swapped):
        state = HandState.from_contract(deal, bidder=0, bid=30, trump=Suit.SIXES)
        state.apply(d("0/1"))
        views.append(encode_actions(state, 1, state.legal_actions()))
    assert np.array_equal(views[0], views[1])
    fresh = [encode_actions(HandState.from_contract(deal, 0, 30, Suit.SIXES), 0, [d("6/6"), d("0/1")])
             for deal in (DEAL, swapped)]
    assert np.array_equal(fresh[0], fresh[1])
