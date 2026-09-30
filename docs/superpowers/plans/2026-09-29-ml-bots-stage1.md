# ML Bots Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `ml/` Python project that holds an exact port of Forty-Two's hand rules, proven against the TS engine by a trace-parity test. On top of that sit a self-play (Deep Monte-Carlo) trick-play model and an evaluation arena that measures it against heuristic bots.

**Architecture:** `fortytwo_ml.engine` simulates one hand as a mutable state machine over int dominoes and bitmasks. A Node script drives the real `@fortytwo/rules` through random hands and writes gzipped JSONL traces. Python replays those traces and asserts that legal actions and results are identical. Agents (the dumb bot, a heuristic bot, and the model) share one protocol. Training runs CPU actor processes that play self-play hands and feed a GPU learner through a queue into a replay buffer. The arena plays duplicate deals and reports marks per deal with 95% confidence intervals.

**Tech Stack:** Python 3.12, uv, PyTorch (CUDA 12.8 wheels on Windows, CPU wheels elsewhere), numpy, PyYAML, TensorBoard, and pytest. On the Node side: tsx for the trace script, and GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-29-ml-bots-stage1-design.md`

## Global Constraints

- New root project at `ml/`, managed by uv, with `requires-python = ">=3.12,<3.13"`. All Python commands run from `ml/` as `uv run ...`.
- Domino ints 0–27 follow TS `shuffledDominoOrder` generation order: `(lo, hi)` for `lo` in 0..6 and `hi` in `lo..6`. Domino string ids are `"lo/hi"`, exactly as TS `createDomino` makes them.
- Seats are 0–3 and team is `seat % 2` (TS `Teams.TeamA = 1` ↔ Python team 0). Bid and Suit int values are identical to the TS enums.
- The engine raises `IllegalAction` on any illegal action and never corrects or ignores one.
- A hand ends (`Phase.DONE`) the moment `gameWinningTeam` would be non-null. The engine never plays a decided hand out.
- No test may need a GPU.
- The committed trace fixture is `ml/tests/fixtures/ts-traces.jsonl.gz` (5,000 hands, seed 42).
- The Stage 1 "done" bar: over ≥5,000 duplicate deals vs `heuristic`, mean marks per deal > 0 with a 95% CI excluding 0, and 0 illegal actions.
- Don't modify any existing TS source in `cloudflare/packages/rules/src`. Only add `scripts/dump-traces.ts` plus `package.json` wiring.

## Review Focus

1. **Low hands where the partner sits out.** The engine must never make the bidder's partner act, and tricks must close at 3 dominoes. Pinned in Task 4 (`test_low_skips_partner_and_closes_trick_at_three`).
2. **Plunge flow.** The partner names trump and then *leads* (TS never moves `currentPlayerId` in `setTrump`). Pinned in Task 4 (`test_plunge_partner_names_trump_and_leads`) and by parity.
3. **An agent returning an illegal action during evaluation.** It's counted, the first legal action is substituted, and evaluation completes without crashing. Pinned in Task 11 (`test_illegal_actions_are_counted_not_fatal`).
4. **An actor process dying mid-training.** The learner raises instead of hanging forever. Pinned in Task 13 (`test_check_actors_raises_when_an_actor_died`).
5. **Training asked for CUDA on a machine without it.** It fails fast with a clear message unless `allow_cpu_fallback` is set. Pinned in Task 12 (`test_resolve_device_*`).

---

### Task 1: Scaffold `ml/` with dominoes and enums

**Files:**
- Create: `ml/pyproject.toml`, `ml/.gitignore`, `ml/.python-version`
- Create: `ml/src/fortytwo_ml/__init__.py`, `ml/src/fortytwo_ml/engine/__init__.py`
- Create: `ml/src/fortytwo_ml/engine/enums.py`, `ml/src/fortytwo_ml/engine/dominoes.py`
- Test: `ml/tests/test_dominoes.py`, `ml/tests/conftest.py`

**Interfaces:**
- Produces:
  - `enums.Suit` (IntEnum: `LOW_DOUBLES_OWN_SUIT=-4, LOW_DOUBLES_LOW=-3, LOW=-2, NONE=-1, BLANKS=0 … SIXES=6, DOUBLES=7`), `NAMED_SUITS: tuple[int,...]` (0..6), `LOW_TRUMPS`, `ALL_TRUMPS` (11 values in the order `0..6, NONE, LOW, LOW_DOUBLES_LOW, LOW_DOUBLES_OWN_SUIT`), and `is_low(trump) -> bool`.
  - `enums.Bid` (IntEnum with the TS values), `PASS = 0`, and `PLUNGE = 169`.
  - `dominoes.PIPS: tuple[tuple[int,int],...]`, `VALUE`, `IS_DOUBLE`, `FULL_MASK`, `index_of(a, b) -> int`, `domino_id(d) -> str`, `from_id(s) -> int`, `to_mask(ds) -> int`, `from_mask(mask) -> list[int]`, and `doubles_in(mask) -> int`.
  - `tests/conftest.py`: the `deal_with(hands: dict[int, list[tuple[int,int]]]) -> list[int]` helper.

- [ ] **Step 1: Create the project files**

`ml/pyproject.toml`:
```toml
[project]
name = "fortytwo-ml"
version = "0.1.0"
description = "Self-play ML bots for Texas 42"
requires-python = ">=3.12,<3.13"
dependencies = [
  "numpy>=2.1",
  "pyyaml>=6.0",
  "tensorboard>=2.18",
  "torch>=2.7",
]

[project.scripts]
ml = "fortytwo_ml.cli:main"

[dependency-groups]
dev = ["pytest>=8.3"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/fortytwo_ml"]

# CUDA wheels where training happens (the Windows dev box, RTX 2070 SUPER); CPU wheels everywhere
# else, including CI.
[tool.uv.sources]
torch = [
  { index = "pytorch-cu128", marker = "sys_platform == 'win32'" },
  { index = "pytorch-cpu", marker = "sys_platform != 'win32'" },
]

[[tool.uv.index]]
name = "pytorch-cu128"
url = "https://download.pytorch.org/whl/cu128"
explicit = true

[[tool.uv.index]]
name = "pytorch-cpu"
url = "https://download.pytorch.org/whl/cpu"
explicit = true

[tool.pytest.ini_options]
testpaths = ["tests"]
```

`ml/.python-version`:
```
3.12
```

`ml/.gitignore`:
```
.venv/
__pycache__/
*.pyc
.pytest_cache/
runs/
```

`ml/src/fortytwo_ml/__init__.py` and `ml/src/fortytwo_ml/engine/__init__.py`: empty files.

- [ ] **Step 2: Install**

Run: `cd ml && uv sync`
Expected: this creates `.venv` and `uv.lock` and installs torch. Then check the GPU is visible:
`uv run python -c "import torch; print(torch.cuda.is_available())"` should print `True` on the Windows box.

- [ ] **Step 3: Write the failing tests**

`ml/tests/conftest.py`:
```python
from fortytwo_ml.engine.dominoes import index_of


def deal_with(hands: dict[int, list[tuple[int, int]]]) -> list[int]:
    """A deal order giving each listed seat those dominoes first; everything else fills in ascending."""
    fixed = {seat: [index_of(*pips) for pips in dominoes] for seat, dominoes in hands.items()}
    used = {d for ds in fixed.values() for d in ds}
    rest = iter(d for d in range(28) if d not in used)
    order: list[int] = []
    for seat in range(4):
        ds = fixed.get(seat, [])
        order.extend(ds + [next(rest) for _ in range(7 - len(ds))])
    return order
```

`ml/tests/test_dominoes.py`:
```python
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
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_dominoes.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'fortytwo_ml.engine.dominoes'`

- [ ] **Step 5: Implement**

`ml/src/fortytwo_ml/engine/enums.py`:
```python
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
```

`ml/src/fortytwo_ml/engine/dominoes.py`:
```python
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_dominoes.py -v`
Expected: 6 passed

- [ ] **Step 7: Commit**

```bash
git add ml/
git commit -m "ml: scaffold Python project with dominoes and enums"
```

---

### Task 2: Suit, rank, and follow-suit rules

**Files:**
- Create: `ml/src/fortytwo_ml/engine/rules.py`
- Test: `ml/tests/test_rules.py`

**Interfaces:**
- Consumes: `dominoes.PIPS` and `enums.Suit` / `ALL_TRUMPS` from Task 1.
- Produces (every `trump` argument is an int from `ALL_TRUMPS`, and `led` is 0..7):
  - literal TS ports: `is_of_suit(d, suit, trump=None) -> bool`, `get_suit(d, trump) -> int`, and `get_suit_value(d, suit, trump) -> float`;
  - table-backed fast paths: `led_suit(d, trump) -> int`, `rank(d, led, trump) -> float`, `legal_plays(hand_mask, led: int | None, trump) -> int` (mask), `trick_winner(dominoes: Sequence[int], trump) -> int` (index into the sequence), and `is_trump(d, trump) -> bool` (False for follow-me and Low).

- [ ] **Step 1: Write the failing tests**

`ml/tests/test_rules.py`:
```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_rules.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'fortytwo_ml.engine.rules'`

- [ ] **Step 3: Implement**

`ml/src/fortytwo_ml/engine/rules.py`:
```python
"""Suits, ranks, and follow-suit. `is_of_suit`, `get_suit` and `get_suit_value` are literal ports of
cloudflare/packages/rules/src/domino.ts; everything else reads tables built from them once at import."""
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_rules.py -v`
Expected: all passed (the parametrized table test runs 11 times)

- [ ] **Step 5: Commit**

```bash
git add ml/src/fortytwo_ml/engine/rules.py ml/tests/test_rules.py
git commit -m "ml: port suit, rank and follow-suit rules"
```

---

### Task 3: Bidding and trump availability

**Files:**
- Create: `ml/src/fortytwo_ml/engine/bidding.py`
- Test: `ml/tests/test_bidding.py`

**Interfaces:**
- Consumes: `enums` from Task 1.
- Produces: `RANKED_BIDS: tuple[int,...]` (30..42, 84, 126, 168, 210, 252, 294), `CONTRACT_BIDS` (the 20 non-pass bids in ascending order, including 169), `available_bids(high_bid: int | None, passes: int, doubles: int) -> list[int]`, `available_trumps(high_bid: int | None) -> list[int]`, `marks_for(bid) -> int`, and `target_points(bid) -> int`.

- [ ] **Step 1: Write the failing tests**

`ml/tests/test_bidding.py`:
```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_bidding.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement**

`ml/src/fortytwo_ml/engine/bidding.py`:
```python
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_bidding.py -v`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add ml/src/fortytwo_ml/engine/bidding.py ml/tests/test_bidding.py
git commit -m "ml: port bidding ladder and trump availability"
```

---

### Task 4: The hand state machine

**Files:**
- Create: `ml/src/fortytwo_ml/engine/hand_state.py`
- Test: `ml/tests/test_hand_state.py`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `Phase` (IntEnum `BID, TRUMP, PLAY, DONE`), `IllegalAction(Exception)` (attrs `seat, phase, action, legal`), `Contract(bidder, bid, trump)` (frozen dataclass), `Trick(plays: tuple[tuple[int,int],...], winner: int, points: int)`, and `HandResult(winning_team: int, marks: int, points: tuple[int,int])`.
  - Helpers `team_of(seat) -> int` and `partner(seat) -> int`.
  - `HandState` with:
    - constructors `HandState.deal(deal_order, opener)` and `HandState.from_contract(deal_order, bidder, bid, trump)`;
    - attributes `phase, to_act, opener, bids: list[int | None], high_bid, bidder, trump, hands: list[int]` (masks), `dealt: list[tuple[int,...]]`, `played: list[int]` (masks), `trick: list[tuple[int,int]]` ((seat, domino)), `tricks: list[Trick]`, `points: list[int]`, `voids: list[int]` (bit per led suit 0..7), and `result: HandResult | None`;
    - properties `trump_namer`, `sits_out`, `led_suit`, and `contract`;
    - methods `hand(seat) -> list[int]` (in dealt order), `legal_actions() -> list[int]`, and `apply(action) -> None`.
  - Action ints by phase: a Bid value in BID, a Suit value in TRUMP, and a domino index in PLAY.

- [ ] **Step 1: Write the failing tests**

`ml/tests/test_hand_state.py`:
```python
import random

import pytest

from conftest import deal_with
from fortytwo_ml.engine.dominoes import from_id
from fortytwo_ml.engine.enums import NAMED_SUITS, PASS, PLUNGE, Suit
from fortytwo_ml.engine.hand_state import Contract, HandState, IllegalAction, Phase

d = from_id

# Trump-sixes fixture: seat 0 holds six trumps plus 0/1, seat 1 is long in aces, seats 2 and 3
# hold no aces (and seat 2 no sixes).
HANDS = {
    0: ["0/1", "6/6", "5/6", "4/6", "3/6", "2/6", "1/6"],
    1: ["1/5", "1/1", "1/2", "1/3", "1/4", "0/0", "0/2"],
    2: ["0/3", "0/4", "0/5", "2/2", "2/3", "2/4", "2/5"],
    3: ["0/6", "3/3", "3/4", "3/5", "4/4", "4/5", "5/5"],
}
DEAL = [d(x) for seat in range(4) for x in HANDS[seat]]


def test_deal_gives_each_seat_its_slice_in_order():
    state = HandState.deal(DEAL, opener=2)
    assert state.hand(1) == [d(x) for x in HANDS[1]]
    assert state.phase is Phase.BID and state.to_act == 2


def test_deal_rejects_a_bad_order():
    with pytest.raises(ValueError):
        HandState.deal(DEAL[:-1] + [DEAL[0]], opener=0)


def test_bidding_goes_round_once_then_the_high_bidder_names_trump_and_leads():
    state = HandState.deal(DEAL, opener=2)
    for seat, bid in [(2, PASS), (3, 31), (0, 35), (1, PASS)]:
        assert state.to_act == seat
        state.apply(bid)
    assert state.phase is Phase.TRUMP and state.to_act == 0 and state.bidder == 0
    assert state.legal_actions() == list(NAMED_SUITS)
    state.apply(Suit.SIXES)
    assert state.phase is Phase.PLAY and state.to_act == 0
    assert state.contract == Contract(0, 35, Suit.SIXES)


def test_illegal_bid_raises():
    state = HandState.deal(DEAL, opener=0)
    state.apply(35)
    with pytest.raises(IllegalAction):
        state.apply(33)


def test_plunge_partner_names_trump_and_leads():
    deal = deal_with({1: [(0, 0), (1, 1), (2, 2), (3, 3)]})
    state = HandState.deal(deal, opener=0)
    for bid in (PASS, PLUNGE, PASS, PASS):
        state.apply(bid)
    assert state.phase is Phase.TRUMP and state.to_act == 3
    assert state.legal_actions() == [*NAMED_SUITS, Suit.NONE]
    state.apply(Suit.NONE)
    assert state.phase is Phase.PLAY and state.to_act == 3


def test_follow_suit_is_enforced_and_voids_recorded():
    state = HandState.from_contract(DEAL, bidder=0, bid=42, trump=Suit.SIXES)
    state.apply(d("0/1"))
    with pytest.raises(IllegalAction):
        state.apply(d("0/0"))
    assert state.legal_actions() == [d("1/5"), d("1/1"), d("1/2"), d("1/3"), d("1/4")]
    state.apply(d("1/5"))
    state.apply(d("0/3"))
    assert state.voids[2] == 1 << Suit.ACES


def test_hand_ends_as_soon_as_it_is_decided():
    # Bid 42 needs every point; the defenders take trick one, so the hand is over.
    state = HandState.from_contract(DEAL, bidder=0, bid=42, trump=Suit.SIXES)
    for x in ("0/1", "1/5", "0/3", "3/3"):
        state.apply(d(x))
    assert state.phase is Phase.DONE
    assert state.result.winning_team == 1 and state.result.marks == 1
    assert state.result.points == (0, 1)
    assert state.legal_actions() == []


def test_low_skips_partner_and_closes_trick_at_three():
    state = HandState.from_contract(DEAL, bidder=0, bid=42, trump=Suit.LOW)
    assert state.sits_out == 2 and state.to_act == 0
    state.apply(d("6/6"))
    state.apply(d("0/0"))
    assert state.to_act == 3
    assert state.legal_actions() == [d("0/6")]
    state.apply(d("0/6"))
    # The bidder took a trick, so the Low bid failed.
    assert state.phase is Phase.DONE and len(state.tricks[0].plays) == 3
    assert state.result.winning_team == 1


def test_from_contract_rejects_impossible_contracts():
    with pytest.raises(ValueError):
        HandState.from_contract(DEAL, bidder=0, bid=PLUNGE, trump=Suit.SIXES)  # 1 double
    with pytest.raises(ValueError):
        HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.LOW)
    with pytest.raises(ValueError):
        HandState.from_contract(DEAL, bidder=0, bid=PASS, trump=Suit.SIXES)


