"""Head-to-head evaluation on duplicate deals: every deal is played twice with the same dominoes
and contract, the two agents swapping sides, so most of the deal's luck cancels out."""
import random
from collections.abc import Mapping
from dataclasses import dataclass, field

from ..agents.base import Agent, run_hand
from ..contracts import DEFAULT_MIX, ContractSampler, contract_kind
from ..engine.hand_state import HandState, team_of
from ..engine.match import play_match


@dataclass(frozen=True)
class HandRecord:
    kind: str
    a_bidding: bool
    bidders_won: bool
    a_marks: int  # signed: + when A's team won the hand


@dataclass
class HandEval:
    a_name: str
    b_name: str
    records: list[HandRecord] = field(default_factory=list)
    deal_scores: list[int] = field(default_factory=list)  # A's net marks per duplicate deal
    illegal: dict[str, int] = field(default_factory=lambda: {"a": 0, "b": 0})


@dataclass
class MatchEval:
    a_wins: int
    matches: int
    illegal: dict[str, int]


def _seats(a: Agent, b: Agent, a_team: int) -> list[Agent]:
    return [a if team_of(s) == a_team else b for s in range(4)]


def _illegal_counter(illegal: dict[str, int], a_team: int):
    def count(seat: int, _action: int) -> None:
        illegal["a" if team_of(seat) == a_team else "b"] += 1
    return count


def evaluate_hands(
    a: Agent, b: Agent, deals: int, seed: int = 0, mix: Mapping[str, float] | None = None
) -> HandEval:
    result = HandEval(a.name, b.name)
    for i in range(deals):
        rng = random.Random(f"{seed}:{i}")
        order = list(range(28))
        rng.shuffle(order)
        contract = ContractSampler(mix or DEFAULT_MIX, rng).sample(order, rng.randrange(4))
        kind = contract_kind(contract)
        bidders = team_of(contract.bidder)
        score = 0
        for a_team in (0, 1):
            state = HandState.from_contract(order, contract.bidder, contract.bid, contract.trump)
            hand = run_hand(state, _seats(a, b, a_team), _illegal_counter(result.illegal, a_team))
            a_marks = hand.marks if hand.winning_team == a_team else -hand.marks
            result.records.append(HandRecord(kind, bidders == a_team, hand.winning_team == bidders, a_marks))
            score += a_marks
        result.deal_scores.append(score)
    return result


def evaluate_matches(a: Agent, b: Agent, matches: int, seed: int = 0) -> MatchEval:
    illegal = {"a": 0, "b": 0}
    wins = 0
    for i in range(matches):
        rng = random.Random(f"match:{seed}:{i}")
        a_team = i % 2
        result = play_match(_seats(a, b, a_team), rng, rng.randrange(4), _illegal_counter(illegal, a_team))
        wins += result.winning_team == a_team
    return MatchEval(wins, matches, illegal)
