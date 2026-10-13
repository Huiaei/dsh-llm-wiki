/**
 * frontmatter.mjs —— LLM-Wiki frontmatter 受控子集解析 / 序列化（零外部依赖）
 *
 * 设计（O1）：不引入 YAML 库，而是明确定义一个 frontmatter 子集，**超出子集即报错，不静默吞掉**。
 *
 *   支持：标量（含引号）           title: 文本 / title: "带: 冒号"
 *        内联数组                 tags: [a, b, "c d"]
 *        块序列                   related:\n  - "[[wiki/概念/A]]"
 *        内联映射                 verified: { by: agent/x, at: "2026-01-01T00:00:00Z" }
 *        块映射                   generated:\n  by: agent/x\n  at: "..."
 *
 *   不支持（报 fm_syntax）：锚点/引用（& / *）、多行折叠标量（> / |）、嵌套超过 2 层、tab 缩进
 *
 * 为什么需要它：旧的 parseFm 是逐行 `line.match(/^([\w_]+):\s*(.*)$/)`，把 tags 读成字符串
 * "[wiki/决策, compiled]"、把多行 related 整个读成空串、把 verified/sources 读成原始字符串。
 * 盘上的 YAML 是合法的（Obsidian/Dataview 读得对），**只有管线自己是瞎的** —— 于是 lint 无法
 * 校验 type↔目录、无法校验 related 目标是否存在，stale_after/verified/superseded_by 全部写而不读。
 */

/** 规范分类表（唯一来源，避免三处硬编码数组各自漂移） */
export const CATS = ["决策", "发现", "概念", "项目", "流程", "命令", "规则", "提示", "记忆", "基因", "引用"];

/** frontmatter 定位（支持前置杂行）：返回第一个"行首"--- 块（防值内 --- 如 URL 误判） */
export function extractFmText(content) {
  let start;
  if (content.startsWith("---")) start = 0;
  else {
    const m = content.match(/^---[\r\n]/m);
    if (!m) return null;
    start = m.index;
  }
  const end = content.indexOf("\n---", start + 3);
  if (end < 0) return null;
  return { start, end, fm: content.slice(start + 3, end) };
}

