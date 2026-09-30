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
uv run ml eval --a runs/first/ckpt-latest.pt --b heuristic --deals 5000 --matches 500
uv run ml play-demo --agent runs/first/ckpt-latest.pt --seed 3
```

`--resume runs/first/ckpt-latest.pt` continues a run from its step count.

Stage 1 is done when `ml eval` against `heuristic` shows all of:

1. Mean marks/deal > 0 with a 95% CI excluding 0, over 5,000+ duplicate deals.
2. No contract type significantly worse: no row in the per-contract table is flagged `WORSE`
   (its marks/deal 95% CI upper bound below 0).
3. Zero illegal actions.

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
