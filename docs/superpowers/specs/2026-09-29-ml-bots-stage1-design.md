# ML Bots, Stage 1: Python Engine, Parity Harness, and Play Model — Design

## Context

The only bots today are the dev-only auto-play bots in `cloudflare/apps/worker/src/bots.ts`: they
pass unless forced, name their most-held suit as trump, and play the first legal domino. They exist
to keep a match moving during local testing, not to play well.

We want a trained model that plays Forty-Two competently, for two uses:

1. **Real bots in the live game** — competent partners and opponents to fill open seats.
2. **Hints and analysis** — suggesting bids and plays to human players, or reviewing finished hands.

Both need a trained policy whose inference can run from TypeScript (in the Worker, or the browser).
Training happens in a new Python project on a local NVIDIA GPU.

## Roadmap

The work is staged. Every stage ends with something usable and measurable. **This spec covers Stage
1 only**; later stages get their own spec and plan when we reach them.

| Stage | What | Result |
| --- | --- | --- |
| **1** | Python rules engine + TS parity harness, a play (trick-taking) model trained by self-play, and an evaluation framework. Bidding and trump in Stage 1 come from a heuristic *contract sampler*. | A play model that handles every contract type and clearly beats the heuristic bots at trick-play. |
| 2 | **Bidding by simulation**: for each candidate bid and trump, deal the unseen dominoes many times and play the hand out with the Stage 1 model; bid on the resulting expected outcome. | Competent bidding and trump choice without a separately trained model, but too slow for a Worker. |
| 3 | **Fast bidding model**: a small network distilled from Stage 2's decisions, then improved with full-game self-play, including when marks bids and plunge are worth the risk. | Instant bidding suitable for inference in a Worker. |
| 4 | **Ship**: ONNX export, a TS observation encoder with its own parity test, Worker bots behind a flag, and a hint endpoint for the web app. | ML bots and hints in the product. |

## Goals (Stage 1)

- A Python port of the hand rules that is proven equal to `@fortytwo/rules` by an automated
  differential test run in CI.
- A play model trained by self-play that makes every trick-play decision (leading, following,
  trumping, dropping count) under every contract the game allows: points bids, marks bids, plunge,
  follow-me, and all three Low variants.
- An evaluation command that reports the model's strength against the existing bot, a stronger
  heuristic bot, and earlier checkpoints, with confidence intervals.

## Non-goals (Stage 1)

- Learned bidding or trump choice (Stages 2–3).
- ONNX export, a TS inference path, or any change to the Worker or web app (Stage 4).
- A distributed or cloud training setup. Training runs on one machine: CPU actor processes feeding
  one local GPU learner.
- A perfect-information (double-dummy) solver. It could be a useful oracle later, but nothing in
  Stage 1 needs one.

## Project layout

A new root project, `ml/`, sits next to `cloudflare/` and `FortyTwo/`:

```
ml/
  pyproject.toml              # uv-managed; Python 3.12, torch (CUDA build), numpy, pyyaml,
                              #   tensorboard, pytest
  README.md                   # setup (uv, CUDA torch), commands, how parity works
  configs/
    stage1.yaml               # training hyperparameters + contract-sampler mix
    smoke.yaml                # tiny config for the CI smoke test (CPU, a few hundred steps)
  src/fortytwo_ml/
    engine/
      dominoes.py             # the 28 dominoes as ints 0..27, pips, count values, doubles
      rules.py                # suit membership, rank, and led suit under each trump; tables
      bidding.py              # port of availableBids / availableTrumps
      hand_state.py           # one hand as a state machine: deal → bid → trump → play → decided
      match.py                # thin match loop (marks to 7, who opens next); used by eval only
    agents/
      base.py                 # Agent protocol: bid(), trump(), play() over a player's view
      dumb_bot.py             # exact port of bots.ts
      heuristic_bot.py        # a stronger rule-based player (the real baseline to beat)
      model_agent.py          # wraps a trained checkpoint
    contracts.py              # contract sampler for Stage 1 training hands
    features.py               # observation + candidate-action encoding
    model.py                  # the Q-network
    train/
      actor.py                # self-play worker process
      learner.py              # GPU training loop
      buffer.py               # shared replay buffer
      run.py                  # wiring, checkpoints, TensorBoard
    eval/
      arena.py                # duplicate-deal hands and matches between agents
      report.py               # metrics + confidence intervals
    cli.py                    # `ml train`, `ml eval`, `ml play-demo`
  tests/
    test_dominoes.py, test_rules.py, test_bidding.py, test_hand_state.py
    test_parity.py            # replays TS-generated traces
    test_features.py
    test_agents.py
    test_train_smoke.py
    fixtures/ts-traces.jsonl  # committed traces from the TS engine
  runs/                       # gitignored: checkpoints, configs, TensorBoard logs per run
cloudflare/packages/rules/scripts/dump-traces.ts   # generates traces from @fortytwo/rules
```

