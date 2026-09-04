# 小机斗地主

一张带实时裁判、小机命令适配器、聊天、表情、互动道具、四套桌布、背景音乐和完整扑克牌素材的浏览器斗地主牌桌。

这个仓库同时包含**前端牌桌**和**后端裁判服务**（HTTP + WebSocket）。不包含主站、聊天系统、Bio、记忆、人格提示词、VPS 配置或任何真实运行存档。

## 直接运行

需要 Node.js 18 或更高版本。

```bash
npm install
npm start
```

打开 <http://127.0.0.1:8788/doudizhu/>。根路径 `/` 会跳到牌桌。

三个 AI 座位默认交给**真模型**：本机的 `claude` CLI（Claude Code 订阅，不填 API Key），每个座位一个常驻会话。没装 CLI 或想省额度就设 `DOUDIZHU_MODEL_OFF=1`，退回本地策略玩家，同样不需要 API Key、也不会用 mock 数据。裁判服务会在首次运行时创建 `data/doudizhu/`，保存积分、资料和牌局状态（这个目录不进 git）。

也可以 `./run.sh`：会自动 `npm install`，若仓库里已有 `certs/dev.crt` 就开 HTTPS。

## 后端是什么

`src/server.js` 是独立的 Node 服务，默认监听 `0.0.0.0:8788`：

| 路径 | 作用 |
|---|---|
| `GET /doudizhu/` | 牌桌静态页（`public/doudizhu/`） |
| `GET /api/doudizhu/health` | 健康检查 |
| `GET /api/doudizhu/state` | 当前牌局快照 |
| `POST /api/doudizhu/action` | 叫分 / 出牌 / 聊天等操作 |
| `GET /api/doudizhu/avatar/:id` | 座位头像 |
| `WS /api/doudizhu/ws` | 实时推送快照 |

规则、发牌、叫分、炸弹倍数、春天、积分和持久化都在 `src/doudizhu-service.js` 和 `src/doudizhu-rules.js`，浏览器只是画桌，不当裁判。

环境变量见 `.env.example`。常用：`HOST`、`PORT`、`SSL_CERTFILE` / `SSL_KEYFILE`、`DOUDIZHU_MODEL_OFF=1`、`DOUDIZHU_CLAUDE_BIN`、`DOUDIZHU_DATA_DIR`。

## 做成 PWA（添加到主屏幕）

牌桌带了 Web App Manifest 和 Service Worker。装到主屏幕后是独立窗口、横屏优先；**对局仍然要这个 Node 后端在跑**，Service Worker 只缓存牌桌壳和素材，不缓存 `/api/`。

### 电脑 Chrome / Edge

1. `npm start`，打开 <http://127.0.0.1:8788/doudizhu/>
2. 地址栏右侧的安装图标，或 菜单 → 安装应用 / 转换为应用
3. 以后从应用列表打开，不再走浏览器标签页

localhost 的 HTTP 就可以装。换别的域名或局域网 IP 必须 HTTPS。

### 手机（iPhone Safari / Android Chrome）

手机浏览器要求 **HTTPS** 才给「添加到主屏幕」。本机可以自签一份证书：

```bash
chmod +x scripts/make-dev-certs.sh
./scripts/make-dev-certs.sh
SSL_CERTFILE=certs/dev.crt SSL_KEYFILE=certs/dev.key npm start
```

然后用 `https://<电脑局域网IP>:8788/doudizhu/` 打开。

- **iPhone**：Safari 打开 → 分享 → 添加到主屏幕。自签证书要先安装并信任：把 `certs/dev.crt` 发到手机，设置 → 通用 → VPN 与设备管理 → 安装；再去 设置 → 通用 → 关于本机 → 证书信任设置 打开完全信任。
- **Android Chrome**：菜单 → 安装应用 / 添加到主屏幕。

公网部署时用正规证书（nginx + Let's Encrypt 反代到 `:8788` 即可），不要把自签证书用于生产。

### 开发者自己接安装按钮

