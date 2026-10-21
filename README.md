# DSH browser-use 插件

[English](README.en.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

`@local/browser-use-native` 是 DSH（DeepSeek Harness）的 Host 侧浏览器插件：
在 Host 进程内通过 Playwright 驱动真实 Chromium，向模型暴露 17 个 `browser_*` 工具。
工具通过 `ctx.tools` 注册，配置只包含浏览器参数，Playwright 负责发现可用的 Chromium。

它面向“能真正操作网页”的 Agent：用可裁剪的无障碍树（AX tree）快照代替整页 HTML，
给可操作节点分配跨快照稳定的 `uid`，再通过 `uid` 点击、填写、拖拽、下载。

> 包名保留 `@local/` 作用域：这是作为本地 bundle 通过 `link:` 安装的 DSH 插件，
> 不发布到 npm。`private: true` 也能防止误发布。

## 特性

- **17 个工具**：导航、可裁剪快照、点击、填写、悬停、拖拽、按键、上传、原生下载、脚本执行、
  多页面、console、network、弹窗处理。
- **每个 live Agent 一个浏览器**：首次浏览器工具调用时惰性启动，同一 Agent 的工具调用串行执行，
  Agent 释放时关闭。
- **a11y 快照**：逐 frame 读取 Chrome Accessibility Tree，给可操作节点分配稳定 uid；
  支持 `selector` / `uid` 聚焦，以及字符、行、深度上限。
- **稳定 uid**：uid 按 DOM backend node id 分配并在快照间复用；页面导航清空 uid，
  iframe 导航只清空该 frame；过期 uid 会返回明确错误而不是误点别的元素。
- **动作回退**：普通 click 失败后依次尝试命中检测、forced click、关联 label click、脚本 click，
  并在响应里注明实际使用的回退方式。
- **原生下载**：`download` 用 `context.request`（共享 cookie）取响应体，失败回退页面内 `fetch`；
  `uid` 模式捕获 Playwright 的 `download` 事件，无事件时用链接 href 兜底。
- **截图**：可以落盘，也可以作为附件返回给模型。
- **无硬编码路径**：相对路径按当前 Session 工作目录解析，`~` 展开到用户目录。

## 安装

要求：DSH（支持 Host bundle 插件）、Node.js >= 20、本机已安装 Chrome 或 Edge。

```powershell
git clone https://github.com/AythyaCrispus/dsh-browser-use-native.git
cd dsh-browser-use-native
npm install --omit=dev
```

然后在 DSH 会话里由插件管理器安装这个目录：

```text
plugin_manager action=install_bundle target=<克隆下来的目录>
```

插件以 `link:` 方式注册，因此它使用自己的 `node_modules`。

## 更新

- **改 `cordis.patch.yml` 里的配置**：HMR 会重组并生效。
- **改 `index.js` / `lib/*.js`**：Host 已经加载了模块，需要重启 DSH，或在插件管理器里先停用
  再启用该插件（`set_plugin enabled=false/true`）以重新导入。
- 安装/更新后以 `plugin_manager` 返回的 `application` 为准。

## 配置

所有可调值都在 `cordis.patch.yml` 的 `config` 里；插件激活时会校验，非法值会让该行加载失败并给出原因。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `headless` | `true` | `false` 显示浏览器窗口 |
| `channel` | `chrome` | Playwright 的浏览器通道，如 `chrome` / `msedge`；设为空则直接尝试自动发现 |
| `executablePath` | `''` | 可选：指定 Chromium 可执行文件；为空表示自动发现 |
| `slowMo` | `0` | 每步操作延迟（ms） |
| `viewportWidth` | `1280` | 视口宽 |
| `viewportHeight` | `800` | 视口高 |
| `actionTimeoutMs` | `5000` | 点击/填写/悬停等单步超时 |
| `navigationTimeoutMs` | `30000` | 导航超时 |
| `dialogPolicy` | `manual` | `manual` / `auto-dismiss` / `auto-accept` |
| `dialogTimeoutMs` | `5000` | `manual` 模式下弹窗兜底处理时间 |

浏览器发现顺序：`executablePath` → `channel` → `chrome` → `msedge` → Playwright 管理的 Chromium。
全部失败时工具返回每次尝试的错误摘要，并提示安装 Chrome/Edge 或配置 `channel` / `executablePath`。
因此换机器不需要改 patch 里的任何路径。

## 运行时行为

- **每 Agent 一个浏览器**：第一次浏览器工具调用时惰性启动；同一 Agent 的工具调用串行执行；
  Agent 释放时关闭它拥有的 context/browser；插件卸载时关闭全部。
- **快照**：逐 frame 调 `Accessibility.getFullAXTree`，渲染为文本并给可操作节点分配 uid；
  uid 通过 CDP 写成 `data-ba-uid`，同时登记进 `window.__baUidLookup`（`evaluate_script`
  也能取到 shadow DOM 里的元素）。同进程 iframe 走 page 级 CDP + `frameId`，OOPIF 走独立
  CDP session。
- **快照裁剪**：`selector` 在 frame 内打临时标记，经 CDP DOM 解析成 backend node id，只渲染
  该 AX 子树；`uid` 直接复用已有 backend node id。默认 20000 字符 / 1200 行上限，支持
  `maxDepth`、`maxChars`、`maxLines`、`includeFrames`，截断时在末尾报告。
- **动作回退**：见上文；checkbox / radio 的 fill 同样有 label / 脚本回退。
- **等待**：`wait_for` 轮询所有 frame 的文本、selector、JS 谓词，支持 `textGone` 与
  `visible` / `hidden` / `attached` / `detached` 状态。
- **观察**：console / network 由 Playwright 事件采集；主 frame 导航时归档到 preserved 缓冲区，
  默认列表只显示“上次导航之后”的条目。
- **弹窗**：`dialog` 事件被保留给 `handle_dialog`；`manual` 模式下超时 watchdog 会自动 dismiss，
  避免串行客户端卡死。
- **截图**：给了 `filePath` 就落盘；否则通过 `ctx.attachments.saveImages` 存成附件并返回 image
  content block。没有附件服务时返回提示，要求显式传 `filePath`。
- **系统提示**：只在 `take_snapshot` 工具对当前 Agent 可见时注入浏览器操作说明。

## 工具

17 个工具：`click`、`download`、`fill`、`hover`、`drag`、`press_key`、`upload_file`、`evaluate_script`、
`navigate_page`、`take_snapshot`、`take_screenshot`、`wait_for`、`list_pages`、`select_page`、
`list_console_messages`、`list_network_requests`、`handle_dialog`。暴露给模型的名字统一为
`browser_<name>`。

## 自测

```powershell
node selftest.mjs
```

自测不依赖 DSH：它启动本地 HTTP server 和无头 Chrome，覆盖 navigate、snapshot、
selector / uid 聚焦快照、稳定 uid、fill（input / select / 隐藏 checkbox）、hover、覆盖层点击回退、
click、wait_for（text / textGone / selector / 谓词 / iframe）、原生下载（URL 与 uid 点击）、
evaluate_script、upload_file、iframe、drag、press_key、截图（页面 / 元素 / 落盘）、console、
network、多页面、dialog、过期 uid 失效，以及 17 个工具方法是否齐全。共 49 项检查，
产物写在 `artifacts/`。

## 文件

| 文件 | 说明 |
| --- | --- |
| `package.json` | bundle 清单、`dsh.bundle.patch`、`playwright-core` 依赖、locale/icon 导出 |
| `cordis.patch.yml` | 插入 `browser-use-native` 行；只含可调参数 |
| `index.js` | Host 插件入口：17 个工具定义、每 Agent 会话管理、附件、系统提示 |
| `lib/browser.js` | `BrowserSession` / `BrowserTools`：Chromium 生命周期、页面、日志、弹窗、动作 |
| `lib/snapshot.js` | AX 树渲染、uid 分配、CDP 注入 `data-ba-uid` |
| `selftest.mjs` | 不依赖 DSH 的端到端自测（本地 HTTP 页面 + 真实 Chromium） |
| `locale/en.json` / `locale/zh.json` | 插件管理器里的标题与描述 |
| `icon.svg` | 插件图标 |

## 排错

| 现象 | 处理 |
| --- | --- |
| `playwright-core is not installed` | 在仓库目录执行 `npm install --omit=dev` |
| `Could not launch a Chromium browser` | 安装 Chrome/Edge，或在 patch 里设置 `channel` / `executablePath` |
| 工具列表中没有 `browser_*` | 确认插件已安装并启用；改过 JS 后停用再启用或重启 DSH |
| 截图没有图片 | 当前模型路由不接受图片，或没有 attachment 服务；传 `filePath` 落盘 |
| 改了代码但行为没变 | 重启 DSH，或停用再启用插件，才能重新导入 linked package 的 JS |

## 安全边界

这是 Host 进程内插件，拥有 Host 的进程权限；它启动的 Chromium 不受 workspace 文件沙箱约束。
只安装可信来源的插件代码；浏览器会按模型指令访问页面并执行 `evaluate_script` 中的 JavaScript。

## 许可

[MIT](LICENSE)
