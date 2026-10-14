#!/usr/bin/env node
/**
 * llm-wiki-pipeline.mjs —— LLM-Wiki 后处理管线（P2）
 * lint → 索引重建 → 记忆体同步 → log.md。零外部依赖。
 * 用法: node llm-wiki-pipeline.mjs [--lint] [--index] [--sync] [--all] [--dry-run]
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
// 而 Node ≥22.15 内置 zstdDecompressSync —— 少一个外部依赖，少一种「装了但跑不了」。
import { zstdDecompressSync } from "node:zlib";
import { CATS, extractFmText, parseFm, parseFmYaml, setFmField, deleteFmField, repairStructuredFields } from "./lib/frontmatter.mjs";
import { STATE_SCHEMA, pageHashes, changedPages, stateEntry, trustTier, isRetired, TRUST_IMPORTANCE } from "./lib/hash.mjs";
import { normalize } from "./lib/search.mjs";
import { safeJoinVault, isInside } from "./lib/paths.mjs";
import { safeTitle, isSuspiciousTitle } from "./lib/sanitize.mjs";
import { redactSecrets, capLogLines } from "./lib/redact.mjs";
import { acquireLock, releaseLock, atomicWrite, safeWritePage, lockHolder } from "./lib/pipeline-io.mjs";
const execFileAsync = promisify(execFile);

// 管道截断（如 head 关闭）不崩溃：忽略 stdout/stderr 的 EPIPE
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
import { createServer } from "node:http";

const VAULT = process.env.LLM_WIKI_VAULT || "/mnt/d/DB/Obsidian/LLM-Wiki";
const WIKI = join(VAULT, "wiki");
const STATE_DIR = join(homedir(), ".dsh/llm-wiki");
const STATE_FILE = process.env.LLM_WIKI_STATE || join(STATE_DIR, "pipeline-state.json");
const FAKE_EMBED = process.env.LLM_WIKI_FAKE_EMBED || "auto";
const EXCLUDE_DIRS = new Set(["_archived", "trash", ".smart-env", "索引"]);
const STALE_DAYS = 90;
// 生成目录：由管线自己写，不属于知识分类（F2 用来说明「为什么 wiki/ 为空仍可能是健康的」）
const GENERATED_DIRS = ["索引", "patterns", "evolution"];

// ── F5：会话导出 —— 默认关闭 + 显式 opt-in + 输出默认迁出 Obsidian vault ──
// 问题（H5）：`--dsh-export` 把 user/assistant 全文写进 VAULT/raw/sessions/dsh/，
// 插件每次 session/disposed 都会触发 → 静默、无逐会话同意。而 vault 在 /mnt/d：
// Windows 可写、可能被 Obsidian 同步或共享。技能文件写着「密钥不入库」，但会话里
// **粘贴过**的密钥会以「会话复盘」的形式落进同一个 vault —— 规则管得住主动写入，
// 管不住顺手粘进对话。
// 三层防线（缺一不可）：
// ── F2：破坏性操作的保险阈值 ──
// 原则：宁可不做，不可做错。删错的记忆体没法恢复，漏跑一次只是晚一天。
const PRUNE_MIN_PAGES = 10;    // wiki 页面数低于此值 → 拒绝批量软删（典型原因：D 盘没挂载）
const PRUNE_MAX_RATIO = 0.20;  // 单次待删比例高于此值 → 拒绝（典型原因：路径配错，全部「不存在」）

/** vault 结构性健康检查，返回问题列表（空数组 = 健康）。
 *  这是所有破坏性写入的前置闸门，也是 main() 的总闸。 */
function vaultHealth() {
  const problems = [];
  if (!existsSync(VAULT)) {
    problems.push("vault 不存在: " + VAULT);
    return problems;                       // 不存在就没必要再查子路径
  }
  try {
    if (!statSync(VAULT).isDirectory()) problems.push("vault 不是目录: " + VAULT);
  } catch { problems.push("vault 无法 stat: " + VAULT); }
  if (!existsSync(WIKI)) problems.push("wiki/ 不存在（vault 未挂载或路径不对）");
  return problems;
}

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const DRY = args.has("--dry-run");
const FORCE = args.has("--force");   // 只解除「数量/比例」两道保险，不解除健康检查

// ── F3：路由拆分 —— 破坏性阶段不再隐含在 --all 里 ──
const SAFE_STAGES = ["--lint", "--index", "--sync", "--usage", "--okf", "--docs-sync"];
const DESTRUCTIVE_STAGES = ["--prune-memory", "--dsh-export"];
const EXPLICIT_ONLY = ["--compile-patterns"];   // 会写 patterns/evolution，既不属于安全集也不隐含全量
const STAGE_FLAGS = [...SAFE_STAGES, ...DESTRUCTIVE_STAGES, ...EXPLICIT_ONLY, "--rate"];

// 「全量」= 没有点名任何阶段。--all 现在只跑六个安全阶段。
const doAll = ![...args].some(a => STAGE_FLAGS.includes(a));
const RUN = {
  lint: doAll || args.has("--lint"),
  index: doAll || args.has("--index"),
  sync: doAll || args.has("--sync"),
  usage: doAll || args.has("--usage"),
  okf: doAll || args.has("--okf"),
  docs: doAll || args.has("--docs-sync"),
  compilePatterns: args.has("--compile-patterns"),   // 只认显式
  prune: args.has("--prune-memory"),                 // 移出 --all：会软删记忆体
  dsh: args.has("--dsh-export"),                     // 移出 --all：会把会话记录落盘
};
const RATE_TARGET = rawArgs[rawArgs.indexOf("--rate") + 1];
const RATE_VALUE = rawArgs[rawArgs.indexOf("--rating") + 1];
const DO_RATE = args.has("--rate") && RATE_TARGET && RATE_VALUE;

// frontmatter 的定位 / 解析 / 序列化已抽到 scripts/lib/frontmatter.mjs（O1：受控子集 + 严格诊断，可单测）
// extractFmText / parseFm / parseFmYaml / fmSerialize / setFmField / setFmRaw / setFmSeq / repairStructuredFields

/** 写入磁盘后刷新内存页：哈希检测必须基于**盘上的真实内容**，否则同一轮 --all 里
 *  okf 补的 description 不会被 sync 看到，状态里存的是已经不存在的内容的哈希。 */
function refreshPage(p) {
  try {
    p.content = readFileSync(p.full, "utf8");
    const blk = extractFmText(p.content);
    const parsed = blk ? parseFmYaml(blk.fm) : { data: {}, errors: [] };
    p.fm = parsed.data;
    p.fmErrors = parsed.errors;
    p.fmEnd = blk ? blk.end : -1;
    p.body = blk ? p.content.slice(blk.end + 4) : p.content;
    const st = statSync(p.full);
    p.mtime = st.mtimeMs;
    p.size = st.size;
    p.hashes = pageHashes(p);
  } catch {}
  return p;
}

