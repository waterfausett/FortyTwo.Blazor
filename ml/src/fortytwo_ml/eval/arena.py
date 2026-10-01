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
    deal_kinds: list[str] = field(default_factory=list)  # contract kind of each deal, parallel to deal_scores
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
        order, _, contract = ContractSampler(mix or DEFAULT_MIX, rng).sample_hand()
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
        result.deal_kinds.append(kind)
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


@dataclass(frozen=True)
class AuctionRecord:
    kind: str
    bid: int  # the winning bid (state.high_bid)
    a_won_auction: bool
    bidders_won: bool
    a_marks: int
    predicted: float | None  # A's simulated P(make) for its winning bid, when A won the auction


@dataclass
class AuctionEval:
    a_name: str
    b_name: str
    records: list[AuctionRecord] = field(default_factory=list)
    deal_scores: list[int] = field(default_factory=list)
    illegal: dict[str, int] = field(default_factory=lambda: {"a": 0, "b": 0})
    decision_seconds: list[float] = field(default_factory=list)


def evaluate_auctions(a: Agent, b: Agent, deals: int, seed: int = 0) -> AuctionEval:
    """Duplicate deals with real auctions: each deal is bid and played twice with the teams
    swapped. For Stage 2, A and B share a play model and differ only in how they bid."""
    result = AuctionEval(a.name, b.name)
    for i in range(deals):
        rng = random.Random(f"auction:{seed}:{i}")
        order = list(range(28))
        rng.shuffle(order)
        opener = rng.randrange(4)
        score = 0
        for a_team in (0, 1):
            seats = _seats(a, b, a_team)
            state = HandState.deal(order, opener)
            hand = run_hand(state, seats, _illegal_counter(result.illegal, a_team))
            bidders = team_of(state.bidder)
            a_won = bidders == a_team
            predict = getattr(seats[state.bidder], "predicted_make", None) if a_won else None
            predicted = predict(state, state.bidder) if predict else None
            a_marks = hand.marks if hand.winning_team == a_team else -hand.marks
            result.records.append(
                AuctionRecord(contract_kind(state.contract), state.high_bid, a_won, hand.winning_team == bidders, a_marks, predicted)
            )
            score += a_marks
        result.deal_scores.append(score)
    result.decision_seconds = list(getattr(a, "decision_seconds", []))
    return result
