/**
 * F1 回归：--rate 的路径守卫
 *
 * 缺陷：ratePage 用 `join(VAULT, rel)` 直接拼接命令行传入的路径，没有任何包含性检查。
 * 模型（或任何能调这条命令的人）可以用 `../outside/secret.md` 改写 vault 之外的任意 .md 文件。
 *
 * 这里同时测两层：
 *   1. 纯函数 safeJoinVault 的判定（不依赖子进程，跑得快）
 *   2. 走 CLI 的端到端行为 —— 关键是断言「目标文件逐字节未变」，而不是只看有没有报错
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { safeJoinVault, isInside } from "../scripts/lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PIPELINE = join(HERE, "..", "scripts", "llm-wiki-pipeline.mjs");

const SECRET_BODY = "---\ntitle: secret\nquality_score: 1\n---\n\nDO NOT TOUCH\n";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "wiki-f1-"));
  const vault = join(root, "vault");
  const outside = join(root, "outside");
  mkdirSync(join(vault, "wiki", "决策"), { recursive: true });
  mkdirSync(join(vault, "raw"), { recursive: true });
  mkdirSync(outside, { recursive: true });

  const secret = join(outside, "secret.md");
  writeFileSync(secret, SECRET_BODY);
  const rawPage = join(vault, "raw", "sessions.md");
  writeFileSync(rawPage, SECRET_BODY);

  const page = join(vault, "wiki", "决策", "正常页.md");
  writeFileSync(page, "---\ntitle: 正常页\ntype: 决策\ncreated: 2026-01-01\nquality_score: 2\n---\n\n[[wiki/决策/其他]]\n");

  // 符号链接：字面看它在 vault 内，realpath 之后指向 vault 外
  symlinkSync(secret, join(vault, "wiki", "链接.md"));

  return { root, vault, outside, secret, rawPage, page };
}

function cleanup(root) { try { rmSync(root, { recursive: true, force: true }); } catch {} }

function runRate(vault, args, { home } = {}) {
  const env = { ...process.env, LLM_WIKI_VAULT: vault, LLM_WIKI_FAKE_EMBED: "never" };
  if (home) env.HOME = home;
  try {
    const out = execFileSync(process.execPath, [PIPELINE, "--rate", ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

describe("safeJoinVault（纯函数）", () => {
  test("接受 vault 内的 .md", () => {
    const c = setup();
    try {
      const r = safeJoinVault("wiki/决策/正常页.md", c.vault);
      assert.ok(r, "应当接受");
      assert.equal(r.rel, "wiki/决策/正常页.md");
      assert.equal(r.full, c.page);
    } finally { cleanup(c.root); }
  });

  test("拒绝 ../ 越界（文件确实存在也要拒绝）", () => {
    const c = setup();
    try {
      assert.equal(safeJoinVault("../outside/secret.md", c.vault), null);
      assert.equal(safeJoinVault("wiki/../../outside/secret.md", c.vault), null);
      assert.equal(safeJoinVault("wiki/决策/../../../outside/secret.md", c.vault), null);
    } finally { cleanup(c.root); }
  });

  test("拒绝绝对路径", () => {
    const c = setup();
    try {
      assert.equal(safeJoinVault(c.secret, c.vault), null);
      assert.equal(safeJoinVault("/etc/hosts", c.vault), null);
    } finally { cleanup(c.root); }
  });

  test("拒绝非 .md 与空串 / NUL", () => {
    const c = setup();
    try {
      writeFileSync(join(c.vault, "wiki", "notmd.txt"), "x");
      assert.equal(safeJoinVault("wiki/notmd.txt", c.vault), null);
      assert.equal(safeJoinVault("", c.vault), null);
      assert.equal(safeJoinVault("wiki/\0x.md", c.vault), null);
      assert.equal(safeJoinVault(null, c.vault), null);
    } finally { cleanup(c.root); }
  });

  test("拒绝经符号链接指向 vault 外的路径（字面检查会放过它）", () => {
    const c = setup();
    try {
      // 字面看完全合法
      assert.equal(safeJoinVault("wiki/链接.md", c.vault, { mustExist: false }).rel, "wiki/链接.md");
      // 穿透之后必须拒绝
      assert.equal(safeJoinVault("wiki/链接.md", c.vault), null);
    } finally { cleanup(c.root); }
  });

  test("vault 不存在时一律拒绝", () => {
    const c = setup();
    try {
      assert.equal(safeJoinVault("wiki/决策/正常页.md", join(c.root, "不存在")), null);
    } finally { cleanup(c.root); }
  });

  test("isInside 处理根目录与同路径", () => {
    assert.equal(isInside("/a/b", "/a"), true);
    assert.equal(isInside("/a", "/a"), true);
    assert.equal(isInside("/ab", "/a"), false);   // 前缀相同但不是子路径
    assert.equal(isInside("/x/y", "/"), true);    // 根目录
  });
});

describe("--rate 端到端（F1 回归）", () => {
  test("拒绝 ../ 越界，且 vault 外文件逐字节未变", () => {
    const c = setup();
    try {
      const before = readFileSync(c.secret, "utf8");
      const r = runRate(c.vault, ["../outside/secret.md", "--rating", "useful"]);
      assert.match(r.out, /拒绝/);
      assert.equal(readFileSync(c.secret, "utf8"), before, "vault 外文件被改写了");
      assert.equal(readFileSync(c.secret, "utf8"), SECRET_BODY);
    } finally { cleanup(c.root); }
  });

  test("拒绝绝对路径，且目标未变", () => {
    const c = setup();
    try {
      const r = runRate(c.vault, [c.secret, "--rating", "useful"]);
      assert.match(r.out, /拒绝/);
      assert.equal(readFileSync(c.secret, "utf8"), SECRET_BODY);
    } finally { cleanup(c.root); }
  });

  test("拒绝符号链接穿透，且链接目标未变", () => {
    const c = setup();
    try {
      const r = runRate(c.vault, ["wiki/链接.md", "--rating", "useful"]);
      assert.match(r.out, /拒绝/);
      assert.equal(readFileSync(c.secret, "utf8"), SECRET_BODY);
    } finally { cleanup(c.root); }
  });

  test("拒绝给 raw/ 下的非知识页打分", () => {
    const c = setup();
    try {
      const r = runRate(c.vault, ["raw/sessions.md", "--rating", "useful"]);
      assert.match(r.out, /只能给 wiki\//);
      assert.equal(readFileSync(c.rawPage, "utf8"), SECRET_BODY);
    } finally { cleanup(c.root); }
  });

  test("拒绝不存在的文件与缺少 .md 后缀（两者诊断不同）", () => {
    const c = setup();
    try {
      assert.match(runRate(c.vault, ["wiki/决策/没有这个.md", "--rating", "useful"]).out, /文件不存在/);
      assert.match(runRate(c.vault, ["wiki/决策/正常页", "--rating", "useful"]).out, /只接受 \.md/);
    } finally { cleanup(c.root); }
  });

  test("正常路径通过，quality_score 提升", () => {
    const c = setup();
    try {
      const r = runRate(c.vault, ["wiki/决策/正常页.md", "--rating", "useful"]);
      assert.match(r.out, /"ok":true/);
      assert.match(readFileSync(c.page, "utf8"), /quality_score: 3/);
    } finally { cleanup(c.root); }
  });

  test("outdated 撤销 verified 标记（连同块映射续行）", () => {
    const c = setup();
    try {
      writeFileSync(c.page, "---\ntitle: 正常页\ntype: 决策\ncreated: 2026-01-01\nquality_score: 4\nverified:\n  by: agent/dsh-llm-wiki\n  at: 2026-01-01T00:00:00Z\nstatus: active\n---\n\n[[wiki/决策/其他]]\n");
      const r = runRate(c.vault, ["wiki/决策/正常页.md", "--rating", "outdated"]);
      assert.match(r.out, /"ok":true/);
      const after = readFileSync(c.page, "utf8");
      assert.doesNotMatch(after, /verified/, "verified 应当被撤销");
      assert.doesNotMatch(after, /agent\/dsh-llm-wiki/, "verified 的续行未被清理");
      assert.match(after, /status: stale/);
      assert.match(after, /quality_score: 3/);
    } finally { cleanup(c.root); }
  });

  test("--dry-run 不写盘", () => {
    const c = setup();
    try {
      const before = readFileSync(c.page, "utf8");
      const r = runRate(c.vault, ["wiki/决策/正常页.md", "--rating", "useful", "--dry-run"]);
      assert.match(r.out, /dry-run/);
      assert.equal(readFileSync(c.page, "utf8"), before);
    } finally { cleanup(c.root); }
  });
});