## Engine

The engine simulates **one hand**. It has no player ids, no persistence, and no views: seats are
0–3, teams are `seat % 2`, and a hand is a small mutable state (or a cheap copy when the caller
needs one).

### Representation

- A domino is an int 0–27, with a fixed order (0/0, 0/1, … 6/6) matching the TS
  `shuffledDominoOrder` generation order. A hand is a 28-bit mask.
- Per trump value (the 7 suits, follow-me, and the 3 Low variants) we precompute tables once at
  import: for every domino, its suit membership mask (`isOfSuit`), its led suit (`getSuit`), and
  its rank for every led suit (`getSuitValue`). Legal moves and trick winners are then table
  lookups plus bit operations.

### Rules to reproduce exactly (from `packages/rules`)

- **Count:** a domino whose pips sum to a multiple of 5 is worth that sum. Each trick is worth 1
  point plus its count; 42 points in total.
- **Suits and rank:** `isOfSuit`, `getSuit` and `getSuitValue` in `domino.ts`. A trump domino is
  never of its other suit. Doubles rank highest in their suit, except under `LowDoublesLow`, where
  they rank lowest, and `LowDoublesOwnSuit`, where doubles form their own suit (7), ranked by pip.
  Under follow-me (`Suit.None`) nothing is trump, and a domino led counts as its higher end.
- **Follow suit:** a player holding the led suit must play it (`assertValidDomino`).
- **Bidding:** `availableBids`:
  - Pass is allowed unless the other three passed.
  - Bids must go strictly higher.
  - Marks bids climb one rung at a time above 84.
  - Plunge needs 4+ doubles and a high bid under 4 marks.
  - Bidding starts with the hand's opener and goes around the table once.
- **Trump:** `availableTrumps`:
  - The 7 suits always.
  - Follow-me and the 3 Low variants once the bid is at least 42.
  - A plunge gets follow-me but never Low.
  - On a plunge, the bidder's partner names trump.
- **Low:** the bidder's partner sits out. Tricks have three dominoes. The bidding team wins by
  taking no tricks.
- **Who leads and who plays next:** the first lead and turn order follow `matchEngine.ts`, and the
  trick winner leads the next trick.
- **Hand result:** `gameWinningTeam`, with the hand **decided as soon as** a team reaches its
  target, which may be before seven tricks. Marks scored come from `gameValue`: 1 for a points bid,
  `floor(bid / 42)` otherwise. Plunge and marks bids need all 42 points.

The engine raises on any illegal action. It never corrects or ignores one.

### API sketch

```python
state = HandState.deal(deal_order: list[int], opener: int)
state.phase            # BID | TRUMP | PLAY | DONE
state.to_act           # seat
state.legal_actions()  # list of bids, trumps, or dominoes depending on phase
state.apply(action)    # raises IllegalAction
state.result           # once DONE: winning team, marks, points per team
```

`HandState.from_contract(deal_order, opener, bidder, bid, trump)` skips straight to play. The
Stage 1 trainer and parts of the parity test use it.

## Parity harness

`cloudflare/packages/rules/scripts/dump-traces.ts` (run with `npm run dump-traces -w
@fortytwo/rules -- --count N --seed S --out <path>`) drives the real TS engine through random
hands:

