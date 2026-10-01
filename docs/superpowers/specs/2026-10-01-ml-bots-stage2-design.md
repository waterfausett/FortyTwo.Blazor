# ML Bots Stage 2: Bidding by Simulation (+ Plunge/Low Training Fix) — Design

Builds on Stage 1, which is done:
- **Model:** `stage1-b`, trained with `docs/superpowers/specs/2026-09-29-ml-bots-stage1-design.md` and
  `docs/superpowers/specs/2026-09-30-ml-bots-stage1-learning-fixes-design.md`.
- **Result against the heuristic:** +0.361 marks/deal [+0.330, +0.392] with a 72.8% match win rate.
- **Bidding:** the Stage 1 bot still bids with the heuristic.

The perfect-information teacher idea is tracked separately in issue #39.

## Goals

1. **Plunge and Low training fix.** Plunge contracts are about 0.8% of training hands. On a
   plunge-only eval (844 plunges) the model shows no edge: −0.104 [−0.341, +0.133]. Low hands
   are frequent, but they're unrealistic: Low is forced on the weakest suit-strength seat, so
   bidders make only 16%. Stage 2 will choose plunge and Low itself, so the play model must
   play realistic versions of both.
2. **A simulation bidder.** For its own hand, it deals the unseen dominoes many times, plays
   each deal out with the Stage 1 model, and bids and names trump from the estimated chance of
   making each option.
3. **An eval that isolates bidding.** Both sides play with the same Stage 1 model, and only
   the bidding differs.

## Non-goals (v1)

- Inferring other hands from the bidding. v1 bids on its own hand, apart from the two public
  rules below: the partner-holds rule and the plunge 4-doubles constraint.
- Running in the Worker. A bid decision takes seconds, so this is for offline evals, hints,
  and generating data for Stage 3, which distills a fast bidding model.
