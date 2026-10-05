// The table seen from the player's chair, as on the web: one felt with every seat on it - the other
// three players around the edge, each with a face-down fan of the dominoes they still hold, the
// player at the bottom - and the trick in progress in the middle, each domino in front of whoever
// played it. Sized from the window width so it fills a phone screen.
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View, useWindowDimensions, type LayoutRectangle } from 'react-native';
import type { Seat } from '@fortytwo/client';
import type { Suit, Trick } from '@fortytwo/rules';
import { PipFace } from './PipFace';
import { Domino } from './Domino';
import { colors, fonts } from './theme';
import { TRICK_SWEEP_MS } from '@/match/useTrickHold';

// The middle's height while compact (bidding and naming trump), and how long it takes to resize.
const COMPACT_MAT_HEIGHT = 44;
export const TABLE_RESIZE_MS = 480;

const FELT_PADDING = 8;
const GAP = 4;

export interface SeatInfo {
  name: string;
  side: 'us' | 'them';
  isActive: boolean;
  isDealer: boolean;
  bid: string | null;
  // Holds the winning bid: their bid chip is filled in their team's colour, and once trump is
  // named it carries the trump's pip face, as on the web.
  isHighBidder: boolean;
  trump: Suit | null;
  // Shown while everyone readies up for the next hand; null otherwise.
  ready: boolean | null;
  // Dominoes left in hand; null for the player's own seat, whose hand is shown below the table.
  dominoCount: number | null;
}

// A face-down tile for each domino a player still holds. Only ever a count: the Worker never sends
// another player's dominoes.
function TileBacks({ count }: { count: number }) {
  return (
    <View style={styles.backs} accessibilityLabel={`${count} ${count === 1 ? 'domino' : 'dominoes'}`}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.back}>
          <View style={styles.backDot} />
        </View>
      ))}
    </View>
  );
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
  return (
    <View
      style={[styles.plate, { width }, info.isActive && [styles.active, { boxShadow: `0 0 0 2px ${team}` }]]}
      accessibilityLabel={`${info.name}${info.isActive ? ', to act' : ''}`}
    >
      {info.isActive && <PulsingGlow color={team} />}
      <View style={[styles.teamStripe, { backgroundColor: team }]} />
      <View style={styles.nameRow}>
        <Text style={styles.name} numberOfLines={1}>
          {info.name}
        </Text>
        {info.isDealer && (
          <View style={styles.dealer} accessibilityLabel="Dealer">
            <Text style={styles.dealerText}>D</Text>
          </View>
        )}
      </View>
      <View style={styles.detailRow}>
        {info.bid != null && (
          <View
            style={[styles.bid, info.isHighBidder && { backgroundColor: team, borderColor: team }]}
            accessibilityLabel={`Bid ${info.bid}`}
          >
            <Text style={[styles.bidText, info.isHighBidder && styles.bidTextHigh]} maxFontSizeMultiplier={1.2}>
              {info.bid}
            </Text>
            {info.isHighBidder && info.trump != null && <PipFace suit={info.trump} size={14} />}
          </View>
        )}
        {info.ready != null && (
          <Text style={[styles.detail, info.ready && styles.ready]} numberOfLines={1}>
            {info.ready ? 'Ready' : 'Not ready'}
          </Text>
        )}
      </View>
    </View>
  );
}

// How long the glow around whoever is to act takes to swell and fade back, as on the web.
const PULSE_MS = 2400;

// A glow in the team's colour around whoever is to act (the plate carries a steady ring in the same
// colour), slowly swelling and fading so the eye finds it. A shadow can't be animated on the native
// side, so the glow is its own layer and only its opacity changes. Held steady when the system asks
// for reduced motion.
function PulsingGlow({ color }: { color: string }) {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduced) => {
        if (cancelled || reduced) return;
        const half = { duration: PULSE_MS / 2, easing: Easing.inOut(Easing.sin), useNativeDriver: true };
        loop = Animated.loop(
          Animated.sequence([
            Animated.timing(pulse, { ...half, toValue: 0.3 }),
            Animated.timing(pulse, { ...half, toValue: 1 }),
          ]),
        );
        loop.start();
      });
    return () => {
      cancelled = true;
      loop?.stop();
    };
  }, [pulse]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.glow, { boxShadow: `0 0 16px 2px ${color}`, opacity: pulse }]}
    />
  );
}

