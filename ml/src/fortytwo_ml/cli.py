"""`ml train`, `ml eval`, and `ml play-demo`."""
import argparse
import random
from datetime import datetime
from pathlib import Path

from .agents.base import Agent, choose
from .agents.dumb_bot import DumbBot
from .agents.heuristic_bot import HeuristicBot
from .agents.model_agent import ModelAgent
from .contracts import DEFAULT_MIX, ContractSampler, contract_kind
from .engine.dominoes import domino_id
from .engine.enums import Suit
from .engine.hand_state import HandState, Phase
from .eval.arena import evaluate_hands, evaluate_matches
from .eval.report import format_report


def load_agent(spec: str) -> Agent:
    if spec == "dumb":
        return DumbBot()
    if spec == "heuristic":
        return HeuristicBot()
    if not Path(spec).is_file():
        raise FileNotFoundError(f"no agent named {spec!r} and no checkpoint at that path")
    return ModelAgent.from_checkpoint(spec)


def _play_demo(agent: Agent, seed: int) -> None:
    rng = random.Random(seed)
    order = list(range(28))
    rng.shuffle(order)
    contract = ContractSampler(DEFAULT_MIX, rng).sample(order, rng.randrange(4))
    state = HandState.from_contract(order, contract.bidder, contract.bid, contract.trump)
    print(f"Contract: seat {contract.bidder} bid {contract.bid}, trump {Suit(contract.trump).name} "
          f"({contract_kind(contract)})")
    for seat in range(4):
        print(f"  seat {seat}: {' '.join(domino_id(d) for d in state.hand(seat))}")
    while state.phase is not Phase.DONE:
        seat = state.to_act
        if isinstance(agent, ModelAgent) and len(state.legal_actions()) > 1:
            qs = ", ".join(f"{domino_id(d)}={q:+.2f}" for d, q in agent.q_values(state, seat))
            print(f"  seat {seat} considers {qs}")
        action = choose(agent, state)
        state.apply(action)
        print(f"  seat {seat} plays {domino_id(action)}")
        if not state.trick and state.tricks:
            t = state.tricks[-1]
            print(f"  -> trick {len(state.tricks)} to seat {t.winner} ({t.points} pts)")
    r = state.result
    print(f"Result: team {r.winning_team} wins {r.marks} mark(s); points {r.points[0]}-{r.points[1]}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ml", description="Forty-Two ML bots")
    sub = parser.add_subparsers(dest="command", required=True)

    t = sub.add_parser("train", help="train the Stage 1 play model")
    t.add_argument("--config", required=True, type=Path)
    t.add_argument("--run-name")
    t.add_argument("--resume", type=Path)

    e = sub.add_parser("eval", help="duplicate-deal evaluation of agent A vs agent B")
    e.add_argument("--a", required=True, help="dumb | heuristic | path/to/checkpoint.pt")
    e.add_argument("--b", required=True, help="dumb | heuristic | path/to/checkpoint.pt")
    e.add_argument("--deals", type=int, default=5000)
    e.add_argument("--matches", type=int, default=0)
    e.add_argument("--seed", type=int, default=0)

    d = sub.add_parser("play-demo", help="print one hand, decision by decision")
    d.add_argument("--agent", default="heuristic")
    d.add_argument("--seed", type=int, default=0)

    b = sub.add_parser("bench-train", help="measure training throughput (no eval, no replay cap)")
    b.add_argument("--config", required=True, type=Path)
    b.add_argument("--seconds", type=float, default=60)

    args = parser.parse_args(argv)
    if args.command == "train":
        from .train.config import TrainConfig
        from .train.run import train

        name = args.run_name or datetime.now().strftime("%Y%m%d-%H%M%S")
        summary = train(TrainConfig.from_yaml(args.config), Path("runs") / name, args.resume)
        print(f"trained {summary.steps} steps, last loss {summary.last_loss:.4f}; checkpoint {summary.checkpoint}")
    elif args.command == "eval":
        a, b = load_agent(args.a), load_agent(args.b)
        hands = evaluate_hands(a, b, args.deals, seed=args.seed)
        matches = evaluate_matches(a, b, args.matches, seed=args.seed) if args.matches else None
        print(format_report(hands, matches))
    elif args.command == "bench-train":
        import dataclasses
        import tempfile

        from .train.config import TrainConfig
        from .train.run import train

        cfg = dataclasses.replace(
            TrainConfig.from_yaml(args.config),
            eval_every_steps=0, checkpoint_minutes=1e9, max_replay_ratio=0.0,
            max_seconds=args.seconds, total_steps=10**12,
        )
        with tempfile.TemporaryDirectory() as tmp:
            summary = train(cfg, Path(tmp) / "bench")
        seconds = summary.train_seconds or 1e-9
        print(f"actors: {cfg.num_actors}  batch: {cfg.batch_size}  measured over {summary.train_seconds:.0f}s of training")
        print(f"learner steps/s: {summary.steps / seconds:.1f}")
        print(f"samples/s ingested: {summary.samples_while_training / seconds:.0f}")
    else:
        _play_demo(load_agent(args.agent), args.seed)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
