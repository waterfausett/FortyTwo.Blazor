# ML Bots Stage 1 Learning Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Stage 1 play model learn which domino to play, and make training ingest data about 3× faster. That means per-candidate features, quieter optimization with EMA weights, learning diagnostics in TensorBoard, and a GPU-resident replay pipeline, plus a `bench-train` command to prove the speed.

**Architecture:**
- `features.py` appends 10 derived features to each candidate's one-hot.
- The learner keeps an EMA copy of the network. Actors play with it, eval uses it, and checkpoints store it alongside the raw weights and Adam state.
- `eval/diagnostics.py` scores action stability and agreement with the heuristic on a fixed set of 2,000 decisions.
- The replay buffer moves onto the training device.
- Actors batch about 16 hands per queue item.
- A cumulative replay cap keeps the learner from over-reusing data.

**Tech Stack:** Python 3.12, PyTorch, numpy, TensorBoard, pytest, and uv. This is the existing `ml/` project.

**Spec:** `docs/superpowers/specs/2026-09-30-ml-bots-stage1-learning-fixes-design.md`, which amends `docs/superpowers/specs/2026-09-29-ml-bots-stage1-design.md`.

## Global Constraints

- All commands run from `ml/` as `uv run ...`. No test may need a GPU; tests use `device="cpu"` or `configs/smoke.yaml`.
- Features are computed only from public state plus the acting seat's own hand. Other seats' hidden dominoes must never change an encoding.
- `ACTION_DIM = 38` (28 one-hot + 10 features) and `INPUT_DIM = 363`. `OBS_DIM` stays 325.
- Checkpoints store `input_dim`. A checkpoint whose `input_dim` isn't 363, including a missing key (meaning 353), raises `ValueError` naming both sizes.
- Hyperparameters in `stage1.yaml`:
  - `lr: 0.0001`, `batch_size: 4096`, `ema_decay: 0.999`, `max_replay_ratio: 4.0`;
  - `actor_send_hands: 16`, `learner_threads: 2`, `diag_decisions: 2000`;
  - `total_steps: 200000`, `alpha_decay_steps: 20000`, `eval_every_steps: 2000`.
- `actors: 0` resolves to `max(1, os.cpu_count() // 2 - 1)`.
- The replay cap is cumulative since the run started. The learner is starved when `steps_this_run × batch_size > max_replay_ratio × samples_added_this_run`. A value of 0 disables the cap.
- The engine, contract sampler, arena, reward (including zero shaping on Low) and Stage 1 bar are unchanged.
- The throughput target, via `uv run ml bench-train --config configs/stage1.yaml --seconds 60` (replay cap off), is ≥ 15k samples/s and ≥ 60 learner steps/s.

## Review Focus

1. **Hidden-information leak through the new features.** "Boss" and "wins now" must use only unseen = not in my hand and not played. Pinned in Task 1 (`test_hidden_hands_never_change_the_encoding`).
2. **Loading a `stage1-a` checkpoint (353 inputs)** must fail clearly, not with a cryptic shape error from `load_state_dict`. Pinned in Task 1 (`test_old_checkpoint_is_refused_with_both_sizes`).
3. **Publishing must stay in place.** It must not rebind shared-memory parameters, or actors silently stop seeing updates. That's the bug class this whole plan is about. Pinned in Task 5 (`test_publish_copies_in_place_into_shared_memory`).
4. **Resuming must restore EMA, raw weights and Adam state,** so a resumed run doesn't restart optimization. Pinned in Task 5 (`test_checkpoint_carries_raw_and_optimizer_and_resume_uses_them`).
5. **A replay buffer batch larger than capacity** must keep only the newest rows and never index out of range. Pinned in Task 4 (`test_buffer_keeps_only_the_newest_rows_of_an_oversized_batch`).

---

### Task 1: Candidate-action features and checkpoint input-size guard

**Files:**
- Modify: `ml/src/fortytwo_ml/features.py`
- Modify: `ml/src/fortytwo_ml/model.py` (save `input_dim`; check it on load)
- Modify: `ml/tests/test_features.py`, `ml/tests/test_model.py`

**Interfaces:**
- Consumes: the engine rules helpers `is_trump`, `is_of_suit`, `led_suit`, `rank`, `trick_winner`; `dominoes.VALUE`, `IS_DOUBLE`, `FULL_MASK`; `enums.is_low`; `hand_state.partner`, `team_of`.
- Produces:
  - `features.ACTION_ONEHOT = 28`, `ACTION_FEATURES = 10`, `ACTION_DIM = 38`, `INPUT_DIM = 363`.
  - Feature index constants `A_IS_TRUMP, A_IS_DOUBLE, A_COUNT, A_FOLLOWS, A_RANK, A_WINS_NOW, A_OVERTAKES_PARTNER, A_BOSS, A_TRICK_POINTS, A_CLOSES` (0..9). The feature `k` of a row lives at `OBS_DIM + ACTION_ONEHOT + k`.
  - `encode_actions(state, seat, actions)` has the same signature and now returns `(k, 363)`.
  - `model.load_checkpoint` raises `ValueError` on an `input_dim` mismatch.

- [ ] **Step 1: Write the failing tests**

In `ml/tests/test_features.py`:
- Replace `test_dimensions` with the version below.
- Change the last test's `row[OBS_DIM:].sum() == 1` to `row[OBS_DIM:OBS_DIM + 28].sum() == 1`.
- Append the new tests below.

```python
def test_dimensions():
    assert OBS_DIM == 325 and ACTION_DIM == 38 and INPUT_DIM == 363
    assert SCALARS + 3 == OBS_DIM
```

Add `ACTION_DIM, A_BOSS, A_CLOSES, A_COUNT, A_FOLLOWS, A_IS_DOUBLE, A_IS_TRUMP, A_OVERTAKES_PARTNER, A_RANK, A_TRICK_POINTS, A_WINS_NOW` to the `fortytwo_ml.features` import. Then append:

