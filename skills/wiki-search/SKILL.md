---
name: wiki-search
description: 在 LLM-Wiki 知识库（{{VAULT}}）中检索知识。当用户问"之前怎么做的、以前的决策、踩坑经验、某主题的知识"或明确提到 LLM-Wiki/知识库/wiki 时使用。入口：分类索引页粗筛 → wiki-find 排序检索 → read 精读原文 → 引用页面路径。
---

# LLM-Wiki 知识检索

> LLM-Wiki 是 Karpathy 模式的 Obsidian 知识库（866 页，管线自动编译）。检索纪律：**先搜索、后精读、引用原文路径，禁止凭记忆编造知识库内容**。

## 库结构（12 分类，根：{{VAULT}}/wiki/）

| 分类 | 目录 | 内容 |
|---|---|---|
| 决策 | wiki/决策/ | ADR、架构选型、决策记录 |
| 发现 | wiki/发现/ | 会话复盘、踩坑经验、性能优化 |
| 引用 | wiki/引用/ | 网页剪藏（原文链接+摘要） |
| 概念 | wiki/概念/ | 领域概念（LLM-Wiki理念 等） |
| 项目 | wiki/项目/ | 项目知识页（Pi-Agent、gsd-v2 等） |
| 流程/命令/规则/提示/记忆 | 对应目录 | 工作流、常用命令、红线、提示词、日志 |

> `wiki/索引/` 与 `wiki/index.md` 由管线生成，**不是知识分类**；管线不会收录它们。

## 默认流程

1. **导航优先**：先读分类索引页 `wiki/索引/<分类>.md`（**管线生成**，按质量分排序，每行带 `q<分数> · <信任分级>`）——已知分类时直接读索引比搜索快。
   - 索引页由 `llm-wiki-pipeline.mjs --index` 重建。若该文件不存在，说明还没跑过 index 阶段：先跑一次 `node ~/bin/llm-wiki-pipeline.mjs --index`。
2. **排序检索**：执行 `node ~/bin/wiki-find.mjs "<关键词>" --top 10`。
   - 输出按标题/标签/摘要/正文加权 + `quality_score` + 信任分级 + 新鲜度排序；`<superseded>` / `<stale>` 标记的页面已在输出里标出。
   - 加 `--json` 拿结构化结果，`--cat 决策` 限定分类。
   - **⚠️ 这不是精确检索**：中文分词由 2-gram 近似（项目零依赖），"部署流程"这类词有效，但会有噪声命中（"流程"命中"流程化"）。**分数只用于排序，用于判断"要不要读原文"，不能当作相关性结论。**
3. **精读原文**：命中后 `read` 目标文件。**先读 frontmatter 预判**（前 20 行）：`type` 页面类型、`description` 摘要、`related` 关联页、`stale_after`/`status` 新鲜度——不相关或已过时（当前日期 > stale_after 或 status: stale）直接跳过，相关再全文精读，避免无效精读。
4. **行级定位**：需要定位时 `rg -n "<关键词>" <文件>` 获取行号与内容。
   - 全库粗搜作为兜底：`rg -l "<关键词>" {{VAULT}}/wiki/ --glob "*.md"`（**结果按目录顺序返回，无排序**，只在上两条都拿不到结果时用）。
5. **引用**：回答时给出 wiki 页面相对路径（如 `wiki/决策/子代理模型选型与分配.md`）；溯源优先用 frontmatter 的 `sources` 字段（OKF 规范，含原始资源路径/链接），缺失时回退正文 Read Original 链接。

## 失败处理

| 场景 | 处理 |
|---|---|
| 搜索无命中 | 换关键词/同义词重试（wiki-find 与 rg 都试）；仍无则明确说"知识库未收录" |
| 只有旧日志命中 | 用 `log.md` 按 `## [YYYY-MM-DD] compile` 找编译记录定位页面 |
| 用户问的是偏好/协作规则 | 优先查热记忆（MEMORY.md）而非 wiki |
| 深度语义（"之前聊过的 X"） | 用 mnemon_recall（记忆体召回） |
| 页面有用/已过时 | 用 `node ~/bin/llm-wiki-pipeline.mjs --rate <路径> --rating useful\|outdated` 反馈（驱动 quality_score 闭环）。**路径必须是 vault 根下的相对路径且以 `wiki/` 开头** —— 管线会拒绝越界路径、符号链接穿透、以及 raw/ 与会话导出（那两类不是知识页）；`outdated` 会同时撤销该页的 `verified` 标记 |
| 命中页已过时（stale_after 已过 / status: stale） | 引用时明确标注可能过时，优先找相关新页面或按 sources 字段回原始来源核实 |
| `wiki-find` 明显漏了已知页面 | 它的 2-gram 无法跨语言/跨词形（"DEPLOY" 搜不到"部署"）。用同义词再搜一次，或退回 `rg` 兜底 |

## 写入纪律（产出侧协作）

- 会话中学到新知识：按 vault 根 `schema.md` 守则写入对应分类（管线自动维护 frontmatter/关联/质量）。
- 写作规则：中文标题；每页 >=2 条 [[wikilinks]]；写入前先搜索避免重复；不硬编码密钥。
