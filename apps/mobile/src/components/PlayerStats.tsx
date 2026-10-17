// The Profile's Stats section: the player's own record from completed matches, filtered to All,
// Humans only or With bots, as on the web. The figures and their wording come from
// @fortytwo/client's statSections. Loads on its own, so a failure here leaves the settings working.
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { StatsFilter } from '@fortytwo/api-types';
import { bestPartnerRecord, favoriteTrumpRecord, statSections, STATS_FILTERS, trumpLabel } from '@fortytwo/client';
import { useStats } from '@/api/useStats';
import { colors, fonts } from './theme';

export function PlayerStats() {
  const stats = useStats();
  const [filter, setFilter] = useState<StatsFilter>('all');
  const summary = stats.data?.[filter];

  return (
    <View style={styles.section}>
      <Text style={styles.title}>Stats</Text>

      {stats.isLoading && <ActivityIndicator color={colors.brass} />}
      {stats.error && <Text style={styles.error}>{stats.error.message}</Text>}
      {stats.data && stats.data.all.played === 0 && <Text style={styles.hint}>Finish a match to see your stats here.</Text>}

      {stats.data && stats.data.all.played > 0 && summary && (
        <>
          <View style={styles.filters} accessibilityRole="radiogroup">
            {STATS_FILTERS.map(({ filter: value, label }) => {
              const selected = filter === value;
              return (
                <Pressable
                  key={value}
                  onPress={() => setFilter(value)}
                  style={[styles.filter, selected && styles.filterSelected]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  accessibilityLabel={label}
                >
                  <Text style={[styles.filterText, selected && styles.filterTextSelected]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>

          {statSections(summary).map((section) => (
            <View key={section.key} style={styles.group}>
              <Text style={styles.groupTitle} accessibilityRole="header">
                {section.title}
              </Text>
              <View style={styles.grid}>
                {section.tiles.map(({ label, value }) => (
                  <View key={label} style={styles.tile} accessible accessibilityLabel={`${label}: ${value}`}>
                    <Text style={styles.value}>{value}</Text>
                    <Text style={styles.label}>{label}</Text>
                  </View>
                ))}
              </View>

              {section.key === 'matches' && summary.bestPartner && (
                <View style={styles.partner}>
                  <Text style={styles.hint}>Best partner</Text>
                  <Text style={styles.partnerName}>{summary.bestPartner.user.displayName}</Text>
                  <Text style={styles.hint}>{bestPartnerRecord(summary.bestPartner)}</Text>
                </View>
              )}

              {section.key === 'bidding' && summary.favoriteTrump && (
                <View style={styles.partner}>
                  <Text style={styles.hint}>Favorite trump</Text>
                  <Text style={styles.partnerName}>{trumpLabel(summary.favoriteTrump.trump)}</Text>
                  <Text style={styles.hint}>{favoriteTrumpRecord(summary.favoriteTrump, summary.bidsWon)}</Text>
                </View>
              )}
            </View>
          ))}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10, padding: 14, borderRadius: 10, backgroundColor: 'rgba(20, 13, 9, 0.45)' },
  title: { color: colors.bone, fontFamily: fonts.display, fontSize: 20 },
  hint: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  error: { color: colors.danger, fontFamily: fonts.ui, fontSize: 13 },
  filters: { flexDirection: 'row', gap: 6 },
  filter: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(242, 234, 219, 0.15)' },
  filterSelected: { backgroundColor: colors.brass, borderColor: colors.brass },
  filterText: { color: colors.inkMuted, fontFamily: fonts.uiBold, fontSize: 13 },
  filterTextSelected: { color: colors.walnutDeep },
  group: { gap: 8, marginTop: 4 },
  groupTitle: { color: colors.inkMuted, fontFamily: fonts.uiBold, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { width: '31%', paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, backgroundColor: 'rgba(20, 13, 9, 0.6)' },
  value: { color: colors.bone, fontFamily: fonts.display, fontSize: 20 },
  label: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 12 },
  partner: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  partnerName: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
});