```python
F0 = OBS_DIM + 28  # first action-feature column


def _features(state, seat, domino):
    row = encode_actions(state, seat, [domino])[0]
    return row[F0:F0 + 10]


def test_lead_features_for_the_top_trump():
    state = HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.SIXES)
    f = _features(state, 0, d("6/6"))
    assert f[A_IS_TRUMP] == 1 and f[A_IS_DOUBLE] == 1 and f[A_COUNT] == 0
    assert f[A_FOLLOWS] == 0 and f[A_WINS_NOW] == 0 and f[A_CLOSES] == 0
    assert np.isclose(f[A_RANK], 8 / 18)
    assert f[A_BOSS] == 1  # the only unseen six is 0/6, which ranks below the double
    assert np.isclose(f[A_TRICK_POINTS], 1 / 42)


def test_lead_features_for_a_low_off_suit_domino():
    state = HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.SIXES)
    f = _features(state, 0, d("0/1"))
    assert f[A_IS_TRUMP] == 0 and np.isclose(f[A_RANK], 1 / 18)
    assert f[A_BOSS] == 0  # unseen aces like 1/1 outrank it


def test_following_features():
    state = HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.SIXES)
    state.apply(d("0/1"))
    f = _features(state, 1, d("1/4"))
    assert f[A_FOLLOWS] == 1 and f[A_WINS_NOW] == 1 and f[A_OVERTAKES_PARTNER] == 0
    assert np.isclose(f[A_RANK], 5 / 18) and np.isclose(f[A_COUNT], 0.5)
    assert np.isclose(f[A_TRICK_POINTS], 6 / 42) and f[A_BOSS] == 0


def test_overtaking_partner_and_closing_the_trick():
    state = HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.SIXES)
    for x in ("0/1", "1/2", "0/3"):
        state.apply(d(x))
    f = _features(state, 3, d("0/6"))  # seat 3 has no aces; 0/6 trumps partner seat 1's 1/2
    assert f[A_WINS_NOW] == 1 and f[A_OVERTAKES_PARTNER] == 1 and f[A_CLOSES] == 1
    assert f[A_FOLLOWS] == 0 and f[A_IS_TRUMP] == 1
    g = _features(state, 3, d("3/3"))
    assert g[A_WINS_NOW] == 0 and g[A_OVERTAKES_PARTNER] == 0 and g[A_RANK] == 0


def test_low_trick_closes_at_three():
    state = HandState.from_contract(DEAL, bidder=0, bid=42, trump=Suit.LOW)
    state.apply(d("6/6"))
    state.apply(d("0/0"))
    assert _features(state, 3, d("0/6"))[A_CLOSES] == 1


def test_hidden_hands_never_change_the_encoding():
    # Seats 0 and 1 keep their hands; seats 2 and 3 swap theirs. Seat 1's view must not change.
    swapped = [d(x) for seat in (0, 1, 3, 2) for x in HANDS[seat]]
    views = []
    for deal in (DEAL, swapped):
        state = HandState.from_contract(deal, bidder=0, bid=30, trump=Suit.SIXES)
        state.apply(d("0/1"))
        views.append(encode_actions(state, 1, state.legal_actions()))
    assert np.array_equal(views[0], views[1])
    fresh = [encode_actions(HandState.from_contract(deal, 0, 30, Suit.SIXES), 0, [d("6/6"), d("0/1")])
             for deal in (DEAL, swapped)]
    assert np.array_equal(fresh[0], fresh[1])
```

In `ml/tests/test_model.py`, append:

```python
def test_old_checkpoint_is_refused_with_both_sizes(tmp_path):
    path = tmp_path / "old.pt"
    net = QNet(hidden=16, layers=1)
    torch.save({"model": net.state_dict(), "hidden": 16, "layers": 1, "step": 5, "config": {}}, path)
    with pytest.raises(ValueError, match="353.*363"):
        load_checkpoint(path)
```

Add `import pytest` to `test_model.py`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_features.py tests/test_model.py -q`
Expected: FAIL, with `ImportError: cannot import name 'ACTION_DIM'` (and the model test failing when collection is fixed).

- [ ] **Step 3: Implement the features**

In `ml/src/fortytwo_ml/features.py`:

1. Replace the imports and the `ACTION_DIM`/`INPUT_DIM` lines with:

```python
from collections.abc import Sequence

import numpy as np

from .engine.bidding import CONTRACT_BIDS
from .engine.dominoes import FULL_MASK, IS_DOUBLE, VALUE
from .engine.enums import ALL_TRUMPS, PLUNGE, is_low
from .engine.hand_state import HandState, partner, team_of
from .engine.rules import is_of_suit, is_trump, led_suit, rank, trick_winner
```

```python
OBS_DIM = SCALARS + 3
ACTION_ONEHOT = 28        # which domino the candidate is
ACTION_FEATURES = 10      # what that domino means right now (below)
ACTION_DIM = ACTION_ONEHOT + ACTION_FEATURES
INPUT_DIM = OBS_DIM + ACTION_DIM

# Candidate features, at OBS_DIM + ACTION_ONEHOT + k. Each is computed from public state and the
# actor's own hand only.
(A_IS_TRUMP, A_IS_DOUBLE, A_COUNT, A_FOLLOWS, A_RANK, A_WINS_NOW, A_OVERTAKES_PARTNER, A_BOSS,
 A_TRICK_POINTS, A_CLOSES) = range(ACTION_FEATURES)
_MAX_RANK = 18  # ranks run -1 (off suit) .. 17 (the double of trump)
```

2. Replace `encode_actions` with the code below, and add the two helpers above it:

```python
def _action_context(state: HandState, seat: int) -> tuple:
    trump, led = state.trump, state.led_suit
    best_seat = best_rank = None
    if state.trick:
        played = [d for _, d in state.trick]
        best = trick_winner(played, trump)
        best_seat, best_rank = state.trick[best][0], rank(played[best], led, trump)
    seen = state.hands[seat]
    for mask in state.played:
        seen |= mask
    table = sum(VALUE[d] for _, d in state.trick)
    size = 3 if is_low(trump) else 4
    return trump, led, best_seat, best_rank, FULL_MASK & ~seen, table, size


def _fill_action(row: np.ndarray, state: HandState, seat: int, d: int, ctx: tuple) -> None:
    trump, led, best_seat, best_rank, unseen, table, size = ctx
    row[OBS_DIM + d] = 1.0
    f = OBS_DIM + ACTION_ONEHOT
    row[f + A_IS_TRUMP] = float(is_trump(d, trump))
    row[f + A_IS_DOUBLE] = float(IS_DOUBLE[d])
    row[f + A_COUNT] = VALUE[d] / 10
    row[f + A_TRICK_POINTS] = (table + VALUE[d] + 1) / 42
    if led is not None:
        r = rank(d, led, trump)
        wins = r > best_rank
        row[f + A_FOLLOWS] = float(is_of_suit(d, led, trump))
        row[f + A_RANK] = (r + 1) / _MAX_RANK if r > -1 else 0.0
        row[f + A_WINS_NOW] = float(wins)
        row[f + A_OVERTAKES_PARTNER] = float(wins and best_seat == partner(seat))
        row[f + A_CLOSES] = float(len(state.trick) + 1 == size)
    else:
        own = led_suit(d, trump)
        r = rank(d, own, trump)
        row[f + A_RANK] = (r + 1) / _MAX_RANK
        outranked = any(
            unseen >> u & 1 and is_of_suit(u, own, trump) and rank(u, own, trump) > r for u in range(28)
        )
        row[f + A_BOSS] = float(not outranked)


def encode_actions(state: HandState, seat: int, actions: Sequence[int]) -> np.ndarray:
    xs = np.zeros((len(actions), INPUT_DIM), dtype=np.float32)
    xs[:, :OBS_DIM] = encode_observation(state, seat)
    ctx = _action_context(state, seat)
    for i, a in enumerate(actions):
        _fill_action(xs[i], state, seat, a, ctx)
    return xs
