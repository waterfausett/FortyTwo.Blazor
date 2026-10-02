// Both teams' piles of taken tricks for the hand, side by side: each headed by the team's running
// points (out of the target, for the bidding team), then its tricks, newest first, each with the
// points it was worth.
import { StyleSheet, Text, View } from 'react-native';
import { trickValue, type Trick } from '@fortytwo/rules';
import { Domino } from './Domino';
import { colors, fonts } from './theme';

export interface TeamPile {
  label: string;
  color: string;
  tricks: Trick[];
  points: number;
  // The points this team needs to make its bid, when it's the bidding team.
  target: number | null;
}

export interface TrickHistoryProps {
  us: TeamPile;
  them: TeamPile;
  // Only each team's last two tricks are shown (see @fortytwo/client's shouldStackTricks).
  stacked: boolean;
}

// Keyed by the trick's dominoes: every domino is played once per hand, so they identify a trick.
function trickKey(trick: Trick): string {
  return trick.dominoes.map((d) => d?.id ?? 'x').join(',');
}

function Pile({ pile }: { pile: TeamPile }) {
  const newestFirst = [...pile.tricks].reverse();
  return (
    <View style={styles.pile} accessibilityLabel={`${pile.label} tricks: ${pile.points} points`}>
      <View style={[styles.header, { borderColor: pile.color }]}>
        <Text style={[styles.label, { color: pile.color }]}>{pile.label}</Text>
        <Text style={styles.points}>
          {pile.points}
          <Text style={styles.target}>{pile.target != null ? ` of ${pile.target}` : ' pts'}</Text>
        </Text>
      </View>
      {newestFirst.length === 0 ? (
        <Text style={styles.empty}>No tricks yet</Text>
      ) : (
        newestFirst.map((trick) => (
          <View key={trickKey(trick)} style={styles.row}>
            <View style={styles.dominoes}>
              {trick.dominoes.map((d) => d && <Domino key={d.id} top={d.top} bottom={d.bottom} width={14} />)}
            </View>
            <Text style={styles.value}>+{trickValue(trick)}</Text>
          </View>
        ))
      )}
    </View>
  );
}

export function TrickHistory({ us, them, stacked }: TrickHistoryProps) {
  return (
    <View style={styles.history} accessibilityLabel="Tricks taken">
      <View style={styles.piles}>
        <Pile pile={us} />
        <Pile pile={them} />
      </View>
      {stacked && <Text style={styles.note}>Showing each side's last two tricks</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  history: { gap: 6 },
  piles: { flexDirection: 'row', gap: 8 },
  pile: { flex: 1, gap: 6, padding: 8, borderRadius: 10, backgroundColor: 'rgba(20, 13, 9, 0.45)' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', borderBottomWidth: 1, paddingBottom: 4 },
  label: { fontFamily: fonts.uiBold, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
  points: { color: colors.bone, fontFamily: fonts.display, fontSize: 20 },
  target: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  empty: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 12 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dominoes: { flexDirection: 'row', gap: 3 },
  value: { color: colors.inkMuted, fontFamily: fonts.uiMedium, fontSize: 12 },
  note: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 12, textAlign: 'center' },
});