- Deal from a seeded shuffle.
- Pick uniformly among legal bids and legal trumps (plus an oversampling knob so that plunge,
  follow-me, and every Low variant appear often).
- Play uniformly random legal dominoes until the hand is decided.

It goes through `matchEngine`'s `placeBid` / `setTrump` / `playDomino`, so the trace reflects the
actual public API. Each hand becomes one JSONL line:

```json
{"id": 17, "deal": [/* 28 domino ids in deal order */], "opener": 2,
 "steps": [{"seat": 2, "phase": "bid", "legal": [...], "action": 0}, ...],
 "result": {"winningTeam": 1, "marks": 1, "points": [12, 31]}}
```

`test_parity.py` loads `tests/fixtures/ts-traces.jsonl` (about 5,000 hands, committed). For each
hand it deals the same order in Python, then at every step asserts that the seat to act and the
**set of legal actions** match exactly before applying the recorded action. At the end it asserts
the result. A failure reports the trace id, the step index, and the differing sets.

**CI:** a new workflow, `.github/workflows/ml.yml`, runs on changes under `ml/`,
`cloudflare/packages/rules/`, or the workflow itself. It:

1. Runs `ml` unit tests against the committed traces.
2. Regenerates a fresh batch of traces with a new seed from the current TS engine and runs parity
   against those too, so a TS rule change that isn't ported to Python fails CI even if nobody
   updates the committed fixture.
3. Runs the training smoke test on CPU.

## Stage 1 play model

### Algorithm: Deep Monte-Carlo (DMC) self-play

The method behind DouZero. A network estimates `Q(observation, candidate domino)`, the expected
final hand reward for the acting player's team if they play that domino. At decision time we score
every legal domino (at most 7) and pick the best. During self-play the choice is ε-greedy.

Training targets are the **actual final reward** of the hand (Monte-Carlo returns, no
bootstrapping). This works well here because hands are short (7 tricks at most) and the action
space is tiny.

**Why not PPO:** it needs a separate value network and tuning of on-policy batches and clipping.
DMC is simpler and has a proven track record in similar imperfect-information card games. If DMC
plateaus, PPO is the fallback. The feature encoder, engine, and evaluation code are
algorithm-agnostic.

**Process layout (single machine):**
- `N` actor processes (default: CPU cores − 2) each hold a CPU copy of the network. They play
  self-play hands, with all four seats using the current network, and push
  `(observation, action, reward)` samples into a shared-memory buffer.
- The learner process samples batches on the GPU, minimizes MSE between `Q` and the reward, and
  publishes new weights to the actors every `K` steps.

### Observation encoding (`features.py`)

Everything is from the acting seat's point of view, with seats rotated so the actor is always seat
0, partner 2, and opponents 1 and 3:

| Feature | Size |
| --- | --- |
| Own hand | 28 |
| Dominoes already played, per relative seat | 4 × 28 |
| Current trick: domino in each relative seat's slot (zero if not yet played) | 4 × 28 |
| Led suit of the current trick (7 suits + Doubles + none) | 9 |
| Trump (7 suits, follow-me, 3 Low variants) | 11 |
| Bid level (one-hot over the 21 bids) | 21 |
| Bidder's relative seat; whether it's a plunge; whether my partner sits out | 4 + 1 + 1 |
| Inferred voids: each other seat × each led suit they failed to follow | 3 × 8 |
| Points taken so far per team, and tricks played (scaled) | 3 |
| Candidate domino | 28 |

The model is an MLP: input → 4 × 512 (ReLU) → 1. The encoder is a pure function of the hand state
and seat, so Stage 4 can port it to TS and parity-test it the same way as the engine.

### Reward

- `+marks` if the actor's team wins the hand, `−marks` if it loses.
- Plus a shaping term `α · (our points − their points) / 42`, where `α` starts at 0.25 and decays
  linearly to 0 over the first `S` learner steps (configurable). The shaping speeds up early
  learning, and once it reaches 0 the network is optimizing the true objective.

### Contract sampler (`contracts.py`)

Bidding isn't learned yet, so each training hand gets its contract from a sampler. With
configurable probabilities it uses one of:

- **Heuristic** (default ~70%): `heuristic_bot` bids and names trump on the real deal, so common
  contracts look like real play.
