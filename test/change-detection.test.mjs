/**
 * O2 回归测试：语义哈希变更检测
 *
 * 这里锁定的核心性质是：**变更检测只认「消费方关心的内容」，不认 mtime、不认纯遥测字段。**
 * 旧实现 `state[rel].mtime !== p.mtime` 在两个方向上都错——
 *   - 漏：usageSync/okfAlign 用 utimesSync 把 mtime 恢复成旧值，管线自己改的 description/quality_score
 *         永远不会被重新同步；
 *   - 误：Obsidian 保存、同步盘、git checkout 任何一次触碰都改 mtime → 全量重导。
 *
 * 运行: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  STATE_SCHEMA, TELEMETRY_FIELDS, sha16, trustTier, isRetired, TRUST_IMPORTANCE,
  pageHashes, stateEntry, changedPages,
} from "../scripts/lib/hash.mjs";

/** 造一个足够真实的页面对象（pageHashes 只消费 cat / fm / body） */
function page(over = {}) {
  const fm = {
    title: "T",
    type: "决策",
    tags: ["wiki/决策"],
    quality_score: "3",
    status: "active",
    ...(over.fm || {}),
  };
  const body = over.body === undefined ? "正文\n" : over.body;
  return {
    rel: over.rel || "wiki/决策/T.md",
    cat: over.cat || "决策",
    fm,
    body,
    mtime: over.mtime === undefined ? 1000 : over.mtime,
    size: over.size === undefined ? 100 : over.size,
  };
}

test("sha16 稳定且为 16 位十六进制", () => {
  assert.match(sha16("x"), /^[0-9a-f]{16}$/);
  assert.equal(sha16("x"), sha16("x"));
  assert.notEqual(sha16("x"), sha16("y"));
  assert.equal(sha16(""), sha16(""));
});

test("STATE_SCHEMA 提升为 2（v1 是纯 mtime 结构）", () => {
  assert.equal(STATE_SCHEMA, 2);
});

test("trustTier：消费 README 声明的 verified 字段", () => {
  assert.equal(trustTier({ verified: { by: "human:alice" } }), "human-reviewed");
  assert.equal(trustTier({ verified: { by: "agent/dsh-llm-wiki" } }), "machine-confirmed");
  assert.equal(trustTier({ quality_score: "3" }), "machine-confirmed", "无 verified 但质量分够");
  assert.equal(trustTier({ quality_score: "1" }), "unverified");
  assert.equal(trustTier({ verified: "human:bob" }), "human-reviewed", "字符串形态也要认");
  assert.equal(trustTier({}), "unverified");
  assert.equal(TRUST_IMPORTANCE["human-reviewed"], 5);
});

test("isRetired：superseded_by / status=archived 都不参与召回", () => {
  assert.equal(isRetired({ superseded_by: "[[wiki/决策/新方案]]" }), true);
  assert.equal(isRetired({ status: "archived" }), true);
  assert.equal(isRetired({ status: "active" }), false);
  assert.equal(isRetired({ status: "stale" }), false, "stale 仍可召回，只是降权");
  assert.equal(isRetired({}), false);
});

test("draft 指纹只对「消费方关心的字段」敏感", () => {
  const base = page();
  const h0 = pageHashes(base);
  const sensitive = {
    title: { fm: { title: "T2" } },
    description: { fm: { description: "新描述" } },
    project: { fm: { project: "p" } },
    quality_score: { fm: { quality_score: "5" } },
    status: { fm: { status: "stale" } },
    tags: { fm: { tags: ["wiki/决策", "x"] } },
    trust: { fm: { verified: { by: "human:alice" } } },
    cat: { cat: "概念" },
  };
  for (const [name, over] of Object.entries(sensitive)) {
    assert.notEqual(pageHashes(page(over)).draft, h0.draft, name + " 变化必须改 draft 指纹");
  }
  // 正文不属于 draft
  assert.equal(pageHashes(page({ body: "完全不同的正文" })).draft, h0.draft);
});

test("纯遥测字段（queried_count / last_queried）不进 full 指纹", () => {
  assert.ok(TELEMETRY_FIELDS.has("queried_count") && TELEMETRY_FIELDS.has("last_queried"));
  const h0 = pageHashes(page());
  const h1 = pageHashes(page({ fm: { queried_count: "9", last_queried: "2026-10-13" } }));
  assert.equal(h1.draft, h0.draft);
  assert.equal(h1.full, h0.full, "管线自己每轮回写的热度不该制造漂移");
});

test("frontmatter 键顺序不影响 full 指纹", () => {
  const a = pageHashes(page({ fm: { title: "T", project: "p", quality_score: "3" } }));
  const b = pageHashes(page({ fm: { quality_score: "3", title: "T", project: "p" } }));
  assert.equal(a.full, b.full);
});

