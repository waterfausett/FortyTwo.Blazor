// The signed-out home: the five count dominoes dealt into a fan, what the game is, and Sign in.
import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, StyleSheet, Text, View, useAnimatedValue } from 'react-native';
import { useAuth0 } from 'react-native-auth0';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { config } from '@/config';
import { Domino } from '@/components/Domino';
import { Fade } from '@/components/Fade';
import { colors, fonts } from '@/components/theme';

// The count dominoes: 35 points between them, and the 7 tricks make 42.
const FAN = [
  { top: 5, bottom: 5 },
  { top: 6, bottom: 4 },
  { top: 5, bottom: 0 },
  { top: 4, bottom: 1 },
  { top: 3, bottom: 2 },
];
const TILE_WIDTH = 46;
// Degrees between neighbouring tiles, and how far apart their centres sit.
const FAN_STEP = 11;
const FAN_SPACING = 38;
const DEAL_MS = 420;
const DEAL_STAGGER_MS = 90;
// The rest of the screen fades in as the last tile lands.
const CONTENT_DELAY_MS = DEAL_STAGGER_MS * (FAN.length - 1) + DEAL_MS / 2;

const FEATURES = [
  'Play with friends, rivals, or AI 🤖',
  'Live tables, or turns at your own pace',
  'Keep track of your stats and the folks you play with',
];

function FanTile({ index, top, bottom }: { index: number; top: number; bottom: number }) {
  const dealt = useAnimatedValue(0);
  useEffect(() => {
    const animation = Animated.timing(dealt, {
      toValue: 1,
      duration: DEAL_MS,
      delay: index * DEAL_STAGGER_MS,
      easing: Easing.out(Easing.back(1.4)),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [dealt, index]);

  const middle = (FAN.length - 1) / 2;
  const offset = index - middle;
  // Each tile slides up from a stack below the fan, turning out to its place as it comes.
  const angle = dealt.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${offset * FAN_STEP}deg`] });
  const translateX = dealt.interpolate({ inputRange: [0, 1], outputRange: [0, offset * FAN_SPACING] });
  // The outer tiles sit a little lower, so the fan curves like a hand held up.
  const translateY = dealt.interpolate({ inputRange: [0, 1], outputRange: [60, Math.abs(offset) * Math.abs(offset) * 4] });
  const opacity = dealt.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 1, 1] });

  return (
    <Animated.View style={[styles.fanTile, { opacity, transform: [{ translateX }, { translateY }, { rotate: angle }] }]}>
      <Domino top={top} bottom={bottom} width={TILE_WIDTH} accessible={false} />
    </Animated.View>
  );
}

export default function SignIn() {
  const { authorize } = useAuth0();
  const insets = useSafeAreaInsets();
  const [error, setError] = useState<string | null>(null);
  // From the tap until the session is saved. After the login page closes, react-native-auth0
  // still swaps the code for tokens and stores them before it sets the user, which left the
  // Sign in button showing for a second or two. On success the screen goes away, so this is
  // only cleared on failure.
  const [signingIn, setSigningIn] = useState(false);

  async function signIn() {
    setError(null);
    setSigningIn(true);
    try {
      // offline_access gets a refresh token, so the session survives app restarts and token
      // expiry without sending the player back through the login page.
      await authorize({ audience: config.auth0Audience, scope: 'openid profile email offline_access' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSigningIn(false);
    }
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.hero}>
        <View style={styles.fan} accessible accessibilityLabel="The five count dominoes: 5-5, 6-4, 5-0, 4-1 and 3-2">
          {FAN.map((tile, i) => (
            <FanTile key={i} index={i} {...tile} />
          ))}
        </View>
        <Fade delay={CONTENT_DELAY_MS} style={styles.heading}>
          <Text style={styles.title} accessibilityRole="header">
            Forty-Two
          </Text>
          <Text style={styles.tagline}>{'The Texas domino game, at a table for four.\nPull up a chair.'}</Text>
        </Fade>
      </View>

      <Fade delay={CONTENT_DELAY_MS + 120} style={styles.features}>
        {FEATURES.map((feature) => (
          <View key={feature} style={styles.feature}>
            <View style={styles.bullet} />
            <Text style={styles.featureText}>{feature}</Text>
          </View>
        ))}
      </Fade>

      <Fade delay={CONTENT_DELAY_MS + 240} style={styles.actions}>
        {signingIn ? (
          <ActivityIndicator size="large" color={colors.brass} style={styles.spinner} accessibilityLabel="Signing in" />
        ) : (
          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
            onPress={signIn}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>Sign in</Text>
          </Pressable>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
      </Fade>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'space-between', paddingHorizontal: 28, backgroundColor: colors.walnut },
  hero: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 28 },
  // Tall enough for the tiles plus the dip of the outer ones; each tile is centred in it.
  fan: { height: TILE_WIDTH * 2 + 40, width: '100%', alignItems: 'center', justifyContent: 'center' },
  fanTile: { position: 'absolute' },
  heading: { alignItems: 'center', gap: 8 },
  title: { color: colors.bone, fontFamily: fonts.display, fontSize: 48 },
  tagline: { color: colors.inkMuted, fontFamily: fonts.uiMedium, fontSize: 17, textAlign: 'center' },
  features: {
    gap: 14,
    marginBottom: 20,
    alignSelf: 'center',
    width: '100%',
    maxWidth: 360,
    padding: 18,
    borderRadius: 12,
    backgroundColor: colors.mat,
  },
  feature: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  // A pip, in the brass of the button below.
  bullet: { width: 8, height: 8, borderRadius: 4, marginTop: 7, backgroundColor: colors.brass },
  featureText: { flex: 1, color: colors.bone, fontFamily: fonts.ui, fontSize: 16, lineHeight: 22 },
  actions: { alignItems: 'stretch', gap: 12, alignSelf: 'center', width: '100%', maxWidth: 360 },
  button: { backgroundColor: colors.brass, paddingVertical: 15, borderRadius: 10, alignItems: 'center' },
  buttonPressed: { opacity: 0.85, transform: [{ translateY: 1 }] },
  // The button's height, so nothing shifts when they swap.
  spinner: { height: 52 },
  buttonText: { color: colors.walnutDeep, fontFamily: fonts.uiBold, fontSize: 18 },
  error: { color: colors.danger, fontFamily: fonts.ui, textAlign: 'center' },
});