```

- [ ] **Step 4: Implement the checkpoint guard**

In `ml/src/fortytwo_ml/model.py`:
- In `save_checkpoint`, add `"input_dim": INPUT_DIM,` to the saved dict.
- Replace `load_checkpoint` with:

```python
def load_checkpoint(path: str | Path, device: str = "cpu") -> tuple[QNet, dict]:
    data = torch.load(path, map_location=device, weights_only=True)
    found = data.get("input_dim", 353)  # checkpoints from before input_dim was recorded had 353 inputs
    if found != INPUT_DIM:
        raise ValueError(
            f"{path} was trained with {found} model inputs but this code uses {INPUT_DIM}; "
            "it predates a feature change and can't be loaded"
        )
    model = QNet(data["hidden"], data["layers"])
    model.load_state_dict(data["model"])
    model.eval()
    return model, {"step": data["step"], "config": data["config"]}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ml && uv run pytest -q`
Expected: all pass. That includes `test_eval.py::test_heuristic_beats_dumb_at_trick_play` and the smoke training tests (they build fresh nets, so the new width is picked up automatically).

- [ ] **Step 6: Commit**

```bash
git add ml/src/fortytwo_ml/features.py ml/src/fortytwo_ml/model.py ml/tests/test_features.py ml/tests/test_model.py
git commit -m "ml: add per-candidate action features; refuse checkpoints with a different input size"
```

---

### Task 2: EMA weights and checkpoints with raw weights plus optimizer state

**Files:**
- Create: `ml/src/fortytwo_ml/train/ema.py`
- Modify: `ml/src/fortytwo_ml/model.py`
- Test: `ml/tests/test_ema.py`, `ml/tests/test_model.py`

**Interfaces:**
- Consumes: `QNet`, `save_checkpoint` and `load_checkpoint` (Task 1 version).
- Produces:
  - `ema.make_ema(model) -> QNet`: a deep copy with `requires_grad=False`, in eval mode.
  - `ema.update_ema(ema, model, decay) -> None`: `ema ← ema + (1 − decay)(model − ema)`.
  - `model.save_checkpoint(path, model, step, config, raw: QNet | None = None, optimizer: torch.optim.Optimizer | None = None)`. `model` is the weights that play (the EMA).
  - `model.TrainingState(raw: QNet, optimizer: dict | None, step: int)`.
  - `model.load_training_state(path) -> TrainingState`. It uses `raw` when present, else `model`.

- [ ] **Step 1: Write the failing tests**

`ml/tests/test_ema.py`:
```python
import torch

from fortytwo_ml.model import QNet
from fortytwo_ml.train.ema import make_ema, update_ema


def test_ema_is_an_independent_frozen_copy():
    net = QNet(hidden=8, layers=1)
    ema = make_ema(net)
    assert all(not p.requires_grad for p in ema.parameters()) and not ema.training
    with torch.no_grad():
        next(net.parameters()).add_(1.0)
    assert not torch.equal(next(net.parameters()), next(ema.parameters()))


def test_update_moves_ema_toward_the_model():
    net = QNet(hidden=8, layers=1)
    ema = make_ema(net)
    before = [p.clone() for p in ema.parameters()]
    with torch.no_grad():
        for p in net.parameters():
            p.add_(1.0)
    update_ema(ema, net, decay=0.9)
    for old, new, cur in zip(before, ema.parameters(), net.parameters()):
        assert torch.allclose(new, 0.9 * old + 0.1 * cur)
```

Append to `ml/tests/test_model.py`:
```python
def test_checkpoint_can_carry_raw_weights_and_optimizer_state(tmp_path):
    from fortytwo_ml.model import load_training_state

    torch.manual_seed(1)
    ema, raw = QNet(hidden=16, layers=1), QNet(hidden=16, layers=1)
    opt = torch.optim.Adam(raw.parameters(), lr=1e-3)
    raw(torch.randn(3, INPUT_DIM)).sum().backward()
    opt.step()
    path = tmp_path / "c.pt"
    save_checkpoint(path, ema, step=7, config={}, raw=raw, optimizer=opt)

    played, _ = load_checkpoint(path)
    x = torch.randn(2, INPUT_DIM)
    assert torch.allclose(played(x), ema(x))
    state = load_training_state(path)
    assert state.step == 7 and torch.allclose(state.raw(x), raw(x))
    assert state.optimizer is not None and state.optimizer["state"]


def test_training_state_falls_back_to_the_played_weights(tmp_path):
    from fortytwo_ml.model import load_training_state

    net = QNet(hidden=16, layers=1)
    path = tmp_path / "c.pt"
    save_checkpoint(path, net, step=3, config={})
    state = load_training_state(path)
    x = torch.randn(2, INPUT_DIM)
    assert state.optimizer is None and torch.allclose(state.raw(x), net(x))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_ema.py tests/test_model.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'fortytwo_ml.train.ema'` and `ImportError: cannot import name 'load_training_state'`.

- [ ] **Step 3: Implement**

`ml/src/fortytwo_ml/train/ema.py`:
```python
"""An exponential moving average of the learner's weights. Actors, the in-training eval and saved
checkpoints all use it: it moves slowly, so its action ranking isn't washed out by single noisy
updates the way the raw weights are."""
import copy

import torch

from ..model import QNet


def make_ema(model: QNet) -> QNet:
    ema = copy.deepcopy(model)
    ema.requires_grad_(False)
    return ema.eval()


@torch.no_grad()
def update_ema(ema: QNet, model: QNet, decay: float) -> None:
    for e, m in zip(ema.parameters(), model.parameters()):
        e.lerp_(m.detach(), 1.0 - decay)
```

In `ml/src/fortytwo_ml/model.py`:
- Add `from dataclasses import dataclass` to the imports.
- Replace `save_checkpoint` and `load_checkpoint` with the code below.
- Keep the Task 1 guard, now inside `_load`.

```python
def _cpu_state(model: QNet) -> dict:
    return {k: v.detach().cpu() for k, v in model.state_dict().items()}


def save_checkpoint(
    path: str | Path,
    model: QNet,
    step: int,
    config: dict,
    raw: QNet | None = None,
    optimizer: torch.optim.Optimizer | None = None,
) -> None:
    """`model` is what plays (the EMA during training). `raw` and `optimizer`, when given, are what
    `--resume` needs to carry on training exactly where it stopped."""
    data = {
        "model": _cpu_state(model),
        "hidden": model.hidden,
        "layers": model.layers,
        "input_dim": INPUT_DIM,
        "step": step,
        "config": config,
    }
    if raw is not None:
        data["raw"] = _cpu_state(raw)
    if optimizer is not None:
        data["optimizer"] = optimizer.state_dict()
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    torch.save(data, tmp)
    os.replace(tmp, path)


def _load(path: str | Path, device: str) -> dict:
    data = torch.load(path, map_location=device, weights_only=True)
    found = data.get("input_dim", 353)  # checkpoints from before input_dim was recorded had 353 inputs
    if found != INPUT_DIM:
        raise ValueError(
            f"{path} was trained with {found} model inputs but this code uses {INPUT_DIM}; "
            "it predates a feature change and can't be loaded"
        )
    return data


def _build(data: dict, weights: dict) -> QNet:
    model = QNet(data["hidden"], data["layers"])
    model.load_state_dict(weights)
    return model.eval()


def load_checkpoint(path: str | Path, device: str = "cpu") -> tuple[QNet, dict]:
    data = _load(path, device)
    return _build(data, data["model"]), {"step": data["step"], "config": data["config"]}


@dataclass(frozen=True)
class TrainingState:
    raw: QNet
    optimizer: dict | None
    step: int


