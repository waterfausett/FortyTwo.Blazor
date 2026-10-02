// One domino tile, drawn like the web's (apps/web/src/styles/domino.css): a bone tile twice as
// tall as it is wide, a divider across the middle, and each half's pips placed like a die face,
// coloured by count. Every pip is positioned absolutely from the tile's width, so the layout can't
// shift with rounding the way a wrapped grid of fractional cells does.
import { Pressable, StyleSheet, View } from 'react-native';
import { colors } from './theme';

// Pip colours by count, as on the web.
const PIP_COLORS: Record<number, string> = {
  1: '#5fa8d3',
  2: '#3f8f3a',
  3: '#cd5c5c',
  4: '#e0915a',
  5: '#2b3f8f',
  6: '#d4a514',
};

// Pip centres within one half, in units of a sixth of the tile's width (a half is 6 x 6 units):
// columns at 1.5, 3, 4.5 and rows at 1.4, 3, 4.6, matching the web tile's layout.
const COLS = [1.5, 3.05, 4.6];
const ROWS = [1.4, 3, 4.6];
// Which of the 9 grid cells (row-major) carry a pip for each count. 2 and 3 run corner to corner
// from top-right, like the web tile.
const PIP_CELLS: Record<number, number[]> = {
  0: [],
  1: [4],
  2: [2, 6],
  3: [2, 4, 6],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};
const PIP_DIAMETER = 1.2;

// Pip centres for a half showing `value`, in units, relative to that half's top-left corner.
export function pipCenters(value: number): { x: number; y: number }[] {
  return (PIP_CELLS[value] ?? []).map((cell) => ({ x: COLS[cell % 3], y: ROWS[Math.floor(cell / 3)] }));
}

export interface DominoProps {
  top: number;
  bottom: number;
  // The tile's width when vertical (its height is twice that). Horizontal tiles swap the two.
  width?: number;
  direction?: 'vertical' | 'horizontal';
  onPress?: () => void;
  // Shown faded: can't be played right now.
  dimmed?: boolean;
  // A brass outline: playable now, or the winning domino of a trick.
  highlighted?: boolean;
  accessibilityLabel?: string;
}

export function Domino({
  top,
  bottom,
  width = 32,
  direction = 'vertical',
  onPress,
  dimmed = false,
  highlighted = false,
  accessibilityLabel,
}: DominoProps) {
  const unit = width / 6;
  const horizontal = direction === 'horizontal';
  const pip = PIP_DIAMETER * unit;

  // Lay pips out on the vertical tile (top half 0-6 units, bottom half 6-12), then turn the tile
  // a quarter clockwise for horizontal: the top half ends up on the right, as on the web.
  const pips = [
    ...pipCenters(top).map((p) => ({ ...p, value: top })),
    ...pipCenters(bottom).map((p) => ({ x: p.x, y: p.y + 6, value: bottom })),
  ].map(({ x, y, value }, i) => {
    const cx = horizontal ? 12 - y : x;
    const cy = horizontal ? x : y;
    return (
      <View
        key={i}
        style={{
          position: 'absolute',
          left: cx * unit - pip / 2,
          top: cy * unit - pip / 2,
          width: pip,
          height: pip,
          borderRadius: pip / 2,
          backgroundColor: PIP_COLORS[value],
        }}
      />
    );
  });

  const tile = (
    <View
      style={[
        styles.tile,
        {
          width: horizontal ? width * 2 : width,
          height: horizontal ? width : width * 2,
          borderRadius: unit * 0.8,
          // The web tile's offset shadow, as a thicker bottom-right edge.
          borderRightWidth: Math.max(1, unit * 0.35),
          borderBottomWidth: Math.max(1, unit * 0.35),
        },
        highlighted && styles.highlighted,
        dimmed && styles.dimmed,
      ]}
    >
      <View
        style={[
          styles.divider,
          horizontal
            ? { left: 6 * unit - 1, top: unit * 0.4, bottom: unit * 0.4, width: Math.max(1, unit * 0.2) }
            : { top: 6 * unit - 1, left: unit * 0.4, right: unit * 0.4, height: Math.max(1, unit * 0.2) },
        ]}
      />
      {pips}
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
      {({ pressed }) => <View style={pressed ? styles.pressed : undefined}>{tile}</View>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    backgroundColor: colors.bone,
    borderColor: colors.boneEdge,
    borderTopWidth: 1,
    borderLeftWidth: 1,
  },
  divider: { position: 'absolute', backgroundColor: colors.boneEdge },
  highlighted: { borderColor: colors.brass, borderTopWidth: 2, borderLeftWidth: 2 },
  dimmed: { opacity: 0.35 },
  pressed: { transform: [{ translateY: -3 }] },
});
