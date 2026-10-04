import pytest

from fortytwo_ml.agents.dumb_bot import DumbBot
from fortytwo_ml.agents.model_agent import ModelAgent
from fortytwo_ml.cli import load_agent, main
from fortytwo_ml.model import QNet, save_checkpoint


def test_eval_prints_a_report(capsys):
    assert main(["eval", "--a", "heuristic", "--b", "dumb", "--deals", "20", "--matches", "2"]) == 0
    out = capsys.readouterr().out
    assert "Mean marks/deal" in out and "Match win rate" in out


def test_play_demo_prints_a_hand(capsys):
    assert main(["play-demo", "--agent", "heuristic", "--seed", "3"]) == 0
    out = capsys.readouterr().out
    assert "Contract:" in out and "Result:" in out


def test_load_agent(tmp_path):
    assert isinstance(load_agent("dumb"), DumbBot)
    path = tmp_path / "m.pt"
    save_checkpoint(path, QNet(hidden=16, layers=1), step=0, config={})
    assert isinstance(load_agent(str(path)), ModelAgent)
    with pytest.raises(FileNotFoundError):
        load_agent(str(tmp_path / "missing.pt"))


def test_bench_train_reports_rates(capsys):
    from pathlib import Path

    smoke = Path(__file__).parent.parent / "configs" / "smoke.yaml"
    assert main(["bench-train", "--config", str(smoke), "--seconds", "3"]) == 0
    out = capsys.readouterr().out
    assert "learner steps/s:" in out and "samples/s ingested:" in out


def test_eval_kind_restricts_the_contracts(capsys):
    assert main(["eval", "--a", "heuristic", "--b", "dumb", "--deals", "10", "--kind", "low"]) == 0
    out = capsys.readouterr().out
    assert "  low " in out and "  points " not in out


def test_eval_bidding_runs_on_a_tiny_checkpoint(tmp_path, capsys):
    path = tmp_path / "m.pt"
    save_checkpoint(path, QNet(hidden=16, layers=1), step=0, config={})
    assert main(["eval-bidding", "--model", str(path), "--deals", "2", "--sim-deals", "4", "--workers", "1"]) == 0
    assert "Calibration" in capsys.readouterr().out


def test_eval_bidding_passes_bidders_and_threshold(tmp_path, monkeypatch):
    from fortytwo_ml import cli

    path = tmp_path / "m.pt"
    save_checkpoint(path, QNet(hidden=16, layers=1), step=0, config={})
    seen = {}

    def fake(a, b, deals, seed=0, workers=7):
        seen.update(a=a, b=b, workers=workers)
        raise SystemExit(0)

    monkeypatch.setattr(cli, "evaluate_auctions_parallel", fake)
    with pytest.raises(SystemExit):
        main(["eval-bidding", "--model", str(path), "--deals", "1", "--make-threshold", "0.7",
              "--a", "heuristic", "--b", "sim", "--workers", "3"])
    assert seen["a"].kind == "heuristic" and seen["b"].kind == "sim"
    assert seen["b"].make_threshold == 0.7 and seen["workers"] == 3


def test_load_agent_sim(tmp_path):
    from fortytwo_ml.agents.sim_bidder import SimAgent

    path = tmp_path / "m.pt"
    save_checkpoint(path, QNet(hidden=16, layers=1), step=0, config={})
    assert isinstance(load_agent(f"sim:{path}"), SimAgent)


def test_play_demo_sim_runs_an_auction(tmp_path, capsys):
    path = tmp_path / "m.pt"
    save_checkpoint(path, QNet(hidden=16, layers=1), step=0, config={})
    assert main(["play-demo", "--agent", f"sim:{path}", "--seed", "3"]) == 0
    out = capsys.readouterr().out
    assert "top options" in out and "Contract:" in out and "Result:" in out


def test_gen_bids_cli(tmp_path, capsys):
    path = tmp_path / "m.pt"
    save_checkpoint(path, QNet(hidden=16, layers=1), step=0, config={})
    assert main(["gen-bids", "--model", str(path), "--out", str(tmp_path / "d"), "--hands", "2",
                 "--sim-deals", "2", "--workers", "1"]) == 0
    assert "wrote 2 hands" in capsys.readouterr().out


def test_train_bids_cli(tmp_path, capsys):
    from fortytwo_ml.bidding.model import load_bidnet

    path = tmp_path / "m.pt"
    save_checkpoint(path, QNet(hidden=16, layers=1), step=0, config={})
    main(["gen-bids", "--model", str(path), "--out", str(tmp_path / "d"), "--hands", "6", "--sim-deals", "2", "--workers", "1"])
    assert main(["train-bids", "--data", str(tmp_path / "d"), "--gold", str(tmp_path / "d"),
                 "--out", str(tmp_path / "run"), "--epochs", "2"]) == 0
    assert "Gold set" in capsys.readouterr().out
    net, meta = load_bidnet(tmp_path / "run" / "bidnet.pt")
    assert meta["train_hands"] == 6 and "mae_30" in meta["gold"]


def _fast_files(tmp_path, play_step=0):
    from fortytwo_ml.bidding.model import BidNet, save_bidnet

    play = tmp_path / "run" / "m.pt"
    play.parent.mkdir(exist_ok=True)
    save_checkpoint(play, QNet(hidden=16, layers=1), step=0, config={})
    bidnet = tmp_path / "bidnet.pt"
    save_bidnet(bidnet, BidNet(hidden=16, layers=1), {"play_checkpoint": "run/m.pt", "play_path": str(play),
                                                      "play_step": play_step, "train_hands": 1, "val_loss": 0.0, "gold": {}})
    return play, bidnet


def test_load_agent_fast(tmp_path):
    from fortytwo_ml.agents.fast_bidder import FastAgent

    _, bidnet = _fast_files(tmp_path)
    assert isinstance(load_agent(f"fast:{bidnet}"), FastAgent)


def test_eval_bidding_fast_vs_sim(tmp_path, capsys):
    play, bidnet = _fast_files(tmp_path)
    assert main(["eval-bidding", "--model", str(play), "--a", f"fast:{bidnet}", "--b", "sim",
                 "--deals", "2", "--sim-deals", "4", "--workers", "2"]) == 0
    out = capsys.readouterr().out
    assert "A: fast" in out and "Bid decision time (A)" in out and "Bid decision time (B)" in out


def test_eval_bidding_warns_on_play_checkpoint_mismatch(tmp_path, capsys):
    play, bidnet = _fast_files(tmp_path, play_step=5)
    assert main(["eval-bidding", "--model", str(play), "--a", f"fast:{bidnet}", "--b", "heuristic",
                 "--deals", "1", "--workers", "1"]) == 0
    captured = capsys.readouterr()
    assert "warning" in captured.err and "Mean marks/deal" in captured.out


def test_play_demo_fast(tmp_path, capsys):
    _, bidnet = _fast_files(tmp_path)
    assert main(["play-demo", "--agent", f"fast:{bidnet}", "--seed", "3"]) == 0
    assert "top options" in capsys.readouterr().out
