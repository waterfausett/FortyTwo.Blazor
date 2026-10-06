// How doubles play under the hand's Low trump, opened from the scoreboard's short "doubles: ..."
// label. The three rules as the trump picker shows them, with the one in play picked out.
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { LOW_TRUMPS, lowDoublesToPrettyString, type Suit } from '@fortytwo/rules';
import { pickerStyles } from './BiddingPanel';
import { colors, fonts } from './theme';
import { DOUBLES_DETAIL } from './TrumpPicker';

export interface DoublesRuleModalProps {
  trump: Suit | null;
  onClose: () => void;
}

export function DoublesRuleModal({ trump, onClose }: DoublesRuleModalProps) {
  return (
    <Modal visible={trump != null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
        {/* Taps on the card itself don't close it. */}
        <Pressable style={styles.panel} onPress={() => {}} accessible={false}>
          <View style={styles.header}>
            <Text style={styles.prompt} accessibilityRole="header">
              Low: how doubles play
            </Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={12}>
              <Text style={styles.close}>×</Text>
            </Pressable>
          </View>
          {LOW_TRUMPS.map((suit) => {
            const inPlay = suit === trump;
            return (
              <View
                key={suit}
                style={[styles.option, styles.rule, inPlay ? styles.inPlay : styles.notInPlay]}
                accessibilityLabel={`${inPlay ? 'In play: ' : ''}Doubles ${lowDoublesToPrettyString(suit)}. ${DOUBLES_DETAIL[suit]}`}
              >
                <Text style={styles.optionText}>
                  Doubles {lowDoublesToPrettyString(suit)}
                  {inPlay && <Text style={styles.inPlayTag}> · this hand</Text>}
                </Text>
                <Text style={styles.optionDetail}>{DOUBLES_DETAIL[suit]}</Text>
              </View>
            );
          })}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  ...pickerStyles,
  backdrop: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: 'rgba(0, 0, 0, 0.6)' },
  panel: { gap: 10, padding: 16, borderRadius: 10, backgroundColor: colors.walnutDeep },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  close: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 28, lineHeight: 28 },
  rule: { width: '100%' },
  inPlay: { borderWidth: 2, borderColor: colors.brass },
  notInPlay: { opacity: 0.55 },
  inPlayTag: { fontFamily: fonts.ui, fontSize: 13 },
});
