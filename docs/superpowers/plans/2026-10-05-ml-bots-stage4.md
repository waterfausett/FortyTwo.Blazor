# ML Bots Stage 4 (Milestone 1: Bots Fill Seats) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the shipped ML bot (bidnet-2 bidding plus stage1-c play) inside the Cloudflare Worker, so players can seat ML bots in real games in production. The TypeScript bot must make exactly the Python bot's decisions.

**Architecture:**
- **Python** gains `ml export`, which writes the two networks as a float32 `bot.bin` plus a `bot.json` manifest, and `ml export-fixtures`, which writes a tiny model plus golden hands.
- **A new pure-TS package, `@fortytwo/bot`,** ports the encoder, the MLP forward pass, the bid rules and trump naming. It is proven against those fixtures by replaying them through `@fortytwo/rules`.
- **The Worker** loads the real weights via its ASSETS binding and drives bot moves with them, falling back to today's simple bots on any failure.

**Tech Stack:**
- Python 3.12, PyTorch, numpy, pytest, uv (`ml/`).
- TypeScript, vitest, npm workspaces, Cloudflare Workers, Durable Objects and static assets (`cloudflare/`).
- Git LFS.

**Spec:** `docs/superpowers/specs/2026-10-05-ml-bots-stage4-design.md`

## Global Constraints

- **Commands:** Python commands run from `ml/` as `uv run ...`. TS commands run from `cloudflare/` as `npm ... -w <package>`. No test may need a GPU, network, or the real (LFS) weights.
- **Workers Free plan:** 10 ms CPU per invocation. The timing bar is a decision p95 under **5 ms** in Node.
- **`bot.bin`:** every tensor as little-endian float32, back to back, with offsets that are multiples of 4.
- **`bot.json` fields:**
  - `format` 1;
  - `totalBytes`, `sha256`;
  - `playInputDim` 363, `bidInputLayout` 1;
  - `makeThreshold` 0.6, `overbidPartnerThreshold` 0.9;
  - `tensors {name: {shape, offset}}`;
  - `play.layers [{weight, bias}]` (ReLU between layers, none after the last);
  - `bid.body [{weight, bias}]` (ReLU after each), `bid.pointsHead`, `bid.binaryHead`;
  - `provenance`.
- **Real weights:** live in `cloudflare/apps/web/public/models/bot.{bin,json}`. The `.bin` is in Git LFS and the `.json` is in normal git.
- **Worker load checks:** the bin length equals `totalBytes`; the bin does not start with `version https://git-lfs`; `format`, `playInputDim` and `bidInputLayout` match. SHA-256 is **not** checked at runtime.
- **Trump naming (both Python and TS):**
  - the bot's own winning bid: the legal trump with the highest P(make) at the winning bid, from its table (first maximum, in option order);
  - a partner's plunge: the legal trump with the highest `table.high` entry (named suits 0–6 → index 0–6, follow-me → index 7; first maximum, in legal order).
- **After a hand is decided:** the bot plays its first legal domino with no inference. With exactly one legal domino it plays it with no inference, as Python's `ModelAgent` does.
- **Fallback:** any model load failure, inference error or illegal ML decision falls back to the simple `decideBid`/`decideTrump`/`decideDomino` for that action, with a `console.error` line. A load failure is logged once per isolate.
- **Kill switch:** `BOTS_ENABLED` replaces `AUTO_PLAY_BOTS`. Bots are enabled unless the value is exactly `'false'`.
- **Fixtures:** parity fixtures use only decisions whose margin is ≥ **1e-4**; hands with a closer call are redrawn. TS tolerances are:
  - **encodings:** exact, compared with `Math.fround`;
  - **Q-values and table entries:** `|a − b| ≤ 1e-5 · max(1, |b|)`;
  - **actions:** exact.
