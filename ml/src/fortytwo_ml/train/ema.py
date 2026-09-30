"""An exponential moving average of the learner's weights. Actors, the in-training eval and saved
checkpoints all use it: it moves slowly, so its action ranking isn't washed out by single noisy
updates the way the raw weights are."""
import copy

import torch

from ..model import QNet


def make_ema(model: QNet) -> QNet:
    ema = copy.deepcopy(model)
    ema.requires_grad_(False)
    return ema.eval()


@torch.no_grad()
def update_ema(ema: QNet, model: QNet, decay: float) -> None:
    for e, m in zip(ema.parameters(), model.parameters()):
        e.lerp_(m.detach(), 1.0 - decay)
