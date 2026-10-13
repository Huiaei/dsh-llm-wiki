#!/usr/bin/env node
/**
 * wiki-convert — O10 ingest dispatcher.
 *
 * Picks `converters/convert-<fmt>` for the input's extension, runs it as a
 * child process, and validates what it produced. It parses no document format
 * itself, which is what keeps the pipeline auditable: every format-specific
 * dependency lives behind a process boundary that can crash without taking the
 * caller with it.
 *
 *   wiki-convert <输入路径> --inbox DIR --sources DIR [--json]
 *                [--source-url URL] [--converter PATH]
 *
 * Exit codes: 0 ok · 2 unsupported/not installed · 3 parse or contract failure
 * · 4 source unreadable. On any non-zero exit no new file is left in --inbox.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXIT,
  converterFor,
  extOf,
  findConverter,
  inboxPath,
  isSupportedExt,
  parseInboxFm,
  sourcePath,
} from "./lib/ingest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage(stream = process.stdout) {
  stream.write(
    "usage: wiki-convert <输入路径> --inbox DIR --sources DIR [--json]\n" +
      "                    [--source-url URL] [--converter PATH]\n",
  );
}

function parseArgs(argv) {
  const opts = {
    input: null,
    inbox: null,
    sources: null,
    json: false,
    converter: null,
    sourceUrl: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--inbox") opts.inbox = argv[++i];
    else if (a === "--sources") opts.sources = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--converter") opts.converter = argv[++i];
    else if (a === "--source-url") opts.sourceUrl = argv[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("-")) throw new Error("未知参数: " + a);
    else if (opts.input == null) opts.input = a;
    else throw new Error("多余的参数: " + a);
  }
  return opts;
}

/** Names of the `.md` files currently staged. Used to undo a failed run. */
function listInbox(dir) {
  try {
    return new Set(readdirSync(dir).filter((f) => f.endsWith(".md")));
  } catch {
    return new Set();
  }
}

/**
 * Remove staging files this run created. The contract says a failed conversion
 * leaves nothing behind; the converter cannot clean up after a SIGKILL, so the
 * dispatcher does it by diffing the directory.
 */
function cleanupInbox(dir, before) {
  for (const f of listInbox(dir)) {
    if (before.has(f)) continue;
    try {
      rmSync(join(dir, f), { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** The converter prints exactly one JSON line; tolerate extra chatter. */
function parseLastJson(stdout) {
  const lines = String(stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      continue;
    }
  }
  return null;
}

function fail(msg, code) {
  process.stderr.write("wiki-convert: " + msg + "\n");
  return code;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    usage(process.stderr);
    return fail(e.message, EXIT.USAGE);
  }
  if (opts.help) {
    usage();
    return EXIT.OK;
  }
  if (!opts.input) {
    usage(process.stderr);
    return fail("缺少输入路径", EXIT.USAGE);
  }
  if (!opts.inbox || !opts.sources) {
    usage(process.stderr);
    return fail("--inbox 与 --sources 必填", EXIT.USAGE);
  }

  const input = resolve(opts.input);
  if (!existsSync(input)) return fail("原件不可读: " + input, EXIT.UNREADABLE);

  const ext = extOf(input);
  if (!isSupportedExt(ext)) {
    return fail("不支持的扩展名: " + (ext || "(无)"), EXIT.USAGE);
  }
  const name = converterFor(ext);
  const bin = opts.converter || findConverter(name, { root: ROOT });
  if (!bin) {
    return fail(
      "转换器未安装: " + name + "（找过 " + join(ROOT, "converters", "bin") + " 与 ~/bin）",
      EXIT.USAGE,
    );
  }

  const inboxDir = resolve(opts.inbox);
  const sourcesDir = resolve(opts.sources);
  const before = listInbox(inboxDir);

  const childArgs = [input, "--inbox", inboxDir, "--sources", sourcesDir, "--json"];
  if (opts.sourceUrl) childArgs.push("--source-url", opts.sourceUrl);

  let stdout;
  try {
    stdout = execFileSync(bin, childArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (e) {
    cleanupInbox(inboxDir, before);
    if (e.signal) return fail("转换器被信号中断 (" + e.signal + ")", EXIT.PARSE);
    const code = typeof e.status === "number" ? e.status : EXIT.PARSE;
    return fail("转换器失败 (exit " + code + ")", code);
  }

  const parsed = parseLastJson(stdout);
  if (!parsed || !parsed.sha256) {
    cleanupInbox(inboxDir, before);
    return fail("转换器 stdout 不是合法 JSON（缺 sha256）", EXIT.PARSE);
  }

  const mdPath = parsed.inbox || inboxPath(inboxDir, parsed.sha256);
  if (!existsSync(mdPath)) {
    cleanupInbox(inboxDir, before);
    return fail("转换器未产出 " + mdPath, EXIT.PARSE);
  }

  const { data, errors } = parseInboxFm(readFileSync(mdPath, "utf8"));
  if (errors.length) {
    cleanupInbox(inboxDir, before);
    return fail("契约校验失败: " + errors.join("; "), EXIT.PARSE);
  }

  // lossy means information was dropped, so the original is the only thing that
  // can later prove the transcription right or wrong. Refuse to stage a lossy
  // conversion whose oracle is missing.
  if (String(data.fidelity) === "lossy") {
    const sp = parsed.source || sourcePath(sourcesDir, data.sha256, ext);
    if (!existsSync(sp)) {
      cleanupInbox(inboxDir, before);
      return fail("fidelity=lossy 但原件缺失: " + sp, EXIT.PARSE);
    }
  }

  const result = {
    ok: true,
    inbox: mdPath,
    source: parsed.source || sourcePath(sourcesDir, data.sha256, ext),
    sha256: String(data.sha256),
    title: String(data.title),
    fidelity: String(data.fidelity),
    converter: String(data.converted_by),
    skipped: Boolean(parsed.skipped),
  };
  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    process.stdout.write(
      "wiki-convert: " + name + " -> " + result.inbox +
        (result.skipped ? " (已存在，未重写)" : "") + "\n",
    );
  }
  return EXIT.OK;
}

process.exit(main());