- **Commit trailer:** every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **An ML decision that is illegal or throws must not stall a match.** The rules functions throw on an illegal move inside the alarm. Pinned in Task 7 (`falls back when the ML decision is illegal`).
2. **A deploy with the LFS pointer instead of the weights, or with the SPA's `index.html` served for a missing `/models/bot.json`,** must fall back cleanly with one log line. Pinned in Task 3 (loader tests) and Task 7 (`missing model falls back`).
3. **Float noise near a decision boundary** (Q near-ties; P(make) near 0.6 or 0.9) must not make the parity tests flaky. Pinned in Task 2 (the margin filter) and checked by Task 5's replay.
4. **Low contracts** (3-domino tricks, the bidder's partner skipped) must still assign each played domino to the right seat. Pinned in Task 4 (`assigns seats in a Low trick`) and covered by Task 2's fixture coverage of every Low variant.
5. **A decided hand that humans keep playing** must have the bot play its first legal domino without inference. Pinned in Task 5 (`plays first legal once the hand is decided`).

---

### Task 1: Python: partner-plunge trump from the table, and `ml export`

**Files:**
- Modify: `ml/src/fortytwo_ml/agents/fast_bidder.py`, `ml/src/fortytwo_ml/cli.py`
- Create: `ml/src/fortytwo_ml/export.py`
- Test: `ml/tests/test_fast_bidder.py`, `ml/tests/test_export.py`

**Interfaces:**
- Produces, in `fortytwo_ml.export`:
  - `FORMAT = 1`
  - `write_bot(out_dir: Path, name: str, qnet: QNet, bidnet: BidNet, provenance: dict) -> dict`. It writes `<name>.bin` and `<name>.json` and returns the manifest.
  - `read_bot(out_dir: Path, name: str) -> tuple[QNet, BidNet, dict]`
- CLI: `ml export --play PATH --bidnet PATH --out DIR [--name bot]`.
- `FastBidder.trump` on a partner's plunge returns `max(legal, key=lambda t: table.high[HIGH_TRUMPS.index(t)])`.

- [ ] **Step 1: Write the failing tests**

Replace `test_partner_plunge_trump_is_the_heuristic_suit` in `ml/tests/test_fast_bidder.py` with:
```python
def test_partner_plunge_trump_is_the_best_42_level_table_entry():
    state = HandState.deal(deal_with({1: [(0, 0), (1, 1), (2, 2), (3, 3)]}), opener=0)
    for b in (PASS, PLUNGE, PASS, PASS):
        state.apply(b)
    high = np.full(8, 0.1)
    high[7] = 0.7  # follow-me is the namer's best 42-level option
    table = BidTable(np.full((7, 12), 0.1), high, np.full(3, 0.1), None)
    assert FastBidder(StubNet(table)).trump(state, 3) == Suit.NONE
```
Remove the now-unused `best_suit` import from that test file if nothing else uses it.

Create `ml/tests/test_export.py`:
```python
import json

import numpy as np
import torch

from fortytwo_ml.bidding.model import BidNet, encode_hands
from fortytwo_ml.export import FORMAT, read_bot, write_bot
from fortytwo_ml.features import INPUT_DIM
from fortytwo_ml.model import QNet


def _nets():
    torch.manual_seed(0)
    return QNet(hidden=16, layers=2).eval(), BidNet(hidden=8, layers=2).eval()


def test_write_bot_layout_and_round_trip(tmp_path):
    qnet, bidnet = _nets()
    manifest = write_bot(tmp_path, "bot", qnet, bidnet, {"source": "test"})
    assert manifest["format"] == FORMAT and manifest["playInputDim"] == INPUT_DIM and manifest["bidInputLayout"] == 1
    assert manifest["makeThreshold"] == 0.6 and manifest["overbidPartnerThreshold"] == 0.9
    assert len(manifest["play"]["layers"]) == 3 and len(manifest["bid"]["body"]) == 2
    bin_bytes = (tmp_path / "bot.bin").read_bytes()
    assert len(bin_bytes) == manifest["totalBytes"]
    assert all(t["offset"] % 4 == 0 for t in manifest["tensors"].values())
    assert json.loads((tmp_path / "bot.json").read_text()) == manifest

    q2, b2, _ = read_bot(tmp_path, "bot")
    x = torch.randn(5, INPUT_DIM)
    assert torch.equal(qnet(x), q2(x))
    hands = np.array([[0, 1, 2, 3, 4, 5, 6], [7, 13, 18, 22, 1, 2, 3]])
    xb = torch.from_numpy(encode_hands(hands))
    for a, b in zip(bidnet(xb), b2(xb)):
        assert torch.equal(a, b)


def test_tensor_order_is_little_endian_float32(tmp_path):
    qnet, bidnet = _nets()
    manifest = write_bot(tmp_path, "bot", qnet, bidnet, {})
    first = manifest["play"]["layers"][0]["weight"]
    t = manifest["tensors"][first]
    raw = np.frombuffer((tmp_path / "bot.bin").read_bytes(), dtype="<f4", count=int(np.prod(t["shape"])), offset=t["offset"])
    assert np.array_equal(raw.reshape(t["shape"]), qnet.net[0].weight.detach().numpy())
```
Append to `ml/tests/test_cli.py`:
```python
def test_export_refuses_a_bidnet_from_another_play_model(tmp_path):
    from fortytwo_ml.bidding.model import BidNet, save_bidnet

    play = tmp_path / "run" / "m.pt"
    play.parent.mkdir()
    save_checkpoint(play, QNet(hidden=16, layers=1), step=3, config={})
    bidnet = tmp_path / "b.pt"
    save_bidnet(bidnet, BidNet(hidden=8, layers=1), {"play_checkpoint": "run/m.pt", "play_path": str(play),
                                                    "play_step": 9, "train_hands": 1, "val_loss": 0.0, "gold": {}})
    with pytest.raises(ValueError, match="step 9"):
        main(["export", "--play", str(play), "--bidnet", str(bidnet), "--out", str(tmp_path / "out")])
    save_bidnet(bidnet, BidNet(hidden=8, layers=1), {"play_checkpoint": "run/m.pt", "play_path": str(play),
                                                    "play_step": 3, "train_hands": 1, "val_loss": 0.0, "gold": {}})
    assert main(["export", "--play", str(play), "--bidnet", str(bidnet), "--out", str(tmp_path / "out")]) == 0
    assert (tmp_path / "out" / "bot.bin").exists() and (tmp_path / "out" / "bot.json").exists()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_fast_bidder.py tests/test_export.py tests/test_cli.py -q`
Expected: FAIL. The plunge test gets the heuristic suit instead of `Suit.NONE`, and the others fail with `ModuleNotFoundError: fortytwo_ml.export` or argparse rejecting `export`.

- [ ] **Step 3: Implement the plunge change**

In `ml/src/fortytwo_ml/agents/fast_bidder.py`:
- Import `HIGH_TRUMPS` from `..sim.probe`.
- Drop the `best_suit` import.
- Replace the partner-plunge branch of `FastBidder.trump` with:
```python
        if state.high_bid == PLUNGE and state.bidder != seat:
            # Partner's plunge: the trump with the best chance of taking every point, from our own
            # hand's table (named suits, then follow-me; the first maximum wins a tie).
            table = self.bidnet.table(state.hand(seat))
            return max(legal, key=lambda t: table.high[HIGH_TRUMPS.index(t)])
```

- [ ] **Step 4: Implement `ml/src/fortytwo_ml/export.py`**

```python
"""Write the shipped bot's two networks for the TS Worker bot (cloudflare/packages/bot): one
little-endian float32 blob plus a JSON manifest naming every tensor's shape and byte offset."""
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
from torch import nn

from .bidding.model import INPUT_LAYOUT, BidNet
from .features import INPUT_DIM
from .model import QNet
from .sim.decide import DEFAULT_MAKE_THRESHOLD

FORMAT = 1
OVERBID_PARTNER_THRESHOLD = 0.9


def _linears(module: nn.Module) -> list[tuple[str, nn.Linear]]:
    return [(name, m) for name, m in module.named_modules() if isinstance(m, nn.Linear)]


def write_bot(out_dir: Path, name: str, qnet: QNet, bidnet: BidNet, provenance: dict) -> dict:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    tensors: dict[str, dict] = {}
    chunks: list[bytes] = []
    offset = 0

    def add(tname: str, t: torch.Tensor) -> str:
        nonlocal offset
        a = np.ascontiguousarray(t.detach().cpu().numpy().astype("<f4"))
        tensors[tname] = {"shape": list(a.shape), "offset": offset}
        chunks.append(a.tobytes())
        offset += a.nbytes
        return tname

    def dense(prefix: str, lin: nn.Linear) -> dict:
        return {"weight": add(f"{prefix}.weight", lin.weight), "bias": add(f"{prefix}.bias", lin.bias)}

    play = [dense(f"play.{n}", m) for n, m in _linears(qnet)]
    body = [dense(f"bid.body.{n}", m) for n, m in _linears(bidnet.body)]
    points_head = dense("bid.points_head", bidnet.points_head)
    binary_head = dense("bid.binary_head", bidnet.binary_head)
    blob = b"".join(chunks)
    manifest = {
        "format": FORMAT,
        "totalBytes": len(blob),
        "sha256": hashlib.sha256(blob).hexdigest(),
        "playInputDim": INPUT_DIM,
        "bidInputLayout": INPUT_LAYOUT,
        "makeThreshold": DEFAULT_MAKE_THRESHOLD,
        "overbidPartnerThreshold": OVERBID_PARTNER_THRESHOLD,
        "tensors": tensors,
        "play": {"layers": play},
        "bid": {"body": body, "pointsHead": points_head, "binaryHead": binary_head},
        "provenance": {**provenance, "exported": datetime.now(timezone.utc).isoformat(timespec="seconds")},
    }
    for path, data in ((out_dir / f"{name}.bin", blob), (out_dir / f"{name}.json", json.dumps(manifest, indent=1).encode())):
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)
    return manifest


def read_bot(out_dir: Path, name: str) -> tuple[QNet, BidNet, dict]:
    out_dir = Path(out_dir)
    manifest = json.loads((out_dir / f"{name}.json").read_text())
    blob = (out_dir / f"{name}.bin").read_bytes()

    def tensor(tname: str) -> torch.Tensor:
        t = manifest["tensors"][tname]
        a = np.frombuffer(blob, dtype="<f4", count=int(np.prod(t["shape"])), offset=t["offset"])
        return torch.from_numpy(a.reshape(t["shape"]).copy())

    def load(linears: list[tuple[str, nn.Linear]], refs: list[dict]) -> None:
        for (_, lin), ref in zip(linears, refs, strict=True):
            lin.weight.data.copy_(tensor(ref["weight"]))
            lin.bias.data.copy_(tensor(ref["bias"]))

    play, body = manifest["play"]["layers"], manifest["bid"]["body"]
    qnet = QNet(hidden=manifest["tensors"][play[0]["weight"]]["shape"][0], layers=len(play) - 1)
    bidnet = BidNet(hidden=manifest["tensors"][body[0]["weight"]]["shape"][0], layers=len(body))
    load(_linears(qnet), play)
    load(_linears(bidnet.body), body)
    load([("", bidnet.points_head)], [manifest["bid"]["pointsHead"]])
    load([("", bidnet.binary_head)], [manifest["bid"]["binaryHead"]])
    return qnet.eval(), bidnet.eval(), manifest
```

- [ ] **Step 5: Wire `ml export` into the CLI**

In `cli.py`, add the subparser:
```python
    x = sub.add_parser("export", help="Stage 4: write the bot's networks for the Worker (bot.bin + bot.json)")
    x.add_argument("--play", required=True, help="play checkpoint, e.g. runs/stage1-c/ckpt-latest.pt")
    x.add_argument("--bidnet", required=True, help="bidnet.pt from train-bids")
    x.add_argument("--out", required=True, type=Path, help="e.g. ../cloudflare/apps/web/public/models")
    x.add_argument("--name", default="bot")
```
and the branch:
```python
    elif args.command == "export":
        from .bidding.data import checkpoint_label
        from .export import write_bot
        from .model import load_checkpoint

        qnet, info = load_checkpoint(args.play)
        bidnet, meta = load_bidnet(args.bidnet)
        here = (checkpoint_label(args.play), info["step"])
        there = (meta.get("play_checkpoint"), meta.get("play_step"))
        if here != there:
            raise ValueError(f"{args.bidnet} was trained on simulations by {there[0]} (step {there[1]}), "
                             f"not {here[0]} (step {here[1]}); export the pair it was trained for")
        manifest = write_bot(args.out, args.name, qnet, bidnet, {
            "play": here[0], "playStep": here[1], "bidnet": str(args.bidnet), "bidnetTrainHands": meta.get("train_hands"),
        })
        print(f"wrote {args.out / (args.name + '.bin')} ({manifest['totalBytes']} bytes, sha256 {manifest['sha256'][:12]}...)")
```
Add `ml export` to the `cli.py` docstring.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_fast_bidder.py tests/test_export.py tests/test_cli.py -q`, then `uv run pytest -q`.
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add ml/src/fortytwo_ml/export.py ml/src/fortytwo_ml/agents/fast_bidder.py ml/src/fortytwo_ml/cli.py ml/tests/test_export.py ml/tests/test_fast_bidder.py ml/tests/test_cli.py
git commit -m "ml: export the bot for the Worker; partner-plunge trump from the bidnet table"
```

---

### Task 2: Python: `ml export-fixtures`, then generate and commit the fixtures

**Files:**
- Create: `ml/src/fortytwo_ml/export_fixtures.py`
- Modify: `ml/src/fortytwo_ml/cli.py`
- Test: `ml/tests/test_export_fixtures.py`
- Generated (committed): `cloudflare/packages/bot/test/fixtures/tiny-bot.bin`, `tiny-bot.json`, `hands.jsonl.gz`

**Interfaces:**
- Consumes: `write_bot` (Task 1), `FastBidder`, `ModelAgent`, `options_from_table`, `HIGH_TRUMPS`, `encode_actions`, `encode_hands`, `ContractSampler`, `contract_kind`.
- Produces `generate_fixtures(out_dir: Path, hands: int, seed: int, require_coverage: bool = True, log=print) -> dict`. It returns `{"hands", "dropped", "kinds", "low_trumps", "plunge_named"}`.
- **Fixture line schema** (one JSON object per hand):
  - `{"deal": [28 domino ids], "opener": int, "steps": [...]}`;
  - each step is `{"seat", "phase": "bid"|"trump"|"play", "action", "scripted": bool}`, plus:
    - **non-scripted bid:** `"bidInput": [36 floats], "table": {"points": [[12]×7], "high": [8], "low": [3], "plunge": float|null}`;
    - **play:** `"legal": [ids]` always; with ≥ 2 legal also `"features": [[[index, value], ...] per candidate], "q": [floats]`.
  - `action` is an int for bid and trump, and a domino id string such as `"3/5"` for play.

- [ ] **Step 1: Write the failing tests**

`ml/tests/test_export_fixtures.py`:
```python
import gzip
import json

from fortytwo_ml.export_fixtures import MARGIN, generate_fixtures


def _lines(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def test_fixtures_are_deterministic_per_seed(tmp_path):
    generate_fixtures(tmp_path / "a", hands=6, seed=3, require_coverage=False, log=lambda *_: None)
    generate_fixtures(tmp_path / "b", hands=6, seed=3, require_coverage=False, log=lambda *_: None)
    assert _lines(tmp_path / "a" / "hands.jsonl.gz") == _lines(tmp_path / "b" / "hands.jsonl.gz")
    assert (tmp_path / "a" / "tiny-bot.bin").read_bytes() == (tmp_path / "b" / "tiny-bot.bin").read_bytes()


def test_fixture_steps_carry_what_ts_checks(tmp_path):
    generate_fixtures(tmp_path, hands=6, seed=4, require_coverage=False, log=lambda *_: None)
    hands = _lines(tmp_path / "hands.jsonl.gz")
    assert len(hands) == 6 and all(len(h["deal"]) == 28 for h in hands)
    for h in hands:
        for s in h["steps"]:
            if s["phase"] == "bid" and not s["scripted"]:
                assert len(s["bidInput"]) == 36 and len(s["table"]["points"]) == 7
            if s["phase"] == "play" and len(s["legal"]) > 1:
                assert len(s["features"]) == len(s["q"]) == len(s["legal"])
                gap = sorted(s["q"], reverse=True)
                assert gap[0] - gap[1] >= MARGIN


def test_coverage_includes_every_contract_type(tmp_path):
    summary = generate_fixtures(tmp_path, hands=40, seed=0, log=lambda *_: None)
    assert {"points", "marks", "follow_me", "low", "plunge"} <= set(summary["kinds"])
    assert len(summary["low_trumps"]) == 3 and summary["plunge_named"] >= 1
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ml && uv run pytest tests/test_export_fixtures.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'fortytwo_ml.export_fixtures'`.

- [ ] **Step 3: Implement `ml/src/fortytwo_ml/export_fixtures.py`**

```python
"""Golden fixtures for the TS bot's parity tests: a tiny random bot (QNet and BidNet, hidden 16)
in the export format, and complete hands it played against itself, with what the TS bot must
reproduce at every decision. Every third hand forces an exotic contract (marks, follow-me, Low,
plunge) with a scripted auction, so every contract type and a partner naming plunge trump appear.
Hands with a decision closer than MARGIN are redrawn, so float noise can't flip the TS choice."""
import gzip
import io
import json
import math
import random
from pathlib import Path

import numpy as np
import torch

from .agents.fast_bidder import FastBidder
from .agents.model_agent import ModelAgent
from .bidding.model import BidNet, encode_hands
from .contracts import ContractSampler, contract_kind
from .engine.dominoes import domino_id
from .engine.enums import PASS, PLUNGE, is_low
from .engine.hand_state import HandState, Phase
from .export import OVERBID_PARTNER_THRESHOLD, write_bot
from .features import encode_actions
from .model import QNet
from .sim.decide import DEFAULT_MAKE_THRESHOLD
from .sim.probe import HIGH_TRUMPS, options_from_table

MARGIN = 1e-4
_SCRIPTED_MIX = {"marks": 1.0, "follow_me": 1.0, "low": 1.0, "plunge": 1.0}


def _gap(values: list[float]) -> float:
    ordered = sorted(values, reverse=True)
    return ordered[0] - ordered[1] if len(ordered) > 1 else math.inf


def _table_json(table) -> dict:
    return {"points": table.points.tolist(), "high": table.high.tolist(), "low": table.low.tolist(), "plunge": table.plunge}


class _Recorder:
    def __init__(self, qnet: QNet, bidnet: BidNet):
        self.bidder = FastBidder(bidnet, DEFAULT_MAKE_THRESHOLD, OVERBID_PARTNER_THRESHOLD)
        self.player = ModelAgent(qnet)
        self.qnet = qnet
        self.margin = math.inf

    def bid(self, state: HandState, seat: int) -> dict:
        hand = state.hand(seat)
        table = self.bidder.bidnet.table(hand)
        options = options_from_table(table, state.legal_actions())
        action = self.bidder.bid(state, seat)
        for o in options:
            self.margin = min(self.margin, abs(o.p_make - DEFAULT_MAKE_THRESHOLD), abs(o.p_make - OVERBID_PARTNER_THRESHOLD))
        for b in {o.bid for o in options}:
            self.margin = min(self.margin, _gap([o.p_make for o in options if o.bid == b]))
        return {"seat": seat, "phase": "bid", "action": int(action), "scripted": False,
                "bidInput": encode_hands(np.array([hand]))[0].tolist(), "table": _table_json(table)}

    def trump(self, state: HandState, seat: int) -> dict:
        legal = state.legal_actions()
        table = self.bidder.bidnet.table(state.hand(seat))
        if state.high_bid == PLUNGE and state.bidder != seat:
            candidates = [float(table.high[HIGH_TRUMPS.index(t)]) for t in legal]
        else:
            candidates = [o.p_make for o in options_from_table(table, [state.high_bid]) if o.trump in legal]
        self.margin = min(self.margin, _gap(candidates))
        return {"seat": seat, "phase": "trump", "action": int(self.bidder.trump(state, seat)), "scripted": False}

    def play(self, state: HandState, seat: int) -> dict:
        legal = state.legal_actions()
        step = {"seat": seat, "phase": "play", "legal": [domino_id(d) for d in legal], "scripted": False}
        if len(legal) > 1:
            rows = encode_actions(state, seat, legal)
            with torch.no_grad():
                q = self.qnet(torch.from_numpy(rows)).tolist()
            self.margin = min(self.margin, _gap(q))
            step["features"] = [[[int(i), float(row[i])] for i in np.nonzero(row)[0]] for row in rows]
            step["q"] = q
        step["action"] = domino_id(self.player.play(state, seat))
        return step


def _action_value(state: HandState, seat: int, step: dict) -> int:
    """A step's action as the engine's int: bids and trumps already are; plays are domino ids."""
    if step["phase"] != "play":
        return step["action"]
    return next(d for d in state.hand(seat) if domino_id(d) == step["action"])


def _play_hand(qnet: QNet, bidnet: BidNet, rng: random.Random, scripted: bool) -> tuple[dict, HandState] | None:
    if scripted:
        order, opener, contract = ContractSampler(_SCRIPTED_MIX, rng).sample_hand()
    else:
        order = list(range(28))
        rng.shuffle(order)
        opener, contract = rng.randrange(4), None
    state = HandState.deal(order, opener)
    rec = _Recorder(qnet, bidnet)
    steps = []
    while state.phase is not Phase.DONE:
        seat = state.to_act
        if state.phase is Phase.BID:
            if contract is not None:
                action = contract.bid if seat == contract.bidder else PASS
                step = {"seat": seat, "phase": "bid", "action": int(action), "scripted": True}
            else:
                step = rec.bid(state, seat)
        elif state.phase is Phase.TRUMP:
            if contract is not None and contract.bid != PLUNGE:
                step = {"seat": seat, "phase": "trump", "action": int(contract.trump), "scripted": True}
            else:
                step = rec.trump(state, seat)
        else:
            step = rec.play(state, seat)
        steps.append(step)
        state.apply(_action_value(state, seat, step))
        if rec.margin < MARGIN:
            return None
    return {"deal": [domino_id(d) for d in order], "opener": opener, "steps": steps}, state


def generate_fixtures(out_dir: Path, hands: int, seed: int, require_coverage: bool = True, log=print) -> dict:
    out_dir = Path(out_dir)
    torch.manual_seed(seed)
    qnet, bidnet = QNet(hidden=16, layers=1).eval(), BidNet(hidden=16, layers=1).eval()
    write_bot(out_dir, "tiny-bot", qnet, bidnet, {"tiny": True, "seed": seed})
    records, kinds, low_trumps = [], set(), set()
    plunge_named, dropped, i = 0, 0, 0

    def covered() -> bool:
        return {"points", "marks", "follow_me", "low", "plunge"} <= kinds and len(low_trumps) == 3 and plunge_named > 0

    while len(records) < hands or (require_coverage and not covered()):
        if i > 50 * max(hands, 20):
            raise RuntimeError(f"no full coverage after {i} hands: kinds={sorted(kinds)}, low={sorted(low_trumps)}")
        rng = random.Random(f"fixtures:{seed}:{i}")
        played = _play_hand(qnet, bidnet, rng, scripted=i % 3 == 2)
        i += 1
        if played is None:
            dropped += 1
            continue
        record, state = played
        records.append(record)
        kinds.add(contract_kind(state.contract))
        if is_low(state.trump):
            low_trumps.add(state.trump)
        if state.high_bid == PLUNGE:
            plunge_named += 1
    out_dir.mkdir(parents=True, exist_ok=True)
    # mtime=0 keeps the gzip header, and so the whole file, identical between runs with one seed.
    with gzip.GzipFile(out_dir / "hands.jsonl.gz", "wb", mtime=0) as raw, io.TextIOWrapper(raw, encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")
    summary = {"hands": len(records), "dropped": dropped, "kinds": sorted(kinds),
               "low_trumps": sorted(int(t) for t in low_trumps), "plunge_named": plunge_named}
    log(f"wrote {summary['hands']} hands ({dropped} redrawn for close calls); kinds {summary['kinds']}")
    return summary
```



- [ ] **Step 4: Wire the CLI**

```python
    f = sub.add_parser("export-fixtures", help="Stage 4: golden fixtures for the TS bot's parity tests")
    f.add_argument("--out", required=True, type=Path)
    f.add_argument("--hands", type=int, default=300)
    f.add_argument("--seed", type=int, default=0)
```
```python
    elif args.command == "export-fixtures":
        from .export_fixtures import generate_fixtures

        generate_fixtures(args.out, args.hands, args.seed)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ml && uv run pytest tests/test_export_fixtures.py tests/test_cli.py -q`, then `uv run pytest -q`.
Expected: all pass.

- [ ] **Step 6: Generate and commit the fixtures**

Run: `cd ml && uv run ml export-fixtures --out ../cloudflare/packages/bot/test/fixtures --hands 300 --seed 0`
Expected: about 300 hands, with every kind, all three Low variants and a positive `plunge_named` count. Check that `tiny-bot.bin` is roughly 30–40 KB. Put the printed summary in your report.

In the repo root `.gitattributes`, add `cloudflare/packages/bot/test/fixtures/*.bin binary` so line-ending normalization never touches the fixture blob.

- [ ] **Step 7: Commit**

```bash
git add ml/src/fortytwo_ml/export_fixtures.py ml/src/fortytwo_ml/cli.py ml/tests/test_export_fixtures.py .gitattributes cloudflare/packages/bot/test/fixtures
git commit -m "ml: export-fixtures writes a tiny bot and golden hands for the TS bot's parity tests"
```

---

### Task 3: `@fortytwo/bot` scaffold, weights loader, and MLP

**Files:**
- Create: `cloudflare/packages/bot/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/weights.ts`, `src/mlp.ts`, `test/fixtures.ts`, `test/weights.test.ts`, `test/mlp.test.ts`
- Modify: `cloudflare/package-lock.json` (via `npm install`)

**Interfaces:**
- Produces, in `@fortytwo/bot`:
  - `FORMAT`, `PLAY_INPUT_DIM = 363`, `BID_INPUT_LAYOUT = 1`, `class WeightsError extends Error`;
  - `interface Manifest` and `interface DenseRef { weight: string; bias: string }`;
  - `interface Dense { inDim: number; outDim: number; w: Float32Array; b: Float32Array }`, with `w` row-major `[outDim][inDim]` as torch stores it;
  - `interface BotWeights { manifest: Manifest; play: Dense[]; bidBody: Dense[]; pointsHead: Dense; binaryHead: Dense }`;
  - `loadWeights(manifest: unknown, bin: ArrayBuffer): BotWeights`, which throws `WeightsError`;
  - `dense(layer: Dense, x: ArrayLike<number>, relu: boolean): Float64Array`;
  - `scoreCandidates(play: Dense[], obsDim: number, rows: ArrayLike<number>[]): number[]`, in which all rows share the observation prefix `[0, obsDim)`.
- Test helper `test/fixtures.ts`: `fixtureWeights(): BotWeights`, `fixtureHands(): FixtureHand[]`, `type FixtureHand`, `type FixtureStep`.

- [ ] **Step 1: Scaffold the package**

`cloudflare/packages/bot/package.json`:
```json
{
  "name": "@fortytwo/bot",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "bench": "tsx bench/bench.ts"
  },
  "dependencies": { "@fortytwo/rules": "*" },
  "devDependencies": { "tsx": "^4.23.15", "typescript": "^5.6.0", "vitest": "^2.1.0" }
}
```
Copy `tsconfig.json` and `vitest.config.ts` from `cloudflare/packages/rules`, unchanged. Then run `cd cloudflare && npm install` and commit the lockfile change.

`test/fixtures.ts`:
```ts
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { loadWeights, type BotWeights } from '../src/index';

const dir = new URL('./fixtures/', import.meta.url);

export type FixtureStep = {
  seat: number;
  phase: 'bid' | 'trump' | 'play';
  action: number | string;
  scripted: boolean;
  bidInput?: number[];
  table?: { points: number[][]; high: number[]; low: number[]; plunge: number | null };
  legal?: string[];
  features?: [number, number][][];
  q?: number[];
};
export type FixtureHand = { deal: string[]; opener: number; steps: FixtureStep[] };

export function fixtureWeights(): BotWeights {
  const manifest = JSON.parse(readFileSync(new URL('tiny-bot.json', dir), 'utf8'));
  const buf = readFileSync(new URL('tiny-bot.bin', dir));
  return loadWeights(manifest, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

export function fixtureHands(): FixtureHand[] {
  return gunzipSync(readFileSync(new URL('hands.jsonl.gz', dir)))
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as FixtureHand);
}

export function tolerantEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(b));
}
```

- [ ] **Step 2: Write the failing tests**

`test/weights.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadWeights, WeightsError } from '../src/index';
import { fixtureWeights } from './fixtures';

const dir = new URL('./fixtures/', import.meta.url);
const manifest = () => JSON.parse(readFileSync(new URL('tiny-bot.json', dir), 'utf8'));
const bin = () => {
  const b = readFileSync(new URL('tiny-bot.bin', dir));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

describe('loadWeights', () => {
  it('reads the fixture bot with consistent layer sizes', () => {
    const w = fixtureWeights();
    expect(w.play[0].inDim).toBe(363);
    expect(w.play.at(-1)!.outDim).toBe(1);
    expect(w.bidBody[0].inDim).toBe(36);
    expect(w.pointsHead.outDim).toBe(98);
    expect(w.binaryHead.outDim).toBe(12);
  });

  it('rejects a Git LFS pointer instead of the weights', () => {
    const pointer = new TextEncoder().encode('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 6\n');
    expect(() => loadWeights(manifest(), pointer.buffer)).toThrow(/LFS pointer/);
  });

  it('rejects a bin of the wrong size', () => {
    expect(() => loadWeights(manifest(), bin().slice(4))).toThrow(WeightsError);
  });

  it('rejects an encoder layout this bot does not implement', () => {
    expect(() => loadWeights({ ...manifest(), playInputDim: 999 }, bin())).toThrow(/playInputDim/);
    expect(() => loadWeights({ ...manifest(), bidInputLayout: 2 }, bin())).toThrow(/bidInputLayout/);
    expect(() => loadWeights({ ...manifest(), format: 2 }, bin())).toThrow(/format/);
  });

  it('rejects something that is not a manifest', () => {
    expect(() => loadWeights('<!doctype html>', bin())).toThrow(WeightsError);
  });
});
```
`test/mlp.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { dense, scoreCandidates, type Dense } from '../src/index';

const layer = (inDim: number, outDim: number, w: number[], b: number[]): Dense => ({
  inDim, outDim, w: Float32Array.from(w), b: Float32Array.from(b),
});

describe('mlp', () => {
  it('computes Wx + b with optional ReLU', () => {
    const l = layer(2, 2, [1, 2, -3, 1], [0.5, 0]);
    expect(Array.from(dense(l, [1, 1], false))).toEqual([3.5, -2]);
    expect(Array.from(dense(l, [1, 1], true))).toEqual([3.5, 0]);
  });

  it('scores candidates sharing an observation prefix like a plain forward pass', () => {
    const l1 = layer(3, 2, [1, -1, 2, 0.5, 1, -1], [0, 1]);
    const l2 = layer(2, 1, [1, 2], [-1]);
    const rows = [[1, 0, 1], [1, 0, 0], [1, 0, 3]];
    const plain = rows.map((r) => dense(l2, dense(l1, r, true), false)[0]);
    expect(scoreCandidates([l1, l2], 2, rows)).toEqual(plain);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd cloudflare && npm test -w @fortytwo/bot`
Expected: FAIL. `src/index` doesn't exist yet.

- [ ] **Step 4: Implement `src/weights.ts`, `src/mlp.ts` and `src/index.ts`**

`src/weights.ts`:
```ts
// The exported bot (ml/src/fortytwo_ml/export.py): one little-endian float32 blob and a JSON
// manifest naming each tensor's shape and byte offset. Tensors become Float32Array views over the
// blob, with no copying or parsing, so loading is cheap enough for the Workers Free plan.
export const FORMAT = 1;
export const PLAY_INPUT_DIM = 363;
export const BID_INPUT_LAYOUT = 1;
const LFS_HEADER = 'version https://git-lfs';

export class WeightsError extends Error {}

export interface DenseRef { weight: string; bias: string }
export interface Manifest {
  format: number;
  totalBytes: number;
  sha256: string;
  playInputDim: number;
  bidInputLayout: number;
  makeThreshold: number;
  overbidPartnerThreshold: number;
  tensors: Record<string, { shape: number[]; offset: number }>;
  play: { layers: DenseRef[] };
  bid: { body: DenseRef[]; pointsHead: DenseRef; binaryHead: DenseRef };
  provenance: Record<string, unknown>;
}
export interface Dense { inDim: number; outDim: number; w: Float32Array; b: Float32Array }
export interface BotWeights { manifest: Manifest; play: Dense[]; bidBody: Dense[]; pointsHead: Dense; binaryHead: Dense }

export function loadWeights(raw: unknown, bin: ArrayBuffer): BotWeights {
  if (typeof raw !== 'object' || raw === null || !('tensors' in raw)) {
    throw new WeightsError('bot.json is not a bot manifest');
  }
  const manifest = raw as Manifest;
  if (manifest.format !== FORMAT) throw new WeightsError(`model format ${manifest.format}; this bot reads ${FORMAT}`);
  if (manifest.playInputDim !== PLAY_INPUT_DIM) {
    throw new WeightsError(`playInputDim ${manifest.playInputDim}; this bot's encoder makes ${PLAY_INPUT_DIM}`);
  }
  if (manifest.bidInputLayout !== BID_INPUT_LAYOUT) {
    throw new WeightsError(`bidInputLayout ${manifest.bidInputLayout}; this bot implements ${BID_INPUT_LAYOUT}`);
  }
  const head = new TextDecoder().decode(new Uint8Array(bin, 0, Math.min(bin.byteLength, LFS_HEADER.length)));
  if (head === LFS_HEADER) throw new WeightsError('bot.bin is a Git LFS pointer, not the weights (check out with LFS)');
  if (bin.byteLength !== manifest.totalBytes) {
    throw new WeightsError(`bot.bin is ${bin.byteLength} bytes; the manifest says ${manifest.totalBytes}`);
  }

  const tensor = (name: string) => {
    const t = manifest.tensors[name];
    if (!t) throw new WeightsError(`manifest names tensor ${name} but doesn't describe it`);
    const n = t.shape.reduce((a, b) => a * b, 1);
    if (t.offset % 4 !== 0 || t.offset + n * 4 > bin.byteLength) throw new WeightsError(`tensor ${name} is out of bounds`);
    return { shape: t.shape, data: new Float32Array(bin, t.offset, n) };
  };
  const dense = (ref: DenseRef): Dense => {
    const w = tensor(ref.weight);
    const b = tensor(ref.bias);
    if (w.shape.length !== 2 || b.shape.length !== 1 || b.shape[0] !== w.shape[0]) {
      throw new WeightsError(`layer ${ref.weight} has inconsistent shapes`);
    }
    return { outDim: w.shape[0], inDim: w.shape[1], w: w.data, b: b.data };
  };
  const chain = (layers: Dense[], inDim: number, what: string) => {
    let width = inDim;
    for (const l of layers) {
      if (l.inDim !== width) throw new WeightsError(`${what}: a layer takes ${l.inDim} inputs, expected ${width}`);
      width = l.outDim;
    }
    return width;
  };

  const play = manifest.play.layers.map(dense);
  if (chain(play, PLAY_INPUT_DIM, 'play network') !== 1) throw new WeightsError('play network must output one value');
  const bidBody = manifest.bid.body.map(dense);
  const width = chain(bidBody, 36, 'bid network');
  const pointsHead = dense(manifest.bid.pointsHead);
  const binaryHead = dense(manifest.bid.binaryHead);
  if (pointsHead.inDim !== width || pointsHead.outDim !== 7 * 14) throw new WeightsError('bid points head has the wrong shape');
  if (binaryHead.inDim !== width || binaryHead.outDim !== 12) throw new WeightsError('bid binary head has the wrong shape');
  return { manifest, play, bidBody, pointsHead, binaryHead };
}
```
`src/mlp.ts`:
```ts
import type { Dense } from './weights';

