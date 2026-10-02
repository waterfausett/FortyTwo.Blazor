// The table seen from the player's chair: the other three seats around the mat, the player at the
// bottom, and the trick in progress in the middle, each domino in front of whoever played it.
// Sized from the window width so it fills a phone screen.
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Animated, Easing, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { Seat } from '@fortytwo/client';
import type { Trick } from '@fortytwo/rules';
import { Domino } from './Domino';
import { colors, fonts } from './theme';
import { TRICK_SWEEP_MS } from '@/match/useTrickHold';

// Roughly how tall a seat plate is (two lines of text and padding), for aiming the sweep at it.
const PLATE_HEIGHT = 46;
const GAP = 6;

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

interface Point {
  x: number;
  y: number;
}

interface PlayedTile {
  top: number;
  bottom: number;
  winning: boolean;
  lead: boolean;
}

// The sweep runs a little shorter than the hold's sweeping window, so the trick has fully faded
// before it's taken off the table - a hold timer and an animation started from it don't finish in
// step on a device.
const SWEEP_ANIMATION_MS = TRICK_SWEEP_MS - 120;

function trickKey(trick: Trick): string {
  return trick.dominoes.map((d) => d?.id ?? 'x').join(',');
}

// One trick's tiles, in front of whoever played each, and their sweep toward `target` (the
// winner's seat) once it's set.
function TrickTiles({
  played,
  tileWidth,
  rowHeight,
  slotCentre,
  target,
}: {
  played: Partial<Record<Seat, PlayedTile>>;
  tileWidth: number;
  rowHeight: number;
  slotCentre: Record<Seat, Point>;
  target: Point | null;
}) {
  const sweep = useRef(new Animated.Value(0)).current;
  const sweeping = target != null;
  useEffect(() => {
    if (!sweeping) return;
    Animated.timing(sweep, {
      toValue: 1,
      duration: SWEEP_ANIMATION_MS,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [sweeping, sweep]);

  const tile = (seat: Seat) => {
    const d = played[seat];
    const from = slotCentre[seat];
    const sweepStyle =
      d && target
        ? {
            // Fades the whole way, so it's gone by the time it reaches the seat.
            opacity: sweep.interpolate({ inputRange: [0, 0.3, 1], outputRange: [1, 0.9, 0] }),
            transform: [
              { translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [0, target.x - from.x] }) },
              { translateY: sweep.interpolate({ inputRange: [0, 1], outputRange: [0, target.y - from.y] }) },
              { scale: sweep.interpolate({ inputRange: [0, 1], outputRange: [1, 0.45] }) },
            ],
          }
        : null;
    return (
      <Animated.View
        style={[{ width: tileWidth + 4, height: rowHeight, alignItems: 'center', justifyContent: 'center' }, sweepStyle]}
      >
        {d && <Domino top={d.top} bottom={d.bottom} width={tileWidth} highlighted={d.winning} />}
        {d?.lead && (
          <View style={styles.leadTag}>
            {/* A tag on a small tile: kept from growing with the system font size. */}
            <Text style={styles.leadText} maxFontSizeMultiplier={1}>
              Lead
            </Text>
          </View>
        )}
      </Animated.View>
    );
  };

  return (
    <>
      {tile('top')}
      <View style={styles.trickRow}>
        {tile('left')}
        {tile('right')}
      </View>
      {tile('bottom')}
    </>
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
  // The mat is where a dragged domino is dropped to play it: `dropRef` is measured for that, and
  // `dropActive` lights the mat while a domino is over it. Only the mat, not the seat plates, so a
  // short drag up from the hand over the player's own plate doesn't play anything.
  dropRef?: RefObject<View | null>;
  dropActive?: boolean;
  // While set, the trick leaves the table toward this seat: whoever won it.
  sweepTo?: Seat | null;
}

export function Table({
  seats,
  trick,
  slotSeats,
  winningSlot,
  center,
  dropRef,
  dropActive = false,
  sweepTo = null,
}: TableProps) {
  const window = useWindowDimensions();
  const width = Math.min(window.width - 24, 480);
  const sideWidth = Math.round(width * 0.27);
  const matWidth = width - sideWidth * 2 - 12;
  // Trick tiles: three stacked vertically must fit the mat's height, two across beside the middle.
  const tileWidth = Math.min(30, Math.floor(matWidth / 5));
  const matHeight = tileWidth * 2 * 3 + 24;
  const rowHeight = tileWidth * 2 + 4;

  // Centres relative to the mat's centre: each slot's tile, and each seat's plate.
  const slotCentre: Record<Seat, Point> = {
    top: { x: 0, y: -rowHeight },
    bottom: { x: 0, y: rowHeight },
    left: { x: -matWidth / 4, y: 0 },
    right: { x: matWidth / 4, y: 0 },
  };
  const seatCentre: Record<Seat, Point> = {
    top: { x: 0, y: -(matHeight / 2 + GAP + PLATE_HEIGHT / 2) },
    bottom: { x: 0, y: matHeight / 2 + GAP + PLATE_HEIGHT / 2 },
    left: { x: -(matWidth / 2 + GAP + sideWidth / 2), y: 0 },
    right: { x: matWidth / 2 + GAP + sideWidth / 2, y: 0 },
  };

  const played: Partial<Record<Seat, PlayedTile>> = {};
  trick?.dominoes.forEach((domino, slot) => {
    const seat = slotSeats[slot];
    // Slot 0 is always the leader's (trickPlayOrder starts from them).
    if (domino && seat) {
      played[seat] = { top: domino.top, bottom: domino.bottom, winning: slot === winningSlot, lead: slot === 0 };
    }
  });

  return (
    <View style={styles.table} accessibilityLabel="Table">
      <SeatPlate info={seats.top} width={sideWidth + 20} />
      <View style={styles.middle}>
        <SeatPlate info={seats.left} width={sideWidth} />
        <View
          ref={dropRef}
          collapsable={false}
          style={[styles.mat, { width: matWidth, height: matHeight }, dropActive && styles.matDrop]}
        >
          {center ?? (
            // Keyed by the trick, so each trick gets fresh tiles: an animation run on the native
            // side can leave a reused view where it ended, and the next trick's domino in that slot
            // would flash there first.
            <TrickTiles
              key={trick ? trickKey(trick) : 'none'}
              played={played}
              tileWidth={tileWidth}
              rowHeight={rowHeight}
              slotCentre={slotCentre}
              target={sweepTo ? seatCentre[sweepTo] : null}
            />
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
  leadTag: {
    position: 'absolute',
    bottom: 1,
    paddingHorizontal: 2,
    borderRadius: 2,
    backgroundColor: colors.brass,
  },
  // Android pads text above and below by default, which makes a tiny tag much taller.
  leadText: {
    color: colors.walnutDeep,
    fontFamily: fonts.uiBold,
    fontSize: 6,
    lineHeight: 7,
    includeFontPadding: false,
    textAlignVertical: 'center',
    textTransform: 'uppercase',
  },
  matDrop: { borderColor: colors.brass, backgroundColor: colors.matLight },
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
