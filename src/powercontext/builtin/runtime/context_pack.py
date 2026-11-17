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

"""Content-addressed context packs with prefix-reuse deltas.

The wire format is the interoperability contract: canonical UTF-8 JSON, Base64
chunks, a SHA-256 digest over the unsigned pack, and a byte count that accounts
for the serialized form including itself.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any

PACK_SCHEMA = "powercontext.context-pack.v1"
DELTA_SCHEMA = "powercontext.context-pack-delta.v1"

_PACK_FIELDS = frozenset({"schema", "items", "digest", "byte_count"})
_DELTA_FIELDS = frozenset({"schema", "base_digest", "target_digest", "prefix_items", "appended"})
_DIGEST_PATTERN = re.compile(r"sha256:[0-9a-f]{64}\Z")


class ContextPackError(ValueError):
    """Raised when a pack, delta, or chunking request violates the contract."""


@dataclass(frozen=True, slots=True)
class ContextPack:
    """One complete, self-verifying context snapshot."""

    items: tuple[bytes, ...]
    digest: str
    byte_count: int

    @classmethod
    def build(cls, items: tuple[bytes, ...] = ()) -> ContextPack:
        """Build a pack from already chunked content."""

        chunks = _require_chunks(items)
        digest = _digest_for(chunks)
        byte_count = 0
        while True:
            encoded = _serialize_pack(chunks, digest, byte_count)
            if len(encoded) == byte_count:
                return cls(items=chunks, digest=digest, byte_count=byte_count)
            byte_count = len(encoded)

    @classmethod
    def from_content(cls, content: str, *, chunk_bytes: int = 512) -> ContextPack:
        """Chunk ``content`` deterministically, keeping every chunk valid UTF-8."""

        return cls.build(_chunk_content(content, chunk_bytes))

    @classmethod
    def from_bytes(cls, data: bytes) -> ContextPack:
        """Decode and verify one serialized pack."""

        document = _load_document(data, _PACK_FIELDS)
        if document["schema"] != PACK_SCHEMA:
            raise ContextPackError(f"unsupported pack schema {document['schema']!r}")
        chunks = _decode_chunks(document["items"], field="items")
        digest = _require_digest(document["digest"], field="digest")
        if digest != _digest_for(chunks):
            raise ContextPackError("pack digest does not match its items")
        byte_count = document["byte_count"]
        if type(byte_count) is not int or byte_count != len(data):
            raise ContextPackError("pack byte_count does not match the serialized length")
        return cls(items=chunks, digest=digest, byte_count=byte_count)

    def to_bytes(self) -> bytes:
        """Serialize this pack into its canonical wire form."""

        return _serialize_pack(self.items, self.digest, self.byte_count)


@dataclass(frozen=True, slots=True)
class ContextPackDelta:
    """The suffix needed to rebuild a target pack from a known base."""

    base_digest: str
    target_digest: str
    prefix_items: int
    appended: tuple[bytes, ...]

    @property
    def byte_count(self) -> int:
        """Wire size of this delta, including every protocol field."""

        return len(self.to_bytes())

    @classmethod
    def between(cls, base: ContextPack, target: ContextPack) -> ContextPackDelta:
        """Reuse the longest shared chunk prefix and append the target suffix."""

        prefix = 0
        for left, right in zip(base.items, target.items, strict=False):
            if left != right:
                break
            prefix += 1
        return cls(
            base_digest=base.digest,
            target_digest=target.digest,
            prefix_items=prefix,
            appended=target.items[prefix:],
        )

    @classmethod
    def from_bytes(cls, data: bytes) -> ContextPackDelta:
        """Decode and verify one serialized delta."""

        document = _load_document(data, _DELTA_FIELDS)
        if document["schema"] != DELTA_SCHEMA:
            raise ContextPackError(f"unsupported delta schema {document['schema']!r}")
        prefix = document["prefix_items"]
        if type(prefix) is not int or prefix < 0:
            raise ContextPackError("delta prefix_items must be a non-negative integer")
        return cls(
            base_digest=_require_digest(document["base_digest"], field="base_digest"),
            target_digest=_require_digest(document["target_digest"], field="target_digest"),
            prefix_items=prefix,
            appended=_decode_chunks(document["appended"], field="appended"),
        )

    def to_bytes(self) -> bytes:
        """Serialize this delta into its canonical wire form."""

        return _canonical_json(
            {
                "schema": DELTA_SCHEMA,
                "base_digest": self.base_digest,
                "target_digest": self.target_digest,
                "prefix_items": self.prefix_items,
                "appended": _encode_chunks(self.appended),
            }
        )


def apply_context_pack_delta(base: ContextPack, delta: ContextPackDelta, /) -> ContextPack:
    """Rebuild the target pack described by ``delta`` against ``base``."""

    if not isinstance(base, ContextPack) or not isinstance(delta, ContextPackDelta):
        raise ContextPackError("delta application requires a pack and a delta")
    if delta.base_digest != base.digest:
        raise ContextPackError("delta base digest does not match the supplied pack")
    if delta.prefix_items > len(base.items):
        raise ContextPackError("delta prefix_items exceeds the base chunk count")
    target = ContextPack.build(base.items[: delta.prefix_items] + delta.appended)
    if target.digest != delta.target_digest:
        raise ContextPackError("delta target digest does not match the rebuilt pack")
    return target


def _chunk_content(content: str, chunk_bytes: int) -> tuple[bytes, ...]:
    """Group whole lines into bounded chunks so later edits keep earlier chunks stable."""

    if type(chunk_bytes) is not int or chunk_bytes <= 0:
        raise ContextPackError("chunk_bytes must be a positive integer")
    if not content:
        return ()

    chunks: list[bytes] = []
    current = bytearray()
    for line in content.splitlines(keepends=True):
        encoded = line.encode("utf-8")
        if len(encoded) <= chunk_bytes:
            if len(current) + len(encoded) > chunk_bytes:
                chunks.append(bytes(current))
                current = bytearray()
            current += encoded
            continue
        if current:
            chunks.append(bytes(current))
            current = bytearray()
        for character in line:
            piece = character.encode("utf-8")
            if len(piece) > chunk_bytes:
                raise ContextPackError("a single character exceeds chunk_bytes")
            if len(current) + len(piece) > chunk_bytes:
                chunks.append(bytes(current))
                current = bytearray()
            current += piece
    if current:
        chunks.append(bytes(current))
    return tuple(chunks)


def _require_chunks(items: object) -> tuple[bytes, ...]:
    if not isinstance(items, (tuple, list)):
        raise ContextPackError("pack items must be a sequence of byte chunks")
    chunks: list[bytes] = []
    for item in items:
        if not isinstance(item, (bytes, bytearray)):
            raise ContextPackError("pack items must contain bytes")
        chunks.append(bytes(item))
    return tuple(chunks)


def _encode_chunks(chunks: tuple[bytes, ...]) -> list[str]:
    return [base64.b64encode(chunk).decode("ascii") for chunk in chunks]


def _decode_chunks(value: object, *, field: str) -> tuple[bytes, ...]:
    if not isinstance(value, list):
        raise ContextPackError(f"{field} must be a Base64 string array")
    chunks: list[bytes] = []
    for entry in value:
        if not isinstance(entry, str):
            raise ContextPackError(f"{field} must be a Base64 string array")
        try:
            chunks.append(base64.b64decode(entry.encode("ascii"), validate=True))
        except (UnicodeEncodeError, binascii.Error, ValueError) as error:
            raise ContextPackError(f"{field} contains invalid Base64") from error
    return tuple(chunks)


def _require_digest(value: object, *, field: str) -> str:
    if not isinstance(value, str) or _DIGEST_PATTERN.match(value) is None:
        raise ContextPackError(f"{field} must be a sha256 digest")
    return value


def _digest_for(chunks: tuple[bytes, ...]) -> str:
    unsigned = _canonical_json({"schema": PACK_SCHEMA, "items": _encode_chunks(chunks)})
    return "sha256:" + hashlib.sha256(unsigned).hexdigest()


def _serialize_pack(chunks: tuple[bytes, ...], digest: str, byte_count: int) -> bytes:
    return _canonical_json(
        {
            "schema": PACK_SCHEMA,
            "items": _encode_chunks(chunks),
            "digest": digest,
            "byte_count": byte_count,
        }
    )


def _canonical_json(document: dict[str, Any]) -> bytes:
    return json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _load_document(data: bytes, fields: frozenset[str]) -> dict[str, Any]:
    try:
        document = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ContextPackError("payload is not valid UTF-8 JSON") from error
    if not isinstance(document, dict):
        raise ContextPackError("payload must be a JSON object")
    if set(document) != fields:
        missing = sorted(fields - set(document))
        extra = sorted(set(document) - fields)
        raise ContextPackError(f"payload fields mismatch (missing={missing}, extra={extra})")
    return document
