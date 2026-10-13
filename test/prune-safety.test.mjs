/**
 * F2 回归：破坏性写入的保险
 *
 * 缺陷：pruneMemory 判断「孤儿」的唯一依据是「vault 里找不到这个文件」，而它没有任何前置检查。
 * D 盘没挂载（或 LLM_WIKI_VAULT 配错）时，整个记忆体会被判成孤儿并批量软删 —— 且不可逆。
 *
 * 同一个健康检查也保护 --index（拒绝用空内容覆盖 index.md）与 --compile-patterns
 * （拒绝在根文件系统上 mkdir 幽灵 vault 树）。
 *
 * 断言的核心不是「有没有报错」，而是**数据库里的 deleted_at 是否真的还是 NULL**。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const PIPELINE = join(HERE, "..", "scripts", "llm-wiki-pipeline.mjs");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "wiki-f2-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return { root, home, vault: join(root, "vault") };
}
function cleanup(root) { try { rmSync(root, { recursive: true, force: true }); } catch {} }

/** 建 vault：n 个页面（每页都带 wikilink，避免触发无关告警） */
function makeVault(vault, n, { withWiki = true } = {}) {
  if (withWiki) mkdirSync(join(vault, "wiki", "决策"), { recursive: true });
  else { mkdirSync(vault, { recursive: true }); return vault; }
  for (let i = 0; i < n; i++) {
    writeFileSync(join(vault, "wiki", "决策", `页${i}.md`),
      `---\ntitle: 页${i}\ntype: 决策\ncreated: 2026-01-01\n---\n\n[[wiki/决策/页0]]\n`);
  }
  return vault;
}

const DB_REL = ".mnemon/data/default/mnemon.db";

/** 建 mnemon 库，entries 是「来源: 」后面的 wiki 相对路径 */
function makeDb(home, entries) {
  const dir = join(home, ".mnemon", "data", "default");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(home, DB_REL));
  db.exec("CREATE TABLE IF NOT EXISTS insights (id INTEGER PRIMARY KEY, content TEXT, deleted_at TEXT)");
  db.exec("DELETE FROM insights");
  const ins = db.prepare("INSERT INTO insights (id, content, deleted_at) VALUES (?, ?, NULL)");
  entries.forEach((rel, i) => ins.run(i + 1, `[LLM-Wiki/决策] 标题${i}（来源: ${rel}）`));
  db.close();
}

function readDeleted(home) {
  const db = new DatabaseSync(join(home, DB_REL), { readOnly: true });
  const rows = db.prepare("SELECT id, deleted_at FROM insights ORDER BY id").all();
  db.close();
  return rows;
}

