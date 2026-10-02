// Must run before anything that calls crypto.getRandomValues (react-native-auth0's PKCE, and
// @fortytwo/rules' shuffle should it ever run on the device).
import 'react-native-get-random-values';
// Each weight from its own module: the packages' main entries pull in every weight and style.
import { Barlow_400Regular } from '@expo-google-fonts/barlow/400Regular';
import { Barlow_500Medium } from '@expo-google-fonts/barlow/500Medium';
import { Barlow_600SemiBold } from '@expo-google-fonts/barlow/600SemiBold';
import { useFonts } from '@expo-google-fonts/barlow/useFonts';
import { ZillaSlab_700Bold } from '@expo-google-fonts/zilla-slab/700Bold';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, router, usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Auth0Provider, useAuth0 } from 'react-native-auth0';
import { colors, fonts } from '@/components/theme';
import { ToastHost } from '@/components/ToastHost';
import { config } from '@/config';
import { setSignedIn, takePendingLink } from '@/linking/incomingLink';

const queryClient = new QueryClient();

// The splash (the domino on walnut, from app.json) stays up until the fonts are loaded and any
// stored session is restored, so launching goes straight from it to the app with no spinner.
SplashScreen.preventAutoHideAsync().catch(() => {});
SplashScreen.setOptions({ duration: 200, fade: true });

function RootStack() {
  const { user, isLoading } = useAuth0();
  // The web app's fonts (components/theme.ts). A font that fails to load falls back to the
  // system font rather than blocking the app.
  const [fontsLoaded, fontError] = useFonts({ Barlow_400Regular, Barlow_500Medium, Barlow_600SemiBold, ZillaSlab_700Bold });
  const signedIn = user != null;
  const ready = !isLoading && (fontsLoaded || fontError != null);
  const pathname = usePathname();

  // A match link that arrived while signed out (src/linking/incomingLink.ts) opens once the
  // player has signed in - unless the router already opened it, as it does at launch when the
  // stored session turns out to be signed in.
  setSignedIn(signedIn);
  useEffect(() => {
    if (!ready || !signedIn) return;
    const link = takePendingLink();
    if (link && link !== pathname) router.push(link);
  }, [ready, signedIn, pathname]);

  // Auth0Provider restores a stored session on launch: the splash waits for it rather than
  // flashing sign-in.
  useEffect(() => {
    if (ready) SplashScreen.hide();
  }, [ready]);

  // Behind the splash, which is the same walnut.
  if (!ready) return <View style={styles.loading} />;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.walnutDeep },
        headerTintColor: colors.bone,
        headerTitleStyle: { fontFamily: fonts.display },
        contentStyle: { backgroundColor: colors.walnut },
      }}
    >
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="index" options={{ title: 'Matches' }} />
        <Stack.Screen name="match/[id]" options={{ title: 'Match' }} />
        <Stack.Screen name="profile" options={{ title: 'Profile' }} />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    // DPoP is off: the Worker verifies plain bearer tokens and has no way to check a DPoP proof,
    // which a WebSocket upgrade couldn't carry anyway.
    <Auth0Provider domain={config.auth0Domain} clientId={config.auth0ClientId} useDPoP={false}>
      <QueryClientProvider client={queryClient}>
        <RootStack />
        <ToastHost />
      </QueryClientProvider>
    </Auth0Provider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, backgroundColor: colors.walnut },
});
