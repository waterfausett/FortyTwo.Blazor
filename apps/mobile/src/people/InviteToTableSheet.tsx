// Invite a person from the Lobby's People segment to one of your tables, as a bottom sheet: your
// open Custom tables (the first page of Active games, filtered by invitableTables), each with an
// Invite button. Invites go through the same POST /api/matches/:id/invites as the match screen's
// Invite players, so the same limits hold - one invite per person per table, six per table; the
// button then reads Invited ✓. Open while `person` is set.
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { invitableTables, tableDetail, tableTitle, type Person } from '@fortytwo/client';
import { useApi } from '@/api/useApi';
import { BottomSheet } from '@/components/BottomSheet';
import { colors, fonts } from '@/components/theme';
import { toastError } from '@/components/toast';

export function InviteToTableSheet({ person, onClose }: { person: Person | null; onClose: () => void }) {
  const api = useApi();
  const insets = useSafeAreaInsets();
  // Kept after `person` clears, so the sheet still has its rows while it slides down.
  const [shown, setShown] = useState(person);
  if (person !== null && person !== shown) setShown(person);
  const [invited, setInvited] = useState<string[]>([]);
  const tables = useQuery({
    queryKey: ['matches', 'Active', 'first-page'],
    queryFn: () => api.listMatches('Active'),
    enabled: person !== null,
  });
  const invite = useMutation({
    mutationFn: ({ matchId, userId }: { matchId: string; userId: string }) => api.invitePlayers(matchId, [userId]),
    onSuccess: (_result, { matchId, userId }) => setInvited((keys) => [...keys, `${matchId}:${userId}`]),
    onError: toastError,
  });
  const open = shown && tables.data && invitableTables(tables.data.matches, shown.displayName);

  return (
    <BottomSheet visible={person !== null} onClose={onClose} style={[styles.sheet, { paddingBottom: 20 + insets.bottom }]}>
      <Text style={styles.title} accessibilityRole="header">
        Invite {shown?.displayName}
      </Text>
      {tables.isPending && <ActivityIndicator color={colors.brass} />}
      {tables.error && <Text style={styles.error}>{tables.error.message}</Text>}
      {open?.length === 0 && <Text style={styles.empty}>No open Custom tables. Start one from New match.</Text>}
      {shown && open && open.length > 0 && (
        <ScrollView>
          {open.map((match) => (
            <View key={match.id} style={styles.row}>
              <View style={styles.text}>
                <Text style={styles.name} numberOfLines={1}>
                  {tableTitle(match)}
                </Text>
                <Text style={styles.detail}>{tableDetail(match)}</Text>
              </View>
              {invited.includes(`${match.id}:${shown.user_id}`) ? (
                <Text style={styles.invited}>Invited ✓</Text>
              ) : (
                <Pressable
                  style={styles.inviteButton}
                  onPress={() => invite.mutate({ matchId: match.id, userId: shown.user_id })}
                  disabled={invite.isPending && invite.variables?.matchId === match.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Invite ${shown.displayName} to ${tableTitle(match)}`}
                >
                  <Text style={styles.inviteText}>Invite</Text>
                </Pressable>
              )}
            </View>
          ))}
        </ScrollView>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: { maxHeight: '80%', padding: 20, gap: 12, backgroundColor: colors.walnut },
  title: { color: colors.bone, fontFamily: fonts.display, fontSize: 22 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  text: { flex: 1, minWidth: 0 },
  name: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  detail: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  empty: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 15, textAlign: 'center', paddingVertical: 24 },
  error: { color: colors.danger, fontFamily: fonts.ui },
  invited: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  inviteButton: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6, backgroundColor: colors.brass },
  inviteText: { color: colors.walnutDeep, fontFamily: fonts.uiBold },
});
