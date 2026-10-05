# ML Bots Stage 4, Milestone 1: ML Bots Fill Seats in Real Games — Design

The bot from Stages 1–3 moves into the Cloudflare Worker. Players can then seat ML bots in open seats of real matches in production, on the web and on mobile. Hints for human players come later, in #76. Self-play bidding is #75.

## Where things stand

**The bot to ship:** fast bidding from `bidnet-2` (BidNet, 512 wide, P(make) table + `choose_bid` at threshold 0.6), plus play from `stage1-c` (QNet, 4 × 512).

**How it scores** (2,000 matches to 7 marks against the heuristic bot):

| Bot | Match win rate |
|---|---|
| Full bot (bidnet-2 bidding + stage1-c play) | **79.5%** [77.8, 81.3] |
| Same play, heuristic bidding | 73.8% |

**Speed:** about 1–3 ms per bid in Python.

**What exists today in the Worker** (`cloudflare/apps/worker`):
- `MatchDO.addBots` seats bots (`bot-1` to `bot-3`) in open seats, and only a player already at the table can do it.
- Bot moves run on the Durable Object's alarm, one action per tick, `BOT_MOVE_DELAY_MS` = 600 ms apart.
- `bots.ts`'s `decideBid`, `decideTrump` and `decideDomino` are deliberately simple.
- All of this is dev-only, behind `AUTO_PLAY_BOTS`.
- `/api/config` reports `{ bots }`. The web app's `Match.tsx` uses it to show the add-bot controls, and the mobile app on `master` uses it to show "Fill with bots".

**Constraints:**
- **The Workers Free plan:** 10 ms of CPU per invocation.
- **The model lives in TypeScript.** The play model's encoder (`ml/src/fortytwo_ml/features.py`) and both networks exist only in Python today.

## Goals

1. **Bots in production.** In production, any player at the table can seat **ML bots** in open seats, on the web and mobile clients.
2. **Same decisions as Python.** The TypeScript bot makes **exactly the decisions the Python bot would**, proven by golden fixtures.
3. **Within the Free plan.** Every bot action fits the Free plan's CPU budget, checked by a timing spike before integration.
4. **A model problem never stalls a match.** If the model is missing or broken, bots fall back to the simple rules and log why.

## Non-goals

