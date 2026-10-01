// The bids this player may legally make right now (`availableBids` in the rules package: Pass
// unless forced to bid, only bids above the current high bid, marks one rung at a time, and Plunge
// only with four doubles).
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Bid, availableBids, bidToPrettyString, type Game } from '@fortytwo/rules';
import { colors } from './theme';

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
  panel: { gap: 8 },
  prompt: { fontSize: 16, fontWeight: '700' },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: {
    minWidth: 56,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 6,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  optionText: { color: 'white', fontWeight: '600' },
  disabled: { opacity: 0.5 },
});

const styles = StyleSheet.create({
  ...pickerStyles,
  pass: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.primary },
  passText: { color: colors.primary, fontWeight: '600' },
});
