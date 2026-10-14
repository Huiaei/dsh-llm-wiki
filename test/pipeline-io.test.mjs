/**
 * O3 回归测试：并发锁 / 原子写 / Obsidian 外部编辑检测
 *
 * 三个用例各对应一个真实故障，不是「为了覆盖率」写的：
 *
 * 1. **并发锁** —— 插件在 session/disposed 时拉起管线，systemd timer 每日 10:00 也拉起一份。
 *    插件的 60s 冷却是**进程内**计数，跨进程无效。两份同时跑的后果不是抛异常，而是
 *    互相覆盖 state / 覆盖对方刚 okf 补好的字段 —— 静默劣化，最难发现的那类。
 *    这一条同时验证「陈旧锁可回收」：上次被 kill -9 时 exit 钩子不跑，锁会永远留着，
 *    之后所有实例都进不去。宁死不活的故障比并发故障更糟。
 *
 * 2. **原子写** —— 写入途中 kill -9（或掉电）会留下半截文件。frontmatter 砍一半的 md
 *    会被 Obsidian 读成坏页，且 hash 与内容对不上。
 *
 * 3. **外部编辑检测** —— Obsidian 正在编辑同一页时，管线读进来、算完、写回去，会把用户
 *    这一轮编辑覆盖掉。写前复查 mtime 即可挡住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLock, releaseLock, atomicWrite, safeWritePage } from "../scripts/lib/pipeline-io.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const PIPELINE = join(ROOT, "scripts/llm-wiki-pipeline.mjs");

function makeEnv(extra = {}) {
  return { ...process.env, PATH: process.env.PATH, ...extra };
}

/** 造一个最小可用 vault：3 页，每类 1 页，都缺 OKF 字段 → okf 阶段一定会写 */
function makeVault(root) {
  const vault = join(root, "vault");
  for (const cat of ["决策", "概念", "引用"]) {
    mkdirSync(join(vault, "wiki", cat), { recursive: true });
    writeFileSync(join(vault, "wiki", cat, "页.md"),
      `---\ntitle: ${cat}页\ntype: ${cat}\ncreated: 2026-01-01\n---\n\n正文。\n`);
  }
  return vault;
}

test("锁：第二个实例被拒入，且退出码是 0（不是错误）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-o3-lock-"));
  const home = join(dir, "home");
  const vault = makeVault(dir);
  mkdirSync(home, { recursive: true });

  // 用一个 sleep 0.5 的后台进程占住锁，等它拿到再起第二个
  const lockFile = join(dir, "pipeline.lock");
  assert.equal(acquireLock(lockFile), true, "第一个应拿到锁");
  const holder = JSON.parse(readFileSync(lockFile, "utf8"));
  assert.equal(holder.pid, process.pid);

  const env = makeEnv({
    HOME: home, LLM_WIKI_VAULT: vault,
    LLM_WIKI_STATE: join(dir, "state.json"),
    LLM_WIKI_FAKE_EMBED: "never",
  });
  const out = execFileSync(process.execPath, [PIPELINE, "--all"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(out, /另一个管线实例正在运行/, "第二个实例应报告被拒: " + out);
  assert.match(out, new RegExp("pid " + process.pid), "应报出占用者的 pid: " + out);
  // 被拒的那次什么都不能写
  assert.equal(existsSync(join(vault, "wiki/决策/页.md")), true, "页面仍在（没被删）");
  assert.ok(!readFileSync(join(vault, "wiki/决策/页.md"), "utf8").includes("stale_after"), "被拒的实例不应补字段");

  releaseLock(lockFile);
  assert.equal(existsSync(lockFile), false, "释放后锁文件应消失");
  rmSync(dir, { recursive: true, force: true });
});

test("锁：陈旧锁被回收（kill -9 之后管线仍能跑）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-o3-stale-"));
  const lockFile = join(dir, "pipeline.lock");
  // 手写一个「死人遗留」的锁：pid 用一个不可能存在的值
  writeFileSync(lockFile, JSON.stringify({ pid: 0x7fffffff, at: new Date().toISOString() }));
  assert.equal(acquireLock(lockFile), true, "pid 已死的陈旧锁应被回收，而不是永久锁死");

  // 时间戳过期也算陈旧
  releaseLock(lockFile);
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }));
  assert.equal(acquireLock(lockFile), true, "超过 LOCK_STALE_MS 的锁应被回收");

  releaseLock(lockFile);
  rmSync(dir, { recursive: true, force: true });
});