// y = Wx + b (W row-major [outDim][inDim], as torch stores it), with optional ReLU. Math is in
// float64; the Python model runs float32, so results agree to about 1e-6.
export function dense(layer: Dense, x: ArrayLike<number>, relu: boolean): Float64Array {
  const { inDim, outDim, w, b } = layer;
  const out = new Float64Array(outDim);
  for (let o = 0; o < outDim; o++) {
    let s = b[o];
    const row = o * inDim;
    for (let i = 0; i < inDim; i++) s += w[row + i] * x[i];
    out[o] = relu && s < 0 ? 0 : s;
  }
  return out;
}

// Adds W[:, from:to] · x[from:to] into acc, skipping zero inputs (encodings are mostly zeros).
function addColumns(layer: Dense, x: ArrayLike<number>, from: number, to: number, acc: Float64Array): void {
  const { inDim, outDim, w } = layer;
  for (let i = from; i < to; i++) {
    const v = x[i];
    if (v === 0) continue;
    for (let o = 0; o < outDim; o++) acc[o] += w[o * inDim + i] * v;
  }
}

// The play network's Q for each candidate row. Every row shares the observation prefix
// [0, obsDim), so that slice of the first layer is computed once for all candidates.
export function scoreCandidates(play: Dense[], obsDim: number, rows: ArrayLike<number>[]): number[] {
  const [first, ...rest] = play;
  const shared = Float64Array.from(first.b);
  addColumns(first, rows[0], 0, obsDim, shared);
  return rows.map((row) => {
    let h = Float64Array.from(shared);
    addColumns(first, row, obsDim, first.inDim, h);
    for (let o = 0; o < h.length; o++) if (h[o] < 0) h[o] = 0;
    rest.forEach((layer, k) => {
      h = dense(layer, h, k < rest.length - 1);
    });
    return h[0];
  });
}
```
The play network always has at least two layers (`QNet` has `layers ≥ 1` hidden layers plus the output layer), so the ReLU after layer 1 in `scoreCandidates` is always correct.

`src/index.ts`:
```ts
export { FORMAT, PLAY_INPUT_DIM, BID_INPUT_LAYOUT, WeightsError, loadWeights } from './weights';
export type { BotWeights, Dense, DenseRef, Manifest } from './weights';
export { dense, scoreCandidates } from './mlp';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd cloudflare && npm test -w @fortytwo/bot`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add cloudflare/packages/bot cloudflare/package-lock.json
git commit -m "bot: @fortytwo/bot package with the weights loader and MLP"
```