def test_random_hands_always_finish_consistently():
    rng = random.Random(7)
    for _ in range(500):
        order = list(range(28))
        rng.shuffle(order)
        state = HandState.deal(order, opener=rng.randrange(4))
        while state.phase is not Phase.DONE:
            state.apply(rng.choice(state.legal_actions()))
        assert 1 <= len(state.tricks) <= 7
        assert sum(state.points) <= 42
        if len(state.tricks) == 7 and state.sits_out is None:
            assert sum(state.points) == 42
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_hand_state.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement**

`ml/src/fortytwo_ml/engine/hand_state.py`:
```python
"""One hand of Forty-Two as a state machine: deal -> bid -> trump -> play -> decided.

Mirrors placeBid / setTrump / playDomino and gameWinningTeam in cloudflare/packages/rules, except
that a decided hand stops (TS lets players play it out; those plays never change the result)."""
from collections.abc import Sequence
from dataclasses import dataclass
from enum import IntEnum

from .bidding import CONTRACT_BIDS, available_bids, available_trumps, marks_for, target_points
from .dominoes import FULL_MASK, VALUE, doubles_in, to_mask
from .enums import PASS, PLUNGE, is_low
from .rules import is_of_suit, led_suit, legal_plays, trick_winner


class Phase(IntEnum):
    BID = 0
    TRUMP = 1
    PLAY = 2
    DONE = 3


class IllegalAction(Exception):
    def __init__(self, seat: int, phase: Phase, action: int, legal: list[int]):
        super().__init__(f"seat {seat} can't {phase.name} {action}; legal: {legal}")
        self.seat, self.phase, self.action, self.legal = seat, phase, action, legal


@dataclass(frozen=True)
class Contract:
    bidder: int
    bid: int
    trump: int


@dataclass(frozen=True)
class Trick:
    plays: tuple[tuple[int, int], ...]  # (seat, domino) in play order
    winner: int
    points: int


@dataclass(frozen=True)
class HandResult:
    winning_team: int
    marks: int
    points: tuple[int, int]


def team_of(seat: int) -> int:
    return seat % 2


def partner(seat: int) -> int:
    return (seat + 2) % 4


class HandState:
    phase: Phase
    to_act: int
    opener: int
    bids: list[int | None]
    high_bid: int | None
    bidder: int | None
    trump: int | None
    dealt: list[tuple[int, ...]]
    hands: list[int]
    played: list[int]
    trick: list[tuple[int, int]]
    tricks: list[Trick]
    points: list[int]
    voids: list[int]
    result: HandResult | None

    @classmethod
    def deal(cls, deal_order: Sequence[int], opener: int) -> "HandState":
        if len(deal_order) != 28 or to_mask(deal_order) != FULL_MASK:
            raise ValueError("deal_order must be a permutation of 0..27")
        if opener not in range(4):
            raise ValueError(f"opener must be a seat 0..3, got {opener}")
        s = cls.__new__(cls)
        s.dealt = [tuple(deal_order[p * 7:(p + 1) * 7]) for p in range(4)]
        s.hands = [to_mask(ds) for ds in s.dealt]
        s.played = [0, 0, 0, 0]
        s.opener = opener
        s.to_act = opener
        s.phase = Phase.BID
        s.bids = [None, None, None, None]
        s.high_bid = None
        s.bidder = None
        s.trump = None
        s.trick = []
        s.tricks = []
        s.points = [0, 0]
        s.voids = [0, 0, 0, 0]
        s.result = None
        return s

    @classmethod
    def from_contract(cls, deal_order: Sequence[int], bidder: int, bid: int, trump: int) -> "HandState":
        """Skip bidding: `bidder` won with `bid` and trump is `trump`. Everyone else passed."""
        s = cls.deal(deal_order, opener=bidder)
        if bid not in CONTRACT_BIDS:
            raise ValueError(f"{bid} isn't a contract bid")
        if bid == PLUNGE and doubles_in(s.hands[bidder]) < 4:
            raise ValueError("a Plunge needs four doubles")
        if trump not in available_trumps(bid):
            raise ValueError(f"trump {trump} isn't allowed on a bid of {bid}")
        s.bids = [PASS, PASS, PASS, PASS]
        s.bids[bidder] = bid
        s.high_bid = bid
        s.bidder = bidder
        s.trump = trump
        s.phase = Phase.PLAY
        s.to_act = s.trump_namer
        return s

    @property
    def trump_namer(self) -> int:
        # Only the winning bidder names trump - except on a Plunge, where their partner does.
        assert self.bidder is not None
        return partner(self.bidder) if self.high_bid == PLUNGE else self.bidder

    @property
    def sits_out(self) -> int | None:
        """On a Low trump the bidder's partner sits out."""
        return partner(self.bidder) if is_low(self.trump) else None

    @property
    def led_suit(self) -> int | None:
        return led_suit(self.trick[0][1], self.trump) if self.trick else None

    @property
    def contract(self) -> Contract | None:
        if self.trump is None:
            return None
        return Contract(self.bidder, self.high_bid, self.trump)

    def hand(self, seat: int) -> list[int]:
        mask = self.hands[seat]
        return [d for d in self.dealt[seat] if mask >> d & 1]

    def legal_actions(self) -> list[int]:
        if self.phase is Phase.BID:
            passes = sum(1 for b in self.bids if b == PASS)
            return available_bids(self.high_bid, passes, doubles_in(self.hands[self.to_act]))
        if self.phase is Phase.TRUMP:
            return available_trumps(self.high_bid)
        if self.phase is Phase.PLAY:
            allowed = legal_plays(self.hands[self.to_act], self.led_suit, self.trump)
            return [d for d in self.hand(self.to_act) if allowed >> d & 1]
        return []

    def apply(self, action: int) -> None:
        legal = self.legal_actions()
        if action not in legal:
            raise IllegalAction(self.to_act, self.phase, action, legal)
        if self.phase is Phase.BID:
            self._bid(action)
        elif self.phase is Phase.TRUMP:
            self.trump = action
            self.phase = Phase.PLAY  # the trump namer leads: to_act doesn't move
        else:
            self._play(action)

    def _bid(self, bid: int) -> None:
        seat = self.to_act
        self.bids[seat] = bid
        if bid != PASS and (self.high_bid is None or bid > self.high_bid):
            self.high_bid = bid
            self.bidder = seat
        if None in self.bids:
            self.to_act = (seat + 1) % 4
        else:
            self.phase = Phase.TRUMP
            self.to_act = self.trump_namer

    def _play(self, domino: int) -> None:
        seat = self.to_act
        bit = 1 << domino
        self.hands[seat] &= ~bit
        self.played[seat] |= bit
        if self.trick:
            led = self.led_suit
            if not is_of_suit(domino, led, self.trump):
                self.voids[seat] |= 1 << led
        self.trick.append((seat, domino))

        if len(self.trick) < (3 if is_low(self.trump) else 4):
            self.to_act = self._next_seat(seat)
            return

        dominoes = [d for _, d in self.trick]
        winner = self.trick[trick_winner(dominoes, self.trump)][0]
        points = sum(VALUE[d] for d in dominoes) + 1
        self.tricks.append(Trick(tuple(self.trick), winner, points))
        self.points[team_of(winner)] += points
        self.trick = []
        self.to_act = winner
        self._check_decided()

    def _next_seat(self, seat: int) -> int:
        nxt = (seat + 1) % 4
        return (nxt + 1) % 4 if nxt == self.sits_out else nxt

    def _check_decided(self) -> None:
        bidders = team_of(self.bidder)
        others = 1 - bidders
        winner: int | None = None
        if is_low(self.trump):
            # The bidders must lose every trick.
            if any(team_of(t.winner) == bidders for t in self.tricks):
                winner = others
            elif len(self.tricks) == 7:
                winner = bidders
        else:
            target = target_points(self.high_bid)
            if self.points[bidders] >= target:
                winner = bidders
            elif self.points[others] > 42 - target:
                winner = others
        if winner is not None:
            self.phase = Phase.DONE
            self.result = HandResult(winner, marks_for(self.high_bid), (self.points[0], self.points[1]))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_hand_state.py -v`
Expected: 11 passed

- [ ] **Step 5: Commit**

```bash
git add ml/src/fortytwo_ml/engine/hand_state.py ml/tests/test_hand_state.py
git commit -m "ml: add hand state machine"
```

---

### Task 5: TS trace generator and committed fixture

**Files:**
- Create: `cloudflare/packages/rules/scripts/dump-traces.ts`
- Modify: `cloudflare/packages/rules/package.json` (add a `tsx` devDependency and a `dump-traces` script)
- Modify: `cloudflare/package-lock.json` (via `npm install`)
- Create: `ml/tests/fixtures/ts-traces.jsonl.gz` (generated)

**Interfaces:**
- Produces: gzipped JSONL, one hand per line:
  `{"id", "deal": ["lo/hi" x28], "opener": seat, "steps": [{"seat", "phase": "bid"|"trump"|"play", "legal": [...], "action"}], "result": {"winningTeam": 0|1, "marks", "points": [teamA, teamB]}}`.
  Bid and trump values are ints and plays are `"lo/hi"` strings.
- CLI: `npm run dump-traces -w @fortytwo/rules -- --count N --seed S --out PATH`. A relative `--out` resolves against `cloudflare/packages/rules`.

- [ ] **Step 1: Add tsx and the script entry**

Run: `cd cloudflare && npm install -D tsx@^4.19.0 -w @fortytwo/rules`

Then edit `cloudflare/packages/rules/package.json` so that `scripts` reads:
```json
"scripts": { "test": "vitest run", "dump-traces": "tsx scripts/dump-traces.ts" },
```

- [ ] **Step 2: Write the script**