def load_training_state(path: str | Path) -> TrainingState:
    data = _load(path, "cpu")
    return TrainingState(_build(data, data.get("raw", data["model"])), data.get("optimizer"), data["step"])
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ml && uv run pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add ml/src/fortytwo_ml/train/ema.py ml/src/fortytwo_ml/model.py ml/tests/test_ema.py ml/tests/test_model.py
git commit -m "ml: add EMA weights; checkpoints carry raw weights and optimizer state"
```

---

### Task 3: Learning diagnostics

**Files:**
- Create: `ml/src/fortytwo_ml/eval/diagnostics.py`
- Test: `ml/tests/test_diagnostics.py`

**Interfaces:**
- Consumes: `HeuristicBot`, `ContractSampler`, `DEFAULT_MIX`, `HandState`, `Phase`, `encode_actions`, `QNet`.
- Produces:
  - `DecisionSet(x: np.ndarray (N, INPUT_DIM) float32, starts: np.ndarray (n+1,) int64, heuristic: np.ndarray (n,) int64)`, with `len()` equal to n.
  - `build_decision_set(n: int, seed: int = 0) -> DecisionSet`.
  - `model_choices(model: QNet, ds: DecisionSet) -> np.ndarray (n,)`: the index within each decision. It runs on the model's device.
  - `agreement(a, b) -> float` and `chance_agreement(ds) -> float`.

- [ ] **Step 1: Write the failing tests**

`ml/tests/test_diagnostics.py`:
```python
import numpy as np
import torch

from fortytwo_ml.eval.diagnostics import agreement, build_decision_set, chance_agreement, model_choices
from fortytwo_ml.features import INPUT_DIM
from fortytwo_ml.model import QNet


def test_decision_set_shape_and_determinism():
    ds = build_decision_set(50, seed=3)
    assert len(ds) == 50 and ds.x.shape[1] == INPUT_DIM and ds.x.dtype == np.float32
    sizes = np.diff(ds.starts)
    assert ds.starts[0] == 0 and ds.starts[-1] == len(ds.x) and np.all(sizes >= 2)
    assert np.all(ds.heuristic < sizes)
    again = build_decision_set(50, seed=3)
    assert np.array_equal(ds.x, again.x) and np.array_equal(ds.heuristic, again.heuristic)


def test_chance_is_the_mean_of_one_over_choices():
    ds = build_decision_set(40, seed=1)
    assert np.isclose(chance_agreement(ds), np.mean(1 / np.diff(ds.starts)))
    assert 0 < chance_agreement(ds) <= 0.5


def test_model_choices_and_agreement():
    ds = build_decision_set(40, seed=2)
    net = QNet(hidden=8, layers=1)
    with torch.no_grad():
        for p in net.parameters():
            p.zero_()
    choices = model_choices(net, ds)  # all Q equal -> argmax picks the first candidate
    assert choices.shape == (40,) and np.all(choices == 0)
    assert agreement(choices, choices) == 1.0
    assert agreement(choices, ds.heuristic) == np.mean(ds.heuristic == 0)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_diagnostics.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'fortytwo_ml.eval.diagnostics'`.

- [ ] **Step 3: Implement**

`ml/src/fortytwo_ml/eval/diagnostics.py`:
```python
"""Is the model learning which domino to play? Scored on a fixed set of real decisions (heuristic
play, sampled contracts, only positions with more than one legal domino) so numbers are comparable
across a run:

- action stability: how often two versions of the model pick the same domino
- agreement with the heuristic: how often the model picks what HeuristicBot picks
- chance: how often a uniformly random pick would agree (the floor for both)
"""
import random
from dataclasses import dataclass

import numpy as np
import torch

from ..agents.heuristic_bot import HeuristicBot
from ..contracts import DEFAULT_MIX, ContractSampler
from ..engine.hand_state import HandState, Phase
from ..features import encode_actions
from ..model import QNet


@dataclass(frozen=True)
class DecisionSet:
    x: np.ndarray          # every decision's candidate rows, back to back
    starts: np.ndarray     # decision i's rows are x[starts[i]:starts[i + 1]]
    heuristic: np.ndarray  # index of HeuristicBot's choice within decision i

    def __len__(self) -> int:
        return len(self.heuristic)


def build_decision_set(n: int, seed: int = 0) -> DecisionSet:
    rng = random.Random(f"diagnostics:{seed}")
    sampler = ContractSampler(DEFAULT_MIX, rng)
    bot = HeuristicBot()
    rows: list[np.ndarray] = []
    starts = [0]
    picks: list[int] = []
    while len(picks) < n:
        order = list(range(28))
        rng.shuffle(order)
        contract = sampler.sample(order, rng.randrange(4))
        state = HandState.from_contract(order, contract.bidder, contract.bid, contract.trump)
        while state.phase is not Phase.DONE and len(picks) < n:
            seat, legal = state.to_act, state.legal_actions()
            choice = bot.play(state, seat)
            if len(legal) > 1:
                rows.append(encode_actions(state, seat, legal))
                starts.append(starts[-1] + len(legal))
                picks.append(legal.index(choice))
            state.apply(choice)
    return DecisionSet(np.concatenate(rows), np.array(starts, np.int64), np.array(picks, np.int64))


def model_choices(model: QNet, ds: DecisionSet) -> np.ndarray:
    device = next(model.parameters()).device
    with torch.no_grad():
        q = model(torch.from_numpy(ds.x).to(device)).float().cpu().numpy()
    return np.array([int(np.argmax(q[a:b])) for a, b in zip(ds.starts[:-1], ds.starts[1:])], np.int64)


def agreement(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean(a == b))


def chance_agreement(ds: DecisionSet) -> float:
    return float(np.mean(1.0 / np.diff(ds.starts)))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_diagnostics.py -q`, then `uv run pytest -q`.
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add ml/src/fortytwo_ml/eval/diagnostics.py ml/tests/test_diagnostics.py
git commit -m "ml: add action-stability and heuristic-agreement diagnostics"
```

---

### Task 4: Config, GPU replay buffer, and batched actor sends

**Files:**
- Modify: `ml/src/fortytwo_ml/train/config.py`, `ml/src/fortytwo_ml/train/buffer.py`, `ml/src/fortytwo_ml/train/actor.py`
- Modify: `ml/configs/stage1.yaml`, `ml/configs/smoke.yaml`
- Modify: `ml/tests/test_train_parts.py`

**Interfaces:**
- Consumes: `play_selfplay_hand`, `ContractSampler`, `QNet`.
- Produces:
  - New `TrainConfig` fields: `ema_decay: float = 0.999`, `max_replay_ratio: float = 4.0`, `actor_send_hands: int = 16`, `learner_threads: int = 2`, `max_seconds: float = 0.0`, `diag_decisions: int = 2000`.
  - New defaults: `lr = 1e-4`, `batch_size = 4096`, `total_steps = 200_000`, `alpha_decay_steps = 20_000`, `eval_every_steps = 2_000`.
  - `num_actors` becomes `actors or max(1, cpu_count // 2 - 1)`.
  - `replay_starved(cfg, consumed: int, added: int) -> bool`.
  - `ReplayBuffer(capacity, dim, device="cpu")` with `.add(x, marks, pdiff)` taking numpy arrays of any float dtype, and `.sample(n) -> (x float32 Tensor, marks Tensor, pdiff Tensor)` on its device. An empty buffer raises `ValueError`.
  - `actor.pack_hands(hands: list[tuple[np.ndarray, np.ndarray, np.ndarray]]) -> tuple[np.ndarray f16, np.ndarray f32, np.ndarray f32]`.
  - The queue item format is unchanged: `(x, marks, pdiff)`, now holding many hands, with `x` as float16.

