# dsh-llm-wiki

> Karpathy LLM Wiki 模式的 DeepSeek Harness 知识库系统：模型写 wiki、管线维护、记忆体召回、质量闭环。
> 对齐 [Google Research WikiSkill](https://arxiv.org/abs/2608.27454) 三层架构 + [OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format) 知识格式规范。

基于 [Karpathy 的 LLM Wiki 理念](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 的 Obsidian 知识库自动化方案。整套系统由 **1 个极简插件 + 2 个技能 + 1 个管线脚本 + 1 个向量代理服务** 组成，刻意保持低代码、零第三方插件依赖。

## 架构

```
写：wiki-write SKILL → 模型会话内写 Obsidian wiki 页面（frontmatter/wikilink 规范）
管：llm-wiki-pipeline.mjs（lint/okf/compile-patterns/索引/记忆体同步/usage/rate，零依赖，幂等）
     ├─ systemd timer 每日 10:00 自动运行
     └─ 插件 session/disposed 事件触发（60s 防重入）
记：mnemon 记忆体（向量语义召回）
读：wiki-search SKILL（rg + read 检索原文）
馈：--rate 质量反馈 / --usage 召回热度回写 queried_count
编：--compile-patterns 从孤立节点聚类生成 pattern 页（WikiSkill 核心创新）
向：embed-proxy.mjs（Ollama 兼容代理 → SiliconFlow /v1/embeddings，可选）
```

| 组件 | 文件 | 部署位置 |
|---|---|---|
| 生命周期插件 | plugin/dsh-llm-wiki.mjs | ~/.dsh/profiles/web/（cordis.patch.yml 挂载） |
| 检索技能 | skills/wiki-search/SKILL.md | ~/.agents/skills/wiki-search/ |
| 写入技能 | skills/wiki-write/SKILL.md | ~/.agents/skills/wiki-write/ |
| 管线 | scripts/llm-wiki-pipeline.mjs | ~/bin/ |
| 向量代理 | scripts/embed-proxy.mjs | ~/bin/ + systemd 服务 |
| 定时 | systemd/llm-wiki-pipeline.timer | ~/.config/systemd/user/ |

## 依赖

- dsh >= 0.1.1-rc.2（web profile）
- Node.js >= 22.19（管线用 node:sqlite）
- ripgrep（wiki-search 检索）
- mnemon CLI + dsh-mnemon 插件（记忆体）
- Obsidian vault（wiki 页面），目录结构见 [wiki 结构](#wiki-结构)
- SiliconFlow API key（可选，用于向量召回；复用 ~/.modlens/config.json 或环境变量 EMBED_KEY）

## 安装

**方式 A：bundle 包（推荐，含插件）**

```bash
# F7-7：固定到具体 commit，不要跟分支。插件运行在 dsh-web 进程内、能读整个 vault
# 并把内容注入系统提示词 —— 它不是「装坏了删掉就行」的东西，而跟分支意味着
# 上游任何一次推送都会自动进入你的 dsh-web 进程。
dsh plugin --profile web add "github:iwtown/dsh-llm-wiki#<commit-sha>"
```

然后安装 SKILL / 管线 / systemd 服务（install.sh 只做这一步也行）：

```bash
git clone https://github.com/iwtown/dsh-llm-wiki.git
cd dsh-llm-wiki
git checkout <commit-sha>          # 与上面保持一致
./install.sh --dry-run             # 先看要做什么，不写任何文件
./install.sh --vault /path/to/vault
systemctl --user restart dsh-web   # 让插件生效
```

**方式 B：install.sh 全量本地部署**（插件为 profile 本地文件，零 npm/零 node_modules，最反脆弱）

```bash
git clone https://github.com/iwtown/dsh-llm-wiki.git
cd dsh-llm-wiki && ./install.sh
systemctl --user restart dsh-web
```

`install.sh` 参数：

| 参数 | 说明 |
|---|---|
| `--vault PATH` | vault 根目录（默认 `$LLM_WIKI_VAULT`，再默认 `/mnt/d/DB/Obsidian/LLM-Wiki`） |
| `--dry-run` | 只打印将要做的事，不写任何文件 |
| `--enable-services` | 同时启用 systemd 用户服务（**默认只安装单元文件，不启用**） |

脚本做的事：

1. **预检 vault**：目录不存在则打印原因并 `exit 3`，不创建任何文件。
2. **替换 SKILL 里的 `{{VAULT}}`** 为 `--vault` 指定的路径，并把同一路径写进 `cordis.patch.yml` 的 `config.vault`。
3. 追加 `cordis.patch.yml` 前**先备份**，并确保原文件以换行结尾（否则追加的 `- insert:` 会与上一行粘连成 `key: value- insert:`，整个 YAML 损坏）。
4. 复制 `scripts/lib/*.mjs` 到 `~/bin/lib/`（管线在 O1/O2 后 import 这两个文件，漏掉会在运行时 `ERR_MODULE_NOT_FOUND`）。

然后：

1. **配置 vault 路径**：`--vault` 已同时写入插件配置与 SKILL；管线可用环境变量 `LLM_WIKI_VAULT` 覆盖
2. **自检**：`node ~/bin/llm-wiki-pipeline.mjs --all --dry-run`（零写入）
3. **首次记忆体同步**：`node ~/bin/llm-wiki-pipeline.mjs --sync`（把 wiki 精华导入 mnemon）
4. **可选向量**：确认 embed-proxy 服务运行后 `mnemon embed --all` 补齐向量

## 使用

- **写入知识**：直接说"把这个记到知识库"，模型按 wiki-write 技能写入对应分类
- **检索知识**：问"之前怎么做的"，模型按 wiki-search 技能检索并引用原文
- **手动管线**：`node ~/bin/llm-wiki-pipeline.mjs --all`（安全阶段；破坏性阶段需点名，见下）
- **摄取外部文档**：`node ~/bin/wiki-convert.mjs 文件.html --inbox "$VAULT/raw/inbox" --sources "$VAULT/raw/sources"`，再由模型按 wiki-write 落位（见下）
- **质量反馈**：`node ~/bin/llm-wiki-pipeline.mjs --rate wiki/决策/xxx.md --rating useful|outdated`
  - 路径必须是 vault 根下的相对路径且以 `wiki/` 开头：管线会拒绝越界路径（含 `../`、绝对路径）、经符号链接指向 vault 外的路径，以及 `raw/` 与会话导出（它们不是知识页）。
  - `outdated` 会同时**撤销该页的 `verified` 标记** —— 页面既被判为过时，自动核验的结论也随之失效。

### 管线路由

```bash
# 安全阶段 —— --all 现在只跑这些（零破坏性）
node ~/bin/llm-wiki-pipeline.mjs --lint          # frontmatter 完整性 + YAML 子集校验 + type↔目录 + related 悬空链接 + stale 报告
node ~/bin/llm-wiki-pipeline.mjs --okf           # OKF v0.2 字段补齐 + 旧字符串字段规范化为受控子集 YAML（幂等）
node ~/bin/llm-wiki-pipeline.mjs --index         # 重建导航页（页面数为 0 时拒绝覆盖）
node ~/bin/llm-wiki-pipeline.mjs --sync          # 变更同步到 mnemon 记忆体
node ~/bin/llm-wiki-pipeline.mjs --usage         # 回写召回热度到 frontmatter
node ~/bin/llm-wiki-pipeline.mjs --docs-sync     # mnemon Documents 回流为 wiki 页
node ~/bin/llm-wiki-pipeline.mjs --all           # 上述安全阶段
node ~/bin/llm-wiki-pipeline.mjs --all --dry-run # 预览模式（零写入）

# 破坏性 / 显式阶段 —— 不再隐含在 --all 里，必须点名
node ~/bin/llm-wiki-pipeline.mjs --prune-memory     # 软删来源已消失的记忆体条目（三重保险，见下）
node ~/bin/llm-wiki-pipeline.mjs --dsh-export       # 导出 DSH 会话到 raw/sessions/dsh/
node ~/bin/llm-wiki-pipeline.mjs --compile-patterns # 从孤立节点聚类生成 pattern 页
```

`--prune-memory` 是全项目唯一会**批量删除持久化数据**的操作，它判定「孤儿」的唯一依据是
「vault 里找不到这个文件」—— 挂载缺失时这个判断会把整个记忆体判成孤儿。三道保险任一触发即拒绝：

| 保险 | 触发条件 | 对应现实 |
|---|---|---|
| vault 健康 | vault 或 `wiki/` 不存在 | 路径都不对时「删除」没有依据（`--force` 也不能越过这道） |
| 页面数下限 | wiki 页面数 < 10 | 典型原因是 D 盘未挂载 |
| 待删比例 | 待删 > 20% | 典型原因是路径配错，于是「全部页面都不存在」 |

vault 不健康时，管线会中止全部阶段、只输出诊断，并返回**退出码 3**（与 `install.sh` 的 vault 预检失败一致）。

### 文档摄取（可选）

外部文档不进 `wiki/`，先落到**暂存区**，再由模型按 wiki-write 落位。转换是**独立进程**，
不是插件内的函数调用 —— 一个 PDF 解析器崩溃不该带走整个 dsh-web 会话。

```bash
node ~/bin/wiki-convert.mjs 文件.html \
  --inbox "$VAULT/raw/inbox" --sources "$VAULT/raw/sources" --json
```

| 路径 | 内容 |
|---|---|
| `raw/inbox/<sha256 前 16 位>.md` | 转换产物（待模型落位） |
| `raw/sources/<sha256>.<ext>` | 原件，`fidelity: lossy` 时必需 |

产物 frontmatter 的七个必填字段：`title` / `source` / `sha256` / `original_name` /
`converted_by`（**必须带版本号**，如 `convert-html@0.1.0`）/ `converted_at` / `fidelity`。
`converted_by` 带版本号是为了将来能精确找出「哪些页是旧工具转的」**只重转那一批** ——
无差别重跑会覆盖模型在落位时写进去的分类、标题与 wikilink，等于把写时语义工作白做一遍。

**四条硬约束**：

1. **身份是原件的哈希，不是产物的哈希。** 用产物哈希去重，会让「同一份 PDF 转两次」变成两个文档。
2. **非 0 退出不留文件。** 转换器自己 `tmp + rename`，调度器再按目录 diff 兜底 —— 连 `kill -9` 也不会留下半截产物。
3. **`fidelity: lossy` 必须留原件。** 原件是唯一的**验证 oracle**：转录错 5% 没有任何 diff 能发现，原件删掉就永久不可复证。
4. **转换器不写 `wiki/`。** 它不认识 11 个分类，硬猜会撞 `type_dir` 校验；分类与标题由模型在落位时决定。

`fidelity` 由转换器按**输入格式**声明，**不由模型自评** —— 模型说「我已完整覆盖」是不可审计的，
按格式查表才是确定性、可测、可复现的。

| 输入格式 | fidelity | 原件 |
|---|---|---|
| 纯文本 / markdown / 源码 | `lossless` | 可弃 |
| HTML / 网页正文 | `lossy`（样式丢弃） | 保留，或保留 URL |
| DOCX / PPTX / XLSX、PDF（文字版） | `lossy`（版式、公式、批注、表格结构） | 保留 |
| PDF（扫描件）、图片 / 截图、音视频 | `lossy`（OCR / 描述错误率不可忽略） | 必须保留 |

**现有转换器**：`convert-html`（Go，静态单文件，约 3.7 MB）。
构建：`npm run build:converters`（或 `bash scripts/build-converters.sh`）。
产物 `converters/bin/` 不进版本库。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| LLM_WIKI_VAULT | /mnt/d/DB/Obsidian/LLM-Wiki | vault 路径（不存在时管线中止并返回退出码 3） |
| LLM_WIKI_STATE | ~/.dsh/llm-wiki/pipeline-state.json | 管线增量状态文件（schema 2：存语义指纹；旧版 mtime 状态会被识别为过期并触发一次全量重算） |
| LLM_WIKI_PIPELINE | ~/bin/llm-wiki-pipeline.mjs | 插件触发的管线脚本路径 |
| EMBED_KEY | 读 ~/.modlens/config.json | SiliconFlow API key |
| EMBED_MODEL | BAAI/bge-m3 | 向量模型 |
| EMBED_PORT | 11434 | embed-proxy 监听端口（挪到 11500 需 mnemon 支持 OLLAMA_HOST，未验证） |
| LLM_WIKI_CONVERTERS | （未设） | 转换器搜索目录，优先于 `converters/bin/` 与 `~/bin` |

## wiki 结构

```
LLM-Wiki/
├── schema.md                # 运行时守则（插件注入到系统提示）
├── log.md                   # 操作日志（管线追加）
├── raw/                     # [Raw Layer] 原始素材（追加写入，永不删除）
│   ├── sessions/dsh/        # DSH 会话导出（管线 --dsh-export 自动生成）
│   └── zinbox-index/        # ZInBox 剪藏原始源
├── wiki/                    # [Wiki Layer] 编译后的结构化知识
│   ├── index.md             # 导航页（管线 --index 自动生成）
│   ├── evolution/
│   │   ├── logs.md          # 编译日志（pattern 创建/合并/归档事件）
│   │   └── skill-impact.md  # 技能影响追踪表
│   ├── patterns/            # WikiSkill 模式页（管线 --compile-patterns 自动生成）
│   │   ├── TEMPLATE.md      # Pattern 页模板
│   │   └── *-pattern.md     # 自动生成的可复用经验页
│   └── <12 分类>/           # 发现/决策/概念/流程/命令/规则/提示/记忆/项目/引用/索引/基因
└── skills/                  # [Skills Layer] 可执行技能追溯（扩展点）
    └── _template/PURPOSE.md # Skill 回溯到 inspire 它的 pattern 页
```

### OKF v0.2 字段

| 字段 | 类型 | 写入方 | 说明 |
|---|---|---|---|
| `sources` | `string[]` | 模型填写；管线 okfAlign 补全 | 知识来源（URL / session / 配置路径） |
| `generated` | `{ by, at }` | 管线自动补充 | 生成者（`agent/dsh-llm-wiki` 或 `human:<id>`） |
| `verified` | `{ by, at }` | quality_score≥4 自动标记 / --rate 确认 | 信任分级：agent verified / human reviewed |
| `status` | `active\|draft\|archived` | 管线 stale 检测 + --rate 更新 | 生命周期状态 |
| `stale_after` | ISO 日期 | 管线 okfAlign 自动计算 | created/updated + 90 天 |
| `description` | `string` | 管线 okfAlign 从内容摘要推导 | 一句话知识描述 |
| `quality_score` | 1-5 | 管线 usage 回写 + --rate 更新 | 知识质量评分 |

### 信任分级

| 级别 | 条件 | 置信度 |
|---|---|---|
| ✅ human-reviewed | `verified.by` 含 `human:` | 高置信，优先召回 |
| ⚙️ machine-confirmed | `quality_score ≥ 4` 且无 human verified | 中置信，管线自动验证 |
| ⚠️ unverified | 新页面或 `quality_score < 3` | 低置信，需人工确认 |

## WikiSkill 三层架构对齐

| WikiSkill 层 | dsh-llm-wiki 对应 | 说明 |
|---|---|---|
| **Raw Layer** | `raw/sessions/`, `raw/zinbox-index/` | 原始素材；管线 `--dsh-export` 自动导入 |
| **Wiki Layer** | `wiki/`（12 分类 + patterns/ + evolution/） | 结构化知识；管线 `--lint/--okf/--compile-patterns` 自动维护 |
| **Skills Layer** | `skills/` + DSH `~/.agents/skills/` | 可执行技能；每个 skill 可选配 `PURPOSE.md` 回溯 pattern |

核心创新：**Pattern 层** — 从孤立节点聚类提取可复用经验，由管线 `--compile-patterns` 自动生成，写入 `wiki/evolution/logs.md` 编译日志。

## 测试

零依赖，用 Node 内置测试运行器：

```bash
npm test          # = node --test（自动发现 test/ 下的 *.test.mjs）
```

`test/frontmatter.test.mjs` 覆盖受控 YAML 子集的解析/序列化/规范化，`test/change-detection.test.mjs` 覆盖语义指纹与五种典型改动的判定，`test/pipeline-e2e.test.mjs` 把管线当黑盒跑在临时 vault 上（用 PATH 上的 mnemon stub，不需要真记忆体，也不会碰真实 vault）。

## 设计原则

- **反脆弱**：检索/写入用 SKILL + DSH 原生工具（零插件故障面）；只有"必须进程内"的注入与事件钩子才进插件（~90 行）
- **幂等**：变更检测按**语义指纹**（分类/标题/描述/项目/质量分/状态/标签/信任分级/是否退役）而非 mtime，重复运行无副作用；`--okf` / `--compile-patterns` 均幂等
- **闭环**：使用数据（recall 命中）→ queried_count → quality_score → 影响召回 → verified 信任分级（信任分级直接决定召回权重：human-reviewed 5 / machine-confirmed 4 / unverified 3）
- **元数据可回读**：frontmatter 由受控 YAML 子集解析（标量 / 内联数组 / 块序列 / 内联映射 / 块映射），超出子集即报错而非静默误读 —— 管线写下的字段，管线自己必须读得回来
- **本地优先**：wiki 与记忆体全本地，向量可选云端
- **编译进化**：孤立节点 → pattern 聚类 → 可复用经验，知识随使用不断提炼

## License

MIT
