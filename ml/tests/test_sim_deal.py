import random

import pytest

from fortytwo_ml.engine.dominoes import doubles_in, to_mask
from fortytwo_ml.sim.deal import deal_unseen

HAND = [0, 5, 9, 13, 20, 24, 27]


def test_keeps_the_hand_and_deals_a_permutation():
    rng = random.Random(1)
    for seat in range(4):
        order = deal_unseen(seat, HAND, rng)
        assert sorted(order) == list(range(28)) and order[seat * 7:(seat + 1) * 7] == HAND


def test_deals_differ_and_are_seeded():
    a = deal_unseen(0, HAND, random.Random(3))
    b = deal_unseen(0, HAND, random.Random(3))
    c = deal_unseen(0, HAND, random.Random(4))
    assert a == b and a != c


def test_require_gives_a_seat_enough_doubles():
    rng = random.Random(5)
    for _ in range(50):
        order = deal_unseen(0, HAND, rng, require=(2, 4))
        assert doubles_in(to_mask(order[14:21])) >= 4


def test_impossible_requirement_raises():
    hand_with_all_doubles = [0, 7, 13, 18, 22, 25, 27]  # 0/0 1/1 2/2 3/3 4/4 5/5 6/6
    with pytest.raises(ValueError):
        deal_unseen(0, hand_with_all_doubles, random.Random(0), require=(1, 1), max_tries=20)


def test_rejects_a_hand_that_is_not_seven_dominoes():
    with pytest.raises(ValueError):
        deal_unseen(0, HAND[:6], random.Random(0))
