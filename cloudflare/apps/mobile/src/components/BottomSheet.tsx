// A sheet that slides up from the bottom over a dimmed screen. As a native sheet does, the scrim
// fades in place while only the sheet slides; the Modal's own "slide" would carry the scrim up with
// it. The Modal stays mounted until the sheet is down again. Tapping the scrim, or Back, calls
// onClose. `style` is the sheet's look (background, padding, gap); its place on screen is set here.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';

export function BottomSheet({
  visible,
  onClose,
  style,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const { height: windowHeight } = useWindowDimensions();
  const shown = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);
  const [sheetHeight, setSheetHeight] = useState(windowHeight);
  useEffect(() => {
    if (visible) setMounted(true);
    const animation = Animated.timing(shown, {
      toValue: visible ? 1 : 0,
      duration: visible ? OPEN_MS : CLOSE_MS,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
    return () => animation.stop();
  }, [shown, visible]);
  const translateY = shown.interpolate({ inputRange: [0, 1], outputRange: [sheetHeight, 0] });
  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.scrim, { opacity: shown }]}>
        <Pressable style={styles.fill} onPress={onClose} accessibilityLabel="Close" />
      </Animated.View>
      <Animated.View
        onLayout={(e) => setSheetHeight(e.nativeEvent.layout.height)}
        style={[styles.sheet, style, { transform: [{ translateY }] }]}
      >
        {children}
      </Animated.View>
    </Modal>
  );
}

const OPEN_MS = 280;
const CLOSE_MS = 220;

const styles = StyleSheet.create({
  // Behind the sheet, to the bottom of the screen, so the sheet's rounded corners show it.
  scrim: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(10, 6, 4, 0.6)' },
  fill: { flex: 1 },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
});
