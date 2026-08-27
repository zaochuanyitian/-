#!/usr/bin/env node
import assert from "node:assert/strict";
import { normalizeAdapterResponse } from "../src/doudizhu-adapters.js";
import { claudeCliArgs } from "../src/doudizhu-model-session.js";

const normal = normalizeAdapterResponse({
  action: { type: "play", cards: ["S3", "H3"] },
  say: "我出一对",
  emote: "smile",
  prop: { type: "tomato", target: "aurex" },
});
assert.deepEqual(normal.action, { type: "play", cards: ["S3", "H3"] });
assert.equal(normal.say, "我出一对");
assert.deepEqual(normal.prop, { type: "tomato", target: "aurex" });

const vexStyle = normalizeAdapterResponse(`\n\`\`\`json
{"action":{"type":"vote_dissolve"},"agree":true,"say":"同意解散"}
\`\`\`
`);
assert.deepEqual(vexStyle.action, { type: "vote_dissolve", agree: true });

const vexVoteAlias = normalizeAdapterResponse({
  action: { type: "vote_dissolve", vote: true },
  say: "同意",
});
assert.deepEqual(vexVoteAlias.action, { type: "vote_dissolve", agree: true });

const vexCompactVote = normalizeAdapterResponse({
  action: "vote_dissolve",
  say: "散吧",
  prop: "yes",
});
assert.deepEqual(vexCompactVote.action, { type: "vote_dissolve", agree: true });

const vexCompactNo = normalizeAdapterResponse({ action: "vote_dissolve", prop: "no" });
assert.deepEqual(vexCompactNo.action, { type: "vote_dissolve", agree: false });

const outerCards = normalizeAdapterResponse({
  action: { type: "play" },
  cards: ["LJ", "BJ"],
});
assert.deepEqual(outerCards.action, { type: "play", cards: ["LJ", "BJ"] });

const outerBid = normalizeAdapterResponse({ action: { type: "bid" }, value: 3 });
assert.deepEqual(outerBid.action, { type: "bid", value: 3 });

const directChat = normalizeAdapterResponse({ action: { type: "chat" }, say: "我在呢" });
assert.deepEqual(directChat.action, { type: "chat" });
assert.equal(directChat.say, "我在呢");

assert.throws(
  () => normalizeAdapterResponse({ action: { type: "dance" } }),
  /不支持的动作类型/,
);

console.log("斗地主 AI 适配器测试通过：标准、代码块及 Vex 外层字段输出均可稳定归一化。");

const asRoot = claudeCliArgs("claude-sonnet-4-6", "sys");
assert.equal(asRoot.includes("--dangerously-skip-permissions"), process.getuid?.() !== 0);
assert.ok(asRoot.includes("--disallowedTools"));
console.log("斗地主 CLI 参数测试通过：root 下不带 skip-permissions。");
