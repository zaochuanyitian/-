import { randomInt } from "node:crypto";

export const PLAYER_IDS = ["aurex", "aevi", "vex"];
export const RANKS = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];
export const SUITS = ["S", "H", "D", "C"];
export const SUIT_SYMBOLS = { S: "♠", H: "♥", D: "♦", C: "♣" };
export const RANK_VALUES = Object.fromEntries(RANKS.map((rank, index) => [rank, index + 3]));
export const MOVE_LABELS = {
  single: "单张",
  pair: "对子",
  triple: "三张",
  triple_single: "三带一",
  triple_pair: "三带一对",
  straight: "顺子",
  pair_straight: "连对",
  plane: "飞机",
  plane_single: "飞机带单",
  plane_pair: "飞机带对",
  four_two: "四带二",
  four_two_pairs: "四带两对",
  bomb: "炸弹",
  rocket: "王炸",
};

export function cardFromId(id) {
  const text = String(id || "");
  if (text === "LJ") return { id: "LJ", suit: "J", rank: "小王", value: 16, label: "小王" };
  if (text === "BJ") return { id: "BJ", suit: "J", rank: "大王", value: 17, label: "大王" };
  const suit = text.slice(0, 1);
  const rank = text.slice(1);
  if (!SUITS.includes(suit) || !Object.hasOwn(RANK_VALUES, rank)) return null;
  return { id: text, suit, rank, value: RANK_VALUES[rank], label: `${SUIT_SYMBOLS[suit]}${rank}` };
}

export function createDeck() {
  const deck = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) deck.push(cardFromId(`${suit}${rank}`));
  }
  deck.push(cardFromId("LJ"), cardFromId("BJ"));
  return deck;
}

export function shuffleDeck(deck = createDeck(), rng = randomInt) {
  const next = deck.map((card) => ({ ...card }));
  for (let index = next.length - 1; index > 0; index -= 1) {
    const other = rng(index + 1);
    [next[index], next[other]] = [next[other], next[index]];
  }
  return next;
}

export function sortCardIds(ids = []) {
  return [...ids].sort((leftId, rightId) => {
    const left = cardFromId(leftId);
    const right = cardFromId(rightId);
    if (!left || !right) return String(leftId).localeCompare(String(rightId));
    if (left.value !== right.value) return right.value - left.value;
    return SUITS.indexOf(left.suit) - SUITS.indexOf(right.suit);
  });
}

function countsForCards(cards) {
  const counts = new Map();
  for (const card of cards) counts.set(card.value, (counts.get(card.value) || 0) + 1);
  return counts;
}

function consecutive(values) {
  if (!values.length || values[values.length - 1] > 14) return false;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] !== values[index - 1] + 1) return false;
  }
  return true;
}

function move(type, size, mainValue, extra = {}) {
  return {
    type,
    label: MOVE_LABELS[type],
    size,
    mainValue,
    sequenceLength: extra.sequenceLength || 1,
    wingType: extra.wingType || "none",
    isBomb: type === "bomb" || type === "rocket",
    isRocket: type === "rocket",
  };
}

function planeMove(cards, counts) {
  const size = cards.length;
  const tripleValues = [...counts.entries()]
    .filter(([value, count]) => value <= 14 && count >= 3)
    .map(([value]) => value)
    .sort((a, b) => a - b);
  if (tripleValues.length < 2) return null;

  const possibleCoreLengths = [];
  if (size % 3 === 0) possibleCoreLengths.push({ length: size / 3, type: "plane", wingType: "none" });
  if (size % 4 === 0) possibleCoreLengths.push({ length: size / 4, type: "plane_single", wingType: "single" });
  if (size % 5 === 0) possibleCoreLengths.push({ length: size / 5, type: "plane_pair", wingType: "pair" });

  for (const candidate of possibleCoreLengths.sort((a, b) => b.length - a.length)) {
    const coreLength = candidate.length;
    if (!Number.isInteger(coreLength) || coreLength < 2 || tripleValues.length < coreLength) continue;
    for (let start = 0; start <= tripleValues.length - coreLength; start += 1) {
      const core = tripleValues.slice(start, start + coreLength);
      if (!consecutive(core)) continue;
      const remaining = new Map(counts);
      let valid = true;
      for (const value of core) {
        const original = remaining.get(value) || 0;
        if (original !== 3) {
          valid = false;
          break;
        }
        remaining.delete(value);
      }
      if (!valid) continue;
      const restCounts = [...remaining.values()];
      const restSize = restCounts.reduce((sum, count) => sum + count, 0);
      if (candidate.wingType === "none" && restSize === 0) {
        return move(candidate.type, size, core.at(-1), { sequenceLength: coreLength });
      }
      if (candidate.wingType === "single" && restSize === coreLength) {
        return move(candidate.type, size, core.at(-1), { sequenceLength: coreLength, wingType: "single" });
      }
      if (
        candidate.wingType === "pair" &&
        restSize === coreLength * 2 &&
        restCounts.length === coreLength &&
        restCounts.every((count) => count === 2)
      ) {
        return move(candidate.type, size, core.at(-1), { sequenceLength: coreLength, wingType: "pair" });
      }
    }
  }
  return null;
}

