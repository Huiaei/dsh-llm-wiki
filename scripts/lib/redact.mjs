/**
 * redact.mjs —— 会话导出前的密钥脱敏（F5）
 *
 * 为什么需要：技能文件写着「密钥不入库」，但**会话里粘贴过的密钥**会以「会话复盘」
 * 的形式被 `--dsh-export` 落进 vault —— 而 vault 在 /mnt/d，Windows 可写、可能被
 * Obsidian 同步或共享。规则管得住「主动写入」，管不住「顺手粘进对话」。
 *
 * 定位：这是**兜底**，不是许可。脱敏永远漏得掉（新格式、私有前缀、拼接过的串），
 * 所以 F5 的主手段是「默认关闭 + 输出迁出 vault」，脱敏只是第三层。
 *
 * 为什么单独一个文件：与 O1/O2 同一个理由 —— 管线是「import 即执行 main()」的脚本，
 * 留在里面无法被 `node --test` 加载。
 */

/** 顺序有意义：私钥块要排在通用 key=value 之前，否则会被后者的行内匹配切碎。 */
export const SECRET_PATTERNS = [
  // PEM 私钥（多行）
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // 常见平台 token 前缀。分隔符用 [_-]：GitHub 新旧两种格式分别是
  // ghp_xxx（2021 后）和 ghp-xxx（旧），只认连字符会漏掉现在这一批。
  /\b(?:sk|pk|ghp|gho|ghs|ghu|xox[baprs])[_-][A-Za-z0-9_-]{16,}\b/g,
  // AWS access key id
  /\bAKIA[0-9A-Z]{16}\b/g,
  // JWT
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // key=value / key: value 形式的密钥
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd)\s*[:=]\s*["']?([A-Za-z0-9_\-./+]{12,})/gi,
  // Authorization 头
  /(?:Bearer|Authorization:)\s+[A-Za-z0-9_\-.]{16,}/gi,
];

/** 命中片段保留前 10 字符，便于日后判断「这里曾经是什么」而不泄露全文。 */
function mask(m) {
  return m.length > 28 ? m.slice(0, 10) + "…[REDACTED]" : "[REDACTED]";
}

/**
 * 对文本做密钥脱敏。
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  let t = String(text == null ? "" : text);
  for (const re of SECRET_PATTERNS) t = t.replace(re, mask);
  return t;
}

/**
 * 是否存在疑似密钥（用于统计「本次脱敏了多少处」并写进 frontmatter）。
 * 独立于 redactSecrets，避免为了计数而跑两遍替换。
 */
export function hasSecrets(text) {
  const t = String(text == null ? "" : text);
  return SECRET_PATTERNS.some((re) => {
    re.lastIndex = 0;              // 带 g 的正则有状态，test() 前必须复位
    return re.test(t);
  });
}

/** MAX_LOG_LINES —— 操作日志的最大行数（F8）。
 *
 * log.md 每天写一行（timer 每天都跑），evolution/logs.md 每次新增 pattern 再写一批。
 * 两者都只增不减：没有上限意味着这些文件会一直变厚，而它们的内容是
 * 「纯运维、零知识价值」—— 唯一效果是把 vault 里不该看的东西推到用户眼前。
 * 上限取 500 行，就地截断而不是归档到别的文件：归档只是把体积挪个地方。
 */
export const MAX_LOG_LINES = 500;

/** 按行数截断日志：**保留开头（最新）的 max 行**，砍掉尾部（更旧）。
 *
 * 方向是硬约束，不能想当然地改成 slice(-max)。两个调用点都是 newest-first：
 *   - appendLog:      `line + 原内容`           —— 新行在最前
 *   - compilePatterns: 插在 `## <today>` 标题之后 —— 新条目在前，旧条目在后
 * 若改成留尾部，日志会变成「越旧越留着、每天新写的行先被砍」—— 正好反了。
 * 砍掉的块在开头留一行说明，让读的人知道这里少过东西，而不是静默消失。
 */
export function capLogLines(text, max = MAX_LOG_LINES) {
  if (typeof text !== "string") return { text: "", dropped: 0 };
  const lines = text.split("\n");
  if (lines.length <= max) return { text, dropped: 0 };
  const kept = lines.slice(0, max - 1);
  const dropped = lines.length - kept.length;
  return { text: `（已截断，省略更早的 ${dropped} 行，仅保留最近的 ${kept.length} 行）\n` + kept.join("\n"), dropped };
}
