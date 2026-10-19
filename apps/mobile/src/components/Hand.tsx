// The player's own dominoes, lying horizontally in up to two rows (four, then three), sized to
// fill the screen's width.
//
// On their turn a domino is played by tapping it, or by holding it and dragging it onto the table
// (`dropZone`). At any time a held domino can be dropped onto another to move it there - the order
// is the player's own, kept on this device and carried across plays. Holding first keeps an
// ordinary swipe scrolling the screen.
//
// With the player's "highlight playable dominoes" setting on, legal plays are outlined and the
// rest are faded and can't be played; with it off (the default) every domino looks the same, and
// the server turns away an illegal play.
//
// Before their turn, a player can double-tap a domino to pre-select it, as on the web (a double-click
// there): it's ringed, and played a beat after their turn comes (PRESELECT_AUTO_PLAY_DELAY_MS).
// Only a legal play can be picked, and only one at a time - double-tap it again to drop it, or
// another to switch. Any play, and any change to the hand, clears it.
//
// Dragging uses React Native's own PanResponder and Animated, so it needs no native library.
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Animated, Easing, PanResponder, Pressable, StyleSheet, View, useAnimatedValue, useAnimatedValueXY, useWindowDimensions } from 'react-native';
import { PRESELECT_AUTO_PLAY_DELAY_MS } from '@fortytwo/client';
import type { Domino as DominoType } from '@fortytwo/rules';
import { Domino } from './Domino';
import { colors } from './theme';

