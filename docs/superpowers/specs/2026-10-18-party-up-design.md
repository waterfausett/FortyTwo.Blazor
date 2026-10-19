# Party up: queue for the next Live game with your partner

Issue #124.

## Why

When a Live game ends, the only way to keep playing together is **Rematch**, which needs all four
players. If you liked your partner but not the table, or the other side is leaving, you're on your
own: back out to the lobby and search alone, and you'll almost certainly never sit with that
partner again.

Two partners should be able to say "let's keep going together" and land on the same team in the
next game, the same way a solo player presses Live and lands somewhere.

## Goals

- When a **Live** game ends, the end-of-game panel offers three ways on:
  - **Party up with <partner>**: you and your partner search together as a team.
  - **Find a game**: you leave and search alone right away, as if you'd backed out and pressed Live.
  - **Rematch**: the same four again, unchanged from today.
- When both partners press Party up, the second press starts the search for both of them. They
  land on the same team: at a table still filling with a whole team free, in a game under way with
  two bot seats on one team, or at a new table. After that it's a normal table: waiting, then bots
  after the usual wait.
- Each player can see what their partner has chosen, and an offer ends cleanly when the partner
  moves on.
- **The rematch backdoor closes.** Today a player can be in two Live games at once: search for a
  Live game, then go back to a finished Live game and complete its rematch vote. Every way into a
  new Live game must respect "one Live game at a time".
- Web and mobile both.

## Non-goals

- **Teaming up from the lobby.** It gets its own ticket. A rough idea for it: a "Party up" invite on
  someone in Recent players or Friends; accepting makes a party that searches as soon as either
  of you presses Live. That reuses the pair search built here.
- **Pairs facing only pairs.** A pair may sit with two solo players or bots. A queue that matches
  parties against parties is #123's "real queue", not this.
- **Daily, Challenge, Over the table, vs Bots.** Their end-of-game screens stay as they are today.
- **A party that lasts beyond one search.** Once the pair is seated, they're two players at a
  table. Leaving that table works as it does today. Partying up again at the end of the next game
  is another Party up.
- **A party leader.** Not needed: the second press is consent from both.
- **Older mobile builds.** The owner's phone is the only install, so the worker and clients can
  ship together with no release order or flag.

## Anti-goals

- **Dropping someone into a game they aren't watching.** An offer only counts while its maker is
  still on that game's screen (see *Offers lapse*). Pressing Party up an hour after your partner
  put the phone down must not seat them anywhere.
- **Anyone ending up in two Live games.** This applies to Party up, Find a game and Rematch.
- **Half a pair seated.** Both partners get seated or neither does.

## The end-of-game panel

### Where it appears

Only in a Live match that is over, with the viewer seated. The **Party up** button only appears
when the viewer's partner (the other seat on their team) is a person. With a bot partner it's
left out and the other two buttons stay.

### Game screen (the usual case): stacked (decided)

The panel above your hand (the "You won the match" panel with the **Match summary** button and
**Rematch** today) shows three full-width buttons stacked in this order:

1. **Party up with <partner name>** (team colour, turquoise)
2. **Find a game** (brass, the main action colour)
3. **Rematch** (outline)

The panel grows to fit. Since the match is over, the table and any leftover dominoes need little
room, so the panel grows **upward over the table** and the hand stays put. *(My call.)* The back
arrow stays the way out to the lobby, as today.

### Match summary sheet: two rows (decided)

The summary sheet (opened only from its button, as today) keeps its **Lobby | Rematch** row and
adds a **Find a game | Party up** row under it.

Mockups: `.superpowers/brainstorm/312641-1792374588/content/end-screen-both.html` (both screens)
and `end-screen-layout.html` (the button states). This folder is gitignored and local only.

### Button states (decided)

Labels can be tuned. What matters is what each one tells you:

