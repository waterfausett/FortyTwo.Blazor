import math
import statistics
from collections.abc import Sequence

from ..contracts import KIND_ORDER
from .arena import HandEval, MatchEval

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
        "By contract type:        A bidding: made        A defending: set",
    ]
    for kind in KIND_ORDER:
        recs = [r for r in hands.records if r.kind == kind]
        if not recs:
            continue
        bidding = [r for r in recs if r.a_bidding]
        defending = [r for r in recs if not r.a_bidding]
        made = sum(r.bidders_won for r in bidding)
        set_ = sum(not r.bidders_won for r in defending)
        lines.append(f"  {kind:<10}             {_rate(made, len(bidding))}      {_rate(set_, len(defending))}")
    illegal = dict(hands.illegal)
    if matches is not None:
        p, plo, phi = proportion_ci(matches.a_wins, matches.matches)
        lines.append(f"Match win rate (A): {p:.1%}  [95% CI {plo:.1%}, {phi:.1%}] over {matches.matches} matches")
        illegal = {k: illegal[k] + matches.illegal[k] for k in illegal}
    lines.append(f"Illegal actions: A={illegal['a']} B={illegal['b']}")
    return "\n".join(lines)
