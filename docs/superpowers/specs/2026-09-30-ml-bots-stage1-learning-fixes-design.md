# ML Bots Stage 1: Learning Fixes — Design Amendment

Amends `2026-09-29-ml-bots-stage1-design.md`. Everything not mentioned here stands.

## What happened

The first full run (`stage1-a`, 2M learner steps, about 14 hours) finished well below the Stage 1
bar:

| Opponent / measure | Result |
| --- | --- |
| vs `heuristic`, 5,000 duplicate deals | −0.498 marks/deal (CI −0.532, −0.464); every contract type but follow-me significantly worse; 11.8% match win rate |
| vs `dumb` | +0.2 marks/deal (an untrained net scores about 0) |

## Root causes (measured)

### 1. The action ranking is noise

The network learns how good a position is, but not which domino is better.

- **Loss and eval were flat almost from the start.** Loss reached its plateau (about 0.6) by step
  300. The in-training eval against the heuristic sat at about −0.55 from step 20k to 2M.
- **Checkpoints close together disagree.** Checkpoints 30k steps apart choose the same domino 38%
  of the time, where chance is 30%.
- **The model doesn't play like the heuristic.** It agrees with the heuristic's choice 34% of the
  time, against 30% chance.
- **Q values for the same action swing.** For the same state and action, Q moves by about 0.35
  between those two checkpoints.

Why:
- **The target is noisy.** The Monte-Carlo target is the hand's result, which mostly reflects the
  luck of the deal. The part that depends on the action is a small signal on top of that noise.
- **The candidate is hard to read.** It is only a 28-way one-hot, so relations like "is trump
  now" or "wins this trick" have to be learned as interactions between the one-hot, the trump
  one-hot, and the trick block, separately under each of the 11 trumps.
- **The optimizer is noisy.** At lr 3e-4 and batch 1024, updates wash out that small signal every
  few thousand steps.

### 2. Throughput is a fifth of what it should be

Measured in a short run with the `stage1.yaml` settings:

| Measure | Result |
| --- | --- |
| Learner speed | 38.7 steps/s |
| Samples ingested | 4.5k/s |
| Throughput with 4 actors instead of 14 | higher: 5.4k samples/s, learner at 147 steps/s |

- **The CPU is oversubscribed.** The box has 8 physical cores. `actors: 0` resolves to 14 actors
  (logical CPUs − 2), and they starve the single-threaded learner loop.
- **Where the learner's time goes,** per the profile:
  - reading one hand per queue item: about 0.6 ms per item across `PeekNamedPipe`, `ReadFile` and
    unpickling;
  - converting sampled rows from float16 to float32: 3 ms per batch;
  - copying each batch from host to GPU;
  - backward-pass syncs;
  - copying the shared weights for every publish.

## Changes

### A. Candidate-action features (model input)

Each candidate gets 10 derived features after its 28-way one-hot, so `ACTION_DIM` goes from 28 to
38 and `INPUT_DIM` from 353 to 363. They are computed only from public state plus the actor's own
hand:

| # | Feature | Value |
| --- | --- | --- |
| 0 | is trump | 1 if a named-suit trump holds it (`is_trump`) |
| 1 | is a double | 0/1 |
| 2 | count | `VALUE / 10` (0, 0.5, 1) |
| 3 | follows suit | 1 if a trick is started and the domino is of the led suit |
| 4 | rank | `(rank + 1) / 18` in the led suit, or in its own led suit when leading; off-suit gives 0 |
| 5 | wins now | trick started, and it would beat the current best domino |
| 6 | overtakes partner | wins now and partner currently holds the trick |
| 7 | boss | leading, and no unseen domino (not in my hand, not played) outranks it in its led suit |
| 8 | trick points if played | (count on the table + its count + 1) / 42 |
| 9 | closes the trick | trick started, and it is the trick's last domino (3 under Low, else 4) |

The encoder stays a pure function of `(state, seat, action)`. The test that other seats' hidden
dominoes never change the encoding becomes mandatory.

### B. Quieter optimization

- **Learning rate and batch:** lr 1e-4 (was 3e-4), batch 4096 (was 1024).
- **EMA weights for acting:** the learner keeps an exponential moving average of its weights,
  decay 0.999 per step. The EMA is what gets published to actors, what the in-training eval uses,
  and what `ModelAgent` loads.
- **Checkpoints carry both weight sets:**
  - `model` is the EMA, and is what plays.
  - `raw` holds the learner weights plus the Adam state. `--resume` uses it.
  - Checkpoints record their input size (`input_dim`). Pre-change checkpoints (`stage1-a`, 353
    inputs) can't be used with the new features: loading one raises a clear error naming both sizes.
- **Replay cap:** a `max_replay_ratio` setting, default 4, makes the learner wait for fresh data
  whenever it has consumed more than 4× what actors have produced since the run started
  (samples consumed = learner steps × batch size).

### C. Learning diagnostics in TensorBoard

At every in-training eval, `eval/*` also records:
- `action_stability`: argmax agreement between the current EMA net and the net from the previous
  eval, on a fixed set of 2,000 decision states. The states come from heuristic self-play with a
  fixed seed, and only decisions with more than one legal domino count.
- `agree_heuristic`: argmax agreement with `HeuristicBot` on the same states.
- `agree_chance`: the random-choice baseline for those states, logged once.

`stage1-a` would have shown about 0.38 against 0.30 by the second eval. A healthy run should climb
well above that.

### D. Throughput

- **Actor count:** `actors: 0` now resolves to physical cores − 1. The code estimates physical
  cores as logical CPUs ÷ 2, and never goes below 1.
- **Learner threads:** the learner process runs with `torch.set_num_threads(2)`.
- **Batched sends:** actors accumulate hands and send one queue item about every 16 hands (or
  every 0.25 s), with rows as float16.
- **Replay buffer on the GPU:**
  - It stays float16 on the training device.
  - Drained batches go over in one host-to-device copy.
  - Sampling uses on-device random indices and a float32 cast on the GPU.
  - Writes are vectorized slice writes that wrap around the ring.
- **Publishing:** the EMA is published with one flat copy of the parameters, not a copy per
  parameter.
- **Throughput target:** on this box (8 cores, RTX 2070 SUPER), a new `ml bench-train` command
  runs 60 s with `stage1.yaml`, no eval, and the replay cap off so it measures raw capacity. It
  should report ≥ 15k samples/s ingested and ≥ 60 learner steps/s at batch 4096.
- **Step counts rescaled:** batch 4096 plus the replay cap make real training data-bound. At 15k
  samples/s and a ratio of 4 that's about 15 steps/s, so `stage1.yaml` uses:
  - `total_steps: 200000` (about 4 hours);
  - `alpha_decay_steps: 20000`;
  - `eval_every_steps: 2000` (about every 2–3 minutes).

Shutdown was measured separately at 0.7 s in total for 7 actor joins, so it needs no fix. The
wait time seen in the first profile was the learner blocking on the queue.

## Unchanged

- The DMC algorithm and the rules engine.
- The contract sampler and its mix.
- The arena, and the Stage 1 bar.
- The reward, including zero shaping on Low.

## Success

- **Stage 1 bar:** unchanged. A new run, `stage1-b`, must clear it.
- **Early warning:** within the first 20k steps (about 25 minutes) of `stage1-b`, `eval/action_stability` and
  `eval/agree_heuristic` should be clearly above `agree_chance`. If they aren't, the next step is
  the perfect-information (solved-hand) teacher, in a spec of its own. We don't launch a multi-hour
  run on a flat curve.
