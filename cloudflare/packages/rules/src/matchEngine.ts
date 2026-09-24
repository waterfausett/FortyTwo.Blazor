// Port of `FortyTwo/Server/Services/MatchService.cs`'s 6 mutating methods (`CreateAsync`,
// `AddPlayerAsync`, `PatchPlayerAsync` + its private `ReadyUp`/`Deal` helpers, `BidAsync`,
// `SetTrumpForCurrentGameAsync`, `PlayDominoAsync`) plus the `Match.Scores` computed property,
// as pure functions over a `MatchState` aggregate. Every function throws `ValidationError`
// (never returns an error value) on an illegal action, matching `CustomValidationException`.
//
// All 6 mutating functions return a fresh top-level `MatchState` object per TS/React's
// immutable-state convention (established in trick.ts's `addDominoToTrick`), even though some
// nested structures are rebuilt more eagerly than strictly necessary for clarity.
import { Bid } from './bid';
import { Domino, dominoEquals, getSuitValue } from './domino';
import { Game, gameValue, gameWinningTeam } from './game';
import { Hand } from './hand';
import { MatchPlayerRef, selectNextPlayer } from './match';
import { nextPosition, Positions } from './positions';
import { Suit } from './suit';
import { Teams } from './teams';
import { addDominoToTrick, createTrick, isTrickFull } from './trick';
import {
  assertActive,
  assertActiveBidder,
  assertActiveTurn,
  assertBiddingComplete,
  assertHasDomino,
  assertIsMatchPlayer,
  assertIsNotMatchPlayer,
  assertNotFull,
  assertReadyToPlay,
  assertValidBid,
  assertValidDomino,
} from './validation';

// Port of `FortyTwo/Shared/Constants.cs`'s `WinningScore`.
const WINNING_SCORE = 7;

export interface MatchPlayerState extends MatchPlayerRef {
  ready: boolean;
}

// Port of C# `LoggedInPlayer` (FortyTwo/Shared/Models) - the narrow, per-player DTO returned by
// `MatchService.GetPlayerForMatch`. NOT the full `MatchState` - `getPlayerView` (Task 11's
// `MatchDO`) is a separate operation from a full-match fetch. Field names follow this codebase's
// established camelCase convention (`playerId`, `dominoes`) rather than the C# source's PascalCase
// (`Id`, `Dominos`) - a faithful-in-shape, not faithful-in-spelling, port.
export interface LoggedInPlayer {
  playerId: string;
  team: Teams;
  isActive: boolean;
  ready: boolean;
  dominoes: Domino[] | undefined;
  bid: Bid | null | undefined;
}

// The full aggregate the MatchDO (Task 11) will hold and mutate.
export interface MatchState {
  id: string;
  createdOn: string;
  updatedOn: string;
  currentGame: Game;
  games: Partial<Record<Teams, Game[]>>;
  winningTeam: Teams | null;
  players: MatchPlayerState[];
}

// Port of C# `MatchPlayerExtensions.Team()`: `(int)position % 2 == 0 ? TeamA : TeamB`.
function teamForPosition(position: Positions): Teams {
  return position % 2 === 0 ? Teams.TeamA : Teams.TeamB;
}

function now(): string {
  return new Date().toISOString();
}

// Port of `MatchService.CreateAsync`. No validation guards - matches the C# original, which
// calls none.
export function createMatch(firstPlayerId: string): MatchState {
  const timestamp = now();

  const game: Game = {
    id: crypto.randomUUID(),
    name: 'Game 1',
    firstActionBy: firstPlayerId,
    bid: null,
    biddingPlayerId: null,
    trump: null,
    currentPlayerId: firstPlayerId,
    hands: [{ playerId: firstPlayerId, team: Teams.TeamA, dominoes: [], bid: null }],
    currentTrick: createTrick(),
    tricks: [],
  };

  return {
    id: crypto.randomUUID(),
    createdOn: timestamp,
    updatedOn: timestamp,
    currentGame: game,
    games: {},
    winningTeam: null,
    players: [{ playerId: firstPlayerId, position: Positions.First, ready: true }],
  };
}

