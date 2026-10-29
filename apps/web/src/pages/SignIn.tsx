// The signed-out home, shown by AuthGate: the five count dominoes dealt into a fan, what the game
// is, and Sign in. Like the mobile app's sign-in screen (apps/mobile/src/app/sign-in.tsx).
import type { CSSProperties, JSX } from 'react';
import { Domino } from '../components/Domino.tsx';
import './SignIn.css';

// The count dominoes: 35 points between them, and the 7 tricks make 42.
const FAN = [
  { top: 5, bottom: 5 },
  { top: 6, bottom: 4 },
  { top: 5, bottom: 0 },
  { top: 4, bottom: 1 },
  { top: 3, bottom: 2 },
];

const FEATURES = [
  'Play with friends, rivals, or AI 🤖',
  'Live tables, or turns at your own pace',
  'Keep track of your stats and the folks you play with',
];

export function SignIn({ onSignIn, signingIn }: { onSignIn: () => void; signingIn: boolean }): JSX.Element {
  const middle = (FAN.length - 1) / 2;
  return (
    <main className="sign-in">
      <div className="sign-in-hero">
        <div
          className="sign-in-fan"
          role="img"
          aria-label="The five count dominoes: 5-5, 6-4, 5-0, 4-1 and 3-2"
        >
          {FAN.map((tile, i) => (
            // SignIn.css places each tile from its offset from the middle one.
            <div key={i} className="sign-in-fan-tile" style={{ '--i': i, '--offset': i - middle } as CSSProperties}>
              <Domino top={tile.top} bottom={tile.bottom} direction="vertical" />
            </div>
          ))}
        </div>
        <div className="sign-in-heading">
          <h1 className="sign-in-title">Forty-Two</h1>
          <p className="sign-in-tagline">The Texas domino game, at a table for four.<br />Pull up a chair.</p>
        </div>
      </div>

      <ul className="sign-in-features">
        {FEATURES.map((feature) => (
          <li key={feature}>{feature}</li>
        ))}
      </ul>

      <button type="button" className="action-button sign-in-button" onClick={onSignIn} disabled={signingIn}>
        {signingIn ? 'Signing in…' : 'Sign in'}
      </button>
    </main>
  );
}
