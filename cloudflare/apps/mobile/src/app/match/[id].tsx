// The match screen: scores and contract, the table, and what this player can do right now - bid,
// name trump, play a domino by tapping it, ready up for the next hand, or ask for a rematch. Live
// state comes from the match socket; what the state allows comes from @fortytwo/client's
// describeMatch, which the web match page uses too.
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuth0 } from 'react-native-auth0';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  MARKS_TO_WIN,
  describeMatch,
  isHighBidder,
  isTrickStarted,
  isValidPlay,
  matchStatus,
  openSeats,
  seatFor,
  shouldStackTricks,
  teamTrickPoints,
  teamTricksForDisplay,
  trickLeaderId,
  trickPlayOrder,
  type Seat,
} from '@fortytwo/client';
import {
  Bid,
  bidToPrettyString,
  handSize,
  isLow,
  lowDoublesToPrettyString,
  matchScores,
  rematchAgreed,
  suitToPrettyString,
  type Domino as DominoType,
  type Suit,
} from '@fortytwo/rules';
import { useApi } from '@/api/useApi';
import { useProfile } from '@/api/useProfile';
import { useMatchSocket } from '@/api/useMatchSocket';
import { useGetToken } from '@/auth/useGetToken';
import { BiddingPanel } from '@/components/BiddingPanel';
import { Hand, type DragState } from '@/components/Hand';
import { MatchSummary } from '@/components/MatchSummary';
import { toastError } from '@/components/toast';
import { Table, type SeatInfo } from '@/components/Table';
import { TrickHistory } from '@/components/TrickHistory';
import { TrumpPicker } from '@/components/TrumpPicker';
import { colors, fonts } from '@/components/theme';
import { useTrickHold } from '@/match/useTrickHold';

