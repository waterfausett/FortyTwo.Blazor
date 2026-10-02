// The player's profile, as on the web profile page: the name the table calls them, a picture URL
// with a live preview, their email (read-only), and their game settings. Name and picture save
// together with the button; a setting saves as soon as it's flipped. All of it is stored on their
// profile, so it applies on the web too.
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useProfile, useSaveProfile } from '@/api/useProfile';
import { MAX_DISPLAY_NAME_LENGTH, profileErrors } from '@/components/profileErrors';
import { colors, fonts } from '@/components/theme';

export default function Profile() {
  const profile = useProfile();
  const save = useSaveProfile();
  const insets = useSafeAreaInsets();

  const [displayName, setDisplayName] = useState('');
  const [picture, setPicture] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  // Fill the fields once, from the profile as stored - but leave them alone after that, so a
  // refetch doesn't overwrite what the player is typing. The picture field holds only their own
  // custom picture; blank means their account's.
  useEffect(() => {
    if (!profile.data || loaded) return;
    setDisplayName(profile.data.displayName);
    setPicture(profile.data.user_metadata?.picture ?? '');
    setLoaded(true);
  }, [profile.data, loaded]);

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

  const errors = profileErrors(displayName, picture);
  const preview = picture.trim() !== '' ? picture.trim() : profile.data.picture;
  const changed =
    displayName.trim() !== profile.data.displayName || picture.trim() !== (profile.data.user_metadata?.picture ?? '');

  function submit() {
    setJustSaved(false);
    save.mutate(
      { displayName: displayName.trim(), picture: picture.trim() },
      {
        onSuccess: () => {
          setJustSaved(true);
          setTimeout(() => setJustSaved(false), 1750);
        },
      }
    );
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[styles.container, { paddingBottom: 32 + insets.bottom }]} keyboardShouldPersistTaps="handled">
        <View style={styles.plate}>
          {preview ? (
            <Image source={{ uri: preview }} style={styles.picture} accessibilityLabel="Profile picture preview" />
          ) : (
            <View style={[styles.picture, styles.pictureEmpty]}>
              <Text style={styles.initial}>{(displayName.trim()[0] ?? '?').toUpperCase()}</Text>
            </View>
          )}
          <View style={styles.plateText}>
            <Text style={styles.plateName} numberOfLines={1}>
              {displayName.trim() || 'No display name'}
            </Text>
            <Text style={styles.hint} numberOfLines={1}>
              {profile.data.email}
            </Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Display name</Text>
          <TextInput
            style={styles.input}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="What the table calls you"
            placeholderTextColor={colors.inkMuted}
            maxLength={MAX_DISPLAY_NAME_LENGTH}
            autoCorrect={false}
            accessibilityLabel="Display name"
          />

          <Text style={styles.label}>Picture URL</Text>
          <TextInput
            style={styles.input}
            value={picture}
            onChangeText={setPicture}
            placeholder="Your account picture"
            placeholderTextColor={colors.inkMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel="Picture URL"
          />

          {errors.map((e) => (
            <Text key={e} style={styles.error}>
              {e}
            </Text>
          ))}

          <View style={styles.saveRow}>
            <Pressable
              style={[styles.button, (!changed || errors.length > 0 || save.isPending) && styles.disabled]}
              disabled={!changed || errors.length > 0 || save.isPending}
              onPress={submit}
              accessibilityRole="button"
            >
              <Text style={styles.buttonText}>{save.isPending ? 'Saving…' : 'Save changes'}</Text>
            </Pressable>
            {justSaved && <Text style={styles.saved}>Saved</Text>}
          </View>
        </View>

        <View style={[styles.section, styles.row]}>
          <View style={styles.rowText}>
            <Text style={styles.settingLabel}>Highlight playable dominoes</Text>
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

        <Text style={styles.note}>Your profile and settings apply on the web too.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.walnut },
  container: { padding: 16, gap: 14 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.walnut },
  plate: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  picture: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.mat },
  pictureEmpty: { alignItems: 'center', justifyContent: 'center' },
  initial: { color: colors.bone, fontFamily: fonts.display, fontSize: 28 },
  plateText: { flex: 1 },
  plateName: { color: colors.bone, fontFamily: fonts.display, fontSize: 22 },
  section: { gap: 8, padding: 14, borderRadius: 10, backgroundColor: 'rgba(20, 13, 9, 0.45)' },
  label: { color: colors.inkMuted, fontFamily: fonts.uiBold, fontSize: 13 },
  input: {
    color: colors.bone,
    fontFamily: fonts.uiMedium,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(20, 13, 9, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(242, 234, 219, 0.1)',
  },
  error: { color: colors.danger, fontFamily: fonts.ui, fontSize: 13 },
  saveRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  button: { backgroundColor: colors.brass, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 8 },
  buttonText: { color: colors.walnutDeep, fontFamily: fonts.uiBold, fontSize: 16 },
  disabled: { opacity: 0.5 },
  saved: { color: colors.ok, fontFamily: fonts.uiBold },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowText: { flex: 1, gap: 2 },
  settingLabel: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  hint: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  note: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 12, textAlign: 'center' },
});
