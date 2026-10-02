// Fades its children in when it mounts. Key it by what it shows, so a change of content (the bids
// giving way to the trumps, the trumps to the play) eases in rather than popping into place.
import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, type StyleProp, type ViewStyle } from 'react-native';

export const FADE_IN_MS = 260;

export function FadeIn({
  children,
  delay = 0,
  style,
}: {
  children: ReactNode;
  delay?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(opacity, {
      toValue: 1,
      duration: FADE_IN_MS,
      delay,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [opacity, delay]);
  return <Animated.View style={[style, { opacity }]}>{children}</Animated.View>;
}
