# ML Bots Stage 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix plunge and Low training data, then build a bidder that decides bids and trump by simulating many deals with the Stage 1 play model. Plus an eval that isolates bidding quality.

**Architecture:**
- `ContractSampler.sample_hand()` picks the deal and contract together, so plunge hands always qualify and Low goes to the hand best able to lose every trick.
- `sim/` adds:
  - a play-to-the-end engine mode;
  - `deal_unseen`, which deals the unseen dominoes;
  - `rollout`, which plays thousands of deals in lockstep with one batched model call per step.
- `sim/decide.py` holds the pure `choose_bid` rules.
- `agents/sim_bidder.py` estimates each option's P(make) from rollouts, chooses, and remembers the trump that justified its bid.
- `eval/arena.py` gains `evaluate_auctions`: full auctions on duplicate deals, with a calibration table.

**Tech Stack:** Python 3.12, PyTorch, numpy, pytest, uv. This is the existing `ml/` project.

**Spec:** `docs/superpowers/specs/2026-10-01-ml-bots-stage2-design.md`

## Global Constraints

- All commands run from `ml/` as `uv run ...`. No test may need a GPU; tests use CPU and tiny models (`QNet(hidden=16, layers=1)`).
- The engine's default behavior and the TS parity test are unchanged. `play_to_end` defaults to `False`.
- **Plunge sampling:**
  - The sampler reshuffles at most 100 times for a plunge deal, then falls back to the heuristic contract.
  - A plunger needs ≥ 4 doubles.
- **Low choice risk per domino:**
  - **`LOW`:** high pip, plus 3 for a double.
  - **`LOW_DOUBLES_LOW`:** high pip, and doubles count 0.
  - **`LOW_DOUBLES_OWN_SUIT`:** pip for doubles, high pip for everything else.
  - Pick the lowest total. Ties go to the lowest seat, then to the variant order `LOW`, `LOW_DOUBLES_LOW`, `LOW_DOUBLES_OWN_SUIT`. The bid is 42.
- `configs/stage1-plunge.yaml` is `stage1.yaml` with:
  - mix heuristic 0.65, marks 0.08, follow_me 0.07, low 0.10, plunge 0.10;
  - `total_steps: 230000`.
- **`deal_unseen`:** keeps the given hand in its seat. `require=(seat, min_doubles)` is enforced by reshuffling, with a cap of 1000 tries, then `ValueError`.
- **Simulation defaults:**
  - `n_deals = 200`, `make_threshold = 0.5`, `overbid_partner_threshold = 0.9`.
  - EV = `marks_for(bid) × (2·P(make) − 1)`. A "marks bid" is a bid ≥ 84 (plunge included).
- **Option probes:**
  - points bids 30–41: suits played at 30, with P(make b) = P(bidder team points ≥ b);
  - bids ≥ 42 except plunge: suits + follow-me played at 42, with P = P(points == 42), plus the 3 Low variants played at 42, with P = P(bidders took no trick);
  - plunge: played at 169 with the partner's heuristic best suit, with P = P(points == 42).
- **Trump naming:**
  - Reuse the trump recorded with this seat's winning bid, if its bid equals the current high bid and the trump is legal.
  - Otherwise simulate the legal trumps at the actual bid.
  - For a partner's plunge, simulate with `require=(plunger, 4)`.
- **Stage 2 bar:**
  - 1,000 duplicate deals at N = 200, with A's marks/deal > 0 and the 95% CI excluding 0. A = `SimAgent`, B = `ModelAgent` on the same checkpoint.
  - p95 bid decision ≤ 30 s on the dev box.

## Review Focus

