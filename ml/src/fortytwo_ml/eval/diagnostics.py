"""Is the model learning which domino to play? Scored on a fixed set of real decisions (heuristic
play, sampled contracts, only positions with more than one legal domino) so numbers are comparable
across a run:

- action stability: how often two versions of the model pick the same domino
- agreement with the heuristic: how often the model picks what HeuristicBot picks
- chance: how often a uniformly random pick would agree (the floor for both)
"""
import random
from collections.abc import Mapping
from dataclasses import dataclass

import numpy as np
import torch

from ..agents.heuristic_bot import HeuristicBot
from ..contracts import DEFAULT_MIX, ContractSampler
from ..engine.hand_state import HandState, Phase
from ..features import encode_actions
from ..model import QNet


@dataclass(frozen=True)
class DecisionSet:
    x: np.ndarray          # every decision's candidate rows, back to back
    starts: np.ndarray     # decision i's rows are x[starts[i]:starts[i + 1]]
    heuristic: np.ndarray  # index of HeuristicBot's choice within decision i

    def __len__(self) -> int:
        return len(self.heuristic)


def build_decision_set(n: int, seed: int = 0, mix: Mapping[str, float] | None = None) -> DecisionSet:
    rng = random.Random(f"diagnostics:{seed}")
    sampler = ContractSampler(DEFAULT_MIX if mix is None else mix, rng)
    bot = HeuristicBot()
    rows: list[np.ndarray] = []
    starts = [0]
    picks: list[int] = []
    while len(picks) < n:
        order, _, contract = sampler.sample_hand()
        state = HandState.from_contract(order, contract.bidder, contract.bid, contract.trump)
        while state.phase is not Phase.DONE and len(picks) < n:
            seat, legal = state.to_act, state.legal_actions()
            choice = bot.play(state, seat)
            if len(legal) > 1:
                rows.append(encode_actions(state, seat, legal))
                starts.append(starts[-1] + len(legal))
                picks.append(legal.index(choice))
            state.apply(choice)
    return DecisionSet(np.concatenate(rows), np.array(starts, np.int64), np.array(picks, np.int64))


def model_choices(model: QNet, ds: DecisionSet) -> np.ndarray:
    device = next(model.parameters()).device
    with torch.no_grad():
        q = model(torch.from_numpy(ds.x).to(device)).float().cpu().numpy()
    return np.array([int(np.argmax(q[a:b])) for a, b in zip(ds.starts[:-1], ds.starts[1:])], np.int64)


def agreement(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean(a == b))


def chance_agreement(ds: DecisionSet) -> float:
    return float(np.mean(1.0 / np.diff(ds.starts)))
