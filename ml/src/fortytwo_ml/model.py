"""Q(observation, candidate domino) -> expected final hand reward for the actor's team."""
import os
from dataclasses import dataclass
from pathlib import Path

import torch
from torch import nn

from .features import INPUT_DIM


class QNet(nn.Module):
    def __init__(self, hidden: int = 512, layers: int = 4):
        super().__init__()
        self.hidden = hidden
        self.layers = layers
        blocks: list[nn.Module] = []
        width = INPUT_DIM
        for _ in range(layers):
            blocks += [nn.Linear(width, hidden), nn.ReLU()]
            width = hidden
        blocks.append(nn.Linear(width, 1))
        self.net = nn.Sequential(*blocks)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x).squeeze(-1)


def _cpu_state(model: QNet) -> dict:
    return {k: v.detach().cpu() for k, v in model.state_dict().items()}


def save_checkpoint(
    path: str | Path,
    model: QNet,
    step: int,
    config: dict,
    raw: QNet | None = None,
    optimizer: torch.optim.Optimizer | None = None,
) -> None:
    """`model` is what plays (the EMA during training). `raw` and `optimizer`, when given, are what
    `--resume` needs to carry on training exactly where it stopped."""
    data = {
        "model": _cpu_state(model),
        "hidden": model.hidden,
        "layers": model.layers,
        "input_dim": INPUT_DIM,
        "step": step,
        "config": config,
    }
    if raw is not None:
        data["raw"] = _cpu_state(raw)
    if optimizer is not None:
        data["optimizer"] = optimizer.state_dict()
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    torch.save(data, tmp)
    os.replace(tmp, path)


def _load(path: str | Path, device: str) -> dict:
    data = torch.load(path, map_location=device, weights_only=True)
    found = data.get("input_dim", 353)  # checkpoints from before input_dim was recorded had 353 inputs
    if found != INPUT_DIM:
        raise ValueError(
            f"{path} was trained with {found} model inputs but this code uses {INPUT_DIM}; "
            "it predates a feature change and can't be loaded"
        )
    return data


def _build(data: dict, weights: dict) -> QNet:
    model = QNet(data["hidden"], data["layers"])
    model.load_state_dict(weights)
    return model.eval()


def load_checkpoint(path: str | Path, device: str = "cpu") -> tuple[QNet, dict]:
    data = _load(path, device)
    return _build(data, data["model"]), {"step": data["step"], "config": data["config"]}


@dataclass(frozen=True)
class TrainingState:
    raw: QNet
    optimizer: dict | None
    step: int


def load_training_state(path: str | Path) -> TrainingState:
    data = _load(path, "cpu")
    return TrainingState(_build(data, data.get("raw", data["model"])), data.get("optimizer"), data["step"])
