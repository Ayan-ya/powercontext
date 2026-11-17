import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Collection, SeekdbClientArgs } from "seekdb";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SERVER_DIR, "..");
const PORT = Number(process.env.PORT ?? 8787);
const SEEKDB_MODE = process.env.SEEKDB_MODE === "server" ? "server" : "embedded";
const DEFAULT_SEEKDB_PATH =
  process.platform === "win32" && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "StepSeek", "stepseek.db")
    : resolve(PROJECT_DIR, "data", "stepseek.db");
const SEEKDB_PATH = resolve(
  PROJECT_DIR,
  process.env.SEEKDB_PATH ?? DEFAULT_SEEKDB_PATH,
);
const VECTOR_DIMENSION = 384;
const BINDINGS_CACHE_PATH = resolve(PROJECT_DIR, "data", "bindings");

if (SEEKDB_MODE === "embedded") {
  mkdirSync(dirname(SEEKDB_PATH), { recursive: true });
  mkdirSync(BINDINGS_CACHE_PATH, { recursive: true });
  process.env.SEEKDB_BINDINGS_CACHE_DIR ??= BINDINGS_CACHE_PATH;
}

const {
  FulltextIndexConfig,
  Schema,
  SeekdbClient,
  VectorIndexConfig,
} = await import("seekdb");

const clientArgs: SeekdbClientArgs =
  SEEKDB_MODE === "server"
    ? {
        host: process.env.SEEKDB_HOST ?? "127.0.0.1",
        port: Number(process.env.SEEKDB_PORT ?? 2881),
        database: process.env.SEEKDB_DATABASE ?? "test",
        user: process.env.SEEKDB_USER ?? "root",
        password: process.env.SEEKDB_PASSWORD ?? "",
        queryTimeout: Number(process.env.SEEKDB_QUERY_TIMEOUT ?? 30_000),
      }
    : { path: SEEKDB_PATH, database: "stepseek" };

const client = new SeekdbClient(clientArgs);

const collectionSchema = new Schema({
  fulltextIndex: new FulltextIndexConfig("ik", { ik_mode: "smart" }),
  vectorIndex: new VectorIndexConfig({
    hnsw: {
      dimension: VECTOR_DIMENSION,
      distance: "cosine",
      type: "hnsw",
      m: 16,
      ef_construction: 200,
      ef_search: 64,
    },
    embeddingFunction: null,
  }),
});

function validateCollectionName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{2,47}$/.test(value)) {
    throw new Error(
      "知识库标识需为 3-48 位小写字母、数字或下划线，并以字母开头",
    );
  }
  return value;
}

function validateEmbedding(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== VECTOR_DIMENSION ||
    value.some((item) => typeof item !== "number" || !Number.isFinite(item))
  ) {
    throw new Error(`向量必须包含 ${VECTOR_DIMENSION} 个有限数值`);
  }
  return value;
}

async function getCollection(name: string): Promise<Collection> {
  return client.getOrCreateCollection({
    name: validateCollectionName(name),
    schema: collectionSchema,
    embeddingFunction: null,
  });
}

async function summarize(collection: Collection) {
  const [count, details] = await Promise.all([
    collection.count(),
    collection.describe(),
  ]);
  return {
    name: collection.name,
    count,
    dimension: details.dimension,
    distance: details.distance,
  };
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "30mb" }));

app.get("/api/health", async (_request, response) => {
  await client.countCollection();
  response.json({ status: "ok", engine: "seekdb", mode: SEEKDB_MODE });
});

app.get("/api/collections", async (_request, response) => {
  const collections = await client.listCollections({ withEmbeddingFunction: false });
  const summaries = await Promise.all(collections.map(summarize));
  summaries.sort((left, right) => left.name.localeCompare(right.name));
  response.json({ collections: summaries });
});

app.post("/api/collections", async (request, response) => {
  const collection = await getCollection(validateCollectionName(request.body?.name));
  response.status(201).json({ collection: await summarize(collection) });
});

