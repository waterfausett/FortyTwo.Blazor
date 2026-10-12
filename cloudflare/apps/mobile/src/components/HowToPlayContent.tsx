// The How to play copy (@fortytwo/client's HOW_TO_PLAY) for the rules screen. Domino examples use
// the table's Domino, upright in a wrapping row, read out as one label with their caption.
import { StyleSheet, Text, View } from 'react-native';
import { HOW_TO_PLAY } from '@fortytwo/client';
import { Domino } from './Domino';
import { colors, fonts } from './theme';

export function HowToPlayContent() {
  return (
    <View style={styles.content}>
      {HOW_TO_PLAY.map((section) => (
        <View key={section.id} style={styles.section}>
          <Text style={styles.title} accessibilityRole="header">
            {section.title}
          </Text>
          {section.blocks.map((block, i) =>
            block.kind === 'text' ? (
              <Text key={i} style={styles.text}>
                {block.text}
              </Text>
            ) : block.kind === 'list' ? (
              <View key={i} style={styles.list}>
                {block.items.map((item) => (
                  <View key={item} style={styles.item}>
                    <Text style={styles.text}>•</Text>
                    <Text style={[styles.text, styles.itemText]}>{item}</Text>
                  </View>
                ))}
              </View>
            ) : (
              <View
                key={i}
                style={styles.figure}
                accessible
                accessibilityLabel={`${block.caption} ${block.dominoes.map((d) => `${d.top}-${d.bottom}`).join(', ')}`}
              >
                <View style={styles.row}>
                  {block.dominoes.map((d) => (
                    <Domino key={`${d.top}-${d.bottom}`} top={d.top} bottom={d.bottom} width={26} accessible={false} />
                  ))}
                </View>
                <Text style={styles.caption}>{block.caption}</Text>
              </View>
            )
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: 28 },
  section: { gap: 10 },
  title: { color: colors.brass, fontFamily: fonts.display, fontSize: 22 },
  text: { color: colors.bone, fontFamily: fonts.ui, fontSize: 16, lineHeight: 23 },
  list: { gap: 6 },
  item: { flexDirection: 'row', gap: 8 },
  itemText: { flex: 1 },
  figure: { gap: 8, paddingVertical: 4 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  caption: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 14, lineHeight: 20 },
});
