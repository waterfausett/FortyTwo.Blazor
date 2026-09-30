import numpy as np


class ReplayBuffer:
    """A ring buffer of (input row, marks reward, point-difference) samples. Rows are stored as
    float16 (they're almost all 0/1) to keep a 200k buffer small."""

    def __init__(self, capacity: int, dim: int):
        self.capacity = capacity
        self._x = np.zeros((capacity, dim), np.float16)
        self._marks = np.zeros(capacity, np.float32)
        self._pdiff = np.zeros(capacity, np.float32)
        self._pos = 0
        self._size = 0

    def __len__(self) -> int:
        return self._size

    def add(self, x: np.ndarray, marks: np.ndarray, pdiff: np.ndarray) -> None:
        for i in range(len(marks)):
            self._x[self._pos] = x[i]
            self._marks[self._pos] = marks[i]
            self._pdiff[self._pos] = pdiff[i]
            self._pos = (self._pos + 1) % self.capacity
            self._size = min(self._size + 1, self.capacity)

    def sample(self, n: int, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        idx = rng.integers(0, self._size, size=n)
        return self._x[idx].astype(np.float32), self._marks[idx], self._pdiff[idx]
