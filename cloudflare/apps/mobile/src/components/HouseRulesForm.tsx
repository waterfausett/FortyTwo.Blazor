// The house rules a Custom Match's creator picks (NewMatchSheet's second step). Controlled: every
// change goes through setHouseRule, which keeps the combination valid.
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { MAX_MARKS_TO_WIN, MIN_MARKS_TO_WIN, type AllPassRule, type HouseRules, type LowRule } from '@fortytwo/rules';
import { setHouseRule } from '@fortytwo/client';
import { colors, fonts } from '@/components/theme';

const LOW_OPTIONS: { value: LowRule; label: string }[] = [
  { value: 'forcedOnly', label: 'Forced bid only' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];
const ALL_PASS_OPTIONS: { value: AllPassRule; label: string }[] = [
  { value: 'forceLast', label: 'Last player must bid' },
  { value: 'redeal', label: 'Reshuffle' },
];
const NO_FORCED_BID = 'Some options are\'t available when forced bidding is disabled.';

function Segment<T extends string>({ options, value, onPick, unavailable, disabled }: {
  options: { value: T; label: string }[];
  value: T;
  onPick: (value: T) => void;
  // Why an option can't be picked right now, or undefined when it can.
  unavailable?: (value: T) => string | undefined;
  disabled: boolean;
}) {
  return (
    <View style={styles.segment}>
      {options.map((o) => {
        const why = unavailable?.(o.value);
        const off = disabled || why !== undefined;
        const selected = value === o.value;
        return (
          <Pressable
            key={o.value}
            style={[styles.segmentItem, selected && styles.segmentSelected, off && styles.dim]}
            disabled={off}
            onPress={() => onPick(o.value)}
            accessibilityRole="radio"
            accessibilityLabel={o.label}
            accessibilityHint={why}
            accessibilityState={{ selected, disabled: off }}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function HouseRulesForm({ rules, onChange, disabled = false }: {
  rules: HouseRules;
  onChange: (rules: HouseRules) => void;
  disabled?: boolean;
}) {
  const change = (patch: Partial<HouseRules>) => onChange(setHouseRule(rules, patch));
  const redeal = rules.allPass === 'redeal';
  return (
    <View style={styles.form}>
      <View style={styles.row}>
        <Text style={styles.label}>Allow Plunge</Text>
        <Switch value={rules.plunge} onValueChange={(plunge) => change({ plunge })} disabled={disabled}
          accessibilityLabel="Allow Plunge" />
      </View>

      <Text style={styles.label}>Low</Text>
      <Segment options={LOW_OPTIONS} value={rules.low} onPick={(low) => change({ low })}
        unavailable={(v) => (v === 'forcedOnly' && redeal ? NO_FORCED_BID : undefined)} disabled={disabled} />
      {redeal && <Text style={styles.note}>{NO_FORCED_BID}</Text>}

      <Text style={styles.label}>When everyone passes</Text>
      <Segment options={ALL_PASS_OPTIONS} value={rules.allPass} onPick={(allPass) => change({ allPass })} disabled={disabled} />

      <View style={styles.row}>
        <Text style={styles.label}>Marks to win</Text>
        <View style={styles.stepper}>
          <Pressable style={[styles.step, (disabled || rules.marksToWin <= MIN_MARKS_TO_WIN) && styles.dim]}
            disabled={disabled || rules.marksToWin <= MIN_MARKS_TO_WIN}
            onPress={() => change({ marksToWin: rules.marksToWin - 1 })}
            accessibilityRole="button" accessibilityLabel="Fewer marks">
            <Text style={styles.stepText}>−</Text>
          </Pressable>
          <Text style={styles.marks}>{rules.marksToWin}</Text>
          <Pressable style={[styles.step, (disabled || rules.marksToWin >= MAX_MARKS_TO_WIN) && styles.dim]}
            disabled={disabled || rules.marksToWin >= MAX_MARKS_TO_WIN}
            onPress={() => change({ marksToWin: rules.marksToWin + 1 })}
            accessibilityRole="button" accessibilityLabel="More marks">
            <Text style={styles.stepText}>+</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 10 },
  label: { color: colors.inkMuted, fontFamily: fonts.uiBold, fontSize: 12, letterSpacing: 1 },
  note: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  segment: { flexDirection: 'row', borderRadius: 14, backgroundColor: colors.mat, padding: 4, gap: 4 },
  segmentItem: { flex: 1, paddingVertical: 10, paddingHorizontal: 6, borderRadius: 10, alignItems: 'center' },
  segmentSelected: { backgroundColor: colors.brass },
  segmentText: { color: colors.bone, fontFamily: fonts.uiMedium, fontSize: 14, textAlign: 'center' },
  segmentTextSelected: { color: colors.walnutDeep, fontFamily: fonts.uiBold },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  step: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.brass, alignItems: 'center', justifyContent: 'center' },
  stepText: { color: colors.walnutDeep, fontFamily: fonts.uiBold, fontSize: 18, top: -1 },
  marks: { minWidth: 28, textAlign: 'center', color: colors.bone, fontFamily: fonts.uiBold, fontSize: 18 },
  dim: { opacity: 0.6 },
});
