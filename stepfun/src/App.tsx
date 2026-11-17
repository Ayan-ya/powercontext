import {
  AlertCircle,
  Check,
  Cpu,
  Database,
  FileText,
  FolderPlus,
  Gauge,
  HardDrive,
  Layers3,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEmbedding } from "./hooks/useEmbedding";
import { api } from "./lib/api";
import { buildChunks } from "./lib/chunk";
import type {
  CollectionSummary,
  ImportMetrics,
  SearchMetrics,
  SearchResult,
} from "./lib/types";

type View = "import" | "search";

const DEFAULT_COLLECTION = "personal_notes";
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const WRITE_BATCH_SIZE = 64;

function formatMs(value: number | null | undefined) {
  if (value == null) return "--";
  return value < 1000 ? `${value.toFixed(0)} ms` : `${(value / 1000).toFixed(2)} s`;
}

function formatCount(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function sanitizeCollectionName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

export default function App() {
  const { runtime, embeddingProgress, initialize, embed } = useEmbedding();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<View>("import");
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [selectedName, setSelectedName] = useState(
    () => localStorage.getItem("stepseek.collection") ?? DEFAULT_COLLECTION,
  );
  const [apiState, setApiState] = useState<"checking" | "ready" | "error">("checking");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [pastedText, setPastedText] = useState("");
  const [maxChars, setMaxChars] = useState(700);
  const [overlapChars, setOverlapChars] = useState(80);
  const [batchSize, setBatchSize] = useState(8);
  const [isImporting, setIsImporting] = useState(false);
  const [importMetrics, setImportMetrics] = useState<ImportMetrics | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(8);
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchMetrics, setSearchMetrics] = useState<SearchMetrics | null>(null);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const selectedCollection = useMemo(
    () => collections.find((collection) => collection.name === selectedName) ?? null,
    [collections, selectedName],
  );

  const refreshCollections = useCallback(async (preferredName?: string) => {
    const response = await api.listCollections();
    let nextCollections = response.collections;

    if (nextCollections.length === 0) {
      const created = await api.createCollection(DEFAULT_COLLECTION);
      nextCollections = [created.collection];
    }

    setCollections(nextCollections);
    setSelectedName((current) => {
      const requested = preferredName ?? current;
      const next = nextCollections.some((item) => item.name === requested)
        ? requested
        : nextCollections[0].name;
      localStorage.setItem("stepseek.collection", next);
      return next;
    });
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await api.health();
        await refreshCollections();
        setApiState("ready");
      } catch (error) {
        setApiState("error");
        setNotice({
          kind: "error",
          text: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, [refreshCollections]);

  const selectCollection = (name: string) => {
    setSelectedName(name);
    localStorage.setItem("stepseek.collection", name);
    setResults([]);
    setSearchMetrics(null);
  };

  const createCollection = async () => {
    const name = sanitizeCollectionName(newCollectionName);
    try {
      const response = await api.createCollection(name);
      setNewCollectionName("");
      setShowCreate(false);
      await refreshCollections(response.collection.name);
      setNotice({ kind: "success", text: `知识库 ${response.collection.name} 已创建` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const deleteCollection = async (name: string) => {
    if (!window.confirm(`删除知识库 ${name} 及其中全部数据？`)) return;
    try {
      await api.deleteCollection(name);
      await refreshCollections();
      setNotice({ kind: "success", text: `知识库 ${name} 已删除` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const addFiles = (incoming: FileList | File[]) => {
    const accepted = Array.from(incoming).filter((file) => file.size <= MAX_FILE_BYTES);
    setFiles((current) => {
      const seen = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
      return [
        ...current,
        ...accepted.filter((file) => !seen.has(`${file.name}:${file.size}:${file.lastModified}`)),
      ];
    });
    if (accepted.length !== Array.from(incoming).length) {
      setNotice({ kind: "error", text: "单个文件不能超过 5 MB" });
    }
  };

  const runImport = async () => {
    if (!selectedCollection) return;
    if (files.length === 0 && !pastedText.trim()) {
      setNotice({ kind: "error", text: "请选择文件或输入文本" });
      return;
    }

    setIsImporting(true);
    setNotice(null);
    try {
      if (runtime.state !== "ready") await initialize();

      const documents = await Promise.all(
        files.map(async (file) => ({ source: file.name, text: await file.text() })),
      );
      if (pastedText.trim()) {
        documents.push({
          source: `manual_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`,
          text: pastedText.trim(),
        });
      }

      const chunks = buildChunks(documents, { maxChars, overlapChars });
      if (chunks.length === 0) throw new Error("没有可导入的文本内容");

      const embeddingResult = await embed(
        chunks.map((chunk) => chunk.text),
        batchSize,
      );

      let databaseWriteMs = 0;
      let indexRefreshMs = 0;
      for (let offset = 0; offset < chunks.length; offset += WRITE_BATCH_SIZE) {
        const chunkBatch = chunks.slice(offset, offset + WRITE_BATCH_SIZE);
        const embeddingBatch = embeddingResult.vectors.slice(offset, offset + WRITE_BATCH_SIZE);
        const response = await api.importChunks(selectedCollection.name, chunkBatch, embeddingBatch);
        databaseWriteMs += response.metrics.databaseWriteMs;
        indexRefreshMs += response.metrics.indexRefreshMs;
      }

      const characters = chunks.reduce((total, chunk) => total + chunk.text.length, 0);
      setImportMetrics({
        chunks: chunks.length,
        characters,
        embeddingMs: embeddingResult.elapsedMs,
        embeddingThroughput: chunks.length / (embeddingResult.elapsedMs / 1000),
        databaseWriteMs,
        indexRefreshMs,
      });
      setFiles([]);
      setPastedText("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      await refreshCollections(selectedCollection.name);
      setNotice({ kind: "success", text: `${chunks.length} 个文本块已写入 seekdb` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsImporting(false);
    }
  };

  const runSearch = async () => {
    if (!selectedCollection || !query.trim()) return;
    setIsSearching(true);
    setNotice(null);
    const startedAt = performance.now();

    try {
      if (runtime.state !== "ready") await initialize();
      const embeddingResult = await embed([query.trim()], 1);
      const response = await api.search(
        selectedCollection.name,
        query.trim(),
        embeddingResult.vectors[0],
        limit,
      );
      setResults(response.results);
      setSearchMetrics({
        queryEmbeddingMs: embeddingResult.elapsedMs,
        databaseSearchMs: response.metrics.databaseSearchMs,
        endToEndMs: performance.now() - startedAt,
      });
    } catch (error) {
      setResults([]);
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><Layers3 size={20} /></div>
          <div>
            <strong>StepSeek</strong>
            <span>端侧知识库</span>
          </div>
        </div>
        <div className="runtime-strip">
          <div className={`status-item ${apiState}`}>
            <Database size={15} />
            <span>seekdb {apiState === "ready" ? "已连接" : apiState === "error" ? "连接失败" : "连接中"}</span>
          </div>
          <div className={`status-item ${runtime.state}`}>
            <Cpu size={15} />
            <span>
              {runtime.state === "ready"
                ? `${runtime.backend?.toUpperCase()} · INT8`
                : runtime.statusText}
            </span>
          </div>
          <button
            className="button secondary compact"
            onClick={() => void initialize()}
            disabled={runtime.state === "loading" || runtime.state === "ready"}
          >
            {runtime.state === "loading" ? <LoaderCircle className="spin" size={16} /> : <Cpu size={16} />}
            {runtime.state === "ready" ? "模型就绪" : "加载模型"}
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <span>知识库</span>
            <button className="icon-button" title="新建知识库" onClick={() => setShowCreate(true)}>
              <Plus size={17} />
            </button>
          </div>

          {showCreate && (
            <div className="create-row">
              <input
                autoFocus
                value={newCollectionName}
                onChange={(event) => setNewCollectionName(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void createCollection()}
                placeholder="project_notes"
              />
              <button className="icon-button" title="确认创建" onClick={() => void createCollection()}>
                <Check size={16} />
              </button>
              <button className="icon-button" title="取消" onClick={() => setShowCreate(false)}>
                <X size={16} />
              </button>
            </div>
          )}

          <nav className="collection-list" aria-label="知识库列表">
            {collections.map((collection) => (
              <div className={`collection-row ${collection.name === selectedName ? "active" : ""}`} key={collection.name}>
                <button className="collection-select" onClick={() => selectCollection(collection.name)}>
                  <HardDrive size={16} />
                  <span>
                    <strong>{collection.name}</strong>
                    <small>{formatCount(collection.count)} 个文本块</small>
                  </span>
                </button>
                <button
                  className="icon-button danger"
                  title="删除知识库"
                  onClick={() => void deleteCollection(collection.name)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </nav>

          <div className="sidebar-meta">
            <span>384 维</span>
            <span>Cosine</span>
            <span>HNSW + IK</span>
          </div>
        </aside>

        <main className="main-pane">
          <div className="pane-toolbar">
            <div>
              <h1>{selectedCollection?.name ?? "知识库"}</h1>
              <p>{formatCount(selectedCollection?.count ?? 0)} 个已索引文本块</p>
            </div>
            <div className="segmented" role="tablist" aria-label="工作视图">
              <button className={view === "import" ? "active" : ""} onClick={() => setView("import")}>
                <Upload size={16} />导入
              </button>
              <button className={view === "search" ? "active" : ""} onClick={() => setView("search")}>
                <Search size={16} />检索
              </button>
            </div>
          </div>

          {notice && (
            <div className={`notice ${notice.kind}`} role="status">
              {notice.kind === "success" ? <Check size={17} /> : <AlertCircle size={17} />}
              <span>{notice.text}</span>
              <button className="icon-button" title="关闭" onClick={() => setNotice(null)}><X size={15} /></button>
            </div>
          )}

          {runtime.state === "loading" && (
            <div className="model-progress">
              <div style={{ width: `${Math.max(4, runtime.progress)}%` }} />
            </div>
          )}

          {view === "import" ? (
            <section className="content-section" aria-labelledby="import-title">
              <div className="section-heading">
                <div>
                  <h2 id="import-title">导入语料</h2>
                  <span>TXT · Markdown · JSON · CSV</span>
                </div>
                <div className="control-cluster">
                  <label>块大小<input type="number" min="100" max="2000" step="50" value={maxChars} onChange={(e) => setMaxChars(Number(e.target.value))} /></label>
                  <label>重叠<input type="number" min="0" max="500" step="10" value={overlapChars} onChange={(e) => setOverlapChars(Number(e.target.value))} /></label>
                  <label>批大小<input type="number" min="1" max="32" value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))} /></label>
                </div>
              </div>

              <div
                className="drop-zone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  addFiles(event.dataTransfer.files);
                }}
              >
                <FolderPlus size={28} />
                <strong>{files.length ? `${files.length} 个文件已选择` : "选择文本文档"}</strong>
                <button className="button secondary" onClick={() => fileInputRef.current?.click()}>
                  <Upload size={16} />浏览文件
                </button>
                <input
                  ref={fileInputRef}
                  hidden
                  multiple
                  type="file"
                  accept=".txt,.md,.markdown,.json,.csv,text/plain,text/markdown,application/json,text/csv"
                  onChange={(event) => event.target.files && addFiles(event.target.files)}
                />
              </div>

              {files.length > 0 && (
                <div className="file-list">
                  {files.map((file) => (
                    <div key={`${file.name}:${file.lastModified}`}>
                      <FileText size={15} />
                      <span>{file.name}</span>
                      <small>{(file.size / 1024).toFixed(1)} KB</small>
                      <button className="icon-button" title="移除文件" onClick={() => setFiles((current) => current.filter((item) => item !== file))}><X size={14} /></button>
                    </div>
                  ))}
                </div>
              )}

              <label className="paste-field">
                <span>直接输入</span>
                <textarea value={pastedText} onChange={(event) => setPastedText(event.target.value)} placeholder="粘贴需要索引的文本" />
              </label>

              <div className="action-row">
                <button className="button primary" disabled={isImporting || !selectedCollection} onClick={() => void runImport()}>
                  {isImporting ? <LoaderCircle className="spin" size={17} /> : <Database size={17} />}
                  {isImporting ? `本地向量化 ${embeddingProgress.completed}/${embeddingProgress.total}` : "向量化并写入"}
                </button>
                <span>{runtime.backend ? `${runtime.modelId} · ${runtime.backend.toUpperCase()} · INT8` : "模型将在浏览器本地运行"}</span>
              </div>

              {importMetrics && (
                <div className="metrics-band" aria-label="最近导入性能">
                  <Metric icon={<Layers3 size={17} />} label="文本块" value={formatCount(importMetrics.chunks)} />
                  <Metric icon={<Gauge size={17} />} label="向量化" value={formatMs(importMetrics.embeddingMs)} detail={`${importMetrics.embeddingThroughput.toFixed(2)} 块/秒`} />
                  <Metric icon={<Database size={17} />} label="写入" value={formatMs(importMetrics.databaseWriteMs)} />
                  <Metric icon={<RefreshCw size={17} />} label="索引刷新" value={formatMs(importMetrics.indexRefreshMs)} />
                </div>
              )}
            </section>
          ) : (
            <section className="content-section" aria-labelledby="search-title">
              <div className="section-heading">
                <div>
                  <h2 id="search-title">混合检索</h2>
                  <span>seekdb RRF · 全文 + 向量</span>
                </div>
                <label className="limit-control">结果数<input type="number" min="1" max="20" value={limit} onChange={(e) => setLimit(Number(e.target.value))} /></label>
              </div>

              <form
                className="search-box"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runSearch();
                }}
              >
                <Search size={20} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入查询" autoFocus />
                <button className="button primary" disabled={isSearching || !query.trim()}>
                  {isSearching ? <LoaderCircle className="spin" size={17} /> : <Search size={17} />}
                  检索
                </button>
              </form>

              {searchMetrics && (
                <div className="metrics-band search-metrics" aria-label="最近查询性能">
                  <Metric icon={<Cpu size={17} />} label="查询向量" value={formatMs(searchMetrics.queryEmbeddingMs)} />
                  <Metric icon={<Database size={17} />} label="seekdb" value={formatMs(searchMetrics.databaseSearchMs)} />
                  <Metric icon={<Gauge size={17} />} label="端到端" value={formatMs(searchMetrics.endToEndMs)} />
                  <Metric icon={<Layers3 size={17} />} label="命中" value={formatCount(results.length)} />
                </div>
              )}

              <div className="results-list">
                {results.map((result, index) => (
                  <article className="result-card" key={result.id}>
                    <div className="result-rank">{index + 1}</div>
                    <div className="result-body">
                      <div className="result-meta">
                        <strong>{result.metadata?.source ?? "未知来源"}</strong>
                        <span>块 {(result.metadata?.chunkIndex ?? 0) + 1}</span>
                        <span>RRF {result.score.toFixed(4)}</span>
                      </div>
                      <p>{result.document}</p>
                    </div>
                  </article>
                ))}
                {!isSearching && searchMetrics && results.length === 0 && (
                  <div className="empty-state"><Search size={26} /><span>没有匹配结果</span></div>
                )}
                {!searchMetrics && (
                  <div className="empty-state"><Database size={26} /><span>{selectedCollection?.count ? "等待查询" : "当前知识库为空"}</span></div>
                )}
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="metric">
      <span className="metric-icon">{icon}</span>
      <span><small>{label}</small><strong>{value}</strong>{detail && <em>{detail}</em>}</span>
    </div>
  );
}
