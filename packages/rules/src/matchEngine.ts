// A match's rules as pure functions over `MatchState`: each action takes the current match and
// returns a new one, never mutating its input, or throws `ValidationError` when the action isn't
// allowed.
import { Bid } from './bid';
import { isBot } from './botIds';
import { Domino, dominoEquals, getSuitValue } from './domino';
import { ValidationError } from './errors';
import { Game, gameValue, gameWinningTeam } from './game';
import { Hand } from './hand';
import { MatchPlayerRef, selectNextPlayer } from './match';
import { nextPosition, Positions } from './positions';
import { Suit } from './suit';
import { Teams, teamForPosition } from './teams';
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
  assertSeatOpen,
  assertTeamNotFull,
  assertValidBid,
  assertValidDomino,
  assertValidTrump,
} from './validation';

// Marks needed to win the match.
const WINNING_SCORE = 7;

export interface MatchPlayerState extends MatchPlayerRef {
  ready: boolean;
}

// One seated player's own slice of a match (`getPlayerView`): their team, hand, bid and whether
// it's their turn.
export interface LoggedInPlayer {
  playerId: string;
  team: Teams;
  isActive: boolean;
  ready: boolean;
  dominoes: Domino[] | undefined;
  bid: Bid | null | undefined;
}

// A whole match, every hand included - what the Worker's MatchDO stores.
export interface MatchState {
  id: string;
  createdOn: string;
  updatedOn: string;
  currentGame: Game;
  games: Partial<Record<Teams, Game[]>>;
  winningTeam: Teams | null;
  players: MatchPlayerState[];
  // Who has asked to play the same four again, once the match is over. Optional, like rematchId,
  // because matches stored before rematches existed have neither.
  rematchVotes?: string[];
  // The rematch's match id, set once everyone has agreed and that match exists.
  rematchId?: string;
}

function now(): string {
  return new Date().toISOString();
}

// A new match with its creator in the first seat, waiting for three more players.
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
// per the seated player's position.
function dealHands(hands: Hand[], players: MatchPlayerState[], dealOrder: Domino[]): Hand[] {
  return hands.map((hand) => {
    const player = players.find((p) => p.playerId === hand.playerId)!;
    const start = player.position * 7;
    return { ...hand, dominoes: dealOrder.slice(start, start + 7) };
  });
}

// Joins a match on `team`, taking the seat across from a teammate already there (or the first
// open seat on that team's side). The 4th player's join deals the first hand from `dealOrder`
// and unreadies everyone; these functions stay pure, so the caller does the shuffling. Without a
// `dealOrder` the 4th player is still seated, but nothing is dealt.
export function addPlayer(match: MatchState, playerId: string, team: Teams, dealOrder?: Domino[]): MatchState {
  assertActive(match);
  assertNotFull(match);
  assertIsNotMatchPlayer(match, playerId);
  assertTeamNotFull(match.players, team);

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

  return seatPlayer(match, playerId, position, dealOrder);
}

// Joins a match at a seat the player picked, rather than one derived from a team (addPlayer).
// The seat decides both team (position parity) and turn order, so it must be one of the four
// positions and not already taken.
export function takeSeat(match: MatchState, playerId: string, position: number, dealOrder?: Domino[]): MatchState {
  assertActive(match);
  assertNotFull(match);
  assertIsNotMatchPlayer(match, playerId);
  assertSeatOpen(match.players, position);

  return seatPlayer(match, playerId, position as Positions, dealOrder);
}

function seatPlayer(match: MatchState, playerId: string, position: Positions, dealOrder?: Domino[]): MatchState {
  const newPlayer: MatchPlayerState = { playerId, position, ready: true };
  const newHand: Hand = { playerId, team: teamForPosition(position), dominoes: [], bid: null };

  let players = [...match.players, newPlayer];
  let currentGame: Game = { ...match.currentGame, hands: [...match.currentGame.hands, newHand] };

  if (currentGame.hands.length === 4 && dealOrder) {
    currentGame = { ...currentGame, hands: dealHands(currentGame.hands, players, dealOrder) };
    players = players.map((p) => ({ ...p, ready: false }));
  }

  return { ...match, currentGame, players, updatedOn: now() };
}

