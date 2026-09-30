"""The learner: starts actor processes, trains the Q-network on the GPU from their samples,
publishes weights back, and writes checkpoints and TensorBoard logs."""
import queue as queue_module
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.multiprocessing as mp
import torch.nn.functional as F
import yaml
from torch.utils.tensorboard import SummaryWriter

from ..agents.heuristic_bot import HeuristicBot
from ..agents.model_agent import ModelAgent
from ..eval.arena import evaluate_hands
from ..eval.report import mean_ci
from ..features import INPUT_DIM
from ..model import QNet, load_checkpoint, save_checkpoint
from .actor import actor_main
from .buffer import ReplayBuffer
from .config import TrainConfig, resolve_device, shaping_alpha

_MAX_DRAIN = 64


@dataclass(frozen=True)
class TrainSummary:
    steps: int
    last_loss: float
    checkpoint: Path


def check_actors(actors) -> None:
    for p in actors:
        if not p.is_alive():
            raise RuntimeError(f"{p.name} died (exit code {p.exitcode}); stopping training")


def _drain(queue, buffer: ReplayBuffer, block: bool) -> int:
    added = 0
    for i in range(_MAX_DRAIN):
        try:
            x, marks, pdiff = queue.get(timeout=1.0) if (block and i == 0) else queue.get_nowait()
        except queue_module.Empty:
            break
        buffer.add(x, marks, pdiff)
        added += len(marks)
    return added


def _publish(model: QNet, shared: QNet, version) -> None:
    with torch.no_grad():
        for dst, src in zip(shared.parameters(), model.parameters()):
            dst.copy_(src.detach().cpu())
    version.value += 1


def _cpu_copy(model: QNet) -> QNet:
    copy = QNet(model.hidden, model.layers)
    copy.load_state_dict({k: v.detach().cpu() for k, v in model.state_dict().items()})
    return copy.eval()


def train(cfg: TrainConfig, run_dir: Path, resume: Path | None = None) -> TrainSummary:
    run_dir = Path(run_dir)
    device = resolve_device(cfg)
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "config.yaml").write_text(yaml.safe_dump(cfg.to_dict(), sort_keys=False))
    torch.manual_seed(cfg.seed)

    model = QNet(cfg.hidden, cfg.layers)
    step = 0
    if resume is not None:
        loaded, meta = load_checkpoint(resume)
        model.load_state_dict(loaded.state_dict())
        step = meta["step"]
    model.to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=cfg.lr)

    shared = _cpu_copy(model)
    shared.share_memory()
    ctx = mp.get_context("spawn")
    version = ctx.Value("i", 0)
    queue = ctx.Queue(maxsize=512)
    stop = ctx.Event()
    actors = [
        ctx.Process(target=actor_main, args=(i, cfg, shared, version, queue, stop), name=f"actor-{i}", daemon=True)
        for i in range(cfg.num_actors)
    ]
    for p in actors:
        p.start()

    buffer = ReplayBuffer(cfg.buffer_size, INPUT_DIM)
    np_rng = np.random.default_rng(cfg.seed)
    writer = SummaryWriter(str(run_dir / "tb"))
    last_checkpoint = time.monotonic()
    window_start, window_samples, window_steps = time.monotonic(), 0, 0
    loss_value = float("nan")
    try:
        while step < cfg.total_steps:
            window_samples += _drain(queue, buffer, block=len(buffer) < cfg.min_buffer)
            check_actors(actors)
            if len(buffer) < max(cfg.min_buffer, cfg.batch_size):
                continue

            x, marks, pdiff = buffer.sample(cfg.batch_size, np_rng)
            target = marks + shaping_alpha(cfg, step) * pdiff
            q = model(torch.from_numpy(x).to(device))
            loss = F.mse_loss(q, torch.from_numpy(target).to(device))
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            step += 1
            window_steps += 1
            loss_value = loss.item()

            if step % cfg.weight_sync_every == 0:
                _publish(model, shared, version)
            if step % cfg.log_every == 0:
                elapsed = max(time.monotonic() - window_start, 1e-9)
                writer.add_scalar("train/loss", loss_value, step)
                writer.add_scalar("train/mean_q", q.mean().item(), step)
                writer.add_scalar("train/alpha", shaping_alpha(cfg, step), step)
                writer.add_scalar("train/buffer", len(buffer), step)
                writer.add_scalar("train/samples_per_sec", window_samples / elapsed, step)
                writer.add_scalar("train/replay_ratio", window_steps * cfg.batch_size / max(window_samples, 1), step)
                window_start, window_samples, window_steps = time.monotonic(), 0, 0
            if cfg.eval_every_steps and step % cfg.eval_every_steps == 0:
                result = evaluate_hands(ModelAgent(_cpu_copy(model)), HeuristicBot(), cfg.eval_deals, seed=cfg.seed)
                writer.add_scalar("eval/marks_per_deal_vs_heuristic", mean_ci(result.deal_scores)[0], step)
            if time.monotonic() - last_checkpoint >= cfg.checkpoint_minutes * 60:
                save_checkpoint(run_dir / f"ckpt-{step}.pt", model, step, cfg.to_dict())
                save_checkpoint(run_dir / "ckpt-latest.pt", model, step, cfg.to_dict())
                last_checkpoint = time.monotonic()
    finally:
        if step > 0:  # keep the work done so far on Ctrl+C or an actor failure
            try:
                save_checkpoint(run_dir / f"ckpt-{step}.pt", model, step, cfg.to_dict())
                save_checkpoint(run_dir / "ckpt-latest.pt", model, step, cfg.to_dict())
            except Exception as e:  # best effort; never mask the original error
                print(f"warning: could not save final checkpoint: {e}")
        stop.set()
        for p in actors:
            p.join(timeout=5)
            if p.is_alive():
                p.terminate()
        writer.close()

    latest = run_dir / "ckpt-latest.pt"
    if step == 0:  # nothing trained (total_steps already reached or 0): still leave a checkpoint
        save_checkpoint(latest, model, step, cfg.to_dict())
    return TrainSummary(step, loss_value, latest)
