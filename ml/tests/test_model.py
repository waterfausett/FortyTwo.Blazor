import random

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
