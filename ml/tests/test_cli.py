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