- [ ] **Step 1: Write the failing tests**

In `ml/tests/test_train_parts.py`:
- Replace `test_configs_load` and `test_buffer_wraps_and_samples` with the code below.
- Append the new tests.
- Add `from fortytwo_ml.train.actor import pack_hands` and `replay_starved` (from `fortytwo_ml.train.config`) to the imports.

```python
def test_configs_load():
    stage1 = TrainConfig.from_yaml(CONFIGS / "stage1.yaml")
    assert stage1.device == "cuda" and stage1.contract_mix["heuristic"] == 0.7
    assert (stage1.lr, stage1.batch_size, stage1.ema_decay, stage1.max_replay_ratio) == (1e-4, 4096, 0.999, 4.0)
    assert (stage1.total_steps, stage1.alpha_decay_steps, stage1.eval_every_steps) == (200_000, 20_000, 2_000)
    assert (stage1.actor_send_hands, stage1.learner_threads, stage1.diag_decisions) == (16, 2, 2000)
    smoke = TrainConfig.from_yaml(CONFIGS / "smoke.yaml")
    assert smoke.device == "cpu" and smoke.num_actors == 2


def test_default_actor_count_leaves_a_physical_core_free(monkeypatch):
    monkeypatch.setattr("os.cpu_count", lambda: 16)
    assert TrainConfig().num_actors == 7
    monkeypatch.setattr("os.cpu_count", lambda: 2)
    assert TrainConfig().num_actors == 1


def test_replay_cap_is_cumulative_and_can_be_disabled():
    cfg = TrainConfig(max_replay_ratio=4.0)
    assert not replay_starved(cfg, consumed=4000, added=1000)
    assert replay_starved(cfg, consumed=4001, added=1000)
    assert not replay_starved(TrainConfig(max_replay_ratio=0), consumed=10**9, added=1)


def test_buffer_wraps_and_samples():
    buf = ReplayBuffer(capacity=10, dim=3)
    for i in range(4):
        buf.add(np.full((4, 3), i, np.float16), np.full(4, i, np.float32), np.zeros(4, np.float32))
    assert len(buf) == 10
    # slots 0-1 and 8-9 hold batch 2 (it wrapped), 2-5 batch 3, 6-7 what's left of batch 1
    assert buf._marks.tolist() == [2, 2, 3, 3, 3, 3, 1, 1, 2, 2]
    x, marks, pdiff = buf.sample(6)
    assert x.shape == (6, 3) and x.dtype == torch.float32 and marks.shape == (6,)
    assert set(marks.tolist()) <= {1.0, 2.0, 3.0}


def test_buffer_keeps_only_the_newest_rows_of_an_oversized_batch():
    buf = ReplayBuffer(capacity=4, dim=1)
    buf.add(np.arange(6, dtype=np.float32).reshape(6, 1), np.arange(6, dtype=np.float32), np.zeros(6, np.float32))
    assert len(buf) == 4 and sorted(buf._marks.tolist()) == [2, 3, 4, 5]


def test_empty_buffer_refuses_to_sample():
    with pytest.raises(ValueError):
        ReplayBuffer(capacity=4, dim=1).sample(1)


def test_pack_hands_concatenates_and_halves_the_rows():
    a = (np.ones((2, 3), np.float32), np.array([1, 1], np.float32), np.array([0.5, 0.5], np.float32))
    b = (np.zeros((3, 3), np.float32), np.array([-2, -2, -2], np.float32), np.zeros(3, np.float32))
    x, marks, pdiff = pack_hands([a, b])
    assert x.dtype == np.float16 and x.shape == (5, 3)
    assert marks.tolist() == [1, 1, -2, -2, -2] and pdiff.dtype == np.float32
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_train_parts.py -q`
Expected: FAIL with `ImportError: cannot import name 'pack_hands'`.

- [ ] **Step 3: Implement config**

In `ml/src/fortytwo_ml/train/config.py`:

1. Replace the fields from `actors` through `eval_deals` with the block below. It keeps `device`, `allow_cpu_fallback`, `seed` and `contract_mix` as they are.

```python
    actors: int = 0  # 0 = physical cores - 1, estimated as logical CPUs // 2 - 1
    epsilon: float = 0.05
    hidden: int = 512
    layers: int = 4
    lr: float = 1e-4
    batch_size: int = 4096
    buffer_size: int = 200_000
    min_buffer: int = 20_000
    weight_sync_every: int = 50
    total_steps: int = 200_000
    alpha0: float = 0.25
    alpha_decay_steps: int = 20_000
    ema_decay: float = 0.999          # actors, eval and checkpoints use these averaged weights
    max_replay_ratio: float = 4.0     # learner waits for data past this many uses per sample; 0 = off
    actor_send_hands: int = 16        # hands an actor batches into one queue item
    learner_threads: int = 2          # CPU threads for the learner process (leave the rest to actors)
    max_seconds: float = 0.0          # stop training after this long (bench-train); 0 = no limit
    log_every: int = 100
    checkpoint_minutes: float = 15.0
    eval_every_steps: int = 2_000
    eval_deals: int = 500
    diag_decisions: int = 2000        # decisions scored for eval/action_stability and agree_heuristic
```

2. Replace `num_actors`, and add `replay_starved` after `shaping_alpha`:

```python
    @property
    def num_actors(self) -> int:
        return self.actors or max(1, (os.cpu_count() or 2) // 2 - 1)
```

```python
def replay_starved(cfg: TrainConfig, consumed: int, added: int) -> bool:
    """True once the learner has used each sample more than max_replay_ratio times on average since
    the run started; it then waits for actors instead of training on stale data."""
    return cfg.max_replay_ratio > 0 and consumed > cfg.max_replay_ratio * added
```

- [ ] **Step 4: Implement the buffer**

Replace `ml/src/fortytwo_ml/train/buffer.py` with:
```python
import numpy as np
import torch


class ReplayBuffer:
    """A ring buffer of (input row, marks reward, point-difference) samples, kept on the training
    device so sampling costs no host work or host-to-device copy. Rows are float16 (almost all
    0/1)."""

    def __init__(self, capacity: int, dim: int, device: str | torch.device = "cpu"):
        self.capacity = capacity
        self.device = torch.device(device)
        self._x = torch.zeros((capacity, dim), dtype=torch.float16, device=self.device)
        self._marks = torch.zeros(capacity, dtype=torch.float32, device=self.device)
        self._pdiff = torch.zeros(capacity, dtype=torch.float32, device=self.device)
        self._pos = 0
        self._size = 0

    def __len__(self) -> int:
        return self._size

    def add(self, x: np.ndarray, marks: np.ndarray, pdiff: np.ndarray) -> None:
        n = len(marks)
        if n == 0:
            return
        if n > self.capacity:  # only the newest rows would survive anyway
            x, marks, pdiff, n = x[-self.capacity:], marks[-self.capacity:], pdiff[-self.capacity:], self.capacity
        xt = torch.from_numpy(np.ascontiguousarray(x, dtype=np.float16)).to(self.device)
        mt = torch.from_numpy(np.ascontiguousarray(marks, dtype=np.float32)).to(self.device)
        pt = torch.from_numpy(np.ascontiguousarray(pdiff, dtype=np.float32)).to(self.device)
        first = min(n, self.capacity - self._pos)
        self._write(self._pos, xt[:first], mt[:first], pt[:first])
        if first < n:
            self._write(0, xt[first:], mt[first:], pt[first:])
        self._pos = (self._pos + n) % self.capacity
        self._size = min(self._size + n, self.capacity)

    def _write(self, at: int, x: torch.Tensor, marks: torch.Tensor, pdiff: torch.Tensor) -> None:
        k = len(marks)
        self._x[at:at + k] = x
        self._marks[at:at + k] = marks
        self._pdiff[at:at + k] = pdiff

    def sample(self, n: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        if self._size == 0:
            raise ValueError("can't sample from an empty replay buffer")
        idx = torch.randint(0, self._size, (n,), device=self.device)
        return self._x[idx].float(), self._marks[idx], self._pdiff[idx]
```

