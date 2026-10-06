import gzip
import json

from fortytwo_ml.export_fixtures import MARGIN, generate_fixtures


def _lines(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def test_fixtures_are_deterministic_per_seed(tmp_path):
    generate_fixtures(tmp_path / "a", hands=6, seed=3, require_coverage=False, log=lambda *_: None)
    generate_fixtures(tmp_path / "b", hands=6, seed=3, require_coverage=False, log=lambda *_: None)
    assert _lines(tmp_path / "a" / "hands.jsonl.gz") == _lines(tmp_path / "b" / "hands.jsonl.gz")
    assert (tmp_path / "a" / "tiny-bot.bin").read_bytes() == (tmp_path / "b" / "tiny-bot.bin").read_bytes()


def test_fixture_steps_carry_what_ts_checks(tmp_path):
    generate_fixtures(tmp_path, hands=6, seed=4, require_coverage=False, log=lambda *_: None)
    hands = _lines(tmp_path / "hands.jsonl.gz")
    assert len(hands) == 6 and all(len(h["deal"]) == 28 for h in hands)
    for h in hands:
        for s in h["steps"]:
            if s["phase"] == "bid" and not s["scripted"]:
                assert len(s["bidInput"]) == 36 and len(s["table"]["points"]) == 7
            if s["phase"] == "play" and len(s["legal"]) > 1:
                assert len(s["features"]) == len(s["q"]) == len(s["legal"])
                gap = sorted(s["q"], reverse=True)
                assert gap[0] - gap[1] >= MARGIN


def test_coverage_includes_every_contract_type(tmp_path):
    summary = generate_fixtures(tmp_path, hands=40, seed=0, log=lambda *_: None)
    assert {"points", "marks", "follow_me", "low", "plunge"} <= set(summary["kinds"])
    assert len(summary["low_trumps"]) == 3 and summary["plunge_named"] >= 1
