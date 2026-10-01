import random

import numpy as np
import torch

from fortytwo_ml.agents.base import run_hand
from fortytwo_ml.agents.model_agent import ModelAgent
from fortytwo_ml.contracts import DEFAULT_MIX, ContractSampler
from fortytwo_ml.engine.hand_state import HandState, team_of
from fortytwo_ml.model import QNet
from fortytwo_ml.sim.rollout import rollout


def _jobs(n, seed=0):
    sampler = ContractSampler(DEFAULT_MIX, random.Random(seed))
    return [(order, contract) for order, _, contract in (sampler.sample_hand() for _ in range(n))]


def test_batched_rollout_matches_one_at_a_time_play():
    torch.manual_seed(0)
    model = QNet(hidden=16, layers=1).eval()
    jobs = _jobs(40)
    result = rollout(model, jobs)
    agent = ModelAgent(model)
    for i, (order, c) in enumerate(jobs):
        state = HandState.from_contract(order, c.bidder, c.bid, c.trump, play_to_end=True)
        run_hand(state, [agent] * 4)
        bidders = team_of(c.bidder)
        assert result.bidder_points[i] == state.points[bidders]
        assert result.bidders_won[i] == (state.result.winning_team == bidders)
        assert result.bidder_took_trick[i] == any(team_of(t.winner) == bidders for t in state.tricks)


def test_rollout_shapes_and_empty_jobs():
    model = QNet(hidden=16, layers=1).eval()
    result = rollout(model, _jobs(5))
    assert result.bidder_points.shape == (5,) and result.bidders_won.dtype == bool
    empty = rollout(model, [])
    assert empty.bidder_points.shape == (0,)
