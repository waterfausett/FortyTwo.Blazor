// Picking a seat when joining a match: the table from above, with each taken seat's name and a
// button in each open one. Seat 0 (the creator's) is nearest, then clockwise in turn order - the
// layout the match screen uses. An open seat says who you'd partner with (the seat across), since
// that's what picking a seat really decides.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { NameSkeleton } from './NameSkeleton';
import { colors, fonts } from './theme';

export interface SeatPickerProps {
  // The display name at each position 0-3, or null for an open seat (MatchSummary.seats).
  seats: (string | null)[];
  // The taken seats' names are still loading (a match opened from an invite).
  loading?: boolean;
  disabled: boolean;
  onPick: (position: number) => void;
}

export function SeatPicker({ seats, loading = false, disabled, onPick }: SeatPickerProps) {
  const seat = (position: number) => {
    const name = seats[position];
    if (name != null) {
      return (
        <View style={[styles.seat, styles.taken]}>
          {loading ? (
            <NameSkeleton width={64} />
          ) : (
            <Text style={styles.takenText} numberOfLines={1}>
              {name}
            </Text>
          )}
        </View>
      );
    }
    const partner = seats[(position + 2) % 4];
    return (
      <Pressable
        style={[styles.seat, styles.open, disabled && styles.disabled]}
        disabled={disabled}
        onPress={() => onPick(position)}
        accessibilityRole="button"
        accessibilityLabel={`Sit here${partner != null && !loading ? `, with ${partner}` : ''}`}
      >
        <Text style={styles.openText}>Sit here</Text>
        {partner != null && loading ? (
          <NameSkeleton width={48} />
        ) : (
          <Text style={styles.hint} numberOfLines={1}>
            {partner != null ? `with ${partner}` : 'open seat'}
          </Text>
        )}
      </Pressable>
    );
  };

  return (
    <View style={styles.picker} accessibilityLabel="Pick a seat">
      {seat(2)}
      <View style={styles.row}>
        {seat(1)}
        <View style={styles.table} />
        {seat(3)}
      </View>
      {seat(0)}
    </View>
  );
}

const styles = StyleSheet.create({
  picker: { alignItems: 'center', gap: 6, paddingVertical: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  table: { width: 70, height: 70, borderRadius: 10, backgroundColor: colors.mat, borderWidth: 2, borderColor: colors.matLight },
  seat: { width: 100, paddingVertical: 6, paddingHorizontal: 4, borderRadius: 8, alignItems: 'center' },
  taken: { borderWidth: 1, borderColor: colors.inkMuted },
  takenText: { color: colors.inkMuted, fontFamily: fonts.ui },
  open: { backgroundColor: colors.brass },
  openText: { color: colors.walnutDeep, fontFamily: fonts.uiBold },
  hint: { color: colors.walnutDeep, fontFamily: fonts.ui, fontSize: 11 },
  disabled: { opacity: 0.5 },
});
