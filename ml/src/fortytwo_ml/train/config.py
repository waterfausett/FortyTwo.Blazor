import os
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

import torch
import yaml

from ..contracts import DEFAULT_MIX


@dataclass(frozen=True)
class TrainConfig:
    device: str = "cuda"
    allow_cpu_fallback: bool = False
    seed: int = 0
    actors: int = 0  # 0 = physical cores - 1, estimated as logical CPUs // 2 - 1
    epsilon: float = 0.05
    hidden: int = 512
    layers: int = 4
    lr: float = 1e-4
    batch_size: int = 4096
    buffer_size: int = 200_000
    min_buffer: int = 20_000
    weight_sync_every: int = 50
    total_steps: int = 200_000
    alpha0: float = 0.25
    alpha_decay_steps: int = 20_000
    ema_decay: float = 0.999          # actors, eval and checkpoints use these averaged weights
    max_replay_ratio: float = 4.0     # learner waits for data past this many uses per sample; 0 = off
    actor_send_hands: int = 16        # hands an actor batches into one queue item
    learner_threads: int = 2          # CPU threads for the learner process (leave the rest to actors)
    max_seconds: float = 0.0          # stop training after this long (bench-train); 0 = no limit
    log_every: int = 100
    checkpoint_minutes: float = 15.0
    eval_every_steps: int = 2_000
    eval_deals: int = 500
    diag_decisions: int = 2000        # decisions scored for eval/action_stability and agree_heuristic
    contract_mix: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_MIX))

    @classmethod
    def from_yaml(cls, path: str | Path) -> "TrainConfig":
        data = yaml.safe_load(Path(path).read_text()) or {}
        unknown = set(data) - {f.name for f in fields(cls)}
        if unknown:
            raise ValueError(f"unknown config keys in {path}: {sorted(unknown)}")
        return cls(**data)

    def to_dict(self) -> dict:
        return asdict(self)

    @property
    def num_actors(self) -> int:
        return self.actors or max(1, (os.cpu_count() or 2) // 2 - 1)


def shaping_alpha(cfg: TrainConfig, step: int) -> float:
    if cfg.alpha_decay_steps <= 0:
        return 0.0
    return cfg.alpha0 * max(0.0, 1.0 - step / cfg.alpha_decay_steps)


def replay_starved(cfg: TrainConfig, consumed: int, added: int) -> bool:
    """True once the learner has used each sample more than max_replay_ratio times on average since
    the run started; it then waits for actors instead of training on stale data."""
    return cfg.max_replay_ratio > 0 and consumed > cfg.max_replay_ratio * added


def resolve_device(cfg: TrainConfig) -> torch.device:
    if cfg.device.startswith("cuda") and not torch.cuda.is_available():
        if not cfg.allow_cpu_fallback:
            raise RuntimeError(
                "config asks for CUDA but torch can't see a GPU; set allow_cpu_fallback: true to train on CPU"
            )
        return torch.device("cpu")
    return torch.device(cfg.device)
