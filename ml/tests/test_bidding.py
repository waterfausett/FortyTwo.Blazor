from fortytwo_ml.engine.bidding import (
    CONTRACT_BIDS, available_bids, available_trumps, marks_for, target_points,
)
from fortytwo_ml.engine.enums import LOW_TRUMPS, NAMED_SUITS, PASS, PLUNGE, Suit

POINTS = list(range(30, 43))


def test_opening_bids_are_pass_points_and_84():
    assert available_bids(None, 0, 0) == [PASS, *POINTS, 84]


def test_bids_must_go_higher():
    assert available_bids(35, 1, 0) == [PASS, *range(36, 43), 84]


def test_marks_climb_one_rung_at_a_time():
    assert available_bids(42, 0, 0) == [PASS, 84]
    assert available_bids(84, 1, 0) == [PASS, 126]
    assert available_bids(126, 1, 0) == [PASS, 168]


def test_last_bidder_is_forced_when_three_passed():
    assert available_bids(None, 3, 0) == [*POINTS, 84]


def test_plunge_needs_four_doubles_and_a_high_bid_under_four_marks():
    assert PLUNGE not in available_bids(None, 0, 3)
    assert PLUNGE in available_bids(None, 0, 4)
    assert PLUNGE in available_bids(126, 0, 4)
    assert available_bids(168, 0, 4) == [PASS, 210]


def test_five_marks_is_allowed_over_a_plunge():
    assert available_bids(PLUNGE, 0, 0) == [PASS, 210]


def test_trumps_by_bid():
    assert available_trumps(30) == list(NAMED_SUITS)
    assert available_trumps(42) == [*NAMED_SUITS, Suit.NONE, *LOW_TRUMPS]
    assert available_trumps(84) == [*NAMED_SUITS, Suit.NONE, *LOW_TRUMPS]
    assert available_trumps(PLUNGE) == [*NAMED_SUITS, Suit.NONE]


def test_marks_and_targets():
    assert [marks_for(b) for b in (30, 42, 84, 126, PLUNGE, 294)] == [1, 1, 2, 3, 4, 7]
    assert [target_points(b) for b in (30, 35, 42, 84, PLUNGE)] == [30, 35, 42, 42, 42]


def test_contract_bids_has_twenty_non_pass_bids():
    assert len(CONTRACT_BIDS) == 20 and PASS not in CONTRACT_BIDS and PLUNGE in CONTRACT_BIDS
