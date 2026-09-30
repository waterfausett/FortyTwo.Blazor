"""A self-play worker process: plays hands with its CPU copy of the network and sends every
sample to the learner. It reloads weights whenever the learner bumps `version`."""
import queue as queue_module
import random
import time

import numpy as np
import torch

from ..contracts import ContractSampler
from ..model import QNet
from .config import TrainConfig
from .selfplay import play_selfplay_hand


_SEND_SECONDS = 0.25  # send what's batched at least this often, even below actor_send_hands


def pack_hands(hands: list[tuple[np.ndarray, np.ndarray, np.ndarray]]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Many hands' samples as one queue item: fewer pipe writes and unpickles for the learner."""
    x = np.concatenate([h[0] for h in hands]).astype(np.float16)
    marks = np.concatenate([h[1] for h in hands]).astype(np.float32)
    pdiff = np.concatenate([h[2] for h in hands]).astype(np.float32)
    return x, marks, pdiff


def actor_main(actor_id: int, cfg: TrainConfig, shared: QNet, version, queue, stop) -> None:
    try:
        _actor_loop(actor_id, cfg, shared, version, queue, stop)
    except KeyboardInterrupt:
        pass  # Ctrl+C reaches every actor on Windows; the learner handles shutdown


def _actor_loop(actor_id: int, cfg: TrainConfig, shared: QNet, version, queue, stop) -> None:
    torch.set_num_threads(1)
    # Don't block process exit on samples the learner will never read.
    queue.cancel_join_thread()
    rng = random.Random(cfg.seed * 10_007 + actor_id)
    local = QNet(cfg.hidden, cfg.layers)
    local.load_state_dict(shared.state_dict())
    local.eval()
    seen = version.value
    sampler = ContractSampler(cfg.contract_mix, rng)
    pending: list[tuple[np.ndarray, np.ndarray, np.ndarray]] = []
    last_send = time.monotonic()
    while not stop.is_set():
        if version.value != seen:
            # The learner may be mid-copy; a slightly torn read only perturbs one hand's policy.
            seen = version.value
            local.load_state_dict(shared.state_dict())
        hand = play_selfplay_hand(local, sampler, rng, cfg.epsilon)
        if len(hand[1]):
            pending.append(hand)
        if pending and (len(pending) >= cfg.actor_send_hands or time.monotonic() - last_send >= _SEND_SECONDS):
            batch, pending, last_send = pack_hands(pending), [], time.monotonic()
            try:
                queue.put(batch, timeout=1.0)
            except queue_module.Full:
                continue
