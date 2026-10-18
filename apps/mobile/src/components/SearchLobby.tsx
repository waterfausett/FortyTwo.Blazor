// What a Live search shows in place of the table: who's online, the bar toward the bots taking the
// empty seats, who has sat down on each team, a card of tips and stats to read while waiting, and
// Start with bots / Cancel. When a seat fills it says so to a screen reader ("Maria joined, 2 of 4")
// - never the timer.
import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, Text, View, useAnimatedValue } from 'react-native';
import { fillProgress, formatClock, joinAnnouncement, rosterIds, type LobbyCard, type LobbyRoster } from '@fortytwo/client';
import { LobbyCarousel } from './LobbyCarousel';
import { NameSkeleton } from './NameSkeleton';
import { colors, fonts } from './theme';

const PULSE_MS = 1600;

export function SearchLobby({
  roster,
  viewerId,
  nameOf,
  online,
  elapsedMs,
  full,
  cards,
  onStartWithBots,
  startDisabled,
  onCancel,
  cancelDisabled,
}: {
  roster: LobbyRoster;
  viewerId: string;
  // null while the name loads.
  nameOf: (playerId: string) => string | null;
  online: number | null;
  // null without bots: there's no fill to count down to.
  elapsedMs: number | null;
  full: boolean;
  cards: LobbyCard[];
  onStartWithBots: (() => void) | null;
  startDisabled: boolean;
  onCancel: () => void;
  cancelDisabled: boolean;
}) {
  const ids = rosterIds(roster);
  const previous = useRef(ids);
  useEffect(() => {
    // A newcomer's name is looked up after they sit down: wait for it, so they're announced by name.
    if (ids.some((id) => id !== null && nameOf(id) === null)) return;
    const message = joinAnnouncement(previous.current, ids, nameOf);
    previous.current = ids;
    if (message) AccessibilityInfo.announceForAccessibility(message);
  });

  const progress = elapsedMs === null ? null : fillProgress(elapsedMs);
  const row = (playerId: string | null, partnerSeat: boolean) => (
    <RosterRow
      key={partnerSeat ? 'partner' : undefined}
      playerId={playerId}
      you={playerId !== null && playerId === viewerId}
      name={playerId === null ? null : nameOf(playerId)}
      emptyText={partnerSeat && roster.seated ? 'Partner · searching…' : 'Searching…'}
    />
  );

  return (
    <View style={styles.lobby}>
      <View style={styles.heading}>
        <Text style={styles.title} accessibilityRole="header">
          Finding players
        </Text>
        {online !== null && <Online count={online} />}
      </View>

      {full ? (
        <Text style={styles.full}>Table full</Text>
      ) : (
        progress && (
          <View style={styles.barRow}>
            <View style={styles.bar}>
              <View style={[styles.barFill, { width: `${progress.fraction * 100}%` }]} />
            </View>
            <Text style={styles.barEnd}>{`${formatClock(progress.remainingMs)} 🤖`}</Text>
          </View>
        )
      )}

      <View style={styles.roster}>
        <Text style={[styles.group, { color: colors.us }]}>Us</Text>
        {row(roster.us[0], false)}
        {row(roster.us[1], true)}
        <Text style={styles.vs}>vs</Text>
        <Text style={[styles.group, { color: colors.them }]}>Them</Text>
        {row(roster.them[0], false)}
        {row(roster.them[1], false)}
      </View>

      <LobbyCarousel cards={cards} />

      <View style={styles.buttons}>
        {onStartWithBots && (
          <Pressable
            style={[styles.button, styles.startButton, startDisabled && styles.disabled]}
            disabled={startDisabled}
            onPress={onStartWithBots}
            accessibilityRole="button"
          >
            <Text style={styles.startText}>Start with bots</Text>
          </Pressable>
        )}
        <Pressable
          style={[styles.button, styles.cancelButton, cancelDisabled && styles.disabled]}
          disabled={cancelDisabled}
          onPress={onCancel}
          accessibilityRole="button"
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

function RosterRow({ playerId, you, name, emptyText }: { playerId: string | null; you: boolean; name: string | null; emptyText: string }) {
  if (playerId === null) {
    return (
      <View style={[styles.row, styles.emptyRow]}>
        <Pulse style={styles.emptyPulse} />
        <View style={[styles.avatar, styles.emptyAvatar]}>
          <Text style={styles.emptyInitial}>?</Text>
        </View>
        <Text style={styles.emptyText}>{emptyText}</Text>
      </View>
    );
  }
  return (
    <View style={[styles.row, you && styles.youRow]}>
      <View style={styles.avatar}>
        <Text style={styles.initial}>{you ? 'Y' : (name?.trim()[0]?.toUpperCase() ?? '')}</Text>
      </View>
      {you ? (
        <Text style={styles.name}>You</Text>
      ) : name !== null ? (
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
      ) : (
        <NameSkeleton width={120} />
      )}
    </View>
  );
}

function Online({ count }: { count: number }) {
  return (
    <View style={styles.online}>
      <Pulse style={styles.onlineDot} />
      <Text style={styles.onlineText}>{`${count} online`}</Text>
    </View>
  );
}

// Fades in and out, gently, unless reduce motion is on - then it stays at full strength.
function Pulse({ style }: { style: object }) {
  const opacity = useAnimatedValue(1);
  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduced) => {
        if (cancelled || reduced) return;
        const half = { duration: PULSE_MS / 2, easing: Easing.inOut(Easing.sin), useNativeDriver: true };
        loop = Animated.loop(
          Animated.sequence([Animated.timing(opacity, { ...half, toValue: 0.3 }), Animated.timing(opacity, { ...half, toValue: 1 })])
        );
        loop.start();
      });
    return () => {
      cancelled = true;
      loop?.stop();
    };
  }, [opacity]);
  return <Animated.View pointerEvents="none" style={[style, { opacity }]} />;
}

