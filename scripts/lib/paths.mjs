/**
 * paths.mjs —— vault 内路径守卫（F1）
 *
 * 为什么单独一个文件：`--rate` 的路径穿越是唯一能改写 vault 之外任意文件的缺陷，
 * 而守卫本身是纯函数（rel + base → 绝对路径或 null），适合单测。
 * 管线是「import 即执行 main()」的脚本，留在里面无法被 node --test 加载。
 */
import { resolve, relative, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";

/** child 是否等于 parent 或位于 parent 之内（正确处理 parent 为根目录的情形） */
export function isInside(child, parent) {
  if (child === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

/**
 * 把传入的相对路径安全地解析到 vault 内。
 *
 * @param {string} rel   命令行/模型给出的路径（应相对 vault 根）
 * @param {string} base  vault 根目录
 * @param {object} [opts]
 * @param {boolean} [opts.mustExist=true] 是否要求目标存在（存在则穿透符号链接复查）
 * @param {string|null} [opts.ext=".md"]  要求的扩展名；null 表示不限制
 * @returns {{full: string, rel: string} | null} 越界 / 非法 / 不存在一律 null
 *
 * 双重校验：先按字面 resolve 做包含性检查，再 realpath（穿透符号链接）后复查。
 * 只做字面检查会被 `wiki/链接.md -> /etc/hosts` 这类符号链接绕过 —— 字面看它在 vault 内。
 */
export function safeJoinVault(rel, base, opts = {}) {
  const { mustExist = true, ext = ".md" } = opts;
  if (typeof rel !== "string" || rel.length === 0) return null;
  if (rel.includes("\0")) return null;

  let baseReal;
  try {
    baseReal = realpathSync(resolve(base));      // vault 不存在 → 拒绝（不做「尽力而为」）
    if (!statSync(baseReal).isDirectory()) return null;
  } catch { return null; }

  let full;
  try { full = resolve(baseReal, rel); } catch { return null; }
  if (!isInside(full, baseReal)) return null;    // 字面越界（含传绝对路径的情形）
  if (ext && !full.endsWith(ext)) return null;   // 只接受 .md

  if (mustExist) {
    try { full = realpathSync(full); } catch { return null; }   // 不存在 → 拒绝
    if (!isInside(full, baseReal)) return null;                 // 链接指向 vault 外 → 拒绝
  }
  return { full, rel: relative(baseReal, full).split(sep).join("/") };
}
