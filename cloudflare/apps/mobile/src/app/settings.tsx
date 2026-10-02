// The player's game settings. Saved to their profile, so they apply on the web app too.
import { ActivityIndicator, StyleSheet, Switch, Text, View } from 'react-native';
import { useProfile, useSaveProfile } from '@/api/useProfile';
import { colors, fonts } from '@/components/theme';

export default function Settings() {
  const profile = useProfile();
  const save = useSaveProfile();

  if (!profile.data) {
    return (
      <View style={styles.centered}>
        {profile.error ? (
          <Text style={styles.hint}>{profile.error.message}</Text>
        ) : (
          <ActivityIndicator size="large" color={colors.brass} />
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <View style={styles.text}>
          <Text style={styles.label}>Highlight playable dominoes</Text>
          <Text style={styles.hint}>On your turn, outline the dominoes you can play and fade the rest.</Text>
        </View>
        <Switch
          value={profile.data.highlightPlayable}
          onValueChange={(value) => save.mutate({ highlightPlayable: value })}
          trackColor={{ true: colors.brass, false: colors.mat }}
          thumbColor={colors.bone}
          accessibilityLabel="Highlight playable dominoes"
        />
      </View>
      <Text style={styles.note}>Settings are saved to your profile and apply on the web too.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12, backgroundColor: colors.walnut },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.walnut },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 10,
    backgroundColor: 'rgba(20, 13, 9, 0.45)',
  },
  text: { flex: 1, gap: 2 },
  label: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  hint: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  note: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 12, textAlign: 'center' },
});