// --rate: 手动质量反馈（useful +1 分 / outdated 标 stale）
function ratePage(rel, rating, { dry = DRY } = {}) {
  // F1：路径守卫。--rate 的入参由模型/命令行给出，未校验时 `../../x.md` 能改写 vault 外任意文件。
  // 分四步给出精确诊断（越界 / 非 .md / 非 wiki / 不存在），最后一步用 mustExist:true 穿透符号链接复查。
  const pre = safeJoinVault(rel, VAULT, { mustExist: false, ext: null });
  if (!pre) return { error: "拒绝：路径非法或越出 vault: " + rel };
  if (!pre.full.endsWith(".md")) return { error: "拒绝：只接受 .md 文件: " + rel };
  if (!pre.rel.startsWith("wiki/")) {
    return { error: "拒绝：只能给 wiki/ 下的知识页打分（不接受 raw/ 与会话导出）: " + pre.rel };
  }
  if (!existsSync(pre.full)) return { error: "文件不存在: " + rel };
  const hit = safeJoinVault(rel, VAULT);
  if (!hit) return { error: "拒绝：路径经符号链接指向 vault 外: " + rel };
  const full = hit.full;

  let content = readFileSync(full, "utf8");
  const fm = parseFm(content);
  const today = new Date().toISOString().slice(0, 10);
  if (rating === "useful") {
    const cur = Number(fm.quality_score) || 0;
    content = setFmField(content, "quality_score", Math.min(cur + 1, 5));
    content = setFmField(content, "queried_count", (Number(fm.queried_count) || 0) + 1);
    content = setFmField(content, "last_queried", today);
    if (fm.status === "stale") content = setFmField(content, "status", "active");
    if (dry) return { ok: true, rel: hit.rel, score: Math.min(cur + 1, 5), note: "(--dry-run) 未写入" };
    atomicWrite(full, content);
    return { ok: true, rel: hit.rel, score: Math.min(cur + 1, 5), note: "useful 反馈，quality_score 提升" };
  }
  if (rating === "outdated") {
    const cur = Number(fm.quality_score) || 0;
    content = setFmField(content, "quality_score", Math.max(cur - 1, 0));
    content = setFmField(content, "status", "stale");
    content = setFmField(content, "last_queried", today);
    // 撤销 machine-confirmed 信任标记：页面既被判为过时，自动核验的结论也随之失效。
    // 否则 okfAlign 写的 verified 会永久留在页面上，继续把它伪装成「已验证内容」。
    content = deleteFmField(content, "verified");
    if (dry) return { ok: true, rel: hit.rel, score: Math.max(cur - 1, 0), note: "(--dry-run) 未写入" };
    atomicWrite(full, content);
    return { ok: true, rel: hit.rel, score: Math.max(cur - 1, 0), note: "outdated 反馈，标记 stale 并撤销 verified" };
  }
  return { error: "rating 必须是 useful 或 outdated" };
}

// --usage: 从 mnemon 记忆体提取召回热度，回写 queried_count/last_queried
function usageSync(pages) {
  const conflicts = [];   // O3
  const errors = [];
  let db;
  try { db = new DatabaseSync(join(homedir(), ".mnemon/data/default/mnemon.db"), { readOnly: true }); }
  catch (e) { return { error: "无法打开 mnemon db: " + e.message }; }
  try {
    const rows = db.prepare("SELECT content, access_count, last_accessed_at FROM insights WHERE content LIKE ? AND deleted_at IS NULL").all("%来源: wiki/%");
    const byRel = new Map();
    for (const r of rows) {
      const m = String(r.content).match(/来源: ([^）)]+)/);
      if (!m) continue;
      const rel = m[1].trim();
      if (!byRel.has(rel)) byRel.set(rel, { count: 0, last: "" });
      const e = byRel.get(rel);
      e.count = Math.max(e.count, Number(r.access_count) || 0);
      if (r.last_accessed_at && String(r.last_accessed_at) > e.last) e.last = String(r.last_accessed_at).slice(0, 10);
    }
    let updated = 0;
    for (const p of pages) {
      const u = byRel.get(p.rel);
      if (!u || u.count <= 0) continue;
      const cur = Number(p.fm.queried_count) || 0;
      if (u.count > cur || (u.last && u.last !== p.fm.last_queried)) {
        let content = p.content;
        content = setFmField(content, "queried_count", u.count);
        if (u.last) content = setFmField(content, "last_queried", u.last);
        if (content !== p.content) {
          const w = safeWritePage(p, content);
          if (w.skipped) { conflicts.push(p.rel); continue; }
          if (w.error) { errors.push(p.rel + ": " + w.error); continue; }
          // O2：不再伪装 mtime。queried_count/last_queried 不进 draft 指纹，所以本来就不会触发重同步。
          refreshPage(p);
          updated++;
        }
      }
    }
    return { tracked: rows.length, updated, conflicts, errors };
  } finally { try { db.close(); } catch {} }
}

// ── OKF v0.2 对齐：补 description/sources/generated/stale_after（幂等，只补缺字段）──
function okfAlign(pages) {
  let updated = 0, aligned = 0, repaired = 0;
  const repairSample = [];
  const conflicts = [];   // O3：本轮被外部改过、我们主动放弃写的页
  const errors = [];
  for (const p of pages) {
    if (p.cat === "索引") continue;
    let content = p.content;
    const fm = p.fm;
    const today = new Date().toISOString().slice(0, 10);
    // O1 迁移：旧文件里被写成字符串的 sources/tags/related/… 规范化成真正的数组/映射
    const rep = repairStructuredFields(content);
    if (rep.repairs.length) {
      content = rep.content;
      repaired++;
      for (const r of rep.repairs) {
        if (repairSample.length < 5) repairSample.push(p.rel + " " + r.field + ": " + JSON.stringify(r.from) + " → " + JSON.stringify(r.to));
      }
    }
    // description：缺则从 summary 补；无 summary 则从正文首段提取（确定性摘要，幂等）
    if (!fm.description) {
      let desc = null;
      if (fm.summary && fm.summary !== "-") desc = fm.summary;
      else {
        const blk = extractFmText(content);
        if (blk) {
          const lines = content.slice(blk.end + 4).split(String.fromCharCode(10));
          let hIdx = -1;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().startsWith("#")) { hIdx = i; break; }
          }
          for (let i = hIdx + 1; i < lines.length; i++) {
            let s = lines[i].trim();
            if (s.length <= 10) continue;
            if (s.startsWith("#") || s.startsWith("!") || s.startsWith("|")) continue;
            if (s.startsWith("-") || s.startsWith("*") || s.charCodeAt(0) === 96) continue;
            const c0 = s.charCodeAt(0), c1 = s[1];
            if (c0 >= 48 && c0 <= 57 && (c1 === "." || c1 === ")" || c1 === "、")) continue;
            // 引用块/信息卡片：剥离 "> " 前缀后作为候选（callout 头如 [!info] 跳过）
            if (s.startsWith(">")) {
              while (s.startsWith(">")) s = s.slice(1).trim();
              if (!s || s.length <= 10 || s.startsWith("[")) continue;
            }
            desc = s.split(" ").filter(Boolean).join(" ").slice(0, 80);
            break;
          }
        }
      }
      if (desc) content = setFmField(content, "description", desc);
    }
    // sources：有 source 单值 → 转 OKF sources 数组（保留原 source 兼容）
    if (fm.source && !fm.sources) {
      content = setFmField(content, "sources", [{ resource: fm.source }]);
    }
    // generated：补 by/at（at 用 created/updated 日期近似 ISO）
    if (!fm.generated) {
      const at = (fm.updated || fm.created || today) + "T00:00:00Z";
      content = setFmField(content, "generated", { by: "agent/dsh-llm-wiki", at });
    }
    // verified：仅当质量分达标、未过期、未被取代、且非草稿时才自动标记
    // （否则 --rate useful 能把分数刷到 4，让被注入的页面顺着作者自己的闭环升格成"已验证知识"）
    if (!fm.verified && Number(fm.quality_score) >= 4
        && fm.status !== "stale" && fm.status !== "draft" && !fm.superseded_by) {
      const at = (fm.updated || fm.created || today) + "T00:00:00Z";
      content = setFmField(content, "verified", { by: "agent/dsh-llm-wiki", at });
    }
    // stale_after：created/updated + 90 天
    if (!fm.stale_after) {
      const base = fm.updated || fm.created;
      if (base) {
        const d = new Date(base); d.setDate(d.getDate() + STALE_DAYS);
        content = setFmField(content, "stale_after", d.toISOString().slice(0, 10) + "T00:00:00Z");
      }
    }
    if (content !== p.content) {
      // O3：写前复查 mtime。这一轮刚开始时 collectPages() 记下了 p.mtime；若 Obsidian
      // 在两次阶段之间编辑过同一页，stat 对不上就跳过——宁可少补一个 description，
      // 也不能把用户刚写的正文冲掉。
      const w = safeWritePage(p, content);
      if (w.skipped) { conflicts.push(p.rel); continue; }
      if (w.error) { errors.push(p.rel + ": " + w.error); continue; }
      // O2：不再恢复 mtime。--okf 补的 description 进 draft 指纹 → 这一轮就该同步，而不是永不
      refreshPage(p);
      updated++; aligned++;
    }
  }
  return { aligned, updated, repaired, repairSample, conflicts, errors };
}








