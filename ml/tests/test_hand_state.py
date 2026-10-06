import random

import pytest

from conftest import deal_with
from fortytwo_ml.engine.dominoes import from_id
from fortytwo_ml.engine.enums import NAMED_SUITS, PASS, PLUNGE, Suit
from fortytwo_ml.engine.hand_state import Contract, HandState, IllegalAction, Phase

d = from_id

# Trump-sixes fixture: seat 0 holds six trumps plus 0/1, seat 1 is long in aces, seats 2 and 3
# hold no aces (and seat 2 no sixes).
HANDS = {
    0: ["0/1", "6/6", "5/6", "4/6", "3/6", "2/6", "1/6"],
    1: ["1/5", "1/1", "1/2", "1/3", "1/4", "0/0", "0/2"],
    2: ["0/3", "0/4", "0/5", "2/2", "2/3", "2/4", "2/5"],
    3: ["0/6", "3/3", "3/4", "3/5", "4/4", "4/5", "5/5"],
}
DEAL = [d(x) for seat in range(4) for x in HANDS[seat]]


def test_deal_gives_each_seat_its_slice_in_order():
    state = HandState.deal(DEAL, opener=2)
    assert state.hand(1) == [d(x) for x in HANDS[1]]
    assert state.phase is Phase.BID and state.to_act == 2


def test_deal_rejects_a_bad_order():
    with pytest.raises(ValueError):
        HandState.deal(DEAL[:-1] + [DEAL[0]], opener=0)


def test_bidding_goes_round_once_then_the_high_bidder_names_trump_and_leads():
    state = HandState.deal(DEAL, opener=2)
    for seat, bid in [(2, PASS), (3, 31), (0, 35), (1, PASS)]:
        assert state.to_act == seat
        state.apply(bid)
    assert state.phase is Phase.TRUMP and state.to_act == 0 and state.bidder == 0
    assert state.legal_actions() == list(NAMED_SUITS)
    state.apply(Suit.SIXES)
    assert state.phase is Phase.PLAY and state.to_act == 0
    assert state.contract == Contract(0, 35, Suit.SIXES)


def test_illegal_bid_raises():
    state = HandState.deal(DEAL, opener=0)
    state.apply(35)
    with pytest.raises(IllegalAction):
        state.apply(33)


def test_plunge_partner_names_trump_and_leads():
    deal = deal_with({1: [(0, 0), (1, 1), (2, 2), (3, 3)]})
    state = HandState.deal(deal, opener=0)
    for bid in (PASS, PLUNGE, PASS, PASS):
        state.apply(bid)
    assert state.phase is Phase.TRUMP and state.to_act == 3
    assert state.legal_actions() == [*NAMED_SUITS, Suit.NONE]
    state.apply(Suit.NONE)
    assert state.phase is Phase.PLAY and state.to_act == 3


def test_follow_suit_is_enforced_and_voids_recorded():
    state = HandState.from_contract(DEAL, bidder=0, bid=42, trump=Suit.SIXES)
    state.apply(d("0/1"))
    with pytest.raises(IllegalAction):
        state.apply(d("0/0"))
    assert state.legal_actions() == [d("1/5"), d("1/1"), d("1/2"), d("1/3"), d("1/4")]
    state.apply(d("1/5"))
    state.apply(d("0/3"))
    assert state.voids[2] == 1 << Suit.ACES


def test_hand_ends_as_soon_as_it_is_decided():
    # Bid 42 needs every point; the defenders take trick one, so the hand is over.
    state = HandState.from_contract(DEAL, bidder=0, bid=42, trump=Suit.SIXES)
    for x in ("0/1", "1/5", "0/3", "3/3"):
        state.apply(d(x))
    assert state.phase is Phase.DONE
    assert state.result.winning_team == 1 and state.result.marks == 1
    assert state.result.points == (0, 1)
    assert state.legal_actions() == []


def test_low_skips_partner_and_closes_trick_at_three():
    state = HandState.from_contract(DEAL, bidder=0, bid=42, trump=Suit.LOW)
    assert state.sits_out == 2 and state.to_act == 0
    state.apply(d("6/6"))
    state.apply(d("0/0"))
    assert state.to_act == 3
    assert state.legal_actions() == [d("0/6")]
    state.apply(d("0/6"))
    # The bidder took a trick, so the Low bid failed.
    assert state.phase is Phase.DONE and len(state.tricks[0].plays) == 3
    assert state.result.winning_team == 1


def test_from_contract_rejects_impossible_contracts():
    with pytest.raises(ValueError):
        HandState.from_contract(DEAL, bidder=0, bid=PLUNGE, trump=Suit.SIXES)  # 1 double
    with pytest.raises(ValueError):
        HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.LOW)
    with pytest.raises(ValueError):
        HandState.from_contract(DEAL, bidder=0, bid=PASS, trump=Suit.SIXES)


def test_random_hands_always_finish_consistently():
    rng = random.Random(7)
    for _ in range(500):
        order = list(range(28))
        rng.shuffle(order)
        state = HandState.deal(order, opener=rng.randrange(4))
        while state.phase is not Phase.DONE:
            state.apply(rng.choice(state.legal_actions()))
        assert 1 <= len(state.tricks) <= 7
        assert sum(state.points) <= 42
        if len(state.tricks) == 7 and state.sits_out is None:
            assert sum(state.points) == 42


def _play_seeded(state, rng):
    while state.phase is not Phase.DONE:
        state.apply(rng.choice(state.legal_actions()))
    return state


def test_play_to_end_keeps_the_official_result_and_plays_seven_tricks():
    rng = random.Random(11)
    for _ in range(200):
        order = list(range(28))
        rng.shuffle(order)
        bidder, trump = rng.randrange(4), rng.choice([0, 1, 2, 3, 4, 5, 6])
        seed = rng.random()
        normal = _play_seeded(HandState.from_contract(order, bidder, 30, trump), random.Random(seed))
        full = _play_seeded(HandState.from_contract(order, bidder, 30, trump, play_to_end=True), random.Random(seed))
        assert full.result == normal.result
        assert len(full.tricks) == 7 and sum(full.points) == 42


def test_play_to_end_low_keeps_three_domino_tricks():
    state = HandState.from_contract(DEAL, bidder=0, bid=42, trump=Suit.LOW, play_to_end=True)
    state.apply(d("6/6"))  # nothing beats the double six on a sixes lead, so the bidder takes trick one
    _play_seeded(state, random.Random(2))
    assert state.result.winning_team == 1  # decided (Low failed) after trick one...
    assert len(state.tricks) == 7 and all(len(t.plays) == 3 for t in state.tricks)  # ...but played on
    assert all(seat != 2 for t in state.tricks for seat, _ in t.plays)  # partner still sits out