- [ ] **Step 5: Implement batched actor sends**

In `ml/src/fortytwo_ml/train/actor.py`:
- Add `import time` and `import numpy as np`.
- Add `pack_hands` and `_SEND_SECONDS`.
- Replace `_actor_loop`'s `while` body with the batching version below. The setup lines above the loop don't change.

```python
_SEND_SECONDS = 0.25  # send what's batched at least this often, even below actor_send_hands


def pack_hands(hands: list[tuple[np.ndarray, np.ndarray, np.ndarray]]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Many hands' samples as one queue item: fewer pipe writes and unpickles for the learner."""
    x = np.concatenate([h[0] for h in hands]).astype(np.float16)
    marks = np.concatenate([h[1] for h in hands]).astype(np.float32)
    pdiff = np.concatenate([h[2] for h in hands]).astype(np.float32)
    return x, marks, pdiff
```

```python
    pending: list[tuple[np.ndarray, np.ndarray, np.ndarray]] = []
    last_send = time.monotonic()
    while not stop.is_set():
        if version.value != seen:
            # The learner may be mid-copy; a slightly torn read only perturbs one hand's policy.
            seen = version.value
            local.load_state_dict(shared.state_dict())
        hand = play_selfplay_hand(local, sampler, rng, cfg.epsilon)
        if len(hand[1]):
            pending.append(hand)
        if pending and (len(pending) >= cfg.actor_send_hands or time.monotonic() - last_send >= _SEND_SECONDS):
            batch, pending, last_send = pack_hands(pending), [], time.monotonic()
            try:
                queue.put(batch, timeout=1.0)
            except queue_module.Full:
                continue
```

- [ ] **Step 6: Update the configs**

`ml/configs/stage1.yaml`: set `lr: 0.0001`, `batch_size: 4096`, `total_steps: 200000`, `alpha_decay_steps: 20000`, `eval_every_steps: 2000`. Change the `actors` comment to `# 0 = physical cores - 1`. Add these lines after `alpha_decay_steps`:
```yaml
ema_decay: 0.999     # actors, eval and checkpoints use the averaged weights
max_replay_ratio: 4.0
actor_send_hands: 16
learner_threads: 2
diag_decisions: 2000
```

`ml/configs/smoke.yaml`: add
```yaml
actor_send_hands: 2
diag_decisions: 30
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_train_parts.py -q`, then `uv run pytest -q`.
Expected: `test_train_parts.py` passes.

`tests/test_train_smoke.py` may now FAIL, because `run.py` still calls `buffer.sample(batch, np_rng)` and puts numpy arrays through `torch.from_numpy`. That is expected and is fixed in Task 5. If it fails, note it in the report and commit anyway. Every other test must pass.

- [ ] **Step 8: Commit**

```bash
git add ml/src/fortytwo_ml/train/config.py ml/src/fortytwo_ml/train/buffer.py ml/src/fortytwo_ml/train/actor.py ml/configs ml/tests/test_train_parts.py
git commit -m "ml: GPU replay buffer, batched actor sends, replay cap and new training defaults"
```

---

### Task 5: Learner wiring (EMA, replay cap, diagnostics, threads, flat publish)

**Files:**
- Modify: `ml/src/fortytwo_ml/train/run.py`
- Modify: `ml/tests/test_train_smoke.py`

**Interfaces:**
- Consumes:
  - `make_ema`, `update_ema` (Task 2);
  - `save_checkpoint(..., raw, optimizer)`, `load_checkpoint`, `load_training_state` (Task 2);
  - `build_decision_set`, `model_choices`, `agreement`, `chance_agreement` (Task 3);
  - `ReplayBuffer(capacity, dim, device).sample(n)` and `replay_starved` (Task 4);
  - the new `TrainConfig` fields (Task 4).
- Produces:
  - `TrainSummary(steps, last_loss, checkpoint, train_seconds: float = 0.0, samples_while_training: int = 0)`;
  - `_publish(src: QNet, shared: QNet, version)`, which copies in place;
  - TensorBoard tags `eval/agree_chance`, `eval/agree_heuristic`, `eval/action_stability`;
  - `train()` honors `max_seconds`, measured from the first learner step.

- [ ] **Step 1: Write the failing tests**

Append to `ml/tests/test_train_smoke.py`. Add `import torch` and `from tensorboard.backend.event_processing.event_accumulator import EventAccumulator` to its imports.

```python
def test_publish_copies_in_place_into_shared_memory():
    import multiprocessing as std_mp

    from fortytwo_ml.model import QNet
    from fortytwo_ml.train.run import _cpu_copy, _publish

    src = QNet(hidden=16, layers=2)
    shared = _cpu_copy(QNet(hidden=16, layers=2))
    shared.share_memory()
    pointers = [p.data_ptr() for p in shared.parameters()]
    version = std_mp.Value("i", 0)
    _publish(src, shared, version)
    assert version.value == 1
    assert [p.data_ptr() for p in shared.parameters()] == pointers  # same storage: actors still see it
    for a, b in zip(shared.parameters(), src.parameters()):
        assert torch.equal(a, b.detach())


def test_smoke_run_logs_learning_diagnostics_and_restores_threads(tmp_path):
    cfg = TrainConfig.from_yaml(CONFIGS / "smoke.yaml")
    threads = torch.get_num_threads()
    train(cfg, tmp_path / "run")
    assert torch.get_num_threads() == threads
    ea = EventAccumulator(str(tmp_path / "run" / "tb"))
    ea.Reload()
    tags = set(ea.Tags()["scalars"])
    assert {"eval/agree_chance", "eval/agree_heuristic", "eval/action_stability"} <= tags


def test_checkpoint_carries_raw_and_optimizer_and_resume_uses_them(tmp_path):
    cfg = TrainConfig.from_yaml(CONFIGS / "smoke.yaml")
    first = train(cfg, tmp_path / "a")
    data = torch.load(first.checkpoint, weights_only=True)
    assert {"model", "raw", "optimizer"} <= set(data) and data["optimizer"]["state"]
    more = TrainConfig(**{**cfg.to_dict(), "total_steps": cfg.total_steps + 20})
    assert train(more, tmp_path / "b", resume=first.checkpoint).steps == cfg.total_steps + 20


def test_max_seconds_stops_training_early(tmp_path):
    cfg = TrainConfig(**{**TrainConfig.from_yaml(CONFIGS / "smoke.yaml").to_dict(),
                         "total_steps": 10**9, "max_seconds": 2.0, "eval_every_steps": 0})
    summary = train(cfg, tmp_path / "run")
    assert 0 < summary.steps < 10**9 and 2.0 <= summary.train_seconds < 30
    assert summary.samples_while_training > 0
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_train_smoke.py -q`
Expected: FAIL. Smoke runs crash at `buffer.sample(cfg.batch_size, np_rng)` (the signature changed in Task 4), and the diagnostics tags and `train_seconds` are missing.

