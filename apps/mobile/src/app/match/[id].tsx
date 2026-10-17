// The match screen: scores and contract, the table, and what this player can do right now - bid,
// name trump, play a domino by tapping it, ready up for the next hand, ask for a rematch, or - before
// the first deal - leave the table (or cancel the match, when no other human is seated) - or poke
// whoever the table has been waiting on for 30 minutes (match/usePoke.ts). Live
// state comes from the match socket; what the state allows comes from @fortytwo/client's
// describeMatch, which the web match page uses too.
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Alert, Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuth0 } from 'react-native-auth0';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  houseRuleLabels,
  lobbyCards,
  lobbyRoster,
  shuffledTips,
  marksToWin,
  assertPlayable,
  describeMatch,
  isHighBidder,
  isTrickStarted,
  isValidPlay,
  matchStatus,
  nameText,
  nextHandClock,
  openSeats,
  projectPlay,
  formatClock,
  searchState,
  seatChanges,
  seatFor,
  shouldStackTricks,
  teamTrickPoints,
  teamTricksForDisplay,
  trickLeaderId,
  trickPlayOrder,
  serverNow,
  turnClock,
  viewerRole,
  watchAnchor,
  type MatchView,
  type Seat,
} from '@fortytwo/client';
import {
  Bid,
  bidToPrettyString,
  handSize,
  hasBeenDealt,
  isBot,
  isLow,
  isOnAutopilot,
  isPresent,
  LIVE_FILL_MS,
  lowDoublesToPrettyString,
  matchMode,
  matchScores,
  rematchAgreed,
  seatedPlayers,
  suitToPrettyString,
  type Domino as DominoType,
  type MatchState,
  Suit,
} from '@fortytwo/rules';
import { useOnline } from '@/api/presence';
import { useApi } from '@/api/useApi';
import { useStats } from '@/api/useStats';
import { useProfile } from '@/api/useProfile';
import { useMatchSocket } from '@/api/useMatchSocket';
import { useGetToken } from '@/auth/useGetToken';
import { BiddingPanel } from '@/components/BiddingPanel';
import { DoublesRuleModal } from '@/components/DoublesRuleModal';
import { InviteSheet } from '@/people/InviteSheet';
import { Fade, FADE_IN_MS } from '@/components/Fade';
import { Hand, type DragState } from '@/components/Hand';
import { HelpButton } from '@/components/HelpButton';
import { JoinMatchPanel } from '@/components/JoinMatchPanel';
import { MatchMenu } from '@/components/MatchMenu';
import { HouseRulesButton, HouseRulesModal } from '@/components/HouseRulesModal';
import { MatchSummary } from '@/components/MatchSummary';
import { NameSkeleton } from '@/components/NameSkeleton';
import { PipFace } from '@/components/PipFace';
import { SearchLobby } from '@/components/SearchLobby';
import { toastError, toastInfo } from '@/components/toast';
import { Table, TABLE_RESIZE_MS, type SeatInfo } from '@/components/Table';
import { TrickHistory } from '@/components/TrickHistory';
import { TrumpPicker } from '@/components/TrumpPicker';
import { colors, fonts } from '@/components/theme';
import { DEV_BYPASS } from '@/dev/devBypass';
import { DEV_PLAYER_ID } from '@/dev/devMatches';
import { shareInvite } from '@/linking/invite';
import { askOnceForPush } from '@/notifications/push';
import { useNow } from '@/match/useNow';
import { useLatch } from '@/match/useLatch';
import { useLobbyHold } from '@/match/useLobbyHold';
import { usePlayerNames } from '@/match/usePlayerNames';
import { usePoke } from '@/match/usePoke';
import { useSettled } from '@/match/useSettled';
import { useTrickHold } from '@/match/useTrickHold';

// A Low trump's doubles rule, short enough for the scoreboard's middle column ("Low · doubles:
// suit"); tapping it opens DoublesRuleModal, which spells the rules out.
function doublesRule(trump: Suit): string {
  return trump === Suit.LowDoublesOwnSuit ? 'suit' : lowDoublesToPrettyString(trump).toLowerCase();
}

// The header's "?": the rules, pushed over the match, which stays as it was underneath.
const rulesButton = () => <HelpButton onPress={() => router.push('/how-to-play')} />;

