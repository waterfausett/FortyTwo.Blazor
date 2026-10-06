import pytest

from fortytwo_ml.engine.dominoes import from_id, to_mask
from fortytwo_ml.engine.enums import ALL_TRUMPS, Suit
from fortytwo_ml.engine.rules import (
    get_suit, get_suit_value, is_of_suit, is_trump, led_suit, legal_plays, rank, trick_winner,
)

d = from_id


def test_a_trump_domino_is_not_of_its_other_suit():
    assert is_of_suit(d("3/6"), Suit.SIXES, Suit.SIXES)
    assert not is_of_suit(d("3/6"), Suit.THREES, Suit.SIXES)
    assert is_trump(d("3/6"), Suit.SIXES)
    assert not is_trump(d("3/6"), Suit.NONE)


def test_led_suit_is_trump_or_the_high_end():
    assert get_suit(d("3/5"), Suit.SIXES) == Suit.FIVES
    assert get_suit(d("3/6"), Suit.SIXES) == Suit.SIXES
    assert get_suit(d("3/5"), Suit.NONE) == Suit.FIVES
    assert get_suit(d("3/5"), Suit.LOW) == Suit.FIVES


def test_doubles_own_suit_under_low_doubles_own_suit():
    assert get_suit(d("5/5"), Suit.LOW_DOUBLES_OWN_SUIT) == Suit.DOUBLES
    assert not is_of_suit(d("5/5"), Suit.FIVES, Suit.LOW_DOUBLES_OWN_SUIT)
    assert is_of_suit(d("5/5"), Suit.DOUBLES, Suit.LOW_DOUBLES_OWN_SUIT)
    assert get_suit_value(d("6/6"), Suit.DOUBLES, Suit.LOW_DOUBLES_OWN_SUIT) == 6
    assert get_suit_value(d("0/0"), Suit.DOUBLES, Suit.LOW_DOUBLES_OWN_SUIT) == 0
    assert get_suit_value(d("3/5"), Suit.DOUBLES, Suit.LOW_DOUBLES_OWN_SUIT) == -1


def test_ranks_under_a_named_trump():
    assert get_suit_value(d("3/3"), Suit.THREES, Suit.SIXES) == 7
    assert get_suit_value(d("3/5"), Suit.THREES, Suit.SIXES) == 5
    assert get_suit_value(d("0/6"), Suit.THREES, Suit.SIXES) == 10
    assert get_suit_value(d("6/6"), Suit.THREES, Suit.SIXES) == 17
    assert get_suit_value(d("1/2"), Suit.THREES, Suit.SIXES) == -1


def test_doubles_rank_low_under_low_doubles_low():
    assert get_suit_value(d("3/3"), Suit.THREES, Suit.LOW_DOUBLES_LOW) == -0.5
    assert get_suit_value(d("0/3"), Suit.THREES, Suit.LOW_DOUBLES_LOW) == 0


@pytest.mark.parametrize("trump", ALL_TRUMPS)
def test_tables_agree_with_the_literal_ports(trump):
    for dom in range(28):
        assert led_suit(dom, trump) == get_suit(dom, trump)
        for led in range(8):
            assert rank(dom, led, trump) == get_suit_value(dom, led, trump)


def test_must_follow_suit_when_able():
    hand = to_mask([d("0/5"), d("1/2"), d("3/6")])
    assert legal_plays(hand, Suit.FIVES, Suit.SIXES) == to_mask([d("0/5")])
    assert legal_plays(hand, Suit.FOURS, Suit.SIXES) == hand
    assert legal_plays(hand, None, Suit.SIXES) == hand
    # 3/6 is trump, so it is not a three.
    assert legal_plays(hand, Suit.THREES, Suit.SIXES) == hand


def test_trick_winner_is_highest_rank_in_led_suit_or_trump():
    assert trick_winner([d("3/5"), d("5/5"), d("0/6"), d("1/1")], Suit.SIXES) == 2
    assert trick_winner([d("3/5"), d("5/5"), d("0/4"), d("1/1")], Suit.SIXES) == 1
    assert trick_winner([d("3/5"), d("5/5"), d("0/6")], Suit.NONE) == 1