// A seat on the felt: the plate, and for the other players their face-down tiles, on the side
// facing the middle of the table.
function TableSeat({
  info,
  width,
  onLayout,
}: {
  info: SeatInfo | null;
  width: number;
  onLayout: (layout: LayoutRectangle) => void;
}) {
  const count = info?.dominoCount ?? 0;
  return (
    <View style={styles.seat} onLayout={(e) => onLayout(e.nativeEvent.layout)}>
      <SeatPlate info={info} width={width} />
      {count > 0 && <TileBacks count={count} />}
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
  // Bidding and naming trump don't use the table, so the mat shrinks to a strip, leaving more of
  // the screen for the hand and the choices; it opens back up as play starts, which also says
  // that play is about to begin. The seat plates stay full size, since they show each bid.
  compact?: boolean;
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
  compact = false,
}: TableProps) {
  const window = useWindowDimensions();
  const width = Math.min(window.width - 24, 480);
  const inner = width - FELT_PADDING * 2;
  const sideWidth = Math.round(inner * 0.26);
  const matWidth = inner - sideWidth * 2 - GAP * 2;
  // Trick tiles: three stacked vertically must fit the middle's height, two across beside it.
  const tileWidth = Math.min(30, Math.floor(matWidth / 5));
  const matHeight = tileWidth * 2 * 3 + 24;
  const rowHeight = tileWidth * 2 + 4;

  // The middle's height, eased between full and compact. Animating height re-lays-out the screen
  // each frame, which is fine for this one short, deliberate change. Opening starts gently and
  // settles slowly, so the table seems to unfold rather than snap open.
  const shownHeight = compact ? COMPACT_MAT_HEIGHT : matHeight;
  const height = useRef(new Animated.Value(shownHeight)).current;
  useEffect(() => {
    Animated.timing(height, {
      toValue: shownHeight,
      duration: TABLE_RESIZE_MS,
      easing: Easing.bezier(0.33, 0, 0.2, 1),
      useNativeDriver: false,
    }).start();
  }, [shownHeight, height]);

  // Where everything sits, for aiming a sweep at the winner's seat: the top and bottom seats and the
  // middle row are laid out on the felt, the side seats and the middle within that row. Measured
  // rather than worked out, since a seat's height depends on its plate's text.
  const layouts = useRef<Partial<Record<Seat | 'row' | 'mat', LayoutRectangle>>>({}).current;
  const remember = (key: Seat | 'row' | 'mat') => (layout: LayoutRectangle) => {
    layouts[key] = layout;
  };
  const centreOf = (key: Seat | 'mat'): Point | null => {
    const l = layouts[key];
    if (!l) return null;
    const inRow = key === 'left' || key === 'right' || key === 'mat';
    const row = inRow ? layouts.row : { x: 0, y: 0 };
    if (!row) return null;
    // The middle is measured mid-resize too, so use its full height rather than the last frame's.
    const h = key === 'mat' ? matHeight : l.height;
    return { x: row.x + l.x + l.width / 2, y: row.y + l.y + h / 2 };
  };
  const sweepTarget = (seat: Seat): Point => {
    const from = centreOf('mat');
    const to = centreOf(seat);
    if (from && to) return { x: to.x - from.x, y: to.y - from.y };
    // Not laid out yet (or under test): roughly where the seat is.
    const fallback: Record<Seat, Point> = {
      top: { x: 0, y: -matHeight },
      bottom: { x: 0, y: matHeight },
      left: { x: -(matWidth + sideWidth) / 2, y: 0 },
      right: { x: (matWidth + sideWidth) / 2, y: 0 },
    };
    return fallback[seat];
  };

  // Centres of each slot's tile, relative to the middle's centre.
  const slotCentre: Record<Seat, Point> = {
    top: { x: 0, y: -rowHeight },
    bottom: { x: 0, y: rowHeight },
    left: { x: -matWidth / 4, y: 0 },
    right: { x: matWidth / 4, y: 0 },
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
    <View style={[styles.felt, { width }]} accessibilityLabel="Table">
      <TableSeat info={seats.top} width={sideWidth + 30} onLayout={remember('top')} />
      <View style={styles.middle} onLayout={(e) => remember('row')(e.nativeEvent.layout)}>
        <TableSeat info={seats.left} width={sideWidth} onLayout={remember('left')} />
        <Animated.View
          ref={dropRef}
          collapsable={false}
          onLayout={(e) => remember('mat')(e.nativeEvent.layout)}
          style={[styles.mat, { width: matWidth, height }, compact && styles.matCompact, dropActive && styles.matDrop]}
        >
          {center ?? (compact ? null : (
            // Keyed by the trick, so each trick gets fresh tiles: an animation run on the native
            // side can leave a reused view where it ended, and the next trick's domino in that slot
            // would flash there first.
            <TrickTiles
              key={trick ? trickKey(trick) : 'none'}
              played={played}
              tileWidth={tileWidth}
              rowHeight={rowHeight}
              slotCentre={slotCentre}
              target={sweepTo ? sweepTarget(sweepTo) : null}
            />
          ))}
        </Animated.View>
        <TableSeat info={seats.right} width={sideWidth} onLayout={remember('right')} />
      </View>
      <TableSeat info={seats.bottom} width={sideWidth + 30} onLayout={remember('bottom')} />
    </View>
  );
}

