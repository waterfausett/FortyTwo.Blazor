"""Golden fixtures for the TS bot's parity tests: a tiny random bot (QNet and BidNet, hidden 16)
in the export format, and complete hands it played against itself, with what the TS bot must
reproduce at every decision. Every third hand forces an exotic contract (marks, follow-me, Low,
plunge) with a scripted auction, so every contract type and a partner naming plunge trump appear.
Hands with a decision closer than MARGIN are redrawn, so float noise can't flip the TS choice."""
import gzip
import io
import json
import math
import random
from dataclasses import replace
from pathlib import Path

import numpy as np
import torch

from .agents.fast_bidder import FastBidder
from .agents.model_agent import ModelAgent
from .bidding.model import BidNet, encode_hands
from .contracts import ContractSampler, contract_kind
from .engine.dominoes import domino_id
from .engine.enums import LOW_TRUMPS, PASS, PLUNGE, is_low
from .engine.hand_state import HandState, Phase
from .export import OVERBID_PARTNER_THRESHOLD, write_bot
from .features import encode_actions
from .model import QNet
from .sim.decide import DEFAULT_MAKE_THRESHOLD
from .sim.probe import HIGH_TRUMPS, options_from_table

MARGIN = 1e-4
_SCRIPTED_MIX = {"marks": 1.0, "follow_me": 1.0, "low": 1.0, "plunge": 1.0}


def _gap(values: list[float]) -> float:
    ordered = sorted(values, reverse=True)
    return ordered[0] - ordered[1] if len(ordered) > 1 else math.inf


def _table_json(table) -> dict:
    return {"points": table.points.tolist(), "high": table.high.tolist(), "low": table.low.tolist(), "plunge": table.plunge}


class _Recorder:
    def __init__(self, qnet: QNet, bidnet: BidNet):
        self.bidder = FastBidder(bidnet, DEFAULT_MAKE_THRESHOLD, OVERBID_PARTNER_THRESHOLD)
        self.player = ModelAgent(qnet)
        self.qnet = qnet
        self.margin = math.inf

    def bid(self, state: HandState, seat: int) -> dict:
        hand = state.hand(seat)
        table = self.bidder.bidnet.table(hand)
        options = options_from_table(table, state.legal_actions())
        action = self.bidder.bid(state, seat)
        for o in options:
            self.margin = min(self.margin, abs(o.p_make - DEFAULT_MAKE_THRESHOLD), abs(o.p_make - OVERBID_PARTNER_THRESHOLD))
        for b in {o.bid for o in options}:
            self.margin = min(self.margin, _gap([o.p_make for o in options if o.bid == b]))
        return {"seat": seat, "phase": "bid", "action": int(action), "scripted": False,
                "bidInput": encode_hands(np.array([hand]))[0].tolist(), "table": _table_json(table)}

    def trump(self, state: HandState, seat: int) -> dict:
        legal = state.legal_actions()
        table = self.bidder.bidnet.table(state.hand(seat))
        if state.high_bid == PLUNGE and state.bidder != seat:
            candidates = [float(table.high[HIGH_TRUMPS.index(t)]) for t in legal]
        else:
            candidates = [o.p_make for o in options_from_table(table, [state.high_bid]) if o.trump in legal]
        self.margin = min(self.margin, _gap(candidates))
        return {"seat": seat, "phase": "trump", "action": int(self.bidder.trump(state, seat)), "scripted": False}

    def play(self, state: HandState, seat: int) -> dict:
        legal = state.legal_actions()
        step = {"seat": seat, "phase": "play", "legal": [domino_id(d) for d in legal], "scripted": False}
        if len(legal) > 1:
            rows = encode_actions(state, seat, legal)
            with torch.no_grad():
                q = self.qnet(torch.from_numpy(rows)).tolist()
            self.margin = min(self.margin, _gap(q))
            step["features"] = [[[int(i), float(row[i])] for i in np.nonzero(row)[0]] for row in rows]
            step["q"] = q
        step["action"] = domino_id(self.player.play(state, seat))
        return step