---

### Task 4: View and encoders (ports of `features.py` and `encode_hands`)

**Files:**
- Create: `cloudflare/packages/bot/src/dominoes.ts`, `src/view.ts`, `src/encode.ts`, `test/view.test.ts`, `test/encode.test.ts`
- Modify: `cloudflare/packages/bot/src/index.ts`

**Interfaces:**
- Consumes: `@fortytwo/rules` (`MatchState`, `Domino`, `createDomino`, `isOfSuit`, `getSuit`, `getSuitValue`, `isLow`, `trickValue`, `Bid`, `Suit`) and the fixtures helper (Task 3).
- Produces:
  - **`dominoes.ts`:**
    - `DOMINOES: Domino[]` (index → domino, Python's order `0/0, 0/1, … 6/6`);
    - `toIndex(d: Domino): number`;
    - `VALUE: number[]`, `IS_DOUBLE: boolean[]`.
  - **`view.ts`:**
    - `interface BotView { seat: number; hand: number[]; played: number[]; trick: [number, number][]; led: number | null; trump: number; highBid: number; bidder: number; voids: number[]; points: [number, number]; tricks: number; sitsOut: number | null }`;
    - `buildView(match: MatchState, playerId: string): BotView`, valid in the play phase;
    - `seatOf(match: MatchState, playerId: string): number`.
  - **`encode.ts`:**
    - the constants `OBS_DIM = 325` and `INPUT_DIM = 363`;
    - `encodeCandidates(view: BotView, legal: number[]): Float64Array[]` (one full 363-float row per candidate);
    - `encodeHand(hand: number[]): Float64Array` (36 floats).

- [ ] **Step 1: Write the failing tests**

`test/encode.test.ts` checks every fixture decision, with the encoder run through replay. The replay helper lives here so Task 5 can reuse it. Create `test/replay.ts`:
```ts
import {
  createDomino, createMatch, placeBid, playDomino, setTrump, takeSeat, type Domino, type MatchState,
} from '@fortytwo/rules';
import type { FixtureHand, FixtureStep } from './fixtures';

export const PLAYERS = ['p0', 'p1', 'p2', 'p3'];

export function dominoFromId(id: string): Domino {
  const [a, b] = id.split('/').map(Number);
  return createDomino(a, b);
}

export function startHand(h: FixtureHand): MatchState {
  const deal = h.deal.map(dominoFromId);
  let match = createMatch(PLAYERS[0]);
  for (let seat = 1; seat < 4; seat++) match = takeSeat(match, PLAYERS[seat], seat, seat === 3 ? deal : undefined);
  return {
    ...match,
    currentGame: { ...match.currentGame, firstActionBy: PLAYERS[h.opener], currentPlayerId: PLAYERS[h.opener] },
  };
}

export function applyStep(match: MatchState, s: FixtureStep): MatchState {
  const id = PLAYERS[s.seat];
  if (s.phase === 'bid') return placeBid(match, id, s.action as number);
  if (s.phase === 'trump') return setTrump(match, id, s.action as number);
  return playDomino(match, id, dominoFromId(s.action as string));
}
```
`test/encode.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildView, encodeCandidates, encodeHand, toIndex, DOMINOES } from '../src/index';
import { fixtureHands } from './fixtures';
import { PLAYERS, applyStep, dominoFromId, startHand } from './replay';

const sparse = (row: Float64Array) => {
  const out: [number, number][] = [];
  row.forEach((v, i) => { if (v !== 0) out.push([i, Math.fround(v)]); });
  return out;
};

describe('encoders match features.py on every fixture decision', () => {
  it('domino indices follow Python order', () => {
    expect(DOMINOES.map((d) => d.id).slice(0, 8)).toEqual(['0/0', '0/1', '0/2', '0/3', '0/4', '0/5', '0/6', '1/1']);
    expect(toIndex(dominoFromId('6/6'))).toBe(27);
  });

  it('play encodings', () => {
    let checked = 0;
    for (const h of fixtureHands()) {
      let match = startHand(h);
      for (const s of h.steps) {
        if (s.phase === 'play' && s.features) {
          const view = buildView(match, PLAYERS[s.seat]);
          const rows = encodeCandidates(view, s.legal!.map((id) => toIndex(dominoFromId(id))));
          rows.forEach((row, k) => expect(sparse(row)).toEqual(s.features![k].map(([i, v]) => [i, Math.fround(v)])));
          checked++;
        }
        match = applyStep(match, s);
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('bid encodings', () => {
    for (const h of fixtureHands()) {
      let match = startHand(h);
      for (const s of h.steps) {
        if (s.phase === 'bid' && s.bidInput) {
          const hand = match.currentGame.hands.find((x) => x.playerId === PLAYERS[s.seat])!.dominoes.map(toIndex);
          expect(Array.from(encodeHand(hand), Math.fround)).toEqual(s.bidInput.map(Math.fround));
        }
        match = applyStep(match, s);
      }
    }
  });
});
```
`test/view.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Bid, Suit, isLow } from '@fortytwo/rules';
import { buildView } from '../src/index';
import { fixtureHands } from './fixtures';
import { PLAYERS, applyStep, startHand } from './replay';

describe('buildView', () => {
  it('assigns seats in a Low trick, skipping the bidder\'s partner', () => {
    const h = fixtureHands().find((x) => x.steps.some((s) => s.phase === 'trump' && isLow(s.action as Suit)))!;
    let match = startHand(h);
    let checked = false;
    for (const s of h.steps) {
      if (s.phase === 'play' && match.currentGame.trump !== null) {
        const view = buildView(match, PLAYERS[s.seat]);
        expect(view.sitsOut).toBe((view.bidder + 2) % 4);
        expect(view.trick.every(([seat]) => seat !== view.sitsOut)).toBe(true);
        expect(s.seat).not.toBe(view.sitsOut);
        checked = true;
      }
      match = applyStep(match, s);
    }
    expect(checked).toBe(true);
  });

  it('the plunge namer leads the first trick', () => {
    const h = fixtureHands().find((x) => x.steps.some((s) => s.phase === 'bid' && s.action === Bid.Plunge))!;
    let match = startHand(h);
    for (const s of h.steps) {
      if (s.phase === 'play') {
        const view = buildView(match, PLAYERS[s.seat]);
        expect(s.seat).toBe((view.bidder + 2) % 4);
        break;
      }
      match = applyStep(match, s);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd cloudflare && npm test -w @fortytwo/bot`
Expected: FAIL, because `buildView`, `encodeCandidates` and the others are not exported.

- [ ] **Step 3: Implement `src/dominoes.ts`**

```ts
import { createDomino, type Domino } from '@fortytwo/rules';

// Dominoes as ints 0..27 in the ML engine's order (0/0, 0/1, ... 6/6), which the encoder's one-hots use.
export const DOMINOES: Domino[] = [];
for (let lo = 0; lo <= 6; lo++) for (let hi = lo; hi <= 6; hi++) DOMINOES.push(createDomino(lo, hi));

export function toIndex(d: Domino): number {
  const lo = Math.min(d.top, d.bottom);
  const hi = Math.max(d.top, d.bottom);
  return lo * 7 - (lo * (lo - 1)) / 2 + (hi - lo);
}

export const VALUE = DOMINOES.map((d) => ((d.top + d.bottom) % 5 === 0 ? d.top + d.bottom : 0));
export const IS_DOUBLE = DOMINOES.map((d) => d.top === d.bottom);
export const FULL_MASK = 2 ** 28 - 1;
```
Masks are plain numbers with 28 bits. Use `>>> 0` after `|=` where needed; JS bitwise operators are 32-bit, so 28 bits are safe.

- [ ] **Step 4: Implement `src/view.ts`**

```ts
// What features.py reads from the Python HandState, rebuilt from a TS MatchState. A TS Trick
// lists its dominoes in play order, not by seat, so seats come from turn order: the trump namer
// (the plunger's partner on a Plunge, else the bidder) leads the first trick, each trick's winner
// leads the next, and under Low the bidder's partner sits out and is skipped.
import { Bid, isLow, isOfSuit, trickValue, type Domino, type MatchState, type Suit } from '@fortytwo/rules';
import { toIndex } from './dominoes';

export interface BotView {
  seat: number;
  hand: number[];
  played: number[];
  trick: [number, number][];
  led: number | null;
  trump: number;
  highBid: number;
  bidder: number;
  voids: number[];
  points: [number, number];
  tricks: number;
  sitsOut: number | null;
}

export function seatOf(match: MatchState, playerId: string): number {
  return match.players.find((p) => p.playerId === playerId)!.position;
}

export function buildView(match: MatchState, playerId: string): BotView {
  const game = match.currentGame;
  const seat = seatOf(match, playerId);
  const bidder = seatOf(match, game.biddingPlayerId!);
  const trump = game.trump! as number;
  const sitsOut = isLow(game.trump) ? (bidder + 2) % 4 : null;
  const next = (s: number) => {
    const n = (s + 1) % 4;
    return n === sitsOut ? (n + 1) % 4 : n;
  };
  const played = [0, 0, 0, 0];
  const voids = [0, 0, 0, 0];
  const points: [number, number] = [0, 0];

  let leader = game.bid === Bid.Plunge ? (bidder + 2) % 4 : bidder;
  const replay = (dominoes: (Domino | null)[], suit: Suit | null): [number, number][] => {
    const plays: [number, number][] = [];
    let s = leader;
    for (const d of dominoes) {
      if (d === null) break;
      if (plays.length > 0 && !isOfSuit(d, suit!, game.trump)) voids[s] |= 1 << suit!;
      const i = toIndex(d);
      played[s] |= 1 << i;
      plays.push([s, i]);
      s = next(s);
    }
    return plays;
  };
  for (const t of game.tricks) {
    replay(t.dominoes, t.suit);
    const winner = seatOf(match, t.playerId!);
    points[winner % 2] += trickValue(t);
    leader = winner;
  }
  const trick = replay(game.currentTrick.dominoes, game.currentTrick.suit);

  return {
    seat,
    hand: game.hands.find((h) => h.playerId === playerId)!.dominoes.map(toIndex),
    played,
    trick,
    led: game.currentTrick.suit,
    trump,
    highBid: game.bid!,
    bidder,
    voids,
    points,
    tricks: game.tricks.length,
    sitsOut,
  };
}
```

- [ ] **Step 5: Implement `src/encode.ts`**

```ts
// A port of ml/src/fortytwo_ml/features.py (play) and bidding/model.encode_hands (bid). Layouts,
// orders and scalings must match exactly: test/encode.test.ts checks every fixture decision.
import { getSuit, getSuitValue, isOfSuit, type Suit } from '@fortytwo/rules';
import { DOMINOES, FULL_MASK, IS_DOUBLE, VALUE } from './dominoes';
import type { BotView } from './view';

export const HAND = 0;
export const PLAYED = HAND + 28;
export const TRICK = PLAYED + 4 * 28;
export const LED = TRICK + 4 * 28;
export const TRUMP = LED + 9;
export const BID = TRUMP + 11;
export const BIDDER = BID + 20;
export const PLUNGE_FLAG = BIDDER + 4;
export const SITS_OUT = PLUNGE_FLAG + 1;
export const VOIDS = SITS_OUT + 1;
export const SCALARS = VOIDS + 24;
export const OBS_DIM = SCALARS + 3;
const ACTION_ONEHOT = 28;
export const INPUT_DIM = OBS_DIM + ACTION_ONEHOT + 10;
const [A_IS_TRUMP, A_IS_DOUBLE, A_COUNT, A_FOLLOWS, A_RANK, A_WINS_NOW, A_OVERTAKES_PARTNER, A_BOSS, A_TRICK_POINTS, A_CLOSES] =
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const MAX_RANK = 18;
export const ALL_TRUMPS = [0, 1, 2, 3, 4, 5, 6, -1, -2, -3, -4];
export const CONTRACT_BIDS = [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 84, 126, 168, 169, 210, 252, 294];
const PLUNGE = 169;

const rank = (d: number, led: number, trump: number) => getSuitValue(DOMINOES[d], led as Suit, trump as Suit);
const isTrump = (d: number, trump: number) => trump >= 0 && trump <= 6 && isOfSuit(DOMINOES[d], trump as Suit);

function bits(x: Float64Array, offset: number, mask: number): void {
  for (let d = 0; d < 28; d++) if ((mask >>> d) & 1) x[offset + d] = 1;
}

function observation(v: BotView): Float64Array {
  const x = new Float64Array(INPUT_DIM);
  const rel = (s: number) => (s - v.seat + 4) % 4;
  for (const d of v.hand) x[HAND + d] = 1;
  for (let s = 0; s < 4; s++) bits(x, PLAYED + rel(s) * 28, v.played[s]);
  for (const [s, d] of v.trick) x[TRICK + rel(s) * 28 + d] = 1;
  x[LED + (v.led === null ? 8 : v.led)] = 1;
  x[TRUMP + ALL_TRUMPS.indexOf(v.trump)] = 1;
  x[BID + CONTRACT_BIDS.indexOf(v.highBid)] = 1;
  x[BIDDER + rel(v.bidder)] = 1;
  x[PLUNGE_FLAG] = v.highBid === PLUNGE ? 1 : 0;
  x[SITS_OUT] = v.sitsOut === (v.seat + 2) % 4 ? 1 : 0;
  for (let s = 0; s < 4; s++) {
    if (s === v.seat) continue;
    for (let led = 0; led < 8; led++) if ((v.voids[s] >>> led) & 1) x[VOIDS + (rel(s) - 1) * 8 + led] = 1;
  }
  const team = v.seat % 2;
  x[SCALARS] = v.points[team] / 42;
  x[SCALARS + 1] = v.points[1 - team] / 42;
  x[SCALARS + 2] = v.tricks / 7;
  return x;
}

export function encodeCandidates(v: BotView, legal: number[]): Float64Array[] {
  const obs = observation(v);
  const { trump, led } = v;
  let bestSeat: number | null = null;
  let bestRank = 0;
  if (v.trick.length > 0) {
    let best = 0;
    const ranks = v.trick.map(([, d]) => rank(d, led!, trump));
    for (let i = 1; i < ranks.length; i++) if (ranks[i] > ranks[best]) best = i;
    bestSeat = v.trick[best][0];
    bestRank = ranks[best];
  }
  let seen = 0;
  for (const d of v.hand) seen |= 1 << d;
  for (const m of v.played) seen |= m;
  const unseen = FULL_MASK & ~seen;
  const table = v.trick.reduce((sum, [, d]) => sum + VALUE[d], 0);
  const size = v.sitsOut === null ? 4 : 3;
  const f = OBS_DIM + ACTION_ONEHOT;

  return legal.map((d) => {
    const row = Float64Array.from(obs);
    row[OBS_DIM + d] = 1;
    row[f + A_IS_TRUMP] = isTrump(d, trump) ? 1 : 0;
    row[f + A_IS_DOUBLE] = IS_DOUBLE[d] ? 1 : 0;
    row[f + A_COUNT] = VALUE[d] / 10;
    row[f + A_TRICK_POINTS] = (table + VALUE[d] + 1) / 42;
    if (led !== null) {
      const r = rank(d, led, trump);
      const wins = r > bestRank;
      row[f + A_FOLLOWS] = isOfSuit(DOMINOES[d], led as Suit, trump as Suit) ? 1 : 0;
      row[f + A_RANK] = r > -1 ? (r + 1) / MAX_RANK : 0;
      row[f + A_WINS_NOW] = wins ? 1 : 0;
      row[f + A_OVERTAKES_PARTNER] = wins && bestSeat === (v.seat + 2) % 4 ? 1 : 0;
      row[f + A_CLOSES] = v.trick.length + 1 === size ? 1 : 0;
    } else {
      const own = getSuit(DOMINOES[d], trump as Suit);
      const r = rank(d, own, trump);
      row[f + A_RANK] = (r + 1) / MAX_RANK;
      let outranked = false;
      for (let u = 0; u < 28 && !outranked; u++) {
        if ((unseen >>> u) & 1 && isOfSuit(DOMINOES[u], own, trump as Suit) && rank(u, own, trump) > r) outranked = true;
      }
      row[f + A_BOSS] = outranked ? 0 : 1;
    }
    return row;
  });
}

// BidNet's input (bidding/model.encode_hands): 28 domino bits, dominoes per suit / 7, doubles / 7.
export function encodeHand(hand: number[]): Float64Array {
  const x = new Float64Array(36);
  const perSuit = [0, 0, 0, 0, 0, 0, 0];
  let doubles = 0;
  for (const d of hand) {
    x[d] = 1;
    const { top, bottom } = DOMINOES[d];
    for (let s = 0; s < 7; s++) if (top === s || bottom === s) perSuit[s]++;
    if (top === bottom) doubles++;
  }
  // Count, then divide once, as encode_hands does, so the values match its float32 exactly.
  perSuit.forEach((n, s) => { x[28 + s] = n / 7; });
  x[35] = doubles / 7;
  return x;
}
```

The `size` local above uses `v.sitsOut === null`, which matches Python's `3 if is_low(trump) else 4`, because `sitsOut` is set exactly when trump is Low.

Export `buildView`, `seatOf`, `type BotView`, `encodeCandidates`, `encodeHand`, `OBS_DIM`, `INPUT_DIM`, `DOMINOES` and `toIndex` from `src/index.ts`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd cloudflare && npm test -w @fortytwo/bot`
Expected: all pass. If an encoding mismatches, fix the TS port, never the fixture. Report the first mismatching index and its features.py slot.

- [ ] **Step 7: Commit**

```bash
git add cloudflare/packages/bot
git commit -m "bot: view and encoders, ported from features.py and checked against fixtures"
```

---

### Task 5: Bidding, trump and play decisions, plus full fixture replay

**Files:**
- Create: `cloudflare/packages/bot/src/bidding.ts`, `src/bot.ts`, `test/bot.test.ts`
- Modify: `cloudflare/packages/bot/src/index.ts`

**Interfaces:**
- Consumes:
  - from Tasks 3–4: `BotWeights`, `dense`, `scoreCandidates`, `buildView`, `seatOf`, `encodeCandidates`, `encodeHand`, `OBS_DIM`, `toIndex`, `DOMINOES`;
  - from `@fortytwo/rules`: `availableBids`, `availableTrumps`, `gameWinningTeam`, `isOfSuit`.
- Produces:
  - **`bidding.ts`:**
    - `interface BidTable { points: number[][]; high: number[]; low: number[]; plunge: number | null }`;
    - `bidTable(w: BotWeights, hand: number[]): BidTable`;
    - `interface Option { bid: number; trump: number; pMake: number }`;
    - `optionsFromTable(table: BidTable, legal: number[]): Option[]`;
    - `interface BidContext { legal: number[]; partnerHolds: boolean; lastToBid: boolean }`;
    - `chooseBid(options: Option[], ctx: BidContext, cfg: { makeThreshold: number; overbidPartnerThreshold: number }): { bid: number; trump: number | null; pMake: number | null }`.
  - **`bot.ts`:**
    - `interface Bot { decideBid(match: MatchState, playerId: string): Bid; decideTrump(match: MatchState, playerId: string): Suit; decideDomino(match: MatchState, playerId: string): Domino }`;
    - `createBot(w: BotWeights): Bot`.

- [ ] **Step 1: Write the failing tests**

`test/bot.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { gameWinningTeam } from '@fortytwo/rules';
import { bidTable, createBot, toIndex } from '../src/index';
import { fixtureHands, fixtureWeights, tolerantEqual } from './fixtures';
import { PLAYERS, applyStep, dominoFromId, startHand } from './replay';

describe('the TS bot makes the Python bot\'s decisions', () => {
  const w = fixtureWeights();
  const bot = createBot(w);

  it('replays every fixture hand', () => {
    const counts = { bid: 0, trump: 0, play: 0 };
    for (const h of fixtureHands()) {
      let match = startHand(h);
      for (const s of h.steps) {
        const id = PLAYERS[s.seat];
        if (!s.scripted) {
          if (s.phase === 'bid') {
            const hand = match.currentGame.hands.find((x) => x.playerId === id)!.dominoes.map(toIndex);
            const t = bidTable(w, hand);
            t.points.flat().forEach((p, i) => expect(tolerantEqual(p, s.table!.points.flat()[i])).toBe(true));
            t.high.forEach((p, i) => expect(tolerantEqual(p, s.table!.high[i])).toBe(true));
            t.low.forEach((p, i) => expect(tolerantEqual(p, s.table!.low[i])).toBe(true));
            expect(t.plunge === null).toBe(s.table!.plunge === null);
            expect(bot.decideBid(match, id)).toBe(s.action);
            counts.bid++;
          } else if (s.phase === 'trump') {
            expect(bot.decideTrump(match, id)).toBe(s.action);
            counts.trump++;
          } else {
            expect(bot.decideDomino(match, id).id).toBe(s.action);
            counts.play++;
          }
        }
        match = applyStep(match, s);
      }
    }
    expect(counts.bid).toBeGreaterThan(300);
    expect(counts.trump).toBeGreaterThan(50);
    expect(counts.play).toBeGreaterThan(2000);
  });

  it('plays first legal once the hand is decided', () => {
    // Python stops a hand when it's decided; TS lets humans play it out. Take a fixture hand that
    // ended with dominoes still in hand, so a bot has a move after the decision.
    const h = fixtureHands().find((x) => x.steps.filter((s) => s.phase === 'play').length < 24)!;
    let match = startHand(h);
    for (const s of h.steps) match = applyStep(match, s);
    expect(gameWinningTeam(match.currentGame)).not.toBeNull();
    const id = match.currentGame.currentPlayerId!;
    // An empty play network would throw if decideDomino ran inference.
    const noInference = createBot({ ...w, play: [] });
    expect(noInference.decideDomino(match, id)).toBe(legalPlays(match.currentGame, id)[0]);
  });
});
```
Import `legalPlays` from `../src/index`, and drop `dominoFromId` from the imports if it is now unused. Every fixture hand stops when its result is decided. A hand with fewer than 24 plays always leaves the next player holding dominoes, whether or not a seat sits out.

The trump count bar (`> 50`) assumes about 300 hands. If the generated fixture has fewer non-scripted trump steps, lower the bar to whatever the fixture holds, with a minimum of 20, and say so in your report.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd cloudflare && npm test -w @fortytwo/bot`
Expected: FAIL, because `createBot` and `bidTable` are not exported.

- [ ] **Step 3: Implement `src/bidding.ts` and `src/bot.ts`**

`src/bidding.ts` (ports `BidNet.table`, `sim/probe.options_from_table` and `sim/decide.choose_bid`):
```ts
import { dense } from './mlp';
import { encodeHand } from './encode';
import { IS_DOUBLE } from './dominoes';
import type { BotWeights } from './weights';

const PASS = 0;
const PLUNGE = 169;
const HIGH_PROBE = 42;
const MARKS_BID = 84;
const HIGH_TRUMPS = [0, 1, 2, 3, 4, 5, 6, -1];
const LOW_TRUMPS = [-2, -3, -4];

export interface BidTable { points: number[][]; high: number[]; low: number[]; plunge: number | null }
export interface Option { bid: number; trump: number; pMake: number }
export interface BidContext { legal: number[]; partnerHolds: boolean; lastToBid: boolean }
export interface BidDecision { bid: number; trump: number | null; pMake: number | null }

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const marksFor = (bid: number) => (bid <= 42 ? 1 : Math.floor(bid / 42));
const ev = (o: Option) => marksFor(o.bid) * (2 * o.pMake - 1);

export function bidTable(w: BotWeights, hand: number[]): BidTable {
  let h: ArrayLike<number> = encodeHand(hand);
  for (const layer of w.bidBody) h = dense(layer, h, true);
  const logits = dense(w.pointsHead, h, false);
  const binary = Array.from(dense(w.binaryHead, h, false), sigmoid);
  const points: number[][] = [];
  for (let s = 0; s < 7; s++) {
    const z = Array.from(logits.slice(s * 14, s * 14 + 14));
    const m = Math.max(...z);
    const e = z.map((v) => Math.exp(v - m));
    const total = e.reduce((a, b) => a + b, 0);
    const p = e.map((v) => v / total);
    const atLeast = new Array<number>(14);
    let acc = 0;
    for (let k = 13; k >= 0; k--) atLeast[k] = acc += p[k];
    points.push(atLeast.slice(1, 13)); // P(make 30) ... P(make 41)
  }
  const doubles = hand.filter((d) => IS_DOUBLE[d]).length;
  return { points, high: binary.slice(0, 8), low: binary.slice(8, 11), plunge: doubles >= 4 ? binary[11] : null };
}

export function optionsFromTable(table: BidTable, legal: number[]): Option[] {
  const bids = legal.filter((b) => b !== PASS);
  const pointsBids = bids.filter((b) => b < HIGH_PROBE);
  const highBids = bids.filter((b) => b >= HIGH_PROBE && b !== PLUNGE);
  const options: Option[] = [];
  if (pointsBids.length) for (let t = 0; t < 7; t++) for (const b of pointsBids) options.push({ bid: b, trump: t, pMake: table.points[t][b - 30] });
  if (highBids.length) {
    HIGH_TRUMPS.forEach((t, i) => { for (const b of highBids) options.push({ bid: b, trump: t, pMake: table.high[i] }); });
    LOW_TRUMPS.forEach((t, i) => { for (const b of highBids) options.push({ bid: b, trump: t, pMake: table.low[i] }); });
  }
  if (bids.includes(PLUNGE)) {
    if (table.plunge === null) throw new Error('plunge is legal but the table has no plunge probability');
    options.push({ bid: PLUNGE, trump: -1, pMake: table.plunge });
  }
  return options;
}

export function chooseBid(
  options: Option[], ctx: BidContext, cfg: { makeThreshold: number; overbidPartnerThreshold: number },
): BidDecision {
  const best = new Map<number, Option>();
  for (const o of options) {
    if (!ctx.legal.includes(o.bid) || o.bid === PASS) continue;
    const cur = best.get(o.bid);
    if (cur === undefined || o.pMake > cur.pMake) best.set(o.bid, o);
  }
  const take = (bid: number): BidDecision => {
    const o = best.get(bid)!;
    return { bid: o.bid, trump: o.trump, pMake: o.pMake };
  };
  const passing: BidDecision = { bid: PASS, trump: null, pMake: null };
  const forced = !ctx.legal.includes(PASS);
  const forcedBid = (): BidDecision => {
    const lowest = Math.min(...ctx.legal.filter((b) => b !== PASS));
    return best.has(lowest) ? take(lowest) : { bid: lowest, trump: null, pMake: null };
  };
  const makeable = [...best.entries()].filter(([, o]) => o.pMake > cfg.makeThreshold).map(([b]) => b).sort((a, b) => a - b);

  if (ctx.partnerHolds) {
    const strong = [...best.entries()].filter(([, o]) => o.pMake >= cfg.overbidPartnerThreshold).map(([b]) => b);
    return strong.length ? take(Math.max(...strong)) : passing;
  }
  if (ctx.lastToBid) {
    if (makeable.length) {
      const lowest = makeable[0];
      const marks = makeable.filter((b) => b >= MARKS_BID);
      let richest: number | null = null;
      for (const b of marks) if (richest === null || ev(best.get(b)!) > ev(best.get(richest)!)) richest = b;
      return richest !== null && ev(best.get(richest)!) > ev(best.get(lowest)!) ? take(richest) : take(lowest);
    }
    return forced ? forcedBid() : passing;
  }
  if (makeable.length) return take(makeable[makeable.length - 1]);
  return forced ? forcedBid() : passing;
}
```
`src/bot.ts`:
```ts
// The shipped bot: BidNet bidding through the same rules as Python's FastBidder, and the play
// network's best Q. Stateless: trump is recomputed from the table (it's always the trump that
// justified the winning bid), so nothing has to survive between Durable Object alarms.
import {
  Bid, Suit, availableBids, availableTrumps, gameWinningTeam, isOfSuit, type Domino, type Game, type MatchState,
} from '@fortytwo/rules';
import { bidTable, chooseBid, optionsFromTable } from './bidding';
import { toIndex } from './dominoes';
import { OBS_DIM, encodeCandidates } from './encode';
import { scoreCandidates } from './mlp';
import { buildView, seatOf } from './view';
import type { BotWeights } from './weights';

export interface Bot {
  decideBid(match: MatchState, playerId: string): Bid;
  decideTrump(match: MatchState, playerId: string): Suit;
  decideDomino(match: MatchState, playerId: string): Domino;
}

const handOf = (game: Game, playerId: string) => game.hands.find((h) => h.playerId === playerId)!.dominoes;

// Follow suit: holding the led suit, you must play it (validation.assertValidDomino).
export function legalPlays(game: Game, playerId: string): Domino[] {
  const hand = handOf(game, playerId);
  const suit = game.currentTrick.suit;
  if (suit === null) return hand;
  const following = hand.filter((d) => isOfSuit(d, suit, game.trump));
  return following.length ? following : hand;
}

function firstMax<T>(items: T[], score: (t: T) => number): T {
  let best = items[0];
  for (const t of items) if (score(t) > score(best)) best = t;
  return best;
}

export function createBot(w: BotWeights): Bot {
  const cfg = { makeThreshold: w.manifest.makeThreshold, overbidPartnerThreshold: w.manifest.overbidPartnerThreshold };
  const table = (game: Game, playerId: string) => bidTable(w, handOf(game, playerId).map(toIndex));

  return {
    decideBid(match, playerId) {
      const game = match.currentGame;
      const seat = seatOf(match, playerId);
      const legal = availableBids(game, playerId);
      const ctx = {
        legal,
        partnerHolds: game.biddingPlayerId !== null && seatOf(match, game.biddingPlayerId) === (seat + 2) % 4,
        lastToBid: game.hands.every((h) => h.playerId === playerId || h.bid !== null),
      };
      return chooseBid(optionsFromTable(table(game, playerId), legal), ctx, cfg).bid as Bid;
    },

    decideTrump(match, playerId) {
      const game = match.currentGame;
      const legal = availableTrumps(game);
      const t = table(game, playerId);
      if (game.bid === Bid.Plunge && game.biddingPlayerId !== playerId) {
        return firstMax(legal, (s) => t.high[s === Suit.None ? 7 : s]);
      }
      const atBid = optionsFromTable(t, [game.bid!]).filter((o) => legal.includes(o.trump as Suit));
      return (atBid.length ? firstMax(atBid, (o) => o.pMake).trump : legal[0]) as Suit;
    },

    decideDomino(match, playerId) {
      const game = match.currentGame;
      const legal = legalPlays(game, playerId);
      if (legal.length === 1 || gameWinningTeam(game) !== null) return legal[0];
      const rows = encodeCandidates(buildView(match, playerId), legal.map(toIndex));
      const q = scoreCandidates(w.play, OBS_DIM, rows);
      return legal[q.indexOf(Math.max(...q))];
    },
  };
}
```
Two decisions in this code need careful attention:
- **The bidder's own trump:** in Python, the planned trump is reused only when `plan[1] in legal`. A forced bid with no option gives a `None` plan, which falls through to the table fallback. Recomputing from the table gives the same answer in every case, and the fixtures prove it.
- **The play argmax:** Python's `ModelAgent.play` takes `max(pairs, key=q)`, which is the first maximum, and `indexOf(Math.max(...))` is also the first maximum.

Export `createBot`, `type Bot`, `legalPlays`, `bidTable`, `optionsFromTable`, `chooseBid` and their types from `src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd cloudflare && npm test -w @fortytwo/bot`
Expected: all pass. Fix mismatches in TS, never in the fixtures.

- [ ] **Step 5: Commit**

```bash
git add cloudflare/packages/bot
git commit -m "bot: bidding, trump and play decisions match the Python bot on every fixture decision"
```

---

### Task 6: Export the real bot (Git LFS), and the timing spike

**Files:**
- Modify: `.gitattributes`
- Create: `cloudflare/apps/web/public/models/bot.bin` (LFS), `cloudflare/apps/web/public/models/bot.json`, `cloudflare/packages/bot/bench/bench.ts`, `cloudflare/packages/bot/test/realManifest.test.ts`

**Interfaces:**
- Consumes: `ml export` (Task 1), the bot package (Tasks 3–5), and the real checkpoints `ml/runs/stage1-c/ckpt-latest.pt` and `ml/runs/bidnet-2/bidnet.pt`, which are local and not in git.

- [ ] **Step 1: Track model blobs with LFS**

From the repo root, run `git lfs install --local`, then `git lfs track "cloudflare/apps/web/public/models/*.bin"`. That appends the LFS line to `.gitattributes`. Confirm `git check-attr filter cloudflare/apps/web/public/models/bot.bin` prints `lfs`.

- [ ] **Step 2: Export the real bot**

Run: `cd ml && uv run ml export --play runs/stage1-c/ckpt-latest.pt --bidnet runs/bidnet-2/bidnet.pt --out ../cloudflare/apps/web/public/models`
Expected: about 6 MB `bot.bin` plus `bot.json`. If `ml export` refuses because the checkpoint step differs, stop and report BLOCKED. That would mean `stage1-c` was retrained after bidnet-2 was made.

- [ ] **Step 3: Write the real-manifest test**

`test/realManifest.test.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BID_INPUT_LAYOUT, FORMAT, PLAY_INPUT_DIM } from '../src/index';

// The shipped manifest is plain git (only bot.bin is LFS), so CI can check it without the weights:
// a retrain with new features but no TS update fails here, not in production.
const path = new URL('../../../apps/web/public/models/bot.json', import.meta.url);

describe('shipped model manifest', () => {
  it.runIf(existsSync(path))('declares the layouts this bot implements', () => {
    const m = JSON.parse(readFileSync(path, 'utf8'));
    expect(m.format).toBe(FORMAT);
    expect(m.playInputDim).toBe(PLAY_INPUT_DIM);
    expect(m.bidInputLayout).toBe(BID_INPUT_LAYOUT);
  });
});
```

- [ ] **Step 4: Write the benchmark**

`bench/bench.ts`:
```ts
// Times the real bot in Node: decisions replayed from the fixture hands' positions, plus the cold
// load. The Workers Free plan allows 10 ms CPU per invocation; the bar here is a decision p95
// under 5 ms, leaving room for the rules engine, storage and broadcast in the same alarm.
import { readFileSync } from 'node:fs';
import { createBot, loadWeights } from '../src/index';
import { fixtureHands } from '../test/fixtures';
import { PLAYERS, applyStep, startHand } from '../test/replay';

const models = new URL('../../../apps/web/public/models/', import.meta.url);
const t0 = performance.now();
const manifest = JSON.parse(readFileSync(new URL('bot.json', models), 'utf8'));
const buf = readFileSync(new URL('bot.bin', models));
const bot = createBot(loadWeights(manifest, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
const cold = performance.now() - t0;

const times: Record<string, number[]> = { bid: [], trump: [], play: [] };
for (const h of fixtureHands().slice(0, 150)) {
  let match = startHand(h);
  for (const s of h.steps) {
    const id = PLAYERS[s.seat];
    const start = performance.now();
    if (s.phase === 'bid') bot.decideBid(match, id);
    else if (s.phase === 'trump') bot.decideTrump(match, id);
    else bot.decideDomino(match, id);
    times[s.phase].push(performance.now() - start);
    match = applyStep(match, s);
  }
}
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
console.log(`cold load (read + views + createBot): ${cold.toFixed(1)} ms`);
for (const [phase, xs] of Object.entries(times)) {
  console.log(`${phase}: n=${xs.length} median ${pct(xs, 0.5).toFixed(2)} ms  p95 ${pct(xs, 0.95).toFixed(2)} ms  max ${pct(xs, 1).toFixed(2)} ms`);
}
```
The fixture hands' bids and plays came from the tiny model, so the real bot's choices will differ. That's fine here: the bench only times each decision on realistic positions.

- [ ] **Step 5: Run the tests and the bench**

Run: `cd cloudflare && npm test -w @fortytwo/bot`, then `npm run bench -w @fortytwo/bot`.
Expected: the tests pass, including the real-manifest test.
- **Bench bar:** the play p95 is under 5 ms. Paste the full bench output into your report.
- **If play p95 ≥ 5 ms:** first try the cheap optimisations in `mlp.ts`:
  - reuse preallocated `Float64Array` buffers across layers and candidates instead of allocating per call;
  - hoist `layer.w`, `inDim` and `outDim` into locals (already done in `dense`).

  Re-run the bench. If it still misses, report DONE_WITH_CONCERNS with the numbers. Don't shrink the model.

- [ ] **Step 6: Commit**

```bash
git add .gitattributes cloudflare/apps/web/public/models cloudflare/packages/bot
git commit -m "bot: export stage1-c + bidnet-2 for the Worker (LFS), timing bench"
```
Before committing, run `git lfs ls-files` and confirm `bot.bin` is listed, meaning it is stored as an LFS object, not a 6 MB git blob.

---

### Task 7: Worker integration, the `BOTS_ENABLED` switch, CI

**Files:**
- Create: `cloudflare/apps/worker/src/mlBot.ts`
- Modify:
  - `cloudflare/apps/worker/src/bots.ts` and `src/matchDO.ts`;
  - `src/index.ts`, `src/routes/matches.ts`;
  - `wrangler.toml`, `vitest.config.ts`, `package.json`;
  - every worker test that sets `AUTO_PLAY_BOTS`: run `git grep -l AUTO_PLAY_BOTS cloudflare` to find them all, including `apps/web` and `apps/mobile` comments;
  - `cloudflare/README.md`, `.github/workflows/worker.yml`.
- Test: `cloudflare/apps/worker/src/bots.test.ts` (extend), `cloudflare/apps/worker/test/config.test.ts` (or wherever `/api/config` is tested now)

**Interfaces:**
- Consumes: `@fortytwo/bot` (`createBot`, `loadWeights`, `type Bot`).
- Produces:
  - **`mlBot.ts`:** `getMlBot(env: { ASSETS?: Fetcher }): Promise<Bot | null>`, cached per isolate, plus `resetMlBotForTest(): void`.
  - **`bots.ts`:**
    - `applyBotAction(match: MatchState, action: BotAction, bot: Bot | null): MatchState`, moved here from `matchDO.ts` (where it was private);
    - `botsEnabled(env: { BOTS_ENABLED?: string }): boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/src/bots.test.ts`. Reuse its existing helpers for building a match with bots, and look at the file for how it seats players.
```ts
import type { Bot } from '@fortytwo/bot';
import { createMatch, shuffledDominoOrder, takeSeat } from '@fortytwo/rules';
import { applyBotAction, botsEnabled } from './bots';

// A dealt match (a human in seat 0, bots in 1-3) with bot-1 to open the bidding.
function botToBid(): MatchState {
  let m = createMatch('human');
  m = takeSeat(m, 'bot-1', 1);
  m = takeSeat(m, 'bot-2', 2);
  m = takeSeat(m, 'bot-3', 3, shuffledDominoOrder(() => 0.5));
  return { ...m, currentGame: { ...m.currentGame, firstActionBy: 'bot-1', currentPlayerId: 'bot-1' } };
}
const bidOf = (m: MatchState, id: string) => m.currentGame.hands.find((h) => h.playerId === id)!.bid;
const unused = () => {
  throw new Error('not used in this test');
};

describe('applyBotAction with an ML bot', () => {
  it('uses the ML decision when it is legal', () => {
    const match = botToBid();
    const action = findNextBotAction(match)!;
    expect(action).toEqual({ kind: 'bid', playerId: 'bot-1' });
    const bot: Bot = { decideBid: () => Bid.ThirtyFive, decideTrump: unused, decideDomino: unused };
    expect(bidOf(applyBotAction(match, action, bot), 'bot-1')).toBe(Bid.ThirtyFive);
  });

  it('falls back when the ML decision is illegal', () => {
    const match = botToBid();
    const action = findNextBotAction(match)!;
    const bot: Bot = { decideBid: () => 999 as Bid, decideTrump: unused, decideDomino: unused };
    expect(bidOf(applyBotAction(match, action, bot), 'bot-1')).toBe(Bid.Pass); // the simple bot passes
  });

  it('falls back when the ML bot throws', () => {
    const match = botToBid();
    const action = findNextBotAction(match)!;
    const bot: Bot = { decideBid: unused, decideTrump: unused, decideDomino: unused };
    expect(bidOf(applyBotAction(match, action, bot), 'bot-1')).toBe(Bid.Pass);
  });

  it('missing model falls back to the simple bots', () => {
    const match = botToBid();
    const action = findNextBotAction(match)!;
    expect(bidOf(applyBotAction(match, action, null), 'bot-1')).toBe(Bid.Pass);
  });
});

describe('botsEnabled', () => {
  it('is on unless BOTS_ENABLED is exactly "false"', () => {
    expect(botsEnabled({})).toBe(true);
    expect(botsEnabled({ BOTS_ENABLED: 'true' })).toBe(true);
    expect(botsEnabled({ BOTS_ENABLED: 'false' })).toBe(false);
  });
});
```
Merge the new imports into the file's existing `@fortytwo/rules` and `./bots` import lines. `bots.test.ts` already imports `Bid`, `MatchState` and `findNextBotAction`.

Add a config test to the existing `/api/config` test (find it with `git grep -n "api/config" cloudflare/apps/worker`). With `BOTS_ENABLED` unset, `{ bots: true }`. With `'false'`, `{ bots: false }`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd cloudflare && npm test -w @fortytwo/worker`
Expected: FAIL, because `applyBotAction` and `botsEnabled` are not exported from `bots.ts`.

- [ ] **Step 3: Wire the package and the ASSETS binding**

- In `apps/worker/package.json`, add `"@fortytwo/bot": "*"` to `dependencies`, then run `npm install` from `cloudflare/`.
- In `wrangler.toml`, add `binding = "ASSETS"` under `[assets]`, with this comment: `# The bot's weights (/models/bot.{json,bin}) are read through this binding (mlBot.ts).`

- [ ] **Step 4: Implement `mlBot.ts`**

```ts
// Loads the shipped ML bot once per isolate from the static assets (/models/bot.json + bot.bin,
// exported by `ml export`). Any failure - no binding, a missing file (the SPA fallback serves
// index.html), a Git LFS pointer, a layout mismatch - is logged once and cached as null, so bots
// fall back to the simple rules in bots.ts instead of stalling a match.
import { createBot, loadWeights, type Bot } from '@fortytwo/bot';

let cached: Promise<Bot | null> | null = null;

async function fetchAsset(assets: Fetcher, path: string): Promise<Response> {
  const res = await assets.fetch(new Request(`https://assets.local${path}`));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res;
}