1. **Rollout bookkeeping:** a batched rollout must apply each hand's own argmax. An off-by-one in the row spans would silently cross-wire hands. Pinned in Task 3 (`test_batched_rollout_matches_one_at_a_time_play`).
2. **Low under play-to-end:** the partner still sits out, tricks stay 3 dominoes, and play continues to 7 tricks after the bidders take a trick. Pinned in Task 2 (`test_play_to_end_low_keeps_three_domino_tricks`).
3. **Plunge trump for a partner:** simulated deals must give the plunger ≥ 4 doubles, or `from_contract` raises. Pinned in Task 5 (`test_partner_plunge_trump_uses_constrained_deals`).
4. **Stale trump plans:** a remembered trump whose bid isn't the current high bid must not be reused. Pinned in Task 5 (`test_trump_plan_only_used_for_the_winning_bid`).
5. **`choose_bid` with no options for some legal bids** (marks rungs the probes don't cover, or forced with only the 30 option) must still return a legal bid. Pinned in Task 4 (`test_forced_with_only_thirty_options`).

---

### Task 1: Sampler picks deal and contract together; realistic Low; plunge fine-tune config; `ml eval --kind`

**Files:**
- Modify: `ml/src/fortytwo_ml/contracts.py`, `ml/src/fortytwo_ml/train/selfplay.py`, `ml/src/fortytwo_ml/eval/arena.py`, `ml/src/fortytwo_ml/eval/diagnostics.py`, `ml/src/fortytwo_ml/cli.py`
- Create: `ml/configs/stage1-plunge.yaml`
- Test: `ml/tests/test_contracts.py`, `ml/tests/test_cli.py`

**Interfaces:**
- Produces:
  - `ContractSampler.sample_hand() -> tuple[list[int], int, Contract]` (deal order, opener, contract), drawn from the sampler's own rng.
  - `contracts.low_risk(hand: Sequence[int], variant: int) -> int` and `contracts.best_low(hands: Sequence[Sequence[int]]) -> tuple[int, int]` (seat, variant).
  - `ml eval --kind plunge|low`.
- `ContractSampler.sample(deal, opener)` stays, using the new Low rule, for existing callers and tests.

- [ ] **Step 1: Write the failing tests**

Append to `ml/tests/test_contracts.py`:
```python
from fortytwo_ml.contracts import best_low, low_risk
from fortytwo_ml.engine.dominoes import doubles_in, index_of, to_mask


def test_low_risk_by_variant():
    hand = [index_of(0, 0), index_of(1, 2), index_of(6, 6)]
    assert low_risk(hand, Suit.LOW) == (0 + 3) + 2 + (6 + 3)
    assert low_risk(hand, Suit.LOW_DOUBLES_LOW) == 0 + 2 + 0
    assert low_risk(hand, Suit.LOW_DOUBLES_OWN_SUIT) == 0 + 2 + 6


def test_best_low_picks_the_safest_seat_and_variant():
    def pips(*ps):
        return [index_of(a, b) for a, b in ps]
    hands = [
        pips((6, 6), (5, 6), (4, 6), (3, 6), (2, 6), (1, 6), (0, 6)),
        pips((0, 0), (1, 1), (2, 2), (0, 1), (0, 2), (1, 2), (0, 3)),  # low, doubles-heavy
        pips((5, 5), (4, 5), (3, 5), (2, 5), (1, 5), (0, 5), (4, 4)),
        pips((3, 3), (3, 4), (2, 4), (1, 4), (0, 4), (2, 3), (1, 3)),
    ]
    assert best_low(hands) == (1, Suit.LOW_DOUBLES_LOW)


def test_sample_hand_plunge_always_has_a_four_double_plunger():
    sampler = ContractSampler({"plunge": 1.0}, random.Random(5))
    plunges = 0
    for _ in range(200):
        order, opener, c = sampler.sample_hand()
        HandState.from_contract(order, c.bidder, c.bid, c.trump)
        if contract_kind(c) == "plunge":
            plunges += 1
            assert doubles_in(to_mask(order[c.bidder * 7:(c.bidder + 1) * 7])) >= 4
    assert plunges >= 195  # the 100-try cap almost never runs out


def test_sample_hand_low_goes_to_the_best_low_hand():
    sampler = ContractSampler({"low": 1.0}, random.Random(6))
    for _ in range(50):
        order, _, c = sampler.sample_hand()
        hands = [order[p * 7:(p + 1) * 7] for p in range(4)]
        assert (c.bidder, c.trump) == best_low(hands) and c.bid == 42


def test_sample_hand_is_deterministic_for_a_seed():
    a = [ContractSampler(DEFAULT_MIX, random.Random(9)).sample_hand() for _ in range(1)]
    b = [ContractSampler(DEFAULT_MIX, random.Random(9)).sample_hand() for _ in range(1)]
    assert a == b
```

Append to `ml/tests/test_cli.py`:
```python
def test_eval_kind_restricts_the_contracts(capsys):
    assert main(["eval", "--a", "heuristic", "--b", "dumb", "--deals", "10", "--kind", "low"]) == 0
    out = capsys.readouterr().out
    assert "  low " in out and "  points " not in out
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_contracts.py tests/test_cli.py -q`
Expected: FAIL with `ImportError: cannot import name 'best_low'` (then argparse rejecting `--kind`).

- [ ] **Step 3: Implement in `contracts.py`**

Add `from .engine.dominoes import PIPS, doubles_in, to_mask` (extend the existing import). Add these helpers above `ContractSampler`:
```python
_PLUNGE_TRIES = 100


def low_risk(hand: Sequence[int], variant: int) -> int:
    """How likely `hand` is to catch a trick under a Low variant: lower is safer."""
    total = 0
    for d in hand:
        lo, hi = PIPS[d]
        if lo != hi:
            total += hi
        elif variant == Suit.LOW:
            total += hi + 3  # doubles are the top of their suit
        elif variant == Suit.LOW_DOUBLES_OWN_SUIT:
            total += hi  # doubles are their own suit, ranked by pip
        # LOW_DOUBLES_LOW: doubles rank lowest, so they're safe
    return total


def best_low(hands: Sequence[Sequence[int]]) -> tuple[int, int]:
    """The (seat, Low variant) whose hand is best placed to lose every trick."""
    return min(
        ((seat, variant) for seat in range(4) for variant in LOW_TRUMPS),
        key=lambda sv: (low_risk(hands[sv[0]], sv[1]), sv[0], LOW_TRUMPS.index(sv[1])),
    )
```

In `ContractSampler`, add `sample_hand` and `_deal`, and change the Low branch of `_forced`:
```python
    def sample_hand(self) -> tuple[list[int], int, Contract]:
        """A deal, its opener and its contract, chosen together so forced kinds are realistic:
        a plunge deal always gives some seat four doubles."""
        kind = self._rng.choices(self._kinds, self._weights)[0]
        for _ in range(_PLUNGE_TRIES if kind == "plunge" else 1):
            order, opener = self._deal()
            forced = self._forced(kind, order)
            if forced is not None:
                return order, opener, forced
        return order, opener, self._heuristic(order, opener)

    def _deal(self) -> tuple[list[int], int]:
        order = list(range(28))
        self._rng.shuffle(order)
        return order, self._rng.randrange(4)
```
```python
        if kind == "low":
            seat, variant = best_low(hands)
            return Contract(seat, 42, variant)
```

- [ ] **Step 4: Switch the callers to `sample_hand`**

- `ml/src/fortytwo_ml/train/selfplay.py`: replace the three lines that shuffle `order`, call `sampler.sample(...)` and build `state` with:
```python
    order, _, contract = sampler.sample_hand()
    state = HandState.from_contract(order, contract.bidder, contract.bid, contract.trump)
```
- `ml/src/fortytwo_ml/eval/arena.py` (`evaluate_hands`): replace the `order`/`shuffle`/`contract = ...sample(...)` lines with:
```python
        order, _, contract = ContractSampler(mix or DEFAULT_MIX, rng).sample_hand()
```
- `ml/src/fortytwo_ml/eval/diagnostics.py` (`build_decision_set`): replace the `order`/`shuffle`/`contract = sampler.sample(...)` lines with:
```python
        order, _, contract = sampler.sample_hand()
```
- `ml/src/fortytwo_ml/cli.py` (`_play_demo`): replace the `order`/`shuffle`/`contract` lines with:
```python
    order, _, contract = ContractSampler(DEFAULT_MIX, rng).sample_hand()
```

- [ ] **Step 5: Add `ml eval --kind`**

In `cli.py`, add to the `eval` parser:
```python
    e.add_argument("--kind", choices=["plunge", "low"], help="only evaluate this contract type")
```
In the `eval` branch, change the call to:
```python
        hands = evaluate_hands(a, b, args.deals, seed=args.seed, mix={args.kind: 1.0} if args.kind else None)
```

- [ ] **Step 6: Add the fine-tune config**

Create `ml/configs/stage1-plunge.yaml` as a copy of `ml/configs/stage1.yaml` with these changes:
- `total_steps: 230000`, commented `# resume from stage1-b (step 200000) and add 30k steps`;
- the `contract_mix` block becoming `heuristic: 0.65`, `marks: 0.08`, `follow_me: 0.07`, `low: 0.1`, `plunge: 0.1`;
- a header comment: `# Stage 2 prep: fine-tune stage1-b with realistic, more frequent plunge and Low hands.`

In `ml/tests/test_train_parts.py`, append:
```python
def test_plunge_finetune_config_loads():
    cfg = TrainConfig.from_yaml(CONFIGS / "stage1-plunge.yaml")
    assert cfg.total_steps == 230_000 and cfg.contract_mix["plunge"] == 0.1 and cfg.contract_mix["heuristic"] == 0.65
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd ml && uv run pytest -q`
Expected: all pass. The parity, eval, diagnostics and smoke-training tests all exercise the new sampler path.

- [ ] **Step 8: Commit**

```bash
git add ml/src/fortytwo_ml ml/configs/stage1-plunge.yaml ml/tests
git commit -m "ml: sampler deals realistic plunge and Low hands; plunge fine-tune config; eval --kind"
```

---

### Task 2: Play-to-the-end engine mode and `deal_unseen`

**Files:**
- Modify: `ml/src/fortytwo_ml/engine/hand_state.py`
- Create: `ml/src/fortytwo_ml/sim/__init__.py` (empty), `ml/src/fortytwo_ml/sim/deal.py`
- Test: `ml/tests/test_hand_state.py`, `ml/tests/test_sim_deal.py`

**Interfaces:**
- Produces:
  - `HandState.from_contract(deal_order, bidder, bid, trump, play_to_end: bool = False)`. With `play_to_end`:
    - `result` is set when the hand is decided, with the points at that moment;
    - `phase` becomes `DONE` only after 7 tricks;
    - `points` keeps accumulating.
  - `sim.deal.deal_unseen(seat: int, hand: Sequence[int], rng: random.Random, require: tuple[int, int] | None = None, max_tries: int = 1000) -> list[int]`.

- [ ] **Step 1: Write the failing tests**

Append to `ml/tests/test_hand_state.py`:
```python
def _play_seeded(state, rng):
    while state.phase is not Phase.DONE:
        state.apply(rng.choice(state.legal_actions()))
    return state


def test_play_to_end_keeps_the_official_result_and_plays_seven_tricks():
    rng = random.Random(11)
    for _ in range(200):
        order = list(range(28))
        rng.shuffle(order)
        bidder, trump = rng.randrange(4), rng.choice([0, 1, 2, 3, 4, 5, 6])
        seed = rng.random()
        normal = _play_seeded(HandState.from_contract(order, bidder, 30, trump), random.Random(seed))
        full = _play_seeded(HandState.from_contract(order, bidder, 30, trump, play_to_end=True), random.Random(seed))
        assert full.result == normal.result
        assert len(full.tricks) == 7 and sum(full.points) == 42


def test_play_to_end_low_keeps_three_domino_tricks():
    state = HandState.from_contract(DEAL, bidder=0, bid=42, trump=Suit.LOW, play_to_end=True)
    state.apply(d("6/6"))  # nothing beats the double six on a sixes lead, so the bidder takes trick one
    _play_seeded(state, random.Random(2))
    assert state.result.winning_team == 1  # decided (Low failed) after trick one...
    assert len(state.tricks) == 7 and all(len(t.plays) == 3 for t in state.tricks)  # ...but played on
    assert all(seat != 2 for t in state.tricks for seat, _ in t.plays)  # partner still sits out
```

Create `ml/tests/test_sim_deal.py`:
```python
import random

import pytest

from fortytwo_ml.engine.dominoes import doubles_in, to_mask
from fortytwo_ml.sim.deal import deal_unseen

HAND = [0, 5, 9, 13, 20, 24, 27]


def test_keeps_the_hand_and_deals_a_permutation():
    rng = random.Random(1)
    for seat in range(4):
        order = deal_unseen(seat, HAND, rng)
        assert sorted(order) == list(range(28)) and order[seat * 7:(seat + 1) * 7] == HAND


def test_deals_differ_and_are_seeded():
    a = deal_unseen(0, HAND, random.Random(3))
    b = deal_unseen(0, HAND, random.Random(3))
    c = deal_unseen(0, HAND, random.Random(4))
    assert a == b and a != c


def test_require_gives_a_seat_enough_doubles():
    rng = random.Random(5)
    for _ in range(50):
        order = deal_unseen(0, HAND, rng, require=(2, 4))
        assert doubles_in(to_mask(order[14:21])) >= 4


def test_impossible_requirement_raises():
    hand_with_all_doubles = [0, 7, 13, 18, 22, 25, 27]  # 0/0 1/1 2/2 3/3 4/4 5/5 6/6
    with pytest.raises(ValueError):
        deal_unseen(0, hand_with_all_doubles, random.Random(0), require=(1, 1), max_tries=20)


def test_rejects_a_hand_that_is_not_seven_dominoes():
    with pytest.raises(ValueError):
        deal_unseen(0, HAND[:6], random.Random(0))
```
Before relying on the ids in `hand_with_all_doubles`, check them against `PIPS`. The doubles are indices `[0, 7, 13, 18, 22, 25, 27]` in generation order.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_hand_state.py tests/test_sim_deal.py -q`
Expected: FAIL with `TypeError: from_contract() got an unexpected keyword argument 'play_to_end'` and `ModuleNotFoundError: fortytwo_ml.sim`.

- [ ] **Step 3: Implement play-to-end**

In `hand_state.py`:
- Add `play_to_end: bool` to the class attribute annotations.
- In `deal()`, set `s.play_to_end = False`.
- Change `from_contract`'s signature to `(cls, deal_order, bidder, bid, trump, play_to_end: bool = False)` and set `s.play_to_end = play_to_end` before returning.
- Replace `_check_decided` with:

```python
    def _check_decided(self) -> None:
        if self.result is None:
            winner = self._decided_winner()
            if winner is not None:
                self.result = HandResult(winner, marks_for(self.high_bid), (self.points[0], self.points[1]))
        # Normally a decided hand stops; in play-to-end mode (simulations) it runs all 7 tricks.
        if self.result is not None and (not self.play_to_end or len(self.tricks) == 7):
            self.phase = Phase.DONE

    def _decided_winner(self) -> int | None:
        bidders = team_of(self.bidder)
        others = 1 - bidders
        if is_low(self.trump):
            # The bidders must lose every trick.
            if any(team_of(t.winner) == bidders for t in self.tricks):
                return others
            return bidders if len(self.tricks) == 7 else None
        target = target_points(self.high_bid)
        if self.points[bidders] >= target:
            return bidders
        if self.points[others] > 42 - target:
            return others
        return None
```

- [ ] **Step 4: Implement `sim/deal.py`**

```python
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ml && uv run pytest -q`
Expected: all pass. The parity test (`test_parity.py`) confirms the default engine path is unchanged.

- [ ] **Step 6: Commit**

```bash
git add ml/src/fortytwo_ml/engine/hand_state.py ml/src/fortytwo_ml/sim ml/tests/test_hand_state.py ml/tests/test_sim_deal.py
git commit -m "ml: play-to-end engine mode for simulations; deal_unseen"
```

---

### Task 3: Batched rollouts

**Files:**
- Create: `ml/src/fortytwo_ml/sim/rollout.py`
- Test: `ml/tests/test_sim_rollout.py`

**Interfaces:**
- Consumes: `HandState.from_contract(..., play_to_end=True)` (Task 2), `encode_actions`, `QNet`, `Contract`, `team_of`.
- Produces:
  - `RolloutResult(bidder_points: np.ndarray[int], bidder_took_trick: np.ndarray[bool], bidders_won: np.ndarray[bool])`, one entry per job in order;
  - `rollout(model: QNet, jobs: Sequence[tuple[Sequence[int], Contract]], device: torch.device | str | None = None) -> RolloutResult`.

- [ ] **Step 1: Write the failing tests**

`ml/tests/test_sim_rollout.py`:
```python
import random

import numpy as np
import torch

from fortytwo_ml.agents.base import run_hand
from fortytwo_ml.agents.model_agent import ModelAgent
from fortytwo_ml.contracts import DEFAULT_MIX, ContractSampler
from fortytwo_ml.engine.hand_state import HandState, team_of
from fortytwo_ml.model import QNet
from fortytwo_ml.sim.rollout import rollout


def _jobs(n, seed=0):
    sampler = ContractSampler(DEFAULT_MIX, random.Random(seed))
    return [(order, contract) for order, _, contract in (sampler.sample_hand() for _ in range(n))]


def test_batched_rollout_matches_one_at_a_time_play():
    torch.manual_seed(0)
    model = QNet(hidden=16, layers=1).eval()
    jobs = _jobs(40)
    result = rollout(model, jobs)
    agent = ModelAgent(model)
    for i, (order, c) in enumerate(jobs):
        state = HandState.from_contract(order, c.bidder, c.bid, c.trump, play_to_end=True)
        run_hand(state, [agent] * 4)
        bidders = team_of(c.bidder)
        assert result.bidder_points[i] == state.points[bidders]
        assert result.bidders_won[i] == (state.result.winning_team == bidders)
        assert result.bidder_took_trick[i] == any(team_of(t.winner) == bidders for t in state.tricks)


def test_rollout_shapes_and_empty_jobs():
    model = QNet(hidden=16, layers=1).eval()
    result = rollout(model, _jobs(5))
    assert result.bidder_points.shape == (5,) and result.bidders_won.dtype == bool
    empty = rollout(model, [])
    assert empty.bidder_points.shape == (0,)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_sim_rollout.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'fortytwo_ml.sim.rollout'`.

- [ ] **Step 3: Implement**

`ml/src/fortytwo_ml/sim/rollout.py`:
```python
"""Play many deals out at once with the play model: every step, one batched forward pass scores
the candidate dominoes of every unfinished hand, and each hand plays its best one (greedy, all
four seats, no exploration). Hands play to the end so one rollout answers every bid level."""
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import torch

from ..engine.hand_state import Contract, HandState, Phase, team_of
from ..features import encode_actions
from ..model import QNet


@dataclass(frozen=True)
class RolloutResult:
    bidder_points: np.ndarray      # bidding team's points after all 7 tricks
    bidder_took_trick: np.ndarray  # whether the bidding team won any trick (Low fails if so)
    bidders_won: np.ndarray        # the official result at the contract's bid


def rollout(
    model: QNet, jobs: Sequence[tuple[Sequence[int], Contract]], device: torch.device | str | None = None
) -> RolloutResult:
    device = torch.device(device) if device is not None else next(model.parameters()).device
    states = [HandState.from_contract(order, c.bidder, c.bid, c.trump, play_to_end=True) for order, c in jobs]
    active = list(range(len(states)))
    with torch.no_grad():
        while active:
            rows, legals = [], []
            for i in active:
                state = states[i]
                legal = state.legal_actions()
                legals.append(legal)
                rows.append(encode_actions(state, state.to_act, legal))
            q = model(torch.from_numpy(np.concatenate(rows)).to(device)).float().cpu().numpy()
            start = 0
            for i, legal in zip(active, legals):
                end = start + len(legal)
                states[i].apply(legal[int(np.argmax(q[start:end]))])
                start = end
            active = [i for i in active if states[i].phase is not Phase.DONE]

    bidders = [team_of(c.bidder) for _, c in jobs]
    return RolloutResult(
        np.array([s.points[t] for s, t in zip(states, bidders)], dtype=np.int64),
        np.array([any(team_of(tr.winner) == t for tr in s.tricks) for s, t in zip(states, bidders)], dtype=bool),
        np.array([s.result.winning_team == t for s, t in zip(states, bidders)], dtype=bool),
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_sim_rollout.py -q`, then `uv run pytest -q`.
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add ml/src/fortytwo_ml/sim/rollout.py ml/tests/test_sim_rollout.py
git commit -m "ml: batched lockstep rollouts with the play model"
```

---

### Task 4: `choose_bid` (pure bidding rules)

**Files:**
- Create: `ml/src/fortytwo_ml/sim/decide.py`
- Test: `ml/tests/test_sim_decide.py`

**Interfaces:**
- Produces:
  - `Option(bid: int, trump: int, p_make: float)` (frozen), with a property `ev = marks_for(bid) * (2 * p_make - 1)`;
  - `BidContext(legal: Sequence[int], partner_holds: bool, last_to_bid: bool)` (frozen), with a property `forced = PASS not in legal`;
  - `DecideConfig(make_threshold: float = 0.5, overbid_partner_threshold: float = 0.9)`;
  - `BidDecision(bid: int, trump: int | None, p_make: float | None, options: tuple[Option, ...])`;
  - `choose_bid(options, ctx, cfg=DecideConfig()) -> BidDecision`.

- [ ] **Step 1: Write the failing tests**

`ml/tests/test_sim_decide.py`:
```python
from fortytwo_ml.engine.enums import PASS, PLUNGE, Suit
from fortytwo_ml.sim.decide import BidContext, DecideConfig, Option, choose_bid

OPEN = [PASS, *range(30, 43), 84]


def table(**p_by_bid):
    """Options with trump SIXES for bids given as b30=0.8 etc., plus a worse FIVES option."""
    out = []
    for key, p in p_by_bid.items():
        bid = int(key[1:])
        out += [Option(bid, Suit.SIXES, p), Option(bid, Suit.FIVES, p - 0.2)]
    return out


def test_highest_makeable_bid_with_its_best_trump():
    d = choose_bid(table(b30=0.9, b34=0.7, b36=0.55, b38=0.4), BidContext(OPEN, False, False))
    assert (d.bid, d.trump, d.p_make) == (36, Suit.SIXES, 0.55)


def test_pass_when_nothing_is_makeable():
    d = choose_bid(table(b30=0.45, b31=0.3), BidContext(OPEN, False, False))
    assert d.bid == PASS and d.trump is None


def test_last_to_bid_takes_the_lowest_makeable_bid():
    legal = [PASS, *range(32, 43), 84]
    d = choose_bid(table(b32=0.9, b36=0.7, b40=0.6), BidContext(legal, False, True))
    assert d.bid == 32


def test_last_to_bid_prefers_a_marks_bid_with_higher_ev():
    legal = [PASS, *range(32, 43), 84]
    d = choose_bid(table(b32=0.6, b84=0.95), BidContext(legal, False, True))
    assert d.bid == 84  # EV 2*(0.9) = 1.8 > 0.2


def test_forced_bids_thirty_when_nothing_is_makeable():
    forced = [*range(30, 43), 84]
    d = choose_bid(table(b30=0.3, b35=0.1), BidContext(forced, False, True))
    assert d.bid == 30 and d.trump == Suit.SIXES


def test_forced_with_only_thirty_options():
    forced = [*range(30, 43), 84]
    d = choose_bid([Option(30, Suit.ACES, 0.2)], BidContext(forced, False, True))
    assert (d.bid, d.trump) == (30, Suit.ACES)


def test_partner_holds_passes_unless_a_higher_bid_is_near_certain():
    legal = [PASS, *range(31, 43), 84]
    assert choose_bid(table(b31=0.8, b35=0.7), BidContext(legal, True, False)).bid == PASS
    d = choose_bid(table(b31=0.95, b35=0.92, b38=0.6), BidContext(legal, True, False))
    assert d.bid == 35  # highest bid with P >= 0.9


def test_thresholds_are_configurable():
    d = choose_bid(table(b30=0.65), BidContext(OPEN, False, False), DecideConfig(make_threshold=0.7))
    assert d.bid == PASS


def test_options_for_illegal_bids_are_ignored():
    legal = [PASS, 41, 42, 84]
    d = choose_bid(table(b30=0.99, b41=0.4), BidContext(legal, False, False))
    assert d.bid == PASS


def test_plunge_is_a_marks_bid():
    legal = [PASS, *range(31, 43), 84, PLUNGE]
    d = choose_bid(table(b31=0.6) + [Option(PLUNGE, Suit.NONE, 0.8)], BidContext(legal, False, True))
    assert d.bid == PLUNGE  # EV 4*(0.6)=2.4 beats 0.2
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_sim_decide.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'fortytwo_ml.sim.decide'`.

- [ ] **Step 3: Implement**

`ml/src/fortytwo_ml/sim/decide.py`:
```python
"""The bidding rules, as a pure function over a table of simulated P(make) values.

- Partner holds the high bid: pass, unless a higher bid is near-certain.
- Last to bid (nobody can outbid us): the lowest makeable bid, unless a marks bid is worth more.
  Forced with nothing makeable: the lowest legal bid anyway.
- Otherwise: the highest makeable bid (bid what the hand can make, so opponents can't take it
  cheaply), or pass."""
from collections.abc import Sequence
from dataclasses import dataclass

from ..engine.bidding import marks_for
from ..engine.enums import PASS


@dataclass(frozen=True)
class Option:
    bid: int
    trump: int
    p_make: float

    @property
    def ev(self) -> float:
        return marks_for(self.bid) * (2 * self.p_make - 1)


@dataclass(frozen=True)
class BidContext:
    legal: Sequence[int]
    partner_holds: bool
    last_to_bid: bool

    @property
    def forced(self) -> bool:
        return PASS not in self.legal


@dataclass(frozen=True)
class DecideConfig:
    make_threshold: float = 0.5
    overbid_partner_threshold: float = 0.9


@dataclass(frozen=True)
class BidDecision:
    bid: int
    trump: int | None
    p_make: float | None
    options: tuple[Option, ...]


MARKS_BID = 84  # bids from 84 up (plunge included) are marks bids


def choose_bid(options: Sequence[Option], ctx: BidContext, cfg: DecideConfig = DecideConfig()) -> BidDecision:
    table = tuple(options)
    best: dict[int, Option] = {}
    for o in table:
        if o.bid in ctx.legal and o.bid != PASS and (o.bid not in best or o.p_make > best[o.bid].p_make):
            best[o.bid] = o

    def take(bid: int) -> BidDecision:
        o = best[bid]
        return BidDecision(o.bid, o.trump, o.p_make, table)

    passing = BidDecision(PASS, None, None, table)
    makeable = sorted(b for b, o in best.items() if o.p_make > cfg.make_threshold)

    if ctx.partner_holds:
        strong = [b for b, o in best.items() if o.p_make >= cfg.overbid_partner_threshold]
        return take(max(strong)) if strong else passing

    if ctx.last_to_bid:
        if makeable:
            lowest = makeable[0]
            marks = [b for b in makeable if b >= MARKS_BID]
            richest = max(marks, key=lambda b: best[b].ev) if marks else None
            return take(richest) if richest is not None and best[richest].ev > best[lowest].ev else take(lowest)
        return take(min(best)) if ctx.forced and best else passing

    if makeable:
        return take(makeable[-1])
    return take(min(best)) if ctx.forced and best else passing
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_sim_decide.py -q`, then `uv run pytest -q`.
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add ml/src/fortytwo_ml/sim/decide.py ml/tests/test_sim_decide.py
git commit -m "ml: choose_bid rules for simulation bidding"
```

---

### Task 5: `SimBidder` and `SimAgent`

**Files:**
- Create: `ml/src/fortytwo_ml/agents/sim_bidder.py`
- Test: `ml/tests/test_sim_bidder.py`

**Interfaces:**
- Consumes: `deal_unseen` (Task 2), `rollout` (Task 3), `Option`, `BidContext`, `DecideConfig`, `BidDecision`, `choose_bid` (Task 4), `ModelAgent`, `best_suit`, `HandState`, `Contract`, `partner`, `team_of`, `NAMED_SUITS`, `LOW_TRUMPS`, `Suit`, `PASS`, `PLUNGE`.
- Produces:
  - `estimate_options(model, state, seat, n_deals, rng, device=None) -> list[Option]`.
  - `SimBidder(model, n_deals=200, make_threshold=0.5, overbid_partner_threshold=0.9, seed=0, device=None)`:
    - name `"sim"`; implements `bid` and `trump` (`play` raises `NotImplementedError`);
    - `.last_decision: BidDecision | None`, `.decision_seconds: list[float]`;
    - `.predicted_make(state, seat) -> float | None`: the P(make) recorded for this seat's winning bid.
  - `SimAgent(model, name="sim", **sim_bidder_kwargs)`:
    - bid and trump via `SimBidder`, play via `ModelAgent`;
    - `.from_checkpoint(path, **kw)`, plus `.decision_seconds`, `.last_decision` and `.predicted_make` delegated to the bidder.

- [ ] **Step 1: Write the failing tests**

`ml/tests/test_sim_bidder.py`:
```python
import random

import pytest
import torch

from conftest import deal_with
from fortytwo_ml.agents.base import run_hand
from fortytwo_ml.agents import sim_bidder as sb
from fortytwo_ml.agents.sim_bidder import SimAgent, SimBidder, estimate_options
from fortytwo_ml.engine.enums import LOW_TRUMPS, PASS, PLUNGE, Suit
from fortytwo_ml.engine.hand_state import HandState, Phase
from fortytwo_ml.model import QNet


def tiny():
    torch.manual_seed(0)
    return QNet(hidden=16, layers=1).eval()


def test_estimate_options_covers_every_legal_bid_with_probabilities():
    state = HandState.deal(list(range(28)), opener=0)
    options = estimate_options(tiny(), state, 0, 4, random.Random(0))
    bids = {o.bid for o in options}
    assert set(range(30, 43)) <= bids and 84 in bids
    assert all(0.0 <= o.p_make <= 1.0 for o in options)
    assert {o.trump for o in options if o.bid == 42} >= {Suit.NONE, *LOW_TRUMPS}
    assert {o.trump for o in options if o.bid == 30} == set(range(7))


def test_estimate_options_includes_plunge_when_legal():
    deal = deal_with({0: [(0, 0), (1, 1), (2, 2), (3, 3)]})
    state = HandState.deal(deal, opener=0)
    options = estimate_options(tiny(), state, 0, 4, random.Random(0))
    assert any(o.bid == PLUNGE for o in options)


def test_sim_agents_play_full_auctions_legally():
    agent = SimAgent(tiny(), n_deals=4)
    rng = random.Random(1)
    for _ in range(3):
        order = list(range(28))
        rng.shuffle(order)
        state = HandState.deal(order, rng.randrange(4))
        run_hand(state, [agent] * 4)
        assert state.phase is Phase.DONE
    assert len(agent.decision_seconds) >= 3 and agent.last_decision is not None


def test_trump_reuses_the_bid_time_choice(monkeypatch):
    bidder = SimBidder(tiny(), n_deals=4)
    state = HandState.deal(list(range(28)), opener=0)
    bid = bidder.bid(state, 0)
    if bid == PASS:
        pytest.skip("the tiny model passed; nothing to name")
    planned = bidder.last_decision.trump
    state.apply(bid)
    for _ in range(3):
        state.apply(PASS)
    monkeypatch.setattr(sb, "rollout", lambda *a, **k: (_ for _ in ()).throw(AssertionError("simulated")))
    assert bidder.trump(state, 0) == planned


def test_trump_plan_only_used_for_the_winning_bid():
    bidder = SimBidder(tiny(), n_deals=4)
    state = HandState.deal(list(range(28)), opener=0)
    bidder._planned[bidder._key(state, 0)] = (30, Suit.SIXES, 0.9)
    for bid in (30, 31, PASS, PASS):  # seat 1 outbids; seat 0 never wins at 30
        state.apply(bid)
    assert state.bidder == 1
    assert bidder._plan_for(state, 0) is None


def test_partner_plunge_trump_uses_constrained_deals():
    deal = deal_with({1: [(0, 0), (1, 1), (2, 2), (3, 3)]})
    state = HandState.deal(deal, opener=0)
    for bid in (PASS, PLUNGE, PASS, PASS):
        state.apply(bid)
    assert state.to_act == 3
    trump = SimBidder(tiny(), n_deals=4).trump(state, 3)
    assert trump in state.legal_actions()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_sim_bidder.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'fortytwo_ml.agents.sim_bidder'`.

- [ ] **Step 3: Implement**

`ml/src/fortytwo_ml/agents/sim_bidder.py`:
```python
"""Bidding by simulation: deal the unseen dominoes many times, play each deal out with the
Stage 1 play model, and bid on the estimated chance of making each (bid, trump) option.
v1 looks only at its own hand (plus two public facts: who holds the high bid, and that a
plunger holds four doubles)."""
import random
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch

from ..engine.enums import LOW_TRUMPS, NAMED_SUITS, PASS, PLUNGE, Suit
from ..engine.hand_state import Contract, HandState, partner
from ..model import QNet, load_checkpoint
from ..sim.deal import deal_unseen
from ..sim.decide import BidContext, BidDecision, DecideConfig, Option, choose_bid
from ..sim.rollout import rollout
from .heuristic_bot import best_suit
from .model_agent import ModelAgent

POINTS_PROBE = 30  # suits played as a 30 bid answer every points bid (30..41)
HIGH_PROBE = 42    # suits, follow-me and Low played as a 42 bid answer 42 and the marks bids


def estimate_options(
    model: QNet, state: HandState, seat: int, n_deals: int, rng: random.Random, device=None
) -> list[Option]:
    legal = [b for b in state.legal_actions() if b != PASS]
    if not legal:
        return []
    hand = state.hand(seat)
    deals = [deal_unseen(seat, hand, rng) for _ in range(n_deals)]
    points_bids = [b for b in legal if b < HIGH_PROBE]
    high_bids = [b for b in legal if b >= HIGH_PROBE and b != PLUNGE]

    jobs: list[tuple[list[int], Contract]] = []
    keys: list[tuple[str, int]] = []

    def add(kind: str, trump_for_deal) -> None:
        for d in deals:
            trump = trump_for_deal(d)
            jobs.append((d, Contract(seat, {"points": POINTS_PROBE, "plunge": PLUNGE}.get(kind, HIGH_PROBE), trump)))
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
    points: dict[tuple[str, int], list[int]] = defaultdict(list)
    took: dict[tuple[str, int], list[bool]] = defaultdict(list)
    for key, p, t in zip(keys, result.bidder_points, result.bidder_took_trick):
        points[key].append(int(p))
        took[key].append(bool(t))

    options: list[Option] = []
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
```
Plunge's `trump` in the option is a placeholder (`Suit.NONE`), because the partner names the real trump. `SimBidder` records `None` as the plan's trump for a plunge.

Continue the same file:
```python
class SimBidder:
    name = "sim"

    def __init__(self, model: QNet, n_deals: int = 200, make_threshold: float = 0.5,
                 overbid_partner_threshold: float = 0.9, seed: int = 0, device=None):
        self.model = model.eval()
        self.n_deals = n_deals
        self.config = DecideConfig(make_threshold, overbid_partner_threshold)
        self.rng = random.Random(f"sim-bidder:{seed}")
        self.device = torch.device(device) if device is not None else next(model.parameters()).device
        self._planned: dict[tuple, tuple[int, int | None, float]] = {}  # (seat, hand) -> (bid, trump, p_make)
        self.last_decision: BidDecision | None = None
        self.decision_seconds: list[float] = []

    @staticmethod
    def _key(state: HandState, seat: int) -> tuple:
        return seat, tuple(sorted(state.dealt[seat]))

    def _plan_for(self, state: HandState, seat: int) -> tuple[int, int | None, float] | None:
        plan = self._planned.get(self._key(state, seat))
        return plan if plan is not None and state.bidder == seat and plan[0] == state.high_bid else None

    def predicted_make(self, state: HandState, seat: int) -> float | None:
        plan = self._plan_for(state, seat)
        return plan[2] if plan else None

    def bid(self, state: HandState, seat: int) -> int:
        start = time.perf_counter()
        options = estimate_options(self.model, state, seat, self.n_deals, self.rng, self.device)
        others = [s for s in range(4) if s != seat]
        ctx = BidContext(
            legal=state.legal_actions(),
            partner_holds=state.bidder is not None and state.bidder == partner(seat),
            last_to_bid=all(state.bids[s] is not None for s in others),
        )
        decision = choose_bid(options, ctx, self.config)
        self.decision_seconds.append(time.perf_counter() - start)
        self.last_decision = decision
        if decision.bid != PASS:
            trump = None if decision.bid == PLUNGE else decision.trump
            self._planned[self._key(state, seat)] = (decision.bid, trump, decision.p_make)
        return decision.bid

    def trump(self, state: HandState, seat: int) -> int:
        legal = state.legal_actions()
        if state.high_bid == PLUNGE and state.bidder != seat:
            return self._best_trump(state, seat, legal, require=(state.bidder, 4), bidder=state.bidder)
        plan = self._plan_for(state, seat)
        if plan is not None and plan[1] in legal:
            return plan[1]
        return self._best_trump(state, seat, legal, require=None, bidder=seat)

    def _best_trump(self, state: HandState, seat: int, legal, require, bidder: int) -> int:
        hand = state.hand(seat)
        deals = [deal_unseen(seat, hand, self.rng, require=require) for _ in range(self.n_deals)]
        jobs = [(d, Contract(bidder, state.high_bid, t)) for t in legal for d in deals]
        won = rollout(self.model, jobs, self.device).bidders_won.reshape(len(legal), len(deals))
        return legal[int(np.argmax(won.mean(axis=1)))]

    def play(self, state: HandState, seat: int) -> int:
        raise NotImplementedError("SimBidder only bids and names trump; use SimAgent to play")


class SimAgent:
    """A complete bot: simulation bidding and trump, Stage 1 model play."""

    def __init__(self, model: QNet, name: str = "sim", **kwargs):
        self.name = name
        self.bidder = SimBidder(model, **kwargs)
        self.player = ModelAgent(model)

    @classmethod
    def from_checkpoint(cls, path: str | Path, **kwargs) -> "SimAgent":
        model, _ = load_checkpoint(path)
        return cls(model, name=f"sim:{Path(path).name}", **kwargs)

    def bid(self, state: HandState, seat: int) -> int:
        return self.bidder.bid(state, seat)

    def trump(self, state: HandState, seat: int) -> int:
        return self.bidder.trump(state, seat)

    def play(self, state: HandState, seat: int) -> int:
        return self.player.play(state, seat)

    @property
    def decision_seconds(self) -> list[float]:
        return self.bidder.decision_seconds

    @property
    def last_decision(self) -> BidDecision | None:
        return self.bidder.last_decision

    def predicted_make(self, state: HandState, seat: int) -> float | None:
        return self.bidder.predicted_make(state, seat)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_sim_bidder.py -q`, then `uv run pytest -q`.
Expected: all pass. If `test_trump_reuses_the_bid_time_choice` skips because the tiny model passed, change its deal to `deal_with({0: [(6, 6), (5, 6), (4, 6), (3, 6), (2, 6), (1, 6), (0, 6)]})`, a hand of all sixes, so a bid is near-certain. It must not skip.

- [ ] **Step 5: Commit**

```bash
git add ml/src/fortytwo_ml/agents/sim_bidder.py ml/tests/test_sim_bidder.py
git commit -m "ml: SimBidder and SimAgent (simulation bidding, remembered trump)"
```

---

### Task 6: `evaluate_auctions`, report, CLI, README, and the timing check

**Files:**
- Modify: `ml/src/fortytwo_ml/eval/arena.py`, `ml/src/fortytwo_ml/eval/report.py`, `ml/src/fortytwo_ml/cli.py`, `ml/README.md`
- Test: `ml/tests/test_eval.py`, `ml/tests/test_cli.py`

**Interfaces:**
- Consumes: `SimAgent` (Task 5), `ModelAgent`, `run_hand`, `HandState.deal`, `contract_kind`, `team_of`, `mean_ci`.
- Produces:
  - `AuctionRecord(kind, a_won_auction, bidders_won, a_marks, predicted: float | None)`;
  - `AuctionEval(a_name, b_name, records, deal_scores, illegal, decision_seconds)`;
  - `evaluate_auctions(a, b, deals, seed=0) -> AuctionEval`;
  - `report.format_auction_report(ev: AuctionEval, matches: MatchEval | None = None) -> str`;
  - CLI: `ml eval-bidding`; `load_agent("sim:<ckpt>")`; `ml play-demo --agent sim:<ckpt>` runs a full auction and prints the top options of every simulated bid decision.

- [ ] **Step 1: Write the failing tests**

Append to `ml/tests/test_eval.py`:
```python
def test_evaluate_auctions_duplicates_deals_with_full_bidding():
    import torch
    from fortytwo_ml.agents.model_agent import ModelAgent
    from fortytwo_ml.agents.sim_bidder import SimAgent
    from fortytwo_ml.eval.arena import evaluate_auctions
    from fortytwo_ml.eval.report import format_auction_report
    from fortytwo_ml.model import QNet

    torch.manual_seed(0)
    net = QNet(hidden=16, layers=1).eval()
    ev = evaluate_auctions(SimAgent(net, n_deals=4), ModelAgent(net), deals=3, seed=1)
    assert len(ev.records) == 6 and len(ev.deal_scores) == 3 and ev.illegal == {"a": 0, "b": 0}
    assert len(ev.decision_seconds) >= 3
    assert all((r.predicted is not None) == r.a_won_auction for r in ev.records)
    text = format_auction_report(ev)
    assert "Mean marks/deal" in text and "Calibration" in text and "Bid decision time" in text
```

Append to `ml/tests/test_cli.py`:
```python
def test_eval_bidding_runs_on_a_tiny_checkpoint(tmp_path, capsys):
    path = tmp_path / "m.pt"
    save_checkpoint(path, QNet(hidden=16, layers=1), step=0, config={})
    assert main(["eval-bidding", "--model", str(path), "--deals", "2", "--sim-deals", "4"]) == 0
    assert "Calibration" in capsys.readouterr().out


def test_load_agent_sim(tmp_path):
    from fortytwo_ml.agents.sim_bidder import SimAgent

    path = tmp_path / "m.pt"
    save_checkpoint(path, QNet(hidden=16, layers=1), step=0, config={})
    assert isinstance(load_agent(f"sim:{path}"), SimAgent)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_eval.py tests/test_cli.py -q`
Expected: FAIL with `ImportError: cannot import name 'evaluate_auctions'`.

- [ ] **Step 3: Implement `evaluate_auctions`**

Append to `ml/src/fortytwo_ml/eval/arena.py`:
```python
@dataclass(frozen=True)
class AuctionRecord:
    kind: str
    a_won_auction: bool
    bidders_won: bool
    a_marks: int
    predicted: float | None  # A's simulated P(make) for its winning bid, when A won the auction


@dataclass
class AuctionEval:
    a_name: str
    b_name: str
    records: list[AuctionRecord] = field(default_factory=list)
    deal_scores: list[int] = field(default_factory=list)
    illegal: dict[str, int] = field(default_factory=lambda: {"a": 0, "b": 0})
    decision_seconds: list[float] = field(default_factory=list)


def evaluate_auctions(a: Agent, b: Agent, deals: int, seed: int = 0) -> AuctionEval:
    """Duplicate deals with real auctions: each deal is bid and played twice with the teams
    swapped. For Stage 2, A and B share a play model and differ only in how they bid."""
    result = AuctionEval(a.name, b.name)
    for i in range(deals):
        rng = random.Random(f"auction:{seed}:{i}")
        order = list(range(28))
        rng.shuffle(order)
        opener = rng.randrange(4)
        score = 0
        for a_team in (0, 1):
            seats = _seats(a, b, a_team)
            state = HandState.deal(order, opener)
            hand = run_hand(state, seats, _illegal_counter(result.illegal, a_team))
            bidders = team_of(state.bidder)
            a_won = bidders == a_team
            predict = getattr(seats[state.bidder], "predicted_make", None) if a_won else None
            predicted = predict(state, state.bidder) if predict else None
            a_marks = hand.marks if hand.winning_team == a_team else -hand.marks
            result.records.append(
                AuctionRecord(contract_kind(state.contract), a_won, hand.winning_team == bidders, a_marks, predicted)
            )
            score += a_marks
        result.deal_scores.append(score)
    result.decision_seconds = list(getattr(a, "decision_seconds", []))
    return result
```
`predicted` is `None` only when A didn't win the auction, provided A is a `SimAgent`, which records a plan for every winning bid. The test asserts exactly that.

- [ ] **Step 4: Implement the report**

Append to `ml/src/fortytwo_ml/eval/report.py`, importing `AuctionEval` alongside the existing arena imports:
```python
_CALIBRATION_BINS = [(0.0, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 0.9), (0.9, 1.01)]


def format_auction_report(ev: AuctionEval, matches: MatchEval | None = None) -> str:
    mean, lo, hi = mean_ci(ev.deal_scores)
    won = [r for r in ev.records if r.a_won_auction]
    lines = [
        f"A: {ev.a_name}  vs  B: {ev.b_name}  -  {len(ev.deal_scores)} duplicate deals with auctions",
        f"Mean marks/deal (A): {mean:+.3f}  [95% CI {lo:+.3f}, {hi:+.3f}]",
        f"A won the auction: {len(won)}/{len(ev.records)}   made: {_rate(sum(r.bidders_won for r in won), len(won))}",
        "By winning contract:     A's marks/hand   A bid / B bid",
    ]
    for kind in KIND_ORDER:
        recs = [r for r in ev.records if r.kind == kind]
        if recs:
            a_bid = sum(r.a_won_auction for r in recs)
            avg = sum(r.a_marks for r in recs) / len(recs)
            lines.append(f"  {kind:<10}             {avg:+.3f} (n={len(recs)})   {a_bid} / {len(recs) - a_bid}")
    lines.append("Calibration (A's winning bids): predicted P(make) -> actual made rate")
    for low, high in _CALIBRATION_BINS:
        hits = [r for r in won if r.predicted is not None and low <= r.predicted < high]
        if hits:
            predicted = sum(r.predicted for r in hits) / len(hits)
            made = sum(r.bidders_won for r in hits) / len(hits)
            lines.append(f"  {low:.1f}-{min(high, 1.0):.1f}: predicted {predicted:.2f}  actual {made:.2f}  (n={len(hits)})")
    if ev.decision_seconds:
        times = sorted(ev.decision_seconds)
        p95 = times[min(len(times) - 1, int(0.95 * len(times)))]
        lines.append(f"Bid decision time: median {times[len(times) // 2]:.1f}s  p95 {p95:.1f}s  (n={len(times)})")
    illegal = dict(ev.illegal)
    if matches is not None:
        p, plo, phi = proportion_ci(matches.a_wins, matches.matches)
        lines.append(f"Match win rate (A): {p:.1%}  [95% CI {plo:.1%}, {phi:.1%}] over {matches.matches} matches")
        illegal = {k: illegal[k] + matches.illegal[k] for k in illegal}
    lines.append(f"Illegal actions: A={illegal['a']} B={illegal['b']}")
    return "\n".join(lines)
```

- [ ] **Step 5: Implement the CLI**

In `cli.py`:
- Import `SimAgent` from `.agents.sim_bidder`, `evaluate_auctions` from `.eval.arena`, and `format_auction_report` from `.eval.report`.
- In `load_agent`, before the file check:
```python
    if spec.startswith("sim:"):
        path = spec[len("sim:"):]
        if not Path(path).is_file():
            raise FileNotFoundError(f"no checkpoint at {path}")
        return SimAgent.from_checkpoint(path)
```
- Add the subparser:
```python
    s = sub.add_parser("eval-bidding", help="Stage 2: simulation bidding vs heuristic bidding, same play model")
    s.add_argument("--model", required=True, help="path/to/checkpoint.pt")
    s.add_argument("--deals", type=int, default=1000)
    s.add_argument("--sim-deals", type=int, default=200)
    s.add_argument("--matches", type=int, default=0)
    s.add_argument("--seed", type=int, default=0)
```
- Add the branch:
```python
    elif args.command == "eval-bidding":
        a = SimAgent.from_checkpoint(args.model, n_deals=args.sim_deals, seed=args.seed)
        b = ModelAgent.from_checkpoint(args.model)
        b.name = f"heuristic-bidding:{Path(args.model).name}"
        ev = evaluate_auctions(a, b, args.deals, seed=args.seed)
        matches = evaluate_matches(a, b, args.matches, seed=args.seed) if args.matches else None
        print(format_auction_report(ev, matches))
```
- Make `play-demo` run a full auction for a `SimAgent`. At the top of `_play_demo`, add:
```python
    if isinstance(agent, SimAgent):
        return _auction_demo(agent, seed)
```
  and add:
```python
def _auction_demo(agent: SimAgent, seed: int) -> None:
    rng = random.Random(seed)
    order = list(range(28))
    rng.shuffle(order)
    state = HandState.deal(order, rng.randrange(4))
    for seat in range(4):
        print(f"  seat {seat}: {' '.join(domino_id(d) for d in state.hand(seat))}")
    while state.phase is Phase.BID:
        seat = state.to_act
        bid = agent.bid(state, seat)
        top = sorted(agent.last_decision.options, key=lambda o: -o.ev)[:5]
        print(f"  seat {seat} bids {bid}; top options: "
              + ", ".join(f"{o.bid}/{Suit(o.trump).name} p={o.p_make:.2f} ev={o.ev:+.2f}" for o in top))
        state.apply(bid)
    trump = agent.trump(state, state.to_act)
    print(f"Contract: seat {state.bidder} bid {state.high_bid}, trump {Suit(trump).name}")
    state.apply(trump)
    while state.phase is not Phase.DONE:
        state.apply(choose(agent, state))
    r = state.result
    print(f"Result: team {r.winning_team} wins {r.marks} mark(s); points {r.points[0]}-{r.points[1]}")
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ml && uv run pytest -q`
Expected: all pass.

- [ ] **Step 7: Update the README**

Add a section to `ml/README.md` after "Watching a run":
````markdown
## Stage 2: bidding by simulation

First fine-tune the play model on realistic plunge and Low hands (about 1.7 h), then check it
against `stage1-b`:

```sh
uv run ml train --config configs/stage1-plunge.yaml --run-name stage1-c --resume runs/stage1-b/ckpt-latest.pt
uv run ml eval --a runs/stage1-c/ckpt-latest.pt --b runs/stage1-b/ckpt-latest.pt --deals 5000 --kind plunge
uv run ml eval --a runs/stage1-c/ckpt-latest.pt --b runs/stage1-b/ckpt-latest.pt --deals 5000 --kind low
uv run ml eval --a runs/stage1-c/ckpt-latest.pt --b runs/stage1-b/ckpt-latest.pt --deals 5000
```

The fine-tune passes if:
- **plunge:** A wins, with the CI above 0;
- **Low:** A is at least even (CI lower bound ≥ −0.03), and Low bidders' made rate rises well above 16%;
- **normal mix:** no regression (CI lower bound > −0.03).

Then evaluate the simulation bidder against heuristic bidding with the same play model. This
takes roughly 4–7 h:

```sh
uv run ml eval-bidding --model runs/stage1-c/ckpt-latest.pt --deals 1000
uv run ml play-demo --agent sim:runs/stage1-c/ckpt-latest.pt --seed 3   # one auction with its reasoning
```

Stage 2 passes if:
- A's mean marks/deal is above 0, with the 95% CI excluding 0;
- the bid decision's p95 time is ≤ 30 s.

The **calibration** table compares the bidder's predicted P(make) with how often those bids were
actually made. If actual rates fall consistently below the predictions, the bidder is
overrating its best option (the "winner's curse"). It picks the trump from the same sample that
justified the bid. The fix would be an independent confirmation sample before bidding.
````

- [ ] **Step 8: Measure decision time on the dev box**

Run: `cd ml && uv run ml eval-bidding --model runs/stage1-b/ckpt-latest.pt --deals 5 --sim-deals 200`
Expected: a full report. Put the output in your report, especially the `Bid decision time` line (target p95 ≤ 30 s).
- If `runs/stage1-b/ckpt-latest.pt` doesn't exist, say so and skip this step.
- If p95 is over 30 s, report DONE_WITH_CONCERNS with the numbers. Don't tune.

- [ ] **Step 9: Commit**

```bash
git add ml/src/fortytwo_ml/eval ml/src/fortytwo_ml/cli.py ml/tests/test_eval.py ml/tests/test_cli.py ml/README.md
git commit -m "ml: evaluate_auctions with calibration; eval-bidding and sim play-demo"
```

---

### Task 7: The runs (manual, on the GPU box)

Not code. The user runs these once Task 6 has landed. The fine-tune can start as soon as Task 1 lands.

- [ ] Fine-tune `stage1-c` and run the three head-to-heads from the README. Check them against the bar.
- [ ] Run `ml eval-bidding --model runs/stage1-c/ckpt-latest.pt --deals 1000` overnight. Check it against the Stage 2 bar and the calibration table.