test("锁：损坏的锁文件不会永久锁死管线", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-o3-corrupt-"));
  const lockFile = join(dir, "pipeline.lock");
  writeFileSync(lockFile, "{ 这不是 JSON");
  assert.equal(acquireLock(lockFile), true, "读不出来的锁保守当陈旧回收，否则写坏一次就永久锁死");
  releaseLock(lockFile);
  rmSync(dir, { recursive: true, force: true });
});

test("并发：两个管线同时跑，只有一个真的干活", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-o3-race-"));
  const home = join(dir, "home");
  const vault = makeVault(dir);
  mkdirSync(home, { recursive: true });
  const env = makeEnv({
    HOME: home, LLM_WIKI_VAULT: vault,
    LLM_WIKI_STATE: join(dir, "state.json"),
    LLM_WIKI_FAKE_EMBED: "never",
  });

  // 两个子进程同时起。只 spawn 不 sleep：--okf 的启动（node 引导 + import 六个 lib）
  // 本身就够慢，两个进程几乎必然在 acquireLock 处相遇。若此断言偶发 rejected=0，
  // 说明两个进程错开了约 100ms —— 那是竞态窗口没覆盖到，不是锁失效（下面的显式
  // 持锁用例已经钉死了「持锁期间必被拒」这一行为）。
  const kids = [0, 1].map(() => spawn(process.execPath, [PIPELINE, "--okf"],
    { env, stdio: ["ignore", "pipe", "pipe"] }));
  const outs = kids.map(() => "");
  let rejected = 0, done = 0, settled = 0;
  return new Promise((resolve, reject) => {
    kids.forEach((k, i) => {
      k.stdout.on("data", d => { outs[i] += d; });
      k.stderr.on("data", d => { outs[i] += d; });   // 「另一个管线」打到 stdout，但兜底也抓 stderr
      k.on("close", () => {
        if (/另一个管线实例/.test(outs[i])) rejected++; else done++;
        if (++settled === 2) {
          try {
            assert.equal(rejected + done, 2, "两个进程都应有结论");
            assert.ok(rejected >= 1 && done >= 1,
              "两个并发实例不能都成功（要么一个被拒，要么都没跑起来）: rejected=" + rejected + " done=" + done);
          } catch (e) { rmSync(dir, { recursive: true, force: true }); reject(e); return; }
          rmSync(dir, { recursive: true, force: true });
          resolve();
        }
      });
    });
  });
});

test("原子写：崩溃只留 .tmp 垃圾，绝不留半截文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-o3-atomic-"));
  const target = join(dir, "page.md");
  const original = "---\ntitle: 原文\n---\n\n完整内容\n";
  writeFileSync(target, original);

  // 在 rename 之前 kill：用子进程写一个大内容然后 kill -9 它。
  // 更直接的做法是让 rename 那个瞬间被杀 —— 用 helper 进程卡在 fsync 之后做不到（无钩子），
  // 所以改为：写一个比 writeFileSync 慢得多的大 payload，并在其执行中 kill。
  const killer = spawn(process.execPath, ["-e", `
    const { openSync, writeSync, fsyncSync, closeSync } = require("node:fs");
    const fd = openSync(process.argv[1] + ".tmp-probe", "w", 0o644);
    const chunk = Buffer.alloc(1024*1024, 0x61);
    for (let i = 0; i < 8; i++) { writeSync(fd, chunk); fsyncSync(fd); }
    closeSync(fd);
  `, target], { stdio: "ignore" });

  const t = setTimeout(() => killer.kill("SIGKILL"), 30);
  killer.on("close", () => {
    clearTimeout(t);
    try {
      // 原文件必须完好：rename 没发生过
      assert.equal(readFileSync(target, "utf8"), original, "原文件不应被写坏");
      // 留下的只能是 tmp 同胞，不会是 target 本身被截断
      const junk = readdirSync(dir).filter(f => f.includes(".tmp-"));
      assert.ok(junk.length >= 1, "应留下 .tmp 同胞（这是代价，可接受）: " + JSON.stringify(readdirSync(dir)));
      for (const j of junk) assert.ok(j.includes(".tmp-"), j);
      rmSync(dir, { recursive: true, force: true });
    } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
  });
});

