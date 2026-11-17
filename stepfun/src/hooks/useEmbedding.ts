import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelRuntime } from "../lib/types";

interface EmbedResponse {
  vectors: number[][];
  backend: "webgpu" | "wasm";
  elapsedMs: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

const initialRuntime: ModelRuntime = {
  state: "idle",
  backend: null,
  modelId: "Xenova/all-MiniLM-L6-v2",
  dtype: "q8",
  loadMs: null,
  progress: 0,
  statusText: "未加载",
  error: null,
};

export function useEmbedding() {
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef(new Map<string, PendingRequest>());
  const [runtime, setRuntime] = useState<ModelRuntime>(initialRuntime);
  const [embeddingProgress, setEmbeddingProgress] = useState({ completed: 0, total: 0 });

  useEffect(() => {
    const worker = new Worker(new URL("../workers/embedding.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.addEventListener("message", (message: MessageEvent<Record<string, any>>) => {
      const payload = message.data;

      if (payload.type === "backend-attempt") {
        setRuntime((current) => ({
          ...current,
          state: "loading",
          statusText: `正在初始化 ${String(payload.backend).toUpperCase()}`,
          error: null,
        }));
        return;
      }

      if (payload.type === "progress") {
        const progress = Number(payload.event?.progress ?? 0);
        const file = String(payload.event?.file ?? "模型文件");
        setRuntime((current) => ({
          ...current,
          progress: Number.isFinite(progress) ? Math.max(current.progress, progress) : current.progress,
          statusText: payload.event?.status === "progress" ? `加载 ${file}` : current.statusText,
        }));
        return;
      }

      if (payload.type === "backend-failed") {
        setRuntime((current) => ({
          ...current,
          statusText: `${String(payload.backend).toUpperCase()} 不可用，正在降级`,
        }));
        return;
      }

      if (payload.type === "ready") {
        setRuntime((current) => ({
          ...current,
          state: "ready",
          backend: payload.backend,
          modelId: payload.modelId,
          dtype: payload.dtype,
          loadMs: payload.loadMs,
          progress: 100,
          statusText: "模型就绪",
          error: null,
        }));
        return;
      }

      if (payload.type === "embedding-progress") {
        setEmbeddingProgress({ completed: payload.completed, total: payload.total });
        return;
      }

      if (payload.type === "complete" || payload.type === "request-error") {
        const pending = pendingRef.current.get(payload.requestId);
        if (!pending) return;
        pendingRef.current.delete(payload.requestId);
        if (payload.type === "complete") pending.resolve(payload.value);
        else pending.reject(new Error(payload.error));
      }
    });

    worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "Embedding worker failed");
      setRuntime((current) => ({
        ...current,
        state: "error",
        statusText: "模型加载失败",
        error: error.message,
      }));
      for (const pending of pendingRef.current.values()) pending.reject(error);
      pendingRef.current.clear();
    });

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const send = useCallback(<T,>(payload: Record<string, unknown>) => {
    const worker = workerRef.current;
    if (!worker) return Promise.reject(new Error("Embedding worker is unavailable"));
    const requestId = crypto.randomUUID();

    return new Promise<T>((resolve, reject) => {
      pendingRef.current.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      worker.postMessage({ ...payload, requestId });
    });
  }, []);

  const initialize = useCallback(async () => {
    setRuntime((current) => ({ ...current, state: "loading", error: null }));
    try {
      await send<null>({ type: "init" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntime((current) => ({
        ...current,
        state: "error",
        statusText: "模型加载失败",
        error: message,
      }));
      throw error;
    }
  }, [send]);

  const embed = useCallback(
    async (texts: string[], batchSize: number) => {
      setEmbeddingProgress({ completed: 0, total: texts.length });
      return send<EmbedResponse>({ type: "embed", texts, batchSize });
    },
    [send],
  );

  return { runtime, embeddingProgress, initialize, embed };
}
