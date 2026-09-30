"""What every player (bot, heuristic, or model) looks like to the engine and the arena.

An agent may read public state (bids, trump, tricks, the current trick, played dominoes, voids)
and only its OWN hand (`state.hand(seat)` / `state.hands[seat]`). Nothing enforces this; it's the
contract that keeps evaluation honest."""
from collections.abc import Callable, Sequence
from typing import Protocol

from ..engine.hand_state import HandResult, HandState, IllegalAction, Phase


class Agent(Protocol):
    name: str

    def bid(self, state: HandState, seat: int) -> int: ...

    def trump(self, state: HandState, seat: int) -> int: ...

    def play(self, state: HandState, seat: int) -> int: ...


def choose(agent: Agent, state: HandState) -> int:
    seat = state.to_act
    if state.phase is Phase.BID:
        return agent.bid(state, seat)
    if state.phase is Phase.TRUMP:
        return agent.trump(state, seat)
    if state.phase is Phase.PLAY:
        return agent.play(state, seat)
    raise ValueError("the hand is over")


def run_hand(
    state: HandState,
    agents: Sequence[Agent],
    on_illegal: Callable[[int, int], None] | None = None,
) -> HandResult:
    """Plays `state` to the end, `agents[seat]` choosing for each seat. An illegal choice raises,
    unless `on_illegal(seat, action)` is given, in which case it's reported and the first legal
    action is played instead."""
    while state.phase is not Phase.DONE:
        seat = state.to_act
        action = choose(agents[seat], state)
        legal = state.legal_actions()
        if action not in legal:
            if on_illegal is None:
                raise IllegalAction(seat, state.phase, action, legal)
            on_illegal(seat, action)
            action = legal[0]
        state.apply(action)
    return state.result
