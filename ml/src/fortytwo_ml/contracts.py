"""Where Stage 1 training hands get their contract. Bidding isn't learned yet, so most contracts
come from the heuristic bot bidding the real deal, and a share are forced exotics so the play model
learns every contract type it can face in a live game."""
import random
from collections.abc import Mapping, Sequence

from .agents.base import choose
from .agents.heuristic_bot import HeuristicBot, best_suit
from .engine.dominoes import doubles_in, to_mask
from .engine.enums import LOW_TRUMPS, PLUNGE, Suit, is_low
from .engine.hand_state import Contract, HandState, Phase, partner

KINDS = ("heuristic", "marks", "follow_me", "low", "plunge")
DEFAULT_MIX: dict[str, float] = {"heuristic": 0.7, "marks": 0.08, "follow_me": 0.07, "low": 0.1, "plunge": 0.05}
KIND_ORDER = ("points", "marks", "plunge", "follow_me", "low")


def contract_kind(contract: Contract) -> str:
    if contract.bid == PLUNGE:
        return "plunge"
    if is_low(contract.trump):
        return "low"
    if contract.trump == Suit.NONE:
        return "follow_me"
    return "marks" if contract.bid > 42 else "points"


class ContractSampler:
    def __init__(self, mix: Mapping[str, float], rng: random.Random):
        unknown = set(mix) - set(KINDS)
        if unknown:
            raise ValueError(f"unknown contract kinds: {sorted(unknown)}")
        if sum(mix.values()) <= 0:
            raise ValueError("contract mix needs a positive weight")
        self._kinds = list(mix)
        self._weights = [mix[k] for k in self._kinds]
        self._rng = rng
        self._bot = HeuristicBot()

    def sample(self, deal_order: Sequence[int], opener: int) -> Contract:
        kind = self._rng.choices(self._kinds, self._weights)[0]
        return self._forced(kind, deal_order) or self._heuristic(deal_order, opener)

    def _heuristic(self, deal_order: Sequence[int], opener: int) -> Contract:
        state = HandState.deal(deal_order, opener)
        while state.phase in (Phase.BID, Phase.TRUMP):
            state.apply(choose(self._bot, state))
        return state.contract

    def _forced(self, kind: str, deal_order: Sequence[int]) -> Contract | None:
        hands = [list(deal_order[p * 7:(p + 1) * 7]) for p in range(4)]
        strengths = [best_suit(h)[1] for h in hands]
        strongest = max(range(4), key=lambda s: strengths[s])
        if kind == "marks":
            return Contract(strongest, 84, best_suit(hands[strongest])[0])
        if kind == "follow_me":
            return Contract(strongest, 42, Suit.NONE)
        if kind == "low":
            weakest = min(range(4), key=lambda s: strengths[s])
            return Contract(weakest, 42, self._rng.choice(LOW_TRUMPS))
        if kind == "plunge":
            plungers = [s for s in range(4) if doubles_in(to_mask(hands[s])) >= 4]
            if not plungers:
                return None
            seat = self._rng.choice(plungers)
            return Contract(seat, PLUNGE, best_suit(hands[partner(seat)])[0])
        return None  # "heuristic"
