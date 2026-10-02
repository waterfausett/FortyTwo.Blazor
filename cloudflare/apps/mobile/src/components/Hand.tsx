// The player's own dominoes, lying horizontally in up to two rows (four, then three), sized to
// fill the screen's width. On their turn a domino is played by tapping it, or by holding it and
// dragging it onto the table (`dropZone`) - the hold keeps an ordinary swipe scrolling the screen.
// With the player's "highlight playable dominoes" setting on, legal plays are outlined and the
// rest are faded and can't be played; with it off (the default) every domino looks the same, and
// the server turns away an illegal play.
//
// Dragging uses React Native's own PanResponder and Animated, so it needs no native library.
import { useMemo, useRef, useState, type RefObject } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import type { Domino as DominoType } from '@fortytwo/rules';
import { Domino } from './Domino';

const PER_ROW = 4;
const GAP = 8;
// The tile's short side, at most.
const MAX_TILE_SIZE = 42;
// How long a domino must be held before it can be dragged.
export const HOLD_TO_DRAG_MS = 250;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isInside(x: number, y: number, rect: Rect | null): boolean {
  return rect != null && x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

export interface DragState {
  dragging: boolean;
  // Whether the dragged domino is over the drop zone, so letting go would play it.
  overDropZone: boolean;
}

export interface HandProps {
  dominoes: DominoType[];
  canPlay: boolean;
  isValidPlay: (domino: DominoType) => boolean;
  onPlay: (domino: DominoType) => void;
  highlightPlayable?: boolean;
  // Where a dragged domino is played by dropping it: the table.
  dropZone?: RefObject<View | null>;
  // Reports a drag starting, crossing the drop zone and ending - the screen stops scrolling while
  // a domino is held, and the table lights up while one is over it.
  onDragChange?: (state: DragState) => void;
  // Horizontal space the hand may use; defaults to the window width less the screen's padding.
  availableWidth?: number;
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
}: HandProps) {
  const window = useWindowDimensions();
  const width = availableWidth ?? window.width - 24;
  // A horizontal tile is twice as long as its short side, plus a little for its shadow. Sized for
  // a full row, so tiles don't grow as the hand empties.
  const tileSize = Math.min(MAX_TILE_SIZE, Math.floor((width - GAP * (PER_ROW - 1)) / (PER_ROW * 2.12)));
  const tileLength = tileSize * 2 + Math.max(1.5, tileSize * 0.06);
  const rowWidth = tileLength * PER_ROW + GAP * (PER_ROW - 1);

  return (
    <View style={[styles.hand, { width: rowWidth, minHeight: tileSize * 2 + GAP + 4 }]} accessibilityLabel="Your hand">
      {dominoes.map((domino) => {
        const legal = !highlightPlayable || isValidPlay(domino);
        const playable = canPlay && legal;
        return (
          <HandTile
            key={domino.id}
            domino={domino}
            tileSize={tileSize}
            playable={playable}
            dimmed={highlightPlayable && canPlay && !legal}
            highlighted={highlightPlayable && playable}
            onPlay={() => onPlay(domino)}
            dropZone={dropZone}
            onDragChange={onDragChange}
          />
        );
      })}
    </View>
  );
}

function HandTile({
  domino,
  tileSize,
  playable,
  dimmed,
  highlighted,
  onPlay,
  dropZone,
  onDragChange,
}: {
  domino: DominoType;
  tileSize: number;
  playable: boolean;
  dimmed: boolean;
  highlighted: boolean;
  onPlay: () => void;
  dropZone?: RefObject<View | null>;
  onDragChange?: (state: DragState) => void;
}) {
  const offset = useRef(new Animated.ValueXY()).current;
  const [lifted, setLifted] = useState(false);
  // Gesture state lives in refs: the PanResponder is created once, and reads the latest of these.
  const armed = useRef(false);
  const granted = useRef(false);
  const over = useRef(false);
  const zone = useRef<Rect | null>(null);
  const latest = useRef({ onPlay, onDragChange });
  latest.current = { onPlay, onDragChange };

  function finish(drop: boolean) {
    armed.current = false;
    granted.current = false;
    over.current = false;
    setLifted(false);
    latest.current.onDragChange?.({ dragging: false, overDropZone: false });
    if (drop) {
      // The domino leaves the hand once the play lands, so it needn't glide back.
      offset.setValue({ x: 0, y: 0 });
      latest.current.onPlay();
    } else {
      Animated.spring(offset, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start();
    }
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
          const isOver = isInside(gesture.moveX, gesture.moveY, zone.current);
          if (isOver !== over.current) {
            over.current = isOver;
            latest.current.onDragChange?.({ dragging: true, overDropZone: isOver });
          }
        },
        onPanResponderRelease: (_, gesture) => finish(isInside(gesture.moveX, gesture.moveY, zone.current)),
        onPanResponderTerminate: () => finish(false),
      }),
    // `offset` and the refs are stable, and `finish` only reads refs.
    []
  );

  function pickUp() {
    armed.current = true;
    setLifted(true);
    latest.current.onDragChange?.({ dragging: true, overDropZone: false });
    // The screen stops scrolling while a domino is held, so the table stays where it's measured.
    dropZone?.current?.measureInWindow((x, y, width, height) => {
      zone.current = { x, y, width, height };
    });
  }

  return (
    <Animated.View
      {...responder.panHandlers}
      style={[
        { transform: [...offset.getTranslateTransform(), { scale: lifted ? 1.08 : 1 }] },
        lifted && styles.lifted,
      ]}
    >
      <Pressable
        onPress={playable ? onPlay : undefined}
        onLongPress={playable && dropZone ? pickUp : undefined}
        delayLongPress={HOLD_TO_DRAG_MS}
        // Held and let go without moving: put it back. (When a drag takes over the touch, this
        // fires first, so wait a tick to see whether the drag was granted.)
        onPressOut={() =>
          setTimeout(() => {
            if (armed.current && !granted.current) finish(false);
          }, 0)
        }
        disabled={!playable}
        accessibilityRole="button"
        accessibilityLabel={`${domino.top}-${domino.bottom}`}
        accessibilityHint={playable && dropZone ? 'Tap to play, or hold and drag it to the table' : undefined}
        hitSlop={4}
      >
        <Domino
          top={domino.top}
          bottom={domino.bottom}
          width={tileSize}
          direction="horizontal"
          dimmed={dimmed}
          highlighted={highlighted}
          accessible={false}
        />
      </Pressable>
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
});