// Deals 7 dominoes to each hand, sliced from `dealOrder` at `[position * 7, position * 7 + 7)`
// per the seated player's position. Port of the domino-distribution half of `MatchService.Deal`.
function dealHands(hands: Hand[], players: MatchPlayerState[], dealOrder: Domino[]): Hand[] {
  return hands.map((hand) => {
    const player = players.find((p) => p.playerId === hand.playerId)!;
    const start = player.position * 7;
    return { ...hand, dominoes: dealOrder.slice(start, start + 7) };
  });
}

// Port of `MatchService.AddPlayerAsync`.
//
// JUDGMENT CALL: the brief's interface for `addPlayer` takes no `dealOrder` parameter, but the
// real C# `AddPlayerAsync` unconditionally deals (via the same `Deal()` helper `ReadyUp` uses)
// the instant the 4th hand is added - and dealing requires a shuffled 28-domino source, which
// this pure-function port can't conjure on its own (see `patchPlayerReady`'s `dealOrder` param
// for why). To stay faithful to the interface's 3-arg calling convention while still supporting
// that behavior, `dealOrder` is an added optional 4th parameter: when the 4th player's join
// supplies it, the deal happens exactly as in `AddPlayerAsync` (dominoes dealt, all `ready`
// flags reset to false); when omitted, the 4th hand is still added but dealing is skipped
// (there being no dominoes to deal from) - a caller (the Task 11 Durable Object) that knows a
// deal is about to be triggered should pass one.
export function addPlayer(match: MatchState, playerId: string, team: Teams, dealOrder?: Domino[]): MatchState {
  assertActive(match);
  assertNotFull(match);
  assertIsNotMatchPlayer(match, playerId);

  const teams = new Map<Teams, MatchPlayerState[]>();
  for (const p of match.players) {
    const t = teamForPosition(p.position);
    const bucket = teams.get(t);
    if (bucket) bucket.push(p);
    else teams.set(t, [p]);
  }

  const teammates = teams.get(team);
  const teammatePosition = teammates?.[0]?.position;

  const position: Positions =
    teammatePosition !== undefined
      ? (((teammatePosition + 2) % 4) as Positions)
      : teams.get(team === Teams.TeamA ? Teams.TeamB : Teams.TeamA)![0].position % 2 === 0
        ? Positions.Second
        : Positions.First;

  const newPlayer: MatchPlayerState = { playerId, position, ready: true };
  // Mirrors the C# source's own quirk: the new Hand's team is computed from POSITION, not the
  // `team` argument directly - always consistent in practice since position is derived from
  // `team` above, but written the same (redundant) way for a faithful line-for-line port.
  const newHand: Hand = { playerId, team: teamForPosition(position), dominoes: [], bid: null };

  let players = [...match.players, newPlayer];
  let currentGame: Game = { ...match.currentGame, hands: [...match.currentGame.hands, newHand] };

  if (currentGame.hands.length === 4 && dealOrder) {
    currentGame = { ...currentGame, hands: dealHands(currentGame.hands, players, dealOrder) };
    players = players.map((p) => ({ ...p, ready: false }));
  }

  return { ...match, currentGame, players, updatedOn: now() };
}

