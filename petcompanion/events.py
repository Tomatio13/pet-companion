"""Thread-safe event hub for SSE broadcasting."""

from __future__ import annotations

import queue
import threading
import time
from typing import Optional


class EventHub:
    """Broadcasts events to all connected SSE clients."""

    def __init__(self, history_size: int = 100) -> None:
        self._clients: list[queue.Queue] = []
        self._lock = threading.Lock()
        self._history: list[dict] = []
        self._history_size = history_size

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=100)
        with self._lock:
            self._clients.append(q)
            for event in self._history:
                try:
                    q.put_nowait(event)
                except queue.Full:
                    break
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            try:
                self._clients.remove(q)
            except ValueError:
                pass

    def emit(self, event: dict) -> int:
        if "timestamp" not in event:
            event["timestamp"] = time.time()
        with self._lock:
            self._history.append(event)
            if len(self._history) > self._history_size:
                self._history = self._history[-self._history_size :]
            dead: list[queue.Queue] = []
            count = 0
            for q in self._clients:
                try:
                    q.put_nowait(event)
                    count += 1
                except queue.Full:
                    dead.append(q)
            for q in dead:
                self._clients.remove(q)
        return count

    @property
    def client_count(self) -> int:
        with self._lock:
            return len(self._clients)
