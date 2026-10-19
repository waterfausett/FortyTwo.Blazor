// What a finished Live match offers next: Party up with the partner, Find a game, and Rematch (as on
// the web, apps/web/src/components/MatchOverActions.tsx). The game screen stacks them; the summary
// sheet lays them in two rows beside its Lobby button. Rematch and Lobby come in as nodes because
// each screen already has its own (vote count, the way to the rematch once it exists); the state of
// the party button comes from endChoices.
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { EndChoices } from '@fortytwo/client';
import { colors, fonts } from './theme';

export interface MatchOverActionsProps {
  choices: EndChoices;
  partnerName: string;
  layout: 'stack' | 'rows';
  rematch: ReactNode;
  lobby?: ReactNode;
  busy: boolean;
  onPartyUp: () => void;
  onCancelParty: () => void;
  onFindGame: () => void;
  // The stack reports how tall Party up and Find a game are together, so the game screen can let
  // them grow the panel upward without moving the hand.
  onExtraHeight?: (height: number) => void;
}

export function MatchOverActions({
  choices,
  partnerName,
  layout,
  rematch,
  lobby,
  busy,
  onPartyUp,
  onCancelParty,
  onFindGame,
  onExtraHeight,
}: MatchOverActionsProps) {
  const party = partyControl();
  // Once partied, these could only lead back to the new game, so it stands alone.
  const findGame = choices.showFindGame && (
    <Pressable
      style={[styles.button, styles.brass, busy && styles.disabled]}
      disabled={busy}
      onPress={onFindGame}
      accessibilityRole="button"
    >
      <Text style={styles.buttonText}>Find a game</Text>
    </Pressable>
  );

  if (layout === 'rows') {
    return (
      <View style={styles.rows}>
        <View style={styles.row}>
          {lobby}
          {choices.showRematch && rematch}
        </View>
        <View style={styles.row}>
          {findGame}
          {party}
        </View>
      </View>
    );
  }
  return (
    <View style={styles.stack}>
      <View style={styles.stack} onLayout={(e) => onExtraHeight?.(e.nativeEvent.layout.height)}>
        {choices.showRematch && party}
        {findGame}
      </View>
      {/* Without Rematch, the party's way to its new game takes Rematch's place. */}
      {choices.showRematch ? rematch : party}
    </View>
  );

  function partyControl(): ReactNode {
    const button = (label: string, onPress: (() => void) | null) => (
      <Pressable
        style={[styles.button, styles.team, (onPress === null || busy) && styles.disabled]}
        disabled={onPress === null || busy}
        onPress={onPress ?? undefined}
        accessibilityRole="button"
      >
        <Text style={styles.buttonText}>{label}</Text>
      </Pressable>
    );
    const { party } = choices;
    switch (party.kind) {
      case 'hidden':
        return null;
      case 'offer':
        return button(party.partnerOffered ? `${partnerName} wants to party up ✓` : `Party up with ${partnerName}`, onPartyUp);
      case 'waiting':
        return button(`Waiting for ${partnerName}…`, onCancelParty);
      case 'partnerLeft':
        return button(`${partnerName} left`, null);
      case 'partnerBusy':
        return button(`${partnerName} is in another game`, null);
      case 'partied':
        return button('Go to your new game', () => router.replace(`/match/${party.matchId}`));
    }
  }
}

const styles = StyleSheet.create({
  stack: { alignSelf: 'stretch', gap: 8 },
  rows: { gap: 10 },
  row: { flexDirection: 'row', gap: 10 },
  button: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 12, borderRadius: 8 },
  brass: { backgroundColor: colors.brass },
  team: { backgroundColor: colors.us },
  buttonText: { color: colors.walnutDeep, fontFamily: fonts.uiBold, fontSize: 16, textAlign: 'center' },
  disabled: { opacity: 0.5 },
});
