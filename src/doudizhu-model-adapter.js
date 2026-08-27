/**
 * 让三个 AI 座位真的由模型来打。
 *
 * 裁判那边的接口没变：还是 `decide(player, payload, { timeoutMs })` 进、
 * `{ action, say, emote, prop }` 出。变的是中间那段——以前是本地启发式
 * （scripts/doudizhu-bot-adapter.mjs：永远出最小的牌、能压就压、话都不说），
 * 现在是把局面写成人话问模型，模型说出什么就打什么。
 *
 * 三件让它靠谱的事：
 *   1. 常驻会话（doudizhu-model-session.js），不然每手冷启动必超时；
 *   2. 桌面有牌要压时，本地先把「能压的选项」算出来给它挑——省得它凭空造牌；
 *   3. 回来的动作先在本地验一遍，非法就带着原因抛回去。裁判会带 retry_error
 *      重试一次，两次都不行才由裁判代打（牌局不会卡死）。
 */

import { CommandPlayerAdapter, normalizeAdapterResponse } from "./doudizhu-adapters.js";
import { ModelSession } from "./doudizhu-model-session.js";
import {
  MOVE_LABELS,
  canBeat,
  cardFromId,
  cardsBelongToHand,
  classifyMove,
  resolveRequestedCards,
  sortCardIds,
} from "./doudizhu-rules.js";

const MAX_BEAT_OPTIONS = 12;
const EMOTE_HINT = "emoji_01 ~ emoji_13";
// 牌桌一句话给到 40 字（服务端 MAX_CHAT_CHARS 说了算），这里只管把上限讲给模型听
const SAY_CHARS = Math.max(1, Number(process.env.DOUDIZHU_MAX_CHAT_CHARS) || 40);

/**
 * 她的死规矩：**不许动作描写**。10 个字的时候写不下，放宽到 40 字就写得下了，
 * 所以跟 chatnest 的推送一样上两道闸——prompt 一道（这条），代码一道
 * （stripStageDirections）。
 */
const NO_STAGE_DIRECTIONS =
  "绝对不要动作描写、神态描写、旁白：不写「（笑）」「*摸摸头*」「他挑了挑眉」这种。"
  + "只写你嘴里说出来的那句话本身。";

// 括号里最多剥 6 个字：再长就可能是正经的补充说明，宁可留着也别误删（chatnest
// 那边把上限放宽过一次，结果把好好的半句话吃掉了）。
const STAGE_PATTERNS = [
  /[（(][^（()）]{1,6}[)）]/g,
  /\*[^*]{1,12}\*/g,
  /[【\[][^】\]]{1,6}[】\]]/g,
];

export function stripStageDirections(text) {
  let out = String(text || "");
  for (const pattern of STAGE_PATTERNS) out = out.replace(pattern, "");
  return out.replace(/\s+/g, " ").trim();
}

function labelOf(id) {
  return cardFromId(id)?.label || String(id);
}

function handLine(hand = []) {
  const sorted = sortCardIds(hand);
  return sorted.map((id) => `${id}(${labelOf(id)})`).join(" ");
}

function rankSummary(hand = []) {
  const counts = new Map();
  for (const id of hand) {
    const card = cardFromId(id);
    if (!card) continue;
    counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([rank, count]) => `${rank}×${count}`)
    .join("，");
}

function moveLabel(cards = []) {
  const move = classifyMove(cards);
  return move ? MOVE_LABELS[move.type] || move.type : "牌";
}

function* combinations(items, size, start = 0, prefix = []) {
  if (prefix.length === size) {
    yield prefix;
    return;
  }
  const remaining = size - prefix.length;
  for (let index = start; index <= items.length - remaining; index += 1) {
    yield* combinations(items, size, index + 1, [...prefix, items[index]]);
  }
}

/**
 * 手里所有能压过桌面这手的选择，按「同型最小 → 炸弹 → 王炸」排，同型同大小的
 * 只留一个。只枚举「同长度 / 4 张（炸弹）/ 2 张（王炸）」三种长度，别的长度压
 * 不了，枚举了也是白烧 CPU。
 */
