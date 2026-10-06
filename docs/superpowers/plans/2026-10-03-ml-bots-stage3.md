# ML Bots Stage 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make simulation parallel, generate training data from the simulation bidder, train a small `BidNet` that predicts each hand's P(make) table, and bid with it in milliseconds through the existing `choose_bid` rules.

**Architecture:**
- `sim/probe.py` becomes the one simulation core. `simulate_hand` returns raw counts, and `options_from_table` turns a P(make) table into bid options. The Stage 2 `estimate_options` becomes a thin wrapper over it.
- `sim/parallel.py` runs independent work on spawned worker processes. `evaluate_auctions` reseeds agents per hand, so results don't depend on the worker count.
- The `bidding/` package holds the data generator (`data.py`), the model (`model.py`) and training (`train.py`).
- `agents/fast_bidder.py` bids from `BidNet`'s table. `eval-bidding` can compare any two of `heuristic`, `sim` and `fast:<bidnet.pt>` on one play model.

**Tech Stack:** Python 3.12, PyTorch, numpy, pytest, uv. This is the existing `ml/` project.

**Spec:** `docs/superpowers/specs/2026-10-03-ml-bots-stage3-design.md`

## Global Constraints

- **Commands and tests**
  - All commands run from `ml/` as `uv run ...`.
  - No test may need a GPU. Tests use CPU and tiny models: `QNet(hidden=16, layers=1)` and `BidNet(hidden=16, layers=1)`.
- **Stage 2 compatibility**
  - `estimate_options` must return exactly what the Stage 2 implementation returns for the same state and rng.
  - `ml eval-bidding` with no `--a`/`--b` keeps its Stage 2 meaning: A = `sim`, B = `heuristic`.
- **Parallel workers**
  - `--workers` defaults to 7.
  - Workers are spawned. Each worker loads models from file paths and calls `torch.set_num_threads(1)`.
  - `--workers 1` runs everything in-process.
  - Results are identical for any worker count.
  - The reseed key for each hand of `evaluate_auctions` is `f"{seed}:{deal}:{a_team}"`.
- **`gen-bids` data**
  - Hand `i` uses `random.Random(f"gen-bids:{seed}:{i}")`. It draws the 7 dominoes, then drives `simulate_hand` from seat 0 with every probe kind.
  - Each batch file holds 1,000 hands and is named `gen-s{seed}-{start:07d}.npz`. It is written to `*.tmp` and renamed.
  - An existing complete batch is skipped.
  - Training refuses folders whose batches come from different play checkpoints.
- **`BidNet`**
  - Input: 36 floats (28 domino bits, 7 suit counts / 7, doubles count / 7).
  - Body: 3 × Linear 256 + ReLU.
  - Points head: 7 × 14 buckets (`<30, 30..41, 42`).
  - Binary head: 12 outputs, in this order: 42 in each named suit, follow-me, `LOW`, `LOW_DOUBLES_LOW`, `LOW_DOUBLES_OWN_SUIT`, plunge.
- **Training**
  - Adam with lr 1e-3, batch 512.
  - A 5% held-out split by `zlib.crc32` of the sorted hand.
  - Early stopping with patience 5. The best epoch is kept.
- **Bidding thresholds**
  - `DEFAULT_MAKE_THRESHOLD = 0.6` lives in `sim/decide.py`.
  - `DecideConfig`'s own default stays 0.5.
- **Trump naming in `FastBidder`**
  - Reuse the plan for the winning bid.
  - Otherwise take the best P(make) at the actual bid from the table.
  - On a partner's plunge, use the heuristic's best suit.
- **Every commit message ends with:**
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. **Results identical for any worker count.** One reused agent consuming randomness across deals would silently make results depend on how deals are split. Pinned in Task 2 (`test_split_ranges_match_one_run`) and Task 3 (`test_parallel_eval_matches_in_process`).
2. **Rerunning `gen-bids` with a larger `--hands`.** The old last batch is short. It must be regenerated, not skipped, or hands go missing. Pinned in Task 4 (`test_rerun_with_more_hands_fills_the_short_batch`).
3. **A run killed mid-write.** It leaves a `*.npz.tmp` file, which loading must ignore. Pinned in Task 4 (`test_loading_ignores_temporary_files`).
4. **The Stage 2 bidder unchanged by the refactor.** Pinned in Task 1 (`test_estimate_options_matches_stage2`).
5. **A fast bidder trained on another play checkpoint.** It must warn, not fail, and the run continues. Pinned in Task 6 (`test_eval_bidding_warns_on_play_checkpoint_mismatch`).

---

### Task 1: One simulation core (`sim/probe.py`); the shared threshold moves to `decide.py`

**Files:**
- Create: `ml/src/fortytwo_ml/sim/probe.py`
- Modify: `ml/src/fortytwo_ml/agents/sim_bidder.py`, `ml/src/fortytwo_ml/sim/decide.py`, `ml/src/fortytwo_ml/cli.py` (an import only)
- Test: `ml/tests/test_sim_probe.py`

**Interfaces:**
- Produces, in `fortytwo_ml.sim.probe`:
  - **Constants:** `POINTS_PROBE = 30`, `HIGH_PROBE = 42`, `HIGH_TRUMPS = (*NAMED_SUITS, Suit.NONE)`, `ALL_KINDS = frozenset({"points", "high", "low", "plunge"})`.
  - **`HandSims(n: int, points_hist: np.ndarray | None, high_made: np.ndarray | None, low_clean: np.ndarray | None, plunge_made: int | None)`** (frozen):
    - `points_hist` has shape (7, 43);
    - `high_made` has shape (8,): named suits, then follow-me;
    - `low_clean` has shape (3,), in `LOW_TRUMPS` order.
  - **`BidTable(points: np.ndarray | None, high: np.ndarray | None, low: np.ndarray | None, plunge: float | None)`** (frozen):
    - `points` has shape (7, 12): P(make b) for b = 30..41;
    - `high` has shape (8,);
    - `low` has shape (3,).
  - **Functions:**
    - `can_plunge(hand) -> bool`
    - `kinds_for(legal) -> frozenset[str]`
    - `simulate_hand(model, seat, hand, n_deals, rng, device=None, kinds=ALL_KINDS) -> HandSims`
    - `table_from_sims(sims) -> BidTable`
    - `options_from_table(table, legal) -> list[Option]`
- Produces, in `fortytwo_ml.sim.decide`: `DEFAULT_MAKE_THRESHOLD = 0.6`.
- Keeps: `fortytwo_ml.agents.sim_bidder.estimate_options(model, state, seat, n_deals, rng, device=None) -> list[Option]`, with the same output as before.

- [ ] **Step 1: Write the failing tests**

Create `ml/tests/test_sim_probe.py`. The `_stage2_estimate_options` function is the Stage 2 implementation, copied verbatim. It is the reference the refactor must match.
```python
import random
from collections import defaultdict

import numpy as np
import pytest
import torch

from conftest import deal_with
from fortytwo_ml.agents.base import run_hand
from fortytwo_ml.agents.heuristic_bot import best_suit
from fortytwo_ml.agents.model_agent import ModelAgent
from fortytwo_ml.agents.sim_bidder import estimate_options
from fortytwo_ml.engine.enums import LOW_TRUMPS, NAMED_SUITS, PASS, PLUNGE, Suit
from fortytwo_ml.engine.hand_state import Contract, HandState, partner, team_of
from fortytwo_ml.model import QNet
from fortytwo_ml.sim.deal import deal_unseen
from fortytwo_ml.sim.decide import Option
from fortytwo_ml.sim.probe import (
    BidTable, HandSims, HIGH_TRUMPS, can_plunge, options_from_table, simulate_hand, table_from_sims,
)
from fortytwo_ml.sim.rollout import rollout


def tiny():
    torch.manual_seed(0)
    return QNet(hidden=16, layers=1).eval()


def _stage2_estimate_options(model, state, seat, n_deals, rng, device=None):
    legal = [b for b in state.legal_actions() if b != PASS]
    if not legal:
        return []
    hand = state.hand(seat)
    deals = [deal_unseen(seat, hand, rng) for _ in range(n_deals)]
    points_bids = [b for b in legal if b < 42]
    high_bids = [b for b in legal if b >= 42 and b != PLUNGE]
    jobs, keys = [], []

    def add(kind, trump_for_deal):
        for d in deals:
            trump = trump_for_deal(d)
            jobs.append((d, Contract(seat, {"points": 30, "plunge": PLUNGE}.get(kind, 42), trump)))
            keys.append((kind, trump if kind != "plunge" else -1))

    if points_bids:
        for t in NAMED_SUITS:
            add("points", lambda d, t=t: t)
    if high_bids:
        for t in (*NAMED_SUITS, Suit.NONE):
            add("high", lambda d, t=t: t)
        for v in LOW_TRUMPS:
            add("low", lambda d, v=v: v)
    if PLUNGE in legal:
        mate = partner(seat)
        add("plunge", lambda d: best_suit(list(d[mate * 7:(mate + 1) * 7]))[0])
    result = rollout(model, jobs, device)
    points, took = defaultdict(list), defaultdict(list)
    for key, p, t in zip(keys, result.bidder_points, result.bidder_took_trick):
        points[key].append(int(p))
        took[key].append(bool(t))
    options = []
    for t in NAMED_SUITS if points_bids else ():
        pts = np.array(points[("points", t)])
        options += [Option(b, t, float(np.mean(pts >= b))) for b in points_bids]
    if high_bids:
        for t in (*NAMED_SUITS, Suit.NONE):
            p = float(np.mean(np.array(points[("high", t)]) == 42))
            options += [Option(b, t, p) for b in high_bids]
        for v in LOW_TRUMPS:
            p = float(np.mean(~np.array(took[("low", v)])))
            options += [Option(b, v, p) for b in high_bids]
    if PLUNGE in legal:
        options.append(Option(PLUNGE, Suit.NONE, float(np.mean(np.array(points[("plunge", -1)]) == 42))))
    return options


def _states():
    opening = HandState.deal(list(range(28)), opener=0)
    plunge = HandState.deal(deal_with({0: [(0, 0), (1, 1), (2, 2), (3, 3)]}), opener=0)
    forced = HandState.deal(list(range(28)), opener=0)
    for _ in range(3):
        forced.apply(PASS)
    high_only = HandState.deal(list(range(28)), opener=0)
    high_only.apply(41)
    return [(opening, 0), (plunge, 0), (forced, 3), (high_only, 1)]


@pytest.mark.parametrize("index", range(4))
def test_estimate_options_matches_stage2(index):
    state, seat = _states()[index]
    model = tiny()
    assert estimate_options(model, state, seat, 6, random.Random(7)) == _stage2_estimate_options(
        model, state, seat, 6, random.Random(7)
    )


def test_simulate_hand_counts_match_one_at_a_time_play():
    model = tiny()
    hand = deal_with({0: [(0, 0), (1, 1), (2, 2), (3, 3)]})[:7]
    sims = simulate_hand(model, 0, hand, 3, random.Random(5))
    rng = random.Random(5)  # the same stream simulate_hand used, so the same deals
    deals = [deal_unseen(0, hand, rng) for _ in range(3)]
    agent = ModelAgent(model)

    def play(deal, bid, trump):
        state = HandState.from_contract(deal, 0, bid, trump, play_to_end=True)
        run_hand(state, [agent] * 4)
        return state.points[team_of(0)], any(team_of(t.winner) == team_of(0) for t in state.tricks)

    for t in NAMED_SUITS:
        expected = np.bincount([play(d, 30, t)[0] for d in deals], minlength=43)
        assert (sims.points_hist[t] == expected).all()
    for i, t in enumerate(HIGH_TRUMPS):
        assert sims.high_made[i] == sum(play(d, 42, t)[0] == 42 for d in deals)
    for i, v in enumerate(LOW_TRUMPS):
        assert sims.low_clean[i] == sum(not play(d, 42, v)[1] for d in deals)
    plunge_trumps = [best_suit(list(d[14:21]))[0] for d in deals]
    assert sims.plunge_made == sum(play(d, PLUNGE, t)[0] == 42 for d, t in zip(deals, plunge_trumps))


def test_plunge_is_simulated_only_with_four_doubles():
    model = tiny()
    weak = [1, 2, 3, 4, 5, 6, 8]  # one double (0/0 is index 0, not held; 1/1 is index 7, not held)
    assert not can_plunge(weak)
    assert simulate_hand(model, 0, weak, 2, random.Random(0)).plunge_made is None
    strong = deal_with({0: [(0, 0), (1, 1), (2, 2), (3, 3)]})[:7]
    assert can_plunge(strong)
    assert simulate_hand(model, 0, strong, 2, random.Random(0)).plunge_made is not None


def test_kinds_limit_the_probes():
    sims = simulate_hand(tiny(), 0, [1, 2, 3, 4, 5, 6, 8], 2, random.Random(0), kinds=frozenset({"points"}))
    assert sims.points_hist is not None and sims.high_made is None and sims.low_clean is None


def test_options_from_table_reads_a_hand_built_table():
    points = np.zeros((7, 12))
    points[Suit.SIXES] = np.linspace(0.9, 0.35, 12)  # 30 -> 0.9 ... 41 -> 0.35
    table = BidTable(points, np.full(8, 0.2), np.array([0.1, 0.6, 0.3]), None)
    options = options_from_table(table, [PASS, 32, 42, 84])
    assert Option(32, Suit.SIXES, pytest.approx(0.8)) in options
    assert Option(84, Suit.LOW_DOUBLES_LOW, 0.6) in options and Option(42, Suit.NONE, 0.2) in options
    assert not any(o.bid == PLUNGE for o in options)


def test_table_from_sims_turns_counts_into_probabilities():
    hist = np.zeros((7, 43), dtype=np.int64)
    hist[:, 29] = 1  # one deal with 29 points
    hist[:, 35] = 3  # three with 35
    table = table_from_sims(HandSims(4, hist, np.full(8, 2), np.full(3, 1), None))
    assert table.points[0, 0] == 0.75 and table.points[0, 35 - 30] == 0.75 and table.points[0, 36 - 30] == 0.0
    assert (table.high == 0.5).all() and (table.low == 0.25).all() and table.plunge is None
```