`cloudflare/packages/rules/scripts/dump-traces.ts`:
```ts
// Plays random hands through the real rules engine and writes one JSON line per hand (gzipped),
// for the Python port's parity test (ml/tests/test_parity.py). Legal actions are found black-box:
// every candidate is offered to the same guard the Worker uses, and whatever doesn't throw is
// legal. A hand stops the moment it's decided, matching the Python engine.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import {
  Bid,
  Suit,
  Teams,
  assertValidBid,
  assertValidDomino,
  assertValidTrump,
  createMatch,
  gameValue,
  gameWinningTeam,
  placeBid,
  playDomino,
  setTrump,
  shuffledDominoOrder,
  takeSeat,
  trickValue,
  type MatchState,
} from '../src/index';

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '1000' },
    seed: { type: 'string', default: '1' },
    out: { type: 'string' },
  },
});
if (!values.out) throw new Error('--out is required');

// mulberry32: a small seeded PRNG, so a trace file can be regenerated exactly.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Step = { seat: number; phase: 'bid' | 'trump' | 'play'; legal: (number | string)[]; action: number | string };

const PLAYERS = ['p0', 'p1', 'p2', 'p3'];
const ALL_BIDS = Object.values(Bid).filter((v): v is Bid => typeof v === 'number');
const ALL_SUITS = Object.values(Suit).filter((v): v is Suit => typeof v === 'number');

function legal<T>(candidates: T[], check: (candidate: T) => void): T[] {
  return candidates.filter((candidate) => {
    try {
      check(candidate);
      return true;
    } catch {
      return false;
    }
  });
}

function pick<T>(xs: T[], random: () => number): T {
  return xs[Math.floor(random() * xs.length)];
}

function playHand(id: number, random: () => number) {
  const deal = shuffledDominoOrder(random);
  let match: MatchState = createMatch(PLAYERS[0]);
  for (let seat = 1; seat < 4; seat++) {
    match = takeSeat(match, PLAYERS[seat], seat, seat === 3 ? deal : undefined);
  }
  const opener = Math.floor(random() * 4);
  match = {
    ...match,
    currentGame: { ...match.currentGame, firstActionBy: PLAYERS[opener], currentPlayerId: PLAYERS[opener] },
  };

  const steps: Step[] = [];
  while (gameWinningTeam(match.currentGame) === null) {
    const game = match.currentGame;
    const playerId = game.currentPlayerId!;
    const seat = PLAYERS.indexOf(playerId);

    if (game.hands.some((h) => h.bid === null)) {
      const bids = legal(ALL_BIDS, (b) => assertValidBid(game, playerId, b));
      // Plunge is rare (it needs four doubles), so take it half the time it's offered.
      const action = bids.includes(Bid.Plunge) && random() < 0.5 ? Bid.Plunge : pick(bids, random);
      steps.push({ seat, phase: 'bid', legal: bids, action });
      match = placeBid(match, playerId, action);
    } else if (game.trump === null) {
      const trumps = legal(ALL_SUITS, (s) => assertValidTrump(game, s));
      const action = pick(trumps, random);
      steps.push({ seat, phase: 'trump', legal: trumps, action });
      match = setTrump(match, playerId, action);
    } else {
      const hand = game.hands.find((h) => h.playerId === playerId)!.dominoes;
      const plays = legal(hand, (d) => assertValidDomino(game, playerId, d));
      const action = pick(plays, random);
      steps.push({ seat, phase: 'play', legal: plays.map((d) => d.id), action: action.id });
      match = playDomino(match, playerId, action);
    }
  }

  const game = match.currentGame;
  const points = [0, 0];
  for (const trick of game.tricks) {
    if (trick.team !== null) points[trick.team - Teams.TeamA] += trickValue(trick);
  }
  return {
    id,
    deal: deal.map((d) => d.id),
    opener,
    steps,
    result: { winningTeam: gameWinningTeam(game)! - Teams.TeamA, marks: gameValue(game), points },
  };
}

const random = mulberry32(Number(values.seed));
const lines: string[] = [];
for (let i = 0; i < Number(values.count); i++) lines.push(JSON.stringify(playHand(i, random)));
writeFileSync(values.out, gzipSync(lines.join('\n') + '\n'));
console.log(`wrote ${lines.length} hands to ${values.out}`);
```

- [ ] **Step 3: Generate the committed fixture**

Run: `cd cloudflare && npm run dump-traces -w @fortytwo/rules -- --count 5000 --seed 42 --out ../../../ml/tests/fixtures/ts-traces.jsonl.gz`
Expected: `wrote 5000 hands to ../../../ml/tests/fixtures/ts-traces.jsonl.gz`. The file should be around 1–2 MB.

Check that the rules suite is unaffected: `cd cloudflare && npm test -w @fortytwo/rules` should pass.

- [ ] **Step 4: Commit**

```bash
git add cloudflare/packages/rules/scripts/dump-traces.ts cloudflare/packages/rules/package.json cloudflare/package-lock.json ml/tests/fixtures/ts-traces.jsonl.gz
git commit -m "rules: add dump-traces script and commit parity fixture for ml/"
```

---

### Task 6: Parity test

**Files:**
- Test: `ml/tests/test_parity.py`

**Interfaces:**
- Consumes: `HandState` and `Phase` (Task 4), `from_id` (Task 1), and the trace format (Task 5).
- Reads `FORTYTWO_TRACES` from the environment to override the fixture path. CI uses that for freshly generated traces.

- [ ] **Step 1: Write the test**

`ml/tests/test_parity.py`:
```python
"""Replays hands recorded from the real TS engine (cloudflare/packages/rules) and asserts the Python
engine agrees at every decision: same seat to act, same legal actions, and the same result.

Regenerate the fixture after a rules change:
  cd cloudflare && npm run dump-traces -w @fortytwo/rules -- --count 5000 --seed 42 \
    --out ../../../ml/tests/fixtures/ts-traces.jsonl.gz
"""
import gzip
import json
import os
from pathlib import Path

import pytest

from fortytwo_ml.engine.dominoes import from_id
from fortytwo_ml.engine.enums import LOW_TRUMPS, PLUNGE, Suit
from fortytwo_ml.engine.hand_state import HandState, Phase

TRACES = Path(os.environ.get("FORTYTWO_TRACES") or Path(__file__).parent / "fixtures" / "ts-traces.jsonl.gz")
PHASES = {"bid": Phase.BID, "trump": Phase.TRUMP, "play": Phase.PLAY}


def _load() -> list[dict]:
    with gzip.open(TRACES, "rt", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def _decode(phase: str, value) -> int:
    return from_id(value) if phase == "play" else int(value)


ALL_TRACES = _load()


def test_traces_cover_every_contract_type():
    bids = {s["action"] for t in ALL_TRACES for s in t["steps"] if s["phase"] == "bid"}
    trumps = {s["action"] for t in ALL_TRACES for s in t["steps"] if s["phase"] == "trump"}
    assert PLUNGE in bids and 84 in bids
    assert Suit.NONE in trumps
    assert set(LOW_TRUMPS) <= trumps


@pytest.mark.parametrize("trace", ALL_TRACES, ids=lambda t: f"hand{t['id']}")
def test_python_engine_matches_ts(trace):
    state = HandState.deal([from_id(x) for x in trace["deal"]], trace["opener"])
    for i, step in enumerate(trace["steps"]):
        where = f"hand {trace['id']} step {i} ({step['phase']})"
        phase = step["phase"]
        assert state.phase == PHASES[phase], f"{where}: phase"
        assert state.to_act == step["seat"], f"{where}: seat to act"
        expected = sorted(_decode(phase, x) for x in step["legal"])
        assert sorted(state.legal_actions()) == expected, f"{where}: legal actions differ"
        state.apply(_decode(phase, step["action"]))
    assert state.phase is Phase.DONE, f"hand {trace['id']}: TS decided the hand, Python didn't"
    expected = trace["result"]
    assert (state.result.winning_team, state.result.marks, list(state.result.points)) == (
        expected["winningTeam"], expected["marks"], expected["points"],
    ), f"hand {trace['id']}: result"
```

- [ ] **Step 2: Run it**

Run: `cd ml && uv run pytest tests/test_parity.py -q`
Expected: 5001 passed. If any hand fails, the message names the hand, step, and phase. Fix the engine (Tasks 2–4), not the test. Use `systematic-debugging`: replay the failing trace step by step and compare against the TS source.

- [ ] **Step 3: Commit**

```bash
git add ml/tests/test_parity.py
git commit -m "ml: add TS parity test over recorded traces"
```

---

### Task 7: Agents (protocol, dumb bot, heuristic bot)

**Files:**
- Create: `ml/src/fortytwo_ml/agents/__init__.py` (empty), `ml/src/fortytwo_ml/agents/base.py`, `ml/src/fortytwo_ml/agents/dumb_bot.py`, `ml/src/fortytwo_ml/agents/heuristic_bot.py`
- Test: `ml/tests/test_agents.py`

**Interfaces:**
- Consumes: `HandState`, `Phase`, `IllegalAction`, `HandResult`, `team_of`, `partner` (Task 4), and the rules helpers (Task 2).
- Produces:
  - `Agent` Protocol (`name: str`; `bid(state, seat) -> int`, `trump(state, seat) -> int`, `play(state, seat) -> int`), `choose(agent, state) -> int`, and `run_hand(state, agents: Sequence[Agent], on_illegal: Callable[[int, int], None] | None = None) -> HandResult`.
  - `DumbBot` (name `"dumb"`) and `HeuristicBot` (name `"heuristic"`).
  - `heuristic_bot.suit_strength(hand: list[int], suit: int) -> int` and `best_suit(hand) -> tuple[int, int]` (suit, strength).
- Agents may only read public state plus `state.hand(seat)` / `state.hands[seat]` for their own seat. This is a documented convention, not enforced.

- [ ] **Step 1: Write the failing tests**

`ml/tests/test_agents.py`:
```python
import random

from conftest import deal_with
from fortytwo_ml.agents.base import run_hand
from fortytwo_ml.agents.dumb_bot import DumbBot
from fortytwo_ml.agents.heuristic_bot import HeuristicBot, best_suit
from fortytwo_ml.engine.dominoes import VALUE, from_id
from fortytwo_ml.engine.enums import PASS, Suit
from fortytwo_ml.engine.hand_state import HandState, Phase

d = from_id

HANDS = {
    0: ["0/1", "6/6", "5/6", "4/6", "3/6", "2/6", "1/6"],
    1: ["1/5", "1/1", "1/2", "1/3", "1/4", "0/0", "0/2"],
    2: ["0/3", "0/4", "0/5", "2/2", "2/3", "2/4", "2/5"],
    3: ["0/6", "3/3", "3/4", "3/5", "4/4", "4/5", "5/5"],
}
DEAL = [d(x) for seat in range(4) for x in HANDS[seat]]


# --- DumbBot mirrors apps/worker/src/bots.test.ts ---

def test_dumb_passes_unless_forced():
    state = HandState.deal(DEAL, opener=0)
    assert DumbBot().bid(state, 0) == PASS
    for _ in range(3):
        state.apply(PASS)
    assert DumbBot().bid(state, 3) == 30


def test_dumb_trump_is_most_held_suit_lowest_on_ties():
    deal = deal_with({0: [(2, 2), (2, 5), (3, 4), (0, 1), (6, 6), (3, 3), (4, 4)]})
    assert DumbBot().trump(HandState.deal(deal, opener=0), 0) == Suit.DEUCES


def test_dumb_plays_first_legal_domino_in_hand_order():
    state = HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.SIXES)
    assert DumbBot().play(state, 0) == d("0/1")
    state.apply(d("0/1"))
    assert DumbBot().play(state, 1) == d("1/5")


# --- HeuristicBot ---

def test_heuristic_bids_a_strong_hand_and_passes_a_weak_one():
    state = HandState.deal(DEAL, opener=0)
    bid = HeuristicBot().bid(state, 0)
    assert 30 <= bid <= 42
    state.apply(bid)
    assert HeuristicBot().bid(state, 1) == PASS


def test_heuristic_is_forced_to_bid_30():
    state = HandState.deal(DEAL, opener=1)
    for _ in range(3):
        state.apply(PASS)
    assert state.to_act == 0 and HeuristicBot().bid(state, 0) in state.legal_actions()


def test_heuristic_names_its_best_suit():
    state = HandState.deal(DEAL, opener=0)
    assert best_suit(state.hand(0))[0] == Suit.SIXES


def test_heuristic_leads_top_trump_while_others_may_hold_trump():
    state = HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.SIXES)
    assert HeuristicBot().play(state, 0) == d("6/6")


def test_heuristic_drops_count_on_partners_winning_trick():
    state = HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.SIXES)
    state.apply(d("6/6"))
    state.apply(d("1/1"))
    assert VALUE[HeuristicBot().play(state, 2)] == 5


def test_heuristic_wins_cheaply_when_opponent_is_winning():
    state = HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.SIXES)
    state.apply(d("0/1"))
    assert HeuristicBot().play(state, 1) == d("1/2")


def test_heuristic_low_bidder_leads_its_lowest_domino():
    state = HandState.from_contract(DEAL, bidder=0, bid=42, trump=Suit.LOW)
    assert HeuristicBot().play(state, 0) == d("0/1")


def test_bots_only_ever_choose_legal_actions():
    rng = random.Random(3)
    for agents in ([HeuristicBot()] * 4, [DumbBot()] * 4, [HeuristicBot(), DumbBot()] * 2):
        for _ in range(300):
            order = list(range(28))
            rng.shuffle(order)
            state = HandState.deal(order, opener=rng.randrange(4))
            run_hand(state, agents)  # raises IllegalAction on any illegal choice
            assert state.phase is Phase.DONE
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_agents.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement**

`ml/src/fortytwo_ml/agents/base.py`:
```python
"""What every player (bot, heuristic, or model) looks like to the engine and the arena.

An agent may read public state (bids, trump, tricks, the current trick, played dominoes, voids)
and only its OWN hand (`state.hand(seat)` / `state.hands[seat]`). Nothing enforces this; it's the
contract that keeps evaluation honest."""
from collections.abc import Callable, Sequence
from typing import Protocol

