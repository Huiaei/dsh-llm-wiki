/**
 * pipeline-io.mjs —— 管线的 I/O 纪律（O3）
 *
 * 三件事，对应三个真实故障：
 *
 * 1. **跨进程锁**：插件在 session/disposed 时拉起管线，systemd timer 每日 10:00
 *    也拉起一份。插件的 60s 冷却只是**进程内**计数，跨进程无效。两份管线同时跑
 *    → 互相覆盖对方刚写的 state、互相 undo 对方刚写完的 okf 补齐。
 * 2. **原子写**：`writeFileSync` 非原子。写入途中 kill -9（或断电）会留下半截
 *    文件——frontmatter 砍一半的 md 会被 Obsidian 读成坏页，且 hash 对不上。
 * 3. **外部编辑检测**：Obsidian 正在编辑同一文件时，管线读进来、算完、写回去，
 *    会把用户这一轮编辑覆盖掉。写前复查 mtime 即可低成本挡住。
 *
 * 为什么放在 lib/ 而不是 ingest.mjs：ingest 依赖 frontmatter/hash/paths，
 * 而这里只需要 fs。分层保持「零循环依赖」。
 *
 * **锁文件位置由调用方传入**（管线传 `~/.dsh/llm-wiki/pipeline.lock`）。这是必要的：
 * 测试并行跑多个 vault，若锁路径跟着 STATE_DIR 之外的全局位置走，测试之间会互相拒入。
 */
import { openSync, writeSync, closeSync, fsyncSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, statSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/** 锁的陈旧阈值：超过这个时间没人更新的锁视为死者遗留，可被回收。 */
export const LOCK_STALE_MS = 30 * 60 * 1000;

/**
 * 同目录 tmp + rename。rename 在同一文件系统上是原子的，所以读者只会看到
 * 完整的旧内容或完整的新内容，永远不会看到半截。
 *
 * tmp 名带 pid + 时间戳：两个进程同时写同一目标时 tmp 不会互撞（撞了也只是
 * 其中一个 rename 失败，不会污染目标文件）。
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
      try { closeSync(fd); } catch {}
    }
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

/**
 * 抢占跨进程锁。O_CREAT|O_EXCL 由内核保证原子：恰好一个进程能创建成功。
 *
 * 陈旧锁回收是必要的——上次进程被 kill -9 时 `exit` 钩子不会跑，锁会永远留着，
 * 之后所有管线实例都进不去（宁死不活的故障比并发故障更糟）。判据两条，任一成立
 * 即回收：锁内容里的 pid 已不存在，或锁的时间戳超过 LOCK_STALE_MS。
 *
 * 返回 true = 拿到锁（可以继续）；false = 别人在跑（应安静退出）。
 */
export function acquireLock(lockFile) {
  try {
    const fd = openSync(lockFile, "wx");
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    } finally {
      try { closeSync(fd); } catch {}
    }
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") return false;
    // 锁存在：判断是不是死者遗留
    let stale = false;
    try {
      const j = JSON.parse(readFileSync(lockFile, "utf8"));
      const expired = Date.now() - Date.parse(j.at) > LOCK_STALE_MS;
      let dead = false;
      try { process.kill(j.pid, 0); } catch { dead = true; }
      stale = expired || dead;
    } catch {
      // 锁文件读不出来（损坏/正在被写）：保守当陈旧，否则一个写坏的锁能永久锁死管线
      stale = true;
    }
    if (stale) {
      try { unlinkSync(lockFile); } catch { return false; }
      return acquireLock(lockFile);
    }
    return false;
  }
}

/** 释放锁。幂等：锁已经没了（被别人回收）也不抛。 */
export function releaseLock(lockFile) {
  try { unlinkSync(lockFile); } catch {}
}

/** 锁持有者（仅测试与诊断用）。 */
export function lockHolder(lockFile) {
  try { return JSON.parse(readFileSync(lockFile, "utf8")); } catch { return null; }
}

/**
 * 带外部编辑检测的页面写入。
 *
 * `p.mtime` 来自本次运行开始时 collectPages() 的 statSync。写入前再比一次：
 * 不一致 → 这段时间里有人改了文件（最常见是 Obsidian），跳过而不是覆盖。
 * 这比「读时加时间戳再写」更简单，也够用——它挡不住两次恰好都在同一毫秒内
 * 的修改，但那个窗口在人工编辑场景下没有实际意义。
 *
 * 返回 { ok } / { skipped, reason } / { error }。调用方应把 skipped 汇进阶段输出。
 */
export function safeWritePage(p, content) {
  try {
    if (existsSync(p.full) && statSync(p.full).mtimeMs !== p.mtime) {
      return { skipped: true, reason: "本次运行期间被外部修改（可能是 Obsidian），已跳过: " + p.rel };
    }
    atomicWrite(p.full, content);
    return { ok: true };
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 120) };
  }
}
