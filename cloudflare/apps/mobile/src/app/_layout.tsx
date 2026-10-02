// Must run before anything that calls crypto.getRandomValues (react-native-auth0's PKCE, and
// @fortytwo/rules' shuffle should it ever run on the device).
import 'react-native-get-random-values';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Auth0Provider, useAuth0 } from 'react-native-auth0';
import { config } from '@/config';

const queryClient = new QueryClient();

function RootStack() {
  const { user, isLoading } = useAuth0();

  // Auth0Provider restores a stored session on launch; wait for it rather than flashing sign-in.
  if (isLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  const signedIn = user != null;
  return (
    <Stack>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="index" options={{ title: 'Matches' }} />
        <Stack.Screen name="match/[id]" options={{ title: 'Match' }} />
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
      </QueryClientProvider>
    </Auth0Provider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
