#!/usr/bin/env node
/**
 * wiki-find.mjs —— O5 排序检索 CLI（零依赖）
 *
 * 用法: node wiki-find.mjs "<查询>" [--top N] [--json] [--cat 分类]
 *
 * 为什么要有它：上游 `skills/wiki-search/SKILL.md:24` 的检索是 `rg -l "<关键词>" wiki/`，
 * SKILL:26 自己承认"结果按目录顺序返回，模型自行判断相关度"—— 无排序、无质量加权，
 * 866 页的库会把模型埋在无关命中和历史废页里。这个脚本把排序逻辑显式化并可测。
 *
 * ⚠️ 它不是精确检索：2-gram 近似替代中文分词（见 lib/search.mjs 顶部注释），
 * SKILL 里必须写明"结果需模型复核"。
 *
 * 与注入面的关系：本脚本的输出进**模型上下文**，但不进**系统提示词** ——
 * 模型主动调用它是检索行为。这是 F4「注入面收敛」后与 O5 的分工。
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { CATS, extractFmText, parseFmYaml } from "./lib/frontmatter.mjs";
import { normalize, rankPages } from "./lib/search.mjs";

const VAULT = process.env.LLM_WIKI_VAULT || "/mnt/d/DB/Obsidian/LLM-Wiki";
const WIKI = join(VAULT, "wiki");

function parseArgv(argv) {
  const positional = [];
  let top = 10, json = false, cat = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--top") { top = Number(argv[++i]); }
    else if (a.startsWith("--top=")) { top = Number(a.slice(6)); }
    else if (a === "--cat") { cat = argv[++i]; }
    else if (a.startsWith("--cat=")) { cat = a.slice(6); }
    else if (a.startsWith("--")) { console.error("未知参数: " + a); process.exit(2); }
    else positional.push(a);
  }
  return { query: positional.join(" "), top, json, cat };
}

/** 读全库。与 collectPages 同一套解析（extractFmText + parseFmYaml），
 *  不另写一套单行正则 —— 那样 O1 修的 frontmatter 解析缺陷在检索侧会复活。 */
function loadPages(cat) {
  const pages = [];
  for (const c of CATS) {
    if (cat && c !== cat) continue;
    const dir = join(WIKI, c);
    if (!existsSync(dir)) continue;
    let files = [];
    try { files = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of files) {
      if (!e.isFile() || !e.name.endsWith(".md") || e.name === "index.md") continue;
      const full = join(dir, e.name);
      try {
        const content = readFileSync(full, "utf8");
        const blk = extractFmText(content);
        const parsed = blk ? parseFmYaml(blk.fm) : { data: {}, errors: [] };
        pages.push({
          cat: c, file: e.name, full,
          rel: relative(VAULT, full),
          fm: parsed.data,
          body: blk ? content.slice(blk.end + 4) : content,
        });
      } catch {}
    }
  }
  return pages;
}

const { query, top, json, cat } = parseArgv(process.argv.slice(2));
if (!query) {
  console.error('用法: node wiki-find.mjs "<查询>" [--top N] [--json] [--cat 分类]');
  process.exit(2);
}

const pages = loadPages(cat);
const ranked = rankPages(query, pages, { top });

if (json) {
  console.log(JSON.stringify({
    query, vault: VAULT, total: pages.length, returned: ranked.length,
    results: ranked.map((x) => ({
      rel: x.p.rel,
      title: x.p.fm.title || x.p.file,
      cat: x.p.cat,
      score: Number(x.s.toFixed(2)),
      status: x.p.fm.status || "active",
      superseded_by: x.p.fm.superseded_by || null,
      description: x.p.fm.description || x.p.fm.summary || null,
    })),
  }, null, 2));
} else if (ranked.length === 0) {
  console.log(`（无匹配，共扫描 ${pages.length} 页）`);
} else {
  console.log(`# 匹配 ${ranked.length} / ${pages.length} 页\n`);
  for (const x of ranked) {
    const flags = [];
    const st = x.p.fm.status;
    if (st && st !== "active") flags.push(st);
    if (x.p.fm.superseded_by) flags.push("superseded");
    const d = x.p.fm.description || x.p.fm.summary;
    console.log(`[${x.s.toFixed(2)}] ${x.p.rel}${flags.length ? " <" + flags.join("/") + ">" : ""}`);
    console.log(`      ${x.p.fm.title || x.p.file}${d && d !== "-" ? " — " + d : ""}`);
  }
  console.log("\n（2-gram 近似分词，结果需读原文复核；标 <superseded> 的只作历史参考）");
}
process.exit(0);
