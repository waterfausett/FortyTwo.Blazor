// The bids this player may legally make right now (`availableBids` in the rules package: Pass
// unless forced to bid, only bids above the current high bid, marks one rung at a time, and Plunge
// only with four doubles).
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Bid, availableBids, bidToPrettyString, type Game } from '@fortytwo/rules';
import { colors, fonts } from './theme';

export interface BiddingPanelProps {
  game: Game;
  myPlayerId: string;
  onBid: (bid: Bid) => void;
  disabled?: boolean;
}

export function BiddingPanel({ game, myPlayerId, onBid, disabled = false }: BiddingPanelProps) {
  const bids = availableBids(game, myPlayerId);
  return (
    <View style={styles.panel} accessibilityLabel="Bidding">
      <Text style={styles.prompt}>Select a bid</Text>
      <View style={styles.options}>
        {bids.map((bid) => (
          <Pressable
            key={bid}
            style={[styles.option, bid === Bid.Pass && styles.pass, disabled && styles.disabled]}
            disabled={disabled}
            onPress={() => onBid(bid)}
            accessibilityRole="button"
          >
            <Text style={bid === Bid.Pass ? styles.passText : styles.optionText}>{bidToPrettyString(bid)}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export const pickerStyles = StyleSheet.create({
  panel: { gap: 10, padding: 12, borderRadius: 10, backgroundColor: 'rgba(20, 13, 9, 0.45)' },
  prompt: { color: colors.bone, fontFamily: fonts.display, fontSize: 18 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  option: {
    minWidth: 58,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.bone,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderColor: colors.boneEdge,
    alignItems: 'center',
  },
  optionText: { color: colors.ink, fontFamily: fonts.uiBold, fontSize: 16 },
  optionDetail: { color: colors.ink, fontFamily: fonts.ui, fontSize: 12, textAlign: 'center' },
  disabled: { opacity: 0.5 },
});

const styles = StyleSheet.create({
  ...pickerStyles,
  pass: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.inkMuted },
  passText: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
});