from ..engine.hand_state import HandResult, HandState, IllegalAction, Phase


class Agent(Protocol):
    name: str

    def bid(self, state: HandState, seat: int) -> int: ...

    def trump(self, state: HandState, seat: int) -> int: ...

    def play(self, state: HandState, seat: int) -> int: ...


def choose(agent: Agent, state: HandState) -> int:
    seat = state.to_act
    if state.phase is Phase.BID:
        return agent.bid(state, seat)
    if state.phase is Phase.TRUMP:
        return agent.trump(state, seat)
    if state.phase is Phase.PLAY:
        return agent.play(state, seat)
    raise ValueError("the hand is over")


def run_hand(
    state: HandState,
    agents: Sequence[Agent],
    on_illegal: Callable[[int, int], None] | None = None,
) -> HandResult:
    """Plays `state` to the end, `agents[seat]` choosing for each seat. An illegal choice raises,
    unless `on_illegal(seat, action)` is given, in which case it's reported and the first legal
    action is played instead."""
    while state.phase is not Phase.DONE:
        seat = state.to_act
        action = choose(agents[seat], state)
        legal = state.legal_actions()
        if action not in legal:
            if on_illegal is None:
                raise IllegalAction(seat, state.phase, action, legal)
            on_illegal(seat, action)
            action = legal[0]
        state.apply(action)
    return state.result
```

`ml/src/fortytwo_ml/agents/dumb_bot.py`:
```python
"""Exact port of the Worker's dev-only bots (cloudflare/apps/worker/src/bots.ts)."""
from ..engine.dominoes import PIPS
from ..engine.enums import NAMED_SUITS, PASS
from ..engine.hand_state import HandState


class DumbBot:
    name = "dumb"

    def bid(self, state: HandState, seat: int) -> int:
        forced = sum(1 for s in range(4) if s != seat and state.bids[s] == PASS) == 3
        return 30 if forced else PASS

    def trump(self, state: HandState, seat: int) -> int:
        hand = state.hand(seat)
        best, best_count = NAMED_SUITS[0], -1
        for suit in NAMED_SUITS:
            count = sum(1 for d in hand if suit in PIPS[d])
            if count > best_count:
                best, best_count = suit, count
        return best

    def play(self, state: HandState, seat: int) -> int:
        # legal_actions is in hand order: the first domino of the led suit, else the first held.
        return state.legal_actions()[0]
```

`ml/src/fortytwo_ml/agents/heuristic_bot.py`:
```python
"""A rule-based player that plays sensibly: the baseline the model must beat, and the default
source of contracts for Stage 1 training."""
from ..engine.dominoes import IS_DOUBLE, PIPS, VALUE, index_of
from ..engine.enums import NAMED_SUITS, PASS, is_low
from ..engine.hand_state import HandState, team_of
from ..engine.rules import is_trump, led_suit, rank, trick_winner, trump_mask


def suit_strength(hand: list[int], suit: int) -> int:
    """A rough 30-42 scale estimate of what `hand` can make with `suit` as trump."""
    trumps = sum(1 for d in hand if suit in PIPS[d])
    strength = 5 * trumps
    if index_of(suit, suit) in hand:
        strength += 5
    strength += 3 * sum(1 for d in hand if IS_DOUBLE[d] and suit not in PIPS[d])
    strength += sum(VALUE[d] for d in hand) // 5
    return strength


def best_suit(hand: list[int]) -> tuple[int, int]:
    best, best_strength = NAMED_SUITS[0], -1
    for suit in NAMED_SUITS:
        strength = suit_strength(hand, suit)
        if strength > best_strength:
            best, best_strength = suit, strength
    return best, best_strength


class HeuristicBot:
    name = "heuristic"

    def bid(self, state: HandState, seat: int) -> int:
        legal = state.legal_actions()
        target = min(42, best_suit(state.hand(seat))[1])
        if target >= 30 and target in legal:
            return target
        if PASS in legal:
            return PASS
        return min(legal)  # forced: the other three passed

    def trump(self, state: HandState, seat: int) -> int:
        return best_suit(state.hand(seat))[0]

    def play(self, state: HandState, seat: int) -> int:
        legal = state.legal_actions()
        if len(legal) == 1:
            return legal[0]
        if is_low(state.trump):
            return self._play_low(state, seat, legal)
        if not state.trick:
            return self._lead(state, seat, legal)
        return self._follow(state, seat, legal)

    def _lead_rank(self, d: int, trump: int) -> float:
        return rank(d, led_suit(d, trump), trump)

    def _lead(self, state: HandState, seat: int, legal: list[int]) -> int:
        trump = state.trump
        trumps = [d for d in legal if is_trump(d, trump)]
        if trumps and self._others_may_hold_trump(state, seat):
            return max(trumps, key=lambda d: rank(d, trump, trump))
        doubles = [d for d in legal if IS_DOUBLE[d] and d not in trumps]
        if doubles:
            return max(doubles, key=lambda d: PIPS[d][0])
        return min(legal, key=lambda d: (VALUE[d], self._lead_rank(d, trump)))

    def _others_may_hold_trump(self, state: HandState, seat: int) -> bool:
        seen = state.hands[seat]
        for mask in state.played:
            seen |= mask
        return bool(trump_mask(state.trump) & ~seen)

    def _follow(self, state: HandState, seat: int, legal: list[int]) -> int:
        trump, led = state.trump, state.led_suit
        current = [d for _, d in state.trick]
        best = trick_winner(current, trump)
        best_seat, best_rank = state.trick[best][0], rank(current[best], led, trump)
        if team_of(best_seat) == team_of(seat):
            # Partner is winning: drop count, keep trumps, shed low.
            return max(legal, key=lambda d: (VALUE[d], not is_trump(d, trump), -rank(d, led, trump)))
        winners = [d for d in legal if rank(d, led, trump) > best_rank]
        if winners:
            return min(winners, key=lambda d: (rank(d, led, trump), VALUE[d]))
        return min(legal, key=lambda d: (VALUE[d], rank(d, led, trump)))

    def _play_low(self, state: HandState, seat: int, legal: list[int]) -> int:
        trump = state.trump
        if not state.trick:
            return min(legal, key=lambda d: self._lead_rank(d, trump))
        led = state.led_suit
        current = [d for _, d in state.trick]
        best_rank = rank(current[trick_winner(current, trump)], led, trump)
        if team_of(seat) == team_of(state.bidder):
            # Bidding Low: stay under the trick; if we must win it, shed our highest.
            under = [d for d in legal if rank(d, led, trump) < best_rank]
            return max(under or legal, key=lambda d: rank(d, led, trump))
        return min(legal, key=lambda d: rank(d, led, trump))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_agents.py -v`
Expected: 11 passed

- [ ] **Step 5: Commit**

```bash
git add ml/src/fortytwo_ml/agents ml/tests/test_agents.py
git commit -m "ml: add agent protocol, dumb bot port, and heuristic bot"
```

---

### Task 8: Contract sampler and match loop

**Files:**
- Create: `ml/src/fortytwo_ml/contracts.py`, `ml/src/fortytwo_ml/engine/match.py`
- Test: `ml/tests/test_contracts.py`, `ml/tests/test_match.py`

**Interfaces:**
- Consumes: `HandState`, `Contract`, `partner` (Task 4), `HeuristicBot`, `best_suit`, `run_hand`, `choose` (Task 7).
- Produces:
  - `contracts.KINDS = ("heuristic", "marks", "follow_me", "low", "plunge")`, `DEFAULT_MIX: dict[str, float]`, `ContractSampler(mix, rng: random.Random)` with `.sample(deal_order, opener) -> Contract`, `contract_kind(contract) -> str` (one of `"plunge", "low", "follow_me", "marks", "points"`), and `KIND_ORDER` (that tuple, in report order).
  - `match.MatchResult(winning_team, marks: tuple[int,int], hands: int)` and `match.play_match(agents, rng, first_opener=0, on_illegal=None) -> MatchResult`.

- [ ] **Step 1: Write the failing tests**

`ml/tests/test_contracts.py`:
```python
import random

import pytest

from fortytwo_ml.agents.base import run_hand
from fortytwo_ml.agents.heuristic_bot import HeuristicBot
from fortytwo_ml.contracts import DEFAULT_MIX, ContractSampler, contract_kind
from fortytwo_ml.engine.enums import LOW_TRUMPS, PLUNGE, Suit
from fortytwo_ml.engine.hand_state import Contract, HandState, Phase


def _deals(n, seed=0):
    rng = random.Random(seed)
    for _ in range(n):
        order = list(range(28))
        rng.shuffle(order)
        yield order, rng.randrange(4)


@pytest.mark.parametrize("kind", ["heuristic", "marks", "follow_me", "low", "plunge"])
def test_every_kind_yields_contracts_the_engine_accepts(kind):
    sampler = ContractSampler({kind: 1.0}, random.Random(1))
    for deal, opener in _deals(200):
        c = sampler.sample(deal, opener)
        HandState.from_contract(deal, c.bidder, c.bid, c.trump)  # raises if impossible


def test_forced_kinds_produce_their_contract_types():
    rng = random.Random(2)
    deal, opener = next(_deals(1))
    assert contract_kind(ContractSampler({"follow_me": 1}, rng).sample(deal, opener)) == "follow_me"
    assert contract_kind(ContractSampler({"marks": 1}, rng).sample(deal, opener)) == "marks"
    low = ContractSampler({"low": 1}, rng).sample(deal, opener)
    assert low.trump in LOW_TRUMPS and contract_kind(low) == "low"


def test_plunge_falls_back_when_nobody_holds_four_doubles():
    kinds = {contract_kind(ContractSampler({"plunge": 1}, random.Random(3)).sample(d, o)) for d, o in _deals(300)}
    assert "plunge" in kinds and kinds - {"plunge"}


def test_contract_kind_classification():
    assert contract_kind(Contract(0, PLUNGE, Suit.NONE)) == "plunge"
    assert contract_kind(Contract(0, 42, Suit.LOW)) == "low"
    assert contract_kind(Contract(0, 42, Suit.NONE)) == "follow_me"
    assert contract_kind(Contract(0, 84, Suit.SIXES)) == "marks"
    assert contract_kind(Contract(0, 31, Suit.SIXES)) == "points"


def test_unknown_kind_is_rejected():
    with pytest.raises(ValueError):
        ContractSampler({"nello": 1.0}, random.Random(0))


def test_heuristic_plays_every_sampled_contract_legally():
    sampler = ContractSampler(DEFAULT_MIX, random.Random(4))
    for deal, opener in _deals(500, seed=4):
        c = sampler.sample(deal, opener)
        state = HandState.from_contract(deal, c.bidder, c.bid, c.trump)
        run_hand(state, [HeuristicBot()] * 4)
        assert state.phase is Phase.DONE
```

`ml/tests/test_match.py`:
```python
import random

from fortytwo_ml.agents.heuristic_bot import HeuristicBot
from fortytwo_ml.engine.match import play_match


def test_match_runs_to_seven_marks():
    result = play_match([HeuristicBot()] * 4, random.Random(0))
    assert max(result.marks) >= 7 and result.marks[result.winning_team] >= 7
    assert min(result.marks) < 7 and result.hands >= 2


def test_match_is_deterministic_for_a_seed():
    a = play_match([HeuristicBot()] * 4, random.Random(5))
    b = play_match([HeuristicBot()] * 4, random.Random(5))
    assert a == b
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_contracts.py tests/test_match.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement**

`ml/src/fortytwo_ml/contracts.py`:
```python
"""Where Stage 1 training hands get their contract. Bidding isn't learned yet, so most contracts
come from the heuristic bot bidding the real deal, and a share are forced exotics so the play model
learns every contract type it can face in a live game."""
import random
from collections.abc import Mapping, Sequence

from .agents.base import choose
from .agents.heuristic_bot import HeuristicBot, best_suit
from .engine.dominoes import doubles_in, to_mask
from .engine.enums import LOW_TRUMPS, PLUNGE, Suit, is_low
from .engine.hand_state import Contract, HandState, Phase, partner

KINDS = ("heuristic", "marks", "follow_me", "low", "plunge")
DEFAULT_MIX: dict[str, float] = {"heuristic": 0.7, "marks": 0.08, "follow_me": 0.07, "low": 0.1, "plunge": 0.05}
KIND_ORDER = ("points", "marks", "plunge", "follow_me", "low")


def contract_kind(contract: Contract) -> str:
    if contract.bid == PLUNGE:
        return "plunge"
    if is_low(contract.trump):
        return "low"
    if contract.trump == Suit.NONE:
        return "follow_me"
    return "marks" if contract.bid > 42 else "points"


class ContractSampler:
    def __init__(self, mix: Mapping[str, float], rng: random.Random):
        unknown = set(mix) - set(KINDS)
        if unknown:
            raise ValueError(f"unknown contract kinds: {sorted(unknown)}")
        if sum(mix.values()) <= 0:
            raise ValueError("contract mix needs a positive weight")
        self._kinds = list(mix)
        self._weights = [mix[k] for k in self._kinds]
        self._rng = rng
        self._bot = HeuristicBot()

    def sample(self, deal_order: Sequence[int], opener: int) -> Contract:
        kind = self._rng.choices(self._kinds, self._weights)[0]
        return self._forced(kind, deal_order) or self._heuristic(deal_order, opener)

    def _heuristic(self, deal_order: Sequence[int], opener: int) -> Contract:
        state = HandState.deal(deal_order, opener)
        while state.phase in (Phase.BID, Phase.TRUMP):
            state.apply(choose(self._bot, state))
        return state.contract

    def _forced(self, kind: str, deal_order: Sequence[int]) -> Contract | None:
        hands = [list(deal_order[p * 7:(p + 1) * 7]) for p in range(4)]
        strengths = [best_suit(h)[1] for h in hands]
        strongest = max(range(4), key=lambda s: strengths[s])
        if kind == "marks":
            return Contract(strongest, 84, best_suit(hands[strongest])[0])
        if kind == "follow_me":
            return Contract(strongest, 42, Suit.NONE)
        if kind == "low":
            weakest = min(range(4), key=lambda s: strengths[s])
            return Contract(weakest, 42, self._rng.choice(LOW_TRUMPS))
        if kind == "plunge":
            plungers = [s for s in range(4) if doubles_in(to_mask(hands[s])) >= 4]
            if not plungers:
                return None
            seat = self._rng.choice(plungers)
            return Contract(seat, PLUNGE, best_suit(hands[partner(seat)])[0])
        return None  # "heuristic"
```

