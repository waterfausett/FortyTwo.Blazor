"""Build bidding agents from plain specs (so worker processes can rebuild them from file paths)
and run `evaluate_auctions` across workers."""
from dataclasses import dataclass
from pathlib import Path

from ..agents.base import Agent
from ..agents.model_agent import ModelAgent
from ..agents.sim_bidder import SimAgent
from ..sim.decide import DEFAULT_MAKE_THRESHOLD
from ..sim.parallel import DEFAULT_WORKERS, parallel_map
from .arena import AuctionEval, evaluate_auctions, merge_auction_evals


@dataclass(frozen=True)
class BidderSpec:
    kind: str  # "heuristic" | "sim" | "fast"
    model: str  # the play checkpoint both sides play with
    bidnet: str | None = None
    sim_deals: int = 200
    make_threshold: float = DEFAULT_MAKE_THRESHOLD
    seed: int = 0


def parse_bidder(text: str, model: str, sim_deals: int, make_threshold: float, seed: int) -> BidderSpec:
    if text in ("heuristic", "sim"):
        return BidderSpec(text, model, None, sim_deals, make_threshold, seed)
    raise ValueError(f"unknown bidder {text!r}; use heuristic or sim")


def build_bidder(spec: BidderSpec) -> Agent:
    if spec.kind == "heuristic":
        agent = ModelAgent.from_checkpoint(spec.model)
        agent.name = f"heuristic-bidding:{Path(spec.model).name}"
        return agent
    if spec.kind == "sim":
        return SimAgent.from_checkpoint(
            spec.model, n_deals=spec.sim_deals, make_threshold=spec.make_threshold, seed=spec.seed
        )
    raise ValueError(f"unknown bidder kind {spec.kind!r}")


_agents: tuple[Agent, Agent] | None = None  # this worker's A and B, built once


def _init_agents(a: BidderSpec, b: BidderSpec) -> None:
    global _agents
    _agents = (build_bidder(a), build_bidder(b))


def _run_chunk(task: tuple[range, int]) -> AuctionEval:
    deals, seed = task
    return evaluate_auctions(*_agents, deals, seed=seed)


def evaluate_auctions_parallel(
    a: BidderSpec, b: BidderSpec, deals: int, seed: int = 0, workers: int = DEFAULT_WORKERS, chunk: int | None = None
) -> AuctionEval:
    """`evaluate_auctions` over `deals` duplicate deals, split into contiguous chunks (about four per
    worker, for load balance). The result is identical for any worker count."""
    if deals < 1:
        raise ValueError("deals must be at least 1")
    size = chunk or max(1, -(-deals // (max(workers, 1) * 4)))
    tasks = [(range(start, min(start + size, deals)), seed) for start in range(0, deals, size)]
    return merge_auction_evals(parallel_map(_run_chunk, tasks, workers, _init_agents, (a, b)))
