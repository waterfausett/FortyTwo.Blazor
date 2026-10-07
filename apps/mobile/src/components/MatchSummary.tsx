// The match-over summary, as on the web (apps/web/src/components/MatchSummary.tsx): who won, each
// team with its final marks, every hand played, and the way on - back to the lobby, or a rematch
// with the same four once everyone asks for one (or the way to it, once it exists). Everything
// comes from the MatchState the screen already holds.
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { playedHands } from '@fortytwo/client';
import {
  Teams,
  bidToPrettyString,
  matchScores,
  rematchAgreed,
  suitToPrettyString,
  teamForPosition,
  type MatchState,
} from '@fortytwo/rules';
import { colors, fonts } from './theme';

export interface MatchSummaryProps {
  visible: boolean;
  match: MatchState;
  myTeam: Teams;
  nameFor: (playerId: string | null) => string;
  iVoted: boolean;
  rematchDisabled: boolean;
  onRematch: () => void;
  onGoToRematch: () => void;
  onLobby: () => void;
  onClose: () => void;
}

export function MatchSummary({
  visible,
  match,
  myTeam,
  nameFor,
  iVoted,
  rematchDisabled,
  onRematch,
  onGoToRematch,
  onLobby,
  onClose,
}: MatchSummaryProps) {
  const insets = useSafeAreaInsets();
  const theirTeam = myTeam === Teams.TeamA ? Teams.TeamB : Teams.TeamA;
  const scores = matchScores(match);
  const namesOn = (team: Teams) =>
    match.players
      .filter((p) => teamForPosition(p.position) === team)
      .map((p) => nameFor(p.playerId))
      .join(' & ');
  const agreed = rematchAgreed(match).length;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.sheet, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            {match.winningTeam === myTeam ? 'You won the match' : 'They won the match'}
          </Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={12}>
            <Text style={styles.close}>×</Text>
          </Pressable>
        </View>

        <View style={styles.teams}>
          <TeamTotal names={namesOn(myTeam)} marks={scores[myTeam] ?? 0} color={colors.us} label="Us" />
          <TeamTotal names={namesOn(theirTeam)} marks={scores[theirTeam] ?? 0} color={colors.them} label="Them" />
        </View>

        <ScrollView style={styles.hands} contentContainerStyle={styles.handsContent}>
          {playedHands(match).map(({ game, winner, made, marks }) => (
            <View
              key={game.id}
              style={[styles.hand, { borderLeftColor: winner === myTeam ? colors.us : colors.them }]}
              accessibilityLabel={`${game.name}: ${nameFor(game.biddingPlayerId)} bid ${
                game.bid == null ? 'nothing' : bidToPrettyString(game.bid)
              }, ${made ? 'made' : 'set'}, ${marks} ${marks === 1 ? 'mark' : 'marks'}`}
            >
              <View style={styles.handMain}>
                <Text style={styles.handName}>{game.name}</Text>
                <Text style={styles.handDetail} numberOfLines={1}>
                  {nameFor(game.biddingPlayerId)}
                  {game.bid != null ? ` · ${bidToPrettyString(game.bid)}` : ''}
                  {game.trump != null ? ` · ${suitToPrettyString(game.trump)}` : ''}
                </Text>
              </View>
              <Text style={[styles.result, { color: winner === myTeam ? colors.us : colors.them }]}>
                {made ? 'Made' : 'Set'} +{marks}
              </Text>
            </View>
          ))}
        </ScrollView>

        <View style={styles.actions}>
          <Pressable style={[styles.button, styles.secondary]} onPress={onLobby} accessibilityRole="button">
            <Text style={styles.secondaryText}>Back to lobby</Text>
          </Pressable>
          {match.rematchId ? (
            <Pressable style={styles.button} onPress={onGoToRematch} accessibilityRole="button">
              <Text style={styles.buttonText}>Go to rematch</Text>
            </Pressable>
          ) : (
            <Pressable
              style={[styles.button, (iVoted || rematchDisabled) && styles.disabled]}
              disabled={iVoted || rematchDisabled}
              onPress={onRematch}
              accessibilityRole="button"
            >
              <Text style={styles.buttonText}>
                {iVoted ? `Waiting (${agreed} of 4)` : agreed > 0 ? `Rematch (${agreed} of 4)` : 'Rematch'}
              </Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

function TeamTotal({ names, marks, color, label }: { names: string; marks: number; color: string; label: string }) {
  return (
    <View style={[styles.team, { borderColor: color }]} accessibilityLabel={`${label}: ${names}, ${marks} marks`}>
      <Text style={[styles.teamLabel, { color }]}>{label}</Text>
      <Text style={styles.teamNames} numberOfLines={2}>
        {names}
      </Text>
      <Text style={styles.teamMarks}>{marks}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.walnut, paddingHorizontal: 16, gap: 14 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.bone, fontFamily: fonts.display, fontSize: 28 },
  close: { color: colors.inkMuted, fontSize: 32, lineHeight: 34 },
  teams: { flexDirection: 'row', gap: 10 },
  team: { flex: 1, alignItems: 'center', gap: 2, padding: 12, borderRadius: 10, borderWidth: 2, backgroundColor: 'rgba(20, 13, 9, 0.45)' },
  teamLabel: { fontFamily: fonts.uiBold, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
  teamNames: { color: colors.bone, fontFamily: fonts.uiMedium, textAlign: 'center' },
  teamMarks: { color: colors.bone, fontFamily: fonts.display, fontSize: 36 },
  hands: { flex: 1 },
  handsContent: { gap: 6 },
  hand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderLeftWidth: 4,
    backgroundColor: 'rgba(20, 13, 9, 0.45)',
  },
  handMain: { flex: 1 },
  handName: { color: colors.bone, fontFamily: fonts.uiBold },
  handDetail: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  result: { fontFamily: fonts.uiBold },
  actions: { flexDirection: 'row', gap: 10 },
  button: { flex: 1, alignItems: 'center', backgroundColor: colors.brass, paddingVertical: 14, borderRadius: 8 },
  buttonText: { color: colors.walnutDeep, fontFamily: fonts.uiBold, fontSize: 16 },
  secondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.inkMuted },
  secondaryText: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  disabled: { opacity: 0.5 },
});
