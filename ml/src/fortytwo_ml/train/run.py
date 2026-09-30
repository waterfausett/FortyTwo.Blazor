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
from ..eval.diagnostics import agreement, build_decision_set, chance_agreement, model_choices
from ..model import QNet, load_checkpoint, load_training_state, save_checkpoint
from .actor import actor_main
from .buffer import ReplayBuffer
from .config import TrainConfig, replay_starved, resolve_device, shaping_alpha
from .ema import make_ema, update_ema

_MAX_DRAIN = 64


@dataclass(frozen=True)
class TrainSummary:
    steps: int
    last_loss: float
    checkpoint: Path
    train_seconds: float = 0.0          # wall time from the first learner step to the end
    samples_while_training: int = 0     # samples ingested over that time


def check_actors(actors) -> None:
    for p in actors:
        if not p.is_alive():
            raise RuntimeError(f"{p.name} died (exit code {p.exitcode}); stopping training")


def _drain(queue, buffer: ReplayBuffer, block: bool) -> int:
    xs, marks, pdiffs = [], [], []
    for i in range(_MAX_DRAIN):
        try:
            x, m, p = queue.get(timeout=1.0) if (block and i == 0) else queue.get_nowait()
        except queue_module.Empty:
            break
        xs.append(x)
        marks.append(m)
        pdiffs.append(p)
    if not marks:
        return 0
    buffer.add(np.concatenate(xs), np.concatenate(marks), np.concatenate(pdiffs))  # one device copy
    return sum(len(m) for m in marks)


def _publish(src: QNet, shared: QNet, version) -> None:
    """One device-to-host copy of the whole weight vector, then in-place copies into the
    shared-memory parameters. In place matters: rebinding them would cut actors off from updates."""
    with torch.no_grad():
        flat = torch.nn.utils.parameters_to_vector(src.parameters()).detach().cpu()
        offset = 0
        for p in shared.parameters():
            n = p.numel()
            p.copy_(flat[offset:offset + n].view_as(p))
            offset += n
    version.value += 1


def _cpu_copy(model: QNet) -> QNet:
    copy = QNet(model.hidden, model.layers)
    copy.load_state_dict({k: v.detach().cpu() for k, v in model.state_dict().items()})
    return copy.eval()


def _save(run_dir: Path, step: int, ema: QNet, model: QNet, optimizer, cfg: TrainConfig) -> None:
    for name in (f"ckpt-{step}.pt", "ckpt-latest.pt"):
        save_checkpoint(run_dir / name, ema, step, cfg.to_dict(), raw=model, optimizer=optimizer)