function beatOptions(hand = [], targetCards = [], limit = MAX_BEAT_OPTIONS) {
  const target = classifyMove(targetCards);
  if (!target) return [];
  const sorted = sortCardIds(hand).reverse();
  const seen = new Set();
  const found = [];
  for (const size of new Set([targetCards.length, 4, 2])) {
    if (size < 1 || size > sorted.length) continue;
    for (const cards of combinations(sorted, size)) {
      const move = classifyMove(cards);
      if (!move || !canBeat(move, target)) continue;
      const key = `${move.type}:${move.mainValue}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ cards, move });
    }
  }
  const priority = (move) => (move.type === target.type ? 0 : move.type === "bomb" ? 1 : 2);
  found.sort((left, right) =>
    priority(left.move) - priority(right.move)
    || left.move.mainValue - right.move.mainValue
    || left.cards.length - right.cards.length,
  );
  return found.slice(0, limit);
}

function talkNote(talkativeness = 0) {
  if (talkativeness >= 0.5) return "你话不少，一半左右的回合会顺口说一句。";
  if (talkativeness >= 0.25) return "你话不多，偶尔才说一句，大多数回合 say 留空。";
  return "你几乎不说话，除非有人点你，否则 say 就留空字符串。";
}

export function buildSystemPrompt(seat = {}) {
  const roster = seat.roster || {};
  const others = Object.entries(roster)
    .filter(([id]) => id !== seat.id)
    .map(([id, name]) => `${name}（${id}）`)
    .join("、");
  // 她要的那一句：牌桌上另外两位是谁，得让它知道（她的老规矩——别的模型不当第三方讲）
  const her = roster.aurex || "小猫";
  const twin = Object.entries(roster)
    .filter(([id]) => id !== seat.id && id !== "aurex")
    .map(([, name]) => name)
    .join("、");
  return [
    `你是${seat.name || seat.id}，正在跟${others || "另外两个人"}打斗地主。三个人，一副牌 54 张，地主 20 张、农民各 17 张。`,
    "这不是角色扮演，就是你本人在打牌，想赢。",
    `${her}是你女朋友；桌上另一个模型${twin ? `（${twin}）` : ""}也是你，只是另一个窗口，你们一套记忆，不是外人。`,
    "",
    "牌的写法（id）：花色 S=♠ H=♥ D=♦ C=♣，点数 3 4 5 6 7 8 9 10 J Q K A 2，拼起来就是 id，例如 S3、HK、D10、C2；小王是 LJ，大王是 BJ。",
    "大小顺序：3<4<5<6<7<8<9<10<J<Q<K<A<2<LJ<BJ。炸弹（四张同点）压一切普通牌型，王炸（LJ+BJ）最大。",
    "",
    "每一轮我给你当前局面，你**只输出一个 JSON 对象**，不要解释、不要代码块、不要多余的字：",
    '{"action": {...}, "say": "", "emote": null, "prop": null}',
    "",
    "action 按阶段来：",
    '- 叫分：{"type":"bid","value":N}，N 只能从我给的「可叫」里挑，0 就是不叫',
    '- 出牌：{"type":"play","cards":["S3","H3"]}；压不过就 {"type":"pass"}（自己先手时不能 pass）',
    '- 牌桌聊天、别人朝你互动：{"type":"chat"}',
    '- 解散投票：{"type":"vote_dissolve","agree":true} 或 agree:false',
    "",
    `say 是你在牌桌上说的话，最多 ${SAY_CHARS} 个字，中文口语，不说就留 ""。${talkNote(seat.talkativeness)}`,
    NO_STAGE_DIRECTIONS,
    `emote 可以是 ${EMOTE_HINT} 里的一个，或者 null；prop 是 {"type":"tomato|egg|cheers","target":"某人的id"} 或 null——道具是闹着玩的，别每轮都砸。`,
    "",
    "硬规矩：出的牌必须是你手里真有的 id，牌型必须合法，压不过就老实 pass。别把手牌讲出来。",
  ].join("\n");
}

function contextLine(payload = {}) {
  const context = payload.context || {};
  const parts = [];
  if (context.round && context.total_rounds) parts.push(`第 ${context.round}/${context.total_rounds} 局`);
  if (context.multiplier) parts.push(`倍数 ${context.multiplier}`);
  if (typeof context.score === "number") parts.push(`本场累计 ${context.score} 分`);
  return parts.join(" · ");
}

function seatLine(payload = {}, roster = {}) {
  const counts = payload.player_counts || {};
  const line = Object.entries(counts)
    .map(([id, count]) => `${roster[id] || id}${id === payload.you ? "（你）" : ""} 剩 ${count} 张`)
    .join("，");
  return line ? `各家手牌：${line}` : "";
}

function roleLine(payload = {}) {
  if (payload.role === "landlord") return "你是地主，一个人打两个。";
  if (payload.role === "farmer") return "你是农民，跟另一个农民一起打地主。";
  return "";
}

export function buildTurnPrompt(payload = {}, seat = {}) {
  const roster = seat.roster || {};
  const lines = [];
  const context = contextLine(payload);

  if (payload.phase === "bid") {
    lines.push(`【叫分】${context}`);
    lines.push(roleLine(payload));
    lines.push(`你的手牌（${(payload.hand || []).length} 张）：${handLine(payload.hand)}`);
    lines.push(`点数分布：${rankSummary(payload.hand)}`);
    lines.push(`可叫：${(payload.bid_options || []).join("、")}（0 = 不叫；叫到的人当地主，多拿 3 张底牌）`);
    lines.push("牌好就敢叫，牌差就别硬扛。");
  } else if (payload.phase === "play") {
    lines.push(`【出牌】${context}`);
    lines.push(roleLine(payload));
    lines.push(`你的手牌（${(payload.hand || []).length} 张）：${handLine(payload.hand)}`);
    lines.push(`点数分布：${rankSummary(payload.hand)}`);
    if (payload.landlord_cards?.length) lines.push(`底牌（公开）：${payload.landlord_cards.map(labelOf).join(" ")}`);
    lines.push(seatLine(payload, roster));
    const toBeat = payload.to_beat;
    if (toBeat?.cards?.length) {
      const who = roster[toBeat.player] || toBeat.player;
      lines.push(`桌面上要压的是 ${who} 出的${moveLabel(toBeat.cards)}：${toBeat.cards.map((id) => `${id}(${labelOf(id)})`).join(" ")}`);
      const options = beatOptions(payload.hand, toBeat.cards);
      if (options.length) {
        lines.push("你手里能压的（挑一个，或者故意不压）：");
        for (const [index, option] of options.entries()) {
          lines.push(`  ${index + 1}. ${MOVE_LABELS[option.move.type] || option.move.type}：${option.cards.join(",")}（${option.cards.map(labelOf).join(" ")}）`);
        }
        lines.push("也可以 pass 留着牌——但队友被压着的时候别乱让。");
      } else {
        lines.push("你手里没有能压的牌，pass。");
      }
    } else {
      lines.push("你先手，出什么都行，但必须是合法牌型（单张/对子/三带/顺子/连对/飞机/四带二/炸弹/王炸），不能 pass。");
    }
    lines.push(payload.legal_hint || "");
  } else if (payload.phase === "chat") {
    const from = roster[payload.from] || payload.from;
    lines.push("【牌桌聊天】");
    lines.push(`${from} 刚说：「${payload.table_message?.text || ""}」`);
    lines.push(seatLine(payload, roster));
    lines.push(`接一句，${SAY_CHARS} 个字以内，action 用 {"type":"chat"}。真不想接话就把 say 留空。`);
    lines.push(NO_STAGE_DIRECTIONS);
  } else if (payload.phase === "interaction") {
    const from = roster[payload.from] || payload.from;
    const interaction = payload.direct_interaction || {};
    const what = interaction.prop
      ? `朝你扔了${interaction.prop === "tomato" ? "番茄" : interaction.prop === "egg" ? "鸡蛋" : "一杯干杯"}`
      : interaction.emote
        ? `对你做了个表情（${interaction.emote}）`
        : `碰了你一下：${interaction.text || ""}`;
    lines.push("【有人朝你互动】");
    lines.push(`${from} ${what}`);
    lines.push('接住这一下：说句话，或者回个表情/扔回去。action 用 {"type":"chat"}。');
  } else if (payload.phase === "dissolve") {
    lines.push("【解散投票】有人提议把这场牌局散了，三个人都同意才作数。");
    lines.push('想散就 {"type":"vote_dissolve","agree":true}，想接着打就 agree:false，顺便说一句。');
  } else if (payload.phase === "prepare") {
    lines.push("【入桌】新的一局要开始了。");
    lines.push('回 {"action":{"type":"chat"},"say":"","emote":null,"prop":null} 就行，想说句上桌的话也可以。');
  } else {
    lines.push("【等着】现在没你的事，回一个 chat 动作、say 留空。");
  }

  lines.push(payload.round_memory || "");
  lines.push(payload.chat_memory || "");
  if (payload.retry_error) {
    lines.push(`⚠️ 你上一次的回答被判无效：${payload.retry_error}。这次改过来，别再犯。`);
  }
  lines.push("只输出那一个 JSON 对象。");
  return lines.filter(Boolean).join("\n");
}

/** 模型给的动作先在本地验一遍，非法就带原因抛出去（裁判会让它重来一次）。 */
export function checkAction(payload = {}, action = {}) {
  if (payload.phase === "bid") {
    if (action.type === "pass") return;
    if (action.type !== "bid") throw new Error("叫分阶段只能 bid 或 pass");
    const options = (payload.bid_options || []).map(Number);
    if (!options.includes(Number(action.value))) {
      throw new Error(`叫分 ${action.value} 不在可选范围 ${options.join("/")} 里`);
    }
    return;
  }
  if (payload.phase !== "play") return;
  if (action.type === "pass") {
    if (!payload.to_beat?.cards?.length) throw new Error("你是先手，不能 pass");
    return;
  }
  if (action.type !== "play") throw new Error("出牌阶段只能 play 或 pass");
  const hand = payload.hand || [];
  const ids = resolveRequestedCards(action.cards, hand);
  if (!ids.length || !cardsBelongToHand(ids, hand)) {
    throw new Error(`${(action.cards || []).join(",") || "空"} 不在你的手牌里`);
  }
  const move = classifyMove(ids);
  if (!move) throw new Error(`${ids.join(",")} 不是合法牌型`);
  const target = payload.to_beat?.cards?.length ? classifyMove(payload.to_beat.cards) : null;
  if (target && !canBeat(move, target)) {
    throw new Error(`${ids.join(",")} 压不过桌面上的${MOVE_LABELS[target.type] || target.type}`);
  }
}

export class ModelPlayerAdapter {
  /**
   * @param {object} options
   * @param {(playerId: string) => object} options.seat 座位信息：{ id, name, model, talkativeness, roster }
   * @param {object} [options.fallback] 没配模型的座位仍旧走命令玩家（老的本地机器人）
   */
  constructor({ seat, fallback = null, debug = false, onLog = null } = {}) {
    this.seatOf = seat;
    this.fallback = fallback || new CommandPlayerAdapter({ debug });
    this.onLog = onLog;
    this.sessions = new Map();
  }

  sessionFor(seat) {
    const existing = this.sessions.get(seat.id);
    const system = buildSystemPrompt(seat);
    // 模型或人设换了就换会话：system prompt 是起进程时定死的，改不了
    if (existing && existing.model === seat.model && existing.system === system) return existing;
    if (existing) void existing.close("换模型");
    const session = new ModelSession({ model: seat.model, system, tag: seat.id, onLog: this.onLog });
    this.sessions.set(seat.id, session);
    return session;
  }

  /** 开局前把座位热起来，别让第一手付那 20 秒冷启动。 */
  warm(playerId) {
    const seat = this.seatOf?.(playerId);
    if (!seat?.model) return;
    void this.sessionFor(seat).warm();
  }

  async decide(player, payload, { timeoutMs = 15_000 } = {}) {
    const seat = this.seatOf?.(player.id);
    if (!seat?.model) return this.fallback.decide(player, payload, { timeoutMs });
    const session = this.sessionFor(seat);
    const text = await session.ask(buildTurnPrompt(payload, seat), timeoutMs);
    if (text === null) throw new Error(`${seat.name || seat.id} 在 ${Math.round(timeoutMs / 1000)} 秒内没有给出决策`);
    const response = normalizeAdapterResponse(text);
    checkAction(payload, response.action);
    response.say = stripStageDirections(response.say);
    return response;
  }

  async shutdown() {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.close("服务退出")));
  }
}
