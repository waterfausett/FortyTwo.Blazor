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


def test_evaluate_auctions_duplicates_deals_with_full_bidding():
    import torch
    from fortytwo_ml.agents.model_agent import ModelAgent
    from fortytwo_ml.agents.sim_bidder import SimAgent
    from fortytwo_ml.eval.arena import evaluate_auctions
    from fortytwo_ml.eval.report import format_auction_report
    from fortytwo_ml.model import QNet

    torch.manual_seed(0)
    net = QNet(hidden=16, layers=1).eval()
    ev = evaluate_auctions(SimAgent(net, n_deals=4), ModelAgent(net), deals=3, seed=1)
    assert len(ev.records) == 6 and len(ev.deal_scores) == 3 and ev.illegal == {"a": 0, "b": 0}
    assert len(ev.decision_seconds) >= 3
    assert all((r.predicted is not None) == r.a_won_auction for r in ev.records)
    text = format_auction_report(ev)
    assert "Mean marks/deal" in text and "Calibration" in text and "Bid decision time" in text


def test_auction_report_calibration_bands_auction_sides_and_p95():
    from fortytwo_ml.eval.arena import AuctionEval, AuctionRecord
    from fortytwo_ml.eval.report import format_auction_report

    recs = [
        AuctionRecord("points", 30, True, True, 2, 0.75),
        AuctionRecord("points", 31, True, False, -2, 0.85),
        AuctionRecord("points", 34, True, True, 1, 0.65),
        AuctionRecord("points", 42, True, True, 3, 0.95),
        AuctionRecord("points", 32, False, True, -1, None),
        AuctionRecord("points", 30, False, False, 1, None),
    ]
    ev = AuctionEval("a", "b", records=recs, deal_scores=[1, 2, 3], decision_seconds=[float(i) for i in range(1, 21)])
    text = format_auction_report(ev)
    assert "0.7-0.8: predicted 0.75  actual 1.00  (n=1)" in text
    assert "bid 30-31: predicted 0.80  actual 0.50  (n=2)" in text
    assert "bid 32-35: predicted 0.65  actual 1.00  (n=1)" in text
    assert "bid 36-41" not in text
    assert "bid 42+: predicted 0.95  actual 1.00  (n=1)" in text
    assert "A won: +1.000  (n=4)" in text
    assert "B won: +0.000  (n=2)" in text
    assert "median 11.0s  p95 20.0s  (n=20)" in text


def _sim_and_model(seed=0):
    import torch
    from fortytwo_ml.agents.model_agent import ModelAgent
    from fortytwo_ml.agents.sim_bidder import SimAgent
    from fortytwo_ml.model import QNet

    torch.manual_seed(seed)
    net = QNet(hidden=16, layers=1).eval()
    return SimAgent(net, n_deals=4), ModelAgent(net)


def test_split_ranges_match_one_run():
    from fortytwo_ml.eval.arena import evaluate_auctions, merge_auction_evals

    whole = evaluate_auctions(*_sim_and_model(), deals=4, seed=3)
    parts = merge_auction_evals([
        evaluate_auctions(*_sim_and_model(), deals=range(0, 2), seed=3),
        evaluate_auctions(*_sim_and_model(), deals=range(2, 4), seed=3),
    ])
    assert parts.records == whole.records and parts.deal_scores == whole.deal_scores
    assert parts.illegal == whole.illegal and len(parts.decision_seconds) == len(whole.decision_seconds)


def test_decision_times_cover_only_this_call():
    from fortytwo_ml.eval.arena import evaluate_auctions

    a, b = _sim_and_model()
    first = evaluate_auctions(a, b, deals=1, seed=0)
    second = evaluate_auctions(a, b, deals=1, seed=1)
    assert len(first.decision_seconds) + len(second.decision_seconds) == len(a.decision_seconds)
    assert second.b_decision_seconds == []  # ModelAgent records no times


def test_report_prints_each_sides_decision_time_in_ms_when_fast():
    from fortytwo_ml.eval.arena import AuctionEval, AuctionRecord
    from fortytwo_ml.eval.report import format_auction_report

    recs = [AuctionRecord("points", 30, True, True, 1, 0.7)]
    ev = AuctionEval("a", "b", records=recs, deal_scores=[1],
                     decision_seconds=[0.001, 0.002, 0.003], b_decision_seconds=[5.0, 6.0, 7.0])
    text = format_auction_report(ev)
    assert "Bid decision time (A): median 2.0ms  p95 3.0ms  (n=3)" in text
    assert "Bid decision time (B): median 6.0s  p95 7.0s  (n=3)" in text
