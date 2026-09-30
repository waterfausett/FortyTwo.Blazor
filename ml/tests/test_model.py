import random

import pytest
import torch

from fortytwo_ml.agents.base import run_hand
from fortytwo_ml.agents.model_agent import ModelAgent
from fortytwo_ml.contracts import DEFAULT_MIX, ContractSampler
from fortytwo_ml.engine.hand_state import HandState, Phase
from fortytwo_ml.features import INPUT_DIM
from fortytwo_ml.model import QNet, load_checkpoint, save_checkpoint


def test_qnet_maps_rows_to_scalars():
    net = QNet(hidden=32, layers=2)
    assert net(torch.zeros(5, INPUT_DIM)).shape == (5,)


def test_checkpoint_round_trip_keeps_dims_and_weights(tmp_path):
    torch.manual_seed(0)
    net = QNet(hidden=32, layers=3)
    path = tmp_path / "c.pt"
    save_checkpoint(path, net, step=12, config={"hidden": 32})
    loaded, meta = load_checkpoint(path)
    assert (loaded.hidden, loaded.layers) == (32, 3) and meta["step"] == 12
    x = torch.randn(4, INPUT_DIM)
    assert torch.allclose(net(x), loaded(x))


def test_model_agent_plays_legal_hands_even_untrained():
    agent = ModelAgent(QNet(hidden=32, layers=2))
    rng = random.Random(0)
    sampler = ContractSampler(DEFAULT_MIX, rng)
    for _ in range(50):
        order = list(range(28))
        rng.shuffle(order)
        c = sampler.sample(order, rng.randrange(4))
        state = HandState.from_contract(order, c.bidder, c.bid, c.trump)
        assert len(agent.q_values(state, state.to_act)) == len(state.legal_actions())
        run_hand(state, [agent] * 4)
        assert state.phase is Phase.DONE


def test_old_checkpoint_is_refused_with_both_sizes(tmp_path):
    path = tmp_path / "old.pt"
    net = QNet(hidden=16, layers=1)
    torch.save({"model": net.state_dict(), "hidden": 16, "layers": 1, "step": 5, "config": {}}, path)
    with pytest.raises(ValueError, match="353.*363"):
        load_checkpoint(path)


def test_checkpoint_can_carry_raw_weights_and_optimizer_state(tmp_path):
    from fortytwo_ml.model import load_training_state

    torch.manual_seed(1)
    ema, raw = QNet(hidden=16, layers=1), QNet(hidden=16, layers=1)
    opt = torch.optim.Adam(raw.parameters(), lr=1e-3)
    raw(torch.randn(3, INPUT_DIM)).sum().backward()
    opt.step()
    path = tmp_path / "c.pt"
    save_checkpoint(path, ema, step=7, config={}, raw=raw, optimizer=opt)

    played, _ = load_checkpoint(path)
    x = torch.randn(2, INPUT_DIM)
    assert torch.allclose(played(x), ema(x))
    state = load_training_state(path)
    assert state.step == 7 and torch.allclose(state.raw(x), raw(x))
    assert state.optimizer is not None and state.optimizer["state"]


def test_training_state_falls_back_to_the_played_weights(tmp_path):
    from fortytwo_ml.model import load_training_state

    net = QNet(hidden=16, layers=1)
    path = tmp_path / "c.pt"
    save_checkpoint(path, net, step=3, config={})
    state = load_training_state(path)
    x = torch.randn(2, INPUT_DIM)
    assert state.optimizer is None and torch.allclose(state.raw(x), net(x))