const styles = StyleSheet.create({
  lobby: { flexGrow: 1, gap: 12 },
  heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  title: { color: colors.bone, fontFamily: fonts.display, fontSize: 26 },
  online: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  onlineDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.ok },
  onlineText: { color: colors.ok, fontFamily: fonts.uiMedium, fontSize: 14 },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bar: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.mat, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: colors.brass },
  barEnd: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  full: { color: colors.brass, fontFamily: fonts.uiBold, fontSize: 15 },
  roster: { gap: 8 },
  group: { fontFamily: fonts.uiBold, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', marginTop: 2 },
  vs: { color: colors.inkMuted, fontFamily: fonts.display, fontSize: 14, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: colors.mat },
  youRow: { borderLeftWidth: 3, borderLeftColor: colors.us, paddingLeft: 9 },
  emptyRow: { backgroundColor: 'transparent', borderWidth: 1, borderStyle: 'dashed', borderColor: `${colors.boneEdge}55` },
  emptyPulse: { position: 'absolute', top: -1, left: -1, right: -1, bottom: -1, borderRadius: 8, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.brass },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.walnutDeep, alignItems: 'center', justifyContent: 'center' },
  emptyAvatar: { backgroundColor: 'transparent', borderWidth: 1, borderStyle: 'dashed', borderColor: `${colors.boneEdge}55` },
  initial: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  emptyInitial: { color: colors.inkMuted, fontFamily: fonts.uiBold, fontSize: 16 },
  name: { flex: 1, color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  emptyText: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 16 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 'auto', paddingTop: 4 },
  button: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 8 },
  startButton: { backgroundColor: colors.brass },
  startText: { color: colors.ink, fontFamily: fonts.uiBold, fontSize: 16 },
  cancelButton: { borderWidth: 1, borderColor: colors.danger },
  cancelText: { color: colors.danger, fontFamily: fonts.uiBold, fontSize: 16 },
  disabled: { opacity: 0.5 },
});
