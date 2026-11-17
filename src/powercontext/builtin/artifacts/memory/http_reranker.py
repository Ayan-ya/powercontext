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

"""Score Memory candidates through one batched HTTP cross-encoder endpoint."""

from __future__ import annotations

import math
from typing import Any

import httpx

from powercontext.builtin.artifacts.memory.models import MemoryHit
from powercontext.builtin.artifacts.memory.reranking import MemoryRerankDecision
from powercontext.builtin.inference import InferenceUsage

DEFAULT_POLICY_ID = "http-cross-encoder-v1"
DEFAULT_BATCH_SIZE = 32


class HTTPMemoryReranker:
    """Rank candidates with an external scoring service while preserving identity.

    Candidate ranks are always the position in the caller's full candidate list,
    so a batched request never renumbers candidates and every batch is scored in
    one global selection.
    """

    def __init__(
        self,
        endpoint: str,
        *,
        client: httpx.AsyncClient,
        batch_size: int = DEFAULT_BATCH_SIZE,
        policy_id: str = DEFAULT_POLICY_ID,
    ) -> None:
        if batch_size < 1:
            raise ValueError("batch_size must be a positive integer")
        self._endpoint = endpoint
        self._client = client
        self._batch_size = batch_size
        self.policy_id = policy_id

    async def rerank(
        self,
        query: str,
        candidates: tuple[MemoryHit, ...],
        limit: int,
        /,
    ) -> MemoryRerankDecision:
        """Score every candidate in bounded batches, then select one global order."""

        _validate_bounds(len(candidates), limit)
        scores: dict[int, float] = {}
        requests = 0
        for start in range(0, len(candidates), self._batch_size):
            batch = candidates[start : start + self._batch_size]
            ranks = tuple(range(start + 1, start + 1 + len(batch)))
            response = await self._client.post(
                self._endpoint,
                json={
                    "query": query,
                    "candidates": [
                        {"rank": rank, "text": candidate.text}
                        for rank, candidate in zip(ranks, batch, strict=True)
                    ],
                },
            )
            response.raise_for_status()
            scores.update(_parse_scores(response, expected=frozenset(ranks)))
            requests += 1

        ordered = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
        return MemoryRerankDecision(
            selected_ranks=tuple(rank for rank, _ in ordered[:limit]),
            usage=InferenceUsage(requests=requests),
        )


def _parse_scores(response: httpx.Response, *, expected: frozenset[int]) -> dict[int, float]:
    try:
        payload: Any = response.json()
    except ValueError as error:
        raise ValueError("reranker response is not valid JSON") from error
    if not isinstance(payload, dict) or set(payload) != {"scores"}:
        raise ValueError("reranker response must contain exactly one scores field")
    entries = payload["scores"]
    if not isinstance(entries, list):
        raise ValueError("reranker scores must be a list")

    scores: dict[int, float] = {}
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"rank", "score"}:
            raise ValueError("each reranker score must contain exactly rank and score")
        rank = entry["rank"]
        if type(rank) is not int:
            raise ValueError("reranker ranks must be integers")
        if rank not in expected:
            raise ValueError(f"reranker returned a rank outside the requested batch: {rank}")
        if rank in scores:
            raise ValueError(f"reranker returned a duplicate rank: {rank}")
        scores[rank] = _finite_score(entry["score"])
    if set(scores) != expected:
        raise ValueError("reranker did not score every requested candidate")
    return scores


def _finite_score(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("reranker scores must be numbers")
    score = float(value)
    if math.isnan(score) or math.isinf(score):
        raise ValueError("reranker scores must be finite")
    return score


def _validate_bounds(candidate_count: int, limit: int) -> None:
    if candidate_count < 1:
        raise ValueError("rerank requires at least one candidate")
    if limit < 1 or limit > candidate_count:
        raise ValueError("rerank limit must be between one and the candidate count")


__all__ = ["DEFAULT_POLICY_ID", "HTTPMemoryReranker"]