| Situation | Party up button | Rematch |
|---|---|---|
| Nobody has offered | **Party up with Sam** | as today |
| Sam offered first | **Party up with Sam**, with a note "Sam wants to party up ✓". Your press starts the search. | as today |
| You offered first | **Waiting for Sam…** (tap to cancel) | live again only after you cancel your offer |
| Sam pressed Find a game, left, or his offer lapsed | **Sam left**, disabled | disabled, since it needs all four |
| Sam is in another Live game | **Sam is in another game**, disabled | disabled |
| You and Sam already partied up | **Go to your new game** (link) | n/a |

**Party up and Rematch are a choice you switch between.** Pressing Party up withdraws your rematch
vote. Pressing Rematch withdraws your Party up offer. *(My call: you can't both leave with your
partner and stay at this table.)* **Find a game** withdraws both.

## How it behaves

### Offers and votes on the finished match

The finished match records each player's choice: a rematch vote (`rematchVotes`, as today), a party
offer (new), or "moved on" (pressed Find a game, or lapsed). One choice per player.

- **Party up** records your offer. If your partner's offer is already there, this press starts the
  pair search (below) instead.
- **Cancel** removes your offer.
- **Find a game** marks you moved on on the finished match, then runs a normal solo Live search. The
  client goes to the match it returns, as pressing Live in the lobby does.
- **Rematch** records your vote and removes your offer.

Each change is broadcast like any other, so your partner's buttons update live.

### Offers lapse (decided)

**Live matches only.** Every other mode's rematch votes behave as today: a Daily player votes and
leaves, and that must keep working.

An offer or rematch vote counts only while its maker is on that game's screen. When a player's last
socket on the finished match closes (they left the screen, backed out, or the app went to the
background), their offer and rematch vote are withdrawn after a **grace period of about 30
seconds**. Briefly switching apps doesn't kill the offer. If a socket of theirs reopens within the
grace period, nothing is withdrawn.

**A player with no socket open when the match ends** (on autopilot, app in the background during
the last hand) starts the same grace period at the moment the match is won. *(My call.)*

**A lapse isn't final; Find a game is.** *(My call.)* While a player is away, their partner sees
"Sam left" and Rematch is disabled. If Sam comes back to the screen, the buttons come back to
life for everyone, though his offer and vote are gone and he presses again. Pressing **Find a game**
(or being in another Live game, below) ends it for good. So "moved on" is stored only for Find a
game. "Away" comes from who is watching plus the grace timer.

The MatchDO already knows who has a socket open (`watchingPlayers`). The grace period needs a
timer, for which the DO's existing alarm is the natural place. *(How to schedule it alongside the
alarm's other jobs is up to the builder.)*

For Rematch, a lapsed vote drops out of the "N of 4" count, and the button is disabled while anyone
is away or moved on.

### The other team (my call)

Each team's choice is its own. When one team partied up (its new-match id is written), its two
players count as moved on: the other team sees Rematch disabled, but can still party up together
or find a game.

### One Live game at a time (decided: fixes the backdoor)

Before **any** new Live game is created or joined from a finished match, a pair search or the vote
that completes a Live rematch, each person involved is checked for a Live game they're already in:
seated in one under way, or **waiting on a bot seat they claimed**. `findActiveLiveMatch` (D1) only
sees seated players, since claims never reach D1. The Matchmaker's index sees both (`tablesOf`).
So the check asks the Matchmaker, which confirms with the table as its Live search already does.
*(My call: one source of truth, and it runs in the Matchmaker's turn queue, so it can't race a
search.)*

- **Rematch:** if anyone who voted is in another Live game, the rematch isn't created. That
  player's vote is removed (they've moved on), and the others see Rematch disabled as for anyone
  who left. *(My call on removing the vote, not just refusing: otherwise the table is stuck on a
  vote that can never count.)*
- **Party up:** if either partner is in another Live game, no search runs. The offer is removed,
  and the other partner sees "Sam is in another game". If it's the presser themselves, they're
  sent to their current game, as the Live button does.
