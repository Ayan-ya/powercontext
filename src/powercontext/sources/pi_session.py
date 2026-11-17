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

"""Parse a Pi session branch and import its visible events as captured Sources."""

from __future__ import annotations

import asyncio
import json
from hashlib import sha256
from math import isfinite
from pathlib import Path
from typing import NamedTuple

from pydantic import BaseModel, JsonValue

from powercontext.sources.connectors import (
    ConnectorRunCompletion,
    ConnectorRunSession,
    ConnectorRunStatus,
    ConnectorSubmissionStatus,
)
from powercontext.sources.definitions import AdapterSourceDefinition
from powercontext.sources.models import Source, SourceMaterialization
from powercontext.sources.projections import TEXT_EVIDENCE_PROJECTION_KEY, TextEvidence

_SOURCE_NAME = "pi-event"


class PiSessionInput(BaseModel):
    """A UTF-8 Pi v3 archive and an optional selected branch tip."""

    content: bytes
    leaf_id: str | None = None


class PiEventInput(BaseModel):
    """One visible event with its complete original JSON record."""

    session_id: str
    event_id: str
    parent_id: str | None
    event_type: str
    role: str
    content: str
    record: dict[str, JsonValue]


class _Session(NamedTuple):
    session_id: str
    records: dict[str, dict[str, JsonValue]]
    path: tuple[str, ...]


def parse_pi_session(value: PiSessionInput) -> tuple[PiEventInput, ...]:
    """Validate the archive and return visible events along the selected root-to-leaf path."""

    return _visible_events(_read_session(value))


def _read_session(value: PiSessionInput) -> _Session:
    lines = enumerate(value.content.decode("utf-8-sig").split("\n"), start=1)
    rows = ((number, _parse_record(line, number)) for number, line in lines if line.strip())
    _, header = next(rows, (0, {}))
    session_id = header.get("id")
    version = header.get("version")
    if (
        header.get("type") != "session"
        or type(version) is not int
        or version != 3
        or not isinstance(session_id, str)
        or not session_id
    ):
        raise ValueError("Expected a Pi v3 session header with a non-empty id")

    records: dict[str, dict[str, JsonValue]] = {}
    parents: dict[str, str | None] = {}
    for number, record in rows:
        event_id = record.get("id")
        if not isinstance(event_id, str) or not event_id or event_id in records:
            raise ValueError(f"Invalid or duplicate Pi event id on line {number}")
        event_type = record.get("type")
        if not isinstance(event_type, str) or not event_type or event_type == "session":
            raise ValueError(f"Invalid Pi event type on line {number}")
        parent = record.get("parentId")
        if "parentId" not in record or (parent is not None and (not isinstance(parent, str) or parent not in records)):
            raise ValueError(f"Pi event on line {number} must reference an earlier parent or null")
        records[event_id] = record
        parents[event_id] = parent

    leaf = value.leaf_id
    if leaf is not None and leaf not in records:
        raise ValueError(f"Pi leaf {leaf!r} does not exist")
    if leaf is None:
        leaf = next(reversed(records), None)
    path = []
    while leaf is not None:
        path.append(leaf)
        leaf = parents[leaf]
    return _Session(session_id, records, tuple(reversed(path)))


def _parse_record(line: str, number: int) -> dict[str, JsonValue]:
    def finite_number(value: str) -> float:
        number = float(value)
        if not isfinite(number):
            raise ValueError(f"Invalid JSON number {value}")
        return number

    try:
        record = json.loads(line, parse_constant=finite_number, parse_float=finite_number)
    except ValueError as error:
        raise ValueError(f"Invalid Pi JSON on line {number}") from error
    if not isinstance(record, dict):
        raise ValueError(f"Expected a Pi JSON object on line {number}")
    return record


def _compact_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _text_blocks(value: JsonValue, *, include_calls: bool = False) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""
    parts = []
    for block in value:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "text" and isinstance(text := block.get("text"), str):
            parts.append(text)
        elif kind == "toolCall" and include_calls:
            name, call_id = block.get("name"), block.get("id")
            if isinstance(name, str) and isinstance(call_id, str):
                arguments = _compact_json(block.get("arguments", {}))
                parts.append(f"[tool_call {name} {call_id}] {arguments}")
    return "\n".join(parts)


