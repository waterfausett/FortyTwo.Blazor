import math

import pytest

from fortytwo_ml.eval.auction_runner import BidderSpec, evaluate_auctions_parallel
from fortytwo_ml.model import QNet, save_checkpoint
from fortytwo_ml.sim.parallel import parallel_map


def test_parallel_map_keeps_item_order():
    seen = []
    assert parallel_map(math.sqrt, [1, 4, 9, 16], workers=2, on_result=lambda k, r: seen.append(k)) == [1, 2, 3, 4]
    assert seen == [1, 2, 3, 4]


def test_parallel_map_runs_in_process_with_one_worker():
    assert parallel_map(math.sqrt, [4, 9], workers=1) == [2, 3]


def test_a_worker_error_fails_the_call():
    with pytest.raises(ValueError):
        parallel_map(math.sqrt, [4, -1, 9], workers=2)


def test_parallel_eval_matches_in_process(tmp_path):
    import torch

    torch.manual_seed(0)
    path = tmp_path / "m.pt"
    save_checkpoint(path, QNet(hidden=16, layers=1), step=0, config={})
    a = BidderSpec("sim", str(path), sim_deals=4)
    b = BidderSpec("heuristic", str(path))
    one = evaluate_auctions_parallel(a, b, deals=4, seed=2, workers=1)
    two = evaluate_auctions_parallel(a, b, deals=4, seed=2, workers=2, chunk=1)
    assert one.records == two.records and one.deal_scores == two.deal_scores and one.illegal == two.illegal
    assert len(one.decision_seconds) == len(two.decision_seconds) > 0


def test_a_worker_setup_error_is_raised_as_itself():
    with pytest.raises(ValueError):
        parallel_map(math.sqrt, [1, 4], workers=2, initializer=math.sqrt, initargs=(-1,))
