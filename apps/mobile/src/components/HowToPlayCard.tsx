// The Lobby's "New to 42?" card, offered until the player dismisses it or opens the rules.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from './theme';

export function HowToPlayCard({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  return (
    <View style={styles.card}>
      <Pressable style={styles.open} onPress={onOpen} accessibilityRole="button">
        <Text style={styles.text}>New to 42? Learn how to play</Text>
      </Pressable>
      <Pressable onPress={onDismiss} accessibilityRole="button" accessibilityLabel="Dismiss" hitSlop={12}>
        <Text style={styles.close}>×</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.brass,
    backgroundColor: colors.walnutDeep,
  },
  open: { flex: 1 },
  text: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  close: { color: colors.inkMuted, fontFamily: fonts.uiBold, fontSize: 24, lineHeight: 26 },
});