export default function MatchScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth0();
  const myPlayerId = user?.sub;
  const api = useApi();
  const getToken = useGetToken();
  // Room at the bottom of the scroll, above the phone's gesture bar or navigation buttons.
  const bottomInset = useSafeAreaInsets().bottom;

  const { match: socketMatch, connected, reconnecting } = useMatchSocket(id, getToken);
  // The socket sends the match as soon as it connects; this fills the moment before that, and
  // stands in while the socket is down.
  const matchQuery = useQuery({ queryKey: ['match', id], queryFn: () => api.getMatch(id) });
  const match = socketMatch ?? matchQuery.data ?? null;

  const seatedIds = (match?.players.map((p) => p.playerId) ?? []).sort();
  const names = useQuery({
    queryKey: ['playerNames', seatedIds],
    queryFn: async () => {
      const users = await api.searchUsers(seatedIds);
      return new Map(users.map((u) => [u.user_id, u.displayName]));
    },
    enabled: seatedIds.length > 0,
    staleTime: Infinity,
  });
  // Whether to outline the playable dominoes - a setting the player opts into.
  const highlightPlayable = useProfile().data?.highlightPlayable ?? false;
  // Bots are a dev-only testing aid (the Worker's AUTO_PLAY_BOTS).
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.getConfig(), staleTime: Infinity });

  const bid = useMutation({ mutationFn: (value: Bid) => api.bid(id, value), onError: toastError });
  const trump = useMutation({ mutationFn: (suit: Suit) => api.setTrump(id, suit), onError: toastError });
  const readyUp = useMutation({ mutationFn: () => api.readyUp(id, true), onError: toastError });
  const rematch = useMutation({ mutationFn: () => api.rematch(id), onError: toastError });
  const addBots = useMutation({ mutationFn: () => api.addBots(id), onError: toastError });

  // A play's response arrives before the broadcast that moves the turn on, and until then the
  // stale state would still say it's my turn. Hold play until the broadcast shows the domino I
  // played gone from my hand. (Not "until the turn changes": winning a trick keeps the turn.)
  const [awaitingPlay, setAwaitingPlay] = useState<string | null>(null);
  const play = useMutation({
    mutationFn: (domino: DominoType) => api.playDomino(id, { top: domino.top, bottom: domino.bottom }),
    onSuccess: (_data, domino) => setAwaitingPlay(domino.id),
    onError: toastError,
  });
  const game = match?.currentGame ?? null;
  useEffect(() => {
    if (awaitingPlay == null || !game) return;
    const myHand = game.hands.find((h) => h.playerId === myPlayerId);
    if (!myHand?.dominoes.some((d) => d.id === awaitingPlay)) setAwaitingPlay(null);
  }, [awaitingPlay, game, myPlayerId]);

  const { heldTrick, sweeping } = useTrickHold(game);

  // Dragging a domino to the table: the table is the drop zone, the screen holds still while a
  // domino is held, and the table lights up while one is over it.
  const tableRef = useRef<View>(null);
  // The summary opens by itself when the match ends; closing it uncovers the final table, and the
  // hand-over panel keeps a button to bring it back.
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [drag, setDrag] = useState<DragState>({ dragging: false, overDropZone: false });

  // Follow the rematch once everyone has agreed - but only if it's created while this screen is
  // open. A finished match opened later stays viewable.
  const rematchId = match?.rematchId;
  const rematchIdAtLoad = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!match) return;
    if (rematchIdAtLoad.current === undefined) {
      rematchIdAtLoad.current = rematchId ?? null;
      return;
    }
    if (rematchId && rematchId !== rematchIdAtLoad.current) router.replace(`/match/${rematchId}`);
  }, [match, rematchId]);

  if (!match || !game || !myPlayerId) {
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
  if (!match.players.some((p) => p.playerId === myPlayerId)) {
    return (
      <View style={styles.centered}>
        <Text style={styles.text}>You aren't part of this match.</Text>
      </View>
    );
  }

  const view = describeMatch(match, myPlayerId);
  const { me, myTeam, opponentTeam } = view;
  const scores = matchScores(match);
  const canPlay = view.isMyTurnToPlay && connected && !play.isPending && awaitingPlay == null;
  const nameFor = (playerId: string | null) =>
    playerId === myPlayerId ? 'You' : playerId == null ? '' : (names.data?.get(playerId) ?? playerId);
  const status = matchStatus(match, view, nameFor);

  // The trick on the table: the one just completed while it's held, else the one in progress.
  const trick = heldTrick ?? game.currentTrick;
  const trickIndex = heldTrick ? game.tricks.length - 1 : game.tricks.length;
  const leader = view.isPlayingPhase ? trickLeaderId(match.players, game, trickIndex) : null;
  const order = trickPlayOrder(match.players, game, leader);
  const slotSeats = order.map((pid) => (pid == null ? null : seatFor(match.players, myPlayerId, pid)));
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

  const myPosition = match.players.find((p) => p.playerId === myPlayerId)!.position;
  const showReady = view.isHandOver && !view.isMatchOver;
  function seatInfo(playerId: string): SeatInfo {
    const player = match!.players.find((p) => p.playerId === playerId)!;
    const hand = game!.hands.find((h) => h.playerId === playerId);
    const highBidder = isHighBidder(game!, playerId);
    // While bidding is open everyone's bid shows; once trump is named, only the winning bid.
    const shownBid = game!.trump == null ? (hand?.bid ?? null) : highBidder ? game!.bid : null;
    return {
      name: nameFor(playerId),
      side: player.position % 2 === myPosition % 2 ? 'us' : 'them',
      isActive: view.isTableReady && !view.isHandPlayedOut && game!.currentPlayerId === playerId,
      isDealer: view.dealer === playerId,
      bid: view.isTableReady && shownBid != null ? bidToPrettyString(shownBid) : null,
      ready: showReady ? player.ready : null,
      dominoCount: playerId === myPlayerId || !hand ? null : handSize(hand),
    };
  }
  const seats: Record<Seat, SeatInfo | null> = { bottom: null, left: null, top: null, right: null };
  for (const p of match.players) seats[seatFor(match.players, myPlayerId, p.playerId)!] = seatInfo(p.playerId);
  const emptySeatCount = openSeats(match.players, myPlayerId).length;

  const handWinnerIsUs = view.handWinner === myTeam;
  const contractBid =
    game.bid != null && game.bid !== Bid.Pass && game.biddingPlayerId != null
      ? `${game.trump == null ? 'High bid' : 'Bid'} ${bidToPrettyString(game.bid)} · ${nameFor(game.biddingPlayerId)}`
      : view.isBiddingPhase
        ? 'Bidding is open'
        : null;
  const trumpLine =
    game.trump == null
      ? null
      : `Trump: ${suitToPrettyString(game.trump)}${isLow(game.trump) ? ` (doubles ${lowDoublesToPrettyString(game.trump)})` : ''}`;

  return (
    <ScrollView
      style={styles.screen}
      // flexGrow: so the spacer below can push the hand to the bottom of the screen.
      contentContainerStyle={[styles.container, { flexGrow: 1, paddingBottom: 32 + bottomInset }]}
      scrollEnabled={!drag.dragging}
    >
      <Stack.Screen options={{ title: game.name }} />
      {reconnecting && <Text style={styles.reconnecting}>Reconnecting…</Text>}

      <View style={styles.scoreboard} accessibilityLabel="Scores">
        <Score label="Us" marks={scores[myTeam] ?? 0} color={colors.us} />
        <View style={styles.contract}>
          {contractBid && <Text style={styles.contractText}>{contractBid}</Text>}
          {trumpLine && <Text style={styles.contractText}>{trumpLine}</Text>}
        </View>
        <Score label="Them" marks={scores[opponentTeam] ?? 0} color={colors.them} />
      </View>

      <Table
        seats={seats}
        trick={view.isTableReady ? trick : null}
        slotSeats={slotSeats}
        winningSlot={winningSlot}
        dropRef={tableRef}
        dropActive={drag.overDropZone}
        sweepTo={sweepTo}
        compact={view.isBiddingPhase || view.isTrumpSelectPhase}
        center={
          view.isTableReady ? undefined : (
            <View style={styles.waiting}>
              <Text style={styles.waitingText}>
                {match.players.length < 4 ? `${match.players.length} of 4 seated` : 'Dealing'}
              </Text>
              {config.data?.bots && emptySeatCount > 0 && (
                <Pressable
                  style={styles.smallButton}
                  disabled={!connected || addBots.isPending}
                  onPress={() => addBots.mutate()}
                  accessibilityRole="button"
                >
                  <Text style={styles.smallButtonText}>Fill with bots</Text>
                </Pressable>
              )}
            </View>
          )
        }
      />

      {view.isHandOver && (
        <View style={styles.handOver} accessibilityLabel="Hand over">
          <Text style={styles.handOverTitle}>
            {view.isMatchOver
              ? match.winningTeam === myTeam
                ? 'You won the match'
                : 'They won the match'
              : handWinnerIsUs
                ? 'We took the hand'
                : 'They took the hand'}
          </Text>
          {view.isMatchOver && (
            <Pressable style={styles.smallButton} onPress={() => setSummaryOpen(true)} accessibilityRole="button">
              <Text style={styles.smallButtonText}>Match summary</Text>
            </Pressable>
          )}
          {view.isMatchOver ? (
            match.rematchId ? (
              <ActionButton label="Go to rematch" onPress={() => router.replace(`/match/${match.rematchId}`)} />
            ) : (
              <ActionButton
                label={view.iVotedRematch ? `Waiting for rematch (${rematchAgreed(match).length} of 4)` : 'Rematch'}
                disabled={view.iVotedRematch || !connected || rematch.isPending}
                onPress={() => rematch.mutate()}
              />
            )
          ) : (
            <>
              <Text style={styles.muted}>
                {view.iAmReady
                  ? `Waiting for everyone to ready up (${view.readyCount} of 4)`
                  : view.isHandPlayedOut
                    ? 'Ready up for the next hand'
                    : 'Play it out, or ready up for the next hand'}
              </Text>
              <ActionButton
                label={view.iAmReady ? "You're ready" : 'Ready up'}
                disabled={view.iAmReady || !connected || readyUp.isPending}
                onPress={() => readyUp.mutate()}
              />
            </>
          )}
        </View>
      )}

      {view.canBid ? (
        <BiddingPanel game={game} myPlayerId={myPlayerId} onBid={(b) => bid.mutate(b)} disabled={!connected || bid.isPending} />
      ) : view.canSelectTrump ? (
        <TrumpPicker game={game} onSelect={(s) => trump.mutate(s)} disabled={!connected || trump.isPending} />
      ) : (
        status != null && (
          <Text style={view.isSittingOut ? styles.muted : styles.status} accessibilityRole="text">
            {status}
          </Text>
        )
      )}

      {/* Takes up whatever room is left, keeping the hand at the bottom of the screen: when the
          choices above grow or shrink (a status line, the bids, the trumps), only this changes,
          so nothing else moves. */}
      <View style={styles.spacer} />

      <Hand
        dominoes={me.dominoes ?? []}
        canPlay={canPlay}
        isValidPlay={(domino) => isValidPlay(match, view, domino)}
        // mutateAsync, so a domino dropped on the table returns to the hand if the play is turned
        // away (the mutation's onError still shows why).
        onPlay={(domino) => play.mutateAsync(domino)}
        highlightPlayable={highlightPlayable}
        dropZone={tableRef}
        onDragChange={setDrag}
      />
      {/* Always laid out, and only shown on the player's turn, so it coming and going doesn't move
          anything. */}
      <Text
        style={[styles.hint, !canPlay && styles.hidden]}
        numberOfLines={1}
        adjustsFontSizeToFit
        accessibilityElementsHidden={!canPlay}
        importantForAccessibility={canPlay ? 'auto' : 'no-hide-descendants'}
      >
        Tap a domino to {isTrickStarted(game.currentTrick) ? 'play' : 'lead'} it, or hold and drag it to the table.
      </Text>

      {view.isPlayingPhase && (
        <TrickHistory
          us={pile(myTeam, 'Us', colors.us)}
          them={pile(opponentTeam, 'Them', colors.them)}
          stacked={stacked}
        />
      )}
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

// A team's marks as a tally of MARKS_TO_WIN notches, like the web scoreboard - no number, to save
// room on a phone.
function Score({ label, marks, color }: { label: string; marks: number; color: string }) {
  return (
    <View style={styles.score} accessibilityLabel={`${label}: ${marks} of ${MARKS_TO_WIN} marks`}>
      <Text style={[styles.scoreLabel, { color }]}>{label}</Text>
      <View style={styles.tally}>
        {Array.from({ length: MARKS_TO_WIN }, (_, i) => (
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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.walnut },
  container: { padding: 12, gap: 14 },
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
  tally: { flexDirection: 'row', gap: 3 },
  notch: { width: 9, height: 18, borderRadius: 2, borderWidth: 1.5, borderColor: colors.inkMuted },
  contract: { flex: 1, alignItems: 'center', gap: 2 },
  contractText: { color: colors.bone, fontFamily: fonts.uiMedium, textAlign: 'center' },
  waiting: { alignItems: 'center', gap: 10, padding: 8 },
  waitingText: { color: colors.bone, fontFamily: fonts.display, fontSize: 18, textAlign: 'center' },
  smallButton: { borderWidth: 1, borderColor: colors.brass, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  smallButtonText: { color: colors.brass, fontFamily: fonts.uiBold },
  handOver: {
    alignItems: 'center',
    gap: 8,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.brass,
    backgroundColor: 'rgba(20, 13, 9, 0.55)',
  },
  handOverTitle: { color: colors.bone, fontFamily: fonts.display, fontSize: 22 },
  status: { color: colors.bone, fontFamily: fonts.display, fontSize: 18, textAlign: 'center' },
  muted: { color: colors.inkMuted, fontFamily: fonts.ui, textAlign: 'center' },
  spacer: { flexGrow: 1 },
  hidden: { opacity: 0 },
  hint: { color: colors.inkMuted, fontFamily: fonts.ui, textAlign: 'center', fontSize: 12 },
  button: { backgroundColor: colors.brass, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 8 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: colors.walnutDeep, fontFamily: fonts.uiBold, fontSize: 16 },
});
