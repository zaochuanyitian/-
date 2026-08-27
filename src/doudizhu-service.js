import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteJson, withFileLock } from "./json-file-store.js";
import { defaultDoudizhuPlayers } from "./doudizhu-adapters.js";
import { ModelPlayerAdapter } from "./doudizhu-model-adapter.js";
import {
  defaultSeatModel,
  normalizeSeatModel,
  seatModelOptions,
  seatThinkMs,
} from "./doudizhu-seat-models.js";
import {
  PLAYER_IDS,
  canBeat,
  cardFromId,
  cardPublicView,
  cardsBelongToHand,
  classifyMove,
  createDeck,
  labelsForCards,
  legalHint,
  nextPlayerId,
  removeCards,
  resolveRequestedCards,
  shuffleDeck,
  smallestLead,
  sortCardIds,
} from "./doudizhu-rules.js";

// 1 局：大厅不再选手数，打完一把弹「是否继续」；仍兼容旧客户端 4/8/16/24
const ROUND_OPTIONS = [1, 4, 8, 16, 24];
const EMOTES = Array.from({ length: 13 }, (_, index) => `emoji_${String(index + 1).padStart(2, "0")}`);
const PROPS = ["tomato", "egg", "cheers"];
const THEMES = ["jade", "sakura", "camp", "beach"];
const TURN_MS = 15_000;
// AI 那三个座位现在是真模型在想（见 doudizhu-model-adapter.js），15 秒不够：
// 破线就是裁判代打，那等于没接模型。所以 AI 的回合按模型放宽（各模型实测耗时
// 见 doudizhu-seat-models.js 的 THINK_MS），人的回合还是 15 秒。
// 想一刀切：DOUDIZHU_AI_TURN_MS=60000。
const AI_TURN_MS_FORCED = Number(process.env.DOUDIZHU_AI_TURN_MS) || 0;
// 接话比出牌短：一个座位只有一个会话，接话占着它的时候出牌只能排队等。
const AI_CHAT_MS = Number(process.env.DOUDIZHU_AI_CHAT_MS) || 25_000;
// 牌桌聊天字数上限。原来是 10 个字——她嫌太紧，2026-08-08 放到 40，代价是
// 模型有空间写「（笑着摸摸头）」这类动作描写了，所以 prompt 和代码各加一道闸
// （见 doudizhu-model-adapter.js 的 NO_STAGE_DIRECTIONS / stripStageDirections）。
const MAX_CHAT_CHARS = Math.max(1, Number(process.env.DOUDIZHU_MAX_CHAT_CHARS) || 40);
const RATE_LIMIT_MS = 5_000;
const MAX_FEED = 120;
const MAX_CHAT_TRANSCRIPT = 1_000;
const MAX_HISTORY = 240;
const ROSTER_IDS = ["aurex", "aevi", "vex", "juhua"];

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, max = 80) {
  return String(value || "").trim().slice(0, max);
}

function charLength(value) {
  return Array.from(String(value || "")).length;
}

function firstChars(value, max) {
  return Array.from(String(value || "")).slice(0, max).join("");
}

function isTerminalAdapterError(error) {
  const message = String(error?.message || error || "");
  return /(?:status(?: code)?\s*[:=]?\s*403|permission_error|insufficient[_ -]?quota|usage limit|billing cycle|quota (?:exhausted|exceeded)|credits? (?:exhausted|depleted))/i.test(message);
}

function compactRoundMemory(round) {
  const bids = (round?.bidHistory || []).map((entry) => `${entry.playerId}:${Number(entry.value) > 0 ? `叫${entry.value}` : "不叫"}`);
  const plays = (round?.playHistory || []).map((entry) => {
    if (entry.type === "pass") return `${entry.playerId}:过`;
    return `${entry.playerId}:${(entry.cards || []).join(",") || entry.move?.type || "出牌"}`;
  });
  const actions = [...bids, ...plays].slice(-18);
  return actions.length ? `本局最近动作：${actions.join("；")}` : "本局尚无动作。";
}

function compactChatMemory(feed) {
  const chats = (feed || [])
    .filter((item) => item.type === "chat")
    .slice(-3)
    .map((item) => `${item.playerId}${item.targetId ? `->${item.targetId}` : ""}:${cleanText(item.text, 20)}`);
  return chats.length ? `最近聊天：${chats.join("；")}` : "最近没有聊天。";
}

function recentAurexDissolveIntent(feed) {
  const recent = [...(feed || [])]
    .reverse()
    .filter((item) => item.type === "chat" && item.playerId === "aurex")
    .slice(0, 5);
  for (const item of recent) {
    const text = cleanText(item.text, 40);
    if (!text) continue;
    if (/(?:解散|先散|散了|不玩|退了|退出|停一下|先停|有事|要走|下了|睡了|困了)/u.test(text)) {
      return text;
    }
  }
  return "";
}

function compactLeadingMove(entry) {
  if (!entry) return null;
  return {
    player: entry.playerId,
    type: entry.move?.type || entry.type || "play",
    cards: Array.isArray(entry.cards) ? entry.cards : [],
  };
}

function defaultScores() {
  return {
    version: 1,
    players: Object.fromEntries(ROSTER_IDS.map((id) => [id, { score: 0, games: 0, wins: 0, losses: 0 }])),
    updatedAt: nowIso(),
  };
}

function normalizeScores(raw = {}) {
  const base = defaultScores();
  for (const id of ROSTER_IDS) {
    const item = raw?.players?.[id] || {};
    base.players[id] = {
      score: Number.isFinite(Number(item.score)) ? Number(item.score) : 0,
      games: Math.max(0, Number(item.games) || 0),
      wins: Math.max(0, Number(item.wins) || 0),
      losses: Math.max(0, Number(item.losses) || 0),
    };
  }
  base.updatedAt = raw?.updatedAt || base.updatedAt;
  return base;
}

function defaultProfiles(players) {
  return {
    version: 1,
    players: Object.fromEntries(
      players.map((player) => [
        player.id,
        {
          id: player.id,
          name: player.name,
          avatar: player.avatar,
          avatarExtension: "",
          model: defaultSeatModel(player.id),
          talkativeness: Number(player.persona?.talkativeness || 0),
          updatedAt: nowIso(),
        },
      ]),
    ),
    updatedAt: nowIso(),
  };
}

function normalizeProfiles(raw, players) {
  const base = defaultProfiles(players);
  for (const player of players) {
    const item = raw?.players?.[player.id] || {};
    base.players[player.id] = {
      id: player.id,
      name: cleanText(item.name, 18) || player.name,
      avatar: cleanText(item.avatar, 300) || player.avatar,
      avatarExtension: ["png", "jpg", "webp"].includes(item.avatarExtension) ? item.avatarExtension : "",
      // 人类座位没有模型；AI 座位认不出来就退回该座位的默认模型（见 doudizhu-seat-models.js）
      model: player.kind === "human" ? "" : normalizeSeatModel(player.id, item.model),
      talkativeness: Math.max(0, Math.min(1, Number(item.talkativeness ?? player.persona?.talkativeness ?? 0))),
      updatedAt: item.updatedAt || nowIso(),
    };
  }
  base.updatedAt = raw?.updatedAt || base.updatedAt;
  return base;
}