Check the `weak` hand against `PIPS` before relying on it. Doubles are indices `[0, 7, 13, 18, 22, 25, 27]`, so `[1, 2, 3, 4, 5, 6, 8]` holds no doubles.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_sim_probe.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'fortytwo_ml.sim.probe'`.

- [ ] **Step 3: Implement `sim/probe.py`**

```python
"""The one simulation core: deal a hand's unseen dominoes many times, play every deal out under
each probe contract with the play model, and count what happened. Every P(make) the simulation
bidder needs comes from these counts, and they depend only on the hand (and seat), never on the
auction - which is why the bidding model's training data needs no auctions."""
import random
from collections.abc import Collection, Sequence
from dataclasses import dataclass

import numpy as np

from ..agents.heuristic_bot import best_suit
from ..engine.dominoes import doubles_in, to_mask
from ..engine.enums import LOW_TRUMPS, NAMED_SUITS, PASS, PLUNGE, Suit
from ..engine.hand_state import Contract, partner
from ..model import QNet
from .deal import deal_unseen
from .decide import Option
from .rollout import rollout

POINTS_PROBE = 30  # suits played as a 30 bid answer every points bid (30..41)
HIGH_PROBE = 42    # suits, follow-me and Low played as a 42 bid answer 42 and the marks bids
HIGH_TRUMPS = (*NAMED_SUITS, Suit.NONE)
ALL_KINDS = frozenset({"points", "high", "low", "plunge"})


@dataclass(frozen=True)
class HandSims:
    n: int
    points_hist: np.ndarray | None  # (7, 43): bidding team's final points at a 30 bid, per named suit
    high_made: np.ndarray | None    # (8,): deals that took all 42 points at a 42 bid; named suits, then follow-me
    low_clean: np.ndarray | None    # (3,): deals where the bidders took no trick, LOW_TRUMPS order
    plunge_made: int | None         # deals a plunge took every trick; None when not simulated


@dataclass(frozen=True)
class BidTable:
    points: np.ndarray | None  # (7, 12): P(make b) for b = 30..41, per named suit
    high: np.ndarray | None    # (8,): P(make 42 and the marks bids); named suits, then follow-me
    low: np.ndarray | None     # (3,): P(take no trick), LOW_TRUMPS order
    plunge: float | None


def can_plunge(hand: Sequence[int]) -> bool:
    return doubles_in(to_mask(hand)) >= 4


def kinds_for(legal: Collection[int]) -> frozenset[str]:
    """The probes a decision needs, given its legal bids."""
    bids = [b for b in legal if b != PASS]
    kinds = set()
    if any(b < HIGH_PROBE for b in bids):
        kinds.add("points")
    if any(b >= HIGH_PROBE and b != PLUNGE for b in bids):
        kinds |= {"high", "low"}
    if PLUNGE in bids:
        kinds.add("plunge")
    return frozenset(kinds)


def simulate_hand(
    model: QNet, seat: int, hand: Sequence[int], n_deals: int, rng: random.Random,
    device=None, kinds: Collection[str] = ALL_KINDS,
) -> HandSims:
    deals = [deal_unseen(seat, hand, rng) for _ in range(n_deals)]
    run_plunge = "plunge" in kinds and can_plunge(hand)
    jobs: list[tuple[list[int], Contract]] = []
    if "points" in kinds:
        jobs += [(d, Contract(seat, POINTS_PROBE, t)) for t in NAMED_SUITS for d in deals]
    if "high" in kinds:
        jobs += [(d, Contract(seat, HIGH_PROBE, t)) for t in HIGH_TRUMPS for d in deals]
    if "low" in kinds:
        jobs += [(d, Contract(seat, HIGH_PROBE, v)) for v in LOW_TRUMPS for d in deals]
    if run_plunge:
        mate = partner(seat)
        jobs += [(d, Contract(seat, PLUNGE, best_suit(list(d[mate * 7:(mate + 1) * 7]))[0])) for d in deals]
    result = rollout(model, jobs, device)

    cursor = 0

    def block(rows: int) -> slice:
        nonlocal cursor
        s = slice(cursor, cursor + rows * n_deals)
        cursor += rows * n_deals
        return s

    points_hist = high_made = low_clean = None
    plunge_made = None
    if "points" in kinds:
        pts = result.bidder_points[block(7)].reshape(7, n_deals)
        points_hist = np.stack([np.bincount(row, minlength=43) for row in pts])
    if "high" in kinds:
        high_made = (result.bidder_points[block(8)].reshape(8, n_deals) == 42).sum(axis=1)
    if "low" in kinds:
        low_clean = (~result.bidder_took_trick[block(3)].reshape(3, n_deals)).sum(axis=1)
    if run_plunge:
        plunge_made = int((result.bidder_points[block(1)] == 42).sum())
    return HandSims(n_deals, points_hist, high_made, low_clean, plunge_made)


def table_from_sims(sims: HandSims) -> BidTable:
    n = sims.n
    points = None
    if sims.points_hist is not None:
        at_least = np.cumsum(sims.points_hist[:, ::-1], axis=1)[:, ::-1]  # [:, p] = deals with >= p points
        points = at_least[:, POINTS_PROBE:HIGH_PROBE] / n
    return BidTable(
        points,
        None if sims.high_made is None else sims.high_made / n,
        None if sims.low_clean is None else sims.low_clean / n,
        None if sims.plunge_made is None else sims.plunge_made / n,
    )


def _need(value, kind: str):
    if value is None:
        raise ValueError(f"the table has no {kind!r} probabilities, but a legal bid needs them")
    return value


def options_from_table(table: BidTable, legal: Collection[int]) -> list[Option]:
    """One Option per (legal bid, trump), in a fixed order: points suits, 42-probe trumps, Low, plunge."""
    bids = [b for b in legal if b != PASS]
    points_bids = [b for b in bids if b < HIGH_PROBE]
    high_bids = [b for b in bids if b >= HIGH_PROBE and b != PLUNGE]
    options: list[Option] = []
    if points_bids:
        points = _need(table.points, "points")
        for t in NAMED_SUITS:
            options += [Option(b, t, float(points[t, b - POINTS_PROBE])) for b in points_bids]
    if high_bids:
        high, low = _need(table.high, "high"), _need(table.low, "low")
        for i, t in enumerate(HIGH_TRUMPS):
            options += [Option(b, t, float(high[i])) for b in high_bids]
        for i, v in enumerate(LOW_TRUMPS):
            options += [Option(b, v, float(low[i])) for b in high_bids]
    if PLUNGE in bids:
        options.append(Option(PLUNGE, Suit.NONE, float(_need(table.plunge, "plunge"))))
    return options
```

- [ ] **Step 4: Make `estimate_options` a wrapper, and move the threshold**

In `ml/src/fortytwo_ml/sim/decide.py`, add this below the imports:
```python
# Tuned on stage1-c: over the same 300 deals, 0.5/0.55/0.6 scored +0.390/+0.467/+0.497 marks/deal
# against heuristic bidding. Fewer coin-flip bids, a higher made rate, and the auctions given up cost
# nothing. Both bidders default to it; DecideConfig's own default stays 0.5, the pure-rule default.
DEFAULT_MAKE_THRESHOLD = 0.6
```

In `ml/src/fortytwo_ml/agents/sim_bidder.py`:
- Delete `POINTS_PROBE`, `HIGH_PROBE`, the old `estimate_options` body, the `DEFAULT_MAKE_THRESHOLD` block, and the now-unused imports (`defaultdict`, `LOW_TRUMPS`, `NAMED_SUITS`, `Suit`, `best_suit`).
- Import `DEFAULT_MAKE_THRESHOLD` from `..sim.decide`, and `kinds_for`, `options_from_table`, `simulate_hand`, `table_from_sims` from `..sim.probe`.
- The new `estimate_options`:
```python
def estimate_options(
    model: QNet, state: HandState, seat: int, n_deals: int, rng: random.Random, device=None
) -> list[Option]:
    legal = state.legal_actions()
    if not any(b != PASS for b in legal):
        return []
    sims = simulate_hand(model, seat, state.hand(seat), n_deals, rng, device, kinds_for(legal))
    return options_from_table(table_from_sims(sims), legal)
```

In `ml/src/fortytwo_ml/cli.py`, import `DEFAULT_MAKE_THRESHOLD` from `.sim.decide` instead of `.agents.sim_bidder`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_sim_probe.py tests/test_sim_bidder.py -q`, then `uv run pytest -q`.
Expected: all pass. If `test_estimate_options_matches_stage2` fails on float equality alone, report it with the differing values. Don't loosen it to `approx` without saying so.

- [ ] **Step 6: Commit**

```bash
git add ml/src/fortytwo_ml/sim/probe.py ml/src/fortytwo_ml/sim/decide.py ml/src/fortytwo_ml/agents/sim_bidder.py ml/src/fortytwo_ml/cli.py ml/tests/test_sim_probe.py
git commit -m "ml: one simulation core (simulate_hand, P(make) tables); estimate_options wraps it"
```

---

### Task 2: Per-hand reseeding, deal ranges, and per-side decision times

**Files:**
- Modify: `ml/src/fortytwo_ml/agents/sim_bidder.py`, `ml/src/fortytwo_ml/eval/arena.py`, `ml/src/fortytwo_ml/eval/report.py`
- Test: `ml/tests/test_eval.py`

**Interfaces:**
- Produces:
  - `SimBidder.reseed(key: str)` and `SimAgent.reseed(key: str)`.
  - `evaluate_auctions(a, b, deals: int | Sequence[int], seed=0)`. Before each hand, it calls `reseed(f"{seed}:{i}:{a_team}")` on any agent that has the method.
  - `AuctionEval.b_decision_seconds: list[float]`. Both time lists hold only the decisions made during that call.
  - `merge_auction_evals(parts: Sequence[AuctionEval]) -> AuctionEval`, in `eval/arena.py`.
  - The report prints `Bid decision time (A): ...` and `Bid decision time (B): ...` for each side with times. When the p95 is under 1 s, the times print in ms (`2.0ms`). Otherwise they print in seconds (`11.0s`).

- [ ] **Step 1: Write the failing tests**

