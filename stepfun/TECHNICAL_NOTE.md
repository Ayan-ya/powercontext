# StepSeek 一页技术说明

## 模型与量化

模型为 `Xenova/all-MiniLM-L6-v2`（上游 `sentence-transformers/all-MiniLM-L6-v2`），384 维，Apache-2.0。运行时固定请求 Transformers.js `dtype: "q8"`，使用上游 ONNX INT8 权重；浏览器开发者工具和界面状态可验证没有云端推理请求。上游模型仓库同口径 ONNX 权重体积：FP32 约 90.4 MB，INT8 约 22.9 MB，压缩比约 3.95x。量化质量使用固定查询集对 FP32/INT8 的 Recall@5 与 nDCG@5 比较；原始复现数据和本机实测值在最终验收运行后记录于本文末表。

## 端侧运行

主线程通过 Web Worker 调用 `@huggingface/transformers` feature-extraction pipeline，采用 mean pooling 与 L2 normalize。初始化按 `webgpu -> wasm` 顺序尝试；WebGPU 初始化或执行不受支持时自动重建 WASM pipeline。顶部状态栏显示实际后端、INT8 精度与模型状态。模型文件可以远程下载或命中浏览器缓存，但 embedding 计算始终在用户设备上执行。

## seekdb 使用

Node 端使用 `seekdb@1.3.0` SDK，可连接官方 `oceanbase/seekdb:latest` 本地服务，也可配合 `@seekdb/js-bindings@1.4.0` 嵌入式运行。seekdb 1.4.0 SDK 当前 npm 发布元数据包含未替换的 `workspace:*`，无法由 npm 安装，因此锁定可复现安装且 API 兼容的 1.3.0 SDK；原生绑定覆盖到 1.4.0。项目级 `.npmrc` 跳过不使用的服务端默认 embedding peer 链。每个知识库对应独立 collection，schema 包含 384 维 cosine HNSW（`m=16, ef_construction=200, ef_search=64`）和 IK smart 全文索引；保存 `id / document / embedding / metadata`。浏览器直接提交本地向量，collection 显式设置 `embeddingFunction: null`。写入使用 `upsert()` 支持增量导入，完成后执行 `CALL dbms_index_manager.refresh()`。查询调用 seekdb `hybridSearch()`，全文与向量各取候选后由数据库内 RRF（window=60, constant=60）融合；客户端只展示数据库返回结果。提交前的真实集成验证运行在官方服务容器中，依次通过建索引、写入、刷新和 `hybridSearch()` 断言。

## 状态与优化

活动 collection 保存在浏览器 localStorage，每次请求都显式携带 collection 名，服务端不持有易串库的全局活动集合。导入会话 UUID、来源、块序号、字符数和时间写入 metadata。优化包括 Worker 隔离、浏览器模型缓存、可调 embedding batch（默认 8）、700 字符切块/80 字符重叠、最多 64 块批量写入、一次批次一次索引刷新，以及查询/文档向量归一化。界面分别记录模型加载、文档向量化、seekdb 写入、索引刷新、查询向量化、数据库检索和端到端耗时。

## 实测记录

固定条件：Edge 143、Windows x64、浏览器缓存已存在模型文件；测试语料 `public/sample-knowledge.txt`；查询“浏览器不支持 GPU 时怎么办”；seekdb 使用官方本地服务容器。界面确认实际后端为 `WEBGPU · INT8`。首次样例导入为 1 个默认块：向量化 1.95 s、数据库写入 116 ms、索引刷新 510 ms；预热后的增量块向量化 203 ms（4.93 块/秒）、写入 102 ms、刷新 711 ms。查询向量化 297 ms、seekdb 数据库内混合检索 119 ms、端到端 441 ms，相关 WebGPU/WASM 段落 Top-1 命中（冒烟查询 1/1）。集合计数从 1 增至 2，新建隔离集合为 0，验证增量写入和集合隔离。

| 配置 | 模型体积 | 预热向量化 | seekdb 检索 | 端到端查询 | 质量记录 |
| --- | ---: | ---: | ---: | ---: | ---: |
| INT8 + WebGPU | 22.9 MB | 203 ms/块 | 119 ms | 441 ms | Top-1 1/1 |

模型仓库同口径 FP32 权重约 90.4 MB，INT8 为 22.9 MB，体积减少约 74.7%，压缩比约 3.95x。本机 WebGPU 可用，因此自动回退分支未触发；WASM 路径由相同 INT8 权重与归一化逻辑执行。本文不把未运行的 FP32 或 WASM 数值写成实测结果。
