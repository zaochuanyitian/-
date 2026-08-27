#!/usr/bin/env node
import { canBeat, classifyMove, sortCardIds } from "../src/doudizhu-rules.js";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

let payload;
try {
  payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
} catch {
  process.stderr.write("输入不是合法 JSON\n");
  process.exit(2);
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
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

function movePriority(move, target) {
  if (move.type === target.type) return 0;
  if (move.type === "bomb") return 1;
  if (move.type === "rocket") return 2;
  return 3;
}

function smallestResponse(hand, targetCards) {
  const target = classifyMove(targetCards || []);
  if (!target) return null;
  const sorted = sortCardIds(hand).reverse();
  const sizes = new Set([targetCards.length, 4, 2]);
  const candidates = [];
  for (const size of sizes) {
    if (size < 1 || size > sorted.length) continue;
    for (const cards of combinations(sorted, size)) {
      const move = classifyMove(cards);
      if (move && canBeat(move, target)) candidates.push({ cards, move });
    }
  }
  candidates.sort((left, right) =>
    movePriority(left.move, target) - movePriority(right.move, target)
    || left.move.mainValue - right.move.mainValue
    || left.cards.length - right.cards.length,
  );
  return candidates[0]?.cards || null;
}

if (["prepare", "chat"].includes(payload.phase)) {
  output({ action: { type: "chat" }, say: payload.phase === "prepare" ? "在" : "", emote: null, prop: null });
} else if (payload.phase === "interaction") {
  output({ action: { type: "chat" }, say: "收到", emote: "emoji_01", prop: null });
} else if (payload.phase === "dissolve") {
  output({ action: { type: "vote_dissolve", agree: true }, say: "", emote: null, prop: null });
} else if (payload.phase === "bid") {
  const options = Array.isArray(payload.bid_options) ? payload.bid_options.map(Number) : [0];
  const positive = options.filter((value) => value > 0).sort((a, b) => a - b);
  output({ action: { type: "bid", value: positive[0] || 0 }, say: "", emote: null, prop: null });
} else if (payload.phase === "play") {
  const hand = Array.isArray(payload.hand) ? payload.hand : [];
  const targetCards = Array.isArray(payload.to_beat?.cards) ? payload.to_beat.cards : [];
  if (!targetCards.length) {
    const card = sortCardIds(hand).at(-1);
    output({ action: { type: "play", cards: card ? [card] : [] }, say: "", emote: null, prop: null });
  } else {
    const cards = smallestResponse(hand, targetCards);
    output(cards
      ? { action: { type: "play", cards }, say: "", emote: null, prop: null }
      : { action: { type: "pass" }, say: "要不起", emote: null, prop: null });
  }
} else {
  output({ action: { type: "chat" }, say: "", emote: null, prop: null });
}
