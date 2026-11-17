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

"""Durable source availability and propagation to native Memory revisions."""

from __future__ import annotations

from collections import defaultdict
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator
from sqlalchemy import insert, select, update

from powercontext.artifacts import ArtifactRef, MemoryCitation
from powercontext.builtin.persistence.tables import SOURCE_LIFECYCLE_TABLE
from powercontext.builtin.sources import validate_scope_id
from powercontext.errors import PowerContextError
from powercontext.sources import SourceRef

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncConnection

    from powercontext.builtin.artifacts.memory import MemoryService
    from powercontext.builtin.runtime.relational import RelationalContexts

Policy = Literal["all", "any"]
Reference = SourceRef | MemoryCitation | ArtifactRef


class SourceLifecycleError(ValueError):
    """An invalid lifecycle reference, event or dependency."""


def _non_blank(value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SourceLifecycleError("Lifecycle identifiers and reasons must not be blank")
    return value


class SourceLifecycleEvent(BaseModel):
    """One ordered availability change for a registered Source."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    node_id: str
    revision: int = Field(gt=0)
    sequence: int = Field(gt=0)
    available: bool
    reason: str

    @field_validator("node_id", "reason")
    @classmethod
    def validate_text(cls, value: str) -> str:
        return _non_blank(value)


class _Node(BaseModel):
    reference: Reference
    parents: tuple[str, ...] = ()
    policy: Policy = "all"
    revision: int | None = None
    event: SourceLifecycleEvent | None = None
    available: bool = True


_GRAPH = TypeAdapter(dict[str, _Node])


async def _load(connection: AsyncConnection, scope_id: str) -> dict[str, _Node]:
    payload = await connection.scalar(
        select(SOURCE_LIFECYCLE_TABLE.c.payload).where(SOURCE_LIFECYCLE_TABLE.c.scope_id == scope_id)
    )
    return {} if payload is None else _GRAPH.validate_json(bytes(payload))


def _supported(nodes: dict[str, _Node], node: _Node) -> bool:
    states = (nodes[parent].available for parent in node.parents)
    return all(states) if node.policy == "all" else any(states)


async def unavailable_topics(connection: AsyncConnection, scope_id: str) -> frozenset[str]:
    nodes = await _load(connection, scope_id)
    inactive = set()
    active = set()
    for node in nodes.values():
        if isinstance(node.reference, ArtifactRef):
            (active if node.available else inactive).add(node.reference.artifact_id)
    return frozenset(inactive - active)


class SourceLifecycle:
    """Scope selector for the Runtime's lifecycle service."""

    def __init__(self, contexts: RelationalContexts) -> None:
        self._contexts = contexts

    def for_scope(self, scope_id: str) -> ScopedSourceLifecycle:
        return ScopedSourceLifecycle(self._contexts, validate_scope_id(scope_id))


class ScopedSourceLifecycle:
    def __init__(self, contexts: RelationalContexts, scope_id: str) -> None:
        self._contexts = contexts
        self._scope_id = scope_id

    async def register_source(self, node_id: str, source_ref: SourceRef, *, revision: int) -> None:
        if not isinstance(source_ref, SourceRef) or type(revision) is not int or revision <= 0:
            raise SourceLifecycleError("Expected a Source reference and positive revision")
        await self._register(node_id, _Node(reference=source_ref, revision=revision))

    async def register_memory(
        self, node_id: str, citation: MemoryCitation, *, parents: tuple[str, ...], policy: Policy
    ) -> None:
        if not isinstance(citation, MemoryCitation):
            raise SourceLifecycleError("Expected a Memory citation")
        await self._register(node_id, self._derived(citation, parents, policy))

    async def register_topic(
        self, node_id: str, artifact_ref: ArtifactRef, *, parents: tuple[str, ...], policy: Policy
    ) -> None:
        if not isinstance(artifact_ref, ArtifactRef) or artifact_ref.family != "topic-memory":
            raise SourceLifecycleError("Expected a Topic Memory reference")
        await self._register(node_id, self._derived(artifact_ref, parents, policy))

    @staticmethod
    def _derived(reference: Reference, parents: tuple[str, ...], policy: Policy) -> _Node:
        if not isinstance(parents, (tuple, list)) or not parents or policy not in ("all", "any"):
            raise SourceLifecycleError("Derived nodes require parents and an all/any policy")
        parent_ids = tuple(_non_blank(parent) for parent in parents)
        if len(set(parent_ids)) != len(parent_ids):
            raise SourceLifecycleError("Lifecycle parents must be distinct")
        return _Node(reference=reference, parents=tuple(sorted(parent_ids)), policy=policy)

    async def _register(self, node_id: str, node: _Node) -> None:
        _non_blank(node_id)
        async with self._contexts.database.transaction() as connection:
            nodes = await _load(connection, self._scope_id)
            existing = nodes.get(node_id)
            if existing is not None:
                if existing.model_copy(update={"available": True, "event": None}) != node:
                    raise SourceLifecycleError(f"Conflicting registration for {node_id!r}")
                return
            if any(parent not in nodes for parent in node.parents):
                raise SourceLifecycleError("Register all parents before their descendants")
            await self._validate_reference(connection, node.reference)
            initialized = node.model_copy(update={"available": _supported(nodes, node)})
            await self._publish(connection, nodes, {**nodes, node_id: initialized}, (initialized,))

    async def _validate_reference(self, connection: AsyncConnection, reference: Reference) -> None:
        repositories = self._contexts.repositories
        try:
            if isinstance(reference, SourceRef):
                await repositories.sources.get(connection, self._scope_id, reference)
            elif isinstance(reference, MemoryCitation):
                await self._memory(connection).validate_citation(reference)
            else:
                await repositories.topic_memories.get_exact(connection, self._scope_id, reference)
        except (PowerContextError, LookupError) as error:
            raise SourceLifecycleError("Lifecycle reference is not readable in this scope") from error

    def _memory(self, connection: AsyncConnection) -> MemoryService:
        services = self._contexts._services_for(self._scope_id)
        _, catalog = services.sources(connection)
        return services.memory(catalog, connection)

    async def apply(self, event: SourceLifecycleEvent) -> list[str]:
        if not isinstance(event, SourceLifecycleEvent):
            raise SourceLifecycleError("Expected a SourceLifecycleEvent")
        async with self._contexts.database.transaction() as connection:
            nodes = await _load(connection, self._scope_id)
            root = nodes.get(event.node_id)
            if root is None or root.revision != event.revision:
                raise SourceLifecycleError("Unknown Source or incompatible lifecycle revision")
            previous = root.event
            if previous is not None and event.sequence <= previous.sequence:
                if event != previous:
                    raise SourceLifecycleError("Stale or conflicting lifecycle event")
                return sorted(key for key, node in nodes.items() if node.available)
            updated = dict(nodes)
            updated[event.node_id] = root.model_copy(update={"event": event, "available": event.available})
            changed = []
            # Registration order is topological because every parent must already exist.
            for key, node in nodes.items():
                if node.parents:
                    available = _supported(updated, node)
                    if available != node.available:
                        updated[key] = node.model_copy(update={"available": available})
                        changed.append(updated[key])
            await self._publish(connection, nodes, updated, changed)
            return sorted(key for key, node in updated.items() if node.available)

    async def _publish(
        self,
        connection: AsyncConnection,
        previous: dict[str, _Node],
        updated: dict[str, _Node],
        changed: tuple[_Node, ...] | list[_Node],
    ) -> None:
        affected = {
            (node.reference.memory_ref.artifact_id, node.reference.entry_id)
            for node in changed
            if isinstance(node.reference, MemoryCitation)
        }
        targets: dict[str, dict[str, bool]] = defaultdict(dict)
        for node in updated.values():
            ref = node.reference
            if isinstance(ref, MemoryCitation):
                artifact_id, entry_id = ref.memory_ref.artifact_id, ref.entry_id
                if (artifact_id, entry_id) in affected:
                    targets[artifact_id][entry_id] = targets[artifact_id].get(entry_id, False) or node.available
        if targets:
            memory = self._memory(connection)
            for artifact_id, entries in targets.items():
                head = await memory.head(artifact_id)
                current = await memory.entries(head)
                deactivate = tuple(entry for entry in current if entries.get(entry.entry_id) is False)
                reactivate = tuple(entry for entry in current if entries.get(entry.entry_id) is True)
                if deactivate:
                    head = await memory.forget(head, entries=deactivate, reason="Source lifecycle")
                if reactivate:
                    await memory.reactivate(head, entries=reactivate, reason="Source lifecycle")

        # Publish the graph in the same transaction as all native Memory changes.
        table = SOURCE_LIFECYCLE_TABLE
        payload = _GRAPH.dump_json(updated)
        if previous:
            await connection.execute(update(table).where(table.c.scope_id == self._scope_id).values(payload=payload))
        else:
            await connection.execute(insert(table).values(scope_id=self._scope_id, payload=payload))

    async def resolve(self, node_id: str, *, purpose: Literal["generation", "audit"]) -> Reference:
        _non_blank(node_id)
        if purpose not in ("generation", "audit"):
            raise SourceLifecycleError("Unknown lifecycle resolution purpose")
        async with self._contexts.database.transaction() as connection:
            node = (await _load(connection, self._scope_id)).get(node_id)
        if node is None or (purpose == "generation" and not node.available):
            raise SourceLifecycleError(f"Unavailable lifecycle node {node_id!r}")
        return node.reference