Append to `ml/tests/test_eval.py`:
```python
def _sim_and_model(seed=0):
    import torch
    from fortytwo_ml.agents.model_agent import ModelAgent
    from fortytwo_ml.agents.sim_bidder import SimAgent
    from fortytwo_ml.model import QNet

    torch.manual_seed(seed)
    net = QNet(hidden=16, layers=1).eval()
    return SimAgent(net, n_deals=4), ModelAgent(net)


def test_split_ranges_match_one_run():
    from fortytwo_ml.eval.arena import evaluate_auctions, merge_auction_evals

    whole = evaluate_auctions(*_sim_and_model(), deals=4, seed=3)
    parts = merge_auction_evals([
        evaluate_auctions(*_sim_and_model(), deals=range(0, 2), seed=3),
        evaluate_auctions(*_sim_and_model(), deals=range(2, 4), seed=3),
    ])
    assert parts.records == whole.records and parts.deal_scores == whole.deal_scores
    assert parts.illegal == whole.illegal and len(parts.decision_seconds) == len(whole.decision_seconds)


def test_decision_times_cover_only_this_call():
    from fortytwo_ml.eval.arena import evaluate_auctions

    a, b = _sim_and_model()
    first = evaluate_auctions(a, b, deals=1, seed=0)
    second = evaluate_auctions(a, b, deals=1, seed=1)
    assert len(first.decision_seconds) + len(second.decision_seconds) == len(a.decision_seconds)
    assert second.b_decision_seconds == []  # ModelAgent records no times


def test_report_prints_each_sides_decision_time_in_ms_when_fast():
    from fortytwo_ml.eval.arena import AuctionEval, AuctionRecord
    from fortytwo_ml.eval.report import format_auction_report

    recs = [AuctionRecord("points", 30, True, True, 1, 0.7)]
    ev = AuctionEval("a", "b", records=recs, deal_scores=[1],
                     decision_seconds=[0.001, 0.002, 0.003], b_decision_seconds=[5.0, 6.0, 7.0])
    text = format_auction_report(ev)
    assert "Bid decision time (A): median 2.0ms  p95 3.0ms  (n=3)" in text
    assert "Bid decision time (B): median 6.0s  p95 7.0s  (n=3)" in text
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_eval.py -q`
Expected: FAIL with `ImportError: cannot import name 'merge_auction_evals'`, then a `TypeError` on `b_decision_seconds`.

- [ ] **Step 3: Implement**

`sim_bidder.py`: add to `SimBidder`
```python
    def reseed(self, key: str) -> None:
        """Restart the simulation stream from `key`, so a hand's simulations don't depend on what
        this bidder simulated before (the arena reseeds per hand; results then don't depend on how
        deals are split across workers)."""
        self.rng = random.Random(f"sim-bidder:{key}")
```
and to `SimAgent`:
```python
    def reseed(self, key: str) -> None:
        self.bidder.reseed(key)
```

`arena.py`:
- Add `b_decision_seconds: list[float] = field(default_factory=list)` to `AuctionEval`, after `decision_seconds`.
- Add `from collections.abc import Mapping, Sequence`.
- Replace `evaluate_auctions` and add `merge_auction_evals`:
```python
def _reseed(agents: tuple[Agent, ...], key: str) -> None:
    for agent in agents:
        reseed = getattr(agent, "reseed", None)
        if reseed is not None:
            reseed(key)


def evaluate_auctions(a: Agent, b: Agent, deals: int | Sequence[int], seed: int = 0) -> AuctionEval:
    """Duplicate deals with real auctions: each deal is bid and played twice with the teams
    swapped. A and B share a play model and differ only in how they bid. `deals` is a count or the
    deal indices to play (workers each take a slice); every hand reseeds both agents from
    (seed, deal, seating), so the result for a deal never depends on what ran before it."""
    result = AuctionEval(a.name, b.name)
    a_start = len(getattr(a, "decision_seconds", []))
    b_start = len(getattr(b, "decision_seconds", []))
    for i in range(deals) if isinstance(deals, int) else deals:
        rng = random.Random(f"auction:{seed}:{i}")
        order = list(range(28))
        rng.shuffle(order)
        opener = rng.randrange(4)
        score = 0
        for a_team in (0, 1):
            _reseed((a, b), f"{seed}:{i}:{a_team}")
            seats = _seats(a, b, a_team)
            state = HandState.deal(order, opener)
            hand = run_hand(state, seats, _illegal_counter(result.illegal, a_team))
            bidders = team_of(state.bidder)
            a_won = bidders == a_team
            predict = getattr(seats[state.bidder], "predicted_make", None) if a_won else None
            predicted = predict(state, state.bidder) if predict else None
            a_marks = hand.marks if hand.winning_team == a_team else -hand.marks
            result.records.append(
                AuctionRecord(contract_kind(state.contract), state.high_bid, a_won, hand.winning_team == bidders, a_marks, predicted)
            )
            score += a_marks
        result.deal_scores.append(score)
    result.decision_seconds = list(getattr(a, "decision_seconds", []))[a_start:]
    result.b_decision_seconds = [] if b is a else list(getattr(b, "decision_seconds", []))[b_start:]
    return result


def merge_auction_evals(parts: Sequence[AuctionEval]) -> AuctionEval:
    """Combine evaluations of consecutive deal ranges, in order."""
    merged = AuctionEval(parts[0].a_name, parts[0].b_name)
    for part in parts:
        merged.records += part.records
        merged.deal_scores += part.deal_scores
        merged.decision_seconds += part.decision_seconds
        merged.b_decision_seconds += part.b_decision_seconds
        for side in merged.illegal:
            merged.illegal[side] += part.illegal[side]
    return merged
```

`report.py`: replace the `if ev.decision_seconds:` block in `format_auction_report` with
```python
    for label, seconds in (("A", ev.decision_seconds), ("B", ev.b_decision_seconds)):
        if seconds:
            lines.append(_decision_time_line(label, seconds))
```
and add above `format_auction_report`:
```python
def _decision_time_line(label: str, seconds: Sequence[float]) -> str:
    times = sorted(seconds)
    median, p95 = times[len(times) // 2], times[min(len(times) - 1, int(0.95 * len(times)))]

    def fmt(t: float) -> str:
        return f"{t * 1000:.1f}ms" if p95 < 1 else f"{t:.1f}s"

    return f"Bid decision time ({label}): median {fmt(median)}  p95 {fmt(p95)}  (n={len(times)})"
```
The existing test `test_auction_report_calibration_bands_auction_sides_and_p95` asserts the substring `"median 11.0s  p95 20.0s  (n=20)"`, which still matches.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_eval.py tests/test_sim_bidder.py tests/test_cli.py -q`, then `uv run pytest -q`.
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add ml/src/fortytwo_ml/agents/sim_bidder.py ml/src/fortytwo_ml/eval/arena.py ml/src/fortytwo_ml/eval/report.py ml/tests/test_eval.py
git commit -m "ml: reseed agents per hand; evaluate deal ranges; per-side bid decision times"
```

---

### Task 3: Parallel workers and `eval-bidding --a/--b/--workers`

**Files:**
- Create: `ml/src/fortytwo_ml/sim/parallel.py`, `ml/src/fortytwo_ml/eval/auction_runner.py`
- Modify: `ml/src/fortytwo_ml/cli.py`
- Test: `ml/tests/test_sim_parallel.py`, `ml/tests/test_cli.py`

**Interfaces:**
- Consumes:
  - `evaluate_auctions(a, b, deals: int | Sequence[int], seed)` and `merge_auction_evals` (Task 2);
  - `DEFAULT_MAKE_THRESHOLD` (Task 1).
- Produces:
  - **`fortytwo_ml.sim.parallel`:**
    - `DEFAULT_WORKERS = 7`;
    - `parallel_map(fn, items, workers, initializer=None, initargs=(), on_result=None) -> list`. Results come back in item order. `on_result(done_count, result)` is called as each result arrives in order. A worker exception propagates.
  - **`fortytwo_ml.eval.auction_runner`:**
    - `BidderSpec(kind: str, model: str, bidnet: str | None = None, sim_deals: int = 200, make_threshold: float = DEFAULT_MAKE_THRESHOLD, seed: int = 0)` (frozen; `kind` is `"heuristic"`, `"sim"` or `"fast"`);
    - `parse_bidder(text, model, sim_deals, make_threshold, seed) -> BidderSpec`. It accepts `heuristic` and `sim`; Task 6 adds `fast:<path>`;
    - `build_bidder(spec) -> Agent`;
    - `evaluate_auctions_parallel(a: BidderSpec, b: BidderSpec, deals: int, seed=0, workers=DEFAULT_WORKERS, chunk: int | None = None) -> AuctionEval`.
  - **CLI:** `eval-bidding` gains `--a` (default `sim`), `--b` (default `heuristic`) and `--workers` (default 7).

- [ ] **Step 1: Write the failing tests**

Create `ml/tests/test_sim_parallel.py`:
```python
import math

import pytest

from fortytwo_ml.eval.auction_runner import BidderSpec, evaluate_auctions_parallel
from fortytwo_ml.model import QNet, save_checkpoint
from fortytwo_ml.sim.parallel import parallel_map


def test_parallel_map_keeps_item_order():
    seen = []
    assert parallel_map(math.sqrt, [1, 4, 9, 16], workers=2, on_result=lambda k, r: seen.append(k)) == [1, 2, 3, 4]
    assert seen == [1, 2, 3, 4]


def test_parallel_map_runs_in_process_with_one_worker():
    assert parallel_map(math.sqrt, [4, 9], workers=1) == [2, 3]


def test_a_worker_error_fails_the_call():
    with pytest.raises(ValueError):
        parallel_map(math.sqrt, [4, -1, 9], workers=2)


def test_parallel_eval_matches_in_process(tmp_path):
    import torch

    torch.manual_seed(0)
    path = tmp_path / "m.pt"
    save_checkpoint(path, QNet(hidden=16, layers=1), step=0, config={})
    a = BidderSpec("sim", str(path), sim_deals=4)
    b = BidderSpec("heuristic", str(path))
    one = evaluate_auctions_parallel(a, b, deals=4, seed=2, workers=1)
    two = evaluate_auctions_parallel(a, b, deals=4, seed=2, workers=2, chunk=1)
    assert one.records == two.records and one.deal_scores == two.deal_scores and one.illegal == two.illegal
    assert len(one.decision_seconds) == len(two.decision_seconds) > 0
```

In `ml/tests/test_cli.py`:
- Change `test_eval_bidding_runs_on_a_tiny_checkpoint`'s call to `main(["eval-bidding", "--model", str(path), "--deals", "2", "--sim-deals", "4", "--workers", "1"])`.
- Replace `test_eval_bidding_passes_the_make_threshold` with:
```python
def test_eval_bidding_passes_bidders_and_threshold(tmp_path, monkeypatch):
    from fortytwo_ml import cli

    path = tmp_path / "m.pt"
    save_checkpoint(path, QNet(hidden=16, layers=1), step=0, config={})
    seen = {}

    def fake(a, b, deals, seed=0, workers=7):
        seen.update(a=a, b=b, workers=workers)
        raise SystemExit(0)

    monkeypatch.setattr(cli, "evaluate_auctions_parallel", fake)
    with pytest.raises(SystemExit):
        main(["eval-bidding", "--model", str(path), "--deals", "1", "--make-threshold", "0.7",
              "--a", "heuristic", "--b", "sim", "--workers", "3"])
    assert seen["a"].kind == "heuristic" and seen["b"].kind == "sim"
    assert seen["b"].make_threshold == 0.7 and seen["workers"] == 3
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_sim_parallel.py tests/test_cli.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'fortytwo_ml.eval.auction_runner'`.

- [ ] **Step 3: Implement `sim/parallel.py`**

```python
"""Spread independent work over worker processes. Workers are spawned (the only start method on
Windows), each set up once by `initializer` (e.g. load a model) with torch limited to one thread so
N workers use about N cores. Results come back in item order; a worker's exception fails the call."""
import multiprocessing as mp
from collections.abc import Callable, Iterable
from concurrent.futures import ProcessPoolExecutor

DEFAULT_WORKERS = 7  # one core of the dev box's eight left for the parent and the machine


def _init_worker(initializer: Callable | None, initargs: tuple) -> None:
    import torch

    torch.set_num_threads(1)
    if initializer is not None:
        initializer(*initargs)


def parallel_map(
    fn: Callable, items: Iterable, workers: int, initializer: Callable | None = None, initargs: tuple = (),
    on_result: Callable[[int, object], None] | None = None,
) -> list:
    """`fn` and `initializer` must be importable top-level functions (spawned workers re-import them).
    With one worker (or one item) everything runs in this process, initializer included."""
    items = list(items)
    results: list = []

    def collect(result) -> None:
        results.append(result)
        if on_result is not None:
            on_result(len(results), result)

    if workers <= 1 or len(items) <= 1:
        if initializer is not None:
            initializer(*initargs)
        for item in items:
            collect(fn(item))
        return results
    pool = ProcessPoolExecutor(
        max_workers=min(workers, len(items)), mp_context=mp.get_context("spawn"),
        initializer=_init_worker, initargs=(initializer, initargs),
    )
    try:
        for result in pool.map(fn, items):
            collect(result)
    except BaseException:
        pool.shutdown(wait=False, cancel_futures=True)
        raise
    pool.shutdown()
    return results
```

