"""Replays hands recorded from the real TS engine (packages/rules) and asserts the Python
engine agrees at every decision: same seat to act, same legal actions, and the same result.

Regenerate the fixture after a rules change:
  cd .. && npm run dump-traces -w @fortytwo/rules -- --count 5000 --seed 42 \
    --out ../../ml/tests/fixtures/ts-traces.jsonl.gz
"""
import gzip
import json
import os
from pathlib import Path

import pytest

from fortytwo_ml.engine.dominoes import from_id
from fortytwo_ml.engine.enums import LOW_TRUMPS, PLUNGE, Suit
from fortytwo_ml.engine.hand_state import HandState, Phase

TRACES = Path(os.environ.get("FORTYTWO_TRACES") or Path(__file__).parent / "fixtures" / "ts-traces.jsonl.gz")
PHASES = {"bid": Phase.BID, "trump": Phase.TRUMP, "play": Phase.PLAY}


def _load() -> list[dict]:
    with gzip.open(TRACES, "rt", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def _decode(phase: str, value) -> int:
    return from_id(value) if phase == "play" else int(value)


ALL_TRACES = _load()


def test_traces_cover_every_contract_type():
    bids = {s["action"] for t in ALL_TRACES for s in t["steps"] if s["phase"] == "bid"}
    trumps = {s["action"] for t in ALL_TRACES for s in t["steps"] if s["phase"] == "trump"}
    assert PLUNGE in bids and 84 in bids
    assert Suit.NONE in trumps
    assert set(LOW_TRUMPS) <= trumps


@pytest.mark.parametrize("trace", ALL_TRACES, ids=lambda t: f"hand{t['id']}")
def test_python_engine_matches_ts(trace):
    state = HandState.deal([from_id(x) for x in trace["deal"]], trace["opener"])
    for i, step in enumerate(trace["steps"]):
        where = f"hand {trace['id']} step {i} ({step['phase']})"
        phase = step["phase"]
        assert state.phase == PHASES[phase], f"{where}: phase"
        assert state.to_act == step["seat"], f"{where}: seat to act"
        expected = sorted(_decode(phase, x) for x in step["legal"])
        assert sorted(state.legal_actions()) == expected, f"{where}: legal actions differ"
        state.apply(_decode(phase, step["action"]))
    assert state.phase is Phase.DONE, f"hand {trace['id']}: TS decided the hand, Python didn't"
    expected = trace["result"]
    assert (state.result.winning_team, state.result.marks, list(state.result.points)) == (
        expected["winningTeam"], expected["marks"], expected["points"],
    ), f"hand {trace['id']}: result"
