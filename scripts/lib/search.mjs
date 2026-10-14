/**
 * search.mjs —— O5 检索层：归一化 + n-gram + 打分（纯函数）
 *
 * 这些函数从 `wiki-find.mjs` 里抽出来，理由与 O1/O2/F4/0.8 相同：CLI 是
 * `import 即执行` 的脚本，函数留在里面无法被 `node --test` 加载。而排序正是 O5
 * 全部增量所在 —— 它必须能被直接断言，不能只靠"看起来排对了"。
 *
 * ⚠️ 中文分词在这里是**故意缺席**的：零依赖是硬约束（项目不引 npm 包，README 依赖表
 * 只有 node + rg + zstd）。所以用 2-gram 近似替代。这意味着"部署流程"这种词有效，
 * 但会带来噪声命中（"流程"命中"流程化"），单字高频也会带偏。SKILL 里必须据此写明
 * "结果需模型复核"。
 *
 * 为什么不用 `Intl.Segmenter`：它在 Node 20 就已内置、按词切分，看似更合适。但
 *  (a) 它对中文的切分依赖 ICU 数据，`node --test` 里两种构建结果可能不同；
 *  (b) 对英文/路径/代码片段反而切得更碎，而标题里混排中英是常态。
 * 2-gram 是确定性的、可枚举的、零 ICU 差异的 —— 对"检索粗筛"这个用途足够。
 *
 * 信任分级与退役判定直接复用 `hash.mjs`（O4 的落地处），不在这里复制一份字面量 ——
 * 复制一份的后果是读路径与写路径的标准会各自漂移，而那正是 O5 要消除的东西。
 */

import { trustTier, isRetired } from "./hash.mjs";

/** 归一化：小写 + 去空白 + 去标点（Unicode 属性）。中文没有大小写，但中英混排标题要。 */
export function normalize(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[\s\p{P}]+/gu, "");
}

/** n-gram 集合。n <= 0 或空串 → 空集合（不是全命中，那会让空查询排到最高）。 */
export function ngrams(s, n = 2) {
  const out = new Set();
  if (!s || n <= 0) return out;
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}

/**
 * 查询过短时的兜底：长度 1 的查询没有 n-gram（`ngrams("流",2)` 是空集合），
 * 但"部署"写成"流"搜索时用户就是想要子串匹配。
 * 这里的价差是刻意的 —— 单字查询只走子串，权重低于 n-gram（`SINGLE_CHAR_BONUS`），
 * 所以它不会盖过 2-gram 的正常结果。
 */
export const MIN_QUERY_LEN = 2;
export const SINGLE_CHAR_BONUS = 0.6;

/** 查询命中率：查询的 n-gram 里有多少出现在 hay 中。hay 为空 → 0（不能除 0）。 */
export function coverRatio(nq, hay) {
  if (!nq || !hay) return 0;
  const g = ngrams(nq);
  if (g.size === 0) return 0;
  let hit = 0;
  for (const x of g) if (hay.includes(x)) hit++;
  return hit / g.size;
}

/** 字段加权。写死在这里而不是可配置，是因为这几组权重就是 O5 的排序语义本身。 */
export const FIELD_WEIGHTS = {
  title: 5,      // 标题命中远强于正文命中 —— 对"部署"这类检索最符合直觉
  tags: 3,       // tags 是作者显式打的，比标题弱但远强于正文
  description: 2.5,
  body: 1,
};

/** 精确子串命中标题时的加分。这是"查标题里的原词"这条路径的回归锁。 */
export const EXACT_TITLE_BONUS = 4;

/**
 * 单页打分。`q` 是原始查询（内部会归一化），`p` 是 { fm, body, mtime }。
 *
 * **两步结构是刻意的**：先算查询相关度 `rel`，`rel === 0` 直接返回 0 —— 没有任何
 * 重叠的页面不允许靠"质量分 + 新鲜度"堆过 0.5 混进结果。第一版把两部分加在一起再
 * 过滤，实测查询"无所谓"也能召回 3 页（quality 1.5 + freshness 0.88 = 2.38）。
 *
 * 三条降权/加权与 `generateDraft`（scripts/llm-wiki-pipeline.mjs:840-858）刻意一致 ——
 * 读路径与写路径若用不同的召回标准，同一个库会给出两套"重要"的页面。
 */
export function scorePage(q, p, opts = {}) {
  const now = opts.now || Date.now();
  const nq = normalize(q);
  if (!nq) return 0;
  const fm = (p && p.fm) || {};
  const title = normalize(fm.title || (p && p.file) || "");
  const tags = normalize(Array.isArray(fm.tags) ? fm.tags.join(" ") : fm.tags || "");
  const desc = normalize(fm.description || fm.summary || "");
  const body = normalize(p && p.body);

  let rel = coverRatio(nq, title) * FIELD_WEIGHTS.title
        + coverRatio(nq, tags) * FIELD_WEIGHTS.tags
        + coverRatio(nq, desc) * FIELD_WEIGHTS.description
        + coverRatio(nq, body) * FIELD_WEIGHTS.body;
  if (title.includes(nq)) rel += EXACT_TITLE_BONUS;               // 精确子串强加权
  // 单字查询（"流"）没有 n-gram（ngrams("流",2) 是空集合），coverRatio 恒为 0，
  // 退化到子串匹配。**必须在 rel === 0 判定之前算进 rel** —— 第一版写在判定之后，
  // 于是每个单字查询都在"没有任何重叠"的分支里返回 0，兜底成了死代码（实测
  // scorePage("署", 标题含"署"的页) === 0）。价见 MIN_QUERY_LEN 注释。
  if (nq.length < MIN_QUERY_LEN) {
    if (title.includes(nq) || tags.includes(nq) || desc.includes(nq) || body.includes(nq)) rel += SINGLE_CHAR_BONUS;
  }
  if (rel === 0) return 0;

  let s = rel;
  s += (Number(fm.quality_score) || 0) * 0.3;                     // 质量
  if (trustTier(fm) === "human-reviewed") s += 1.5;               // 人审加权
  if (isRetired(fm)) s -= 3;                                      // 已废弃沉底
  if (fm.status === "stale") s -= 1;

  const d = fm.updated || fm.created;
  if (d && !Number.isNaN(Date.parse(d))) {
    const days = (now - Date.parse(d)) / 86400000;
    if (days >= 0) s += Math.max(0, 1 - days / 365);              // 新鲜度；未来时间不加分
  }
  return s;
}

/**
 * 排序入口。过滤阈值 0.5：低于它的命中基本是 n-gram 偶然重叠（两个单字恰好重叠就有 0.5），
 * 放进来只会噪声。返回按分数降序，同分按标题字典序，保证输出稳定可测。
 */
export const MIN_SCORE = 0.5;

export function rankPages(query, pages, opts = {}) {
  const top = opts.top > 0 ? Math.floor(opts.top) : 10;
  const min = opts.min == null ? MIN_SCORE : opts.min;
  return pages
    .map((p) => ({ p, s: scorePage(query, p, opts) }))
    .filter((x) => x.s > min)
    .sort((a, b) => b.s - a.s || normalize(a.p.fm.title || a.p.file).localeCompare(normalize(b.p.fm.title || b.p.file), "zh-Hans-CN"))
    .slice(0, top);
}