- [ ] **Step 4: Implement `eval/auction_runner.py`**

```python
"""Build bidding agents from plain specs (so worker processes can rebuild them from file paths)
and run `evaluate_auctions` across workers."""
from dataclasses import dataclass
from pathlib import Path

from ..agents.base import Agent
from ..agents.model_agent import ModelAgent
from ..agents.sim_bidder import SimAgent
from ..sim.decide import DEFAULT_MAKE_THRESHOLD
from ..sim.parallel import DEFAULT_WORKERS, parallel_map
from .arena import AuctionEval, evaluate_auctions, merge_auction_evals


@dataclass(frozen=True)
class BidderSpec:
    kind: str  # "heuristic" | "sim" | "fast"
    model: str  # the play checkpoint both sides play with
    bidnet: str | None = None
    sim_deals: int = 200
    make_threshold: float = DEFAULT_MAKE_THRESHOLD
    seed: int = 0


def parse_bidder(text: str, model: str, sim_deals: int, make_threshold: float, seed: int) -> BidderSpec:
    if text in ("heuristic", "sim"):
        return BidderSpec(text, model, None, sim_deals, make_threshold, seed)
    raise ValueError(f"unknown bidder {text!r}; use heuristic or sim")


def build_bidder(spec: BidderSpec) -> Agent:
    if spec.kind == "heuristic":
        agent = ModelAgent.from_checkpoint(spec.model)
        agent.name = f"heuristic-bidding:{Path(spec.model).name}"
        return agent
    if spec.kind == "sim":
        return SimAgent.from_checkpoint(
            spec.model, n_deals=spec.sim_deals, make_threshold=spec.make_threshold, seed=spec.seed
        )
    raise ValueError(f"unknown bidder kind {spec.kind!r}")


_agents: tuple[Agent, Agent] | None = None  # this worker's A and B, built once


def _init_agents(a: BidderSpec, b: BidderSpec) -> None:
    global _agents
    _agents = (build_bidder(a), build_bidder(b))


def _run_chunk(task: tuple[range, int]) -> AuctionEval:
    deals, seed = task
    return evaluate_auctions(*_agents, deals, seed=seed)


def evaluate_auctions_parallel(
    a: BidderSpec, b: BidderSpec, deals: int, seed: int = 0, workers: int = DEFAULT_WORKERS, chunk: int | None = None
) -> AuctionEval:
    """`evaluate_auctions` over `deals` duplicate deals, split into contiguous chunks (about four per
    worker, for load balance). The result is identical for any worker count."""
    if deals < 1:
        raise ValueError("deals must be at least 1")
    size = chunk or max(1, -(-deals // (max(workers, 1) * 4)))
    tasks = [(range(start, min(start + size, deals)), seed) for start in range(0, deals, size)]
    return merge_auction_evals(parallel_map(_run_chunk, tasks, workers, _init_agents, (a, b)))
```

- [ ] **Step 5: Wire the CLI**

In `cli.py`:
- Import `BidderSpec`, `build_bidder`, `evaluate_auctions_parallel` and `parse_bidder` from `.eval.auction_runner`, and `DEFAULT_WORKERS` from `.sim.parallel`.
- Drop `evaluate_auctions` from the `.eval.arena` import if it is now unused.
- Change the `eval-bidding` parser help to `"compare two bidders on one play model (default: sim vs heuristic)"`.
- Add:
```python
    s.add_argument("--a", default="sim", help="heuristic | sim (Task 6 adds fast:<bidnet.pt>)")
    s.add_argument("--b", default="heuristic", help="heuristic | sim")
    s.add_argument("--workers", type=int, default=DEFAULT_WORKERS, help="worker processes (1 = in-process)")
```
Write the `--a` help as `"heuristic | sim | fast:<bidnet.pt>"` in Task 6, not now. Replace the branch:
```python
    elif args.command == "eval-bidding":
        common = dict(model=args.model, sim_deals=args.sim_deals, make_threshold=args.make_threshold, seed=args.seed)
        a_spec, b_spec = parse_bidder(args.a, **common), parse_bidder(args.b, **common)
        ev = evaluate_auctions_parallel(a_spec, b_spec, args.deals, seed=args.seed, workers=args.workers)
        matches = None
        if args.matches:
            matches = evaluate_matches(build_bidder(a_spec), build_bidder(b_spec), args.matches, seed=args.seed)
        print(format_auction_report(ev, matches))
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_sim_parallel.py tests/test_cli.py -q`, then `uv run pytest -q`.
Expected: all pass. The spawn tests take several seconds each, because each worker imports torch.

- [ ] **Step 7: Commit**

```bash
git add ml/src/fortytwo_ml/sim/parallel.py ml/src/fortytwo_ml/eval/auction_runner.py ml/src/fortytwo_ml/cli.py ml/tests/test_sim_parallel.py ml/tests/test_cli.py
git commit -m "ml: parallel workers; eval-bidding --a/--b/--workers"
```

---

### Task 4: `ml gen-bids`, the training data

**Files:**
- Create: `ml/src/fortytwo_ml/bidding/__init__.py` (empty), `ml/src/fortytwo_ml/bidding/data.py`
- Modify: `ml/src/fortytwo_ml/cli.py`, `ml/.gitignore` (add the line `data/`)
- Test: `ml/tests/test_bid_data.py`

**Interfaces:**
- Consumes:
  - `simulate_hand` (Task 1);
  - `parallel_map` and `DEFAULT_WORKERS` (Task 3);
  - `load_checkpoint(path) -> (QNet, {"step", "config"})`.
- Produces, in `fortytwo_ml.bidding.data`:
  - **`deal_hand(seed, i) -> tuple[list[int], random.Random]`.** The hand is sorted, and the rng is ready to drive `simulate_hand`.
  - **`checkpoint_label(path) -> str`.** For example, `"stage1-c/ckpt-latest.pt"`.
  - **`GenConfig(model: str, out: str, hands: int, sim_deals: int = 50, seed: int = 0, workers: int = DEFAULT_WORKERS, batch_hands: int = 1000)`.**
  - **`generate(cfg, log=print) -> int`.** Returns the number of hands written this run.
  - **`save_batch(path, arrays: dict, *, sim_deals, play_checkpoint, play_path, play_step, seed)`.**
  - **`BidData`** (frozen) with:
    - `hands` (n, 7);
    - `points_hist` (n, 7, 43);
    - `high_made` (n, 8);
    - `low_clean` (n, 3);
    - `plunge_made` (n,) (−1 = absent);
    - `n_deals` (n,);
    - `play_checkpoint: str`, `play_path: str`, `play_step: int`.
  - **`load_bids(folder) -> BidData`.**
  - **`BidData.subset(mask_or_index) -> BidData`.**
- CLI: `ml gen-bids --model --out --hands [--sim-deals 50] [--seed 0] [--workers 7]`.

- [ ] **Step 1: Write the failing tests**

Create `ml/tests/test_bid_data.py`:
```python
import numpy as np
import pytest
import torch

from fortytwo_ml.bidding.data import GenConfig, deal_hand, generate, load_bids, save_batch
from fortytwo_ml.model import QNet, save_checkpoint


@pytest.fixture
def ckpt(tmp_path):
    torch.manual_seed(0)
    path = tmp_path / "run" / "m.pt"
    path.parent.mkdir()
    save_checkpoint(path, QNet(hidden=16, layers=1), step=7, config={})
    return str(path)


def _gen(ckpt, out, hands, seed=1, workers=1, batch=2):
    return generate(GenConfig(ckpt, str(out), hands, sim_deals=2, seed=seed, workers=workers, batch_hands=batch), log=lambda *_: None)


def test_hands_are_deterministic_per_seed_and_index():
    assert deal_hand(1, 5)[0] == deal_hand(1, 5)[0] != deal_hand(1, 6)[0]
    hand = deal_hand(2, 0)[0]
    assert len(set(hand)) == 7 and hand == sorted(hand)


def test_generate_writes_batches_that_load_back(tmp_path, ckpt):
    assert _gen(ckpt, tmp_path / "d", 5) == 5
    assert sorted(p.name for p in (tmp_path / "d").iterdir()) == [
        "gen-s1-0000000.npz", "gen-s1-0000002.npz", "gen-s1-0000004.npz"]
    data = load_bids(tmp_path / "d")
    assert data.hands.shape == (5, 7) and data.points_hist.shape == (5, 7, 43)
    assert (data.points_hist.sum(axis=2) == 2).all() and (data.n_deals == 2).all()
    assert data.play_checkpoint == "run/m.pt" and data.play_step == 7 and data.play_path == ckpt
    assert [list(h) for h in data.hands] == [deal_hand(1, i)[0] for i in range(5)]


def test_rerun_skips_existing_batches_and_new_seed_adds_hands(tmp_path, ckpt):
    _gen(ckpt, tmp_path / "d", 4)
    assert _gen(ckpt, tmp_path / "d", 4) == 0
    assert _gen(ckpt, tmp_path / "d", 4, seed=2) == 4
    assert len(load_bids(tmp_path / "d").hands) == 8


def test_rerun_with_more_hands_fills_the_short_batch(tmp_path, ckpt):
    _gen(ckpt, tmp_path / "d", 3)  # batches of 2 and 1
    assert _gen(ckpt, tmp_path / "d", 4) == 2  # the 1-hand batch is redone as 2 hands
    assert [list(h) for h in load_bids(tmp_path / "d").hands] == [deal_hand(1, i)[0] for i in range(4)]


def test_loading_ignores_temporary_files(tmp_path, ckpt):
    _gen(ckpt, tmp_path / "d", 2)
    (tmp_path / "d" / "gen-s1-0000002.npz.tmp").write_bytes(b"half a file")
    assert len(load_bids(tmp_path / "d").hands) == 2  # the stray partial file is ignored
    _gen(ckpt, tmp_path / "e", 3)
    assert not list((tmp_path / "e").glob("*.tmp"))  # and generate itself leaves none


def test_mixed_play_checkpoints_are_rejected(tmp_path):
    arrays = dict(hands=np.zeros((1, 7), np.int8), points_hist=np.zeros((1, 7, 43), np.uint16),
                  high_made=np.zeros((1, 8), np.uint16), low_clean=np.zeros((1, 3), np.uint16),
                  plunge_made=np.full(1, -1, np.int16))
    save_batch(tmp_path / "gen-s1-0000000.npz", arrays, sim_deals=2, play_checkpoint="a/m.pt", play_path="a/m.pt", play_step=1, seed=1)
    save_batch(tmp_path / "gen-s2-0000000.npz", arrays, sim_deals=2, play_checkpoint="b/m.pt", play_path="b/m.pt", play_step=1, seed=2)
    with pytest.raises(ValueError, match="different play checkpoints"):
        load_bids(tmp_path)


def test_worker_count_does_not_change_the_data(tmp_path, ckpt):
    _gen(ckpt, tmp_path / "one", 4, workers=1)
    _gen(ckpt, tmp_path / "two", 4, workers=2)
    one, two = load_bids(tmp_path / "one"), load_bids(tmp_path / "two")
    assert (one.hands == two.hands).all() and (one.points_hist == two.points_hist).all()
    assert (one.high_made == two.high_made).all() and (one.plunge_made == two.plunge_made).all()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_bid_data.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'fortytwo_ml.bidding'`.

- [ ] **Step 3: Implement `bidding/data.py`**

