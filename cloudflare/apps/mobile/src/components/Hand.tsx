// The player's own dominoes, lying horizontally in up to two rows (four, then three), sized to
// fill the screen's width. On their turn, tapping a domino plays it. With the player's "highlight
// playable dominoes" setting on, legal plays are outlined and the rest are faded and can't be
// tapped; with it off (the default) every domino looks the same, and the server turns away an
// illegal play.
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import type { Domino as DominoType } from '@fortytwo/rules';
import { Domino } from './Domino';

const PER_ROW = 4;
const GAP = 8;
// The tile's short side, at most.
const MAX_TILE_SIZE = 42;

export interface HandProps {
  dominoes: DominoType[];
  canPlay: boolean;
  isValidPlay: (domino: DominoType) => boolean;
  onPlay: (domino: DominoType) => void;
  highlightPlayable?: boolean;
  // Horizontal space the hand may use; defaults to the window width less the screen's padding.
  availableWidth?: number;
}

export function Hand({ dominoes, canPlay, isValidPlay, onPlay, highlightPlayable = false, availableWidth }: HandProps) {
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
          <Domino
            key={domino.id}
            top={domino.top}
            bottom={domino.bottom}
            width={tileSize}
            direction="horizontal"
            onPress={playable ? () => onPlay(domino) : undefined}
            dimmed={highlightPlayable && canPlay && !legal}
            highlighted={highlightPlayable && playable}
          />
        );
      })}
    </View>
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
});