app.delete("/api/collections/:name", async (request, response) => {
  const name = validateCollectionName(request.params.name);
  await client.deleteCollection(name);
  response.json({ deleted: name });
});

app.post("/api/collections/:name/documents", async (request, response) => {
  const collection = await getCollection(request.params.name);
  const { ids, documents, metadatas, embeddings } = request.body ?? {};

  if (
    !Array.isArray(ids) ||
    !Array.isArray(documents) ||
    !Array.isArray(metadatas) ||
    !Array.isArray(embeddings) ||
    ids.length === 0 ||
    ids.length !== documents.length ||
    ids.length !== metadatas.length ||
    ids.length !== embeddings.length
  ) {
    throw new Error("文档、向量和元数据必须为长度相同的非空数组");
  }
  if (ids.length > 128) throw new Error("单批最多写入 128 个文本块");
  if (ids.some((id) => typeof id !== "string" || id.length > 128)) {
    throw new Error("文档 ID 无效");
  }
  if (documents.some((document) => typeof document !== "string" || !document.trim())) {
    throw new Error("文档内容不能为空");
  }

  const checkedEmbeddings = embeddings.map(validateEmbedding);
  const writeStartedAt = performance.now();
  await collection.upsert({ ids, documents, metadatas, embeddings: checkedEmbeddings });
  const databaseWriteMs = performance.now() - writeStartedAt;

  const refreshStartedAt = performance.now();
  await client.execute("CALL dbms_index_manager.refresh();");
  const indexRefreshMs = performance.now() - refreshStartedAt;

  response.status(201).json({
    imported: ids.length,
    total: await collection.count(),
    metrics: { databaseWriteMs, indexRefreshMs },
  });
});

app.post("/api/collections/:name/search", async (request, response) => {
  const collection = await getCollection(request.params.name);
  const query = typeof request.body?.query === "string" ? request.body.query.trim() : "";
  const queryEmbedding = validateEmbedding(request.body?.queryEmbedding);
  const limit = Math.min(20, Math.max(1, Number(request.body?.limit ?? 8)));

  if (!query) throw new Error("查询内容不能为空");

  const candidateCount = Math.max(20, limit * 4);
  const startedAt = performance.now();
  const result = await collection.hybridSearch({
    query: {
      whereDocument: { $contains: query },
      nResults: candidateCount,
    },
    knn: {
      queryEmbeddings: queryEmbedding,
      nResults: candidateCount,
    },
    rank: {
      rrf: { rankWindowSize: 60, rankConstant: 60 },
    },
    nResults: limit,
    include: ["documents", "metadatas", "distances"],
  });
  const databaseSearchMs = performance.now() - startedAt;

  const ids = result.ids[0] ?? [];
  const documents = result.documents?.[0] ?? [];
  const metadatas = result.metadatas?.[0] ?? [];
  const scores = result.distances?.[0] ?? [];

  response.json({
    results: ids.map((id, index) => ({
      id,
      document: documents[index] ?? "",
      metadata: metadatas[index] ?? null,
      score: scores[index] ?? 0,
    })),
    metrics: { databaseSearchMs, candidateCount, fusion: "rrf" },
  });
});

const distDir = join(PROJECT_DIR, "dist");
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((request, response, next) => {
    if (request.method !== "GET" || request.path.startsWith("/api/")) return next();
    response.sendFile(join(distDir, "index.html"));
  });
}

app.use(
  (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "服务器处理失败";
    console.error(error);
    response.status(400).json({ error: message });
  },
);

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`StepSeek API listening on http://127.0.0.1:${PORT}`);
  if (SEEKDB_MODE === "server") {
    console.log(
      `seekdb server: ${clientArgs.host}:${clientArgs.port}/${clientArgs.database}`,
    );
  } else {
    console.log(`seekdb embedded path: ${SEEKDB_PATH}`);
  }
});

async function shutdown() {
  server.close();
  await client.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
