#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";

const suits = ["S", "H", "D", "C"];
const ranks = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];
const required = [
  "public/doudizhu/index.html",
  "public/doudizhu/game.css",
  "public/doudizhu/game.js",
  "public/doudizhu/assets/cards/single/back.jpg",
  "public/doudizhu/assets/cards/single/LJ.jpg",
  "public/doudizhu/assets/cards/single/BJ.jpg",
  "public/doudizhu/assets/music/normal.mp3",
  "public/doudizhu/assets/music/intense.mp3",
  "public/doudizhu/assets/sfx/bomb.wav",
  "public/doudizhu/assets/sfx/select.ogg",
  "public/doudizhu/assets/sfx/toast.ogg",
  ...suits.flatMap((suit) => ranks.map((rank) => `public/doudizhu/assets/cards/single/${suit}${rank}.jpg`)),
];

for (const file of required) {
  const stat = await fs.stat(file);
  assert.ok(stat.isFile() && stat.size > 0, `${file} 必须存在且非空`);
}

const expectedMusicHashes = {
  "public/doudizhu/assets/music/intense.mp3": "2d67972c5e85abcb0e6c7855e143897ba5f95a45d0a7664a22754599a920a52b",
  "public/doudizhu/assets/music/normal.mp3": "add63004bed27cc1a2fbdd361009c89bba10554eecff3840e81fa42c7edfb2eb",
};

for (const [file, expected] of Object.entries(expectedMusicHashes)) {
  const actual = createHash("sha256").update(await fs.readFile(file)).digest("hex");
  assert.equal(actual, expected, `${file} 内容不完整`);
}

const adapters = await fs.readFile("src/doudizhu-adapters.js", "utf8");
const service = await fs.readFile("src/doudizhu-service.js", "utf8");
const game = await fs.readFile("public/doudizhu/game.js", "utf8");
const indexHtml = await fs.readFile("public/doudizhu/index.html", "utf8");
assert.match(adapters, /scripts\/doudizhu-bot-adapter\.mjs/);
assert.doesNotMatch(adapters, /doudizhu-(?:aevi|vex|juhua)-(?:adapter|client)/);
assert.match(service, /ROUND_OPTIONS = \[4, 8, 16, 24\]/);
assert.match(game, /\[4, 8, 16, 24\]\.map/);
assert.match(game, /aevi_ddz_rounds"\) \|\| 4/);
assert.match(indexHtml, /game\.js\?v=20260716ddzresultfix1/);
assert.match(indexHtml, /game\.css\?v=20260716ddzresultfix1/);
assert.match(service, /chatTranscript/);
assert.match(service, /transcriptFromFeed/);
assert.match(game, /本场聊天记录/);
assert.match(game, /data-copy-transcript/);
assert.match(game, /navigator\.clipboard\.writeText/);
assert.match(game, /allItems\.slice\(-6\)/);
assert.match(game, /data-toggle-transcript/);
assert.match(game, /data-close-result="true"/);
assert.match(game, /data-close-result-button/);
assert.match(game, /data-open-result/);
assert.match(game, /data-exit-doudizhu/);

console.log(`独立版检查通过：${required.length} 个关键文件与两首 MP3 完整。`);
