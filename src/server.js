import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { DoudizhuService } from "./doudizhu-service.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.resolve(process.env.DOUDIZHU_DATA_DIR || path.join(rootDir, "data/doudizhu"));
// ChatNest 嵌入：默认对外监听；可用 HOST=127.0.0.1 收紧
const host = process.env.HOST || "0.0.0.0";
const port = Math.max(1, Number(process.env.PORT) || 8788);
const sslCert = process.env.SSL_CERTFILE || "";
const sslKey = process.env.SSL_KEYFILE || "";
const useTls = Boolean(sslCert && sslKey && fsSync.existsSync(sslCert) && fsSync.existsSync(sslKey));
// 头像走 base64 dataURL：解码后服务层允许 2MB，编码后约 ×4/3，再加 JSON 外壳 → 放宽到 4MB
const maxBodyBytes = Math.max(4 * 1024 * 1024, Number(process.env.DOUDIZHU_MAX_BODY_BYTES) || 0);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".wav", "audio/wav"],
]);

const doudizhu = new DoudizhuService({ rootDir, dataDir });
await doudizhu.ready();

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  res.end(data);
}

function sendOk(res, data, status = 200) {
  sendJson(res, status, { ok: true, data });
}

function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

async function sendStatic(res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded === "/doudizhu" || decoded === "/doudizhu/") decoded = "/doudizhu/index.html";
  const relative = decoded.replace(/^\/+/, "");
  const filePath = path.resolve(publicDir, relative);
  const publicPrefix = `${path.resolve(publicDir)}${path.sep}`;
  if (!filePath.startsWith(publicPrefix)) return false;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    const body = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const immutable = /\/assets\//.test(decoded);
    res.writeHead(200, {
      "content-type": contentTypes.get(extension) || "application/octet-stream",
      "content-length": body.length,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/doudizhu/health") {
      return sendOk(res, await doudizhu.health());
    }
    if (req.method === "GET" && url.pathname === "/api/doudizhu/state") {
      return sendOk(res, doudizhu.publicSnapshot("aurex"));
    }
    if (req.method === "POST" && url.pathname === "/api/doudizhu/action") {
      return sendOk(res, await doudizhu.handleClientMessage(await readJsonBody(req), "aurex"));
    }
    const avatarMatch = url.pathname.match(/^\/api\/doudizhu\/avatar\/([a-z0-9_-]+)$/i);
    if (req.method === "GET" && avatarMatch) {
      const avatar = await doudizhu.avatarFile(avatarMatch[1]);
      if (!avatar) return sendError(res, 404, "AVATAR_NOT_FOUND", "头像不存在");
      res.writeHead(200, {
        "content-type": avatar.type,
        "content-length": avatar.data.length,
        // URL 已经带 ?v=换头时间戳，可以让 WKWebView 把头像留在本地。
        "cache-control": "public, max-age=31536000, immutable",
      });
      res.end(avatar.data);
      return;
    }
    return sendError(res, 404, "NOT_FOUND", "斗地主接口不存在");
  } catch (error) {
    return sendError(res, 400, "DOUDIZHU_ACTION_FAILED", error.message || "牌桌操作失败");
  }
}

async function requestHandler(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/") {
    res.writeHead(302, { location: "/doudizhu/" });
    res.end();
    return;
  }
  if (url.pathname.startsWith("/api/doudizhu/")) return handleApi(req, res, url);
  if (req.method === "GET" || req.method === "HEAD") {
    if (await sendStatic(res, url.pathname)) return;
  }
  sendError(res, 404, "NOT_FOUND", "页面不存在");
}

const server = useTls
  ? https.createServer(
      {
        cert: fsSync.readFileSync(sslCert),
        key: fsSync.readFileSync(sslKey),
      },
      requestHandler,
    )
  : http.createServer(requestHandler);

const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

function sendSocket(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

wss.on("connection", async (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("message", async (raw) => {
    try {
      await doudizhu.handleClientMessage(JSON.parse(raw.toString("utf8")), "aurex");
    } catch (error) {
      sendSocket(ws, { type: "error", error: error.message || "牌桌操作失败" });
    }
  });
  sendSocket(ws, { type: "snapshot", data: doudizhu.publicSnapshot("aurex") });
});

doudizhu.onBroadcast((snapshot) => {
  const message = JSON.stringify({ type: "snapshot", data: snapshot });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
});

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/api/doudizhu/ws") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } catch {
    socket.destroy();
  }
});

const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, 30_000);
heartbeat.unref?.();

server.listen(port, host, () => {
  const scheme = useTls ? "https" : "http";
  console.log(`Aevi 家庭斗地主已启动：${scheme}://${host}:${port}/doudizhu/`);
});

function shutdown() {
  void doudizhu.shutdown();     // 顺手收掉三个座位的常驻 claude 会话
  clearInterval(heartbeat);
  for (const client of wss.clients) client.close(1001, "server shutdown");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref?.();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