export default function MatchScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth0();
  // The dev bypass has no Auth0 user; it plays as its own player.
  const myPlayerId = DEV_BYPASS ? DEV_PLAYER_ID : user?.sub;
  const api = useApi();
  const getToken = useGetToken();
  // Room at the bottom of the scroll, above the phone's gesture bar or navigation buttons.
  const bottomInset = useSafeAreaInsets().bottom;

  // What a poke needs when it lands, from state below: the sender's display name, and whether a
  // move of mine is already in flight - then the poke is moot. (The Worker only sends a poke while
  // it's still my turn, and the socket keeps its messages in order, so that's the one way one can
  // land late.)
  const pokedRef = useRef<{ nameOf?: (playerId: string) => string | null; moving: boolean }>({ moving: false });
  const { match: socketMatch, connected, reconnecting, deleted } = useMatchSocket(id, getToken, (from) => {
    if (pokedRef.current.moving) return;
    const poker = pokedRef.current.nameOf?.(from) ?? null;
    toastInfo(poker ? `${poker} poked you` : 'You were poked', "It's your turn", 'center');
  });
  // The socket sends the match as soon as it connects; this fills the moment before that, and
  // stands in while the socket is down.
  const matchQuery = useQuery({
    queryKey: ['match', id],
    queryFn: () => api.getMatch(id),
    // A match that doesn't exist (deleted, or a stale link) won't appear on a retry - say so now.
    retry: (failureCount, error) => (error as { status?: number }).status !== 404 && failureCount < 3,
  });
  const liveMatch = socketMatch ?? matchQuery.data ?? null;

  // How this player stands at the table. In a Live Play game under way, a newcomer waits
  // for a bot's seat (claiming) and watches meanwhile; one whose wait came to nothing is bumped
  // and looks again; one away a whole hand was replaced by a bot.
  const role = liveMatch && myPlayerId ? viewerRole(liveMatch, myPlayerId) : null;
  // A claimant watches from the first seat's side; everything that acts is switched off for them.
  const watching = role === 'claiming';
  const watchFrom = watching ? watchAnchor(liveMatch!) : null;

  // Display names for everyone seated (match/usePlayerNames.ts). Until a name loads it reads null
  // here and the screen shows a placeholder; one that can't be found reads "Player N". Never the id.
  const names = usePlayerNames(liveMatch?.players ?? [], myPlayerId, (ids) => api.searchUsers(ids));
  const nameOf = (playerId: string): string | null => nameText(names.nameFor(playerId));
  const poke = usePoke(liveMatch, myPlayerId, () => api.poke(id), nameOf);
  // The player's settings: whether to outline the playable dominoes (opted into), and whether
  // they want notifications.
  const profile = useProfile().data;
  const highlightPlayable = profile?.highlightPlayable ?? false;
  // Bots can be switched off server-side (the Worker's BOTS_ENABLED).
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.getConfig(), staleTime: Infinity });

  // A bid, trump call or ready-up counts as made from the moment it's sent until the socket's
  // broadcast shows it. The request's own reply can arrive first, and going by that alone the bids
  // fade back in (or "Ready up" comes back) until the broadcast lands. Each is kept by the game it
  // was made in, so the next hand starts afresh; one turned away is forgotten.
  const [sentIn, setSentIn] = useState<{ bid?: string; trump?: string; ready?: string }>({});
  const sent = (move: keyof typeof sentIn) => ({
    onMutate: () => setSentIn((s) => ({ ...s, [move]: liveMatch?.currentGame.id })),
    onError: (error: Error) => {
      setSentIn((s) => ({ ...s, [move]: undefined }));
      toastError(error);
    },
  });
  const bid = useMutation({ mutationFn: (value: Bid) => api.bid(id, value), ...sent('bid') });
  const trump = useMutation({ mutationFn: (suit: Suit) => api.setTrump(id, suit), ...sent('trump') });
  const readyUp = useMutation({ mutationFn: () => api.readyUp(id, true), ...sent('ready') });
  const rematch = useMutation({ mutationFn: () => api.rematch(id), onError: toastError });
  const addBots = useMutation({ mutationFn: () => api.addBots(id), onError: toastError });
  const resume = useMutation({ mutationFn: () => api.resume(id), onError: toastError });
  const online = useOnline();
  // A Live search counts up, and a Live turn and the wait for the next hand count down, so the clock
  // ticks only while one is shown. A paused clock sits at 0:00 until the table moves on, so it doesn't tick.
  const searchNow = liveMatch ? searchState(liveMatch, serverNow()) : null;
  const clockNow = liveMatch ? turnClock(liveMatch, serverNow()) : null;
  const nextHandNow = liveMatch ? nextHandClock(liveMatch, serverNow()) : null;
  const ticking =
    liveMatch != null && (searchNow?.mode === 'live' || (clockNow !== null && !clockNow.paused) || nextHandNow !== null);
  const now = useNow(ticking);
  const search = liveMatch ? searchState(liveMatch, now) : null;
  // Stopped, `now` is as old as the last tick, so a stopped clock reads the time afresh.
  const clock = liveMatch ? (ticking ? turnClock(liveMatch, now) : clockNow) : null;
  const nextHand = liveMatch ? (ticking ? nextHandClock(liveMatch, now) : nextHandNow) : null;
  const mode = liveMatch ? matchMode(liveMatch) : 'custom';
  // A Live search shows the lobby in place of the table, held up a moment once the table fills.
  const lobby = useLobbyHold(search?.mode === 'live', (liveMatch?.players.length ?? 0) >= 4);
  const stats = useStats({ enabled: lobby });
  // Shuffled once per visit, so the card's order holds steady through the search.
  const [tips] = useState(() => shuffledTips());
  const meOnAutopilot = liveMatch != null && myPlayerId != null && isOnAutopilot(liveMatch, myPlayerId);
  // Taking a seat from this screen - arriving from an invite link, say. The match's broadcast
  // then seats the player here; the lobby's lists change too.
  const queryClient = useQueryClient();

  // Set (by the button, before the request goes out) while this player's own leave is in flight:
  // if it deletes the match, their socket gets the same "deleted" close as everyone else's, and
  // they shouldn't be told about it.
  const leavingRef = useRef(false);
  const leave = useMutation({
    mutationFn: () => api.leaveMatch(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['matches'] });
      queryClient.invalidateQueries({ queryKey: ['invites'] });
      router.dismissTo('/');
    },
    onError: (error) => {
      leavingRef.current = false;
      toastError(error);
    },
  });

  // The match was deleted (its last human left, or it expired) - there's nothing left to show.
  // Re-checked when this player's own leave fails, since by then the match may be gone anyway.
  // A bumped player is already on their way to another table (below), so isn't told either: a
  // dropped match's last broadcast, which bumps them, arrives before the socket closes.
  const leaveFailed = leave.isError;
  const bumped = role === 'bumped';
  useEffect(() => {
    if (!deleted || leavingRef.current || bumped) return;
    toastInfo('This match was deleted');
    queryClient.invalidateQueries({ queryKey: ['matches'] });
    queryClient.invalidateQueries({ queryKey: ['invites'] });
    router.dismissTo('/');
  }, [deleted, leaveFailed, bumped, queryClient]);

  // Arriving at a full table (often from an Invited to card fetched before it filled): the Lobby
  // stays mounted underneath, so refresh its invites now, and the stale one is gone on the way back.
  const full = role === 'stranger' && liveMatch !== null && liveMatch.players.length === 4;
  useEffect(() => {
    if (full) queryClient.invalidateQueries({ queryKey: ['invites'] });
  }, [full, queryClient]);

  // Bumped - the game they were waiting on ended first - this player looks for another Over the
  // table game straight away, once, and goes to it. If that fails they can try again.
  const findAnother = useMutation({
    mutationFn: () => api.play('live'),
    onSuccess: (found) => router.replace(`/match/${found.id}`),
  });
  const { mutate: searchAgain } = findAnother;
  const searchedAgainRef = useRef(false);
  useEffect(() => {
    if (!bumped || searchedAgainRef.current) return;
    searchedAgainRef.current = true;
    searchAgain();
  }, [bumped, searchAgain]);

  // "Sam took Bot 2's seat", for each seat that changes hands, once the newcomer's name is in;
  // a player who has just been seated is told they're in instead.
  const previousMatchRef = useRef<MatchState | null>(null);
  const pendingSeatChangesRef = useRef<{ from: string; to: string }[]>([]);
  useEffect(() => {
    if (!liveMatch) return;
    const previous = previousMatchRef.current;
    previousMatchRef.current = liveMatch;
    if (previous && previous.id === liveMatch.id) {
      for (const change of seatChanges(previous, liveMatch)) {
        if (change.to === myPlayerId) toastInfo("You're in", 'You took a seat - your first hand is dealt.');
        // The one leaving has a screen of their own to see.
        else if (change.from !== myPlayerId) pendingSeatChangesRef.current.push(change);
      }
    }
    if (!names.ready) return;
    for (const change of pendingSeatChangesRef.current.splice(0)) {
      const to = nameText(names.nameFor(change.to)) ?? 'A player';
      const from = nameText(names.nameFor(change.from)) ?? 'a player';
      toastInfo(`${to} took ${from}'s seat`);
    }
  }, [liveMatch, myPlayerId, names]);

  const join = useMutation({
    mutationFn: (position: number) => api.joinMatch(id, position),
    onSuccess: (joined) => {
      queryClient.setQueryData(['match', id], joined);
      queryClient.invalidateQueries({ queryKey: ['matches'] });
      queryClient.invalidateQueries({ queryKey: ['invites'] });
    },
    onError: toastError,
  });

  // Plays are optimistic: a legal play shows on the table the moment it's made, and the screen
  // shows the match as it will be once the play lands (projectPlay) until the broadcast shows the
  // domino gone from my hand. If the play is turned away, the domino goes back to my hand.
  const [playing, setPlaying] = useState<DominoType | null>(null);
  const play = useMutation({
    mutationFn: (domino: DominoType) => api.playDomino(id, { top: domino.top, bottom: domino.bottom }),
    onError: (error) => {
      setPlaying(null);
      toastError(error);
    },
  });
  useEffect(() => {
    pokedRef.current = {
      nameOf: (playerId) => nameText(names.nameFor(playerId)),
      moving: playing != null || bid.isPending || trump.isPending,
    };
  }, [names, playing, bid.isPending, trump.isPending]);
  const liveGame = liveMatch?.currentGame ?? null;
  const myLiveHand = liveGame?.hands.find((h) => h.playerId === myPlayerId)?.dominoes ?? [];
  // Still in my hand, as far as the server has said - so still to be shown as played.
  const inFlight = playing != null && myLiveHand.some((d) => d.id === playing.id) ? playing : null;
  useEffect(() => {
    if (playing != null && inFlight == null) setPlaying(null);
  }, [playing, inFlight]);

  // With my hand played out (or not yet dealt) there's no hand to keep in place, so the play area
  // stops filling the screen and eases down to its content, bringing the trick history up. On the
  // next deal it opens straight back up: the old hand's trick history has gone by then, so that
  // only puts the new hand back at the bottom of the screen.
  const handEmpty = myLiveHand.length - (inFlight ? 1 : 0) === 0;
  const loaded = liveMatch != null;
  const pinned = useRef(new Animated.Value(handEmpty ? 0 : 1)).current;
  const pinnedOnLoad = useRef(false);
  useEffect(() => {
    if (!loaded) return;
    if (handEmpty && pinnedOnLoad.current) {
      Animated.timing(pinned, {
        toValue: 0,
        duration: HAND_COLLAPSE_MS,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: false,
      }).start();
    } else {
      pinned.setValue(handEmpty ? 0 : 1);
    }
    pinnedOnLoad.current = true;
  }, [loaded, handEmpty, pinned]);

  const { heldTrick, sweeping } = useTrickHold(liveGame);

  // Bidding and naming trump don't use the table, so it folds down to a strip for them. On a new
  // deal the bids wait for it to finish folding: arriving while it's still full height, they'd
  // briefly push the hand down the screen.
  // A claimant's view is the first seat's, like the table they're watching.
  const early = seatedView(liveMatch, watchFrom ?? myPlayerId);
  // Sitting at a match is when notifications start to matter: ask for permission then, if the
  // player hasn't turned them off.
  const seated = role === 'seated';
  const wantsPush = profile != null && profile.pushNotifications;
  useEffect(() => {
    if (seated && wantsPush) askOnceForPush(api);
  }, [seated, wantsPush, api]);
  const tableCompact = early != null && (early.isBiddingPhase || early.isTrumpSelectPhase);
  const tableFolded = useSettled(tableCompact, TABLE_RESIZE_MS);
  // The hand-over panel waits for the trick that decided the hand to leave the table, so the
  // result doesn't land on top of it - then stays until the next deal, through any tricks played
  // out after it, so a player can ready up at any time.
  const isHandOver = early?.isHandOver ?? false;
  const showHandOver = useLatch(isHandOver && heldTrick == null, isHandOver);

  // The match summary only opens when asked for, from the hand-over panel's button: the end of
  // the match plays out on the table like any other hand.
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [doublesOpen, setDoublesOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);

  // Dragging a domino to the table: the table is the drop zone, the screen holds still while a
  // domino is held, and the table lights up while one is over it.
  const tableRef = useRef<View>(null);
  const [drag, setDrag] = useState<DragState>({ dragging: false, overDropZone: false });
  const [viewportHeight, setViewportHeight] = useState(0);

  // Follow the rematch once everyone has agreed - but only if it's created while this screen is
  // open. A finished match opened later stays viewable.
  const rematchId = liveMatch?.rematchId;
  const rematchIdAtLoad = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!liveMatch) return;
    if (rematchIdAtLoad.current === undefined) {
      rematchIdAtLoad.current = rematchId ?? null;
      return;
    }
    if (rematchId && rematchId !== rematchIdAtLoad.current) router.replace(`/match/${rematchId}`);
  }, [liveMatch, rematchId]);

  if (!liveMatch || !liveGame || !myPlayerId) {
    return (
      <View style={styles.centered}>
        {matchQuery.error ? (
          <Text style={styles.text}>{matchQuery.error.message}</Text>
        ) : (
          <ActivityIndicator size="large" color={colors.brass} />
        )}
      </View>
    );
  }
  // Having just left, the table's broadcast without this player usually arrives before the
  // leave's own reply navigates away - that's not a seat picker (or a "replaced" note) to show them.
  if (role !== 'seated' && (leave.isPending || leave.isSuccess)) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.brass} accessibilityLabel="Leaving match" />
      </View>
    );
  }
  if (role === 'bumped') {
    return (
      <View style={[styles.centered, styles.notice]} accessibilityLabel="Finding another table">
        <Stack.Screen options={{ title: liveGame.name, headerRight: rulesButton }} />
        {findAnother.isError ? (
          <>
            <Text style={styles.noticeText}>That game ended, and no other table could be found just now.</Text>
            <ActionButton label="Find another" disabled={findAnother.isPending} onPress={() => searchAgain()} />
          </>
        ) : (
          <Text style={styles.noticeText} accessibilityRole="text">
            That game ended - finding you another table…
          </Text>
        )}
        <Pressable style={styles.lobbyLink} onPress={() => router.dismissTo('/')} accessibilityRole="button">
          <Text style={styles.smallButtonText}>Back to lobby</Text>
        </Pressable>
      </View>
    );
  }
  if (role === 'replaced') {
    return (
      <View style={[styles.centered, styles.notice]} accessibilityLabel="Your seat was taken">
        <Stack.Screen options={{ title: liveGame.name, headerRight: rulesButton }} />
        <Text style={styles.noticeText}>A bot took your seat after you were away for a hand.</Text>
        <Pressable style={styles.lobbyLink} onPress={() => router.dismissTo('/')} accessibilityRole="button">
          <Text style={styles.smallButtonText}>Back to lobby</Text>
        </Pressable>
      </View>
    );
  }
  // Someone who isn't seated - typically arriving from an invite link - picks a seat, or learns
  // the match is full.
  if (role === 'stranger') {
    const seats = [0, 1, 2, 3].map((position) => {
      const player = seatedPlayers(liveMatch).find((p) => p.position === position);
      return player ? (nameOf(player.playerId) ?? '') : null;
    });
    // Per seat, so a name that has loaded shows while another is still on its way.
    const loading = [0, 1, 2, 3].map((position) => {
      const player = seatedPlayers(liveMatch).find((p) => p.position === position);
      return player != null && names.nameFor(player.playerId).status === 'loading';
    });
    return (
      <>
        <Stack.Screen options={{ title: liveGame.name, headerRight: rulesButton }} />
        <JoinMatchPanel
          seats={seats}
          loading={loading}
          joining={join.isPending}
          onPick={(position) => join.mutate(position)}
          onLobby={() => router.dismissTo('/')}
        />
      </>
    );
  }

  if (lobby) {
    const searching = search?.mode === 'live';
    return (
      <ScrollView style={styles.screen} contentContainerStyle={[styles.container, styles.lobby, { paddingBottom: 32 + bottomInset }]}>
        <Stack.Screen options={{ title: liveGame.name, headerRight: rulesButton }} />
        {reconnecting && <Text style={styles.reconnecting}>Reconnecting…</Text>}
        <SearchLobby
          roster={lobbyRoster(liveMatch.players, myPlayerId)}
          viewerId={myPlayerId}
          nameOf={nameOf}
          online={online}
          elapsedMs={config.data?.bots ? (searching ? search.elapsedMs : LIVE_FILL_MS) : null}
          full={!searching}
          cards={lobbyCards(stats.data?.all, tips)}
          onStartWithBots={config.data?.bots ? () => addBots.mutate() : null}
          startDisabled={!searching || !connected || addBots.isPending}
          onCancel={() => {
            leavingRef.current = true;
            leave.mutate();
          }}
          cancelDisabled={!searching || leave.isPending}
        />
      </ScrollView>
    );
  }

  // Everything below reads the match as it will be once a play in flight lands.
  const match = inFlight ? projectPlay(liveMatch, myPlayerId, inFlight) : liveMatch;
  const game = match.currentGame;
  // The table is laid out around whoever it's seen from: this player, or for a claimant watching,
  // the first seat.
  const viewerId = watchFrom ?? myPlayerId;
  const view = describeMatch(match, viewerId);
  const { myTeam, opponentTeam } = view;
  const scores = matchScores(match);
  const canPlay = !watching && view.isMyTurnToPlay && connected && playing == null;
  const bidSent = sentIn.bid === game.id;
  const trumpSent = sentIn.trump === game.id;
  const iAmReady = view.iAmReady || sentIn.ready === game.id;

  // Checked here first, by the same rule the server applies, so an illegal play never leaves the
  // hand: it's refused at once (a dragged domino springs back). A legal one leaves for the table.
  function playDomino(domino: DominoType): Promise<unknown> {
    try {
      assertPlayable(liveMatch!, myPlayerId!, domino);
    } catch (error) {
      toastError(error);
      return Promise.reject(error);
    }
    setPlaying(domino);
    return play.mutateAsync(domino);
  }
  // For sentences: only rendered once names are ready (see the status and contract lines).
  const nameFor = (playerId: string | null) => (playerId == null ? '' : (nameOf(playerId) ?? ''));
  // One line saying what the table is waiting on - for a watcher, never "Your play".
  const status = matchStatus(
    match,
    watching ? { ...view, isSittingOut: false, me: { ...view.me, isActive: false } } : view,
    nameFor,
  );

  // The trick on the table: the one just completed while it's held, else the one in progress.
  const trick = heldTrick ?? game.currentTrick;
  const trickIndex = heldTrick ? game.tricks.length - 1 : game.tricks.length;
  const leader = view.isPlayingPhase ? trickLeaderId(match.players, game, trickIndex) : null;
  const order = trickPlayOrder(match.players, game, leader);
  const slotSeats = order.map((pid) => (pid == null ? null : seatFor(match.players, viewerId, pid)));
  const winningSlot = trick.playerId == null ? null : order.indexOf(trick.playerId);
  // A held trick sweeps off toward whoever won it.
  const sweepTo = sweeping && winningSlot != null && winningSlot >= 0 ? slotSeats[winningSlot] : null;

  // Taken tricks join their team's pile once the hold lets them leave the table.
  const pileTricks = heldTrick ? game.tricks.slice(0, -1) : game.tricks;
  const stacked = shouldStackTricks(game);
  const pile = (team: typeof myTeam, label: string, color: string) => ({
    label,
    color,
    tricks: teamTricksForDisplay(pileTricks, team, stacked),
    points: teamTrickPoints(pileTricks, team),
    target: view.bidderTeam === team ? view.target : null,
  });

  const myPosition = match.players.find((p) => p.playerId === viewerId)!.position;
  const showReady = view.isHandOver && !view.isMatchOver;
  function seatInfo(playerId: string): SeatInfo {
    const player = match!.players.find((p) => p.playerId === playerId)!;
    const hand = game!.hands.find((h) => h.playerId === playerId);
    const highBidder = isHighBidder(game!, playerId);
    // While bidding is open everyone's bid shows; once trump is named, only the winning bid.
    const shownBid = game!.trump == null ? (hand?.bid ?? null) : highBidder ? game!.bid : null;
    return {
      name: nameOf(playerId),
      side: player.position % 2 === myPosition % 2 ? 'us' : 'them',
      isActive: view.isTableReady && !view.isHandPlayedOut && game!.currentPlayerId === playerId,
      isDealer: view.dealer === playerId,
      bid: view.isTableReady && shownBid != null ? bidToPrettyString(shownBid) : null,
      isHighBidder: highBidder,
      trump: game!.trump,
      ready: showReady ? player.ready : null,
      dominoCount: playerId === myPlayerId || !hand ? null : handSize(hand),
      away: isOnAutopilot(match!, playerId),
      clock: clock?.playerIds.includes(playerId) ? formatClock(clock.remainingMs) : null,
      paused: clock?.paused === true && clock.playerIds.includes(playerId),
    };
  }
  const seats: Record<Seat, SeatInfo | null> = { bottom: null, left: null, top: null, right: null };
  // A parked bot whose seat has opened is drawn as an open seat, not a player.
  for (const p of seatedPlayers(match)) seats[seatFor(match.players, viewerId, p.playerId)!] = seatInfo(p.playerId);
  const emptySeatCount = openSeats(match, viewerId).length;
  // The last human out deletes the match, so for them leaving is cancelling it.
  const onlyHumanSeated = match.players.every((p) => p.playerId === myPlayerId || isBot(p.playerId));
  function confirmLeave() {
    Alert.alert(
      onlyHumanSeated ? 'Cancel this match?' : 'Leave this table?',
      onlyHumanSeated ? 'It will be deleted.' : undefined,
      [
        { text: 'Stay', style: 'cancel' },
        {
          text: onlyHumanSeated ? 'Cancel match' : 'Leave',
          style: 'destructive',
          onPress: () => {
            leavingRef.current = true;
            leave.mutate();
          },
        },
      ],
    );
  }
  // A player can leave a game under way: in Live Play a bot takes their seat; a bots match ends; in a
  // Custom game a bot finishes the hand and then the seat opens.
  const canLeaveGame = (mode === 'live' || mode === 'bots' || mode === 'custom') && hasBeenDealt(match) && !view.isMatchOver && !watching;
  // A game with nobody else present is dropped when I leave it.
  const lastPresent = match.players.every((p) => p.playerId === myPlayerId || !isPresent(match, p.playerId));
  function confirmLeaveGame() {
    const outcome =
      mode === 'custom'
        ? onlyHumanSeated
          ? 'Nobody else is at the table, so it ends.'
          : 'A bot finishes this hand for you, then your seat opens for someone new.'
        : lastPresent
          ? 'Nobody else is playing, so it ends.'
          : 'A bot takes your seat.';
    Alert.alert('Leave this game?', outcome, [
      { text: 'Stay', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => {
          leavingRef.current = true;
          leave.mutate();
        },
      },
    ]);
  }

  const total = marksToWin(match);
  const ruleLabels = houseRuleLabels(match.rules);
  const handWinnerIsUs = view.handWinner === myTeam;
  const contractBid =
    game.bid != null && game.bid !== Bid.Pass && game.biddingPlayerId != null
      ? `${game.trump == null ? 'High bid' : 'Bid'} ${bidToPrettyString(game.bid)} · ${nameFor(game.biddingPlayerId)}`
      : view.isBiddingPhase
        ? 'Bidding is open'
        : null;
  const doublesLine = game.trump != null && isLow(game.trump) ? `doubles: ${doublesRule(game.trump)}` : null;
  const trumpLine = game.trump == null ? null : `${suitToPrettyString(game.trump)}${doublesLine ? ` · ${doublesLine}` : ''}`;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.container, { paddingBottom: 32 + bottomInset }]}
      scrollEnabled={!drag.dragging}
      onLayout={(e) => setViewportHeight(e.nativeEvent.layout.height)}
    >
      <Stack.Screen
        options={{
          title: game.name,
          // Leaving sits in the header's menu, well away from the hand.
          // A Custom Match's house rules get a button beside it.
          headerRight: () => (
            <View style={styles.headerRight}>
              {ruleLabels.length > 0 && <HouseRulesButton onPress={() => setRulesOpen(true)} />}
              {canLeaveGame ? (
                <MatchMenu
                  onHowToPlay={() => router.push('/how-to-play')}
                  onLeave={confirmLeaveGame}
                  leaveDisabled={leave.isPending}
                />
              ) : (
                rulesButton()
              )}
            </View>
          ),
        }}
      />
      {/* The play area fills the screen, less a peek at the trick history below, whatever the
          phase - so the hand sits in the same place from the deal to the last trick, and the
          table opening up as play starts only takes up the room between them. */}
      <Animated.View
        style={[
          styles.playArea,
          {
            minHeight: pinned.interpolate({
              inputRange: [0, 1],
              outputRange: [0, Math.max(0, viewportHeight - CONTAINER_PADDING - CONTAINER_GAP - HISTORY_PEEK - bottomInset)],
            }),
          },
        ]}
      >
        {reconnecting && <Text style={styles.reconnecting}>Reconnecting…</Text>}

        <View style={styles.scoreboard} accessibilityLabel="Scores">
          <Score label="Us" total={total} marks={scores[myTeam] ?? 0} color={colors.us} />
          <View style={styles.contract}>
            {contractBid && (names.ready ? <Text style={styles.contractText}>{contractBid}</Text> : <NameSkeleton width={120} />)}
            {trumpLine && game.trump != null && (
              <View style={styles.trumpRow} accessibilityLabel={doublesLine ? undefined : `Trump: ${trumpLine}`}>
                <PipFace suit={game.trump} size={20} />
                <Text style={styles.contractText}>
                  {suitToPrettyString(game.trump)}
                  {doublesLine && ' ·'}
                </Text>
                {doublesLine && (
                  <Pressable
                    onPress={() => setDoublesOpen(true)}
                    accessibilityRole="button"
                    accessibilityLabel={`Doubles rule: ${doublesRule(game.trump)}`}
                    accessibilityHint="Shows how doubles play this hand"
                    hitSlop={8}
                  >
                    <Text style={[styles.contractText, styles.doublesLink]}>{doublesLine}</Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>
          <Score label="Them" total={total} marks={scores[opponentTeam] ?? 0} color={colors.them} />
        </View>
        {match.currentGame.redealt && view.isBiddingPhase && (
          <Text style={styles.redeal} accessibilityLiveRegion="polite">Everyone passed, so the hands were dealt again.</Text>
        )}

        {meOnAutopilot && !watching && (
          <View style={styles.autopilotBar}>
            <Text style={styles.autopilotText}>Your turn ran out, so a bot is playing for you.</Text>
            <Pressable
              style={[styles.smallButton, resume.isPending && styles.buttonDisabled]}
              disabled={resume.isPending}
              onPress={() => resume.mutate()}
              accessibilityRole="button"
            >
              <Text style={styles.smallButtonText}>Resume</Text>
            </Pressable>
          </View>
        )}

        <Table
          seats={seats}
          trick={view.isTableReady ? trick : null}
          slotSeats={slotSeats}
          winningSlot={winningSlot}
          pendingId={inFlight?.id ?? null}
          dropRef={tableRef}
          dropActive={drag.overDropZone}
          sweepTo={sweepTo}
          compact={tableCompact}
          center={
            view.isTableReady && !(view.openSeatCount > 0 && showHandOver && !isTrickStarted(game.currentTrick)) ? undefined : (
              <View style={styles.waiting}>
                {/* Kept short: it has only the middle of the table, between the open seats. A Live
                    search shows the lobby instead of the table. */}
                {search?.mode === 'daily' && (
                  <Text style={styles.searchText}>Looking for players - we'll notify you when the table fills.</Text>
                )}
                {/* A Live search leaves the count to the status line under the table. */}
                {mode !== 'live' && (
                  <Text style={styles.waitingText}>
                    {view.openSeatCount > 0 ? `${4 - view.openSeatCount} of 4 seated` : 'Dealing'}
                  </Text>
                )}
                <View style={styles.waitingButtons}>
                  {mode === 'custom' && emptySeatCount > 0 && (
                    <Pressable
                      style={styles.smallButton}
                      onPress={() => shareInvite(match.id).catch(toastError)}
                      accessibilityRole="button"
                    >
                      <Text style={styles.smallButtonText}>Share link</Text>
                    </Pressable>
                  )}
                  {mode === 'custom' && emptySeatCount > 0 && (
                    <Pressable style={styles.smallButton} onPress={() => setInviting(true)} accessibilityRole="button">
                      <Text style={styles.smallButtonText}>Invite players</Text>
                    </Pressable>
                  )}
                  {mode === 'custom' && config.data?.bots && emptySeatCount > 0 && (
                    <Pressable
                      style={styles.smallButton}
                      disabled={!connected || addBots.isPending}
                      onPress={() => addBots.mutate()}
                      accessibilityRole="button"
                    >
                      <Text style={styles.smallButtonText}>Fill with bots</Text>
                    </Pressable>
                  )}
                  {!hasBeenDealt(match) && (
                    <Pressable
                      style={[styles.smallButton, styles.dangerButton, leave.isPending && styles.buttonDisabled]}
                      disabled={leave.isPending}
                      onPress={
                        mode === 'live'
                          ? () => {
                              leavingRef.current = true;
                              leave.mutate();
                            }
                          : confirmLeave
                      }
                      accessibilityRole="button"
                    >
                      <Text style={[styles.smallButtonText, styles.dangerButtonText]}>
                        {mode === 'live' ? 'Cancel' : onlyHumanSeated ? 'Cancel match' : 'Leave table'}
                      </Text>
                    </Pressable>
                  )}
                </View>
              </View>
            )
          }
        />

        {/* A watcher gets none of the hand-over panel (its us/them would read as the first seat's),
            the bids or the trumps - just the status line. */}
        {tableCompact && !tableFolded ? null : showHandOver && !watching ? (
          // Takes the status line's place, so it fits above the hand without moving it.
          <Fade key="handOver">
            {view.isMatchOver ? (
              <View style={styles.matchOver} accessibilityLabel="Match over">
                <Text style={styles.handOverTitle}>
                  {match.winningTeam === myTeam ? 'You won the match' : 'They won the match'}
                </Text>
                <Pressable style={styles.smallButton} onPress={() => setSummaryOpen(true)} accessibilityRole="button">
                  <Text style={styles.smallButtonText}>Match summary</Text>
                </Pressable>
                {match.rematchId ? (
                  <ActionButton label="Go to rematch" onPress={() => router.replace(`/match/${match.rematchId}`)} />
                ) : (
                  <ActionButton
                    label={view.iVotedRematch ? `Waiting for rematch (${rematchAgreed(match).length} of 4)` : 'Rematch'}
                    disabled={view.iVotedRematch || !connected || rematch.isPending}
                    onPress={() => rematch.mutate()}
                  />
                )}
              </View>
            ) : (
              <View style={styles.handOver} accessibilityLabel="Hand over">
                <View style={styles.handOverText}>
                  <Text style={styles.handOverTitle}>{handWinnerIsUs ? 'We took the hand' : 'They took the hand'}</Text>
                  {view.openSeatCount > 0 && (
                    <Text style={styles.handOverDetail}>Waiting for a player to take the open seat</Text>
                  )}
                  <Text style={styles.handOverDetail}>
                    {iAmReady
                      ? `Waiting for everyone (${view.readyCount + (view.iAmReady ? 0 : 1)} of 4 ready)`
                      : view.isHandPlayedOut
                        ? 'Ready up for the next hand'
                        : 'Play it out, or ready up'}
                  </Text>
                  {nextHand !== null && <Text style={styles.handOverDetail}>Next hand in {formatClock(nextHand)}</Text>}
                </View>
                <ActionButton
                  label={iAmReady ? 'Ready' : 'Ready up'}
                  disabled={iAmReady || !connected}
                  onPress={() => readyUp.mutate()}
                />
              </View>
            )}
          </Fade>
        ) : view.canBid && !watching ? (
          // Fades out as soon as a bid is picked (and back, should it be turned away), rather than
          // dimming until the server answers and then vanishing.
          <Fade key="bid" visible={!bidSent}>
            <BiddingPanel game={game} myPlayerId={myPlayerId} onBid={(b) => bid.mutate(b)} disabled={!connected} />
          </Fade>
        ) : view.canSelectTrump && !watching ? (
          <Fade key="trump" visible={!trumpSent}>
            <TrumpPicker game={game} onSelect={(s) => trump.mutate(s)} disabled={!connected} />
          </Fade>
        ) : (
          status != null && (
            // Keyed by phase rather than by the words, so a new phase eases in but each turn's
            // status doesn't flicker.
            <Fade key={view.isPlayingPhase ? 'play' : 'wait'}>
              <View style={styles.statusLine}>
                <Text style={view.isSittingOut ? styles.muted : styles.status} accessibilityRole="text">
                  {names.ready ? status : null}
                </Text>
                {!names.ready && <NameSkeleton width={160} />}
                {poke.target != null && !watching && (
                  <Pressable
                    style={[styles.smallButton, poke.pending && styles.buttonDisabled]}
                    disabled={poke.pending}
                    onPress={poke.poke}
                    accessibilityRole="button"
                  >
                    <Text style={styles.smallButtonText}>Poke {nameOf(poke.target)}</Text>
                  </Pressable>
                )}
              </View>
            </Fade>
          )
        )}

        {/* Takes up whatever room is left, keeping the hand at the bottom of the screen: when the
            choices above grow or shrink (a status line, the bids, the trumps), only this changes,
            so nothing else moves. */}
        <View style={styles.spacer} />

        {watching ? (
          <View style={styles.autopilotBar}>
            <Text style={styles.autopilotText}>Joining a game in progress. You'll take a seat when this hand ends.</Text>
            <Pressable
              style={[styles.smallButton, leave.isPending && styles.buttonDisabled]}
              disabled={leave.isPending}
              onPress={() => {
                leavingRef.current = true;
                leave.mutate();
              }}
              accessibilityRole="button"
            >
              <Text style={styles.smallButtonText}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <Hand
            // My live hand, with any domino in flight held back in place (see `playingId`).
            dominoes={myLiveHand}
            playingId={inFlight?.id ?? null}
            canPlay={canPlay}
            isValidPlay={(domino) => isValidPlay(match, view, domino)}
            // Rejects when the play is refused, so a domino dropped on the table returns to the hand.
            onPlay={playDomino}
            highlightPlayable={highlightPlayable}
            dropZone={tableRef}
            onDragChange={setDrag}
          />
        )}
        {/* Laid out whenever there's a hand, and only shown on the player's turn, so it coming and
            going doesn't move anything. */}
        {!handEmpty && (
          <Text
            style={[styles.hint, !canPlay && styles.hidden]}
            numberOfLines={1}
            adjustsFontSizeToFit
            accessibilityElementsHidden={!canPlay}
            importantForAccessibility={canPlay ? 'auto' : 'no-hide-descendants'}
          >
            Tap a domino to {isTrickStarted(game.currentTrick) ? 'play' : 'lead'} it, or hold and drag it to the table.
          </Text>
        )}
      </Animated.View>

      {view.isPlayingPhase && (
        <Fade delay={FADE_IN_MS}>
          <TrickHistory
            us={pile(myTeam, 'Us', colors.us)}
            them={pile(opponentTeam, 'Them', colors.them)}
            stacked={stacked}
          />
        </Fade>
      )}
      <HouseRulesModal rules={match.rules} visible={rulesOpen} onClose={() => setRulesOpen(false)} />
      <DoublesRuleModal trump={doublesOpen ? game.trump : null} onClose={() => setDoublesOpen(false)} />
      <InviteSheet
        visible={inviting}
        matchId={match.id}
        seatedIds={match.players.map((p) => p.playerId)}
        onClose={() => setInviting(false)}
      />
      {view.isMatchOver && (
        <MatchSummary
          visible={summaryOpen}
          match={match}
          myTeam={myTeam}
          nameFor={nameFor}
          iVoted={view.iVotedRematch}
          rematchDisabled={!connected || rematch.isPending}
          onRematch={() => rematch.mutate()}
          onGoToRematch={() => {
            setSummaryOpen(false);
            router.replace(`/match/${match.rematchId}`);
          }}
          onLobby={() => {
            setSummaryOpen(false);
            router.dismissTo('/');
          }}
          onClose={() => setSummaryOpen(false)}
        />
      )}
    </ScrollView>
  );
}

// The match as this player sees it, or null before it loads or when they aren't seated. For the
// hooks above the screen's early returns.
function seatedView(match: MatchState | null, myPlayerId: string | undefined): MatchView | null {
  if (!match || !myPlayerId || !match.players.some((p) => p.playerId === myPlayerId)) return null;
  return describeMatch(match, myPlayerId);
}

// A team's marks as a tally of `total` notches, like the web scoreboard - no number, to save
// room on a phone.
function Score({ label, marks, total, color }: { label: string; marks: number; total: number; color: string }) {
  return (
    <View style={styles.score} accessibilityLabel={`${label}: ${marks} of ${total} marks`}>
      <Text style={[styles.scoreLabel, { color }]}>{label}</Text>
      <View style={styles.tally}>
        {Array.from({ length: total }, (_, i) => (
          <View key={i} style={[styles.notch, i < marks && { backgroundColor: color, borderColor: color }]} />
        ))}
      </View>
    </View>
  );
}

function ActionButton({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      style={[styles.button, disabled && styles.buttonDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const CONTAINER_PADDING = 12;
const CONTAINER_GAP = 14;
const HAND_COLLAPSE_MS = 420;
// How much of the trick history shows below the play area: the top of each pile, with its points.
const HISTORY_PEEK = 40;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.walnut },
  container: { padding: CONTAINER_PADDING, gap: CONTAINER_GAP },
  lobby: { flexGrow: 1 },
  // Fills its minimum height through the spacer above the hand.
  playArea: { gap: CONTAINER_GAP },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: colors.walnut },
  text: { color: colors.bone, fontFamily: fonts.ui },
  reconnecting: { color: colors.danger, fontFamily: fonts.uiBold, textAlign: 'center' },
  scoreboard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(20, 13, 9, 0.45)',
  },
  score: { alignItems: 'center', gap: 5 },
  scoreLabel: { fontFamily: fonts.uiBold, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
  // Seven notches wide (9 + 3 gap each), then wraps, so 21 marks stay inside the score column.
  tally: { flexDirection: 'row', flexWrap: 'wrap', gap: 3, maxWidth: 7 * 9 + 6 * 3 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  redeal: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13, textAlign: 'center' },
  notch: { width: 9, height: 18, borderRadius: 2, borderWidth: 1.5, borderColor: colors.inkMuted },
  contract: { flex: 1, alignItems: 'center', gap: 2 },
  trumpRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  contractText: { color: colors.bone, fontFamily: fonts.uiMedium, textAlign: 'center' },
  // Underlined, as the one tappable part of the contract.
  doublesLink: { textDecorationLine: 'underline' },
  waiting: { alignItems: 'center', gap: 10, padding: 8 },
  waitingText: { color: colors.bone, fontFamily: fonts.display, fontSize: 18, textAlign: 'center' },
  searchText: { color: colors.brass, fontFamily: fonts.uiBold, fontSize: 15, textAlign: 'center' },
  // Side by side, wrapping only when they don't fit.
  waitingButtons: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
  autopilotBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(201, 164, 92, 0.15)',
  },
  autopilotText: { flex: 1, color: colors.bone, fontFamily: fonts.ui, fontSize: 14 },
  smallButton: { borderWidth: 1, borderColor: colors.brass, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  smallButtonText: { color: colors.brass, fontFamily: fonts.uiBold },
  dangerButton: { borderColor: colors.danger },
  dangerButtonText: { color: colors.danger },
  // Under the hand: out of the way of play.
  // The bumped and replaced screens: a line of explanation, then the way on.
  notice: { gap: 16 },
  noticeText: { color: colors.bone, fontFamily: fonts.display, fontSize: 18, textAlign: 'center' },
  lobbyLink: { padding: 8 },
  matchOver: {
    alignItems: 'center',
    gap: 8,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.brass,
    backgroundColor: 'rgba(20, 13, 9, 0.55)',
  },
  // One row - the result, then the button - so it takes little more room than a status line.
  handOver: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.brass,
    backgroundColor: 'rgba(20, 13, 9, 0.55)',
  },
  handOverText: { flex: 1, gap: 2 },
  handOverTitle: { color: colors.bone, fontFamily: fonts.display, fontSize: 20 },
  handOverDetail: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  statusLine: { alignItems: 'center', gap: 8 },
  status: { color: colors.bone, fontFamily: fonts.display, fontSize: 18, textAlign: 'center' },
  muted: { color: colors.inkMuted, fontFamily: fonts.ui, textAlign: 'center' },
  spacer: { flexGrow: 1 },
  hidden: { opacity: 0 },
  hint: { color: colors.inkMuted, fontFamily: fonts.ui, textAlign: 'center', fontSize: 12 },
  button: { backgroundColor: colors.brass, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 8 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: colors.walnutDeep, fontFamily: fonts.uiBold, fontSize: 16 },
});
