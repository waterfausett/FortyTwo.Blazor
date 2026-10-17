"""One hand of Forty-Two as a state machine: deal -> bid -> trump -> play -> decided.

Mirrors placeBid / setTrump / playDomino and gameWinningTeam in packages/rules, except
that a decided hand stops (TS lets players play it out; those plays never change the result)."""
from collections.abc import Sequence
from dataclasses import dataclass
from enum import IntEnum

from .bidding import CONTRACT_BIDS, available_bids, available_trumps, marks_for, target_points
from .dominoes import FULL_MASK, VALUE, doubles_in, to_mask
from .enums import PASS, PLUNGE, is_low
from .rules import is_of_suit, led_suit, legal_plays, trick_winner


class Phase(IntEnum):
    BID = 0
    TRUMP = 1
    PLAY = 2
    DONE = 3


class IllegalAction(Exception):
    def __init__(self, seat: int, phase: Phase, action: int, legal: list[int]):
        super().__init__(f"seat {seat} can't {phase.name} {action}; legal: {legal}")
        self.seat, self.phase, self.action, self.legal = seat, phase, action, legal


@dataclass(frozen=True)
class Contract:
    bidder: int
    bid: int
    trump: int


@dataclass(frozen=True)
class Trick:
    plays: tuple[tuple[int, int], ...]  # (seat, domino) in play order
    winner: int
    points: int


@dataclass(frozen=True)
class HandResult:
    winning_team: int
    marks: int
    points: tuple[int, int]


def team_of(seat: int) -> int:
    return seat % 2


def partner(seat: int) -> int:
    return (seat + 2) % 4


