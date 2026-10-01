// A read-only view of one match, kept live by the match socket: who's seated, the score, and the
// current hand. Bidding and play come with the full match screen (#31).
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuth0 } from 'react-native-auth0';
import {
  bidToPrettyString,
  getPlayerView,
  matchScores,
  suitToPrettyString,
  Teams,
  teamForPosition,
} from '@fortytwo/rules';
import { useApi } from '@/api/useApi';
import { useMatchSocket } from '@/api/useMatchSocket';
import { useGetToken } from '@/auth/useGetToken';

export default function MatchScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth0();
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
  const nameFor = (playerId: string | null | undefined) =>
    playerId ? (names.data?.get(playerId) ?? playerId) : '—';

  if (!match) {
    return (
      <View style={styles.container}>
        <Text>{matchQuery.error ? matchQuery.error.message : 'Loading…'}</Text>
      </View>
    );
  }

  const game = match.currentGame;
  const scores = matchScores(match);
  const me = user?.sub && match.players.some((p) => p.playerId === user.sub) ? getPlayerView(match, user.sub) : null;
  const seats = [0, 1, 2, 3].map((position) => match.players.find((p) => p.position === position));

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: game.name }} />
      <Text style={connected ? styles.live : styles.offline}>
        {connected ? 'Live' : reconnecting ? 'Reconnecting…' : 'Connecting…'}
      </Text>

      <Section title="Score">
        <Text>Team A: {scores[Teams.TeamA] ?? 0} · Team B: {scores[Teams.TeamB] ?? 0}</Text>
        {match.winningTeam != null && <Text>{Teams[match.winningTeam]} won the match.</Text>}
      </Section>

      <Section title="Seats">
        {seats.map((player, position) => (
          <Text key={position}>
            {position + 1}. {player ? nameFor(player.playerId) : 'Open'} ({Teams[teamForPosition(position)]})
            {player?.ready ? ' · ready' : ''}
          </Text>
        ))}
      </Section>

      <Section title="This hand">
        <Text>
          Bid: {bidToPrettyString(game.bid)}
          {game.biddingPlayerId ? ` by ${nameFor(game.biddingPlayerId)}` : ''}
        </Text>
        <Text>Trump: {game.trump != null ? suitToPrettyString(game.trump) : '—'}</Text>
        <Text>Turn: {nameFor(game.currentPlayerId)}</Text>
        <Text>
          Current trick: {game.currentTrick.dominoes
            .filter((d) => d != null)
            .map((d) => `${d.top}|${d.bottom}`).join('  ') || '—'}
        </Text>
      </Section>

      {me?.dominoes && (
        <Section title="Your hand">
          <Text style={styles.hand}>{me.dominoes.map((d) => `${d.top}|${d.bottom}`).join('  ')}</Text>
        </Section>
      )}
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16 },
  live: { color: '#2e7d32', fontWeight: '600' },
  offline: { color: '#b26a00', fontWeight: '600' },
  section: { gap: 4 },
  sectionTitle: { fontSize: 18, fontWeight: '700' },
  hand: { fontSize: 18 },
});
