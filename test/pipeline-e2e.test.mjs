// 端到端回归：把管线当黑盒跑在临时 vault 上。
// 不需要真 mnemon —— PATH 前面放一个 stub，import 时把草稿抄出来即可。
// 覆盖 O1（结构化解析/写入 + lint 新校验）与 O2（语义指纹变更检测）。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFmYaml, extractFmText } from "../scripts/lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PIPELINE = join(ROOT, "scripts", "llm-wiki-pipeline.mjs");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wiki-e2e-"));
  const vault = join(dir, "vault");
  for (const c of ["决策", "概念", "引用"]) mkdirSync(join(vault, "wiki", c), { recursive: true });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const draftOut = join(dir, "draft.json");
  const stub = join(bin, "mnemon");
  writeFileSync(stub, "#!/bin/sh\ncat \"$2\" > " + JSON.stringify(draftOut) + "\nexit 0\n");
  chmodSync(stub, 0o755);
  return { dir, vault, bin, state: join(dir, "state.json"), draftOut };
}

function run(ctx, args) {
  const env = {
    ...process.env,
    PATH: ctx.bin + ":" + process.env.PATH,
    LLM_WIKI_VAULT: ctx.vault,
    LLM_WIKI_STATE: ctx.state,
    LLM_WIKI_FAKE_EMBED: "never", // 别去占 11434
  };
  return execFileSync(process.execPath, [PIPELINE, ...args], { env, encoding: "utf8", cwd: ROOT });
}

const write = (ctx, cat, name, fm, body = "正文。\n") =>
  writeFileSync(join(ctx.vault, "wiki", cat, name + ".md"), "---\n" + fm + "\n---\n\n" + body);
const read = (ctx, cat, name) => readFileSync(join(ctx.vault, "wiki", cat, name + ".md"), "utf8");

const FML = [
  "title: 正常页", "type: 决策", "created: 2026-01-01", "updated: 2026-01-02",
  "tags: [wiki/决策, compiled]", "related: [\"[[wiki/概念/概念页]]\"]", "quality_score: 5",
].join("\n");

// 七页 fixture，每页触发一个特定检查
function seed(ctx) {
  write(ctx, "决策", "正常页", FML, "见 [[概念页]] 与 [[引用页]]。\n");
  write(ctx, "概念", "概念页", "title: 概念页\ntype: 概念\ncreated: 2026-01-01\nupdated: 2026-01-02\ntags: [wiki/概念]",
    "见 [[正常页]] 与 [[引用页]]。\n");
  write(ctx, "引用", "引用页", "title: 引用页\ntype: 引用\ncreated: 2026-01-01\nupdated: 2026-01-02\ntags: [wiki/引用]",
    "见 [[正常页]] 与 [[概念页]]。\n");
  write(ctx, "决策", "语法错误", "title: 语法错误\ntype: 决策\ncreated: 2026-01-01\ntags: &anchor 坏写法");
  write(ctx, "决策", "类型不匹配", "title: 类型不匹配\ntype: 概念\ncreated: 2026-01-01\ntags: [a]");
  write(ctx, "决策", "悬挂链接", "title: 悬挂链接\ntype: 决策\ncreated: 2026-01-01\ntags: [a]\nrelated: [\"[[wiki/决策/不存在]]\"]");
  write(ctx, "决策", "过期页", "title: 过期页\ntype: 决策\ncreated: 2026-01-01\ntags: [a]\nstale_after: 2020-01-01");
  write(ctx, "决策", "旧字符串标签", "title: 旧字符串标签\ntype: 决策\ncreated: 2026-01-01\ntags: wiki/决策, compiled\nsources: https://example.com");
}

const parseAfter = (out, label) => {
  const m = out.match(new RegExp(label + ": (\\{.*\\})"));
  assert.ok(m, "输出里找不到 " + label + ":\n" + out);
  return JSON.parse(m[1]);
};

