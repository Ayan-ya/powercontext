# Copyright (c) 2026 OceanBase.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Coalesce, deduplicate, and cache embedding work shared across callers."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from powercontext.builtin.inference.models import EmbeddingResult, EmbeddingVector, InferenceUsage

if TYPE_CHECKING:
    from powercontext.builtin.artifacts.memory.models import EmbeddingProfile

DEFAULT_MAX_BATCH_SIZE = 64
DEFAULT_COALESCE_MS = 5.0
DEFAULT_CACHE_SIZE = 1024


class _EmbeddingBackend(Protocol):
    profile: EmbeddingProfile

    async def embed(self, texts: tuple[str, ...], /) -> EmbeddingResult: ...


@dataclass(frozen=True, slots=True)
class _Embedded:
    """One resolved vector together with the provider batch that produced it."""

    vector: EmbeddingVector
    batch: int
    usage: InferenceUsage


class CoalescingEmbeddingModel:
    """Share one provider batch across concurrent, overlapping embedding calls.

    Identical texts are embedded once per coalescing window, in-flight work is
    reused by later callers, and successful vectors are cached. Cancelling one
    caller never cancels the shared provider request.
    """

    def __init__(
        self,
        model: _EmbeddingBackend,
        *,
        max_batch_size: int = DEFAULT_MAX_BATCH_SIZE,
        coalesce_ms: float = DEFAULT_COALESCE_MS,
        cache_size: int = DEFAULT_CACHE_SIZE,
    ) -> None:
        if max_batch_size < 1:
            raise ValueError("max_batch_size must be a positive integer")
        if cache_size < 0:
            raise ValueError("cache_size must not be negative")
        self._model = model
        self.profile: EmbeddingProfile = model.profile
        self._max_batch_size = max_batch_size
        self._coalesce_seconds = max(coalesce_ms, 0.0) / 1000.0
        self._cache_size = cache_size
        self._cache: OrderedDict[str, EmbeddingVector] = OrderedDict()
        self._pending: dict[str, asyncio.Future[_Embedded]] = {}
        self._inflight: dict[str, asyncio.Future[_Embedded]] = {}
        self._flush_scheduled = False
        self._batches = 0
        self._tasks: set[asyncio.Task[None]] = set()

    async def embed(self, texts: tuple[str, ...], /) -> EmbeddingResult:
        """Return one ordered vector per input text, sharing provider work."""

        if not texts:
            return EmbeddingResult(vectors=(), usage=InferenceUsage(requests=0))

        loop = asyncio.get_running_loop()
        vectors: dict[str, EmbeddingVector] = {}
        waiting: dict[str, asyncio.Future[_Embedded]] = {}
        for text in texts:
            if text in vectors or text in waiting:
                continue
            cached = self._cache.get(text)
            if cached is not None:
                self._cache.move_to_end(text)
                vectors[text] = cached
                continue
            future = self._inflight.get(text)
            if future is None:
                future = self._pending.get(text)
            if future is None:
                future = loop.create_future()
                self._pending[text] = future
            waiting[text] = future

        if not waiting:
            return EmbeddingResult(
                vectors=tuple(vectors[text] for text in texts),
                usage=InferenceUsage(requests=0),
            )

        self._schedule_flush()
        resolved = await asyncio.gather(*(asyncio.shield(future) for future in waiting.values()))
        for text, item in zip(waiting, resolved, strict=True):
            vectors[text] = item.vector
        return EmbeddingResult(
            vectors=tuple(vectors[text] for text in texts),
            usage=_merge_usage(resolved),
        )

    def _schedule_flush(self) -> None:
        if self._flush_scheduled:
            return
        self._flush_scheduled = True
        loop = asyncio.get_running_loop()
        if self._coalesce_seconds > 0:
            loop.call_later(self._coalesce_seconds, self._flush)
        else:
            loop.call_soon(self._flush)

    def _flush(self) -> None:
        self._flush_scheduled = False
        ready = [text for text, future in self._pending.items() if not future.done()]
        for start in range(0, len(ready), self._max_batch_size):
            chunk = tuple(ready[start : start + self._max_batch_size])
            batch = self._batches
            self._batches += 1
            for text in chunk:
                self._inflight[text] = self._pending.pop(text)
            task = asyncio.ensure_future(self._run_batch(batch, chunk))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _run_batch(self, batch: int, texts: tuple[str, ...]) -> None:
        try:
            result = await self._model.embed(texts)
        except asyncio.CancelledError:
            self._fail(texts, asyncio.CancelledError())
            raise
        except BaseException as error:  # noqa: BLE001 - provider failures reach every waiter unchanged
            self._fail(texts, error)
            return

        vectors = result.vectors
        if len(vectors) != len(texts):
            self._fail(texts, ValueError("embedding model returned an unexpected number of vectors"))
            return
        for text, vector in zip(texts, vectors, strict=True):
            resolved = tuple(float(value) for value in vector)
            self._remember(text, resolved)
            future = self._inflight.pop(text, None)
            if future is not None and not future.done():
                future.set_result(_Embedded(vector=resolved, batch=batch, usage=result.usage))

    def _fail(self, texts: tuple[str, ...], error: BaseException) -> None:
        for text in texts:
            future = self._inflight.pop(text, None)
            if future is not None and not future.done():
                future.set_exception(error)
                future.add_done_callback(_consume_exception)

    def _remember(self, text: str, vector: EmbeddingVector) -> None:
        if self._cache_size <= 0:
            return
        self._cache[text] = vector
        self._cache.move_to_end(text)
        while len(self._cache) > self._cache_size:
            self._cache.popitem(last=False)


def _consume_exception(future: asyncio.Future[object]) -> None:
    if not future.cancelled():
        future.exception()


def _merge_usage(items: Iterable[_Embedded]) -> InferenceUsage:
    """Count each contributing provider request once and sum its token usage."""

    by_batch: dict[int, InferenceUsage] = {}
    for item in items:
        by_batch.setdefault(item.batch, item.usage)
    usages: Sequence[InferenceUsage] = tuple(by_batch.values())
    return InferenceUsage(
        requests=len(usages),
        input_tokens=_sum_optional(usage.input_tokens for usage in usages),
        output_tokens=_sum_optional(usage.output_tokens for usage in usages),
    )


def _sum_optional(values: Iterable[int | None]) -> int | None:
    present = [value for value in values if value is not None]
    if not present:
        return None
    return sum(present)
