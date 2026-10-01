// The table seen from the player's chair: the other three seats around the felt, the player at
// the bottom, and the trick in progress in the middle, each domino in front of whoever played it.
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Seat } from '@fortytwo/client';
import type { Trick } from '@fortytwo/rules';
import { Domino } from './Domino';
import { colors } from './theme';

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

export function SeatPlate({ info }: { info: SeatInfo | null }) {
  if (!info) {
    return (
      <View style={[styles.plate, styles.open]}>
        <Text style={styles.openText}>Open seat</Text>
      </View>
    );
  }
  return (
    <View
      style={[styles.plate, { borderColor: info.side === 'us' ? colors.us : colors.them }, info.isActive && styles.active]}
      accessibilityLabel={`${info.name}${info.isActive ? ', to act' : ''}`}
    >
      <Text style={styles.name} numberOfLines={1}>
        {info.name}
        {info.isDealer ? ' · D' : ''}
      </Text>
      <Text style={styles.detail} numberOfLines={1}>
        {[
          info.bid,
          info.dominoCount != null ? `${info.dominoCount} left` : null,
          info.ready == null ? null : info.ready ? 'Ready' : 'Not ready',
        ]
          .filter(Boolean)
          .join(' · ') || ' '}
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
  const played: Partial<Record<Seat, { top: number; bottom: number; winning: boolean }>> = {};
  trick?.dominoes.forEach((domino, slot) => {
    const seat = slotSeats[slot];
    if (domino && seat) played[seat] = { top: domino.top, bottom: domino.bottom, winning: slot === winningSlot };
  });
  const tile = (seat: Seat) => {
    const d = played[seat];
    return (
      <View style={styles.slot}>
        {d && <Domino top={d.top} bottom={d.bottom} size={18} highlighted={d.winning} />}
      </View>
    );
  };

  return (
    <View style={styles.table} accessibilityLabel="Table">
      <SeatPlate info={seats.top} />
      <View style={styles.middle}>
        <SeatPlate info={seats.left} />
        <View style={styles.felt}>
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
        <SeatPlate info={seats.right} />
      </View>
      <SeatPlate info={seats.bottom} />
    </View>
  );
}

const styles = StyleSheet.create({
  table: { alignItems: 'center', gap: 6 },
  middle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  felt: {
    width: 170,
    height: 190,
    borderRadius: 12,
    backgroundColor: colors.felt,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 6,
  },
  trickRow: { flexDirection: 'row', justifyContent: 'space-between', width: '100%' },
  slot: { minWidth: 22, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  plate: {
    width: 92,
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: 6,
    borderWidth: 2,
    backgroundColor: 'white',
    alignItems: 'center',
  },
  active: { backgroundColor: '#fff4cc' },
  open: { borderColor: colors.border, borderStyle: 'dashed' },
  openText: { color: colors.muted },
  name: { fontWeight: '700', fontSize: 13 },
  detail: { fontSize: 11, color: colors.muted },
});
