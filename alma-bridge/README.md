# 小肥鱼 × Alma 桥接插件 v0.2

Alma 里 agent 干活时，让桌面上的小肥鱼跟着变状态：干活、完成、出错。

| Alma 里发生的事 | 小肥鱼变 |
| --- | --- |
| 你发消息 / agent 开始调工具 | 工作中（气泡里显示正在干的事，最多 40 字） |
| agent 回完一整轮 | 完成，12 秒后回空闲 |
| 工具报错 | 出错，12 秒后回空闲 |
| Alma 退出 / 插件停用 | 回空闲 |

状态栏会显示小肥鱼当前状态（空闲 / 工作中 / 完成 / 出错 / 未连接）。

## v0.2 改了什么

- **端口自动发现**：DSH 桌面版与独立模式的端口每次启动都是随机的，写死 3080 连不上。
  现在按 设置里的 petBaseUrl → `~/.dsh/dsh-pet/logs.txt` 里最近的 `/dsh-pet-<n>` 地址 →
  兜底扫本机端口 的顺序找，探到能回 200 的就缓存 60 秒，失败自动重找。
- 新增设置项 `dshPetAlmaBridge.autoDiscover`。
- 状态栏文案更准：连不上时显示「未连接」，不再误报空闲。
- TypeScript 通过 `alma-plugin-api@0.1.2` 的严格类型检查（原来 README 里列的「待验证」项已实测通过）。

## 安装（Windows）

```bash
npm install
npm run build
```

把 `manifest.json`、`package.json`、`dist/main.js` 拷到
`%USERPROFILE%\.config\alma\plugins\dsh-pet-alma-bridge\`（注意：Windows 上 Alma 的插件目录
不是 %APPDATA%，是 `~/.config/alma/plugins`，可以用 `GET /api/plugins-path` 确认）。

然后在 Alma 里刷新插件：

```bash
curl -X POST http://localhost:23001/api/plugins/refresh
curl -X POST http://localhost:23001/api/plugins/dsh-pet-alma-bridge/enable
```

## 桌宠这边

桌宠宿主要有 HTTP 接口，两条路：

1. **DSH 桌面版**（宿主路由无鉴权）：装 `dsh-pet` 到 profile，打开 DSH 就行。
2. **独立模式**（不依赖 DSH）：`node lib/standalone.js --port 3080`。
   注意独立模式自带令牌保护，默认只允许 GET；要让外部写 `/work-status`，需要在
   `lib/standalone.js` 的 `publicRead` 里放行（本机已改成允许 `/dsh-pet-<n>/work-status`
   与 `/anim` 的 POST/DELETE，聊天类 `/whisper`、`/chat` 仍然要令牌）。

桌宠自己的对话 / 碎碎念走它的「本机 AI 设置」，配置在 `~/.dsh/dsh-pet/standalone-ai.json`，
可以填跟 Alma 同一个供应商（openai-compatible 的 baseUrl + apiKey + model）。

## 设置

- `dshPetAlmaBridge.enabled`：总开关。
- `dshPetAlmaBridge.petBaseUrl`：桌宠地址，默认 `http://127.0.0.1:3080`，连不上会自动另找。
- `dshPetAlmaBridge.autoDiscover`：是否自动发现端口。
- `dshPetAlmaBridge.petId`：桌宠 id，默认 `main`。
- `dshPetAlmaBridge.celebrateAnim`：完成时点播的动画名，留空不播。
