// Fades its children in when it mounts, and out and back in as `visible` changes. Key it by what
// it shows, so a change of content (the bids giving way to the trumps, the trumps to the play)
// eases in rather than popping into place. Hidden, it ignores touches.
//
// While fading it draws its children as one layer: otherwise Android fades each overlapping view
// (a button's face, its edge, its label) on its own, and they smear into each other on the way.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, type StyleProp, type ViewStyle } from 'react-native';

export const FADE_IN_MS = 260;
export const FADE_OUT_MS = 180;

export function Fade({
  children,
  visible = true,
  delay = 0,
  style,
}: {
  children: ReactNode;
  visible?: boolean;
  delay?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const [fading, setFading] = useState(true);
  useEffect(() => {
    setFading(true);
    const animation = Animated.timing(opacity, {
      toValue: visible ? 1 : 0,
      duration: visible ? FADE_IN_MS : FADE_OUT_MS,
      delay: visible ? delay : 0,
      easing: visible ? Easing.out(Easing.quad) : Easing.in(Easing.quad),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) setFading(false);
    });
    return () => animation.stop();
  }, [opacity, visible, delay]);
  return (
    <Animated.View
      style={[style, { opacity }]}
      pointerEvents={visible ? 'auto' : 'none'}
      needsOffscreenAlphaCompositing={fading}
      renderToHardwareTextureAndroid={fading}
    >
      {children}
    </Animated.View>
  );
}