```python
"""Training data for the bidding model: random hands, each with the raw simulation counts for
every bid option (see sim/probe.py), stored in batch files of `batch_hands` hands. Rerunning a
command resumes it; a new seed adds new hands."""
import os
import random
import time
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np

from ..model import load_checkpoint
from ..sim.parallel import DEFAULT_WORKERS, parallel_map
from ..sim.probe import simulate_hand

ARRAYS = ("hands", "points_hist", "high_made", "low_clean", "plunge_made")


@dataclass(frozen=True)
class GenConfig:
    model: str
    out: str
    hands: int
    sim_deals: int = 50
    seed: int = 0
    workers: int = DEFAULT_WORKERS
    batch_hands: int = 1000


@dataclass(frozen=True)
class BidData:
    hands: np.ndarray        # (n, 7) domino ids, sorted
    points_hist: np.ndarray  # (n, 7, 43)
    high_made: np.ndarray    # (n, 8)
    low_clean: np.ndarray    # (n, 3)
    plunge_made: np.ndarray  # (n,), -1 when the hand can't plunge
    n_deals: np.ndarray      # (n,) simulated deals behind each hand's counts
    play_checkpoint: str     # run folder / file name of the play model, e.g. "stage1-c/ckpt-latest.pt"
    play_path: str           # the path it was loaded from
    play_step: int

    def subset(self, index) -> "BidData":
        return replace(self, **{k: getattr(self, k)[index] for k in (*ARRAYS, "n_deals")})


def deal_hand(seed: int, i: int) -> tuple[list[int], random.Random]:
    rng = random.Random(f"gen-bids:{seed}:{i}")
    return sorted(rng.sample(range(28), 7)), rng


def checkpoint_label(path: str | Path) -> str:
    p = Path(path)
    return f"{p.parent.name}/{p.name}"


def batch_path(out: str | Path, seed: int, start: int) -> Path:
    return Path(out) / f"gen-s{seed}-{start:07d}.npz"


def save_batch(path: Path, arrays: dict, *, sim_deals: int, play_checkpoint: str, play_path: str, play_step: int, seed: int) -> None:
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as f:
        np.savez(f, **arrays, sim_deals=np.int32(sim_deals), play_checkpoint=np.str_(play_checkpoint),
                 play_path=np.str_(play_path), play_step=np.int64(play_step), seed=np.int64(seed))
    os.replace(tmp, path)


def _batch_size(path: Path) -> int | None:
    if not path.exists():
        return None
    with np.load(path) as z:
        return len(z["hands"])


_worker: dict = {}  # this process's play model and its provenance, loaded once


def _init(model_path: str) -> None:
    model, info = load_checkpoint(model_path)
    _worker.update(model=model, label=checkpoint_label(model_path), path=model_path, step=info["step"])


def _simulate_batch(task: tuple[str, int, int, int, int]) -> int:
    out, seed, start, count, sim_deals = task
    arrays = dict(
        hands=np.zeros((count, 7), np.int8), points_hist=np.zeros((count, 7, 43), np.uint16),
        high_made=np.zeros((count, 8), np.uint16), low_clean=np.zeros((count, 3), np.uint16),
        plunge_made=np.full(count, -1, np.int16),
    )
    for j in range(count):
        hand, rng = deal_hand(seed, start + j)
        sims = simulate_hand(_worker["model"], 0, hand, sim_deals, rng)
        arrays["hands"][j] = hand
        arrays["points_hist"][j] = sims.points_hist
        arrays["high_made"][j] = sims.high_made
        arrays["low_clean"][j] = sims.low_clean
        if sims.plunge_made is not None:
            arrays["plunge_made"][j] = sims.plunge_made
    save_batch(batch_path(out, seed, start), arrays, sim_deals=sim_deals, play_checkpoint=_worker["label"],
               play_path=_worker["path"], play_step=_worker["step"], seed=seed)
    return count


def generate(cfg: GenConfig, log=print) -> int:
    out = Path(cfg.out)
    out.mkdir(parents=True, exist_ok=True)
    tasks = []
    for start in range(0, cfg.hands, cfg.batch_hands):
        count = min(cfg.batch_hands, cfg.hands - start)
        if _batch_size(batch_path(out, cfg.seed, start)) != count:  # missing, or short from a smaller --hands
            tasks.append((str(out), cfg.seed, start, count, cfg.sim_deals))
    total = sum(t[3] for t in tasks)
    log(f"{len(tasks)} batches to simulate ({total} hands); "
        f"{-(-cfg.hands // cfg.batch_hands) - len(tasks)} already done")
    began, written = time.monotonic(), 0

    def progress(done: int, count: int) -> None:
        nonlocal written
        written += count
        rate = written / max(time.monotonic() - began, 1e-9)
        eta = (total - written) / rate if rate else 0
        log(f"batch {done}/{len(tasks)}: {written}/{total} hands, {rate:.2f} hands/s, ETA {eta / 3600:.1f} h")

    parallel_map(_simulate_batch, tasks, cfg.workers, _init, (cfg.model,), on_result=progress)
    return written


def load_bids(folder: str | Path) -> BidData:
    files = sorted(Path(folder).glob("gen-s*.npz"))
    if not files:
        raise FileNotFoundError(f"no gen-s*.npz batches in {folder}")
    parts, sources = [], set()
    for f in files:
        with np.load(f) as z:
            sources.add((z["play_checkpoint"].item(), int(z["play_step"])))
            part = {k: z[k] for k in ARRAYS}
            part["n_deals"] = np.full(len(part["hands"]), int(z["sim_deals"]))
            play_path = z["play_path"].item()
        parts.append(part)
    if len(sources) > 1:
        raise ValueError(f"batches in {folder} come from different play checkpoints {sorted(sources)}; "
                         "keep one play model's data per folder")
    (label, step), = sources
    joined = {k: np.concatenate([p[k] for p in parts]).astype(np.int64) for k in (*ARRAYS, "n_deals")}
    return BidData(**joined, play_checkpoint=label, play_path=play_path, play_step=step)
```

- [ ] **Step 4: Wire the CLI and the gitignore**

In `cli.py`, add the subparser:
```python
    g = sub.add_parser("gen-bids", help="Stage 3: simulate random hands into bidding-model training data")
    g.add_argument("--model", required=True, help="the play checkpoint the simulations use")
    g.add_argument("--out", required=True, help="data folder (batches are added; reruns resume)")
    g.add_argument("--hands", type=int, required=True)
    g.add_argument("--sim-deals", type=int, default=50)
    g.add_argument("--seed", type=int, default=0)
    g.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
```
and the branch (importing inside the branch, like `train`):
```python
    elif args.command == "gen-bids":
        from .bidding.data import GenConfig, generate

        written = generate(GenConfig(args.model, args.out, args.hands, args.sim_deals, args.seed, args.workers))
        print(f"wrote {written} hands to {args.out}")
```
Update the module docstring of `cli.py` to list `ml gen-bids`. Append `data/` to `ml/.gitignore`.

Append to `ml/tests/test_cli.py`:
```python
def test_gen_bids_cli(tmp_path, capsys):
    path = tmp_path / "m.pt"
    save_checkpoint(path, QNet(hidden=16, layers=1), step=0, config={})
    assert main(["gen-bids", "--model", str(path), "--out", str(tmp_path / "d"), "--hands", "2",
                 "--sim-deals", "2", "--workers", "1"]) == 0
    assert "wrote 2 hands" in capsys.readouterr().out
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_bid_data.py tests/test_cli.py -q`, then `uv run pytest -q`.
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add ml/src/fortytwo_ml/bidding ml/src/fortytwo_ml/cli.py ml/.gitignore ml/tests/test_bid_data.py ml/tests/test_cli.py
git commit -m "ml: gen-bids writes resumable batches of simulated hands for the bidding model"
```

---

### Task 5: `BidNet` and `ml train-bids`

**Files:**
- Create: `ml/src/fortytwo_ml/bidding/model.py`, `ml/src/fortytwo_ml/bidding/train.py`
- Modify: `ml/src/fortytwo_ml/cli.py`
- Test: `ml/tests/test_bidnet.py`, `ml/tests/test_cli.py`

**Interfaces:**
- Consumes: `BidData`, `load_bids` (Task 4); `BidTable`, `can_plunge` (Task 1).
- Produces, in `fortytwo_ml.bidding.model`:
  - **Constants:** `INPUT_LAYOUT = 1`, `HAND_DIM = 36`, `POINT_BUCKETS = 14`, `BINARY = 12`.
  - **`encode_hands(hands: np.ndarray) -> np.ndarray`:** (n, 7) → (n, 36) float32.
  - **`BidNet(hidden=256, layers=3)`:**
    - `forward(x) -> (points_logits (n, 7, 14), binary_logits (n, 12))`;
    - `predict(hands) -> (points (n, 7, 12) P(make 30..41), binary (n, 12))` as numpy arrays;
    - `table(hand) -> BidTable`, where plunge is `None` unless `can_plunge(hand)`.
  - **`save_bidnet(path, net, meta: dict)`** and **`load_bidnet(path) -> (BidNet, meta)`**. `meta` keys: `play_checkpoint`, `play_path`, `play_step`, `train_hands`, `val_loss`, and `gold` (a dict, possibly empty).
- Produces, in `fortytwo_ml.bidding.train`:
  - **Helpers:**
    - `bucket_counts(points_hist) -> (n, 7, 14)`;
    - `is_validation(hands) -> np.ndarray[bool]`;
    - `bid_loss(points_logits, binary_logits, buckets, made, mask, n) -> Tensor`.
  - **`BidTrainConfig(hidden=256, layers=3, epochs=100, patience=5, batch_size=512, lr=1e-3, seed=0)`.**
  - **`train_bidnet(data, cfg, log=print) -> TrainResult(net, val_loss, epochs)`.**
  - **`simulated_tables(data) -> (points (n, 7, 12), binary (n, 12), mask (n, 12))`.**
  - **`gold_report(net, gold) -> (lines: list[str], metrics: dict[str, float])`.**
- CLI: `ml train-bids --data DIR [--gold DIR] --out RUN_DIR [--epochs 100] [--seed 0]`.

- [ ] **Step 1: Write the failing tests**

Create `ml/tests/test_bidnet.py`:
```python
import random

import numpy as np
import torch

from fortytwo_ml.bidding.data import BidData
from fortytwo_ml.bidding.model import BidNet, encode_hands, load_bidnet, save_bidnet
from fortytwo_ml.bidding.train import (
    BidTrainConfig, bid_loss, bucket_counts, gold_report, is_validation, simulated_tables, train_bidnet,
)
from fortytwo_ml.engine.dominoes import PIPS


def _hands(n, seed):
    rng = random.Random(seed)
    return np.array([sorted(rng.sample(range(28), 7)) for _ in range(n)])


def _rule_data(hands, n_deals=20):
    """Synthetic labels with a learnable rule: a suit's 30-bid points are 26 + 3 x (dominoes in it)."""
    count = len(hands)
    hist = np.zeros((count, 7, 43), np.int64)
    for i, hand in enumerate(hands):
        for s in range(7):
            held = sum(1 for d in hand if s in PIPS[d])
            hist[i, s, min(42, 26 + 3 * held)] = n_deals
    high = (hist[:, :, 42] > 0).astype(np.int64) * n_deals
    high = np.concatenate([high, np.zeros((count, 1), np.int64)], axis=1)
    return BidData(hands, hist, high, np.zeros((count, 3), np.int64), np.full(count, -1),
                   np.full(count, n_deals), "run/m.pt", "runs/run/m.pt", 1)


def test_encode_hands_bits_and_counts():
    x = encode_hands(np.array([[0, 1, 2, 3, 4, 5, 6]]))  # 0/0 0/1 ... 0/6: every domino has a 0
    assert x.shape == (1, 36) and x[0, :7].sum() == 7 and x[0, 7:28].sum() == 0
    assert x[0, 28] == 1.0  # seven dominoes contain a 0
    assert abs(x[0, 35] - 1 / 7) < 1e-6  # one double (0/0)


def test_points_probabilities_never_rise_with_the_bid():
    torch.manual_seed(0)
    points, binary = BidNet(hidden=16, layers=1).predict(_hands(20, 1))
    assert (np.diff(points, axis=2) <= 1e-7).all() and points.shape == (20, 7, 12) and binary.shape == (20, 12)


def test_table_has_plunge_only_with_four_doubles():
    net = BidNet(hidden=16, layers=1)
    assert net.table([1, 2, 3, 4, 5, 6, 8]).plunge is None
    assert net.table([0, 7, 13, 18, 1, 2, 3]).plunge is not None


def test_bucket_counts_keep_every_deal():
    hist = np.zeros((1, 7, 43), np.int64)
    hist[0, 0, [5, 29, 30, 41, 42]] = [1, 2, 3, 4, 5]
    b = bucket_counts(hist)
    assert b.shape == (1, 7, 14) and list(b[0, 0]) == [3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 5]


