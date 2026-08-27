#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DoudizhuService } from "../src/doudizhu-service.js";
import { smallestLead } from "../src/doudizhu-rules.js";

class FakeAdapter {
  constructor(votes = {}) {
    this.votes = votes;
  }

  async decide(player, payload) {
    if (payload.phase === "chat") {
      return { action: { type: "chat" }, say: "我在呢", emote: "", prop: null };
    }
    if (payload.phase === "dissolve") {
      return { action: { type: "vote_dissolve", agree: this.votes[player.id] !== false }, say: "", emote: "", prop: null };
    }
    return { action: { type: "pass" }, say: "", emote: "", prop: null };
  }
}

class QuotaAdapter {
  constructor() {
    this.calls = 0;
  }

  async decide() {
    this.calls += 1;
    throw new Error("Kimi Coding usage limit reached (status 403)");
  }
}

class InvalidActionAdapter {
  constructor() {
    this.calls = 0;
  }

  async decide() {
    this.calls += 1;
    return { action: { type: "dance" }, say: "", emote: "", prop: null };
  }
}

class InteractionAdapter {
  constructor() {
    this.calls = [];
  }

  async decide(player, payload) {
    this.calls.push({ player: player.id, payload });
    if (payload.phase === "interaction") {
      return { action: { type: "chat" }, say: "砸我？", emote: null, prop: { type: "egg", target: "aurex" } };
    }
    if (payload.phase === "chat") {
      return { action: { type: "chat" }, say: "我在呢", emote: "", prop: null };
    }
    if (payload.phase === "dissolve") {
      return { action: { type: "vote_dissolve", agree: false }, say: "", emote: "", prop: null };
    }
    return { action: { type: "pass" }, say: "", emote: "", prop: null };
  }
}

{
  const adapter = new InteractionAdapter();
  const { service, dataDir } = await createService(adapter);
  try {
    await service.startMatch(8, ["aevi", "juhua"]);
    service.clearTimers();
    service.players = service.players.map((player) => ["aevi", "juhua"].includes(player.id) ? { ...player, kind: "cmd" } : { ...player, kind: "human" });
    await service.handleClientMessage({ type: "chat", text: "有人吗" }, "aurex");
    await waitFor(() => adapter.calls.filter((call) => call.payload.phase === "chat").length === 2);
    await waitFor(() => service.state.feed.filter((item) => item.type === "chat" && item.playerId !== "aurex").length === 2);
    await service.operationQueue;
    const aurexMessage = service.state.feed.find((item) => item.type === "chat" && item.playerId === "aurex");
    assert.equal(aurexMessage.targetId, undefined, "牌桌聊天不应是私信目标");
    const chatCalls = adapter.calls.filter((call) => call.payload.phase === "chat");
    assert.deepEqual(chatCalls.map((call) => call.player).sort(), ["aevi", "juhua"]);
    assert.ok(chatCalls.every((call) => call.payload.table_message.text === "有人吗"));
    assert.ok(chatCalls.every((call) => call.payload.direct_message.targetId === null));
  } finally {
    await cleanup(service, dataDir);
  }
}

{
  const adapter = new InteractionAdapter();
  const { service, dataDir } = await createService(adapter);
  try {
    await service.startMatch(8, ["aevi", "vex"]);
    service.clearTimers();
    service.players = service.players.map((player) => player.id === "aevi" ? { ...player, kind: "cmd" } : { ...player, kind: "human" });
    await service.applyProp("aurex", "tomato", "aevi");
    await waitFor(() => service.state.feed.some((item) => item.type === "prop" && item.playerId === "aevi" && item.targetId === "aurex"));
    const interaction = adapter.calls.find((call) => call.payload.phase === "interaction");
    assert.ok(interaction, "Aurex 扔道具后目标 AI 必须收到互动反应 payload");
    assert.equal(interaction.payload.direct_interaction.prop, "tomato");
    assert.ok(service.state.feed.some((item) => item.type === "chat" && item.playerId === "aevi" && item.text === "砸我？"));
  } finally {
    await cleanup(service, dataDir);
  }
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待异步状态超时");
}

async function createService(adapter = new FakeAdapter()) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aevi-ddz-test-"));
  const service = new DoudizhuService({ rootDir: process.cwd(), dataDir, adapter });
  await service.ready();
  service.players = service.players.map((player) => ({ ...player, kind: "human" }));
  return { service, dataDir };
}