def _body(event_type: str, record: dict[str, JsonValue]) -> tuple[str, str] | None:
    if event_type in {"compaction", "branch_summary"}:
        summary = record.get("summary")
        return (event_type, summary) if isinstance(summary, str) else None
    if event_type == "custom_message":
        return "custom", _text_blocks(record.get("content"))
    if event_type != "message":
        return None

    message = record.get("message")
    if not isinstance(message, dict) or not isinstance(role := message.get("role"), str) or not role:
        return None
    if role == "bashExecution":
        command, output = message.get("command"), message.get("output")
        if isinstance(command, str) and isinstance(output, str):
            return role, f"$ {command}\n{output}"
        return None
    if role == "toolResult":
        text = _text_blocks(message.get("content"))
        name, call_id = message.get("toolName"), message.get("toolCallId")
        if text.strip() and isinstance(name, str) and isinstance(call_id, str):
            return role, f"[tool_result {name} {call_id}] {text}"
        return None
    return role, _text_blocks(message.get("content"), include_calls=True)


def _visible_events(session: _Session) -> tuple[PiEventInput, ...]:
    events = []
    for event_id in session.path:
        record = session.records[event_id]
        event_type = record["type"]
        parent_id = record["parentId"]
        assert isinstance(event_type, str)
        assert parent_id is None or isinstance(parent_id, str)
        visible = _body(event_type, record)
        if visible is None or not visible[1].strip():
            continue
        role, body = visible
        events.append(
            PiEventInput(
                session_id=session.session_id,
                event_id=event_id,
                parent_id=parent_id,
                event_type=event_type,
                role=role,
                content=f"{role}: {body}",
                record=record,
            )
        )
    return tuple(events)


def _source_id(session_id: str, event_id: str) -> str:
    identity = _compact_json((session_id, event_id)).encode("utf-8")
    return f"pi:{sha256(identity).hexdigest()}"


class _PiEventSource(Source):
    event: PiEventInput


class _PiEventAdapter:
    input_class = PiEventInput
    source_class = _PiEventSource
    name = _SOURCE_NAME

    async def resolve(self, value: PiEventInput, /) -> _PiEventSource:
        return _PiEventSource(
            name=_source_id(value.session_id, value.event_id),
            materialization=SourceMaterialization.CAPTURED,
            event=value,
        )

    async def read(self, source: _PiEventSource, /) -> PiEventInput:
        return source.event


class _PiTextEvidence:
    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = _PiEventSource
    output_class = TextEvidence

    def project(self, source: _PiEventSource, /) -> TextEvidence:
        event = source.event
        return TextEvidence(
            source_type=_SOURCE_NAME,
            source_id=source.name,
            content=event.content,
            metadata={
                "session_id": event.session_id,
                "event_id": event.event_id,
                "parent_id": event.parent_id,
                "event_type": event.event_type,
                "role": event.role,
            },
        )


PI_EVENT_SOURCE_DEFINITION = AdapterSourceDefinition(_PiEventAdapter(), projections=(_PiTextEvidence(),))


class PiSessionConnector:
    """Import new visible Pi events using a lifecycle-owned durable checkpoint."""

    name = "pi-session-history"
    version = "1"
    source_definitions = frozenset({_SOURCE_NAME})

    def __init__(self, path: str | Path, leaf_id: str | None = None) -> None:
        self.path = Path(path)
        self.leaf_id = leaf_id

    async def run(self, session: ConnectorRunSession, /) -> ConnectorRunCompletion:
        content = await asyncio.to_thread(self.path.read_bytes)
        archive = _read_session(PiSessionInput(content=content, leaf_id=self.leaf_id))
        events = _visible_events(archive)

        prior = session.checkpoint
        if prior is not None and (
            not isinstance(prior, dict) or not all(isinstance(digest, str) for digest in prior.values())
        ):
            raise ValueError("Invalid Pi session checkpoint")
        imported: dict[str, JsonValue] = {} if prior is None else dict(prior)
        # Check all previously imported records still in the file, even off the selected branch.
        selected = {event.event_id for event in events}
        digests = {}
        for event_id, record in archive.records.items():
            identity = _source_id(archive.session_id, event_id)
            if identity not in imported and event_id not in selected:
                continue
            digest = sha256(_compact_json(record).encode("utf-8")).hexdigest()
            if identity in imported and imported[identity] != digest:
                raise ValueError(f"Previously imported Pi event {event_id!r} changed")
            digests[event_id] = (identity, digest)

        for event in events:
            identity, digest = digests[event.event_id]
            if identity in imported:
                continue
            outcome = await session.submit(identity, _SOURCE_NAME, event)
            if outcome.status is not ConnectorSubmissionStatus.ACCEPTED:
                return ConnectorRunCompletion(status=ConnectorRunStatus.INCOMPLETE, checkpoint=prior)
            imported[identity] = digest

        return ConnectorRunCompletion(status=ConnectorRunStatus.COMPLETE, checkpoint=imported or prior)


__all__ = [
    "PI_EVENT_SOURCE_DEFINITION",
    "PiEventInput",
    "PiSessionConnector",
    "PiSessionInput",
    "parse_pi_session",
]