`ml/src/fortytwo_ml/engine/match.py`:
```python
"""A match: hands until a team has 7 marks, the opener moving one seat each hand (patchPlayerReady)."""
import random
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from ..agents.base import run_hand
from .hand_state import HandState

WINNING_SCORE = 7


@dataclass(frozen=True)
class MatchResult:
    winning_team: int
    marks: tuple[int, int]
    hands: int


def play_match(
    agents: Sequence,
    rng: random.Random,
    first_opener: int = 0,
    on_illegal: Callable[[int, int], None] | None = None,
) -> MatchResult:
    marks = [0, 0]
    opener = first_opener
    hands = 0
    while max(marks) < WINNING_SCORE:
        order = list(range(28))
        rng.shuffle(order)
        result = run_hand(HandState.deal(order, opener), agents, on_illegal)
        marks[result.winning_team] += result.marks
        opener = (opener + 1) % 4
        hands += 1
    return MatchResult(0 if marks[0] >= WINNING_SCORE else 1, (marks[0], marks[1]), hands)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_contracts.py tests/test_match.py -v`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add ml/src/fortytwo_ml/contracts.py ml/src/fortytwo_ml/engine/match.py ml/tests/test_contracts.py ml/tests/test_match.py
git commit -m "ml: add contract sampler and match loop"
```

---

### Task 9: Observation encoding

**Files:**
- Create: `ml/src/fortytwo_ml/features.py`
- Test: `ml/tests/test_features.py`

**Interfaces:**
- Consumes: `HandState`, `team_of`, `partner` (Task 4), `CONTRACT_BIDS` (Task 3), and `ALL_TRUMPS` (Task 1).
- Produces:
  - constants `OBS_DIM = 325`, `ACTION_DIM = 28`, `INPUT_DIM = 353`, and the block offsets `HAND, PLAYED, TRICK, LED, TRUMP, BID, BIDDER, PLUNGE_FLAG, SITS_OUT, VOIDS, SCALARS`;
  - `encode_observation(state, seat) -> np.ndarray` (float32, shape `(325,)`);
  - `encode_actions(state, seat, actions: Sequence[int]) -> np.ndarray` (float32, shape `(len(actions), 353)`).
- Valid only in `Phase.PLAY`.

- [ ] **Step 1: Write the failing tests**

`ml/tests/test_features.py`:
```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_features.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement**

`ml/src/fortytwo_ml/features.py`:
```python
"""What the play model sees, from the acting seat's point of view: seats are rotated so the actor
is 0, its partner 2, and the opponents 1 (left) and 3 (right). A pure function of the hand state,
so Stage 4 can port it to TS and parity-test it."""
from collections.abc import Sequence

import numpy as np

from .engine.bidding import CONTRACT_BIDS
from .engine.enums import ALL_TRUMPS, PLUNGE
from .engine.hand_state import HandState, partner, team_of

HAND = 0                  # 28: own hand
PLAYED = HAND + 28        # 4 x 28: dominoes each relative seat has played (current trick included)
TRICK = PLAYED + 4 * 28   # 4 x 28: the current trick, by relative seat
LED = TRICK + 4 * 28      # 9: led suit 0..6, DOUBLES (7), or none yet (8)
TRUMP = LED + 9           # 11: ALL_TRUMPS one-hot
BID = TRUMP + 11          # 20: CONTRACT_BIDS one-hot
BIDDER = BID + 20         # 4: bidder's relative seat
PLUNGE_FLAG = BIDDER + 4  # 1
SITS_OUT = PLUNGE_FLAG + 1  # 1: my partner sits out (Low)
VOIDS = SITS_OUT + 1      # 3 x 8: relative seats 1..3 x led suits they failed to follow
SCALARS = VOIDS + 24      # 3: our points / 42, their points / 42, tricks played / 7
OBS_DIM = SCALARS + 3
ACTION_DIM = 28
INPUT_DIM = OBS_DIM + ACTION_DIM

_TRUMP_INDEX = {t: i for i, t in enumerate(ALL_TRUMPS)}
_BID_INDEX = {b: i for i, b in enumerate(CONTRACT_BIDS)}


def _bits(x: np.ndarray, offset: int, mask: int) -> None:
    while mask:
        low = mask & -mask
        x[offset + low.bit_length() - 1] = 1.0
        mask ^= low


def encode_observation(state: HandState, seat: int) -> np.ndarray:
    x = np.zeros(OBS_DIM, dtype=np.float32)

    def rel(s: int) -> int:
        return (s - seat) % 4

    _bits(x, HAND, state.hands[seat])
    for s in range(4):
        _bits(x, PLAYED + rel(s) * 28, state.played[s])
    for s, d in state.trick:
        x[TRICK + rel(s) * 28 + d] = 1.0
    led = state.led_suit
    x[LED + (8 if led is None else led)] = 1.0
    x[TRUMP + _TRUMP_INDEX[state.trump]] = 1.0
    x[BID + _BID_INDEX[state.high_bid]] = 1.0
    x[BIDDER + rel(state.bidder)] = 1.0
    x[PLUNGE_FLAG] = float(state.high_bid == PLUNGE)
    x[SITS_OUT] = float(state.sits_out == partner(seat))
    for s in range(4):
        if s != seat:
            _bits(x, VOIDS + (rel(s) - 1) * 8, state.voids[s])
    team = team_of(seat)
    x[SCALARS] = state.points[team] / 42
    x[SCALARS + 1] = state.points[1 - team] / 42
    x[SCALARS + 2] = len(state.tricks) / 7
    return x


def encode_actions(state: HandState, seat: int, actions: Sequence[int]) -> np.ndarray:
    xs = np.zeros((len(actions), INPUT_DIM), dtype=np.float32)
    xs[:, :OBS_DIM] = encode_observation(state, seat)
    for i, a in enumerate(actions):
        xs[i, OBS_DIM + a] = 1.0
    return xs
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_features.py -v`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add ml/src/fortytwo_ml/features.py ml/tests/test_features.py
git commit -m "ml: add observation and action encoding"
```

---

### Task 10: Q-network, checkpoints, and ModelAgent

**Files:**
- Create: `ml/src/fortytwo_ml/model.py`, `ml/src/fortytwo_ml/agents/model_agent.py`
- Test: `ml/tests/test_model.py`

**Interfaces:**
- Consumes: `INPUT_DIM` and `encode_actions` (Task 9), and `HeuristicBot` (Task 7).
- Produces:
  - `QNet(hidden=512, layers=4)` (`nn.Module`, with attributes `hidden` and `layers`; `forward(x: (N, 353)) -> (N,)`);
  - `save_checkpoint(path, model, step: int, config: dict) -> None` and `load_checkpoint(path, device="cpu") -> tuple[QNet, dict]` (the dict has `step` and `config`);
  - `ModelAgent(model, name="model")`, with `.from_checkpoint(path)`, `.q_values(state, seat) -> list[tuple[int, float]]`, and bid/trump delegated to `HeuristicBot`.

- [ ] **Step 1: Write the failing tests**

`ml/tests/test_model.py`:
```python
import random

import torch

from fortytwo_ml.agents.base import run_hand
from fortytwo_ml.agents.model_agent import ModelAgent
from fortytwo_ml.contracts import DEFAULT_MIX, ContractSampler
from fortytwo_ml.engine.hand_state import HandState, Phase
from fortytwo_ml.features import INPUT_DIM
from fortytwo_ml.model import QNet, load_checkpoint, save_checkpoint


def test_qnet_maps_rows_to_scalars():
    net = QNet(hidden=32, layers=2)
    assert net(torch.zeros(5, INPUT_DIM)).shape == (5,)


def test_checkpoint_round_trip_keeps_dims_and_weights(tmp_path):
    torch.manual_seed(0)
    net = QNet(hidden=32, layers=3)
    path = tmp_path / "c.pt"
    save_checkpoint(path, net, step=12, config={"hidden": 32})
    loaded, meta = load_checkpoint(path)
    assert (loaded.hidden, loaded.layers) == (32, 3) and meta["step"] == 12
    x = torch.randn(4, INPUT_DIM)
    assert torch.allclose(net(x), loaded(x))


def test_model_agent_plays_legal_hands_even_untrained():
    agent = ModelAgent(QNet(hidden=32, layers=2))
    rng = random.Random(0)
    sampler = ContractSampler(DEFAULT_MIX, rng)
    for _ in range(50):
        order = list(range(28))
        rng.shuffle(order)
        c = sampler.sample(order, rng.randrange(4))
        state = HandState.from_contract(order, c.bidder, c.bid, c.trump)
        assert len(agent.q_values(state, state.to_act)) == len(state.legal_actions())
        run_hand(state, [agent] * 4)
        assert state.phase is Phase.DONE
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_model.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement**

`ml/src/fortytwo_ml/model.py`:
```python
"""Q(observation, candidate domino) -> expected final hand reward for the actor's team."""
from pathlib import Path

import torch
from torch import nn

from .features import INPUT_DIM


class QNet(nn.Module):
    def __init__(self, hidden: int = 512, layers: int = 4):
        super().__init__()
        self.hidden = hidden
        self.layers = layers
        blocks: list[nn.Module] = []
        width = INPUT_DIM
        for _ in range(layers):
            blocks += [nn.Linear(width, hidden), nn.ReLU()]
            width = hidden
        blocks.append(nn.Linear(width, 1))
        self.net = nn.Sequential(*blocks)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x).squeeze(-1)


def save_checkpoint(path: str | Path, model: QNet, step: int, config: dict) -> None:
    state = {k: v.detach().cpu() for k, v in model.state_dict().items()}
    torch.save(
        {"model": state, "hidden": model.hidden, "layers": model.layers, "step": step, "config": config},
        path,
    )


def load_checkpoint(path: str | Path, device: str = "cpu") -> tuple[QNet, dict]:
    data = torch.load(path, map_location=device, weights_only=True)
    model = QNet(data["hidden"], data["layers"])
    model.load_state_dict(data["model"])
    model.eval()
    return model, {"step": data["step"], "config": data["config"]}
```

`ml/src/fortytwo_ml/agents/model_agent.py`:
```python
"""Plays with a trained QNet. Stage 1 doesn't learn bidding, so bids and trump come from the
heuristic bot."""
from pathlib import Path

import torch

from ..engine.hand_state import HandState
from ..features import encode_actions
from ..model import QNet, load_checkpoint
from .heuristic_bot import HeuristicBot


class ModelAgent:
    def __init__(self, model: QNet, name: str = "model"):
        self.model = model.eval()
        self.name = name
        self._fallback = HeuristicBot()

    @classmethod
    def from_checkpoint(cls, path: str | Path) -> "ModelAgent":
        model, _ = load_checkpoint(path)
        return cls(model, name=Path(path).name)

    def bid(self, state: HandState, seat: int) -> int:
        return self._fallback.bid(state, seat)

    def trump(self, state: HandState, seat: int) -> int:
        return self._fallback.trump(state, seat)

    def q_values(self, state: HandState, seat: int) -> list[tuple[int, float]]:
        legal = state.legal_actions()
        with torch.no_grad():
            q = self.model(torch.from_numpy(encode_actions(state, seat, legal))).tolist()
        return list(zip(legal, q))

    def play(self, state: HandState, seat: int) -> int:
        legal = state.legal_actions()
        if len(legal) == 1:
            return legal[0]
        return max(self.q_values(state, seat), key=lambda pair: pair[1])[0]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_model.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add ml/src/fortytwo_ml/model.py ml/src/fortytwo_ml/agents/model_agent.py ml/tests/test_model.py
git commit -m "ml: add Q-network, checkpoints, and model agent"
```

---

### Task 11: Evaluation arena and report

**Files:**
- Create: `ml/src/fortytwo_ml/eval/__init__.py` (empty), `ml/src/fortytwo_ml/eval/arena.py`, `ml/src/fortytwo_ml/eval/report.py`
- Test: `ml/tests/test_eval.py`

**Interfaces:**
- Consumes: `run_hand`, `Agent` (Task 7), `ContractSampler`, `DEFAULT_MIX`, `contract_kind`, `KIND_ORDER` (Task 8), `play_match` (Task 8), and `HandState`, `team_of` (Task 4).
- Produces:
  - `HandRecord(kind, a_bidding, bidders_won, a_marks)`;
  - `HandEval(a_name, b_name, records, deal_scores, illegal: dict[str,int])`;
  - `evaluate_hands(a, b, deals, seed=0, mix=None) -> HandEval`;
  - `MatchEval(a_wins, matches, illegal)` and `evaluate_matches(a, b, matches, seed=0) -> MatchEval`;
  - `report.mean_ci(values) -> tuple[float, float, float]`, `report.proportion_ci(k, n) -> tuple[float, float, float]`, and `report.format_report(hands, matches=None) -> str`.

