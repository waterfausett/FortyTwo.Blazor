// The bidder's trump picker: every trump `availableTrumps` allows, with the three Low variants
// folded into one "Low" choice that then asks how doubles behave for the hand.
import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { LOW_TRUMPS, Suit, availableTrumps, isLow, lowDoublesToPrettyString, suitToPrettyString, type Game } from '@fortytwo/rules';
import { StyleSheet } from 'react-native';
import { DOUBLES_DETAIL } from '@fortytwo/client';
import { pickerStyles } from './BiddingPanel';
import { PipFace } from './PipFace';
import { colors, fonts } from './theme';

export interface TrumpPickerProps {
  game: Game;
  onSelect: (suit: Suit) => void;
  disabled?: boolean;
  // The trump a hint suggests, ringed (on the Low choice for any Low variant).
  suggested?: Suit | null;
  // Shown beside the prompt: the Hint button, or its answer.
  hint?: ReactNode;
}

export function TrumpPicker({ game, onSelect, disabled = false, suggested = null, hint = null }: TrumpPickerProps) {
  const [choosingDoubles, setChoosingDoubles] = useState(false);
  const trumps = availableTrumps(game);
  const lowTrumps = trumps.filter(isLow);

  if (choosingDoubles) {
    return (
      <View style={styles.panel} accessibilityLabel="Select trump">
        <View style={styles.promptRow}>
          <Text style={styles.prompt}>Low: how do doubles play?</Text>
          {hint}
        </View>
        <View style={styles.options}>
          {lowTrumps.map((suit) => (
            <Pressable
              key={suit}
              style={[styles.option, { width: '100%' }, suit === suggested && styles.suggested, disabled && styles.disabled]}
              disabled={disabled}
              onPress={() => onSelect(suit)}
              accessibilityRole="button"
              accessibilityLabel={suit === suggested ? `Doubles ${lowDoublesToPrettyString(suit)}, suggested` : undefined}
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
      <View style={styles.promptRow}>
        <Text style={styles.prompt}>Select a trump</Text>
        {hint}
      </View>
      <View style={styles.options}>
        {trumps
          .filter((suit) => !isLow(suit))
          .map((suit) => (
            <Pressable
              key={suit}
              style={[styles.option, suit === suggested && styles.suggested, disabled && styles.disabled]}
              disabled={disabled}
              onPress={() => onSelect(suit)}
              accessibilityRole="button"
              accessibilityLabel={suit === suggested ? `${suitToPrettyString(suit)}, suggested` : undefined}
            >
              <View style={styles.trumpOption}>
                <PipFace suit={suit} size={22} />
                <Text style={styles.optionText}>{suitToPrettyString(suit)}</Text>
              </View>
            </Pressable>
          ))}
        {lowTrumps.length > 0 && (
          <Pressable
            style={[styles.option, suggested !== null && isLow(suggested) && styles.suggested, disabled && styles.disabled]}
            disabled={disabled}
            onPress={() => setChoosingDoubles(true)}
            accessibilityRole="button"
            accessibilityLabel={suggested !== null && isLow(suggested) ? 'Low, suggested' : undefined}
          >
            <View style={styles.trumpOption}>
              <PipFace suit={Suit.Low} size={22} />
              <Text style={styles.optionText}>Low</Text>
            </View>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  ...pickerStyles,
  trumpOption: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  back: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.inkMuted },
  backText: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
});