test("e2e: lint 报出 O1 新增的结构化问题", () => {
  const ctx = setup();
  try {
    seed(ctx);
    const out = run(ctx, ["--lint"]);
    const line = out.split("\n").find(l => l.includes("分类:"));
    for (const k of ["fm_syntax", "fm_shape", "type_dir", "dangling_link", "stale_after"]) {
      assert.match(line, new RegExp(k + "="), "缺少 " + k + " 分类: " + line);
    }
    // fm_syntax=1 只有 &anchor 那一页；fm_shape=1 只有未规范化的字符串 tags。
    // 两者分开计数，是为了让"解析器读不懂"和"字段形状不对"不混为一谈。
    assert.match(line, /fm_syntax=1\b/, "fm_syntax 应为 1: " + line);
    assert.match(line, /fm_shape=1\b/, "fm_shape 应为 1: " + line);
    // 解析失败时不再叠加形状噪声：&anchor 页只报解析诊断，不报"tags 应为数组"
    const anchorIssues = out.split("\n").filter(l => l.includes("语法错误.md") && l.includes("[问题]"));
    assert.ok(anchorIssues.some(l => /锚点|anchor/.test(l)), "应报解析诊断: " + JSON.stringify(anchorIssues));
    assert.ok(!anchorIssues.some(l => /应为数组/.test(l)), "解析失败时不应叠加形状噪声: " + JSON.stringify(anchorIssues));
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("e2e: okf 首轮规范化旧字符串字段，二轮幂等，且不碰有诊断的页", () => {
  const ctx = setup();
  try {
    seed(ctx);
    const r1 = parseAfter(run(ctx, ["--okf"]), "OKF 对齐");
    assert.ok(r1.repaired >= 1, "应规范化 旧字符串标签: " + JSON.stringify(r1));
    // 规范化后必须能被解析器读回结构（引号可选，所以断解析结果而非字面量）
    const fixed = parseFmYaml(extractFmText(read(ctx, "决策", "旧字符串标签")).fm).data;
    assert.deepEqual(fixed.tags, ["wiki/决策", "compiled"]);
    assert.deepEqual(fixed.sources, [{ resource: "https://example.com" }]);
    assert.equal(fixed.generated.by, "agent/dsh-llm-wiki");
    // 语法错误页一字不改
    assert.match(read(ctx, "决策", "语法错误"), /tags: &anchor 坏写法/);

    const r2 = parseAfter(run(ctx, ["--okf"]), "OKF 对齐");
    assert.deepEqual(
      { aligned: r2.aligned, updated: r2.updated, repaired: r2.repaired },
      { aligned: 0, updated: 0, repaired: 0 },
      "第二轮必须幂等: " + JSON.stringify(r2),
    );
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("e2e: 变更检测按语义指纹，不按 mtime", () => {
  const ctx = setup();
  try {
    seed(ctx);
    run(ctx, ["--sync"]);
    // state 是扁平的 { rel: {schema,draft,body,full,mtime,size} }
    const st0 = JSON.parse(readFileSync(ctx.state, "utf8"));
    assert.ok(Object.keys(st0).length > 0, "state 不应为空");
    for (const [rel, e] of Object.entries(st0)) {
      assert.equal(e.schema, 2, rel + " 应记为 schema 2");
      assert.ok(e.draft && e.full && e.body, rel + " 应有 draft/body/full 指纹");
    }

    // 1) 只碰 mtime —— 旧实现（纯 mtime）会全量重导，现在必须零动作
    const now = Math.floor(Date.now() / 1000) + 120;
    utimesSync(join(ctx.vault, "wiki", "决策", "正常页.md"), now, now);
    assert.deepEqual(
      pick(parseAfter(run(ctx, ["--sync"]), "同步")),
      { synced: 0, retired: 0, drift: 0, bodyDrift: 0 },
      "只碰 mtime 不应触发任何动作",
    );

    // 2) 只改正文 —— 草稿不变（不用重导），但必须报外部漂移
    const p = join(ctx.vault, "wiki", "决策", "正常页.md");
    writeFileSync(p, readFileSync(p, "utf8") + "\n新增一段。\n");
    const r2 = parseAfter(run(ctx, ["--sync"]), "同步");
    assert.equal(r2.synced, 0);
    assert.equal(r2.drift, 1, "正文改动应报漂移: " + JSON.stringify(r2));
    assert.equal(r2.bodyDrift, 1);

    // 3) 改 quality_score —— 影响召回权重，必须重导
    const q = join(ctx.vault, "wiki", "概念", "概念页.md");
    writeFileSync(q, readFileSync(q, "utf8").replace("tags: [wiki/概念]", "tags: [wiki/概念]\nquality_score: 5"));
    const r3 = parseAfter(run(ctx, ["--sync"]), "同步");
    assert.equal(r3.synced, 1, "quality_score 改动应重导: " + JSON.stringify(r3));
    const draft = JSON.parse(readFileSync(ctx.draftOut, "utf8"));
    const item = draft.insights.find(i => i.content.includes("概念页"));
    assert.equal(item.importance, 5, "machine-confirmed + quality_score>=5 应升到 5");
    assert.ok(item.tags.includes("trust:machine-confirmed"), "应带信任分级标签: " + JSON.stringify(item.tags));

    // 4) git checkout 语义：记 X → 改成 Y → 还原成 X（中途不跑管线）→ 零动作
    const orig = readFileSync(q, "utf8");
    writeFileSync(q, orig + "\n中间态。\n");
    writeFileSync(q, orig);
    assert.deepEqual(
      pick(parseAfter(run(ctx, ["--sync"]), "同步")),
      { synced: 0, retired: 0, drift: 0, bodyDrift: 0 },
      "还原成已记录的内容不应有动作",
    );
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});

test("e2e: 退役页被检出并挡在召回之外", () => {
  const ctx = setup();
  try {
    seed(ctx);
    run(ctx, ["--sync"]);
    const p = join(ctx.vault, "wiki", "决策", "悬挂链接.md");
    writeFileSync(p, readFileSync(p, "utf8").replace("tags: [a]", "tags: [a]\nsuperseded_by: \"[[wiki/决策/正常页]]\""));
    // 同时改另一页的 quality_score —— 否则 toSync 为空、根本不会生成草稿，
    // 就会读到上一轮遗留的 draft.json（假阳性）。
    const q = join(ctx.vault, "wiki", "概念", "概念页.md");
    writeFileSync(q, readFileSync(q, "utf8").replace("tags: [wiki/概念]", "tags: [wiki/概念]\nquality_score: 5"));
    const r = parseAfter(run(ctx, ["--sync"]), "同步");
    assert.equal(r.retired, 1, "退役必须被检出并计入 retired: " + JSON.stringify(r));
    assert.equal(r.synced, 1, "另一页应正常重导: " + JSON.stringify(r));
    const draft = JSON.parse(readFileSync(ctx.draftOut, "utf8"));
    assert.ok(!draft.insights.some(i => i.content.includes("悬挂链接")), "退役页不应进召回");
    assert.ok(draft.insights.some(i => i.content.includes("概念页")), "正常页应在召回里");
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});

const pick = r => ({ synced: r.synced, retired: r.retired, drift: r.drift, bodyDrift: r.bodyDrift });
