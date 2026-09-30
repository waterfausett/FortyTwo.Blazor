import random
from pathlib import Path

import numpy as np
import pytest
import torch

from fortytwo_ml.contracts import DEFAULT_MIX, ContractSampler
from fortytwo_ml.features import INPUT_DIM
from fortytwo_ml.model import QNet
from fortytwo_ml.train.buffer import ReplayBuffer
from fortytwo_ml.train.config import TrainConfig, resolve_device, shaping_alpha
from fortytwo_ml.train.selfplay import play_selfplay_hand

CONFIGS = Path(__file__).parent.parent / "configs"


def test_configs_load():
    stage1 = TrainConfig.from_yaml(CONFIGS / "stage1.yaml")
    assert stage1.device == "cuda" and stage1.contract_mix["heuristic"] == 0.7
    smoke = TrainConfig.from_yaml(CONFIGS / "smoke.yaml")
    assert smoke.device == "cpu" and smoke.num_actors == 2


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
        buf.add(np.full((4, 3), i, np.float32), np.full(4, i, np.float32), np.zeros(4, np.float32))
    assert len(buf) == 10
    x, marks, pdiff = buf.sample(6, np.random.default_rng(0))
    assert x.shape == (6, 3) and x.dtype == np.float32
    assert set(np.unique(marks)) <= {1.0, 2.0, 3.0}  # the first batch was overwritten