const styles = StyleSheet.create({
  // The felt, lit from just above the middle like the web's table.
  felt: {
    alignItems: 'center',
    gap: 8,
    padding: FELT_PADDING,
    borderRadius: 24,
    backgroundColor: colors.mat,
    experimental_backgroundImage: `radial-gradient(ellipse at 50% 45%, ${colors.matLight}, ${colors.mat} 70%)`,
    boxShadow: 'inset 0 2px 18px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(242, 234, 219, 0.06)',
  },
  middle: { flexDirection: 'row', alignItems: 'center', gap: GAP },
  seat: { alignItems: 'center', gap: 5 },
  // The middle of the felt, where the trick is played and a dragged domino is dropped. Outlined
  // only while a domino is over it, as on the web.
  mat: {
    borderRadius: 14,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: 'transparent',
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
  // Clipped only while compact: a full table lets a sweeping trick fly out to the seats.
  matCompact: { overflow: 'hidden' },
  matDrop: { borderColor: colors.brass, backgroundColor: 'rgba(242, 234, 219, 0.05)' },
  trickRow: { flexDirection: 'row', justifyContent: 'space-around', width: '100%' },
  plate: {
    paddingVertical: 5,
    paddingLeft: 10,
    paddingRight: 6,
    borderRadius: 10,
    backgroundColor: 'rgba(20, 13, 9, 0.55)',
    boxShadow: '0 0 0 1px rgba(242, 234, 219, 0.1)',
  },
  teamStripe: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    borderTopLeftRadius: 10,
    borderBottomLeftRadius: 10,
  },
  active: { backgroundColor: 'rgba(58, 42, 22, 0.85)' },
  glow: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 10 },
  open: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.inkMuted,
    boxShadow: 'none',
    paddingLeft: 6,
  },
  openText: { color: colors.inkMuted, fontFamily: fonts.ui },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  name: { flex: 1, color: colors.bone, fontFamily: fonts.uiBold, fontSize: 14 },
  dealer: {
    backgroundColor: colors.bone,
    borderRadius: 8,
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: `0 1px 0 ${colors.boneEdge}`,
  },
  dealerText: { color: colors.walnutDeep, fontFamily: fonts.display, fontSize: 10 },
  // Fixed height, so a plate doesn't change size as a bid chip comes and goes.
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 20 },
  detail: { flexShrink: 1, color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 12 },
  ready: { color: colors.us },
  bid: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: 'rgba(242, 234, 219, 0.25)',
  },
  bidText: { color: colors.inkMuted, fontFamily: fonts.display, fontSize: 12 },
  bidTextHigh: { color: colors.walnutDeep },
  backs: { flexDirection: 'row', gap: 2 },
  back: {
    width: 8,
    height: 16,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bone,
    boxShadow: `1px 1px 0 ${colors.boneEdge}, 0 2px 3px rgba(0, 0, 0, 0.35)`,
  },
  backDot: { width: 2, height: 2, borderRadius: 1, backgroundColor: colors.boneEdge },
});
