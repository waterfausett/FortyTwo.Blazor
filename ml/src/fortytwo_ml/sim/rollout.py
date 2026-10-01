"""Play many deals out at once with the play model: every step, one batched forward pass scores
the candidate dominoes of every unfinished hand, and each hand plays its best one (greedy, all
four seats, no exploration). Hands play to the end so one rollout answers every bid level."""
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import torch

from ..engine.hand_state import Contract, HandState, Phase, team_of
from ..features import encode_actions
from ..model import QNet


@dataclass(frozen=True)
class RolloutResult:
    bidder_points: np.ndarray      # bidding team's points after all 7 tricks
    bidder_took_trick: np.ndarray  # whether the bidding team won any trick (Low fails if so)
    bidders_won: np.ndarray        # the official result at the contract's bid


def rollout(
    model: QNet, jobs: Sequence[tuple[Sequence[int], Contract]], device: torch.device | str | None = None
) -> RolloutResult:
    device = torch.device(device) if device is not None else next(model.parameters()).device
    states = [HandState.from_contract(order, c.bidder, c.bid, c.trump, play_to_end=True) for order, c in jobs]
    active = list(range(len(states)))
    with torch.no_grad():
        while active:
            rows, legals = [], []
            for i in active:
                state = states[i]
                legal = state.legal_actions()
                legals.append(legal)
                rows.append(encode_actions(state, state.to_act, legal))
            q = model(torch.from_numpy(np.concatenate(rows)).to(device)).float().cpu().numpy()
            start = 0
            for i, legal in zip(active, legals):
                end = start + len(legal)
                states[i].apply(legal[int(np.argmax(q[start:end]))])
                start = end
            active = [i for i in active if states[i].phase is not Phase.DONE]

    bidders = [team_of(c.bidder) for _, c in jobs]
    return RolloutResult(
        np.array([s.points[t] for s, t in zip(states, bidders)], dtype=np.int64),
        np.array([any(team_of(tr.winner) == t for tr in s.tricks) for s, t in zip(states, bidders)], dtype=bool),
        np.array([s.result.winning_team == t for s, t in zip(states, bidders)], dtype=bool),
    )
