import random

import numpy as np
import torch

from fortytwo_ml.bidding.data import BidData
from fortytwo_ml.bidding.model import BidNet, encode_hands, load_bidnet, save_bidnet
from fortytwo_ml.bidding.train import (
    BidTrainConfig, bid_loss, bucket_counts, gold_report, is_validation, simulated_tables, train_bidnet,
)
from fortytwo_ml.engine.dominoes import PIPS


def _hands(n, seed):
    rng = random.Random(seed)
    return np.array([sorted(rng.sample(range(28), 7)) for _ in range(n)])


def _rule_data(hands, n_deals=20):
    """Synthetic labels with a learnable rule: a suit's 30-bid points are 26 + 3 x (dominoes in it)."""
    count = len(hands)
    hist = np.zeros((count, 7, 43), np.int64)
    for i, hand in enumerate(hands):
        for s in range(7):
            held = sum(1 for d in hand if s in PIPS[d])
            hist[i, s, min(42, 26 + 3 * held)] = n_deals
    high = (hist[:, :, 42] > 0).astype(np.int64) * n_deals
    high = np.concatenate([high, np.zeros((count, 1), np.int64)], axis=1)
    return BidData(hands, hist, high, np.zeros((count, 3), np.int64), np.full(count, -1),
                   np.full(count, n_deals), "run/m.pt", "runs/run/m.pt", 1)


def test_encode_hands_bits_and_counts():
    x = encode_hands(np.array([[0, 1, 2, 3, 4, 5, 6]]))  # 0/0 0/1 ... 0/6: every domino has a 0
    assert x.shape == (1, 36) and x[0, :7].sum() == 7 and x[0, 7:28].sum() == 0
    assert x[0, 28] == 1.0  # seven dominoes contain a 0
    assert abs(x[0, 35] - 1 / 7) < 1e-6  # one double (0/0)


def test_points_probabilities_never_rise_with_the_bid():
    torch.manual_seed(0)
    points, binary = BidNet(hidden=16, layers=1).predict(_hands(20, 1))
    assert (np.diff(points, axis=2) <= 1e-7).all() and points.shape == (20, 7, 12) and binary.shape == (20, 12)


def test_table_has_plunge_only_with_four_doubles():
    net = BidNet(hidden=16, layers=1)
    assert net.table([1, 2, 3, 4, 5, 6, 8]).plunge is None
    assert net.table([0, 7, 13, 18, 1, 2, 3]).plunge is not None


def test_bucket_counts_keep_every_deal():
    hist = np.zeros((1, 7, 43), np.int64)
    hist[0, 0, [5, 29, 30, 41, 42]] = [1, 2, 3, 4, 5]
    b = bucket_counts(hist)
    assert b.shape == (1, 7, 14) and list(b[0, 0]) == [3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 5]


def test_validation_split_is_stable_and_small():
    hands = _hands(4000, 2)
    mask = is_validation(hands)
    assert (mask == is_validation(hands)).all() and 0.03 < mask.mean() < 0.07


def test_loss_prefers_the_right_answer():
    buckets = torch.zeros(1, 7, 14)
    buckets[:, :, 5] = 10
    made, mask, n = torch.tensor([[10.0] * 12]), torch.ones(1, 12), torch.tensor([10.0])
    right = torch.full((1, 7, 14), -9.0)
    right[:, :, 5] = 9.0
    wrong = torch.zeros(1, 7, 14)
    good = bid_loss(right, torch.full((1, 12), 9.0), buckets, made, mask, n)
    bad = bid_loss(wrong, torch.full((1, 12), -9.0), buckets, made, mask, n)
    assert good < bad


def test_training_learns_a_known_rule_and_round_trips(tmp_path):
    data, gold = _rule_data(_hands(800, 3)), _rule_data(_hands(100, 4))
    torch.manual_seed(0)
    _, before = gold_report(BidNet(hidden=32, layers=2), gold)
    result = train_bidnet(data, BidTrainConfig(hidden=32, layers=2, epochs=40, batch_size=64), log=lambda *_: None)
    lines, after = gold_report(result.net, gold)
    assert after["mae_30"] < before["mae_30"] / 2 and any("Calibration" in line for line in lines)
    save_bidnet(tmp_path / "b.pt", result.net, {"play_checkpoint": "run/m.pt", "play_path": "x", "play_step": 1,
                                                "train_hands": 800, "val_loss": result.val_loss, "gold": after})
    net, meta = load_bidnet(tmp_path / "b.pt")
    assert meta["play_step"] == 1 and np.allclose(net.predict(gold.hands)[0], result.net.predict(gold.hands)[0])


def test_simulated_tables_match_counts():
    data = _rule_data(_hands(3, 5))
    points, binary, mask = simulated_tables(data)
    assert points.shape == (3, 7, 12) and set(np.unique(points)) <= {0.0, 1.0}
    assert (mask[:, 11] == 0).all() and (mask[:, :11] == 1).all()
