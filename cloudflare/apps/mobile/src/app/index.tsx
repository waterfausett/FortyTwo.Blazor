// The lobby: the signed-in player's matches, one list at a time, plus starting a new match and
// joining an open seat in someone else's. Each list loads a page at a time as it's scrolled.
import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { router, Stack } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useAuth0 } from 'react-native-auth0';
import { uniqueMatches, type MatchPage, type MatchSummary } from '@fortytwo/client';
import { useApi } from '@/api/useApi';
import { clearCachedToken } from '@/auth/tokenCache';
import { SeatPicker } from '@/components/SeatPicker';
import { colors, fonts } from '@/components/theme';
import { toastError } from '@/components/toast';
import { unregisterDevice } from '@/notifications/push';

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
  // This device stops getting the player's notifications before the session goes, while the
  // request can still be signed as them.
  const signOut = async () => {
    await unregisterDevice(api).catch(() => {});
    clearCachedToken();
    await clearSession();
  };
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('Active');
  // The Find a game row whose seat picker is open, if any.
  const [pickingSeatIn, setPickingSeatIn] = useState<string | null>(null);

  const matches = useInfiniteQuery({
    queryKey: ['matches', filter] as const,
    queryFn: ({ pageParam }) => api.listMatches(filter, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  // Loading the next page fetches too, but only a refresh shows the pull-to-refresh spinner.
  const refreshing = matches.isFetching && !matches.isFetchingNextPage;

  // Back to the first page: drop the rest from the cache, then refetch what's left - one request,
  // with the list kept on screen meanwhile.
  function refresh() {
    queryClient.setQueryData<InfiniteData<MatchPage, string | undefined>>(['matches', filter], (data) =>
      data && { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
    );
    void matches.refetch();
  }

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
      toastError(error);
      queryClient.invalidateQueries({ queryKey: ['matches'] });
    },
  });

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={styles.headerLinks}>
              <Pressable onPress={() => router.push('/profile')} accessibilityRole="button">
                <Text style={styles.link}>Profile</Text>
              </Pressable>
              <Pressable onPress={() => void signOut()} accessibilityRole="button">
                <Text style={styles.link}>Sign out</Text>
              </Pressable>
            </View>
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
        data={uniqueMatches(matches.data?.pages) ?? []}
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
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colors.brass}
            colors={[colors.brass]}
          />
        }
        onEndReached={() => {
          if (matches.hasNextPage && !matches.isFetching) void matches.fetchNextPage();
        }}
        ListFooterComponent={
          matches.isFetchingNextPage ? <ActivityIndicator color={colors.brass} style={styles.footer} /> : null
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
  footer: { marginVertical: 12 },
  empty: { textAlign: 'center', color: colors.inkMuted, fontFamily: fonts.ui, marginTop: 24 },
  error: { color: colors.danger, fontFamily: fonts.ui },
  headerLinks: { flexDirection: 'row', gap: 16 },
  link: { color: colors.brass, fontFamily: fonts.uiMedium, fontSize: 16 },
  button: { backgroundColor: colors.brass, padding: 14, borderRadius: 8, alignItems: 'center' },
  buttonText: { color: colors.walnutDeep, fontFamily: fonts.uiBold, fontSize: 16 },
});
