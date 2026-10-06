"""The one simulation core: deal a hand's unseen dominoes many times, play every deal out under
each probe contract with the play model, and count what happened. Every P(make) the simulation
bidder needs comes from these counts, and they depend only on the hand (and seat), never on the
auction - which is why the bidding model's training data needs no auctions."""
import random
from collections.abc import Collection, Sequence
from dataclasses import dataclass

import numpy as np

from ..agents.heuristic_bot import best_suit
from ..engine.dominoes import doubles_in, to_mask
from ..engine.enums import LOW_TRUMPS, NAMED_SUITS, PASS, PLUNGE, Suit
from ..engine.hand_state import Contract, partner
from ..model import QNet
from .deal import deal_unseen
from .decide import Option
from .rollout import rollout

POINTS_PROBE = 30  # suits played as a 30 bid answer every points bid (30..41)
HIGH_PROBE = 42    # suits, follow-me and Low played as a 42 bid answer 42 and the marks bids
HIGH_TRUMPS = (*NAMED_SUITS, Suit.NONE)
ALL_KINDS = frozenset({"points", "high", "low", "plunge"})


@dataclass(frozen=True)
class HandSims:
    n: int
    points_hist: np.ndarray | None  # (7, 43): bidding team's final points at a 30 bid, per named suit
    high_made: np.ndarray | None    # (8,): deals that took all 42 points at a 42 bid; named suits, then follow-me
    low_clean: np.ndarray | None    # (3,): deals where the bidders took no trick, LOW_TRUMPS order
    plunge_made: int | None         # deals a plunge took every trick; None when not simulated


@dataclass(frozen=True)
class BidTable:
    points: np.ndarray | None  # (7, 12): P(make b) for b = 30..41, per named suit
    high: np.ndarray | None    # (8,): P(make 42 and the marks bids); named suits, then follow-me
    low: np.ndarray | None     # (3,): P(take no trick), LOW_TRUMPS order
    plunge: float | None


def can_plunge(hand: Sequence[int]) -> bool:
    return doubles_in(to_mask(hand)) >= 4


def kinds_for(legal: Collection[int]) -> frozenset[str]:
    """The probes a decision needs, given its legal bids."""
    bids = [b for b in legal if b != PASS]
    kinds = set()
    if any(b < HIGH_PROBE for b in bids):
        kinds.add("points")
    if any(b >= HIGH_PROBE and b != PLUNGE for b in bids):
        kinds |= {"high", "low"}
    if PLUNGE in bids:
        kinds.add("plunge")
    return frozenset(kinds)


def simulate_hand(
    model: QNet, seat: int, hand: Sequence[int], n_deals: int, rng: random.Random,
    device=None, kinds: Collection[str] = ALL_KINDS,
) -> HandSims:
    deals = [deal_unseen(seat, hand, rng) for _ in range(n_deals)]
    run_plunge = "plunge" in kinds and can_plunge(hand)
    jobs: list[tuple[list[int], Contract]] = []
    if "points" in kinds:
        jobs += [(d, Contract(seat, POINTS_PROBE, t)) for t in NAMED_SUITS for d in deals]
    if "high" in kinds:
        jobs += [(d, Contract(seat, HIGH_PROBE, t)) for t in HIGH_TRUMPS for d in deals]
    if "low" in kinds:
        jobs += [(d, Contract(seat, HIGH_PROBE, v)) for v in LOW_TRUMPS for d in deals]
    if run_plunge:
        mate = partner(seat)
        jobs += [(d, Contract(seat, PLUNGE, best_suit(list(d[mate * 7:(mate + 1) * 7]))[0])) for d in deals]
    result = rollout(model, jobs, device)

    cursor = 0

    def block(rows: int) -> slice:
        nonlocal cursor
        s = slice(cursor, cursor + rows * n_deals)
        cursor += rows * n_deals
        return s

    points_hist = high_made = low_clean = None
    plunge_made = None
    if "points" in kinds:
        pts = result.bidder_points[block(7)].reshape(7, n_deals)
        points_hist = np.stack([np.bincount(row, minlength=43) for row in pts])
    if "high" in kinds:
        high_made = (result.bidder_points[block(8)].reshape(8, n_deals) == 42).sum(axis=1)
    if "low" in kinds:
        low_clean = (~result.bidder_took_trick[block(3)].reshape(3, n_deals)).sum(axis=1)
    if run_plunge:
        plunge_made = int((result.bidder_points[block(1)] == 42).sum())
    return HandSims(n_deals, points_hist, high_made, low_clean, plunge_made)


def table_from_sims(sims: HandSims) -> BidTable:
    n = sims.n
    points = None
    if sims.points_hist is not None:
        at_least = np.cumsum(sims.points_hist[:, ::-1], axis=1)[:, ::-1]  # [:, p] = deals with >= p points
        points = at_least[:, POINTS_PROBE:HIGH_PROBE] / n
    return BidTable(
        points,
        None if sims.high_made is None else sims.high_made / n,
        None if sims.low_clean is None else sims.low_clean / n,
        None if sims.plunge_made is None else sims.plunge_made / n,
    )


def _need(value, kind: str):
    if value is None:
        raise ValueError(f"the table has no {kind!r} probabilities, but a legal bid needs them")
    return value


def options_from_table(table: BidTable, legal: Collection[int]) -> list[Option]:
    """One Option per (legal bid, trump), in a fixed order: points suits, 42-probe trumps, Low, plunge."""
    bids = [b for b in legal if b != PASS]
    points_bids = [b for b in bids if b < HIGH_PROBE]
    high_bids = [b for b in bids if b >= HIGH_PROBE and b != PLUNGE]
    options: list[Option] = []
    if points_bids:
        points = _need(table.points, "points")
        for t in NAMED_SUITS:
            options += [Option(b, t, float(points[t, b - POINTS_PROBE])) for b in points_bids]
    if high_bids:
        high, low = _need(table.high, "high"), _need(table.low, "low")
        for i, t in enumerate(HIGH_TRUMPS):
            options += [Option(b, t, float(high[i])) for b in high_bids]
        for i, v in enumerate(LOW_TRUMPS):
            options += [Option(b, v, float(low[i])) for b in high_bids]
    if PLUNGE in bids:
        options.append(Option(PLUNGE, Suit.NONE, float(_need(table.plunge, "plunge"))))
    return options
