import math
import statistics
from collections.abc import Sequence

from ..contracts import KIND_ORDER
from .arena import AuctionEval, HandEval, MatchEval

Z95 = 1.96


def mean_ci(values: Sequence[float]) -> tuple[float, float, float]:
    mean = statistics.fmean(values)
    if len(values) < 2:
        return mean, mean, mean
    half = Z95 * statistics.stdev(values) / math.sqrt(len(values))
    return mean, mean - half, mean + half


def proportion_ci(k: int, n: int) -> tuple[float, float, float]:
    p = k / n
    half = Z95 * math.sqrt(p * (1 - p) / n)
    return p, p - half, p + half


def _rate(hits: int, n: int) -> str:
    return f"{hits / n:6.1%} (n={n})" if n else "     - (n=0)"


def format_report(hands: HandEval, matches: MatchEval | None = None) -> str:
    mean, lo, hi = mean_ci(hands.deal_scores)
    lines = [
        f"A: {hands.a_name}  vs  B: {hands.b_name}  -  {len(hands.deal_scores)} duplicate deals",
        f"Mean marks/deal (A): {mean:+.3f}  [95% CI {lo:+.3f}, {hi:+.3f}]",
        "By contract type:        marks/deal (A) [95% CI]          A bidding: made   A defending: set",
    ]
    for kind in KIND_ORDER:
        recs = [r for r in hands.records if r.kind == kind]
        if not recs and kind not in hands.deal_kinds:
            continue
        bidding = [r for r in recs if r.a_bidding]
        defending = [r for r in recs if not r.a_bidding]
        made = sum(r.bidders_won for r in bidding)
        set_ = sum(not r.bidders_won for r in defending)
        scores = [s for s, k in zip(hands.deal_scores, hands.deal_kinds) if k == kind]
        kmean, klo, khi = mean_ci(scores)
        flag = "WORSE" if khi < 0 else ""
        lines.append(
            f"  {kind:<10} {kmean:+.3f} [{klo:+.3f}, {khi:+.3f}] n={len(scores):<5} {flag:<5}"
            f"  {_rate(made, len(bidding))}      {_rate(set_, len(defending))}"
        )
    illegal = dict(hands.illegal)
    if matches is not None:
        p, plo, phi = proportion_ci(matches.a_wins, matches.matches)
        lines.append(f"Match win rate (A): {p:.1%}  [95% CI {plo:.1%}, {phi:.1%}] over {matches.matches} matches")
        illegal = {k: illegal[k] + matches.illegal[k] for k in illegal}
    lines.append(f"Illegal actions: A={illegal['a']} B={illegal['b']}")
    return "\n".join(lines)


_CALIBRATION_BINS = [(0.0, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 0.9), (0.9, 1.01)]


_BID_BANDS = [(30, 31, "30-31"), (32, 35, "32-35"), (36, 41, "36-41"), (42, 10**9, "42+")]


def format_auction_report(ev: AuctionEval, matches: MatchEval | None = None) -> str:
    mean, lo, hi = mean_ci(ev.deal_scores)
    won = [r for r in ev.records if r.a_won_auction]
    lines = [
        f"A: {ev.a_name}  vs  B: {ev.b_name}  -  {len(ev.deal_scores)} duplicate deals with auctions",
        f"Mean marks/deal (A): {mean:+.3f}  [95% CI {lo:+.3f}, {hi:+.3f}]",
        f"A won the auction: {len(won)}/{len(ev.records)}   made: {_rate(sum(r.bidders_won for r in won), len(won))}",
        "By winning contract:     A's marks/hand   A bid / B bid",
    ]
    for kind in KIND_ORDER:
        recs = [r for r in ev.records if r.kind == kind]
        if recs:
            a_bid = sum(r.a_won_auction for r in recs)
            avg = sum(r.a_marks for r in recs) / len(recs)
            lines.append(f"  {kind:<10}             {avg:+.3f} (n={len(recs)})   {a_bid} / {len(recs) - a_bid}")
    lines.append("Calibration (A's winning bids): predicted P(make) -> actual made rate")
    for low, high in _CALIBRATION_BINS:
        hits = [r for r in won if r.predicted is not None and low <= r.predicted < high]
        if hits:
            predicted = sum(r.predicted for r in hits) / len(hits)
            made = sum(r.bidders_won for r in hits) / len(hits)
            lines.append(f"  {low:.1f}-{min(high, 1.0):.1f}: predicted {predicted:.2f}  actual {made:.2f}  (n={len(hits)})")
    lines.append("Calibration by bid level (A's winning bids; 42+ includes marks and plunge):")
    for low, high, label in _BID_BANDS:
        hits = [r for r in won if r.predicted is not None and low <= r.bid <= high]
        if hits:
            predicted = sum(r.predicted for r in hits) / len(hits)
            made = sum(r.bidders_won for r in hits) / len(hits)
            lines.append(f"  bid {label}: predicted {predicted:.2f}  actual {made:.2f}  (n={len(hits)})")
    lines.append("A's marks/hand by who won the auction:")
    for label, side in (("A won", True), ("B won", False)):
        recs = [r for r in ev.records if r.a_won_auction == side]
        if recs:
            lines.append(f"  {label}: {sum(r.a_marks for r in recs) / len(recs):+.3f}  (n={len(recs)})")
    if ev.decision_seconds:
        times = sorted(ev.decision_seconds)
        p95 = times[min(len(times) - 1, int(0.95 * len(times)))]
        lines.append(f"Bid decision time: median {times[len(times) // 2]:.1f}s  p95 {p95:.1f}s  (n={len(times)})")
    illegal = dict(ev.illegal)
    if matches is not None:
        p, plo, phi = proportion_ci(matches.a_wins, matches.matches)
        lines.append(f"Match win rate (A): {p:.1%}  [95% CI {plo:.1%}, {phi:.1%}] over {matches.matches} matches")
        illegal = {k: illegal[k] + matches.illegal[k] for k in illegal}
    lines.append(f"Illegal actions: A={illegal['a']} B={illegal['b']}")
    return "\n".join(lines)
