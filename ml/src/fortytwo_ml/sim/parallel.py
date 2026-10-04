"""Spread independent work over worker processes. Workers are spawned (the only start method on
Windows), each set up once by `initializer` (e.g. load a model) with torch limited to one thread so
N workers use about N cores. Results come back in item order; the first exception from any item
fails the call at once and stops the workers."""
import multiprocessing as mp
from collections.abc import Callable, Iterable
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait

DEFAULT_WORKERS = 7  # one core of the dev box's eight left for the parent and the machine


_init_error: Exception | None = None  # this worker's setup failure, re-raised by its first task


def _init_worker(initializer: Callable | None, initargs: tuple) -> None:
    global _init_error
    import torch

    torch.set_num_threads(1)
    if initializer is not None:
        try:
            initializer(*initargs)
        except Exception as e:  # keep the worker alive so the caller gets this error, not BrokenProcessPool
            _init_error = e


def _guarded(fn: Callable, item):
    if _init_error is not None:
        raise _init_error
    return fn(item)


def _stop(pool: ProcessPoolExecutor) -> None:
    """Kill the workers now. `shutdown(cancel_futures=True)` alone can't stop items already handed
    to a worker, and the interpreter's exit hook would wait for them (gen-bids items run for
    minutes). The executor has no public way to reach its processes, hence the private `_processes`."""
    for p in list((pool._processes or {}).values()):
        p.terminate()
    pool.shutdown(wait=False, cancel_futures=True)


def parallel_map(
    fn: Callable, items: Iterable, workers: int, initializer: Callable | None = None, initargs: tuple = (),
    on_result: Callable[[int, object], None] | None = None,
) -> list:
    """`fn` and `initializer` must be importable top-level functions (spawned workers re-import them).
    With one worker (or one item) everything runs in this process, initializer included.
    `on_result(done_count, result)` is called in item order."""
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
        futures = [pool.submit(_guarded, fn, item) for item in items]
        pending = set(futures)
        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for f in done:  # fail fast: any item's error, not just the next one in order
                if f.exception() is not None:
                    raise f.exception()
            while len(results) < len(futures) and futures[len(results)].done():  # flush the finished prefix
                collect(futures[len(results)].result())
    except BaseException:  # including KeyboardInterrupt
        _stop(pool)
        raise
    pool.shutdown()
    return results
