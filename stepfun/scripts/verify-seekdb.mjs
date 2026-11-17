import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

process.env.SEEKDB_BINDINGS_CACHE_DIR ??= resolve("data", "bindings");
const mode = process.env.SEEKDB_MODE === "server" ? "server" : "embedded";

const {
  FulltextIndexConfig,
  Schema,
  SeekdbClient,
  VectorIndexConfig,
} = await import("seekdb");

const databasePath = resolve(tmpdir(), `stepseek-verification-${process.pid}.db`);
const client = new SeekdbClient(
  mode === "server"
    ? {
        host: process.env.SEEKDB_HOST ?? "127.0.0.1",
        port: Number(process.env.SEEKDB_PORT ?? 2881),
        database: process.env.SEEKDB_DATABASE ?? "test",
        user: process.env.SEEKDB_USER ?? "root",
        password: process.env.SEEKDB_PASSWORD ?? "",
        queryTimeout: Number(process.env.SEEKDB_QUERY_TIMEOUT ?? 30_000),
      }
    : { path: databasePath, database: "verification" },
);
const collectionName = `verification_docs_${process.pid}`;
let collectionCreated = false;
console.log(`[1/4] seekdb ${mode} client initialized`);

try {
  const collection = await client.createCollection({
    name: collectionName,
    schema: new Schema({
      fulltextIndex: new FulltextIndexConfig("ik", { ik_mode: "smart" }),
      vectorIndex: new VectorIndexConfig({
        hnsw: { dimension: 3, distance: "cosine" },
        embeddingFunction: null,
      }),
    }),
    embeddingFunction: null,
  });
  collectionCreated = true;
  console.log("[2/4] collection and indexes created");

  await collection.add({
    ids: ["database", "browser", "weather"],
    documents: [
      "seekdb provides vector and full-text hybrid database search",
      "browser WebGPU runs local embedding inference",
      "tomorrow will be warm and sunny",
    ],
    embeddings: [
      [1, 0, 0],
      [0.8, 0.2, 0],
      [0, 0, 1],
    ],
    metadatas: [{ source: "db" }, { source: "web" }, { source: "weather" }],
  });
  console.log("[3/4] vectors, documents and metadata written");

  await client.execute("CALL dbms_index_manager.refresh();");
  const result = await collection.hybridSearch({
    query: { whereDocument: { $contains: "database" }, nResults: 5 },
    knn: { queryEmbeddings: [1, 0, 0], nResults: 5 },
    rank: { rrf: {} },
    nResults: 2,
    include: ["documents", "metadatas", "distances"],
  });

  assert.ok(result.ids[0].length > 0, "hybridSearch should return a result");
  assert.equal(result.ids[0][0], "database");
  console.log("[4/4] seekdb hybridSearch verified:", result.ids[0]);
} finally {
  if (collectionCreated && (await client.hasCollection(collectionName))) {
    await client.deleteCollection(collectionName);
  }
  await client.close();
  if (mode === "embedded") {
    await rm(databasePath, { recursive: true, force: true });
  }
}
