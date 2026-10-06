"""What the simulation bidder and the fast bidder share: the bidding context for a decision, and
the plan (trump, P(make)) behind each bid, so trump naming and calibration can use it."""
from ..engine.enums import PASS, PLUNGE
from ..engine.hand_state import HandState, partner
from ..sim.decide import BidContext, BidDecision


def bid_context(state: HandState, seat: int) -> BidContext:
    return BidContext(
        legal=state.legal_actions(),
        partner_holds=state.bidder is not None and state.bidder == partner(seat),
        last_to_bid=all(state.bids[s] is not None for s in range(4) if s != seat),
    )


class BidPlans:
    def __init__(self) -> None:
        self._plans: dict[tuple, tuple[int, int | None, float | None]] = {}  # (seat, hand) -> (bid, trump, p_make)

    @staticmethod
    def key(state: HandState, seat: int) -> tuple:
        return seat, tuple(sorted(state.dealt[seat]))

    def record(self, state: HandState, seat: int, decision: BidDecision) -> None:
        if decision.bid != PASS:
            trump = None if decision.bid == PLUNGE else decision.trump  # a plunger's partner names trump
            self._plans[self.key(state, seat)] = (decision.bid, trump, decision.p_make)

    def current(self, state: HandState, seat: int) -> tuple[int, int | None, float | None] | None:
        """The plan behind this seat's bid, only if that bid is the winning one."""
        plan = self._plans.get(self.key(state, seat))
        return plan if plan is not None and state.bidder == seat and plan[0] == state.high_bid else None

    def predicted_make(self, state: HandState, seat: int) -> float | None:
        plan = self.current(state, seat)
        return plan[2] if plan else None
