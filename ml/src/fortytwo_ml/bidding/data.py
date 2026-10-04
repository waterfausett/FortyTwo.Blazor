"""Training data for the bidding model: random hands, each with the raw simulation counts for
every bid option (see sim/probe.py), stored in batch files of `batch_hands` hands. Rerunning a
command resumes it; a new seed adds new hands."""
import os
import random
import time
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np

from ..model import load_checkpoint
from ..sim.parallel import DEFAULT_WORKERS, parallel_map
from ..sim.probe import simulate_hand

ARRAYS = ("hands", "points_hist", "high_made", "low_clean", "plunge_made")


@dataclass(frozen=True)
class GenConfig:
    model: str
    out: str
    hands: int
    sim_deals: int = 50
    seed: int = 0
    workers: int = DEFAULT_WORKERS
    batch_hands: int = 1000


@dataclass(frozen=True)
class BidData:
    hands: np.ndarray        # (n, 7) domino ids, sorted
    points_hist: np.ndarray  # (n, 7, 43)
    high_made: np.ndarray    # (n, 8)
    low_clean: np.ndarray    # (n, 3)
    plunge_made: np.ndarray  # (n,), -1 when the hand can't plunge
    n_deals: np.ndarray      # (n,) simulated deals behind each hand's counts
    play_checkpoint: str     # run folder / file name of the play model, e.g. "stage1-c/ckpt-latest.pt"
    play_path: str           # the path it was loaded from
    play_step: int

    def subset(self, index) -> "BidData":
        return replace(self, **{k: getattr(self, k)[index] for k in (*ARRAYS, "n_deals")})


def deal_hand(seed: int, i: int) -> tuple[list[int], random.Random]:
    rng = random.Random(f"gen-bids:{seed}:{i}")
    return sorted(rng.sample(range(28), 7)), rng


def checkpoint_label(path: str | Path) -> str:
    p = Path(path)
    return f"{p.parent.name}/{p.name}"


def batch_path(out: str | Path, seed: int, start: int) -> Path:
    return Path(out) / f"gen-s{seed}-{start:07d}.npz"


def save_batch(path: Path, arrays: dict, *, sim_deals: int, play_checkpoint: str, play_path: str, play_step: int, seed: int) -> None:
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as f:
        np.savez(f, **arrays, sim_deals=np.int32(sim_deals), play_checkpoint=np.str_(play_checkpoint),
                 play_path=np.str_(play_path), play_step=np.int64(play_step), seed=np.int64(seed))
    os.replace(tmp, path)


def _batch_size(path: Path) -> int | None:
    if not path.exists():
        return None
    with np.load(path) as z:
        return len(z["hands"])


_worker: dict = {}  # this process's play model and its provenance, loaded once


def _init(model_path: str) -> None:
    model, info = load_checkpoint(model_path)
    _worker.update(model=model, label=checkpoint_label(model_path), path=model_path, step=info["step"])


def _simulate_batch(task: tuple[str, int, int, int, int]) -> int:
    out, seed, start, count, sim_deals = task
    arrays = dict(
        hands=np.zeros((count, 7), np.int8), points_hist=np.zeros((count, 7, 43), np.uint16),
        high_made=np.zeros((count, 8), np.uint16), low_clean=np.zeros((count, 3), np.uint16),
        plunge_made=np.full(count, -1, np.int16),
    )
    for j in range(count):
        hand, rng = deal_hand(seed, start + j)
        sims = simulate_hand(_worker["model"], 0, hand, sim_deals, rng)
        arrays["hands"][j] = hand
        arrays["points_hist"][j] = sims.points_hist
        arrays["high_made"][j] = sims.high_made
        arrays["low_clean"][j] = sims.low_clean
        if sims.plunge_made is not None:
            arrays["plunge_made"][j] = sims.plunge_made
    save_batch(batch_path(out, seed, start), arrays, sim_deals=sim_deals, play_checkpoint=_worker["label"],
               play_path=_worker["path"], play_step=_worker["step"], seed=seed)
    return count


def generate(cfg: GenConfig, log=print) -> int:
    out = Path(cfg.out)
    out.mkdir(parents=True, exist_ok=True)
    tasks = []
    for start in range(0, cfg.hands, cfg.batch_hands):
        count = min(cfg.batch_hands, cfg.hands - start)
        if _batch_size(batch_path(out, cfg.seed, start)) != count:  # missing, or short from a smaller --hands
            tasks.append((str(out), cfg.seed, start, count, cfg.sim_deals))
    total = sum(t[3] for t in tasks)
    log(f"{len(tasks)} batches to simulate ({total} hands); "
        f"{-(-cfg.hands // cfg.batch_hands) - len(tasks)} already done")
    began, written = time.monotonic(), 0

    def progress(done: int, count: int) -> None:
        nonlocal written
        written += count
        rate = written / max(time.monotonic() - began, 1e-9)
        eta = (total - written) / rate if rate else 0
        log(f"batch {done}/{len(tasks)}: {written}/{total} hands, {rate:.2f} hands/s, ETA {eta / 3600:.1f} h")

    parallel_map(_simulate_batch, tasks, cfg.workers, _init, (cfg.model,), on_result=progress)
    return written


def load_bids(folder: str | Path) -> BidData:
    files = sorted(Path(folder).glob("gen-s*.npz"))
    if not files:
        raise FileNotFoundError(f"no gen-s*.npz batches in {folder}")
    parts, sources = [], set()
    for f in files:
        with np.load(f) as z:
            sources.add((z["play_checkpoint"].item(), int(z["play_step"])))
            part = {k: z[k] for k in ARRAYS}
            part["n_deals"] = np.full(len(part["hands"]), int(z["sim_deals"]))
            play_path = z["play_path"].item()
        parts.append(part)
    if len(sources) > 1:
        raise ValueError(f"batches in {folder} come from different play checkpoints {sorted(sources)}; "
                         "keep one play model's data per folder")
    (label, step), = sources
    joined = {k: np.concatenate([p[k] for p in parts]).astype(np.int64) for k in (*ARRAYS, "n_deals")}
    return BidData(**joined, play_checkpoint=label, play_path=play_path, play_step=step)