- [ ] **Step 3: Implement**

In `ml/src/fortytwo_ml/train/run.py`:

1. Imports: keep `import numpy as np`, since `_drain` below uses `np.concatenate`. Change the model import to `from ..model import QNet, load_checkpoint, load_training_state, save_checkpoint`. Add:
```python
from ..eval.diagnostics import agreement, build_decision_set, chance_agreement, model_choices
from .config import TrainConfig, replay_starved, resolve_device, shaping_alpha
from .ema import make_ema, update_ema
```
(The `.config` line replaces the existing one.)

2. Replace `TrainSummary`, `_drain`, `_publish`, and the whole `train` function with the code below. `check_actors` and `_cpu_copy` stay as they are.

```python
@dataclass(frozen=True)
class TrainSummary:
    steps: int
    last_loss: float
    checkpoint: Path
    train_seconds: float = 0.0          # wall time from the first learner step to the end
    samples_while_training: int = 0     # samples ingested over that time


def _drain(queue, buffer: ReplayBuffer, block: bool) -> int:
    xs, marks, pdiffs = [], [], []
    for i in range(_MAX_DRAIN):
        try:
            x, m, p = queue.get(timeout=1.0) if (block and i == 0) else queue.get_nowait()
        except queue_module.Empty:
            break
        xs.append(x)
        marks.append(m)
        pdiffs.append(p)
    if not marks:
        return 0
    buffer.add(np.concatenate(xs), np.concatenate(marks), np.concatenate(pdiffs))  # one device copy
    return sum(len(m) for m in marks)


def _publish(src: QNet, shared: QNet, version) -> None:
    """One device-to-host copy of the whole weight vector, then in-place copies into the
    shared-memory parameters. In place matters: rebinding them would cut actors off from updates."""
    with torch.no_grad():
        flat = torch.nn.utils.parameters_to_vector(src.parameters()).detach().cpu()
        offset = 0
        for p in shared.parameters():
            n = p.numel()
            p.copy_(flat[offset:offset + n].view_as(p))
            offset += n
    version.value += 1


def _save(run_dir: Path, step: int, ema: QNet, model: QNet, optimizer, cfg: TrainConfig) -> None:
    for name in (f"ckpt-{step}.pt", "ckpt-latest.pt"):
        save_checkpoint(run_dir / name, ema, step, cfg.to_dict(), raw=model, optimizer=optimizer)


def train(cfg: TrainConfig, run_dir: Path, resume: Path | None = None) -> TrainSummary:
    run_dir = Path(run_dir)
    device = resolve_device(cfg)
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "config.yaml").write_text(yaml.safe_dump(cfg.to_dict(), sort_keys=False))
    torch.manual_seed(cfg.seed)
    previous_threads = torch.get_num_threads()
    torch.set_num_threads(cfg.learner_threads)  # the rest of the CPU belongs to the actors

    model = QNet(cfg.hidden, cfg.layers)
    step, optimizer_state, ema = 0, None, None
    if resume is not None:
        state = load_training_state(resume)
        model.load_state_dict(state.raw.state_dict())
        step, optimizer_state = state.step, state.optimizer
        ema = load_checkpoint(resume)[0].requires_grad_(False)
    model.to(device)
    ema = make_ema(model) if ema is None else ema.to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=cfg.lr)
    if optimizer_state is not None:
        optimizer.load_state_dict(optimizer_state)

    diag = build_decision_set(cfg.diag_decisions, cfg.seed) if cfg.eval_every_steps and cfg.diag_decisions else None
    previous_choices = None

    shared = _cpu_copy(ema)
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

    buffer = ReplayBuffer(cfg.buffer_size, INPUT_DIM, device)
    writer = SummaryWriter(str(run_dir / "tb"))
    if diag is not None:
        writer.add_scalar("eval/agree_chance", chance_agreement(diag), step)
    last_checkpoint = time.monotonic()
    window_start, window_samples, window_steps = time.monotonic(), 0, 0
    added_total, consumed, samples_while_training = 0, 0, 0
    train_start: float | None = None
    loss_value = float("nan")
    try:
        while step < cfg.total_steps:
            if cfg.max_seconds and train_start is not None and time.monotonic() - train_start >= cfg.max_seconds:
                break
            starved = replay_starved(cfg, consumed, added_total)
            added = _drain(queue, buffer, block=len(buffer) < cfg.min_buffer or starved)
            added_total += added
            window_samples += added
            if train_start is not None:
                samples_while_training += added
            check_actors(actors)
            if starved or len(buffer) < max(cfg.min_buffer, cfg.batch_size):
                continue
            if train_start is None:
                train_start = time.monotonic()

            x, marks, pdiff = buffer.sample(cfg.batch_size)
            q = model(x)
            loss = F.mse_loss(q, marks + shaping_alpha(cfg, step) * pdiff)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            update_ema(ema, model, cfg.ema_decay)
            step += 1
            window_steps += 1
            consumed += cfg.batch_size
            loss_value = loss.item()

            if step % cfg.weight_sync_every == 0:
                _publish(ema, shared, version)
            if step % cfg.log_every == 0:
                elapsed = max(time.monotonic() - window_start, 1e-9)
                writer.add_scalar("train/loss", loss_value, step)
                writer.add_scalar("train/mean_q", q.mean().item(), step)
                writer.add_scalar("train/alpha", shaping_alpha(cfg, step), step)
                writer.add_scalar("train/buffer", len(buffer), step)
                writer.add_scalar("train/samples_per_sec", window_samples / elapsed, step)
                writer.add_scalar("train/steps_per_sec", window_steps / elapsed, step)
                writer.add_scalar("train/replay_ratio", window_steps * cfg.batch_size / max(window_samples, 1), step)
                window_start, window_samples, window_steps = time.monotonic(), 0, 0
            if cfg.eval_every_steps and step % cfg.eval_every_steps == 0:
                result = evaluate_hands(ModelAgent(_cpu_copy(ema)), HeuristicBot(), cfg.eval_deals, seed=cfg.seed)
                writer.add_scalar("eval/marks_per_deal_vs_heuristic", mean_ci(result.deal_scores)[0], step)
                if diag is not None:
                    choices = model_choices(ema, diag)
                    writer.add_scalar("eval/agree_heuristic", agreement(choices, diag.heuristic), step)
                    if previous_choices is not None:
                        writer.add_scalar("eval/action_stability", agreement(choices, previous_choices), step)
                    previous_choices = choices
            if time.monotonic() - last_checkpoint >= cfg.checkpoint_minutes * 60:
                _save(run_dir, step, ema, model, optimizer, cfg)
                last_checkpoint = time.monotonic()
    finally:
        if step > 0:  # keep the work done so far on Ctrl+C or an actor failure
            try:
                _save(run_dir, step, ema, model, optimizer, cfg)
            except Exception as e:  # best effort; never mask the original error
                print(f"warning: could not save final checkpoint: {e}")
        stop.set()
        for p in actors:
            p.join(timeout=5)
            if p.is_alive():
                p.terminate()
        writer.close()
        torch.set_num_threads(previous_threads)

    latest = run_dir / "ckpt-latest.pt"
    if step == 0:  # nothing trained (total_steps already reached or 0): still leave a checkpoint
        save_checkpoint(latest, ema, step, cfg.to_dict(), raw=model, optimizer=optimizer)
    train_seconds = time.monotonic() - train_start if train_start is not None else 0.0
    return TrainSummary(step, loss_value, latest, train_seconds, samples_while_training)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_train_smoke.py -q`, then `uv run pytest -q`.
