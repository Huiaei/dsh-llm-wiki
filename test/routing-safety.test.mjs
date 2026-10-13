/**
 * F3 回归：路由拆分
 *
 * 缺陷：`--all` 把九个阶段（含 prune-memory / dsh-export / compile-patterns）绑在一起，
 * 而插件在每次 session/disposed 后都会跑 `--all` —— 即「每结束一次会话，就顺手跑一遍
 * 批量软删记忆体 + 把会话记录导出到 D 盘」。破坏性操作不该挂在生命周期钩子上。
 *
 * 本测试同时覆盖两半：
 *   1) 管线侧：--all 只跑安全阶段；破坏性阶段必须显式点名
 *   2) 插件侧：spawn 的 argv 里不能出现 --all，也不能出现任何破坏性阶段
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PIPELINE = join(ROOT, "scripts", "llm-wiki-pipeline.mjs");
const PLUGIN = join(ROOT, "plugin", "dsh-llm-wiki.mjs");

const SAFE = ["--lint", "--index", "--usage", "--okf", "--docs-sync", "--sync"];
const DESTRUCTIVE = ["--compile-patterns", "--dsh-export", "--prune-memory"];

function setup() {
  const root = mkdtempSync(join(tmpdir(), "wiki-f3-"));
  const home = join(root, "home");
  const vault = join(root, "vault");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(vault, "wiki", "决策"), { recursive: true });
  for (let i = 0; i < 12; i++) {
    writeFileSync(join(vault, "wiki", "决策", `页${i}.md`),
      `---\ntitle: 页${i}\ntype: 决策\ncreated: 2026-01-01\n---\n\n[[wiki/决策/页0]]\n`);
  }
  writeFileSync(join(vault, "schema.md"), "# schema\n");
  return { root, home, vault };
}
function cleanup(root) { try { rmSync(root, { recursive: true, force: true }); } catch {} }

function run(vault, home, args) {
  const env = { ...process.env, HOME: home, LLM_WIKI_VAULT: vault, LLM_WIKI_FAKE_EMBED: "never" };
  try {
    return execFileSync(process.execPath, [PIPELINE, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return String(e.stdout || "") + String(e.stderr || "");
  }
}

// "== lint ==" → "lint"（slice(3,-3)，写成 4/-4 会得到 "in"）
const stagesIn = (out) => out.match(/^== (.+) ==$/gm)?.map((s) => s.slice(3, -3)) ?? [];

describe("F3 管线路由", () => {
  test("--all 只跑安全阶段，破坏性阶段一个都不出现", () => {
    const c = setup();
    try {
      const out = run(c.vault, c.home, ["--all", "--dry-run"]);
      const stages = stagesIn(out);
      for (const s of ["lint", "index", "usage", "okf", "docs-sync", "sync"]) {
        assert.ok(stages.includes(s), `--all 应包含安全阶段 ${s}，实际: ${stages.join(",")}`);
      }
      for (const s of ["compile-patterns", "dsh-export", "prune-memory"]) {
        assert.ok(!stages.includes(s), `--all 不应包含破坏性阶段 ${s}`);
      }
    } finally { cleanup(c.root); }
  });

  test("破坏性阶段显式点名时仍然可用", () => {
    const c = setup();
    try {
      for (const flag of DESTRUCTIVE) {
        const stages = stagesIn(run(c.vault, c.home, [flag, "--dry-run"]));
        assert.deepEqual(stages, [flag.slice(2)], `${flag} 应单独执行，实际: ${stages.join(",")}`);
      }
    } finally { cleanup(c.root); }
  });

  test("显式点名某个安全阶段时不会顺带跑其它阶段", () => {
    const c = setup();
    try {
      assert.deepEqual(stagesIn(run(c.vault, c.home, ["--lint"])), ["lint"]);
      assert.deepEqual(stagesIn(run(c.vault, c.home, ["--lint", "--okf", "--dry-run"])), ["lint", "okf"]);
    } finally { cleanup(c.root); }
  });

  test("--rate 是终止型动作，不触发任何管线阶段", () => {
    const c = setup();
    try {
      const out = run(c.vault, c.home, ["--rate", "wiki/决策/页0.md", "--rating", "useful"]);
      // --rate 有自己的表头，但不应继续跑九个阶段中的任何一个
      assert.deepEqual(stagesIn(out), ["rate"], "打分不应触发管线阶段");
      assert.match(out, /"score":1/);
    } finally { cleanup(c.root); }
  });
});

describe("F3 插件侧：生命周期钩子只跑安全阶段", () => {
  let argv = null;

  before(async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-f3p-"));
    const rec = join(root, "recorder.mjs");
    const out = join(root, "argv.txt");
    writeFileSync(rec, 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.RECORD_FILE, process.argv.slice(2).join(" "));\n');
    process.env.RECORD_FILE = out;
    process.env.LLM_WIKI_PIPELINE = rec;   // 必须在 import 插件之前设置：PIPELINE 是模块级常量

    const mod = await import(pathToFileURL(PLUGIN).href);
    const handlers = {};
    const sections = [];
    const ctx = {
      effect: (fn) => { try { fn(); } catch {} },
      systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
      on: (ev, fn) => { handlers[ev] = fn; },
    };
    mod.apply(ctx, { vault: join(root, "vault") });
    assert.ok(handlers["session/disposed"], "插件应注册 session/disposed 钩子");
    assert.equal(sections.length, 2, "插件应注册两个 systemPrompt section");

    handlers["session/disposed"]();   // F3：延迟 5s + 单次

    const deadline = Date.now() + 15_000;
    while (!existsSync(out) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    argv = existsSync(out) ? readFileSync(out, "utf8").trim() : null;
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  });

  test("插件 spawn 的 argv 不含 --all，也不含任何破坏性阶段", () => {
    assert.ok(argv !== null, "插件没有在 15s 内触发管线");
    const parts = argv.split(/\s+/).filter(Boolean);
    assert.ok(!parts.includes("--all"), "插件仍在用 --all，破坏性阶段会随上游改动被带进来");
    for (const flag of DESTRUCTIVE) {
      assert.ok(!parts.includes(flag), `插件不应触发破坏性阶段 ${flag}`);
    }
    for (const s of ["--lint", "--index", "--okf", "--usage", "--sync"]) {
      assert.ok(parts.includes(s), `插件应点名安全阶段 ${s}`);
    }
  });
});
