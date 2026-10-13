/**
 * O1 回归测试：frontmatter 受控子集解析 / 序列化 / 规范化
 *
 * 这些用例之所以此前**不可能存在**，是因为解析逻辑长在 llm-wiki-pipeline.mjs 里——
 * 那是一个 import 即执行 main() 的脚本，没有导出，无法被 node --test 加载。
 * 抽到 scripts/lib/ 之后纯函数可以直接单测。
 *
 * 运行: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CATS, extractFmText, splitInline, parseFmYaml, parseFm, parseFmStrict,
  fmSerialize, setFmRaw, setFmField, setFmSeq, repairStructuredFields,
} from "../scripts/lib/frontmatter.mjs";

const wrap = (fm, body = "正文\n") => "---\n" + fm + "\n---\n\n" + body;

test("CATS 是 11 个分类的唯一来源", () => {
  assert.equal(CATS.length, 11);
  assert.ok(CATS.includes("决策") && CATS.includes("引用"));
  assert.ok(!CATS.includes("索引"), "索引是 Dataview 聚合目录，不是可写分类");
});

test("extractFmText 定位 frontmatter 块", () => {
  assert.equal(extractFmText(wrap("title: T")).fm, "\ntitle: T");
  assert.equal(extractFmText("无 frontmatter"), null);
  assert.equal(extractFmText("---\ntitle: T\n没有结束标记"), null);
  // 前置杂行（BOM / 空行）时仍能定位
  const r = extractFmText("\n\n---\ntitle: T\n---\n\n正文");
  assert.ok(r && r.fm.includes("title: T"));
});

test("splitInline 只在顶层逗号切分", () => {
  assert.deepEqual(splitInline("a, b, c"), ["a", "b", "c"]);
  assert.deepEqual(splitInline('"x, y", z'), ['"x, y"', "z"]);
  assert.deepEqual(splitInline("{ a: 1, b: 2 }"), ["{ a: 1, b: 2 }"]);
});

test("受控子集：五种子集写法都能解析", () => {
  const { data, errors } = parseFmYaml([
    "title: 带: 冒号的标题",
    "type: 决策",
    'tags: [wiki/决策, compiled, "带 空格 的标签"]',
    "related:",
    '  - "[[wiki/概念/A]]"',
    '  - "[[wiki/概念/B]]"',
    'sources: [{ resource: "https://a.b/c?d=1" }]',
    "verified:",
    "  by: agent/dsh-llm-wiki",
    "  at: 2026-01-01T00:00:00Z",
  ].join("\n"));

  assert.deepEqual(errors, [], "合法子集不应产生诊断");
  assert.equal(data.title, "带: 冒号的标题");
  assert.deepEqual(data.tags, ["wiki/决策", "compiled", "带 空格 的标签"]);
  assert.deepEqual(data.related, ["[[wiki/概念/A]]", "[[wiki/概念/B]]"]);
  assert.deepEqual(data.sources, [{ resource: "https://a.b/c?d=1" }]);
  assert.deepEqual(data.verified, { by: "agent/dsh-llm-wiki", at: "2026-01-01T00:00:00Z" });
});

test("裸 wikilink 不被误读成嵌套 flow 序列", () => {
  const { data, errors } = parseFmYaml("related: [[wiki/概念/A]]");
  assert.deepEqual(errors, []);
  assert.equal(data.related, "[[wiki/概念/A]]", "标量形态的 wikilink 保持字符串，由 lint 报形状错误");
});

test("超出受控子集即报错，不静默吞掉", () => {
  const cases = [
    ["tags: &anchor value", /锚点\/引用/],
    ["desc: >", /多行折叠标量/],
    ["\ttitle: T", /tab 缩进/],
    ["title: T\n  - 游离缩进", /意外的缩进行（缺少父键）/],
    [">>>: 坏键", /无法解析的行/],
  ];
  for (const [fm, re] of cases) {
    const { errors } = parseFmYaml(fm);
    assert.ok(errors.length > 0, "应当报错: " + JSON.stringify(fm));
    assert.ok(errors.some((e) => re.test(e)), "错误信息应匹配 " + re + "，实际: " + JSON.stringify(errors));
  }
});

test("解析诊断能透传到 parseFmStrict（lint 的 fm_syntax 来源）", () => {
  const r = parseFmStrict(wrap("title: T\ntags: &a b"));
  assert.equal(r.hasFm, true);
  assert.ok(r.errors.length > 0);
  assert.equal(parseFmStrict("没有 frontmatter").hasFm, false);
});

test("回归：旧 parseFm 读不回的结构化字段，现在读得回", () => {
  // 这是真实 vault 里一页的 frontmatter 形状。旧实现逐行 /^([\w_]+):\s*(.*)$/ 会得到：
  //   tags    -> "[wiki/决策, compiled]"（字符串）
  //   related -> ""（多行块整个丢失）
  //   sources -> "[{ resource: \"https://a.b\" }]"（原始字符串）
  //   verified-> "{ by: ..., at: ... }"（原始字符串）
  const fm = [
    "title: X",
    "tags: [wiki/决策, compiled]",
    "related:",
    '  - "[[wiki/概念/A]]"',
    'sources: [{ resource: "https://a.b" }]',
    'verified: { by: agent/dsh-llm-wiki, at: "2026-01-01T00:00:00Z" }',
  ].join("\n");
  const d = parseFm(wrap(fm));
  assert.deepEqual(d.tags, ["wiki/决策", "compiled"]);
  assert.deepEqual(d.related, ["[[wiki/概念/A]]"]);
  assert.deepEqual(d.sources, [{ resource: "https://a.b" }]);
  assert.equal(d.verified.by, "agent/dsh-llm-wiki");
});

test("fmSerialize → parseFmYaml 往返一致", () => {
  const values = [
    ["related", ["[[wiki/概念/A]]", "[[wiki/概念/B]]"]],
    ["sources", [{ resource: "https://a.b/c?d=1" }]],
    ["verified", { by: "agent/dsh-llm-wiki", at: "2026-01-01T00:00:00Z" }],
    ["tags", ["wiki/决策", "带 空格 的标签", "含: 冒号"]],
    ["title", "带: 冒号的标题"],
    ["description", "-"],
  ];
  for (const [field, v] of values) {
    const { data, errors } = parseFmYaml(field + ": " + fmSerialize(v));
    assert.deepEqual(errors, [], field + " 序列化后应无诊断");
    assert.deepEqual(data[field], v, field + " 往返应一致");
  }
});

test("fmSerialize 对歧义标量加引号", () => {
  assert.equal(fmSerialize("agent/x"), "agent/x");
  assert.equal(fmSerialize("带: 冒号"), '"带: 冒号"');
  assert.equal(fmSerialize("2026-01-01T00:00:00Z"), '"2026-01-01T00:00:00Z"');
  assert.equal(fmSerialize(3), "3");
  assert.equal(fmSerialize(true), "true");
});

test("setFmRaw 是块感知的：块序列改标量不留孤儿行", () => {
  // 旧实现 new RegExp("^"+field+":.*$","m") 只替换单行，会留下 "  - ..." 孤儿行，
  // 下一次解析就报「意外的缩进行（缺少父键）」——这正是旧代码损坏文件的机制。
  const before = wrap('title: T\nrelated:\n  - "[[wiki/A]]"\n  - "[[wiki/B]]"\ncreated: 2026-01-01');
  const after = setFmRaw(before, "related", "[x, y]");
  assert.ok(!/\n\s+- /.test(extractFmText(after).fm), "不应残留块序列行");
  const { data, errors } = parseFmYaml(extractFmText(after).fm);
  assert.deepEqual(errors, []);
  assert.deepEqual(data.related, ["x", "y"]);
  assert.equal(data.created, "2026-01-01", "后续字段不受影响");
});

test("setFmField / setFmSeq 写入并可被解析回来", () => {
  let c = wrap("title: T");
  c = setFmField(c, "tags", ["a", "b"]);
  c = setFmSeq(c, "related", ["[[wiki/A]]", "[[wiki/B]]"]);
  c = setFmField(c, "quality_score", 3);
  const { data, errors } = parseFmYaml(extractFmText(c).fm);
  assert.deepEqual(errors, []);
  assert.deepEqual(data.tags, ["a", "b"]);
  assert.deepEqual(data.related, ["[[wiki/A]]", "[[wiki/B]]"]);
  assert.equal(Number(data.quality_score), 3, "标量数值以字符串返回，由调用方 Number() 收敛");
  assert.ok(c.includes("\n---\n\n正文"), "正文未被破坏");
});

test("repairStructuredFields 只修无歧义情况", () => {
  // 无引号的字符串形态 → 修
  const r1 = repairStructuredFields(wrap("title: T\ntags: wiki/决策, compiled"));
  assert.equal(r1.repairs.length, 1);
  assert.deepEqual(parseFmYaml(extractFmText(r1.content).fm).data.tags, ["wiki/决策", "compiled"]);

  // 显式引号 → 作者意图就是字符串，不修（交给 lint 报形状错误）
  const r2 = repairStructuredFields(wrap('title: T\ntags: "wiki/决策, compiled"'));
  assert.equal(r2.repairs.length, 0);

  // 已经是正确形状 → 不动
  const r3 = repairStructuredFields(wrap("title: T\ntags: [a, b]\nverified: { by: agent/x }"));
  assert.equal(r3.repairs.length, 0);
});

test("repairStructuredFields 幂等", () => {
  const once = repairStructuredFields(wrap("title: T\ntags: a, b\nsources: x, y")).content;
  const twice = repairStructuredFields(once);
  assert.equal(twice.content, once, "第二次规范化不应再改内容");
  assert.equal(twice.repairs.length, 0);
});

test("repairStructuredFields 不碰有解析诊断的文件", () => {
  // `tags: &anchor 坏写法` 会被解析器判为锚点语法错误。若此时还去"规范化"，
  // 就会把误读结果 ["&anchor 坏写法"] 写进磁盘，同时抹掉 lint 的 fm_syntax —— 静默改写。
  const src = wrap("title: T\ntags: &anchor 坏写法");
  const r = repairStructuredFields(src);
  assert.equal(r.content, src, "有诊断时内容必须一字不改");
  assert.equal(r.repairs.length, 0);
  // 诊断仍然可见（lint 的 fm_syntax 来源）
  assert.ok(parseFmStrict(src).errors.length > 0);
});

test("重复键报错（解析取最后一个、setFmField 改第一个 → 会静默丢数据）", () => {
  const { errors } = parseFmYaml("title: 第一个\ntitle: 第二个");
  assert.ok(errors.some(e => /重复的键/.test(e)), "应报重复键，实际: " + JSON.stringify(errors));

  // 键名不同则不应误报
  assert.deepEqual(parseFmYaml("title: A\ntype: B").errors, []);

  // 有重复键的文件一律不被自动改写（与其它诊断同等对待）
  const src = wrap("title: T\nquality_score: 3\nquality_score: 5");
  assert.equal(repairStructuredFields(src).content, src);
  assert.ok(parseFmStrict(src).errors.length > 0);
});
