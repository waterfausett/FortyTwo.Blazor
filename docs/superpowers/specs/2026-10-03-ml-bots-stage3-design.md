# ML Bots Stage 3: A Fast Bidding Model Distilled From Simulation (+ Parallel Simulation) — Design

Builds on Stage 2, which is done (`docs/superpowers/specs/2026-10-01-ml-bots-stage2-design.md`).

## Where Stage 2 left things

**The simulation bidder (`SimAgent`) works.**
- With the `stage1-c` play model on both sides, it beat heuristic bidding by +0.304 marks/deal [+0.194, +0.414] over 1,000 duplicate deals at `make_threshold` 0.5.
- The default is now 0.6. On the same 300 deals, thresholds 0.5, 0.55 and 0.6 scored +0.390, +0.467 and +0.497. A 1,000-deal run at 0.6 also beat the 0.5 baseline, but its output was lost.
- Most of the edge comes from Low contracts, which the heuristic never bids.

**It is too slow to ship.** A bid decision takes about 6 s on CPU. A 1,000-deal eval takes about 6.5 h.

**Profile of one decision** (stage1-c, 200 simulated deals):

| Where the time goes | Share |
|---|---|
| Encoding positions in Python | ~58% |
| The game engine in Python | ~15% |
| Network forward passes | ~18% |

Running the model on CUDA saves only about 30%. Simulation is bound by Python on one core, and the dev box has eight.

## Goals

1. **Parallel simulation.** `eval-bidding` and the new data generator spread work over worker processes, with results identical for any worker count. A 1,000-deal eval drops from about 6.5 h to about 1 h, which makes a 0.6 vs 0.7 threshold retest practical.
2. **Training data for a bidding model.**
   - `ml gen-bids` simulates random hands and stores, for each hand, the raw simulation results for every bid option.
   - A key fact makes this cheap: every P(make) the simulation bidder estimates depends only on its own seven dominoes. The unseen 21 are dealt at random whatever the auction says, and the auction only decides which options are legal. So the data needs no auctions.
3. **A fast bidder.**
   - `BidNet` predicts the hand's whole P(make) table.
   - `FastBidder` feeds that table into the existing `choose_bid` rules at the same thresholds.
   - It must bid in milliseconds, and keep most of the simulation bidder's edge.

## Non-goals

- **Improving bidding beyond the simulation bidder through full-game self-play**, the second half of the roadmap's Stage 3. It gets its own spec once we see how close distillation gets.
- **A vectorized encoder or GPU simulation.** Parallel workers meet the time budget. We revisit only if data generation becomes the bottleneck.
- **Inferring opponents' or partner's hands from the auction.** That stays as in Stage 2.
- **A learned trump choice for a partner's plunge.** It is rare; the sim bidder never plunged in 2,000 hands. The heuristic's best suit is used.
- **ONNX export, a TypeScript encoder, or Worker integration.** Those are Stage 4. The design keeps `BidNet`'s input simple enough to port.

## 1. Parallel simulation (`sim/parallel.py`)

**Workers** follow Stage 1's spawn-worker pattern (`train/run.py` uses `mp.get_context("spawn")`), which works on Windows.
- Each worker loads the models itself from file paths. Agents are never pickled across processes.
- Each worker calls `torch.set_num_threads(1)`.
- The parent hands out units of work and gathers results in order.
- If a worker raises, the run fails with that worker's error and traceback. It must not hang, and nothing is skipped silently.
- `--workers N` defaults to 7.

**Determinism.**
- `evaluate_auctions` already deals each duplicate deal from `(seed, deal index)`.
- `SimBidder` keeps one random stream across decisions, so splitting deals among workers would change its simulations. Agents therefore get an optional `reseed(key: str)` method.
- `evaluate_auctions` calls it on any agent that has it, before each hand, with key `f"{seed}:{deal}:{a_team}"`.
- `SimBidder.reseed` resets its rng from the key. `FastBidder` is deterministic, so its `reseed` does nothing.
- With this, 1 worker and N workers produce identical reports.

