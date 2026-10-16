// The lobby: the signed-in player's matches, one list at a time (three segments: Active, History,
// People), plus starting a new match and starting Live or Async play, or a table to share. Each
// list loads a page at a time as it's scrolled. Invites to custom tables wait in an Invited to card
// above the segments.
//
// Laid out as a phone app's home screen rather than a page: a large title with the player's
// picture (the way to their profile) in place of the navigation bar, a segmented control for the
// lists, full-width rows, and a floating button for a new match. Each person in People has an
// Invite that asks them to one of the player's open Custom tables (InviteToTableSheet).
import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { router, Stack } from 'expo-router';
import { ActivityIndicator, FlatList, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MODE_LABELS, rowStatus, uniqueMatches, yourTurnFirst, type MatchPage, type MatchSummary, type Person } from '@fortytwo/client';
import { useOnline } from '@/api/presence';
import { useApi } from '@/api/useApi';
import { useHowToPlay } from '@/api/useHowToPlay';
import { useProfile } from '@/api/useProfile';
import { NewMatchSheet, type NewMatchChoice } from '@/components/NewMatchSheet';
import { HelpButton } from '@/components/HelpButton';
import { HowToPlayCard } from '@/components/HowToPlayCard';
import { colors, fonts } from '@/components/theme';
import { InvitesCard } from '@/people/InvitesCard';
import { InviteToTableSheet } from '@/people/InviteToTableSheet';
import { PeoplePanel } from '@/people/PeoplePanel';

type Filter = 'Active' | 'Completed';
type Segment = Filter | 'People';
const SEGMENTS: { segment: Segment; label: string }[] = [
  { segment: 'Active', label: 'Active' },
  { segment: 'Completed', label: 'History' },
  { segment: 'People', label: 'People' },
];
const EMPTY: Record<Filter, { title: string; detail: string }> = {
  Active: { title: 'No games yet', detail: 'Start a new match: play Live now, take Async turns, or set up a Custom Match.' },
  Completed: { title: 'Nothing finished yet', detail: 'Finished games will show up here.' },
};

// Room under the list for the floating New match button.
const FAB_CLEARANCE = 88;