// Port of `MatchService.PatchPlayerAsync` + its private `ReadyUp`/`Deal` helpers.
export function patchPlayerReady(
  match: MatchState,
  playerId: string,
  ready: boolean,
  dealOrder: Domino[]
): MatchState {
  assertActive(match);
  assertIsMatchPlayer(match, playerId);

  let players = match.players.map((p) => (p.playerId === playerId ? { ...p, ready } : p));
  let currentGame = match.currentGame;

  if (gameWinningTeam(match.currentGame) !== null && players.every((p) => p.ready)) {
    const lastGame = match.currentGame;
    const totalGamesPlayed = Object.values(match.games).reduce(
      (sum, games) => sum + (games?.length ?? 0),
      0
    );

    const firstActionByPosition = nextPosition(players.find((p) => p.playerId === lastGame.firstActionBy)!.position);
    const firstActionBy = players.find((p) => p.position === firstActionByPosition)!.playerId;

    let hands: Hand[] = players.map((p) => ({
      playerId: p.playerId,
      team: teamForPosition(p.position),
      dominoes: [],
      bid: null,
    }));
    hands = dealHands(hands, players, dealOrder);

    players = players.map((p) => ({ ...p, ready: false }));

    currentGame = {
      id: crypto.randomUUID(),
      name: `Game ${totalGamesPlayed + 1}`,
      firstActionBy,
      bid: null,
      biddingPlayerId: null,
      trump: null,
      currentPlayerId: firstActionBy,
      hands,
      currentTrick: createTrick(),
      tricks: [],
    };
  }

  return { ...match, players, currentGame, updatedOn: now() };
}

// Port of `MatchService.BidAsync`.
export function placeBid(match: MatchState, playerId: string, bid: Bid): MatchState {
  assertActive(match);
  assertActive(match.currentGame);
  assertActiveTurn(match.currentGame, playerId);
  assertValidBid(match.currentGame, playerId, bid);

  const hands = match.currentGame.hands.map((h) => (h.playerId === playerId ? { ...h, bid } : h));

  let gameBid = match.currentGame.bid;
  let biddingPlayerId = match.currentGame.biddingPlayerId;

  if (bid !== Bid.Pass && (gameBid === null || bid > gameBid)) {
    gameBid = bid;
    biddingPlayerId = playerId;
  }

  let currentPlayerId: string;

  if (hands.some((h) => h.bid === null)) {
    currentPlayerId = selectNextPlayer(
      match.currentGame.currentPlayerId!,
      biddingPlayerId,
      match.currentGame.trump,
      match.players
    );
  } else if (gameBid === Bid.Plunge) {
    const plungePlayerPosition = match.players.find((p) => p.playerId === biddingPlayerId)!.position;
    const plungePartnerPosition = nextPosition(nextPosition(plungePlayerPosition));
    currentPlayerId = match.players.find((p) => p.position === plungePartnerPosition)!.playerId;
  } else {
    currentPlayerId = biddingPlayerId!;
  }

  const currentGame: Game = { ...match.currentGame, hands, bid: gameBid, biddingPlayerId, currentPlayerId };

  return { ...match, currentGame, updatedOn: now() };
}

// Port of `MatchService.SetTrumpForCurrentGameAsync`.
export function setTrump(match: MatchState, playerId: string, suit: Suit): MatchState {
  assertActive(match);
  assertActive(match.currentGame);
  assertActiveTurn(match.currentGame, playerId);
  assertBiddingComplete(match.currentGame);
  assertActiveBidder(match.currentGame, playerId);

  // `match.CurrentGame.Trump ??= suit;` - first call wins.
  const currentGame: Game = { ...match.currentGame, trump: match.currentGame.trump ?? suit };

  return { ...match, currentGame, updatedOn: now() };
}

