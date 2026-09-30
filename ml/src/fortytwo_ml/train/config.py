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
    actors: int = 0  # 0 = CPU cores - 2
    epsilon: float = 0.05
    hidden: int = 512
    layers: int = 4
    lr: float = 3e-4
    batch_size: int = 1024
    buffer_size: int = 200_000
    min_buffer: int = 20_000
    weight_sync_every: int = 50
    total_steps: int = 2_000_000
    alpha0: float = 0.25
    alpha_decay_steps: int = 200_000
    log_every: int = 100
    checkpoint_minutes: float = 15.0
    eval_every_steps: int = 20_000
    eval_deals: int = 500
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
        return self.actors or max(1, (os.cpu_count() or 2) - 2)


def shaping_alpha(cfg: TrainConfig, step: int) -> float:
    if cfg.alpha_decay_steps <= 0:
        return 0.0
    return cfg.alpha0 * max(0.0, 1.0 - step / cfg.alpha_decay_steps)


def resolve_device(cfg: TrainConfig) -> torch.device:
    if cfg.device.startswith("cuda") and not torch.cuda.is_available():
        if not cfg.allow_cpu_fallback:
            raise RuntimeError(
                "config asks for CUDA but torch can't see a GPU; set allow_cpu_fallback: true to train on CPU"
            )
        return torch.device("cpu")
    return torch.device(cfg.device)
