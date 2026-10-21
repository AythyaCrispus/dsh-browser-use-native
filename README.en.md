# DSH browser-use plugin

English | [简体中文](README.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

`@local/browser-use-native` is a Host-side plugin for DSH (DeepSeek Harness). It drives a real
Chromium through Playwright inside the Host process and exposes 17 `browser_*` tools to the
model. Tools are registered via `ctx.tools`; the config only carries browser options, and
Playwright is responsible for discovering a usable Chromium.

It targets agents that actually operate web pages: instead of dumping HTML, it renders a
prunable accessibility-tree snapshot, assigns each actionable node a `uid` that stays stable
across snapshots, and then clicks, fills, drags and downloads by `uid`.

> The package keeps the `@local/` scope on purpose: it is installed as a local `link:` bundle
> and is not published to npm. `private: true` also prevents accidental publishing.

## Features

- **17 tools**: navigation, prunable snapshots, click, fill, hover, drag, key presses, file
  upload, native downloads, script evaluation, multiple pages, console, network and dialogs.
- **One browser per live agent**: started lazily on the first browser tool call; calls from the
  same agent run serially; the browser is closed when the agent is disposed.
- **a11y snapshots**: reads the Chrome Accessibility Tree per frame and gives actionable nodes
  stable uids. Supports `selector` / `uid` scoping plus character, line and depth caps.
- **Stable uids**: uids are keyed by DOM backend node id and reused across snapshots; page
  navigation clears them, while iframe navigation clears only that frame. Stale uids produce a
  clear error instead of clicking some other element.
- **Action fallbacks**: when a plain click fails, it tries hit testing, a forced click, an
  associated label click and finally a scripted click, reporting which fallback was used.
- **Native downloads**: `download` fetches through `context.request` (shared cookies) and falls
  back to an in-page `fetch`; `uid` mode captures Playwright's `download` event and otherwise
  uses the link href.
- **Screenshots**: either written to disk or returned to the model as an attachment.
- **No hard-coded paths**: relative paths resolve against the current session working directory,
  and `~` expands to the home directory.

## Install

Requirements: DSH with Host bundle plugin support, Node.js >= 20, and Chrome or Edge installed.

```powershell
git clone https://github.com/AythyaCrispus/dsh-browser-use-native.git
cd dsh-browser-use-native
npm install --omit=dev
```

Then install that directory through the plugin manager in a DSH session:

```text
plugin_manager action=install_bundle target=<cloned directory>
```

The plugin is registered as a `link:` dependency, so it uses its own `node_modules`.

## Updating

- **Config in `cordis.patch.yml`**: HMR re-configures the plugin and the change takes effect.
- **`index.js` / `lib/*.js`**: the Host has already imported the module. Restart DSH, or disable
  and re-enable the plugin (`set_plugin enabled=false/true`) to re-import it.
- After installing or updating, trust the `application` returned by `plugin_manager`.

## Configuration

Every tunable lives in the patch `config`; values are validated on activation, and an invalid
value fails that row with an explanation.

| Field | Default | Description |
| --- | --- | --- |
| `headless` | `true` | `false` shows the browser window |
| `channel` | `chrome` | Playwright browser channel, e.g. `chrome` / `msedge`; empty means auto-detect |
| `executablePath` | `''` | Optional Chromium executable; empty means auto-detect |
| `slowMo` | `0` | Delay per action (ms) |
| `viewportWidth` | `1280` | Viewport width |
| `viewportHeight` | `800` | Viewport height |
| `actionTimeoutMs` | `5000` | Timeout for click / fill / hover and similar steps |
| `navigationTimeoutMs` | `30000` | Navigation timeout |
| `dialogPolicy` | `manual` | `manual` / `auto-dismiss` / `auto-accept` |
| `dialogTimeoutMs` | `5000` | Watchdog timeout for pending dialogs in `manual` mode |

Discovery order: `executablePath` → `channel` → `chrome` → `msedge` → Playwright-managed
Chromium. If everything fails, the tools return a summary of each attempt and suggest installing
Chrome/Edge or setting `channel` / `executablePath`. No machine-specific paths in the patch.

## Runtime behaviour

- **One browser per agent**: lazily started on the first browser tool call; tool calls for the
  same agent run serially; its context/browser is closed when the agent is disposed and all of
  them are closed when the plugin unloads.
- **Snapshots**: calls `Accessibility.getFullAXTree` per frame, renders it as text and assigns
  uids to actionable nodes. uids are written to `data-ba-uid` over CDP and registered in
  `window.__baUidLookup` (so `evaluate_script` can reach elements inside shadow DOM). Same-process
  iframes use page-level CDP with a `frameId`; OOPIFs get their own CDP session.
- **Pruning**: `selector` drops a temporary marker inside the frame, resolves it to a backend node
  id over CDP DOM, and renders only that AX subtree; `uid` reuses an existing backend node id.
  Defaults: 20000 chars / 1200 lines, with `maxDepth`, `maxChars`, `maxLines` and `includeFrames`;
  truncation is reported at the end.
- **Waiting**: `wait_for` polls text, selectors and JS predicates across all frames and supports
  `textGone` plus `visible` / `hidden` / `attached` / `detached` states.
- **Observation**: console and network entries are collected from Playwright events; on main-frame
  navigation they are archived into a preserved buffer, and default listings show only entries
  since the last navigation.
- **Dialogs**: `dialog` events are kept for `handle_dialog`; in `manual` mode a timeout watchdog
  dismisses them so a serial client never hangs.
- **Screenshots**: with `filePath` they are written to disk; otherwise they are stored through
  `ctx.attachments.saveImages` and returned as an image content block. Without an attachment
  service the tool asks for an explicit `filePath`.
- **System prompt**: browser instructions are injected only when `take_snapshot` is visible to the
  current agent.

## Tools

17 tools: `click`, `download`, `fill`, `hover`, `drag`, `press_key`, `upload_file`,
`evaluate_script`, `navigate_page`, `take_snapshot`, `take_screenshot`, `wait_for`, `list_pages`,
`select_page`, `list_console_messages`, `list_network_requests`, `handle_dialog`. They are exposed
to the model as `browser_<name>`.

## Self-test

```powershell
node selftest.mjs
```

The self-test does not need DSH: it starts a local HTTP server and headless Chrome and covers
navigate, snapshot, selector/uid-scoped snapshots, stable uids, fill (input / select / hidden
checkbox), hover, overlay click fallbacks, click, wait_for (text / textGone / selector / predicate /
iframe), native downloads (URL and uid click), evaluate_script, upload_file, iframe, drag,
press_key, screenshots (page / element / file), console, network, multiple pages, dialogs, stale-uid
rejection, and the presence of all 17 tool methods — 49 checks in total. Artifacts go to
`artifacts/`.

## Files

| File | Purpose |
| --- | --- |
| `package.json` | Bundle manifest, `dsh.bundle.patch`, `playwright-core` dependency, locale/icon exports |
| `cordis.patch.yml` | Inserts the `browser-use-native` row; carries only tunables |
| `index.js` | Host plugin entry: 17 tool definitions, per-agent session management, attachments, system prompt |
| `lib/browser.js` | `BrowserSession` / `BrowserTools`: Chromium lifecycle, pages, logs, dialogs, actions |
| `lib/snapshot.js` | AX-tree rendering, uid assignment, `data-ba-uid` CDP injection |
| `selftest.mjs` | End-to-end self-test without DSH (local HTTP pages + a real Chromium) |
| `locale/en.json` / `locale/zh.json` | Title and description shown in the plugin manager |
| `icon.svg` | Plugin icon |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `playwright-core is not installed` | Run `npm install --omit=dev` in the repo directory |
| `Could not launch a Chromium browser` | Install Chrome/Edge, or set `channel` / `executablePath` in the patch |
| No `browser_*` tools listed | Make sure the plugin is installed and enabled; after JS changes disable/enable it or restart DSH |
| Screenshot returns no image | The current model route does not accept images, or no attachment service is available; pass `filePath` |
| Code changes have no effect | Restart DSH or disable/enable the plugin to re-import the linked package |

## Security

This is an in-process Host plugin with the Host's process privileges; the Chromium it launches is
not constrained by the workspace file sandbox. Only install plugin code you trust: the browser
visits pages and runs JavaScript from `evaluate_script` on the model's instructions.

## License

[MIT](LICENSE)