export default function Lobby() {
  const api = useApi();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [segment, setSegment] = useState<Segment>('Active');
  const filter: Filter = segment === 'People' ? 'Active' : segment;
  // A first-time player is offered the rules until they dismiss the card or open them.
  const howToPlay = useHowToPlay();

  const matches = useInfiniteQuery({
    queryKey: ['matches', filter] as const,
    enabled: segment !== 'People',
    queryFn: ({ pageParam }) => api.listMatches(filter, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  // Loading the next page fetches too, and so does the first load, which has its own spinner -
  // only a refresh shows the pull-to-refresh one.
  const refreshing = matches.isFetching && !matches.isFetchingNextPage && !matches.isPending;

  // Back to the first page: drop the rest from the cache, then refetch what's left - one request,
  // with the list kept on screen meanwhile.
  function refresh() {
    queryClient.setQueryData<InfiniteData<MatchPage, string | undefined>>(['matches', filter], (data) =>
      data && { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
    );
    void matches.refetch();
    void queryClient.invalidateQueries({ queryKey: ['invites'] });
  }

  // The People segment's pull-to-refresh: its own spinner, until the lists are back.
  const [peopleRefreshing, setPeopleRefreshing] = useState(false);
  async function refreshPeople() {
    setPeopleRefreshing(true);
    try {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['people'] }), queryClient.invalidateQueries({ queryKey: ['invites'] })]);
    } finally {
      setPeopleRefreshing(false);
    }
  }

  const config = useQuery({ queryKey: ['config'], queryFn: () => api.getConfig(), staleTime: Infinity });
  const online = useOnline();
  const [choosing, setChoosing] = useState(false);
  // Who the People segment's Invite is inviting to a table, while its sheet is open.
  const [inviting, setInviting] = useState<Person | null>(null);
  // Live and Async seat the player through matchmaking; Custom Match starts a custom table; Play
  // vs bots starts a game against three bots.
  const start = useMutation({
    mutationFn: (choice: NewMatchChoice) =>
      choice === 'challenge' ? api.createMatch() : choice === 'bots' ? api.playBots() : api.play(choice),
    onSuccess: (match) => {
      setChoosing(false);
      queryClient.invalidateQueries({ queryKey: ['matches'] });
      router.push(`/match/${match.id}`);
    },
    // The sheet shows the error. A timeout may still have seated the player, so refetch the list.
    onError: () => queryClient.invalidateQueries({ queryKey: ['matches'] }),
  });
  function choose() {
    start.reset();
    setChoosing(true);
  }

  const empty = EMPTY[filter];

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.titleRow}>
          <Text style={styles.title} accessibilityRole="header">
            Matches
          </Text>
          <View style={styles.headerButtons}>
            <HelpButton onPress={() => router.push('/how-to-play')} />
            <ProfileButton />
          </View>
        </View>
        {howToPlay.offer && <HowToPlayCard onOpen={() => router.push('/how-to-play')} onDismiss={howToPlay.markSeen} />}
        <InvitesCard />
        <View style={styles.segments} accessibilityRole="tablist">
          {SEGMENTS.map(({ segment: s, label }) => {
            const selected = s === segment;
            return (
              <Pressable
                key={s}
                onPress={() => setSegment(s)}
                style={[styles.segment, selected && styles.segmentSelected]}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
              >
                <Text style={selected ? styles.segmentTextSelected : styles.segmentText}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {segment === 'People' ? (
        <ScrollView
          contentContainerStyle={[styles.list, styles.people, { paddingBottom: FAB_CLEARANCE + insets.bottom }]}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={peopleRefreshing}
              onRefresh={refreshPeople}
              tintColor={colors.brass}
              colors={[colors.brass]}
              progressBackgroundColor={colors.walnutDeep}
            />
          }
        >
          <PeoplePanel
            emptyText="Play a game and the people you play with show up here."
            action={(person) => (
              <Pressable
                style={styles.inviteButton}
                onPress={() => setInviting(person)}
                accessibilityRole="button"
                accessibilityLabel={`Invite ${person.displayName} to a table`}
              >
                <Text style={styles.inviteText}>Invite</Text>
              </Pressable>
            )}
          />
        </ScrollView>
      ) : matches.isPending ? (
        <ActivityIndicator size="large" color={colors.brass} style={styles.loading} />
      ) : (
        <FlatList
          data={yourTurnFirst(uniqueMatches(matches.data?.pages) ?? [])}
          keyExtractor={(m) => m.id}
          contentContainerStyle={[styles.list, { paddingBottom: FAB_CLEARANCE + insets.bottom }]}
          renderItem={({ item }) => <MatchRow match={item} />}
          ItemSeparatorComponent={Separator}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={colors.brass}
              colors={[colors.brass]}
              progressBackgroundColor={colors.walnutDeep}
            />
          }
          onEndReached={() => {
            if (matches.hasNextPage && !matches.isFetching) void matches.fetchNextPage();
          }}
          ListHeaderComponent={matches.error ? <Text style={styles.error}>{matches.error.message}</Text> : null}
          ListFooterComponent={
            matches.isFetchingNextPage ? <ActivityIndicator color={colors.brass} style={styles.footer} /> : null
          }
          ListEmptyComponent={
            matches.isSuccess ? (
              <View style={styles.empty}>
                <SeatGlyph seats={[null, null, null, null]} size={72} />
                <Text style={styles.emptyTitle}>{empty.title}</Text>
                <Text style={styles.emptyDetail}>{empty.detail}</Text>
                {filter === 'Active' && (
                  <Pressable onPress={choose} accessibilityRole="button" hitSlop={8}>
                    <Text style={styles.emptyLink}>New match</Text>
                  </Pressable>
                )}
              </View>
            ) : null
          }
        />
      )}

      <InviteToTableSheet person={inviting} onClose={() => setInviting(null)} />

      <NewMatchSheet
        visible={choosing}
        liveEnabled={config.data?.bots ?? false}
        online={online}
        pending={start.isPending ? start.variables : null}
        error={start.error?.message ?? null}
        onChoose={(c) => start.mutate(c)}
        onClose={() => setChoosing(false)}
      />

      <Pressable
        style={({ pressed }) => [styles.fab, { bottom: 20 + insets.bottom }, pressed && styles.fabPressed]}
        onPress={choose}
        disabled={start.isPending}
        accessibilityRole="button"
        accessibilityLabel="New match"
      >
        {start.isPending ? (
          <ActivityIndicator color={colors.walnutDeep} />
        ) : (
          <Text style={styles.fabPlus}>+</Text>
        )}
        <Text style={styles.fabText}>New match</Text>
      </Pressable>
    </View>
  );
}