- [ ] **Step 1: Write the failing tests**

`ml/tests/test_eval.py`:
```python
from fortytwo_ml.agents.dumb_bot import DumbBot
from fortytwo_ml.agents.heuristic_bot import HeuristicBot
from fortytwo_ml.eval.arena import evaluate_hands, evaluate_matches
from fortytwo_ml.eval.report import format_report, mean_ci, proportion_ci


class IllegalBot(HeuristicBot):
    name = "illegal"

    def play(self, state, seat):
        return 99


def test_duplicate_deals_play_each_deal_from_both_sides():
    result = evaluate_hands(HeuristicBot(), DumbBot(), deals=30, seed=1)
    assert len(result.records) == 60 and len(result.deal_scores) == 30
    assert sum(r.a_bidding for r in result.records) == 30
    assert result.illegal == {"a": 0, "b": 0}


def test_evaluation_is_deterministic_for_a_seed():
    a = evaluate_hands(HeuristicBot(), DumbBot(), deals=20, seed=9)
    b = evaluate_hands(HeuristicBot(), DumbBot(), deals=20, seed=9)
    assert a.deal_scores == b.deal_scores


def test_heuristic_beats_dumb_at_trick_play():
    result = evaluate_hands(HeuristicBot(), DumbBot(), deals=300, seed=0)
    mean, lo, _ = mean_ci(result.deal_scores)
    assert mean > 0 and lo > 0


def test_illegal_actions_are_counted_not_fatal():
    result = evaluate_hands(IllegalBot(), HeuristicBot(), deals=5, seed=0)
    assert result.illegal["a"] > 0 and result.illegal["b"] == 0
    assert len(result.deal_scores) == 5


def test_matches_and_report():
    matches = evaluate_matches(HeuristicBot(), DumbBot(), matches=4, seed=0)
    assert matches.matches == 4 and 0 <= matches.a_wins <= 4
    text = format_report(evaluate_hands(HeuristicBot(), DumbBot(), deals=20), matches)
    assert "Mean marks/deal" in text and "Match win rate" in text and "Illegal actions: A=0 B=0" in text


def test_confidence_intervals():
    assert mean_ci([1, 1, 1]) == (1, 1, 1)
    mean, lo, hi = mean_ci([0, 2, 0, 2])
    assert mean == 1 and lo < 1 < hi
    p, lo, hi = proportion_ci(50, 100)
    assert p == 0.5 and round(hi - lo, 3) == 0.196
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_eval.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement**

`ml/src/fortytwo_ml/eval/arena.py`:
```python
"""Head-to-head evaluation on duplicate deals: every deal is played twice with the same dominoes
and contract, the two agents swapping sides, so most of the deal's luck cancels out."""
import random
from collections.abc import Mapping
from dataclasses import dataclass, field

from ..agents.base import Agent, run_hand
from ..contracts import DEFAULT_MIX, ContractSampler, contract_kind
from ..engine.hand_state import HandState, team_of
from ..engine.match import play_match


@dataclass(frozen=True)
class HandRecord:
    kind: str
    a_bidding: bool
    bidders_won: bool
    a_marks: int  # signed: + when A's team won the hand


@dataclass
class HandEval:
    a_name: str
    b_name: str
    records: list[HandRecord] = field(default_factory=list)
    deal_scores: list[int] = field(default_factory=list)  # A's net marks per duplicate deal
    illegal: dict[str, int] = field(default_factory=lambda: {"a": 0, "b": 0})


@dataclass
class MatchEval:
    a_wins: int
    matches: int
    illegal: dict[str, int]


def _seats(a: Agent, b: Agent, a_team: int) -> list[Agent]:
    return [a if team_of(s) == a_team else b for s in range(4)]


def _illegal_counter(illegal: dict[str, int], a_team: int):
    def count(seat: int, _action: int) -> None:
        illegal["a" if team_of(seat) == a_team else "b"] += 1
    return count


def evaluate_hands(
    a: Agent, b: Agent, deals: int, seed: int = 0, mix: Mapping[str, float] | None = None
) -> HandEval:
    result = HandEval(a.name, b.name)
    for i in range(deals):
        rng = random.Random(f"{seed}:{i}")
        order = list(range(28))
        rng.shuffle(order)
        contract = ContractSampler(mix or DEFAULT_MIX, rng).sample(order, rng.randrange(4))
        kind = contract_kind(contract)
        bidders = team_of(contract.bidder)
        score = 0
        for a_team in (0, 1):
            state = HandState.from_contract(order, contract.bidder, contract.bid, contract.trump)
            hand = run_hand(state, _seats(a, b, a_team), _illegal_counter(result.illegal, a_team))
            a_marks = hand.marks if hand.winning_team == a_team else -hand.marks
            result.records.append(HandRecord(kind, bidders == a_team, hand.winning_team == bidders, a_marks))
            score += a_marks
        result.deal_scores.append(score)
    return result


def evaluate_matches(a: Agent, b: Agent, matches: int, seed: int = 0) -> MatchEval:
    illegal = {"a": 0, "b": 0}
    wins = 0
    for i in range(matches):
        rng = random.Random(f"match:{seed}:{i}")
        a_team = i % 2
        result = play_match(_seats(a, b, a_team), rng, rng.randrange(4), _illegal_counter(illegal, a_team))
        wins += result.winning_team == a_team
    return MatchEval(wins, matches, illegal)
```

`ml/src/fortytwo_ml/eval/report.py`:
```python
import math
import statistics
from collections.abc import Sequence

from ..contracts import KIND_ORDER
from .arena import HandEval, MatchEval

Z95 = 1.96


def mean_ci(values: Sequence[float]) -> tuple[float, float, float]:
    mean = statistics.fmean(values)
    if len(values) < 2:
        return mean, mean, mean
    half = Z95 * statistics.stdev(values) / math.sqrt(len(values))
    return mean, mean - half, mean + half


def proportion_ci(k: int, n: int) -> tuple[float, float, float]:
    p = k / n
    half = Z95 * math.sqrt(p * (1 - p) / n)
    return p, p - half, p + half


def _rate(hits: int, n: int) -> str:
    return f"{hits / n:6.1%} (n={n})" if n else "     - (n=0)"


def format_report(hands: HandEval, matches: MatchEval | None = None) -> str:
    mean, lo, hi = mean_ci(hands.deal_scores)
    lines = [
        f"A: {hands.a_name}  vs  B: {hands.b_name}  -  {len(hands.deal_scores)} duplicate deals",
        f"Mean marks/deal (A): {mean:+.3f}  [95% CI {lo:+.3f}, {hi:+.3f}]",
        "By contract type:        A bidding: made        A defending: set",
    ]
    for kind in KIND_ORDER:
        recs = [r for r in hands.records if r.kind == kind]
        if not recs:
            continue
        bidding = [r for r in recs if r.a_bidding]
        defending = [r for r in recs if not r.a_bidding]
        made = sum(r.bidders_won for r in bidding)
        set_ = sum(not r.bidders_won for r in defending)
        lines.append(f"  {kind:<10}             {_rate(made, len(bidding))}      {_rate(set_, len(defending))}")
    illegal = dict(hands.illegal)
    if matches is not None:
        p, plo, phi = proportion_ci(matches.a_wins, matches.matches)
        lines.append(f"Match win rate (A): {p:.1%}  [95% CI {plo:.1%}, {phi:.1%}] over {matches.matches} matches")
        illegal = {k: illegal[k] + matches.illegal[k] for k in illegal}
    lines.append(f"Illegal actions: A={illegal['a']} B={illegal['b']}")
    return "\n".join(lines)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_eval.py -v`
Expected: 6 passed. If `test_heuristic_beats_dumb_at_trick_play` fails, the heuristic has a bug. It has to beat first-legal-domino play, so debug it; don't loosen the test.

- [ ] **Step 5: Commit**

```bash
git add ml/src/fortytwo_ml/eval ml/tests/test_eval.py
git commit -m "ml: add duplicate-deal arena and report"
```

---

### Task 12: Training config, self-play, and replay buffer

**Files:**
- Create: `ml/src/fortytwo_ml/train/__init__.py` (empty), `ml/src/fortytwo_ml/train/config.py`, `ml/src/fortytwo_ml/train/selfplay.py`, `ml/src/fortytwo_ml/train/buffer.py`
- Create: `ml/configs/stage1.yaml`, `ml/configs/smoke.yaml`
- Test: `ml/tests/test_train_parts.py`

**Interfaces:**
- Consumes: `QNet` (Task 10), `ContractSampler` and `DEFAULT_MIX` (Task 8), `encode_actions` and `INPUT_DIM` (Task 9), and `HandState`, `Phase`, `team_of` (Task 4).
- Produces:
  - `TrainConfig` (frozen dataclass; fields are listed in the code), `TrainConfig.from_yaml(path)`, `.to_dict()`, `.num_actors`;
  - `shaping_alpha(cfg, step) -> float` and `resolve_device(cfg) -> torch.device`;
  - `play_selfplay_hand(model, sampler, rng, epsilon) -> tuple[np.ndarray (n,353) float32, np.ndarray (n,) marks, np.ndarray (n,) point_diff]`;
  - `ReplayBuffer(capacity, dim)` with `.add(x, marks, pdiff)`, `.sample(n, rng: np.random.Generator) -> (x float32, marks, pdiff)`, and `len()`.

- [ ] **Step 1: Write the configs**

`ml/configs/stage1.yaml`:
```yaml
# Stage 1: trick-play by Deep Monte-Carlo self-play. See docs/superpowers/specs/2026-09-29-ml-bots-stage1-design.md.
device: cuda
allow_cpu_fallback: false
seed: 0
actors: 0            # 0 = CPU cores - 2
epsilon: 0.05
hidden: 512
layers: 4
lr: 0.0003
batch_size: 1024
buffer_size: 200000
min_buffer: 20000
weight_sync_every: 50
total_steps: 2000000
alpha0: 0.25         # point-difference shaping, decayed linearly to 0
alpha_decay_steps: 200000
log_every: 100
checkpoint_minutes: 15
eval_every_steps: 20000
eval_deals: 500
contract_mix:
  heuristic: 0.7
  marks: 0.08
  follow_me: 0.07
  low: 0.1
  plunge: 0.05
```

`ml/configs/smoke.yaml`:
```yaml
# Tiny CPU run for tests/CI: proves the pipeline end to end, learns nothing.
device: cpu
seed: 0
actors: 2
hidden: 64
layers: 2
batch_size: 64
buffer_size: 10000
min_buffer: 256
weight_sync_every: 20
total_steps: 200
alpha_decay_steps: 100
log_every: 20
checkpoint_minutes: 60
eval_every_steps: 100
eval_deals: 10
```

- [ ] **Step 2: Write the failing tests**

`ml/tests/test_train_parts.py`:
```python
import random
from pathlib import Path

import numpy as np
import pytest
import torch

from fortytwo_ml.contracts import DEFAULT_MIX, ContractSampler
from fortytwo_ml.features import INPUT_DIM
from fortytwo_ml.model import QNet
from fortytwo_ml.train.buffer import ReplayBuffer
from fortytwo_ml.train.config import TrainConfig, resolve_device, shaping_alpha
from fortytwo_ml.train.selfplay import play_selfplay_hand

CONFIGS = Path(__file__).parent.parent / "configs"


def test_configs_load():
    stage1 = TrainConfig.from_yaml(CONFIGS / "stage1.yaml")
    assert stage1.device == "cuda" and stage1.contract_mix["heuristic"] == 0.7
    smoke = TrainConfig.from_yaml(CONFIGS / "smoke.yaml")
    assert smoke.device == "cpu" and smoke.num_actors == 2


def test_unknown_config_keys_are_rejected(tmp_path):
    path = tmp_path / "bad.yaml"
    path.write_text("learning_rate: 0.1\n")
    with pytest.raises(ValueError, match="learning_rate"):
        TrainConfig.from_yaml(path)


def test_shaping_decays_to_zero():
    cfg = TrainConfig(alpha0=0.25, alpha_decay_steps=100)
    assert shaping_alpha(cfg, 0) == 0.25
    assert shaping_alpha(cfg, 50) == pytest.approx(0.125)
    assert shaping_alpha(cfg, 100) == 0 and shaping_alpha(cfg, 500) == 0


def test_resolve_device_fails_fast_without_cuda(monkeypatch):
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    with pytest.raises(RuntimeError, match="allow_cpu_fallback"):
        resolve_device(TrainConfig(device="cuda"))


def test_resolve_device_falls_back_when_allowed(monkeypatch):
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    assert resolve_device(TrainConfig(device="cuda", allow_cpu_fallback=True)).type == "cpu"


def test_selfplay_hand_yields_consistent_samples():
    rng = random.Random(0)
    model = QNet(hidden=32, layers=2)
    for _ in range(20):
        x, marks, pdiff = play_selfplay_hand(model, ContractSampler(DEFAULT_MIX, rng), rng, epsilon=0.1)
        assert x.shape == (len(marks), INPUT_DIM) and len(pdiff) == len(marks)
        assert np.all(np.abs(marks) >= 1)
        assert np.all(np.abs(pdiff) <= 1)


def test_buffer_wraps_and_samples():
    buf = ReplayBuffer(capacity=10, dim=3)
    for i in range(4):
        buf.add(np.full((4, 3), i, np.float32), np.full(4, i, np.float32), np.zeros(4, np.float32))
    assert len(buf) == 10
    x, marks, pdiff = buf.sample(6, np.random.default_rng(0))
    assert x.shape == (6, 3) and x.dtype == np.float32
    assert set(np.unique(marks)) <= {1.0, 2.0, 3.0}  # the first batch was overwritten
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_train_parts.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 4: Implement**

