// The Live search lobby's card: tips and the player's own stats, one page at a time, with a
// sliding row of dots underneath (lobbyDots). It moves on by itself every LOBBY_CARD_MS - unless reduce motion is on, a finger is
// on it, or the player swiped it lately - and the player can swipe it either way. Its paging is
// never announced: there's no live region here.
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { LOBBY_CARD_MS, lobbyDots, type LobbyCard } from '@fortytwo/client';
import { colors, fonts } from './theme';

export function LobbyCarousel({ cards }: { cards: LobbyCard[] }) {
  const scroller = useRef<ScrollView>(null);
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(0);
  const [reduced, setReduced] = useState(true);
  const touching = useRef(false);
  const dragging = useRef(false);
  const swipedAt = useRef(0);
  const pageRef = useRef(0);
  useEffect(() => {
    pageRef.current = page;
  }, [page]);
  const count = cards.length;

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((r) => {
        if (!cancelled) setReduced(r);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (reduced || count < 2) return;
    const timer = setInterval(() => {
      if (touching.current || Date.now() - swipedAt.current < LOBBY_CARD_MS) return;
      const next = (pageRef.current + 1) % count;
      scroller.current?.scrollTo({ x: next * width, animated: true });
      setPage(next);
    }, LOBBY_CARD_MS);
    return () => clearInterval(timer);
  }, [reduced, count, width]);

  function settled(e: NativeSyntheticEvent<NativeScrollEvent>) {
    if (width === 0) return;
    setPage(Math.round(e.nativeEvent.contentOffset.x / width));
    if (dragging.current) swipedAt.current = Date.now();
    dragging.current = false;
  }

  return (
    <View style={styles.wrap}>
      <ScrollView
        ref={scroller}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onTouchStart={() => (touching.current = true)}
        onTouchEnd={() => (touching.current = false)}
        onTouchCancel={() => (touching.current = false)}
        onScrollBeginDrag={() => (dragging.current = true)}
        onMomentumScrollEnd={settled}
        style={styles.card}
      >
        {cards.map((card, i) => (
          <View key={i} style={[styles.page, { width: width || undefined }]}>
            <CardPage card={card} />
          </View>
        ))}
      </ScrollView>
      {count > 1 && (
        <View style={styles.dots}>
          {lobbyDots(count, page % count).map(({ index: i, size }) => (
            <View
              key={i}
              style={[styles.dot, size !== 'full' && styles[size], i === page % count && styles.dotOn]}
              accessible
              accessibilityLabel={`Card ${i + 1} of ${count}`}
              accessibilityState={{ selected: i === page % count }}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function CardPage({ card }: { card: LobbyCard }) {
  if (card.kind === 'tip') {
    return (
      <>
        <Text style={styles.label}>Did you know</Text>
        <Text style={styles.tip}>{card.text}</Text>
      </>
    );
  }
  return (
    <>
      <Text style={styles.label}>Your stats</Text>
      {card.kind === 'summary' ? (
        <View style={styles.summary}>
          {card.items.map((item) => (
            <View key={item.label} style={styles.figure}>
              <Text style={styles.value}>{item.value}</Text>
              <Text style={styles.hint}>{item.label}</Text>
            </View>
          ))}
        </View>
      ) : (
        <View>
          <Text style={styles.hint}>{card.kind === 'favoriteTrump' ? 'Favorite trump' : 'Best partner'}</Text>
          <Text style={styles.headline}>{card.kind === 'favoriteTrump' ? card.trump : card.name}</Text>
          <Text style={styles.hint}>{card.record}</Text>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  card: { backgroundColor: colors.mat, borderRadius: 10, flexGrow: 0 },
  page: { padding: 14, minHeight: 104, gap: 6 },
  label: { color: colors.brass, fontFamily: fonts.uiBold, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase' },
  tip: { color: colors.bone, fontFamily: fonts.ui, fontSize: 15, lineHeight: 21 },
  summary: { flexDirection: 'row', gap: 8 },
  figure: { flex: 1, alignItems: 'center' },
  value: { color: colors.bone, fontFamily: fonts.display, fontSize: 24 },
  headline: { color: colors.bone, fontFamily: fonts.display, fontSize: 20 },
  hint: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.matLight },
  small: { transform: [{ scale: 0.7 }] },
  tiny: { transform: [{ scale: 0.45 }] },
  dotOn: { backgroundColor: colors.brass },
});
