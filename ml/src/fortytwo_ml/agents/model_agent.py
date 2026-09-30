"""Plays with a trained QNet. Stage 1 doesn't learn bidding, so bids and trump come from the
heuristic bot."""
from pathlib import Path

import torch

from ..engine.hand_state import HandState
from ..features import encode_actions
from ..model import QNet, load_checkpoint
from .heuristic_bot import HeuristicBot


class ModelAgent:
    def __init__(self, model: QNet, name: str = "model"):
        self.model = model.eval()
        self.name = name
        self._fallback = HeuristicBot()

    @classmethod
    def from_checkpoint(cls, path: str | Path) -> "ModelAgent":
        model, _ = load_checkpoint(path)
        return cls(model, name=Path(path).name)

    def bid(self, state: HandState, seat: int) -> int:
        return self._fallback.bid(state, seat)

    def trump(self, state: HandState, seat: int) -> int:
        return self._fallback.trump(state, seat)

    def q_values(self, state: HandState, seat: int) -> list[tuple[int, float]]:
        legal = state.legal_actions()
        with torch.no_grad():
            q = self.model(torch.from_numpy(encode_actions(state, seat, legal))).tolist()
        return list(zip(legal, q))

    def play(self, state: HandState, seat: int) -> int:
        legal = state.legal_actions()
        if len(legal) == 1:
            return legal[0]
        return max(self.q_values(state, seat), key=lambda pair: pair[1])[0]
