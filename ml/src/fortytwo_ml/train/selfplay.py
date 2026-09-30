"""One self-play hand for Deep Monte-Carlo training: all four seats use the same network with
epsilon-greedy exploration, and every real decision (more than one legal domino) becomes a sample
labeled with the hand's final outcome for the deciding seat's team."""
import random

import numpy as np
import torch

from ..contracts import ContractSampler
from ..engine.enums import is_low
from ..engine.hand_state import HandState, Phase, team_of
from ..features import INPUT_DIM, encode_actions
from ..model import QNet


def play_selfplay_hand(
    model: QNet, sampler: ContractSampler, rng: random.Random, epsilon: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    order = list(range(28))
    rng.shuffle(order)
    contract = sampler.sample(order, rng.randrange(4))
    state = HandState.from_contract(order, contract.bidder, contract.bid, contract.trump)

    rows: list[np.ndarray] = []
    teams: list[int] = []
    while state.phase is not Phase.DONE:
        seat = state.to_act
        legal = state.legal_actions()
        if len(legal) == 1:
            state.apply(legal[0])
            continue
        xs = encode_actions(state, seat, legal)
        if rng.random() < epsilon:
            i = rng.randrange(len(legal))
        else:
            with torch.no_grad():
                i = int(model(torch.from_numpy(xs)).argmax())
        rows.append(xs[i])
        teams.append(team_of(seat))
        state.apply(legal[i])

    result = state.result
    marks = np.array([result.marks if t == result.winning_team else -result.marks for t in teams], np.float32)
    if is_low(state.trump):
        pdiff = np.zeros(len(teams), np.float32)  # low bidders aim for ~0 points, so the shaping would mislead
    else:
        pdiff = np.array([(result.points[t] - result.points[1 - t]) / 42 for t in teams], np.float32)
    x = np.stack(rows) if rows else np.zeros((0, INPUT_DIM), np.float32)
    return x, marks, pdiff
