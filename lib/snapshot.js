/**
 * Accessibility-tree snapshots with snapshot-scoped ``uid`` annotation.
 *
 * The tree comes from the Chrome DevTools Protocol, each actionable node
 * receives a uid, and the uid is materialised as a DOM attribute so later
 * Playwright actions can resolve it with a plain CSS selector.
 */

export const UID_ATTR = 'data-ba-uid'

/**
 * Temporary marker used by selector-scoped snapshots. The session sets it on
 * the matched element, resolves the marker to a backend node id through the
 * DOM domain, then renders only that AX subtree.
 */
export const SCOPE_ATTR = 'data-ba-scope'

// Roles that carry text but can never be clicked/filled themselves.
const TEXT_ROLES = new Set(['StaticText'])

// Structural noise that is never worth showing to the model.
const SKIP_ROLES = new Set(['InlineTextBox', 'LineBreak', 'none', 'superscript', 'subscript'])

// Containers without an accessible name are flattened so their children keep
// the parent's indentation level.
const TRANSPARENT_ROLES = new Set(['generic', 'GenericContainer', 'presentation'])

// Accessibility properties worth surfacing in the snapshot.
const ATTRIBUTE_NAMES = new Set([
  'level',
  'url',
  'placeholder',
  'valuetext',
  'checked',
  'disabled',
  'expanded',
  'selected',
  'required',
  'readonly',
  'focused',
  'pressed',
  'hidden',
  'invalid',
  'haspopup',
  'multiselectable',
  'orientation',
  'autocomplete',
  'min',
  'max',
])

// Roles whose current value is useful to show next to the node.
const VALUE_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'slider',
  'spinbutton',
  'option',
])

const NAME_LIMIT = 300
const VALUE_LIMIT = 120
const MAX_SNAPSHOT_LINES = 3000

function axValue(node) {
  return node && typeof node === 'object' ? node.value : undefined
}

function quote(text, limit = NAME_LIMIT) {
  const normalized = String(text).replace(/\s+/g, ' ').trim()
  const clipped = normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized
  return JSON.stringify(clipped)
}

function formatAttribute(name, value) {
  if (value === null || value === undefined || value === '' || value === false || value === 'false') return null
  if (value === true) return name
  if (typeof value === 'number') return `${name}="${value}"`
  return `${name}=${quote(String(value), VALUE_LIMIT)}`
}

