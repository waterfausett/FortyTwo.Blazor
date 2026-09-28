// One player's place at the table: a name plate carrying their turn/dealer/lead/bid/ready markers
// and, for everyone but the viewer, a face-down fan of the dominoes they still hold. Replaces the
// old app's RemotePlayer.razor (which drew the same face-down tiles via Domino's ShowPlaceHolder).
//
// Only ever receives a count for another player - the Worker never sends their dominoes.
import type { JSX } from 'react';
import type { Bid, Suit } from '@fortytwo/rules';
import { bidToPrettyString } from '@fortytwo/rules';
import type { Seat as SeatPosition } from '../match/table';
import { PipFace } from './PipFace';

export interface SeatProps {
  seat: SeatPosition;
  name: string;
  side: 'us' | 'them';
  isActive: boolean;
  isDealer: boolean;
  isLeader: boolean;
  // The bid to show on the plate: every player's own bid while bidding is open, then only the
  // winning bidder's once trump is named.
  bid: Bid | null;
  isHighBidder: boolean;
  trump: Suit | null;
  ready: boolean | null;
  dominoCount: number | null;
}

function TileBacks({ count, seat }: { count: number; seat: SeatPosition }): JSX.Element {
  return (
    <div className={`tile-backs tile-backs-${seat}`}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="tile-back" />
      ))}
      <span className="visually-hidden">{count} dominoes</span>
    </div>
  );
}

export function Seat({
  seat,
  name,
  side,
  isActive,
  isDealer,
  isLeader,
  bid,
  isHighBidder,
  trump,
  ready,
  dominoCount,
}: SeatProps): JSX.Element {
  return (
    <div
      className={`seat seat-${seat} seat-${side}${isActive ? ' active' : ''}`}
      data-testid={seat === 'bottom' ? 'my-seat' : 'remote-player'}
    >
      <div className="seat-plate">
        <span className="seat-name" title={name}>
          {name}
        </span>
        <span className="seat-markers">
          {isDealer && (
            <span className="marker marker-dealer" title="Dealer">
              D<span className="visually-hidden">ealer</span>
            </span>
          )}
          {isLeader && (
            <span className="marker marker-lead" title="Leads the next trick">
              Lead
            </span>
          )}
          {bid != null && (
            <span className={`marker marker-bid${isHighBidder ? ' marker-bid-high' : ''}`} title="Bid">
              {bidToPrettyString(bid)}
              {isHighBidder && trump != null && <PipFace suit={trump} size="xs" />}
            </span>
          )}
          {ready != null && (
            <span className={`marker marker-ready${ready ? ' is-ready' : ''}`} data-testid="ready-status">
              {ready ? 'Ready' : 'Not ready'}
            </span>
          )}
        </span>
      </div>
      {dominoCount != null && dominoCount > 0 && <TileBacks count={dominoCount} seat={seat} />}
    </div>
  );
}
