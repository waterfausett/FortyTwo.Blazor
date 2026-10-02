// The match screen: scores and contract, the table, and what this player can do right now - bid,
// name trump, play a domino by tapping it, ready up for the next hand, or ask for a rematch. Live
// state comes from the match socket; what the state allows comes from @fortytwo/client's
// describeMatch, which the web match page uses too.
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuth0 } from 'react-native-auth0';
import {
  MARKS_TO_WIN,
  describeMatch,
  isHighBidder,
  isTrickStarted,
  isValidPlay,
  matchStatus,
  openSeats,
  seatFor,
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
import { useMatchSocket } from '@/api/useMatchSocket';
import { useGetToken } from '@/auth/useGetToken';
import { BiddingPanel } from '@/components/BiddingPanel';
import { Hand } from '@/components/Hand';
import { showError } from '@/components/showError';
import { Table, type SeatInfo } from '@/components/Table';
import { TrumpPicker } from '@/components/TrumpPicker';
import { colors, fonts } from '@/components/theme';
import { useTrickHold } from '@/match/useTrickHold';

export default function MatchScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth0();
  const myPlayerId = user?.sub;
  const api = useApi();
  const getToken = useGetToken();

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
  // Bots are a dev-only testing aid (the Worker's AUTO_PLAY_BOTS).
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.getConfig(), staleTime: Infinity });

  const bid = useMutation({ mutationFn: (value: Bid) => api.bid(id, value), onError: showError });
  const trump = useMutation({ mutationFn: (suit: Suit) => api.setTrump(id, suit), onError: showError });
  const readyUp = useMutation({ mutationFn: () => api.readyUp(id, true), onError: showError });
  const rematch = useMutation({ mutationFn: () => api.rematch(id), onError: showError });
  const addBots = useMutation({ mutationFn: () => api.addBots(id), onError: showError });

  // A play's response arrives before the broadcast that moves the turn on, and until then the
  // stale state would still say it's my turn. Hold play until the broadcast shows the domino I
  // played gone from my hand. (Not "until the turn changes": winning a trick keeps the turn.)
  const [awaitingPlay, setAwaitingPlay] = useState<string | null>(null);
  const play = useMutation({
    mutationFn: (domino: DominoType) => api.playDomino(id, { top: domino.top, bottom: domino.bottom }),
    onSuccess: (_data, domino) => setAwaitingPlay(domino.id),
    onError: showError,
  });
  const game = match?.currentGame ?? null;
  useEffect(() => {
    if (awaitingPlay == null || !game) return;
    const myHand = game.hands.find((h) => h.playerId === myPlayerId);
    if (!myHand?.dominoes.some((d) => d.id === awaitingPlay)) setAwaitingPlay(null);
  }, [awaitingPlay, game, myPlayerId]);

  const heldTrick = useTrickHold(game);

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
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: game.name }} />
      {reconnecting && <Text style={styles.reconnecting}>Reconnecting…</Text>}

      <View style={styles.scoreboard} accessibilityLabel="Scores">
        <Score label="Us" marks={scores[myTeam] ?? 0} color={colors.us} />
        <View style={styles.contract}>
          {contractBid && <Text style={styles.contractText}>{contractBid}</Text>}
          {trumpLine && <Text style={styles.contractText}>{trumpLine}</Text>}
          {view.target != null && <Text style={styles.contractDetail}>Bidders need {view.target}</Text>}
        </View>
        <Score label="Them" marks={scores[opponentTeam] ?? 0} color={colors.them} />
      </View>

      <Table
        seats={seats}
        trick={view.isTableReady ? trick : null}
        slotSeats={slotSeats}
        winningSlot={winningSlot}
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

      <Hand
        dominoes={me.dominoes ?? []}
        canPlay={canPlay}
        isValidPlay={(domino) => isValidPlay(match, view, domino)}
        onPlay={(domino) => play.mutate(domino)}
      />
      {canPlay && (
        <Text style={styles.hint}>Tap a domino to {isTrickStarted(game.currentTrick) ? 'play' : 'lead'} it.</Text>
      )}
    </ScrollView>
  );
}

// A team's marks, with a tally of MARKS_TO_WIN notches like the web scoreboard.
function Score({ label, marks, color }: { label: string; marks: number; color: string }) {
  return (
    <View style={styles.score} accessibilityLabel={`${label}: ${marks} of ${MARKS_TO_WIN} marks`}>
      <Text style={[styles.scoreLabel, { color }]}>{label}</Text>
      <Text style={styles.scoreValue}>{marks}</Text>
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
  score: { alignItems: 'center', width: 76, gap: 2 },
  scoreLabel: { fontFamily: fonts.uiBold, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
  scoreValue: { color: colors.bone, fontFamily: fonts.display, fontSize: 28, lineHeight: 32 },
  tally: { flexDirection: 'row', gap: 2 },
  notch: { width: 7, height: 10, borderRadius: 2, borderWidth: 1, borderColor: colors.inkMuted },
  contract: { flex: 1, alignItems: 'center', gap: 2 },
  contractText: { color: colors.bone, fontFamily: fonts.uiMedium, textAlign: 'center' },
  contractDetail: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 12 },
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
  hint: { color: colors.inkMuted, fontFamily: fonts.ui, textAlign: 'center', fontSize: 12 },
  button: { backgroundColor: colors.brass, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 8 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: colors.walnutDeep, fontFamily: fonts.uiBold, fontSize: 16 },
});