def _action_value(state: HandState, seat: int, step: dict) -> int:
    """A step's action as the engine's int: bids and trumps already are; plays are domino ids."""
    if step["phase"] != "play":
        return step["action"]
    return next(d for d in state.hand(seat) if domino_id(d) == step["action"])


def _play_hand(qnet: QNet, bidnet: BidNet, rng: random.Random, scripted: bool) -> tuple[dict, HandState] | None:
    if scripted:
        order, opener, contract = ContractSampler(_SCRIPTED_MIX, rng).sample_hand()
        if is_low(contract.trump):
            # The sampler always names the safest Low variant, which is never plain LOW; draw one so all three appear.
            contract = replace(contract, trump=rng.choice(LOW_TRUMPS))
    else:
        order = list(range(28))
        rng.shuffle(order)
        opener, contract = rng.randrange(4), None
    state = HandState.deal(order, opener)
    rec = _Recorder(qnet, bidnet)
    steps = []
    while state.phase is not Phase.DONE:
        seat = state.to_act
        if state.phase is Phase.BID:
            if contract is not None:
                action = contract.bid if seat == contract.bidder else PASS
                step = {"seat": seat, "phase": "bid", "action": int(action), "scripted": True}
            else:
                step = rec.bid(state, seat)
        elif state.phase is Phase.TRUMP:
            if contract is not None and contract.bid != PLUNGE:
                step = {"seat": seat, "phase": "trump", "action": int(contract.trump), "scripted": True}
            else:
                step = rec.trump(state, seat)
        else:
            step = rec.play(state, seat)
        steps.append(step)
        state.apply(_action_value(state, seat, step))
        if rec.margin < MARGIN:
            return None
    return {"deal": [domino_id(d) for d in order], "opener": opener, "steps": steps}, state


def generate_fixtures(out_dir: Path, hands: int, seed: int, require_coverage: bool = True, log=print) -> dict:
    out_dir = Path(out_dir)
    torch.manual_seed(seed)
    qnet, bidnet = QNet(hidden=16, layers=1).eval(), BidNet(hidden=16, layers=1).eval()
    write_bot(out_dir, "tiny-bot", qnet, bidnet, {"tiny": True, "seed": seed})
    records, kinds, low_trumps = [], set(), set()
    plunge_named, dropped, i = 0, 0, 0

    def covered() -> bool:
        return {"points", "marks", "follow_me", "low", "plunge"} <= kinds and len(low_trumps) == 3 and plunge_named > 0

    while len(records) < hands or (require_coverage and not covered()):
        if i > 50 * max(hands, 20):
            raise RuntimeError(f"no full coverage after {i} hands: kinds={sorted(kinds)}, low={sorted(low_trumps)}")
        rng = random.Random(f"fixtures:{seed}:{i}")
        played = _play_hand(qnet, bidnet, rng, scripted=i % 3 == 2)
        i += 1
        if played is None:
            dropped += 1
            continue
        record, state = played
        records.append(record)
        kinds.add(contract_kind(state.contract))
        if is_low(state.trump):
            low_trumps.add(state.trump)
        if state.high_bid == PLUNGE:
            plunge_named += 1
    out_dir.mkdir(parents=True, exist_ok=True)
    # mtime=0 keeps the gzip header, and so the whole file, identical between runs with one seed.
    with gzip.GzipFile(out_dir / "hands.jsonl.gz", "wb", mtime=0) as raw, io.TextIOWrapper(raw, encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")
    summary = {"hands": len(records), "dropped": dropped, "kinds": sorted(kinds),
               "low_trumps": sorted(int(t) for t in low_trumps), "plunge_named": plunge_named}
    log(f"wrote {summary['hands']} hands ({dropped} redrawn for close calls); kinds {summary['kinds']}")
    return summary
