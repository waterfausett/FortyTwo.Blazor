import numpy as np
import torch

from fortytwo_ml.eval.diagnostics import agreement, build_decision_set, chance_agreement, model_choices
from fortytwo_ml.features import INPUT_DIM
from fortytwo_ml.model import QNet


def test_decision_set_shape_and_determinism():
    ds = build_decision_set(50, seed=3)
    assert len(ds) == 50 and ds.x.shape[1] == INPUT_DIM and ds.x.dtype == np.float32
    sizes = np.diff(ds.starts)
    assert ds.starts[0] == 0 and ds.starts[-1] == len(ds.x) and np.all(sizes >= 2)
    assert np.all(ds.heuristic < sizes)
    again = build_decision_set(50, seed=3)
    assert np.array_equal(ds.x, again.x) and np.array_equal(ds.heuristic, again.heuristic)


def test_chance_is_the_mean_of_one_over_choices():
    ds = build_decision_set(40, seed=1)
    assert np.isclose(chance_agreement(ds), np.mean(1 / np.diff(ds.starts)))
    assert 0 < chance_agreement(ds) <= 0.5


def test_model_choices_and_agreement():
    ds = build_decision_set(40, seed=2)
    net = QNet(hidden=8, layers=1)
    with torch.no_grad():
        for p in net.parameters():
            p.zero_()
    choices = model_choices(net, ds)  # all Q equal -> argmax picks the first candidate
    assert choices.shape == (40,) and np.all(choices == 0)
    assert agreement(choices, choices) == 1.0
    assert agreement(choices, ds.heuristic) == np.mean(ds.heuristic == 0)


def test_build_decision_set_honours_the_contract_mix():
    from fortytwo_ml.contracts import DEFAULT_MIX
    mix = {k: 0.0 for k in DEFAULT_MIX}
    mix[next(iter(mix))] = 1.0
    a = build_decision_set(30, 0, mix=mix)
    b = build_decision_set(30, 0)
    assert not (a.x.shape == b.x.shape and (a.x == b.x).all())