// Whether any hand has been dealt in this match yet. Hands are empty again after a hand's last
// trick, so empty hands alone don't mean "not dealt": a played trick or a filed game counts too.
// A hidden hand (view.ts) counts by its `hiddenCount`, so this also works on a client's view.
export function hasBeenDealt(match: MatchState): boolean {
  return (
    Object.values(match.games).some((games) => (games?.length ?? 0) > 0) ||
    match.currentGame.tricks.length > 0 ||
    match.currentGame.hands.some((h) => (h.hiddenCount ?? h.dominoes.length) > 0)
  );
}

export function hasHumanPlayers(match: MatchState): boolean {
  return match.players.some((p) => !isBot(p.playerId));
}

// Takes a player's seat and hand back out of a match that hasn't been dealt yet. If they were
// due to open (the creator always is), the lowest-seated remaining human opens instead - never a
// bot, which would act on its turn before anything is dealt. Removing the last player is allowed;
// the caller deletes a match with no human left.
export function removePlayer(match: MatchState, playerId: string): MatchState {
  assertActive(match);
  assertIsMatchPlayer(match, playerId);
  if (hasBeenDealt(match)) throw new ValidationError("You can't leave once the dominoes are dealt");

  const players = match.players.filter((p) => p.playerId !== playerId);
  const opener = players
    .filter((p) => !isBot(p.playerId))
    .sort((a, b) => a.position - b.position)[0]?.playerId;
  const replaceLeaver = (id: string | null) => (id === playerId && opener !== undefined ? opener : id);

  const currentGame: Game = {
    ...match.currentGame,
    hands: match.currentGame.hands.filter((h) => h.playerId !== playerId),
    firstActionBy: replaceLeaver(match.currentGame.firstActionBy),
    currentPlayerId: replaceLeaver(match.currentGame.currentPlayerId),
  };

  return { ...match, players, currentGame, updatedOn: now() };
}

// Marks a player ready (or not) for the next hand. Once the current hand is decided and all four
// are ready, the next hand is dealt from `dealOrder`, opened by the seat after the last opener.
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

// Records the current player's bid and moves on: to the next bidder, or once everyone has bid, to
// the winning bidder (their partner, on a Plunge) to name trump.
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

// The winning bidder names trump. Trump can't be changed once named.
export function setTrump(match: MatchState, playerId: string, suit: Suit): MatchState {
  assertActive(match);
  assertActive(match.currentGame);
  assertActiveTurn(match.currentGame, playerId);
  assertBiddingComplete(match.currentGame);
  assertActiveBidder(match.currentGame, playerId);
  assertValidTrump(match.currentGame, suit);

  const currentGame: Game = { ...match.currentGame, trump: match.currentGame.trump ?? suit };

  return { ...match, currentGame, updatedOn: now() };
}

