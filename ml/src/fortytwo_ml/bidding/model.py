"""BidNet: a hand -> the simulation bidder's P(make) table, in well under a millisecond.

Points bids: per named suit, a distribution over the team's final points at a 30 bid in buckets
(<30, 30, ..., 41, 42); P(make b) is the mass at or above b, so it can't rise with the bid.
Everything else is a yes/no probability: 42 in each named suit, follow-me, the three Low
variants, plunge."""
from collections.abc import Sequence
from pathlib import Path

import numpy as np
import torch
from torch import nn

from ..engine.dominoes import PIPS
from ..sim.probe import BidTable, can_plunge

INPUT_LAYOUT = 1
HAND_DIM = 28 + 7 + 1  # domino bits, dominoes per suit / 7, doubles / 7
POINT_BUCKETS = 14
BINARY = 12
_LO = np.array([lo for lo, _ in PIPS])
_HI = np.array([hi for _, hi in PIPS])


def encode_hands(hands: np.ndarray) -> np.ndarray:
    hands = np.asarray(hands, dtype=np.int64)
    x = np.zeros((len(hands), HAND_DIM), np.float32)
    x[np.arange(len(hands))[:, None], hands] = 1.0
    lo, hi = _LO[hands], _HI[hands]
    for suit in range(7):
        x[:, 28 + suit] = ((lo == suit) | (hi == suit)).sum(axis=1) / 7
    x[:, 35] = (lo == hi).sum(axis=1) / 7
    return x


class BidNet(nn.Module):
    def __init__(self, hidden: int = 256, layers: int = 3):
        super().__init__()
        self.hidden, self.layers = hidden, layers
        blocks: list[nn.Module] = []
        width = HAND_DIM
        for _ in range(layers):
            blocks += [nn.Linear(width, hidden), nn.ReLU()]
            width = hidden
        self.body = nn.Sequential(*blocks)
        self.points_head = nn.Linear(width, 7 * POINT_BUCKETS)
        self.binary_head = nn.Linear(width, BINARY)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        h = self.body(x)
        return self.points_head(h).view(-1, 7, POINT_BUCKETS), self.binary_head(h)

    def predict(self, hands: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        with torch.no_grad():
            points_logits, binary_logits = self(torch.from_numpy(encode_hands(hands)))
        probs = points_logits.softmax(-1).numpy().astype(np.float64)
        at_least = probs[:, :, ::-1].cumsum(axis=2)[:, :, ::-1]  # [..., k] = P(bucket >= k)
        return at_least[:, :, 1:13], torch.sigmoid(binary_logits).numpy().astype(np.float64)

    def table(self, hand: Sequence[int]) -> BidTable:
        points, binary = self.predict(np.array([list(hand)]))
        return BidTable(points[0], binary[0, :8], binary[0, 8:11], float(binary[0, 11]) if can_plunge(hand) else None)


def save_bidnet(path: str | Path, net: BidNet, meta: dict) -> None:
    torch.save({"weights": {k: v.detach().cpu() for k, v in net.state_dict().items()},
                "hidden": net.hidden, "layers": net.layers, "input_layout": INPUT_LAYOUT, "meta": meta}, path)


def load_bidnet(path: str | Path) -> tuple[BidNet, dict]:
    data = torch.load(path, map_location="cpu", weights_only=True)
    if data.get("input_layout") != INPUT_LAYOUT:
        raise ValueError(f"{path} uses input layout {data.get('input_layout')}, this code uses {INPUT_LAYOUT}")
    net = BidNet(data["hidden"], data["layers"])
    net.load_state_dict(data["weights"])
    return net.eval(), data["meta"]
