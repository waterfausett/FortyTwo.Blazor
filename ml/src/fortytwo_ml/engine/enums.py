"""Suit and Bid, with the same int values as cloudflare/packages/rules/src/{suit,bid}.ts."""
from enum import IntEnum


class Suit(IntEnum):
    # The three Low trumps differ only in how doubles behave (see rules.py).
    LOW_DOUBLES_OWN_SUIT = -4
    LOW_DOUBLES_LOW = -3
    LOW = -2
    NONE = -1  # Follow Me: nothing is trump
    BLANKS = 0
    ACES = 1
    DEUCES = 2
    THREES = 3
    FOURS = 4
    FIVES = 5
    SIXES = 6
    # Never a trump: the suit a double leads under LOW_DOUBLES_OWN_SUIT.
    DOUBLES = 7


NAMED_SUITS: tuple[int, ...] = tuple(range(7))
LOW_TRUMPS: tuple[int, ...] = (Suit.LOW, Suit.LOW_DOUBLES_LOW, Suit.LOW_DOUBLES_OWN_SUIT)
# Every value trump can take, in the order the feature encoder one-hots them.
ALL_TRUMPS: tuple[int, ...] = (*NAMED_SUITS, Suit.NONE, *LOW_TRUMPS)


def is_low(trump: int | None) -> bool:
    return trump is not None and trump in LOW_TRUMPS


class Bid(IntEnum):
    PASS = 0
    THIRTY = 30
    THIRTY_ONE = 31
    THIRTY_TWO = 32
    THIRTY_THREE = 33
    THIRTY_FOUR = 34
    THIRTY_FIVE = 35
    THIRTY_SIX = 36
    THIRTY_SEVEN = 37
    THIRTY_EIGHT = 38
    THIRTY_NINE = 39
    FORTY = 40
    FORTY_ONE = 41
    FORTY_TWO = 42
    EIGHTY_FOUR = 84
    THREE_MARKS = 126
    FOUR_MARKS = 168
    PLUNGE = 169
    FIVE_MARKS = 210
    SIX_MARKS = 252
    SEVEN_MARKS = 294


PASS: int = Bid.PASS
PLUNGE: int = Bid.PLUNGE