async function load(env: { ASSETS?: Fetcher }): Promise<Bot> {
  if (!env.ASSETS) throw new Error('no ASSETS binding');
  const [manifestText, bin] = await Promise.all([
    fetchAsset(env.ASSETS, '/models/bot.json').then((r) => r.text()),
    fetchAsset(env.ASSETS, '/models/bot.bin').then((r) => r.arrayBuffer()),
  ]);
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error('/models/bot.json is not JSON (missing model?)');
  }
  return createBot(loadWeights(manifest, bin));
}

export function getMlBot(env: { ASSETS?: Fetcher }): Promise<Bot | null> {
  cached ??= load(env).catch((e: unknown) => {
    console.error(`ML bot unavailable, using simple bots: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  return cached;
}

export function resetMlBotForTest(): void {
  cached = null;
}
```

- [ ] **Step 5: Move `applyBotAction` into `bots.ts`, with fallback**

In `bots.ts`:
- Update the header comment. Bots are now the ML bot when it's loaded, and the simple rules below are its fallback.
- Add:
```ts
import type { Bot } from '@fortytwo/bot';
import { patchPlayerReady, placeBid, playDomino, setTrump, shuffledDominoOrder } from '@fortytwo/rules';

export function botsEnabled(env: { BOTS_ENABLED?: string }): boolean {
  return env.BOTS_ENABLED !== 'false';
}

function simple(match: MatchState, action: BotAction): MatchState {
  const hand = match.currentGame.hands.find((h) => h.playerId === action.playerId)!;
  switch (action.kind) {
    case 'ready':
      return patchPlayerReady(match, action.playerId, true, shuffledDominoOrder());
    case 'bid':
      return placeBid(match, action.playerId, decideBid(match.currentGame, hand));
    case 'setTrump':
      return setTrump(match, action.playerId, decideTrump(hand));
    case 'play':
      return playDomino(match, action.playerId, decideDomino(match.currentGame, hand));
  }
}

function ml(match: MatchState, action: BotAction, bot: Bot): MatchState {
  switch (action.kind) {
    case 'ready':
      return simple(match, action);
    case 'bid':
      return placeBid(match, action.playerId, bot.decideBid(match, action.playerId));
    case 'setTrump':
      return setTrump(match, action.playerId, bot.decideTrump(match, action.playerId));
    case 'play':
      return playDomino(match, action.playerId, bot.decideDomino(match, action.playerId));
  }
}

// Performs exactly one bot action. The ML bot decides when it's loaded; if it throws or its move
// is illegal (the rules functions throw), that action falls back to the simple rules, so a model
// problem never stalls a match.
export function applyBotAction(match: MatchState, action: BotAction, bot: Bot | null): MatchState {
  if (bot !== null) {
    try {
      return ml(match, action, bot);
    } catch (e) {
      console.error(`ML bot ${action.kind} for ${action.playerId} failed, using the simple bot: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return simple(match, action);
}
```
In `matchDO.ts`:
- Delete the private `applyBotAction`.
- Import `applyBotAction` from `./bots` and `getMlBot` from `./mlBot`.
- In `alarm()`, replace `const next = this.applyBotAction(match, action);` with:
```ts
    const next = applyBotAction(match, action, await getMlBot(this.env));
```

- [ ] **Step 6: Rename `AUTO_PLAY_BOTS` to `BOTS_ENABLED` (default on)**

- **`index.ts` `Env`:**
  - Replace the `AUTO_PLAY_BOTS` block with `BOTS_ENABLED?: string;`, commented: "Bots (the ML bot, falling back to simple rules) can fill open seats unless this is exactly 'false': a kill switch settable in the Cloudflare dashboard without a deploy."
  - Add `ASSETS?: Fetcher;`.
- **`/api/config`:** use `{ bots: botsEnabled(c.env) }`.
- **`routes/matches.ts`:** use `if (!botsEnabled(c.env)) return c.json({ title: 'Not found' }, 404);` and update the "Dev-only" comment.
- **`vitest.config.ts`:** pin `BOTS_ENABLED: 'false'` in place of `AUTO_PLAY_BOTS: 'false'`, and update its comment.
- **Tests that turn bots on per call:** in every worker test that sets `AUTO_PLAY_BOTS: 'true'`, change it to `BOTS_ENABLED: 'true'`.
- **Comments in other apps:** update the "dev-only (the Worker's AUTO_PLAY_BOTS)" comments in `apps/web/src/api/client.ts`, `apps/web/src/pages/Match.tsx` and the mobile app (`git grep -n AUTO_PLAY_BOTS cloudflare`). Comments only; no client logic changes.
- **`cloudflare/README.md`:**
  - replace the `AUTO_PLAY_BOTS` row with `BOTS_ENABLED`;
  - say bots are the ML bot from `ml/`, with weights in `apps/web/public/models` (Git LFS, so run `git lfs pull` after cloning) and refreshed with `ml export`;
  - drop "dev-only".

- [ ] **Step 7: CI**

In `.github/workflows/worker.yml`:
- add `- run: npm test -w @fortytwo/bot` to the `test` job, after `@fortytwo/client`;
- in the `deploy` job, change the checkout to:
```yaml
      - uses: actions/checkout@v4
        with:
          lfs: true # the bot's weights (apps/web/public/models/*.bin) are Git LFS objects
```

- [ ] **Step 8: Run all the suites**

Run, from `cloudflare/`:
- `npm test -w @fortytwo/bot`
- `npm test -w @fortytwo/rules`
- `npm test -w @fortytwo/client`
- `npm test -w @fortytwo/worker`
- `npm test -w @fortytwo/web`
- `npm run build -w @fortytwo/web`

Expected: all pass. Existing bot-flow tests still pass because the test pool has no model assets, so `getMlBot` resolves to `null` and the simple bots run.

- [ ] **Step 9: Commit**

```bash
git add cloudflare .github/workflows/worker.yml
git commit -m "worker: ML bots fill seats (fallback to simple bots), BOTS_ENABLED kill switch, LFS deploy checkout"
```

---

### Task 8: Manual check (the user, on the dev box)

- [ ] **Local check.** Run `cd cloudflare/apps/worker && npm run dev`, with `.dev.vars` no longer needing `AUTO_PLAY_BOTS`. Build the web app first (`npm run build -w @fortytwo/web`) so `/models/*` is served. Then:
  1. Create a match and fill three seats with bots.
  2. Play a full match.
  3. Watch the `wrangler dev` output: there should be no "ML bot unavailable" line, and no "failed, using the simple bot" lines.
- [ ] **Deploy.** Merge and push when ready; the deploy job checks out LFS. After deploying:
  1. Play a few matches with bots.
  2. In the Cloudflare dashboard, check the Worker's logs for CPU-limit errors (`exceededCpu`) and for fallback lines.
  3. If either shows up, set `BOTS_ENABLED=false` while the cause is investigated.
- [ ] **Update issue #76** (hints) with what landed:
  - the `Bot` interface;
  - `@fortytwo/bot`;
  - the bench numbers;
  - how the Worker loads the model.
