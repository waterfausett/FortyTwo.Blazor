from fortytwo_ml.engine.dominoes import (
    FULL_MASK, IS_DOUBLE, PIPS, VALUE, doubles_in, domino_id, from_id, from_mask, index_of, to_mask,
)
from fortytwo_ml.engine.enums import ALL_TRUMPS, Bid, Suit, is_low


def test_there_are_28_dominoes_in_ts_generation_order():
    assert len(PIPS) == 28
    assert PIPS[0] == (0, 0)
    assert PIPS[1] == (0, 1)
    assert PIPS[7] == (1, 1)
    assert PIPS[27] == (6, 6)


def test_ids_round_trip_and_ignore_orientation():
    for d in range(28):
        assert from_id(domino_id(d)) == d
    assert index_of(5, 3) == index_of(3, 5)
    assert domino_id(index_of(5, 3)) == "3/5"
    assert from_id("5/3") == index_of(3, 5)


def test_count_dominoes_total_35_points():
    counts = {domino_id(d): VALUE[d] for d in range(28) if VALUE[d]}
    assert counts == {"0/5": 5, "1/4": 5, "2/3": 5, "5/5": 10, "4/6": 10}


def test_seven_doubles():
    assert sum(IS_DOUBLE) == 7
    assert doubles_in(to_mask([index_of(1, 1), index_of(2, 2), index_of(0, 3)])) == 2


def test_masks_round_trip():
    assert from_mask(to_mask([27, 0, 5])) == [0, 5, 27]
    assert to_mask(range(28)) == FULL_MASK


def test_enums_match_ts_values():
    assert Suit.LOW_DOUBLES_OWN_SUIT == -4 and Suit.NONE == -1 and Suit.DOUBLES == 7
    assert Bid.PLUNGE == 169 and Bid.EIGHTY_FOUR == 84 and Bid.SEVEN_MARKS == 294
    assert len(ALL_TRUMPS) == 11 and Suit.DOUBLES not in ALL_TRUMPS
    assert is_low(Suit.LOW_DOUBLES_LOW) and not is_low(Suit.NONE) and not is_low(None)
