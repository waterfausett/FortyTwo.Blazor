// Shows the toasts from ./toast: a walnut card edged in danger (errors) or brass (notices), with a
// bar that runs down as it times out. Tap a toast, or its ×, to dismiss it early. Rendered once,
// over everything, in the root layout; touches pass through to the screen except on a toast.
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts } from './theme';
import { TOAST_DURATION_MS, dismissToast, subscribeToasts, type Toast } from './toast';

// Roughly the navigation header's height, so a top toast sits just below it.
const HEADER_HEIGHT = 56;

export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const insets = useSafeAreaInsets();
  useEffect(() => subscribeToasts(setToasts), []);

  const top = toasts.filter((t) => t.position === 'top');
  const center = toasts.filter((t) => t.position === 'center');
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <View pointerEvents="box-none" style={[styles.stack, { top: insets.top + HEADER_HEIGHT + 8 }]}>
        {top.map((t) => (
          <ToastCard key={t.id} toast={t} />
        ))}
      </View>
      <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, styles.center]}>
        {center.map((t) => (
          <ToastCard key={t.id} toast={t} />
        ))}
      </View>
    </View>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const appear = useRef(new Animated.Value(0)).current;
  const timeLeft = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(appear, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    // A transform, run on the native side: animating the bar's width instead would make every
    // frame re-lay-out the whole screen, which shows as the hand at the bottom jiggling.
    Animated.timing(timeLeft, {
      toValue: 0,
      duration: TOAST_DURATION_MS,
      easing: Easing.linear,
      useNativeDriver: true,
    }).start();
  }, [appear, timeLeft]);

  const edge = toast.kind === 'error' ? colors.danger : colors.brass;
  return (
    <Animated.View
      style={[
        styles.card,
        { borderLeftColor: edge },
        {
          opacity: appear,
          transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) }],
        },
      ]}
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
    >
      <Pressable style={styles.body} onPress={() => dismissToast(toast.id)} accessibilityHint="Dismisses this message">
        <View style={styles.text}>
          <Text style={styles.title}>{toast.title}</Text>
          {toast.detail.length > 0 && (
            <Text style={styles.detail}>
              {toast.detail.map((part, i) => (
                <Text key={i} style={part.emphasis ? styles.emphasis : undefined}>
                  {part.text}
                </Text>
              ))}
            </Text>
          )}
        </View>
        <Text style={styles.close} accessibilityLabel="Dismiss">
          ×
        </Text>
      </Pressable>
      <Animated.View
        style={[
          styles.timer,
          // Shrinks toward the left edge as time runs out.
          { backgroundColor: edge, transformOrigin: 'left', transform: [{ scaleX: timeLeft }] },
        ]}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  stack: { position: 'absolute', left: 12, right: 12, gap: 8 },
  center: { alignItems: 'stretch', justifyContent: 'center', paddingHorizontal: 24, gap: 8 },
  card: {
    overflow: 'hidden',
    borderRadius: 8,
    borderLeftWidth: 4,
    borderWidth: 1,
    borderColor: 'rgba(242, 234, 219, 0.12)',
    backgroundColor: colors.walnutDeep,
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  body: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 10, paddingHorizontal: 12 },
  text: { flex: 1, gap: 2 },
  title: { color: colors.bone, fontFamily: fonts.display, fontSize: 16 },
  detail: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 14 },
  // The bid or suit a rule message names, picked out in brass as on the web.
  emphasis: { color: colors.brass, fontFamily: fonts.uiBold },
  close: { color: colors.inkMuted, fontSize: 20, lineHeight: 20 },
  timer: { height: 3, width: '100%', opacity: 0.6 },
});
