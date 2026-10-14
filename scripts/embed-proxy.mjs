#!/usr/bin/env node
/**
 * embed-proxy.mjs —— Ollama 兼容 embedding 代理（11434 → SiliconFlow /v1/embeddings）
 *
 * 让 mnemon（只认 127.0.0.1:11434 的 Ollama API）使用云端 embedding，
 * 替代本地 Ollama。零模型下载，网络延迟 ~250ms/批。
 *
 * 端点：
 *   GET  /api/tags          → {"models":[...]}（存活检测，让 mnemon/管线认为 Ollama 可用）
 *   GET  /healthz           → {"ok":true,...}（本服务自身的存活/配置探针，不进 /api 命名空间）
 *   POST /api/embed         → Ollama 格式 {model,input} → SF {data:[{embedding}]} → {embeddings:[[]]}
 *   POST /api/embeddings    → OpenAI 兼容包装
 *
 * 配置（env）：
 *   EMBED_MODEL      SiliconFlow 模型（默认 BAAI/bge-m3）
 *   EMBED_KEY        API key（默认读 ~/.config/llm-wiki/embed.json 的 siliconflow.apiKey）
 *   EMBED_PORT       监听端口（默认 11434）
 *
 * F6 变更（原 M1 / M2）：
 *   ① 不再复用 ~/.modlens/config.json 里 **providers.openai** 的 key ——
 *      那是 A 厂商的凭据，发往 SiliconFlow 等于外泄。改用本服务专用凭据文件。
 *   ② 失败关闭：没有 key 直接退出，不提供"假装可用"的服务（否则 mnemon
 *      会以为 Ollama 在线，然后把所有 embedding 静默丢进空实现）。
 *   ③ 疑似 OpenAI 格式的 key → 拒绝启动（即便用户填错了地方）。
 *   ④ 请求体上限 + 输入条数上限 + 只接受回环来源。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const PORT = Number(process.env.EMBED_PORT || 11434);
const MODEL = process.env.EMBED_MODEL || "BAAI/bge-m3";
const SF_URL = "https://api.siliconflow.cn/v1/embeddings";
const MAX_BODY = 8 * 1024 * 1024;    // 8MB：bge-m3 的 8192 上限远小于此，纯防内存耗尽
const MAX_INPUTS = 256;              // 单批上限，防一次请求打满配额

/** 专用凭据：~/.config/llm-wiki/embed.json → { siliconflow: { apiKey } }。
 *  刻意不复用 ~/.modlens/config.json —— 那里躺着的是**别的厂商**的 key。 */
function loadKey() {
  if (process.env.EMBED_KEY) return process.env.EMBED_KEY.trim();
  try {
    const c = JSON.parse(readFileSync(join(homedir(), ".config/llm-wiki/embed.json"), "utf8"));
    return String(c?.siliconflow?.apiKey || "").trim();
  } catch { return ""; }
}
const KEY = loadKey();

// 失败关闭：宁可起不来，也不要"起得来但每次请求都 401/402"，
// 更不要让 mnemon 以为 Ollama 可用而走假 embedding。
if (!KEY) {
  console.error("embed-proxy: 未配置凭据。请设置 EMBED_KEY，或写入 ~/.config/llm-wiki/embed.json：");
  console.error('  { "siliconflow": { "apiKey": "sf-..." } }');
  process.exit(1);
}
// 交叉校验：OpenAI 与 SiliconFlow 的 key 都以 sk- 开头，所以这条判据是启发式的。
// 判错方向的代价不对称 —— 拦住一次误配（用户重新填）远好过把真 key 发去 B 厂商，
// 所以这里偏向「宁可拒绝」。判据：OpenAI 的新 key 几乎总是 sk-proj- 或纯 20+ 位随机串，
// 而 SiliconFlow 的 key 形如 sk-<小写字母数字>。两者不可靠区分时以 EMBED_ALLOW_OPENAI_KEY=1 放行。
const OPENAI_SHAPED = (/^sk-proj-/.test(KEY) || /^sk-[A-Za-z0-9_\-]{40,}$/.test(KEY))
  && !/^sk-[a-z0-9]{20,}$/.test(KEY);
if (OPENAI_SHAPED && process.env.EMBED_ALLOW_OPENAI_KEY !== "1") {
  console.error("embed-proxy: 这个 key 看起来是 OpenAI 格式（sk-proj- 或超长随机串），拒绝发往 SiliconFlow。");
  console.error("  若确认它就是 SiliconFlow 的 key，设 EMBED_ALLOW_OPENAI_KEY=1 再启动。");
  process.exit(1);
}

async function sfEmbed(inputs) {
  const res = await fetch(SF_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
    body: JSON.stringify({ model: MODEL, input: inputs }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json();
  if (!res.ok) throw new Error("SF " + res.status + ": " + JSON.stringify(j).slice(0, 200));
  return (j.data || []).map(d => d.embedding);
}

const started = Date.now();
let reqCount = 0;
let denied = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:" + PORT);
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  // 已 bind 127.0.0.1 仍再查一次来源：容器/网络命名空间给容器内进程开了口子时，
  // 这一层是唯一还在的。拒绝而不应答，避免被用来做端口扫描。
  const ra = req.socket.remoteAddress || "";
  if (!/^(127\.|::1$|::ffff:127\.)/.test(ra)) {
    denied++;
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "forbidden: loopback only" }));
  }
  reqCount++;
  try {
    if (req.method === "GET" && url.pathname === "/healthz") {
      return send(200, { ok: true, model: MODEL, port: PORT,
        uptime: Math.round((Date.now() - started) / 1000), requests: reqCount, denied });
    }
    if (req.method === "GET" && url.pathname === "/api/tags") {
      return send(200, { models: [{ name: MODEL, model: MODEL }] });
    }
    if (req.method === "POST" && (url.pathname === "/api/embed" || url.pathname === "/api/embeddings")) {
      let body = "", size = 0;
      for await (const ch of req) {
        size += ch.length;
        if (size > MAX_BODY) return send(413, { error: "request too large" });
        body += ch;
      }
      const { input } = JSON.parse(body || "{}");
      const list = (Array.isArray(input) ? input : [input]).filter(x => typeof x === "string");
      if (list.length === 0) return send(400, { error: "no string input" });
      if (list.length > MAX_INPUTS) return send(413, { error: "too many inputs (max " + MAX_INPUTS + ")" });
      const embeddings = await sfEmbed(list);
      // 数量对不上说明上游截断了 —— 直接把问题暴露出来，别让 mnemon 拿到
      // 长度不齐的向量数组然后在 cosine 里算出静默错位的结果。
      if (embeddings.length !== list.length) {
        return send(502, { error: "upstream returned " + embeddings.length + "/" + list.length + " embeddings" });
      }
      return url.pathname === "/api/embed"
        ? send(200, { model: MODEL, embeddings })
        : send(200, { data: embeddings.map((e, i) => ({ embedding: e, index: i, object: "embedding" })), model: MODEL });
    }
    return send(404, { error: "unknown endpoint: " + url.pathname });
  } catch (e) {
    return send(502, { error: "embed proxy error: " + String(e.message || e).slice(0, 200) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("embed-proxy: " + PORT + " -> " + MODEL + " (SF), key=" + (KEY ? "configured" : "MISSING"));
});
process.on("SIGTERM", () => { server.close(); process.exit(0); });

