// One domino tile drawn with Views: two square halves, each a 3x3 grid of pip cells laid out like a
// die face. A `Domino` (packages/rules) only carries its canonical `top <= bottom` values, so a
// tile has no orientation beyond vertical or horizontal.
import { Pressable, StyleSheet, View } from 'react-native';
import { colors } from './theme';

// Which of the 9 grid cells (row-major, 0-8) carry a pip for each count.
const PIP_CELLS: Record<number, number[]> = {
  0: [],
  1: [4],
  2: [2, 6],
  3: [2, 4, 6],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

export function Pips({ value, size }: { value: number; size: number }) {
  const cells = PIP_CELLS[value] ?? [];
  const pip = size / 5;
  return (
    <View style={[styles.half, { width: size, height: size, padding: pip / 2 }]}>
      {Array.from({ length: 9 }, (_, i) => (
        <View key={i} style={[styles.cell, { width: (size - pip) / 3, height: (size - pip) / 3 }]}>
          {cells.includes(i) && <View style={{ width: pip, height: pip, borderRadius: pip / 2, backgroundColor: colors.pip }} />}
        </View>
      ))}
    </View>
  );
}

export interface DominoProps {
  top: number;
  bottom: number;
  // The length of one half's side.
  size?: number;
  direction?: 'vertical' | 'horizontal';
  onPress?: () => void;
  // Shown faded: can't be played right now.
  dimmed?: boolean;
  highlighted?: boolean;
  accessibilityLabel?: string;
}

export function Domino({
  top,
  bottom,
  size = 28,
  direction = 'vertical',
  onPress,
  dimmed = false,
  highlighted = false,
  accessibilityLabel,
}: DominoProps) {
  const tile = (
    <View
      style={[
        styles.tile,
        direction === 'horizontal' ? styles.horizontal : null,
        highlighted ? styles.highlighted : null,
        dimmed ? styles.dimmed : null,
      ]}
    >
      <Pips value={top} size={size} />
      <View style={direction === 'horizontal' ? [styles.divider, styles.dividerVertical] : styles.divider} />
      <Pips value={bottom} size={size} />
    </View>
  );

  const label = accessibilityLabel ?? `${top}-${bottom}`;
  if (!onPress) {
    return (
      <View accessible accessibilityLabel={label}>
        {tile}
      </View>
    );
  }
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={4}>
      {tile}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    backgroundColor: colors.tile,
    borderColor: colors.tileEdge,
    borderWidth: 1,
    borderRadius: 4,
    alignItems: 'center',
  },
  horizontal: { flexDirection: 'row' },
  highlighted: { borderColor: '#f2b705', borderWidth: 2 },
  dimmed: { opacity: 0.4 },
  half: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { alignItems: 'center', justifyContent: 'center' },
  divider: { alignSelf: 'stretch', height: 1, backgroundColor: colors.tileEdge, marginHorizontal: 3 },
  dividerVertical: { width: 1, height: undefined, marginHorizontal: 0, marginVertical: 3 },
});
