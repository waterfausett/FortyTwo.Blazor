from fortytwo_ml.engine.enums import PASS, PLUNGE, Suit
from fortytwo_ml.sim.decide import BidContext, DecideConfig, Option, choose_bid

OPEN = [PASS, *range(30, 43), 84]


def table(**p_by_bid):
    """Options with trump SIXES for bids given as b30=0.8 etc., plus a worse FIVES option."""
    out = []
    for key, p in p_by_bid.items():
        bid = int(key[1:])
        out += [Option(bid, Suit.SIXES, p), Option(bid, Suit.FIVES, p - 0.2)]
    return out


def test_highest_makeable_bid_with_its_best_trump():
    d = choose_bid(table(b30=0.9, b34=0.7, b36=0.55, b38=0.4), BidContext(OPEN, False, False))
    assert (d.bid, d.trump, d.p_make) == (36, Suit.SIXES, 0.55)


def test_pass_when_nothing_is_makeable():
    d = choose_bid(table(b30=0.45, b31=0.3), BidContext(OPEN, False, False))
    assert d.bid == PASS and d.trump is None


def test_last_to_bid_takes_the_lowest_makeable_bid():
    legal = [PASS, *range(32, 43), 84]
    d = choose_bid(table(b32=0.9, b36=0.7, b40=0.6), BidContext(legal, False, True))
    assert d.bid == 32


def test_last_to_bid_prefers_a_marks_bid_with_higher_ev():
    legal = [PASS, *range(32, 43), 84]
    d = choose_bid(table(b32=0.6, b84=0.95), BidContext(legal, False, True))
    assert d.bid == 84  # EV 2*(0.9) = 1.8 > 0.2


def test_forced_bids_thirty_when_nothing_is_makeable():
    forced = [*range(30, 43), 84]
    d = choose_bid(table(b30=0.3, b35=0.1), BidContext(forced, False, True))
    assert d.bid == 30 and d.trump == Suit.SIXES


def test_forced_with_only_thirty_options():
    forced = [*range(30, 43), 84]
    d = choose_bid([Option(30, Suit.ACES, 0.2)], BidContext(forced, False, True))
    assert (d.bid, d.trump) == (30, Suit.ACES)


def test_partner_holds_passes_unless_a_higher_bid_is_near_certain():
    legal = [PASS, *range(31, 43), 84]
    assert choose_bid(table(b31=0.8, b35=0.7), BidContext(legal, True, False)).bid == PASS
    d = choose_bid(table(b31=0.95, b35=0.92, b38=0.6), BidContext(legal, True, False))
    assert d.bid == 35  # highest bid with P >= 0.9


def test_thresholds_are_configurable():
    d = choose_bid(table(b30=0.65), BidContext(OPEN, False, False), DecideConfig(make_threshold=0.7))
    assert d.bid == PASS


def test_options_for_illegal_bids_are_ignored():
    legal = [PASS, 41, 42, 84]
    d = choose_bid(table(b30=0.99, b41=0.4), BidContext(legal, False, False))
    assert d.bid == PASS


def test_plunge_is_a_marks_bid():
    legal = [PASS, *range(31, 43), 84, PLUNGE]
    d = choose_bid(table(b31=0.6) + [Option(PLUNGE, Suit.NONE, 0.8)], BidContext(legal, False, True))
    assert d.bid == PLUNGE  # EV 4*(0.6)=2.4 beats 0.2


def test_forced_with_no_options_bids_lowest_legal():
    forced = [*range(30, 43), 84]
    d = choose_bid([], BidContext(forced, False, True))
    assert d.bid == 30 and d.trump is None


def test_forced_bids_lowest_legal_not_only_available():
    forced = [*range(30, 43), 84]
    d = choose_bid([Option(84, Suit.SIXES, 0.2)], BidContext(forced, False, True))
    assert d.bid == 30 and d.trump is None


def test_partner_holds_threshold_is_configurable():
    legal = [PASS, *range(31, 43), 84]
    d = choose_bid(table(b31=0.92), BidContext(legal, True, False), DecideConfig(overbid_partner_threshold=0.95))
    assert d.bid == PASS
