import torch

from fortytwo_ml.model import QNet
from fortytwo_ml.train.ema import make_ema, update_ema


def test_ema_is_an_independent_frozen_copy():
    net = QNet(hidden=8, layers=1)
    ema = make_ema(net)
    assert all(not p.requires_grad for p in ema.parameters()) and not ema.training
    with torch.no_grad():
        next(net.parameters()).add_(1.0)
    assert not torch.equal(next(net.parameters()), next(ema.parameters()))


def test_update_moves_ema_toward_the_model():
    net = QNet(hidden=8, layers=1)
    ema = make_ema(net)
    before = [p.clone() for p in ema.parameters()]
    with torch.no_grad():
        for p in net.parameters():
            p.add_(1.0)
    update_ema(ema, net, decay=0.9)
    for old, new, cur in zip(before, ema.parameters(), net.parameters()):
        assert torch.allclose(new, 0.9 * old + 0.1 * cur)
