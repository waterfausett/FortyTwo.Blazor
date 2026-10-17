// The Hint button and the hint card above the hand (practice matches only). The card advises; the
// player still makes the move.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { hintHeadline, hintRows } from '@fortytwo/client';
import type { HintController } from '@/match/useHint';
import { colors, fonts } from './theme';

export function HintPanel({ hint }: { hint: HintController }) {
  if (!hint.available) return null;
  const { state } = hint;
  return (
    <View style={styles.panel} accessibilityLabel="Hint">
      {state.status === 'idle' && (
        <Pressable style={styles.button} onPress={hint.ask} accessibilityRole="button">
          <Text style={styles.buttonText}>Hint</Text>
        </Pressable>
      )}
      {state.status === 'loading' && <Text style={styles.status}>Thinking…</Text>}
      {state.status === 'error' && (
        <View style={styles.errorRow}>
          <Text style={styles.status}>{state.message}</Text>
          <Pressable style={styles.button} onPress={hint.ask} accessibilityRole="button">
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      )}
      {state.status === 'ready' && (
        <View style={styles.card}>
          <Text style={styles.headline}>{hintHeadline(state.hint)}</Text>
          {hintRows(state.hint).map((row) => (
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
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { alignItems: 'center', marginVertical: 6 },
  button: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: colors.inkMuted },
  buttonText: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 14 },
  status: { color: colors.bone, fontFamily: fonts.ui, fontSize: 14 },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  card: { gap: 4, padding: 10, borderRadius: 10, backgroundColor: 'rgba(20, 13, 9, 0.45)', minWidth: 220 },
  headline: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 16, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  suggested: { borderWidth: 1, borderColor: colors.brass },
  rowText: { color: colors.bone, fontFamily: fonts.ui, fontSize: 14 },
});
