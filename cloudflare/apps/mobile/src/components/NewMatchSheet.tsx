// The New match chooser as a bottom sheet, in two groups: Find opponents (Live and Async, which go
// to matchmaking) and Play with friends (Custom Match sets up a custom table to share). Live
// is left out while bots are off, since it relies on them to fill its seats.
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts } from '@/components/theme';

export type NewMatchChoice = 'live' | 'daily' | 'challenge';

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
  const { height: windowHeight } = useWindowDimensions();
  // As a native sheet does: the scrim fades in place while only the sheet slides. The Modal's own
  // "slide" would carry the scrim up with it. It stays mounted until the sheet is down again.
  const shown = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);
  const [sheetHeight, setSheetHeight] = useState(windowHeight);
  useEffect(() => {
    if (visible) setMounted(true);
    const animation = Animated.timing(shown, {
      toValue: visible ? 1 : 0,
      duration: visible ? OPEN_MS : CLOSE_MS,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
    return () => animation.stop();
  }, [shown, visible]);
  const translateY = shown.interpolate({ inputRange: [0, 1], outputRange: [sheetHeight, 0] });
  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={close}>
      <Animated.View style={[styles.scrim, { opacity: shown }]}>
        <Pressable style={styles.fill} onPress={close} accessibilityLabel="Close" />
      </Animated.View>
      <Animated.View
        onLayout={(e) => setSheetHeight(e.nativeEvent.layout.height)}
        style={[styles.sheet, { paddingBottom: 20 + insets.bottom, transform: [{ translateY }] }]}
      >
        <View style={styles.grab} />
        <Text style={styles.title} accessibilityRole="header">New match</Text>
        {online !== null && <Text style={styles.online}>{online} online</Text>}
        {error && !pending && (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        )}
        {GROUPS.map((group) => {
          const options = group.options.filter((o) => liveEnabled || o.choice !== 'live');
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
      </Animated.View>
    </Modal>
  );
}

const OPEN_MS = 280;
const CLOSE_MS = 220;
// How long a choice works before its line admits it's taking a while.
export const SLOW_MS = 3000;

function workingDetail(choice: NewMatchChoice, slow: boolean): string {
  if (slow) return 'Still working - your connection may be slow.';
  return choice === 'challenge' ? 'Setting up the table…' : 'Finding a seat…';
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
  // Behind the sheet, to the bottom of the screen, so the sheet's rounded corners show it.
  scrim: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(10, 6, 4, 0.6)' },
  fill: { flex: 1 },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
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
