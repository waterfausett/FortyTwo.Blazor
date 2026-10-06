// What someone who isn't seated sees on a match - typically arriving from an invite link: the
// table with its open seats to pick from, or word that the match is full.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SeatPicker } from './SeatPicker';
import { colors, fonts } from './theme';

export interface JoinMatchPanelProps {
  // The display name at each position 0-3, or null for an open seat.
  seats: (string | null)[];
  // The taken seats' names are still loading.
  loading?: boolean;
  joining: boolean;
  onPick: (position: number) => void;
  onLobby: () => void;
}

export function JoinMatchPanel({ seats, loading, joining, onPick, onLobby }: JoinMatchPanelProps) {
  const open = seats.some((name) => name == null);
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>{open ? 'Pick a seat to join' : 'This match is full'}</Text>
      {open ? (
        <SeatPicker seats={seats} loading={loading} disabled={joining} onPick={onPick} />
      ) : (
        <Text style={styles.text}>All four seats are taken.</Text>
      )}
      <Pressable style={styles.link} onPress={onLobby} accessibilityRole="button">
        <Text style={styles.linkText}>Back to matches</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, gap: 16, padding: 16, justifyContent: 'center', backgroundColor: colors.walnut },
  title: { color: colors.bone, fontFamily: fonts.display, fontSize: 22, textAlign: 'center' },
  text: { color: colors.inkMuted, fontFamily: fonts.ui, textAlign: 'center' },
  link: { alignSelf: 'center', padding: 8 },
  linkText: { color: colors.brass, fontFamily: fonts.uiBold },
});
