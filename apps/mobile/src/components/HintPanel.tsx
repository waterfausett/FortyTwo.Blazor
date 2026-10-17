// Hints in practice matches. The Hint button sits beside the bid or trump prompt (or the play
// status line); once answered, a bid or trump hint names its suggestion there and a play hint just
// rings the domino in the hand. The details card - chances to make and the close alternatives -
// shows only with ClientConfig.hintDetails on. A hint advises; the player still makes the move.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { hintHeadline, hintRows, hintSuggestion } from '@fortytwo/client';
import type { HintController } from '@/match/useHint';
import { colors, fonts } from './theme';

// Every state sits in the same box (styles.slot, one line of text), so the prompt beside it doesn't
// move when the button gives way to "Thinking…" and then the answer.
export function HintButton({ hint }: { hint: HintController }) {
  if (!hint.available) return null;
  const { state } = hint;
  switch (state.status) {
    case 'idle':
      return (
        <Pressable style={styles.button} onPress={hint.ask} accessibilityRole="button">
          <Text style={styles.buttonText}>Hint</Text>
        </Pressable>
      );
    case 'loading':
      return (
        <View style={styles.slot}>
          <Text style={styles.status}>Thinking…</Text>
        </View>
      );
    case 'error':
      return (
        <View style={styles.errorRow}>
          <Text style={styles.status}>{state.message}</Text>
          <Pressable style={styles.button} onPress={hint.ask} accessibilityRole="button">
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      );
    case 'ready':
      // The ringed domino is the whole of a play hint.
      return state.hint.kind === 'play' ? null : (
        <View style={styles.slot}>
          <Text style={styles.suggestion}>{hintSuggestion(state.hint)}</Text>
        </View>
      );
  }
}

export function HintDetails({ hint, show }: { hint: HintController; show: boolean }) {
  if (!show || !hint.available || hint.state.status !== 'ready') return null;
  const answer = hint.state.hint;
  return (
    <View style={styles.panel} accessibilityLabel="Hint details">
      <View style={styles.card}>
        <Text style={styles.headline}>{hintHeadline(answer)}</Text>
        {hintRows(answer).map((row) => (
          <View
            key={row.key}
            style={[styles.row, row.suggested && styles.suggested]}
            accessible
            accessibilityLabel={`${row.label}, ${row.detail}${row.suggested ? ', suggested' : ''}`}
          >
            <Text style={styles.rowText}>{row.label}</Text>
            <Text style={styles.rowText}>{row.detail}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { alignItems: 'center', marginVertical: 6 },
  slot: { paddingVertical: 4, borderWidth: 1, borderColor: 'transparent', justifyContent: 'center' },
  button: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: colors.inkMuted },
  buttonText: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 14, lineHeight: 20 },
  status: { color: colors.bone, fontFamily: fonts.ui, fontSize: 14, lineHeight: 20 },
  suggestion: { color: colors.brass, fontFamily: fonts.uiBold, fontSize: 14, lineHeight: 20 },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  card: { gap: 4, padding: 10, borderRadius: 10, backgroundColor: 'rgba(20, 13, 9, 0.45)', minWidth: 220 },
  headline: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 16, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  suggested: { borderWidth: 1, borderColor: colors.brass },
  rowText: { color: colors.bone, fontFamily: fonts.ui, fontSize: 14 },
});
