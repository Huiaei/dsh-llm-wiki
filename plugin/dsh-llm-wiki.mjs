/**
 * dsh-llm-wiki.mjs —— LLM-Wiki 生命周期插件（P3）
 *
 * profile 本地文件插件（cordis.patch.yml insert name: './dsh-llm-wiki.mjs'）。
 * 零外部依赖（不 import dsh-tools；只用 node 内置 + ctx）。
 *
 * 功能：
 *  1. systemPrompt 注入：schema.md 守则 + 知识预览（index.md，管线产物）
 *  2. session/disposed → 异步触发 P2 管线（防重入 + 冷却）
 *
 * 配置（cordis.patch.yml config）:
 *  vault: vault 路径（默认 /mnt/d/DB/Obsidian/LLM-Wiki）
 *  previewOrder / rulesOrder: section 顺序
 */
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

export const name = "dsh-llm-wiki";
export const inject = ["systemPrompt"];

const DEFAULT_VAULT = "/mnt/d/DB/Obsidian/LLM-Wiki";
// F3/M6：原来用 process.env.HOME 拼接，HOME 未设时会得到 "undefined/bin/llm-wiki-pipeline.mjs"
const PIPELINE = process.env.LLM_WIKI_PIPELINE || join(homedir(), "bin", "llm-wiki-pipeline.mjs");
const CACHE_TTL = 60_000; // 读文件缓存 60s

// F3：只点名安全阶段，不用 --all。--all 现在也只跑安全阶段，但显式列出可以防止
// 「将来往 --all 里加阶段时，插件在不知情的情况下跟着跑」—— 这个钩子每 60s 就有机会触发。
const SAFE_STAGES = ["--lint", "--index", "--okf", "--usage", "--sync"];

function cached(file, ttl = CACHE_TTL) {
  let last = 0, data = "";
  return () => {
    try {
      const st = statSync(file);
      if (Date.now() - last < ttl && data) return data;
      data = readFileSync(file, "utf8");
      last = Date.now();
      return data;
    } catch { return data || ""; }
  };
}

export function apply(ctx, config = {}) {
  const vault = config.vault && String(config.vault).length > 0 ? config.vault : DEFAULT_VAULT;
  const rulesFile = join(vault, "schema.md");
  const previewFile = join(vault, "wiki/index.md");
  const readRules = cached(rulesFile);
  const readPreview = cached(previewFile);
  try { console.log("[dsh-llm-wiki] apply() vault=" + vault + " rules=" + existsSync(rulesFile) + " preview=" + existsSync(previewFile)); } catch {}

  // ── 1) systemPrompt 注入 ──
  // 知识预览（先于守则，order 更低先出现）
  ctx.effect(() => ctx.systemPrompt.section({
    name: "llm-wiki:preview",
    order: 138,
    text: () => {
      const idx = readPreview();
      if (!idx) return "";
      return "\n---\n# LLM-Wiki 知识库（管线自动维护）\n\n" + idx + "\n---\n";
    },
  }), "dsh-llm-wiki.prompt.preview");

  // schema 守则
  ctx.effect(() => ctx.systemPrompt.section({
    name: "llm-wiki:rules",
    order: 139,
    text: () => {
      const schema = readRules();
      if (!schema) return "";
      return "\n---\n# LLM-Wiki 知识库运行规则\n\n" + schema + "\n---\n";
    },
  }), "dsh-llm-wiki.prompt.rules");

  // ── 2) session/disposed → 触发管线 ──
  let lastRun = 0;
  let running = false;
  const COOLDOWN_MS = 60_000;

  const runPipeline = () => {
    if (running) return;
    // F3：预校验。原来只在 spawn 的 error 回调里报错，而 detached + stdio:"ignore"
    // 会把「管线不存在」变成一个每 60s 重复一次、无人看见的静默失败。
    if (!existsSync(PIPELINE)) {
      try { console.log("[dsh-llm-wiki] 管线不存在，跳过: " + PIPELINE); } catch {}
      return;
    }
    const now = Date.now();
    if (now - lastRun < COOLDOWN_MS) return;
    running = true;
    lastRun = now;
    const child = spawn(process.execPath, [PIPELINE, ...SAFE_STAGES], {
      stdio: "ignore",
      detached: true,
    });
    child.on("exit", (code) => {
      running = false;
      try { console.log("[dsh-llm-wiki] pipeline exit code=" + code); } catch {}
    });
    child.on("error", (e) => {
      running = false;
      try { console.log("[dsh-llm-wiki] pipeline spawn error: " + e.message); } catch {}
    });
    child.unref();
  };

  // F3：延迟 5s + 单次。会话销毁瞬间可能有多个 disposed 事件，而且此时管线会与正在收尾的
  // 进程抢 IO。原来的实现每个事件都立刻 spawn 一次，只有进程内 60s 冷却兜底。
  let timer = null;
  ctx.on("session/disposed", () => {
    if (timer) return;                        // 已有排队的触发 → 忽略后续事件
    timer = setTimeout(() => {
      timer = null;
      try { runPipeline(); } catch (e) { try { console.log("[dsh-llm-wiki] hook error: " + e.message); } catch {} }
    }, 5000);
    if (typeof timer.unref === "function") timer.unref();
  });
}