def test_validation_split_is_stable_and_small():
    hands = _hands(4000, 2)
    mask = is_validation(hands)
    assert (mask == is_validation(hands)).all() and 0.03 < mask.mean() < 0.07


def test_loss_prefers_the_right_answer():
    buckets = torch.zeros(1, 7, 14)
    buckets[:, :, 5] = 10
    made, mask, n = torch.tensor([[10.0] * 12]), torch.ones(1, 12), torch.tensor([10.0])
    right = torch.full((1, 7, 14), -9.0)
    right[:, :, 5] = 9.0
    wrong = torch.zeros(1, 7, 14)
    good = bid_loss(right, torch.full((1, 12), 9.0), buckets, made, mask, n)
    bad = bid_loss(wrong, torch.full((1, 12), -9.0), buckets, made, mask, n)
    assert good < bad


def test_training_learns_a_known_rule_and_round_trips(tmp_path):
    data, gold = _rule_data(_hands(800, 3)), _rule_data(_hands(100, 4))
    torch.manual_seed(0)
    _, before = gold_report(BidNet(hidden=32, layers=2), gold)
    result = train_bidnet(data, BidTrainConfig(hidden=32, layers=2, epochs=40, batch_size=64), log=lambda *_: None)
    lines, after = gold_report(result.net, gold)
    assert after["mae_30"] < before["mae_30"] / 2 and any("Calibration" in line for line in lines)
    save_bidnet(tmp_path / "b.pt", result.net, {"play_checkpoint": "run/m.pt", "play_path": "x", "play_step": 1,
                                                "train_hands": 800, "val_loss": result.val_loss, "gold": after})
    net, meta = load_bidnet(tmp_path / "b.pt")
    assert meta["play_step"] == 1 and np.allclose(net.predict(gold.hands)[0], result.net.predict(gold.hands)[0])


def test_simulated_tables_match_counts():
    data = _rule_data(_hands(3, 5))
    points, binary, mask = simulated_tables(data)
    assert points.shape == (3, 7, 12) and set(np.unique(points)) <= {0.0, 1.0}
    assert (mask[:, 11] == 0).all() and (mask[:, :11] == 1).all()
```
Check `[0, 7, 13, 18, 1, 2, 3]` against `PIPS` before relying on it. It is 0/0, 1/1, 2/2, 3/3, 0/1, 0/2, 0/3, which is four doubles.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_bidnet.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'fortytwo_ml.bidding.model'`.

- [ ] **Step 3: Implement `bidding/model.py`**

```python
"""BidNet: a hand -> the simulation bidder's P(make) table, in well under a millisecond.

Points bids: per named suit, a distribution over the team's final points at a 30 bid in buckets
(<30, 30, ..., 41, 42); P(make b) is the mass at or above b, so it can't rise with the bid.
Everything else is a yes/no probability: 42 in each named suit, follow-me, the three Low
variants, plunge."""
from collections.abc import Sequence
from pathlib import Path

import numpy as np
import torch
from torch import nn

from ..engine.dominoes import PIPS
from ..sim.probe import BidTable, can_plunge

INPUT_LAYOUT = 1
HAND_DIM = 28 + 7 + 1  # domino bits, dominoes per suit / 7, doubles / 7
POINT_BUCKETS = 14
BINARY = 12
_LO = np.array([lo for lo, _ in PIPS])
_HI = np.array([hi for _, hi in PIPS])


def encode_hands(hands: np.ndarray) -> np.ndarray:
    hands = np.asarray(hands, dtype=np.int64)
    x = np.zeros((len(hands), HAND_DIM), np.float32)
    x[np.arange(len(hands))[:, None], hands] = 1.0
    lo, hi = _LO[hands], _HI[hands]
    for suit in range(7):
        x[:, 28 + suit] = ((lo == suit) | (hi == suit)).sum(axis=1) / 7
    x[:, 35] = (lo == hi).sum(axis=1) / 7
    return x


class BidNet(nn.Module):
    def __init__(self, hidden: int = 256, layers: int = 3):
        super().__init__()
        self.hidden, self.layers = hidden, layers
        blocks: list[nn.Module] = []
        width = HAND_DIM
        for _ in range(layers):
            blocks += [nn.Linear(width, hidden), nn.ReLU()]
            width = hidden
        self.body = nn.Sequential(*blocks)
        self.points_head = nn.Linear(width, 7 * POINT_BUCKETS)
        self.binary_head = nn.Linear(width, BINARY)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        h = self.body(x)
        return self.points_head(h).view(-1, 7, POINT_BUCKETS), self.binary_head(h)

    def predict(self, hands: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        with torch.no_grad():
            points_logits, binary_logits = self(torch.from_numpy(encode_hands(hands)))
        probs = points_logits.softmax(-1).numpy().astype(np.float64)
        at_least = probs[:, :, ::-1].cumsum(axis=2)[:, :, ::-1]  # [..., k] = P(bucket >= k)
        return at_least[:, :, 1:13], torch.sigmoid(binary_logits).numpy().astype(np.float64)

    def table(self, hand: Sequence[int]) -> BidTable:
        points, binary = self.predict(np.array([list(hand)]))
        return BidTable(points[0], binary[0, :8], binary[0, 8:11], float(binary[0, 11]) if can_plunge(hand) else None)


def save_bidnet(path: str | Path, net: BidNet, meta: dict) -> None:
    torch.save({"weights": {k: v.detach().cpu() for k, v in net.state_dict().items()},
                "hidden": net.hidden, "layers": net.layers, "input_layout": INPUT_LAYOUT, "meta": meta}, path)


def load_bidnet(path: str | Path) -> tuple[BidNet, dict]:
    data = torch.load(path, map_location="cpu", weights_only=True)
    if data.get("input_layout") != INPUT_LAYOUT:
        raise ValueError(f"{path} uses input layout {data.get('input_layout')}, this code uses {INPUT_LAYOUT}")
    net = BidNet(data["hidden"], data["layers"])
    net.load_state_dict(data["weights"])
    return net.eval(), data["meta"]
```

- [ ] **Step 4: Implement `bidding/train.py`**

```python
"""Train BidNet on gen-bids data: cross-entropy against each hand's simulated points histogram,
binomial likelihood for the yes/no options, both weighted by how many deals the counts came from."""
import copy
import zlib
from dataclasses import dataclass

import numpy as np
import torch
import torch.nn.functional as F

from .data import BidData
from .model import BidNet, encode_hands

_REPORT_BIDS = (30, 34, 38)


@dataclass(frozen=True)
class BidTrainConfig:
    hidden: int = 256
    layers: int = 3
    epochs: int = 100
    patience: int = 5
    batch_size: int = 512
    lr: float = 1e-3
    seed: int = 0


@dataclass
class TrainResult:
    net: BidNet
    val_loss: float
    epochs: int


def bucket_counts(points_hist: np.ndarray) -> np.ndarray:
    return np.concatenate([points_hist[..., :30].sum(axis=-1, keepdims=True), points_hist[..., 30:43]], axis=-1)


def is_validation(hands: np.ndarray) -> np.ndarray:
    return np.array([zlib.crc32(bytes(sorted(int(d) for d in h))) % 20 == 0 for h in hands])


def _targets(data: BidData) -> tuple[torch.Tensor, ...]:
    x = torch.from_numpy(encode_hands(data.hands))
    buckets = torch.from_numpy(bucket_counts(data.points_hist).astype(np.float32))
    plunge = np.maximum(data.plunge_made, 0)[:, None]
    made = torch.from_numpy(np.concatenate([data.high_made, data.low_clean, plunge], axis=1).astype(np.float32))
    mask = torch.ones_like(made)
    mask[:, 11] = torch.from_numpy((data.plunge_made >= 0).astype(np.float32))
    n = torch.from_numpy(data.n_deals.astype(np.float32))
    return x, buckets, made, mask, n


def bid_loss(points_logits, binary_logits, buckets, made, mask, n) -> torch.Tensor:
    points = -(buckets * points_logits.log_softmax(-1)).sum(-1) / n[:, None]
    binary = F.binary_cross_entropy_with_logits(binary_logits, made / n[:, None], reduction="none")
    return points.mean() + (binary * mask).sum() / mask.sum()


def _loss_on(net: BidNet, tensors) -> float:
    x, *rest = tensors
    with torch.no_grad():
        return float(bid_loss(*net(x), *rest))


def train_bidnet(data: BidData, cfg: BidTrainConfig, log=print) -> TrainResult:
    torch.manual_seed(cfg.seed)
    val = is_validation(data.hands)
    train_t = _targets(data.subset(~val))
    # Tiny datasets can hold no validation hand; early stopping then watches the training loss.
    val_t = _targets(data.subset(val)) if val.any() else train_t
    net = BidNet(cfg.hidden, cfg.layers)
    opt = torch.optim.Adam(net.parameters(), lr=cfg.lr)
    gen = torch.Generator().manual_seed(cfg.seed)
    best, best_state, since, epoch = float("inf"), None, 0, 0
    for epoch in range(1, cfg.epochs + 1):
        net.train()
        order = torch.randperm(len(train_t[0]), generator=gen)
        total = 0.0
        for start in range(0, len(order), cfg.batch_size):
            idx = order[start:start + cfg.batch_size]
            x, *rest = (t[idx] for t in train_t)
            loss = bid_loss(*net(x), *rest)
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += float(loss) * len(idx)
        net.eval()
        held_out = _loss_on(net, val_t)
        log(f"epoch {epoch}: train {total / len(order):.4f}  held-out {held_out:.4f}")
        if held_out < best:
            best, best_state, since = held_out, copy.deepcopy(net.state_dict()), 0
        else:
            since += 1
            if since >= cfg.patience:
                break
    net.load_state_dict(best_state)
    return TrainResult(net.eval(), best, epoch)


def simulated_tables(data: BidData) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    n = data.n_deals[:, None].astype(np.float64)
    at_least = data.points_hist[:, :, ::-1].cumsum(axis=2)[:, :, ::-1]
    points = at_least[:, :, 30:42] / n[:, :, None]
    plunge = np.maximum(data.plunge_made, 0)[:, None]
    binary = np.concatenate([data.high_made, data.low_clean, plunge], axis=1) / n
    mask = np.ones_like(binary)
    mask[:, 11] = data.plunge_made >= 0
    return points, binary, mask


def gold_report(net: BidNet, gold: BidData) -> tuple[list[str], dict[str, float]]:
    """How far BidNet's P(make) is from a low-noise simulated table, at the bids that matter."""
    pred_points, pred_binary = net.predict(gold.hands)
    sim_points, sim_binary, mask = simulated_tables(gold)
    rows = np.arange(len(gold.hands))
    best30 = sim_points[:, :, 0].argmax(axis=1)
    best42 = sim_binary[:, :7].argmax(axis=1)
    best_low = 8 + sim_binary[:, 8:11].argmax(axis=1)
    metrics = {f"mae_{b}": float(np.abs(pred_points[rows, best30, b - 30] - sim_points[rows, best30, b - 30]).mean())
               for b in _REPORT_BIDS}
    metrics["mae_42"] = float(np.abs(pred_binary[rows, best42] - sim_binary[rows, best42]).mean())
    metrics["mae_follow_me"] = float(np.abs(pred_binary[:, 7] - sim_binary[:, 7]).mean())
    metrics["mae_low"] = float(np.abs(pred_binary[rows, best_low] - sim_binary[rows, best_low]).mean())
    lines = [f"Gold set: {len(gold.hands)} hands",
             "Mean absolute error of P(make), best suit unless noted:"]
    lines += [f"  {name[4:]:<10} {value:.3f}" for name, value in metrics.items()]
    lines.append("Calibration: predicted P(make) -> simulated P(make), all table entries")
    flat_pred = np.concatenate([pred_points.ravel(), pred_binary[mask > 0]])
    flat_sim = np.concatenate([sim_points.ravel(), sim_binary[mask > 0]])
    for k in range(10):
        low, high = k / 10, (k + 1) / 10
        hit = (flat_pred >= low) & ((flat_pred < high) if k < 9 else (flat_pred <= 1.0))
        if hit.any():
            lines.append(f"  {low:.1f}-{high:.1f}: predicted {flat_pred[hit].mean():.2f}  "
                         f"simulated {flat_sim[hit].mean():.2f}  (n={int(hit.sum())})")
    return lines, metrics
```

- [ ] **Step 5: Wire the CLI**

