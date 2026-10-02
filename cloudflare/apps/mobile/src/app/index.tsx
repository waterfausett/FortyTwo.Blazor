// The lobby: the signed-in player's matches, one filter at a time, plus starting a new match.
// Joining a seat comes with the full lobby screen (#31).
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { router, Stack } from 'expo-router';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useAuth0 } from 'react-native-auth0';
import type { MatchSummary } from '@fortytwo/client';
import { useApi } from '@/api/useApi';

type Filter = 'Active' | 'Joinable' | 'Completed';
const FILTERS: Filter[] = ['Active', 'Joinable', 'Completed'];

export default function Lobby() {
  const api = useApi();
  const { clearSession } = useAuth0();
  const [filter, setFilter] = useState<Filter>('Active');

  const matches = useQuery({
    queryKey: ['matches', filter],
    queryFn: () => api.listMatches(filter),
  });

  const create = useMutation({
    mutationFn: () => api.createMatch(),
    onSuccess: (match) => router.push(`/match/${match.id}`),
  });

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => clearSession()} accessibilityRole="button">
              <Text style={styles.link}>Sign out</Text>
            </Pressable>
          ),
        }}
      />
      <View style={styles.filters}>
        {FILTERS.map((f) => (
          <Pressable
            key={f}
            onPress={() => setFilter(f)}
            style={[styles.filter, f === filter && styles.filterSelected]}
            accessibilityRole="tab"
            accessibilityState={{ selected: f === filter }}
          >
            <Text style={f === filter ? styles.filterTextSelected : undefined}>{f}</Text>
          </Pressable>
        ))}
      </View>
      {matches.error && <Text style={styles.error}>{matches.error.message}</Text>}
      <FlatList
        data={matches.data ?? []}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => <MatchRow match={item} />}
        refreshControl={<RefreshControl refreshing={matches.isFetching} onRefresh={() => matches.refetch()} />}
        ListEmptyComponent={matches.isSuccess ? <Text style={styles.empty}>No matches.</Text> : null}
      />
      {create.error && <Text style={styles.error}>{create.error.message}</Text>}
      <Pressable
        style={styles.button}
        onPress={() => create.mutate()}
        disabled={create.isPending}
        accessibilityRole="button"
      >
        <Text style={styles.buttonText}>New match</Text>
      </Pressable>
    </View>
  );
}

function MatchRow({ match }: { match: MatchSummary }) {
  const [teamA, teamB] = match.teams;
  return (
    <Pressable style={styles.row} onPress={() => router.push(`/match/${match.id}`)}>
      <Text style={styles.rowTitle}>
        {teamA.join(' & ') || '—'} vs {teamB.join(' & ') || '—'}
      </Text>
      <Text style={styles.rowDetail}>
        {match.playerCount}/4 players · updated {new Date(match.updatedOn).toLocaleString()}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  filters: { flexDirection: 'row', gap: 8 },
  filter: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: '#ccc' },
  filterSelected: { backgroundColor: '#1b6ec2', borderColor: '#1b6ec2' },
  filterTextSelected: { color: 'white' },
  row: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#ccc' },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  rowDetail: { color: '#666', marginTop: 2 },
  empty: { textAlign: 'center', color: '#666', marginTop: 24 },
  error: { color: '#b00020' },
  link: { color: '#1b6ec2', fontSize: 16 },
  button: { backgroundColor: '#1b6ec2', padding: 14, borderRadius: 6, alignItems: 'center' },
  buttonText: { color: 'white', fontSize: 16, fontWeight: '600' },
});