/** 顶层逗号切分（忽略引号内与括号内） */
export function splitInline(s) {
  const out = [];
  let cur = "", q = null, depth = 0;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * 解析 frontmatter 块。返回 { data, errors }；errors 非空即表示写法超出受控子集。
 * @param {string} block extractFmText().fm
 */
export function parseFmYaml(block) {
  const data = {};
  const errors = [];
  const lines = String(block == null ? "" : block).split("\n");

  const stripQuote = (s) => {
    s = s.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      try { return s[0] === '"' ? JSON.parse(s) : s.slice(1, -1); } catch { return s.slice(1, -1); }
    }
    return s;
  };

  const parseValue = (raw, depth = 0) => {
    const s = String(raw == null ? "" : raw).trim();
    if (s === "") return "";
    if (depth > 2) { errors.push("嵌套超过 2 层，超出受控子集: " + s.slice(0, 40)); return stripQuote(s); }
    // 锚点 / 引用
    if (/^[&*]\S/.test(s)) { errors.push("不支持锚点/引用（& / *）: " + s.slice(0, 40)); return stripQuote(s); }
    // 多行折叠标量
    if (/^[>|][+-]?$/.test(s)) { errors.push("不支持多行折叠标量（> / |）: " + s.slice(0, 40)); return ""; }
    // wikilink 不能被误读成嵌套 flow 序列
    if (s.startsWith("[[") && s.endsWith("]]")) return stripQuote(s);
    if (s.startsWith("[") && s.endsWith("]")) return splitInline(s.slice(1, -1)).map((x) => parseValue(x, depth + 1));
    if (s.startsWith("{") && s.endsWith("}")) {
      const o = {};
      for (const kv of splitInline(s.slice(1, -1))) {
        const idx = kv.indexOf(":");
        if (idx < 0) { errors.push("内联映射项缺冒号: " + kv); continue; }
        o[kv.slice(0, idx).trim()] = parseValue(kv.slice(idx + 1), depth + 1);
      }
      return o;
    }
    return stripQuote(s);
  };

  let i = 0;
  const seen = new Set();
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("\t")) { errors.push("不支持 tab 缩进: " + line.slice(0, 40)); i++; continue; }
    if (/^\s/.test(line)) { errors.push("意外的缩进行（缺少父键）: " + line); i++; continue; }
    const m = line.match(/^([A-Za-z_][\w-]*):(?:\s*(.*))?$/);
    if (!m) { errors.push("无法解析的行: " + line); i++; continue; }
    const key = m[1];
    // 重复键：解析取最后一个，而 setFmField 改的是第一个 —— 两边不一致会静默丢数据
    if (seen.has(key)) errors.push("重复的键: " + key);
    seen.add(key);
    const rest = (m[2] || "").trim();
    if (rest !== "") { data[key] = parseValue(rest); i++; continue; }

    // 值为空 → 可能是块序列或块映射
    const items = [], map = {};
    let j = i + 1, sawSeq = false, sawMap = false;
    while (j < lines.length && /^\s+\S/.test(lines[j])) {
      if (lines[j].startsWith("\t")) { errors.push("不支持 tab 缩进: " + lines[j].slice(0, 40)); j++; continue; }
      const sub = lines[j].replace(/^\s+/, "");
      const seq = sub.match(/^-\s*(.*)$/);
      if (seq) { sawSeq = true; items.push(parseValue(seq[1], 1)); j++; continue; }
      const kv = sub.match(/^([A-Za-z_][\w-]*):(?:\s*(.*))?$/);
      if (kv) { sawMap = true; map[kv[1]] = parseValue((kv[2] || "").trim(), 1); j++; continue; }
      errors.push("块内无法解析: " + sub);
      j++;
    }
    if (sawSeq && sawMap) errors.push("键 " + key + " 同时含序列项与映射项");
    data[key] = sawSeq ? items : sawMap ? map : "";
    i = j;
  }
  return { data, errors };
}

/** 便捷解析：只要数据，忽略诊断（供 ratePage / docsSync 等单点读取使用） */
export function parseFm(content) {
  const blk = extractFmText(content);
  if (!blk) return {};
  return parseFmYaml(blk.fm).data;
}

/** 带诊断的解析（供 lint 使用） */
export function parseFmStrict(content) {
  const blk = extractFmText(content);
  if (!blk) return { data: {}, errors: [], hasFm: false };
  const r = parseFmYaml(blk.fm);
  return { data: r.data, errors: r.errors, hasFm: true };
}

/** 把 JS 值序列化为受控子集 YAML 片段 */
export function fmSerialize(value) {
  if (Array.isArray(value)) return "[" + value.map(fmSerialize).join(", ") + "]";
  if (value && typeof value === "object") {
    return "{ " + Object.entries(value).map(([k, v]) => k + ": " + fmSerialize(v)).join(", ") + " }";
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const s = String(value == null ? "" : value);
  return /^[\w\u4e00-\u9fff][\w\u4e00-\u9fff .\-/]*$/.test(s) && !/^(true|false|null|\d)/.test(s)
    ? s
    : JSON.stringify(s);
}

/**
 * 写入字段原始文本（不经过序列化）。
 * 相比旧实现（`new RegExp("^"+field+":.*$","m")` 只替换单行）这里会**一并消费该字段的缩进续行**，
 * 否则把一个块序列字段改成标量会在 frontmatter 里留下孤立的 `  - ...` 行，下次解析报
 * "意外的缩进行（缺少父键）"——旧实现正是这样损坏文件的。
 */
export function setFmRaw(content, field, rawValue) {
  const blk = extractFmText(content);
  if (!blk) return content;
  const lines = blk.fm.split("\n");
  const re = new RegExp("^" + field + ":");
  let idx = -1;
  for (let i = 0; i < lines.length; i++) { if (re.test(lines[i])) { idx = i; break; } }
  const head = String(rawValue).startsWith("\n") ? field + ":" + rawValue : field + ": " + rawValue;
  let newLines;
  if (idx < 0) {
    newLines = [...lines, head];
  } else {
    let j = idx + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j])) j++;   // 吃掉续行；空行不吞
    newLines = [...lines.slice(0, idx), head, ...lines.slice(j)];
  }
  return content.slice(0, blk.start + 3) + newLines.join("\n") + "\n---" + content.slice(blk.end + 4);
}