- Bidding to block opponents, and any risk preference beyond expected marks.
- An exact solver for simulated deals (issue #39).

## 1. Plunge and Low training fix

### Sampler: deal and contract chosen together

`ContractSampler.sample_hand(rng) -> (deal_order, opener, Contract)` replaces "caller shuffles,
then `sample(deal, opener)`". Self-play (`train/selfplay.py`), the arena, and the diagnostics
decision set all use it. Results stay deterministic for a given seed.

- **Plunge kind:**
  - Reshuffle until some seat holds 4+ doubles. About 16% of deals qualify, so this takes
    about 6 tries on average.
  - The cap is 100 tries, then it falls back to the heuristic contract.
  - The plunger is a random qualifying seat. The partner names trump with the heuristic's best
    suit, as before.
- **Low kind:** the bidder and the Low variant come from a "can this hand avoid winning tricks"
  score, not the weakest suit strength.
  - Each domino gets a risk value under each variant:
    - **`LOW` (doubles high):** risk = high pip, plus 3 for a double.
    - **`LOW_DOUBLES_LOW`:** risk = high pip, and doubles count 0.
    - **`LOW_DOUBLES_OWN_SUIT`:** risk = pip for doubles, high pip for everything else.
  - A hand's score is the sum of its risk. Pick the seat and variant with the lowest total;
    ties go to the lowest seat, then to the variant order `LOW`, `LOW_DOUBLES_LOW`,
    `LOW_DOUBLES_OWN_SUIT`.
  - The bid is still 42.
- **Other kinds:** unchanged.

### Fine-tune

`configs/stage1-plunge.yaml` is `stage1.yaml` with these changes:
- **contract mix:** heuristic 0.65, marks 0.08, follow_me 0.07, low 0.10, plunge 0.10.
- **steps:** `total_steps: 230000`. That resumes from `stage1-b`'s step 200000 and adds 30k
  steps, about 1.7 h at the measured ~4.8 steps/s.

Run it with `ml train --config configs/stage1-plunge.yaml --run-name stage1-c --resume
runs/stage1-b/ckpt-latest.pt`.

### Bar (head-to-head: `stage1-c` as A vs `stage1-b` as B)

`ml eval` gains `--kind plunge|low` to restrict an eval to one contract type. Each check below
uses 5,000 duplicate deals.

| Eval | Requirement |
| --- | --- |
| `--kind plunge` | A's marks/deal > 0, with the 95% CI lower bound > 0 |
| `--kind low` | A's marks/deal ≥ 0 (CI lower bound ≥ −0.03); Low-bidder made rate reported (expected well above 16%) |
| normal mix | no regression: A's 95% CI lower bound > −0.03 |

## 2. Simulator (`ml/src/fortytwo_ml/sim/`)

### Play-to-end engine option

`HandState.from_contract(..., play_to_end=False)`:
- **When true,** the official result is recorded the moment the hand is decided, exactly as
  today. Play then continues to 7 tricks (3-domino tricks under Low), and `points` keeps
  accumulating.
- **Default false,** so normal play and TS parity are unchanged.

### `sim/deal.py`

`deal_unseen(seat, hand, rng, require=None) -> deal_order`:
- **Keeps** `hand` (7 dominoes) in `seat`'s slot.
- **Shuffles** the other 21 dominoes among the other seats.
- **`require`:** an optional `(seat, min_doubles)` constraint, enforced by reshuffling and
  capped at 1000 tries. If the cap is hit, it raises `ValueError`.
- **Uses:** the only v1 use of `require` is "the plunger holds ≥ 4 doubles". That applies when
  naming trump for a partner's plunge, and when the bidder evaluates its own plunge, where it
  is satisfied by construction.

### `sim/rollout.py`

`rollout(model, jobs: list[tuple[deal_order, Contract]], device) -> RolloutResult`:
- **Setup:** builds `HandState.from_contract(deal, ..., play_to_end=True)` for every job.
- **The loop:** advances all states in lockstep. Each move, it encodes the candidate rows of
  every active state, runs **one batched forward pass**, and plays each state's argmax. Greedy
  play with no exploration, in all four seats, by the same model.
- **Returns, per job:**
  - the bidding team's final points;
  - whether the bidding team took any trick;
  - the official result: winner and marks.
- **Batching across options:** all of a decision's options go into one call, so batches stay
  large.

## 3. `SimBidder` and `SimAgent` (`ml/src/fortytwo_ml/agents/sim_bidder.py`)

### Options simulated per bid decision (N deals each, default N = 200)

| Option | Played as | Estimates |
| --- | --- | --- |
| each named suit (7) | 30 bid | distribution of the bidding team's points, which gives P(make b) for b = 30..41 |
| each named suit + follow-me (8) | 42 bid | P(team takes all 42 points), for 42 and the marks bids |
| each Low variant (3) | 42 bid | P(team takes no trick) |
| plunge (only with 4+ doubles and plunge legal) | 169, partner names its heuristic best suit in each simulated deal | P(team takes all 7 tricks) |

Options that no legal bid could use are skipped. For example, Low and follow-me aren't simulated
when no bid of 42 or more is legal.

### Scoring and choice: pure function `choose_bid(options, legal_bids, context) -> BidDecision`

- **Expected value:** EV(bid, trump) = marks(bid) × (2·P(make) − 1). Each bid uses its best
  trump.
- **Makeable** means P(make) > `make_threshold` (default 0.5).
- **Rules, in order:**
  1. **Partner holds the high bid:** pass, unless some higher legal bid has P(make) ≥
     `overbid_partner_threshold` (default 0.9). If one does, treat it as rule 3.
  2. **Last to bid** (every other seat has bid): choose the **lowest** makeable legal bid. The
     exception is a marks bid (≥ 84, including plunge) with a higher EV, in which case choose
     that.
     - **If forced** (pass isn't legal) and nothing is makeable: bid the lowest legal bid with
       its best trump.
     - **If not forced** and nothing is makeable: pass.
  3. **Otherwise:** choose the **highest** makeable legal bid. If none, pass. If forced, apply
     rule 2's forced case.
- **The decision records:**
  - the bid;
  - the trump that justified it;
  - the full option table: bid, trump, P(make), EV.

### Trump naming

- **Reuse the bid-time choice.** When `SimBidder` wins, it names the trump recorded with its
  winning bid decision. That keeps the bid and its justification consistent, and it costs
  nothing.
- **Fallback simulation.** Only if no record exists for this hand (a fresh agent, say), it
  simulates the trumps allowed at the actual bid, played at that bid level, and takes the best
  P(make).
- **Partner's plunge.** When a partner's plunge makes this seat the trump namer, it simulates
  the named suits and follow-me with `require = (plunger, 4 doubles)`, played as a plunge. It
  picks the best P(team takes all 7 tricks).
- **Known limitation:** reuse means trump is picked from the same noisy sample that justified
  the bid. The calibration table in Section 4 is how we check whether that biases results (the
  winner's curse). The fix would be an independent confirmation sample, in a later version.

### Agents

- **`SimBidder(model, n_deals=200, make_threshold=0.5, overbid_partner_threshold=0.9, seed=0,
  device=None)`** implements `bid` and `trump`. It keeps a per-hand record of the trumps it
  decided on, and exposes `last_decision` for hints and demos.
- **`SimAgent`** combines `SimBidder` for bidding and trump with `ModelAgent` for play, sharing
  one model. `load_agent("sim:<ckpt>")` builds one.

## 4. Evaluation, speed, CLI, tests

### `evaluate_auctions(a, b, deals, seed)` (in `eval/arena.py`)

- **Setup:** duplicate deals with full auctions. The same deal and opener are played twice with
  the teams swapped.
- **Stage 2 matchup:** A = `SimAgent`, and B = `ModelAgent` (heuristic bidding, Stage 1 play)
  on the same checkpoint. Only the bidding differs.
- **The report:**
  - A's marks/deal with a 95% CI.
  - A breakdown by the winning contract's kind and by which side won the auction.
  - A's auction-win rate and made rate.
  - Bid-decision time, median and p95.
  - **The calibration table:** A's winning bids grouped by predicted P(make) (0.5–0.6, …,
    0.9–1.0), each with its actual made rate. If made rates fall consistently below the
    predictions, that's the winner's curse, and the confirmation-sample fix is next.

### Stage 2 bar

- Over 1,000 duplicate deals, A's marks/deal > 0 with the 95% CI excluding 0, at N = 200.
- p95 bid decision ≤ 30 s on the dev box (8 physical cores, RTX 2070 SUPER).
- Match win rate is reported but is not part of the bar.

### Cost

About 4 simulated bid decisions per duplicate deal at roughly 3–6 s each, so 1,000 deals takes
about 4–7 h. `--sim-deals` allows quick lower-N runs.

### CLI

- `ml eval-bidding --model <ckpt> --deals 1000 [--sim-deals 200] [--matches N] [--seed S]`.
- `ml eval --kind plunge|low`.
- `ml play-demo --agent sim:<ckpt>` prints the option table at every bid decision.

### Tests (none need the GPU)

- **`deal_unseen`:** keeps the hand, produces a permutation, honors `require`, and raises past
  the cap.
- **Play-to-end:** gives the same official result as normal play, and points total 42 when
  nobody sits out.
- **`rollout`:** batched results equal playing the same deals one at a time with `ModelAgent`,
  move for move. This is the key correctness test.
- **`choose_bid` rules:**
  - highest makeable bid;
  - last to bid takes the lowest makeable bid;
  - forced takes 30 unless a marks bid has better EV;
  - partner-holds passes, with the 0.9 override;
  - the marks ladder;
  - plunge legality.
- **Trump reuse:** names the recorded trump; the fallback simulates.
- **Sampler:**
  - plunge deals always have a 4-double plunger (when found);
  - the Low choice follows the risk score;
  - `sample_hand` is deterministic for a seed.
- **Smoke tests:** `evaluate_auctions` and `ml eval-bidding` on a tiny model (hidden 16) with
  about 5 deals at N = 4.
- **Timing:** measured manually on the dev box, as a plan step, not in CI.