// Plays a domino into the current trick. When the trick fills, its winner leads the next one; when
// the play decides the hand, the hand is filed under the team that won it, and the match is won
// once a team reaches WINNING_SCORE marks.
//
// Unlike the other actions, this deliberately skips `assertActive` for both the hand and the
// match: a decided hand can be played out if the players want to, and that includes the hand that
// won the match. Those plays never change the score, since a hand is only filed once.
export function playDomino(match: MatchState, playerId: string, domino: Domino): MatchState {
  const game = match.currentGame;

  assertActiveTurn(game, playerId);
  assertReadyToPlay(game);
  assertHasDomino(game, playerId, domino);
  assertValidDomino(game, playerId, domino);

  const player = match.players.find((p) => p.playerId === playerId)!;
  const playerTeam = teamForPosition(player.position);
  const trump = game.trump!;

  // Everything stored from here on uses the domino from the hand, not the caller's object, so
  // nothing a client sent beyond the two halves is ever persisted or broadcast.
  const actualDomino = match.currentGame.hands.find((h) => h.playerId === playerId)!.dominoes.find((d) =>
    dominoEquals(d, domino)
  )!;

  const hands = game.hands.map((h) => {
    if (h.playerId !== playerId) return h;
    const index = h.dominoes.findIndex((d) => dominoEquals(d, actualDomino));
    const dominoes = [...h.dominoes];
    dominoes.splice(index, 1);
    return { ...h, dominoes };
  });

  let currentTrick = addDominoToTrick(game.currentTrick, actualDomino, trump);
  const trickSuit = currentTrick.suit!;

  const playedDominoes = currentTrick.dominoes.filter((d): d is Domino => d !== null);
  const currentlyWinningDomino = playedDominoes.reduce((best, d) =>
    getSuitValue(d, trickSuit, trump) > getSuitValue(best, trickSuit, trump) ? d : best
  );

  if (dominoEquals(currentlyWinningDomino, actualDomino)) {
    currentTrick = { ...currentTrick, playerId, team: playerTeam };
  }

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

  // On a tie the lower `Teams` value wins: `Object.entries` lists integer keys in ascending order,
  // and the reduce only replaces a strictly higher score.
  const matchWinningTeam: Teams | null = scoreEntries.some(([, value]) => value >= WINNING_SCORE)
    ? (Number(
        scoreEntries.reduce((best, current) => (current[1] > best[1] ? current : best))[0]
      ) as Teams)
    : null;

  return { ...match, currentGame, games, winningTeam: matchWinningTeam, updatedOn: now() };
}

// Asks to play the same four again. Only once the match is over, and only from someone seated;
// asking twice changes nothing.
export function voteRematch(match: MatchState, playerId: string): MatchState {
  if (match.winningTeam === null) throw new ValidationError('This match is still being played');
  assertIsMatchPlayer(match, playerId);

  const votes = match.rematchVotes ?? [];
  if (votes.includes(playerId)) return match;
  return { ...match, rematchVotes: [...votes, playerId], updatedOn: now() };
}

// Everyone who counts as wanting a rematch: those who voted, plus the bots, which never vote but
// never hold one up either. A rematch starts when this covers every seat.
export function rematchAgreed(match: MatchState): string[] {
  const votes = match.rematchVotes ?? [];
  return match.players.map((p) => p.playerId).filter((id) => isBot(id) || votes.includes(id));
}

// A fresh match for the same four, each in the seat they had, with the first hand dealt. The deal
// keeps rotating: the seat after whoever opened the previous match's last hand opens this one.
export function createRematch(id: string, previous: MatchState, dealOrder: Domino[]): MatchState {
  if (previous.players.length !== 4) throw new Error('A rematch needs all four players');

  const timestamp = now();
  const players = previous.players.map((p) => ({ ...p, ready: false }));
  const lastOpener = players.find((p) => p.playerId === previous.currentGame.firstActionBy) ?? players[0];
  const openerPosition = nextPosition(lastOpener.position);
  const firstActionBy = players.find((p) => p.position === openerPosition)!.playerId;

  const hands = dealHands(
    players.map((p) => ({ playerId: p.playerId, team: teamForPosition(p.position), dominoes: [], bid: null })),
    players,
    dealOrder
  );

  return {
    id,
    createdOn: timestamp,
    updatedOn: timestamp,
    currentGame: {
      id: crypto.randomUUID(),
      name: 'Game 1',
      firstActionBy,
      bid: null,
      biddingPlayerId: null,
      trump: null,
      currentPlayerId: firstActionBy,
      hands,
      currentTrick: createTrick(),
      tricks: [],
    },
    games: {},
    winningTeam: null,
    players,
  };
}

// A seated player's own slice of the match. Only someone at the table has one.
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

// Marks per team: the sum of the values of the hands each team has won.
export function matchScores(match: MatchState): Partial<Record<Teams, number>> {
  const scores: Partial<Record<Teams, number>> = {};

  for (const key of Object.keys(match.games)) {
    const team = Number(key) as Teams;
    const games = match.games[team] ?? [];
    scores[team] = games.reduce((sum, g) => sum + (gameValue(g) ?? 0), 0);
  }

  return scores;
}