async function cleanup(service, dataDir) {
  service.clearTimers();
  await fs.rm(dataDir, { recursive: true, force: true });
}

{
  const { service, dataDir } = await createService();
  try {
    await service.startMatch(4, ["aevi", "vex"]);
    service.clearTimers();
    await service.applyChat("aurex", "第一局好险", { skipRateLimit: true });
    service.state.match.roundNumber = 2;
    service.state.round.number = 2;
    await service.applyChat("aevi", "第二局加油", { skipRateLimit: true });
    await service.applyEmote("vex", "emoji_01", { skipRateLimit: true });
    assert.equal(service.state.match.chatTranscript.length, 2, "本场记录只应收集文字聊天");
    assert.deepEqual(service.state.match.chatTranscript.map((item) => item.round), [1, 2]);
    assert.deepEqual(service.state.match.chatTranscript.map((item) => item.text), ["第一局好险", "第二局加油"]);
    assert.equal(service.publicSnapshot("aurex").match.chatTranscript.length, 0, "整场结束前不应弹出结算聊天记录");
    service.state.phase = "match_end";
    const finalSnapshot = service.publicSnapshot("aurex");
    assert.deepEqual(finalSnapshot.match.chatTranscript.map((item) => item.playerName), ["Aurex", "Aevi"]);
    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "state.json"), "utf8"));
    assert.equal(persisted.match.chatTranscript.length, 2, "聊天记录必须随牌局状态持久化");
  } finally {
    await cleanup(service, dataDir);
  }
}

{
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aevi-ddz-chat-migrate-"));
  const at = "2026-07-16T08:00:00.000Z";
  await fs.writeFile(path.join(dataDir, "state.json"), JSON.stringify({
    version: 1,
    phase: "match_end",
    match: {
      id: "legacy-match",
      totalRounds: 4,
      roundNumber: 2,
      playerIds: ["aurex", "aevi", "vex"],
      scoreDeltas: { aurex: 0, aevi: 0, vex: 0 },
      status: "completed",
      createdAt: at,
    },
    feed: [
      { id: "round-1", type: "round_start", round: 1, at },
      { id: "chat-1", type: "chat", playerId: "aurex", text: "旧第一局", at },
      { id: "round-2", type: "round_start", round: 2, at },
      { id: "emote-1", type: "emote", playerId: "vex", text: "表情", at },
      { id: "chat-2", type: "chat", playerId: "aevi", text: "旧第二局", at },
    ],
  }));
  const service = new DoudizhuService({ rootDir: process.cwd(), dataDir, adapter: new FakeAdapter() });
  await service.ready();
  try {
    const transcript = service.publicSnapshot("aurex").match.chatTranscript;
    assert.deepEqual(transcript.map((item) => [item.round, item.text]), [[1, "旧第一局"], [2, "旧第二局"]], "升级时应从旧事件恢复当前牌局聊天");
  } finally {
    await cleanup(service, dataDir);
  }
}

{
  const { service, dataDir } = await createService();
  try {
    await service.startMatch(8, ["aevi", "juhua"]);
    assert.deepEqual(service.state.match.playerIds, ["aurex", "aevi", "juhua"]);
    assert.deepEqual(Object.keys(service.state.round.hands), ["aurex", "aevi", "juhua"]);
    assert.deepEqual(service.publicSnapshot("aurex").players.map((player) => player.id), ["aurex", "aevi", "juhua"]);
    assert.equal("vex" in service.state.round.hands, false, "未点中的 AI 不得进入本局状态");
  } finally {
    await cleanup(service, dataDir);
  }
}

