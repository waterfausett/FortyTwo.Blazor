// The New match chooser as a bottom sheet, in three groups: Find opponents (Live and Async, which
// go to matchmaking), Play with friends (Custom Match sets up a custom table to share) and Practice
// (Play vs bots goes straight into a game against three bots). Live and Play vs bots are left out
// while bots are off, since they rely on them to fill their seats.
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet } from '@/components/BottomSheet';
import { colors, fonts } from '@/components/theme';

export type NewMatchChoice = 'live' | 'daily' | 'challenge' | 'bots';

type IconName = keyof typeof Ionicons.glyphMap;

interface Option {
  choice: NewMatchChoice;
  title: string;
  detail: string;
  icon: IconName;
}

const GROUPS: { id: string; label: string; icon: IconName; options: Option[] }[] = [
  {
    id: 'matchmade',
    label: 'Find opponents',
    icon: 'people',
    options: [
      { choice: 'live', title: 'Live Play',
        detail: '60-second turns; kicked if away for a full hand.', icon: 'pulse' },
      { choice: 'daily', title: 'Async', detail: "Take turns whenever; we'll notify you.", icon: 'notifications' },
    ],
  },
  {
    id: 'friends',
    label: 'Play with friends',
    icon: 'mail',
    options: [{ choice: 'challenge', title: 'Custom Match', detail: 'Set up a table and send the invite link.', icon: 'construct' }],
  },
  {
    id: 'practice',
    label: 'Practice',
    icon: 'hardware-chip',
    options: [{ choice: 'bots', title: 'Play vs bots', detail: 'Jump straight in against three bots.', icon: 'play' }],
  },
];

export function NewMatchSheet({
  visible,
  liveEnabled,
  online,
  pending,
  error,
  onChoose,
  onClose,
}: {
  visible: boolean;
  liveEnabled: boolean;
  // Players online (the presence socket), or null until the first count arrives.
  online: number | null;
  // The choice being started, or null. Only that option shows it's working; the sheet stays open
  // until it lands, so the player isn't moved to a match after giving up on it.
  pending: NewMatchChoice | null;
  // Why the last choice failed. Shown here, since a toast would sit under the sheet.
  error: string | null;
  onChoose: (choice: NewMatchChoice) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const slow = useSlow(pending);
  const close = pending ? () => {} : onClose;
  return (
    <BottomSheet visible={visible} onClose={close} style={[styles.sheet, { paddingBottom: 20 + insets.bottom }]}>
      <View style={styles.grab} />
      <Text style={styles.title} accessibilityRole="header">New match</Text>
      {online !== null && <Text style={styles.online}>{online} online</Text>}
      {error && !pending && (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      )}
      {GROUPS.map((group) => {
        const options = group.options.filter((o) => liveEnabled || (o.choice !== 'live' && o.choice !== 'bots'));
        if (options.length === 0) return null;
        return (
          <View key={group.id} style={styles.group}>
            <View style={styles.groupLabel} accessible accessibilityRole="header" accessibilityLabel={group.label}>
              <Ionicons name={group.icon} size={14} color={colors.inkMuted} />
              <Text style={styles.groupLabelText}>{group.label.toUpperCase()}</Text>
            </View>
            {options.map((o) => {
              const working = pending === o.choice;
              const detail = working ? workingDetail(o.choice, slow) : o.detail;
              return (
                <Pressable
                  key={o.choice}
                  style={({ pressed }) => [styles.option, (pressed || (pending && !working)) && styles.optionDim]}
                  disabled={pending !== null}
                  onPress={() => onChoose(o.choice)}
                  accessibilityRole="button"
                  accessibilityLabel={`${o.title}. ${detail}`}
                  accessibilityState={{ disabled: pending !== null, busy: working }}
                >
                  <View style={styles.icon}>
                    {working ? (
                      <ActivityIndicator color={colors.walnutDeep} />
                    ) : (
                      <Ionicons name={o.icon} size={18} color={colors.walnutDeep} />
                    )}
                  </View>
                  <View style={styles.optionText}>
                    <Text style={styles.optionTitle}>{o.title}</Text>
                    <Text style={working ? styles.optionWorking : styles.optionDetail}>{detail}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        );
      })}
    </BottomSheet>
  );
}

// How long a choice works before its line admits it's taking a while.
export const SLOW_MS = 3000;

function workingDetail(choice: NewMatchChoice, slow: boolean): string {
  if (slow) return 'Still working - your connection may be slow.';
  return choice === 'challenge' || choice === 'bots' ? 'Setting up the table…' : 'Finding a seat…';
}

// True once `pending` has stayed set for SLOW_MS; false again when it clears.
function useSlow(pending: NewMatchChoice | null): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [pending]);
  return slow;
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: colors.walnutDeep,
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 10,
  },
  grab: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(242, 234, 219, 0.25)' },
  title: { color: colors.bone, fontFamily: fonts.display, fontSize: 22, marginBottom: 4 },
  online: { color: colors.brass, fontFamily: fonts.uiMedium, fontSize: 14, marginTop: -6, marginBottom: 4 },
  group: { gap: 10, marginTop: 4 },
  groupLabel: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  groupLabelText: { color: colors.inkMuted, fontFamily: fonts.uiBold, fontSize: 12, letterSpacing: 1 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, backgroundColor: colors.mat },
  optionDim: { opacity: 0.6 },
  icon: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.brass, alignItems: 'center', justifyContent: 'center' },
  optionText: { flex: 1 },
  optionTitle: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  optionDetail: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13, marginTop: 2 },
  optionWorking: { color: colors.brass, fontFamily: fonts.ui, fontSize: 13, marginTop: 2 },
  error: { color: colors.danger, fontFamily: fonts.uiMedium, fontSize: 14 },
});