// The player's picture, or their initial, opening their profile.
function ProfileButton() {
  const profile = useProfile();
  const picture = profile.data?.picture;
  const initial = (profile.data?.displayName.trim()[0] ?? '').toUpperCase();
  return (
    <Pressable
      onPress={() => router.push('/profile')}
      accessibilityRole="button"
      accessibilityLabel="Profile"
      hitSlop={8}
      style={({ pressed }) => [styles.avatar, pressed && styles.avatarPressed]}
    >
      {picture ? <Image source={{ uri: picture }} style={styles.avatarImage} /> : <Text style={styles.avatarInitial}>{initial}</Text>}
    </Pressable>
  );
}

// The table from above, as in the seat picker: a domino at each seat, lying along the table's
// edge - face up once someone's sitting there, an outline while it's open. Seat 0 nearest, then
// clockwise.
function SeatGlyph({ seats, size = 44 }: { seats: (string | null)[]; size?: number }) {
  const long = size * 0.36;
  const short = long / 2;
  const inset = size * 0.06;
  const across = { width: long, height: short };
  const upright = { width: short, height: long };
  const place = [
    { ...across, bottom: inset, left: (size - long) / 2 },
    { ...upright, left: inset, top: (size - long) / 2 },
    { ...across, top: inset, left: (size - long) / 2 },
    { ...upright, right: inset, top: (size - long) / 2 },
  ];
  return (
    <View style={[styles.glyph, { width: size, height: size, borderRadius: size * 0.24 }]}>
      <View style={[styles.glyphTable, { width: size * 0.3, height: size * 0.3, borderRadius: size * 0.05 }]} />
      {place.map((at, position) => {
        const taken = seats[position] != null;
        const vertical = position % 2 === 1;
        return (
          <View
            key={position}
            style={[
              styles.glyphTile,
              { borderRadius: short * 0.22, flexDirection: vertical ? 'column' : 'row' },
              at,
              taken ? styles.glyphTileTaken : styles.glyphTileOpen,
            ]}
          >
            <View style={[vertical ? styles.glyphDividerAcross : styles.glyphDividerUpright, taken ? styles.glyphDividerTaken : styles.glyphDividerOpen]} />
          </View>
        );
      })}
    </View>
  );
}

// Each team as "Ann & Cy". A team nobody has joined yet reads as "Open seats".
function teamNames(team: string[]): string {
  return team.length > 0 ? team.join(' & ') : 'Open seats';
}

// "Now", "5m", "3h", "2d", then a date.
function updatedLabel(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'Now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / (60 * 24))}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function Separator() {
  return <View style={styles.separator} />;
}

function MatchRow({ match }: { match: MatchSummary }) {
  const status = rowStatus(match);
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      android_ripple={{ color: 'rgba(242, 234, 219, 0.06)' }}
      onPress={() => router.push(`/match/${match.id}`)}
      accessibilityRole="button"
    >
      <SeatGlyph seats={match.seats} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {teamNames(match.teams[0])}
        </Text>
        <Text style={styles.rowTitle} numberOfLines={1}>
          <Text style={styles.rowVs}>vs </Text>
          {teamNames(match.teams[1])}
        </Text>
        <Text style={[styles.rowStatus, status.yours && styles.rowStatusYours]}>
          {MODE_LABELS[match.mode]} · {status.text}
        </Text>
      </View>
      <View style={styles.rowTrailing}>
        <Text style={styles.rowTime}>{updatedLabel(match.updatedOn)}</Text>
        <Text style={styles.chevron}>›</Text>
      </View>
    </Pressable>
  );
}

