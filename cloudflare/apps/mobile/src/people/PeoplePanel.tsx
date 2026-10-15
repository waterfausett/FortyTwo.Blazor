// A search box over the People list (usePeople), each person with a star to add or remove them as
// a friend, and an optional action - the match screen's Invite. Used by the Lobby's People segment
// and the Invite players sheet. Not a FlatList: it sits inside screens that already scroll, and
// the list is capped (30 recent, 20 search results) by the Worker.
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { personDetail, type Person } from '@fortytwo/client';
import { colors, fonts } from '@/components/theme';
import { usePeople } from './usePeople';

export function PeoplePanel({
  hiddenIds = [],
  action,
  emptyText,
}: {
  hiddenIds?: string[];
  action?: (person: Person) => ReactNode;
  emptyText: string;
}) {
  const [query, setQuery] = useState('');
  const { list, loading, error, searching, toggleFriend } = usePeople(query);
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
        autoCorrect={false}
        autoCapitalize="none"
      />
      {loading && <ActivityIndicator color={colors.brass} />}
      {error && <Text style={styles.error}>{error.message}</Text>}
      {!loading && !error && shown.length === 0 && (
        <Text style={styles.empty}>{searching ? 'No players by that name.' : emptyText}</Text>
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
