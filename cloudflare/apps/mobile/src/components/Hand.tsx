// The player's own dominoes, in one row sized to fit all seven across the screen. On their turn,
// tapping a legal domino plays it; illegal ones are faded and do nothing.
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import type { Domino as DominoType } from '@fortytwo/rules';
import { Domino } from './Domino';

const HAND_SIZE = 7;
const GAP = 6;
const MAX_TILE_WIDTH = 46;

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
  // Sized for a full hand, so tiles don't grow as the hand empties.
  const tileWidth = Math.min(MAX_TILE_WIDTH, Math.floor((width - GAP * (HAND_SIZE - 1)) / HAND_SIZE));

  return (
    <View style={[styles.hand, { minHeight: tileWidth * 2 + 6 }]} accessibilityLabel="Your hand">
      {dominoes.map((domino) => {
        const playable = canPlay && isValidPlay(domino);
        return (
          <Domino
            key={domino.id}
            top={domino.top}
            bottom={domino.bottom}
            width={tileWidth}
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
  hand: { flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-end', gap: GAP },
});