- **Find a game** already goes through `POST /api/matchmaking`, which takes a player in a Live game
  back to it.

The lapse rule makes this rare, since a player who went off to search has usually lost their offer
or vote already. The check is what makes it impossible.

### The pair search

The second Party up press makes **one** Matchmaker call for the pair, a new `playPair(a, b)` beside
`play(playerId, mode)`, Live only, run in the same one-at-a-time turn queue.

Order to try, oldest table first within each step (`searchOrder`):

1. **A Live table still filling with a whole team free:** seats 0 and 2, or 1 and 3, both empty.
   Empty seats on opposite teams don't count.
2. **A Live game under way with two unclaimed bot seats on the same team**, taken over at the next
   hand break the way a solo claim is today (`claimSeat` / `seatChangesAtBreak`). Both claims must
   land on that team's two bot seats. Today a solo claim takes "bot seats, lowest position first",
   so a pair claim needs to be pinned to its team's positions.
3. **A new Live table** with the pair at seats 0 and 2.

**Both or neither.** MatchDO gets pair versions of `takeSeat` and `claimSeat` (e.g.
`takeTeamListed(a, b, positions, dealOrder)`, `claimTeamListed(a, b)`) that apply both in one
update and refuse both if either can't go. Creating a table for two seats the second player in the
same update. *(Exact names and signatures are up to the builder.)* Each returns its listing like
the solo versions, so the seat index stays right.

`seatIndex.ts` needs the matching helpers: a table with a whole team free, and a game under way with
two bot seats on one team that aren't claimed.

**Getting both clients there.** As with a rematch, the new match's id is written on the finished
match, **per team** (e.g. `partyMatchIds: { [team]: matchId }`), since both teams may party up
separately. Each partner's client follows it off the broadcast, as it follows `rematchId` today,
and shows **Go to your new game** if the old match is opened later. Both partners count as
watching the new table (`onTheWay`, as for a rematch), so neither gets a push for it.

**Lobby rows.** Both partners' lobby rows for the new match sync, as `POST /api/matchmaking` does
for a solo player (`syncLobbyIndex`).

If the search throws (a table unreachable, the Matchmaker failing), nothing is written on the old
match. Both offers stay, and the second presser's button stays live to try again, the same as a
rematch whose creation fails today.

### Solo seat order (decided)

Today `freeSeat` gives a solo player the lowest free seat, so a table's first two players sit at 0
and 1, on opposite teams, and no team is ever left free for a pair. Solos at **Live** tables now fill
**one team first: 0, 2, 1, 3**. Daily tables keep the lowest free seat, since pairs never search
there. *(My call.)* A table then keeps a whole team free until its third player arrives.

The first two strangers at a table become partners. That changes who plays with whom, and it's
accepted.

## Constraints

- Cloudflare Durable Objects: the Matchmaker is one DO (`global`), and its plays run one at a time
  (`inTurn`). The pair search runs in that same queue.
- The seat index (#173 / PR #175) is on master. Pair searches read it the same way solo ones do.
- MatchDO sockets use the Hibernation API. `webSocketClose` runs after eviction too, so the lapse
  timer can't live in memory.
- Stored matches must still read: new `MatchState` fields are optional.

## Left to the builder

- Field names and shapes on `MatchState` for offers, "moved on" and the per-team new-match id.
- The REST routes (e.g. `POST /api/matches/:id/party`, `DELETE` to cancel, an endpoint for Find a
  game's "moved on"), and the matching `@fortytwo/client` API calls.
- How the lapse timer shares the MatchDO alarm.
- Where the "who's my partner, is it a person" helper lives (rules or client).
- Button label wording, within the meaning in the table above.
- Test coverage at the usual levels: rules unit tests, MatchDO and Matchmaker DO tests, route tests,
  and web/mobile component tests for the panel states.
