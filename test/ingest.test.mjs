/**
 * O10 ingest contract tests.
 *
 * Two kinds of converter are used on purpose:
 *   - a fake Node converter for the *failure* paths (non-zero exit, SIGKILL,
 *     missing oracle, malformed frontmatter), because those must be reachable
 *     without depending on how a real parser happens to fail;
 *   - the real Go `convert-html` for determinism and idempotency.
 *
 * If the Go toolchain or the module cache is unavailable the format-specific
 * assertions are skipped rather than silently passing.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { before, test } from "node:test";

import {
  EXIT,
  converterFor,
  inboxPath,
  isSupportedExt,
  parseInboxFm,
  sourcePath,
} from "../scripts/lib/ingest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DISPATCHER = join(ROOT, "scripts", "wiki-convert.mjs");

const FIXED_HTML =
  '<html><head><title>T &amp; U: "q"</title></head><body>' +
  "<h1>主标题</h1><p>a  b   c</p>" +
  "<pre><code>func main() {\n\tif x {\n\t\ty()\n\t}\n}</code></pre>" +
  "<table><tr><th>列 A</th><th>列 B</th></tr><tr><td>v</td><td>含 | 竖线</td></tr></table>" +
  "</body></html>";

/* ------------------------------------------------------------------ helpers */

function mkTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runDispatcher(args, opts = {}) {
  const r = spawnSync(process.execPath, [DISPATCHER, ...args], {
    encoding: "utf8",
    ...opts,
  });
  return { code: r.status, signal: r.signal, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function mdFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

function writeHtml(dir, name, content) {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

/** A converter that implements the CLI contract but can be told to misbehave. */
const FAKE_CONVERTER_SRC = `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const input = argv[0];
let inbox = "", sources = "";
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === "--inbox") inbox = argv[++i];
  else if (argv[i] === "--sources") sources = argv[++i];
}
const raw = readFileSync(input);
const sha = createHash("sha256").update(raw).digest("hex");
mkdirSync(inbox, { recursive: true });
mkdirSync(sources, { recursive: true });
const md = join(inbox, sha.slice(0, 16) + ".md");
const src = join(sources, sha + ".html");
const mode = process.env.FAKE_MODE || "ok";

if (mode === "exit3" || mode === "crash") {
  writeFileSync(md, "---\\ntitle: 半截\\n");
  if (mode === "crash") process.kill(process.pid, "SIGKILL");
  process.exit(3);
}

if (mode !== "nooracle") copyFileSync(input, src);

const fidelity = mode === "badfm" ? "partially" : "lossy";
writeFileSync(md, [
  "---",
  'title: "fake"',
  'source: "file:' + input + '"',
  "sha256: " + sha,
  'original_name: "x.html"',
  'converted_by: "fake@1.0.0"',
  'converted_at: "2024-01-01T00:00:00Z"',
  "fidelity: " + fidelity,
  "---",
  "",
  "body",
  "",
].join("\\n"));
process.stdout.write(JSON.stringify({ ok: true, inbox: md, source: src, sha256: sha, fidelity }) + "\\n");
`;

let fakeConverter = null;
function ensureFakeConverter() {
  if (fakeConverter) return fakeConverter;
  const dir = mkTmp("ingest-fake-");
  fakeConverter = join(dir, "convert-fake.mjs");
  writeFileSync(fakeConverter, FAKE_CONVERTER_SRC, "utf8");
  chmodSync(fakeConverter, 0o755);
  return fakeConverter;
}

let goConverter = null;
before(() => {
  const bin = join(ROOT, "converters", "bin", "convert-html");
  if (existsSync(bin)) {
    goConverter = bin;
    return;
  }
  const r = spawnSync("go", ["build", "-o", bin, "."], {
    cwd: join(ROOT, "converters", "html"),
    encoding: "utf8",
    env: { ...process.env, GOFLAGS: "-mod=mod" },
  });
  goConverter = r.status === 0 && existsSync(bin) ? bin : null;
});

/* ------------------------------------------------------- 1. contract checks */

test("1. 契约校验：缺 sha256 / fidelity 非法 / converted_by 无版本号 → 全部报错", () => {
  const ok = [
    "---",
    'title: "t"',
    'source: "file:/x.html"',
    "sha256: " + "a".repeat(64),
    'original_name: "x.html"',
    'converted_by: "convert-html@0.1.0"',
    'converted_at: "2024-01-01T00:00:00Z"',
    "fidelity: lossy",
    "---",
    "",
    "body",
    "",
  ].join("\n");

  assert.deepEqual(parseInboxFm(ok).errors, [], "完整契约应无错");

  const missing = parseInboxFm(ok.replace(/^sha256:.*\n/m, ""));
  assert.ok(
    missing.errors.some((e) => e.includes("sha256")),
    "缺 sha256 必须报错",
  );

  const badFidelity = parseInboxFm(ok.replace("fidelity: lossy", "fidelity: partially"));
  assert.ok(
    badFidelity.errors.some((e) => e.includes("fidelity 非法")),
    "fidelity 枚举外的值必须报错",
  );

  const noVersion = parseInboxFm(ok.replace('"convert-html@0.1.0"', '"convert-html"'));
  assert.ok(
    noVersion.errors.some((e) => e.includes("converted_by")),
    "converted_by 不带版本号必须报错",
  );

  const badHash = parseInboxFm(ok.replace("a".repeat(64), "zz".repeat(32)));
  assert.ok(
    badHash.errors.some((e) => e.includes("sha256 必须")),
    "sha256 非 64 位小写十六进制必须报错",
  );

  const badDate = parseInboxFm(ok.replace('"2024-01-01T00:00:00Z"', '"2024-01-01"'));
  assert.ok(
    badDate.errors.some((e) => e.includes("converted_at")),
    "converted_at 非 ISO 8601 必须报错",
  );

  // 路径与调度是纯函数，也一并锁定
  assert.equal(inboxPath("/v/raw/inbox", "a".repeat(64)), join("/v/raw/inbox", "a".repeat(16) + ".md"));
  assert.equal(sourcePath("/v/raw/sources", "b".repeat(64), "HTML"), join("/v/raw/sources", "b".repeat(64) + ".html"));
  assert.equal(converterFor(".HTML"), "convert-html");
  assert.equal(isSupportedExt(".xyz"), false);
  assert.equal(EXIT.USAGE, 2);
});

/* -------------------------------------------------- 2. determinism (real Go) */

test("2. convert-html 对固定 HTML 产出逐字节稳定的 markdown", (t) => {
  if (!goConverter) return t.skip("go 工具链或模块缓存不可用，跳过");
  const vault = mkTmp("ingest-det-");
  const inbox = join(vault, "raw", "inbox");
  const sources = join(vault, "raw", "sources");
  const input = writeHtml(vault, "page.html", FIXED_HTML);

  const env = { ...process.env, SOURCE_DATE_EPOCH: "1700000000", LLM_WIKI_CONVERTERS: dirname(goConverter) };
  const a = runDispatcher([input, "--inbox", inbox, "--sources", sources, "--json"], { env });
  assert.equal(a.code, 0, a.stderr);
  const first = readFileSync(JSON.parse(a.stdout).inbox, "utf8");

  rmSync(inbox, { recursive: true, force: true });
  rmSync(sources, { recursive: true, force: true });

  const b = runDispatcher([input, "--inbox", inbox, "--sources", sources, "--json"], { env });
  assert.equal(b.code, 0, b.stderr);
  const second = readFileSync(JSON.parse(b.stdout).inbox, "utf8");

  assert.equal(first, second, "同输入两次转换必须逐字节一致");
  assert.ok(first.includes("\tif x {"), "代码块里的 tab 必须保留");
  assert.ok(first.includes("| 列 A | 列 B |"), "表格必须转成 GFM");
  assert.ok(first.includes("\\| 竖线"), "单元格里的竖线必须转义");
  assert.ok(!first.includes("\\u0026"), "不应出现 HTML 转义残留");
});

/* ---------------------------------------------------- 3. idempotency (real) */

test("3. 同一输入跑两次 → 相同 sha256、相同路径、第二次不重写", (t) => {
  if (!goConverter) return t.skip("go 工具链或模块缓存不可用，跳过");
  const vault = mkTmp("ingest-idem-");
  const inbox = join(vault, "raw", "inbox");
  const sources = join(vault, "raw", "sources");
  const input = writeHtml(vault, "page.html", FIXED_HTML);
  const env = { ...process.env, SOURCE_DATE_EPOCH: "1700000000", LLM_WIKI_CONVERTERS: dirname(goConverter) };

  const a = runDispatcher([input, "--inbox", inbox, "--sources", sources, "--json"], { env });
  assert.equal(a.code, 0, a.stderr);
  const ra = JSON.parse(a.stdout);
  const mtime1 = statSync(ra.inbox).mtimeMs;
  const body1 = readFileSync(ra.inbox, "utf8");

  const b = runDispatcher([input, "--inbox", inbox, "--sources", sources, "--json"], { env });
  assert.equal(b.code, 0, b.stderr);
  const rb = JSON.parse(b.stdout);

  assert.equal(rb.sha256, ra.sha256, "sha256 必须一致");
  assert.equal(rb.inbox, ra.inbox, "产物路径必须一致");
  assert.equal(rb.skipped, true, "第二次必须报告 skipped");
  assert.equal(statSync(ra.inbox).mtimeMs, mtime1, "第二次不得重写（mtime 不变）");
  assert.equal(readFileSync(ra.inbox, "utf8"), body1, "内容必须一致");
  assert.equal(mdFiles(inbox).length, 1, "不得产生第二个产物");
});

/* ------------------------------------------------- 4. non-zero leaves nothing */

test("4. 转换器非 0 退出时，--inbox 不留任何文件", () => {
  const vault = mkTmp("ingest-exit3-");
  const inbox = join(vault, "raw", "inbox");
  const sources = join(vault, "raw", "sources");
  mkdirSync(inbox, { recursive: true });
  const input = writeHtml(vault, "page.html", "<p>x</p>");

  const r = runDispatcher(
    [input, "--inbox", inbox, "--sources", sources, "--json", "--converter", ensureFakeConverter()],
    { env: { ...process.env, FAKE_MODE: "exit3" } },
  );
  assert.equal(r.code, 3, "退出码应透传");
  assert.deepEqual(mdFiles(inbox), [], "失败的转换不得留下半截文件");
});

/* ------------------------------------------------------- 5. crash / atomicity */

test("5. 转换器被 kill -9 后 --inbox 无半截文件", () => {
  const vault = mkTmp("ingest-crash-");
  const inbox = join(vault, "raw", "inbox");
  const sources = join(vault, "raw", "sources");
  mkdirSync(inbox, { recursive: true });
  const input = writeHtml(vault, "page.html", "<p>x</p>");

  const r = runDispatcher(
    [input, "--inbox", inbox, "--sources", sources, "--json", "--converter", ensureFakeConverter()],
    { env: { ...process.env, FAKE_MODE: "crash" } },
  );
  assert.equal(r.code, 3, "被信号中断应报解析失败");
  assert.deepEqual(mdFiles(inbox), [], "崩溃后不得留下半截文件");
});

/* ------------------------------------------- 6. identity is the input hash */

test("6. 身份用输入哈希：篡改产物内容后重跑 → 不产生新文档", (t) => {
  if (!goConverter) return t.skip("go 工具链或模块缓存不可用，跳过");
  const vault = mkTmp("ingest-identity-");
  const inbox = join(vault, "raw", "inbox");
  const sources = join(vault, "raw", "sources");
  const input = writeHtml(vault, "page.html", FIXED_HTML);
  const env = { ...process.env, SOURCE_DATE_EPOCH: "1700000000", LLM_WIKI_CONVERTERS: dirname(goConverter) };

  const a = runDispatcher([input, "--inbox", inbox, "--sources", sources, "--json"], { env });
  assert.equal(a.code, 0, a.stderr);
  const ra = JSON.parse(a.stdout);

  // Simulate the model having edited the staging file during 落位.
  writeFileSync(ra.inbox, readFileSync(ra.inbox, "utf8") + "\n模型追加的落位备注\n", "utf8");

  const b = runDispatcher([input, "--inbox", inbox, "--sources", sources, "--json"], { env });
  assert.equal(b.code, 0, b.stderr);
  assert.equal(JSON.parse(b.stdout).skipped, true, "输入未变，必须跳过");
  assert.equal(mdFiles(inbox).length, 1, "不得产生新文档");
  assert.ok(
    readFileSync(ra.inbox, "utf8").includes("模型追加的落位备注"),
    "模型在暂存文件里的改动不得被覆盖",
  );

  // The hash recorded in the frontmatter must be the input hash, not the output's.
  const sha = createHash("sha256").update(readFileSync(input)).digest("hex");
  assert.ok(readFileSync(ra.inbox, "utf8").includes("sha256: " + sha), "记录的必须是原件哈希");
});

/* ------------------------------------------------------- 7. lossy needs oracle */

test("7. fidelity: lossy 且原件缺失 → 报错，不留产物", () => {
  const vault = mkTmp("ingest-oracle-");
  const inbox = join(vault, "raw", "inbox");
  const sources = join(vault, "raw", "sources");
  mkdirSync(inbox, { recursive: true });
  const input = writeHtml(vault, "page.html", "<p>x</p>");

  const r = runDispatcher(
    [input, "--inbox", inbox, "--sources", sources, "--json", "--converter", ensureFakeConverter()],
    { env: { ...process.env, FAKE_MODE: "nooracle" } },
  );
  assert.equal(r.code, 3, "丢原件的 lossy 转换必须失败");
  assert.match(r.stderr, /原件缺失/, "诊断必须说明是原件缺失");
  assert.deepEqual(mdFiles(inbox), [], "失败时不得留下产物");
});

/* ------------------------------------------------ 8. unsupported extension */

test("8. 调度器不认识的扩展名 → 退出码 2，不产生任何文件", () => {
  const vault = mkTmp("ingest-unsup-");
  const inbox = join(vault, "raw", "inbox");
  const sources = join(vault, "raw", "sources");
  mkdirSync(inbox, { recursive: true });
  const input = writeHtml(vault, "broken.xyz", "not really a document");

  const r = runDispatcher([input, "--inbox", inbox, "--sources", sources, "--json"]);
  assert.equal(r.code, EXIT.USAGE, "未知扩展名应返回 2");
  assert.match(r.stderr, /不支持的扩展名/);
  assert.deepEqual(mdFiles(inbox), []);

  // 已知格式但转换器未安装，同样是 2（契约把"支持"与"已安装"分开）
  const known = writeHtml(vault, "doc.pdf", "%PDF-1.4");
  const r2 = runDispatcher([known, "--inbox", inbox, "--sources", sources, "--json"], {
    env: { ...process.env, LLM_WIKI_CONVERTERS: join(vault, "no-such-dir") },
  });
  assert.equal(r2.code, EXIT.USAGE);
  assert.match(r2.stderr, /转换器未安装|原件不可读/);
  assert.deepEqual(mdFiles(inbox), []);
});
