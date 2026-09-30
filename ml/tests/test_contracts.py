import random

import pytest

from fortytwo_ml.agents.base import run_hand
from fortytwo_ml.agents.heuristic_bot import HeuristicBot
from fortytwo_ml.contracts import DEFAULT_MIX, ContractSampler, contract_kind
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
