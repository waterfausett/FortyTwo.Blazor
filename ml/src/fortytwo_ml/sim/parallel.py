"""Spread independent work over worker processes. Workers are spawned (the only start method on
Windows), each set up once by `initializer` (e.g. load a model) with torch limited to one thread so
N workers use about N cores. Results come back in item order; a worker's exception fails the call."""
import multiprocessing as mp
from collections.abc import Callable, Iterable
from concurrent.futures import ProcessPoolExecutor

DEFAULT_WORKERS = 7  # one core of the dev box's eight left for the parent and the machine


def _init_worker(initializer: Callable | None, initargs: tuple) -> None:
    import torch

    torch.set_num_threads(1)
    if initializer is not None:
        initializer(*initargs)


def parallel_map(
    fn: Callable, items: Iterable, workers: int, initializer: Callable | None = None, initargs: tuple = (),
    on_result: Callable[[int, object], None] | None = None,
) -> list:
    """`fn` and `initializer` must be importable top-level functions (spawned workers re-import them).
    With one worker (or one item) everything runs in this process, initializer included."""
    items = list(items)
    results: list = []

    def collect(result) -> None:
        results.append(result)
        if on_result is not None:
            on_result(len(results), result)

    if workers <= 1 or len(items) <= 1:
        if initializer is not None:
            initializer(*initargs)
        for item in items:
            collect(fn(item))
        return results
    pool = ProcessPoolExecutor(
        max_workers=min(workers, len(items)), mp_context=mp.get_context("spawn"),
        initializer=_init_worker, initargs=(initializer, initargs),
    )
    try:
        for result in pool.map(fn, items):
            collect(result)
    except BaseException:
        pool.shutdown(wait=False, cancel_futures=True)
        raise
    pool.shutdown()
    return results
