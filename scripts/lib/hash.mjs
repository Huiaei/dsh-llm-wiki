/**
 * hash.mjs —— 页面指纹与信任分级（零外部依赖）
 *
 * 设计（O2）：按「消费方关心的字段」做哈希，而不是按文件 mtime。
 *
 * 旧实现用 `state[rel].mtime !== p.mtime` 判断变更，同时 usageSync/okfAlign **刻意用 utimesSync
 * 把 mtime 恢复成旧值**来"防止元数据回写触发重同步"。结果两个方向都错：
 *   - 管线自己改了 description / quality_score 这类**会影响 mnemon 草稿**的字段，mtime 被伪装
 *     → 永远不会重新同步（草稿里的 importance 停留在旧值）；
 *   - Obsidian 保存、同步盘、git checkout 任何一次触碰都会改 mtime → **全量重导**。
 *
 * 现在改为三个指纹：
 *   draft —— generateDraft 用到的全部字段（决定是否需要重新 import 到 mnemon）
 *   body  —— 正文（决定 lint / okf 是否需要重跑）
 *   full  —— 全文（检测外部漂移，含 frontmatter）
 */

import { createHash } from "node:crypto";

/** state 条目的结构版本；v1（纯 mtime）视为未知，首次运行全量重算一次 */
export const STATE_SCHEMA = 2;

/** sha256 前 16 个十六进制字符 */
export function sha16(s) {
  return createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
}

/**
 * 信任分级：human-reviewed > machine-confirmed > unverified
 * 消费 README.md:134-140 声明的 verified 字段（此前只有写入点、没有任何消费者）。
 */
export function trustTier(fm) {
  const v = fm && fm.verified;
  const by = v && typeof v === "object" ? String(v.by || "") : typeof v === "string" ? v : "";
  if (by.startsWith("human:")) return "human-reviewed";
  if (by.startsWith("agent/")) return "machine-confirmed";
  const q = Number(fm && fm.quality_score) || 0;
  return q >= 3 ? "machine-confirmed" : "unverified";
}

/** 已废弃 / 被取代 → 不参与召回 */
export function isRetired(fm) {
  return Boolean(fm && fm.superseded_by) || (fm && fm.status) === "archived";
}

export const TRUST_IMPORTANCE = { "human-reviewed": 5, "machine-confirmed": 4, "unverified": 3 };

/**
 * 纯遥测字段：管线自己每轮都会回写，**不代表知识变化**。
 * 把它们排除在 full 指纹之外，否则每次召回热度变化都会制造一次"外部漂移"。
 */
export const TELEMETRY_FIELDS = new Set(["queried_count", "last_queried"]);

/** 键序稳定的 JSON（frontmatter 的键顺序不该影响指纹） */
function stableJson(v) {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
  }
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * 一页的三个指纹：
 *   draft —— generateDraft 消费的全部字段，变了就要重新 import 到 mnemon
 *   body  —— 正文，用于区分「正文漂移」与「frontmatter 漂移」
 *   full  —— 正文 + 除遥测外的全部 frontmatter，检测任何外部改动
 */
export function pageHashes(p) {
  const fm = (p && p.fm) || {};
  const draftKey = JSON.stringify([
    p.cat || "",
    fm.title || "",
    fm.description || fm.summary || "",
    fm.project || "",
    Number(fm.quality_score) || 0,
    fm.status || "",
    Array.isArray(fm.tags) ? fm.tags : fm.tags || "",
    trustTier(fm),
    // 退役必须被检出，否则给页面加 superseded_by 之后管线会以为"什么都没变"，
    // 那一页就永远留在召回里。
    isRetired(fm),
  ]);
  const driftFm = {};
  for (const [k, v] of Object.entries(fm)) if (!TELEMETRY_FIELDS.has(k)) driftFm[k] = v;
  const body = p.body != null ? p.body : String((p && p.content) || "");
  return {
    draft: sha16(draftKey),
    body: sha16(body),
    full: sha16(stableJson(driftFm) + "\n" + body),
  };
}

/** 写进 state 的一条页面记录 */
export function stateEntry(p) {
  return { schema: STATE_SCHEMA, ...(p.hashes || pageHashes(p)), mtime: p.mtime, size: p.size };
}

/**
 * 变更检测。两个列表互斥，语义清晰：
 *   changed —— draft 指纹变了（会影响 mnemon 草稿内容与召回权重）→ 需要重导
 *   drift   —— draft 没变、但别的地方动了（Obsidian 改正文、git checkout）→ 认下来，不重导
 *
 * 为什么不是「按文件哈希」：usageSync 每轮回写 queried_count/last_queried，按文件哈希会把
 * 这种纯遥测写入也算成变更；而按 mtime 判断又会因为 utimesSync 伪装而漏掉真正影响召回的改动。
 */
export function changedPages(pages, state) {
  const changed = [], drift = [], bodyDrift = [];
  for (const p of pages) {
    const st = state[p.rel];
    const h = p.hashes || pageHashes(p);
    if (!st || st.schema !== STATE_SCHEMA) { changed.push(p); continue; }  // v1（纯 mtime）的旧 state → 重算一次
    if (st.draft !== h.draft) changed.push(p);
    else if (st.full !== h.full) { drift.push(p); if (st.body !== h.body) bodyDrift.push(p); }
  }
  return { changed, drift, bodyDrift };
}
