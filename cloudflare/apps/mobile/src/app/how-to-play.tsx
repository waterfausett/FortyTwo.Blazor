// How to play: the rules of Forty-Two, from the Lobby's "?" and card or the match screen's "?".
// Opening it counts as having seen them, so the Lobby stops offering them.
import { useEffect } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHowToPlay } from '@/api/useHowToPlay';
import { HowToPlayContent } from '@/components/HowToPlayContent';
import { colors } from '@/components/theme';

export default function HowToPlayScreen() {
  const { offer, markSeen } = useHowToPlay();
  const { bottom } = useSafeAreaInsets();

  // Once the profile says "not seen" - it may still be loading when the screen opens.
  useEffect(() => {
    if (offer) markSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingBottom: 32 + bottom }]}>
      <HowToPlayContent />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.walnut },
  content: { padding: 20 },
});
