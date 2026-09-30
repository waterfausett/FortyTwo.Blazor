"""A self-play worker process: plays hands with its CPU copy of the network and sends every
sample to the learner. It reloads weights whenever the learner bumps `version`."""
import queue as queue_module
import random

import torch

from ..contracts import ContractSampler
from ..model import QNet
from .config import TrainConfig
from .selfplay import play_selfplay_hand


def actor_main(actor_id: int, cfg: TrainConfig, shared: QNet, version, queue, stop) -> None:
    torch.set_num_threads(1)
    # Don't block process exit on samples the learner will never read.
    queue.cancel_join_thread()
    rng = random.Random(cfg.seed * 10_007 + actor_id)
    local = QNet(cfg.hidden, cfg.layers)
    local.load_state_dict(shared.state_dict())
    local.eval()
    seen = version.value
    sampler = ContractSampler(cfg.contract_mix, rng)
    while not stop.is_set():
        if version.value != seen:
            # The learner may be mid-copy; a slightly torn read only perturbs one hand's policy.
            seen = version.value
            local.load_state_dict(shared.state_dict())
        x, marks, pdiff = play_selfplay_hand(local, sampler, rng, cfg.epsilon)
        if len(marks):
            try:
                queue.put((x, marks, pdiff), timeout=1.0)
            except queue_module.Full:
                continue
