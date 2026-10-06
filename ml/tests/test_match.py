import random

from fortytwo_ml.agents.heuristic_bot import HeuristicBot
from fortytwo_ml.engine.match import play_match


def test_match_runs_to_seven_marks():
    result = play_match([HeuristicBot()] * 4, random.Random(0))
    assert max(result.marks) >= 7 and result.marks[result.winning_team] >= 7
    assert min(result.marks) < 7 and result.hands >= 2


def test_match_is_deterministic_for_a_seed():
    a = play_match([HeuristicBot()] * 4, random.Random(5))
    b = play_match([HeuristicBot()] * 4, random.Random(5))
    assert a == b
