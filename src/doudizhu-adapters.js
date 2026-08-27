import { spawn } from "node:child_process";
import path from "node:path";

const MAX_OUTPUT_BYTES = 512 * 1024;

function cleanText(value, max = 200) {
  return String(value || "").trim().slice(0, max);
}

function booleanish(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = cleanText(value, 20).toLowerCase();
  if (["true", "yes", "y", "1", "agree", "同意", "赞成"].includes(normalized)) return true;
  if (["false", "no", "n", "0", "disagree", "不同意", "反对"].includes(normalized)) return false;
  return undefined;
}

function parseJsonCandidate(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {}
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }
  return null;
}

export function normalizeAdapterResponse(value) {
  let parsed = typeof value === "string" ? parseJsonCandidate(value) : value;
  if (parsed && typeof parsed === "object" && parsed.result && !parsed.action) parsed = parsed.result;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("适配器没有返回 JSON 对象");
  const action = typeof parsed.action === "string" ? { type: parsed.action } : parsed.action;
  if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error("适配器响应缺少 action");
  const type = cleanText(action.type, 32);
  if (!["bid", "play", "pass", "vote_dissolve", "chat"].includes(type)) throw new Error(`不支持的动作类型：${type || "空"}`);
  const normalizedAction = { type };
  if (type === "bid") normalizedAction.value = Number(action.value ?? parsed.value);
  if (type === "play") {
    const cards = Array.isArray(action.cards) ? action.cards : Array.isArray(parsed.cards) ? parsed.cards : [];
    normalizedAction.cards = cards.map((item) => cleanText(item, 20)).filter(Boolean).slice(0, 20);
  }
  if (type === "vote_dissolve") {
    const propVote = typeof parsed.prop === "string" ? parsed.prop : undefined;
    normalizedAction.agree = booleanish(action.agree ?? action.vote ?? parsed.agree ?? parsed.vote ?? propVote) ?? false;
  }
  const prop = parsed.prop && typeof parsed.prop === "object"
    ? { type: cleanText(parsed.prop.type, 24), target: cleanText(parsed.prop.target, 40) }
    : null;
  return {
    action: normalizedAction,
    // 给到 60：牌桌上限 40 字（MAX_CHAT_CHARS），这里留点余量让服务端去截，
    // 免得动作描写还没来得及剥掉就先被腰斩成半句
    say: cleanText(parsed.say, 60),
    emote: cleanText(parsed.emote, 32),
    prop: prop?.type && prop?.target ? prop : null,
  };
}

function killProcessTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

export class CommandPlayerAdapter {
  constructor({ debug = false } = {}) {
    this.debug = debug;
  }

  async decide(player, payload, { timeoutMs = 15_000 } = {}) {
    const command = Array.isArray(player.command) ? player.command : [];
    if (!command.length) throw new Error(`${player.name || player.id} 没有配置适配器命令`);
    const executable = command[0];
    const args = command.slice(1);
    const cwd = path.resolve(player.cwd || process.cwd());
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      const child = spawn(executable, args, {
        cwd,
        env: { ...process.env, ...(player.env || {}) },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => {
        killProcessTree(child);
        finish(new Error(`${player.name || player.id} 决策超时`));
      }, Math.max(250, Number(timeoutMs) || 15_000));
      timer.unref?.();
      child.on("error", (error) => finish(new Error(`${player.name || player.id} 适配器启动失败：${error.message}`)));
      child.stdout.on("data", (chunk) => {
        if (Buffer.byteLength(stdout) < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        if (Buffer.byteLength(stderr) < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        if (code !== 0) {
          const detail = cleanText(stderr || stdout || signal || `退出码 ${code}`, 500);
          finish(new Error(`${player.name || player.id} 适配器失败：${detail}`));
          return;
        }
        try {
          finish(null, normalizeAdapterResponse(stdout));
        } catch (error) {
          if (this.debug && stderr) error.message += `；stderr=${cleanText(stderr, 300)}`;
          finish(error);
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    });
  }
}

export function defaultDoudizhuPlayers(rootDir = process.cwd()) {
  return [
    {
      id: "aurex",
      name: "Aurex",
      kind: "human",
      avatar: "/doudizhu/assets/avatars/aurex.jpg",
      persona: { talkativeness: 0.6 },
    },
    {
      id: "aevi",
      name: "Aevi",
      kind: "cmd",
      command: [process.execPath, "scripts/doudizhu-bot-adapter.mjs"],
      cwd: rootDir,
      avatar: "/doudizhu/assets/avatars/aevi.jpg",
      persona: { talkativeness: 0.3 },
    },
    {
      id: "vex",
      name: "Vex",
      kind: "cmd",
      command: [process.execPath, "scripts/doudizhu-bot-adapter.mjs"],
      cwd: rootDir,
      avatar: "/doudizhu/assets/avatars/vex.jpg",
      persona: { talkativeness: 0.55 },
    },
    {
      id: "juhua",
      name: "菊花",
      kind: "cmd",
      command: [process.execPath, "scripts/doudizhu-bot-adapter.mjs"],
      cwd: rootDir,
      avatar: "/doudizhu/assets/avatars/juhua.svg",
      persona: { talkativeness: 0.1 },
    },
  ];
}