{
  const { service, dataDir } = await createService();
  try {
    await service.startMatch(4);
    const compactPayload = service.aiPayload(service.state.round.currentPlayerId);
    assert.ok(compactPayload.hand.every((card) => typeof card === "string"), "AI 手牌只应发送紧凑牌 ID");
    assert.ok(compactPayload.landlord_cards.every((card) => typeof card === "string"), "底牌只应发送紧凑牌 ID");
    assert.equal(typeof compactPayload.round_memory, "string");
    assert.equal(typeof compactPayload.chat_memory, "string");
    assert.equal("history" in compactPayload, false, "不得再发送完整动作历史对象");
    assert.equal("chat_recent" in compactPayload, false, "不得再发送完整聊天对象");
    assert.doesNotMatch(JSON.stringify(compactPayload), /\"(?:labels?|at)\"\s*:/, "AI 负载不得夹带展示字段和时间戳");
    assert.equal(service.state.phase, "bid");
    assert.equal(service.state.match.totalRounds, 4);
    assert.deepEqual(Object.values(service.state.round.hands).map((hand) => hand.length), [17, 17, 17]);
    assert.equal(service.state.round.landlordCards.length, 3);
    const firstDealer = service.state.round.currentPlayerId;
    for (let turn = 0; turn < 3; turn += 1) await service.applyBid(service.state.round.currentPlayerId, 0);
    assert.equal(service.state.phase, "bid");
    assert.equal(service.state.round.bidTurns, 0);
    assert.ok(service.state.feed.some((item) => item.text.includes("重新洗牌")));
    assert.notEqual(service.state.round.currentPlayerId, firstDealer, "无人叫分后应轮换发牌起点");

    const landlordId = service.state.round.currentPlayerId;
    await service.applyBid(landlordId, 1);
    await service.applyBid(service.state.round.currentPlayerId, 0);
    await service.applyBid(service.state.round.currentPlayerId, 0);
    assert.equal(service.state.phase, "play");
    assert.equal(service.state.round.landlordId, landlordId);
    assert.equal(service.state.round.hands[landlordId].length, 20);

    const firstCard = smallestLead(service.state.round.hands[landlordId]);
    await service.applyPlay(landlordId, firstCard);
    await service.applyPass(service.state.round.currentPlayerId);
    await service.applyPass(service.state.round.currentPlayerId);
    assert.equal(service.state.round.currentPlayerId, landlordId);
    assert.equal(service.state.round.leadingMove, null);

    service.state.round.hands[landlordId] = ["S3"];
    service.state.round.currentPlayerId = landlordId;
    service.state.round.leadingMove = null;
    service.state.round.playsByPlayer = { aurex: 0, aevi: 0, vex: 0 };
    await service.applyPlay(landlordId, ["S3"]);
    assert.ok(["round_end", "match_end"].includes(service.state.phase));
    assert.equal(service.state.round.result.spring, true);
    assert.equal(service.state.round.result.multiplier, 2, "1 分底分春天后应为 2 倍结算因子");
    const landlordDelta = service.state.round.scoreDelta[landlordId];
    assert.equal(landlordDelta, 4);
    assert.equal(Object.values(service.state.round.scoreDelta).reduce((sum, value) => sum + value, 0), 0);

    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "scores.json"), "utf8"));
    assert.equal(persisted.players[landlordId].games, 1);
  } finally {
    await cleanup(service, dataDir);
  }
}

{
  const adapter = new QuotaAdapter();
  const { service, dataDir } = await createService(adapter);
  try {
    await service.startMatch(8);
    service.clearTimers();
    const playerId = "vex";
    const token = "quota-test-turn";
    const deadlineAt = Date.now() + 5_000;
    service.state.round.currentPlayerId = playerId;
    service.state.timer = { token, phase: "bid", playerId, deadlineAt, durationMs: 15_000 };
    await service.runAiTurn(playerId, token, deadlineAt);
    assert.equal(adapter.calls, 1, "额度或权限 403 不得白白重试第二次");
    assert.ok(service.state.feed.some((item) => item.type === "adapter_error" && item.playerId === playerId));
  } finally {
    await cleanup(service, dataDir);
  }
}

{
  const adapter = new InvalidActionAdapter();
  const { service, dataDir } = await createService(adapter);
  try {
    await service.startMatch(8, ["aevi", "juhua"]);
    service.clearTimers();
    const playerId = "juhua";
    const token = "invalid-action-turn";
    const deadlineAt = Date.now() + 5_000;
    service.state.round.currentPlayerId = playerId;
    service.state.timer = { token, phase: "bid", playerId, deadlineAt, durationMs: 15_000 };
    await service.runAiTurn(playerId, token, deadlineAt);
    assert.equal(adapter.calls, 2, "非法动作必须带错误重试一次");
    await service.handleTurnTimeout(token);
    assert.notEqual(service.state.round.currentPlayerId, playerId, "适配器连续失败后裁判必须代打并推进回合");
  } finally {
    await cleanup(service, dataDir);
  }
}

