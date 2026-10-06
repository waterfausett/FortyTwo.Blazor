"""Exact port of the Worker's dev-only bots (cloudflare/apps/worker/src/bots.ts)."""
from ..engine.dominoes import PIPS
from ..engine.enums import NAMED_SUITS, PASS
from ..engine.hand_state import HandState


class DumbBot:
    name = "dumb"

    def bid(self, state: HandState, seat: int) -> int:
        forced = sum(1 for s in range(4) if s != seat and state.bids[s] == PASS) == 3
        return 30 if forced else PASS

    def trump(self, state: HandState, seat: int) -> int:
        hand = state.hand(seat)
        best, best_count = NAMED_SUITS[0], -1
        for suit in NAMED_SUITS:
            count = sum(1 for d in hand if suit in PIPS[d])
            if count > best_count:
                best, best_count = suit, count
        return best

    def play(self, state: HandState, seat: int) -> int:
        # legal_actions is in hand order: the first domino of the led suit, else the first held.
        return state.legal_actions()[0]