function run(vault, home, args = []) {
  const env = { ...process.env, HOME: home, LLM_WIKI_VAULT: vault, LLM_WIKI_FAKE_EMBED: "never" };
  try {
    const out = execFileSync(process.execPath, [PIPELINE, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

const MISSING = Array.from({ length: 12 }, (_, i) => `wiki/决策/不存在${i}.md`);

describe("F2 vault 健康闸门", () => {
  test("vault 不存在 → 退出码 3，记忆体一字未动", () => {
    const c = setup();
    try {
      makeDb(c.home, MISSING);
      const r = run(join(c.root, "不存在的vault"), c.home, ["--prune-memory"]);
      assert.equal(r.code, 3, "应当以退出码 3 中止");
      assert.match(r.out, /中止/);
      assert.ok(readDeleted(c.home).every((x) => x.deleted_at === null), "记忆体被改动了");
    } finally { cleanup(c.root); }
  });

  test("vault 存在但没有 wiki/ → 退出码 3，记忆体一字未动", () => {
    const c = setup();
    try {
      makeVault(c.vault, 0, { withWiki: false });
      makeDb(c.home, MISSING);
      const r = run(c.vault, c.home, ["--prune-memory"]);
      assert.equal(r.code, 3);
      assert.match(r.out, /wiki\/ 不存在/);
      assert.ok(readDeleted(c.home).every((x) => x.deleted_at === null));
    } finally { cleanup(c.root); }
  });

  test("--force 也不能越过健康闸门", () => {
    const c = setup();
    try {
      makeDb(c.home, MISSING);
      const r = run(join(c.root, "不存在的vault"), c.home, ["--prune-memory", "--force"]);
      assert.equal(r.code, 3);
      assert.ok(readDeleted(c.home).every((x) => x.deleted_at === null));
    } finally { cleanup(c.root); }
  });

  test("vault 不健康时 --all --dry-run 也中止（不会误报「一切正常」）", () => {
    const c = setup();
    try {
      const r = run(join(c.root, "不存在的vault"), c.home, ["--all", "--dry-run"]);
      assert.equal(r.code, 3);
      assert.doesNotMatch(r.out, /== lint ==/, "不健康时不应继续跑阶段");
    } finally { cleanup(c.root); }
  });
});

describe("F2 prune 的三道保险", () => {
  test("保险 2：页面数 < 10 → 拒绝（记忆体一字未动）", () => {
    const c = setup();
    try {
      makeVault(c.vault, 3);
      makeDb(c.home, MISSING);
      const r = run(c.vault, c.home, ["--prune-memory"]);
      assert.match(r.out, /页面数 3 < 10/);
      assert.ok(readDeleted(c.home).every((x) => x.deleted_at === null), "记忆体被改动了");
    } finally { cleanup(c.root); }
  });

  test("保险 3：待删比例 > 20% → 拒绝（这是「路径配错」的典型形态）", () => {
    const c = setup();
    try {
      makeVault(c.vault, 12);
      makeDb(c.home, MISSING);           // 12/12 = 100%
      const r = run(c.vault, c.home, ["--prune-memory"]);
      assert.match(r.out, /超过 20%/);
      assert.ok(readDeleted(c.home).every((x) => x.deleted_at === null), "记忆体被改动了");
    } finally { cleanup(c.root); }
  });

  test("三道保险都通过 → 正常软删，且只删该删的", () => {
    const c = setup();
    try {
      makeVault(c.vault, 12);
      const entries = [
        ...Array.from({ length: 11 }, (_, i) => `wiki/决策/页${i}.md`),  // 都存在
        "wiki/决策/已删除的页.md",                                        // 孤儿
      ];
      makeDb(c.home, entries);
      const r = run(c.vault, c.home, ["--prune-memory"]);
      assert.match(r.out, /"pruned":1/);
      const rows = readDeleted(c.home);
      assert.equal(rows.filter((x) => x.deleted_at !== null).length, 1, "应当恰好删 1 条");
      assert.equal(rows.find((x) => x.id === 12).deleted_at === null, false, "孤儿条目应当被软删");
      assert.ok(rows.slice(0, 11).every((x) => x.deleted_at === null), "存活条目被误删了");
    } finally { cleanup(c.root); }
  });

  test("--force 越过数量/比例两道保险", () => {
    const c = setup();
    try {
      makeVault(c.vault, 3);
      makeDb(c.home, MISSING);
      const r = run(c.vault, c.home, ["--prune-memory", "--force"]);
      assert.match(r.out, /"pruned":12/);
      assert.equal(readDeleted(c.home).filter((x) => x.deleted_at !== null).length, 12);
    } finally { cleanup(c.root); }
  });

  test("--dry-run 报告待删数但不写库", () => {
    const c = setup();
    try {
      makeVault(c.vault, 12);
      makeDb(c.home, [...Array.from({ length: 11 }, (_, i) => `wiki/决策/页${i}.md`), "wiki/决策/已删除的页.md"]);
      const r = run(c.vault, c.home, ["--prune-memory", "--dry-run"]);
      assert.match(r.out, /"wouldPrune":1/);
      assert.ok(readDeleted(c.home).every((x) => x.deleted_at === null), "dry-run 写库了");
    } finally { cleanup(c.root); }
  });
});

describe("F2 同一闸门保护的其它阶段", () => {
  test("页面数为 0 时 --index 拒绝覆盖 index.md", () => {
    const c = setup();
    try {
      makeVault(c.vault, 0);   // wiki/ 存在但是空的
      const before = "# 原有索引内容\n";
      writeFileSync(join(c.vault, "wiki", "index.md"), before);
      const r = run(c.vault, c.home, ["--index"]);
      assert.match(r.out, /拒绝用空内容覆盖/);
      assert.equal(readFileSync(join(c.vault, "wiki", "index.md"), "utf8"), before);
    } finally { cleanup(c.root); }
  });

  test("vault 不健康时 --compile-patterns 不创建幽灵目录树", () => {
    const c = setup();
    try {
      const ghost = join(c.root, "幽灵vault");
      const r = run(ghost, c.home, ["--compile-patterns"]);
      assert.equal(r.code, 3);
      assert.equal(existsSync(join(ghost, "wiki", "patterns")), false, "在根文件系统上造出了幽灵目录");
      assert.equal(existsSync(ghost), false, "连 vault 目录本身都不该被创建");
    } finally { cleanup(c.root); }
  });
});
