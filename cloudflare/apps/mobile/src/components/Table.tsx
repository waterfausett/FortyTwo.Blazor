// The table seen from the player's chair: the other three seats around the mat, the player at the
// bottom, and the trick in progress in the middle, each domino in front of whoever played it.
// Sized from the window width so it fills a phone screen.
import type { ReactNode } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { Seat } from '@fortytwo/client';
import type { Trick } from '@fortytwo/rules';
import { Domino } from './Domino';
import { colors, fonts } from './theme';

export interface SeatInfo {
  name: string;
  side: 'us' | 'them';
  isActive: boolean;
  isDealer: boolean;
  bid: string | null;
  // Shown while everyone readies up for the next hand; null otherwise.
  ready: boolean | null;
  // Dominoes left in hand; null for the player's own seat, whose hand is shown below the table.
  dominoCount: number | null;
}

export function SeatPlate({ info, width }: { info: SeatInfo | null; width: number }) {
  if (!info) {
    return (
      <View style={[styles.plate, styles.open, { width }]}>
        <Text style={styles.openText}>Open seat</Text>
      </View>
    );
  }
  const team = info.side === 'us' ? colors.us : colors.them;
  const details = [
    info.bid,
    info.dominoCount != null ? `${info.dominoCount} left` : null,
    info.ready == null ? null : info.ready ? 'Ready' : 'Not ready',
  ].filter(Boolean);
  return (
    <View
      style={[styles.plate, { width, borderColor: info.isActive ? colors.brass : team }, info.isActive && styles.active]}
      accessibilityLabel={`${info.name}${info.isActive ? ', to act' : ''}`}
    >
      <View style={styles.nameRow}>
        <View style={[styles.teamDot, { backgroundColor: team }]} />
        <Text style={styles.name} numberOfLines={1}>
          {info.name}
        </Text>
        {info.isDealer && (
          <View style={styles.dealer}>
            <Text style={styles.dealerText}>D</Text>
          </View>
        )}
      </View>
      <Text style={styles.detail} numberOfLines={1}>
        {details.length > 0 ? details.join(' · ') : ' '}
      </Text>
    </View>
  );
}

export interface TableProps {
  seats: Record<Seat, SeatInfo | null>;
  trick: Trick | null;
  // Which seat played each slot of `trick`.
  slotSeats: (Seat | null)[];
  winningSlot: number | null;
  // Shown in the middle instead of a trick, e.g. while waiting for players.
  center?: ReactNode;
}

export function Table({ seats, trick, slotSeats, winningSlot, center }: TableProps) {
  const window = useWindowDimensions();
  const width = Math.min(window.width - 24, 480);
  const sideWidth = Math.round(width * 0.27);
  const matWidth = width - sideWidth * 2 - 12;
  // Trick tiles: three stacked vertically must fit the mat's height, two across beside the middle.
  const tileWidth = Math.min(30, Math.floor(matWidth / 5));
  const matHeight = tileWidth * 2 * 3 + 24;

  const played: Partial<Record<Seat, { top: number; bottom: number; winning: boolean }>> = {};
  trick?.dominoes.forEach((domino, slot) => {
    const seat = slotSeats[slot];
    if (domino && seat) played[seat] = { top: domino.top, bottom: domino.bottom, winning: slot === winningSlot };
  });
  const tile = (seat: Seat) => {
    const d = played[seat];
    return (
      <View style={{ width: tileWidth + 4, height: tileWidth * 2 + 4, alignItems: 'center', justifyContent: 'center' }}>
        {d && <Domino top={d.top} bottom={d.bottom} width={tileWidth} highlighted={d.winning} />}
      </View>
    );
  };

  return (
    <View style={styles.table} accessibilityLabel="Table">
      <SeatPlate info={seats.top} width={sideWidth + 20} />
      <View style={styles.middle}>
        <SeatPlate info={seats.left} width={sideWidth} />
        <View style={[styles.mat, { width: matWidth, height: matHeight }]}>
          {center ?? (
            <>
              {tile('top')}
              <View style={styles.trickRow}>
                {tile('left')}
                {tile('right')}
              </View>
              {tile('bottom')}
            </>
          )}
        </View>
        <SeatPlate info={seats.right} width={sideWidth} />
      </View>
      <SeatPlate info={seats.bottom} width={sideWidth + 20} />
    </View>
  );
}

const styles = StyleSheet.create({
  table: { alignItems: 'center', gap: 8 },
  middle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  mat: {
    borderRadius: 14,
    backgroundColor: colors.mat,
    borderWidth: 2,
    borderColor: colors.matLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trickRow: { flexDirection: 'row', justifyContent: 'space-around', width: '100%' },
  plate: {
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderRadius: 8,
    borderWidth: 2,
    backgroundColor: 'rgba(20, 13, 9, 0.55)',
  },
  active: { backgroundColor: 'rgba(201, 164, 92, 0.18)' },
  open: { borderColor: colors.inkMuted, borderStyle: 'dashed', alignItems: 'center' },
  openText: { color: colors.inkMuted, fontFamily: fonts.ui },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  teamDot: { width: 8, height: 8, borderRadius: 4 },
  name: { flex: 1, color: colors.bone, fontFamily: fonts.uiBold, fontSize: 14 },
  dealer: { backgroundColor: colors.brass, borderRadius: 8, width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
  dealerText: { color: colors.walnutDeep, fontFamily: fonts.uiBold, fontSize: 10 },
  detail: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 12 },
});
