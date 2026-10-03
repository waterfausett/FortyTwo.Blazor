// A single domino half standing in for a suit, as on the web (apps/web/src/components/PipFace.tsx):
// shows trump at a glance on the bidder's seat, the scoreboard and the trump picker. Follow Me
// (Suit.None) and Low have no pip count, so they show a short word on the same tile instead.
import { StyleSheet, Text, View } from 'react-native';
import { Suit, isLow, suitToPrettyString } from '@fortytwo/rules';
import { PIP_COLORS, pipCenters } from './Domino';
import { colors, fonts } from './theme';

export function PipFace({ suit, size = 26 }: { suit: Suit; size?: number }) {
  const label = suitToPrettyString(suit);
  const face = [styles.face, { width: size, height: size, borderRadius: size * 0.18 }];

  if (suit === Suit.None || isLow(suit)) {
    return (
      <View style={[face, styles.word]} accessible accessibilityLabel={label}>
        <Text style={[styles.wordText, { fontSize: size * 0.42 }]} maxFontSizeMultiplier={1}>
          {suit === Suit.None ? 'FM' : 'Lo'}
        </Text>
      </View>
    );
  }

  // Placed from the face's centre, on a face with no border of its own (the outline is drawn over
  // it), so the pips sit dead centre - a border would shift where they start, as with the tiles.
  const unit = size / 6;
  const pip = unit * 1.2;
  return (
    <View style={face} accessible accessibilityLabel={label}>
      {pipCenters(suit).map(({ x, y }, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: size / 2 + (x - 3) * unit - pip / 2,
            top: size / 2 + (y - 3) * unit - pip / 2,
            width: pip,
            height: pip,
            borderRadius: pip / 2,
            backgroundColor: PIP_COLORS[suit],
          }}
        />
      ))}
      <View pointerEvents="none" style={[styles.outline, { borderRadius: size * 0.18 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  face: { backgroundColor: colors.bone },
  outline: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderWidth: 1, borderColor: colors.boneEdge },
  word: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.boneEdge },
  wordText: { color: colors.walnutDeep, fontFamily: fonts.display },
});
