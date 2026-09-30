"""Q(observation, candidate domino) -> expected final hand reward for the actor's team."""
import os
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


def save_checkpoint(path: str | Path, model: QNet, step: int, config: dict) -> None:
    state = {k: v.detach().cpu() for k, v in model.state_dict().items()}
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    torch.save(
        {"model": state, "hidden": model.hidden, "layers": model.layers, "step": step, "config": config},
        tmp,
    )
    os.replace(tmp, path)


def load_checkpoint(path: str | Path, device: str = "cpu") -> tuple[QNet, dict]:
    data = torch.load(path, map_location=device, weights_only=True)
    model = QNet(data["hidden"], data["layers"])
    model.load_state_dict(data["model"])
    model.eval()
    return model, {"step": data["step"], "config": data["config"]}
