// The player's own dominoes, lying horizontally in up to two rows (four, then three), sized to
// fill the screen's width. On their turn, tapping a legal domino plays it; illegal ones are faded
// and do nothing.
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
  // Horizontal space the hand may use; defaults to the window width less the screen's padding.
  availableWidth?: number;
}

export function Hand({ dominoes, canPlay, isValidPlay, onPlay, availableWidth }: HandProps) {
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
        const playable = canPlay && isValidPlay(domino);
        return (
          <Domino
            key={domino.id}
            top={domino.top}
            bottom={domino.bottom}
            width={tileSize}
            direction="horizontal"
            onPress={playable ? () => onPlay(domino) : undefined}
            dimmed={canPlay && !playable}
            highlighted={playable}
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
