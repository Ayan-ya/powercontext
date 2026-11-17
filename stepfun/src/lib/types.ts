export type InferenceBackend = "webgpu" | "wasm";
export type ModelState = "idle" | "loading" | "ready" | "error";

export interface CollectionSummary {
  name: string;
  count: number;
  dimension: number;
  distance: string;
}

export interface DocumentChunk {
  id: string;
  text: string;
  metadata: {
    source: string;
    chunkIndex: number;
    charCount: number;
    importedAt: string;
    sessionId: string;
  };
}

export interface ImportMetrics {
  chunks: number;
  characters: number;
  embeddingMs: number;
  embeddingThroughput: number;
  databaseWriteMs: number;
  indexRefreshMs: number;
}

export interface SearchResult {
  id: string;
  document: string;
  metadata: DocumentChunk["metadata"] | null;
  score: number;
}

export interface SearchMetrics {
  queryEmbeddingMs: number;
  databaseSearchMs: number;
  endToEndMs: number;
}

export interface SearchResponse {
  results: SearchResult[];
  metrics: {
    databaseSearchMs: number;
    candidateCount: number;
    fusion: "rrf";
  };
}

export interface ModelRuntime {
  state: ModelState;
  backend: InferenceBackend | null;
  modelId: string;
  dtype: "q8";
  loadMs: number | null;
  progress: number;
  statusText: string;
  error: string | null;
}