Expected: all pass. The existing `test_failed_run_still_saves_a_loadable_checkpoint` and `test_resume_continues_from_the_checkpoint_step` must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add ml/src/fortytwo_ml/train/run.py ml/tests/test_train_smoke.py
git commit -m "ml: learner uses EMA, replay cap, GPU buffer and learning diagnostics"
```

---

### Task 6: `ml bench-train`, README, and the throughput check

**Files:**
- Modify: `ml/src/fortytwo_ml/cli.py`, `ml/README.md`
- Modify: `ml/tests/test_cli.py`

**Interfaces:**
- Consumes: `TrainConfig`, and `train()` → `TrainSummary.train_seconds` / `samples_while_training` (Task 5).
- Produces: the CLI subcommand `ml bench-train --config PATH [--seconds S]`, which prints `learner steps/s: N` and `samples/s ingested: N`.

- [ ] **Step 1: Write the failing test**

Append to `ml/tests/test_cli.py`:
```python
def test_bench_train_reports_rates(capsys):
    from pathlib import Path

    smoke = Path(__file__).parent.parent / "configs" / "smoke.yaml"
    assert main(["bench-train", "--config", str(smoke), "--seconds", "3"]) == 0
    out = capsys.readouterr().out
    assert "learner steps/s:" in out and "samples/s ingested:" in out
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ml && uv run pytest tests/test_cli.py -q`
Expected: FAIL with an argparse error (`invalid choice: 'bench-train'`), shown as `SystemExit: 2`.

- [ ] **Step 3: Implement**

In `ml/src/fortytwo_ml/cli.py`, add the subparser after the `play-demo` one:
```python
    b = sub.add_parser("bench-train", help="measure training throughput (no eval, no replay cap)")
    b.add_argument("--config", required=True, type=Path)
    b.add_argument("--seconds", type=float, default=60)
```

Then add a branch before the final `else:` (the play-demo branch):
```python
    elif args.command == "bench-train":
        import dataclasses
        import tempfile

        from .train.config import TrainConfig
        from .train.run import train

        cfg = dataclasses.replace(
            TrainConfig.from_yaml(args.config),
            eval_every_steps=0, checkpoint_minutes=1e9, max_replay_ratio=0.0,
            max_seconds=args.seconds, total_steps=10**12,
        )
        with tempfile.TemporaryDirectory() as tmp:
            summary = train(cfg, Path(tmp) / "bench")
        seconds = summary.train_seconds or 1e-9
        print(f"actors: {cfg.num_actors}  batch: {cfg.batch_size}  measured over {summary.train_seconds:.0f}s of training")
        print(f"learner steps/s: {summary.steps / seconds:.1f}")
        print(f"samples/s ingested: {summary.samples_while_training / seconds:.0f}")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_cli.py -q`, then `uv run pytest -q`.
Expected: all pass.

- [ ] **Step 5: Update the README**

In `ml/README.md`:

1. In `## Commands`, change the training line and add bench-train:
```sh
uv run ml bench-train --config configs/stage1.yaml               # ~1 min: throughput check
uv run ml train --config configs/stage1.yaml --run-name stage1-b  # writes runs/stage1-b/
```

2. Add a section after `## Commands`:
````markdown
## Watching a run

TensorBoard's `eval/` tab shows whether the model is learning *which domino to play*, not just how
good a hand is:

- `eval/agree_chance`: how often a random pick would agree (the floor).
- `eval/action_stability`: how often this eval's model picks the same domino as the previous eval's.
- `eval/agree_heuristic`: how often it picks what the heuristic bot picks.

Within the first ~20k steps (about 25 minutes), both `action_stability` and `agree_heuristic`
should be clearly above `agree_chance`. If they aren't, stop: the run won't reach the Stage 1 bar
(see `docs/superpowers/specs/2026-09-30-ml-bots-stage1-learning-fixes-design.md`).

Actors play with, the eval scores, and checkpoints save an exponential moving average of the
learner's weights. Checkpoints also carry the raw weights and optimizer state for `--resume`.
Checkpoints from before the candidate features (the `stage1-a` run, 353 inputs) can't be loaded by
this code.
````

- [ ] **Step 6: Measure throughput on the GPU box**

Run: `cd ml && uv run ml bench-train --config configs/stage1.yaml --seconds 60`
Target: `samples/s ingested` ≥ 15000 and `learner steps/s` ≥ 60. Put the full output in the report.
- If either number is below target, don't tune anything beyond this plan. Report DONE_WITH_CONCERNS with the numbers.
- Then profile one short run of the learner process and include the top 12 functions by tottime. Save this as `../.superpowers/sdd/bench_prof.py`, which is git-ignored:

```python
import cProfile, dataclasses, pstats
from pathlib import Path
from fortytwo_ml.train.config import TrainConfig
from fortytwo_ml.train.run import train

if __name__ == "__main__":  # required: actors are spawned
    cfg = dataclasses.replace(TrainConfig.from_yaml("configs/stage1.yaml"), eval_every_steps=0,
                              max_replay_ratio=0.0, max_seconds=30, total_steps=10**12)
    prof = cProfile.Profile()
    prof.enable()
    train(cfg, Path("../.superpowers/sdd/bench-prof"))
    prof.disable()
    pstats.Stats(prof).sort_stats("tottime").print_stats(12)
```

  Run it with `uv run python ../.superpowers/sdd/bench_prof.py`.

- [ ] **Step 7: Commit**

```bash
git add ml/src/fortytwo_ml/cli.py ml/tests/test_cli.py ml/README.md
git commit -m "ml: add bench-train and document the learning diagnostics"
```

---

### Task 7: The `stage1-b` run (manual, on the GPU box)

Not code. The user runs this after Task 6.

- [ ] Run `cd ml && uv run ml train --config configs/stage1.yaml --run-name stage1-b` and `uv run tensorboard --logdir runs`.
- [ ] At about 20k steps, check `eval/action_stability` and `eval/agree_heuristic` against `eval/agree_chance`. If they are not clearly above it, stop the run and bring the numbers back. The next step would be the perfect-information teacher (a new spec).
- [ ] Otherwise let it finish, then run `uv run ml eval --a runs/stage1-b/ckpt-latest.pt --b heuristic --deals 5000 --matches 500` and check it against the Stage 1 bar in the README.
