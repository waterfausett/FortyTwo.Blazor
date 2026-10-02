// One domino tile, drawn like the web's (apps/web/src/styles/domino.css): a bone tile twice as
// tall as it is wide, a divider across the middle, and each half's pips placed like a die face,
// coloured by count. Every pip is positioned absolutely from the centre of its half of the face,
// so the layout can't shift with rounding the way a wrapped grid of fractional cells does, and the
// offset shadow is a separate layer behind the face so it can't pull the pips off centre.
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

// Pip centres within one half, in units of a sixth of the face's width (a half is 6 x 6 units).
// Symmetric about the half's centre (3, 3), so the pips sit in the middle of the tile.
const COLS = [1.5, 3, 4.5];
const ROWS = [1.5, 3, 4.5];
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
  // The tile's short side: its width when vertical (its height is twice that); horizontal tiles
  // are twice as wide as they are tall. The offset shadow adds a little to both.
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
  const horizontal = direction === 'horizontal';
  // The bone face is `width` x 2*width (or turned) with no border of its own: its outline is a
  // separate overlay. A border on the face would shift where its absolutely positioned children
  // start, and platforms don't all agree on by how much - so the pips are placed against a
  // borderless face and are centred on what you see everywhere.
  const faceW = horizontal ? width * 2 : width;
  const faceH = horizontal ? width : width * 2;
  const inner = width;
  const unit = inner / 6;
  const pip = PIP_DIAMETER * unit;
  // The web tile's offset shadow: a second, darker tile behind the face, down and to the right.
  const edge = Math.max(1.5, width * 0.06);
  const radius = width * 0.13;

  // Lay pips out on the vertical tile (top half 0-6 units, bottom half 6-12), then turn the tile
  // a quarter clockwise for horizontal: the top half ends up on the right, as on the web.
  const innerLong = width * 2;
  const halfLong = innerLong / 2;
  // Measured from each half's centre, so both halves are centred exactly.
  const at = (p: { x: number; y: number }, halfCentre: number) => ({
    x: inner / 2 + (p.x - 3) * unit,
    y: halfCentre + (p.y - 3) * unit,
  });
  const pips = [
    ...pipCenters(top).map((p) => ({ ...at(p, halfLong / 2), value: top })),
    ...pipCenters(bottom).map((p) => ({ ...at(p, halfLong * 1.5), value: bottom })),
  ].map(({ x, y, value }, i) => {
    const cx = horizontal ? innerLong - y : x;
    const cy = horizontal ? x : y;
    return (
      <View
        key={i}
        style={{
          position: 'absolute',
          left: cx - pip / 2,
          top: cy - pip / 2,
          width: pip,
          height: pip,
          borderRadius: pip / 2,
          backgroundColor: PIP_COLORS[value],
        }}
      />
    );
  });

  const dividerThickness = Math.max(1, unit * 0.2);
  const tile = (
    <View style={[{ width: faceW + edge, height: faceH + edge }, dimmed && styles.dimmed]}>
      <View style={[styles.edge, { left: edge, top: edge, width: faceW, height: faceH, borderRadius: radius }]} />
      <View style={[styles.face, { width: faceW, height: faceH, borderRadius: radius }]}>
        <View
          style={[
            styles.divider,
            horizontal
              ? { left: halfLong - dividerThickness / 2, top: unit * 0.5, bottom: unit * 0.5, width: dividerThickness }
              : { top: halfLong - dividerThickness / 2, left: unit * 0.5, right: unit * 0.5, height: dividerThickness },
          ]}
        />
        {pips}
        <View
          pointerEvents="none"
          style={[styles.outline, { borderRadius: radius }, highlighted && styles.highlighted]}
        />
      </View>
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
  edge: { position: 'absolute', backgroundColor: colors.boneEdge },
  face: { position: 'absolute', left: 0, top: 0, backgroundColor: colors.bone },
  outline: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderWidth: 1, borderColor: colors.boneEdge },
  highlighted: { borderWidth: 2, borderColor: colors.brass },
  divider: { position: 'absolute', backgroundColor: colors.boneEdge },
  dimmed: { opacity: 0.35 },
  pressed: { transform: [{ translateY: -3 }] },
});