Add the subparser:
```python
    t = sub.add_parser("train-bids", help="Stage 3: train BidNet on gen-bids data")
    t.add_argument("--data", required=True, help="gen-bids folder")
    t.add_argument("--gold", help="optional low-noise gen-bids folder, used only for the final report")
    t.add_argument("--out", required=True, type=Path, help="run folder; bidnet.pt is written here")
    t.add_argument("--epochs", type=int, default=100)
    t.add_argument("--seed", type=int, default=0)
```
and the branch:
```python
    elif args.command == "train-bids":
        from .bidding.data import load_bids
        from .bidding.model import save_bidnet
        from .bidding.train import BidTrainConfig, gold_report, train_bidnet

        data = load_bids(args.data)
        gold = load_bids(args.gold) if args.gold else None
        if gold is not None and (gold.play_checkpoint, gold.play_step) != (data.play_checkpoint, data.play_step):
            raise ValueError(f"the gold set was simulated with {gold.play_checkpoint} (step {gold.play_step}), "
                             f"the training data with {data.play_checkpoint} (step {data.play_step})")
        result = train_bidnet(data, BidTrainConfig(epochs=args.epochs, seed=args.seed))
        meta = {"play_checkpoint": data.play_checkpoint, "play_path": data.play_path, "play_step": data.play_step,
                "train_hands": int(len(data.hands)), "val_loss": result.val_loss, "gold": {}}
        if gold is not None:
            lines, meta["gold"] = gold_report(result.net, gold)
            print("\n".join(lines))
        args.out.mkdir(parents=True, exist_ok=True)
        save_bidnet(args.out / "bidnet.pt", result.net, meta)
        print(f"trained {result.epochs} epochs on {len(data.hands)} hands; held-out loss {result.val_loss:.4f}; "
              f"saved {args.out / 'bidnet.pt'}")
```
Add `ml train-bids` to the `cli.py` docstring. Append to `ml/tests/test_cli.py`:
```python
def test_train_bids_cli(tmp_path, capsys):
    from fortytwo_ml.bidding.model import load_bidnet

    path = tmp_path / "m.pt"
    save_checkpoint(path, QNet(hidden=16, layers=1), step=0, config={})
    main(["gen-bids", "--model", str(path), "--out", str(tmp_path / "d"), "--hands", "6", "--sim-deals", "2", "--workers", "1"])
    assert main(["train-bids", "--data", str(tmp_path / "d"), "--gold", str(tmp_path / "d"),
                 "--out", str(tmp_path / "run"), "--epochs", "2"]) == 0
    assert "Gold set" in capsys.readouterr().out
    net, meta = load_bidnet(tmp_path / "run" / "bidnet.pt")
    assert meta["train_hands"] == 6 and "mae_30" in meta["gold"]
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_bidnet.py tests/test_cli.py -q`, then `uv run pytest -q`.
Expected: all pass. If `test_training_learns_a_known_rule_and_round_trips` doesn't halve `mae_30` within 40 epochs, report the before and after numbers rather than loosening the bar.

- [ ] **Step 7: Commit**

```bash
git add ml/src/fortytwo_ml/bidding/model.py ml/src/fortytwo_ml/bidding/train.py ml/src/fortytwo_ml/cli.py ml/tests/test_bidnet.py ml/tests/test_cli.py
git commit -m "ml: BidNet predicts the P(make) table; train-bids with a gold-set report"
```

---

### Task 6: `FastBidder`, `FastAgent`, `fast:` everywhere, and the README

**Files:**
- Create: `ml/src/fortytwo_ml/agents/bid_support.py`, `ml/src/fortytwo_ml/agents/fast_bidder.py`
- Modify:
  - `ml/src/fortytwo_ml/agents/sim_bidder.py`, to use `BidPlans` and `bid_context`;
  - `ml/src/fortytwo_ml/eval/auction_runner.py`;
  - `ml/src/fortytwo_ml/cli.py`;
  - `ml/README.md`.
- Test: `ml/tests/test_fast_bidder.py`, `ml/tests/test_sim_bidder.py` (one test updated), `ml/tests/test_cli.py`

**Interfaces:**
- Consumes:
  - `options_from_table`, `BidTable` (Task 1);
  - `BidNet`, `load_bidnet` (Task 5);
  - `BidderSpec`, `parse_bidder`, `build_bidder` (Task 3);
  - `DEFAULT_MAKE_THRESHOLD`, `choose_bid`, `DecideConfig`, `BidContext`, `BidDecision`.
- Produces, in `fortytwo_ml.agents.bid_support`:
  - **`BidPlans`**, with:
    - `key(state, seat)` (static);
    - `record(state, seat, decision: BidDecision)`;
    - `current(state, seat) -> tuple[int, int | None, float | None] | None`;
    - `predicted_make(state, seat) -> float | None`.
  - **`bid_context(state, seat) -> BidContext`.**
- Produces, in `fortytwo_ml.agents.fast_bidder`:
  - **`FastBidder(bidnet, make_threshold=DEFAULT_MAKE_THRESHOLD, overbid_partner_threshold=0.9)`** with `bid`, `trump`, `reseed`, `play` (raises), `.plans`, `.last_decision` and `.decision_seconds`.
  - **`FastAgent(bidnet, play_model, name="fast", meta=None, **kw)`** with:
    - `from_files(bidnet_path, play_path=None, **kw)`, where `play_path` defaults to the meta's `play_path`;
    - `.meta`, plus `decision_seconds`, `last_decision`, `predicted_make` and `reseed`, delegated to the bidder.
  - **`play_checkpoint_mismatch(meta, model_path) -> str | None`.**
- `SimBidder` keeps its public behaviour. Its `_planned`, `_key` and `_plan_for` are replaced by `self.plans: BidPlans`.

- [ ] **Step 1: Write the failing tests**

Create `ml/tests/test_fast_bidder.py`:
```python
import random

import numpy as np
import torch

from conftest import deal_with
from fortytwo_ml.agents.base import run_hand
from fortytwo_ml.agents.bid_support import bid_context
from fortytwo_ml.agents.fast_bidder import FastAgent, FastBidder, play_checkpoint_mismatch
from fortytwo_ml.agents.heuristic_bot import best_suit
from fortytwo_ml.bidding.model import BidNet
from fortytwo_ml.engine.enums import PASS, PLUNGE, Suit
from fortytwo_ml.engine.hand_state import HandState, Phase
from fortytwo_ml.model import QNet, save_checkpoint
from fortytwo_ml.sim.decide import BidDecision, DecideConfig, choose_bid
from fortytwo_ml.sim.probe import BidTable, options_from_table


class StubNet:
    """A BidNet stand-in that predicts one fixed table."""

    def __init__(self, table):
        self._table = table

    def eval(self):
        return self

    def table(self, hand):
        return self._table


def _table(sixes_30=0.9):
    points = np.full((7, 12), 0.1)
    points[Suit.SIXES] = np.linspace(sixes_30, 0.2, 12)
    return BidTable(points, np.full(8, 0.1), np.full(3, 0.1), None)


def test_bids_what_choose_bid_picks_for_the_table():
    state = HandState.deal(list(range(28)), opener=0)
    table = _table()
    expected = choose_bid(options_from_table(table, state.legal_actions()), bid_context(state, 0), DecideConfig(0.6, 0.9))
    bidder = FastBidder(StubNet(table))
    assert bidder.bid(state, 0) == expected.bid != PASS
    assert bidder.last_decision == expected and len(bidder.decision_seconds) == 1


def test_names_the_planned_trump_for_its_winning_bid():
    bidder = FastBidder(StubNet(_table()))
    state = HandState.deal(list(range(28)), opener=0)
    bid = bidder.bid(state, 0)
    for b in (bid, PASS, PASS, PASS):
        state.apply(b)
    assert bidder.trump(state, 0) == Suit.SIXES and bidder.plans.predicted_make(state, 0) is not None


def test_plan_only_used_for_the_winning_bid():
    bidder = FastBidder(StubNet(_table()))
    state = HandState.deal(list(range(28)), opener=0)
    bidder.plans.record(state, 0, BidDecision(30, Suit.FIVES, 0.9, ()))
    for b in (30, 31, PASS, PASS):
        state.apply(b)
    assert bidder.plans.current(state, 0) is None


def test_trump_without_a_plan_uses_the_table_at_the_actual_bid():
    bidder = FastBidder(StubNet(_table()))
    state = HandState.deal(list(range(28)), opener=0)
    for b in (PASS, PASS, PASS, 30):  # seat 3 bids 30 without asking this bidder
        state.apply(b)
    assert bidder.trump(state, 3) == Suit.SIXES


def test_partner_plunge_trump_is_the_heuristic_suit():
    state = HandState.deal(deal_with({1: [(0, 0), (1, 1), (2, 2), (3, 3)]}), opener=0)
    for b in (PASS, PLUNGE, PASS, PASS):
        state.apply(b)
    assert FastBidder(StubNet(_table())).trump(state, 3) == best_suit(state.hand(3))[0]


def test_fast_agents_play_full_auctions_legally():
    torch.manual_seed(0)
    agent = FastAgent(BidNet(hidden=16, layers=1), QNet(hidden=16, layers=1))
    rng = random.Random(1)
    for _ in range(5):
        order = list(range(28))
        rng.shuffle(order)
        state = HandState.deal(order, rng.randrange(4))
        run_hand(state, [agent] * 4)
        assert state.phase is Phase.DONE
    assert len(agent.decision_seconds) >= 5


def test_play_checkpoint_mismatch(tmp_path):
    path = tmp_path / "run" / "m.pt"
    path.parent.mkdir()
    save_checkpoint(path, QNet(hidden=16, layers=1), step=7, config={})
    assert play_checkpoint_mismatch({"play_checkpoint": "run/m.pt", "play_step": 7}, str(path)) is None
    assert "step 3" in play_checkpoint_mismatch({"play_checkpoint": "run/m.pt", "play_step": 3}, str(path))
```

In `ml/tests/test_sim_bidder.py`, replace `test_trump_plan_only_used_for_the_winning_bid` with:
```python
def test_trump_plan_only_used_for_the_winning_bid():
    from fortytwo_ml.sim.decide import BidDecision

    bidder = SimBidder(tiny(), n_deals=4)
    state = HandState.deal(list(range(28)), opener=0)
    bidder.plans.record(state, 0, BidDecision(30, Suit.SIXES, 0.9, ()))
    for bid in (30, 31, PASS, PASS):  # seat 1 outbids; seat 0 never wins at 30
        state.apply(bid)
    assert state.bidder == 1
    assert bidder.plans.current(state, 0) is None
```

Append to `ml/tests/test_cli.py`:
```python
def _fast_files(tmp_path, play_step=0):
    from fortytwo_ml.bidding.model import BidNet, save_bidnet

    play = tmp_path / "run" / "m.pt"
    play.parent.mkdir(exist_ok=True)
    save_checkpoint(play, QNet(hidden=16, layers=1), step=0, config={})
    bidnet = tmp_path / "bidnet.pt"
    save_bidnet(bidnet, BidNet(hidden=16, layers=1), {"play_checkpoint": "run/m.pt", "play_path": str(play),
                                                      "play_step": play_step, "train_hands": 1, "val_loss": 0.0, "gold": {}})
    return play, bidnet


def test_load_agent_fast(tmp_path):
    from fortytwo_ml.agents.fast_bidder import FastAgent

    _, bidnet = _fast_files(tmp_path)
    assert isinstance(load_agent(f"fast:{bidnet}"), FastAgent)


def test_eval_bidding_fast_vs_sim(tmp_path, capsys):
    play, bidnet = _fast_files(tmp_path)
    assert main(["eval-bidding", "--model", str(play), "--a", f"fast:{bidnet}", "--b", "sim",
                 "--deals", "2", "--sim-deals", "4", "--workers", "2"]) == 0
    out = capsys.readouterr().out
    assert "A: fast" in out and "Bid decision time (A)" in out and "Bid decision time (B)" in out


def test_eval_bidding_warns_on_play_checkpoint_mismatch(tmp_path, capsys):
    play, bidnet = _fast_files(tmp_path, play_step=5)
    assert main(["eval-bidding", "--model", str(play), "--a", f"fast:{bidnet}", "--b", "heuristic",
                 "--deals", "1", "--workers", "1"]) == 0
    captured = capsys.readouterr()
    assert "warning" in captured.err and "Mean marks/deal" in captured.out


def test_play_demo_fast(tmp_path, capsys):
    _, bidnet = _fast_files(tmp_path)
    assert main(["play-demo", "--agent", f"fast:{bidnet}", "--seed", "3"]) == 0
    assert "top options" in capsys.readouterr().out
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_fast_bidder.py tests/test_sim_bidder.py tests/test_cli.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'fortytwo_ml.agents.bid_support'`.

