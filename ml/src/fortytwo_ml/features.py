"""What the play model sees, from the acting seat's point of view: seats are rotated so the actor
is 0, its partner 2, and the opponents 1 (left) and 3 (right). A pure function of the hand state,
so Stage 4 can port it to TS and parity-test it."""
from collections.abc import Sequence

import numpy as np

from .engine.bidding import CONTRACT_BIDS
from .engine.enums import ALL_TRUMPS, PLUNGE
from .engine.hand_state import HandState, partner, team_of

HAND = 0                  # 28: own hand
PLAYED = HAND + 28        # 4 x 28: dominoes each relative seat has played (current trick included)
TRICK = PLAYED + 4 * 28   # 4 x 28: the current trick, by relative seat
LED = TRICK + 4 * 28      # 9: led suit 0..6, DOUBLES (7), or none yet (8)
TRUMP = LED + 9           # 11: ALL_TRUMPS one-hot
BID = TRUMP + 11          # 20: CONTRACT_BIDS one-hot
BIDDER = BID + 20         # 4: bidder's relative seat
PLUNGE_FLAG = BIDDER + 4  # 1
SITS_OUT = PLUNGE_FLAG + 1  # 1: my partner sits out (Low)
VOIDS = SITS_OUT + 1      # 3 x 8: relative seats 1..3 x led suits they failed to follow
SCALARS = VOIDS + 24      # 3: our points / 42, their points / 42, tricks played / 7
OBS_DIM = SCALARS + 3
ACTION_DIM = 28
INPUT_DIM = OBS_DIM + ACTION_DIM

_TRUMP_INDEX = {t: i for i, t in enumerate(ALL_TRUMPS)}
_BID_INDEX = {b: i for i, b in enumerate(CONTRACT_BIDS)}


def _bits(x: np.ndarray, offset: int, mask: int) -> None:
    while mask:
        low = mask & -mask
        x[offset + low.bit_length() - 1] = 1.0
        mask ^= low


def encode_observation(state: HandState, seat: int) -> np.ndarray:
    x = np.zeros(OBS_DIM, dtype=np.float32)

    def rel(s: int) -> int:
        return (s - seat) % 4

    _bits(x, HAND, state.hands[seat])
    for s in range(4):
        _bits(x, PLAYED + rel(s) * 28, state.played[s])
    for s, d in state.trick:
        x[TRICK + rel(s) * 28 + d] = 1.0
    led = state.led_suit
    x[LED + (8 if led is None else led)] = 1.0
    x[TRUMP + _TRUMP_INDEX[state.trump]] = 1.0
    x[BID + _BID_INDEX[state.high_bid]] = 1.0
    x[BIDDER + rel(state.bidder)] = 1.0
    x[PLUNGE_FLAG] = float(state.high_bid == PLUNGE)
    x[SITS_OUT] = float(state.sits_out == partner(seat))
    for s in range(4):
        if s != seat:
            _bits(x, VOIDS + (rel(s) - 1) * 8, state.voids[s])
    team = team_of(seat)
    x[SCALARS] = state.points[team] / 42
    x[SCALARS + 1] = state.points[1 - team] / 42
    x[SCALARS + 2] = len(state.tricks) / 7
    return x


def encode_actions(state: HandState, seat: int, actions: Sequence[int]) -> np.ndarray:
    xs = np.zeros((len(actions), INPUT_DIM), dtype=np.float32)
    xs[:, :OBS_DIM] = encode_observation(state, seat)
    for i, a in enumerate(actions):
        xs[i, OBS_DIM + a] = 1.0
    return xs
