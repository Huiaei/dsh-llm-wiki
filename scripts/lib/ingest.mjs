/**
 * O10 ingest contract — the pure, testable half.
 *
 * The contract is a *process boundary*, not a function call: a converter is any
 * executable that takes an input path plus `--inbox`/`--sources` directories and
 * emits one line of JSON. This module owns everything the dispatcher and the
 * tests must agree on — path shapes, required frontmatter fields, and validation
 * — so that the rules are not re-derived at each call site.
 *
 * Nothing here parses a document format. That is the converter's job.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import { parseFmStrict } from "./frontmatter.mjs";

/** Allowed `fidelity` values. Declared by the converter from the *input* format. */
export const FIDELITY = ["lossless", "lossy"];

/** The seven fields every `raw/inbox/*.md` must carry. */
export const REQUIRED_INBOX_FIELDS = [
  "title",
  "source",
  "sha256",
  "original_name",
  "converted_by",
  "converted_at",
  "fidelity",
];

/**
 * Extension → format key. The format key names the converter binary
 * (`convert-<fmt>`). A format can appear here before its converter exists:
 * dispatch then fails with exit 2 ("converter not installed"), which is the
 * correct answer and keeps the supported-format list in one place.
 */
export const FORMATS = {
  ".html": "html",
  ".htm": "html",
  ".xhtml": "html",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".csv": "csv",
  ".pdf": "pdf",
  ".docx": "docx",
  ".pptx": "pptx",
  ".xlsx": "xlsx",
  ".epub": "epub",
};

/** `工具名@版本` — the version is mandatory; see O10 on targeted re-conversion. */
export const CONVERTER_VERSION_RE = /^[A-Za-z0-9._-]+@[0-9][A-Za-z0-9._+-]*$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Exit codes of the CLI protocol. */
export const EXIT = { OK: 0, USAGE: 2, PARSE: 3, UNREADABLE: 4 };

export function normalizeExt(ext) {
  const e = String(ext == null ? "" : ext).toLowerCase();
  if (!e) return "";
  return e.startsWith(".") ? e : "." + e;
}

export function isSupportedExt(ext) {
  return Object.prototype.hasOwnProperty.call(FORMATS, normalizeExt(ext));
}

/** Converter binary name for an extension, or null when the format is unknown. */
export function converterFor(ext) {
  const fmt = FORMATS[normalizeExt(ext)];
  return fmt ? "convert-" + fmt : null;
}

/** `raw/inbox/<sha256 前 16 位>.md` */
export function inboxPath(dir, sha256) {
  return join(dir, String(sha256).slice(0, 16) + ".md");
}

/** `raw/sources/<sha256><ext>` */
export function sourcePath(dir, sha256, ext) {
  let e = normalizeExt(ext);
  if (!e) e = ".bin";
  return join(dir, String(sha256) + e);
}

/**
 * Validate a staging file against the contract.
 *
 * Returns `{ data, errors }`. YAML diagnostics come from the controlled-subset
 * parser, so a converter that emits a construct the pipeline cannot read back is
 * rejected here rather than silently mis-parsed three stages later.
 */
export function parseInboxFm(text) {
  const { data, errors } = parseFmStrict(text);
  const errs = [...errors];

  for (const f of REQUIRED_INBOX_FIELDS) {
    const v = data[f];
    if (v === undefined || v === null || String(v).trim() === "") {
      errs.push("缺少必填字段: " + f);
    }
  }
  if (data.fidelity != null && !FIDELITY.includes(String(data.fidelity))) {
    errs.push("fidelity 非法（应为 " + FIDELITY.join(" | ") + "）: " + data.fidelity);
  }
  if (data.sha256 != null && !SHA256_RE.test(String(data.sha256))) {
    errs.push("sha256 必须是 64 位小写十六进制: " + String(data.sha256).slice(0, 20));
  }
  if (data.converted_by != null && !CONVERTER_VERSION_RE.test(String(data.converted_by))) {
    errs.push("converted_by 必须带版本号（工具名@版本）: " + data.converted_by);
  }
  if (data.converted_at != null && !ISO8601_RE.test(String(data.converted_at))) {
    errs.push("converted_at 必须是带时区的 ISO 8601: " + data.converted_at);
  }
  return { data, errors: errs };
}

/**
 * tmp + rename in the same directory. Shared with O3.
 *
 * A crash can leave a `.tmp-*` sibling behind but can never leave a partial file
 * at `file`, which is what "非 0 时不得留下任何 raw/inbox 文件" needs.
 */
export function atomicWrite(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  let fd;
  try {
    fd = openSync(tmp, "w", 0o644);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw e;
  }
}

/**
 * Locate `convert-<fmt>`.
 *
 * Search order: explicit `--converter`/`$LLM_WIKI_CONVERTERS` first (so a test
 * or an operator can override), then the repo's own build output, then `~/bin`
 * (where install.sh puts it).
 */
export function findConverter(name, { root, env = process.env, dirs } = {}) {
  const search = [];
  if (dirs) search.push(...dirs);
  if (env.LLM_WIKI_CONVERTERS) search.push(env.LLM_WIKI_CONVERTERS);
  if (root) search.push(join(root, "converters", "bin"));
  if (env.HOME) search.push(join(env.HOME, "bin"));
  for (const d of search) {
    if (!d) continue;
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Extensions this repo ships a converter for right now. */
export function extOf(p) {
  return extname(String(p == null ? "" : p)).toLowerCase();
}
