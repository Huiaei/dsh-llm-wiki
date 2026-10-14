/**
 * F8 回归：运维日志无界增长 → log.md 与 evolution/logs.md 就地封顶
 *
 * 原状（L4）：`appendLog` 每次前插一行，`compilePatterns` 每次插一批条目。
 * 两个文件都只增不减 —— timer 每天都跑，pattern 每次新增都追加，
 * 结果是 vault 里唯一的「纯运维、零知识价值」内容无限变厚，把真正要看的东西挤走。
 *
 * 修法：capLogLines 按行数封顶。**方向是硬约束**——
 * 两个调用点都是 newest-first（appendLog 是 `line + 原内容`，
 * compilePatterns 是插在 `## <today>` 之后），所以必须**保留头部、砍尾部**。
 * 第一版写成了 `slice(-max)`（留尾部），实测把每天新写的行先砍了，旧的留下——正好反了。
 * 这个用例就是钉住那个方向的。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { capLogLines, MAX_LOG_LINES } from "../scripts/lib/redact.mjs";

const PIPELINE = new URL("../scripts/llm-wiki-pipeline.mjs", import.meta.url).pathname;

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
function runPipeline(home, vault) {
  return execFileSync(process.execPath, [PIPELINE, "--all"],
    { encoding: "utf8", env: { ...process.env, HOME: home, LLM_WIKI_VAULT: vault,
      LLM_WIKI_FAKE_EMBED: "never", LLM_WIKI_STATE: join(home, ".dsh/llm-wiki/pipeline-state.json") },
      stdio: ["ignore", "pipe", "pipe"] });
}

describe("capLogLines 纯函数", () => {
  test("保留头部（最新）、砍尾部（最旧）—— 方向不能反", () => {
    const text = "NEW\n" + Array.from({ length: 600 }, (_, i) => "old" + i).join("\n");
    const r = capLogLines(text, 100);
    const lines = r.text.split("\n");
    assert.equal(lines.length, 100, "应封顶到 100 行");
    assert.equal(lines[0].includes("已截断"), true, "首行应是截断说明");
    assert.equal(lines[1], "NEW", "第 2 行必须是最新那条 —— 若砍了它，日志方向就反了");
    assert.equal(lines.at(-1), "old97", "尾部应是被砍边界附近的最旧一条（boundary: kept max-1 行 + 1 行说明）");
    assert.equal(r.dropped, 502, "601 行输入、保留 99 行 → 砍 502 行");
    assert.ok(!r.text.includes("old99"), "更旧的应被砍掉");
    assert.ok(!r.text.includes("old599"), "最旧的不该出现");
  });

  test("不满上限时原样返回（一行不加）", () => {
    const text = "a\nb\nc";
    const r = capLogLines(text);
    assert.equal(r.text, text);
    assert.equal(r.dropped, 0);
  });

  test("正好等于上限时不截断", () => {
    const text = Array.from({ length: 100 }, (_, i) => "x" + i).join("\n");
    const r = capLogLines(text, 100);
    assert.equal(r.text, text);
    assert.equal(r.dropped, 0);
  });

  test("超过一行即触发", () => {
    const r = capLogLines(Array.from({ length: 101 }, (_, i) => "x" + i).join("\n"), 100);
    assert.equal(r.dropped, 2);
    assert.equal(r.text.split("\n").length, 100);
  });

  test("非字符串入参安全（不抛）", () => {
    for (const v of [null, undefined, 42, {}, []]) {
      const r = capLogLines(v);
      assert.equal(r.text, "");
      assert.equal(r.dropped, 0);
    }
  });

  test("默认上限即 MAX_LOG_LINES", () => {
    assert.equal(MAX_LOG_LINES, 500);
    const r = capLogLines(Array.from({ length: 2000 }, (_, i) => "L" + i).join("\n"));
    assert.equal(r.text.split("\n").length, 500);
  });
});

describe("端到端：log.md 每天前插也封顶", () => {
  test("600 行存量 log.md 再跑管线 → 回到上限内且新条目在最前", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-f8a-"));
    const home = join(root, "home"); mkdirSync(home, { recursive: true });
    const vault = makeVault(root);
    const logMd = join(vault, "log.md");
    try {
      // 预置「已经跑了 600 天」的存量
      const stale = "# LLM-Wiki 操作日志\n\n"
        + Array.from({ length: 600 }, (_, i) => `## [2026-01-01] pipeline | sync:1条（旧${i}）\n`).join("");
      writeFileSync(logMd, stale);
      const before = readFileSync(logMd, "utf8").split("\n").length;
      const out = runPipeline(home, vault);
      assert.match(out, /页面数: 3/);
      const after = readFileSync(logMd, "utf8");
      const lines = after.split("\n");
      assert.ok(lines.length <= MAX_LOG_LINES, `应封顶，实得 ${lines.length} 行`);
      assert.ok(before > MAX_LOG_LINES, "前置条件：存量必须超上限");
      // 新写入的条目在最顶部（截断说明之后）
      assert.equal(lines[0].includes("已截断"), true, "应留下「这里少过东西」的说明");
      const body = lines.slice(1).join("\n");
      assert.match(body, /^## \[\d{4}-\d{2}-\d{2}\] pipeline \| lint:/, "最新一条必须是今天写的");
      // 存量 603 行、新写 1 行 → 604 行，保留头部 499 行 → 淘汰尾部约 105 行（含 header 与最旧条目）
      assert.ok(!after.includes("（旧599）"), "最旧的一条（旧599）应被淘汰");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("连跑 3 次不累积、不缩水", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-f8b-"));
    const home = join(root, "home"); mkdirSync(home, { recursive: true });
    const vault = makeVault(root);
    const logMd = join(vault, "log.md");
    try {
      writeFileSync(logMd, "# LLM-Wiki 操作日志\n\n"
        + Array.from({ length: 600 }, (_, i) => `## [2026-01-01] pipeline | 旧${i}\n`).join(""));
      const sizes = [];
      for (let i = 0; i < 3; i++) { runPipeline(home, vault); sizes.push(readFileSync(logMd, "utf8").split("\n").length); }
      for (const s of sizes) assert.ok(s <= MAX_LOG_LINES, `每次都应封顶，实得 ${s}`);
      assert.equal(sizes[0], sizes[2], "稳态下行数应一致");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("端到端：evolution/logs.md 也封顶", () => {
  test("预置 600 行 logs.md 后跑 compile-patterns → 不超过上限", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-f8c-"));
    const home = join(root, "home"); mkdirSync(home, { recursive: true });
    const vault = makeVault(root);
    const logsMd = join(vault, "wiki", "evolution", "logs.md");
    try {
      mkdirSync(join(vault, "wiki", "evolution"), { recursive: true });
      writeFileSync(logsMd, "# 编译日志（Evolution Log）\n\n"
        + "> 记录 wiki/patterns/ 的编译、合并、归档事件。\n\n"
        + Array.from({ length: 600 }, (_, i) => `* **Pattern 新增**: [[wiki/patterns/p${i}]] \u2014 旧条目${i}\n`).join(""));
      // 注意 fixture：3 个同类孤立页（正文不带 [[]]，标题同词）才会真正走到写日志的分支
      for (let i = 0; i < 3; i++) {
        writeFileSync(join(vault, "wiki", "决策", `页${i}.md`),
          `---\ntitle: "配置问题${i}"\ntype: 决策\ncreated: 2026-01-01\n---\n\n正文${i}\n`);
      }
      const out = execFileSync(process.execPath, [PIPELINE, "--compile-patterns"],
        { encoding: "utf8", env: { ...process.env, HOME: home, LLM_WIKI_VAULT: vault,
          LLM_WIKI_FAKE_EMBED: "never", LLM_WIKI_STATE: join(home, ".dsh/llm-wiki/pipeline-state.json") },
          stdio: ["ignore", "pipe", "pipe"] });
      assert.match(out, /"created":1/, "前置条件：应先真正新增一个 pattern，才会去写日志");
      const after = readFileSync(logsMd, "utf8");
      const afterLines = after.split("\n");
      const n = afterLines.length;
      assert.ok(n <= MAX_LOG_LINES, `logs.md 应封顶，实得 ${n} 行`);
      // 注意 afterLines 是数组、n 是数字 —— 断言首行只能对数组做
      assert.equal(afterLines[0].includes("已截断"), true, "首行应是截断说明（600 行存量已超上限）");
      assert.ok(afterLines[1].startsWith("# 编译日志"), "标题块应紧随说明之后");
      assert.ok(after.includes("配置问题-pattern"), "新条目应写进去");
      assert.ok(!after.includes("（旧599）"), "最旧的一条应被淘汰");
      // 幂等：同一天再跑不应再插一条
      execFileSync(process.execPath, [PIPELINE, "--compile-patterns"],
        { encoding: "utf8", env: { ...process.env, HOME: home, LLM_WIKI_VAULT: vault,
          LLM_WIKI_FAKE_EMBED: "never", LLM_WIKI_STATE: join(home, ".dsh/llm-wiki/pipeline-state.json") },
          stdio: ["ignore", "pipe", "pipe"] });
      const again = readFileSync(logsMd, "utf8");
      // 幂等只针对**同一条文本**。「Pattern 更新」是一条不同的文本（追加证据是新事件，
      // 每天记一次合理），所以断言按文本分开数，不能笼统统计 pattern 名的出现次数。
      const added = again.match(/Pattern 新增[^\n]*配置问题-pattern/g) || [];
      const updated = again.match(/Pattern 更新[^\n]*配置问题-pattern/g) || [];
      assert.equal(added.length, 1, "幂等：同一条「新增」不应被重复插入");
      assert.equal(updated.length, 1, "「更新」每天最多一条");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
