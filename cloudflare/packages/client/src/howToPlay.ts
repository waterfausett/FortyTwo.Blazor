// The How to play copy, as data both apps render with their own components (web and mobile
// HowToPlayContent) - one copy, so the two can't drift. Everything here states what
// packages/rules does; howToPlay.test.ts checks the parts that can be checked.
import { LOW_TRUMPS, Suit, WINNING_SCORE, lowDoublesToPrettyString } from '@fortytwo/rules';

export type HowToPlayBlock =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'dominoes'; caption: string; dominoes: { top: number; bottom: number }[] };

export interface HowToPlaySection {
  id: string;
  title: string;
  blocks: HowToPlayBlock[];
}

// How doubles play under each Low trump, for the trump pickers, the doubles rule modal and the
// rules screen.
export const DOUBLES_DETAIL: Record<(typeof LOW_TRUMPS)[number], string> = {
  [Suit.Low]: 'Each double tops its suit',
  [Suit.LowDoublesLow]: 'Each double is the lowest of its suit',
  [Suit.LowDoublesOwnSuit]: 'Doubles form a suit, double-six highest',
};

const d = (top: number, bottom: number) => ({ top, bottom });

export const HOW_TO_PLAY: HowToPlaySection[] = [
  {
    id: 'game',
    title: 'The game',
    blocks: [
      {
        kind: 'text',
        text: 'Forty-Two is a trick-taking game for four players in two teams, played with a double-six set of 28 dominoes. Partners sit across the table from each other, so turns alternate between the teams.',
      },
      {
        kind: 'text',
        text: 'Each hand, everyone gets seven dominoes. The teams bid for the right to name trump, then play seven tricks. The bidding team has to take enough points to make its bid; the other team tries to stop them.',
      },
    ],
  },
  {
    id: 'suits',
    title: 'Suits and trump',
    blocks: [
      {
        kind: 'text',
        text: 'Each end of a domino is a suit, from blanks up to sixes, so most dominoes belong to two suits. The bidder names one suit as trump for the hand.',
      },
      {
        kind: 'list',
        items: [
          'A trump domino belongs only to trump. With sixes trump, the 6-4 is a six, never a four.',
          'Any other domino leads as its higher end: lead the 5-3 and fives are the suit led.',
          'A trump beats any domino of another suit, and a higher trump beats a lower one.',
        ],
      },
      {
        kind: 'dominoes',
        caption: 'With sixes trump, these seven are trump, highest first:',
        dominoes: [d(6, 6), d(6, 5), d(6, 4), d(6, 3), d(6, 2), d(6, 1), d(6, 0)],
      },
      {
        kind: 'text',
        text: 'Once the bid is 42 or more, the bidder may instead call Follow Me (no trump: only the suit led can win) or Low (see Doubles and Scoring).',
      },
    ],
  },
  {
    id: 'doubles',
    title: 'Doubles',
    blocks: [
      {
        kind: 'text',
        text: 'A double belongs to just one suit - the 4-4 is a four - and it is the highest domino of that suit.',
      },
      {
        kind: 'dominoes',
        caption: 'Fours, highest to lowest:',
        dominoes: [d(4, 4), d(6, 4), d(5, 4), d(4, 3), d(4, 2), d(4, 1), d(4, 0)],
      },
      { kind: 'text', text: 'When the bidder calls Low, they also choose how doubles play for that hand:' },
      {
        kind: 'list',
        items: LOW_TRUMPS.map((suit) => `Doubles ${lowDoublesToPrettyString(suit)}: ${DOUBLES_DETAIL[suit]}.`),
      },
    ],
  },
  {
    id: 'bidding',
    title: 'Bidding',
    blocks: [
      {
        kind: 'text',
        text: 'Bidding goes once around the table. Each player bids or passes once, and every bid has to beat the high bid so far.',
      },
      {
        kind: 'list',
        items: [
          '30 to 42: the points your team will take this hand. Worth 1 mark.',
          '84: worth 2 marks, and your team must take all 42 points.',
          '3 Marks to 7 Marks: all 42 points again, one rung at a time - 3 Marks only over a standing 84, 4 Marks only over 3 Marks, and so on.',
          'Plunge: needs four or more doubles in your hand, and only while the high bid is under 4 Marks. Worth 4 marks: your partner names trump - a suit or Follow Me, never Low - and your team must take every trick.',
          'Pass: no bid this hand. Everyone can’t pass - if the first three do, the last player has to bid.',
        ],
      },
      {
        kind: 'text',
        text: 'The high bidder names trump (on a Plunge, their partner does), and whoever names trump leads the first trick.',
      },
    ],
  },
  {
    id: 'counting',
    title: 'Counting dominoes',
    blocks: [
      { kind: 'text', text: 'Every hand is worth 42 points. Five dominoes carry points - the counters:' },
      {
        kind: 'dominoes',
        caption: '10 points each: 5-5 and 6-4. 5 points each: 5-0, 4-1 and 3-2.',
        dominoes: [d(5, 5), d(6, 4), d(5, 0), d(4, 1), d(3, 2)],
      },
      {
        kind: 'text',
        text: 'That’s 35 points in counters, plus 1 point for each of the seven tricks: 42 in all. The counters in a trick go to the team that wins it.',
      },
      {
        kind: 'text',
        text: 'The hand ends as soon as it’s decided: once the bidders have the points they bid, or the other team has taken enough that they can’t.',
      },
    ],
  },
  {
    id: 'tricks',
    title: 'Playing tricks',
    blocks: [
      {
        kind: 'list',
        items: [
          'Whoever won the last trick leads the next.',
          'Follow the suit led if you can. If you can’t, play anything - including a trump.',
          'The highest trump in the trick wins it. With no trump in it, the highest domino of the suit led wins.',
          'On Low the bidder’s partner sits out, so each trick has three dominoes.',
        ],
      },
    ],
  },
  {
    id: 'scoring',
    title: 'Scoring',
    blocks: [
      {
        kind: 'list',
        items: [
          'Make your bid and your team scores its marks: 1 for 30 to 42, 2 for 84, and so on. A Plunge is worth 4.',
          'Set the bidders and your team scores those marks instead.',
          'Low is lost the moment the bidder takes a trick, and made if they take none.',
          `The first team to ${WINNING_SCORE} marks wins the match.`,
        ],
      },
    ],
  },
];

// Whether to offer the Lobby's "New to 42?" card: only when the profile says the player hasn't
// seen the rules. Strict, so a profile still loading - or from a worker that doesn't know the
// setting, where dismissing it couldn't be saved - offers nothing.
export function shouldOfferHowToPlay(profile: { seenHowToPlay?: boolean } | undefined): boolean {
  return profile?.seenHowToPlay === false;
}
