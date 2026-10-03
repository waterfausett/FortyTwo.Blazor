import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth0 } from 'react-native-auth0';
import { config } from '@/config';
import { colors, fonts } from '@/components/theme';

export default function SignIn() {
  const { authorize } = useAuth0();
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setError(null);
    try {
      // offline_access gets a refresh token, so the session survives app restarts and token
      // expiry without sending the player back through the login page.
      await authorize({ audience: config.auth0Audience, scope: 'openid profile email offline_access' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Forty-Two</Text>
      <Pressable style={styles.button} onPress={signIn} accessibilityRole="button">
        <Text style={styles.buttonText}>Sign in</Text>
      </Pressable>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24, backgroundColor: colors.walnut },
  title: { color: colors.bone, fontFamily: fonts.display, fontSize: 44 },
  button: { backgroundColor: colors.brass, paddingHorizontal: 36, paddingVertical: 14, borderRadius: 8 },
  buttonText: { color: colors.walnutDeep, fontFamily: fonts.uiBold, fontSize: 18 },
  error: { color: colors.danger, fontFamily: fonts.ui, textAlign: 'center' },
});
