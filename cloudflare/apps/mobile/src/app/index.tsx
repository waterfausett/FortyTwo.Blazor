// The lobby: the signed-in player's matches, one list at a time, plus starting a new match and
// joining an open seat in someone else's.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, Stack } from 'expo-router';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useAuth0 } from 'react-native-auth0';
import type { MatchSummary } from '@fortytwo/client';
import { useApi } from '@/api/useApi';
import { SeatPicker } from '@/components/SeatPicker';
import { colors, fonts } from '@/components/theme';
import { showError } from '@/components/showError';

type Filter = 'Active' | 'Joinable' | 'Completed';
const FILTERS: { filter: Filter; label: string }[] = [
  { filter: 'Joinable', label: 'Find a game' },
  { filter: 'Active', label: 'Active' },
  { filter: 'Completed', label: 'History' },
];
const EMPTY_LABELS: Record<Filter, string> = {
  Active: "You're not in any games. Create a match, or find one to join.",
  Joinable: 'No open seats right now. Create a match and others can join it.',
  Completed: 'Finished games will show up here.',
};

export default function Lobby() {
  const api = useApi();
  const { clearSession } = useAuth0();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('Active');
  // The Find a game row whose seat picker is open, if any.
  const [pickingSeatIn, setPickingSeatIn] = useState<string | null>(null);

  const matches = useQuery({
    queryKey: ['matches', filter],
    queryFn: () => api.listMatches(filter),
  });

  const create = useMutation({
    mutationFn: () => api.createMatch(),
    onSuccess: (match) => {
      queryClient.invalidateQueries({ queryKey: ['matches'] });
      router.push(`/match/${match.id}`);
    },
  });

  const join = useMutation({
    mutationFn: ({ id, position }: { id: string; position: number }) => api.joinMatch(id, position),
    onSuccess: (match) => {
      setPickingSeatIn(null);
      queryClient.invalidateQueries({ queryKey: ['matches'] });
      router.push(`/match/${match.id}`);
    },
    // Most likely someone took the seat first - refetch so the picker shows who.
    onError: (error) => {
      showError(error);
      queryClient.invalidateQueries({ queryKey: ['matches'] });
    },
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
        {FILTERS.map(({ filter: f, label }) => (
          <Pressable
            key={f}
            onPress={() => setFilter(f)}
            style={[styles.filter, f === filter && styles.filterSelected]}
            accessibilityRole="tab"
            accessibilityState={{ selected: f === filter }}
          >
            <Text style={f === filter ? styles.filterTextSelected : styles.filterText}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {matches.error && <Text style={styles.error}>{matches.error.message}</Text>}
      <FlatList
        data={matches.data ?? []}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <MatchRow
            match={item}
            joinable={filter === 'Joinable'}
            picking={pickingSeatIn === item.id}
            onToggleJoin={() => setPickingSeatIn(pickingSeatIn === item.id ? null : item.id)}
            joining={join.isPending}
            onPick={(position) => join.mutate({ id: item.id, position })}
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={matches.isFetching}
            onRefresh={() => matches.refetch()}
            tintColor={colors.brass}
            colors={[colors.brass]}
          />
        }
        ListEmptyComponent={matches.isSuccess ? <Text style={styles.empty}>{EMPTY_LABELS[filter]}</Text> : null}
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

// "Ann & Cy vs Bo & Di". A team nobody has joined yet reads as "?".
function formatMatchup({ id, teams }: MatchSummary): string {
  if (teams.every((team) => team.length === 0)) return id;
  return teams.map((team) => (team.length > 0 ? team.join(' & ') : '?')).join(' vs ');
}

function MatchRow({
  match,
  joinable,
  picking,
  onToggleJoin,
  joining,
  onPick,
}: {
  match: MatchSummary;
  joinable: boolean;
  picking: boolean;
  onToggleJoin: () => void;
  joining: boolean;
  onPick: (position: number) => void;
}) {
  const summary = (
    <View style={styles.rowText}>
      <Text style={styles.rowTitle}>{formatMatchup(match)}</Text>
      <Text style={styles.rowDetail}>
        {match.playerCount} of 4 seated · updated {new Date(match.updatedOn).toLocaleDateString()}
      </Text>
    </View>
  );
  // You can only open a match you're in, so a joinable row's only action is joining.
  if (!joinable) {
    return (
      <Pressable style={styles.row} onPress={() => router.push(`/match/${match.id}`)} accessibilityRole="button">
        {summary}
      </Pressable>
    );
  }
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        {summary}
        <Pressable style={styles.joinButton} onPress={onToggleJoin} accessibilityRole="button">
          <Text style={styles.joinText}>{picking ? 'Cancel' : 'Join'}</Text>
        </Pressable>
      </View>
      {picking && <SeatPicker seats={match.seats} disabled={joining} onPick={onPick} />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12, backgroundColor: colors.walnut },
  filters: { flexDirection: 'row', gap: 8 },
  filter: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, borderWidth: 1, borderColor: colors.inkMuted },
  filterSelected: { backgroundColor: colors.brass, borderColor: colors.brass },
  filterText: { color: colors.bone, fontFamily: fonts.uiMedium },
  filterTextSelected: { color: colors.walnutDeep, fontFamily: fonts.uiBold },
  row: {
    padding: 12,
    marginBottom: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(20, 13, 9, 0.45)',
  },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowText: { flex: 1 },
  rowTitle: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  joinButton: { backgroundColor: colors.brass, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  joinText: { color: colors.walnutDeep, fontFamily: fonts.uiBold },
  rowDetail: { color: colors.inkMuted, fontFamily: fonts.ui, marginTop: 2 },
  empty: { textAlign: 'center', color: colors.inkMuted, fontFamily: fonts.ui, marginTop: 24 },
  error: { color: colors.danger, fontFamily: fonts.ui },
  link: { color: colors.brass, fontFamily: fonts.uiMedium, fontSize: 16 },
  button: { backgroundColor: colors.brass, padding: 14, borderRadius: 8, alignItems: 'center' },
  buttonText: { color: colors.walnutDeep, fontFamily: fonts.uiBold, fontSize: 16 },
});