**`eval-bidding --workers N`.**
- Workers take contiguous slices of deal indices. The parent merges records, deal scores, illegal counts and decision times in deal order.
- With `--workers 1` (or N = 1), everything runs in-process, with no spawn.
- `--matches` stays single-process.

## 2. The simulation core and `ml gen-bids`

### `simulate_hand`

`sim/probe.py`: `simulate_hand(model, seat, hand, n_deals, rng, device=None, kinds=ALL) -> HandSims`.
- It deals `n_deals` unseen deals with `deal_unseen` once and runs every requested probe on those same deals in one batched `rollout` call, exactly as `estimate_options` does today.
- `kinds` is a subset of `{"points", "high", "low", "plunge"}`.

The probes:

| Probe | Played as | Recorded |
|---|---|---|
| `points` | each named suit at 30 | histogram of the bidding team's final points, `points_hist[7, 43]` |
| `high` | each named suit + follow-me at 42 | how many deals made all 42 points, `high_made[8]` |
| `low` | each Low variant at 42 | how many deals the bidders took no trick, `low_clean[3]` |
| `plunge` | 169, partner names its heuristic best suit | `plunge_made`; only for hands with 4+ doubles, else `None` |

**`HandSims`** is a frozen dataclass holding `n` and the fields above.

**`estimate_options` becomes a thin wrapper.** It calls `simulate_hand` with the kinds the legal bids need, then `options_from_sims(sims, legal) -> list[Option]`.
- It must return exactly the options it returns today, on the same rng. A test pins this, so the Stage 2 bidder is unchanged.

**`options_from_table(table, legal)`** builds options from a P(make) table in the same layout as `BidNet`'s output (Section 3).
- `options_from_sims` turns the counts into that table, then calls `options_from_table`.
- So the simulation bidder and the fast bidder share one conversion.

### `ml gen-bids`

```
ml gen-bids --model <play ckpt> --out <dir> --hands 100000 --sim-deals 50 --seed 1 [--workers 7]
```

**Dealing.**
- Hand `i` uses one rng, `random.Random(f"gen-bids:{seed}:{i}")`. That rng first draws the 7 dominoes, then drives `simulate_hand` for that hand.
- The hand is simulated from seat 0 with all four probe kinds.

**Batch files.**
- Each holds 1,000 hands and is named `gen-s{seed}-{start:07d}.npz`. The last batch may be shorter.
- Contents:
  - `hands` (n, 7) int8;
  - `points_hist` (n, 7, 43) uint16;
  - `high_made` (n, 8) uint16;
  - `low_clean` (n, 3) uint16;
  - `plunge_made` (n,) int16, −1 when absent;
  - `sim_deals` int;
  - `play_checkpoint` (file name) and `play_step`;
  - `seed`.
- Files are written to `*.tmp` and renamed, so a killed run never leaves a partial batch.

**Resume and extend.**
- A batch whose file already exists is skipped. Rerunning the same command resumes.
- A different `--seed` adds new hands.

**Progress and size.**
- The command prints progress and an ETA as batches complete.
- 100k hands are about 60 MB.

**Expected cost.** About 1.8 s per hand per core at 50 deals, so about 4 hands/s with 7 workers. 100k hands take about 7 h.

## 3. `BidNet` and `ml train-bids`

### Model (`bidding/model.py`)

**Input: 36 floats.**
- 28 one-hot domino bits.
- 7 suit counts (dominoes containing each pip), divided by 7.
- The doubles count, divided by 7.

**Body:** 3 × (Linear 256 + ReLU).

