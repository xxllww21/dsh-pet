# 小肥鱼 × Alma 桥接插件（草稿 v0.1，未实测）

Alma 里 agent 干活时，让桌上独立跑着的小肥鱼跟着变状态。

## 它做什么

订阅 Alma 的事件，调桌宠独立模式的 HTTP 接口（`POST /dsh-pet-7340/work-status`）：

| Alma 里发生的事 | 小肥鱼变 |
| --- | --- |
| 你发消息 / agent 开始调工具 | 工作中（气泡里显示正在干的事，最多 40 字） |
| agent 回完一整轮 | 完成，12 秒后回空闲 |
| 工具报错 | 出错，12 秒后回空闲 |
| Alma 退出 / 插件停用 | 回空闲 |

状态栏会显示小肥鱼当前的状态（空闲 / 工作中 / 完成 / 出错 / 未连接）。

`celebrateAnim` 配了动画名的话，完成时还会点播一段那个动画。聊天不走这里：宠物的对话直接配它自己的 AI 设置（custom 服务商 + 自己的 API + deepseek v4.1 flash）。

## 前置条件

1. 桌宠以独立模式跑着：`dsh-pet-standalone`（默认 http://127.0.0.1:3080）。
2. Alma 已安装，Node.js 18+。

## 安装（Windows）

```bash
npm install
npm run build
```

把 `manifest.json` 和 `dist/main.js` 拷到 `%APPDATA%/Alma/plugins/dsh-pet-alma-bridge/`（`main.js` 放目录根部，不要带 `dist` 文件夹），然后在 Alma 设置 → 插件里启用。

## 设置

- `dshPetAlmaBridge.enabled`：总开关。
- `dshPetAlmaBridge.petBaseUrl`：桌宠地址；端口被占时独立模式会自动顺延，启动输出里看实际端口。
- `dshPetAlmaBridge.petId`：桌宠 id，默认 `main`。
- `dshPetAlmaBridge.celebrateAnim`：完成时点播的动画名，留空不播。

## 待验证

- 插件里的 `fetch` 能不能调到本机 3080（文档示例里直接用 `fs`/`fetch`，大概率可以，装机实测为准）。
- `createStatusBarItem({ text })` 与 `statusBar.text` 的形状以 `alma-plugin-api` 的实际类型为准，`npm run build` 会校验。
- `celebrateAnim` 的名字必须在宠物动画池里，否则点播没反应（看 `GET /config` 里那只宠物的 `animations`）。

## 归属

这份是草稿，等 xxllww21/dsh-pet 的 fork 建好后，放进 fork 里（建议 `alma-bridge/` 目录）再继续改。
