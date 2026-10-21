/**
 * DSH Host plugin for the browser-use tool surface.
 *
 * Registers 17 browser tools and executes them in-process through Playwright.
 * Configuration contains only browser options; Playwright discovers an
 * installed Chromium.
 *
 * @module @local/browser-use-native
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { BrowserSession, BrowserTools, ToolError, resolveConfig } from './lib/browser.js'

export const name = 'browser-use-native'
export const inject = ['tools']

const TOOL_PREFIX = 'browser_'
const TOOL_TIMEOUT_MS = 120000

const INSTRUCTIONS = `You control a real Chromium browser.

Workflow:
1. Call ${TOOL_PREFIX}take_snapshot to read the accessibility tree of the selected page.
   Every actionable element in the snapshot carries a uid.
2. Act through uids: ${TOOL_PREFIX}click, ${TOOL_PREFIX}fill, ${TOOL_PREFIX}hover,
   ${TOOL_PREFIX}drag, ${TOOL_PREFIX}upload_file, ${TOOL_PREFIX}press_key.
3. After an action that changes the page, call ${TOOL_PREFIX}take_snapshot again. uids of
   elements that still exist stay stable; elements that were replaced need a fresh snapshot.

Rules:
- A snapshot is capped (20000 chars / 1200 lines by default) and reports when it truncated.
  On large pages pass selector="<css container>" or uid=<container uid> to snapshot only the
  relevant region, and/or raise maxChars/maxLines. Prefer a scoped snapshot over dumping the
  whole page, especially for filter sidebars and long lists.
- uids refer to elements observed by a snapshot. They survive new snapshots while the DOM
  node survives, but stale uids from a removed element fail with a clear message. After
  navigation, all previous uids are invalid.
- Prefer ${TOOL_PREFIX}take_snapshot over ${TOOL_PREFIX}take_screenshot. Screenshots are for
  visual checks, layout debugging and CAPTCHA-like cases where the snapshot is not enough.
- Use ${TOOL_PREFIX}wait_for for asynchronously rendered content. It can wait for text,
  textGone, a selector state (visible/hidden/attached/detached), or a JS predicate; it searches
  all frames.
- Use ${TOOL_PREFIX}download to save a file by URL (shares browser cookies) or by clicking a
  uid that triggers a browser download. Do not extract signed URLs and fetch them with
  another tool unless download fails.
- Use ${TOOL_PREFIX}list_pages / ${TOOL_PREFIX}select_page when several tabs are open.
- Use ${TOOL_PREFIX}list_console_messages / ${TOOL_PREFIX}list_network_requests to debug page failures.
- If a dialog is open, no other tool will run until ${TOOL_PREFIX}handle_dialog is called.`

const uidParameter = {
  type: 'string',
  description: 'A uid from the latest take_snapshot output.',
}

const pageIdxParameter = {
  type: 'integer',
  description: 'Zero-based page index from list_pages; omit for the selected page.',
}

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      image: { type: 'object' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  render(_args, value) {
    const content = [{ type: 'text', text: value.text }]
    if (value.image) content.push({ type: 'image', attachment: value.image })
    return content
  },
}

const TOOL_SPECS = [
  {
    name: 'click',
    description: 'Clicks on the provided element.',
    parameters: {
      type: 'object',
      properties: {
        uid: uidParameter,
        dblClick: { type: 'boolean', default: false, description: 'Double-click instead of a single click.' },
      },
      required: ['uid'],
    },
    run: (tools, args) => tools.click(args.uid, args.dblClick ?? false),
  },
  {
    name: 'fill',
    description: 'Type text into a input, text area or select an option from a <select> element.',
    parameters: {
      type: 'object',
      properties: {
        uid: uidParameter,
        value: { type: 'string', description: 'Text to type, or the option to select.' },
      },
      required: ['uid', 'value'],
    },
    run: (tools, args) => tools.fill(args.uid, args.value),
  },
  {
    name: 'hover',
    description: 'Hover over the provided element.',
    parameters: {
      type: 'object',
      properties: { uid: uidParameter },
      required: ['uid'],
    },
    run: (tools, args) => tools.hover(args.uid),
  },
  {
    name: 'drag',
    description: 'Drag an element onto another element.',
    parameters: {
      type: 'object',
      properties: {
        from_uid: { ...uidParameter, description: 'The element to drag.' },
        to_uid: { ...uidParameter, description: 'The target element.' },
      },
      required: ['from_uid', 'to_uid'],
    },
    run: (tools, args) => tools.drag(args.from_uid, args.to_uid),
  },
  {
    name: 'press_key',
    description:
      'Press a key or key combination. Use this when other input methods like fill() cannot be used ' +
      '(e.g., keyboard shortcuts, navigation keys, or special key combinations). For multiple key ' +
      'presses, call this tool multiple times instead of using space-separated keys.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name, e.g. Enter, Escape, Tab, or Control+A.' },
      },
      required: ['key'],
    },
    run: (tools, args) => tools.pressKey(args.key),
  },
  {
    name: 'upload_file',
    description:
      'Upload a file through a provided element. The uid can point at a file input or at any ' +
      'element that opens a file chooser.',
    parameters: {
      type: 'object',
      properties: {
        uid: uidParameter,
        filePath: { type: 'string', description: 'Path to the local file to upload.' },
      },
      required: ['uid', 'filePath'],
    },
    run: (tools, args) => tools.uploadFile(args.uid, args.filePath),
  },
  {
    name: 'download',
    description:
      'Save a file to disk. Pass url to fetch it with the browser session (cookies included), or ' +
      'uid to click an element that starts a browser download. Relative filePath resolves against ' +
      'the session working directory; without filePath the file goes to ./downloads/<name>.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'HTTP(S), data: or blob: URL to save. Relative URLs resolve against the page.',
        },
        uid: {
          type: 'string',
          description: 'A uid from the latest snapshot; clicking it should trigger a download.',
        },
        filePath: {
          type: 'string',
          description: 'Destination file, or an existing directory to save into.',
        },
        timeout: {
          type: 'integer',
          description: 'Timeout in milliseconds; defaults to the navigation timeout.',
        },
      },
    },
    run: (tools, args) => tools.download(args),
  },
  {
    name: 'evaluate_script',
    description:
      'Evaluate a JavaScript function inside the currently selected page. Returns the response as ' +
      'JSON so returned values have to be JSON-serializable. Use `args` to pass elements referenced ' +
      'by uid; e.g. function="(el) => el.innerText" with args=[{"uid": "0_3"}].',
    parameters: {
      type: 'object',
      properties: {
        function: {
          type: 'string',
          description: 'JavaScript function declaration, e.g. "(el) => el.innerText".',
        },
        args: {
          type: 'array',
          items: { type: 'object' },
          description: 'Optional arguments; an object with a uid field resolves to that element.',
        },
      },
      required: ['function'],
    },
    run: (tools, args) => tools.evaluateScript(args.function, args.args ?? null),
  },
  {
    name: 'navigate_page',
    description: 'Navigates the currently selected page to a URL.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['url', 'back', 'forward', 'reload'],
          default: 'url',
          description: 'Navigation operation.',
        },
        url: { type: 'string', description: 'Target URL when type is url.' },
        timeout: { type: 'integer', description: 'Navigation timeout in milliseconds.' },
        ignoreCache: { type: 'boolean', default: false, description: 'Bypass the HTTP cache for this navigation.' },
      },
    },
    run: (tools, args) =>
      tools.navigatePage(args.type ?? 'url', args.url ?? null, args.timeout ?? null, args.ignoreCache ?? false),
  },
  {
    name: 'take_snapshot',
    description:
      'Take a text snapshot of the currently selected page based on the a11y tree. The snapshot ' +
      'lists page elements along with a unique identifier (uid). uids stay stable for elements ' +
      'that survive later snapshots. On large pages scope the snapshot with selector or uid ' +
      'instead of dumping the whole page; the output is capped and reports truncation.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Optional path to write the snapshot text to.' },
        verbose: { type: 'boolean', default: false, description: 'Keep otherwise flattened structural nodes.' },
        selector: {
          type: 'string',
          description:
            'CSS selector of a container to snapshot. Only that subtree is rendered (searched in ' +
            'all frames). Mutually exclusive with uid.',
        },
        uid: {
          type: 'string',
          description: 'A uid from a previous snapshot; snapshot only that element/subtree.',
        },
        maxDepth: {
          type: 'integer',
          description: 'Maximum indentation depth to render; deeper nodes are omitted.',
        },
        maxLines: {
          type: 'integer',
          default: 1200,
          description: 'Maximum output lines (0 disables the line cap).',
        },
        maxChars: {
          type: 'integer',
          default: 20000,
          description: 'Maximum output characters (0 disables the character cap).',
        },
        includeFrames: {
          type: 'boolean',
          default: true,
          description: 'Include child frames/iframes in the snapshot.',
        },
      },
    },
    run: (tools, args) => tools.takeSnapshot(args),
  },
  {
    name: 'take_screenshot',
    description: 'Take a screenshot of the page or element.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Optional path to save the image to instead of attaching it.' },
        format: { type: 'string', enum: ['png', 'jpeg'], default: 'png', description: 'Image format.' },
        fullPage: { type: 'boolean', default: false, description: 'Capture the full scrollable page.' },
        quality: { type: 'integer', description: 'JPEG quality from 0 to 100.' },
        uid: { type: 'string', description: 'Capture one element from the latest snapshot instead of the page.' },
      },
    },
    run: (tools, args) =>
      tools.takeScreenshot(
        args.filePath ?? null,
        args.format ?? 'png',
        args.fullPage ?? false,
        args.quality ?? null,
        args.uid ?? null,
      ),
  },
  {
    name: 'wait_for',
    description:
      'Wait until text appears, text disappears, a selector reaches a state, and/or a JS predicate ' +
      'is truthy. Text is searched in every frame. Multiple supplied conditions must all hold.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text that must appear.' },
        textGone: { type: 'string', description: 'Text that must disappear (e.g. a loading label).' },
        selector: { type: 'string', description: 'CSS selector to wait for.' },
        state: {
          type: 'string',
          enum: ['visible', 'hidden', 'attached', 'detached'],
          default: 'visible',
          description: 'State the selector must reach; requires selector.',
        },
        function: {
          type: 'string',
          description: 'JavaScript predicate, e.g. "() => document.readyState === \'complete\'".',
        },
        timeout: { type: 'integer', description: 'Timeout in milliseconds; defaults to 10000.' },
        pollInterval: { type: 'integer', description: 'Poll interval in milliseconds; defaults to 200.' },
      },
    },
    run: (tools, args) => tools.waitFor(args),
  },
  {
    name: 'list_pages',
    description: 'Get a list of pages open in the browser.',
    parameters: { type: 'object', properties: {} },
    run: (tools) => tools.listPages(),
  },
  {
    name: 'select_page',
    description: 'Select a page as a context for future tool calls.',
    parameters: {
      type: 'object',
      properties: { pageIdx: { ...pageIdxParameter, description: 'Zero-based page index from list_pages.' } },
      required: ['pageIdx'],
    },
    run: (tools, args) => tools.selectPage(args.pageIdx),
  },
  {
    name: 'list_console_messages',
    description: 'List all console messages for the currently selected page since the last navigation.',
    parameters: {
      type: 'object',
      properties: {
        types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Console message types to include, e.g. error or warning.',
        },
        pageIdx: pageIdxParameter,
        pageSize: { type: 'integer', description: 'Maximum number of most recent entries.' },
        includePreservedMessages: {
          type: 'boolean',
          default: false,
          description: 'Include entries archived by the last main-frame navigation.',
        },
      },
    },
    run: (tools, args) =>
      tools.listConsoleMessages(
        args.types ?? null,
        args.pageIdx ?? null,
        args.pageSize ?? null,
        args.includePreservedMessages ?? false,
      ),
  },
  {
    name: 'list_network_requests',
    description: 'List all requests for the currently selected page since the last navigation.',
    parameters: {
      type: 'object',
      properties: {
        resourceTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Resource types to include, e.g. document or script.',
        },
        pageIdx: pageIdxParameter,
        pageSize: { type: 'integer', description: 'Maximum number of most recent entries.' },
        includePreservedRequests: {
          type: 'boolean',
          default: false,
          description: 'Include entries archived by the last main-frame navigation.',
        },
      },
    },
    run: (tools, args) =>
      tools.listNetworkRequests(
        args.resourceTypes ?? null,
        args.pageIdx ?? null,
        args.pageSize ?? null,
        args.includePreservedRequests ?? false,
      ),
  },
  {
    name: 'handle_dialog',
    description: 'If a browser dialog was opened, use this command to handle it.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['accept', 'dismiss'], description: 'Accept or dismiss the dialog.' },
        promptText: { type: 'string', description: 'Text to enter when accepting a prompt dialog.' },
      },
      required: ['action'],
    },
    run: (tools, args) => tools.handleDialog(args.action, args.promptText ?? null),
  },
]

function expandHome(target) {
  const text = String(target)
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

/** One browser per live Agent, serialized per Agent. */
class BrowserManager {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.sessions = new Map()
    this.closed = false
  }

  forAgent(agent) {
    const key = agent ?? null
    const existing = this.sessions.get(key)
    if (existing && !existing.closed) return existing

    const session = new BrowserSession(this.config, this.ctx.logger)
    const tools = new BrowserTools(session, {
      resolvePath: (target) => this.resolvePath(agent, target),
      attachImage: (data, mediaType) => this.attachImage(agent, data, mediaType),
    })
    const entry = {
      key,
      agent,
      session,
      tools,
      chain: Promise.resolve(),
      closed: false,
      agentEffect: null,
    }
    this.sessions.set(key, entry)

    if (agent?.ctx && typeof agent.ctx.effect === 'function') {
      try {
        entry.agentEffect = agent.ctx.effect(
          () => async () => {
            await this.closeEntry(key, entry)
          },
          'browser-use-native.session',
        )
      } catch (error) {
        this.ctx.logger?.warn?.(`browser-use-native: could not bind Agent cleanup: ${error}`)
      }
    }
    return entry
  }

  enqueue(agent, operation) {
    if (this.closed) return Promise.reject(new ToolError('The browser plugin is disposed.'))
    const entry = this.forAgent(agent)
    const run = entry.chain.then(async () => {
      if (entry.closed) throw new ToolError('Browser session is closed.')
      await entry.session.start()
      return operation(entry)
    })
    entry.chain = run.catch(() => {})
    return run
  }

  async closeEntry(key, entry) {
    if (!entry || entry.closed) return
    entry.closed = true
    if (this.sessions.get(key) === entry) this.sessions.delete(key)
    try {
      await entry.chain
    } catch {
      // The operation already reported its failure to its caller.
    }
    await entry.session.stop()
  }

  async stopAll() {
    if (this.closed) return
    this.closed = true
    const entries = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.allSettled(entries.map((entry) => this.closeEntry(entry.key, entry)))
  }

  cwdFor(agent) {
    try {
      const workingDirectory = this.ctx.get('workingDirectory')
      const session = agent?.session
      if (workingDirectory && session) return workingDirectory.get(session)
    } catch {
      // Fall back to the Host working directory.
    }
    return process.cwd()
  }

  resolvePath(agent, target) {
    const expanded = expandHome(target)
    if (isAbsolute(expanded)) return expanded
    return resolve(this.cwdFor(agent), expanded)
  }

  async attachImage(_agent, data, mediaType) {
    const attachments = this.ctx.get('attachments')
    if (!attachments) return null
    const [ref] = await attachments.saveImages([
      { data, mediaType, name: 'browser-screenshot' },
    ])
    return ref ?? null
  }
}

function registerTool(ctx, manager, spec) {
  return ctx.tools.register({
    name: `${TOOL_PREFIX}${spec.name}`,
    description: spec.description,
    parameters: spec.parameters,
    output: TEXT_OUTPUT,
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
      return manager.enqueue(exec.agent, (entry) => spec.run(entry.tools, input, exec))
    },
  })
}

/**
 * Mount the browser tools.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context with `tools`.
 * @param {Record<string, unknown>} [config] - Browser defaults; see README.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const manager = new BrowserManager(ctx, resolved)

  ctx.effect(() => () => manager.stopAll(), 'browser-use-native.sessions')

  ctx.effect(() => {
    const disposers = TOOL_SPECS.map((spec) => registerTool(ctx, manager, spec))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // The registry may already be tearing down.
        }
      }
    }
  }, 'browser-use-native.tools')

  ctx.inject(['systemPrompt'], (inner) => {
    inner.effect(
      () =>
        inner.systemPrompt.section({
          name: 'tool:browser',
          order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'),
          text: ({ scope }) =>
            inner.tools.get(`${TOOL_PREFIX}take_snapshot`, scope) === undefined ? '' : INSTRUCTIONS,
        }),
      'browser-use-native.instructions',
    )
  })
}
