/**
 * sanitize.mjs —— 写入侧消毒（F4）
 *
 * 这里只放**管线侧**（写入侧）的函数：标题在进入 `wiki/index.md` 之前要过 safeTitle()，
 * 因为 index.md 是给 Obsidian 看的 markdown，一个 `]` 就能破坏 `* [title](rel)` 链接。
 *
 * 注入侧（sanitizeInjected / renderPreview / UNTRUSTED_NOTICE）**刻意不在这里** ——
 * 它们在 `plugin/dsh-llm-wiki.mjs` 内。原因：README「方式 A」用
 * `dsh plugin add github:iwtown/dsh-llm-wiki#<sha>` 只取插件那一个文件，
 * 插件若 import 同级模块，方式 A 装出来的插件会直接加载失败。
 * 插件必须自包含；那边的函数已 export，测试可以直接 import 调用。
 *
 * 为什么单独一个文件：与 O1/O2 同一个理由 —— 管线是「import 即执行 main()」的脚本，
 * 留在里面无法被 `node --test` 加载，而这些函数正是 F4 的验收点之一。
 */

/**
 * 标题消毒（写入侧）。
 *
 * 与方案初稿的差别：初稿只去 `[[` 与 `]]`，复审发现**单个 `]` 就足以破坏**
 * `* [title](rel)` 这个 markdown 链接（标题里出现 `]` 会让链接文本提前闭合）。
 * 因此把方括号整体换成全角 —— 比直接删除更能保住标题的可读性。
 */
export function safeTitle(t, limit = 120) {
  return String(t == null ? "" : t)
    .replace(/[\r\n]+/g, " ")                   // 换行 → 空格（防多行指令注入）
    .replace(/[`<>]/g, "")                      // 防围栏 / 标签逃逸
    .replace(/\[/g, "［").replace(/\]/g, "］")  // 防破坏 index.md 的 markdown 链接
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit) || "（无标题）";
}

/**
 * 疑似指令注入的标题特征。**只用于 lint 告警，不用于删除** ——
 * 误报代价是作者看到一条警告，漏报代价是标题进系统提示词，两者不对称。
 */
export const SUSPICIOUS_TITLE_RE =
  /(ignore\s+(all\s+)?previous|disregard\s+(all\s+)?(previous|above|prior)|system\s*[:：]|<\s*\/?\s*(system|assistant|user|tool)\s*>|you\s+must|do\s+not\s+tell|忽略(以上|上述|之前|前面)|系统\s*[:：]|必须(执行|遵守)|不要告诉)/i;

export function isSuspiciousTitle(t) {
  return SUSPICIOUS_TITLE_RE.test(String(t == null ? "" : t));
}