- **Hints** (#76) and **self-play bidding** (#75).
- **Running inference outside the Worker** (a Python service, or Python Workers) and **ONNX Runtime**: its WebAssembly bundle is too large for the Free plan.
- **Bot display names, bot difficulty levels, auto-filling seats when players leave, and one-click solo games from the lobby.**
- **Smarter play after a hand is decided.** Bots play their first legal domino then.

## Prerequisite

This work builds on current `master`, which is 29 commits ahead of the ML-bots branch when this spec was written. That includes the mobile app (`cloudflare/apps/mobile`) and a small `@fortytwo/rules` refactor (`pointsToMakeBid`). Bring `master` into the branch before implementation starts.

## 1. The `@fortytwo/bot` package

**What it is.** A new pure-TypeScript workspace package, `cloudflare/packages/bot`. Its only runtime dependency is `@fortytwo/rules`. It's tested with vitest like the other packages.

| Module | Job | Ports |
|---|---|---|
| `view.ts` | Turns a `Game` plus the bot's player id into what the encoder reads: the bot's hand, the dominoes each relative seat has played, the current trick in play order, the led suit, trump, the high bid and the bidder, each seat's voids (led suits it failed to follow), both teams' points, the trick count, and who sits out under Low. | the `HandState` fields that `features.py` reads |
| `encode.ts` | The play encoding: 363 floats per legal domino (observation + action features), in exactly the layout of `features.py`. The BidNet encoding: 36 floats. | `features.py`, `bidding/model.encode_hands` |
| `mlp.ts` | A forward pass over float32 weights (Linear + ReLU). For the play network, the observation's share of layer 1 is computed once per decision and reused for every candidate. | `QNet.forward`, `BidNet.forward` |
| `bidding.ts` | BidNet output → P(make) table (points buckets cumulated, sigmoid binaries) → bid options for the legal bids → the `choose_bid` rules (`make_threshold` 0.6, `overbid_partner_threshold` 0.9). | `BidNet.table`, `sim/probe.options_from_table`, `sim/decide.choose_bid` |
| `bot.ts` | `createBot(weights)` returns `{ decideBid(game, playerId), decideTrump(game, playerId), decideDomino(game, playerId) }`, the same shape as today's `bots.ts`. | `FastAgent` |

**Trump naming.** The bot is **stateless**, so nothing has to survive between alarms, even if the Durable Object is evicted.
- **The bot's own winning bid:** the legal trump with the highest P(make) at the winning bid, recomputed from the table. This is always the trump that justified the bid. Python's remembered plan is `choose_bid`'s best option at that bid, with the same tie-break (first maximum in option order), so recomputing gives the same answer. The fixtures pin this.
- **A partner's plunge:** the legal trump (named suits and follow-me) with the highest 42-level P(make) from the bot's own table, `table.high`. This replaces Python's heuristic `best_suit`, which only looked at length and the double. The table's 42-level probability (take every point) is the target a plunge needs, and it includes follow-me. Python's `FastBidder` changes the same way, so the two stay in step. It matters in production because a human who plunges with a bot partner gets trump named by the bot.

**After the hand is decided,** while play continues until everyone is ready, the bot plays its first legal domino without inference. The play model never trained past the decision point, and nothing rides on those moves.

## 2. Exporting and loading the weights

**`ml export`** (new):
```
uv run ml export --play runs/stage1-c/ckpt-latest.pt --bidnet runs/bidnet-2/bidnet.pt --out ../cloudflare/apps/web/public/models
```
It writes two files:
- `bot.bin`: every tensor of both networks as little-endian float32, back to back.
- `bot.json`: the manifest, containing:
  - a `format` version;
  - each tensor's name, shape and byte offset;
  - `totalBytes`;
  - `sha256` of the bin;
  - the encoder layouts (`playInputDim` 363, `bidInputLayout` 1);
  - the thresholds (`makeThreshold` 0.6, `overbidPartnerThreshold` 0.9);
  - provenance: play checkpoint label and step, the bidnet path and its training data's checkpoint, and the export time.

The command refuses to export a bidnet whose recorded play checkpoint differs from `--play`.

**Git LFS:**
- `.gitattributes` tracks `cloudflare/apps/web/public/models/*.bin` with LFS. The manifest stays in normal git.
- The `deploy` job in `.github/workflows/cloudflare.yml` checks out with `lfs: true`.

**Loading in the Worker:**
- `wrangler.toml`'s `[assets]` gains `binding = "ASSETS"`.
- On the first bot action in an isolate, the Worker fetches `/models/bot.json` and `/models/bot.bin` through `env.ASSETS`.
- **Checks:**
  - the bin's length must equal `totalBytes`;
  - it must not begin with an LFS pointer header (`version https://git-lfs`);
  - `format`, `playInputDim` and `bidInputLayout` must match what the package implements.
- The tensors become `Float32Array` views over the one buffer, with no copying or parsing, and are kept in a module-level cache.
- The SHA-256 is checked by `ml export` and by a test, not at runtime: hashing 6 MB would use most of the Free plan's CPU budget.

## 3. The Worker and clients

**Bot moves:**
- `matchDO.ts`'s `applyBotAction` asks the ML bot for bids, trump and plays. Pacing and seating are unchanged.
- **Fallback:** if loading the model failed, or inference throws for an action, that action uses today's simple `decideBid`/`decideTrump`/`decideDomino`, which stay in `bots.ts`. One line is logged with the reason. A load failure is logged once per isolate.

**Turning bots on:**
- `AUTO_PLAY_BOTS` is replaced by **`BOTS_ENABLED`**. Bots are on unless it is `false`, so production gets them with no configuration. It serves as a kill switch that can be flipped in the Cloudflare dashboard without a deploy.
- `/api/config` keeps reporting `{ bots }`. The web (`Match.tsx`) and mobile (`match/[id].tsx`) controls therefore appear in production with no client logic changes.
- The "dev-only" comments and README sections are updated.
- Only a player already at the table can add bots (`MatchDO.addBots`), as today.

## 4. Parity fixtures and tests

**`ml export-fixtures`** (new) writes small golden data to `cloudflare/packages/bot/test/fixtures` in normal git:
- `tiny-bot.bin` and `tiny-bot.json`: a random `QNet(hidden=16, layers=1)` and `BidNet(hidden=16, layers=1)` in the Section 2 format.
- `hands.jsonl.gz`: complete hands with all four seats bid and played by that tiny Python bot. Each hand records the deal, the opener and every action. Each decision also records:
  - **play:** the legal dominoes, each candidate's nonzero encoder entries (index → value), the Q-values, and the chosen domino;
  - **bid:** BidNet's 36 inputs, the P(make) table, the options, and the chosen bid;
  - **trump:** the chosen trump.
- **Coverage:** hands are drawn until the file covers points, marks, follow-me, every Low variant, and a plunge with a partner naming trump. About 300 hands are expected, and the actual count is reported.

**TypeScript tests** (`packages/bot`):
- **Replay:** every fixture hand is replayed through `@fortytwo/rules` (`placeBid`/`setTrump`/`playDomino`). At each decision:
  - the encodings must match exactly;
  - the P(make) table and Q-values must match within 1e-5;
  - the chosen bid, trump or domino must match exactly.
- **Loader:** size mismatch, LFS pointer, and layout or format mismatch.
- **Fallback:** a missing model gives the simple bot's decisions.
- **Real manifest:** `apps/web/public/models/bot.json` declares the encoder layouts this package implements. This catches a retrain with new features but no TypeScript update, without downloading the LFS bin.

**Python tests:**
- `ml export` round-trips: reloaded tensors give identical outputs, and the manifest's sha256 and offsets are right.
- `export-fixtures` is deterministic for a seed.
- The `FastBidder` partner-plunge trump is the best `table.high` legal trump.

**CI:** the existing Cloudflare test job runs the new package's tests, using the tiny fixture weights only, so it needs no LFS.

## 5. Timing check, fallbacks, rollout

**Timing spike** (first, before Worker integration): `packages/bot/bench` loads the real `bot.bin` and replays a few hundred real positions in Node: bids, trump calls, and plays with 1–7 candidates. It reports the median and p95 per decision, and the cold-load cost.
- **Bar:** p95 under **5 ms** per decision. That's half the Free plan's 10 ms, leaving headroom for the rules engine, storage and broadcast in the same alarm.
- **If it misses:**
  1. optimise the code (preallocated buffers, a fused first layer);
  2. distil a smaller play model and check its strength against stage1-c before shipping;
  3. switch to Workers Paid.

**After deploy:**
- Play a few matches with three bots.
- Check the Worker's logs and metrics for CPU-limit errors and fallback lines.
- `BOTS_ENABLED=false` turns bots off without a deploy.

**Order:**
1. Bring in `master`.
2. Python: partner-plunge trump, `ml export`, `ml export-fixtures`.
3. The `@fortytwo/bot` package with parity tests.
4. The timing spike on the real export.
5. Worker integration, `BOTS_ENABLED`, LFS and the deploy checkout.
6. The real export committed, then a manual check in `wrangler dev` with three bots.

**Issue #76** (hints) is updated with what this milestone provides: the decision interface, the encoder and the timing numbers.
