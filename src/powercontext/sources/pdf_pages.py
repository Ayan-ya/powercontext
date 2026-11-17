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

"""Physical PDF pages as captured Sources and scoped, offline evidence retrieval."""

from __future__ import annotations

import io
import math
import re
from collections import Counter
from hashlib import sha256
from typing import TYPE_CHECKING

from pydantic import BaseModel, Field

from powercontext.sources.definitions import AdapterSourceDefinition
from powercontext.sources.models import Source, SourceMaterialization
from powercontext.sources.projections import TEXT_EVIDENCE_PROJECTION_KEY, TextEvidence

if TYPE_CHECKING:
    from powercontext.artifacts import MemoryCitation
    from powercontext.builtin.runtime.application import ScopedMemoryApplication

_SOURCE_NAME = "pdf-page"
_WORD = re.compile(r"[a-z]+|\d+")
_YEAR = re.compile(r"(?<!\d)(?:19|20)\d{2}(?!\d)")
_STOP_WORDS = frozenset(
    "a about according across all also an analyst and any are as at be been being by calculate can "
    "could data define detail directly do does during each else for from give had has have how i if "
    "in into is it its less made may much of on only or other out over per please primarily "
    "quantity question reliance rely report reported reporting respond response said shown so state "
    "such than that the their them then there these they this those to under up use used using "
    "was we were what when where which who will with would year".split()
)
# These phrases describe accounting concepts and standard statement headings.
_CONCEPTS = (
    ("operating income", "operating profit", "income from operations", "profit from operations", "operating earnings"),
    ("capital expenditures", "capital expenditure", "capital spending", "capex", "purchases of property"),
    ("cash flows", "cash flow", "statement of cash flows", "cash from operating activities"),
    ("income statement", "income statements", "statement of income", "statements of income", "statement of operations",
     "statements of operations", "statement of earnings", "statements of earnings", "results of operations", "p l"),
    ("balance sheet", "balance sheets", "financial position", "total assets", "total liabilities"),
    ("depreciation and amortization", "depreciation amortization", "d a"),
    ("revenue", "revenues", "net sales", "total sales", "net revenue"),
    ("cost of sales", "cost of revenue", "cost of goods sold", "cogs"),
    ("gross profit", "gross margin"),
    ("legal proceedings", "legal matters", "legal battles", "litigation", "lawsuits", "contingencies"),
    (
        "geographies", "geography", "geographic", "geographical", "segments", "business segments",
        "reportable segments", "principal markets", "major markets", "key markets", "geographic markets",
        "countries in which", "international operations", "sales by country", "long lived assets by country",
    ),
    ("restructuring", "restructuring charges", "restructuring costs", "restructuring expenses"),
    ("free cash flow", "fcf", "operating cash flow"),
    ("research and development", "research development", "r d"),
    ("dividends", "cash dividends", "dividends paid"),
    ("share repurchases", "stock repurchases", "repurchases of common stock", "buybacks"),
    ("ebitda", "ebit", "adjusted ebitda", "unadjusted ebitda", "operating income before depreciation"),
    ("net income", "net earnings", "net loss", "net income attributable"),
    ("total debt", "long term debt", "short term debt", "borrowings", "debt outstanding"),
    ("shareholders equity", "stockholders equity", "total equity", "total shareholders equity"),
    ("interest expense", "interest income", "interest and other"),
    ("effective tax rate", "income tax expense", "provision for income taxes", "income taxes"),
    ("inventories", "inventory"),
    ("accounts receivable", "receivables", "allowance for doubtful accounts"),
    ("goodwill", "intangible assets", "intangible"),
    ("stock based compensation", "share based compensation", "share based payments"),
    ("pension", "retirement benefits", "postretirement"),
    ("operating expenses", "selling general and administrative", "general and administrative"),
)
_QUERY_CONTEXT = re.compile(
    r"\b(?:answer in|respond to the question|give a response|state 0|express your answer)\b", re.IGNORECASE
)


class PDFDocumentInput(BaseModel):
    """The entire original PDF and its caller-assigned document identity."""

    document_id: str
    content: bytes


class PDFPageInput(BaseModel):
    """One physical page of a specific PDF revision."""

    document_id: str
    document_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    page_number: int = Field(strict=True, gt=0)
    text: str


def _validate_document_id(document_id: str) -> None:
    if not document_id.strip():
        raise ValueError("document_id must not be blank")  # noqa: TRY003


