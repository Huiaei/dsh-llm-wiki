/**
 * F5 回归：会话导出的三道闸（默认关闭 / 迁出 vault / 脱敏）+ zstd 内置解码
 *
 * 缺陷（H5）：`--dsh-export` 把 user/assistant 全文写进 VAULT/raw/sessions/dsh/，
 * 插件每次 session/disposed 都会触发 → 静默、无逐会话同意。vault 在 /mnt/d：
 * Windows 可写、可能被 Obsidian 同步或共享。技能文件写着「密钥不入库」，但会话里
 * **粘贴过**的密钥会以「会话复盘」的形式落进同一个 vault。
 *
 * 主手段不是脱敏（一定漏得掉），而是：
 *   ① 默认关闭 —— 不显式 opt-in 就什么都不做；
 *   ② 输出默认落在 ~/.dsh/llm-wiki/sessions-export，不进 Obsidian；
 *   ③ 只导最近 7 天、最多 20 个，不做全历史静默导出。
 * 脱敏只是兜底，且会在 frontmatter 里如实记 `redacted: true/false`。
 *
 * 另外锁一个环境事实：本机没有 zstd 二进制，所以实现必须走 node:zlib 的
 * zstdDecompressSync —— 否则在最小安装的 Linux 上整阶段静默失败。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { zstdCompressSync } from "node:zlib";
import { redactSecrets, hasSecrets, SECRET_PATTERNS } from "../scripts/lib/redact.mjs";

const PIPELINE = new URL("../scripts/llm-wiki-pipeline.mjs", import.meta.url).pathname;

/** 造一个假的 DSH 会话目录：~/.dsh/sessions/<ws>/session-<id>/session.jsonl.zstd */
function makeSession(home, ws, id, { cwd = "/tmp/proj", createdAt, user, assistant, mtimeDaysAgo = 0 }) {
  const dir = join(home, ".dsh/sessions", ws, `session-${id}`);
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", cwd, agentPreset: "default", createdAt: createdAt || Date.now() }),
    JSON.stringify({ type: "agent/inbox/spliced", data: { inserted: [{ role: "user", content: [{ text: user }] }] } }),
    JSON.stringify({ type: "text-chunks", data: { turn: 1, texts: [assistant] } }),
  ];
  writeFileSync(join(dir, "session.jsonl.zstd"), zstdCompressSync(Buffer.from(lines.join("\n") + "\n")));
  if (mtimeDaysAgo > 0) {
    const t = Date.now() / 1000 - mtimeDaysAgo * 86400;
    // 用 utimes 把 mtime 戳回 N 天前，好让「最近 7 天」窗口能把它排除掉
    utimesSync(join(dir, "session.jsonl.zstd"), t, t);
  }
  return dir;
}

/** 造一个最小但「健康」的 vault（否则 main() 的总闸会跳过全部阶段） */
function makeVault(root) {
  const vault = join(root, "vault");
  for (const c of ["决策", "发现", "概念"]) mkdirSync(join(vault, "wiki", c), { recursive: true });
  mkdirSync(join(vault, "wiki", "index"), { recursive: true });
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(vault, "wiki", "决策", `页${i}.md`),
      `---\ntitle: "页${i}"\ntype: 决策\ncreated: 2026-01-01\n---\n\n[[wiki/决策/其他]]\n`);
  }
  return vault;
}