// --compile-patterns: 扫描孤立节点，聚类高频主题，生成 wiki/patterns/ 页面
function compilePatterns(pages) {
  const patternsDir = join(WIKI, "patterns");
  const evolutionDir = join(WIKI, "evolution");
  const logsFile = join(evolutionDir, "logs.md");
  // F2：mkdirSync(recursive) 会在挂载缺失时沿 VAULT 路径在根文件系统上造出幽灵目录树
  // （实测创建过 log.md / wiki/evolution / wiki/patterns）。写入前先确认 vault 结构真的存在。
  const problems = vaultHealth();
  if (problems.length) return { skipped: true, reason: "vault 不健康，拒绝生成 pattern 页: " + problems.join("; ") };
  mkdirSync(patternsDir, { recursive: true });
  mkdirSync(evolutionDir, { recursive: true });
  const orphanPages = [];
  for (const pg of pages) {
    if (pg.cat === "索引") continue;
    // O2 顺带修复：旧代码用 pg.fmEnd（collectPages 从未设置过）→ undefined + 4 = NaN → slice(NaN) 取到全文，
    // 于是 frontmatter 里的 related 链接会把页面误判成"非孤立"
    const body = pg.body != null ? pg.body : pg.content;
    const linkCount = (body.match(/\[\[/g) || []).length;
    if (linkCount === 0) orphanPages.push(pg);
  }
  const byType = {};
  for (const pg of orphanPages) {
    const t = pg.fm.type || "unknown";
    if (!byType[t]) byType[t] = [];
    byType[t].push(pg);
  }
  const created = [];
  const today = new Date().toISOString().slice(0, 10);
  const logEntries = [];
  for (const [typ, ps] of Object.entries(byType)) {
    if (ps.length < 2) continue;
    const keywords = new Map();
    for (const pg of ps) {
      const title = pg.fm.title || pg.rel;
      const words = title.match(/[\u4e00-\u9fff]{2,4}/g) || [];
      for (const w of words) keywords.set(w, (keywords.get(w) || 0) + 1);
    }
    const topKeywords = [...keywords.entries()].filter(([, cnt]) => cnt >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
    if (topKeywords.length === 0) continue;
    const patternName = topKeywords[0] + "-pattern";
    const patternFile = join(patternsDir, patternName + ".md");
    if (existsSync(patternFile)) {
      let existing = readFileSync(patternFile, "utf8");
      const appendLine = ps.map(pp => "- [[" + pp.rel + "]]（" + (pp.fm.created || today) + "）").join("\n");
      const insertAfter = existing.indexOf("## 出现记录\n");
      if (insertAfter >= 0) {
        const insertAt = existing.indexOf("\n", insertAfter) + 1;
        existing = existing.slice(0, insertAt) + appendLine + "\n" + existing.slice(insertAt);
      }
      existing = existing.replace(/^updated: .+$/m, "updated: " + today);
      atomicWrite(patternFile, existing);
      logEntries.push("* **Pattern 更新**: [[wiki/patterns/" + patternName + "]] \u2014 追加 " + ps.length + " 条新证据");
    } else {
      const rl = ps.slice(0, 3).map(pp => "  - \"[[" + pp.rel + "]]\"").join("\n");
      const ar = ps.map(pp => "- [[" + pp.rel + "]]（" + (pp.fm.created || today) + "）").join("\n");
      const parts = [
        "---",
        'title: "' + topKeywords[0] + ' 模式"',
        "tags: [wiki/patterns, compiled, pattern]",
        'type: "pattern"',
        "created: " + today,
        "updated: " + today,
        "status: active",
        "related:",
        rl,
        "cssclasses: [pattern]",
        "---",
        "",
        "# " + topKeywords[0] + " 模式",
        "",
        "## 问题描述",
        "<该模式在 " + ps.length + " 个孤立页面中出现>",
        "",
        "## 根因",
        "<待分析>",
        "",
        "## 解决方案",
        "<待补充>",
        "",
        "## 出现记录",
        ar,
        "",
        "## 衍生技能",
        "- --",
      ];
      atomicWrite(patternFile, parts.join("\n"));
      created.push(patternName);
      logEntries.push("* **Pattern 新增**: [[wiki/patterns/" + patternName + "]] \u2014 从 " + ps.length + " 个 " + typ + " 孤立页聚类（关键词: " + topKeywords.join(", ") + "）");
    }
  }
  if (logEntries.length > 0) {
    // 幂等：检查是否已有今天的相同条目
    const existing = existsSync(logsFile) ? readFileSync(logsFile, "utf8") : "";
    const dupCheck = logEntries.every(e => !existing.includes(e));
    if (!dupCheck) { console.log("(--dry-run) 跳过重复日志条目"); return { created: created.length, orphans: orphanPages.length, patterns: created, skipped: "log" }; }
    let lc;
    if (existsSync(logsFile)) {
      // 已有文件：保留原样，只在今天的标题下插入 —— 别把过去的日志冲掉
      const el = readFileSync(logsFile, "utf8");
      const ip = el.indexOf("## " + today + "\n");
      if (ip >= 0) {
        const nn = el.indexOf("\n", ip);
        lc = el.slice(0, nn + 1) + "\n" + logEntries.join("\n") + "\n" + el.slice(nn + 1);
      } else {
        // 头部是标题块（# 编译日志 … 格式说明）。新日期段要落在说明之后、更早日段之前。
        // 找不到任何日段（fixture 是纯条目堆积）时，退到标题块末尾 —— **不能退到 el.length**：
        // 那会把今天的新条目拼到全文最后，而 F8 的封顶是「保留头部、砍尾部」，
        // 于是每天新写的行大概率一进入文件就被裁掉，日志变成永远的旧内容。
        const firstDay = el.search(/^## /m);
        let at;
        if (firstDay >= 0) {
          at = el.lastIndexOf("\n", firstDay) + 1;
        } else {
          // 标题块 = 从开头到第一个 "* " 条目行（或空行结束）之前
          const firstItem = el.search(/^\* /m);
          at = firstItem >= 0 ? el.lastIndexOf("\n", firstItem) + 1 : el.length;
        }
        lc = el.slice(0, at) + "\n## " + today + "\n" + logEntries.join("\n") + "\n" + el.slice(at);
      }
    } else {
      lc = "# 编译日志（Evolution Log）\n\n> 记录 wiki/patterns/ 的编译、合并、归档事件。\n> 格式：* **<类型>**: <详情>\n\n"
        + "## " + today + "\n" + logEntries.join("\n") + "\n";
    }
    // F8：封顶。两个整段都来自 newest-first 的插入点，所以保留头部（最新）即可。
    atomicWrite(logsFile, capLogLines(lc).text);
  }
  return { created: created.length, orphans: orphanPages.length, patterns: created };
}

// ── --dsh-export: 把 DSH 会话（~/.dsh/sessions/*/session-*/session.jsonl.zstd）导出为复盘 markdown 到 raw/sessions/dsh/
// 幂等：state.exportedDsh 记录 {sessionId: mtime}；只导出 user 文本 + assistant 正文（不导出 reasoning/工具详情）
const DSH_SESSIONS = join(homedir(), ".dsh/sessions");

// ── F5：会话导出的三道闸 ──────────────────────────────────────────────────────
// ① 默认关闭。把整段对话落盘是「需要时才做」的事，不该挂在生命周期钩子上。
// ② 默认写到 ~/.dsh/llm-wiki/ 下，**不落 vault**。vault 在 /mnt/d —— Windows 可写、
//    可能被 Obsidian 同步或共享，把对话全文放进去等于扩大了泄露面。
// ③ 只导最近一段，不再「全历史静默导出」。
//    三道闸都在 DSH_EXPORT_ENABLED 之后才谈得上；第一个没过就什么都不做。
// ① 默认关闭。不显式给 LLM_WIKI_EXPORT_SESSIONS=1 就什么都不做 —— 这是三道闸里
//    唯一能挡住「静默」的，后面两道都只是缩小爆炸半径。
const DSH_EXPORT_ENABLED = process.env.LLM_WIKI_EXPORT_SESSIONS === "1";
// ② 默认写到 ~/.dsh/llm-wiki/ 下，**不落 vault**。vault 在 /mnt/d —— Windows 可写、
//    可能被 Obsidian 同步或共享，把对话全文放进去等于扩大了泄露面。
const DSH_EXPORT_DIR = process.env.LLM_WIKI_EXPORT_DIR || join(dirname(STATE_FILE), "sessions-export");
// ③ 只导最近一段，不再「全历史静默导出」。这是「逐会话同意」在 CLI 语言里的替代品。
const DSH_EXPORT_DEFAULT_DAYS = 7;
const DSH_EXPORT_DEFAULT_LIMIT = 20;
// 窗口的两个旋钮：天数（环境变量，日常调）与绝对日期（--since，精确覆盖）。
// `--since 1970-01-01` = 全历史 —— 这是「确实要全导」的唯一显式写法，
// 不会是默认值，也不可能因为误操作触发。
const DSH_EXPORT_DAYS = Number(process.env.LLM_WIKI_EXPORT_DAYS) || DSH_EXPORT_DEFAULT_DAYS;
function argValue(nm) {
  const i = rawArgs.indexOf(nm);
  return i >= 0 && i + 1 < rawArgs.length ? rawArgs[i + 1] : null;
}
const DSH_EXPORT_SINCE = argValue("--since");
// 上限默认 20。Math.max(1, …)：显式给 --limit 0 会让整个 flag 变哑弹，宁可忽略也不沉默。
const DSH_EXPORT_LIMIT = Math.max(1, Number(argValue("--limit")) || DSH_EXPORT_DEFAULT_LIMIT);

function buildSessionMd(sessionId, raw) {
  const meta = { cwd: "", preset: "", createdAt: 0 };
  const blocks = [];
  let asstBuf = [];
  let curTurn = -1;
  const flush = () => {
    if (asstBuf.length) {
      const text = asstBuf.join("").trim();
      if (text) blocks.push({ role: "assistant", text });
      asstBuf = [];
    }
  };
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "session") {
      meta.cwd = ev.cwd || ""; meta.preset = ev.agentPreset || ""; meta.createdAt = ev.createdAt || 0;
    } else if (ev.type === "agent/inbox/spliced" && ev.data && Array.isArray(ev.data.inserted)) {
      for (const ins of ev.data.inserted) {
        if (ins.role === "user" && Array.isArray(ins.content)) {
          const text = ins.content.map(c => (c && c.text) || "").join("").trim();
          if (text) { flush(); blocks.push({ role: "user", text }); }
        }
      }
    } else if (ev.type === "text-chunks" && ev.data && Array.isArray(ev.data.texts)) {
      const turn = ev.data.turn || 0;
      if (turn !== curTurn) { flush(); curTurn = turn; }
      asstBuf.push(ev.data.texts.join(""));
    }
  }
  flush();
  // F5：脱敏。技能文件写着「密钥不入库」，但规则管得住「主动写入」，管不住
  // 「顺手粘进对话」—— 而会话复盘会落进 vault，vault 在 /mnt/d，可能被同步或共享。
  // 这是兜底，不是许可：脱敏永远漏得掉，所以主手段是「默认关闭 + 输出迁出 vault」。
  let redactedBlocks = 0;
  const safe = blocks.map(b => {
    const t = redactSecrets(b.text);
    if (t !== b.text) redactedBlocks++;
    return { role: b.role, text: t };
  });
  const date = meta.createdAt ? new Date(meta.createdAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const title = "DSH 会话复盘" + (meta.cwd ? "：" + String(meta.cwd).split("/").filter(Boolean).pop() : "");
  let md = "---\ntitle: \"" + title + "\"\ntags: [dsh, session]\ntype: \"发现\"\ncreated: " + date
    + "\nsource: \"dsh:" + sessionId + "\"\nredacted: " + (redactedBlocks > 0) + "\n---\n\n# " + title + "\n\n"
    + "- **会话**: " + sessionId
    + "\n- **工作目录**: " + (meta.cwd || "-")
    + "\n- **Agent 预设**: " + (meta.preset || "-")
    + "\n- **创建时间**: " + (meta.createdAt ? new Date(meta.createdAt).toISOString() : "-")
    + "\n- **消息块**: " + safe.length
    + (redactedBlocks ? "\n- **已脱敏块**: " + redactedBlocks : "")
    + "\n\n## 对话记录\n\n";
  for (const b of safe) {
    md += "### " + (b.role === "user" ? "用户" : "助手") + "\n\n" + b.text + "\n\n";
  }
  return md;
}

function dshSessionExport() {
  const state = loadState();
  const exported = state.exportedDsh || {};
  const outDir = DSH_EXPORT_DIR;
  mkdirSync(outDir, { recursive: true });

  // 用户确实把导出目录指回 vault 时，留一个哨兵并明说 —— 默认路径已经不在 vault 里了。
  let warnedInVault = false;
  try {
    if (isInside(outDir, VAULT)) {
      atomicWrite(join(outDir, ".no-sync"), "此目录含 DSH 会话全文，请把它排除出 Obsidian / 网盘同步。\n");
      warnedInVault = true;
    }
  } catch {}

  // ③ 先按 mtime 收集候选，再筛「最近 N 天」并取前 limit 个 —— 不再全历史导出。
  //    窗口边界 = LLM_WIKI_EXPORT_DAYS 天前；--since 给的绝对日期优先。
  const sinceMs = DSH_EXPORT_SINCE ? Date.parse(DSH_EXPORT_SINCE) : (Date.now() - DSH_EXPORT_DAYS * 86400_000);
  if (DSH_EXPORT_SINCE && Number.isNaN(sinceMs)) return { error: "--since 不是合法日期: " + DSH_EXPORT_SINCE };

  const candidates = [];
  try {
    for (const ws of readdirSync(DSH_SESSIONS)) {
      const wsDir = join(DSH_SESSIONS, ws);
      let sessionDirs;
      try { if (!statSync(wsDir).isDirectory()) continue; sessionDirs = readdirSync(wsDir); } catch { continue; }
      for (const sd of sessionDirs) {
        if (!sd.startsWith("session-")) continue;
        const sdir = join(wsDir, sd);
        const zf = join(sdir, "session.jsonl.zstd");
        try {
          if (!statSync(sdir).isDirectory() || !existsSync(zf)) continue;
          candidates.push({ sd, zf, mtimeMs: statSync(zf).mtimeMs });
        } catch {}
      }
    }
  } catch (e) { return { error: String(e.message || e).slice(0, 120) }; }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const inWindow = candidates.filter(c => c.mtimeMs >= sinceMs);
  const selected = inWindow.slice(0, DSH_EXPORT_LIMIT);

  let exportedNow = 0, skipped = 0;
  const results = [];
  for (const c of selected) {
    try {
      if (exported[c.sd] === c.mtimeMs) { skipped++; continue; }
      // 用 node:zlib 内置的 zstd 解压，不再 fork `zstd` 二进制。
      // 理由：这是本机缺的外部依赖（本机 only gzip/xz/bzip2），缺了整阶段就静默失败，
      // 而 Node ≥22.15 自带 zstdDecompressSync —— 少一个「装了但跑不了」。
      const raw = zstdDecompressSync(readFileSync(c.zf)).toString("utf8");
      const md = buildSessionMd(c.sd, raw);
      const date = new Date(c.mtimeMs).toISOString().slice(0, 10);
      const dest = join(outDir, date + "-" + c.sd.replace(/^session-/, "").slice(0, 8) + ".md");
      atomicWrite(dest, md);
      exported[c.sd] = c.mtimeMs;
      exportedNow++;
      results.push(c.sd.slice(0, 16));
    } catch { results.push(c.sd.slice(0, 16) + " ERR"); }
  }
  if (exportedNow > 0) saveState({ ...state, exportedDsh: exported });
  return {
    exported: exportedNow,
    skipped,
    candidates: candidates.length,
    inWindow: inWindow.length,
    truncated: inWindow.length - selected.length,
    since: new Date(sinceMs).toISOString().slice(0, 10),
    outDir,
    ...(warnedInVault ? { warn: "导出目录在 vault 内，已写 .no-sync 哨兵" } : {}),
    tracked: Object.keys(exported).length,
    results: results.slice(0, 6),
  };
}

// ── --docs-sync: 把 mnemon Documents（~/.mnemon/documents/active/*.md）回流为 wiki 页
// 幂等：state.docsImported 记录 {fileName: content_hash}；title 与已有 wiki 页重复则跳过
const DOCS_DIR = join(homedir(), ".mnemon/documents/active");

function docCategory(title) {
  if (/计划|规划|方案|调研|决策|适配|评估/.test(title)) return "决策";
  if (/接入|部署|配置|环境|发布|导航|优化/.test(title)) return "项目";
  if (/准则|原则|规范|参考|收录/.test(title)) return "引用";
  return "概念";
}

function docsSync() {
  const state = loadState();
  const imported = state.docsImported || {};
  const results = [];
  let importedNow = 0;
  try {
    if (!existsSync(DOCS_DIR)) return { error: "无 documents 目录" };
    // 已有 wiki 页 title 规范化集（去重）
    const existing = new Set();
    for (const cat of CATS) {
      const dir = join(WIKI, cat);
      let files = [];
      try { files = readdirSync(dir).filter(f => f.endsWith(".md") && f !== "index.md"); } catch { continue; }
      for (const f of files) {
        const t = parseFm(readFileSync(join(dir, f), "utf8")).title;
        if (t) existing.add(String(t).replace(/\s+/g, ""));
      }
    }
    for (const f of readdirSync(DOCS_DIR).filter(f => f.endsWith(".md")).sort()) {
      const text = readFileSync(join(DOCS_DIR, f), "utf8");
      const fm = parseFm(text);
      if (!fm.id || !fm.title) continue;
      if (imported[f] === fm.content_hash) continue;
      const cat = docCategory(String(fm.title));
      const normTitle = String(fm.title).replace(/\s+/g, "");
      if (existing.has(normTitle)) { results.push(String(fm.title) + " SKIP(已有页)"); imported[f] = fm.content_hash; continue; }
      const blk = extractFmText(text);
      const body = blk ? text.slice(blk.end + 4).trim() : text.trim();
      const date = String(fm.created_at || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
      const fname = String(fm.title).replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
      const md = "---\ntitle: " + JSON.stringify(String(fm.title)) + "\ntags: [wiki/" + cat + ", compiled, mnemon]\ntype: \"" + cat + "\"\ncreated: " + date + "\nupdated: " + date + "\nsource: \"mnemon:document:" + fm.id + "\"\ndescription: " + (fm.description ? JSON.stringify(String(fm.description)) : "\"\"") + "\n---\n\n" + body + "\n\n## 相关\n\n- [[wiki/决策/llm-wiki-架构设计决策]]\n- [[wiki/概念/LLM-Wiki理念]]\n";
      const dest = join(WIKI, cat, fname + ".md");
      atomicWrite(dest, md);
      imported[f] = fm.content_hash;
      importedNow++;
      existing.add(normTitle);
      results.push(cat + "/" + fname);
    }
    if (importedNow > 0) saveState({ ...state, docsImported: imported });
    return { imported: importedNow, results: results.slice(0, 12) };
  } catch (e) { return { error: String(e.message || e).slice(0, 120) }; }
}

// ── --prune-memory: 清记忆体孤儿条目（来源指向不存在的 wiki 页）──
// F2：三道保险。这是全项目唯一会**批量删除持久化数据**的操作，而它判定「孤儿」的唯一依据
// 是「vault 里找不到这个文件」—— vault 没挂载时，这个判断会把整个记忆体判成孤儿。
function pruneMemory(pages, { force = FORCE, dry = DRY } = {}) {
  // 保险 1：vault 结构性健康。硬停，--force 也不能越过 —— 路径都不对时「删除」没有任何依据。
  const problems = vaultHealth();
  if (problems.length) {
    return { skipped: true, reason: "vault 不健康，拒绝软删: " + problems.join("; ") };
  }
  // 保险 2：页面数下限。挂载缺失 / 路径配错时 wiki/ 会是空的或近乎空的。
  const n = Array.isArray(pages) ? pages.length : 0;
  if (n < PRUNE_MIN_PAGES && !force) {
    return { skipped: true, reason: `wiki 页面数 ${n} < ${PRUNE_MIN_PAGES}，疑似 vault 未挂载，拒绝软删（--force 可覆盖）` };
  }

  let db;
  try { db = new DatabaseSync(join(homedir(), ".mnemon/data/default/mnemon.db"), { readOnly: true }); }
  catch (e) { return { error: "无法打开 mnemon db: " + e.message }; }
  try {
    const rows = db.prepare("SELECT id, content FROM insights WHERE content LIKE ? AND deleted_at IS NULL").all("%来源: wiki/%");
    const victims = [];
    const gone = [];
    for (const r of rows) {
      const m = String(r.content).match(/来源: ([^）)]+)/);
      if (!m) continue;
      const rel = m[1].trim();
      const inside = safeJoinVault(rel, VAULT, { mustExist: false });
      const alive = inside ? existsSync(inside.full) : false;
      if (!alive) { victims.push(r.id); gone.push(rel); }
    }
    // 保险 3：单次删除比例。路径配错时「全部都不存在」，比例会冲到 100%。
    if (rows.length > 0 && victims.length / rows.length > PRUNE_MAX_RATIO && !force) {
      return {
        skipped: true, scanned: rows.length, wouldPrune: victims.length,
        reason: `待删 ${victims.length}/${rows.length} 超过 ${Math.round(PRUNE_MAX_RATIO * 100)}%，疑似路径配错，拒绝软删（--force 可覆盖）`,
      };
    }
    if (dry) return { scanned: rows.length, pruned: 0, wouldPrune: victims.length, gone: gone.slice(0, 8), note: "(--dry-run) 未写入" };
    // 三重保险都通过后才开写 —— 上面用 readOnly 打开，避免在只读检查阶段就持有写锁。
    db.close();
    db = null;
    try { db = new DatabaseSync(join(homedir(), ".mnemon/data/default/mnemon.db"), { readOnly: false }); }
    catch (e) { return { error: "无法以写模式打开 mnemon db: " + e.message }; }
    const stamp = new Date().toISOString();
    for (const id of victims) db.prepare("UPDATE insights SET deleted_at = ? WHERE id = ?").run(stamp, id);
    return { scanned: rows.length, pruned: victims.length, gone: gone.slice(0, 8) };
  } finally { try { if (db) db.close(); } catch {} }
}

function collectPages() {
  const pages = [];
  function walk(dir, cat) {
    for (const e of readdirSync(dir)) {
      if (EXCLUDE_DIRS.has(e)) continue;
      const full = join(dir, e);
      try {
        if (statSync(full).isDirectory()) walk(full, cat);
        else if (e.endsWith(".md") && e !== "index.md") {
          const content = readFileSync(full, "utf8");
          const st = statSync(full);
          const blk = extractFmText(content);
          const parsed = blk ? parseFmYaml(blk.fm) : { data: {}, errors: [] };
          const p = {
            cat, file: e, full, rel: relative(VAULT, full), content,
            fm: parsed.data, fmErrors: parsed.errors,
            fmEnd: blk ? blk.end : -1,
            body: blk ? content.slice(blk.end + 4) : content,
            mtime: st.mtimeMs, size: st.size,
          };
          p.hashes = pageHashes(p);        // O2：语义指纹在收集时一次算好
          pages.push(p);
        }
      } catch {}
    }
  }
  for (const cat of CATS) {
    const dir = join(WIKI, cat);
    if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir, cat);
  }
  return pages;
}

function lint(pages) {
  const issues = [];
  const links = new Map();
  // 页面索引：related 目标存在性校验用（文件名与相对路径、带不带 .md 都认）
  const pageIndex = new Set();
  for (const p of pages) {
    const stem = p.file.replace(/\.md$/, "");
    pageIndex.add(stem);
    pageIndex.add(p.rel);
    pageIndex.add(p.rel.replace(/\.md$/, ""));
  }
  for (const p of pages) {
    // OKF 结构检查
    const content = p.content;
    if (!content.startsWith("---")) issues.push({ type: "okf", path: p.rel, message: "frontmatter 不在文件开头" });
    else {
      const closing = content.indexOf("\n---", 4);
      if (closing < 0) issues.push({ type: "okf", path: p.rel, message: "frontmatter 无 closing ---" });
    }
    for (const f of ["title", "type", "created"]) {
      if (!p.fm[f]) issues.push({ type: "missing_frontmatter", path: p.rel, message: "缺 " + f });
    }
    // ── O1：结构化校验（旧解析器把 tags/sources/verified 读成字符串，这些检查此前不可能存在）──
    for (const e of (p.fmErrors || [])) issues.push({ type: "fm_syntax", path: p.rel, message: e });
    // 解析本身失败时，基于误读值的形状检查只会产生噪声（如把 &anchor 误读成字符串后再报"tags 应为数组"）
    const fmd = p.fm;
    if (!(p.fmErrors || []).length) {
      if (fmd.type && !CATS.includes(String(fmd.type))) {
        issues.push({ type: "type_dir", path: p.rel, message: "type=" + fmd.type + " 不是已知分类" });
      }
      if (fmd.type && String(fmd.type) !== p.cat) {
        issues.push({ type: "type_dir", path: p.rel, message: "type=" + fmd.type + " 与目录 " + p.cat + " 不一致" });
      }
      if (Array.isArray(fmd.related)) {
        for (const r of fmd.related) {
          const target = String(r).replace(/^\[\[|\]\]$/g, "").split("|")[0].trim();
          if (target && !pageIndex.has(target) && !pageIndex.has(target + ".md")) {
            issues.push({ type: "dangling_link", path: p.rel, message: "related 指向不存在的页面: " + target });
          }
        }
      } else if (fmd.related !== undefined && fmd.related !== "") {
        issues.push({ type: "fm_shape", path: p.rel, message: "related 应为数组" });
      }
      if (fmd.tags !== undefined && fmd.tags !== "" && !Array.isArray(fmd.tags)) {
        issues.push({ type: "fm_shape", path: p.rel, message: "tags 应为数组" });
      }
      if (fmd.stale_after && new Date(fmd.stale_after) < new Date() && fmd.status !== "stale") {
        issues.push({ type: "stale_after", path: p.rel, message: "已过期: " + fmd.stale_after });
      }
    }
    // F4：标题是注入面的源头（标题会进 index.md，而 index.md 曾每轮进系统提示词）。
    // 只告警不删除 —— 误报的代价是作者看到一条警告，漏报的代价是标题进系统提示词，两者不对称。
    const titleForCheck = String(p.fm.title == null ? "" : p.fm.title);
    if (isSuspiciousTitle(titleForCheck)) {
      issues.push({ type: "suspicious_title", path: p.rel, message: "标题疑似指令注入: " + safeTitle(titleForCheck, 60) });
    }
    const wl = (p.content.match(/\[\[[^\]]+\]\]/g) || []).length;
    if (wl < 2) issues.push({ type: "few_wikilinks", path: p.rel, message: "wikilink " + wl });
    for (const m of p.content.matchAll(/\[\[([^\]#|]+)/g)) {
      const t = m[1].trim();
      if (!links.has(t)) links.set(t, new Set());
      links.get(t).add(p.rel);
    }
  }
  const graceCut = new Date(); graceCut.setDate(graceCut.getDate() - 7);
  const orphans = pages.filter(p => {
    if (p.cat === "引用" || p.cat === "索引") return false;
    // 新页面宽限期：创建/更新在 7 天内不算孤立（等入链自然形成）
    const d = p.fm.updated || p.fm.created;
    if (d && new Date(d) > graceCut) return false;
    const name = p.file.replace(/\.md$/, "");
    return ![...links.entries()].some(([t, srcs]) => (t === name || t.endsWith("/" + name)) && srcs.size > 0);
  });
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - STALE_DAYS);
  const stale = pages.filter(p => {
    const u = p.fm.updated || p.fm.created;
    return u && new Date(u) < cutoff && p.fm.status !== "stale";
  });
  const byType = {};
  for (const i of issues) byType[i.type] = (byType[i.type] || 0) + 1;
  return { issues, orphans, stale, pageCount: pages.length, byType };
}

function rebuildIndex(pages) {
  const byCat = {};
  for (const p of pages) (byCat[p.cat] ||= []).push(p);
  const cats = CATS.filter(c => byCat[c]);
  let md = "# LLM-Wiki 知识库导航\n\nAgent 自主浏览入口。通过以下分类逐级浏览。\n\n> 此页面由管线自动维护。\n\n## 分类\n\n";
  for (const c of cats) md += "* [wiki/" + c + "](wiki/索引/" + c + ".md) — " + byCat[c].length + " 条\n";
  const recent = [...pages].sort((a, b) => b.mtime - a.mtime).slice(0, 10);
  md += "\n## 最近更新\n\n";
  // F4：标题消毒。初稿只去 `[[` / `]]`，但**单个 `]` 就足以破坏** `* [title](rel)` 这个链接。
  for (const p of recent) md += "* [" + safeTitle(p.fm.title || p.file) + "](" + p.rel + ") — " + new Date(p.mtime).toISOString().slice(0, 10) + "\n";

  // ── O5：分类索引页落盘，替代 Dataview ──
  // 上游 SKILL.md 让模型先读 `wiki/索引/<分类>.md`（Dataview 聚合），但管线从不生成它
  // （"索引"在 EXCLUDE_DIRS，也不在 CATS 里）→ 读路径隐式依赖 Obsidian + Dataview，
  // 而 README 依赖表没列 Dataview。没有 Dataview 的人模型每次都会撞一个不存在的文件。
  //
  // 排序用 generateDraft 同源信号（质量分 / 信任分级 / 陈旧度），不引 lib/search.mjs：
  // 那边是"查询相关度"，这边是"全量浏览序"，意图不同；但权重刻意保持同向，
  // 否则同一个库在"浏览"和"检索"两条路径会给出两套"重要"。
  const idxDir = join(WIKI, "索引");
  const idxPages = [];
  for (const c of cats) {
    const list = byCat[c].slice().sort((a, b) => {
      const qa = Number(a.fm.quality_score) || 0, qb = Number(b.fm.quality_score) || 0;
      if (qb !== qa) return qb - qa;
      const da = String(a.fm.updated || a.fm.created || ""), db = String(b.fm.updated || b.fm.created || "");
      if (da !== db) return db.localeCompare(da);
      return normalize(a.fm.title || a.file).localeCompare(normalize(b.fm.title || b.file), "zh-Hans-CN");
    });
    let im = "# " + c + "（" + list.length + " 条）\n\n> 由管线自动生成。检索时先在本页粗筛，再用 `wiki-find` 排序检索、`read` 读原文。\n\n";
    for (const p of list) {
      const tier = trustTier(p.fm);
      const st = p.fm.status && p.fm.status !== "active" ? p.fm.status : "";
      const flags = [tier, st, p.fm.superseded_by ? "superseded" : ""].filter(Boolean).join(" · ");
      const q = Number(p.fm.quality_score) || 0;
      const rawDesc = p.fm.description && p.fm.description !== "-" ? p.fm.description : "";
      const descPart = rawDesc ? " — " + safeTitle(rawDesc, 80) : "";
      im += "* [" + safeTitle(p.fm.title || p.file) + "](" + p.rel + ")" + descPart
        + " `q" + q + (flags ? " · " + flags : "") + "`\n";
    }
    idxPages.push({ cat: c, md: im });
  }

  // F4：注入面收敛的载体。插件读这份 JSON 而不是读 index.md 原文 ——
  // 这里**刻意只有数字，没有任何标题**，所以模型可写的文本完全不进系统提示词。
  //
  // ⚠️ byType 必须是 `{分类名: 页数}`。O5 把 byCat 从计数 map 改成 `{分类名: 页对象[]}`
  // 之后，这里直接塞 byCat 会让整套页面（含 title/fm/正文）序列化进 stats ——
  // F4 的注入面收敛当场失效，且文件从 200B 涨到几十 KB。实测踩过，勿改回。
  const latestMs = pages.reduce((m, p) => Math.max(m, Number(p.mtime) || 0), 0);
  const stats = {
    generated: new Date().toISOString(),
    total: pages.length,
    byType: Object.fromEntries(Object.entries(byCat).map(([c, ps]) => [c, ps.length])),
    latest: latestMs ? new Date(latestMs).toISOString().slice(0, 10) : null,
  };
  return { md, stats, idxDir, idxPages };
}

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; } }
// state 也走原子写：半截 JSON 会让下次 loadState 抛异常，而 catch 里返回 {} 会让
// 整个增量检测退化成「全量重算」——不会崩，但每次都全量。
// state 也走原子写（半截 JSON 会让 loadState 抛异常 → catch 返回 {} → 增量检测退化成
// 全量重算，不崩但每次都全量）。目录随 STATE_FILE 走，不钉死 STATE_DIR：LLM_WIKI_STATE
// 把状态搬到 tmp 时，不该再往真实 HOME 里 mkdir。
function saveState(s) { mkdirSync(dirname(STATE_FILE), { recursive: true }); atomicWrite(STATE_FILE, JSON.stringify(s, null, 1)); }
function generateDraft(changed) {
  return changed
    // 已废弃 / 被取代 → 不进召回。
    // 边界（已知，属 O4 范围）：这只能阻止**进入**召回，无法删除 mnemon 里**已经存在**的条目 ——
    // mnemon 没有暴露删除/降权的原语。所以对一个早已同步过的页面加 superseded_by，本轮只是
    // 不再重导（syncMemory 会把它计入 retired），它在 mnemon 里的旧权重仍然存在。
    .filter(p => !isRetired(p.fm))
    .map(p => {
      const d = p.fm.description || p.fm.summary;
      const desc = d && d !== "-" ? "：" + d : "";
      const tier = trustTier(p.fm);
      // 置信度决定召回权重，质量分作为小幅修正（draft 指纹已把 tier 纳入，所以它必须真正生效）
      const importance = Math.max(1, Math.min(5,
        TRUST_IMPORTANCE[tier] + (Number(p.fm.quality_score) >= 5 ? 1 : 0) - (p.fm.status === "stale" ? 1 : 0)));
      return {
        content: "[LLM-Wiki/" + p.cat + "] " + (p.fm.title || p.file) + desc + "（来源: " + p.rel + "）",
        tags: ["llm-wiki", p.cat, "trust:" + tier, ...(p.fm.project ? [p.fm.project] : [])].filter(Boolean),
        importance,
      };
    });
}

function startFakeEmbed() {
  const srv = createServer((req, res) => { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "embedding unavailable" })); });
  return new Promise((resolve, reject) => { srv.once("error", reject); srv.listen(11434, "127.0.0.1", () => resolve(srv)); });
}
async function ollamaAlive() {
  return new Promise(resolve => {
    execFileSync("node", ["-e", "fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(2500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { stdio: "ignore" });
    resolve(true);
  }).catch(() => false);
}
async function syncMemory(pages) {
  const syncPages = pages.filter(p => p.cat !== "引用" && !(p.cat === "发现" && p.file.includes("会话复盘")));
  const state = loadState();
  const { changed, drift, bodyDrift } = changedPages(syncPages, state);
  const toSync = changed.filter(p => !isRetired(p.fm));
  // 没有需要重导的页时也要把漂移认下来，否则每一轮都会重复报同一次漂移
  if (toSync.length === 0) {
    if (changed.length || drift.length) {
      const ns = { ...state };
      for (const p of [...changed, ...drift]) ns[p.rel] = stateEntry(p);
      saveState(ns);
    }
    return { synced: 0, retired: changed.length - toSync.length, drift: drift.length, bodyDrift: bodyDrift.length, note: "无需重导" };
  }
  const draft = { schema_version: "1", insights: generateDraft(toSync) };
  const tmp = join(STATE_DIR, "sync-draft-" + Date.now() + ".json");
  // 刻意不原子写：这是给 mnemon import 的临时文件，写完立刻被外部读走；且 state 目录
  // 在 ~/.dsh/llm-wiki，用户不会看到它。真异常时留个 tmp 无害（cron 不清理也不涨）。
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(tmp, JSON.stringify(draft, null, 1));
  let fake = null;
  if (FAKE_EMBED !== "never") {
    const alive = await ollamaAlive();
    if (!alive) { fake = await startFakeEmbed().catch(e => { console.log("[sync] startFakeEmbed 失败:", String(e).slice(0, 80)); return null; }); }
  }
  try {
    await execFileAsync("mnemon", ["import", tmp], { timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    const tail = String(e.stdout || "").trim().slice(-150);
    return { synced: 0, error: String(e.message || e).slice(0, 120) + (tail ? " | out:" + tail : "") };
  } finally {
    if (fake) { try { fake.close(); } catch {} }
    try { rmSync(tmp, { force: true }); } catch {}
  }
  const ns = { ...state };
  for (const p of [...changed, ...drift]) ns[p.rel] = stateEntry(p);
  saveState(ns);
  return {
    synced: toSync.length,
    retired: changed.length - toSync.length,
    drift: drift.length,
    bodyDrift: bodyDrift.length,
    changed: toSync.map(p => p.rel).slice(0, 5),
    drifted: drift.map(p => p.rel).slice(0, 5),
  };
}

function appendLog(entry) {
  const logPath = join(VAULT, "log.md");
  try {
    const line = "## [" + new Date().toISOString().slice(0, 10) + "] pipeline | " + entry + "\n";
    if (existsSync(logPath)) atomicWrite(logPath, capLogLines(line + readFileSync(logPath, "utf8")).text);
    else atomicWrite(logPath, "# LLM-Wiki 操作日志\n\n" + line);
  } catch {}
}

async function main() {
  console.log("LLM-Wiki pipeline | vault:", VAULT);
  if (DO_RATE) {
    const r = ratePage(RATE_TARGET, RATE_VALUE);
    console.log("\n== rate ==\n", JSON.stringify(r));
    if (r.ok && !DRY) appendLog("rate:" + RATE_TARGET + "=" + RATE_VALUE);
    return;
  }

  // O3：跨进程锁。插件（session/disposed）与 systemd timer（每日 10:00 + RandomizedDelaySec
  // 300s）会各自拉起一份，插件的 60s 冷却只是进程内计数，挡不住跨进程并发。两份同时跑的
  // 后果不是抛异常，而是互相覆盖 state / 覆盖对方刚 okf 补好的字段 —— 静默劣化。
  // 只锁 `--rate` 之外的路径：rate 是单文件增量操作，用户手动执行，锁了反而挡正常使用。
  // 锁跟着 STATE_FILE 的目录走，而不是钉死 STATE_DIR：LLM_WIKI_STATE 已经是「把状态搬到
  // 别处」的既有旋钮，同一台机器多个 vault / 测试并行跑时，锁必须跟着状态一起搬，否则
  // 两个互不相干的 vault 会互相拒入。
  const LOCK_FILE = join(dirname(STATE_FILE), "pipeline.lock");
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  if (!acquireLock(LOCK_FILE)) {
    const h = lockHolder(LOCK_FILE);
    console.log("另一个管线实例正在运行" + (h ? "（pid " + h.pid + "，起于 " + h.at + "）" : "") + "，退出。");
    return;   // 不是错误：并发的正确行为就是让其中一方安静退出
  }
  const onExit = () => releaseLock(LOCK_FILE);
  process.on("exit", onExit);
  const onSigint = () => { try { releaseLock(LOCK_FILE); } catch {} process.exit(130); };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

  // F2 总闸：vault 不健康时所有阶段都无意义，且部分阶段是有害的 ——
  //   --index 会用空内容覆盖 wiki/index.md（而 index.md 每轮被注入系统提示词），
  //   --compile-patterns 会在根文件系统上 mkdir 出幽灵 vault 树，
  //   --prune-memory 会把整个记忆体判成孤儿。
  // 之前没有任何一处检查 vault 是否存在，所以「D 盘没挂载」会安静地造成上述全部后果。
  const problems = vaultHealth();
  if (problems.length) {
    console.log("\n[中止] vault 不健康，跳过全部阶段：");
    for (const p of problems) console.log("  -", p);
    console.log("  检查: D 盘是否挂载 / LLM_WIKI_VAULT 是否指向正确的 vault 根目录。");
    process.exitCode = 3;   // 与 install.sh 的 vault 预检失败保持同一退出码，便于 systemd 标红
    return;
  }

  const pages = collectPages();
  console.log("页面数:", pages.length);
  const summary = [];
  if (RUN.lint) {
    const r = lint(pages);
    console.log("\n== lint ==");
    console.log("问题:", r.issues.length, "| 孤立节点:", r.orphans.length, "| stale:", r.stale.length);
    console.log("  分类:", Object.entries(r.byType).map(([k, v]) => k + "=" + v).join(" ") || "无");
    for (const i of r.issues.slice(0, 8)) console.log("  [问题]", i.path, i.message);
    for (const o of r.orphans.slice(0, 5)) console.log("  [孤立]", o.rel);
    summary.push("lint:" + r.issues.length + "问题/" + r.orphans.length + "孤立/" + r.stale.length + "stale");
  }
  if (RUN.index) {
    // F2：index.md 每轮被插件注入系统提示词，用空内容覆盖它 = 把模型的 vault 认知清零。
    // 页面数为 0 时宁可不动，也不要把一份看起来正常的空索引写回去。
    if (pages.length === 0) {
      console.log("\n== index ==\n[跳过] wiki 页面数为 0，拒绝用空内容覆盖 index.md");
      summary.push("index:跳过(空)");
    } else {
      const { md, stats, idxDir, idxPages } = rebuildIndex(pages);
      if (!DRY) {
        atomicWrite(join(WIKI, "index.md"), md);
        // F4：这份统计是注入面的全部内容（约 200 字节，无标题）。插件读它，不读 index.md。
        atomicWrite(join(WIKI, "index-stats.json"), JSON.stringify(stats, null, 2));
        // O5：分类索引页。只写非空分类的页 —— 空分类不生成空壳文件。
        //  一次性全量 mkdir：目录里可能有上一次留下的空分类文件，写它们之前先清场。
        mkdirSync(idxDir, { recursive: true });
        for (const f of readdirSync(idxDir)) {
          if (f.endsWith(".md") && !idxPages.some(x => x.cat + ".md" === f)) rmSync(join(idxDir, f));
        }
        for (const x of idxPages) atomicWrite(join(idxDir, x.cat + ".md"), x.md);
        console.log("\n== index ==\n已重建 wiki/index.md + index-stats.json + 索引/" + idxPages.map(x => x.cat).join("/") + ".md");
        summary.push("index:重建(分类索引 " + idxPages.length + " 页)");
      } else console.log("\n== index ==\n(--dry-run) 将重建 wiki/index.md + index-stats.json + 分类索引页");
    }
  }
  if (RUN.usage) {
    console.log("\n== usage ==");
    if (DRY) console.log("(--dry-run) 将回写召回热度到 wiki 页 frontmatter");
    else {
      const r = usageSync(pages); console.log("回写:", JSON.stringify(r));
      for (const s of (r.conflicts || [])) console.log("  [外部修改] 跳过", s);
      for (const s of (r.errors || [])) console.log("  [写入失败]", s);
      summary.push("usage:" + (r.updated || 0) + "页");
    }
  }
  if (RUN.okf) {
    console.log("\n== okf ==");
    if (DRY) console.log("(--dry-run) 将补 OKF v0.2 字段（description/sources/generated/verified/stale_after），并把旧的字符串形式字段规范化为受控子集 YAML");
    else {
      const r = okfAlign(pages);
      console.log("OKF 对齐:", JSON.stringify(r));
      for (const s of (r.repairSample || [])) console.log("  [规范化]", s);
      for (const s of (r.conflicts || [])) console.log("  [外部修改] 跳过", s);
      for (const s of (r.errors || [])) console.log("  [写入失败]", s);
      summary.push("okf:" + (r.aligned || 0) + "页" + (r.repaired ? "/规范化" + r.repaired : "")
        + ((r.conflicts && r.conflicts.length) ? "/外部修改跳过" + r.conflicts.length : ""));
    }
  }
  if (RUN.compilePatterns) {
    console.log("\n== compile-patterns ==");
    if (DRY) console.log("(--dry-run) 将扫描孤立节点并生成 pattern 页");
    else { const r = compilePatterns(pages); console.log("编译:", JSON.stringify(r)); summary.push(r.skipped ? "compile:跳过" : "compile:" + (r.created || 0) + "pattern/"); }
  }
  if (RUN.docs) {
    console.log("\n== docs-sync ==");
    if (DRY) console.log("(--dry-run) 将把 mnemon Documents 回流为 wiki 页");
    else { const r = docsSync(); console.log("回流:", JSON.stringify(r)); summary.push("docs:" + (r.imported || 0) + "个"); }
  }
  if (RUN.dsh) {
    console.log("\n== dsh-export ==");
    if (!DSH_EXPORT_ENABLED) {
      // ① 默认关闭。这是「把整段对话落盘」的操作，不该因为一个 flag 就打开展开。
      console.log("[已禁用] 会话导出默认关闭 —— 它会把对话全文（可能含密钥、私有路径）写到磁盘。");
      console.log("  确需导出：LLM_WIKI_EXPORT_SESSIONS=1");
      console.log("  建议同时把 LLM_WIKI_EXPORT_DIR 指向 vault 之外（默认 " + DSH_EXPORT_DIR + "）。");
      summary.push("dsh:禁用");
    } else if (DRY) {
      console.log("(--dry-run) 将导出 DSH 会话复盘到 " + DSH_EXPORT_DIR + "（最近 " + DSH_EXPORT_DAYS + " 天，最多 " + DSH_EXPORT_LIMIT + " 个）");
    } else {
      const r = dshSessionExport();
      console.log("导出:", JSON.stringify(r));
      summary.push("dsh:" + (r.exported || 0) + "个" + (r.truncated ? "(截断" + r.truncated + ")" : ""));
    }
  }
  if (RUN.prune) {
    console.log("\n== prune-memory ==");
    const r = pruneMemory(pages);
    console.log("清理:", JSON.stringify(r));
    if (!DRY) summary.push(r.skipped ? "prune:跳过" : "prune:" + (r.pruned || 0) + "条");
  }
  if (RUN.sync) {
    console.log("\n== sync ==");
    if (DRY) {
      const syncPages = pages.filter(p => p.cat !== "引用" && !(p.cat === "发现" && p.file.includes("会话复盘")));
      const state = loadState(); const { changed, drift, bodyDrift } = changedPages(syncPages, state);
      const toSync = changed.filter(p => !isRetired(p.fm));
      console.log("(--dry-run) 待重导:", toSync.length, "| 已废弃:", changed.length - toSync.length, "| 外部漂移:", drift.length, "(其中正文漂移 " + bodyDrift.length + ")");
      summary.push("sync(dry):" + toSync.length);
    } else {
      const r = await syncMemory(pages);
      console.log("同步:", JSON.stringify(r));
      summary.push("sync:" + (r.synced || 0) + "条" + (r.drift ? "/漂移" + r.drift : "") + (r.error ? " ERR:" + r.error : ""));
    }
  }
  if (!DRY) appendLog(summary.join(" | "));
  console.log("\n完成。");
}
main().catch(e => { console.error("pipeline 失败:", e); process.exit(1); });