def parse_pdf_document(value: PDFDocumentInput) -> tuple[PDFPageInput, ...]:
    """Read every physical page, preserving blank pages and page boundaries."""

    from pypdf import PdfReader

    _validate_document_id(value.document_id)
    digest = sha256(value.content).hexdigest()
    try:
        with io.BytesIO(value.content) as stream:
            reader = PdfReader(stream, strict=True)
            if reader.is_encrypted and not reader.decrypt(""):
                raise ValueError("PDF requires a password")  # noqa: TRY003
            return tuple(
                PDFPageInput(
                    document_id=value.document_id,
                    document_sha256=digest,
                    page_number=number,
                    text=page.extract_text(),
                )
                for number, page in enumerate(reader.pages, start=1)
            )
    except Exception as error:
        raise ValueError("PDF could not be parsed completely") from error  # noqa: TRY003


class _PDFPageSource(Source):
    page: PDFPageInput


class _PDFPageAdapter:
    input_class = PDFPageInput
    source_class = _PDFPageSource
    name = _SOURCE_NAME

    async def resolve(self, value: PDFPageInput, /) -> _PDFPageSource:
        _validate_document_id(value.document_id)
        # Fixed-width digest and explicit separation keep even long document IDs addressable.
        identity = "\0".join((value.document_sha256, str(value.page_number), value.document_id))
        return _PDFPageSource(
            name=f"pdf:{sha256(identity.encode('utf-8')).hexdigest()}",
            materialization=SourceMaterialization.CAPTURED,
            page=value.model_copy(),
        )

    async def read(self, source: _PDFPageSource, /) -> PDFPageInput:
        return source.page.model_copy()


class _PDFPageProjection:
    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = _PDFPageSource
    output_class = TextEvidence

    def project(self, source: _PDFPageSource, /) -> TextEvidence:
        page = source.page
        return TextEvidence(
            source_type=_SOURCE_NAME,
            source_id=source.name,
            content=f"{page.document_id}\n{page.text}",
            metadata={
                "document_id": page.document_id,
                "document_sha256": page.document_sha256,
                "page_number": page.page_number,
            },
        )


PDF_PAGE_SOURCE_DEFINITION = AdapterSourceDefinition(_PDFPageAdapter(), projections=(_PDFPageProjection(),))


