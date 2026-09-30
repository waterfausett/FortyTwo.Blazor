import math
import random
from pathlib import Path

import pytest
import torch
import torch.multiprocessing as mp

from fortytwo_ml.agents.base import run_hand
from fortytwo_ml.agents.model_agent import ModelAgent
from fortytwo_ml.engine.hand_state import HandState, Phase
from fortytwo_ml.train.config import TrainConfig
from fortytwo_ml.train.run import check_actors, train

CONFIGS = Path(__file__).parent.parent / "configs"


def test_check_actors_raises_when_an_actor_died():
    ctx = mp.get_context("spawn")
    p = ctx.Process(target=int, name="actor-7")
    p.start()
    p.join()
    with pytest.raises(RuntimeError, match="actor-7"):
        check_actors([p])


def test_smoke_training_run_produces_a_playable_checkpoint(tmp_path):
    cfg = TrainConfig.from_yaml(CONFIGS / "smoke.yaml")
    summary = train(cfg, tmp_path / "run")
    assert summary.steps == cfg.total_steps
    assert math.isfinite(summary.last_loss)
    assert (tmp_path / "run" / "config.yaml").exists()
    assert list((tmp_path / "run" / "tb").iterdir())

    agent = ModelAgent.from_checkpoint(summary.checkpoint)
    order = list(range(28))
    random.Random(0).shuffle(order)
    state = HandState.deal(order, opener=0)
    run_hand(state, [agent] * 4)
    assert state.phase is Phase.DONE


def test_resume_continues_from_the_checkpoint_step(tmp_path):
    cfg = TrainConfig.from_yaml(CONFIGS / "smoke.yaml")
    first = train(cfg, tmp_path / "a")
    more = TrainConfig(**{**cfg.to_dict(), "total_steps": cfg.total_steps + 40})
    second = train(more, tmp_path / "b", resume=first.checkpoint)
    assert second.steps == cfg.total_steps + 40


def test_failed_run_still_saves_a_loadable_checkpoint(tmp_path, monkeypatch):
    from fortytwo_ml.model import load_checkpoint
    from fortytwo_ml.train import run as run_module

    calls = {"n": 0}

    def flaky(actors):
        calls["n"] += 1
        if calls["n"] > 150:
            raise RuntimeError("actor-0 died")

    monkeypatch.setattr(run_module, "check_actors", flaky)
    cfg = TrainConfig.from_yaml(CONFIGS / "smoke.yaml")
    cfg = TrainConfig(**{**cfg.to_dict(), "total_steps": 100_000})
    with pytest.raises(RuntimeError, match="actor-0 died"):
        train(cfg, tmp_path / "run")
    _, meta = load_checkpoint(tmp_path / "run" / "ckpt-latest.pt")
    assert meta["step"] > 0
    assert not list((tmp_path / "run").glob("*.tmp"))


def test_device_refusal_leaves_no_run_dir_files(tmp_path, monkeypatch):
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    cfg = TrainConfig(device="cuda", allow_cpu_fallback=False)
    with pytest.raises(RuntimeError, match="CUDA"):
        train(cfg, tmp_path / "run")
    assert not (tmp_path / "run" / "config.yaml").exists()
