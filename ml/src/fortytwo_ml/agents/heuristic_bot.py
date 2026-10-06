"""A rule-based player that plays sensibly: the baseline the model must beat, and the default
source of contracts for Stage 1 training."""
from ..engine.dominoes import IS_DOUBLE, PIPS, VALUE, index_of
from ..engine.enums import NAMED_SUITS, PASS, is_low
from ..engine.hand_state import HandState, team_of
from ..engine.rules import is_trump, led_suit, rank, trick_winner, trump_mask


def suit_strength(hand: list[int], suit: int) -> int:
    """A rough 30-42 scale estimate of what `hand` can make with `suit` as trump."""
    trumps = sum(1 for d in hand if suit in PIPS[d])
    strength = 5 * trumps
    if index_of(suit, suit) in hand:
        strength += 5
    strength += 3 * sum(1 for d in hand if IS_DOUBLE[d] and suit not in PIPS[d])
    strength += sum(VALUE[d] for d in hand) // 5
    return strength


def best_suit(hand: list[int]) -> tuple[int, int]:
    best, best_strength = NAMED_SUITS[0], -1
    for suit in NAMED_SUITS:
        strength = suit_strength(hand, suit)
        if strength > best_strength:
            best, best_strength = suit, strength
    return best, best_strength


class HeuristicBot:
    name = "heuristic"

    def bid(self, state: HandState, seat: int) -> int:
        legal = state.legal_actions()
        target = min(42, best_suit(state.hand(seat))[1])
        if target >= 30 and target in legal:
            return target
        if PASS in legal:
            return PASS
        return min(legal)  # forced: the other three passed

    def trump(self, state: HandState, seat: int) -> int:
        return best_suit(state.hand(seat))[0]

    def play(self, state: HandState, seat: int) -> int:
        legal = state.legal_actions()
        if len(legal) == 1:
            return legal[0]
        if is_low(state.trump):
            return self._play_low(state, seat, legal)
        if not state.trick:
            return self._lead(state, seat, legal)
        return self._follow(state, seat, legal)

    def _lead_rank(self, d: int, trump: int) -> float:
        return rank(d, led_suit(d, trump), trump)

    def _lead(self, state: HandState, seat: int, legal: list[int]) -> int:
        trump = state.trump
        trumps = [d for d in legal if is_trump(d, trump)]
        if trumps and self._others_may_hold_trump(state, seat):
            return max(trumps, key=lambda d: rank(d, trump, trump))
        doubles = [d for d in legal if IS_DOUBLE[d] and d not in trumps]
        if doubles:
            return max(doubles, key=lambda d: PIPS[d][0])
        return min(legal, key=lambda d: (VALUE[d], self._lead_rank(d, trump)))

    def _others_may_hold_trump(self, state: HandState, seat: int) -> bool:
        seen = state.hands[seat]
        for mask in state.played:
            seen |= mask
        return bool(trump_mask(state.trump) & ~seen)

    def _follow(self, state: HandState, seat: int, legal: list[int]) -> int:
        trump, led = state.trump, state.led_suit
        current = [d for _, d in state.trick]
        best = trick_winner(current, trump)
        best_seat, best_rank = state.trick[best][0], rank(current[best], led, trump)
        if team_of(best_seat) == team_of(seat):
            # Partner is winning: drop count, keep trumps, shed low.
            return max(legal, key=lambda d: (VALUE[d], not is_trump(d, trump), -rank(d, led, trump)))
        winners = [d for d in legal if rank(d, led, trump) > best_rank]
        if winners:
            return min(winners, key=lambda d: (rank(d, led, trump), VALUE[d]))
        return min(legal, key=lambda d: (VALUE[d], rank(d, led, trump)))

    def _play_low(self, state: HandState, seat: int, legal: list[int]) -> int:
        trump = state.trump
        if not state.trick:
            return min(legal, key=lambda d: self._lead_rank(d, trump))
        led = state.led_suit
        current = [d for _, d in state.trick]
        best_rank = rank(current[trick_winner(current, trump)], led, trump)
        if team_of(seat) == team_of(state.bidder):
            # Bidding Low: stay under the trick; if we must win it, shed our highest.
            under = [d for d in legal if rank(d, led, trump) < best_rank]
            return max(under or legal, key=lambda d: rank(d, led, trump))
        return min(legal, key=lambda d: rank(d, led, trump))