def _tokens(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def _normalized(tokens: list[str]) -> str:
    return " " + " ".join(tokens) + " "


async def search_pdf_pages(
    memory: ScopedMemoryApplication, question: str, limit: int = 10
) -> tuple[MemoryCitation, ...]:
    """Rank active PDF pages from the scoped Memory API and return exact citations."""

    if limit <= 0 or not question.strip():
        return ()
    # Rank the bounded current Memory head so an index's lexical cutoff does
    # not discard pages whose terminology differs from the question.
    head = await memory.list()
    candidates = []
    for record in head.entries:
        sources = tuple(source for source in record.entry.sources if source.source_type == _SOURCE_NAME)
        if len(sources) == 1:
            document, _, body = record.entry.text.partition("\n")
            if body.strip():
                candidates.append((record.citation, sources[0].source_id, document, body))
    if not candidates:
        return ()

    lead = _QUERY_CONTEXT.split(question, maxsplit=1)[0]
    query_tokens = _tokens(lead)
    normalized_question = _normalized(_tokens(question))
    main_question = _normalized(query_tokens)
    years = set(_YEAR.findall(question))
    compact_question = "".join(_tokens(question))
    named_documents = {}
    for document in dict.fromkeys(document for _, _, document, _ in candidates):
        name = _tokens(_YEAR.split(document, maxsplit=1)[0])
        compact = "".join(name)
        if compact and compact in compact_question:
            named_documents[document] = name
    if named_documents:
        # A question that names its company must not retrieve another company's pages.
        scoped = [candidate for candidate in candidates if candidate[2] in named_documents]
        if scoped:
            candidates = scoped
    company_terms = {term for name in named_documents.values() for term in (*name, "".join(name))}
    terms = set(query_tokens) - _STOP_WORDS - years - company_terms
    terms = {term for term in terms if len(term) > 1 and not term.isdecimal()}
    concepts = []
    for phrases in _CONCEPTS:
        aliases = tuple(f" {phrase} " for phrase in phrases)
        if any(alias in normalized_question for alias in aliases):
            weight = 1.0 if any(alias in main_question for alias in aliases) else 0.7
            concepts.append((aliases, weight))

    pages = []
    frequencies: Counter[str] = Counter()
    for citation, source, document, body in candidates:
        tokens = _tokens(body)
        counts = Counter(term for term in tokens if term in terms)
        frequencies.update(counts.keys())
        pages.append((citation, source, document, tokens, counts))
    average_length = sum(len(tokens) for _, _, _, tokens, _ in pages) / len(pages) or 1
    weights = {
        term: math.log1p((len(pages) - count + 0.5) / (count + 0.5))
        for term, count in frequencies.items()
    }
    ranked = []
    for index, (citation, source, document, tokens, counts) in enumerate(pages):
        norm = 1.2 * (0.45 + 0.55 * len(tokens) / average_length)
        lexical = sum(weights[term] * count * 2.2 / (count + norm) for term, count in counts.items())
        text, heading = _normalized(tokens), _normalized(tokens[:90])
        matched = [
            number
            for number, (aliases, _weight) in enumerate(concepts)
            if any(phrase in text for phrase in aliases)
        ]
        phrases = sum(
            weight * (2.25 + 1.5 * any(phrase in heading for phrase in concepts[number][0]))
            for number in matched
            for aliases, weight in (concepts[number],)
        )
        score = (lexical + phrases) * (1.6 if document in named_documents else 1.0)
        if " table of contents " in heading:
            # A table of contents lists every statement heading but carries no evidence.
            score *= 0.3
        if score > 0:
            score += 0.15 * len(years.intersection(tokens))
            ranked.append((score, index, citation, source, tuple(matched)))

    ranked.sort(key=lambda item: -item[0])

    # Second ranking signal: plain BM25 over the query plus the matched accounting
    # concept vocabulary. Fusing both keeps the tuned ranking's precision while
    # recovering pages whose wording only matches after expansion.
    expanded_terms = set(terms)
    for aliases, _weight in concepts:
        for alias in aliases:
            expanded_terms.update(_tokens(alias))
    expanded_counts = [Counter(term for term in tokens if term in expanded_terms) for *_page, tokens, _counts in pages]
    expanded_df: Counter[str] = Counter()
    for counts in expanded_counts:
        expanded_df.update(counts.keys())
    expanded_weights = {
        term: math.log1p((len(pages) - count + 0.5) / (count + 0.5)) for term, count in expanded_df.items()
    }
    plain_scores = []
    for index, page in enumerate(pages):
        norm = 1.2 * (0.45 + 0.55 * len(page[-2]) / average_length)
        plain = sum(
            expanded_weights[term] * count * 2.2 / (count + norm) for term, count in expanded_counts[index].items()
        )
        plain_scores.append((plain, index))
    plain_scores.sort(key=lambda item: -item[0])
    plain_rank = {index: rank for rank, (_plain, index) in enumerate(plain_scores, start=1)}

    heading_scores = []
    numeric_scores = []
    for index, page in enumerate(pages):
        tokens = page[-2]
        heading = Counter(term for term in tokens[:80] if term in expanded_terms)
        heading_scores.append((sum(expanded_weights[term] * count for term, count in heading.items()), index))
        density = sum(1 for term in tokens if term.isdigit()) / max(1, len(tokens))
        numeric_scores.append((density, index))
    heading_scores.sort(key=lambda item: -item[0])
    numeric_scores.sort(key=lambda item: -item[0])
    heading_rank = {index: rank for rank, (_heading, index) in enumerate(heading_scores, start=1)}
    numeric_rank = {index: rank for rank, (_density, index) in enumerate(numeric_scores, start=1)}

    tuned_rank = {index: rank for rank, (_score, index, *_rest) in enumerate(ranked, start=1)}
    missing = len(pages) + 1000
    fused = {
        index: (
            1.0 / (60 + tuned_rank.get(index, missing))
            + 1.0 / (60 + plain_rank.get(index, missing))
            + 0.5 / (60 + heading_rank.get(index, missing))
            + 0.5 / (60 + numeric_rank.get(index, missing))
        )
        for index in range(len(pages))
    }
    order = sorted(fused, key=lambda index: -fused[index])

    results = []
    seen_source: set[str] = set()
    by_index = {index: (page[0], page[1]) for index, page in enumerate(pages)}
    for index in order:
        citation, source = by_index[index]
        if source in seen_source:
            continue
        seen_source.add(source)
        results.append(citation)
        if len(results) == limit:
            break
    return tuple(results)


__all__ = [
    "PDF_PAGE_SOURCE_DEFINITION",
    "PDFDocumentInput",
    "PDFPageInput",
    "parse_pdf_document",
    "search_pdf_pages",
]