function defaultState() {
  return {
    version: 1,
    tableId: "aevi-family-table",
    phase: "lobby",
    theme: "jade",
    match: null,
    round: null,
    timer: null,
    dissolveVote: null,
    feed: [],
    rateLimits: { chat: {}, interaction: {} },
    updatedAt: nowIso(),
  };
}

function transcriptFromFeed(feed = [], fallbackRound = 1) {
  const items = Array.isArray(feed) ? feed : [];
  const firstRoundStart = items.find((item) => item?.type === "round_start" && Number(item.round) > 0);
  let currentRound = firstRoundStart ? Math.max(1, Number(firstRoundStart.round) - 1) : Math.max(1, Number(fallbackRound) || 1);
  const transcript = [];
  for (const item of items) {
    if (item?.type === "round_start" && Number(item.round) > 0) currentRound = Number(item.round);
    if (item?.type !== "chat") continue;
    transcript.push({
      id: item.id,
      round: Number(item.round) > 0 ? Number(item.round) : currentRound,
      playerId: item.playerId,
      playerName: item.playerName,
      text: item.text,
      at: item.at,
    });
  }
  return transcript;
}

function normalizeChatTranscript(rawTranscript, feed, fallbackRound) {
  const source = Array.isArray(rawTranscript) ? rawTranscript : transcriptFromFeed(feed, fallbackRound);
  return source
    .filter((item) => item && ROSTER_IDS.includes(item.playerId) && cleanText(item.text, 80))
    .map((item) => ({
      id: cleanText(item.id, 100) || `chat_${randomUUID()}`,
      round: Math.max(1, Number(item.round) || Number(fallbackRound) || 1),
      playerId: item.playerId,
      playerName: cleanText(item.playerName, 18),
      text: firstChars(cleanText(item.text, 200), MAX_CHAT_CHARS),
      at: cleanText(item.at, 64) || nowIso(),
    }))
    .slice(-MAX_CHAT_TRANSCRIPT);
}

