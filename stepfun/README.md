# StepSeek

StepSeek 是一个浏览器端本地向量化、seekdb 数据库存储与混合检索的迷你知识库。文档和查询 embedding 均由浏览器 Web Worker 计算；Node 服务不运行模型，只负责把向量、原文和元数据写入 seekdb，并调用数据库内置 `hybridSearch()`。

## 功能

- `Xenova/all-MiniLM-L6-v2` INT8（384 维），Transformers.js 浏览器本地推理
- 显式优先 WebGPU，初始化失败自动降级至 WASM，界面显示实际后端
- 文本文件批量导入、可配置切块/重叠/embedding 批大小
- seekdb 1.3.0 SDK + 1.4.0 原生绑定，或官方 seekdb 服务容器；HNSW 向量索引与 IK 全文索引
- seekdb `DBMS_HYBRID_SEARCH` + RRF 数据库内融合，不在客户端拼接结果
- 多知识库、增量写入、索引刷新、集合隔离和会话元数据
- 模型加载、向量化吞吐、数据库写入、索引刷新和查询延迟分阶段计时

## 环境

- Node.js 20 或 22 LTS（嵌入模式）；服务模式也已在 Node.js 24 验证
- Edge 或 Chrome 最新版
- 可选：Docker Desktop（Windows 上推荐使用官方 seekdb 服务模式）
- Windows x64、Linux x64/arm64 或 macOS arm64（seekdb 嵌入式预编译平台）
- 首次加载模型需要访问 Hugging Face；模型下载后由浏览器 Cache API 缓存

## 启动

```bash
npm install
npm run dev
```

仓库内 `.npmrc` 会跳过 seekdb 的可选服务端 embedding peer 链；应用显式使用 `embeddingFunction: null`，所需向量全部由浏览器生成。seekdb 官方原生绑定仍作为 optional dependency 正常安装。

打开 `http://127.0.0.1:5173`。Vite 将 `/api` 代理到 `http://127.0.0.1:8787`。

Windows 上也可以使用题目允许的 seekdb 本地服务模式，避免原生嵌入库受 Node ABI 或本机路径影响：

```powershell
npm run seekdb:up
$env:SEEKDB_MODE="server"
npm run dev
```

macOS/Linux 对应命令为 `SEEKDB_MODE=server npm run dev`。`docker-compose.yml` 使用官方 `oceanbase/seekdb:latest` 镜像，数据保存在 Compose 项目级命名卷中；`npm run seekdb:down` 仅停止并移除容器，不删除数据卷。

生产模式：

```bash
npm run build
npm start
```

打开 `http://127.0.0.1:8787`。Windows 默认保存到 `%LOCALAPPDATA%/StepSeek/stepseek.db`，Linux/macOS 默认保存到 `data/stepseek.db`，均可通过 `SEEKDB_PATH` 修改。Windows 使用系统数据目录也避免原生库无法打开含非 ASCII 字符的仓库路径。

## 复现流程

1. 点击顶部“加载模型”，确认状态显示 `WEBGPU · INT8` 或 `WASM · INT8`。
2. 在“导入”页选择 `public/sample-knowledge.txt`，点击“向量化并写入”。
3. 切到“检索”，查询“浏览器不支持 GPU 时怎么办”。结果应命中 WebGPU/WASM 段落。
4. 再次导入其他文档，确认文本块总数增加且新增内容可检索。
5. 新建并切换知识库，确认不同集合的结果相互隔离。

## 验证

```bash
npm test
npm run build
npm run verify:seekdb
```

`verify:seekdb` 会创建临时嵌入式数据库，写入向量与文档，调用 seekdb 原生混合检索并断言首条结果，结束后删除临时数据。

验证服务模式：

```powershell
$env:SEEKDB_MODE="server"
npm run verify:seekdb
```

该流程会在官方 seekdb 容器中创建临时 collection，验证后删除 collection，不删除其他数据。

## 数据路径

```text
浏览器文件 -> 文本切块 -> Web Worker / Transformers.js -> INT8 embedding
  -> POST 向量、原文、元数据 -> seekdb embedded/server -> dbms_index_manager.refresh()
查询 -> 浏览器本地 embedding -> seekdb full-text + HNSW -> RRF -> 结果
```

服务端没有云端推理接口，也没有内存检索或客户端结果融合回退。若当前 seekdb 不支持 `DBMS_HYBRID_SEARCH`，请求会明确失败，而不会绕过数据库规则。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | API / 生产静态服务端口 |
| `SEEKDB_MODE` | `embedded` | `embedded` 或 `server` |
| `SEEKDB_PATH` | Windows: `%LOCALAPPDATA%/StepSeek/stepseek.db`；其他: `./data/stepseek.db` | 嵌入式 seekdb 数据目录 |
| `SEEKDB_BINDINGS_CACHE_DIR` | `./data/bindings` | seekdb 原生绑定缓存目录 |
| `SEEKDB_HOST` / `SEEKDB_PORT` | `127.0.0.1` / `2881` | seekdb 服务模式地址 |
| `SEEKDB_DATABASE` / `SEEKDB_USER` | `test` / `root` | seekdb 服务模式数据库与用户 |
| `SEEKDB_PASSWORD` | 空 | seekdb 服务密码；不应提交真实密码 |
| `SEEKDB_QUERY_TIMEOUT` | `30000` | seekdb 查询超时（毫秒） |
| `VITE_API_BASE` | `/api` | 浏览器 API 前缀 |

模型来源、量化口径和性能记录见 [TECHNICAL_NOTE.md](./TECHNICAL_NOTE.md)。
