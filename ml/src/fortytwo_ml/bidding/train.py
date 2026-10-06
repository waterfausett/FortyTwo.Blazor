"""Train BidNet on gen-bids data: cross-entropy against each hand's simulated points histogram,
binomial likelihood for the yes/no options. Each hand's loss is divided by its deal count, so every
hand weighs the same whatever `sim_deals` its counts came from."""
import copy
import zlib
from dataclasses import dataclass

import numpy as np
import torch
import torch.nn.functional as F

from .data import BidData
from .model import BidNet, encode_hands

_REPORT_BIDS = (30, 34, 38)


@dataclass(frozen=True)
class BidTrainConfig:
    hidden: int = 256
    layers: int = 3
    epochs: int = 100
    patience: int = 5
    batch_size: int = 512
    lr: float = 1e-3
    seed: int = 0


@dataclass
class TrainResult:
    net: BidNet
    val_loss: float
    epochs: int


def bucket_counts(points_hist: np.ndarray) -> np.ndarray:
    return np.concatenate([points_hist[..., :30].sum(axis=-1, keepdims=True), points_hist[..., 30:43]], axis=-1)


def is_validation(hands: np.ndarray) -> np.ndarray:
    return np.array([zlib.crc32(bytes(sorted(int(d) for d in h))) % 20 == 0 for h in hands])


def _targets(data: BidData) -> tuple[torch.Tensor, ...]:
    x = torch.from_numpy(encode_hands(data.hands))
    buckets = torch.from_numpy(bucket_counts(data.points_hist).astype(np.float32))
    plunge = np.maximum(data.plunge_made, 0)[:, None]
    made = torch.from_numpy(np.concatenate([data.high_made, data.low_clean, plunge], axis=1).astype(np.float32))
    mask = torch.ones_like(made)
    mask[:, 11] = torch.from_numpy((data.plunge_made >= 0).astype(np.float32))
    n = torch.from_numpy(data.n_deals.astype(np.float32))
    return x, buckets, made, mask, n


def bid_loss(points_logits, binary_logits, buckets, made, mask, n) -> torch.Tensor:
    points = -(buckets * points_logits.log_softmax(-1)).sum(-1) / n[:, None]
    binary = F.binary_cross_entropy_with_logits(binary_logits, made / n[:, None], reduction="none")
    return points.mean() + (binary * mask).sum() / mask.sum()


def _loss_on(net: BidNet, tensors) -> float:
    x, *rest = tensors
    with torch.no_grad():
        return float(bid_loss(*net(x), *rest))


def train_bidnet(data: BidData, cfg: BidTrainConfig, log=print) -> TrainResult:
    torch.manual_seed(cfg.seed)
    val = is_validation(data.hands)
    train_t = _targets(data.subset(~val))
    # Tiny datasets can hold no validation hand; early stopping then watches the training loss.
    val_t = _targets(data.subset(val)) if val.any() else train_t
    net = BidNet(cfg.hidden, cfg.layers)
    opt = torch.optim.Adam(net.parameters(), lr=cfg.lr)
    gen = torch.Generator().manual_seed(cfg.seed)
    best, best_state, since, epoch = float("inf"), None, 0, 0
    for epoch in range(1, cfg.epochs + 1):
        net.train()
        order = torch.randperm(len(train_t[0]), generator=gen)
        total = 0.0
        for start in range(0, len(order), cfg.batch_size):
            idx = order[start:start + cfg.batch_size]
            x, *rest = (t[idx] for t in train_t)
            loss = bid_loss(*net(x), *rest)
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += float(loss.detach()) * len(idx)
        net.eval()
        held_out = _loss_on(net, val_t)
        log(f"epoch {epoch}: train {total / len(order):.4f}  held-out {held_out:.4f}")
        if held_out < best:
            best, best_state, since = held_out, copy.deepcopy(net.state_dict()), 0
        else:
            since += 1
            if since >= cfg.patience:
                break
    net.load_state_dict(best_state)
    return TrainResult(net.eval(), best, epoch)


def simulated_tables(data: BidData) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    n = data.n_deals[:, None].astype(np.float64)
    at_least = data.points_hist[:, :, ::-1].cumsum(axis=2)[:, :, ::-1]
    points = at_least[:, :, 30:42] / n[:, :, None]
    plunge = np.maximum(data.plunge_made, 0)[:, None]
    binary = np.concatenate([data.high_made, data.low_clean, plunge], axis=1) / n
    mask = np.ones_like(binary)
    mask[:, 11] = data.plunge_made >= 0
    return points, binary, mask


def gold_report(net: BidNet, gold: BidData) -> tuple[list[str], dict[str, float]]:
    """How far BidNet's P(make) is from a low-noise simulated table, at the bids that matter."""
    pred_points, pred_binary = net.predict(gold.hands)
    sim_points, sim_binary, mask = simulated_tables(gold)
    rows = np.arange(len(gold.hands))
    best30 = sim_points[:, :, 0].argmax(axis=1)
    best42 = sim_binary[:, :7].argmax(axis=1)
    best_low = 8 + sim_binary[:, 8:11].argmax(axis=1)
    metrics = {f"mae_{b}": float(np.abs(pred_points[rows, best30, b - 30] - sim_points[rows, best30, b - 30]).mean())
               for b in _REPORT_BIDS}
    metrics["mae_42"] = float(np.abs(pred_binary[rows, best42] - sim_binary[rows, best42]).mean())
    metrics["mae_follow_me"] = float(np.abs(pred_binary[:, 7] - sim_binary[:, 7]).mean())
    metrics["mae_low"] = float(np.abs(pred_binary[rows, best_low] - sim_binary[rows, best_low]).mean())
    lines = [f"Gold set: {len(gold.hands)} hands",
             "Mean absolute error of P(make), best suit unless noted:"]
    lines += [f"  {name[4:]:<10} {value:.3f}" for name, value in metrics.items()]
    lines.append("Calibration: predicted P(make) -> simulated P(make), all table entries")
    flat_pred = np.concatenate([pred_points.ravel(), pred_binary[mask > 0]])
    flat_sim = np.concatenate([sim_points.ravel(), sim_binary[mask > 0]])
    for k in range(10):
        low, high = k / 10, (k + 1) / 10
        hit = (flat_pred >= low) & ((flat_pred < high) if k < 9 else (flat_pred <= 1.0))
        if hit.any():
            lines.append(f"  {low:.1f}-{high:.1f}: predicted {flat_pred[hit].mean():.2f}  "
                         f"simulated {flat_sim[hit].mean():.2f}  (n={int(hit.sum())})")
    return lines, metrics