**Heads:**
- **Points:** 7 × 14 logits, a softmax per suit over the buckets `<30, 30, 31, …, 41, 42`. P(make *b*) for points bid *b* is the probability mass in buckets ≥ *b*, so it is non-increasing in *b* by construction.
- **Binary:** 12 logits, sigmoid. In order: 42 in each named suit (7), follow-me (1), `LOW`, `LOW_DOUBLES_LOW`, `LOW_DOUBLES_OWN_SUIT` (3), and plunge (1).

**`BidNet.table(hand) -> BidTable`.**
- `points[7, 12]` is P(make b) for b = 30..41.
- `high[8]`, `low[3]` and `plunge` are probabilities. `plunge` is `None` when the hand has fewer than 4 doubles.

**Size:** about 170k weights, so CPU inference is well under 1 ms.

### Training (`bidding/train.py`, `ml train-bids`)

```
ml train-bids --data <dir> [--gold <dir>] --out <run dir> [--epochs 100] [--seed 0]
```

**Loading.**
- Every `*.npz` in `--data` is loaded.
- All batches must share one `play_checkpoint` and `play_step`. Otherwise training stops with an error naming the mismatch.
- Different `sim_deals` values may be mixed.

**Losses.**
- **Points:** `points_hist` is grouped into the 14 buckets. The loss is cross-entropy, Σ count × −log p, divided by the hand's deal count.
- **Binary:** binomial negative log-likelihood of the made count out of `n`, also divided by `n`. Plunge counts only when present.

**Validation.**
- A fixed 5% of hands, chosen by a stable hash of the sorted hand, is held out.
- Training uses Adam, lr 1e-3, batch 512, on CPU.
- It stops when the held-out loss has not improved for 5 epochs and keeps the best epoch's weights.

**Gold set.**
- A separate, low-noise dataset, made with `gen-bids --hands 2000 --sim-deals 400 --seed 99`.
- When given, it is used only for the final report.
- **Report:**
  - mean absolute error of predicted vs simulated P(make) at points bids 30, 34 and 38 in each hand's best 30-suit, at 42 in the best suit, at follow-me, and at the best Low variant;
  - a calibration table: predicted P in 0.1 bins → mean simulated P, with n.

**Output.** `<run dir>/bidnet.pt` holds:
- the weights and an input-layout version;
- `play_checkpoint` and `play_step`;
- the number of training hands;
- the final held-out loss and the gold metrics.

The command prints the loss per epoch and the gold report.

## 4. `FastBidder`, `FastAgent`, and evaluation

### Agents (`agents/fast_bidder.py`)

**`FastBidder(bidnet, make_threshold=DEFAULT_MAKE_THRESHOLD, overbid_partner_threshold=0.9)`** has the same interface as `SimBidder`: `bid`, `trump`, `reseed`, `last_decision`, `decision_seconds` and `predicted_make`.

**`bid`:**
1. Compute `bidnet.table(hand)`.
2. Build options with `options_from_table`.
3. Decide with `choose_bid` (with the same `BidContext` construction as `SimBidder`).
4. Record a `(bid, trump, p_make)` plan keyed by (seat, dealt hand).

**`trump`:**
- **Partner's plunge** (high bid is plunge and this seat isn't the bidder): the heuristic's best suit.
- **The remembered trump:** used when this seat holds the high bid at the planned level and the trump is legal.
- **Otherwise:** the legal trump with the best P(make) at the actual bid from the table.

**`FastAgent(bidnet, play_model)`** bids and names trump with `FastBidder` and plays with `ModelAgent`.
- `load_agent("fast:<bidnet.pt>")` builds one, using the play checkpoint recorded in the bidnet file.

**Shared default.** `DEFAULT_MAKE_THRESHOLD` (0.6) moves to `sim/decide.py` so both bidders share it.
- `DecideConfig`'s own default stays 0.5, the pure-rule default the Stage 2 tests pin. Both bidders always pass their threshold explicitly.

### `eval-bidding` compares any two bidders on one play model

