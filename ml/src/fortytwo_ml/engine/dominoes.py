"""The 28 dominoes as ints 0..27, in the order TS's shuffledDominoOrder generates them."""
from collections.abc import Iterable

PIPS: tuple[tuple[int, int], ...] = tuple((lo, hi) for lo in range(7) for hi in range(lo, 7))
N_DOMINOES = 28
FULL_MASK = (1 << N_DOMINOES) - 1

_INDEX = {pips: i for i, pips in enumerate(PIPS)}

# Count: a domino whose pips sum to a multiple of 5 is worth that sum (dominoValue in domino.ts).
VALUE: tuple[int, ...] = tuple((lo + hi) if (lo + hi) % 5 == 0 else 0 for lo, hi in PIPS)
IS_DOUBLE: tuple[bool, ...] = tuple(lo == hi for lo, hi in PIPS)
_DOUBLES_MASK = sum(1 << d for d in range(N_DOMINOES) if IS_DOUBLE[d])


def index_of(a: int, b: int) -> int:
    return _INDEX[(min(a, b), max(a, b))]


def domino_id(d: int) -> str:
    lo, hi = PIPS[d]
    return f"{lo}/{hi}"


def from_id(s: str) -> int:
    a, b = s.split("/")
    return index_of(int(a), int(b))


def to_mask(dominoes: Iterable[int]) -> int:
    mask = 0
    for d in dominoes:
        mask |= 1 << d
    return mask


def from_mask(mask: int) -> list[int]:
    return [d for d in range(N_DOMINOES) if mask >> d & 1]


def doubles_in(mask: int) -> int:
    return (mask & _DOUBLES_MASK).bit_count()
