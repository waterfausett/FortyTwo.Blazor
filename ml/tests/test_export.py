import json

import numpy as np
import torch

from fortytwo_ml.bidding.model import BidNet, encode_hands
from fortytwo_ml.export import FORMAT, read_bot, write_bot
from fortytwo_ml.features import INPUT_DIM
from fortytwo_ml.model import QNet


def _nets():
    torch.manual_seed(0)
    return QNet(hidden=16, layers=2).eval(), BidNet(hidden=8, layers=2).eval()


def test_write_bot_layout_and_round_trip(tmp_path):
    qnet, bidnet = _nets()
    manifest = write_bot(tmp_path, "bot", qnet, bidnet, {"source": "test"})
    assert manifest["format"] == FORMAT and manifest["playInputDim"] == INPUT_DIM and manifest["bidInputLayout"] == 1
    assert manifest["makeThreshold"] == 0.6 and manifest["overbidPartnerThreshold"] == 0.9
    assert len(manifest["play"]["layers"]) == 3 and len(manifest["bid"]["body"]) == 2
    bin_bytes = (tmp_path / "bot.bin").read_bytes()
    assert len(bin_bytes) == manifest["totalBytes"]
    assert all(t["offset"] % 4 == 0 for t in manifest["tensors"].values())
    assert json.loads((tmp_path / "bot.json").read_text()) == manifest

    q2, b2, _ = read_bot(tmp_path, "bot")
    x = torch.randn(5, INPUT_DIM)
    assert torch.equal(qnet(x), q2(x))
    hands = np.array([[0, 1, 2, 3, 4, 5, 6], [7, 13, 18, 22, 1, 2, 3]])
    xb = torch.from_numpy(encode_hands(hands))
    for a, b in zip(bidnet(xb), b2(xb)):
        assert torch.equal(a, b)


def test_tensor_order_is_little_endian_float32(tmp_path):
    qnet, bidnet = _nets()
    manifest = write_bot(tmp_path, "bot", qnet, bidnet, {})
    first = manifest["play"]["layers"][0]["weight"]
    t = manifest["tensors"][first]
    raw = np.frombuffer((tmp_path / "bot.bin").read_bytes(), dtype="<f4", count=int(np.prod(t["shape"])), offset=t["offset"])
    assert np.array_equal(raw.reshape(t["shape"]), qnet.net[0].weight.detach().numpy())
