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
