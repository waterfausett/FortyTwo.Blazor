"""The bidding rules, as a pure function over a table of simulated P(make) values.

- Partner holds the high bid: pass, unless a higher bid is near-certain.
- Last to bid (nobody can outbid us): the lowest makeable bid, unless a marks bid is worth more.
  Forced with nothing makeable: the lowest legal bid anyway.
- Otherwise: the highest makeable bid (bid what the hand can make, so opponents can't take it
  cheaply), or pass."""
from collections.abc import Sequence
from dataclasses import dataclass

from ..engine.bidding import marks_for
from ..engine.enums import PASS


@dataclass(frozen=True)
class Option:
    bid: int
    trump: int
    p_make: float

    @property
    def ev(self) -> float:
        return marks_for(self.bid) * (2 * self.p_make - 1)


@dataclass(frozen=True)
class BidContext:
    legal: Sequence[int]
    partner_holds: bool
    last_to_bid: bool

    @property
    def forced(self) -> bool:
        return PASS not in self.legal


@dataclass(frozen=True)
class DecideConfig:
    make_threshold: float = 0.5
    overbid_partner_threshold: float = 0.9


@dataclass(frozen=True)
class BidDecision:
    bid: int
    trump: int | None
    p_make: float | None
    options: tuple[Option, ...]


MARKS_BID = 84  # bids from 84 up (plunge included) are marks bids


def choose_bid(options: Sequence[Option], ctx: BidContext, cfg: DecideConfig = DecideConfig()) -> BidDecision:
    table = tuple(options)
    best: dict[int, Option] = {}
    for o in table:
        if o.bid in ctx.legal and o.bid != PASS and (o.bid not in best or o.p_make > best[o.bid].p_make):
            best[o.bid] = o

    def take(bid: int) -> BidDecision:
        o = best[bid]
        return BidDecision(o.bid, o.trump, o.p_make, table)

    def forced_bid() -> BidDecision:
        """When forced to bid, return the lowest legal non-PASS bid."""
        lowest_legal = min(b for b in ctx.legal if b != PASS)
        if lowest_legal in best:
            return take(lowest_legal)
        return BidDecision(lowest_legal, None, None, table)

    passing = BidDecision(PASS, None, None, table)
    makeable = sorted(b for b, o in best.items() if o.p_make > cfg.make_threshold)

    if ctx.partner_holds:
        strong = [b for b, o in best.items() if o.p_make >= cfg.overbid_partner_threshold]
        return take(max(strong)) if strong else passing

    if ctx.last_to_bid:
        if makeable:
            lowest = makeable[0]
            marks = [b for b in makeable if b >= MARKS_BID]
            richest = max(marks, key=lambda b: best[b].ev) if marks else None
            return take(richest) if richest is not None and best[richest].ev > best[lowest].ev else take(lowest)
        return forced_bid() if ctx.forced else passing

    if makeable:
        return take(makeable[-1])
    return forced_bid() if ctx.forced else passing
