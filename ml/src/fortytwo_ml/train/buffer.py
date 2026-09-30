import numpy as np
import torch


class ReplayBuffer:
    """A ring buffer of (input row, marks reward, point-difference) samples, kept on the training
    device so sampling costs no host work or host-to-device copy. Rows are float16 (almost all
    0/1)."""

    def __init__(self, capacity: int, dim: int, device: str | torch.device = "cpu"):
        self.capacity = capacity
        self.device = torch.device(device)
        self._x = torch.zeros((capacity, dim), dtype=torch.float16, device=self.device)
        self._marks = torch.zeros(capacity, dtype=torch.float32, device=self.device)
        self._pdiff = torch.zeros(capacity, dtype=torch.float32, device=self.device)
        self._pos = 0
        self._size = 0

    def __len__(self) -> int:
        return self._size

    def add(self, x: np.ndarray, marks: np.ndarray, pdiff: np.ndarray) -> None:
        n = len(marks)
        if n == 0:
            return
        if n > self.capacity:  # only the newest rows would survive anyway
            x, marks, pdiff, n = x[-self.capacity:], marks[-self.capacity:], pdiff[-self.capacity:], self.capacity
        xt = torch.from_numpy(np.ascontiguousarray(x, dtype=np.float16)).to(self.device)
        mt = torch.from_numpy(np.ascontiguousarray(marks, dtype=np.float32)).to(self.device)
        pt = torch.from_numpy(np.ascontiguousarray(pdiff, dtype=np.float32)).to(self.device)
        first = min(n, self.capacity - self._pos)
        self._write(self._pos, xt[:first], mt[:first], pt[:first])
        if first < n:
            self._write(0, xt[first:], mt[first:], pt[first:])
        self._pos = (self._pos + n) % self.capacity
        self._size = min(self._size + n, self.capacity)

    def _write(self, at: int, x: torch.Tensor, marks: torch.Tensor, pdiff: torch.Tensor) -> None:
        k = len(marks)
        self._x[at:at + k] = x
        self._marks[at:at + k] = marks
        self._pdiff[at:at + k] = pdiff

    def sample(self, n: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        if self._size == 0:
            raise ValueError("can't sample from an empty replay buffer")
        idx = torch.randint(0, self._size, (n,), device=self.device)
        return self._x[idx].float(), self._marks[idx], self._pdiff[idx]
