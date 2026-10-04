import numpy as np
import pytest
import torch

from fortytwo_ml.bidding.data import GenConfig, deal_hand, generate, load_bids, save_batch
from fortytwo_ml.model import QNet, save_checkpoint


@pytest.fixture
def ckpt(tmp_path):
    torch.manual_seed(0)
    path = tmp_path / "run" / "m.pt"
    path.parent.mkdir()
    save_checkpoint(path, QNet(hidden=16, layers=1), step=7, config={})
    return str(path)


def _gen(ckpt, out, hands, seed=1, workers=1, batch=2):
    return generate(GenConfig(ckpt, str(out), hands, sim_deals=2, seed=seed, workers=workers, batch_hands=batch), log=lambda *_: None)


def test_hands_are_deterministic_per_seed_and_index():
    assert deal_hand(1, 5)[0] == deal_hand(1, 5)[0] != deal_hand(1, 6)[0]
    hand = deal_hand(2, 0)[0]
    assert len(set(hand)) == 7 and hand == sorted(hand)


def test_generate_writes_batches_that_load_back(tmp_path, ckpt):
    assert _gen(ckpt, tmp_path / "d", 5) == 5
    assert sorted(p.name for p in (tmp_path / "d").iterdir()) == [
        "gen-s1-0000000.npz", "gen-s1-0000002.npz", "gen-s1-0000004.npz"]
    data = load_bids(tmp_path / "d")
    assert data.hands.shape == (5, 7) and data.points_hist.shape == (5, 7, 43)
    assert (data.points_hist.sum(axis=2) == 2).all() and (data.n_deals == 2).all()
    assert data.play_checkpoint == "run/m.pt" and data.play_step == 7 and data.play_path == ckpt
    assert [list(h) for h in data.hands] == [deal_hand(1, i)[0] for i in range(5)]


def test_rerun_skips_existing_batches_and_new_seed_adds_hands(tmp_path, ckpt):
    _gen(ckpt, tmp_path / "d", 4)
    assert _gen(ckpt, tmp_path / "d", 4) == 0
    assert _gen(ckpt, tmp_path / "d", 4, seed=2) == 4
    assert len(load_bids(tmp_path / "d").hands) == 8


def test_rerun_with_more_hands_fills_the_short_batch(tmp_path, ckpt):
    _gen(ckpt, tmp_path / "d", 3)  # batches of 2 and 1
    assert _gen(ckpt, tmp_path / "d", 4) == 2  # the 1-hand batch is redone as 2 hands
    assert [list(h) for h in load_bids(tmp_path / "d").hands] == [deal_hand(1, i)[0] for i in range(4)]


def test_loading_ignores_temporary_files(tmp_path, ckpt):
    _gen(ckpt, tmp_path / "d", 2)
    (tmp_path / "d" / "gen-s1-0000002.npz.tmp").write_bytes(b"half a file")
    assert len(load_bids(tmp_path / "d").hands) == 2  # the stray partial file is ignored
    _gen(ckpt, tmp_path / "e", 3)
    assert not list((tmp_path / "e").glob("*.tmp"))  # and generate itself leaves none


def test_mixed_play_checkpoints_are_rejected(tmp_path):
    arrays = dict(hands=np.zeros((1, 7), np.int8), points_hist=np.zeros((1, 7, 43), np.uint16),
                  high_made=np.zeros((1, 8), np.uint16), low_clean=np.zeros((1, 3), np.uint16),
                  plunge_made=np.full(1, -1, np.int16))
    save_batch(tmp_path / "gen-s1-0000000.npz", arrays, sim_deals=2, play_checkpoint="a/m.pt", play_path="a/m.pt", play_step=1, seed=1)
    save_batch(tmp_path / "gen-s2-0000000.npz", arrays, sim_deals=2, play_checkpoint="b/m.pt", play_path="b/m.pt", play_step=1, seed=2)
    with pytest.raises(ValueError, match="different play checkpoints"):
        load_bids(tmp_path)


def test_worker_count_does_not_change_the_data(tmp_path, ckpt):
    _gen(ckpt, tmp_path / "one", 4, workers=1)
    _gen(ckpt, tmp_path / "two", 4, workers=2)
    one, two = load_bids(tmp_path / "one"), load_bids(tmp_path / "two")
    assert (one.hands == two.hands).all() and (one.points_hist == two.points_hist).all()
    assert (one.high_made == two.high_made).all() and (one.plunge_made == two.plunge_made).all()


def test_rerun_with_fewer_hands_never_shrinks_a_batch(tmp_path, ckpt):
    _gen(ckpt, tmp_path / "d", 4)  # two batches of 2
    assert _gen(ckpt, tmp_path / "d", 3) == 0  # the 2-hand batch at 2 is kept, not cut to 1
    assert len(load_bids(tmp_path / "d").hands) == 4