function renderAttributes(node, role) {
  const parts = []
  for (const prop of node.properties ?? []) {
    const name = prop?.name
    if (!ATTRIBUTE_NAMES.has(name)) continue
    const formatted = formatAttribute(name, prop?.value?.value)
    if (formatted) parts.push(formatted)
  }

  if (VALUE_ROLES.has(role)) {
    const current = axValue(node.value)
    if (current !== null && current !== undefined && current !== '') {
      const formatted = formatAttribute('value', current)
      if (formatted) parts.push(formatted)
    }
  }

  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

/**
 * Render one frame's accessibility tree and collect uid targets.
 *
 * @param {Array<Record<string, any>>} nodes - CDP AX nodes.
 * @param {number} frameIndex - Frame ordinal used as the uid prefix.
 * @param {boolean|{
 *   verbose?: boolean,
 *   maxDepth?: number|null,
 *   rootBackendNodeIds?: Set<number>|null,
 *   allocateUid?: ((backendNodeId: number) => string)|null,
 * }} [options] - Legacy boolean is treated as ``verbose``.
 * @returns {{
 *   lines: string[],
 *   targets: Array<{ uid: string, backendNodeId: number, role: string, name: string }>,
 *   nodeCount: number,
 *   rootFound: boolean,
 *   truncatedByDepth: boolean,
 * }}
 */
export function renderAxTree(nodes, frameIndex, options = {}) {
  const config = typeof options === 'boolean' ? { verbose: options } : options ?? {}
  const verbose = Boolean(config.verbose)
  const maxDepth =
    Number.isInteger(config.maxDepth) && config.maxDepth >= 0 ? config.maxDepth : null
  const rootBackendNodeIds =
    config.rootBackendNodeIds instanceof Set ? config.rootBackendNodeIds : null
  const allocateUid = typeof config.allocateUid === 'function' ? config.allocateUid : null

  const byId = new Map()
  for (const node of nodes ?? []) {
    if (node && node.nodeId !== undefined) byId.set(node.nodeId, node)
  }
  if (byId.size === 0) {
    return { lines: [], targets: [], nodeCount: 0, rootFound: !rootBackendNodeIds, truncatedByDepth: false }
  }

  const children = new Map()
  for (const [nodeId, node] of byId) {
    children.set(nodeId, (node.childIds ?? []).filter((child) => byId.has(child)))
  }

  let root = null
  if (rootBackendNodeIds && rootBackendNodeIds.size > 0) {
    // Scoped snapshot: start at the AX node that backs the requested DOM
    // element instead of the page root.
    for (const node of byId.values()) {
      if (rootBackendNodeIds.has(Number(node.backendDOMNodeId))) {
        root = node
        break
      }
    }
    if (!root) {
      return { lines: [], targets: [], nodeCount: 0, rootFound: false, truncatedByDepth: false }
    }
  } else {
    const referenced = new Set()
    for (const kids of children.values()) for (const child of kids) referenced.add(child)
    const roots = [...byId.values()].filter((node) => !referenced.has(node.nodeId))
    root = roots.find((node) => axValue(node.role) === 'RootWebArea') ?? roots[0]
  }
  if (!root) {
    return { lines: [], targets: [], nodeCount: 0, rootFound: false, truncatedByDepth: false }
  }

  const lines = []
  const targets = []
  let nodeCount = 0
  let counter = 0
  let truncatedByDepth = false
  const stack = [[root.nodeId, 0]]

  while (stack.length > 0) {
    const [nodeId, depth] = stack.pop()
    const node = byId.get(nodeId)
    if (!node) continue
    nodeCount += 1

    const role = String(axValue(node.role) ?? 'generic')
    const name = String(axValue(node.name) ?? '').trim()
    const ignored = Boolean(node.ignored)

    let childDepth
    let rendered
    if (ignored || SKIP_ROLES.has(role)) {
      childDepth = depth
      rendered = false
    } else if (TRANSPARENT_ROLES.has(role) && !name && !verbose) {
      childDepth = depth
      rendered = false
    } else {
      childDepth = depth + 1
      rendered = true
    }

    let uid = null
    if (rendered && !TEXT_ROLES.has(role) && node.backendDOMNodeId) {
      const backendNodeId = Number(node.backendDOMNodeId)
      uid = allocateUid ? allocateUid(backendNodeId) : `${frameIndex}_${counter}`
      counter += 1
      targets.push({ uid, backendNodeId, role, name })
    }

    if (rendered) {
      let line = '  '.repeat(depth)
      if (uid) line += `uid=${uid} `
      line += role
      if (name) line += ` ${quote(name)}`
      line += renderAttributes(node, role)
      lines.push(line)
    }

    const kids = children.get(nodeId) ?? []
    if (maxDepth !== null && depth >= maxDepth) {
      if (kids.length > 0) truncatedByDepth = true
      continue
    }
    for (let index = kids.length - 1; index >= 0; index -= 1) {
      stack.push([kids[index], childDepth])
    }
  }

  if (lines.length > MAX_SNAPSHOT_LINES) {
    lines.length = MAX_SNAPSHOT_LINES
    lines.push('... (snapshot truncated; raise maxLines or scope the snapshot)')
  }

  return {
    lines,
    targets,
    nodeCount,
    rootFound: true,
    truncatedByDepth,
  }
}

/**
 * Attach uid attributes and register elements in a per-frame lookup map.
 *
 * Registering the DOM element itself (not just its attribute) keeps
 * ``evaluate_script`` working for nodes inside shadow roots, where a
 * document-level querySelector cannot reach them.
 */
export async function applyUids(cdp, targets) {
  if (!targets || targets.length === 0) return 0

  await cdp.send('DOM.enable')
  const declaration =
    'function(uid) {' +
    "  this.setAttribute('data-ba-uid', uid);" +
    '  (window.__baUidLookup || (window.__baUidLookup = new Map())).set(uid, this);' +
    '}'

  let applied = 0
  for (const target of targets) {
    try {
      const resolved = await cdp.send('DOM.resolveNode', { backendNodeId: target.backendNodeId })
      const objectId = resolved?.object?.objectId
      if (!objectId) continue
      await cdp.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: declaration,
        arguments: [{ value: target.uid }],
      })
      applied += 1
    } catch {
      // Text nodes and detached nodes cannot hold attributes.
    }
  }
  return applied
}
