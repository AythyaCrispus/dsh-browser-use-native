/**
 * Playwright-backed browser session and the 16 browser-use tools.
 *
 * This module is deliberately independent of the DSH plugin glue: the native
 * plugin passes per-agent path/attachment helpers, while the standalone
 * self-test can drive the same class directly.
 */

import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { mkdir, stat, writeFile } from 'node:fs/promises'

import { SCOPE_ATTR, UID_ATTR, applyUids, renderAxTree } from './snapshot.js'

export class ToolError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BrowserToolError'
  }
}

const KEY_ALIASES = new Map([
  ['enter', 'Enter'],
  ['return', 'Enter'],
  ['esc', 'Escape'],
  ['escape', 'Escape'],
  ['del', 'Delete'],
  ['delete', 'Delete'],
  ['backspace', 'Backspace'],
  ['tab', 'Tab'],
  ['space', 'Space'],
  ['left', 'ArrowLeft'],
  ['arrowleft', 'ArrowLeft'],
  ['right', 'ArrowRight'],
  ['arrowright', 'ArrowRight'],
  ['up', 'ArrowUp'],
  ['arrowup', 'ArrowUp'],
  ['down', 'ArrowDown'],
  ['arrowdown', 'ArrowDown'],
  ['pageup', 'PageUp'],
  ['pagedown', 'PageDown'],
  ['home', 'Home'],
  ['end', 'End'],
  ['ctrl', 'Control'],
  ['control', 'Control'],
  ['shift', 'Shift'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
  ['meta', 'Meta'],
  ['cmd', 'Meta'],
  ['command', 'Meta'],
])

const DIALOG_POLICIES = new Set(['manual', 'auto-dismiss', 'auto-accept'])

// A snapshot is an observation, not a dump: keep one call inside a sane token
// budget and let the caller scope or raise the limit explicitly.
const DEFAULT_SNAPSHOT_MAX_CHARS = 20000
const DEFAULT_SNAPSHOT_MAX_LINES = 1200

function positiveInteger(value, fallback, field) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) throw new ToolError(`${field} must be a positive integer.`)
  return number
}

function nonNegativeNumber(value, fallback, field) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new ToolError(`${field} must be a non-negative number.`)
  return number
}

function nonNegativeInteger(value, fallback, field) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) throw new ToolError(`${field} must be a non-negative integer.`)
  return number
}

function optionalPositiveInteger(value, field) {
  if (value === undefined || value === null) return null
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) throw new ToolError(`${field} must be a positive integer.`)
  return number
}

/**
 * Playwright puts the useful reason on indented ``- ...`` lines after the
 * generic timeout message. Keep those for the caller instead of replacing the
 * whole error with "target missing, covered, or detached".
 */
function playwrightDetails(error) {
  const text = error instanceof Error ? error.message : String(error)
  const details = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('- ')) continue
    const detail = trimmed.slice(2).trim()
    if (!detail || /^retrying\b/i.test(detail)) continue
    if (!details.includes(detail)) details.push(detail)
    if (details.length >= 3) break
  }
  return details
}

function errorSummary(error, uid, attempts = []) {
  const headline = firstLine(error)
  const details = playwrightDetails(error)
  const parts = []
  if (uid) parts.push(`uid '${uid}'`)
  parts.push(headline)
  if (details.length > 0) parts.push(`(${details.join('; ')})`)
  if (attempts.length > 0) parts.push(`Tried: ${attempts.join(', ')}.`)
  parts.push('The page may have changed; call take_snapshot and retry with a current uid.')
  return new ToolError(parts.join(' '))
}

function safeFilename(name, fallback = 'download') {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  if (!cleaned) return fallback
  return cleaned.length > 160 ? cleaned.slice(0, 160) : cleaned
}

function filenameFromDisposition(header) {
  if (!header) return null
  const extended = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header)
  if (extended) {
    let value = extended[1].trim().replace(/^"|"$/g, '')
    try {
      value = decodeURIComponent(value)
    } catch {
      // Keep the raw value.
    }
    return safeFilename(value)
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header)
  return plain ? safeFilename(plain[1].trim()) : null
}

function filenameFromUrl(url, contentType = '') {
  try {
    const parsed = new URL(url)
    const last = decodeURIComponent(parsed.pathname.split('/').pop() ?? '')
    if (last) return safeFilename(last)
  } catch {
    // data: and blob: URLs have no pathname.
  }
  if (contentType.includes('pdf')) return 'download.pdf'
  if (contentType.includes('json')) return 'download.json'
  if (contentType.includes('html')) return 'download.html'
  return 'download'
}

/** Normalize plugin config into a complete session configuration. */
export function resolveConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const headless = source.headless ?? true
  if (typeof headless !== 'boolean') throw new ToolError('headless must be a boolean.')

  const channel = source.channel === undefined ? 'chrome' : source.channel
  if (channel !== null && typeof channel !== 'string') throw new ToolError('channel must be a string or null.')

  const executablePath = source.executablePath ?? ''
  if (typeof executablePath !== 'string') throw new ToolError('executablePath must be a string.')

  const dialogPolicy = source.dialogPolicy ?? 'manual'
  if (!DIALOG_POLICIES.has(dialogPolicy)) {
    throw new ToolError(`dialogPolicy must be one of ${[...DIALOG_POLICIES].join(', ')}.`)
  }

  return Object.freeze({
    headless,
    channel: channel && channel.trim() ? channel.trim() : null,
    executablePath: executablePath.trim(),
    slowMo: nonNegativeNumber(source.slowMo, 0, 'slowMo'),
    viewportWidth: positiveInteger(source.viewportWidth, 1280, 'viewportWidth'),
    viewportHeight: positiveInteger(source.viewportHeight, 800, 'viewportHeight'),
    actionTimeoutMs: positiveInteger(source.actionTimeoutMs, 5000, 'actionTimeoutMs'),
    navigationTimeoutMs: positiveInteger(source.navigationTimeoutMs, 30000, 'navigationTimeoutMs'),
    dialogPolicy,
    dialogTimeoutMs: positiveInteger(source.dialogTimeoutMs, 5000, 'dialogTimeoutMs'),
  })
}

function firstLine(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.split(/\r?\n/)[0]?.trim() || 'unknown error'
}

function normalizeKey(key) {
  if (typeof key !== 'string' || key.trim() === '') throw new ToolError('key must not be empty.')
  if (key === '+') return '+'

  const parts = key.endsWith('++') ? [...key.slice(0, -2).split('+'), '+'] : key.split('+')
  const normalized = []
  for (const part of parts) {
    const token = part.trim()
    if (!token) continue
    normalized.push(KEY_ALIASES.get(token.toLowerCase()) ?? token)
  }
  if (normalized.length === 0) throw new ToolError(`Invalid key combination: ${JSON.stringify(key)}`)
  return normalized.join('+')
}

function logLine(level, logger, message) {
  const sink = logger?.[level]
  if (typeof sink === 'function') sink.call(logger, `browser-use-native: ${message}`)
}

/**
 * Launch Chromium, preferring an installed system browser over a bundled
 * Playwright download. No absolute executable path is baked into the plugin:
 * the operator may set ``channel``/``executablePath``, otherwise the common
 * channels are tried in order.
 */
async function launchChromium(chromium, config, logger) {
  const attempts = []
  const seen = new Set()
  const add = (options, label) => {
    const key = JSON.stringify(options)
    if (seen.has(key)) return
    seen.add(key)
    attempts.push({ options, label })
  }

  if (config.executablePath) add({ executablePath: config.executablePath }, `executablePath ${config.executablePath}`)
  if (config.channel) add({ channel: config.channel }, `channel ${config.channel}`)
  add({ channel: 'chrome' }, 'channel chrome')
  add({ channel: 'msedge' }, 'channel msedge')
  add({}, 'Playwright-managed Chromium')

  const failures = []
  for (const attempt of attempts) {
    try {
      const browser = await chromium.launch({
        headless: config.headless,
        slowMo: config.slowMo,
        args: ['--disable-blink-features=AutomationControlled'],
        ...attempt.options,
      })
      if (attempt.label !== `channel ${config.channel}` && attempt.label !== `executablePath ${config.executablePath}`) {
        logLine('info', logger, `launched ${attempt.label}`)
      }
      return browser
    } catch (error) {
      failures.push(`${attempt.label}: ${firstLine(error)}`)
    }
  }

  throw new ToolError(
    `Could not launch a Chromium browser. Tried ${attempts.length} option(s): ${failures.join(' | ')}. ` +
      'Install Chrome/Edge or set channel/executablePath in the plugin config.',
  )
}

