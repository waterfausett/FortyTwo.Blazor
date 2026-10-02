// The bidder's trump picker: every trump `availableTrumps` allows, with the three Low variants
// folded into one "Low" choice that then asks how doubles behave for the hand.
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { LOW_TRUMPS, Suit, availableTrumps, isLow, lowDoublesToPrettyString, suitToPrettyString, type Game } from '@fortytwo/rules';
import { StyleSheet } from 'react-native';
import { pickerStyles } from './BiddingPanel';
import { colors, fonts } from './theme';

const DOUBLES_DETAIL: Record<(typeof LOW_TRUMPS)[number], string> = {
  [Suit.Low]: 'Each double tops its suit',
  [Suit.LowDoublesLow]: 'Each double is the lowest of its suit',
  [Suit.LowDoublesOwnSuit]: 'Doubles form a suit, double-six highest',
};

export interface TrumpPickerProps {
  game: Game;
  onSelect: (suit: Suit) => void;
  disabled?: boolean;
}

export function TrumpPicker({ game, onSelect, disabled = false }: TrumpPickerProps) {
  const [choosingDoubles, setChoosingDoubles] = useState(false);
  const trumps = availableTrumps(game);
  const lowTrumps = trumps.filter(isLow);

  if (choosingDoubles) {
    return (
      <View style={styles.panel} accessibilityLabel="Select trump">
        <Text style={styles.prompt}>Low: how do doubles play?</Text>
        <View style={styles.options}>
          {lowTrumps.map((suit) => (
            <Pressable
              key={suit}
              style={[styles.option, { width: '100%' }, disabled && styles.disabled]}
              disabled={disabled}
              onPress={() => onSelect(suit)}
              accessibilityRole="button"
            >
              <Text style={styles.optionText}>Doubles {lowDoublesToPrettyString(suit)}</Text>
              <Text style={styles.optionDetail}>
                {DOUBLES_DETAIL[suit as (typeof LOW_TRUMPS)[number]]}
              </Text>
            </Pressable>
          ))}
          <Pressable style={[styles.option, styles.back]} onPress={() => setChoosingDoubles(false)} accessibilityRole="button">
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.panel} accessibilityLabel="Select trump">
      <Text style={styles.prompt}>Select a trump</Text>
      <View style={styles.options}>
        {trumps
          .filter((suit) => !isLow(suit))
          .map((suit) => (
            <Pressable
              key={suit}
              style={[styles.option, disabled && styles.disabled]}
              disabled={disabled}
              onPress={() => onSelect(suit)}
              accessibilityRole="button"
            >
              <Text style={styles.optionText}>{suitToPrettyString(suit)}</Text>
            </Pressable>
          ))}
        {lowTrumps.length > 0 && (
          <Pressable
            style={[styles.option, disabled && styles.disabled]}
            disabled={disabled}
            onPress={() => setChoosingDoubles(true)}
            accessibilityRole="button"
          >
            <Text style={styles.optionText}>Low</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  ...pickerStyles,
  back: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.inkMuted },
  backText: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
});
