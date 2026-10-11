// The New match chooser as a bottom sheet: Live and Daily go to matchmaking, Challenge friends
// sets up a table to share (a custom match). Live is left out while bots are off, since it relies
// on them to fill its seats.
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts } from '@/components/theme';

export type NewMatchChoice = 'live' | 'daily' | 'challenge';

const OPTIONS: { choice: NewMatchChoice; title: string; detail: string; icon: string }[] = [
  { choice: 'live', title: 'Live', detail: "Play now with whoever's around. Start with bots whenever you like.", icon: '⚡' },
  { choice: 'daily', title: 'Daily', detail: "Take your turns whenever. We'll notify you.", icon: '☀' },
  { choice: 'challenge', title: 'Challenge friends', detail: 'Set up a table and share the invite link.', icon: '✉' },
];

export function NewMatchSheet({
  visible,
  liveEnabled,
  online,
  pending,
  onChoose,
  onClose,
}: {
  visible: boolean;
  liveEnabled: boolean;
  // Players online (the presence socket), or null until the first count arrives.
  online: number | null;
  pending: boolean;
  onChoose: (choice: NewMatchChoice) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: 20 + insets.bottom }]}>
        <View style={styles.grab} />
        <Text style={styles.title} accessibilityRole="header">New match</Text>
        {online !== null && <Text style={styles.online}>{online} online</Text>}
        {OPTIONS.filter((o) => liveEnabled || o.choice !== 'live').map((o) => (
          <Pressable
            key={o.choice}
            style={({ pressed }) => [styles.option, (pressed || pending) && styles.optionDim]}
            disabled={pending}
            onPress={() => onChoose(o.choice)}
            accessibilityRole="button"
            accessibilityLabel={`${o.title}. ${o.detail}`}
          >
            <View style={styles.icon}>
              <Text style={styles.iconText}>{o.icon}</Text>
            </View>
            <View style={styles.optionText}>
              <Text style={styles.optionTitle}>{o.title}</Text>
              <Text style={styles.optionDetail}>{o.detail}</Text>
            </View>
          </Pressable>
        ))}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(10, 6, 4, 0.6)' },
  sheet: {
    backgroundColor: colors.walnutDeep,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 10,
  },
  grab: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(242, 234, 219, 0.25)' },
  title: { color: colors.bone, fontFamily: fonts.display, fontSize: 22, marginBottom: 4 },
  online: { color: colors.brass, fontFamily: fonts.uiMedium, fontSize: 14, marginTop: -6, marginBottom: 4 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, backgroundColor: colors.mat },
  optionDim: { opacity: 0.6 },
  icon: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.brass, alignItems: 'center', justifyContent: 'center' },
  iconText: { color: colors.walnutDeep, fontSize: 18 },
  optionText: { flex: 1 },
  optionTitle: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  optionDetail: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13, marginTop: 2 },
});
