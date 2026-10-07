// Both teams' piles of taken tricks for the hand, side by side: each headed by the team's running
// points (out of the target, for the bidding team), then its tricks, newest first, each with the
// points it was worth. On big bids only the hand's last two tricks stay in view, like tricks
// stacked on a real table (the caller picks them: @fortytwo/client's teamTricksForDisplay).
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
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
  // Only the hand's last two tricks are in view - say so, so it's clear why the rest are gone.
  stacked: boolean;
}

// Keyed by the trick's dominoes: every domino is played once per hand, so they identify a trick.
function trickKey(trick: Trick): string {
  return trick.dominoes.map((d) => d?.id ?? 'x').join(',');
}

// Sizes a trick's four tiles to fill a pile's row beside the points label: the screen's padding
// (12 a side), the gap between piles (8), each pile's padding (8 a side), three gaps between tiles
// (3), the label (about 32), and each tile's shadow (about 2).
function tileWidthFor(windowWidth: number): number {
  const pileInner = (windowWidth - 24 - 8) / 2 - 16;
  return Math.max(14, Math.min(26, Math.floor((pileInner - 9 - 32) / 4 - 2)));
}

function Pile({ pile, tileWidth }: { pile: TeamPile; tileWidth: number }) {
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
              {trick.dominoes.map((d) => d && <Domino key={d.id} top={d.top} bottom={d.bottom} width={tileWidth} />)}
            </View>
            <Text style={styles.value}>+{trickValue(trick)}</Text>
          </View>
        ))
      )}
    </View>
  );
}

export function TrickHistory({ us, them, stacked }: TrickHistoryProps) {
  const tileWidth = tileWidthFor(useWindowDimensions().width);
  return (
    <View style={styles.history} accessibilityLabel="Tricks taken">
      <View style={styles.piles}>
        <Pile pile={us} tileWidth={tileWidth} />
        <Pile pile={them} tileWidth={tileWidth} />
      </View>
      {stacked && <Text style={styles.note}>Tricks are stacked: only the last two taken are shown</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  note: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 12, textAlign: 'center' },
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
});