const hairline = 'rgba(242, 234, 219, 0.09)';

const styles = StyleSheet.create({
  inviteButton: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6, backgroundColor: colors.brass },
  inviteText: { color: colors.walnutDeep, fontFamily: fonts.uiBold },
  screen: { flex: 1, backgroundColor: colors.walnut },

  header: { paddingHorizontal: 20, paddingBottom: 12, gap: 16, backgroundColor: colors.walnut },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerButtons: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  title: { color: colors.bone, fontFamily: fonts.display, fontSize: 34, lineHeight: 40 },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.mat,
    borderWidth: 1.5,
    borderColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarPressed: { opacity: 0.7 },
  avatarImage: { width: '100%', height: '100%' },
  avatarInitial: { color: colors.bone, fontFamily: fonts.display, fontSize: 18 },

  segments: { flexDirection: 'row', padding: 3, borderRadius: 12, backgroundColor: colors.walnutDeep },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 9 },
  segmentSelected: { backgroundColor: colors.matLight },
  segmentText: { color: colors.inkMuted, fontFamily: fonts.uiMedium, fontSize: 15 },
  segmentTextSelected: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 15 },

  loading: { marginTop: 48 },
  list: { flexGrow: 1 },
  people: { paddingHorizontal: 20, paddingTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 14 },
  rowPressed: { backgroundColor: 'rgba(242, 234, 219, 0.04)' },
  rowText: { flex: 1 },
  rowTitle: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16, lineHeight: 21 },
  rowVs: { color: colors.inkMuted, fontFamily: fonts.ui },
  rowStatus: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 14, marginTop: 4 },
  rowStatusYours: { color: colors.brass, fontFamily: fonts.uiBold },
  rowTrailing: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingTop: 2 },
  rowTime: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  chevron: { color: colors.inkMuted, fontSize: 22, lineHeight: 22, marginTop: -2 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: hairline, marginLeft: 20 + 44 + 14 },

  glyph: { backgroundColor: colors.walnutDeep, alignItems: 'center', justifyContent: 'center' },
  glyphTable: { backgroundColor: colors.mat, borderWidth: 1, borderColor: colors.matLight },
  glyphTile: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  glyphTileTaken: { backgroundColor: colors.bone },
  glyphTileOpen: { borderWidth: 1.25, borderColor: colors.brass },
  // The line between a domino's two ends.
  glyphDividerAcross: { width: '70%', height: 1 },
  glyphDividerUpright: { width: 1, height: '70%' },
  glyphDividerTaken: { backgroundColor: colors.boneEdge },
  glyphDividerOpen: { backgroundColor: colors.brass, opacity: 0.6 },

  footer: { marginVertical: 16 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: 8, paddingBottom: 48 },
  emptyTitle: { color: colors.bone, fontFamily: fonts.display, fontSize: 22, marginTop: 12 },
  emptyDetail: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 15, lineHeight: 21, textAlign: 'center' },
  emptyLink: { color: colors.brass, fontFamily: fonts.uiBold, fontSize: 16, marginTop: 8 },
  error: { color: colors.danger, fontFamily: fonts.ui, paddingHorizontal: 20, paddingVertical: 8 },

  fab: {
    position: 'absolute',
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 56,
    paddingLeft: 18,
    paddingRight: 22,
    borderRadius: 18,
    backgroundColor: colors.brass,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  fabPressed: { opacity: 0.85 },
  fabPlus: { color: colors.walnutDeep, fontFamily: fonts.uiBold, fontSize: 26, lineHeight: 28, marginTop: -2 },
  fabText: { color: colors.walnutDeep, fontFamily: fonts.uiBold, fontSize: 16 },
});
