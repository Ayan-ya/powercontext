import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DIMENSIONS, embed } from "./embedding.mjs";

const COLLECTION = "minimax_sdd_context";
const DEFAULT_BINDINGS_CACHE = resolve(import.meta.dirname, "..", "data", "bindings");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeMetadata(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export class ContextStore {
  constructor(databasePath, collectionName = process.env.MINIMAX_CONTEXT_COLLECTION ?? COLLECTION) {
    this.databasePath = resolve(databasePath);
    this.mode = process.env.SEEKDB_MODE === "embedded" ? "embedded" : "server";
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(collectionName)) {
      throw new Error("Invalid seekdb collection name");
    }
    this.collectionName = collectionName;
    this.client = null;
    this.collection = null;
  }

  async open() {
    if (this.mode === "embedded") {
      await mkdir(dirname(this.databasePath), { recursive: true });
      process.env.SEEKDB_BINDINGS_CACHE_DIR ??= DEFAULT_BINDINGS_CACHE;
    }
    const { FulltextIndexConfig, Schema, SeekdbClient, VectorIndexConfig } =
      await import("seekdb");

    this.client = new SeekdbClient(
      this.mode === "server"
        ? {
            host: process.env.SEEKDB_HOST ?? "127.0.0.1",
            port: Number(process.env.SEEKDB_PORT ?? 2882),
            database: process.env.SEEKDB_DATABASE ?? "test",
            user: process.env.SEEKDB_USER ?? "root",
            password: process.env.SEEKDB_PASSWORD ?? "",
            queryTimeout: Number(process.env.SEEKDB_QUERY_TIMEOUT ?? 30_000),
          }
        : { path: this.databasePath, database: "minimax_sdd" },
    );
    this.schema = new Schema({
      fulltextIndex: new FulltextIndexConfig("ik", { ik_mode: "smart" }),
      vectorIndex: new VectorIndexConfig({
        hnsw: { dimension: DIMENSIONS, distance: "cosine" },
        embeddingFunction: null,
      }),
    });
    this.collection = await this.client.getOrCreateCollection({
      name: this.collectionName,
      schema: this.schema,
      embeddingFunction: null,
    });
    return this;
  }

  async reset() {
    if (!this.client) throw new Error("ContextStore is not open");
    if (await this.client.hasCollection(this.collectionName)) {
      await this.client.deleteCollection(this.collectionName);
    }
    this.collection = await this.client.createCollection({
      name: this.collectionName,
      schema: this.schema,
      embeddingFunction: null,
    });
  }

  async importManifest(manifestPath) {
    if (!this.collection) throw new Error("ContextStore is not open");
    const absoluteManifest = resolve(manifestPath);
    const manifest = JSON.parse(await readFile(absoluteManifest, "utf8"));
    if (!Array.isArray(manifest.documents) || manifest.documents.length === 0) {
      throw new Error("Manifest must contain a non-empty documents array");
    }

    const base = dirname(absoluteManifest);
    const records = await Promise.all(
      manifest.documents.map(async (entry) => {
        if (!entry.id || !entry.kind || !entry.source || !entry.title) {
          throw new Error("Every manifest document needs id, kind, source and title");
        }
        const sourcePath = resolve(base, entry.source);
        const content = await readFile(sourcePath, "utf8");
        const source = entry.displaySource ?? entry.source.replaceAll("\\", "/");
        const symbols = Array.isArray(entry.symbols) ? entry.symbols.join(", ") : "";
        const document = [
          `kind: ${entry.kind}`,
          `source: ${source}`,
          `title: ${entry.title}`,
          symbols ? `symbols: ${symbols}` : "",
          "",
          content,
        ]
          .filter((line) => line !== "")
          .join("\n");
        return {
          id: String(entry.id),
          document,
          embedding: embed(document),
          metadata: {
            ...normalizeMetadata(entry.metadata),
            kind: String(entry.kind),
            source,
            title: String(entry.title),
            symbols,
            sha256: sha256(content),
          },
        };
      }),
    );

    await this.collection.upsert({
      ids: records.map((record) => record.id),
      documents: records.map((record) => record.document),
      embeddings: records.map((record) => record.embedding),
      metadatas: records.map((record) => record.metadata),
    });
    await this.client.execute("CALL dbms_index_manager.refresh();");
    return {
      engine: "seekdb",
      mode: this.mode,
      collection: this.collectionName,
      imported: records.length,
      total: await this.collection.count(),
      documents: records.map(({ id, metadata }) => ({ id, ...metadata })),
    };
  }

  async search(query, limit = 12) {
    if (!this.collection) throw new Error("ContextStore is not open");
    const count = await this.collection.count();
    if (count === 0) return [];
    const nResults = Math.min(Math.max(1, limit), count);
    const candidateCount = Math.min(count, Math.max(nResults, nResults * 3));
    const result = await this.collection.hybridSearch({
      query: {
        whereDocument: { $contains: query },
        nResults: candidateCount,
      },
      knn: {
        queryEmbeddings: embed(query),
        nResults: candidateCount,
      },
      rank: { rrf: { rankWindowSize: 60, rankConstant: 60 } },
      nResults,
      include: ["documents", "metadatas", "distances"],
    });

    const ids = result.ids?.[0] ?? [];
    const documents = result.documents?.[0] ?? [];
    const metadatas = result.metadatas?.[0] ?? [];
    const scores = result.distances?.[0] ?? [];
    return ids.map((id, index) => ({
      id,
      document: documents[index] ?? "",
      metadata: metadatas[index] ?? {},
      score: scores[index] ?? null,
    }));
  }

  async buildTaskContext(task, state = null) {
    const queries = [
      task,
      `${task} specification requirements constraints`,
      `${task} implementation source code symbols`,
      `${task} functional regression tests compatibility`,
    ];
    const resultSets = [];
    for (const query of queries) {
      resultSets.push(await this.search(query, 12));
    }

    const merged = new Map();
    for (const results of resultSets) {
      for (const result of results) {
        if (!merged.has(result.id)) merged.set(result.id, result);
      }
    }

    const grouped = { specification: [], code: [], test: [], task: [], other: [] };
    for (const result of merged.values()) {
      const kind = String(result.metadata.kind ?? "other");
      const bucket = grouped[kind] ?? grouped.other;
      bucket.push({
        id: result.id,
        source: result.metadata.source,
        title: result.metadata.title,
        symbols: result.metadata.symbols || undefined,
        sha256: result.metadata.sha256,
        excerpt: result.document.slice(0, 6000),
      });
    }

    return {
      task,
      database: {
        engine: "seekdb",
        mode: this.mode,
        collection: this.collectionName,
        queryCount: queries.length,
        queries,
        returnedDocumentCount: merged.size,
      },
      applicableSpecifications: grouped.specification,
      codeLocations: grouped.code,
      verificationTests: grouped.test,
      taskSources: grouped.task,
      restoredState: state,
    };
  }

  async close() {
    await this.client?.close();
    this.client = null;
    this.collection = null;
  }

  async drop() {
    if (this.client && (await this.client.hasCollection(this.collectionName))) {
      await this.client.deleteCollection(this.collectionName);
      this.collection = null;
    }
  }
}
