// The How to play copy (@fortytwo/client's HOW_TO_PLAY), for the rules page and the in-match
// dialog. Domino examples use the table's own Domino, standing upright in a row, and are read out
// by name after their caption.
import type { JSX } from 'react';
import { HOW_TO_PLAY } from '@fortytwo/client';
import { Domino } from './Domino';
import './HowToPlay.css';

export function HowToPlayContent({ headingLevel = 2 }: { headingLevel?: 2 | 3 }): JSX.Element {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className="how-to-play">
      {HOW_TO_PLAY.map((section) => (
        <section key={section.id} id={`how-to-play-${section.id}`} aria-labelledby={`how-to-play-${section.id}-title`}>
          <Heading id={`how-to-play-${section.id}-title`}>{section.title}</Heading>
          {section.blocks.map((block, i) =>
            block.kind === 'text' ? (
              <p key={i}>{block.text}</p>
            ) : block.kind === 'list' ? (
              <ul key={i}>
                {block.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : (
              <figure key={i} className="how-to-play-dominoes">
                <div className="how-to-play-row" aria-hidden="true">
                  {block.dominoes.map((d) => (
                    <Domino key={`${d.top}-${d.bottom}`} top={d.top} bottom={d.bottom} direction="vertical" />
                  ))}
                </div>
                <figcaption>
                  {block.caption}{' '}
                  <span className="visually-hidden">{block.dominoes.map((d) => `${d.top}-${d.bottom}`).join(', ')}</span>
                </figcaption>
              </figure>
            )
          )}
        </section>
      ))}
    </div>
  );
}
