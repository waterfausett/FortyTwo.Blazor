// How to play: the rules of Forty-Two (@fortytwo/client's HOW_TO_PLAY) with an index of its
// sections. Opening it counts as having seen the rules, so the Lobby stops offering them.
import { useEffect } from 'react';
import type { JSX } from 'react';
import { HOW_TO_PLAY } from '@fortytwo/client';
import { apiClient } from '../api/client';
import { useGetToken } from '../auth/useGetToken';
import { HowToPlayContent } from '../components/HowToPlayContent';
import { useHowToPlay } from '../match/useHowToPlay';

export function HowToPlay(): JSX.Element {
  const { offer, markSeen } = useHowToPlay(apiClient(useGetToken()));

  // Once the profile says "not seen" - it may still be loading when the page opens.
  useEffect(() => {
    if (offer) markSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer]);

  return (
    <div className="how-to-play-page">
      <h1 className="page-title">How to play</h1>
      <nav aria-label="Sections" className="how-to-play-index">
        {HOW_TO_PLAY.map((section) => (
          <a key={section.id} href={`#how-to-play-${section.id}`}>
            {section.title}
          </a>
        ))}
      </nav>
      <HowToPlayContent />
    </div>
  );
}
