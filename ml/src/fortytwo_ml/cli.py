"""`ml train`, `ml eval`, `ml eval-bidding`, `ml gen-bids`, `ml train-bids`, `ml export`, `ml export-fixtures`, and `ml play-demo`.

Agents (`load_agent`): dumb, heuristic, a checkpoint path, `sim:<checkpoint.pt>` (simulation bidding)
and `fast:<bidnet.pt>` (BidNet bidding)."""
import argparse
import random
import sys
from datetime import datetime
from pathlib import Path

from .agents.base import Agent, choose
from .agents.dumb_bot import DumbBot
from .agents.fast_bidder import FastAgent, play_checkpoint_mismatch
from .agents.heuristic_bot import HeuristicBot
from .agents.model_agent import ModelAgent
from .agents.sim_bidder import SimAgent
from .bidding.model import load_bidnet
from .bidding.train import BidTrainConfig
from .contracts import DEFAULT_MIX, ContractSampler, contract_kind
from .engine.dominoes import domino_id
from .engine.enums import Suit
from .engine.hand_state import HandState, Phase
from .eval.arena import evaluate_hands, evaluate_matches
from .eval.auction_runner import build_bidder, evaluate_auctions_parallel, parse_bidder
from .eval.report import format_auction_report, format_report
from .sim.decide import DEFAULT_MAKE_THRESHOLD
from .sim.parallel import DEFAULT_WORKERS


def load_agent(spec: str) -> Agent:
    if spec == "dumb":
        return DumbBot()
    if spec == "heuristic":
        return HeuristicBot()
    if spec.startswith("sim:"):
        path = spec[len("sim:"):]
        if not Path(path).is_file():
            raise FileNotFoundError(f"no checkpoint at {path}")
        return SimAgent.from_checkpoint(path)
    if spec.startswith("fast:"):
        path = spec[len("fast:"):]
        if not Path(path).is_file():
            raise FileNotFoundError(f"no bidnet at {path}")
        return FastAgent.from_files(path)
    if not Path(spec).is_file():
        raise FileNotFoundError(f"no agent named {spec!r} and no checkpoint at that path")
    return ModelAgent.from_checkpoint(spec)


def _auction_demo(agent: SimAgent | FastAgent, seed: int) -> None:
    rng = random.Random(seed)
    order = list(range(28))
    rng.shuffle(order)
    state = HandState.deal(order, rng.randrange(4))
    for seat in range(4):
        print(f"  seat {seat}: {' '.join(domino_id(d) for d in state.hand(seat))}")
    while state.phase is Phase.BID:
        seat = state.to_act
        bid = agent.bid(state, seat)
        top = sorted(agent.last_decision.options, key=lambda o: -o.ev)[:5]
        print(f"  seat {seat} bids {bid}; top options: "
              + ", ".join(f"{o.bid}/{Suit(o.trump).name} p={o.p_make:.2f} ev={o.ev:+.2f}" for o in top))
        state.apply(bid)
    trump = agent.trump(state, state.to_act)
    print(f"Contract: seat {state.bidder} bid {state.high_bid}, trump {Suit(trump).name}")
    state.apply(trump)
    while state.phase is not Phase.DONE:
        state.apply(choose(agent, state))
    r = state.result
    print(f"Result: team {r.winning_team} wins {r.marks} mark(s); points {r.points[0]}-{r.points[1]}")