def train(cfg: TrainConfig, run_dir: Path, resume: Path | None = None) -> TrainSummary:
    run_dir = Path(run_dir)
    device = resolve_device(cfg)
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "config.yaml").write_text(yaml.safe_dump(cfg.to_dict(), sort_keys=False))
    torch.manual_seed(cfg.seed)
    previous_threads = torch.get_num_threads()
    torch.set_num_threads(cfg.learner_threads)  # the rest of the CPU belongs to the actors

    model = QNet(cfg.hidden, cfg.layers)
    step, optimizer_state, ema = 0, None, None
    if resume is not None:
        state = load_training_state(resume)
        model.load_state_dict(state.raw.state_dict())
        step, optimizer_state = state.step, state.optimizer
        ema = load_checkpoint(resume)[0].requires_grad_(False)
    model.to(device)
    ema = make_ema(model) if ema is None else ema.to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=cfg.lr)
    if optimizer_state is not None:
        optimizer.load_state_dict(optimizer_state)

    diag = build_decision_set(cfg.diag_decisions, cfg.seed) if cfg.eval_every_steps and cfg.diag_decisions else None
    previous_choices = None

    shared = _cpu_copy(ema)
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

    buffer = ReplayBuffer(cfg.buffer_size, INPUT_DIM, device)
    writer = SummaryWriter(str(run_dir / "tb"))
    if diag is not None:
        writer.add_scalar("eval/agree_chance", chance_agreement(diag), step)
    last_checkpoint = time.monotonic()
    window_start, window_samples, window_steps = time.monotonic(), 0, 0
    added_total, consumed, samples_while_training = 0, 0, 0
    train_start: float | None = None
    loss_value = float("nan")
    try:
        while step < cfg.total_steps:
            if cfg.max_seconds and train_start is not None and time.monotonic() - train_start >= cfg.max_seconds:
                break
            starved = replay_starved(cfg, consumed, added_total)
            added = _drain(queue, buffer, block=len(buffer) < cfg.min_buffer or starved)
            added_total += added
            window_samples += added
            if train_start is not None:
                samples_while_training += added
            check_actors(actors)
            if starved or len(buffer) < max(cfg.min_buffer, cfg.batch_size):
                continue
            if train_start is None:
                train_start = time.monotonic()

            x, marks, pdiff = buffer.sample(cfg.batch_size)
            q = model(x)
            loss = F.mse_loss(q, marks + shaping_alpha(cfg, step) * pdiff)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            update_ema(ema, model, cfg.ema_decay)
            step += 1
            window_steps += 1
            consumed += cfg.batch_size
            loss_value = loss.item()

            if step % cfg.weight_sync_every == 0:
                _publish(ema, shared, version)
            if step % cfg.log_every == 0:
                elapsed = max(time.monotonic() - window_start, 1e-9)
                writer.add_scalar("train/loss", loss_value, step)
                writer.add_scalar("train/mean_q", q.mean().item(), step)
                writer.add_scalar("train/alpha", shaping_alpha(cfg, step), step)
                writer.add_scalar("train/buffer", len(buffer), step)
                writer.add_scalar("train/samples_per_sec", window_samples / elapsed, step)
                writer.add_scalar("train/steps_per_sec", window_steps / elapsed, step)
                writer.add_scalar("train/replay_ratio", window_steps * cfg.batch_size / max(window_samples, 1), step)
                window_start, window_samples, window_steps = time.monotonic(), 0, 0
            if cfg.eval_every_steps and step % cfg.eval_every_steps == 0:
                result = evaluate_hands(ModelAgent(_cpu_copy(ema)), HeuristicBot(), cfg.eval_deals, seed=cfg.seed)
                writer.add_scalar("eval/marks_per_deal_vs_heuristic", mean_ci(result.deal_scores)[0], step)
                if diag is not None:
                    choices = model_choices(ema, diag)
                    writer.add_scalar("eval/agree_heuristic", agreement(choices, diag.heuristic), step)
                    if previous_choices is not None:
                        writer.add_scalar("eval/action_stability", agreement(choices, previous_choices), step)
                    previous_choices = choices
            if time.monotonic() - last_checkpoint >= cfg.checkpoint_minutes * 60:
                _save(run_dir, step, ema, model, optimizer, cfg)
                last_checkpoint = time.monotonic()
    finally:
        if step > 0:  # keep the work done so far on Ctrl+C or an actor failure
            try:
                _save(run_dir, step, ema, model, optimizer, cfg)
            except Exception as e:  # best effort; never mask the original error
                print(f"warning: could not save final checkpoint: {e}")
        stop.set()
        for p in actors:
            p.join(timeout=5)
            if p.is_alive():
                p.terminate()
        writer.close()
        torch.set_num_threads(previous_threads)

    latest = run_dir / "ckpt-latest.pt"
    if step == 0:  # nothing trained (total_steps already reached or 0): still leave a checkpoint
        save_checkpoint(latest, ema, step, cfg.to_dict(), raw=model, optimizer=optimizer)
    train_seconds = time.monotonic() - train_start if train_start is not None else 0.0
    return TrainSummary(step, loss_value, latest, train_seconds, samples_while_training)
