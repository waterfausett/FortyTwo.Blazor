import math
import random
from pathlib import Path

import pytest
import torch
import torch.multiprocessing as mp
from tensorboard.backend.event_processing.event_accumulator import EventAccumulator

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


def test_publish_copies_in_place_into_shared_memory():
    import multiprocessing as std_mp

    from fortytwo_ml.model import QNet
    from fortytwo_ml.train.run import _cpu_copy, _publish

    src = QNet(hidden=16, layers=2)
    shared = _cpu_copy(QNet(hidden=16, layers=2))
    shared.share_memory()
    pointers = [p.data_ptr() for p in shared.parameters()]
    version = std_mp.Value("i", 0)
    _publish(src, shared, version)
    assert version.value == 1
    assert [p.data_ptr() for p in shared.parameters()] == pointers  # same storage: actors still see it
    for a, b in zip(shared.parameters(), src.parameters()):
        assert torch.equal(a, b.detach())


def test_smoke_run_logs_learning_diagnostics_and_restores_threads(tmp_path):
    cfg = TrainConfig.from_yaml(CONFIGS / "smoke.yaml")
    threads = torch.get_num_threads()
    train(cfg, tmp_path / "run")
    assert torch.get_num_threads() == threads
    ea = EventAccumulator(str(tmp_path / "run" / "tb"))
    ea.Reload()
    tags = set(ea.Tags()["scalars"])
    assert {"eval/agree_chance", "eval/agree_heuristic", "eval/action_stability"} <= tags


def test_checkpoint_carries_raw_and_optimizer_and_resume_uses_them(tmp_path):
    cfg = TrainConfig.from_yaml(CONFIGS / "smoke.yaml")
    first = train(cfg, tmp_path / "a")
    data = torch.load(first.checkpoint, weights_only=True)
    assert {"model", "raw", "optimizer"} <= set(data) and data["optimizer"]["state"]
    more = TrainConfig(**{**cfg.to_dict(), "total_steps": cfg.total_steps + 20})
    assert train(more, tmp_path / "b", resume=first.checkpoint).steps == cfg.total_steps + 20


def test_max_seconds_stops_training_early(tmp_path):
    cfg = TrainConfig(**{**TrainConfig.from_yaml(CONFIGS / "smoke.yaml").to_dict(),
                         "total_steps": 10**9, "max_seconds": 2.0, "eval_every_steps": 0})
    summary = train(cfg, tmp_path / "run")
    assert 0 < summary.steps < 10**9 and 2.0 <= summary.train_seconds < 5
    assert summary.samples_while_training > 0


def test_failed_setup_restores_thread_count(tmp_path):
    cfg = TrainConfig.from_yaml(CONFIGS / "smoke.yaml")
    bad = tmp_path / "old.pt"
    torch.save({"model": {}, "step": 0, "config": {}, "hidden": 16, "layers": 2, "input_dim": 353}, bad)
    threads = torch.get_num_threads()
    with pytest.raises(ValueError, match="353"):
        train(cfg, tmp_path / "run", resume=bad)
    assert torch.get_num_threads() == threads