Manifest 在 `/doudizhu/manifest.webmanifest`，Service Worker 在 `/doudizhu/sw.js`（`game.js` 启动时会注册）。桌面 Chrome 会触发 `beforeinstallprompt`，可以自己做一颗「安装到桌面」按钮；iOS Safari 没有这个事件，只能走系统分享菜单。

## 包含什么

- 54 张完整牌组、牌型识别、比较、发牌、叫分、过牌、炸弹/王炸、春天/反春天与跨局积分
- 人 15 秒回合时限；AI 座位按所选模型放宽（实测值见 `src/doudizhu-seat-models.js`），适配器异常或超时由裁判兜底，牌局不会卡死
- WebSocket 实时状态同步和 HTTP 操作接口
- 4 / 8 / 16 / 24 局家庭场，默认 4 局；固定一个真人座位，从三位 AI 中任选两位上桌
- 牌桌聊天、整场结束后按局整理的聊天记录与一键复制、13 个表情、番茄/鸡蛋/干杯互动道具、玩家资料与解散投票
- 四套桌布、完整图片素材、浏览器音效，以及 `normal.mp3` / `intense.mp3` 两首背景音乐
- 真人座位和三个 AI 座位都能在⚙牌桌设置里自己起名、换头像；默认叫「玩家 / 对家甲 / 对家乙 / 对家丙」，不会写死别人的外号
- 每个 AI 座位在牌桌设置里单选模型，存进 `data/doudizhu/profiles.json`
- 可替换的 stdin/stdout JSON 命令玩家协议

## 项目结构

```text
public/doudizhu/                 前端牌桌、PWA、图片/音频素材
  index.html                     牌桌页（含 manifest / apple-touch-icon）
  manifest.webmanifest           PWA 清单
  sw.js                          Service Worker
  icons/                         192 / 512 / iOS 触摸图标
src/server.js                    HTTP + WebSocket 后端入口
src/doudizhu-rules.js            牌组和牌型规则
src/doudizhu-service.js          权威裁判、状态机、计分和持久化
src/doudizhu-adapters.js         命令玩家进程管理与输出校验
src/doudizhu-model-adapter.js    真模型座位：提示词、合法性预检、失败兜底
src/doudizhu-model-session.js    一个座位一个常驻 claude 会话
src/doudizhu-seat-models.js      每个座位能选哪些模型、各给多少思考时间
scripts/                         本地策略玩家、测试、自签证书
```

## 接入自己的 小机

模型座位可调的环境变量：`DOUDIZHU_MODEL_OFF=1` 退回本地机器人、`DOUDIZHU_CLAUDE_BIN` 指定 CLI 路径、`DOUDIZHU_AI_TURN_MS` 一刀切回合时限、`DOUDIZHU_WARM_IDLE_MS` 常驻会话闲置多久收摊。

也可以完全不用模型，按下面的协议接自己的程序：

每个命令玩家从 stdin 接收一行 JSON，并向 stdout 输出一个 JSON 对象。最小输出示例：

```json
{"action":{"type":"play","cards":["S3"]},"say":"","emote":null,"prop":null}
```

首次运行后可修改 `data/doudizhu/players.json` 中对应玩家的 `command`、`cwd` 和 `env`。裁判会验证所有动作；超时、崩溃、非法 JSON 或非法出牌会重试一次，仍失败则自动代打。

## 测试

```bash
npm test
```

测试覆盖牌型、压制关系、AI 输出归一化、发牌与叫分、炸弹倍数、春天/反春天、持久化、互动、解散投票，以及完整扑克牌和两首 MP3 的资源校验。

## 许可

程序代码和文档按 [LICENSE](LICENSE) 走：源码可用（Source-Available），**不是开源** —— 可以自己看、自己跑、自己改着用；**禁止任何商业用途**，也禁止以商业为目的的二次转载／改版转载；任何公开使用、转载、演示、发帖、做视频，都**必须显著署名原作者并链回本仓库**。

图片与音频不在本许可范围内，边界见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，Kenney 音效许可保留在素材目录中。

以上为小猫和grok build共同编辑