// The Lobby's Invited to card: invites to custom tables waiting for the player (GET /api/invites),
// each with Join (the table's seat picker) and Dismiss. The newest few show, and the rest behind
// "Show N more", so a pile of invites doesn't push the match list down. Nothing at all when there
// are none.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApi } from '@/api/useApi';
import { toastError } from '@/components/toast';
import { colors, fonts } from '@/components/theme';

export const VISIBLE_INVITES = 3;

export function InvitesCard() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const invites = useQuery({ queryKey: ['invites'], queryFn: () => api.getInvites() });
  const dismiss = useMutation({
    mutationFn: (matchId: string) => api.dismissInvite(matchId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invites'] }),
    onError: toastError,
  });
  if (!invites.data || invites.data.length === 0) return null;
  const hidden = invites.data.length - VISIBLE_INVITES;
  const shown = expanded || hidden <= 0 ? invites.data : invites.data.slice(0, VISIBLE_INVITES);

  return (
    <View style={styles.card} accessibilityLabel="Invited to">
      <Text style={styles.title}>Invited to</Text>
      {shown.map((invite) => (
        <View key={invite.matchId} style={styles.row}>
          <View style={styles.text}>
            <Text style={styles.name}>{invite.from.displayName} invited you</Text>
            <Text style={styles.detail}>{invite.seatsOpen === 1 ? '1 seat open' : `${invite.seatsOpen} seats open`}</Text>
          </View>
          <Pressable style={styles.join} onPress={() => router.push(`/match/${invite.matchId}`)} accessibilityRole="button" accessibilityLabel="Join">
            <Text style={styles.joinText}>Join</Text>
          </Pressable>
          <Pressable
            onPress={() => dismiss.mutate(invite.matchId)}
            accessibilityRole="button"
            accessibilityLabel={`Dismiss invite from ${invite.from.displayName}`}
            hitSlop={8}
          >
            <Text style={styles.dismiss}>×</Text>
          </Pressable>
        </View>
      ))}
      {hidden > 0 && (
        <Pressable onPress={() => setExpanded(!expanded)} accessibilityRole="button" accessibilityState={{ expanded }} hitSlop={8}>
          <Text style={styles.more}>{expanded ? 'Show fewer' : `Show ${hidden} more`}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, padding: 14, gap: 8, backgroundColor: colors.walnutDeep },
  title: { color: colors.brass, fontFamily: fonts.uiBold, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  text: { flex: 1 },
  name: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  detail: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  join: { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: colors.brass },
  joinText: { color: colors.walnutDeep, fontFamily: fonts.uiBold },
  dismiss: { color: colors.inkMuted, fontSize: 22 },
  more: { color: colors.brass, fontFamily: fonts.uiBold, fontSize: 13 },
});