```
ml eval-bidding --model <play ckpt> [--a sim] [--b heuristic] [--deals 1000] [--sim-deals 200]
                [--make-threshold 0.6] [--workers 7] [--matches N] [--seed S]
```

**Bidder options.**
- `--a` and `--b` each take `heuristic`, `sim` or `fast:<bidnet.pt>`. The defaults keep the Stage 2 command's meaning.
- Both sides always play with `--model`, so only bidding differs.
- `--sim-deals` and `--make-threshold` apply to each sim side. `--make-threshold` also applies to each fast side.
- If a fast side's recorded play checkpoint differs from `--model`'s file name or step, the command prints a warning and continues.

**Report.**
- The decision-time line is reported for each side that records times.
- Times under 1 s are printed in milliseconds.

**`play-demo --agent fast:<bidnet.pt>`** runs one auction and prints the top options at each bid, like the sim demo.

### The Stage 3 bar (1,000 duplicate deals, stage1-c play model, threshold 0.6)

| Matchup | Requirement |
|---|---|
| `fast` vs `heuristic` | A's marks/deal 95% CI above 0 |
| `fast` vs `sim` | A's marks/deal 95% CI lower bound above −0.1 |
| Fast bid decision | p95 < 10 ms on CPU |

Gold-set error and calibration are reported but are not part of the bar.

## 5. Tests (none need the GPU; tiny models: `QNet(hidden=16, layers=1)`, `BidNet(hidden=16)`)

**Parallel simulation**
- `evaluate_auctions` over 4 deals with sim agents gives identical records and scores with 1 and 2 workers.
- A worker that raises makes the run fail with that error, without hanging.

**Simulation core**
- `estimate_options` returns the same options as the Stage 2 implementation for several seeded states, including plunge-legal and forced ones.
- `simulate_hand`'s counts equal a slow reference that plays each simulated deal one at a time with `ModelAgent`.
- The plunge field is present exactly when the hand has 4+ doubles.
- `options_from_sims` and `options_from_table` agree on a hand-built table.

**`gen-bids`**
- Batch round-trip.
- Rerunning with the same seed skips existing batches and adds no hands.
- A new seed adds new hands.
- No `*.tmp` files remain.
- Hands are deterministic per (seed, index) for any worker count.

**`BidNet` and training**
- Points P(make) is non-increasing in the bid.
- The held-out split is stable across runs.
- Training on a synthetic dataset with a known label rule lowers the gold error.
- Mixed play checkpoints are rejected.
- A smoke run saves a loadable `bidnet.pt`.

**`FastBidder`**
- A stub `BidNet` returning a fixed table yields the bid `choose_bid` picks for it.
- The trump plan is reused only for the winning bid.
- A partner's plunge uses the heuristic suit.
- Full auctions with `FastAgent` in all seats are legal.

**CLI smoke tests**
- `gen-bids`, `train-bids` and `eval-bidding --a fast:… --b sim --workers 2` on tiny models.
- `load_agent("fast:…")`.

## 6. Manual runs (the user, on the dev box)

1. Training data: `ml gen-bids --model runs/stage1-c/ckpt-latest.pt --out data/bids --hands 100000 --sim-deals 50 --seed 1` (about one night).
2. Gold set: `ml gen-bids … --out data/bids-gold --hands 2000 --sim-deals 400 --seed 99` (about 30 min).
3. Train: `ml train-bids --data data/bids --gold data/bids-gold --out runs/bidnet-1`.
4. The Stage 3 bar: `ml eval-bidding --model runs/stage1-c/ckpt-latest.pt --a fast:runs/bidnet-1/bidnet.pt --b heuristic --deals 1000`, then the same with `--b sim`.
5. The threshold retest, now about 1 h each: `ml eval-bidding --model runs/stage1-c/ckpt-latest.pt --deals 1000 --seed 2 --make-threshold 0.6`, then 0.7. If 0.7 wins, the default changes for both bidders.
