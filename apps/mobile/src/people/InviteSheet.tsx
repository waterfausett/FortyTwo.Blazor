// Invite players to a custom table from the match screen, as a bottom sheet: the People list with
// an Invite button on each person not already seated. An invite goes as a push and to their
// Lobby (POST /api/matches/:id/invites); the button then reads Invited ✓.
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApi } from '@/api/useApi';
import { BottomSheet } from '@/components/BottomSheet';
import { colors, fonts } from '@/components/theme';
import { toastError } from '@/components/toast';
import { PeoplePanel } from './PeoplePanel';

export function InviteSheet({
  visible,
  matchId,
  seatedIds,
  onClose,
}: {
  visible: boolean;
  matchId: string;
  seatedIds: string[];
  onClose: () => void;
}) {
  const api = useApi();
  const insets = useSafeAreaInsets();
  const [invited, setInvited] = useState<string[]>([]);
  const invite = useMutation({
    mutationFn: (userId: string) => api.invitePlayers(matchId, [userId]),
    onSuccess: (_result, userId) => setInvited((ids) => [...ids, userId]),
    onError: toastError,
  });

  return (
    <BottomSheet visible={visible} onClose={onClose} style={[styles.sheet, { paddingBottom: 20 + insets.bottom }]}>
      <Text style={styles.title} accessibilityRole="header">
        Invite players
      </Text>
      <ScrollView keyboardShouldPersistTaps="handled">
        <PeoplePanel
          hiddenIds={seatedIds}
          emptyText="Nobody here yet. Search for a player by name, or share the invite link."
          action={(person) =>
            invited.includes(person.user_id) ? (
              <Text style={styles.invited}>Invited ✓</Text>
            ) : (
              <Pressable
                style={styles.inviteButton}
                onPress={() => invite.mutate(person.user_id)}
                disabled={invite.isPending && invite.variables === person.user_id}
                accessibilityRole="button"
                accessibilityLabel={`Invite ${person.displayName}`}
              >
                <Text style={styles.inviteText}>Invite</Text>
              </Pressable>
            )
          }
        />
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: { maxHeight: '80%', padding: 20, gap: 12, backgroundColor: colors.walnut },
  title: { color: colors.bone, fontFamily: fonts.display, fontSize: 22 },
  invited: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  inviteButton: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6, backgroundColor: colors.brass },
  inviteText: { color: colors.walnutDeep, fontFamily: fonts.uiBold },
});
