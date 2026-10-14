// An overflow button for the match screen's header - a bare ⋮ with a ripple on Android, like the
// platform's own, and a ringed ⋯ on iOS to match the "?" beside it elsewhere - in place of the "?" while the player can leave the game: How to play,
// and Leave game. Leaving lives up here, away from the hand, so a thumb reaching for a domino
// can't land on it.
import { useState } from 'react';
import { MaterialIcons } from '@expo/vector-icons';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts } from './theme';

const ANDROID = Platform.OS === 'android';

export interface MatchMenuProps {
  onHowToPlay: () => void;
  onLeave: () => void;
  leaveDisabled?: boolean;
}

export function MatchMenu({ onHowToPlay, onLeave, leaveDisabled = false }: MatchMenuProps) {
  const [open, setOpen] = useState(false);
  const { top } = useSafeAreaInsets();
  function choose(action: () => void) {
    setOpen(false);
    action();
  }
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Match menu"
        hitSlop={8}
        android_ripple={ANDROID ? { color: 'rgba(242, 234, 219, 0.2)', borderless: true, radius: 24 } : undefined}
        style={({ pressed }) => (ANDROID ? styles.androidButton : [styles.button, pressed && styles.pressed])}
      >
        {ANDROID ? (
          // Material's own icon, so the dots weigh what the platform's do, in the muted colour
          // Material gives a toolbar's trailing icons.
          <MaterialIcons name="more-vert" size={24} color={colors.inkMuted} />
        ) : (
          <Text style={styles.dots}>⋯</Text>
        )}
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} accessibilityLabel="Close menu">
          {/* Hangs from the header, under the button that opened it. */}
          <View style={[styles.menu, { marginTop: top + 52 }]} accessibilityRole="menu">
            <Pressable
              style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
              onPress={() => choose(onHowToPlay)}
              accessibilityRole="menuitem"
            >
              <Text style={styles.itemText}>How to play</Text>
            </Pressable>
            <View style={styles.divider} />
            <Pressable
              style={({ pressed }) => [styles.item, pressed && styles.itemPressed, leaveDisabled && styles.disabled]}
              disabled={leaveDisabled}
              onPress={() => choose(onLeave)}
              accessibilityRole="menuitem"
            >
              <Text style={[styles.itemText, styles.danger]}>Leave game</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
  // A 48dp target whose dots sit 26dp from the screen's edge, as the Pixel's own apps' overflow
  // buttons' do: the negative margin takes back most of the header's own inset.
  androidButton: { width: 48, height: 48, marginRight: -14, alignItems: 'center', justifyContent: 'center' },
  dots: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 17, lineHeight: 20 },
  backdrop: { flex: 1, alignItems: 'flex-end', paddingHorizontal: 12, backgroundColor: 'rgba(0, 0, 0, 0.35)' },
  menu: {
    minWidth: 180,
    paddingVertical: 4,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.brass,
    backgroundColor: colors.walnutDeep,
  },
  item: { paddingHorizontal: 16, paddingVertical: 12 },
  itemPressed: { backgroundColor: 'rgba(255, 255, 255, 0.08)' },
  itemText: { color: colors.bone, fontFamily: fonts.ui, fontSize: 16 },
  danger: { color: colors.danger },
  disabled: { opacity: 0.5 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.boneEdge, marginHorizontal: 8 },
});