- [ ] **Step 3: Implement `agents/bid_support.py`**

```python
"""What the simulation bidder and the fast bidder share: the bidding context for a decision, and
the plan (trump, P(make)) behind each bid, so trump naming and calibration can use it."""
from ..engine.enums import PASS, PLUNGE
from ..engine.hand_state import HandState, partner
from ..sim.decide import BidContext, BidDecision


def bid_context(state: HandState, seat: int) -> BidContext:
    return BidContext(
        legal=state.legal_actions(),
        partner_holds=state.bidder is not None and state.bidder == partner(seat),
        last_to_bid=all(state.bids[s] is not None for s in range(4) if s != seat),
    )


class BidPlans:
    def __init__(self) -> None:
        self._plans: dict[tuple, tuple[int, int | None, float | None]] = {}  # (seat, hand) -> (bid, trump, p_make)

    @staticmethod
    def key(state: HandState, seat: int) -> tuple:
        return seat, tuple(sorted(state.dealt[seat]))

    def record(self, state: HandState, seat: int, decision: BidDecision) -> None:
        if decision.bid != PASS:
            trump = None if decision.bid == PLUNGE else decision.trump  # a plunger's partner names trump
            self._plans[self.key(state, seat)] = (decision.bid, trump, decision.p_make)

    def current(self, state: HandState, seat: int) -> tuple[int, int | None, float | None] | None:
        """The plan behind this seat's bid, only if that bid is the winning one."""
        plan = self._plans.get(self.key(state, seat))
        return plan if plan is not None and state.bidder == seat and plan[0] == state.high_bid else None

    def predicted_make(self, state: HandState, seat: int) -> float | None:
        plan = self.current(state, seat)
        return plan[2] if plan else None
```

In `sim_bidder.py`, `SimBidder`:
- Replace `self._planned` with `self.plans = BidPlans()`.
- Delete `_key` and `_plan_for`.
- Have `predicted_make` return `self.plans.predicted_make(state, seat)`.
- In `bid`, build `ctx = bid_context(state, seat)` and replace the `if decision.bid != PASS:` block with `self.plans.record(state, seat, decision)`.
- In `trump`, use `plan = self.plans.current(state, seat)`.

- [ ] **Step 4: Implement `agents/fast_bidder.py`**

```python
"""Bidding in milliseconds: BidNet predicts the hand's P(make) table, and the same choose_bid rules
the simulation bidder uses decide from it."""
import time
from pathlib import Path

from ..engine.enums import PLUNGE
from ..engine.hand_state import HandState
from ..model import QNet, load_checkpoint
from ..bidding.data import checkpoint_label
from ..bidding.model import BidNet, load_bidnet
from ..sim.decide import DEFAULT_MAKE_THRESHOLD, BidDecision, DecideConfig, choose_bid
from ..sim.probe import options_from_table
from .bid_support import BidPlans, bid_context
from .heuristic_bot import best_suit
from .model_agent import ModelAgent


class FastBidder:
    name = "fast"

    def __init__(self, bidnet: BidNet, make_threshold: float = DEFAULT_MAKE_THRESHOLD,
                 overbid_partner_threshold: float = 0.9):
        self.bidnet = bidnet.eval()
        self.config = DecideConfig(make_threshold, overbid_partner_threshold)
        self.plans = BidPlans()
        self.last_decision: BidDecision | None = None
        self.decision_seconds: list[float] = []

    def reseed(self, key: str) -> None:
        """Deterministic already; here so the arena can treat every bidder alike."""

    def bid(self, state: HandState, seat: int) -> int:
        start = time.perf_counter()
        options = options_from_table(self.bidnet.table(state.hand(seat)), state.legal_actions())
        decision = choose_bid(options, bid_context(state, seat), self.config)
        self.decision_seconds.append(time.perf_counter() - start)
        self.last_decision = decision
        self.plans.record(state, seat, decision)
        return decision.bid

    def trump(self, state: HandState, seat: int) -> int:
        legal = state.legal_actions()
        if state.high_bid == PLUNGE and state.bidder != seat:
            return best_suit(state.hand(seat))[0]  # partner's plunge: rare, so the heuristic suit
        plan = self.plans.current(state, seat)
        if plan is not None and plan[1] in legal:
            return plan[1]
        at_bid = [o for o in options_from_table(self.bidnet.table(state.hand(seat)), [state.high_bid]) if o.trump in legal]
        return max(at_bid, key=lambda o: o.p_make).trump if at_bid else legal[0]

    def play(self, state: HandState, seat: int) -> int:
        raise NotImplementedError("FastBidder only bids and names trump; use FastAgent to play")


class FastAgent:
    """A complete bot: BidNet bidding and trump, Stage 1 model play."""

    def __init__(self, bidnet: BidNet, play_model: QNet, name: str = "fast", meta: dict | None = None, **kwargs):
        self.name = name
        self.meta = meta or {}
        self.bidder = FastBidder(bidnet, **kwargs)
        self.player = ModelAgent(play_model)

    @classmethod
    def from_files(cls, bidnet_path: str | Path, play_path: str | None = None, **kwargs) -> "FastAgent":
        bidnet, meta = load_bidnet(bidnet_path)
        play_path = play_path or meta["play_path"]
        if not Path(play_path).is_file():
            raise FileNotFoundError(f"no play checkpoint at {play_path} (recorded in {bidnet_path})")
        play_model, _ = load_checkpoint(play_path)
        return cls(bidnet, play_model, name=f"fast:{Path(bidnet_path).parent.name}", meta=meta, **kwargs)

    def bid(self, state: HandState, seat: int) -> int:
        return self.bidder.bid(state, seat)

    def trump(self, state: HandState, seat: int) -> int:
        return self.bidder.trump(state, seat)

    def play(self, state: HandState, seat: int) -> int:
        return self.player.play(state, seat)

    def reseed(self, key: str) -> None:
        self.bidder.reseed(key)

    @property
    def decision_seconds(self) -> list[float]:
        return self.bidder.decision_seconds

    @property
    def last_decision(self) -> BidDecision | None:
        return self.bidder.last_decision

    def predicted_make(self, state: HandState, seat: int) -> float | None:
        return self.bidder.plans.predicted_make(state, seat)


def play_checkpoint_mismatch(meta: dict, model_path: str) -> str | None:
    """A warning when a bidnet's training data came from a different play model than `model_path`."""
    _, info = load_checkpoint(model_path)
    here = (checkpoint_label(model_path), info["step"])
    there = (meta.get("play_checkpoint"), meta.get("play_step"))
    if here == there:
        return None
    return (f"warning: this bidnet was trained on simulations by {there[0]} (step {there[1]}), "
            f"but the play model is {here[0]} (step {here[1]}); the comparison still isolates bidding")
```

- [ ] **Step 5: `fast:` in the runner and the CLI**

`eval/auction_runner.py`:
- In `parse_bidder`, before the `raise`, add:
```python
    if text.startswith("fast:"):
        path = text[len("fast:"):]
        if not Path(path).is_file():
            raise FileNotFoundError(f"no bidnet at {path}")
        return BidderSpec("fast", model, path, sim_deals, make_threshold, seed)
```
  and change the error message to `"use heuristic, sim or fast:<bidnet.pt>"`.
- In `build_bidder`, add before the final `raise`:
```python
    if spec.kind == "fast":
        return FastAgent.from_files(spec.bidnet, play_path=spec.model, make_threshold=spec.make_threshold)
```
  importing `FastAgent` from `..agents.fast_bidder`.

`cli.py`:
- **`load_agent`:** before the file check, add:
```python
    if spec.startswith("fast:"):
        path = spec[len("fast:"):]
        if not Path(path).is_file():
            raise FileNotFoundError(f"no bidnet at {path}")
        return FastAgent.from_files(path)
```
- **`--a` and `--b` help:** both read `"heuristic | sim | fast:<bidnet.pt>"`.
- **The `eval-bidding` branch:** after parsing the specs, add the following, with `import sys` at the top of `cli.py`:
```python
        for spec in (a_spec, b_spec):
            if spec.kind == "fast":
                warning = play_checkpoint_mismatch(load_bidnet(spec.bidnet)[1], args.model)
                if warning:
                    print(warning, file=sys.stderr)
```
- **Imports:** `FastAgent` and `play_checkpoint_mismatch` from `.agents.fast_bidder`, and `load_bidnet` from `.bidding.model`.
- **`_play_demo`:** change `isinstance(agent, SimAgent)` to `isinstance(agent, (SimAgent, FastAgent))`, and the `_auction_demo` parameter type to `SimAgent | FastAgent`.
- **Docstring:** list `fast:` agents.

- [ ] **Step 6: README**

Add a section to `ml/README.md` after the Stage 2 section:
````markdown
## Stage 3: a fast bidding model

The simulation bidder is too slow to ship (about 6 s per bid). Stage 3 teaches a small network,
BidNet, to predict the same P(make) table from the hand alone, then bids from it with the same
rules and threshold. Every P(make) the simulation bidder estimates depends only on its own seven
dominoes, so the training data is just simulated hands, with no auctions.

```sh
# Training data: about 7 h with 7 workers. Rerunning resumes; a new --seed adds hands.
uv run ml gen-bids --model runs/stage1-c/ckpt-latest.pt --out data/bids --hands 100000 --sim-deals 50 --seed 1
# A small low-noise "gold" set for measuring the model (about 30 min).
uv run ml gen-bids --model runs/stage1-c/ckpt-latest.pt --out data/bids-gold --hands 2000 --sim-deals 400 --seed 99
uv run ml train-bids --data data/bids --gold data/bids-gold --out runs/bidnet-1
```

`train-bids` prints each epoch's loss. It ends with the gold-set error at the bids that matter and a
calibration table.

Then check it against both bidders, with the same play model on both sides:

```sh
uv run ml eval-bidding --model runs/stage1-c/ckpt-latest.pt --a fast:runs/bidnet-1/bidnet.pt --b heuristic --deals 1000
uv run ml eval-bidding --model runs/stage1-c/ckpt-latest.pt --a fast:runs/bidnet-1/bidnet.pt --b sim --deals 1000
uv run ml play-demo --agent fast:runs/bidnet-1/bidnet.pt --seed 3
```

Stage 3 passes if:
- against `heuristic`, A's 95% CI is above 0;
- against `sim`, A's CI lower bound is above −0.1;
- the fast bid decision's p95 is under 10 ms.

`eval-bidding` runs on 7 worker processes by default (`--workers`). Results are identical for any
worker count. A 1,000-deal run with a `sim` side now takes about an hour.
````
In the Stage 2 section, replace the runtime paragraph's "1,000 deals take about 6.5 h" sentence with "1,000 deals took about 6.5 h single-process; with the default 7 workers (`--workers`) it's about an hour."

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_fast_bidder.py tests/test_sim_bidder.py tests/test_cli.py -q`, then `uv run pytest -q`.
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add ml/src/fortytwo_ml/agents ml/src/fortytwo_ml/eval/auction_runner.py ml/src/fortytwo_ml/cli.py ml/README.md ml/tests/test_fast_bidder.py ml/tests/test_sim_bidder.py ml/tests/test_cli.py
git commit -m "ml: FastBidder bids from BidNet's table; fast: agents in eval-bidding and play-demo"
```

---

### Task 7: The runs (manual, on the dev box)

Not code. The user runs these once Task 6 has landed. Everything runs from `ml/`.

- [ ] `uv run ml gen-bids --model runs/stage1-c/ckpt-latest.pt --out data/bids --hands 100000 --sim-deals 50 --seed 1` (overnight).
- [ ] `uv run ml gen-bids --model runs/stage1-c/ckpt-latest.pt --out data/bids-gold --hands 2000 --sim-deals 400 --seed 99`.
- [ ] `uv run ml train-bids --data data/bids --gold data/bids-gold --out runs/bidnet-1`.
- [ ] The Stage 3 bar: `eval-bidding --a fast:runs/bidnet-1/bidnet.pt --b heuristic --deals 1000`, then `--b sim`.
- [ ] The threshold retest: `eval-bidding --deals 1000 --seed 2 --make-threshold 0.6`, then `0.7`.
