import random
from pathlib import Path

import numpy as np
import pytest
import torch

from fortytwo_ml.contracts import DEFAULT_MIX, ContractSampler
from fortytwo_ml.features import INPUT_DIM
from fortytwo_ml.model import QNet
from fortytwo_ml.train.actor import pack_hands
from fortytwo_ml.train.buffer import ReplayBuffer
from fortytwo_ml.train.config import TrainConfig, replay_starved, resolve_device, shaping_alpha
from fortytwo_ml.train.selfplay import play_selfplay_hand

CONFIGS = Path(__file__).parent.parent / "configs"


def test_configs_load():
    stage1 = TrainConfig.from_yaml(CONFIGS / "stage1.yaml")
    assert stage1.device == "cuda" and stage1.contract_mix["heuristic"] == 0.7
    assert (stage1.lr, stage1.batch_size, stage1.ema_decay, stage1.max_replay_ratio) == (1e-4, 4096, 0.999, 4.0)
    assert (stage1.total_steps, stage1.alpha_decay_steps, stage1.eval_every_steps) == (200_000, 20_000, 2_000)
    assert (stage1.actor_send_hands, stage1.learner_threads, stage1.diag_decisions) == (16, 2, 2000)
    smoke = TrainConfig.from_yaml(CONFIGS / "smoke.yaml")
    assert smoke.device == "cpu" and smoke.num_actors == 2


def test_default_actor_count_leaves_a_physical_core_free(monkeypatch):
    monkeypatch.setattr("os.cpu_count", lambda: 16)
    assert TrainConfig().num_actors == 7
    monkeypatch.setattr("os.cpu_count", lambda: 2)
    assert TrainConfig().num_actors == 1


def test_replay_cap_is_cumulative_and_can_be_disabled():
    cfg = TrainConfig(max_replay_ratio=4.0)
    assert not replay_starved(cfg, consumed=4000, added=1000)
    assert replay_starved(cfg, consumed=4001, added=1000)
    assert not replay_starved(TrainConfig(max_replay_ratio=0), consumed=10**9, added=1)


def test_unknown_config_keys_are_rejected(tmp_path):
    path = tmp_path / "bad.yaml"
    path.write_text("learning_rate: 0.1\n")
    with pytest.raises(ValueError, match="learning_rate"):
        TrainConfig.from_yaml(path)


def test_shaping_decays_to_zero():
    cfg = TrainConfig(alpha0=0.25, alpha_decay_steps=100)
    assert shaping_alpha(cfg, 0) == 0.25
    assert shaping_alpha(cfg, 50) == pytest.approx(0.125)
    assert shaping_alpha(cfg, 100) == 0 and shaping_alpha(cfg, 500) == 0


def test_resolve_device_fails_fast_without_cuda(monkeypatch):
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    with pytest.raises(RuntimeError, match="allow_cpu_fallback"):
        resolve_device(TrainConfig(device="cuda"))


def test_resolve_device_falls_back_when_allowed(monkeypatch):
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    assert resolve_device(TrainConfig(device="cuda", allow_cpu_fallback=True)).type == "cpu"


def test_selfplay_hand_yields_consistent_samples():
    rng = random.Random(0)
    model = QNet(hidden=32, layers=2)
    for _ in range(20):
        x, marks, pdiff = play_selfplay_hand(model, ContractSampler(DEFAULT_MIX, rng), rng, epsilon=0.1)
        assert x.shape == (len(marks), INPUT_DIM) and len(pdiff) == len(marks)
        assert np.all(np.abs(marks) >= 1)
        assert np.all(np.abs(pdiff) <= 1)


def test_buffer_wraps_and_samples():
    buf = ReplayBuffer(capacity=10, dim=3)
    for i in range(4):
        buf.add(np.full((4, 3), i, np.float16), np.full(4, i, np.float32), np.zeros(4, np.float32))
    assert len(buf) == 10
    # slots 0-1 and 8-9 hold batch 2 (it wrapped), 2-5 batch 3, 6-7 what's left of batch 1
    assert buf._marks.tolist() == [2, 2, 3, 3, 3, 3, 1, 1, 2, 2]
    x, marks, pdiff = buf.sample(6)
    assert x.shape == (6, 3) and x.dtype == torch.float32 and marks.shape == (6,)
    assert set(marks.tolist()) <= {1.0, 2.0, 3.0}


def test_buffer_keeps_only_the_newest_rows_of_an_oversized_batch():
    buf = ReplayBuffer(capacity=4, dim=1)
    buf.add(np.arange(6, dtype=np.float32).reshape(6, 1), np.arange(6, dtype=np.float32), np.zeros(6, np.float32))
    assert len(buf) == 4 and sorted(buf._marks.tolist()) == [2, 3, 4, 5]


def test_empty_buffer_refuses_to_sample():
    with pytest.raises(ValueError):
        ReplayBuffer(capacity=4, dim=1).sample(1)


def test_pack_hands_concatenates_and_halves_the_rows():
    a = (np.ones((2, 3), np.float32), np.array([1, 1], np.float32), np.array([0.5, 0.5], np.float32))
    b = (np.zeros((3, 3), np.float32), np.array([-2, -2, -2], np.float32), np.zeros(3, np.float32))
    x, marks, pdiff = pack_hands([a, b])
    assert x.dtype == np.float16 and x.shape == (5, 3)
    assert marks.tolist() == [1, 1, -2, -2, -2] and pdiff.dtype == np.float32


def test_low_contract_selfplay_has_zero_point_shaping():
    rng = random.Random(1)
    model = QNet(hidden=32, layers=2)
    for _ in range(5):
        x, marks, pdiff = play_selfplay_hand(model, ContractSampler({"low": 1.0}, rng), rng, epsilon=0.1)
        assert len(marks) > 0 and np.all(pdiff == 0)


def test_plunge_finetune_config_loads():
    cfg = TrainConfig.from_yaml(CONFIGS / "stage1-plunge.yaml")
    assert cfg.total_steps == 230_000 and cfg.contract_mix["plunge"] == 0.1 and cfg.contract_mix["heuristic"] == 0.65
