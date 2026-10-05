"""Write the shipped bot's two networks for the TS Worker bot (cloudflare/packages/bot): one
little-endian float32 blob plus a JSON manifest naming every tensor's shape and byte offset."""
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
from torch import nn

from .bidding.model import INPUT_LAYOUT, BidNet
from .features import INPUT_DIM
from .model import QNet
from .sim.decide import DEFAULT_MAKE_THRESHOLD

FORMAT = 1
OVERBID_PARTNER_THRESHOLD = 0.9


def _linears(module: nn.Module) -> list[tuple[str, nn.Linear]]:
    return [(name, m) for name, m in module.named_modules() if isinstance(m, nn.Linear)]


def write_bot(out_dir: Path, name: str, qnet: QNet, bidnet: BidNet, provenance: dict) -> dict:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    tensors: dict[str, dict] = {}
    chunks: list[bytes] = []
    offset = 0

    def add(tname: str, t: torch.Tensor) -> str:
        nonlocal offset
        a = np.ascontiguousarray(t.detach().cpu().numpy().astype("<f4"))
        tensors[tname] = {"shape": list(a.shape), "offset": offset}
        chunks.append(a.tobytes())
        offset += a.nbytes
        return tname

    def dense(prefix: str, lin: nn.Linear) -> dict:
        return {"weight": add(f"{prefix}.weight", lin.weight), "bias": add(f"{prefix}.bias", lin.bias)}

    play = [dense(f"play.{n}", m) for n, m in _linears(qnet)]
    body = [dense(f"bid.body.{n}", m) for n, m in _linears(bidnet.body)]
    points_head = dense("bid.points_head", bidnet.points_head)
    binary_head = dense("bid.binary_head", bidnet.binary_head)
    blob = b"".join(chunks)
    manifest = {
        "format": FORMAT,
        "totalBytes": len(blob),
        "sha256": hashlib.sha256(blob).hexdigest(),
        "playInputDim": INPUT_DIM,
        "bidInputLayout": INPUT_LAYOUT,
        "makeThreshold": DEFAULT_MAKE_THRESHOLD,
        "overbidPartnerThreshold": OVERBID_PARTNER_THRESHOLD,
        "tensors": tensors,
        "play": {"layers": play},
        "bid": {"body": body, "pointsHead": points_head, "binaryHead": binary_head},
        "provenance": {**provenance, "exported": datetime.now(timezone.utc).isoformat(timespec="seconds")},
    }
    for path, data in ((out_dir / f"{name}.bin", blob), (out_dir / f"{name}.json", json.dumps(manifest, indent=1).encode())):
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)
    return manifest


def read_bot(out_dir: Path, name: str) -> tuple[QNet, BidNet, dict]:
    out_dir = Path(out_dir)
    manifest = json.loads((out_dir / f"{name}.json").read_text())
    blob = (out_dir / f"{name}.bin").read_bytes()

    def tensor(tname: str) -> torch.Tensor:
        t = manifest["tensors"][tname]
        a = np.frombuffer(blob, dtype="<f4", count=int(np.prod(t["shape"])), offset=t["offset"])
        return torch.from_numpy(a.reshape(t["shape"]).copy())

    def load(linears: list[tuple[str, nn.Linear]], refs: list[dict]) -> None:
        for (_, lin), ref in zip(linears, refs, strict=True):
            lin.weight.data.copy_(tensor(ref["weight"]))
            lin.bias.data.copy_(tensor(ref["bias"]))

    play, body = manifest["play"]["layers"], manifest["bid"]["body"]
    qnet = QNet(hidden=manifest["tensors"][play[0]["weight"]]["shape"][0], layers=len(play) - 1)
    bidnet = BidNet(hidden=manifest["tensors"][body[0]["weight"]]["shape"][0], layers=len(body))
    load(_linears(qnet), play)
    load(_linears(bidnet.body), body)
    load([("", bidnet.points_head)], [manifest["bid"]["pointsHead"]])
    load([("", bidnet.binary_head)], [manifest["bid"]["binaryHead"]])
    return qnet.eval(), bidnet.eval(), manifest