test("正文变化只动 body / full，不动 draft", () => {
  const h0 = pageHashes(page());
  const h1 = pageHashes(page({ body: "改过的正文\n" }));
  assert.equal(h1.draft, h0.draft);
  assert.notEqual(h1.body, h0.body);
  assert.notEqual(h1.full, h0.full);
});

test("stateEntry 带 schema 与三个指纹", () => {
  const p = page();
  const e = stateEntry(p);
  assert.equal(e.schema, STATE_SCHEMA);
  assert.equal(e.mtime, p.mtime);
  assert.equal(e.size, p.size);
  assert.deepEqual([e.draft, e.body, e.full], [p.hashes ? p.hashes.draft : e.draft, e.body, e.full]);
  assert.match(e.draft, /^[0-9a-f]{16}$/);
});

test("changedPages：无 state / v1 state → 全部 changed", () => {
  const p = page();
  assert.equal(changedPages([p], {}).changed.length, 1);
  // v1 结构（只有 mtime/size，没有 schema）必须被当成未知 → 重算一次
  const v1 = { [p.rel]: { mtime: p.mtime, size: p.size } };
  const r = changedPages([p], v1);
  assert.equal(r.changed.length, 1);
  assert.equal(r.drift.length, 0);
});

test("changedPages：内容没变 → 零动作（即使 mtime 被触碰）", () => {
  const p = page();
  const state = { [p.rel]: stateEntry(p) };
  // Obsidian 保存 / 同步盘 / git checkout：内容一致，只有 mtime 变了
  const touched = page({ mtime: 999999 });
  const r = changedPages([touched], state);
  assert.equal(r.changed.length, 0, "旧实现会在这里全量重导");
  assert.equal(r.drift.length, 0);
});

test("changedPages：两个列表互斥且语义正确", () => {
  const p = page();
  const state = { [p.rel]: stateEntry(p) };

  // 1) 只有遥测变化 → 零动作（旧实现：mtime 被 utimesSync 伪装 → 漏；按文件哈希 → 误）
  const tele = page({ fm: { queried_count: "9", last_queried: "2026-10-13" }, mtime: 5555 });
  let r = changedPages([tele], state);
  assert.equal(r.changed.length, 0);
  assert.equal(r.drift.length, 0);

  // 2) quality_score 变化 → 影响召回权重 → changed
  r = changedPages([page({ fm: { quality_score: "5" } })], state);
  assert.deepEqual(r.changed.map(x => x.rel), [p.rel]);
  assert.equal(r.drift.length, 0, "changed 与 drift 互斥");

  // 3) 只改正文 → 不重导，但要认下漂移
  r = changedPages([page({ body: "Obsidian 里改的正文\n" })], state);
  assert.equal(r.changed.length, 0);
  assert.equal(r.drift.length, 1);
  assert.equal(r.bodyDrift.length, 1, "应识别为正文漂移");

  // 4) 只改非遥测 frontmatter（如 created）→ drift，但不是正文漂移
  r = changedPages([page({ fm: { created: "2026-01-01" } })], state);
  assert.equal(r.changed.length, 0);
  assert.equal(r.drift.length, 1);
  assert.equal(r.bodyDrift.length, 0);

  // 5) git checkout 还原到原状 → 零动作
  r = changedPages([page()], state);
  assert.equal(r.changed.length + r.drift.length, 0);
});

test("退役必须被检出为 changed（否则页面永远留在召回里）", () => {
  const p = page();
  const state = { [p.rel]: stateEntry(p) };
  // 加 superseded_by：draft 指纹必须变，否则管线以为"什么都没发生"
  const retired = page({ fm: { superseded_by: "[[wiki/决策/新方案]]" } });
  const r = changedPages([retired], state);
  assert.deepEqual(r.changed.map(x => x.rel), [p.rel]);
  // status=archived 同理（status 本来就在 draft 里，这里锁住行为）
  const archived = page({ fm: { status: "archived" } });
  assert.equal(changedPages([archived], state).changed.length, 1);
});

test("场景表：五种典型改动各自的判定", () => {
  const p = page();
  const state = { [p.rel]: stateEntry(p) };
  const table = [
    ["usageSync 回写 queried_count", { fm: { queried_count: "4" } }, "none"],
    ["改 quality_score", { fm: { quality_score: "5" } }, "changed"],
    ["Obsidian 只改正文", { body: "新正文\n" }, "drift"],
    ["改标题", { fm: { title: "新标题" } }, "changed"],
    ["git checkout 恢复原状", {}, "none"],
  ];
  for (const [name, over, want] of table) {
    const r = changedPages([page(over)], state);
    const got = r.changed.length ? "changed" : r.drift.length ? "drift" : "none";
    assert.equal(got, want, name + " 期望 " + want + "，实际 " + got);
  }
});
