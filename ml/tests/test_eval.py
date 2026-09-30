from fortytwo_ml.agents.dumb_bot import DumbBot
from fortytwo_ml.agents.heuristic_bot import HeuristicBot
from fortytwo_ml.eval.arena import HandEval, evaluate_hands, evaluate_matches
from fortytwo_ml.eval.report import format_report, mean_ci, proportion_ci


class IllegalBot(HeuristicBot):
    name = "illegal"

    def play(self, state, seat):
        return 99


def test_duplicate_deals_play_each_deal_from_both_sides():
    result = evaluate_hands(HeuristicBot(), DumbBot(), deals=30, seed=1)
    assert len(result.records) == 60 and len(result.deal_scores) == 30 == len(result.deal_kinds)
    assert sum(r.a_bidding for r in result.records) == 30
    assert result.illegal == {"a": 0, "b": 0}


def test_evaluation_is_deterministic_for_a_seed():
    a = evaluate_hands(HeuristicBot(), DumbBot(), deals=20, seed=9)
    b = evaluate_hands(HeuristicBot(), DumbBot(), deals=20, seed=9)
    assert a.deal_scores == b.deal_scores


def test_heuristic_beats_dumb_at_trick_play():
    result = evaluate_hands(HeuristicBot(), DumbBot(), deals=300, seed=0)
    mean, lo, _ = mean_ci(result.deal_scores)
    assert mean > 0 and lo > 0


def test_illegal_actions_are_counted_not_fatal():
    result = evaluate_hands(IllegalBot(), HeuristicBot(), deals=5, seed=0)
    assert result.illegal["a"] > 0 and result.illegal["b"] == 0
    assert len(result.deal_scores) == 5


def test_matches_and_report():
    matches = evaluate_matches(HeuristicBot(), DumbBot(), matches=4, seed=0)
    assert matches.matches == 4 and 0 <= matches.a_wins <= 4
    text = format_report(evaluate_hands(HeuristicBot(), DumbBot(), deals=20), matches)
    assert "Mean marks/deal" in text and "Match win rate" in text and "Illegal actions: A=0 B=0" in text


def test_confidence_intervals():
    assert mean_ci([1, 1, 1]) == (1, 1, 1)
    mean, lo, hi = mean_ci([0, 2, 0, 2])
    assert mean == 1 and lo < 1 < hi
    p, lo, hi = proportion_ci(50, 100)
    assert p == 0.5 and round(hi - lo, 3) == 0.196


def test_report_shows_per_kind_ci_and_flags_worse_buckets():
    hands = HandEval("A", "B")
    hands.deal_scores = [-2, -2, -4, -2] + [2, 4, 2, 2]
    hands.deal_kinds = ["low"] * 4 + ["marks"] * 4
    text = format_report(hands)
    low = next(l for l in text.splitlines() if l.strip().startswith("low"))
    marks = next(l for l in text.splitlines() if l.strip().startswith("marks"))
    assert "-2.500" in low and "WORSE" in low
    assert "+2.500" in marks and "WORSE" not in marks
