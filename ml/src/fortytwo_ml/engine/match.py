"""A match: hands until a team has 7 marks, the opener moving one seat each hand (patchPlayerReady)."""
import random
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from ..agents.base import run_hand
from .hand_state import HandState

WINNING_SCORE = 7


@dataclass(frozen=True)
class MatchResult:
    winning_team: int
    marks: tuple[int, int]
    hands: int


def play_match(
    agents: Sequence,
    rng: random.Random,
    first_opener: int = 0,
    on_illegal: Callable[[int, int], None] | None = None,
) -> MatchResult:
    marks = [0, 0]
    opener = first_opener
    hands = 0
    while max(marks) < WINNING_SCORE:
        order = list(range(28))
        rng.shuffle(order)
        result = run_hand(HandState.deal(order, opener), agents, on_illegal)
        marks[result.winning_team] += result.marks
        opener = (opener + 1) % 4
        hands += 1
    return MatchResult(0 if marks[0] >= WINNING_SCORE else 1, (marks[0], marks[1]), hands)