class HandState:
    phase: Phase
    to_act: int
    opener: int
    bids: list[int | None]
    high_bid: int | None
    bidder: int | None
    trump: int | None
    dealt: list[tuple[int, ...]]
    hands: list[int]
    played: list[int]
    trick: list[tuple[int, int]]
    tricks: list[Trick]
    points: list[int]
    voids: list[int]
    result: HandResult | None
    play_to_end: bool

    @classmethod
    def deal(cls, deal_order: Sequence[int], opener: int) -> "HandState":
        if len(deal_order) != 28 or to_mask(deal_order) != FULL_MASK:
            raise ValueError("deal_order must be a permutation of 0..27")
        if opener not in range(4):
            raise ValueError(f"opener must be a seat 0..3, got {opener}")
        s = cls.__new__(cls)
        s.dealt = [tuple(deal_order[p * 7:(p + 1) * 7]) for p in range(4)]
        s.hands = [to_mask(ds) for ds in s.dealt]
        s.played = [0, 0, 0, 0]
        s.opener = opener
        s.to_act = opener
        s.phase = Phase.BID
        s.bids = [None, None, None, None]
        s.high_bid = None
        s.bidder = None
        s.trump = None
        s.trick = []
        s.tricks = []
        s.points = [0, 0]
        s.voids = [0, 0, 0, 0]
        s.result = None
        s.play_to_end = False
        return s

    @classmethod
    def from_contract(cls, deal_order: Sequence[int], bidder: int, bid: int, trump: int,
                      play_to_end: bool = False) -> "HandState":
        """Skip bidding: `bidder` won with `bid` and trump is `trump`. Everyone else passed."""
        s = cls.deal(deal_order, opener=bidder)
        if bid not in CONTRACT_BIDS:
            raise ValueError(f"{bid} isn't a contract bid")
        if bid == PLUNGE and doubles_in(s.hands[bidder]) < 4:
            raise ValueError("a Plunge needs four doubles")
        if trump not in available_trumps(bid):
            raise ValueError(f"trump {trump} isn't allowed on a bid of {bid}")
        s.bids = [PASS, PASS, PASS, PASS]
        s.bids[bidder] = bid
        s.high_bid = bid
        s.bidder = bidder
        s.trump = trump
        s.phase = Phase.PLAY
        s.to_act = s.trump_namer
        s.play_to_end = play_to_end
        return s

    @property
    def trump_namer(self) -> int:
        # Only the winning bidder names trump - except on a Plunge, where their partner does.
        assert self.bidder is not None
        return partner(self.bidder) if self.high_bid == PLUNGE else self.bidder

    @property
    def sits_out(self) -> int | None:
        """On a Low trump the bidder's partner sits out."""
        return partner(self.bidder) if is_low(self.trump) else None

    @property
    def led_suit(self) -> int | None:
        return led_suit(self.trick[0][1], self.trump) if self.trick else None

    @property
    def contract(self) -> Contract | None:
        if self.trump is None:
            return None
        return Contract(self.bidder, self.high_bid, self.trump)

    def hand(self, seat: int) -> list[int]:
        mask = self.hands[seat]
        return [d for d in self.dealt[seat] if mask >> d & 1]

    def legal_actions(self) -> list[int]:
        if self.phase is Phase.BID:
            passes = sum(1 for b in self.bids if b == PASS)
            return available_bids(self.high_bid, passes, doubles_in(self.hands[self.to_act]))
        if self.phase is Phase.TRUMP:
            return available_trumps(self.high_bid)
        if self.phase is Phase.PLAY:
            allowed = legal_plays(self.hands[self.to_act], self.led_suit, self.trump)
            return [d for d in self.hand(self.to_act) if allowed >> d & 1]
        return []

    def apply(self, action: int) -> None:
        legal = self.legal_actions()
        if action not in legal:
            raise IllegalAction(self.to_act, self.phase, action, legal)
        if self.phase is Phase.BID:
            self._bid(action)
        elif self.phase is Phase.TRUMP:
            self.trump = action
            self.phase = Phase.PLAY  # the trump namer leads: to_act doesn't move
        else:
            self._play(action)

    def _bid(self, bid: int) -> None:
        seat = self.to_act
        self.bids[seat] = bid
        if bid != PASS and (self.high_bid is None or bid > self.high_bid):
            self.high_bid = bid
            self.bidder = seat
        if None in self.bids:
            self.to_act = (seat + 1) % 4
        else:
            self.phase = Phase.TRUMP
            self.to_act = self.trump_namer

    def _play(self, domino: int) -> None:
        seat = self.to_act
        bit = 1 << domino
        self.hands[seat] &= ~bit
        self.played[seat] |= bit
        if self.trick:
            led = self.led_suit
            if not is_of_suit(domino, led, self.trump):
                self.voids[seat] |= 1 << led
        self.trick.append((seat, domino))

        if len(self.trick) < (3 if is_low(self.trump) else 4):
            self.to_act = self._next_seat(seat)
            return

        dominoes = [d for _, d in self.trick]
        winner = self.trick[trick_winner(dominoes, self.trump)][0]
        points = sum(VALUE[d] for d in dominoes) + 1
        self.tricks.append(Trick(tuple(self.trick), winner, points))
        self.points[team_of(winner)] += points
        self.trick = []
        self.to_act = winner
        self._check_decided()

    def _next_seat(self, seat: int) -> int:
        nxt = (seat + 1) % 4
        return (nxt + 1) % 4 if nxt == self.sits_out else nxt

    def _check_decided(self) -> None:
        if self.result is None:
            winner = self._decided_winner()
            if winner is not None:
                self.result = HandResult(winner, marks_for(self.high_bid), (self.points[0], self.points[1]))
        # Normally a decided hand stops; in play-to-end mode (simulations) it runs all 7 tricks.
        if self.result is not None and (not self.play_to_end or len(self.tricks) == 7):
            self.phase = Phase.DONE

    def _decided_winner(self) -> int | None:
        bidders = team_of(self.bidder)
        others = 1 - bidders
        if is_low(self.trump):
            # The bidders must lose every trick.
            if any(team_of(t.winner) == bidders for t in self.tricks):
                return others
            return bidders if len(self.tricks) == 7 else None
        target = target_points(self.high_bid)
        if self.points[bidders] >= target:
            return bidders
        if self.points[others] > 42 - target:
            return others
        return None
