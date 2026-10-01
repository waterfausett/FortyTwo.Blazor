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
uv run ml bench-train --config configs/stage1.yaml               # ~1 min: throughput check
uv run ml train --config configs/stage1.yaml --run-name stage1-b  # writes runs/stage1-b/
uv run tensorboard --logdir runs                                  # watch loss and eval
uv run ml eval --a runs/stage1-b/ckpt-latest.pt --b heuristic --deals 5000 --matches 500
uv run ml play-demo --agent runs/stage1-b/ckpt-latest.pt --seed 3
```

`--resume runs/stage1-b/ckpt-latest.pt` continues a run from its step count.

Stage 1 is done when `ml eval` against `heuristic` shows all of:

1. Mean marks/deal > 0 with a 95% CI excluding 0, over 5,000+ duplicate deals.
2. No contract type significantly worse: no row in the per-contract table is flagged `WORSE`
   (its marks/deal 95% CI upper bound below 0).
3. Zero illegal actions.

## Watching a run

TensorBoard's `eval/` tab shows whether the model is learning *which domino to play*, not just how
good a hand is:

- `eval/agree_chance`: how often a random pick would agree (the floor).
- `eval/action_stability`: how often this eval's model picks the same domino as the previous eval's
  (one eval, 2k steps, apart). Only a sanity check: EMA snapshots that close will read high even
  when the ranking isn't meaningful.
- `eval/action_stability_20k`: the same, against the eval 10 evals (20k steps) earlier. Logged once
  10 earlier evals exist. Supporting evidence.
- `eval/agree_heuristic`: how often it picks what the heuristic bot picks.
- `eval/marks_per_deal_vs_heuristic`: marks/deal against the heuristic bot.

The go/no-go signals are `agree_heuristic` clearly above `agree_chance` and
`eval/marks_per_deal_vs_heuristic` trending up from about -0.5, with `action_stability_20k` above
chance as supporting evidence. Check at ~20k steps, which is about 70 minutes at the measured ~4.7k
samples/s (see `train/steps_per_sec`). If these are flat, don't spend the full run on a flat curve:
the next step is the solved-hand teacher, a separate spec
(see `docs/superpowers/specs/2026-09-30-ml-bots-stage1-learning-fixes-design.md`).

A full 200k-step `stage1.yaml` run takes about 12 hours on this box (8 cores, RTX 2070 SUPER)
because CPU self-play tops out at about 5k samples/s.

Actors play with, the eval scores, and checkpoints save an exponential moving average of the
learner's weights. Checkpoints also carry the raw weights and optimizer state for `--resume`.
Checkpoints from before the candidate features (the `stage1-a` run, 353 inputs) can't be loaded by
this code.

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
