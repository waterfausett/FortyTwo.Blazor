// A search box over the People list (usePeople), each person with a star to add or remove them as
// a friend, and an optional action - the match screen's Invite. Used by the Lobby's People segment
// and the Invite players sheet. With `views` (the Lobby), a Friends / Recent players toggle shows
// one list at a time, friends first; without it, everyone is listed together. Not a FlatList: it sits inside screens that already scroll, and
// the list is capped (30 recent, 20 search results) by the Worker.
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { personDetail, type PeopleView, type Person } from '@fortytwo/client';
import { colors, fonts } from '@/components/theme';
import { usePeople } from './usePeople';

const VIEWS: { view: PeopleView; label: string }[] = [
  { view: 'friends', label: 'Friends' },
  { view: 'recent', label: 'Recent players' },
];
const NO_FRIENDS = 'No friends yet. Star someone from Recent players to add them.';

export function PeoplePanel({
  hiddenIds = [],
  action,
  emptyText,
  views = false,
}: {
  hiddenIds?: string[];
  action?: (person: Person) => ReactNode;
  emptyText: string;
  views?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<PeopleView>('friends');
  const { list, loading, error, searching, toggleFriend } = usePeople(query, views ? view : undefined);
  const empty = views && view === 'friends' ? NO_FRIENDS : emptyText;
  const shown = (list ?? []).filter((p) => !hiddenIds.includes(p.user_id));

  return (
    <View style={styles.panel}>
      <TextInput
        style={styles.search}
        value={query}
        onChangeText={setQuery}
        placeholder="Find a player by name"
        placeholderTextColor={colors.inkMuted}
        accessibilityLabel="Find a player"
        maxLength={40}
        autoCorrect={false}
        autoCapitalize="none"
      />
      {views && !searching && (
        <View style={styles.views}>
          {VIEWS.map(({ view: v, label }) => (
            <Pressable
              key={v}
              onPress={() => setView(v)}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected: view === v }}
              style={[styles.view, view === v && styles.viewOn]}
            >
              <Text style={[styles.viewText, view === v && styles.viewTextOn]}>{label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {loading && <ActivityIndicator color={colors.brass} />}
      {error && <Text style={styles.error}>{error.message}</Text>}
      {!loading && !error && shown.length === 0 && (
        <Text style={styles.empty}>{searching ? 'No players by that name.' : empty}</Text>
      )}
      {shown.map((person) => (
        <View key={person.user_id} style={styles.row}>
          {person.picture ? (
            <Image source={{ uri: person.picture }} style={styles.avatar} />
          ) : (
            <View style={styles.avatar}>
              <Text style={styles.initial}>{person.displayName.trim()[0]?.toUpperCase()}</Text>
            </View>
          )}
          <View style={styles.text}>
            <Text style={styles.name} numberOfLines={1}>
              {person.displayName}
            </Text>
            {personDetail(person) !== '' && <Text style={styles.detail}>{personDetail(person)}</Text>}
          </View>
          <Pressable
            onPress={() => toggleFriend(person)}
            accessibilityRole="button"
            accessibilityLabel={person.isFriend ? `Remove ${person.displayName} from friends` : `Add ${person.displayName} as a friend`}
            accessibilityState={{ selected: person.isFriend }}
            hitSlop={8}
          >
            <Text style={[styles.star, person.isFriend && styles.starOn]}>{person.isFriend ? '★' : '☆'}</Text>
          </Pressable>
          {action?.(person)}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 8 },
  search: {
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.walnutDeep,
    color: colors.bone,
    fontFamily: fonts.ui,
    fontSize: 16,
  },
  views: { flexDirection: 'row', gap: 8 },
  view: { borderRadius: 999, borderWidth: 1, borderColor: 'transparent', paddingHorizontal: 14, paddingVertical: 6, backgroundColor: colors.walnutDeep },
  viewOn: { borderWidth: 1, borderColor: colors.brass },
  viewText: { color: colors.inkMuted, fontFamily: fonts.uiBold, fontSize: 14 },
  viewTextOn: { color: colors.bone },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.walnutDeep, alignItems: 'center', justifyContent: 'center' },
  initial: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  text: { flex: 1, minWidth: 0 },
  name: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  detail: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  star: { color: colors.inkMuted, fontSize: 22 },
  starOn: { color: colors.brass },
  empty: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 15, textAlign: 'center', paddingVertical: 24 },
  error: { color: colors.danger, fontFamily: fonts.ui },
});
