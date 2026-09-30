import random

from conftest import deal_with
from fortytwo_ml.agents.base import run_hand
from fortytwo_ml.agents.dumb_bot import DumbBot
from fortytwo_ml.agents.heuristic_bot import HeuristicBot, best_suit
from fortytwo_ml.engine.dominoes import VALUE, from_id
from fortytwo_ml.engine.enums import PASS, Suit
from fortytwo_ml.engine.hand_state import HandState, Phase

d = from_id

HANDS = {
    0: ["0/1", "6/6", "5/6", "4/6", "3/6", "2/6", "1/6"],
    1: ["1/5", "1/1", "1/2", "1/3", "1/4", "0/0", "0/2"],
    2: ["0/3", "0/4", "0/5", "2/2", "2/3", "2/4", "2/5"],
    3: ["0/6", "3/3", "3/4", "3/5", "4/4", "4/5", "5/5"],
}
DEAL = [d(x) for seat in range(4) for x in HANDS[seat]]


# --- DumbBot mirrors apps/worker/src/bots.test.ts ---

def test_dumb_passes_unless_forced():
    state = HandState.deal(DEAL, opener=0)
    assert DumbBot().bid(state, 0) == PASS
    for _ in range(3):
        state.apply(PASS)
    assert DumbBot().bid(state, 3) == 30


def test_dumb_trump_is_most_held_suit_lowest_on_ties():
    deal = deal_with({0: [(2, 2), (2, 5), (3, 4), (0, 1), (6, 6), (3, 3), (4, 4)]})
    assert DumbBot().trump(HandState.deal(deal, opener=0), 0) == Suit.DEUCES


def test_dumb_plays_first_legal_domino_in_hand_order():
    state = HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.SIXES)
    assert DumbBot().play(state, 0) == d("0/1")
    state.apply(d("0/1"))
    assert DumbBot().play(state, 1) == d("1/5")


# --- HeuristicBot ---

def test_heuristic_bids_a_strong_hand_and_passes_a_weak_one():
    state = HandState.deal(DEAL, opener=0)
    bid = HeuristicBot().bid(state, 0)
    assert 30 <= bid <= 42
    state.apply(bid)
    assert HeuristicBot().bid(state, 1) == PASS


def test_heuristic_is_forced_to_bid_30():
    state = HandState.deal(DEAL, opener=1)
    for _ in range(3):
        state.apply(PASS)
    assert state.to_act == 0 and HeuristicBot().bid(state, 0) in state.legal_actions()


def test_heuristic_names_its_best_suit():
    state = HandState.deal(DEAL, opener=0)
    assert best_suit(state.hand(0))[0] == Suit.SIXES


def test_heuristic_leads_top_trump_while_others_may_hold_trump():
    state = HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.SIXES)
    assert HeuristicBot().play(state, 0) == d("6/6")


def test_heuristic_drops_count_on_partners_winning_trick():
    state = HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.SIXES)
    state.apply(d("6/6"))
    state.apply(d("1/1"))
    assert VALUE[HeuristicBot().play(state, 2)] == 5


def test_heuristic_wins_cheaply_when_opponent_is_winning():
    state = HandState.from_contract(DEAL, bidder=0, bid=30, trump=Suit.SIXES)
    state.apply(d("0/1"))
    assert HeuristicBot().play(state, 1) == d("1/2")


def test_heuristic_low_bidder_leads_its_lowest_domino():
    state = HandState.from_contract(DEAL, bidder=0, bid=42, trump=Suit.LOW)
    assert HeuristicBot().play(state, 0) == d("0/1")


def test_bots_only_ever_choose_legal_actions():
    rng = random.Random(3)
    for agents in ([HeuristicBot()] * 4, [DumbBot()] * 4, [HeuristicBot(), DumbBot()] * 2):
        for _ in range(300):
            order = list(range(28))
            rng.shuffle(order)
            state = HandState.deal(order, opener=rng.randrange(4))
            run_hand(state, agents)  # raises IllegalAction on any illegal choice
            assert state.phase is Phase.DONE