/**
 * One browser instance for one live Agent, with its own page list, observation
 * buffers, dialog queue, and snapshot-scoped uid registry.
 */
export class BrowserSession {
  constructor(config, logger = undefined) {
    this.config = config
    this.logger = logger
    this._browser = null
    this._context = null
    this._pages = []
    this._selected = 0
    this._logs = new Map()
    this._dialogs = []
    this._uidMap = new Map()
    // uid history survives snapshots so unchanged elements keep the same uid;
    // it is cleared per frame on navigation and wholesale on page navigation.
    this._uidHistory = new Map()
    this._uidSequence = 0
    this._startPromise = null
    this._stopped = false
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    if (this._browser) return
    if (this._stopped) throw new ToolError('Browser session is closed.')
    if (this._startPromise) return this._startPromise

    this._startPromise = this._start()
    try {
      await this._startPromise
    } finally {
      this._startPromise = null
    }
  }

  async _start() {
    let chromium
    try {
      ;({ chromium } = await import('playwright-core'))
    } catch (error) {
      throw new ToolError(
        `playwright-core is not installed in this bundle: ${firstLine(error)}. ` +
          'Run "npm install" in the plugin directory and restart the plugin.',
      )
    }

    this._browser = await launchChromium(chromium, this.config, this.logger)
    this._context = await this._browser.newContext({
      viewport: { width: this.config.viewportWidth, height: this.config.viewportHeight },
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
    })
    this._context.on('page', (page) => this._wirePage(page))
    const page = await this._context.newPage()
    this._wirePage(page)
  }

  async stop() {
    if (this._stopped) return
    this._stopped = true
    this._dialogs.length = 0
    this._uidMap.clear()
    this._uidHistory.clear()
    const context = this._context
    const browser = this._browser
    this._context = null
    this._browser = null
    this._pages = []
    this._logs.clear()
    if (context) {
      try {
        await context.close()
      } catch {
        // Already gone.
      }
    }
    if (browser) {
      try {
        await browser.close()
      } catch {
        // Already gone.
      }
    }
  }

  // -------------------------------------------------------------------- pages

  _wirePage(page) {
    if (this._pages.includes(page)) return
    this._pages.push(page)
    this._logs.set(page, { console: [], archivedConsole: [], network: [], archivedNetwork: [] })

    page.on('console', (message) => this._onConsole(page, message))
    page.on('request', (request) => this._onRequest(page, request))
    page.on('response', (response) => this._onResponse(page, response))
    page.on('requestfailed', (request) => this._onRequestFailed(page, request))
    page.on('dialog', (dialog) => this._onDialog(page, dialog))
    page.on('close', () => this._onPageClosed(page))
    page.on('framenavigated', (frame) => this._onFrameNavigated(page, frame))
  }

  _livePages() {
    const pages = this._pages.filter((page) => !page.isClosed())
    this._pages = pages
    return pages
  }

  _onPageClosed(page) {
    const index = this._pages.indexOf(page)
    if (index >= 0) {
      this._pages.splice(index, 1)
      this._logs.delete(page)
      if (this._selected >= index) this._selected = Math.max(0, this._selected - 1)
    }
    try {
      for (const frame of page.frames()) this._forgetFrame(frame)
    } catch {
      // The page is already gone.
    }
    this._dialogs = this._dialogs.filter((entry) => !this._dialogStale(entry))
  }

  _onFrameNavigated(page, frame) {
    // A frame navigation replaces its document, so backend node ids and every
    // uid in that frame are stale even though the Frame object survives.
    this._forgetFrame(frame)
    if (frame !== page.mainFrame()) return
    const logs = this._logs.get(page)
    if (!logs) return
    logs.archivedConsole.push(...logs.console)
    logs.console.length = 0
    logs.archivedNetwork.push(...logs.network)
    logs.network.length = 0
  }

  _forgetFrame(frame) {
    this._uidHistory.delete(frame)
    for (const [uid, ref] of this._uidMap) {
      if (ref.frame === frame) this._uidMap.delete(uid)
    }
  }

  _onConsole(page, message) {
    const logs = this._logs.get(page)
    if (!logs) return
    const location = typeof message.location === 'function' ? message.location() : {}
    logs.console.push({
      type: message.type(),
      text: message.text(),
      url: location?.url ?? '',
      line: Number(location?.lineNumber ?? 0),
    })
  }

  _onRequest(page, request) {
    const logs = this._logs.get(page)
    if (!logs) return
    logs.network.push({
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
    })
  }

  _onResponse(page, response) {
    const logs = this._logs.get(page)
    if (!logs) return
    const request = response.request()
    for (let index = logs.network.length - 1; index >= 0; index -= 1) {
      const entry = logs.network[index]
      if (
        entry.method === request.method() &&
        entry.url === request.url() &&
        entry.status === undefined &&
        entry.failure === undefined
      ) {
        entry.status = response.status()
        return
      }
    }
    logs.network.push({
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      status: response.status(),
    })
  }

  _onRequestFailed(page, request) {
    const logs = this._logs.get(page)
    if (!logs) return
    const failure = request.failure()?.errorText ?? 'failed'
    for (let index = logs.network.length - 1; index >= 0; index -= 1) {
      const entry = logs.network[index]
      if (
        entry.method === request.method() &&
        entry.url === request.url() &&
        entry.status === undefined &&
        entry.failure === undefined
      ) {
        entry.failure = failure
        return
      }
    }
    logs.network.push({
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      failure,
    })
  }

  _selectedPage() {
    const pages = this._livePages()
    if (pages.length === 0) throw new ToolError('No open pages. This should not happen; restart the browser.')
    this._selected = Math.max(0, Math.min(this._selected, pages.length - 1))
    return pages[this._selected]
  }

  pageByIndex(pageIdx) {
    if (pageIdx === null || pageIdx === undefined) return this._selectedPage()
    const pages = this._livePages()
    if (!Number.isInteger(pageIdx) || pageIdx < 0 || pageIdx >= pages.length) {
      throw new ToolError(`Invalid pageIdx ${pageIdx}. Call list_pages to see open pages.`)
    }
    return pages[pageIdx]
  }

