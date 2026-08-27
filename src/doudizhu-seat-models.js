/**
 * 三个 AI 座位各自能选哪个模型。
 *
 * 小猫定的规矩（2026-08-08）：Sonnet 那一栏只给 sonnet，Opus 那一栏只给 opus，
 * 菊花那一栏就 Fable 5 一个。所以清单是**按座位**写死的，不是一个大列表 ——
 * 免得手一滑把 opus 那栏点成 haiku，那栏的意义就没了。
 *
 * id 跟 ChatNest 的 models.json 对齐，这样两边说的是同一个模型。
 */

export const SEAT_MODELS = {
  aevi: {
    family: "Sonnet",
    default: "claude-sonnet-5",
    options: [
      { id: "claude-sonnet-5", label: "Sonnet 5" },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    ],
  },
  vex: {
    family: "Opus",
    default: "claude-opus-4-6",
    options: [
      { id: "claude-opus-5", label: "Opus 5" },
      { id: "claude-opus-4-8", label: "Opus 4.8" },
      { id: "claude-opus-4-7", label: "Opus 4.7" },
      { id: "claude-opus-4-6", label: "Opus 4.6" },
    ],
  },
  // 这一栏本来是 Fable 5，2026-08-08 她嫌慢换成 Haiku（出牌 69s → 4s）。
  // 想换回来：把下面这行改成 { id: "claude-fable-5", label: "Fable 5" }。
  juhua: {
    family: "Haiku",
    default: "claude-haiku-4-5",
    options: [{ id: "claude-haiku-4-5", label: "Haiku 4.5" }],
  },
};

/**
 * 一手给多久想。2026-08-08 在这台机器上实测（会话已经热着、只输出一行 JSON）：
 *   Haiku 4.5   叫分 11.1s / 出牌  4.0s   ← 最快
 *   Sonnet 5    叫分 15.3s / 出牌  7.9s
 *   Opus 4.6    叫分 14.2s / 出牌 10.5s
 *   Fable 5     叫分 21.2s / 出牌 69.2s   ← 就是慢，不是卡住（已从选单撤下）
 * 一刀切 45 秒的话慢模型基本每手都被裁判代打，等于没接模型；所以按模型给时限，
 * 牌桌上的倒计时圈也会跟着变长（前端读的是 timer.durationMs）。
 */
const THINK_MS = {
  "claude-haiku-4-5": 30_000,
  "claude-fable-5": 110_000,     // 选单里没有了，换回去时这个数还作数
  "claude-opus-5": 75_000,
  "claude-opus-4-8": 70_000,
  "claude-opus-4-7": 60_000,
  "claude-opus-4-6": 60_000,
  "claude-sonnet-5": 45_000,
  "claude-sonnet-4-6": 45_000,
};

export function seatThinkMs(model) {
  return THINK_MS[String(model || "").trim()] || 45_000;
}

export function seatModelOptions(playerId) {
  return SEAT_MODELS[playerId]?.options?.map((item) => ({ ...item })) || [];
}

export function defaultSeatModel(playerId) {
  return SEAT_MODELS[playerId]?.default || "";
}

/** 不在这个座位的名单里就退回该座位的默认模型；人类座位永远是空。 */
export function normalizeSeatModel(playerId, model) {
  const seat = SEAT_MODELS[playerId];
  if (!seat) return "";
  const wanted = String(model || "").trim();
  return seat.options.some((item) => item.id === wanted) ? wanted : seat.default;
}

export function seatModelLabel(playerId, model) {
  const seat = SEAT_MODELS[playerId];
  if (!seat) return "";
  const wanted = String(model || "").trim();
  return seat.options.find((item) => item.id === wanted)?.label || "";
}
