// Stands in for a player's name while it loads (match/usePlayerNames.ts), so the raw player id
// never shows: a soft bar the height of a line of text, gently pulsing.
import { useEffect } from 'react';
import { Animated, useAnimatedValue, type DimensionValue } from 'react-native';
import { colors } from './theme';

export function NameSkeleton({ width = 72 }: { width?: DimensionValue }) {
  const opacity = useAnimatedValue(0.15);
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.15, duration: 700, useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity]);
  return (
    <Animated.View
      accessibilityLabel="Loading name"
      style={{ width, height: 12, borderRadius: 4, backgroundColor: colors.bone, opacity }}
    />
  );
}
