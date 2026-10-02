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

  const unit = size / 6;
  const pip = unit * 1.2;
  return (
    <View style={face} accessible accessibilityLabel={label}>
      {pipCenters(suit).map(({ x, y }, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: x * unit - pip / 2,
            top: y * unit - pip / 2,
            width: pip,
            height: pip,
            borderRadius: pip / 2,
            backgroundColor: PIP_COLORS[suit],
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  face: { backgroundColor: colors.bone, borderWidth: 1, borderColor: colors.boneEdge },
  word: { alignItems: 'center', justifyContent: 'center' },
  wordText: { color: colors.walnutDeep, fontFamily: fonts.display },
});
