// A round "?" opening How to play, for the Lobby header and the match screen's header.
import { Pressable, StyleSheet, Text } from 'react-native';
import { colors, fonts } from './theme';

export function HelpButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="How to play"
      hitSlop={8}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Text style={styles.text}>?</Text>
    </Pressable>
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
  text: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 17, lineHeight: 20 },
});
