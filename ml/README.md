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

Since Stage 2, the sampler deals realistic plunges (about 5% of the default mix) and gives Low to
the hand best placed to make it. So the normal-mix eval partly measures the plunge/Low gain; judge
"no regression" on the points, marks and follow_me rows. Seeded eval and diagnostics numbers from
before Stage 2 aren't comparable.

Then evaluate the simulation bidder against heuristic bidding with the same play model. The model
runs on CPU. On the idle dev box a bid decision takes about 6 s (median 5.8 s, p95 6.7 s), and
there are about 4 per duplicate deal. 1,000 deals took about 6.5 h single-process; with the default 7 workers (`--workers`) it's about an hour. A concurrent training run
nearly doubles that. `--sim-deals` trades accuracy for speed, and `--make-threshold` (default 0.6)
sets how sure the bidder must be before it bids. 0.6 beat the spec's original 0.5 by about 0.1
marks/deal on the same 300 deals: the bidder wins fewer auctions but makes more of them.

```sh
uv run ml eval-bidding --model runs/stage1-c/ckpt-latest.pt --deals 1000
uv run ml play-demo --agent sim:runs/stage1-c/ckpt-latest.pt --seed 3   # one auction with its reasoning
```

Stage 2 passes if:
- A's mean marks/deal is above 0, with the 95% CI excluding 0;
- the bid decision's p95 time is ≤ 30 s.

The reported bid decision time covers bidding only. Trump-naming simulations (a partner's plunge,
or no bid-time plan) aren't included.

The **calibration** table compares the bidder's predicted P(make) with how often those bids were
actually made. If actual rates fall consistently below the predictions, the bidder is
overrating its best option (the "winner's curse"). It picks the trump from the same sample that
justified the bid. The fix would be an independent confirmation sample before bidding.

Before the overnight run, sanity-check the bid-level lines. The bidder's P(make b) for bids
31–41 comes from playing deals as a 30 bid. The model was trained only up to the moment a hand is
decided, so play after a 30 bid is decided is out of its training distribution. The calibration
by bid band (30–31, 32–35, 36–41, 42+) shows whether higher points bids are made less often than
predicted.

## Stage 3: a fast bidding model

The simulation bidder is too slow to ship (about 6 s per bid). Stage 3 teaches a small network,
BidNet, to predict the same P(make) table from the hand alone, then bids from it with the same
rules and threshold. Every P(make) the simulation bidder estimates depends only on its own seven
dominoes, so the training data is just simulated hands, with no auctions.

```sh
# Training data: about 7 h with 7 workers. Rerunning resumes; a new --seed adds hands.
uv run ml gen-bids --model runs/stage1-c/ckpt-latest.pt --out data/bids --hands 100000 --sim-deals 50 --seed 1
# A small low-noise "gold" set for measuring the model (roughly an hour with 7 workers).
uv run ml gen-bids --model runs/stage1-c/ckpt-latest.pt --out data/bids-gold --hands 2000 --sim-deals 400 --seed 99
uv run ml train-bids --data data/bids --gold data/bids-gold --out runs/bidnet-1
```

`gen-bids` prints a progress line (hands done, hands/s, ETA) per 100-hand chunk and a line per
1,000-hand batch file written. It refuses an `--out` folder holding batches from a different play
checkpoint.

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

## Layout

| Path | What it is |
| --- | --- |
| `src/fortytwo_ml/engine` | The rules for one hand, ported from `cloudflare/packages/rules`, plus the match loop. |
| `src/fortytwo_ml/agents` | The agent protocol, the Worker's dumb bot, a heuristic bot, and the model agent. |
| `src/fortytwo_ml/contracts.py` | Where self-play training hands get their contract. |
| `src/fortytwo_ml/features.py` | What the model sees. |
| `src/fortytwo_ml/train` | Deep Monte-Carlo self-play: actor processes, the GPU learner, and the replay buffer. |
| `src/fortytwo_ml/eval` | Duplicate-deal arena and report. |
| `src/fortytwo_ml/sim` | Simulation bidding: deal sampling, rollouts, the P(make) probes, bid decisions, and worker processes. |
| `src/fortytwo_ml/bidding` | BidNet, the fast bidding model: gen-bids data, the network, and its training. |

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
