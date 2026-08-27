#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  canBeat,
  cardsBelongToHand,
  classifyMove,
  createDeck,
  nextPlayerId,
  removeCards,
  resolveRequestedCards,
  shuffleDeck,
  smallestLead,
  sortCardIds,
} from "../src/doudizhu-rules.js";

function expectType(cards, type, mainValue = null) {
  const result = classifyMove(cards);
  assert.ok(result, `${cards.join(" ")} 应当是合法牌型`);
  assert.equal(result.type, type, `${cards.join(" ")} 牌型不符`);
  if (mainValue !== null) assert.equal(result.mainValue, mainValue);
  return result;
}

function expectInvalid(cards) {
  assert.equal(classifyMove(cards), null, `${cards.join(" ")} 不应是合法牌型`);
}

const deck = createDeck();
assert.equal(deck.length, 54);
assert.equal(new Set(deck.map((card) => card.id)).size, 54);
const deterministic = shuffleDeck(deck, (max) => max - 1);
assert.deepEqual(deterministic.map((card) => card.id), deck.map((card) => card.id));

expectType(["S3"], "single", 3);
expectType(["S3", "H3"], "pair", 3);
expectType(["S3", "H3", "D3"], "triple", 3);
expectType(["S3", "H3", "D3", "C3"], "bomb", 3);
expectType(["LJ", "BJ"], "rocket", 17);
expectType(["S3", "H3", "D3", "S4"], "triple_single", 3);
expectType(["S3", "H3", "D3", "S4", "H4"], "triple_pair", 3);
expectType(["S3", "H4", "D5", "C6", "S7"], "straight", 7);
expectType(["S10", "HJ", "DQ", "CK", "SA"], "straight", 14);
expectType(["S3", "H3", "S4", "H4", "S5", "H5"], "pair_straight", 5);
expectType(["S3", "H3", "D3", "S4", "H4", "D4"], "plane", 4);
expectType(["S3", "H3", "D3", "S4", "H4", "D4", "S7", "H8"], "plane_single", 4);
expectType(["S3", "H3", "D3", "S4", "H4", "D4", "S7", "H7", "S8", "H8"], "plane_pair", 4);
expectType(["S6", "H6", "D6", "C6", "S8", "H9"], "four_two", 6);
expectType(["S6", "H6", "D6", "C6", "S8", "H8", "S9", "H9"], "four_two_pairs", 6);

expectInvalid([]);
expectInvalid(["S3", "S3"]);
expectInvalid(["S10", "HJ", "DQ", "CK", "SA", "S2"]);
expectInvalid(["S3", "H3", "S4", "H4"]);
expectInvalid(["S3", "H3", "D3", "C3", "S4"]);
expectInvalid(["S3", "H3", "D3", "S5", "H5", "D5"]);

assert.equal(canBeat(expectType(["S4"], "single"), expectType(["S3"], "single")), true);
assert.equal(canBeat(expectType(["S4", "H4"], "pair"), expectType(["S3"], "single")), false);
assert.equal(canBeat(expectType(["S4", "H4", "D4", "C4"], "bomb"), expectType(["S2"], "single")), true);
assert.equal(canBeat(expectType(["LJ", "BJ"], "rocket"), expectType(["S2", "H2", "D2", "C2"], "bomb")), true);
assert.equal(canBeat(expectType(["S4", "H5", "D6", "C7", "S8"], "straight"), expectType(["S3", "H4", "D5", "C6", "S7"], "straight")), true);
assert.equal(canBeat(expectType(["S4", "H5", "D6", "C7", "S8", "H9"], "straight"), expectType(["S3", "H4", "D5", "C6", "S7"], "straight")), false);

assert.deepEqual(sortCardIds(["S3", "BJ", "H10", "LJ"]), ["BJ", "LJ", "H10", "S3"]);
assert.deepEqual(smallestLead(["S2", "H4", "D4"]), ["H4"]);
assert.equal(cardsBelongToHand(["S3", "H3"], ["S3", "H3", "D4"]), true);
assert.equal(cardsBelongToHand(["S3", "S3"], ["S3", "H3"]), false);
assert.deepEqual(removeCards(["S3", "H3", "D4"], ["H3"]), ["S3", "D4"]);
assert.deepEqual(resolveRequestedCards(["♠3", "H3"], ["S3", "H3", "D4"]), ["S3", "H3"]);
assert.equal(nextPlayerId("aurex"), "aevi");
assert.equal(nextPlayerId("vex"), "aurex");

console.log("斗地主规则测试通过：牌组、牌型、压制、手牌操作均正确。");