- **Forced exotics** (~30% total, split across types): a seat whose hand supports it is made the
  bidder with a marks bid, follow-me, one of the three Low variants, or plunge (only when some seat
  holds 4+ doubles, with the partner naming trump).

The sampler always produces a contract the engine would accept.

### Heuristic bot (`heuristic_bot.py`)

It's the baseline the model must beat, and the default contract source.

- **Bid:** estimate a hand's strength from trump length, trump doubles, and count held under its
  best suit; bid 30–42 on a threshold table, pass otherwise, and bid 30 when forced.
- **Trump:** the suit with the most dominoes, with doubles as a tiebreaker.
- **Play:**
  - Lead a high trump while the opponents may still hold trumps.
  - When following, win the trick cheaply if possible.
  - When partner is winning, drop count on partner's trick.
  - Otherwise throw the lowest non-count domino.
  - Under Low: avoid taking tricks (play under whenever possible).

### Running it

```
uv run ml train --config configs/stage1.yaml [--run-name NAME] [--resume PATH]
uv run ml eval  --a runs/<run>/ckpt-latest.pt --b heuristic --deals 5000 [--matches 500]
uv run ml play-demo --agent runs/<run>/ckpt-latest.pt   # prints one hand, decision by decision
```

Each run writes to `ml/runs/<name>/`: the resolved config, checkpoints every `M` minutes plus
`ckpt-latest.pt`, and TensorBoard scalars (loss, mean Q, samples/sec, periodic eval vs. heuristic).

## Evaluation

`eval/arena.py` plays **duplicate deals**. Each deal is played twice with the same dominoes and the
teams swapped between seats, so both agents play both sides of every deal. This cancels most deal
luck.

Contracts in hand-level evaluation come from the same contract sampler, with the seed fixed per
deal so both sides of a duplicate pair face the same contract. Match-level evaluation plays full
matches to 7 marks, with each agent's own bidding (the heuristic for all agents in Stage 1).

`report.py` prints:
- Contract success rate when the agent's team bid, and set rate when it defended, broken down by
  contract type (points, marks, plunge, follow-me, Low).
- Mean marks per deal, with a 95% confidence interval.
- Match win rate, with a 95% confidence interval (when `--matches` is given).
- A count of illegal actions attempted, which must be 0.

**Stage 1 is done when**, over at least 5,000 duplicate deals:
- the model's mean marks per deal against `heuristic_bot` is positive and its 95% confidence
  interval excludes zero;
- the model beats `heuristic_bot` in each contract-type bucket that has enough samples, or at
  least isn't significantly worse;
- it makes zero illegal actions.

## Testing

- **Engine unit tests:**
  - count values, and suit and rank tables for every trump, including each Low doubles rule;
  - follow-suit;
  - bidding ladders (marks rungs, plunge eligibility, forced bid);
  - trump availability;
  - Low's three-domino tricks and the partner sitting out;
  - the hand ending early once decided.

  Where the TS tests cover a case (`domino.test.ts`, `trick.test.ts`, `game.test.ts`,
  `validation.test.ts`), the Python test mirrors it.
- **Parity:** `test_parity.py` as described above, on the committed traces and, in CI, on fresh
  ones.
- **Features:** hand-built states check seat rotation, inferred voids, the current-trick slots,
  each trump's one-hot, and plunge/Low flags.
- **Agents:** `dumb_bot` mirrors the cases in `apps/worker/src/bots.test.ts`. Every agent only
  ever returns legal actions over thousands of random hands.
- **Training smoke test:** `configs/smoke.yaml` on CPU with 2 actors, a few hundred learner steps,
  and a finite loss. Then a checkpoint saves, reloads, and plays a legal hand.

No test needs a GPU.

## Error handling

- Illegal actions raise `IllegalAction` with the seat, phase, action, and legal set. Actors crash
  loudly rather than skipping samples, and the learner exits if an actor dies.
- Parity failures name the trace id, step, and the differing legal-action sets.
- `ml train` refuses to start if the config asks for CUDA and none is available, unless the config
  explicitly allows falling back to CPU.
