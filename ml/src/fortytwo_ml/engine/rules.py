"""Suits, ranks, and follow-suit. `is_of_suit`, `get_suit` and `get_suit_value` are literal ports of
packages/rules/src/domino.ts; everything else reads tables built from them once at import."""
from collections.abc import Sequence

from .dominoes import N_DOMINOES, PIPS
from .enums import ALL_TRUMPS, NAMED_SUITS, Suit

_LED_SUITS = range(8)  # 0..6 plus DOUBLES


def is_of_suit(d: int, suit: int, trump: int | None = None) -> bool:
    lo, hi = PIPS[d]
    # Doubles are a suit of their own: a double belongs only to DOUBLES, never to its number.
    if trump == Suit.LOW_DOUBLES_OWN_SUIT:
        if suit == Suit.DOUBLES:
            return lo == hi
        return lo != hi and (lo == suit or hi == suit)
    if trump is None or suit == trump:
        return lo == suit or hi == suit
    return (lo == suit and hi != trump) or (hi == suit and lo != trump)


def get_suit(d: int, trump: int) -> int:
    lo, hi = PIPS[d]
    if trump == Suit.LOW_DOUBLES_OWN_SUIT and lo == hi:
        return Suit.DOUBLES
    return trump if is_of_suit(d, trump) else hi


def get_suit_value(d: int, suit: int, trump: int) -> float:
    """Rank of d in a trick led in `suit` - higher wins; -1 can't win (off suit, no trump)."""
    lo, hi = PIPS[d]
    if is_of_suit(d, suit, trump):
        if suit == Suit.DOUBLES:
            return lo
        if lo == hi:
            return -0.5 if trump == Suit.LOW_DOUBLES_LOW else 7
        return hi if lo == suit else lo
    if is_of_suit(d, trump):
        return 10 + (7 if lo == hi else (hi if lo == trump else lo))
    return -1


_LED: dict[int, tuple[int, ...]] = {
    t: tuple(get_suit(d, t) for d in range(N_DOMINOES)) for t in ALL_TRUMPS
}
_FOLLOW: dict[int, tuple[int, ...]] = {
    t: tuple(
        sum(1 << d for d in range(N_DOMINOES) if is_of_suit(d, s, t)) for s in _LED_SUITS
    )
    for t in ALL_TRUMPS
}
_RANK: dict[int, tuple[tuple[float, ...], ...]] = {
    t: tuple(tuple(get_suit_value(d, s, t) for d in range(N_DOMINOES)) for s in _LED_SUITS)
    for t in ALL_TRUMPS
}
_TRUMP_MASK: dict[int, int] = {
    t: (sum(1 << d for d in range(N_DOMINOES) if is_of_suit(d, t)) if t in NAMED_SUITS else 0)
    for t in ALL_TRUMPS
}


def led_suit(d: int, trump: int) -> int:
    return _LED[trump][d]


def rank(d: int, led: int, trump: int) -> float:
    return _RANK[trump][led][d]


def is_trump(d: int, trump: int) -> bool:
    return bool(_TRUMP_MASK[trump] >> d & 1)


def trump_mask(trump: int) -> int:
    return _TRUMP_MASK[trump]


def legal_plays(hand_mask: int, led: int | None, trump: int) -> int:
    """Follow suit: holding the led suit, you must play it (assertValidDomino)."""
    if led is None:
        return hand_mask
    following = hand_mask & _FOLLOW[trump][led]
    return following or hand_mask


def trick_winner(dominoes: Sequence[int], trump: int) -> int:
    """Index of the winning domino; the earliest wins a tie, as in playDomino's reduce."""
    led = led_suit(dominoes[0], trump)
    ranks = _RANK[trump][led]
    best = 0
    for i in range(1, len(dominoes)):
        if ranks[dominoes[i]] > ranks[dominoes[best]]:
            best = i
    return best
