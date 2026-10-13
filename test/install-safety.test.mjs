/**
 * F7 回归：安装脚本的供应链与集成正确性
 *
 * 覆盖四类缺陷：
 *   1) vault 路径完全不预检 —— 路径错时无条件写 ~/.dsh 并启用服务，后果静默
 *   2) 追加 cordis.patch.yml 不补尾换行 —— 末行无换行时 YAML 粘连损坏；也不备份
 *   3) 追加的条目没有 config.vault —— 脚本里的 $VAULT 从未生效，插件永远回退 DEFAULT_VAULT
 *   4) 只 cp scripts/llm-wiki-pipeline.mjs，不 cp scripts/lib/ —— O1/O2 后管线
 *      import "./lib/*.mjs"，装到 ~/bin 后必然 ERR_MODULE_NOT_FOUND，而插件是
 *      detached + stdio:"ignore" 启动它的，这个错误没有任何人看得见
 *
 * 最后一个用例是关键：真的装一遍，再从 ~/bin 跑一次管线。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const INSTALL = join(ROOT, "install.sh");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "wiki-f7-"));
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

function install(home, args) {
  // 用 spawnSync 而不是 execFileSync：成功路径下也要能拿到 stderr（警告都走 stderr）
  const r = spawnSync("bash", [INSTALL, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
}

describe("F7 vault 预检", () => {
  test("vault 不存在 → 退出码 3，且一个文件都不写", () => {
    const c = setup();
    try {
      const missing = join(c.root, "没挂载的盘");
      const r = install(c.home, ["--vault", missing]);
      assert.equal(r.code, 3);
      assert.match(r.out, /vault 目录不存在/);
      assert.equal(existsSync(join(c.home, ".dsh")), false, "预检失败却写了 ~/.dsh");
      assert.equal(existsSync(join(c.home, "bin")), false, "预检失败却写了 ~/bin");
    } finally { cleanup(c.root); }
  });

  test("vault 存在但没有 wiki/ → 警告但继续（退出码 0）", () => {
    const c = setup();
    try {
      const bare = join(c.root, "空vault");
      mkdirSync(bare, { recursive: true });
      const r = install(c.home, ["--vault", bare]);
      assert.equal(r.code, 0);
      assert.match(r.out, /没有 wiki\/ 目录/);
    } finally { cleanup(c.root); }
  });
});

describe("F7 --dry-run", () => {
  test("不写任何文件", () => {
    const c = setup();
    try {
      const r = install(c.home, ["--vault", c.vault, "--dry-run"]);
      assert.equal(r.code, 0);
      assert.match(r.out, /\[dry-run\]/);
      assert.equal(existsSync(join(c.home, ".dsh")), false);
      assert.equal(existsSync(join(c.home, "bin")), false);
      assert.equal(existsSync(join(c.home, ".agents")), false);
      assert.equal(existsSync(join(c.home, ".config")), false);
    } finally { cleanup(c.root); }
  });
});

describe("F7 正常安装", () => {
  test("组件落到正确位置，且 config.vault 真的写进去了", () => {
    const c = setup();
    try {
      const r = install(c.home, ["--vault", c.vault]);
      assert.equal(r.code, 0);

      assert.ok(existsSync(join(c.home, ".dsh/profiles/web/dsh-llm-wiki.mjs")), "插件未复制");

      const patch = readFileSync(join(c.home, ".dsh/profiles/web/cordis.patch.yml"), "utf8");
      assert.match(patch, /id: llm-wiki/);
      assert.ok(patch.includes(`vault: "${c.vault}"`), "追加的条目缺少 config.vault —— $VAULT 等于没生效");

      for (const f of ["llm-wiki-pipeline.mjs", "embed-proxy.mjs"]) {
        assert.ok(existsSync(join(c.home, "bin", f)), `${f} 未复制`);
      }
      // F7-4 的核心断言
      for (const f of ["frontmatter.mjs", "hash.mjs", "paths.mjs"]) {
        assert.ok(existsSync(join(c.home, "bin", "lib", f)), `scripts/lib/${f} 未复制到 ~/bin/lib/`);
      }
      assert.ok(statSync(join(c.home, "bin", "llm-wiki-pipeline.mjs")).mode & 0o111, "管线未加可执行位");

      for (const s of ["wiki-search", "wiki-write"]) {
        const txt = readFileSync(join(c.home, ".agents/skills", s, "SKILL.md"), "utf8");
        assert.doesNotMatch(txt, /\{\{VAULT\}\}/, `${s}/SKILL.md 的 {{VAULT}} 没被替换`);
        assert.ok(txt.includes(c.vault), `${s}/SKILL.md 里没有实际 vault 路径`);
      }

      for (const u of ["llm-wiki-pipeline.service", "llm-wiki-pipeline.timer", "embed-proxy.service"]) {
        assert.ok(existsSync(join(c.home, ".config/systemd/user", u)), `${u} 未复制`);
      }
      assert.match(r.out, /未启用/, "默认不应启用服务");
    } finally { cleanup(c.root); }
  });

  test("末行无换行的 cordis.patch.yml：补换行 + 备份，YAML 不粘连", () => {
    const c = setup();
    try {
      const dir = join(c.home, ".dsh/profiles/web");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "cordis.patch.yml"), "- insert:\n    - id: other\n      name: ./other.mjs");  // 无尾换行
      const r = install(c.home, ["--vault", c.vault]);
      assert.equal(r.code, 0);

      const patch = readFileSync(join(dir, "cordis.patch.yml"), "utf8");
      assert.doesNotMatch(patch, /other\.mjs- insert:/, "YAML 粘连了：追加前没补尾换行");
      assert.match(patch, /^ {0,2}- insert:$/m);
      assert.ok(readdirSync(dir).some((f) => f.startsWith("cordis.patch.yml.bak.")), "追加前没有备份");
    } finally { cleanup(c.root); }
  });

  test("已含 llm-wiki 条目 → 跳过，不重复追加", () => {
    const c = setup();
    try {
      const dir = join(c.home, ".dsh/profiles/web");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "cordis.patch.yml"), "- insert:\n    - id: llm-wiki\n      name: ./dsh-llm-wiki.mjs\n");
      const r = install(c.home, ["--vault", c.vault]);
      assert.equal(r.code, 0);
      assert.match(r.out, /已含 llm-wiki 条目/);
      const patch = readFileSync(join(dir, "cordis.patch.yml"), "utf8");
      assert.equal(patch.match(/id: llm-wiki/g).length, 1, "重复追加了");
    } finally { cleanup(c.root); }
  });
});

describe("F7 装完之后管线真的能跑", () => {
  test("从 ~/bin 跑装好的管线（验证 scripts/lib 被带上）", () => {
    const c = setup();
    try {
      assert.equal(install(c.home, ["--vault", c.vault]).code, 0);
      const out = execFileSync(process.execPath, [join(c.home, "bin", "llm-wiki-pipeline.mjs"), "--all", "--dry-run"], {
        encoding: "utf8",
        cwd: tmpdir(),   // 刻意离开仓库目录：证明它不依赖仓库里的相对路径
        env: { ...process.env, HOME: c.home, LLM_WIKI_VAULT: c.vault, LLM_WIKI_FAKE_EMBED: "never" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.match(out, /== lint ==/, "装好的管线没能跑起来（多半是 scripts/lib 没复制）");
      assert.match(out, /页面数: 12/);
    } finally { cleanup(c.root); }
  });
});