def _play_demo(agent: Agent, seed: int) -> None:
    if isinstance(agent, (SimAgent, FastAgent)):
        return _auction_demo(agent, seed)
    rng = random.Random(seed)
    order, _, contract = ContractSampler(DEFAULT_MIX, rng).sample_hand()
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
    e.add_argument("--kind", choices=["plunge", "low"], help="only evaluate this contract type")

    s = sub.add_parser("eval-bidding", help="compare two bidders on one play model (default: sim vs heuristic)")
    s.add_argument("--model", required=True, help="path/to/checkpoint.pt")
    s.add_argument("--deals", type=int, default=1000)
    s.add_argument("--a", default="sim", help="heuristic | sim | fast:<bidnet.pt>")
    s.add_argument("--b", default="heuristic", help="heuristic | sim | fast:<bidnet.pt>")
    s.add_argument("--workers", type=int, default=DEFAULT_WORKERS, help="worker processes (1 = in-process)")
    s.add_argument("--sim-deals", type=int, default=200)
    s.add_argument(
        "--make-threshold", type=float, default=DEFAULT_MAKE_THRESHOLD, help="bid only when P(make) is above this"
    )
    s.add_argument(
        "--matches",
        type=int,
        default=0,
        help="also play full matches; each plays full SimAgent auctions (several simulated bid decisions "
        "per hand), so even a few matches take a long time",
    )
    s.add_argument("--seed", type=int, default=0)

    g = sub.add_parser("gen-bids", help="Stage 3: simulate random hands into bidding-model training data")
    g.add_argument("--model", required=True, help="the play checkpoint the simulations use")
    g.add_argument("--out", required=True, help="data folder (batches are added; reruns resume)")
    g.add_argument("--hands", type=int, required=True)
    g.add_argument("--sim-deals", type=int, default=50)
    g.add_argument("--seed", type=int, default=0)
    g.add_argument("--workers", type=int, default=DEFAULT_WORKERS)

    t = sub.add_parser("train-bids", help="Stage 3: train BidNet on gen-bids data")
    t.add_argument("--data", required=True, help="gen-bids folder")
    t.add_argument("--gold", help="optional low-noise gen-bids folder, used only for the final report")
    t.add_argument("--out", required=True, type=Path, help="run folder; bidnet.pt is written here")
    t.add_argument("--epochs", type=int, default=100)
    t.add_argument("--seed", type=int, default=0)
    t.add_argument("--hidden", type=int, default=BidTrainConfig.hidden, help="units per hidden layer")
    t.add_argument("--layers", type=int, default=BidTrainConfig.layers, help="hidden layers")
    t.add_argument("--lr", type=float, default=BidTrainConfig.lr, help="Adam learning rate")

    x = sub.add_parser("export", help="Stage 4: write the bot's networks for the Worker (bot.bin + bot.json)")
    x.add_argument("--play", required=True, help="play checkpoint, e.g. runs/stage1-c/ckpt-latest.pt")
    x.add_argument("--bidnet", required=True, help="bidnet.pt from train-bids")
    x.add_argument("--out", required=True, type=Path, help="e.g. ../apps/web/public/models")
    x.add_argument("--name", default="bot")

    f = sub.add_parser("export-fixtures", help="Stage 4: golden fixtures for the TS bot's parity tests")
    f.add_argument("--out", required=True, type=Path)
    f.add_argument("--hands", type=int, default=300)
    f.add_argument("--seed", type=int, default=0)

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
        hands = evaluate_hands(a, b, args.deals, seed=args.seed, mix={args.kind: 1.0} if args.kind else None)
        matches = evaluate_matches(a, b, args.matches, seed=args.seed) if args.matches else None
        print(format_report(hands, matches))
    elif args.command == "eval-bidding":
        common = dict(model=args.model, sim_deals=args.sim_deals, make_threshold=args.make_threshold, seed=args.seed)
        a_spec, b_spec = parse_bidder(args.a, **common), parse_bidder(args.b, **common)
        for spec in (a_spec, b_spec):
            if spec.kind == "fast":
                warning = play_checkpoint_mismatch(load_bidnet(spec.bidnet)[1], args.model)
                if warning:
                    print(warning, file=sys.stderr)
        ev = evaluate_auctions_parallel(a_spec, b_spec, args.deals, seed=args.seed, workers=args.workers)
        matches = None
        if args.matches:
            matches = evaluate_matches(build_bidder(a_spec), build_bidder(b_spec), args.matches, seed=args.seed)
        print(format_auction_report(ev, matches))
    elif args.command == "gen-bids":
        from .bidding.data import GenConfig, generate

        written = generate(GenConfig(args.model, args.out, args.hands, args.sim_deals, args.seed, args.workers))
        print(f"wrote {written} hands to {args.out}")
    elif args.command == "train-bids":
        from .bidding.data import load_bids
        from .bidding.model import save_bidnet
        from .bidding.train import gold_report, train_bidnet

        data = load_bids(args.data)
        gold = load_bids(args.gold) if args.gold else None
        if gold is not None and (gold.play_checkpoint, gold.play_step) != (data.play_checkpoint, data.play_step):
            raise ValueError(f"the gold set was simulated with {gold.play_checkpoint} (step {gold.play_step}), "
                             f"the training data with {data.play_checkpoint} (step {data.play_step})")
        result = train_bidnet(data, BidTrainConfig(
            hidden=args.hidden, layers=args.layers, epochs=args.epochs, lr=args.lr, seed=args.seed
        ))
        meta = {"play_checkpoint": data.play_checkpoint, "play_path": data.play_path, "play_step": data.play_step,
                "train_hands": int(len(data.hands)), "val_loss": result.val_loss, "gold": {}}
        if gold is not None:
            lines, meta["gold"] = gold_report(result.net, gold)
            print("\n".join(lines))
        args.out.mkdir(parents=True, exist_ok=True)
        save_bidnet(args.out / "bidnet.pt", result.net, meta)
        print(f"trained {result.epochs} epochs on {len(data.hands)} hands; held-out loss {result.val_loss:.4f}; "
              f"saved {args.out / 'bidnet.pt'}")
    elif args.command == "export":
        from .bidding.data import checkpoint_label
        from .export import write_bot
        from .model import load_checkpoint

        qnet, info = load_checkpoint(args.play)
        bidnet, meta = load_bidnet(args.bidnet)
        here = (checkpoint_label(args.play), info["step"])
        there = (meta.get("play_checkpoint"), meta.get("play_step"))
        if here != there:
            raise ValueError(f"{args.bidnet} was trained on simulations by {there[0]} (step {there[1]}), "
                             f"not {here[0]} (step {here[1]}); export the pair it was trained for")
        manifest = write_bot(args.out, args.name, qnet, bidnet, {
            "play": here[0], "playStep": here[1], "bidnet": str(args.bidnet), "bidnetTrainHands": meta.get("train_hands"),
        })
        print(f"wrote {args.out / (args.name + '.bin')} ({manifest['totalBytes']} bytes, sha256 {manifest['sha256'][:12]}...)")
    elif args.command == "export-fixtures":
        from .export_fixtures import generate_fixtures

        generate_fixtures(args.out, args.hands, args.seed)
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
