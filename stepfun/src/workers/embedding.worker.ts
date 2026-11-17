/// <reference lib="webworker" />

import { env, pipeline } from "@huggingface/transformers";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DTYPE = "q8" as const;

type Extractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: true },
) => Promise<{ tolist: () => unknown }>;

interface InitMessage {
  type: "init";
  requestId: string;
}

interface EmbedMessage {
  type: "embed";
  requestId: string;
  texts: string[];
  batchSize: number;
}

type IncomingMessage = InitMessage | EmbedMessage;

let extractor: Extractor | null = null;
let backend: "webgpu" | "wasm" | null = null;
let loadPromise: Promise<void> | null = null;

env.allowRemoteModels = true;
env.useBrowserCache = true;

function post(payload: Record<string, unknown>) {
  self.postMessage(payload);
}

async function initialize() {
  if (extractor) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const startedAt = performance.now();
    const candidates: Array<"webgpu" | "wasm"> =
      "gpu" in navigator ? ["webgpu", "wasm"] : ["wasm"];
    let lastError: unknown;

    for (const candidate of candidates) {
      try {
        post({ type: "backend-attempt", backend: candidate });
        extractor = (await pipeline("feature-extraction", MODEL_ID, {
          device: candidate,
          dtype: DTYPE,
          progress_callback: (event: Record<string, unknown>) => {
            post({ type: "progress", event });
          },
        })) as unknown as Extractor;
        backend = candidate;
        post({
          type: "ready",
          backend,
          modelId: MODEL_ID,
          dtype: DTYPE,
          loadMs: performance.now() - startedAt,
        });
        return;
      } catch (error) {
        lastError = error;
        extractor = null;
        post({
          type: "backend-failed",
          backend: candidate,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("No browser inference backend is available");
  })().finally(() => {
    loadPromise = null;
  });

  return loadPromise;
}

async function embed(texts: string[], batchSize: number) {
  await initialize();
  if (!extractor || !backend) throw new Error("Embedding model is not ready");

  const vectors: number[][] = [];
  const startedAt = performance.now();

  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const batch = texts.slice(offset, offset + batchSize);
    const output = await extractor(batch, { pooling: "mean", normalize: true });
    const values = output.tolist() as number[][];
    vectors.push(...values);
    post({
      type: "embedding-progress",
      completed: Math.min(offset + batch.length, texts.length),
      total: texts.length,
    });
  }

  return {
    vectors,
    backend,
    elapsedMs: performance.now() - startedAt,
  };
}

self.addEventListener("message", async (message: MessageEvent<IncomingMessage>) => {
  const { requestId } = message.data;

  try {
    if (message.data.type === "init") {
      await initialize();
      post({ type: "complete", requestId, value: null });
      return;
    }

    const value = await embed(message.data.texts, message.data.batchSize);
    post({ type: "complete", requestId, value });
  } catch (error) {
    post({
      type: "request-error",
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