/** 写入字段（结构化：数组→内联数组，对象→内联映射，标量按需加引号） */
export function setFmField(content, field, value) {
  return setFmRaw(content, field, fmSerialize(value));
}

/** 写入块序列（Obsidian 里比内联数组更易读；与 compilePatterns 的既有格式一致） */
export function setFmSeq(content, field, items) {
  const arr = Array.isArray(items) ? items : [items];
  const body = arr.map((v) => "  - " + fmSerialize(v)).join("\n");
  return setFmRaw(content, field, "\n" + body);
}

/** 需要结构化的字段及其期望形状（用于旧文件的一次性规范化） */
export const STRUCTURED_FIELDS = {
  tags: "array",
  related: "array",
  sources: "array",
  supersedes: "array",
  verified: "map",
  generated: "map",
};

/** 取某字段在 frontmatter 里的原始文本（未解析），用于判断是否被引号包裹 */
function rawFieldText(block, field) {
  const re = new RegExp("^" + field + ":(.*)$", "m");
  const m = String(block).match(re);
  return m ? m[1].trim() : null;
}

/**
 * 规范化「字符串形态的结构化字段」→ 真正的数组 / 映射。
 *
 * 只处理**无歧义**的情况：原始文本未被引号包裹，且按子集语法能切出列表项。
 * 被引号包裹的 `tags: "a, b"` 保持原样（YAML 语义上它就是字符串），交给 lint 报形状错误。
 *
 * @returns {{content: string, repairs: Array<{field: string, from: string, to: any}>}}
 */
export function repairStructuredFields(content) {
  const blk = extractFmText(content);
  if (!blk) return { content, repairs: [] };
  const { data, errors } = parseFmYaml(blk.fm);
  // 解析本身就有诊断 → 一个字都不改。
  // 否则 `tags: &anchor 坏写法` 会被"规范化"成 ["&anchor 坏写法"]，把误读结果写进磁盘、
  // 同时抹掉 lint 的 fm_syntax —— 违背"超出子集即报错，不静默"的初衷。
  if (errors.length) return { content, repairs: [] };
  const repairs = [];
  let out = content;
  for (const [field, want] of Object.entries(STRUCTURED_FIELDS)) {
    const v = data[field];
    if (v === undefined || v === "") continue;
    const isArr = Array.isArray(v);
    const isMap = v !== null && typeof v === "object" && !Array.isArray(v);
    if (want === "map" && isMap) continue;
    if (want === "array" && isArr) {
      // sources 的元素在 OKF 里是 { resource: ... } 对象，okfAlign 写入的就是这个形状。
      // 把裸字符串数组也归一成同一形状，免得同一个字段在库里出现两种表示。
      if (field === "sources" && v.some(x => typeof x === "string")) {
        const objs = v.map(x => (typeof x === "string" ? { resource: x } : x));
        out = setFmField(out, field, objs);
        repairs.push({ field, from: v, to: objs });
      }
      continue;
    }
    if (typeof v !== "string") continue;                 // 数字/布尔等形状错误交给 lint 报告
    const raw = rawFieldText(blk.fm, field);
    if (raw === null || /^["']/.test(raw)) continue;     // 显式引号 → 作者意图就是字符串
    if (want !== "array") continue;
    let items = splitInline(v);
    if (items.length === 0) continue;
    if (field === "sources") items = items.map(x => ({ resource: x }));
    out = setFmField(out, field, items);
    repairs.push({ field, from: v, to: items });
  }
  return { content: out, repairs };
}