function normalizeState(raw = {}) {
  raw = raw || {};
  const base = defaultState();
  const phase = ["lobby", "bid", "play", "round_end", "match_end", "dissolve_vote"].includes(raw.phase) ? raw.phase : "lobby";
  const normalized = {
    ...base,
    ...raw,
    version: 1,
    phase,
    theme: THEMES.includes(raw.theme) ? raw.theme : "jade",
    feed: Array.isArray(raw.feed) ? raw.feed.slice(-MAX_FEED) : [],
    rateLimits: raw.rateLimits && typeof raw.rateLimits === "object" ? raw.rateLimits : base.rateLimits,
    timer: null,
    updatedAt: raw.updatedAt || base.updatedAt,
  };
  if (normalized.match) {
    normalized.match = {
      ...normalized.match,
      chatTranscript: normalizeChatTranscript(raw.match?.chatTranscript, normalized.feed, normalized.match.roundNumber),
    };
  }
  return normalized;
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function scoreDeltaTemplate(playerIds = PLAYER_IDS) {
  return Object.fromEntries(playerIds.map((id) => [id, 0]));
}

function roundPublicMove(entry) {
  if (!entry) return null;
  return {
    playerId: entry.playerId,
    cards: entry.cards,
    labels: entry.labels,
    move: entry.move,
    at: entry.at,
  };
}

export class DoudizhuService {
  constructor({ rootDir = process.cwd(), dataDir = path.resolve(process.cwd(), "data/doudizhu"), adapter = null } = {}) {
    this.rootDir = rootDir;
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, "state.json");
    this.playersFile = path.join(dataDir, "players.json");
    this.profilesFile = path.join(dataDir, "profiles.json");
    this.scoresFile = path.join(dataDir, "scores.json");
    this.historyFile = path.join(dataDir, "match-history.json");
    this.avatarDir = path.join(dataDir, "avatars");
    // 三个 AI 座位默认交给真模型（每个座位一个常驻 claude 会话）。想退回本地
    // 启发式机器人：DOUDIZHU_MODEL_OFF=1。
    this.adapter = adapter || new ModelPlayerAdapter({
      debug: process.env.AEVI_BRIDGE_DEBUG === "1",
      seat: (playerId) => this.seatInfo(playerId),
      onLog: (line) => console.log(`[doudizhu] ${line}`),
    });
    this.players = defaultDoudizhuPlayers(rootDir);
    this.profiles = defaultProfiles(this.players);
    this.scores = defaultScores();
    this.state = defaultState();
    this.history = [];
    this.listeners = new Set();
    this.turnTimer = null;
    this.dissolveTimer = null;
    this.readyPromise = this.initialize();
    this.operationQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.avatarDir, { recursive: true, mode: 0o700 });
    const storedPlayers = await readJson(this.playersFile, null);
    if (storedPlayers?.players?.length) {
      const defaults = defaultDoudizhuPlayers(this.rootDir);
      this.players = defaults.map((fallback) => {
        const found = storedPlayers.players.find((item) => item.id === fallback.id) || {};
        return { ...fallback, ...found, command: Array.isArray(found.command) ? found.command : fallback.command, cwd: found.cwd || fallback.cwd };
      });
    } else {
      await atomicWriteJson(this.playersFile, { version: 1, players: this.players });
    }
    await atomicWriteJson(this.playersFile, { version: 1, players: this.players, updatedAt: nowIso() });
    this.profiles = normalizeProfiles(await readJson(this.profilesFile, null), this.players);
    this.scores = normalizeScores(await readJson(this.scoresFile, null));
    this.state = normalizeState(await readJson(this.stateFile, null));
    const history = await readJson(this.historyFile, { version: 1, matches: [] });
    this.history = Array.isArray(history?.matches) ? history.matches.slice(-100) : [];
    await Promise.all([this.saveProfiles(), this.saveScores(), this.saveState()]);
    if (["bid", "play"].includes(this.state.phase) && this.state.round && this.state.match) {
      await this.addFeed({ type: "system", text: "服务恢复，当前回合重新计时。" }, false);
      this.warmSeats();
      await this.prepareJuhuaRound();
      await this.scheduleTurn();
    } else if (this.state.phase === "dissolve_vote") {
      await this.resumeAfterFailedDissolve("服务恢复，解散投票已取消。", false);
    }
    return this;
  }

  ready() {
    return this.readyPromise;
  }

  enqueue(operation) {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.catch(() => {});
    return run;
  }

  onBroadcast(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  broadcast() {
    const snapshot = this.publicSnapshot("aurex");
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {}
    }
  }

  async saveState() {
    this.state.updatedAt = nowIso();
    await atomicWriteJson(this.stateFile, this.state);
  }

  async saveProfiles() {
    this.profiles.updatedAt = nowIso();
    await atomicWriteJson(this.profilesFile, this.profiles);
  }

  async saveScores() {
    this.scores.updatedAt = nowIso();
    await atomicWriteJson(this.scoresFile, this.scores);
  }

  async saveHistory() {
    await atomicWriteJson(this.historyFile, { version: 1, matches: this.history.slice(-100), updatedAt: nowIso() });
  }

  playerConfig(id) {
    return this.players.find((player) => player.id === id) || null;
  }

  profile(id) {
    return this.profiles.players[id] || null;
  }

  /** 交给适配器的座位信息：谁、用哪个模型、话多不多、桌上都有谁。 */
  seatInfo(playerId) {
    const profile = this.profile(playerId);
    if (!profile) return null;
    const model = process.env.DOUDIZHU_MODEL_OFF === "1" ? "" : profile.model || "";
    return {
      id: playerId,
      name: profile.name || playerId,
      model,
      talkativeness: profile.talkativeness || 0,
      roster: Object.fromEntries(
        this.activePlayerIds().map((id) => [id, this.profile(id)?.name || id]),
      ),
    };
  }

  /** 解散投票等多久：按桌上最慢的那个 AI 算。 */
  dissolveMsFor() {
    const aiIds = this.activePlayerIds().filter((id) => this.playerConfig(id)?.kind === "cmd");
    return Math.max(TURN_MS, ...aiIds.map((id) => this.turnMsFor(id)));
  }

  /** 一回合给多久：人不限时（想看多久牌就看多久），AI 按它坐的那个模型给（Fable 就是比 Sonnet 慢一截）。 */
  turnMsFor(playerId) {
    if (this.playerConfig(playerId)?.kind === "human") return Infinity;
    if (AI_TURN_MS_FORCED) return Math.max(TURN_MS, AI_TURN_MS_FORCED);
    return Math.max(TURN_MS, seatThinkMs(this.profile(playerId)?.model));
  }

  /** 开局前把上桌那两个 AI 的会话热起来，别让第一手付冷启动那 20 秒。 */
  warmSeats() {
    if (typeof this.adapter?.warm !== "function") return;
    for (const id of this.activePlayerIds()) {
      if (this.playerConfig(id)?.kind === "cmd") this.adapter.warm(id);
    }
  }

  activePlayerIds() {
    const ids = this.state.match?.playerIds;
    if (Array.isArray(ids) && ids.length === 3 && ids[0] === "aurex" && new Set(ids).size === 3 && ids.every((id) => ROSTER_IDS.includes(id))) {
      return ids;
    }
    return [...PLAYER_IDS];
  }

  matchDeltas() {
    return this.state.match?.scoreDeltas || scoreDeltaTemplate(this.activePlayerIds());
  }

  matchTranscript() {
    return (this.state.match?.chatTranscript || []).map((item) => ({
      id: item.id,
      round: item.round,
      playerId: item.playerId,
      playerName: item.playerName || this.profile(item.playerId)?.name || item.playerId,
      text: item.text,
      at: item.at,
    }));
  }

  leaderboard() {
    return ROSTER_IDS.map((id) => ({
      id,
      name: this.profile(id)?.name || id,
      avatar: this.profile(id)?.avatar || "",
      ...this.scores.players[id],
    })).sort((left, right) => right.score - left.score || right.wins - left.wins || left.name.localeCompare(right.name));
  }

  publicSnapshot(viewerId = "aurex") {
    const round = this.state.round;
    const matchDeltas = this.matchDeltas();
    const visiblePlayerIds = this.state.match ? this.activePlayerIds() : ROSTER_IDS;
    const players = visiblePlayerIds.map((id, index) => ({
      ...this.profile(id),
      kind: this.playerConfig(id)?.kind || "cmd",
      modelOptions: seatModelOptions(id),
      seatIndex: index,
      role: round?.landlordId ? (round.landlordId === id ? "landlord" : "farmer") : null,
      handCount: round?.hands?.[id]?.length || 0,
      roundScore: round?.scoreDelta?.[id] || 0,
      matchScore: matchDeltas[id] || 0,
      totalScore: this.scores.players[id]?.score || 0,
      propUses: round?.propUses?.[id] || 0,
      online: id === "aurex" ? true : true,
    }));
    const currentPlayerId = round?.currentPlayerId || null;
    const ownHand = round?.hands?.[viewerId] || [];
    const bidOptions = this.state.phase === "bid" && currentPlayerId === viewerId
      ? [0, 1, 2, 3].filter((value) => value === 0 || value > Number(round.currentBid || 0))
      : [];
    return {
      version: 1,
      tableId: this.state.tableId,
      phase: this.state.phase,
      theme: this.state.theme,
      roundOptions: ROUND_OPTIONS,
      players,
      leaderboard: this.leaderboard(),
      match: this.state.match
        ? {
            id: this.state.match.id,
            totalRounds: this.state.match.totalRounds,
            roundNumber: this.state.match.roundNumber,
            status: this.state.match.status,
            playerIds: this.activePlayerIds(),
            scoreDeltas: matchDeltas,
            createdAt: this.state.match.createdAt,
            chatTranscript: this.state.phase === "match_end" ? this.matchTranscript() : [],
          }
        : null,
      round: round
        ? {
            number: round.number,
            dealerIndex: round.dealerIndex,
            currentPlayerId,
            currentBid: round.currentBid,
            highestBidderId: round.highestBidderId,
            bidHistory: round.bidHistory || [],
            landlordId: round.landlordId,
            landlordCards: round.landlordId ? (round.landlordCards || []).map(cardPublicView) : [],
            hand: ownHand.map(cardPublicView).filter(Boolean),
            toBeat: roundPublicMove(round.leadingMove),
            lastPlayPlayerId: round.lastPlayPlayerId,
            passCount: round.passCount || 0,
            bombCount: round.bombCount || 0,
            multiplier: (round.bidScore || round.currentBid || 1) * (round.multiplier || 1),
            bidScore: round.bidScore || null,
            playHistory: (round.playHistory || []).slice(-24),
            result: round.result || null,
          }
        : null,
      controls: {
        isYourTurn: currentPlayerId === viewerId && ["bid", "play"].includes(this.state.phase),
        bidOptions,
        canPass: this.state.phase === "play" && currentPlayerId === viewerId && Boolean(round?.leadingMove),
        canStartNextRound: this.state.phase === "round_end" && Number(this.state.match?.roundNumber || 0) < Number(this.state.match?.totalRounds || 0),
        canReturnLobby: this.state.phase === "match_end",
        canDissolve: Boolean(this.state.match && !["lobby", "match_end", "dissolve_vote"].includes(this.state.phase)),
      },
      timer: this.state.timer,
      dissolveVote: this.state.dissolveVote,
      feed: this.state.feed.slice(-60),
      serverTime: Date.now(),
      updatedAt: this.state.updatedAt,
    };
  }

  async addFeed(event, persist = true) {
    this.state.feed.push({ id: `event_${randomUUID()}`, at: nowIso(), ...event });
    this.state.feed = this.state.feed.slice(-MAX_FEED);
    if (persist) await this.saveState();
  }

  clearTimers() {
    clearTimeout(this.turnTimer);
    clearTimeout(this.dissolveTimer);
    this.turnTimer = null;
    this.dissolveTimer = null;
  }

  async startMatch(totalRounds, selectedAiIds = ["aevi", "vex"]) {
    const rounds = Number(totalRounds);
    if (!ROUND_OPTIONS.includes(rounds)) throw new Error("局数只能选择 4、8、16 或 24");
    if (this.state.match && this.state.phase !== "match_end" && this.state.phase !== "lobby") throw new Error("当前牌局还没有结束");
    const aiIds = Array.isArray(selectedAiIds) ? selectedAiIds.map((id) => cleanText(id, 40)) : [];
    if (aiIds.length !== 2 || new Set(aiIds).size !== 2 || aiIds.some((id) => !["aevi", "vex", "juhua"].includes(id))) {
      throw new Error("请从名册中选择两位不同的 AI 上桌");
    }
    const playerIds = ["aurex", ...aiIds];
    this.clearTimers();
    const dealerIndex = Math.floor(Math.random() * playerIds.length);
    this.state = {
      ...defaultState(),
      theme: this.state.theme,
      match: {
        id: `match_${randomUUID()}`,
        totalRounds: rounds,
        playerIds,
        roundNumber: 1,
        initialDealerIndex: dealerIndex,
        scoreDeltas: scoreDeltaTemplate(playerIds),
        chatTranscript: [],
        status: "playing",
        createdAt: nowIso(),
      },
    };
    await this.addFeed({ type: "system", text: `${rounds} 局家庭场开桌。` }, false);
    this.warmSeats();       // 开桌就把上桌那两位的会话点起来，第一手才不用等冷启动
    await this.startRound();
  }

  async startRound() {
    if (!this.state.match) throw new Error("还没有创建比赛");
    const number = Number(this.state.match.roundNumber || 1);
    const playerIds = this.activePlayerIds();
    const dealerIndex = (Number(this.state.match.initialDealerIndex || 0) + number - 1) % playerIds.length;
    const deck = shuffleDeck(createDeck());
    const hands = Object.fromEntries(playerIds.map((id) => [id, []]));
    for (let index = 0; index < 51; index += 1) hands[playerIds[index % 3]].push(deck[index].id);
    for (const id of playerIds) hands[id] = sortCardIds(hands[id]);
    this.state.phase = "bid";
    this.state.round = {
      number,
      dealerIndex,
      hands,
      landlordCards: deck.slice(51).map((card) => card.id),
      landlordId: null,
      currentPlayerId: playerIds[dealerIndex],
      currentBid: 0,
      highestBidderId: null,
      bidScore: null,
      bidTurns: 0,
      bidHistory: [],
      playHistory: [],
      leadingMove: null,
      lastPlayPlayerId: null,
      passCount: 0,
      bombCount: 0,
      multiplier: 1,
      playsByPlayer: Object.fromEntries(playerIds.map((id) => [id, 0])),
      propUses: Object.fromEntries(playerIds.map((id) => [id, 0])),
      scoreDelta: scoreDeltaTemplate(playerIds),
      result: null,
      startedAt: nowIso(),
    };
    this.state.dissolveVote = null;
    await this.addFeed({ type: "round_start", text: `第 ${number}/${this.state.match.totalRounds} 局发牌。`, round: number }, false);
    await this.saveState();
    this.broadcast();
    this.warmSeats();       // 会话闲置会自己收摊，每局重新招呼一声
    await this.prepareJuhuaRound();
    await this.scheduleTurn();
  }

  async prepareJuhuaRound() {
    if (!this.state.match || !this.state.round || !this.activePlayerIds().includes("juhua")) return;
    const player = this.playerConfig("juhua");
    if (!player || player.kind !== "cmd") return;
    const payload = {
      phase: "prepare",
      you: "juhua",
      role: null,
      player_counts: Object.fromEntries(this.activePlayerIds().map((id) => [id, this.state.round.hands[id]?.length || 0])),
      chat_memory: compactChatMemory(this.state.feed),
      context: {
        match_id: this.state.match.id,
        round: this.state.round.number,
        total_rounds: this.state.match.totalRounds,
        score: this.state.match.scoreDeltas.juhua || 0,
      },
    };
    try {
      await this.adapter.decide(player, payload, { timeoutMs: 43_000 });
    } catch (error) {
      await this.addFeed({
        type: "adapter_error",
        playerId: "juhua",
        text: `${this.profile("juhua")?.name || "对家丙"}入桌准备稍慢，裁判会继续托管。`,
        detail: cleanText(error.message || error, 300),
      }, false);
    }
  }

  async redeal() {
    this.state.match.initialDealerIndex = (Number(this.state.match.initialDealerIndex || 0) + 1) % this.activePlayerIds().length;
    await this.addFeed({ type: "system", text: "三家都不叫，重新洗牌。" }, false);
    await this.startRound();
  }

  async scheduleTurn() {
    clearTimeout(this.turnTimer);
    this.turnTimer = null;
    if (!["bid", "play"].includes(this.state.phase) || !this.state.round?.currentPlayerId) {
      this.state.timer = null;
      await this.saveState();
      this.broadcast();
      return;
    }
    const token = randomUUID();
    const playerId = this.state.round.currentPlayerId;
    const turnMs = this.turnMsFor(playerId);
    // 人的回合不挂钟：没有 deadline，也就没有「超时裁判代打」这回事
    const unlimited = !Number.isFinite(turnMs);
    const deadlineAt = unlimited ? null : Date.now() + turnMs;
    this.state.timer = { token, phase: this.state.phase, playerId, deadlineAt, durationMs: unlimited ? null : turnMs };
    await this.saveState();
    this.broadcast();
    if (!unlimited) {
      this.turnTimer = setTimeout(() => {
        void this.enqueue(() => this.handleTurnTimeout(token));
      }, turnMs + 20);
      this.turnTimer.unref?.();
    }
    if (this.playerConfig(playerId)?.kind === "cmd") {
      setTimeout(() => void this.runAiTurn(playerId, token, deadlineAt), 0).unref?.();
    }
  }

  async handleTurnTimeout(token, reason = "超时") {
    if (this.state.timer?.token !== token || !["bid", "play"].includes(this.state.phase)) return;
    const playerId = this.state.round.currentPlayerId;
    await this.addFeed({ type: "timeout", playerId, text: `${this.profile(playerId)?.name || playerId} ${reason}，裁判代打。` }, false);
    if (this.state.phase === "bid") await this.applyBid(playerId, 0, { source: "timeout" });
    else if (this.state.round.leadingMove) await this.applyPass(playerId, { source: "timeout" });
    else await this.applyPlay(playerId, smallestLead(this.state.round.hands[playerId]), { source: "timeout" });
  }

  aiPayload(playerId, errorReason = "") {
    const round = this.state.round;
    const profile = this.profile(playerId);
    const payload = {
      phase: this.state.phase,
      you: playerId,
      role: round.landlordId ? (round.landlordId === playerId ? "landlord" : "farmer") : null,
      hand: [...(round.hands[playerId] || [])],
      landlord_cards: round.landlordId ? [...round.landlordCards] : [],
      player_counts: Object.fromEntries(this.activePlayerIds().map((id) => [id, round.hands[id].length])),
      round_memory: compactRoundMemory(round),
      to_beat: compactLeadingMove(round.leadingMove),
      legal_hint: this.state.phase === "bid" ? "只能从 bid_options 中选择，0 表示不叫。" : legalHint(round.leadingMove?.move, playerId, round.lastPlayPlayerId),
      bid_options: this.state.phase === "bid" ? [0, 1, 2, 3].filter((value) => value === 0 || value > Number(round.currentBid || 0)) : [],
      chat_memory: compactChatMemory(this.state.feed),
      your_persona: { talkativeness: profile?.talkativeness || 0 },
      context: {
        match_id: this.state.match.id,
        round: round.number,
        total_rounds: this.state.match.totalRounds,
        score: this.state.match.scoreDeltas[playerId] || 0,
        multiplier: (round.bidScore || round.currentBid || 1) * round.multiplier,
        turn_id: this.state.timer?.token || null,
      },
    };
    if (errorReason) payload.retry_error = cleanText(errorReason, 500);
    return payload;
  }

  aiChatPayload(playerId, fromId, text, errorReason = "") {
    const round = this.state.round;
    const payload = {
      phase: "chat",
      you: playerId,
      from: fromId,
      table_message: { playerId: fromId, text },
      direct_message: { playerId: fromId, targetId: null, text },
      role: round?.landlordId ? (round.landlordId === playerId ? "landlord" : "farmer") : null,
      player_counts: round?.hands
        ? Object.fromEntries(this.activePlayerIds().map((id) => [id, round.hands[id]?.length || 0]))
        : {},
      chat_memory: compactChatMemory(this.state.feed),
      context: {
        match_id: this.state.match?.id || null,
        round: this.state.match?.roundNumber || null,
        total_rounds: this.state.match?.totalRounds || null,
        score: this.state.match?.scoreDeltas?.[playerId] || 0,
      },
    };
    if (errorReason) payload.retry_error = cleanText(errorReason, 500);
    return payload;
  }

  aiInteractionPayload(playerId, event = {}, errorReason = "") {
    const round = this.state.round;
    const payload = {
      phase: "interaction",
      you: playerId,
      from: event.playerId,
      direct_interaction: {
        type: event.type,
        prop: event.prop || null,
        emote: event.emote || null,
        targetId: event.targetId || null,
        text: cleanText(event.text, 80),
      },
      role: round?.landlordId ? (round.landlordId === playerId ? "landlord" : "farmer") : null,
      player_counts: round?.hands
        ? Object.fromEntries(this.activePlayerIds().map((id) => [id, round.hands[id]?.length || 0]))
        : {},
      chat_memory: compactChatMemory(this.state.feed),
      context: {
        match_id: this.state.match?.id || null,
        round: this.state.match?.roundNumber || null,
        total_rounds: this.state.match?.totalRounds || null,
        score: this.state.match?.scoreDeltas?.[playerId] || 0,
      },
    };
    if (errorReason) payload.retry_error = cleanText(errorReason, 500);
    return payload;
  }

  async runAiChatReply(playerId, fromId, text) {
    const player = this.playerConfig(playerId);
    if (!player || player.kind !== "cmd") return;
    let response = null;
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.adapter.decide(player, this.aiChatPayload(playerId, fromId, text, lastError), { timeoutMs: AI_CHAT_MS });
        if (response.action?.type !== "chat") throw new Error("牌桌聊天必须返回 chat 动作");
        lastError = "";
        break;
      } catch (error) {
        lastError = error.message || String(error);
        response = null;
        if (isTerminalAdapterError(error)) break;
      }
    }
    await this.enqueue(async () => {
      if (!response) {
        await this.addFeed({
          type: "adapter_error",
          playerId,
          text: `${this.profile(playerId)?.name || playerId} 暂时没能回复。`,
          detail: cleanText(lastError, 300),
        });
        this.broadcast();
        return;
      }
      if (response.say) await this.applyChat(playerId, firstChars(response.say, MAX_CHAT_CHARS), { truncate: true, persist: true, skipRateLimit: true });
      if (response.prop) await this.applyProp(playerId, response.prop.type, response.prop.target, { persist: true, skipRateLimit: true, skipReaction: true }).catch(() => {});
      else if (response.emote) await this.applyEmote(playerId, response.emote, { persist: true, skipRateLimit: true }).catch(() => {});
    });
  }

  async runAiInteractionReply(playerId, event) {
    const player = this.playerConfig(playerId);
    if (!player || player.kind !== "cmd") return;
    let response = null;
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.adapter.decide(player, this.aiInteractionPayload(playerId, event, lastError), { timeoutMs: AI_CHAT_MS });
        if (!String(response.say || "").trim() && !response.emote && !response.prop) throw new Error("互动反应不能为空");
        lastError = "";
        break;
      } catch (error) {
        lastError = error.message || String(error);
        response = null;
        if (isTerminalAdapterError(error)) break;
      }
    }
    await this.enqueue(async () => {
      if (!response) {
        await this.addFeed({
          type: "adapter_error",
          playerId,
          text: `${this.profile(playerId)?.name || playerId} 暂时没接住互动。`,
          detail: cleanText(lastError, 300),
        });
        this.broadcast();
        return;
      }
      if (response.say) await this.applyChat(playerId, firstChars(response.say, MAX_CHAT_CHARS), { truncate: true, persist: true, skipRateLimit: true });
      if (response.prop) await this.applyProp(playerId, response.prop.type, response.prop.target, { persist: true, skipRateLimit: true, skipReaction: true }).catch(() => {});
      else if (response.emote) await this.applyEmote(playerId, response.emote, { persist: true, skipRateLimit: true }).catch(() => {});
    });
  }

  validateAiAction(playerId, action) {
    if (this.state.phase === "bid") {
      if (action.type === "pass") return true;
      if (action.type !== "bid") throw new Error("叫分阶段只能叫分或不叫");
      const value = Number(action.value);
      if (![0, 1, 2, 3].includes(value) || (value > 0 && value <= Number(this.state.round.currentBid || 0))) {
        throw new Error("叫分不在可选范围内");
      }
      return true;
    }
    if (this.state.phase === "play") {
      if (action.type === "pass") {
        if (!this.state.round.leadingMove) throw new Error("先手不能过");
        return true;
      }
      if (action.type !== "play") throw new Error("出牌阶段只能出牌或过");
      const ids = resolveRequestedCards(action.cards, this.state.round.hands[playerId]);
      if (!ids.length || !cardsBelongToHand(ids, this.state.round.hands[playerId])) throw new Error("所选牌不在手牌中");
      const move = classifyMove(ids);
      if (!move) throw new Error("不是合法牌型");
      if (this.state.round.leadingMove && !canBeat(move, this.state.round.leadingMove.move)) throw new Error("这手牌压不过桌面牌型");
      return true;
    }
    throw new Error("当前不是 AI 决策阶段");
  }

  async runAiTurn(playerId, token, deadlineAt) {
    const player = this.playerConfig(playerId);
    if (!player) return;
    let lastError = "";
    let response = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = deadlineAt - Date.now() - 120;
      if (remaining < 300) break;
      try {
        response = await this.adapter.decide(player, this.aiPayload(playerId, lastError), { timeoutMs: remaining });
        await this.enqueue(async () => {
          if (this.state.timer?.token !== token || this.state.round?.currentPlayerId !== playerId) throw new Error("回合已经结束");
          this.validateAiAction(playerId, response.action);
        });
        lastError = "";
        break;
      } catch (error) {
        lastError = error.message || String(error);
        response = null;
        if (isTerminalAdapterError(error)) break;
      }
    }
    if (!response) {
      await this.enqueue(async () => {
        if (this.state.timer?.token !== token) return;
        if (lastError) {
          await this.addFeed({ type: "adapter_error", playerId, text: `${this.profile(playerId)?.name || playerId} 决策失败。`, detail: cleanText(lastError, 300) });
          this.broadcast();
        }
        // 两次都没要到动作就立刻代打。AI 的回合时限放宽到 45 秒之后，干等到点
        // 就是一屏幕的空转——牌桌上看着像卡死了。
        await this.handleTurnTimeout(token, "决策失败");
      });
      return;
    }
    await this.enqueue(async () => {
      if (this.state.timer?.token !== token || this.state.round?.currentPlayerId !== playerId) return;
      await this.applyAiExtras(playerId, response);
      if (this.state.phase === "bid") {
        const value = response.action.type === "bid" ? response.action.value : 0;
        await this.applyBid(playerId, value, { source: "ai" });
      } else if (response.action.type === "play") {
        const ids = resolveRequestedCards(response.action.cards, this.state.round.hands[playerId]);
        await this.applyPlay(playerId, ids, { source: "ai" });
      } else await this.applyPass(playerId, { source: "ai" });
    });
  }

  async applyAiExtras(playerId, response) {
    if (response.say) await this.applyChat(playerId, firstChars(response.say, MAX_CHAT_CHARS), { truncate: true, persist: false }).catch(() => {});
    if (response.prop) await this.applyProp(playerId, response.prop.type, response.prop.target, { persist: false }).catch(() => {});
    else if (response.emote) await this.applyEmote(playerId, response.emote, { persist: false }).catch(() => {});
  }

  assertTurn(playerId) {
    if (!this.state.round || !["bid", "play"].includes(this.state.phase)) throw new Error("现在还不能行动");
    if (this.state.round.currentPlayerId !== playerId) throw new Error("还没轮到你");
  }

  async applyBid(playerId, rawValue, { source = "human" } = {}) {
    this.assertTurn(playerId);
    if (this.state.phase !== "bid") throw new Error("现在不是叫分阶段");
    const value = Number(rawValue || 0);
    if (![0, 1, 2, 3].includes(value)) throw new Error("叫分只能选不叫、1、2 或 3");
    if (value > 0 && value <= Number(this.state.round.currentBid || 0)) throw new Error("必须叫得比当前分更高");
    clearTimeout(this.turnTimer);
    this.state.timer = null;
    this.state.round.bidTurns += 1;
    if (value > 0) {
      this.state.round.currentBid = value;
      this.state.round.highestBidderId = playerId;
    }
    const entry = { playerId, value, text: value ? `叫 ${value} 分` : "不叫", source, at: nowIso() };
    this.state.round.bidHistory.push(entry);
    await this.addFeed({ type: "bid", ...entry }, false);
    if (value === 3) return this.finalizeLandlord();
    if (this.state.round.bidTurns >= 3) {
      if (!this.state.round.highestBidderId) return this.redeal();
      return this.finalizeLandlord();
    }
    this.state.round.currentPlayerId = nextPlayerId(playerId, this.activePlayerIds());
    await this.scheduleTurn();
  }

  async finalizeLandlord() {
    const round = this.state.round;
    round.landlordId = round.highestBidderId;
    round.bidScore = round.currentBid;
    round.hands[round.landlordId] = sortCardIds([...round.hands[round.landlordId], ...round.landlordCards]);
    round.currentPlayerId = round.landlordId;
    round.leadingMove = null;
    round.lastPlayPlayerId = null;
    round.passCount = 0;
    this.state.phase = "play";
    await this.addFeed({ type: "landlord", playerId: round.landlordId, text: `${this.profile(round.landlordId)?.name} 成为地主，底分 ${round.bidScore}。`, cards: round.landlordCards }, false);
    await this.scheduleTurn();
  }

  async applyPlay(playerId, cardIds, { source = "human" } = {}) {
    this.assertTurn(playerId);
    if (this.state.phase !== "play") throw new Error("现在不是出牌阶段");
    if (!cardsBelongToHand(cardIds, this.state.round.hands[playerId])) throw new Error("所选牌不在你的手牌中");
    const move = classifyMove(cardIds);
    if (!move) throw new Error("这不是合法牌型");
    if (this.state.round.leadingMove && !canBeat(move, this.state.round.leadingMove.move)) throw new Error("这手牌压不过桌面牌型");
    clearTimeout(this.turnTimer);
    this.state.timer = null;
    this.state.round.hands[playerId] = sortCardIds(removeCards(this.state.round.hands[playerId], cardIds));
    this.state.round.playsByPlayer[playerId] += 1;
    if (move.isBomb) {
      this.state.round.bombCount += 1;
      this.state.round.multiplier *= 2;
    }
    const entry = {
      id: `move_${randomUUID()}`,
      playerId,
      cards: [...cardIds],
      labels: labelsForCards(cardIds),
      move,
      source,
      at: nowIso(),
    };
    this.state.round.playHistory.push(entry);
    this.state.round.playHistory = this.state.round.playHistory.slice(-MAX_HISTORY);
    this.state.round.leadingMove = entry;
    this.state.round.lastPlayPlayerId = playerId;
    this.state.round.passCount = 0;
    await this.addFeed({ type: move.type === "rocket" ? "rocket" : move.type === "bomb" ? "bomb" : "play", ...entry, text: `${this.profile(playerId)?.name} 出了${move.label}。` }, false);
    if (!this.state.round.hands[playerId].length) return this.finishRound(playerId);
    this.state.round.currentPlayerId = nextPlayerId(playerId, this.activePlayerIds());
    await this.scheduleTurn();
  }

  async applyPass(playerId, { source = "human" } = {}) {
    this.assertTurn(playerId);
    if (this.state.phase !== "play") throw new Error("现在不是出牌阶段");
    if (!this.state.round.leadingMove) throw new Error("你是先手，不能过");
    clearTimeout(this.turnTimer);
    this.state.timer = null;
    this.state.round.passCount += 1;
    this.state.round.playHistory.push({ id: `pass_${randomUUID()}`, playerId, type: "pass", source, at: nowIso() });
    await this.addFeed({ type: "pass", playerId, text: `${this.profile(playerId)?.name} 过。`, source }, false);
    if (this.state.round.passCount >= 2) {
      this.state.round.currentPlayerId = this.state.round.lastPlayPlayerId;
      this.state.round.leadingMove = null;
      this.state.round.passCount = 0;
    } else {
      this.state.round.currentPlayerId = nextPlayerId(playerId, this.activePlayerIds());
    }
    await this.scheduleTurn();
  }

  async finishRound(winnerId) {
    this.clearTimers();
    this.state.timer = null;
    const round = this.state.round;
    const landlordWon = winnerId === round.landlordId;
    const playerIds = this.activePlayerIds();
    const farmers = playerIds.filter((id) => id !== round.landlordId);
    const spring = landlordWon && farmers.every((id) => Number(round.playsByPlayer[id] || 0) === 0);
    const antiSpring = !landlordWon && Number(round.playsByPlayer[round.landlordId] || 0) === 1;
    if (spring || antiSpring) round.multiplier *= 2;
    const factor = Number(round.bidScore || 1) * Number(round.multiplier || 1);
    const delta = scoreDeltaTemplate(playerIds);
    if (landlordWon) {
      delta[round.landlordId] = 2 * factor;
      for (const id of farmers) delta[id] = -factor;
    } else {
      delta[round.landlordId] = -2 * factor;
      for (const id of farmers) delta[id] = factor;
    }
    round.scoreDelta = delta;
    for (const id of playerIds) {
      this.state.match.scoreDeltas[id] += delta[id];
      this.scores.players[id].score += delta[id];
      this.scores.players[id].games += 1;
      const won = id === round.landlordId ? landlordWon : !landlordWon;
      this.scores.players[id][won ? "wins" : "losses"] += 1;
    }
    round.result = {
      winnerId,
      landlordWon,
      spring,
      antiSpring,
      bidScore: round.bidScore,
      bombCount: round.bombCount,
      multiplier: factor,
      scoreDelta: delta,
      endedAt: nowIso(),
    };
    await this.saveScores();
    const finalRound = Number(this.state.match.roundNumber) >= Number(this.state.match.totalRounds);
    this.state.phase = finalRound ? "match_end" : "round_end";
    if (finalRound) {
      this.state.match.status = "completed";
      this.state.match.endedAt = nowIso();
      this.history.push({ ...this.state.match, finalScores: { ...this.state.match.scoreDeltas } });
      await this.saveHistory();
    }
    const springText = spring ? "，春天 ×2" : antiSpring ? "，反春天 ×2" : "";
    await this.addFeed({ type: "round_end", playerId: winnerId, text: `${this.profile(winnerId)?.name} 获胜${springText}。`, result: round.result }, false);
    await this.saveState();
    this.broadcast();
  }

  async startNextRound() {
    if (this.state.phase !== "round_end" || !this.state.match) throw new Error("现在不能开始下一局");
    if (this.state.match.roundNumber >= this.state.match.totalRounds) throw new Error("整场已经结束");
    this.state.match.roundNumber += 1;
    await this.startRound();
  }

  async returnLobby() {
    // 局间（round_end / match_end）可回大厅；进行中不允许
    if (["bid", "play", "dissolve_vote"].includes(this.state.phase)) {
      throw new Error("牌局进行中不能回大厅");
    }
    const theme = this.state.theme;
    this.clearTimers();
    this.state = { ...defaultState(), theme };
    await this.saveState();
    this.broadcast();
  }

  rateLimitBucket(kind, playerId) {
    const bucket = this.state.rateLimits[kind] || (this.state.rateLimits[kind] = {});
    const lastAt = Number(bucket[playerId] || 0);
    const remaining = RATE_LIMIT_MS - (Date.now() - lastAt);
    if (remaining > 0) throw new Error(`还要等 ${Math.ceil(remaining / 1000)} 秒`);
    bucket[playerId] = Date.now();
  }

  async applyChat(playerId, rawText, { truncate = false, persist = true, skipRateLimit = false } = {}) {
    let text = String(rawText || "").trim();
    if (!text) throw new Error("消息不能为空");
    if (charLength(text) > MAX_CHAT_CHARS) {
      if (!truncate) throw new Error(`聊天最多 ${MAX_CHAT_CHARS} 个字`);
      text = firstChars(text, MAX_CHAT_CHARS);
    }
    if (!skipRateLimit) this.rateLimitBucket("chat", playerId);
    const chat = {
      id: `chat_${randomUUID()}`,
      round: Math.max(1, Number(this.state.match?.roundNumber || this.state.round?.number || 1)),
      playerId,
      playerName: this.profile(playerId)?.name || playerId,
      text,
      at: nowIso(),
    };
    if (this.state.match) {
      const transcript = Array.isArray(this.state.match.chatTranscript) ? this.state.match.chatTranscript : [];
      transcript.push(chat);
      this.state.match.chatTranscript = transcript.slice(-MAX_CHAT_TRANSCRIPT);
    }
    await this.addFeed({ ...chat, type: "chat" }, persist);
    if (persist) this.broadcast();
    if (persist && playerId === "aurex") {
      for (const target of this.activePlayerIds().filter((id) => id !== playerId && this.playerConfig(id)?.kind === "cmd")) {
        const timer = setTimeout(() => void this.runAiChatReply(target, playerId, text), 0);
        timer.unref?.();
      }
    }
  }

  async applyEmote(playerId, emote, { persist = true, skipRateLimit = false } = {}) {
    if (!EMOTES.includes(emote)) throw new Error("表情不存在");
    if (!skipRateLimit) this.rateLimitBucket("interaction", playerId);
    await this.addFeed({ type: "emote", playerId, emote, text: `${this.profile(playerId)?.name} 发了一个表情。` }, persist);
    if (persist) this.broadcast();
  }

  async applyProp(playerId, propType, targetId, { persist = true, skipRateLimit = false, skipReaction = false } = {}) {
    if (!PROPS.includes(propType)) throw new Error("道具不存在");
    if (!this.activePlayerIds().includes(targetId) || targetId === playerId) throw new Error("请选择另一位玩家");
    if (!this.state.round) throw new Error("开局后才能使用道具");
    // 道具不设冷却、不设每局次数上限（propUses 只留着计数，不再拦人）
    this.state.round.propUses[playerId] += 1;
    const labels = { tomato: "番茄", egg: "臭鸡蛋", cheers: "干杯" };
    const feedEvent = { type: "prop", playerId, targetId, prop: propType, text: `${this.profile(playerId)?.name} 向 ${this.profile(targetId)?.name} 使用了${labels[propType]}。` };
    await this.addFeed(feedEvent, persist);
    if (persist) this.broadcast();
    if (persist && !skipReaction && playerId === "aurex") {
      const target = this.playerConfig(targetId);
      if (target?.kind === "cmd") {
        const timer = setTimeout(() => void this.runAiInteractionReply(targetId, feedEvent), 0);
        timer.unref?.();
      }
    }
  }

  async setTheme(theme) {
    if (!THEMES.includes(theme)) throw new Error("桌布不存在");
    this.state.theme = theme;
    await this.saveState();
    this.broadcast();
  }

  async updateProfile(playerId, patch = {}) {
    if (!ROSTER_IDS.includes(playerId)) throw new Error("玩家不存在");
    const profile = this.profile(playerId);
    if (patch.name !== undefined) {
      const name = cleanText(patch.name, 12);
      if (!name) throw new Error("昵称不能为空");
      profile.name = name;
    }
    if (patch.model !== undefined) {
      if (this.playerConfig(playerId)?.kind === "human") throw new Error("这个座位是人，不用选模型");
      const options = seatModelOptions(playerId).map((item) => item.id);
      const model = cleanText(patch.model, 60);
      if (!options.includes(model)) throw new Error("这个座位不能选这个模型");
      profile.model = model;
    }
    if (patch.avatarDataUrl) {
      const saved = await this.saveAvatar(playerId, patch.avatarDataUrl);
      profile.avatar = saved.url;
      profile.avatarExtension = saved.extension;
    }
    profile.updatedAt = nowIso();
    await this.saveProfiles();
    await this.saveState();
    this.broadcast();
  }

  async saveAvatar(playerId, dataUrl) {
    const match = String(dataUrl || "").match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error("头像只支持 PNG、JPG 或 WebP");
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 2 * 1024 * 1024) throw new Error("头像不能超过 2MB");
    const extension = match[1] === "jpeg" ? "jpg" : match[1];
    const filePath = path.join(this.avatarDir, `${playerId}.${extension}`);
    await withFileLock(filePath, async () => {
      const tempPath = path.join(this.avatarDir, `.${playerId}.${process.pid}.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(tempPath, buffer, { mode: 0o600, flag: "wx" });
        await fs.rename(tempPath, filePath);
        await fs.chmod(filePath, 0o600);
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }
    });
    return { url: `/api/doudizhu/avatar/${playerId}?v=${Date.now()}`, extension };
  }

  async avatarFile(playerId) {
    const profile = this.profile(playerId);
    if (!profile?.avatar?.startsWith("/api/doudizhu/avatar/")) return null;
    const extensions = profile.avatarExtension ? [profile.avatarExtension] : ["png", "jpg", "webp"];
    for (const extension of extensions) {
      const filePath = path.join(this.avatarDir, `${playerId}.${extension}`);
      try {
        const data = await fs.readFile(filePath);
        return { data, type: extension === "jpg" ? "image/jpeg" : `image/${extension}` };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return null;
  }

  async requestDissolve(playerId = "aurex") {
    if (playerId !== "aurex") throw new Error("只能由本座位发起解散");
    if (!this.state.match || !["bid", "play", "round_end"].includes(this.state.phase)) throw new Error("现在不能申请解散");
    this.clearTimers();
    const resumePhase = this.state.phase;
    const token = randomUUID();
    // 投票窗口跟着桌上最慢的那个模型走：还是 15 秒的话，慢模型必然赶不上，
    // 她申请解散就永远得到一句「不同意」（本地机器人时代是瞬答，所以没这问题）。
    const voteMs = this.dissolveMsFor();
    const deadlineAt = Date.now() + voteMs;
    this.state.phase = "dissolve_vote";
    this.state.timer = null;
    this.state.dissolveVote = {
      token,
      requesterId: playerId,
      resumePhase,
      deadlineAt,
      votes: Object.fromEntries(this.activePlayerIds().map((id) => [id, id === "aurex" ? "yes" : "pending"])),
      createdAt: nowIso(),
    };
    await this.addFeed({ type: "dissolve_request", playerId, text: `${this.profile(playerId)?.name || "玩家"} 发起了解散申请。` }, false);
    await this.saveState();
    this.broadcast();
    this.dissolveTimer = setTimeout(() => {
      void this.enqueue(() => this.resumeAfterFailedDissolve(`有人未在 ${Math.round(voteMs / 1000)} 秒内同意，解散失败。`));
    }, voteMs + 30);
    this.dissolveTimer.unref?.();
    for (const id of this.activePlayerIds().filter((id) => id !== "aurex")) {
      setTimeout(() => void this.runDissolveVote(id, token, deadlineAt), 0).unref?.();
    }
  }

  dissolvePayload(playerId) {
    const hostName = this.profile("aurex")?.name || "玩家";
    const aurexDissolveIntent = recentAurexDissolveIntent(this.state.feed);
    return {
      phase: "dissolve",
      you: playerId,
      action_required: "vote_dissolve",
      request_from: "aurex",
      aurex_recent_dissolve_intent: aurexDissolveIntent || null,
      match: {
        id: this.state.match?.id,
        round: this.state.match?.roundNumber,
        total_rounds: this.state.match?.totalRounds,
        scores: this.state.match?.scoreDeltas,
      },
      prompt: aurexDissolveIntent
        ? `${hostName}刚刚说「${aurexDissolveIntent}」，现在申请解散。请你决定是否同意。`
        : `${hostName}申请解散当前比赛。你是否同意？请由你本人决定。`,
      context: { match_id: this.state.match?.id, deadline_at: this.state.dissolveVote?.deadlineAt },
    };
  }

  async runDissolveVote(playerId, token, deadlineAt) {
    const player = this.playerConfig(playerId);
    let agree = false;
    try {
      if (recentAurexDissolveIntent(this.state.feed)) {
        agree = true;
        await this.enqueue(() => this.recordDissolveVote(playerId, agree, token));
        return;
      }
      const remaining = Math.max(300, deadlineAt - Date.now() - 100);
      const response = await this.adapter.decide(player, this.dissolvePayload(playerId), { timeoutMs: remaining });
      agree = response.action.type === "vote_dissolve" && Boolean(response.action.agree);
    } catch {
      agree = false;
    }
    await this.enqueue(() => this.recordDissolveVote(playerId, agree, token));
  }

  async recordDissolveVote(playerId, agree, token) {
    const vote = this.state.dissolveVote;
    if (this.state.phase !== "dissolve_vote" || !vote || vote.token !== token || vote.votes[playerId] !== "pending") return;
    vote.votes[playerId] = agree ? "yes" : "no";
    await this.addFeed({ type: "dissolve_vote", playerId, agree, text: `${this.profile(playerId)?.name} ${agree ? "同意" : "不同意"}解散。` }, false);
    if (!agree) return this.resumeAfterFailedDissolve(`${this.profile(playerId)?.name} 不同意，解散失败。`);
    if (Object.values(vote.votes).every((value) => value === "yes")) return this.completeDissolve();
    await this.saveState();
    this.broadcast();
  }

  async resumeAfterFailedDissolve(reason, broadcast = true) {
    if (this.state.phase !== "dissolve_vote" || !this.state.dissolveVote) return;
    clearTimeout(this.dissolveTimer);
    const resumePhase = this.state.dissolveVote.resumePhase;
    this.state.dissolveVote = null;
    this.state.phase = resumePhase;
    await this.addFeed({ type: "dissolve_failed", text: reason }, false);
    if (["bid", "play"].includes(resumePhase)) await this.scheduleTurn();
    else {
      await this.saveState();
      if (broadcast) this.broadcast();
    }
  }

  async completeDissolve() {
    this.clearTimers();
    const summary = this.state.match ? { ...this.state.match, status: "dissolved", endedAt: nowIso() } : null;
    if (summary) {
      this.history.push(summary);
      await this.saveHistory();
    }
    const theme = this.state.theme;
    this.state = { ...defaultState(), theme };
    await this.addFeed({ type: "dissolved", text: "三个人全部同意，牌局已解散。" }, false);
    await this.saveState();
    this.broadcast();
  }

  async handleClientMessage(message = {}, actorId = "aurex") {
    await this.ready();
    return this.enqueue(async () => {
      const type = cleanText(message.type, 40);
      if (type === "start_match") await this.startMatch(message.totalRounds, message.aiPlayers);
      else if (type === "start_next_round") await this.startNextRound();
      else if (type === "return_lobby") await this.returnLobby();
      else if (type === "bid") await this.applyBid(actorId, message.value);
      else if (type === "play") await this.applyPlay(actorId, Array.isArray(message.cards) ? message.cards : []);
      else if (type === "pass") await this.applyPass(actorId);
      else if (type === "chat") await this.applyChat(actorId, message.text);
      else if (type === "emote") await this.applyEmote(actorId, cleanText(message.emote, 32));
      else if (type === "prop") await this.applyProp(actorId, cleanText(message.prop, 24), cleanText(message.targetId, 40));
      else if (type === "set_theme") await this.setTheme(cleanText(message.theme, 24));
      else if (type === "update_profile") await this.updateProfile(cleanText(message.playerId, 40), message);
      else if (type === "request_dissolve") await this.requestDissolve(actorId);
      else if (type === "sync") this.broadcast();
      else throw new Error("未知的牌桌操作");
      return this.publicSnapshot(actorId);
    });
  }

  /** 服务要退出了：把常驻会话（还有它们底下的 node）收掉，别留孤儿。 */
  async shutdown() {
    this.clearTimers();
    if (typeof this.adapter?.shutdown === "function") await this.adapter.shutdown();
  }

  async health() {
    await this.ready();
    return {
      ok: true,
      service: "doudizhu",
      phase: this.state.phase,
      matchId: this.state.match?.id || null,
      round: this.state.match?.roundNumber || null,
      turnMs: TURN_MS,
      players: this.players.map((player) => ({ id: player.id, kind: player.kind })),
      updatedAt: this.state.updatedAt,
    };
  }
}