export function classifyMove(cardIds = []) {
  if (!Array.isArray(cardIds) || !cardIds.length || new Set(cardIds).size !== cardIds.length) return null;
  const cards = cardIds.map(cardFromId);
  if (cards.some((card) => !card)) return null;
  const size = cards.length;
  const counts = countsForCards(cards);
  const entries = [...counts.entries()].sort((a, b) => a[0] - b[0]);
  const values = entries.map(([value]) => value);
  const countPattern = entries.map(([, count]) => count).sort((a, b) => b - a);

  if (size === 2 && values.length === 2 && values[0] === 16 && values[1] === 17) return move("rocket", size, 17);
  if (values.length === 1) {
    if (size === 1) return move("single", size, values[0]);
    if (size === 2) return move("pair", size, values[0]);
    if (size === 3) return move("triple", size, values[0]);
    if (size === 4) return move("bomb", size, values[0]);
  }
  if (size === 4 && countPattern[0] === 3 && countPattern[1] === 1) {
    const mainValue = entries.find(([, count]) => count === 3)[0];
    return move("triple_single", size, mainValue, { wingType: "single" });
  }
  if (size === 5 && countPattern[0] === 3 && countPattern[1] === 2) {
    const mainValue = entries.find(([, count]) => count === 3)[0];
    return move("triple_pair", size, mainValue, { wingType: "pair" });
  }
  if (size >= 5 && entries.every(([, count]) => count === 1) && consecutive(values)) {
    return move("straight", size, values.at(-1), { sequenceLength: size });
  }
  if (size >= 6 && size % 2 === 0 && entries.length >= 3 && entries.every(([, count]) => count === 2) && consecutive(values)) {
    return move("pair_straight", size, values.at(-1), { sequenceLength: entries.length });
  }

  const plane = planeMove(cards, counts);
  if (plane) return plane;

  if (size === 6) {
    const four = entries.filter(([, count]) => count === 4);
    if (four.length === 1) return move("four_two", size, four[0][0], { wingType: "single" });
  }
  if (size === 8) {
    const four = entries.filter(([, count]) => count === 4);
    const pairs = entries.filter(([, count]) => count === 2);
    if (four.length === 1 && pairs.length === 2) return move("four_two_pairs", size, four[0][0], { wingType: "pair" });
  }
  return null;
}

export function canBeat(candidate, target) {
  if (!candidate || !target) return false;
  if (candidate.type === "rocket") return target.type !== "rocket";
  if (target.type === "rocket") return false;
  if (candidate.type === "bomb" && target.type !== "bomb") return true;
  if (target.type === "bomb" && candidate.type !== "bomb") return false;
  if (candidate.type !== target.type) return false;
  if (candidate.size !== target.size || candidate.sequenceLength !== target.sequenceLength) return false;
  return candidate.mainValue > target.mainValue;
}

export function cardsBelongToHand(cardIds = [], handIds = []) {
  const hand = new Set(handIds);
  return cardIds.length > 0 && new Set(cardIds).size === cardIds.length && cardIds.every((id) => hand.has(id));
}

export function removeCards(handIds = [], cardIds = []) {
  const removing = new Set(cardIds);
  return handIds.filter((id) => !removing.has(id));
}

export function smallestLead(handIds = []) {
  const cards = handIds.map(cardFromId).filter(Boolean).sort((left, right) => left.value - right.value || SUITS.indexOf(left.suit) - SUITS.indexOf(right.suit));
  return cards.length ? [cards[0].id] : [];
}

export function labelsForCards(cardIds = []) {
  return cardIds.map((id) => cardFromId(id)?.label || id);
}

export function resolveRequestedCards(requested = [], handIds = []) {
  const tokens = Array.isArray(requested) ? requested.map((value) => String(value || "").trim()).filter(Boolean) : [];
  const hand = handIds.map(cardFromId).filter(Boolean);
  const used = new Set();
  const resolved = [];
  for (const token of tokens) {
    let card = hand.find((item) => item.id === token && !used.has(item.id));
    if (!card) card = hand.find((item) => item.label === token && !used.has(item.id));
    if (!card) return [];
    used.add(card.id);
    resolved.push(card.id);
  }
  return resolved;
}

export function legalHint(targetMove, playerId, lastPlayPlayerId) {
  if (!targetMove || playerId === lastPlayPlayerId) return "你先手：必须出一个合法牌型，不能过。";
  return `必须出能压过${targetMove.label}的同型同长度牌、炸弹或王炸；也可以过。`;
}

export function nextPlayerId(playerId, players = PLAYER_IDS) {
  const index = players.indexOf(playerId);
  return players[(index + 1 + players.length) % players.length];
}

export function cardPublicView(id) {
  const card = cardFromId(id);
  return card ? { id: card.id, rank: card.rank, suit: card.suit, value: card.value, label: card.label } : null;
}
