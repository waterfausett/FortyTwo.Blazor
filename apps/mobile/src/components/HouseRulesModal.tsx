// The house rules a Custom Match plays by, opened from the match screen's header (HouseRulesButton)
// in place of a line of labels on the scoreboard. Every setting, with the ones that differ from a
// standard table in brass.
import { MaterialIcons } from '@expo/vector-icons';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { houseRuleRows } from '@fortytwo/client';
import type { HouseRules } from '@fortytwo/rules';
import { colors, fonts } from './theme';

// A round button for the header, ringed like the "?" beside it.
export function HouseRulesButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="House rules"
      hitSlop={8}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <MaterialIcons name="rule" size={18} color={colors.bone} />
    </Pressable>
  );
}

export function HouseRulesModal({ rules, visible, onClose }: {
  rules: Partial<HouseRules> | undefined;
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
        {/* Taps on the card itself don't close it. */}
        <Pressable style={styles.panel} onPress={() => {}} accessible={false}>
          <View style={styles.header}>
            <Text style={styles.title} accessibilityRole="header">House rules</Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={12}>
              <Text style={styles.close}>×</Text>
            </Pressable>
          </View>
          <View>
            {houseRuleRows(rules).map((row, i) => (
              <View
                key={row.label}
                style={[styles.row, i > 0 && styles.divider]}
                accessibilityLabel={`${row.label}: ${row.value}${row.custom ? ', house rule' : ''}`}
              >
                <Text style={styles.label}>{row.label}</Text>
                <Text style={[styles.value, row.custom && styles.valueCustom]}>{row.value}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.note}>
            <Text style={styles.valueCustom}>Highlighted</Text> settings differ from a standard table
          </Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
  backdrop: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: 'rgba(0, 0, 0, 0.6)' },
  panel: { gap: 12, padding: 20, borderRadius: 12, backgroundColor: colors.walnutDeep },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.bone, fontFamily: fonts.display, fontSize: 20 },
  close: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 28, lineHeight: 28 },
  row: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, paddingVertical: 12 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.boneEdge },
  label: { flexShrink: 1, color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 15 },
  value: { flexShrink: 1, color: colors.bone, fontFamily: fonts.uiMedium, fontSize: 15, textAlign: 'right' },
  valueCustom: { color: colors.brass, fontFamily: fonts.uiBold },
  note: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 12 },
});
