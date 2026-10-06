"""Ports of availableBids / availableTrumps (validation.ts) and gameValue / the bid target (game.ts)."""
from .enums import LOW_TRUMPS, NAMED_SUITS, PASS, PLUNGE, Bid, Suit

RANKED_BIDS: tuple[int, ...] = tuple(
    sorted(b for b in Bid if b not in (Bid.PASS, Bid.PLUNGE))
)
CONTRACT_BIDS: tuple[int, ...] = tuple(sorted((*RANKED_BIDS, PLUNGE)))


def available_bids(high_bid: int | None, passes: int, doubles: int) -> list[int]:
    """Every legal bid, ascending. `passes` counts hands that already passed; `doubles` is how
    many doubles the bidder holds."""
    bids: list[int] = []
    if passes < 3:
        bids.append(PASS)
    for bid in RANKED_BIDS:
        if high_bid is not None and bid <= high_bid:
            continue
        # Marks climb one rung at a time: 3 marks needs a standing 84, and so on.
        if bid > Bid.EIGHTY_FOUR and (high_bid is None or bid > high_bid + Bid.FORTY_TWO):
            continue
        bids.append(bid)
    if doubles >= 4 and (high_bid or PASS) < Bid.FOUR_MARKS:
        bids.append(PLUNGE)
    return sorted(bids)


def available_trumps(high_bid: int | None) -> list[int]:
    if high_bid == PLUNGE:
        return [*NAMED_SUITS, Suit.NONE]
    if high_bid is not None and high_bid >= Bid.FORTY_TWO:
        return [*NAMED_SUITS, Suit.NONE, *LOW_TRUMPS]
    return [*NAMED_SUITS]


def marks_for(bid: int) -> int:
    return 1 if bid <= Bid.FORTY_TWO else bid // Bid.FORTY_TWO


def target_points(bid: int) -> int:
    """Points the bidders need. Marks bids and Plunge (169, not a multiple of 42) need all 42."""
    return Bid.FORTY_TWO if bid == PLUNGE or bid % Bid.FORTY_TWO == 0 else bid