function runPipeline(home, vault, { extra = [], enabled = true } = {}) {
  const env = {
    ...process.env,
    HOME: home,
    LLM_WIKI_VAULT: vault,
    LLM_WIKI_FAKE_EMBED: "never",
    // 隔离：不许读到真实 ~/.dsh/sessions
    LLM_WIKI_STATE: join(home, ".dsh/llm-wiki/pipeline-state.json"),
    LLM_WIKI_EXPORT_SESSIONS: enabled ? "1" : undefined,
  };
  const out = execFileSync(process.execPath, [PIPELINE, "--dsh-export", ...extra],
    { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  return out.replace(/\x1b\[[0-9;]*m/g, "");
}

const SECRET_ROOM = [
  ["sk-", "sk-abcdefghijklmnopqrstuvwxyz0123456789"],
  ["ghp_", "ghp_abcdefghijklmnopqrstuvwxyz012345"],
  ["AWS AKIA", "AKIAIOSFODNN7EXAMPLE"],
  ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
  ["PEM", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----"],
  ["password:", "password: hunter2hunter2hunter2"],
  ["Bearer", "Authorization: Bearer abcdefghijklmnop1234567890"],
];

describe("F5 ① 默认关闭", () => {
  test("不给 LLM_WIKI_EXPORT_SESSIONS=1 时，什么都不写", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-f5a-"));
    const home = join(root, "home"); mkdirSync(home, { recursive: true });
    const vault = makeVault(root);
    try {
      makeSession(home, "ws1", "aaaabbbb", { user: "普通对话，无密钥", assistant: "好的" });
      const out = runPipeline(home, vault, { enabled: false });
      assert.match(out, /已禁用/, "应打印禁用提示");
      assert.match(out, /LLM_WIKI_EXPORT_SESSIONS=1/, "应给出开启方式");
      // 默认目录与 vault 内旧路径都不应有新文件
      assert.ok(!existsSync(join(home, ".dsh/llm-wiki/sessions-export")), "默认导出目录不该被创建");
      assert.ok(!existsSync(join(vault, "raw/sessions/dsh")), "vault 内旧路径不该有内容");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("禁用时 summary 记 dsh:禁用（可观测，不是静默跳过）", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-f5b-"));
    const home = join(root, "home"); mkdirSync(home, { recursive: true });
    const vault = makeVault(root);
    try {
      const out = runPipeline(home, vault, { enabled: false });
      assert.match(out, /\[已禁用\]/, "stdout 应告知用户为什么没做");
      // summary 落在 vault/log.md —— 断言那里，因为「日志里有没有记」才是可观测性
      const logMd = readFileSync(join(vault, "log.md"), "utf8");
      assert.match(logMd, /dsh:禁用/, "log.md 摘要应记入 dsh:禁用");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("F5 ② 输出迁出 vault", () => {
  test("开启后默认写到 ~/.dsh/llm-wiki/sessions-export，vault 内无文件", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-f5c-"));
    const home = join(root, "home"); mkdirSync(home, { recursive: true });
    const vault = makeVault(root);
    try {
      makeSession(home, "ws1", "aaaabbbb", { user: "你好", assistant: "在的" });
      const out = runPipeline(home, vault);
      assert.match(out, /"exported":\s*1/);
      const outDir = join(home, ".dsh/llm-wiki/sessions-export");
      assert.ok(existsSync(outDir), "应写到 HOME 下的 sessions-export");
      const files = readdirSync(outDir).filter(f => f.endsWith(".md"));
      assert.equal(files.length, 1, "应恰好导出 1 个");
      assert.ok(!existsSync(join(vault, "raw/sessions/dsh")), "vault 内旧路径必须为空");
      // 幂等：同 mtime 再跑一次不该重写
      const out2 = runPipeline(home, vault);
      assert.match(out2, /"exported":\s*0/);
      assert.equal(readdirSync(outDir).filter(f => f.endsWith(".md")).length, 1, "不应重复导出");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("显式把导出目录指回 vault 时写 .no-sync 哨兵（可反悔但留痕）", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-f5d-"));
    const home = join(root, "home"); mkdirSync(home, { recursive: true });
    const vault = makeVault(root);
    const inVault = join(vault, "raw/sessions/dsh");
    try {
      makeSession(home, "ws1", "aaaabbbb", { user: "你好", assistant: "在的" });
      const out = runPipeline(home, vault, { extra: [] });
      // 这一步不经过环境变量注入，所以换成直接设 env 的方式再跑一次
      const env = { ...process.env, HOME: home, LLM_WIKI_VAULT: vault,
        LLM_WIKI_FAKE_EMBED: "never", LLM_WIKI_EXPORT_SESSIONS: "1",
        LLM_WIKI_EXPORT_DIR: inVault,
        LLM_WIKI_STATE: join(home, ".dsh/llm-wiki/pipeline-state.json") };
      execFileSync(process.execPath, [PIPELINE, "--dsh-export"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
      assert.ok(existsSync(join(inVault, ".no-sync")), "导出目录在 vault 内时应写 .no-sync");
      assert.match(readFileSync(join(inVault, ".no-sync"), "utf8"), /排除/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("F5 ③ 窗口闸：--since / --limit", () => {
  test("默认只导最近 7 天：40 天前的会话被排除", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-f5e-"));
    const home = join(root, "home"); mkdirSync(home, { recursive: true });
    const vault = makeVault(root);
    try {
      makeSession(home, "ws1", "oldold01", { user: "旧会话", assistant: "回复", mtimeDaysAgo: 40 });
      const out = runPipeline(home, vault);
      assert.match(out, /"exported":\s*0/, "40 天前的会话不该被导出");
      const outDir = join(home, ".dsh/llm-wiki/sessions-export");
      if (existsSync(outDir)) {
        assert.equal(readdirSync(outDir).filter(f => f.endsWith(".md")).length, 0);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("--since 1970-01-01 放行历史会话，--limit 1 截断", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-f5f-"));
    const home = join(root, "home"); mkdirSync(home, { recursive: true });
    const vault = makeVault(root);
    try {
      makeSession(home, "ws1", "oldold01", { user: "旧会话", assistant: "回复", mtimeDaysAgo: 40 });
      makeSession(home, "ws1", "newnew01", { user: "新会话", assistant: "回复" });
      makeSession(home, "ws1", "newnew02", { user: "新会话2", assistant: "回复" });
      // 1970-01-01 是「确实要全历史」的唯一显式写法 —— 它不可能是默认值，
      // 也就不可能因为误操作把 3 年对话倒出来。
      const out = runPipeline(home, vault, { extra: ["--since", "1970-01-01", "--limit", "1"] });
      const exportDir = join(home, ".dsh/llm-wiki/sessions-export");
      const files = readdirSync(exportDir).filter(f => f.endsWith(".md"));
      assert.equal(files.length, 1, "--limit 1 应只导 1 个");
      assert.match(out, /"truncated":\s*2/, "另 2 个应被记为截断而不是静默丢弃");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("LLM_WIKI_EXPORT_DAYS=90 放宽窗口，40 天前的会话进得来", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-f5f2-"));
    const home = join(root, "home"); mkdirSync(home, { recursive: true });
    const vault = makeVault(root);
    try {
      makeSession(home, "ws1", "oldold01", { user: "旧会话", assistant: "回复", mtimeDaysAgo: 40 });
      const env = { ...process.env, HOME: home, LLM_WIKI_VAULT: vault,
        LLM_WIKI_FAKE_EMBED: "never", LLM_WIKI_EXPORT_SESSIONS: "1",
        LLM_WIKI_EXPORT_DAYS: "90",
        LLM_WIKI_STATE: join(home, ".dsh/llm-wiki/pipeline-state.json") };
      const out = execFileSync(process.execPath, [PIPELINE, "--dsh-export"],
        { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
      assert.match(out, /"exported":\s*1/, "90 天窗口应包含 40 天前的会话");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("--limit 0 被夹到 1（显式给 0 不该让 flag 变哑弹）", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-f5f3-"));
    const home = join(root, "home"); mkdirSync(home, { recursive: true });
    const vault = makeVault(root);
    try {
      makeSession(home, "ws1", "newnew01", { user: "新会话", assistant: "回复" });
      runPipeline(home, vault, { extra: ["--limit", "0"] });
      const dir = join(home, ".dsh/llm-wiki/sessions-export");
      assert.equal(readdirSync(dir).filter(f => f.endsWith(".md")).length, 1, "--limit 0 应退化为 1");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("--since 非法日期 → 返回 error，不导出", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-f5g-"));
    const home = join(root, "home"); mkdirSync(home, { recursive: true });
    const vault = makeVault(root);
    try {
      makeSession(home, "ws1", "newnew01", { user: "新会话", assistant: "回复" });
      const out = runPipeline(home, vault, { extra: ["--since", "昨天吧大概"] });
      assert.match(out, /不是合法日期/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("F5 ③ 脱敏兜底", () => {
  test("各种形态的密钥都被遮掉，且 frontmatter 如实记 redacted: true", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-f5h-"));
    const home = join(root, "home"); mkdirSync(home, { recursive: true });
    const vault = makeVault(root);
    try {
      const user = SECRET_ROOM.map(([, v]) => v).join("\n");
      makeSession(home, "ws1", "secsec01", { user, cwd: "/tmp/myproj" });
      const out = runPipeline(home, vault);
      assert.match(out, /"exported":\s*1/);
      const dir = join(home, ".dsh/llm-wiki/sessions-export");
      const md = readFileSync(readdirSync(dir).find(f => f.endsWith(".md")) && join(dir, readdirSync(dir).find(f => f.endsWith(".md"))), "utf8");
      assert.match(md, /redacted: true/, "frontmatter 应记 redacted: true");
      assert.match(md, /\[REDACTED\]/, "应出现 REDACTED 标记");
      // 断言「原文不可见」。redact.mjs 有意保留命中串的前 10 个字符做取证
      // （"这里曾经有个 sk- 开头的串"有用，全文没用），所以探测点取**末尾 10 位**：
      // 一定落在被遮掉的那一段里，且不受保留前缀长度影响。
      for (const [name, val] of SECRET_ROOM) {
        const probe = val.slice(-10);
        assert.ok(!md.includes(probe), `${name} 的尾部不应出现在导出里（探测片段: ${probe}）`);
      }
      // 但非机密上下文还在（不能把整段都毁了）
      assert.match(md, /普通对话|回复|myproj|DSH 会话复盘/, "非机密内容应保留");
      // 助手段落也被脱敏（不只 user）
      assert.ok(!md.includes("abcdefghijklmnopqrstuvwxyz0123456789"), "assistant 段落的密钥也该被遮");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("无密钥的会话 frontmatter 记 redacted: false", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-f5i-"));
    const home = join(root, "home"); mkdirSync(home, { recursive: true });
    const vault = makeVault(root);
    try {
      makeSession(home, "ws1", "clean001", { user: "今天天气不错", assistant: "确实" });
      runPipeline(home, vault);
      const dir = join(home, ".dsh/llm-wiki/sessions-export");
      const md = readFileSync(join(dir, readdirSync(dir).find(f => f.endsWith(".md"))), "utf8");
      assert.match(md, /redacted: false/);
      assert.ok(!md.includes("REDACTED"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("hasSecrets / redactSecrets 纯函数：边界与 lastIndex 复位", () => {
    // 阴性优先：干净文本必须判 false（这条若错，脱敏会误伤所有会话）
    assert.equal(hasSecrets("没有任何密钥"), false);
    assert.equal(hasSecrets(""), false);
    assert.equal(hasSecrets(null), false);
    for (const [, v] of SECRET_ROOM) {
      assert.equal(hasSecrets("前缀 " + v + " 后缀"), true, `应检出: ${v.slice(0, 12)}`);
    }
    // 同一输入重复判断 5 次，结果必须一致（global 正则 lastIndex 的经典坑）
    for (let i = 0; i < 5; i++) assert.equal(hasSecrets("token 是 ghp_" + "a".repeat(30)), true);
    for (let i = 0; i < 5; i++) assert.equal(hasSecrets("普通文本"), false);

    // 非字符串入参不该抛
    assert.equal(redactSecrets(null), "");
    assert.equal(redactSecrets(undefined), "");
    // 短命中整块替换，长命中留前 10 字符
    assert.equal(redactSecrets("x").length, 1);
    const long = redactSecrets("password: " + "z".repeat(40));
    assert.ok(long.includes("…[REDACTED]"), `长命中应保留前缀: ${long}`);
    assert.ok(!long.includes("z".repeat(40)));
    // 所有 pattern 都带 g 旗（否则 replace 只换第一个）
    for (const re of SECRET_PATTERNS) assert.ok(re.global, "SECRET_PATTERNS 必须全部带 g 旗");
  });

  test("PEM 多行块整体被遮，不会只遮第一行留下残骸", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";
    const out = redactSecrets("前面\n" + pem + "\n后面");
    assert.ok(!out.includes("b3BlbnNzaC1rZXktdjEAAAAA"), "块体不该残留");
    assert.match(out, /\[REDACTED\]/);
    // 保留一点上下文便于判断「这里曾经有东西」
    assert.match(out, /前面/);
    assert.match(out, /后面/);
  });
});

describe("F5 zstd 解码走 node:zlib", () => {
  test("管线源码里不再出现 execFileSync(\"zstd\")（外部二进制依赖已移除）", () => {
    const src = readFileSync(PIPELINE, "utf8");
    assert.ok(!/execFileSync\(\s*["']zstd["']/.test(src), "不应再 fork zstd 二进制");
    assert.match(src, /zstdDecompressSync/, "应改用内置解压");
  });
});