// Port of `MatchService.PlayDominoAsync`.
export function playDomino(match: MatchState, playerId: string, domino: Domino): MatchState {
  const game = match.currentGame;

  // `IsNotNull(match)`/`IsNotNull(match.CurrentGame)` have no TS equivalent here - `match` and
  // `match.currentGame` are non-null by type, unlike C#'s nullable-by-runtime-lookup.
  assertActiveTurn(game, playerId);
  assertReadyToPlay(game);
  assertHasDomino(game, playerId, domino);
  assertValidDomino(game, playerId, domino);

  const player = match.players.find((p) => p.playerId === playerId)!;
  const playerTeam = teamForPosition(player.position);
  const trump = game.trump!;

  const hands = game.hands.map((h) => {
    if (h.playerId !== playerId) return h;
    const index = h.dominoes.findIndex((d) => dominoEquals(d, domino));
    const dominoes = [...h.dominoes];
    dominoes.splice(index, 1);
    return { ...h, dominoes };
  });

  let currentTrick = addDominoToTrick(game.currentTrick, domino, trump);
  const trickSuit = currentTrick.suit!;

  const playedDominoes = currentTrick.dominoes.filter((d): d is Domino => d !== null);
  const currentlyWinningDomino = playedDominoes.reduce((best, d) =>
    getSuitValue(d, trickSuit, trump) > getSuitValue(best, trickSuit, trump) ? d : best
  );

  if (dominoEquals(currentlyWinningDomino, domino)) {
    currentTrick = { ...currentTrick, playerId, team: playerTeam };
  }

  // C#'s `alreadyHadAWinner` local is computed but never used anywhere later in the original
  // method - dead code in the source, deliberately not ported.

  let tricks = game.tricks;
  let currentPlayerId = game.currentPlayerId;

  if (isTrickFull(currentTrick, trump)) {
    tricks = [...game.tricks, currentTrick];
    currentPlayerId = currentTrick.playerId;
    currentTrick = createTrick();
  } else {
    currentPlayerId = selectNextPlayer(game.currentPlayerId!, game.biddingPlayerId, game.trump, match.players);
  }

  const currentGame: Game = { ...game, hands, currentTrick, tricks, currentPlayerId };

  let games = match.games;
  const winningTeam = gameWinningTeam(currentGame);
  const alreadyFiled = Object.values(games).some((filed) => filed?.some((g) => g.id === currentGame.id));

  if (winningTeam !== null && !alreadyFiled) {
    games = { ...games, [winningTeam]: [...(games[winningTeam] ?? []), currentGame] };
  }

  const scores = matchScores({ ...match, games });
  const scoreEntries = Object.entries(scores) as [string, number][];

  // Note: unlike `placeBid`/`setTrump`, `playDomino` doesn't guard on `assertActive(match)` -
  // matching the real C# `PlayDominoAsync`, which has the same gap (it omits `.IsActive(match)`/
  // `.IsActive(match.CurrentGame)`, unlike `BidAsync`/`SetTrumpForCurrentGameAsync`, both of which
  // include them). A caller (the future Durable Object) is responsible for not routing further
  // plays once `match.winningTeam` is set. The tie-break below (lower `Teams` enum value wins,
  // via JS's guaranteed ascending-integer-key ordering on `Object.entries`) is a well-defined
  // default regardless of whether that invariant holds.
  const matchWinningTeam: Teams | null = scoreEntries.some(([, value]) => value >= WINNING_SCORE)
    ? (Number(
        scoreEntries.reduce((best, current) => (current[1] > best[1] ? current : best))[0]
      ) as Teams)
    : null;

  return { ...match, currentGame, games, winningTeam: matchWinningTeam, updatedOn: now() };
}

// Port of `MatchService.GetPlayerForMatch`. Guards: `IsNotNull(match)` has no TS equivalent here
// (see validation.ts's header comment) - the Task 11 `MatchDO` caller is responsible for the
// analogous "match exists in storage" check before calling this. `IsMatchPlayer` is ported as-is.
export function getPlayerView(match: MatchState, userId: string): LoggedInPlayer {
  assertIsMatchPlayer(match, userId);

  const matchPlayer = match.players.find((p) => p.playerId === userId)!;
  const hand = match.currentGame.hands.find((h) => h.playerId === userId);

  return {
    playerId: matchPlayer.playerId,
    team: teamForPosition(matchPlayer.position),
    isActive: match.currentGame.currentPlayerId === userId,
    ready: matchPlayer.ready,
    dominoes: hand?.dominoes,
    bid: hand?.bid,
  };
}

// Port of the `Match.Scores` computed property:
// `Games.ToDictionary(k => k.Key, g => g.Value.Sum(g => g.Value ?? 0))`.
export function matchScores(match: MatchState): Partial<Record<Teams, number>> {
  const scores: Partial<Record<Teams, number>> = {};

  for (const key of Object.keys(match.games)) {
    const team = Number(key) as Teams;
    const games = match.games[team] ?? [];
    scores[team] = games.reduce((sum, g) => sum + (gameValue(g) ?? 0), 0);
  }

  return scores;
}