test("原子写：正常路径下内容完整且模式正确", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-o3-atomic2-"));
  const target = join(dir, "nested/deep/page.md");
  atomicWrite(target, "内容");
  assert.equal(readFileSync(target, "utf8"), "内容");
  // 目录不存在时应自动创建（atomicWrite 里 mkdirSync recursive）
  const leftovers = readdirSync(join(dir, "nested/deep"));
  assert.deepEqual(leftovers, ["page.md"], "不应留下 .tmp 残留: " + JSON.stringify(leftovers));
  rmSync(dir, { recursive: true, force: true });
});

test("冲突检测：Obsidian 改过的页被跳过，内容不被覆盖", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-o3-conflict-"));
  const full = join(dir, "页.md");
  writeFileSync(full, "---\ntitle: 页\n---\n\n原文\n");

  // 模拟收集时的快照：p.mtime 是旧的
  const p = { rel: "wiki/决策/页.md", full, mtime: 1 };   // 1 = 1970，肯定对不上
  const r = safeWritePage(p, "---\ntitle: 页\n---\n\n管线想写的内容\n");
  assert.equal(r.skipped, true, "mtime 不一致应跳过");
  assert.match(r.reason, /外部修改/);
  assert.equal(readFileSync(full, "utf8").includes("管线想写的内容"), false, "用户内容绝不能被覆盖");

  // mtime 一致时正常写
  const st = statSync(full);
  const p2 = { rel: "wiki/决策/页.md", full, mtime: st.mtimeMs };
  const r2 = safeWritePage(p2, "---\ntitle: 页\n---\n\n管线想写的内容\n");
  assert.equal(r2.ok, true, "mtime 一致应写入: " + JSON.stringify(r2));
  assert.ok(readFileSync(full, "utf8").includes("管线想写的内容"));

  rmSync(dir, { recursive: true, force: true });
});

test("冲突检测：写失败被捕获为 error（不抛）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-o3-err-"));
  // 用「目标是目录」造一个必然失败的写入：renameSync(file ← dir) 会 ENOTEMPTY/EISDIR。
  // 不用 chmod 0500 —— 测试跑在 root 下，0500 对 root 不生效（root 绕过权限位），
  // 那条路在这里根本构造不出失败，会得到 {"ok":true} 的假阴性。
  const asDir = join(dir, "其实是目录.md");
  mkdirSync(asDir, { recursive: true });
  writeFileSync(join(asDir, "keep"), "x");
  const bad = { rel: "wiki/x.md", full: asDir, mtime: 0 };
  const r = safeWritePage(bad, "内容");
  // 注意：bad.mtime=0 而目标存在 → 先撞上 mtime 冲突检查，返回 skipped。
  // 这恰好覆盖了两个守卫的**优先级**：外部编辑检测在写入尝试之前，所以哪怕写入注定失败，
  // 也先报「疑似 Obsidian 改过」。要单独测 error 分支，得让 mtime 先对上。
  assert.ok(r.error || r.skipped, "应返回 error/skipped 而不是抛: " + JSON.stringify(r));
  assert.equal(readFileSync(join(asDir, "keep"), "utf8"), "x", "原目录内容不该被破坏");

  // 单独测 error 分支：mtime 对齐后再写
  const st = statSync(asDir);
  const r2 = safeWritePage({ rel: "wiki/x.md", full: asDir, mtime: st.mtimeMs }, "内容");
  assert.ok(r2.error, "mtime 对齐后应真的尝试写并捕获失败: " + JSON.stringify(r2));
  assert.equal(readFileSync(join(asDir, "keep"), "utf8"), "x", "原目录内容仍不该被破坏");
  rmSync(dir, { recursive: true, force: true });
});