const PER_ROW = 4;
const GAP = 8;
// The tile's short side, at most.
const MAX_TILE_SIZE = 42;
// How long a domino must be held before it can be dragged.
export const HOLD_TO_DRAG_MS = 250;
// Dealing: each domino rises into place, one after another.
const DEAL_MS = 280;
const DEAL_STAGGER_MS = 45;
// Two taps on the same domino at most this far apart make a double-tap.
export const DOUBLE_TAP_MS = 300;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isInside(x: number, y: number, rect: Rect | null | undefined): boolean {
  return rect != null && x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

// `ids` with `id` moved to where `targetId` is.
export function moveBefore(ids: string[], id: string, targetId: string): string[] {
  const from = ids.indexOf(id);
  const to = ids.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

// The player's arrangement, kept across a change of hand: dominoes still held stay where the player
// put them, and new ones (a fresh deal) are added in the order dealt.
export function reconcileOrder(previous: string[], dominoes: DominoType[]): string[] {
  const held = new Set(dominoes.map((d) => d.id));
  const kept = previous.filter((id) => held.has(id));
  const keptSet = new Set(kept);
  return [...kept, ...dominoes.map((d) => d.id).filter((id) => !keptSet.has(id))];
}

export interface DragState {
  dragging: boolean;
  // Whether the dragged domino is over the drop zone, so letting go would play it.
  overDropZone: boolean;
}

// What happens to a dragged tile when it's let go: stay where it was dropped (it's being played,
// and leaves the hand for the table), jump straight to its new slot (reordered), or spring
// back to where it was.
type DropOutcome = 'stay' | 'reset' | 'spring';

export interface HandProps {
  dominoes: DominoType[];
  canPlay: boolean;
  isValidPlay: (domino: DominoType) => boolean;
  // May return a promise that rejects when the play is turned away, so a dropped tile can return.
  onPlay: (domino: DominoType) => unknown;
  highlightPlayable?: boolean;
  // Where a dragged domino is played by dropping it: the table.
  dropZone?: RefObject<View | null>;
  // Reports a drag starting, crossing the drop zone and ending - the screen stops scrolling while
  // a domino is held, and the table lights up while one that can be played is over it.
  onDragChange?: (state: DragState) => void;
  // Horizontal space the hand may use; defaults to the window width less the screen's padding.
  availableWidth?: number;
  // A domino on its way to the table: not drawn, but its place is kept, so if the play is turned
  // away it comes back where it was.
  playingId?: string | null;
  // Dominoes a hint suggests playing, ringed.
  suggestedIds?: string[];
  // Told whenever a pre-play is queued (the domino's id) or cleared (null), so the screen can hide
  // the Hint button while a domino is set to play itself.
  onPreselectChange?: (id: string | null) => void;
}

export function Hand({
  dominoes,
  canPlay,
  isValidPlay,
  onPlay,
  highlightPlayable = false,
  dropZone,
  onDragChange,
  availableWidth,
  playingId = null,
  suggestedIds = [],
  onPreselectChange,
}: HandProps) {
  const window = useWindowDimensions();
  const width = availableWidth ?? window.width - 24;
  // A horizontal tile is twice as long as its short side, plus a little for its shadow. Sized for
  // a full row, so tiles don't grow as the hand empties.
  const tileSize = Math.min(MAX_TILE_SIZE, Math.floor((width - GAP * (PER_ROW - 1)) / (PER_ROW * 2.12)));
  const tileLength = tileSize * 2 + Math.max(1.5, tileSize * 0.06);
  const rowWidth = tileLength * PER_ROW + GAP * (PER_ROW - 1);

  // The player's arrangement, reconciled whenever the dominoes held actually change (a deal, or a
  // domino leaving after a play) - not on every broadcast, which brings a fresh array each time.
  const signature = dominoes.map((d) => d.id).join(',');
  const [order, setOrder] = useState(() => dominoes.map((d) => d.id));
  const [syncedSignature, setSyncedSignature] = useState(signature);
  // The domino picked to be played as soon as it's this player's turn.
  const [preselectedId, setPreselectedId] = useState<string | null>(null);
  const onPreselectChangeRef = useRef(onPreselectChange);
  useEffect(() => {
    onPreselectChangeRef.current = onPreselectChange;
  });
  useEffect(() => onPreselectChangeRef.current?.(preselectedId), [preselectedId]);
  if (signature !== syncedSignature) {
    setSyncedSignature(signature);
    setOrder(reconcileOrder(order, dominoes));
    setPreselectedId(null);
  }
  const byId = new Map(dominoes.map((d) => [d.id, d]));
  const ordered = order
    .filter((id) => id !== playingId)
    .map((id) => byId.get(id))
    .filter((d): d is DominoType => d != null);

  // Where each tile and the drop zone are on screen, measured when a drag starts (the screen
  // holds still while a domino is held, so they stay put).
  const tileViews = useRef(new Map<string, View>());
  const tileRects = useRef(new Map<string, Rect>());
  const zone = useRef<Rect | null>(null);

  // The latest of these, for the auto-play timer, which should only restart when the turn or the
  // pick changes - the screen passes a fresh array and `onPlay` on every render.
  const latest = useRef({ dominoes, onPlay });
  // eslint-disable-next-line react/refs -- only read by the timer, never to render
  latest.current = { dominoes, onPlay };

  // Plays the pre-selected domino a beat after the turn comes. A play made in that beat clears
  // the pick (and takes the turn), which cancels this.
  useEffect(() => {
    if (!canPlay || preselectedId == null) return;
    const timer = setTimeout(() => {
      const domino = latest.current.dominoes.find((d) => d.id === preselectedId);
      setPreselectedId(null);
      // Refused plays report their own errors.
      if (domino) Promise.resolve(latest.current.onPlay(domino)).catch(() => {});
    }, PRESELECT_AUTO_PLAY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [canPlay, preselectedId]);

  // Every play made by hand - a tap or a drop - goes through here, so it overrides a pick.
  function playNow(domino: DominoType): unknown {
    setPreselectedId(null);
    return onPlay(domino);
  }

  function preselect(domino: DominoType) {
    if (canPlay) return;
    setPreselectedId((current) => (current === domino.id ? null : isValidPlay(domino) ? domino.id : current));
  }

  function canPlayDomino(domino: DominoType): boolean {
    return canPlay && (!highlightPlayable || isValidPlay(domino));
  }

  function pickUp() {
    dropZone?.current?.measureInWindow((x, y, w, h) => {
      zone.current = { x, y, width: w, height: h };
    });
    tileRects.current.clear();
    for (const [id, view] of tileViews.current) {
      view.measureInWindow((x, y, w, h) => tileRects.current.set(id, { x, y, width: w, height: h }));
    }
  }

  function overZone(domino: DominoType, x: number, y: number): boolean {
    return canPlayDomino(domino) && isInside(x, y, zone.current);
  }

  // The domino a held one would trade places with if let go here, if any.
  function swapTarget(domino: DominoType, x: number, y: number): string | null {
    if (overZone(domino, x, y)) return null;
    return [...tileRects.current].find(([id, rect]) => id !== domino.id && isInside(x, y, rect))?.[0] ?? null;
  }

  // Ringed while a held domino is over it, to show where that one would go.
  const [targetId, setTargetId] = useState<string | null>(null);

  async function drop(domino: DominoType, x: number, y: number): Promise<DropOutcome> {
    if (overZone(domino, x, y)) {
      try {
        await playNow(domino);
        return 'stay';
      } catch {
        return 'spring';
      }
    }
    const target = swapTarget(domino, x, y);
    if (target) {
      setOrder((current) => moveBefore(current, domino.id, target));
      return 'reset';
    }
    return 'spring';
  }

  return (
    // Two rows tall while there's anything in it, so it doesn't shrink as the hand empties; nothing
    // once it's empty.
    <View
      style={[styles.hand, { width: rowWidth }, ordered.length > 0 && { minHeight: tileSize * 2 + GAP + 4 }]}
      accessibilityLabel="Your hand"
    >
      {ordered.map((domino, index) => {
        const legal = !highlightPlayable || isValidPlay(domino);
        return (
          <HandTile
            key={domino.id}
            domino={domino}
            tileSize={tileSize}
            dealDelay={index * DEAL_STAGGER_MS}
            playable={canPlay && legal}
            dimmed={highlightPlayable && canPlay && !legal}
            highlighted={highlightPlayable && canPlay && legal}
            preselected={preselectedId === domino.id}
            suggested={suggestedIds.includes(domino.id)}
            draggable={dropZone != null}
            // A tap's play reports its own errors; nothing here needs the outcome.
            onPlay={() => Promise.resolve(playNow(domino)).catch(() => {})}
            // Off turn only: on the player's turn the first tap has already played it.
            onDoubleTap={canPlay ? undefined : () => preselect(domino)}
            onPickUp={pickUp}
            isTarget={targetId === domino.id}
            isOverZone={(x, y) => overZone(domino, x, y)}
            onHover={(point) => setTargetId(point ? swapTarget(domino, point.x, point.y) : null)}
            onDrop={(x, y) => drop(domino, x, y)}
            onDragChange={onDragChange}
            viewRef={(view) => {
              if (view) tileViews.current.set(domino.id, view);
              else tileViews.current.delete(domino.id);
            }}
          />
        );
      })}
    </View>
  );
}

function HandTile({
  domino,
  tileSize,
  dealDelay,
  isTarget,
  playable,
  dimmed,
  highlighted,
  preselected,
  suggested,
  draggable,
  onPlay,
  onDoubleTap,
  onPickUp,
  isOverZone,
  onHover,
  onDrop,
  onDragChange,
  viewRef,
}: {
  domino: DominoType;
  tileSize: number;
  dealDelay: number;
  playable: boolean;
  dimmed: boolean;
  highlighted: boolean;
  preselected: boolean;
  suggested: boolean;
  draggable: boolean;
  onPlay: () => unknown;
  onDoubleTap?: () => void;
  onPickUp: () => void;
  isTarget: boolean;
  isOverZone: (x: number, y: number) => boolean;
  // Where the held domino is, or null once it's let go.
  onHover: (point: { x: number; y: number } | null) => void;
  onDrop: (x: number, y: number) => Promise<DropOutcome>;
  onDragChange?: (state: DragState) => void;
  viewRef: (view: View | null) => void;
}) {
  const offset = useAnimatedValueXY({ x: 0, y: 0 });
  // A tile mounts when its domino is dealt (it then stays, keyed by the domino, until played).
  const dealt = useAnimatedValue(0);
  useEffect(() => {
    Animated.timing(dealt, {
      toValue: 1,
      duration: DEAL_MS,
      delay: dealDelay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    // Only on mount: a tile moved by a reorder isn't dealt again.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `dealt` is stable
  }, []);
  const [lifted, setLifted] = useState(false);
  // Gesture state lives in refs: the PanResponder is created once, and reads the latest of these.
  const armed = useRef(false);
  const granted = useRef(false);
  const over = useRef(false);
  const latest = useRef({ isOverZone, onHover, onDrop, onDragChange });
  // eslint-disable-next-line react/refs -- only read by the gesture handlers, never to render
  latest.current = { isOverZone, onHover, onDrop, onDragChange };

  function endDrag() {
    armed.current = false;
    granted.current = false;
    over.current = false;
    latest.current.onHover(null);
    latest.current.onDragChange?.({ dragging: false, overDropZone: false });
  }

  function springBack() {
    setLifted(false);
    Animated.spring(offset, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start();
  }

  async function release(x: number, y: number) {
    endDrag();
    const outcome = await latest.current.onDrop(x, y);
    if (outcome === 'stay') return; // played: it leaves the hand for the table
    if (outcome === 'reset') {
      setLifted(false);
      offset.setValue({ x: 0, y: 0 });
      return;
    }
    springBack();
  }

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Only once the domino has been held: until then a swipe scrolls the screen as usual.
        onMoveShouldSetPanResponderCapture: () => armed.current,
        onMoveShouldSetPanResponder: () => armed.current,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          granted.current = true;
        },
        onPanResponderMove: (_, gesture) => {
          offset.setValue({ x: gesture.dx, y: gesture.dy });
          latest.current.onHover({ x: gesture.moveX, y: gesture.moveY });
          const isOver = latest.current.isOverZone(gesture.moveX, gesture.moveY);
          if (isOver !== over.current) {
            over.current = isOver;
            latest.current.onDragChange?.({ dragging: true, overDropZone: isOver });
          }
        },
        onPanResponderRelease: (_, gesture) => {
          void release(gesture.moveX, gesture.moveY);
        },
        onPanResponderTerminate: () => {
          endDrag();
          springBack();
        },
      }),
    // `offset` and the refs are stable, and the handlers only read refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // When the last tap landed, to tell a double-tap from two taps.
  const lastTap = useRef(0);
  function tap() {
    const now = Date.now();
    if (now - lastTap.current <= DOUBLE_TAP_MS) {
      lastTap.current = 0;
      onDoubleTap?.();
    } else {
      lastTap.current = now;
    }
  }

  function pickUp() {
    armed.current = true;
    setLifted(true);
    onPickUp();
    latest.current.onDragChange?.({ dragging: true, overDropZone: false });
  }

  return (
    <Animated.View
      style={[
        { opacity: dealt, transform: [{ translateY: dealt.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] },
        lifted && styles.lifted,
      ]}
    >
      {/* While held, a faded copy marks the domino's own place... */}
      {lifted && (
        <View style={styles.ghost} pointerEvents="none">
          <Domino top={domino.top} bottom={domino.bottom} width={tileSize} direction="horizontal" accessible={false} />
        </View>
      )}
      {/* ...and the domino it would trade places with is ringed. */}
      {isTarget && <View style={styles.target} pointerEvents="none" />}
      <Animated.View
        ref={viewRef}
        collapsable={false}
        {...responder.panHandlers}
        style={{ transform: [...offset.getTranslateTransform(), { scale: lifted ? 1.08 : 1 }] }}
      >
        <Pressable
          onPress={playable ? onPlay : onDoubleTap ? tap : undefined}
          onLongPress={draggable ? pickUp : undefined}
          delayLongPress={HOLD_TO_DRAG_MS}
          // Held and let go without moving: put it back. (When a drag takes over the touch, this
          // fires first, so wait a tick to see whether the drag was granted.)
          onPressOut={() =>
            setTimeout(() => {
              if (armed.current && !granted.current) {
                endDrag();
                springBack();
              }
            }, 0)
          }
          accessibilityRole="button"
          accessibilityState={{ disabled: !playable, selected: preselected }}
          accessibilityLabel={`${domino.top}-${domino.bottom}`}
          accessibilityHint={
            playable
              ? draggable
                ? 'Tap to play, or hold and drag it to the table'
                : undefined
              : onDoubleTap
                ? `Double-tap to play it when your turn comes${draggable ? ', or hold and drag to move it' : ''}`
                : draggable
                  ? 'Hold and drag to move it'
                  : undefined
          }
          hitSlop={4}
        >
          <Domino
            top={domino.top}
            bottom={domino.bottom}
            width={tileSize}
            direction="horizontal"
            dimmed={dimmed}
            highlighted={highlighted}
            preselected={preselected}
            suggested={suggested}
            accessible={false}
          />
        </Pressable>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  hand: {
    alignSelf: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignContent: 'flex-start',
    gap: GAP,
  },
  // Drawn above the rest of the hand while dragged.
  lifted: { zIndex: 10, elevation: 8 },
  ghost: { position: 'absolute', top: 0, left: 0, opacity: 0.3 },
  target: {
    position: 'absolute',
    top: -4,
    left: -4,
    right: -4,
    bottom: -4,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: colors.brass,
  },
});
