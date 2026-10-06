import random

import pytest

from fortytwo_ml.agents.base import run_hand
from fortytwo_ml.agents.heuristic_bot import HeuristicBot
from fortytwo_ml.contracts import DEFAULT_MIX, ContractSampler, best_low, contract_kind, low_risk
from fortytwo_ml.engine.dominoes import doubles_in, index_of, to_mask
from fortytwo_ml.engine.enums import LOW_TRUMPS, PLUNGE, Suit
from fortytwo_ml.engine.hand_state import Contract, HandState, Phase


def _deals(n, seed=0):
    rng = random.Random(seed)
    for _ in range(n):
        order = list(range(28))
        rng.shuffle(order)
        yield order, rng.randrange(4)


@pytest.mark.parametrize("kind", ["heuristic", "marks", "follow_me", "low", "plunge"])
def test_every_kind_yields_contracts_the_engine_accepts(kind):
    sampler = ContractSampler({kind: 1.0}, random.Random(1))
    for deal, opener in _deals(200):
        c = sampler.sample(deal, opener)
        HandState.from_contract(deal, c.bidder, c.bid, c.trump)  # raises if impossible


def test_forced_kinds_produce_their_contract_types():
    rng = random.Random(2)
    deal, opener = next(_deals(1))
    assert contract_kind(ContractSampler({"follow_me": 1}, rng).sample(deal, opener)) == "follow_me"
    assert contract_kind(ContractSampler({"marks": 1}, rng).sample(deal, opener)) == "marks"
    low = ContractSampler({"low": 1}, rng).sample(deal, opener)
    assert low.trump in LOW_TRUMPS and contract_kind(low) == "low"


def test_plunge_falls_back_when_nobody_holds_four_doubles():
    kinds = {contract_kind(ContractSampler({"plunge": 1}, random.Random(3)).sample(d, o)) for d, o in _deals(300)}
    assert "plunge" in kinds and kinds - {"plunge"}


def test_contract_kind_classification():
    assert contract_kind(Contract(0, PLUNGE, Suit.NONE)) == "plunge"
    assert contract_kind(Contract(0, 42, Suit.LOW)) == "low"
    assert contract_kind(Contract(0, 42, Suit.NONE)) == "follow_me"
    assert contract_kind(Contract(0, 84, Suit.SIXES)) == "marks"
    assert contract_kind(Contract(0, 31, Suit.SIXES)) == "points"


def test_unknown_kind_is_rejected():
    with pytest.raises(ValueError):
        ContractSampler({"nello": 1.0}, random.Random(0))


def test_heuristic_plays_every_sampled_contract_legally():
    sampler = ContractSampler(DEFAULT_MIX, random.Random(4))
    for deal, opener in _deals(500, seed=4):
        c = sampler.sample(deal, opener)
        state = HandState.from_contract(deal, c.bidder, c.bid, c.trump)
        run_hand(state, [HeuristicBot()] * 4)
        assert state.phase is Phase.DONE


def test_low_risk_by_variant():
    hand = [index_of(0, 0), index_of(1, 2), index_of(6, 6)]
    assert low_risk(hand, Suit.LOW) == (0 + 3) + 2 + (6 + 3)
    assert low_risk(hand, Suit.LOW_DOUBLES_LOW) == 0 + 2 + 0
    assert low_risk(hand, Suit.LOW_DOUBLES_OWN_SUIT) == 0 + 2 + 6


def test_best_low_picks_the_safest_seat_and_variant():
    def pips(*ps):
        return [index_of(a, b) for a, b in ps]
    hands = [
        pips((6, 6), (5, 6), (4, 6), (3, 6), (2, 6), (1, 6), (0, 6)),
        pips((0, 0), (1, 1), (2, 2), (0, 1), (0, 2), (1, 2), (0, 3)),  # low, doubles-heavy
        pips((5, 5), (4, 5), (3, 5), (2, 5), (1, 5), (0, 5), (4, 4)),
        pips((3, 3), (3, 4), (2, 4), (1, 4), (0, 4), (2, 3), (1, 3)),
    ]
    assert best_low(hands) == (1, Suit.LOW_DOUBLES_LOW)


def test_sample_hand_plunge_always_has_a_four_double_plunger():
    sampler = ContractSampler({"plunge": 1.0}, random.Random(5))
    plunges = 0
    for _ in range(200):
        order, opener, c = sampler.sample_hand()
        HandState.from_contract(order, c.bidder, c.bid, c.trump)
        if contract_kind(c) == "plunge":
            plunges += 1
            assert doubles_in(to_mask(order[c.bidder * 7:(c.bidder + 1) * 7])) >= 4
    assert plunges >= 195  # the 100-try cap almost never runs out


def test_sample_hand_low_goes_to_the_best_low_hand():
    sampler = ContractSampler({"low": 1.0}, random.Random(6))
    for _ in range(50):
        order, _, c = sampler.sample_hand()
        hands = [order[p * 7:(p + 1) * 7] for p in range(4)]
        assert (c.bidder, c.trump) == best_low(hands) and c.bid == 42


def test_sample_hand_is_deterministic_for_a_seed():
    a = [ContractSampler(DEFAULT_MIX, random.Random(9)).sample_hand() for _ in range(1)]
    b = [ContractSampler(DEFAULT_MIX, random.Random(9)).sample_hand() for _ in range(1)]
    assert a == b