`ml/src/fortytwo_ml/train/config.py`:
```python
import os
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

import torch
import yaml

from ..contracts import DEFAULT_MIX


@dataclass(frozen=True)
class TrainConfig:
    device: str = "cuda"
    allow_cpu_fallback: bool = False
    seed: int = 0
    actors: int = 0  # 0 = CPU cores - 2
    epsilon: float = 0.05
    hidden: int = 512
    layers: int = 4
    lr: float = 3e-4
    batch_size: int = 1024
    buffer_size: int = 200_000
    min_buffer: int = 20_000
    weight_sync_every: int = 50
    total_steps: int = 2_000_000
    alpha0: float = 0.25
    alpha_decay_steps: int = 200_000
    log_every: int = 100
    checkpoint_minutes: float = 15.0
    eval_every_steps: int = 20_000
    eval_deals: int = 500
    contract_mix: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_MIX))

    @classmethod
    def from_yaml(cls, path: str | Path) -> "TrainConfig":
        data = yaml.safe_load(Path(path).read_text()) or {}
        unknown = set(data) - {f.name for f in fields(cls)}
        if unknown:
            raise ValueError(f"unknown config keys in {path}: {sorted(unknown)}")
        return cls(**data)

    def to_dict(self) -> dict:
        return asdict(self)

    @property
    def num_actors(self) -> int:
        return self.actors or max(1, (os.cpu_count() or 2) - 2)


def shaping_alpha(cfg: TrainConfig, step: int) -> float:
    if cfg.alpha_decay_steps <= 0:
        return 0.0
    return cfg.alpha0 * max(0.0, 1.0 - step / cfg.alpha_decay_steps)


def resolve_device(cfg: TrainConfig) -> torch.device:
    if cfg.device.startswith("cuda") and not torch.cuda.is_available():
        if not cfg.allow_cpu_fallback:
            raise RuntimeError(
                "config asks for CUDA but torch can't see a GPU; set allow_cpu_fallback: true to train on CPU"
            )
        return torch.device("cpu")
    return torch.device(cfg.device)
```

`ml/src/fortytwo_ml/train/selfplay.py`:
```python
"""One self-play hand for Deep Monte-Carlo training: all four seats use the same network with
epsilon-greedy exploration, and every real decision (more than one legal domino) becomes a sample
labeled with the hand's final outcome for the deciding seat's team."""
import random

import numpy as np
import torch

from ..contracts import ContractSampler
from ..engine.hand_state import HandState, Phase, team_of
from ..features import INPUT_DIM, encode_actions
from ..model import QNet


def play_selfplay_hand(
    model: QNet, sampler: ContractSampler, rng: random.Random, epsilon: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    order = list(range(28))
    rng.shuffle(order)
    contract = sampler.sample(order, rng.randrange(4))
    state = HandState.from_contract(order, contract.bidder, contract.bid, contract.trump)

    rows: list[np.ndarray] = []
    teams: list[int] = []
    while state.phase is not Phase.DONE:
        seat = state.to_act
        legal = state.legal_actions()
        if len(legal) == 1:
            state.apply(legal[0])
            continue
        xs = encode_actions(state, seat, legal)
        if rng.random() < epsilon:
            i = rng.randrange(len(legal))
        else:
            with torch.no_grad():
                i = int(model(torch.from_numpy(xs)).argmax())
        rows.append(xs[i])
        teams.append(team_of(seat))
        state.apply(legal[i])

    result = state.result
    marks = np.array([result.marks if t == result.winning_team else -result.marks for t in teams], np.float32)
    pdiff = np.array([(result.points[t] - result.points[1 - t]) / 42 for t in teams], np.float32)
    x = np.stack(rows) if rows else np.zeros((0, INPUT_DIM), np.float32)
    return x, marks, pdiff
```

`ml/src/fortytwo_ml/train/buffer.py`:
```python
import numpy as np


class ReplayBuffer:
    """A ring buffer of (input row, marks reward, point-difference) samples. Rows are stored as
    float16 (they're almost all 0/1) to keep a 200k buffer small."""

    def __init__(self, capacity: int, dim: int):
        self.capacity = capacity
        self._x = np.zeros((capacity, dim), np.float16)
        self._marks = np.zeros(capacity, np.float32)
        self._pdiff = np.zeros(capacity, np.float32)
        self._pos = 0
        self._size = 0

    def __len__(self) -> int:
        return self._size

    def add(self, x: np.ndarray, marks: np.ndarray, pdiff: np.ndarray) -> None:
        for i in range(len(marks)):
            self._x[self._pos] = x[i]
            self._marks[self._pos] = marks[i]
            self._pdiff[self._pos] = pdiff[i]
            self._pos = (self._pos + 1) % self.capacity
            self._size = min(self._size + 1, self.capacity)

    def sample(self, n: int, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        idx = rng.integers(0, self._size, size=n)
        return self._x[idx].astype(np.float32), self._marks[idx], self._pdiff[idx]
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_train_parts.py -v`
Expected: 8 passed

- [ ] **Step 6: Commit**

```bash
git add ml/configs ml/src/fortytwo_ml/train ml/tests/test_train_parts.py
git commit -m "ml: add training config, self-play hands, and replay buffer"
```

---

### Task 13: Actors, learner, and the smoke test

**Files:**
- Create: `ml/src/fortytwo_ml/train/actor.py`, `ml/src/fortytwo_ml/train/run.py`
- Test: `ml/tests/test_train_smoke.py`

**Interfaces:**
- Consumes: everything from Task 12, plus `QNet` and `save_checkpoint` / `load_checkpoint` (Task 10), `evaluate_hands` and `mean_ci` (Task 11), `ModelAgent` (Task 10), and `HeuristicBot` (Task 7).
- Produces:
  - `actor_main(actor_id, cfg, shared_model, version, queue, stop) -> None`;
  - `TrainSummary(steps: int, last_loss: float, checkpoint: Path)`;
  - `train(cfg: TrainConfig, run_dir: Path, resume: Path | None = None) -> TrainSummary`;
  - `check_actors(actors) -> None` (raises `RuntimeError` naming the dead actor).
  - Run directory contents: `config.yaml`, `ckpt-<step>.pt`, `ckpt-latest.pt`, and `tb/`.

- [ ] **Step 1: Write the failing tests**

`ml/tests/test_train_smoke.py`:
```python
import math
import random
from pathlib import Path

import pytest
import torch.multiprocessing as mp

from fortytwo_ml.agents.base import run_hand
from fortytwo_ml.agents.model_agent import ModelAgent
from fortytwo_ml.engine.hand_state import HandState, Phase
from fortytwo_ml.train.config import TrainConfig
from fortytwo_ml.train.run import check_actors, train

CONFIGS = Path(__file__).parent.parent / "configs"


def test_check_actors_raises_when_an_actor_died():
    ctx = mp.get_context("spawn")
    p = ctx.Process(target=int, name="actor-7")
    p.start()
    p.join()
    with pytest.raises(RuntimeError, match="actor-7"):
        check_actors([p])


def test_smoke_training_run_produces_a_playable_checkpoint(tmp_path):
    cfg = TrainConfig.from_yaml(CONFIGS / "smoke.yaml")
    summary = train(cfg, tmp_path / "run")
    assert summary.steps == cfg.total_steps
    assert math.isfinite(summary.last_loss)
    assert (tmp_path / "run" / "config.yaml").exists()
    assert list((tmp_path / "run" / "tb").iterdir())

    agent = ModelAgent.from_checkpoint(summary.checkpoint)
    order = list(range(28))
    random.Random(0).shuffle(order)
    state = HandState.deal(order, opener=0)
    run_hand(state, [agent] * 4)
    assert state.phase is Phase.DONE


def test_resume_continues_from_the_checkpoint_step(tmp_path):
    cfg = TrainConfig.from_yaml(CONFIGS / "smoke.yaml")
    first = train(cfg, tmp_path / "a")
    more = TrainConfig(**{**cfg.to_dict(), "total_steps": cfg.total_steps + 40})
    second = train(more, tmp_path / "b", resume=first.checkpoint)
    assert second.steps == cfg.total_steps + 40
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_train_smoke.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'fortytwo_ml.train.run'`

- [ ] **Step 3: Implement**

`ml/src/fortytwo_ml/train/actor.py`:
```python
"""A self-play worker process: plays hands with its CPU copy of the network and sends every
sample to the learner. It reloads weights whenever the learner bumps `version`."""
import queue as queue_module
import random

import torch

from ..contracts import ContractSampler
from ..model import QNet
from .config import TrainConfig
from .selfplay import play_selfplay_hand


def actor_main(actor_id: int, cfg: TrainConfig, shared: QNet, version, queue, stop) -> None:
    torch.set_num_threads(1)
    # Don't block process exit on samples the learner will never read.
    queue.cancel_join_thread()
    rng = random.Random(cfg.seed * 10_007 + actor_id)
    local = QNet(cfg.hidden, cfg.layers)
    local.load_state_dict(shared.state_dict())
    local.eval()
    seen = version.value
    sampler = ContractSampler(cfg.contract_mix, rng)
    while not stop.is_set():
        if version.value != seen:
            # The learner may be mid-copy; a slightly torn read only perturbs one hand's policy.
            seen = version.value
            local.load_state_dict(shared.state_dict())
        x, marks, pdiff = play_selfplay_hand(local, sampler, rng, cfg.epsilon)
        if len(marks):
            try:
                queue.put((x, marks, pdiff), timeout=1.0)
            except queue_module.Full:
                continue
```

`ml/src/fortytwo_ml/train/run.py`:
```python
"""The learner: starts actor processes, trains the Q-network on the GPU from their samples,
publishes weights back, and writes checkpoints and TensorBoard logs."""
import queue as queue_module
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.multiprocessing as mp
import torch.nn.functional as F
import yaml
from torch.utils.tensorboard import SummaryWriter

from ..agents.heuristic_bot import HeuristicBot
from ..agents.model_agent import ModelAgent
from ..eval.arena import evaluate_hands
from ..eval.report import mean_ci
from ..features import INPUT_DIM
from ..model import QNet, load_checkpoint, save_checkpoint
from .actor import actor_main
from .buffer import ReplayBuffer
from .config import TrainConfig, resolve_device, shaping_alpha

_MAX_DRAIN = 64


@dataclass(frozen=True)
class TrainSummary:
    steps: int
    last_loss: float
    checkpoint: Path


def check_actors(actors) -> None:
    for p in actors:
        if not p.is_alive():
            raise RuntimeError(f"{p.name} died (exit code {p.exitcode}); stopping training")


def _drain(queue, buffer: ReplayBuffer, block: bool) -> int:
    added = 0
    for i in range(_MAX_DRAIN):
        try:
            x, marks, pdiff = queue.get(timeout=1.0) if (block and i == 0) else queue.get_nowait()
        except queue_module.Empty:
            break
        buffer.add(x, marks, pdiff)
        added += len(marks)
    return added


def _publish(model: QNet, shared: QNet, version) -> None:
    with torch.no_grad():
        for dst, src in zip(shared.parameters(), model.parameters()):
            dst.copy_(src.detach().cpu())
    version.value += 1


def _cpu_copy(model: QNet) -> QNet:
    copy = QNet(model.hidden, model.layers)
    copy.load_state_dict({k: v.detach().cpu() for k, v in model.state_dict().items()})
    return copy.eval()


def train(cfg: TrainConfig, run_dir: Path, resume: Path | None = None) -> TrainSummary:
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "config.yaml").write_text(yaml.safe_dump(cfg.to_dict(), sort_keys=False))
    device = resolve_device(cfg)
    torch.manual_seed(cfg.seed)

    model = QNet(cfg.hidden, cfg.layers)
    step = 0
    if resume is not None:
        loaded, meta = load_checkpoint(resume)
        model.load_state_dict(loaded.state_dict())
        step = meta["step"]
    model.to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=cfg.lr)

    shared = _cpu_copy(model)
    shared.share_memory()
    ctx = mp.get_context("spawn")
    version = ctx.Value("i", 0)
    queue = ctx.Queue(maxsize=512)
    stop = ctx.Event()
    actors = [
        ctx.Process(target=actor_main, args=(i, cfg, shared, version, queue, stop), name=f"actor-{i}", daemon=True)
        for i in range(cfg.num_actors)
    ]
    for p in actors:
        p.start()

    buffer = ReplayBuffer(cfg.buffer_size, INPUT_DIM)
    np_rng = np.random.default_rng(cfg.seed)
    writer = SummaryWriter(str(run_dir / "tb"))
    last_checkpoint = time.monotonic()
    window_start, window_samples = time.monotonic(), 0
    loss_value = float("nan")
    try:
        while step < cfg.total_steps:
            window_samples += _drain(queue, buffer, block=len(buffer) < cfg.min_buffer)
            check_actors(actors)
            if len(buffer) < max(cfg.min_buffer, cfg.batch_size):
                continue

            x, marks, pdiff = buffer.sample(cfg.batch_size, np_rng)
            target = marks + shaping_alpha(cfg, step) * pdiff
            q = model(torch.from_numpy(x).to(device))
            loss = F.mse_loss(q, torch.from_numpy(target).to(device))
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            step += 1
            loss_value = loss.item()

            if step % cfg.weight_sync_every == 0:
                _publish(model, shared, version)
            if step % cfg.log_every == 0:
                elapsed = max(time.monotonic() - window_start, 1e-9)
                writer.add_scalar("train/loss", loss_value, step)
                writer.add_scalar("train/mean_q", q.mean().item(), step)
                writer.add_scalar("train/alpha", shaping_alpha(cfg, step), step)
                writer.add_scalar("train/buffer", len(buffer), step)
                writer.add_scalar("train/samples_per_sec", window_samples / elapsed, step)
                window_start, window_samples = time.monotonic(), 0
            if cfg.eval_every_steps and step % cfg.eval_every_steps == 0:
                result = evaluate_hands(ModelAgent(_cpu_copy(model)), HeuristicBot(), cfg.eval_deals, seed=cfg.seed)
                writer.add_scalar("eval/marks_per_deal_vs_heuristic", mean_ci(result.deal_scores)[0], step)
            if time.monotonic() - last_checkpoint >= cfg.checkpoint_minutes * 60:
                save_checkpoint(run_dir / f"ckpt-{step}.pt", model, step, cfg.to_dict())
                save_checkpoint(run_dir / "ckpt-latest.pt", model, step, cfg.to_dict())
                last_checkpoint = time.monotonic()
    finally:
        stop.set()
        for p in actors:
            p.join(timeout=5)
            if p.is_alive():
                p.terminate()
        writer.close()

    latest = run_dir / "ckpt-latest.pt"
    save_checkpoint(latest, model, step, cfg.to_dict())
    return TrainSummary(step, loss_value, latest)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_train_smoke.py -v`
