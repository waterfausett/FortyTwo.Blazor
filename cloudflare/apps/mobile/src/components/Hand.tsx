// The player's own dominoes. On their turn, tapping a legal domino plays it; illegal ones are
// faded and do nothing. Drag-to-play comes later (#31).
import { StyleSheet, View } from 'react-native';
import type { Domino as DominoType } from '@fortytwo/rules';
import { Domino } from './Domino';

export interface HandProps {
  dominoes: DominoType[];
  canPlay: boolean;
  isValidPlay: (domino: DominoType) => boolean;
  onPlay: (domino: DominoType) => void;
}

export function Hand({ dominoes, canPlay, isValidPlay, onPlay }: HandProps) {
  return (
    <View style={styles.hand} accessibilityLabel="Your hand">
      {dominoes.map((domino) => {
        const playable = canPlay && isValidPlay(domino);
        return (
          <Domino
            key={domino.id}
            top={domino.top}
            bottom={domino.bottom}
            size={20}
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
  hand: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 },
});