{
  const { service, dataDir } = await createService(new FakeAdapter({ aevi: true, vex: false }));
  try {
    await service.startMatch(16);
    await service.requestDissolve("aurex");
    await waitFor(() => service.state.phase !== "dissolve_vote");
    await service.operationQueue;
    assert.equal(service.state.phase, "bid", "一人不同意时应恢复牌局");
    assert.ok(service.state.feed.some((item) => item.type === "dissolve_failed"));
  } finally {
    await cleanup(service, dataDir);
  }
}

{
  const adapter = new InteractionAdapter();
  const { service, dataDir } = await createService(adapter);
  try {
    await service.startMatch(8);
    await service.applyChat("aurex", "先解散我有事");
    await service.requestDissolve("aurex");
    await waitFor(() => service.state.phase !== "dissolve_vote");
    await service.operationQueue;
    assert.equal(service.state.phase, "lobby", "Aurex 明说有事先解散时 AI 应自动同意解散");
    assert.ok(adapter.calls.every((call) => call.payload.phase !== "dissolve"), "明确有事先散时不应再把投票交给模型犟");
    assert.ok(service.state.feed.some((item) => item.type === "dissolved"));
  } finally {
    await cleanup(service, dataDir);
  }
}

{
  const { service, dataDir } = await createService();
  try {
    await service.startMatch(8);
    service.clearTimers();
    service.state.phase = "play";
    Object.assign(service.state.round, {
      landlordId: "aevi",
      bidScore: 1,
      multiplier: 1,
      bombCount: 0,
      currentPlayerId: "aevi",
      leadingMove: null,
      hands: {
        aurex: ["S6", "H7"],
        aevi: ["LJ", "BJ", "S3"],
        vex: ["S4", "H4", "D4", "C4", "S5"],
      },
      playsByPlayer: { aurex: 0, aevi: 0, vex: 0 },
    });
    await service.applyPlay("aevi", ["LJ", "BJ"]);
    assert.equal(service.state.round.bombCount, 1, "王炸应计作一次炸弹事件");
    assert.equal(service.state.round.multiplier, 2, "王炸应翻倍");
    assert.ok(service.state.feed.some((item) => item.type === "rocket"));

    service.clearTimers();
    service.state.round.currentPlayerId = "vex";
    service.state.round.leadingMove = null;
    await service.applyPlay("vex", ["S4", "H4", "D4", "C4"]);
    assert.equal(service.state.round.bombCount, 2);
    assert.equal(service.state.round.multiplier, 4, "炸弹倍数应按 2 的次数幂累计");
  } finally {
    await cleanup(service, dataDir);
  }
}

{
  const { service, dataDir } = await createService();
  try {
    await service.startMatch(8);
    service.clearTimers();
    service.state.phase = "play";
    Object.assign(service.state.round, {
      landlordId: "aevi",
      bidScore: 1,
      multiplier: 1,
      bombCount: 0,
      currentPlayerId: "aurex",
      leadingMove: null,
      hands: { aurex: ["S3"], aevi: ["S4", "H5"], vex: ["S6", "H7"] },
      playsByPlayer: { aurex: 0, aevi: 1, vex: 0 },
    });
    await service.applyPlay("aurex", ["S3"]);
    assert.equal(service.state.round.result.antiSpring, true);
    assert.equal(service.state.round.result.multiplier, 2, "反春天应在现有倍数上再翻倍");
  } finally {
    await cleanup(service, dataDir);
  }
}

{
  const { service, dataDir } = await createService(new FakeAdapter({ aevi: true, vex: true }));
  try {
    await service.startMatch(24);
    await service.requestDissolve("aurex");
    await waitFor(() => service.state.phase === "lobby");
    await service.operationQueue;
    assert.equal(service.state.match, null);
    assert.ok(service.state.feed.some((item) => item.type === "dissolved"));
  } finally {
    await cleanup(service, dataDir);
  }
}

console.log("斗地主服务测试通过：紧凑无状态 AI 负载、额度止损、发牌、叫分、过牌、炸弹、春天/反春天、持久化与全票解散均正确。");
