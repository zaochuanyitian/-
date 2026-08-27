(function () {
  "use strict";

  var game = document.getElementById("game");
  var effects = document.getElementById("effects");
  var particleCanvas = document.getElementById("particleCanvas");
  var musicPlayer = document.getElementById("musicPlayer");
  var soundBomb = document.getElementById("soundBomb");
  var soundSelect = document.getElementById("soundSelect");
  var soundToast = document.getElementById("soundToast");
  var state = null;
  var bootError = "";
  var socket = null;
  var reconnectTimer = 0;
  var reconnectAttempt = 0;
  var connected = false;
  var selectedCards = new Set();
  var seenEvents = new Set();
  var seenInitialized = false;
  var settingsOpen = false;
  // 面板每来一个快照就整块重画，选了还没保存的模型先记在这儿，别被重画抹掉
  var pendingModels = {};
  var interactionOpen = false;
  var chatOpen = false;
  var resultOpen = true;
  var continueOpen = false;
  var transcriptExpanded = false;
  var targetId = "aevi";
  var cardGesture = null;
  var suppressCardClickUntil = 0;
  // 固定 1 局：打完弹出「是否继续」，不再选手数
  var roundChoice = 1;
  var musicVolume = clamp(Number(localStorage.getItem("aevi_ddz_music_volume") || 0.42), 0, 1);
  var effectVolume = clamp(Number(localStorage.getItem("aevi_ddz_effect_volume") || 0.74), 0, 1);
  var audioUnlocked = false;
  var audioContext = null;
  var toastTimer = 0;
  var currentMusicMode = "none";
  var selectedAiIds = (function () {
    try {
      var saved = JSON.parse(localStorage.getItem("aevi_ddz_ai_players") || "[]");
      if (Array.isArray(saved) && saved.length === 2 && saved.every(function (id) { return ["aevi", "vex", "juhua"].indexOf(id) >= 0; })) return saved;
    } catch (_) {}
    return ["aevi", "vex"];
  })();

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  // App 里注入 DOUDIZHU_ASSET_BASE（local-ddz://bundle/），头像和桌布走包里。
  function assetUrl(rel) {
    var base = window.DOUDIZHU_ASSET_BASE;
    rel = String(rel || "").replace(/^\//, "");
    if (base) return String(base) + rel;
    return "/doudizhu/assets/" + rel;
  }

  function avatarSrc(player) {
    if (player && player.id && window.DOUDIZHU_ASSET_BASE) {
      return assetUrl("avatars/" + player.id + ".jpg");
    }
    return (player && player.avatar) || assetUrl("avatars/aurex.jpg");
  }

  function themeUrl(id) {
    return assetUrl("themes/theme-" + id + ".png");
  }

  function signed(value) {
    var number = Number(value || 0);
    return number > 0 ? "+" + number : String(number);
  }

  function playerById(id) {
    return state && state.players ? state.players.find(function (player) { return player.id === id; }) : null;
  }

  function matchTranscript() {
    return state && state.match && Array.isArray(state.match.chatTranscript) ? state.match.chatTranscript : [];
  }

  function transcriptTime(value) {
    var date = new Date(value || 0);
    if (!Number.isFinite(date.getTime())) return "--:--";
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function transcriptPlayerName(item) {
    var player = playerById(item.playerId);
    return item.playerName || player && player.name || item.playerId || "未知玩家";
  }

  function transcriptGroups(items) {
    var groups = [];
    (items || []).forEach(function (item) {
      var round = Math.max(1, Number(item.round) || 1);
      var group = groups.length && groups[groups.length - 1].round === round ? groups[groups.length - 1] : null;
      if (!group) {
        group = { round: round, items: [] };
        groups.push(group);
      }
      group.items.push(item);
    });
    return groups;
  }

  function renderMatchTranscript() {
    if (state.phase !== "match_end") return "";
    var allItems = matchTranscript();
    var items = transcriptExpanded ? allItems : allItems.slice(-6);
    var content = items.length
      ? transcriptGroups(items).map(function (group) {
          return '<section class="match-transcript-round"><h3>第 ' + escapeHtml(group.round) + ' 局</h3>' + group.items.map(function (item) {
            return '<div class="match-transcript-row"><time>' + escapeHtml(transcriptTime(item.at)) + '</time><strong>' + escapeHtml(transcriptPlayerName(item)) + '</strong><span>' + escapeHtml(item.text) + '</span></div>';
          }).join("") + "</section>";
        }).join("")
      : '<p class="match-transcript-empty">本场没人说话。</p>';
    var countLabel = allItems.length + " 条" + (!transcriptExpanded && allItems.length > items.length ? " · 最近 " + items.length + " 条" : "");
    var toggle = allItems.length > 6
      ? '<button class="transcript-toggle" type="button" data-toggle-transcript="true">' + (transcriptExpanded ? "收起记录" : "展开全部 " + allItems.length + " 条") + "</button>"
      : "";
    return '<section class="match-transcript' + (transcriptExpanded ? " is-expanded" : "") + '" aria-label="本场聊天记录"><header><strong>' + (transcriptExpanded ? "按局记录" : "本场聊天记录") + '</strong><span>' + escapeHtml(countLabel) + '</span></header><div class="match-transcript-list">' + content + "</div>" + toggle + "</section>";
  }

  function transcriptCopyText() {
    var items = matchTranscript();
    var lines = ["小机斗地主 · 本场聊天记录", "共 " + items.length + " 条"];
    var activeRound = 0;
    items.forEach(function (item) {
      var round = Math.max(1, Number(item.round) || 1);
      if (round !== activeRound) {
        activeRound = round;
        lines.push("", "第 " + round + " 局");
      }
      lines.push("[" + transcriptTime(item.at) + "] " + transcriptPlayerName(item) + "：" + String(item.text || ""));
    });
    if (!items.length) lines.push("", "本场没人说话。");
    return lines.join("\n");
  }

  function fallbackCopyText(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    var copied = document.execCommand("copy");
    area.remove();
    if (!copied) throw new Error("复制失败");
  }

  async function copyMatchTranscript() {
    try {
      var text = transcriptCopyText();
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else fallbackCopyText(text);
      showNotice("聊天记录已复制");
    } catch (_) {
      showError("复制失败，请稍后再试");
    }
  }

  function eventAge(event) {
    return Date.now() - new Date(event.at || 0).getTime();
  }

  function latestPlayerEvent(playerId, types, maxAge) {
    if (!state || !state.feed) return null;
    for (var index = state.feed.length - 1; index >= 0; index -= 1) {
      var item = state.feed[index];
      if (item.playerId === playerId && types.indexOf(item.type) >= 0 && eventAge(item) <= maxAge) return item;
    }
    return null;
  }

  var SUIT_SYMBOLS = { S: "♠", H: "♥", D: "♦", C: "♣" };

  /** 牌不再贴图：一律纸样底图 + 印上去的点数，红黑只看花色。 */
  function cardMeta(card) {
    if (!card) return null;
    if (!/^(?:[HSDC](?:3|4|5|6|7|8|9|10|J|Q|K|A|2)|LJ|BJ)$/.test(card.id)) return null;
    if (card.id === "LJ" || card.id === "BJ") {
      var big = card.id === "BJ";
      return { rank: big ? "大" : "小", suit: "王", red: big, joker: true, ten: false };
    }
    var suit = card.id.slice(0, 1);
    var rank = card.id.slice(1);
    return { rank: rank, suit: SUIT_SYMBOLS[suit] || "", red: suit === "H" || suit === "D", joker: false, ten: rank === "10" };
  }

  function cardIndexMarkup(meta, flip) {
    return '<span class="card-index' + (flip ? " card-index--flip" : "") + '"><b>' + escapeHtml(meta.rank) + "</b><i>" + escapeHtml(meta.suit) + "</i></span>";
  }

  function renderCard(card, options) {
    options = options || {};
    var meta = cardMeta(card);
    if (!meta) return "";
    var className = "playing-card" + (meta.joker ? " is-joker" : "") + (meta.red ? " is-red" : "") + (meta.ten ? " is-ten" : "") + (options.selected ? " selected" : "");
    var attrs = options.clickable ? ' type="button" data-card="' + escapeAttr(card.id) + '"' : ' aria-hidden="true"';
    var style = "--index:" + Number(options.index || 0);
    var tag = options.clickable ? "button" : "div";
    return "<" + tag + ' class="' + className + '" style="' + escapeAttr(style) + '"' + attrs + (options.clickable ? ' aria-label="' + escapeAttr(card.label) + '" aria-pressed="' + (options.selected ? "true" : "false") + '"' : "") + ">" + cardIndexMarkup(meta, false) + cardIndexMarkup(meta, true) + "</" + tag + ">";
  }

  function renderBack(index) {
    return '<div class="playing-card card-back" style="--index:' + Number(index || 0) + '" aria-hidden="true"></div>';
  }

  function renderCards(cards, options) {
    return (cards || []).map(function (card, index) {
      return renderCard(card, Object.assign({}, options || {}, { index: index, selected: selectedCards.has(card.id) }));
    }).join("");
  }

  // 底牌也用手牌那套角标（左上一个、右下倒过来一个），三处牌面排法一致
  function renderLandlordMiniCard(card) {
    var isJoker = card && card.suit === "J";
    var rank = isJoker ? (card.id === "BJ" ? "大" : "小") : card && card.rank;
    var suit = isJoker ? "王" : SUIT_SYMBOLS[card && card.suit] || "";
    var red = card && (card.suit === "H" || card.suit === "D" || card.id === "BJ");
    var meta = { rank: rank || "", suit: suit, red: red, joker: isJoker, ten: rank === "10" };
    return '<span class="landlord-mini-card' + (red ? " is-red" : "") + (isJoker ? " is-joker" : "") + (meta.ten ? " is-ten" : "") + '" aria-label="' + escapeAttr(card && card.label || "地主牌") + '">' +
      cardIndexMarkup(meta, false) + cardIndexMarkup(meta, true) + "</span>";
  }

  function renderSeat(player) {
    var isTurn = state.round && state.round.currentPlayerId === player.id && ["bid", "play"].indexOf(state.phase) >= 0;
    var bubble = latestPlayerEvent(player.id, ["chat"], 6500);
    var score = state.match ? player.matchScore : player.totalScore;
    var role = player.role === "landlord" ? '<span class="role-badge">地主</span>' : player.role === "farmer" ? '<span class="role-badge">农</span>' : "";
    return (
      '<section class="player-seat' + (isTurn ? " is-turn" : "") + '" data-player="' + escapeAttr(player.id) + '" data-seat="' + Number(player.seatIndex || 0) + '">' +
      '<span class="seat-score">' + (state.match ? "本场 " : "总分 ") + escapeHtml(signed(score)) + "</span>" +
      '<div class="avatar-wrap"><img src="' + escapeAttr(avatarSrc(player)) + '" alt="' + escapeAttr(player.name) + '" />' + role + "</div>" +
      '<span class="hand-count">' + escapeHtml(String(player.handCount)) + " 张</span>" +
      '<span class="seat-name">' + escapeHtml(player.name) + "</span>" +
      (bubble ? '<span class="speech-bubble">' + escapeHtml(bubble.text) + "</span>" : "") +
      "</section>"
    );
  }

  function renderTopbar() {
    var roundText = state.match ? "第 " + state.match.roundNumber + "/" + state.match.totalRounds + " 局" : "等待开桌";
    var multiplier = state.round ? "倍数 ×" + state.round.multiplier : "家庭场";
    return (
      '<header class="topbar"><span class="dot ' + (connected ? "online" : "") + '"></span><span>' +
      escapeHtml(roundText) + "</span><strong>" + escapeHtml(multiplier) + "</strong></header>"
    );
  }

  function renderCenter() {
    if (!state.round) return '<div class="center-table"></div>';
    var bottomCards = state.round.landlordCards || [];
    var landlord = bottomCards.length
      ? '<div class="landlord-cards landlord-cards--revealed" title="地主底牌">' + bottomCards.map(renderLandlordMiniCard).join("") + "</div>"
      : "";
    var last = state.round.toBeat;
    var content = !bottomCards.length
      ? '<div class="landlord-deal-stage"><div class="landlord-cards landlord-cards--waiting" aria-label="待公布的三张地主牌">' + renderBack(0) + renderBack(1) + renderBack(2) + '</div><span class="last-move-label">正在叫地主</span></div>'
      : last
      ? '<div class="last-move"><span class="last-move-label">' + escapeHtml((playerById(last.playerId) || {}).name || last.playerId) + " · " + escapeHtml(last.move.label) + '</span><div class="table-cards">' + renderCards(last.cards.map(function (id, index) {
          var historyCard = (state.round.playHistory || []).flatMap(function (entry) { return entry.cards || []; }).indexOf(id) >= 0;
          var ownCard = (state.round.hand || []).find(function (card) { return card.id === id; });
          if (ownCard) return ownCard;
          var suit = id.slice(0, 1);
          var rank = id.slice(1);
          if (id === "LJ") return { id: id, rank: "小王", suit: "J", label: "小王" };
          if (id === "BJ") return { id: id, rank: "大王", suit: "J", label: "大王" };
          return historyCard ? { id: id, rank: rank, suit: suit, label: id } : { id: id, rank: rank, suit: suit, label: id };
        })) + "</div></div>"
      : '<div class="last-move"><span class="last-move-label">' + (state.phase === "bid" ? "正在叫地主" : "等待出牌") + "</span></div>";
    return landlord + '<div class="center-table">' + content + "</div>";
  }

  function renderTurnActions() {
    if (!state.round) return "";
    var controls = state.controls || {};
    if (state.phase === "bid" && controls.isYourTurn) {
      var options = controls.bidOptions || [];
      return '<div class="turn-actions">' + options.map(function (value) {
        return '<button class="action-button ' + (value === 3 ? "primary" : "") + '" type="button" data-bid="' + value + '">' + (value === 0 ? "不叫" : value + " 分") + "</button>";
      }).join("") + "</div>";
    }
    if (state.phase === "play" && controls.isYourTurn) {
      return (
        '<div class="turn-actions">' +
        '<button class="action-button" type="button" data-pass="true" ' + (controls.canPass ? "" : "disabled") + '>不出</button>' +
        '<button class="action-button primary" type="button" data-play="true" ' + (selectedCards.size ? "" : "disabled") + '>出牌</button>' +
        "</div>"
      );
    }
    if (["bid", "play"].indexOf(state.phase) >= 0) {
      var current = playerById(state.round.currentPlayerId);
      return '<div class="turn-actions"><span class="action-button" aria-live="polite">' + escapeHtml((current && current.name) || "对家") + " 思考中…</span></div>";
    }
    return "";
  }

  function renderHand() {
    if (!state.round || !state.round.hand) return "";
    var count = state.round.hand.length;
    var overlap = count >= 20 ? -0.64 : count >= 18 ? -0.61 : -0.58;
    return '<div class="hand-zone"><div class="hand" style="--hand-count:' + count + ";--hand-overlap:" + overlap + '" aria-label="你的手牌">' + renderCards(state.round.hand, { clickable: state.phase === "play" }) + "</div></div>";
  }

  function renderFeedLine() {
    var feed = state.feed || [];
    var latest = feed.length ? feed[feed.length - 1] : null;
    return latest ? '<div class="feed-line">' + escapeHtml(latest.text || "") + "</div>" : "";
  }

  function renderDissolveBanner() {
    var vote = state.dissolveVote;
    if (!vote) return "";
    var voters = (state.players || []).filter(function (player) {
      return Object.prototype.hasOwnProperty.call(vote.votes || {}, player.id);
    });
    return (
      '<aside class="dissolve-banner glass"><strong>正在申请解散</strong><div class="vote-list">' +
      voters.map(function (player) {
        var value = vote.votes[player.id];
        return '<span class="vote-chip ' + escapeAttr(value) + '">' + escapeHtml(player.name) + " · " + escapeHtml(value === "yes" ? "同意" : value === "no" ? "不同意" : "考虑中") + "</span>";
      }).join("") +
      "</div></aside>"
    );
  }

  function renderResultPanel() {
    if (!resultOpen || !state.round || !state.round.result || ["round_end", "match_end"].indexOf(state.phase) < 0) return "";
    var result = state.round.result;
    var winner = playerById(result.winnerId) || { name: result.winnerId };
    var tag = result.spring ? "春天 ×2" : result.antiSpring ? "反春天 ×2" : "本局结算";
    return (
      '<div class="modal-backdrop result-backdrop" data-close-result="true"><section class="result-panel glass' + (transcriptExpanded ? " transcript-expanded" : "") + '" data-result-stop="true"><header class="result-panel-head"><span aria-hidden="true"></span><div><span class="result-kicker">' + escapeHtml(transcriptExpanded ? "整场回顾" : tag) + "</span><h2>" + escapeHtml(transcriptExpanded ? "本场聊天记录" : winner.name + " 赢了") + '</h2></div><button class="result-close-button" type="button" data-close-result-button="true" aria-label="看完了，问下一局">×</button></header><div class="result-summary"><p>底分 ' + escapeHtml(result.bidScore) + " · 炸弹 " + escapeHtml(result.bombCount) + " · 最终倍数 " + escapeHtml(result.multiplier) + '</p><div class="result-score-grid">' +
      state.players.map(function (player) {
        return '<div class="result-score"><span>' + escapeHtml(player.name) + "</span><strong>" + escapeHtml(signed(result.scoreDelta[player.id])) + "</strong></div>";
      }).join("") +
      '</div></div>' + renderMatchTranscript() + '<div class="result-actions">' + (state.phase === "match_end" ? '<button class="result-copy-button" type="button" data-copy-transcript="true">复制记录</button><button class="result-exit-button" type="button" data-exit-doudizhu="true">退出斗地主</button>' : "") + "</div></section></div>"
    );
  }

  function renderResultReopen() {
    if (resultOpen || continueOpen || !state.round || !state.round.result || ["round_end", "match_end"].indexOf(state.phase) < 0) return "";
    return '<button class="result-reopen-button glass" type="button" data-open-result="true">查看' + (state.phase === "match_end" ? "本场" : "本局") + "结算</button>";
  }

  function renderContinueDialog() {
    if (!continueOpen || !state || ["round_end", "match_end"].indexOf(state.phase) < 0) return "";
    return (
      '<div class="modal-backdrop continue-backdrop" role="dialog" aria-modal="true" aria-labelledby="continueTitle">' +
      '<section class="continue-dialog" data-continue-stop="true">' +
      '<p id="continueTitle" class="continue-title">是否继续下一局？</p>' +
      '<div class="continue-actions">' +
      '<button class="continue-btn yes" type="button" data-continue-yes="true">是</button>' +
      '<button class="continue-btn no" type="button" data-continue-no="true">否</button>' +
      "</div></section></div>"
    );
  }

  function renderInteractionDrawer() {
    if (!interactionOpen) return "";
    var targets = (state.players || []).filter(function (player) { return player.id !== "aurex"; });
    if (!targets.some(function (player) { return player.id === targetId; })) targetId = targets.length ? targets[0].id : "";
    var canProp = Boolean(state.round && targetId);
    return (
      '<div class="drawer-backdrop" data-close-interaction="true"><section class="interaction-drawer" data-drawer-stop="true">' +
      '<div class="target-row"><span>目标</span>' + targets.map(function (player) {
        return '<button class="target-chip ' + (targetId === player.id ? "active" : "") + '" type="button" data-target="' + escapeAttr(player.id) + '">' + escapeHtml(player.name || player.id) + "</button>";
      }).join("") + "</div>" +
      '<div class="prop-row"><button class="prop-button" type="button" data-prop="tomato" ' + (canProp ? "" : "disabled") + '>🍅 番茄</button><button class="prop-button" type="button" data-prop="egg" ' + (canProp ? "" : "disabled") + '>🥚 臭蛋</button><button class="prop-button" type="button" data-prop="cheers" ' + (canProp ? "" : "disabled") + '>🍻 干杯</button></div>' +
      "</section></div>"
    );
  }

  function renderChatDrawer() {
    if (!chatOpen) return "";
    return (
      '<div class="drawer-backdrop chat-backdrop" data-close-chat="true"><section class="chat-drawer" data-chat-stop="true">' +
      '<div class="chat-row"><input data-chat-input="true" maxlength="40" enterkeyhint="send" autocomplete="off" placeholder="牌桌聊天，所有人都能听见" /><button type="button" data-send-chat="true">发送</button></div>' +
      "</section></div>"
    );
  }

  function themeButton(id, label) {
    return (
      '<button class="theme-option ' + (state.theme === id ? "active" : "") +
      '" type="button" data-theme-option="' + escapeAttr(id) +
      '" style="background-image:url(&quot;' + escapeAttr(themeUrl(id)) + '&quot;)"><span>' +
      escapeHtml(label) + "</span></button>"
    );
  }

  // 每个 AI 座位只给它那一族的模型：Sonnet 那栏就 sonnet，Opus 那栏就 opus，
  // 菊花那栏就 Fable 5（服务端 doudizhu-seat-models.js 说了算，这里只画）。
  function modelPicker(player) {
    var options = player.modelOptions || [];
    if (!options.length) return "";
    var chosen = pendingModels[player.id] || player.model || (options[0] && options[0].id);
    return '<select class="model-select" data-model-select="' + escapeAttr(player.id) + '">' +
      options.map(function (option) {
        return '<option value="' + escapeAttr(option.id) + '"' + (option.id === chosen ? " selected" : "") + ">" + escapeHtml(option.label) + "</option>";
      }).join("") + "</select>";
  }

  function profileEditor(player) {
    var avatarInput = '<input hidden type="file" accept="image/png,image/jpeg,image/webp" data-avatar-input="' + escapeAttr(player.id) + '">';
    var avatarButton = '<button type="button" data-pick-avatar="' + escapeAttr(player.id) + '">更换头像</button>';
    var head = '<article class="profile-editor"><img src="' + escapeAttr(avatarSrc(player)) + '" alt="">';
    // 人还是改昵称；AI 那三栏改成选模型（牌桌上就按模型名认人）
    if (player.kind === "human" || !(player.modelOptions || []).length) {
      return head +
        '<input type="text" maxlength="12" value="' + escapeAttr(player.name) + '" data-name-input="' + escapeAttr(player.id) + '">' +
        '<button type="button" data-save-name="' + escapeAttr(player.id) + '">保存昵称</button>' +
        avatarButton + avatarInput + "</article>";
    }
    return head + modelPicker(player) +
      '<button type="button" data-save-model="' + escapeAttr(player.id) + '">保存模型</button>' +
      avatarButton + avatarInput + "</article>";
  }

  function renderSettingsPanel() {
    if (!settingsOpen) return "";
    return (
      '<div class="modal-backdrop" data-close-settings="true"><section class="settings-panel glass" data-settings-stop="true">' +
      '<header class="panel-head"><div><span class="lobby-kicker">斗地主专属</span><h2>牌桌设置</h2></div><button class="close-button" type="button" data-close-settings-button="true">×</button></header>' +
      '<section class="settings-section"><h3>头像与模型</h3><div class="profile-editor-list">' +
      state.players.map(profileEditor).join("") + "</div></section>" +
      '<section class="settings-section"><h3>桌布</h3><div class="theme-picker">' + themeButton("jade", "粉喵键盘") + themeButton("sakura", "云朵软心") + themeButton("camp", "双熊挂饰") + themeButton("beach", "幸福双星") + "</div></section>" +
      '<section class="settings-section"><h3>声音</h3><label class="volume-row"><span>音乐</span><input type="range" min="0" max="1" step="0.01" value="' + musicVolume + '" data-music-volume="true"><output>' + Math.round(musicVolume * 100) + '%</output></label><label class="volume-row"><span>音效</span><input type="range" min="0" max="1" step="0.01" value="' + effectVolume + '" data-effect-volume="true"><output>' + Math.round(effectVolume * 100) + "%</output></label></section>" +
      '<section class="settings-section"><h3>当前比赛</h3><button class="dissolve-button" type="button" data-dissolve="true" ' + (state.controls && state.controls.canDissolve ? "" : "disabled") + '>申请解散 · 三个人都同意才生效</button></section>' +
      "</section></div>"
    );
  }

  var LOCAL_AVATARS = {
    aurex: assetUrl("avatars/aurex.jpg"),
    aevi: assetUrl("avatars/aevi.jpg"),
    vex: assetUrl("avatars/vex.jpg"),
    juhua: window.DOUDIZHU_ASSET_BASE ? assetUrl("avatars/juhua.jpg") : assetUrl("avatars/juhua.svg"),
  };

  function seedLobby() {
    return {
      phase: "lobby",
      theme: "jade",
      players: [
        { id: "aurex", name: "小猫", kind: "human", avatar: LOCAL_AVATARS.aurex, totalScore: 0 },
        { id: "aevi", name: "Aevi", kind: "cmd", avatar: LOCAL_AVATARS.aevi, totalScore: 0 },
        { id: "vex", name: "Vex", kind: "cmd", avatar: LOCAL_AVATARS.vex, totalScore: 0 },
        { id: "juhua", name: "菊花", kind: "cmd", avatar: LOCAL_AVATARS.juhua, totalScore: 0 },
      ],
      leaderboard: [],
    };
  }

  function renderLobby() {
    var players = state.players || [];
    var selectedNames = selectedAiIds.map(function (id) { return (players.find(function (player) { return player.id === id; }) || {}).name || id; });
    // 抬头跟着固定座位的昵称走：改昵称，这行也跟着改
    var hostName = (playerById("aurex") || {}).name || "小猫";
    return (
      '<div class="game-shell"><section class="lobby"><div class="lobby-card glass"><span class="lobby-kicker">' + escapeHtml(hostName) + " × " + escapeHtml(selectedNames.join(" × ")) + '</span><h1>小机斗地主</h1><div class="lobby-players">' +
      players.map(function (player) {
        var fixed = player.id === "aurex";
        var selected = fixed || selectedAiIds.indexOf(player.id) >= 0;
        var tag = fixed ? "固定座位" : selected ? "已上桌" : "点选上桌";
        return '<button class="lobby-player' + (selected ? " selected" : "") + (fixed ? " fixed" : " selectable") + '" type="button" ' + (fixed ? "disabled" : 'data-ai-player="' + escapeAttr(player.id) + '"') + '><img src="' + escapeAttr(avatarSrc(player)) + '" alt="' + escapeAttr(player.name) + '"><strong>' + escapeHtml(player.name) + '</strong><span>' + tag + ' · 总分 ' + escapeHtml(signed(player.totalScore)) + "</span></button>";
      }).join("") +
      '</div><button class="start-button" type="button" data-start="true" ' + (selectedAiIds.length === 2 ? "" : "disabled") + '>开桌</button><div class="leaderboard">' + (state.leaderboard || []).map(function (item, index) {
        return '<span>' + (index + 1) + '. <strong>' + escapeHtml(item.name) + "</strong> " + escapeHtml(signed(item.score)) + "</span>";
      }).join("") + "</div></div></section>" +
      '<button class="settings-button settings-button--lobby" type="button" data-open-settings="true" aria-label="斗地主设置">⚙</button>' + renderSettingsPanel() + "</div>"
    );
  }

  function renderTable() {
    return (
      '<div class="game-shell">' + renderTopbar() +
      state.players.map(renderSeat).join("") + renderCenter() + renderHand() + renderTurnActions() + renderFeedLine() + renderDissolveBanner() +
      '<button class="settings-button" type="button" data-open-settings="true" aria-label="斗地主设置">⚙</button>' +
      '<div class="table-tools"><button class="chat-button" type="button" data-open-chat="true" aria-label="对话"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-4.8 3v-3H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z"/><path d="M7.5 9.5h9M7.5 12.5h6"/></svg></button><button class="interaction-button" type="button" data-open-interaction="true" aria-label="表情与道具">☺</button></div>' +
      renderSettingsPanel() + renderChatDrawer() + renderInteractionDrawer() + renderResultPanel() + renderContinueDialog() + renderResultReopen() + "</div>"
    );
  }

  function render() {
    if (!state) {
      // 头像就在包里的静态文件，先把大厅画出来，别等裁判接口才出画面。
      state = seedLobby();
    }
    if (bootError && state.phase === "lobby" && !connected) {
      game.innerHTML = '<div class="game-shell"><section class="lobby"><div class="lobby-card glass"><span class="lobby-kicker">连接失败</span><h1>牌桌没接上</h1><p>' + escapeHtml(bootError) + '<br>请确认本机裁判服务（:8788）在跑。</p><button class="start-button" type="button" data-retry-connect="true">重试</button></div></section></div>';
      return;
    }
    document.body.dataset.theme = state.theme || "jade";
    game.innerHTML = state.phase === "lobby" ? renderLobby() : renderTable();
  }

  function showError(message) {
    window.clearTimeout(toastTimer);
    var old = document.querySelector(".error-toast");
    if (old) old.remove();
    var node = document.createElement("div");
    node.className = "error-toast";
    node.textContent = message || "操作失败";
    document.body.appendChild(node);
    toastTimer = window.setTimeout(function () { node.remove(); }, 2900);
    playAudio(soundToast, 0.8);
  }

  function showNotice(message) {
    window.clearTimeout(toastTimer);
    var old = document.querySelector(".error-toast");
    if (old) old.remove();
    var node = document.createElement("div");
    node.className = "error-toast success";
    node.textContent = message || "已完成";
    document.body.appendChild(node);
    toastTimer = window.setTimeout(function () { node.remove(); }, 2400);
  }

  function playAudio(element, scale) {
    if (!audioUnlocked || !element || effectVolume <= 0) return;
    try {
      element.currentTime = 0;
      element.volume = clamp(effectVolume * (scale == null ? 1 : scale), 0, 1);
      element.play().catch(function () {});
    } catch (_) {}
  }

  function ensureAudioContext() {
    if (!audioContext) {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) audioContext = new AudioCtx();
    }
    if (audioContext && audioContext.state === "suspended") audioContext.resume().catch(function () {});
    return audioContext;
  }

  function synthRocket() {
    var context = ensureAudioContext();
    if (!context || effectVolume <= 0) return;
    var now = context.currentTime;
    var gain = context.createGain();
    var oscillator = context.createOscillator();
    oscillator.type = "sawtooth";
    oscillator.frequency.setValueAtTime(90, now);
    oscillator.frequency.exponentialRampToValueAtTime(980, now + 0.58);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, effectVolume * 0.22), now + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.68);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.7);
  }

  function makeNoiseBuffer(context, duration) {
    var length = Math.max(1, Math.floor(context.sampleRate * duration));
    var buffer = context.createBuffer(1, length, context.sampleRate);
    var data = buffer.getChannelData(0);
    for (var index = 0; index < length; index += 1) data[index] = Math.random() * 2 - 1;
    return buffer;
  }

  function playToneSweep(type, startHz, endHz, duration, volume, delay) {
    var context = ensureAudioContext();
    if (!context || effectVolume <= 0) return;
    var now = context.currentTime + (delay || 0);
    var oscillator = context.createOscillator();
    var gain = context.createGain();
    oscillator.type = type || "sine";
    oscillator.frequency.setValueAtTime(Math.max(1, startHz), now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endHz), now + duration);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, effectVolume * volume), now + Math.min(0.035, duration * 0.24));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  function playNoiseBurst(options) {
    var context = ensureAudioContext();
    if (!context || effectVolume <= 0) return;
    options = options || {};
    var duration = options.duration || 0.16;
    var now = context.currentTime + (options.delay || 0);
    var source = context.createBufferSource();
    var filter = context.createBiquadFilter();
    var gain = context.createGain();
    source.buffer = makeNoiseBuffer(context, duration + 0.04);
    filter.type = options.filterType || "bandpass";
    filter.frequency.setValueAtTime(options.frequency || 900, now);
    filter.Q.setValueAtTime(options.q || 1.2, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, effectVolume * (options.volume || 0.18)), now + (options.attack || 0.012));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter).connect(gain).connect(context.destination);
    source.start(now);
    source.stop(now + duration + 0.05);
  }

  function playPropSound(prop) {
    if (prop === "tomato") {
      playToneSweep("sine", 138, 42, 0.18, 0.17, 0);
      playNoiseBurst({ duration: 0.24, filterType: "lowpass", frequency: 620, q: 0.72, volume: 0.28, attack: 0.008 });
      playNoiseBurst({ duration: 0.18, filterType: "bandpass", frequency: 380, q: 0.55, volume: 0.16, delay: 0.055, attack: 0.01 });
    } else if (prop === "egg") {
      playToneSweep("triangle", 210, 92, 0.12, 0.1, 0);
      playNoiseBurst({ duration: 0.08, filterType: "highpass", frequency: 2100, q: 0.9, volume: 0.18, attack: 0.003 });
      playNoiseBurst({ duration: 0.065, filterType: "highpass", frequency: 3100, q: 1.1, volume: 0.14, delay: 0.042, attack: 0.003 });
      playNoiseBurst({ duration: 0.1, filterType: "bandpass", frequency: 1300, q: 1.6, volume: 0.11, delay: 0.096, attack: 0.004 });
    } else if (prop === "cheers") {
      playToneSweep("sine", 1260, 1760, 0.34, 0.11, 0);
      playToneSweep("triangle", 850, 1520, 0.28, 0.08, 0.055);
      playToneSweep("sine", 2320, 1260, 0.22, 0.055, 0.12);
      playNoiseBurst({ duration: 0.16, filterType: "bandpass", frequency: 1750, q: 2.2, volume: 0.075, delay: 0.04, attack: 0.003 });
    } else {
      playAudio(soundToast, 0.58);
      return;
    }
    if (navigator.vibrate) navigator.vibrate(prop === "cheers" ? [22, 22, 28] : prop === "egg" ? [42, 25, 18] : [55, 22, 30]);
  }

  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    ensureAudioContext();
    updateMusic();
  }

  function desiredMusicMode() {
    if (!state || ["bid", "play", "dissolve_vote"].indexOf(state.phase) < 0) return "none";
    var intense = state.phase === "play" && state.players.some(function (player) { return player.handCount > 0 && player.handCount <= 3; });
    return intense ? "intense" : "normal";
  }

  function updateMusic() {
    var mode = desiredMusicMode();
    if (!audioUnlocked) return;
    if (mode === "none" || musicVolume <= 0) {
      musicPlayer.pause();
      currentMusicMode = mode;
      return;
    }
    var nextSource = mode === "intense" ? "/doudizhu/assets/music/intense.mp3" : "/doudizhu/assets/music/normal.mp3";
    if (currentMusicMode !== mode || musicPlayer.getAttribute("src") !== nextSource) {
      musicPlayer.pause();
      musicPlayer.setAttribute("src", nextSource);
      musicPlayer.load();
    }
    currentMusicMode = mode;
    musicPlayer.volume = musicVolume;
    musicPlayer.play().catch(function () {});
  }

  function emojiPosition(emote) {
    var index = Math.max(0, Number(String(emote || "").split("_")[1] || 1) - 1);
    return { x: (index % 3) * 50 + "%", y: Math.floor(index / 3) * 25 + "%" };
  }

  function playerCenter(id) {
    var node = document.querySelector('.player-seat[data-player="' + id + '"] .avatar-wrap');
    if (!node) return { x: game.clientWidth / 2, y: game.clientHeight / 2 };
    var rect = node.getBoundingClientRect();
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;
    if (window.matchMedia && window.matchMedia("(orientation: portrait)").matches) {
      return { x: y, y: document.body.clientHeight - x };
    }
    return { x: x, y: y };
  }

  function setCardSelected(button, selected) {
    if (!button || !button.hasAttribute("data-card")) return;
    var id = button.dataset.card;
    if (selected) selectedCards.add(id); else selectedCards.delete(id);
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
    var playButton = document.querySelector("[data-play]");
    if (playButton) playButton.disabled = selectedCards.size === 0;
  }

  function cardAtPoint(x, y) {
    var node = document.elementFromPoint(x, y);
    return node && node.closest ? node.closest("button[data-card]") : null;
  }

  game.addEventListener("pointerdown", function (event) {
    var button = event.target.closest && event.target.closest("button[data-card]");
    if (!button || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    var id = button.dataset.card;
    cardGesture = { pointerId: event.pointerId, selecting: !selectedCards.has(id), touched: new Set() };
    suppressCardClickUntil = Date.now() + 700;
    cardGesture.touched.add(id);
    setCardSelected(button, cardGesture.selecting);
    playAudio(soundSelect, 0.32);
    try { button.setPointerCapture(event.pointerId); } catch (_) {}
  });

  game.addEventListener("pointermove", function (event) {
    if (!cardGesture || cardGesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    var button = cardAtPoint(event.clientX, event.clientY);
    if (!button || cardGesture.touched.has(button.dataset.card)) return;
    cardGesture.touched.add(button.dataset.card);
    setCardSelected(button, cardGesture.selecting);
  });

  function finishCardGesture(event) {
    if (!cardGesture || cardGesture.pointerId !== event.pointerId) return;
    suppressCardClickUntil = Date.now() + 450;
    cardGesture = null;
  }

  game.addEventListener("pointerup", finishCardGesture);
  game.addEventListener("pointercancel", finishCardGesture);

  function animateProp(event) {
    var from = playerCenter(event.playerId);
    var to = playerCenter(event.targetId);
    var prop = ["tomato", "egg", "cheers"].indexOf(event.prop) >= 0 ? event.prop : "tomato";
    var image = document.createElement("img");
    image.className = "prop-flight prop-flight--" + prop;
    image.src = "/doudizhu/assets/props/" + prop + ".png";
    image.style.left = from.x + "px";
    image.style.top = from.y + "px";
    effects.appendChild(image);
    var dx = to.x - from.x;
    var dy = to.y - from.y;
    var arc = prop === "cheers" ? -48 : prop === "egg" ? -95 : -72;
    var spin = prop === "egg" ? 380 : prop === "cheers" ? 14 : 230;
    var animation = image.animate([
      { transform: "translate(-50%, -50%) translate(0,0) scale(.55) rotate(-16deg)", filter: "drop-shadow(0 8px 10px rgba(0,0,0,.18))" },
      { transform: "translate(-50%, -50%) translate(" + dx * 0.42 + "px," + (dy * 0.42 + arc) + "px) scale(1.08) rotate(" + spin * 0.42 + "deg)", filter: "drop-shadow(0 20px 18px rgba(0,0,0,.25))", offset: 0.55 },
      { transform: "translate(-50%, -50%) translate(" + dx * 0.92 + "px," + dy * 0.92 + "px) scale(1.03) rotate(" + spin * 0.86 + "deg)", offset: 0.88 },
      { transform: "translate(-50%, -50%) translate(" + dx + "px," + dy + "px) scale(" + (prop === "tomato" ? "1.18,.52" : ".82") + ") rotate(" + spin + "deg)", filter: "drop-shadow(0 4px 8px rgba(0,0,0,.3))" },
    ], { duration: prop === "cheers" ? 640 : 760, easing: "cubic-bezier(.17,.78,.2,1)", fill: "forwards" });
    animation.finished.then(function () {
      image.remove();
      renderPropImpact(prop, to);
      playPropSound(prop);
      propParticleBurst(prop, to);
    }).catch(function () { image.remove(); });
  }

  function addImpactPiece(parent, className, index, sizeMin, sizeMax) {
    var node = document.createElement("span");
    var angle = Math.random() * Math.PI * 2;
    var distance = 28 + Math.random() * 86;
    var size = sizeMin + Math.random() * (sizeMax - sizeMin);
    node.className = className;
    node.style.setProperty("--dx", Math.cos(angle) * distance + "px");
    node.style.setProperty("--dy", Math.sin(angle) * distance + "px");
    node.style.setProperty("--size", size + "px");
    node.style.setProperty("--rot", Math.round(Math.random() * 240 - 120) + "deg");
    node.style.setProperty("--delay", Math.min(index * 18, 130) + "ms");
    parent.appendChild(node);
  }

  function renderPropImpact(prop, center) {
    var impact = document.createElement("div");
    var counts = { tomato: 13, egg: 12, cheers: 16 };
    impact.className = "prop-impact prop-impact--" + prop;
    impact.style.left = center.x + "px";
    impact.style.top = center.y + "px";
    impact.style.setProperty("--tilt", Math.round(Math.random() * 18 - 9) + "deg");
    var hit = document.createElement("img");
    hit.className = "prop-impact-image";
    hit.src = "/doudizhu/assets/props/" + prop + "-hit.png";
    impact.appendChild(hit);
    for (var index = 0; index < counts[prop]; index += 1) {
      if (prop === "tomato") addImpactPiece(impact, "prop-drop tomato-drop", index, 9, 23);
      else if (prop === "egg") addImpactPiece(impact, "prop-drop egg-shard", index, 7, 18);
      else addImpactPiece(impact, "prop-drop beer-bubble", index, 7, 20);
    }
    if (prop === "cheers") {
      for (var spark = 0; spark < 7; spark += 1) addImpactPiece(impact, "prop-drop beer-spark", spark, 16, 34);
    }
    effects.appendChild(impact);
    setTimeout(function () { impact.remove(); }, prop === "cheers" ? 1250 : 1150);
  }

  function animateEmote(event) {
    var center = playerCenter(event.playerId);
    var pos = emojiPosition(event.emote);
    var node = document.createElement("div");
    node.className = "emote-popup";
    node.style.left = center.x + "px";
    node.style.top = center.y - 45 + "px";
    node.style.setProperty("--emoji-x", pos.x);
    node.style.setProperty("--emoji-y", pos.y);
    effects.appendChild(node);
    setTimeout(function () { node.remove(); }, 1850);
    playAudio(soundToast, 0.55);
  }

  function blast(type) {
    var node = document.createElement("div");
    node.className = type === "rocket" ? "rocket-flash" : "bomb-flash";
    node.textContent = type === "rocket" ? "王炸" : "炸弹";
    effects.appendChild(node);
    var shell = document.querySelector(".game-shell");
    if (shell) {
      shell.classList.remove("shake");
      void shell.offsetWidth;
      shell.classList.add("shake");
      setTimeout(function () { shell.classList.remove("shake"); }, 550);
    }
    if (navigator.vibrate) navigator.vibrate(type === "rocket" ? [85, 45, 120, 40, 180] : [110, 45, 150]);
    playAudio(soundBomb, type === "rocket" ? 1 : 0.88);
    if (type === "rocket") synthRocket();
    particleBurst(type);
    setTimeout(function () { node.remove(); }, 850);
  }

  function particleBurst(type) {
    var context = particleCanvas.getContext("2d");
    var ratio = window.devicePixelRatio || 1;
    var fieldWidth = game.clientWidth || innerWidth;
    var fieldHeight = game.clientHeight || innerHeight;
    particleCanvas.width = Math.round(fieldWidth * ratio);
    particleCanvas.height = Math.round(fieldHeight * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    var palette = type === "rocket" ? ["#ffffff", "#78d5ff", "#c98cff", "#ffe174"] : ["#ff382d", "#ffce55", "#ffffff", "#ff7d27"];
    var particles = Array.from({ length: 78 }, function () {
      var angle = Math.random() * Math.PI * 2;
      var speed = 3 + Math.random() * 8;
      return { x: fieldWidth / 2, y: fieldHeight / 2, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1, size: 2 + Math.random() * 5, color: palette[Math.floor(Math.random() * palette.length)] };
    });
    var start = performance.now();
    function frame(now) {
      var elapsed = now - start;
      context.clearRect(0, 0, fieldWidth, fieldHeight);
      particles.forEach(function (particle) {
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.vy += 0.08;
        particle.vx *= 0.992;
        particle.life = Math.max(0, 1 - elapsed / 950);
        context.globalAlpha = particle.life;
        context.fillStyle = particle.color;
        context.fillRect(particle.x, particle.y, particle.size, particle.size);
      });
      context.globalAlpha = 1;
      if (elapsed < 950) requestAnimationFrame(frame);
      else context.clearRect(0, 0, fieldWidth, fieldHeight);
    }
    requestAnimationFrame(frame);
  }

  function propParticleBurst(prop, center) {
    var context = particleCanvas.getContext("2d");
    if (!context) return;
    var ratio = window.devicePixelRatio || 1;
    var fieldWidth = game.clientWidth || innerWidth;
    var fieldHeight = game.clientHeight || innerHeight;
    particleCanvas.width = Math.round(fieldWidth * ratio);
    particleCanvas.height = Math.round(fieldHeight * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    var palettes = {
      tomato: ["#ff2d22", "#ff6a34", "#ffd05b", "#68b931"],
      egg: ["#fff4c7", "#ffd05b", "#ffffff", "#c98136"],
      cheers: ["#ffe680", "#ffbf3f", "#ffffff", "#d7efff"],
    };
    var palette = palettes[prop] || palettes.tomato;
    var count = prop === "cheers" ? 52 : 66;
    var particles = Array.from({ length: count }, function () {
      var angle = Math.random() * Math.PI * 2;
      var speed = 1.8 + Math.random() * (prop === "tomato" ? 7.4 : 5.8);
      return {
        x: center.x,
        y: center.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - (prop === "cheers" ? 1.3 : 0.2),
        life: 1,
        size: 2 + Math.random() * (prop === "egg" ? 5 : 7),
        color: palette[Math.floor(Math.random() * palette.length)],
        gravity: prop === "egg" ? 0.1 : prop === "cheers" ? 0.035 : 0.14,
      };
    });
    var start = performance.now();
    function frame(now) {
      var elapsed = now - start;
      context.clearRect(0, 0, fieldWidth, fieldHeight);
      particles.forEach(function (particle) {
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.vy += particle.gravity;
        particle.vx *= 0.984;
        particle.life = Math.max(0, 1 - elapsed / 820);
        context.globalAlpha = particle.life;
        context.fillStyle = particle.color;
        if (prop === "cheers") {
          context.beginPath();
          context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
          context.fill();
        } else {
          context.fillRect(particle.x, particle.y, particle.size, particle.size * (prop === "tomato" ? 0.72 : 1));
        }
      });
      context.globalAlpha = 1;
      if (elapsed < 820) requestAnimationFrame(frame);
      else context.clearRect(0, 0, fieldWidth, fieldHeight);
    }
    requestAnimationFrame(frame);
  }

  function handleNewEvent(event) {
    if (event.type === "bomb" || event.type === "rocket") blast(event.type);
    else if (event.type === "play") playAudio(soundSelect, 0.68);
    else if (event.type === "prop") animateProp(event);
    else if (event.type === "emote") animateEmote(event);
    else if (["bid", "landlord", "round_end", "dissolved"].indexOf(event.type) >= 0) playAudio(soundToast, 0.6);
  }

  function acceptSnapshot(next) {
    if (!next) return;
    var previousPhase = state && state.phase;
    var newEvents = [];
    if (!seenInitialized) {
      (next.feed || []).forEach(function (event) { seenEvents.add(event.id); });
      seenInitialized = true;
    } else {
      (next.feed || []).forEach(function (event) {
        if (!seenEvents.has(event.id)) {
          seenEvents.add(event.id);
          newEvents.push(event);
        }
      });
    }
    state = next;
    bootError = "";
    // 局末先把战绩摊开给人看；「是否继续下一局」等她点结算面板右上角那个 ×
    // 才弹。以前两个一起开，继续弹窗压在结算上面，这一局打成什么样永远看不见。
    if (["round_end", "match_end"].indexOf(state.phase) >= 0 && previousPhase !== state.phase) {
      resultOpen = true;
      continueOpen = false;
      transcriptExpanded = false;
    }
    if (["round_end", "match_end"].indexOf(state.phase) < 0) {
      resultOpen = true;
      continueOpen = false;
      transcriptExpanded = false;
    }
    var handIds = new Set((state.round && state.round.hand || []).map(function (card) { return card.id; }));
    Array.from(selectedCards).forEach(function (id) { if (!handIds.has(id)) selectedCards.delete(id); });
    render();
    updateMusic();
    newEvents.forEach(function (event, index) {
      setTimeout(function () { handleNewEvent(event); }, 40 + index * 90);
    });
  }

  async function postAction(message) {
    unlockAudio();
    try {
      var response = await fetch("/api/doudizhu/action", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message || {}),
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok || payload.ok === false) throw new Error(payload.error && payload.error.message || "牌桌操作失败");
      acceptSnapshot(payload.data || payload);
      return payload.data || payload;
    } catch (error) {
      showError(error.message || "牌桌操作失败");
      throw error;
    }
  }

  async function fetchState() {
    try {
      var response = await fetch("/api/doudizhu/state", { credentials: "same-origin", cache: "no-store" });
      var payload = await response.json();
      if (!response.ok) throw new Error(payload.error && payload.error.message || "连接牌桌失败");
      acceptSnapshot(payload.data || payload);
    } catch (error) {
      showError(error.message || "连接牌桌失败");
      bootError = error.message || "连接牌桌失败";
      render();
    }
  }

  function connectSocket() {
    window.clearTimeout(reconnectTimer);
    var scheme = location.protocol === "https:" ? "wss:" : "ws:";
    try {
      socket = new WebSocket(scheme + "//" + location.host + "/api/doudizhu/ws");
    } catch (_) {
      scheduleReconnect();
      return;
    }
    socket.addEventListener("open", function () {
      connected = true;
      reconnectAttempt = 0;
      render();
    });
    socket.addEventListener("message", function (event) {
      try {
        var message = JSON.parse(event.data);
        if (message.type === "snapshot") acceptSnapshot(message.data);
        else if (message.type === "error") showError(message.error);
      } catch (_) {}
    });
    socket.addEventListener("close", function () {
      connected = false;
      render();
      scheduleReconnect();
    });
    socket.addEventListener("error", function () { connected = false; });
  }

  function scheduleReconnect() {
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(connectSocket, Math.min(12000, 700 * Math.pow(1.65, reconnectAttempt)));
  }

  function closeOverlays() {
    settingsOpen = false;
    interactionOpen = false;
    chatOpen = false;
    render();
  }

  function focusChatInput() {
    var input = document.querySelector("[data-chat-input]");
    if (!input) return;
    try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); }
  }

  game.addEventListener("click", function (event) {
    var button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-retry-connect")) {
      bootError = "";
      render();
      fetchState();
      if (!socket || socket.readyState > 1) connectSocket();
      return;
    }
    if (button.hasAttribute("data-ai-player")) {
      var aiId = button.dataset.aiPlayer;
      var selectedIndex = selectedAiIds.indexOf(aiId);
      if (selectedIndex >= 0) selectedAiIds.splice(selectedIndex, 1);
      else {
        if (selectedAiIds.length >= 2) selectedAiIds.shift();
        selectedAiIds.push(aiId);
      }
      localStorage.setItem("aevi_ddz_ai_players", JSON.stringify(selectedAiIds));
      render();
      return;
    }
    if (button.hasAttribute("data-start")) {
      postAction({ type: "start_match", totalRounds: 1, aiPlayers: selectedAiIds.slice(0, 2) }).catch(function () {});
      return;
    }
    if (button.hasAttribute("data-continue-yes")) {
      continueOpen = false;
      resultOpen = false;
      // 固定 1 局：结束即 match_end，点「是」再开一桌
      if (state.phase === "round_end") {
        postAction({ type: "start_next_round" }).catch(function () {});
      } else {
        postAction({ type: "start_match", totalRounds: 1, aiPlayers: selectedAiIds.slice(0, 2) }).catch(function () {});
      }
      return;
    }
    if (button.hasAttribute("data-continue-no")) {
      continueOpen = false;
      resultOpen = false;
      postAction({ type: "return_lobby" }).catch(function () {});
      return;
    }
    if (button.hasAttribute("data-card")) {
      if (Date.now() < suppressCardClickUntil) return;
      var id = button.dataset.card;
      playAudio(soundSelect, 0.32);
      setCardSelected(button, !selectedCards.has(id));
      return;
    }
    if (button.hasAttribute("data-bid")) {
      postAction({ type: "bid", value: Number(button.dataset.bid) }).catch(function () {});
      return;
    }
    if (button.hasAttribute("data-play")) {
      var cards = Array.from(selectedCards);
      postAction({ type: "play", cards: cards }).then(function () { selectedCards.clear(); }).catch(function () {});
      return;
    }
    if (button.hasAttribute("data-pass")) {
      selectedCards.clear();
      postAction({ type: "pass" }).catch(function () {});
      return;
    }
    if (button.hasAttribute("data-open-settings")) {
      settingsOpen = true;
      interactionOpen = false;
      chatOpen = false;
      render();
      return;
    }
    if (button.hasAttribute("data-close-settings-button")) {
      settingsOpen = false;
      render();
      return;
    }
    if (button.hasAttribute("data-open-interaction")) {
      interactionOpen = !interactionOpen;
      settingsOpen = false;
      chatOpen = false;
      render();
      return;
    }
    if (button.hasAttribute("data-open-chat")) {
      chatOpen = !chatOpen;
      settingsOpen = false;
      interactionOpen = false;
      render();
      if (chatOpen) focusChatInput();
      return;
    }
    if (button.hasAttribute("data-theme-option")) {
      postAction({ type: "set_theme", theme: button.dataset.themeOption }).catch(function () {});
      return;
    }
    if (button.hasAttribute("data-save-name")) {
      var playerId = button.dataset.saveName;
      var input = document.querySelector('[data-name-input="' + playerId + '"]');
      postAction({ type: "update_profile", playerId: playerId, name: input && input.value }).catch(function () {});
      return;
    }
    if (button.hasAttribute("data-save-model")) {
      var seatId = button.dataset.saveModel;
      var select = document.querySelector('[data-model-select="' + seatId + '"]');
      var wanted = (select && select.value) || pendingModels[seatId];
      if (!wanted) return;
      postAction({ type: "update_profile", playerId: seatId, model: wanted })
        .then(function () {
          delete pendingModels[seatId];
        })
        .catch(function (err) {
          showError((err && err.message) || "模型没换成");
        });
      return;
    }
    if (button.hasAttribute("data-pick-avatar")) {
      var fileInput = document.querySelector('[data-avatar-input="' + button.dataset.pickAvatar + '"]');
      if (fileInput) fileInput.click();
      return;
    }
    if (button.hasAttribute("data-dissolve")) {
      settingsOpen = false;
      postAction({ type: "request_dissolve" }).catch(function () {});
      return;
    }
    if (button.hasAttribute("data-send-chat")) {
      var chatInput = document.querySelector("[data-chat-input]");
      if (chatInput && chatInput.value.trim()) postAction({ type: "chat", text: chatInput.value.trim() }).then(function () { chatOpen = false; render(); }).catch(function () {});
      return;
    }
    if (button.hasAttribute("data-emote")) {
      postAction({ type: "emote", emote: button.dataset.emote }).then(function () { interactionOpen = false; render(); }).catch(function () {});
      return;
    }
    if (button.hasAttribute("data-target")) {
      targetId = button.dataset.target;
      render();
      return;
    }
    if (button.hasAttribute("data-prop")) {
      postAction({ type: "prop", prop: button.dataset.prop, targetId: targetId }).then(function () { interactionOpen = false; render(); }).catch(function () {});
      return;
    }
    if (button.hasAttribute("data-next-round")) {
      postAction({ type: "start_next_round" }).catch(function () {});
      return;
    }
    if (button.hasAttribute("data-copy-transcript")) {
      copyMatchTranscript();
      return;
    }
    if (button.hasAttribute("data-toggle-transcript")) {
      transcriptExpanded = !transcriptExpanded;
      render();
      return;
    }
    // 结算右上角那个 × ＝「看完了」：收起战绩，紧接着问下一局
    if (button.hasAttribute("data-close-result-button")) {
      resultOpen = false;
      transcriptExpanded = false;
      continueOpen = ["round_end", "match_end"].indexOf(state.phase) >= 0;
      render();
      return;
    }
    if (button.hasAttribute("data-open-result")) {
      resultOpen = true;
      render();
      return;
    }
    if (button.hasAttribute("data-exit-doudizhu")) {
      button.disabled = true;
      postAction({ type: "return_lobby" }).catch(function () {}).finally(function () {
        window.parent.postMessage({ type: "aevi:doudizhu-back" }, "*");
      });
      return;
    }
    if (button.hasAttribute("data-return-lobby")) {
      postAction({ type: "return_lobby" }).catch(function () {});
    }
  });

  game.addEventListener("click", function (event) {
    if (event.target.hasAttribute("data-close-settings")) {
      settingsOpen = false;
      render();
    }
    if (event.target.hasAttribute("data-close-interaction")) {
      interactionOpen = false;
      render();
    }
    if (event.target.hasAttribute("data-close-chat")) {
      chatOpen = false;
      render();
    }
    if (event.target.hasAttribute("data-close-result")) {
      resultOpen = false;
      transcriptExpanded = false;
      render();
    }
  });

  // 相册原图往往几 MB；先缩成 512 方图 JPEG，避免 dataURL 撑爆请求体
  function compressAvatarFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || "")) {
        reject(new Error("请选择图片文件"));
        return;
      }
      // 未压缩源文件上限放宽；真正上传体积由 canvas 控制
      if (file.size > 20 * 1024 * 1024) {
        reject(new Error("图片太大，请选 20MB 以内的"));
        return;
      }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var maxSide = 512;
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          if (!w || !h) throw new Error("无法读取图片尺寸");
          var scale = Math.min(1, maxSide / Math.max(w, h));
          var tw = Math.max(1, Math.round(w * scale));
          var th = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement("canvas");
          canvas.width = tw;
          canvas.height = th;
          var ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("浏览器不支持图片压缩");
          ctx.drawImage(img, 0, 0, tw, th);
          var dataUrl = canvas.toDataURL("image/jpeg", 0.85);
          // 仍过大则再压质量
          if (dataUrl.length > 900 * 1024) {
            dataUrl = canvas.toDataURL("image/jpeg", 0.7);
          }
          if (dataUrl.length > 1.5 * 1024 * 1024) {
            dataUrl = canvas.toDataURL("image/jpeg", 0.55);
          }
          URL.revokeObjectURL(url);
          resolve(dataUrl);
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("图片加载失败"));
      };
      img.src = url;
    });
  }

  game.addEventListener("change", function (event) {
    var input = event.target;
    if (input.hasAttribute("data-model-select")) {
      pendingModels[input.dataset.modelSelect] = input.value;
      return;
    }
    if (!input.hasAttribute("data-avatar-input") || !input.files || !input.files[0]) return;
    var file = input.files[0];
    var playerId = input.dataset.avatarInput;
    input.value = "";
    compressAvatarFile(file)
      .then(function (dataUrl) {
        return postAction({ type: "update_profile", playerId: playerId, avatarDataUrl: dataUrl });
      })
      .catch(function (err) {
        showError((err && err.message) || "头像上传失败");
      });
  });

  game.addEventListener("input", function (event) {
    if (event.target.hasAttribute("data-music-volume")) {
      musicVolume = clamp(Number(event.target.value), 0, 1);
      localStorage.setItem("aevi_ddz_music_volume", String(musicVolume));
      var output = event.target.parentElement.querySelector("output");
      if (output) output.textContent = Math.round(musicVolume * 100) + "%";
      updateMusic();
    }
    if (event.target.hasAttribute("data-effect-volume")) {
      effectVolume = clamp(Number(event.target.value), 0, 1);
      localStorage.setItem("aevi_ddz_effect_volume", String(effectVolume));
      var effectOutput = event.target.parentElement.querySelector("output");
      if (effectOutput) effectOutput.textContent = Math.round(effectVolume * 100) + "%";
    }
  });

  game.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && event.target.hasAttribute("data-chat-input")) {
      event.preventDefault();
      var send = document.querySelector("[data-send-chat]");
      if (send) send.click();
    }
  });

  // 真横屏（App 里那条路）弹键盘时，iOS 不会替固定在底边的元素让位，牌桌聊天条
  // 会被整条压在键盘底下。visualViewport 报的是「没被键盘吃掉的那块」，把差值
  // 记进 --kb，横屏那条 media query 里再拿它把聊天条顶上来。
  // 竖屏那条路画布转了 90°，键盘是从牌桌右边进来的，顶它反而错位 —— 所以 CSS 里只给横屏用。
  var viewport = window.visualViewport;
  if (viewport) {
    var syncKeyboardInset = function () {
      var inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty("--kb", Math.round(inset) + "px");
    };
    viewport.addEventListener("resize", syncKeyboardInset);
    viewport.addEventListener("scroll", syncKeyboardInset);
    syncKeyboardInset();
  }

  document.addEventListener("pointerdown", unlockAudio, { once: true, passive: true });
  window.addEventListener("keydown", function (event) { if (event.key === "Escape") closeOverlays(); });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      musicPlayer.pause();
    } else updateMusic();
  });

  render();
  fetchState();
  connectSocket();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/doudizhu/sw.js", { scope: "/doudizhu/" }).catch(function () {});
  }
})();