  async listPagesText() {
    const pages = this._livePages()
    if (pages.length === 0) return 'No open pages.'
    const selected = this._selectedPage()
    const lines = []
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index]
      const marker = page === selected ? ' [selected]' : ''
      lines.push(`${index}: "${await safeTitle(page)}" ${page.url()}${marker}`)
    }
    return lines.join('\n')
  }

  async selectPage(pageIdx) {
    const pages = this._livePages()
    if (!Number.isInteger(pageIdx) || pageIdx < 0 || pageIdx >= pages.length) {
      throw new ToolError(`Invalid pageIdx ${pageIdx}. Call list_pages to see open pages.`)
    }
    this._selected = pageIdx
    const page = pages[pageIdx]
    return `Selected page ${pageIdx}: "${await safeTitle(page)}" ${page.url()}`
  }

  // ------------------------------------------------------------------ dialogs

  _onDialog(page, dialog) {
    const entry = { dialog, page }
    this._dialogs.push(entry)
    const delay = this.config.dialogPolicy === 'manual' ? this.config.dialogTimeoutMs : 0
    const timer = setTimeout(() => {
      void this._settleDialog(entry)
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
  }

  async _settleDialog(entry) {
    const index = this._dialogs.indexOf(entry)
    if (index < 0) return
    this._dialogs.splice(index, 1)
    try {
      if (this.config.dialogPolicy === 'auto-accept') await entry.dialog.accept()
      else await entry.dialog.dismiss()
    } catch {
      // The page may already be gone.
    }
  }

  _dialogStale(entry) {
    try {
      return entry.page.isClosed()
    } catch {
      return true
    }
  }

  guardDialog() {
    this._dialogs = this._dialogs.filter((entry) => !this._dialogStale(entry))
    if (this._dialogs.length === 0) return
    const entry = this._dialogs[this._dialogs.length - 1]
    const message = String(entry.dialog.message()).replace(/\s+/g, ' ').trim()
    throw new ToolError(
      `A ${entry.dialog.type()} dialog is open: "${message}". ` +
        'Call handle_dialog (accept or dismiss) before any other page action.',
    )
  }

  async handleDialog(action, promptText) {
    this._dialogs = this._dialogs.filter((entry) => !this._dialogStale(entry))
    if (this._dialogs.length === 0) return 'No dialog is currently open.'
    const entry = this._dialogs.pop()
    try {
      if (action === 'accept') {
        if (promptText !== null && promptText !== undefined) await entry.dialog.accept(promptText)
        else await entry.dialog.accept()
        return `Accepted the ${entry.dialog.type()} dialog: "${entry.dialog.message()}"`
      }
      await entry.dialog.dismiss()
      return `Dismissed the ${entry.dialog.type()} dialog: "${entry.dialog.message()}"`
    } catch (error) {
      throw new ToolError(`Failed to handle dialog: ${firstLine(error)}`)
    }
  }

  // --------------------------------------------------------------------- uids

  async newCdpSession(target) {
    if (!this._context) throw new ToolError('Browser session is not started.')
    return this._context.newCDPSession(target)
  }

  invalidateUids() {
    // Called after a page-level navigation. Frame-level navigations are
    // handled by _forgetFrame, which keeps other frames' uids usable.
    this._uidMap.clear()
    this._uidHistory.clear()
  }

  _allocateUid(frame, backendNodeId, frameIndex) {
    let history = this._uidHistory.get(frame)
    if (!history) {
      history = new Map()
      this._uidHistory.set(frame, history)
    }
    const key = Number(backendNodeId)
    const existing = history.get(key)
    if (existing) return existing
    // The sequence is session-global, so a reused uid can never point at a
    // different element even when frames come and go.
    const uid = `${frameIndex}_${this._uidSequence}`
    this._uidSequence += 1
    history.set(key, uid)
    return uid
  }

  locate(uid) {
    const ref = this._uidMap.get(uid)
    if (!ref) {
      throw new ToolError(
        `Unknown uid '${uid}'. uids belong to elements observed by a snapshot; ` +
          'call take_snapshot and use a uid from its output.',
      )
    }
    if (ref.frame.isDetached()) throw new ToolError(`uid '${uid}' belongs to a detached frame. Call take_snapshot again.`)
    return ref.frame.locator(ref.selector).first()
  }

  uidRef(uid) {
    const ref = this._uidMap.get(uid)
    if (!ref) {
      throw new ToolError(
        `Unknown uid '${uid}'. uids belong to elements observed by a snapshot; ` +
          'call take_snapshot and use a uid from its output.',
      )
    }
    return ref
  }

  describeUid(uid) {
    const ref = this._uidMap.get(uid)
    if (!ref) return uid
    const label = ref.name ? `${ref.role} "${ref.name}"` : ref.role
    return `${uid} (${label})`
  }

  /** Look up a uid by role/name; used by tests and power users. */
  findUid(role = null, name = null) {
    for (const [uid, ref] of this._uidMap) {
      if (role !== null && ref.role !== role) continue
      if (name !== null && !ref.name.toLowerCase().includes(name.toLowerCase())) continue
      return uid
    }
    return null
  }

  // ----------------------------------------------------------------- snapshot

  /**
   * Render the accessibility tree as text.
   *
   * Uids are allocated per DOM node and reused across snapshots. A scoped
   * snapshot (``selector`` / ``uid``) only renders that container, which is
   * how a caller avoids dumping a 200-checkbox sidebar into the context.
   */
  async takeSnapshot(options = {}) {
    this.guardDialog()
    const page = this._selectedPage()
    const opts =
      options && typeof options === 'object' && !Array.isArray(options)
        ? options
        : { verbose: Boolean(options) }
    const verbose = Boolean(opts.verbose)
    const maxDepth = opts.maxDepth === undefined || opts.maxDepth === null
      ? null
      : nonNegativeInteger(opts.maxDepth, null, 'maxDepth')
    const maxLines = nonNegativeInteger(opts.maxLines, DEFAULT_SNAPSHOT_MAX_LINES, 'maxLines')
    const maxChars = nonNegativeInteger(opts.maxChars, DEFAULT_SNAPSHOT_MAX_CHARS, 'maxChars')
    const includeFrames = opts.includeFrames !== false
    const selector =
      typeof opts.selector === 'string' && opts.selector.trim() ? opts.selector.trim() : null
    const scopeUid =
      typeof opts.uid === 'string' && opts.uid.trim() ? opts.uid.trim() : null
    if (selector && scopeUid) throw new ToolError('Pass either selector or uid, not both.')

    const allFrames = page.frames()
    let frames = includeFrames ? [...allFrames] : [page.mainFrame()]
    let scopeBackendNodeIds = null
    let scopeLine = null
    let markedFrames = []

    const title = await safeTitle(page)
    const blocks = ['# Latest page snapshot', `url: ${page.url()}`, `title: ${title}`]
    const snapshots = []
    let uidTotal = 0

    let pageCdp = null
    try {
      pageCdp = await this.newCdpSession(page)
    } catch {
      pageCdp = null
    }

    try {
      if (scopeUid) {
        const ref = this.uidRef(scopeUid)
        if (!ref.backendNodeId) {
          throw new ToolError(`uid '${scopeUid}' has no DOM backend node; take a fresh snapshot and retry.`)
        }
        scopeBackendNodeIds = new Set([Number(ref.backendNodeId)])
        frames = [ref.frame]
        const label = ref.name ? `${ref.role} "${ref.name}"` : ref.role
        scopeLine = `scope: uid=${scopeUid} (${label})`
      } else if (selector) {
        if (!pageCdp) throw new ToolError('Selector-scoped snapshots require a page CDP session, which is unavailable.')
        const marked = await this._markScope(selector, frames)
        markedFrames = marked.frames
        if (markedFrames.length === 0) {
          throw new ToolError(
            `selector ${JSON.stringify(selector)} matched no element in ${frames.length} frame(s). ` +
              'Use a CSS selector that exists on the page, or scope with a container uid.',
          )
        }
        scopeBackendNodeIds = await this._scopeBackendIds(pageCdp, marked.token, markedFrames)
        if (scopeBackendNodeIds.size === 0) {
          throw new ToolError(
            `selector ${JSON.stringify(selector)} matched an element, but its DOM node could not be resolved.`,
          )
        }
        frames = frames.filter((frame) => markedFrames.includes(frame))
        scopeLine = `scope: selector ${JSON.stringify(selector)}`
      }

      if (scopeLine) blocks.push(scopeLine)
      blocks.push('')

      const frameIds = pageCdp ? await this._frameIdsForPage(pageCdp, page) : []
      let matchedScopeRoots = 0

      for (const frame of frames) {
        const frameIndex = allFrames.indexOf(frame)
        const ordinal = frameIndex >= 0 ? frameIndex : 0
        let cdp = null
        let ownSession = false
        let params = {}
        let rendered
        try {
          try {
            cdp = await this.newCdpSession(frame)
            ownSession = true
          } catch (error) {
            const frameId = frameIndex < frameIds.length ? frameIds[frameIndex] : null
            if (!pageCdp || !frameId) throw error
            cdp = pageCdp
            params = { frameId }
          }

          const axTree = await cdp.send('Accessibility.getFullAXTree', params)
          rendered = renderAxTree(axTree?.nodes ?? [], ordinal, {
            verbose,
            maxDepth,
            rootBackendNodeIds: scopeBackendNodeIds,
            allocateUid: (backendNodeId) => this._allocateUid(frame, backendNodeId, ordinal),
          })
          if (scopeBackendNodeIds && !rendered.rootFound) continue
          await applyUids(cdp, rendered.targets)
        } catch (error) {
          blocks.push(`# frame ${ordinal} unavailable: ${firstLine(error)}`)
          continue
        } finally {
          if (ownSession && cdp) {
            try {
              await cdp.detach()
            } catch {
              // Already detached.
            }
          }
        }

        if (scopeBackendNodeIds) matchedScopeRoots += 1
        snapshots.push({ frame, frameIndex: ordinal, rendered })
        uidTotal += rendered.targets.length
        for (const target of rendered.targets) {
          this._uidMap.set(target.uid, {
            frame,
            selector: `[${UID_ATTR}="${target.uid}"]`,
            backendNodeId: target.backendNodeId,
            role: target.role,
            name: target.name,
          })
        }
      }

      if (scopeBackendNodeIds && matchedScopeRoots === 0) {
        throw new ToolError(
          'The scoped element exists in the DOM but has no accessibility node. ' +
            'It may be hidden; scope a visible container instead.',
        )
      }

      for (const entry of snapshots) {
        if (entry.frameIndex > 0) blocks.push(`# frame ${entry.frameIndex}: ${entry.frame.url()}`)
        blocks.push(...entry.rendered.lines)
        if (entry.rendered.truncatedByDepth) {
          blocks.push(`# frame ${entry.frameIndex}: maxDepth ${maxDepth} reached; deeper nodes omitted`)
        }
      }
    } finally {
      if (markedFrames.length > 0) await this._clearScope(markedFrames)
      if (pageCdp) {
        try {
          await pageCdp.detach()
        } catch {
          // Already detached.
        }
      }
    }

    if (snapshots.length === 0 || snapshots.every((entry) => entry.rendered.lines.length === 0)) {
      blocks.push('(empty page: no accessible content)')
    }
    if (uidTotal === 0) {
      blocks.push(
        '(no uid elements found; the page may still be loading, or the scoped container has no actionable nodes.)',
      )
    }

    let text = blocks.join('\n')
    const totalLines = text.split('\n').length
    if (maxLines > 0 && totalLines > maxLines) {
      const lines = text.split('\n').slice(0, maxLines)
      lines.push(
        `... (snapshot truncated: ${maxLines} of ${totalLines} lines shown; ` +
          'scope it with selector/uid or raise maxLines)',
      )
      text = lines.join('\n')
    }
    const totalChars = text.length
    if (maxChars > 0 && text.length > maxChars) {
      const note =
        `\n... (snapshot truncated at ${maxChars} of ${totalChars} characters; ` +
        'scope it with selector/uid to focus, or raise maxChars)'
      const room = Math.max(0, maxChars - note.length)
      const cut = text.slice(0, room)
      const boundary = cut.lastIndexOf('\n')
      text = `${boundary > 0 ? cut.slice(0, boundary) : cut}${note}`
    }

    return { text, uidCount: uidTotal, url: page.url(), title, truncated: text.includes('... (snapshot truncated') }
  }

  /**
   * Mark the element matched by ``selector`` in every frame. A temporary
   * attribute survives until the CDP DOM lookup resolves it to a backend
   * node id and is removed in the snapshot's finally block.
   */
  async _markScope(selector, frames) {
    const token = `ba${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const markedFrames = []
    for (const frame of frames) {
      try {
        await frame.evaluate((attribute) => {
          for (const element of document.querySelectorAll(`[${attribute}]`)) element.removeAttribute(attribute)
        }, SCOPE_ATTR)
        const locator = frame.locator(selector).first()
        if ((await locator.count()) === 0) continue
        await locator.evaluate(
          (element, argument) => element.setAttribute(argument.attribute, argument.token),
          { attribute: SCOPE_ATTR, token },
        )
        markedFrames.push(frame)
      } catch {
        // A selector that cannot run in this frame simply does not match it.
      }
    }
    return { token, frames: markedFrames }
  }

  /** Resolve temporary scope markers to backend node ids (including iframes). */
  async _scopeBackendIds(pageCdp, token, frames = []) {
    const ids = new Set()
    const walk = (node) => {
      const attributes = node?.attributes ?? []
      for (let index = 0; index < attributes.length; index += 2) {
        if (attributes[index] === SCOPE_ATTR && attributes[index + 1] === token) {
          if (node.backendNodeId) ids.add(Number(node.backendNodeId))
          break
        }
      }
      for (const child of node?.children ?? []) walk(child)
      for (const shadowRoot of node?.shadowRoots ?? []) walk(shadowRoot)
      if (node?.contentDocument) walk(node.contentDocument)
    }

    try {
      const document = await pageCdp.send('DOM.getDocument', { depth: -1, pierce: true })
      walk(document?.root)
    } catch (error) {
      throw new ToolError(`Could not read the DOM for selector scoping: ${firstLine(error)}`)
    }

    // page-level DOM.getDocument pierces same-process frames only; OOPIFs need
    // their own session to resolve the marker.
    for (const frame of frames) {
      let cdp = null
      try {
        cdp = await this.newCdpSession(frame)
        const document = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
        walk(document?.root)
      } catch {
        // Same-process frames have no separate session; the page walk above
        // already covered them.
      } finally {
        if (cdp) {
          try {
            await cdp.detach()
          } catch {
            // Already detached.
          }
        }
      }
    }
    return ids
  }

  async _clearScope(frames) {
    for (const frame of frames) {
      try {
        await frame.evaluate((attribute) => {
          for (const element of document.querySelectorAll(`[${attribute}]`)) element.removeAttribute(attribute)
        }, SCOPE_ATTR)
      } catch {
        // Detached frames have nothing to clean.
      }
    }
  }

  async _frameIdsForPage(pageCdp, page) {
    let tree
    try {
      tree = await pageCdp.send('Page.getFrameTree')
    } catch {
      return []
    }

    const ordered = []
    const walk = (node) => {
      const info = node?.frame
      if (info?.id) ordered.push(info)
      for (const child of node?.childFrames ?? []) walk(child)
    }
    walk(tree?.frameTree ?? {})

    const frames = page.frames()
    const ids = new Array(frames.length).fill(null)
    const remaining = [...ordered]

    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index]
      const matchIndex = remaining.findIndex(
        (info) => info.url === frame.url() && (info.name ?? '') === frame.name(),
      )
      if (matchIndex >= 0) {
        ids[index] = remaining[matchIndex].id
        remaining.splice(matchIndex, 1)
      }
    }

    for (let index = 0; index < frames.length; index += 1) {
      if (ids[index] === null && remaining.length > 0) ids[index] = remaining.shift().id
    }
    return ids
  }

  // --------------------------------------------------------------- observation

  consoleMessages(pageIdx, types, pageSize, includePreserved) {
    const page = this.pageByIndex(pageIdx)
    const logs = this._logs.get(page)
    if (!logs) return 'No console messages.'
    let entries = [...logs.console]
    if (includePreserved) entries = [...logs.archivedConsole, ...entries]
    if (types && types.length > 0) {
      const allowed = new Set(types.map((type) => String(type).toLowerCase()))
      entries = entries.filter((entry) => allowed.has(entry.type.toLowerCase()))
    }
    if (pageSize) entries = entries.slice(-pageSize)
    if (entries.length === 0) return 'No console messages.'
    return entries
      .map((entry) => {
        const location = entry.url ? ` (${entry.url}:${entry.line})` : ''
        return `[${entry.type}] ${entry.text}${location}`
      })
      .join('\n')
  }

  networkRequests(pageIdx, resourceTypes, pageSize, includePreserved) {
    const page = this.pageByIndex(pageIdx)
    const logs = this._logs.get(page)
    if (!logs) return 'No network requests.'
    let entries = [...logs.network]
    if (includePreserved) entries = [...logs.archivedNetwork, ...entries]
    if (resourceTypes && resourceTypes.length > 0) {
      const allowed = new Set(resourceTypes.map((type) => String(type).toLowerCase()))
      entries = entries.filter((entry) => allowed.has(entry.resourceType.toLowerCase()))
    }
    if (pageSize) entries = entries.slice(-pageSize)
    if (entries.length === 0) return 'No network requests.'
    return entries
      .map((entry) => {
        const status = entry.status === undefined ? 'failed' : String(entry.status)
        const suffix = entry.resourceType ? ` (${entry.resourceType})` : ''
        const failure = entry.failure ? ` - ${entry.failure}` : ''
        return `[${status}] ${entry.method} ${entry.url}${suffix}${failure}`
      })
      .join('\n')
  }
}

async function safeTitle(page) {
  try {
    return await page.title()
  } catch {
    return ''
  }
}

function resolveUserPath(target) {
  const text = String(target)
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

async function ensureParentDir(target) {
  await mkdir(dirname(target), { recursive: true })
}

function safeJson(value) {
  try {
    const serialized = JSON.stringify(
      value,
      (_key, item) => (typeof item === 'bigint' ? item.toString() : item),
      2,
    )
    return serialized === undefined ? String(value) : serialized
  } catch {
    return String(value)
  }
}

/**
 * The tool surface. One method per browser-use tool; return values are plain
 * JSON objects so the DSH plugin can project them as text and images.
 */
export class BrowserTools {
  constructor(session, options = {}) {
    this.session = session
    this.resolvePath = options.resolvePath ?? ((target) => resolve(resolveUserPath(target)))
    this.attachImage = options.attachImage ?? (async () => null)
  }

  _path(target) {
    const resolved = this.resolvePath(resolveUserPath(target))
    return isAbsolute(resolved) ? resolved : resolve(resolved)
  }

  async _locator(uid) {
    const locator = this.session.locate(uid)
    let count
    try {
      count = await locator.count()
    } catch (error) {
      throw errorSummary(error, uid)
    }
    if (count === 0) {
      throw new ToolError(
        `uid '${uid}' no longer matches an element; the page changed since that uid was observed. ` +
          'Call take_snapshot again and use a current uid.',
      )
    }
    return locator
  }

  /**
   * Click with progressively more aggressive fallbacks. Element UI and other
   * component libraries frequently cover the real <input> with a styled
   * sibling or render duplicate responsive DOM, so a plain accessibility
   * click is not enough.
   */
  async _clickElement(uid, locator, dblClick, timeout) {
    const failures = []
    const record = (label, error) => {
      const detail = playwrightDetails(error)[0] ?? firstLine(error)
      failures.push(`${label}: ${detail}`)
    }

    try {
      if (dblClick) await locator.dblclick({ timeout })
      else await locator.click({ timeout })
      return { method: 'normal' }
    } catch (error) {
      record('normal click', error)
    }

    try {
      await locator.scrollIntoViewIfNeeded({ timeout: Math.min(timeout, 2000) })
    } catch {
      // Scrolling is best effort; the click fallbacks still run.
    }

    // A forced click still dispatches at the element's center; if another
    // element owns that point the click goes to the overlay, not this node.
    if (await this._isHitTarget(locator)) {
      try {
        if (dblClick) await locator.dblclick({ timeout, force: true })
        else await locator.click({ timeout, force: true })
        return { method: 'forced click' }
      } catch (error) {
        record('forced click', error)
      }
    } else {
      failures.push('forced click: the element center is covered by another element')
    }

    const label = await this._labelHandle(locator)
    if (label) {
      try {
        await label.click({ timeout, force: true })
        return { method: 'label click' }
      } catch (error) {
        record('label click', error)
      } finally {
        await label.dispose().catch(() => {})
      }
    }

    try {
      await locator.evaluate((element, double) => {
        try {
          element.scrollIntoView({ block: 'center', inline: 'center' })
        } catch {
          // Ignore scroll failures.
        }
        if (typeof element.focus === 'function') {
          try {
            element.focus({ preventScroll: true })
          } catch {
            element.focus()
          }
        }
        if (double) {
          const base = { bubbles: true, cancelable: true, view: window }
          element.dispatchEvent(new MouseEvent('click', { ...base, detail: 1 }))
          element.dispatchEvent(new MouseEvent('click', { ...base, detail: 2 }))
          element.dispatchEvent(new MouseEvent('dblclick', { ...base, detail: 2 }))
        } else if (typeof element.click === 'function') {
          element.click()
        } else {
          element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
        }
      }, dblClick)
      return { method: 'script click' }
    } catch (error) {
      record('script click', error)
    }

    throw new ToolError(
      `Could not click uid '${uid}': ${failures.join(' | ')}. ` +
        'The element may be covered, disabled, or detached; call take_snapshot and retry.',
    )
  }

  async _isHitTarget(locator) {
    try {
      return await locator.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return false
        const x = rect.left + rect.width / 2
        const y = rect.top + rect.height / 2
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false
        const hit = document.elementFromPoint(x, y)
        if (!hit) return false
        if (hit === element || element.contains(hit)) return true
        const label = element.closest?.('label')
        return Boolean(label && (hit === label || label.contains(hit)))
      })
    } catch {
      return true
    }
  }

  async _labelHandle(locator) {
    try {
      const handle = await locator.evaluateHandle((element) => {
        if (!(element instanceof HTMLInputElement)) return null
        if (element.type !== 'checkbox' && element.type !== 'radio') return null
        return element.labels?.[0] ?? element.closest('label') ?? null
      })
      const element = handle.asElement()
      if (element) return element
      await handle.dispose().catch(() => {})
      return null
    } catch {
      return null
    }
  }

  async _selectOption(locator, value, timeout) {
    try {
      await locator.selectOption(value, { timeout })
      return
    } catch {
      // Fall through to label matching.
    }
    try {
      await locator.selectOption({ label: value }, { timeout })
      return
    } catch {
      // Fall through to a script-level value assignment.
    }
    try {
      await locator.evaluate((element, wanted) => {
        const option = [...element.options].find(
          (candidate) =>
            candidate.value === wanted ||
            candidate.label === wanted ||
            candidate.textContent.trim() === wanted,
        )
        if (!option) throw new Error(`No <option> matches ${JSON.stringify(wanted)}.`)
        element.value = option.value
        element.dispatchEvent(new Event('input', { bubbles: true }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
      }, value)
    } catch (error) {
      throw new ToolError(
        `Could not select ${JSON.stringify(value)}: ${playwrightDetails(error)[0] ?? firstLine(error)}`,
      )
    }
  }

  async _setChecked(locator, desired, timeout) {
    try {
      if (desired) await locator.check({ timeout })
      else await locator.uncheck({ timeout })
    } catch (firstError) {
      const label = await this._labelHandle(locator)
      if (label) {
        try {
          await label.click({ timeout, force: true })
        } catch {
          // Fall through to the DOM-level toggle.
        } finally {
          await label.dispose().catch(() => {})
        }
      }
      let checked = null
      try {
        checked = await locator.isChecked()
      } catch {
        checked = null
      }
      if (checked !== desired) {
        try {
          await locator.evaluate((element, wanted) => {
            if (element.checked === wanted) return
            element.click()
            if (element.checked !== wanted) {
              element.checked = wanted
              element.dispatchEvent(new Event('input', { bubbles: true }))
              element.dispatchEvent(new Event('change', { bubbles: true }))
            }
          }, desired)
        } catch {
          throw errorSummary(firstError, null, ['check/uncheck', 'label click', 'script toggle'])
        }
      }
    }

    let checked = null
    try {
      checked = await locator.isChecked()
    } catch {
      checked = null
    }
    if (checked !== null && checked !== desired) {
      throw new ToolError(
        `The control did not become ${desired ? 'checked' : 'unchecked'}; ` +
          'it may be disabled or controlled by the page.',
      )
    }
  }

  async _fillText(locator, value, timeout) {
    try {
      await locator.fill(value, { timeout })
      return
    } catch (firstError) {
      try {
        await locator.fill(value, { timeout, force: true })
        return
      } catch {
        // Fall through to keyboard input after a forced focus.
      }
      try {
        await locator.click({ timeout, force: true })
        const page = this.session.pageByIndex(null)
        await page.keyboard.press('Control+A')
        await page.keyboard.type(value)
      } catch {
        throw errorSummary(firstError, null, ['fill', 'forced fill', 'click + type'])
      }
    }
  }

  // ------------------------------------------------------------------ actions

  async click(uid, dblClick = false) {
    this.session.guardDialog()
    const locator = await this._locator(uid)
    const timeout = this.session.config.actionTimeoutMs
    const result = await this._clickElement(uid, locator, dblClick, timeout)
    const suffix = result.method === 'normal' ? '' : ` (${result.method})`
    return {
      text: `${dblClick ? 'Double-clicked' : 'Clicked'} ${this.session.describeUid(uid)}${suffix}.`,
    }
  }

  async fill(uid, value) {
    this.session.guardDialog()
    const locator = await this._locator(uid)
    const timeout = this.session.config.actionTimeoutMs
    let detail
    try {
      detail = await locator.evaluate((element) => ({
        tag: element.tagName,
        type: element.getAttribute('type') ?? '',
        checked: Boolean(element.checked),
      }))
    } catch (error) {
      throw errorSummary(error, uid)
    }
    const tag = String(detail?.tag ?? '').toUpperCase()
    const inputType = String(detail?.type ?? '').toLowerCase()

    try {
      if (tag === 'SELECT') {
        await this._selectOption(locator, value, timeout)
      } else if (tag === 'INPUT' && (inputType === 'checkbox' || inputType === 'radio')) {
        const desired = ['true', '1', 'yes', 'on', 'checked'].includes(String(value).trim().toLowerCase())
        await this._setChecked(locator, desired, timeout)
      } else {
        await this._fillText(locator, value, timeout)
      }
    } catch (error) {
      throw errorSummary(error, uid)
    }

    if (tag === 'INPUT' && (inputType === 'checkbox' || inputType === 'radio')) {
      const desired = ['true', '1', 'yes', 'on', 'checked'].includes(String(value).trim().toLowerCase())
      return {
        text: `Set ${this.session.describeUid(uid)} to ${desired ? 'checked' : 'unchecked'}.`,
      }
    }
    return { text: `Filled ${this.session.describeUid(uid)} with ${JSON.stringify(value)}.` }
  }

  async hover(uid) {
    this.session.guardDialog()
    const locator = await this._locator(uid)
    const timeout = this.session.config.actionTimeoutMs
    try {
      await locator.hover({ timeout })
    } catch (firstError) {
      try {
        await locator.scrollIntoViewIfNeeded({ timeout: Math.min(timeout, 2000) })
        await locator.hover({ timeout, force: true })
      } catch {
        throw errorSummary(firstError, uid, ['normal hover', 'forced hover'])
      }
    }
    return { text: `Hovered over ${this.session.describeUid(uid)}.` }
  }

  async drag(fromUid, toUid) {
    this.session.guardDialog()
    const source = await this._locator(fromUid)
    const target = await this._locator(toUid)
    try {
      await source.dragTo(target, { timeout: this.session.config.actionTimeoutMs })
    } catch (error) {
      throw errorSummary(error, fromUid)
    }
    return {
      text: `Dragged ${this.session.describeUid(fromUid)} onto ${this.session.describeUid(toUid)}.`,
    }
  }

  async pressKey(key) {
    this.session.guardDialog()
    const normalized = normalizeKey(key)
    const page = this.session.pageByIndex(null)
    try {
      await page.keyboard.press(normalized)
    } catch (error) {
      throw new ToolError(`Failed to press ${JSON.stringify(key)}: ${firstLine(error)}`)
    }
    return { text: `Pressed ${normalized}.` }
  }

  async uploadFile(uid, filePath) {
    this.session.guardDialog()
    const target = this._path(filePath)
    const info = await stat(target).catch(() => null)
    if (!info || !info.isFile()) throw new ToolError(`File not found: ${filePath}`)

    const locator = await this._locator(uid)
    const page = this.session.pageByIndex(null)
    const timeout = this.session.config.actionTimeoutMs
    try {
      const tag = String((await locator.evaluate((element) => element.tagName)) ?? '').toUpperCase()
      const inputType = String((await locator.getAttribute('type')) ?? '').toLowerCase()
      if (tag === 'INPUT' && inputType === 'file') {
        await locator.setInputFiles(target, { timeout })
      } else {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout }),
          locator.click({ timeout }),
        ])
        await chooser.setFiles(target)
      }
    } catch (error) {
      throw errorSummary(error, uid)
    }
    return { text: `Uploaded ${JSON.stringify(target)} through ${this.session.describeUid(uid)}.` }
  }

  /**
   * Download a URL (sharing the browser's cookies) or click an element and
   * capture the resulting browser download. This replaces the "extract a
   * signed URL from an iframe and fetch it with another tool" workaround.
   */
  async download(options = {}) {
    this.session.guardDialog()
    const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {}
    const url = typeof opts.url === 'string' && opts.url.trim() ? opts.url.trim() : null
    const uid = typeof opts.uid === 'string' && opts.uid.trim() ? opts.uid.trim() : null
    const filePath = typeof opts.filePath === 'string' && opts.filePath.trim() ? opts.filePath : null
    const timeout = optionalPositiveInteger(opts.timeout, 'timeout') ?? this.session.config.navigationTimeoutMs
    if (!url && !uid) throw new ToolError('Pass url or uid (or both) to download.')
    const page = this.session.pageByIndex(null)
    if (uid) return this._downloadViaClick(page, uid, filePath, timeout)
    return this._downloadUrl(page, url, filePath, timeout)
  }

  async _downloadViaClick(page, uid, filePath, timeout) {
    const locator = await this._locator(uid)
    let href = ''
    try {
      href = String(
        (await locator.evaluate((element) => {
          const anchor = element.closest?.('a')
          if (anchor?.href) return anchor.href
          return element.href ?? ''
        })) ?? '',
      )
    } catch {
      href = ''
    }

    const downloadPromise = page.waitForEvent('download', { timeout }).catch(() => null)
    let clickError = null
    try {
      await this._clickElement(uid, locator, false, Math.min(timeout, this.session.config.actionTimeoutMs * 2))
    } catch (error) {
      clickError = error
    }
    // If the click itself failed, give the browser a short grace period to
    // emit a download instead of blocking for the full navigation timeout.
    const download = clickError
      ? await Promise.race([
          downloadPromise,
          new Promise((done) => {
            const timer = setTimeout(() => done(null), 3000)
            if (typeof timer.unref === 'function') timer.unref()
          }),
        ])
      : await downloadPromise
    if (download) {
      const failure = await download.failure().catch(() => null)
      if (failure) throw new ToolError(`The browser download failed: ${failure}`)
      const suggested = safeFilename(download.suggestedFilename() || 'download')
      const target = await this._destination(filePath, suggested)
      await ensureParentDir(target)
      await download.saveAs(target)
      const info = await stat(target).catch(() => null)
      return {
        text:
          `Downloaded ${JSON.stringify(suggested)}` +
          `${info ? ` (${info.size} bytes)` : ''} through ${this.session.describeUid(uid)} -> ${target}`,
      }
    }

    if (href) {
      const result = await this._downloadUrl(page, href, filePath, timeout)
      return { text: `${result.text} (the click did not emit a download event; fetched the link target instead)` }
    }
    if (clickError) throw clickError
    throw new ToolError(
      `Clicking uid '${uid}' did not produce a download event and the element has no href. ` +
        'If the page opens a viewer, pass the file url to download instead.',
    )
  }

  async _downloadUrl(page, rawUrl, filePath, timeout, note = '') {
    let url
    try {
      url = new URL(rawUrl, page.url()).toString()
    } catch {
      throw new ToolError(`Invalid download url: ${JSON.stringify(rawUrl)}`)
    }

    if (url.startsWith('data:')) {
      const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url)
      if (!match) throw new ToolError('Malformed data: URL.')
      const contentType = match[1] || 'application/octet-stream'
      const buffer = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8')
      const target = await this._destination(filePath, filenameFromUrl(url, contentType))
      await ensureParentDir(target)
      await writeFile(target, buffer)
      return { text: `Saved data: URL (${buffer.length} bytes, ${contentType}) -> ${target}` }
    }

    if (url.startsWith('blob:')) {
      const blob = await this._fetchInPage(page, url)
      const target = await this._destination(filePath, filenameFromUrl(url, blob.contentType))
      await ensureParentDir(target)
      await writeFile(target, blob.buffer)
      return { text: `Saved blob (${blob.buffer.length} bytes, ${blob.contentType || 'unknown type'}) -> ${target}` }
    }

    let status = null
    let contentType = ''
    let disposition = null
    let finalUrl = url
    let buffer = null
    let via = 'browser request'

    try {
      const response = await page.context().request.get(url, {
        timeout,
        failOnStatusCode: false,
        headers: {
          referer: page.url(),
          accept: '*/*',
        },
      })
      status = response.status()
      finalUrl = response.url() || url
      const headers = response.headers()
      contentType = headers['content-type'] ?? ''
      disposition = headers['content-disposition'] ?? null
      if (status < 400) buffer = await response.body()
    } catch {
      // Some signed URLs reject a detached request but work from the page
      // context; fall through to an in-page fetch.
    }

    if (!buffer) {
      const fetched = await this._fetchInPage(page, url)
      buffer = fetched.buffer
      contentType = contentType || fetched.contentType
      disposition = disposition || fetched.disposition
      status = fetched.status
      via = 'page fetch'
    }

    if (status !== null && status >= 400) {
      throw new ToolError(
        `Download failed with HTTP ${status} for ${url}. The URL may be expired or require a click/session.`,
      )
    }

    const suggested =
      filenameFromDisposition(disposition) || filenameFromUrl(finalUrl, contentType) || safeFilename(basename(new URL(finalUrl).pathname))
    const target = await this._destination(filePath, suggested)
    await ensureParentDir(target)
    await writeFile(target, buffer)
    const type = contentType || 'unknown type'
    return {
      text:
        `Downloaded ${JSON.stringify(suggested)} (${buffer.length} bytes, ${type}` +
        `${status === null ? '' : `, HTTP ${status}`}, via ${via}) -> ${target}` +
        `${note ? ` ${note}` : ''}`,
    }
  }

  async _fetchInPage(page, url) {
    const result = await page.evaluate(async (target) => {
      const response = await fetch(target, { credentials: 'include' })
      const bytes = new Uint8Array(await response.arrayBuffer())
      let binary = ''
      const chunk = 0x8000
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
      }
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        disposition: response.headers.get('content-disposition'),
        base64: btoa(binary),
      }
    }, url)
    return {
      status: result?.status ?? null,
      contentType: result?.contentType ?? '',
      disposition: result?.disposition ?? null,
      buffer: Buffer.from(result?.base64 ?? '', 'base64'),
    }
  }

  async _destination(filePath, suggestedName) {
    const name = safeFilename(suggestedName || 'download')
    if (!filePath) return this._path(join('downloads', name))
    const target = this._path(filePath)
    let info = null
    try {
      info = await stat(target)
    } catch {
      info = null
    }
    if (info?.isDirectory() || /[\\/]$/.test(filePath)) return join(target, name)
    return target
  }

  async evaluateScript(functionDeclaration, args = null) {
    this.session.guardDialog()
    if (typeof functionDeclaration !== 'string' || functionDeclaration.trim() === '') {
      throw new ToolError('function must be a JavaScript function declaration.')
    }
    const page = this.session.pageByIndex(null)

    const uids = []
    for (const argument of args ?? []) {
      if (argument && typeof argument === 'object' && argument.uid) uids.push(String(argument.uid))
      else if (typeof argument === 'string' && argument) uids.push(argument)
    }
    for (const uid of uids) this.session.uidRef(uid)

    const frame = uids.length > 0 ? this.session.uidRef(uids[0]).frame : page.mainFrame()
    // Pass a real function to Playwright so the argument object survives
    // serialization; a plain string expression would be evaluated as a value
    // instead of being invoked with the uid list.
    const evaluateInPage = async (input) => {
      const fn = (0, eval)(`(${input.source})`)
      const elements = input.uids.map(
        (uid) =>
          (window.__baUidLookup && window.__baUidLookup.get(uid)) ||
          document.querySelector('[data-ba-uid="' + uid + '"]'),
      )
      return await fn(...elements)
    }

    let result
    try {
      result = await frame.evaluate(evaluateInPage, { source: functionDeclaration, uids })
    } catch (error) {
      throw new ToolError(`Script evaluation failed: ${firstLine(error)}`)
    }
    return { text: `Script returned:\n${safeJson(result)}` }
  }

  // --------------------------------------------------------------- navigation

  async navigatePage(type = 'url', url = null, timeout = null, ignoreCache = false) {
    this.session.guardDialog()
    const page = this.session.pageByIndex(null)
    const timeoutMs = timeout || this.session.config.navigationTimeoutMs
    const navigation = String(type || 'url').toLowerCase()

    let cdp = null
    try {
      if (ignoreCache) {
        cdp = await this.session.newCdpSession(page)
        await cdp.send('Network.enable')
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
      }

      if (navigation === 'url') {
        if (!url) throw new ToolError("url is required when type='url'.")
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      } else if (navigation === 'back') {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
      } else if (navigation === 'forward') {
        await page.goForward({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
      } else if (navigation === 'reload') {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
      } else {
        throw new ToolError(`Invalid navigation type ${JSON.stringify(type)}; use url, back, forward or reload.`)
      }
    } catch (error) {
      if (error instanceof ToolError) throw error
      throw new ToolError(`Navigation failed: ${firstLine(error)}`)
    } finally {
      if (cdp) {
        try {
          await cdp.send('Network.setCacheDisabled', { cacheDisabled: false })
          await cdp.detach()
        } catch {
          // Already detached.
        }
      }
    }

    this.session.invalidateUids()
    await page.waitForTimeout(100)
    const title = await safeTitle(page)
    return {
      text:
        `Navigated to ${page.url()}\n` +
        `Page title: ${title}\n` +
        'Previous uids are stale; call take_snapshot to inspect the new page.',
    }
  }

  /**
   * Poll text, text disappearance, a selector state, and/or a JS predicate.
   * Polling across all frames is slower than one waitForFunction but works for
   * iframes, SPA text replacement, and ``textGone`` (the old text is gone).
   */
  async waitFor(options = {}, legacyTimeout = null) {
    this.session.guardDialog()
    const opts =
      typeof options === 'string' ? { text: options, timeout: legacyTimeout } : options ?? {}
    const text = typeof opts.text === 'string' && opts.text ? opts.text : null
    const textGone = typeof opts.textGone === 'string' && opts.textGone ? opts.textGone : null
    const selector = typeof opts.selector === 'string' && opts.selector.trim() ? opts.selector.trim() : null
    const predicate = typeof opts.function === 'string' && opts.function.trim() ? opts.function : null
    const state = typeof opts.state === 'string' ? opts.state : 'visible'
    if (!text && !textGone && !selector && !predicate) {
      throw new ToolError('Pass at least one of text, textGone, selector or function.')
    }
    if (!['visible', 'hidden', 'attached', 'detached'].includes(state)) {
      throw new ToolError("state must be 'visible', 'hidden', 'attached' or 'detached'.")
    }
    if (opts.state !== undefined && !selector) throw new ToolError('state requires selector.')

    const page = this.session.pageByIndex(null)
    const timeoutMs = optionalPositiveInteger(opts.timeout, 'timeout') ?? 10000
    const pollMs = optionalPositiveInteger(opts.pollInterval, 'pollInterval') ?? 200
    const started = Date.now()
    const conditions = { text, textGone, selector, state, predicate }

    while (true) {
      const satisfied = await this._conditionsSatisfied(page, conditions).catch(() => false)
      if (satisfied) {
        const pieces = []
        if (text) pieces.push(`text ${JSON.stringify(text)} appeared`)
        if (textGone) pieces.push(`text ${JSON.stringify(textGone)} disappeared`)
        if (selector) pieces.push(`${JSON.stringify(selector)} became ${state}`)
        if (predicate) pieces.push('the predicate returned truthy')
        return { text: `Wait satisfied: ${pieces.join('; ')}.` }
      }
      const remaining = timeoutMs - (Date.now() - started)
      if (remaining <= 0) break
      await new Promise((done) => setTimeout(done, Math.min(pollMs, remaining)))
    }

    throw new ToolError(
      `Timed out after ${timeoutMs}ms waiting for ${this._describeWait(conditions)}. ` +
        `url: ${page.url()}. ${await this._waitDiagnostics(page, conditions)}`,
    )
  }

  async _conditionsSatisfied(page, conditions) {
    const frames = page.frames()
    if (conditions.text) {
      let found = false
      for (const frame of frames) {
        try {
          const bodyText = await frame.evaluate(() =>
            document.body ? document.body.innerText : document.documentElement?.innerText ?? '',
          )
          if (bodyText.includes(conditions.text)) {
            found = true
            break
          }
        } catch {
          // A detached or cross-process frame without a context is skipped.
        }
      }
      if (!found) return false
    }

    if (conditions.textGone) {
      for (const frame of frames) {
        try {
          const bodyText = await frame.evaluate(() =>
            document.body ? document.body.innerText : document.documentElement?.innerText ?? '',
          )
          if (bodyText.includes(conditions.textGone)) return false
        } catch {
          // Ignore frames that cannot be read.
        }
      }
    }

    if (conditions.selector) {
      let anySatisfied = false
      let allSatisfied = true
      for (const frame of frames) {
        let count = 0
        try {
          count = await frame.locator(conditions.selector).count()
        } catch {
          count = 0
        }
        let satisfied = false
        if (count === 0) {
          satisfied = conditions.state === 'hidden' || conditions.state === 'detached'
        } else if (conditions.state === 'attached') {
          satisfied = true
        } else if (conditions.state === 'detached') {
          satisfied = false
        } else {
          const visible = await frame
            .locator(conditions.selector)
            .first()
            .isVisible()
            .catch(() => false)
          satisfied = conditions.state === 'visible' ? visible : !visible
        }
        if (satisfied) anySatisfied = true
        else allSatisfied = false
      }
      const negative = conditions.state === 'hidden' || conditions.state === 'detached'
      if (negative ? !allSatisfied : !anySatisfied) return false
    }

    if (conditions.predicate) {
      try {
        const value = await page.evaluate(async (source) => {
          const fn = (0, eval)(`(${source})`)
          return await fn()
        }, conditions.predicate)
        if (!value) return false
      } catch {
        return false
      }
    }
    return true
  }

  _describeWait(conditions) {
    const pieces = []
    if (conditions.text) pieces.push(`text ${JSON.stringify(conditions.text)}`)
    if (conditions.textGone) pieces.push(`text ${JSON.stringify(conditions.textGone)} to disappear`)
    if (conditions.selector) pieces.push(`selector ${JSON.stringify(conditions.selector)} to be ${conditions.state}`)
    if (conditions.predicate) pieces.push('the JS predicate to return truthy')
    return pieces.join(' and ')
  }

  async _waitDiagnostics(page, conditions) {
    const pieces = []
    if (conditions.selector) {
      let count = 0
      let visible = 0
      for (const frame of page.frames()) {
        try {
          const locator = frame.locator(conditions.selector)
          count += await locator.count()
          if (await locator.first().isVisible().catch(() => false)) visible += 1
        } catch {
          // Ignore inaccessible frames.
        }
      }
      pieces.push(`selector matches ${count} element(s), ${visible} visible.`)
    }
    if (conditions.text) {
      const current = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')
      pieces.push(`current text length ${current.length}.`)
    }
    return pieces.join(' ')
  }

  // -------------------------------------------------------------- observation

  async takeSnapshot(options = {}, legacyVerbose = false) {
    const opts =
      typeof options === 'string' || options === null
        ? { filePath: options, verbose: legacyVerbose }
        : options && typeof options === 'object'
          ? options
          : {}
    const result = await this.session.takeSnapshot(opts)
    const filePath = typeof opts.filePath === 'string' && opts.filePath ? opts.filePath : null
    if (filePath) {
      const target = this._path(filePath)
      await ensureParentDir(target)
      await writeFile(target, result.text, 'utf8')
      return {
        text:
          `Snapshot saved to ${target} (${result.uidCount} uid elements, ` +
          `${Buffer.byteLength(result.text, 'utf8')} bytes).`,
      }
    }
    return { text: result.text }
  }

  async takeScreenshot(filePath = null, format = 'png', fullPage = false, quality = null, uid = null) {
    this.session.guardDialog()
    const page = this.session.pageByIndex(null)
    const imageFormat = String(format || 'png').toLowerCase()
    if (imageFormat !== 'png' && imageFormat !== 'jpeg') {
      throw new ToolError("format must be 'png' or 'jpeg'.")
    }

    const options = { type: imageFormat }
    if (imageFormat === 'jpeg' && quality !== null && quality !== undefined) {
      options.quality = Math.max(0, Math.min(100, Number(quality)))
    }

    let data
    try {
      if (uid) data = await this.session.locate(uid).screenshot({ timeout: this.session.config.actionTimeoutMs, ...options })
      else data = await page.screenshot({ fullPage: Boolean(fullPage), ...options })
    } catch (error) {
      throw new ToolError(`Screenshot failed: ${firstLine(error)}`)
    }

    if (filePath) {
      const target = this._path(filePath)
      await ensureParentDir(target)
      await writeFile(target, data)
      return { text: `Screenshot saved to ${target} (${data.length} bytes).` }
    }

    const text = `Screenshot captured (${data.length} bytes, ${imageFormat}).`
    let image = null
    try {
      image = await this.attachImage(new Uint8Array(data), `image/${imageFormat}`)
    } catch (error) {
      return { text: `${text} The image could not be attached: ${firstLine(error)}.` }
    }
    if (!image) return { text: `${text} No image store is available; pass filePath to save it.` }
    return { text, image }
  }

  async listConsoleMessages(types = null, pageIdx = null, pageSize = null, includePreserved = false) {
    return {
      text: this.session.consoleMessages(pageIdx, types, pageSize, includePreserved),
    }
  }

  async listNetworkRequests(resourceTypes = null, pageIdx = null, pageSize = null, includePreserved = false) {
    return {
      text: this.session.networkRequests(pageIdx, resourceTypes, pageSize, includePreserved),
    }
  }

  // -------------------------------------------------------------------- pages

  async listPages() {
    return { text: await this.session.listPagesText() }
  }

  async selectPage(pageIdx) {
    return { text: await this.session.selectPage(pageIdx) }
  }

  // ------------------------------------------------------------------ dialogs

  async handleDialog(action, promptText = null) {
    if (action !== 'accept' && action !== 'dismiss') {
      throw new ToolError("action must be 'accept' or 'dismiss'.")
    }
    return { text: await this.session.handleDialog(action, promptText) }
  }
}
