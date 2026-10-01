"""Deal the dominoes a player can't see. v1 assumes nothing about them beyond what the rules
guarantee (a plunger holds four or more doubles)."""
import random
from collections.abc import Sequence

from ..engine.dominoes import doubles_in, to_mask


def deal_unseen(
    seat: int,
    hand: Sequence[int],
    rng: random.Random,
    require: tuple[int, int] | None = None,
    max_tries: int = 1000,
) -> list[int]:
    """A full deal order with `hand` in `seat`'s slot and the other 21 dominoes shuffled among
    the other seats. `require=(seat, n)` keeps reshuffling until that seat holds n+ doubles."""
    if len(hand) != 7 or len(set(hand)) != 7:
        raise ValueError("hand must be 7 distinct dominoes")
    held = set(hand)
    rest = [d for d in range(28) if d not in held]
    for _ in range(max_tries):
        rng.shuffle(rest)
        order: list[int] = []
        others = iter(rest)
        for s in range(4):
            order.extend(hand if s == seat else [next(others) for _ in range(7)])
        if require is None or doubles_in(to_mask(order[require[0] * 7:(require[0] + 1) * 7])) >= require[1]:
            return order
    raise ValueError(f"no deal gave seat {require[0]} {require[1]}+ doubles in {max_tries} tries")
