/**
 * 一个座位一个常驻 `claude -p` 会话。
 *
 * 为什么不是每手起一个进程：ChatNest 那边 2026-08-06 实测过，冷起一次 CLI 要
 * 24-76 秒，其中 ~20 秒纯粹是 node 起来 + 首轮建 prompt cache。斗地主一回合
 * 只有十几秒，冷启动这条路必然次次超时、次次裁判代打——也就是「没接模型」。
 *
 * 所以照搬 chatnest/full-stack/app/cli_warm.py 的做法，只是换成 Node：
 * `--input-format stream-json` 让 CLI 一直读 stdin，一轮一问，进程和 cache 都
 * 留着，热起来之后一轮 1.5-4 秒。另外两处省时间也照抄：
 *   - MAX_THINKING_TOKENS=0 关掉扩展思考（不然它会为「出哪张」先想几百 token）
 *   - 拿到 assistant 那条文本就返回，不等 result（尾巴在后台排干，排干前算忙）
 *
 * 这台机器内存紧（8G），所以闲置 IDLE_MS 之后自己收摊，牌局再开会重新热。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const CLAUDE_BIN = process.env.DOUDIZHU_CLAUDE_BIN || "/usr/local/bin/claude";
// 绝不能在项目目录里起：CLAUDE.md 会被当上下文吃进去，又慢又跑题
const SANDBOX = path.resolve(
  process.env.DOUDIZHU_WARM_CWD || path.join(os.homedir(), ".chatnest", "warm-cwd"),
);
const IDLE_MS = Number(process.env.DOUDIZHU_WARM_IDLE_MS) || 300_000;
const MAX_TURNS = Number(process.env.DOUDIZHU_WARM_MAX_TURNS) || 60;
const BOOT_MS = Number(process.env.DOUDIZHU_WARM_BOOT_MS) || 90_000;
const TAIL_MS = 60_000;
const WARMUP_PROMPT = '热身，别管牌局，只回这一行：{"action":{"type":"chat"},"say":"在","emote":null,"prop":null}';

// root 下 `--dangerously-skip-permissions` 会被 CLI 直接拒绝（code 1），
// 两个座位就全是「决策失败 / 暂时没能回复」。工具已经 `--disallowedTools *`，
// 不需要这个旗。非 root 仍带上，免得权限提示把热身卡住。
export function claudeCliArgs(model, system) {
  const args = [
    "-p",
    "--model", model,
    "--setting-sources", "",
    "--disallowedTools", "*",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
  ];
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    args.push("--dangerously-skip-permissions");
  }
  args.push("--system-prompt", system);
  return args;
}

function deferred() {
  const box = { done: false };
  box.promise = new Promise((resolve, reject) => {
    box.resolve = (value) => {
      if (box.done) return;
      box.done = true;
      resolve(value);
    };
    box.reject = (error) => {
      if (box.done) return;
      box.done = true;
      reject(error);
    };
  });
  return box;
}

function textOf(event) {
  const content = event?.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text")
    .map((part) => String(part.text || ""))
    .join("")
    .trim();
}

export class ModelSession {
  constructor({ model, system, tag = "seat", onLog = null } = {}) {
    this.model = model;
    this.system = system;
    this.tag = tag;
    this.onLog = onLog;
    this.turns = 0;
    this.lastUsed = Date.now();
    this.proc = null;
    this.busy = false;
    this.waiters = [];
    this.stderrTail = "";
    this.pendingText = null;
    this.pendingDone = null;
    this.idleTimer = null;
  }

  get alive() {
    return Boolean(this.proc) && this.proc.exitCode === null && !this.proc.killed;
  }

  log(message) {
    if (this.onLog) this.onLog(`[warm:${this.tag}] ${message}`);
  }

  // ── 锁：一个会话同一时刻只跑一轮 ──────────────────────────────────────

  async acquire(deadlineAt) {
    if (!this.busy) {
      this.busy = true;
      return true;
    }
    const left = deadlineAt - Date.now();
    if (left <= 0) return false;
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          waiter.dead = true;
          resolve(false);
        }, left),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  release() {
    this.busy = false;
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      if (waiter.dead) continue;
      this.busy = true;
      waiter.resolve(true);
      return;
    }
    this.touchIdle();
  }

  touchIdle() {
    this.lastUsed = Date.now();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.busy && Date.now() - this.lastUsed >= IDLE_MS) void this.close("闲置收摊");
    }, IDLE_MS + 1_000);
    this.idleTimer.unref?.();
  }

  // ── 进程 ────────────────────────────────────────────────────────────

  spawnProcess() {
    const args = claudeCliArgs(this.model, this.system);
    this.stderrTail = "";
    this.turns = 0;
    fs.mkdirSync(SANDBOX, { recursive: true });
    const proc = spawn(CLAUDE_BIN, args, {
      cwd: SANDBOX,
      env: { ...process.env, MAX_THINKING_TOKENS: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,     // 自己一组，收摊时把 node 子进程一起收掉
    });
    this.proc = proc;
    proc.stdin.on("error", () => {});
    proc.on("error", (error) => {
      this.failPending(new Error(`claude 起不来：${error.message}`));
      this.proc = null;
    });
    proc.on("exit", (code, signal) => {
      this.failPending(new Error(`claude 退出了（${signal || `code ${code}`}）${this.stderrTail ? `：${this.stderrTail}` : ""}`));
      if (this.proc === proc) this.proc = null;
    });
    readline.createInterface({ input: proc.stdout }).on("line", (line) => this.handleEvent(line));
    proc.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-400);
    });
    this.log(`起了 ${this.model} pid=${proc.pid}`);
  }

  handleEvent(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;
    if (event.type === "assistant") {
      const text = textOf(event);
      if (text) this.pendingText?.resolve(text);
      return;
    }
    if (event.type === "result" || "duration_api_ms" in event) {
      const text = String(event.result || "");
      if (event.is_error || event.subtype === "error_during_execution") {
        this.pendingText?.reject(new Error(text || `模型报错：${event.subtype || "未知"}`));
      } else {
        this.pendingText?.resolve(text);
      }
      this.pendingDone?.resolve(true);
    }
  }

  failPending(error) {
    this.pendingText?.reject(error);
    this.pendingDone?.resolve(true);
  }

  async close(why = "") {
    clearTimeout(this.idleTimer);
    const proc = this.proc;
    this.proc = null;
    this.failPending(new Error("会话已关闭"));
    if (!proc || proc.exitCode !== null) return;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
    if (why) this.log(`收摊：${why}`);
  }

  // ── 问一轮 ──────────────────────────────────────────────────────────

  /**
   * 问一轮，deadline 内没吐字就返回 null（这一轮在后台自己收尾，别丢进程）。
   * 会话没起来就先起、先热身——热身那 ~20 秒也算在 deadline 里，所以牌局开始
   * 前应该先 warm() 一次，别让她那一手付这个钱。
   */
  async ask(prompt, timeoutMs) {
    const deadlineAt = Date.now() + Math.max(1_000, Number(timeoutMs) || 15_000);
    if (!(await this.acquire(deadlineAt))) return null;
    let handedOff = false;
    try {
      if (this.alive && this.turns >= MAX_TURNS) await this.close("上下文太长，换新的");
      if (!this.alive) {
        this.spawnProcess();
        const boot = await this.turn(WARMUP_PROMPT, Math.min(BOOT_MS, deadlineAt - Date.now()), true);
        if (boot === null) {
          await this.close("热身没赶上");
          return null;
        }
        this.log("热好了");
      }
      const left = deadlineAt - Date.now();
      if (left < 800) return null;
      const text = await this.turn(prompt, left, false);
      handedOff = true;       // 尾巴交给后台，锁由它放
      return text;
    } catch (error) {
      await this.close(error.message);
      throw error;
    } finally {
      this.lastUsed = Date.now();
      if (!handedOff) this.release();
    }
  }

  /** 起会话 + 热身，只在后台调，别占她的等待时间。 */
  async warm() {
    if (this.alive || this.busy) return;
    const deadlineAt = Date.now() + BOOT_MS;
    if (!(await this.acquire(deadlineAt))) return;
    try {
      this.spawnProcess();
      const boot = await this.turn(WARMUP_PROMPT, BOOT_MS, true);
      if (boot === null) await this.close("热身没赶上");
      else this.log("热好了");
    } catch (error) {
      await this.close(error.message);
    } finally {
      this.release();
    }
  }

  async turn(prompt, timeoutMs, tailInline) {
    const proc = this.proc;
    if (!proc?.stdin?.writable) throw new Error("没有活着的 claude 会话");
    this.pendingText = deferred();
    this.pendingDone = deferred();
    this.turns += 1;
    const payload = { type: "user", message: { role: "user", content: prompt } };
    proc.stdin.write(`${JSON.stringify(payload)}\n`);

    const text = await Promise.race([
      this.pendingText.promise,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), Math.max(500, timeoutMs));
        timer.unref?.();
      }),
    ]);
    if (text === null) this.log(`${Math.round(timeoutMs / 1000)}s 没吐字`);

    if (tailInline) await this.drain();
    else void this.drainThenRelease();
    return text;
  }

  async drain() {
    await Promise.race([
      this.pendingDone.promise,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, TAIL_MS);
        timer.unref?.();
      }),
    ]);
  }

  async drainThenRelease() {
    try {
      await this.drain();
      if (!this.pendingDone.done) await this.close("尾巴排不干");
    } catch {}
    this.release();
  }
}