Expected: 3 passed, in under a minute or two (spawning actors imports torch in each child).

- [ ] **Step 5: Run the whole suite**

Run: `cd ml && uv run pytest -q`
Expected: all passed

- [ ] **Step 6: Commit**

```bash
git add ml/src/fortytwo_ml/train/actor.py ml/src/fortytwo_ml/train/run.py ml/tests/test_train_smoke.py
git commit -m "ml: add actor processes, GPU learner, and smoke test"
```

---

### Task 14: CLI, README, and CI

**Files:**
- Create: `ml/src/fortytwo_ml/cli.py`, `ml/README.md`, `.github/workflows/ml.yml`
- Test: `ml/tests/test_cli.py`

**Interfaces:**
- Consumes: `train` (Task 13), `TrainConfig` (Task 12), `evaluate_hands`, `evaluate_matches`, `format_report` (Task 11), `DumbBot`, `HeuristicBot`, `ModelAgent`, `run_hand`/`choose` (Tasks 7 and 10), and `ContractSampler` and `contract_kind` (Task 8).
- Produces:
  - `main(argv: list[str] | None = None) -> int` (entry point `ml`);
  - `load_agent(spec: str) -> Agent` (`"dumb"`, `"heuristic"`, or a checkpoint path).

- [ ] **Step 1: Write the failing tests**

`ml/tests/test_cli.py`:
```python
import pytest

from fortytwo_ml.agents.dumb_bot import DumbBot
from fortytwo_ml.agents.model_agent import ModelAgent
from fortytwo_ml.cli import load_agent, main
from fortytwo_ml.model import QNet, save_checkpoint


def test_eval_prints_a_report(capsys):
    assert main(["eval", "--a", "heuristic", "--b", "dumb", "--deals", "20", "--matches", "2"]) == 0
    out = capsys.readouterr().out
    assert "Mean marks/deal" in out and "Match win rate" in out


def test_play_demo_prints_a_hand(capsys):
    assert main(["play-demo", "--agent", "heuristic", "--seed", "3"]) == 0
    out = capsys.readouterr().out
    assert "Contract:" in out and "Result:" in out


def test_load_agent(tmp_path):
    assert isinstance(load_agent("dumb"), DumbBot)
    path = tmp_path / "m.pt"
    save_checkpoint(path, QNet(hidden=16, layers=1), step=0, config={})
    assert isinstance(load_agent(str(path)), ModelAgent)
    with pytest.raises(FileNotFoundError):
        load_agent(str(tmp_path / "missing.pt"))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_cli.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'fortytwo_ml.cli'`

- [ ] **Step 3: Implement the CLI**

`ml/src/fortytwo_ml/cli.py`:
```python
"""`ml train`, `ml eval`, and `ml play-demo`."""
import argparse
import random
from datetime import datetime
from pathlib import Path

from .agents.base import Agent, choose
from .agents.dumb_bot import DumbBot
from .agents.heuristic_bot import HeuristicBot
from .agents.model_agent import ModelAgent
from .contracts import DEFAULT_MIX, ContractSampler, contract_kind
from .engine.dominoes import domino_id
from .engine.enums import Suit
from .engine.hand_state import HandState, Phase
from .eval.arena import evaluate_hands, evaluate_matches
from .eval.report import format_report


def load_agent(spec: str) -> Agent:
    if spec == "dumb":
        return DumbBot()
    if spec == "heuristic":
        return HeuristicBot()
    if not Path(spec).is_file():
        raise FileNotFoundError(f"no agent named {spec!r} and no checkpoint at that path")
    return ModelAgent.from_checkpoint(spec)


def _play_demo(agent: Agent, seed: int) -> None:
    rng = random.Random(seed)
    order = list(range(28))
    rng.shuffle(order)
    contract = ContractSampler(DEFAULT_MIX, rng).sample(order, rng.randrange(4))
    state = HandState.from_contract(order, contract.bidder, contract.bid, contract.trump)
    print(f"Contract: seat {contract.bidder} bid {contract.bid}, trump {Suit(contract.trump).name} "
          f"({contract_kind(contract)})")
    for seat in range(4):
        print(f"  seat {seat}: {' '.join(domino_id(d) for d in state.hand(seat))}")
    while state.phase is not Phase.DONE:
        seat = state.to_act
        if isinstance(agent, ModelAgent) and len(state.legal_actions()) > 1:
            qs = ", ".join(f"{domino_id(d)}={q:+.2f}" for d, q in agent.q_values(state, seat))
            print(f"  seat {seat} considers {qs}")
        action = choose(agent, state)
        state.apply(action)
        print(f"  seat {seat} plays {domino_id(action)}")
        if not state.trick and state.tricks:
            t = state.tricks[-1]
            print(f"  -> trick {len(state.tricks)} to seat {t.winner} ({t.points} pts)")
    r = state.result
    print(f"Result: team {r.winning_team} wins {r.marks} mark(s); points {r.points[0]}-{r.points[1]}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ml", description="Forty-Two ML bots")
    sub = parser.add_subparsers(dest="command", required=True)

    t = sub.add_parser("train", help="train the Stage 1 play model")
    t.add_argument("--config", required=True, type=Path)
    t.add_argument("--run-name")
    t.add_argument("--resume", type=Path)

    e = sub.add_parser("eval", help="duplicate-deal evaluation of agent A vs agent B")
    e.add_argument("--a", required=True, help="dumb | heuristic | path/to/checkpoint.pt")
    e.add_argument("--b", required=True, help="dumb | heuristic | path/to/checkpoint.pt")
    e.add_argument("--deals", type=int, default=5000)
    e.add_argument("--matches", type=int, default=0)
    e.add_argument("--seed", type=int, default=0)

    d = sub.add_parser("play-demo", help="print one hand, decision by decision")
    d.add_argument("--agent", default="heuristic")
    d.add_argument("--seed", type=int, default=0)

    args = parser.parse_args(argv)
    if args.command == "train":
        from .train.config import TrainConfig
        from .train.run import train

        name = args.run_name or datetime.now().strftime("%Y%m%d-%H%M%S")
        summary = train(TrainConfig.from_yaml(args.config), Path("runs") / name, args.resume)
        print(f"trained {summary.steps} steps, last loss {summary.last_loss:.4f}; checkpoint {summary.checkpoint}")
    elif args.command == "eval":
        a, b = load_agent(args.a), load_agent(args.b)
        hands = evaluate_hands(a, b, args.deals, seed=args.seed)
        matches = evaluate_matches(a, b, args.matches, seed=args.seed) if args.matches else None
        print(format_report(hands, matches))
    else:
        _play_demo(load_agent(args.agent), args.seed)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_cli.py -v`
Expected: 3 passed

- [ ] **Step 5: Write the README**

`ml/README.md`:
````markdown
# Forty-Two ML bots

Training a model to play Forty-Two. Stage 1 (this project today) is a trick-play model trained by
self-play. Bidding comes later. See `docs/superpowers/specs/2026-09-29-ml-bots-stage1-design.md`
for the roadmap.

## Setup

Install [uv](https://docs.astral.sh/uv/), then:

```sh
cd ml
uv sync
uv run python -c "import torch; print(torch.cuda.is_available())"   # True on the GPU box
```

On Windows, uv installs CUDA 12.8 PyTorch wheels; everywhere else it installs CPU wheels (see
`[tool.uv.sources]` in `pyproject.toml`).

## Commands

```sh
uv run ml train --config configs/stage1.yaml --run-name first     # writes runs/first/
uv run tensorboard --logdir runs                                  # watch loss and eval
uv run ml eval --a runs/first/ckpt-latest.pt --b heuristic --deals 5000 --matches 500
uv run ml play-demo --agent runs/first/ckpt-latest.pt --seed 3
```

`--resume runs/first/ckpt-latest.pt` continues a run from its step count.

Stage 1 is done when `ml eval` against `heuristic` over 5,000+ deals shows positive mean
marks/deal with a 95% CI above zero, and zero illegal actions.

## Layout

| Path | What it is |
| --- | --- |
| `src/fortytwo_ml/engine` | The rules for one hand, ported from `cloudflare/packages/rules`, plus the match loop. |
| `src/fortytwo_ml/agents` | The agent protocol, the Worker's dumb bot, a heuristic bot, and the model agent. |
| `src/fortytwo_ml/contracts.py` | Where training hands get their contract (bidding isn't learned yet). |
| `src/fortytwo_ml/features.py` | What the model sees. |
| `src/fortytwo_ml/train` | Deep Monte-Carlo self-play: actor processes, the GPU learner, and the replay buffer. |
| `src/fortytwo_ml/eval` | Duplicate-deal arena and report. |

## Parity with the TS rules

The Python engine has to agree exactly with `@fortytwo/rules`. `tests/test_parity.py` replays hands
recorded from the TS engine and checks the seat to act, the legal actions, and the result at every
step. After changing the TS rules, port the change and regenerate the fixture:

```sh
cd cloudflare
npm run dump-traces -w @fortytwo/rules -- --count 5000 --seed 42 --out ../../../ml/tests/fixtures/ts-traces.jsonl.gz
```

CI also generates a fresh batch of traces from the current TS engine on every run, so an unported
rules change fails even when the fixture wasn't regenerated.

## Tests

```sh
uv run pytest
```

None of them need a GPU. `test_train_smoke.py` runs a tiny training job on CPU.
````

- [ ] **Step 6: Add the CI workflow**

`.github/workflows/ml.yml`:
```yaml
name: ML

# Tests the Python engine, agents, and training pipeline, and proves the engine still matches the
# TS rules - both on the committed traces and on fresh ones generated from the current TS source.
on:
  push:
    branches: [master]
    paths: ['ml/**', 'cloudflare/packages/rules/**', '.github/workflows/ml.yml']
  pull_request:
    paths: ['ml/**', 'cloudflare/packages/rules/**', '.github/workflows/ml.yml']
  workflow_dispatch:

concurrency:
  group: ml-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
          cache-dependency-path: cloudflare/package-lock.json
      - run: npm ci
        working-directory: cloudflare
      - uses: astral-sh/setup-uv@v6
      - run: uv sync --locked
        working-directory: ml
      - run: uv run pytest -q
        working-directory: ml
      - name: Generate fresh traces from the current TS rules
        run: npm run dump-traces -w @fortytwo/rules -- --count 2000 --seed ${{ github.run_id }} --out "$RUNNER_TEMP/fresh-traces.jsonl.gz"
        working-directory: cloudflare
      - name: Parity against fresh traces
        run: uv run pytest tests/test_parity.py -q
        working-directory: ml
        env:
          FORTYTWO_TRACES: ${{ runner.temp }}/fresh-traces.jsonl.gz
```

- [ ] **Step 7: Run everything once more**

Run: `cd ml && uv run pytest -q`
Expected: all passed

Run: `cd ml && uv run ml eval --a heuristic --b dumb --deals 500`
Expected: a report with positive mean marks/deal for A and `Illegal actions: A=0 B=0`.

- [ ] **Step 8: Commit**

```bash
git add ml/src/fortytwo_ml/cli.py ml/tests/test_cli.py ml/README.md .github/workflows/ml.yml
git commit -m "ml: add CLI, README, and CI workflow"
```

---

### Task 15: First real training run (manual, on the GPU box)

This isn't code; it checks the Stage 1 bar. Run it after Task 14 is merged or on the branch.

- [ ] **Step 1: Start training**

Run: `cd ml && uv run ml train --config configs/stage1.yaml --run-name stage1-a`
In a second terminal: `cd ml && uv run tensorboard --logdir runs`. Watch `train/samples_per_sec`, `train/loss`, and `eval/marks_per_deal_vs_heuristic`. That last curve should rise above 0 within the first few hundred thousand steps.

- [ ] **Step 2: Evaluate against the bar**

Run: `cd ml && uv run ml eval --a runs/stage1-a/ckpt-latest.pt --b heuristic --deals 5000 --matches 500`
Expected (the Stage 1 bar): mean marks/deal > 0 with the CI's lower bound > 0, no contract type significantly worse, and `Illegal actions: A=0 B=0`. Record the report in the PR description.

- [ ] **Step 3: If it falls short**

Don't tune blindly. Check samples/sec (the actor count vs. CPU), whether `eval` is still rising (train longer), and whether exotic contract types lag (raise their share of `contract_mix`). The fallback noted in the spec (PPO) is its own design change, so bring it back to brainstorming rather than improvising it.
