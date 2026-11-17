import type {
  CollectionSummary,
  DocumentChunk,
  SearchResponse,
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  const payload = (await response.json().catch(() => null)) as
    | { error?: string }
    | T
    | null;

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? payload.error
        : null;
    throw new Error(message || `Request failed with status ${response.status}`);
  }

  return payload as T;
}

export const api = {
  health: () =>
    request<{ status: "ok"; engine: string; mode: string }>("/health"),

  listCollections: () => request<{ collections: CollectionSummary[] }>("/collections"),

  createCollection: (name: string) =>
    request<{ collection: CollectionSummary }>("/collections", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  deleteCollection: (name: string) =>
    request<{ deleted: string }>(`/collections/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),

  importChunks: (
    collection: string,
    chunks: DocumentChunk[],
    embeddings: number[][],
  ) =>
    request<{
      imported: number;
      total: number;
      metrics: { databaseWriteMs: number; indexRefreshMs: number };
    }>(`/collections/${encodeURIComponent(collection)}/documents`, {
      method: "POST",
      body: JSON.stringify({
        ids: chunks.map((chunk) => chunk.id),
        documents: chunks.map((chunk) => chunk.text),
        metadatas: chunks.map((chunk) => chunk.metadata),
        embeddings,
      }),
    }),

  search: (
    collection: string,
    query: string,
    queryEmbedding: number[],
    limit: number,
  ) =>
    request<SearchResponse>(`/collections/${encodeURIComponent(collection)}/search`, {
      method: "POST",
      body: JSON.stringify({ query, queryEmbedding, limit }),
    }),
};
