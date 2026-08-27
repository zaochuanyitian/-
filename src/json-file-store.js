import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const fileLocks = new Map();
function durationFromEnv(name, fallback, minimum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

const PROCESS_LOCK_STALE_MS = durationFromEnv("AEVI_JSON_LOCK_STALE_MS", 120_000, 30_000);
const PROCESS_LOCK_TIMEOUT_MS = Math.max(
  PROCESS_LOCK_STALE_MS,
  durationFromEnv("AEVI_JSON_LOCK_TIMEOUT_MS", 180_000, PROCESS_LOCK_STALE_MS),
);
const PROCESS_LOCK_HEARTBEAT_MS = Math.max(1_000, Math.min(15_000, Math.floor(PROCESS_LOCK_STALE_MS / 4)));
const PROCESS_LOCK_RETRY_MIN_MS = 8;
const PROCESS_LOCK_RETRY_MAX_MS = 40;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function displaceStaleLock(lockPath) {
  let owner = null;
  try {
    const raw = await fs.readFile(path.join(lockPath, "owner.json"), "utf8");
    try {
      owner = JSON.parse(raw);
    } catch {
      owner = null;
    }
  } catch (error) {
    if (error.code === "ENOENT") owner = null;
    else throw error;
  }
  let stat;
  try {
    stat = await fs.stat(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (Date.now() - stat.mtimeMs <= PROCESS_LOCK_STALE_MS) return false;
  const ownerPid = Number(owner?.pid);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;
  try {
    process.kill(ownerPid, 0);
    return false;
  } catch (error) {
    if (error.code !== "ESRCH") return false;
  }

  let latestOwner = null;
  try {
    latestOwner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
  } catch {
    return false;
  }
  if (latestOwner?.token !== owner?.token || Number(latestOwner?.pid) !== ownerPid) return false;

  const staleToken = String(owner?.token || `${stat.dev}-${stat.ino}-${Math.floor(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs)}`)
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 180);
  const displacedPath = `${lockPath}.stale.${staleToken}`;
  try {
    await fs.rename(lockPath, displacedPath);
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) return false;
    throw error;
  }
  // Keep the deterministic quarantine directory in place. A second process
  // that inspected the same stale owner will target this exact path, so its
  // rename fails instead of stealing a newly-acquired live lock.
  return true;
}

async function acquireProcessLock(filePath) {
  const absolutePath = path.resolve(filePath);
  const directory = path.dirname(absolutePath);
  const lockPath = `${absolutePath}.lock`;
  const token = randomUUID();
  const candidatePath = `${lockPath}.candidate.${process.pid}.${token}`;
  const candidateOwnerPath = path.join(candidatePath, "owner.json");
  const startedAt = Date.now();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.mkdir(candidatePath, { mode: 0o700 });
  try {
    await fs.writeFile(
      candidateOwnerPath,
      `${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString(), filePath: absolutePath })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    await fs.rm(candidatePath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  while (true) {
    try {
      await fs.rename(candidatePath, lockPath);

      let heartbeatRunning = false;
      const heartbeat = setInterval(async () => {
        if (heartbeatRunning) return;
        heartbeatRunning = true;
        const now = new Date();
        try {
          await fs.utimes(lockPath, now, now);
        } catch (error) {
          if (error.code !== "ENOENT") {
            // A failed heartbeat is recovered by the stale-lock path. Never let
            // a timer rejection terminate the process that owns the operation.
          }
        } finally {
          heartbeatRunning = false;
        }
      }, PROCESS_LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();

      return async () => {
        clearInterval(heartbeat);
        let owner;
        try {
          owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
        } catch (error) {
          if (error.code === "ENOENT") return;
          throw error;
        }
        if (owner.token !== token) return;
        // Publish the unlock with one atomic rename. Removing the live lock
        // directory in-place can race with filesystem bookkeeping on macOS
        // and intermittently fail with ENOTEMPTY, leaving all later writers
        // blocked. The uniquely named release directory is no longer visible
        // as the lock, so it is safe to clean up with bounded retries.
        const releasePath = `${lockPath}.release.${token}`;
        try {
          await fs.rename(lockPath, releasePath);
        } catch (error) {
          if (error.code === "ENOENT") return;
          throw error;
        }
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            await fs.rm(releasePath, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 });
            break;
          } catch (error) {
            if (attempt === 3) throw error;
            await delay(10 * (attempt + 1));
          }
        }
      };
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) {
        await fs.rm(candidatePath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      if (await displaceStaleLock(lockPath)) continue;
      if (Date.now() - startedAt > PROCESS_LOCK_TIMEOUT_MS) {
        await fs.rm(candidatePath, { recursive: true, force: true }).catch(() => {});
        throw new Error(`timed out waiting for JSON file lock: ${absolutePath}`);
      }
      const retryMs = PROCESS_LOCK_RETRY_MIN_MS + Math.floor(Math.random() * (PROCESS_LOCK_RETRY_MAX_MS - PROCESS_LOCK_RETRY_MIN_MS + 1));
      await delay(retryMs);
    }
  }
}

export async function withFileLock(filePath, operation) {
  const key = path.resolve(filePath);
  const previous = fileLocks.get(key) || Promise.resolve();
  const ready = previous.catch(() => {});
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = ready.then(() => gate);
  fileLocks.set(key, tail);

  await ready;
  let releaseProcessLock = null;
  try {
    releaseProcessLock = await acquireProcessLock(key);
    return await operation();
  } finally {
    try {
      await releaseProcessLock?.();
    } finally {
      release();
      if (fileLocks.get(key) === tail) fileLocks.delete(key);
    }
  }
}

async function existingMode(filePath, fallbackMode) {
  try {
    const stat = await fs.stat(filePath);
    return stat.mode & 0o777;
  } catch (error) {
    if (error.code === "ENOENT") return fallbackMode;
    throw error;
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EACCES"].includes(error.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function atomicWriteText(filePath, text, { mode = 0o600, preserveMode = false } = {}) {
  const absolutePath = path.resolve(filePath);
  const directory = path.dirname(absolutePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const finalMode = preserveMode ? await existingMode(absolutePath, mode) : mode;
  const tempPath = path.join(directory, `.${path.basename(absolutePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(tempPath, "wx", finalMode);
    await handle.writeFile(String(text), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, absolutePath);
    await fs.chmod(absolutePath, finalMode);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function atomicWriteJson(filePath, value, options = {}) {
  await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
  return value;
}
