/**
 * Standalone end-to-end self-test for the native browser plugin.
 *
 * Run from this directory: node selftest.mjs
 *
 * It starts a local HTTP server, launches Chromium through playwright-core,
 * and exercises all 16 tools through the same BrowserSession/BrowserTools
 * classes the DSH plugin uses. No DSH process is involved.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BrowserSession, BrowserTools, ToolError, resolveConfig } from './lib/browser.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ARTIFACTS = resolve(HERE, '..', 'artifacts')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const SELFTEST_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Browser Agent Self Test</title>
  <style>
    body { font-family: sans-serif; padding: 24px; }
    #out { color: #0a7; font-weight: 600; }
    #drop { width: 180px; height: 60px; border: 2px dashed #888; }
    #drag { width: 80px; height: 40px; background: #cde; }
  </style>
</head>
<body>
  <h1>Browser Agent Self Test</h1>
  <label for="query">Search</label>
  <input id="query" placeholder="Type here">
  <button id="go" onclick="document.getElementById('out').textContent='clicked:'+document.getElementById('query').value">Go</button>
  <select id="pick" aria-label="Pick">
    <option value="a">Alpha</option>
    <option value="b">Beta</option>
  </select>
  <input id="agree" type="checkbox" aria-label="Agree">
  <input id="file" type="file" aria-label="File">
  <input id="key" aria-label="Key" onkeydown="document.getElementById('out').textContent='key:'+event.key">
  <button id="drag" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','drag')">Drag me</button>
  <button id="drop" ondragover="event.preventDefault()" ondrop="event.preventDefault(); this.textContent='dropped:'+event.dataTransfer.getData('text/plain')">Drop here</button>
  <p id="out">idle</p>
  <div id="cover-wrap" style="position:relative; display:inline-block">
    <button id="covered" onclick="document.getElementById('out').textContent='covered-clicked'">Covered</button>
    <div id="cover" style="position:absolute; inset:0; background:rgba(0,0,0,0.01)"></div>
  </div>
  <label id="styled-wrap" style="display:inline-block; padding:4px; background:#eee">
    <input id="styled" type="checkbox" aria-label="Styled Option" style="opacity:0; position:absolute; width:1px; height:1px">
    Styled Option
  </label>
  <p id="status" style="color:#a60">loading</p>
  <a id="dl" href="/download.txt" download>Download file</a>
  <aside id="filters" aria-label="Filters">
    <h2>Filters</h2>
${Array.from({ length: 40 }, (_, index) => `    <label><input type="checkbox" aria-label="Filter ${index}"> Filter ${index}</label>`).join('\n')}
    <button id="apply" onclick="document.getElementById('out').textContent='filters-applied'">Apply filters</button>
  </aside>
  <div id="outside">Outside marker</div>
  <iframe src="selftest_inner.html" width="420" height="120"></iframe>
  <script>
    setTimeout(() => {
      document.getElementById('status').style.display = 'none'
      window.__selftestFlag = true
    }, 400)
  </script>
  <script>console.log('selftest page ready')</script>
</body>
</html>
`

const INNER_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Inner Frame</title></head>
<body>
  <h1>Inner Frame</h1>
  <button id="inner" onclick="this.textContent='inner-clicked'">Inner Button</button>
</body>
</html>
`

class Checker {
  constructor() {
    this.failures = []
  }

  check(name, ok, detail = '') {
    if (ok) {
      console.log(`[PASS] ${name}`)
      return
    }
    this.failures.push(name)
    console.log(`[FAIL] ${name}${detail ? ` ${detail}` : ''}`)
  }

  report() {
    console.log('')
    if (this.failures.length > 0) {
      console.log(`${this.failures.length} check(s) failed: ${this.failures.join(', ')}`)
      return 1
    }
    console.log('All checks passed.')
    return 0
  }
}

function printBlock(title, text, limit = 1200) {
  console.log(`\n== ${title} ==`)
  console.log(text.length <= limit ? text : `${text.slice(0, limit)}\n... (truncated)`)
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
}

/**
 * Bind a test port outside Chromium's restricted range (4045, 6000, 6000-ish,
 * 10080, ...). Port 0 on Windows occasionally lands on one and page.goto then
 * fails with ERR_UNSAFE_PORT.
 */
async function listenSafe(server) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 50000 + Math.floor(Math.random() * 9000)
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, '127.0.0.1')
      })
      return port
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error('Could not bind a safe self-test port.')
}

async function serve() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/download.txt') {
        response.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="report.txt"',
        })
        response.end('downloaded body')
        return
      }
      const file = join(ARTIFACTS, url.pathname === '/' ? 'selftest.html' : url.pathname)
      const data = await readFile(file)
      response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' })
      response.end(data)
    } catch {
      response.writeHead(404)
      response.end('not found')
    }
  })
  const port = await listenSafe(server)
  return { server, url: `http://127.0.0.1:${port}/selftest.html` }
}

async function main() {
  const checker = new Checker()
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(ARTIFACTS, { recursive: true })
  await writeFile(join(ARTIFACTS, 'selftest.html'), SELFTEST_HTML, 'utf8')
  await writeFile(join(ARTIFACTS, 'selftest_inner.html'), INNER_HTML, 'utf8')
  await writeFile(join(ARTIFACTS, 'upload.txt'), 'native browser upload', 'utf8')

  const { server, url } = await serve()
  const base = new URL(url).origin
  const session = new BrowserSession(resolveConfig({ headless: true, channel: 'chrome' }))
  const tools = new BrowserTools(session, {
    resolvePath: (target) => resolve(target),
    attachImage: async () => null,
  })

  try {
    await session.start()

    printBlock('navigate_page', (await tools.navigatePage('url', url)).text)
    let snapshot = (await tools.takeSnapshot()).text
    printBlock('take_snapshot', snapshot)
    checker.check('snapshot shows page title', snapshot.includes('Browser Agent Self Test'))
    checker.check('snapshot assigns uids', /uid=\d+_\d+/.test(snapshot))

    const textbox = session.findUid('textbox')
    const button = session.findUid('button', 'Go')
    const combobox = session.findUid('combobox')
    const paragraph = session.findUid('paragraph')
    const checkbox = session.findUid('checkbox', 'Agree')
    const fileInput = session.findUid('button', 'File') ?? session.findUid('textbox', 'File')
    checker.check('found textbox uid', Boolean(textbox), textbox)
    checker.check('found button uid', Boolean(button), button)
    checker.check('found combobox uid', Boolean(combobox), combobox)
    checker.check('found paragraph uid', Boolean(paragraph), paragraph)
    if (!textbox || !button || !combobox || !paragraph) return checker.report()

    printBlock('fill textbox', (await tools.fill(textbox, 'playwright')).text)
    printBlock('fill select', (await tools.fill(combobox, 'b')).text)
    printBlock('hover', (await tools.hover(button)).text)
    printBlock('press_key', (await tools.pressKey('Control+A')).text)
    printBlock('click', (await tools.click(button)).text)

    try {
      printBlock('wait_for', (await tools.waitFor('clicked:playwright', 5000)).text)
      checker.check('wait_for found rendered text', true)
    } catch (error) {
      checker.check('wait_for found rendered text', false, error)
    }

    const script = await tools.evaluateScript('(el) => el.textContent', [{ uid: paragraph }])
    printBlock('evaluate_script', script.text)
    checker.check('evaluate_script reads DOM', script.text.includes('clicked:playwright'))
    const selectValue = await tools.evaluateScript("() => document.getElementById('pick').value")
    checker.check('select option applied', selectValue.text.includes('"b"'))

    if (checkbox) {
      await tools.fill(checkbox, 'true')
      const checked = await tools.evaluateScript('(el) => el.checked', [{ uid: checkbox }])
      checker.check('checkbox filled', checked.text.includes('true'))
    } else {
      checker.check('checkbox uid found', false)
    }

    if (fileInput) {
      const upload = await tools.uploadFile(fileInput, join(ARTIFACTS, 'upload.txt'))
      printBlock('upload_file', upload.text)
      const name = await tools.evaluateScript('(el) => el.files[0]?.name ?? ""', [{ uid: fileInput }])
      checker.check('file input uploaded', name.text.includes('upload.txt'), name.text)
    } else {
      checker.check('file input uid found', false)
    }

    // A transparent overlay covers this button, so Playwright's normal and
    // forced clicks both land on the overlay. The script fallback must work.
    const covered = session.findUid('button', 'Covered')
    if (covered) {
      const coveredResult = await tools.click(covered)
      printBlock('click through overlay', coveredResult.text)
      const outText = await tools.evaluateScript("() => document.getElementById('out').textContent")
      checker.check('click escaped an overlay', outText.text.includes('covered-clicked'), outText.text)
      checker.check('click reports its fallback', coveredResult.text.includes('script click'), coveredResult.text)
    } else {
      checker.check('covered button uid found', false)
    }

    // Element UI keeps the real checkbox tiny/invisible inside a label.
    const styledCheckbox = session.findUid('checkbox', 'Styled Option')
    if (styledCheckbox) {
      await tools.fill(styledCheckbox, 'true')
      const styledChecked = await tools.evaluateScript('(el) => el.checked', [{ uid: styledCheckbox }])
      checker.check('hidden checkbox toggled', styledChecked.text.includes('true'), styledChecked.text)
    } else {
      checker.check('styled checkbox uid found', false)
    }

    // Snapshot uids must survive DOM mutations that do not replace the node.
    await tools.evaluateScript(
      "() => { const marker = document.createElement('div'); marker.id = 'inserted'; marker.textContent = 'Inserted marker'; document.body.prepend(marker); return true }",
    )
    const afterInsert = (await tools.takeSnapshot()).text
    checker.check('snapshot sees inserted DOM', afterInsert.includes('Inserted marker'))
    checker.check(
      'uid stable across snapshots',
      session.findUid('button', 'Go') === button,
      `${button} -> ${session.findUid('button', 'Go')}`,
    )

    // Scoped snapshots: only the container, not the 40-checkbox sidebar plus
    // the rest of the page.
    const scoped = (await tools.takeSnapshot({ selector: '#filters', maxChars: 0, maxLines: 0 })).text
    printBlock('take_snapshot selector', scoped, 900)
    checker.check('selector scope includes container', scoped.includes('Apply filters'))
    checker.check('selector scope excludes outside content', !scoped.includes('Outside marker'))
    checker.check('selector scope excludes unrelated controls', !scoped.includes('Styled Option'))

    const applyButton = session.findUid('button', 'Apply filters')
    if (applyButton) {
      const byUid = (await tools.takeSnapshot({ uid: applyButton, maxChars: 0 })).text
      checker.check('uid scope includes subtree', byUid.includes('Apply filters'))
      checker.check('uid scope excludes siblings', !byUid.includes('Filter 1'))
    } else {
      checker.check('apply button uid found', false)
    }

    // A scoped snapshot must not invalidate uids for the rest of the page.
    await tools.click(button)
    const afterScopeClick = await tools.evaluateScript("() => document.getElementById('out').textContent")
    checker.check(
      'uid outside scope remains usable',
      afterScopeClick.text.includes('clicked:playwright'),
      afterScopeClick.text,
    )

    const tiny = (await tools.takeSnapshot({ maxChars: 400 })).text
    checker.check('snapshot truncation is reported', tiny.includes('snapshot truncated'), tiny)

    // wait_for: iframe text, disappearance, selector state, JS predicate.
    await tools.evaluateScript(
      "() => { window.__selftestFlag = false; const status = document.getElementById('status'); status.style.display = ''; status.textContent = 'loading'; setTimeout(() => { status.style.display = 'none'; window.__selftestFlag = true }, 400); const p = document.createElement('p'); p.id = 'temporary'; p.textContent = 'temporary-label'; document.body.append(p); setTimeout(() => p.remove(), 400); return true }",
    )
    await tools.waitFor({ text: 'temporary-label', timeout: 3000 })
    await tools.waitFor({ textGone: 'temporary-label', timeout: 3000 })
    checker.check('wait_for text/textGone', true)
    await tools.waitFor({ selector: '#status', state: 'hidden', timeout: 5000 })
    checker.check('wait_for selector state', true)
    await tools.waitFor({ function: '() => window.__selftestFlag === true', timeout: 5000 })
    checker.check('wait_for predicate', true)
    await tools.waitFor({ text: 'Inner Frame', timeout: 2000 })
    checker.check('wait_for searches iframes', true)

    // Native downloads: URL fetch and click-triggered browser download.
    const urlDownload = join(ARTIFACTS, 'download-url.txt')
    const urlDownloadResult = await tools.download({ url: `${base}/download.txt`, filePath: urlDownload, timeout: 10000 })
    printBlock('download url', urlDownloadResult.text)
    checker.check(
      'download url saved with headers',
      (await readFile(urlDownload, 'utf8')) === 'downloaded body',
      urlDownloadResult.text,
    )
    const downloadLink = session.findUid('link', 'Download file')
    if (downloadLink) {
      const clickedDownload = join(ARTIFACTS, 'download-clicked.txt')
      const clickedResult = await tools.download({ uid: downloadLink, filePath: clickedDownload, timeout: 10000 })
      printBlock('download uid', clickedResult.text)
      checker.check(
        'download by uid saved',
        (await readFile(clickedDownload, 'utf8')) === 'downloaded body',
        clickedResult.text,
      )
    } else {
      checker.check('download link uid found', false)
    }

    // Same-process iframe: snapshot via frameId, uid actions in the child frame.
    snapshot = (await tools.takeSnapshot()).text
    const innerButton = session.findUid('button', 'Inner Button')
    checker.check('iframe button has uid', Boolean(innerButton), innerButton)
    checker.check('iframe content in snapshot', snapshot.includes('Inner Frame'))
    if (innerButton) {
      printBlock('click iframe', (await tools.click(innerButton)).text)
      const innerText = await tools.evaluateScript('(el) => el.textContent', [{ uid: innerButton }])
      checker.check('iframe element clickable via uid', innerText.text.includes('inner-clicked'), innerText.text)
    }

    const keyInput = session.findUid('textbox', 'Key')
    if (keyInput) {
      await tools.click(keyInput)
      await tools.pressKey('Enter')
      const keyResult = await tools.evaluateScript("() => document.getElementById('out').textContent")
      checker.check('press_key triggered keydown', keyResult.text.includes('key:Enter'), keyResult.text)
    } else {
      checker.check('key input uid found', false)
    }

    const dragUid = session.findUid('button', 'Drag me')
    const dropUid = session.findUid('button', 'Drop here')
    if (dragUid && dropUid) {
      try {
        printBlock('drag', (await tools.drag(dragUid, dropUid)).text)
        checker.check('drag completed', true)
      } catch (error) {
        checker.check('drag completed', false, error)
      }
    } else {
      checker.check('drag uids found', false, `${dragUid} -> ${dropUid}`)
    }

    const screenshotFile = join(ARTIFACTS, 'selftest-native.png')
    printBlock('take_screenshot', (await tools.takeScreenshot(screenshotFile, 'png', true)).text)
    const png = await readFile(screenshotFile)
    checker.check('screenshot written', png.length > 0 && png[0] === 0x89 && png[1] === 0x50)

    const elementShot = await tools.takeScreenshot(join(ARTIFACTS, 'selftest-element.png'), 'png', false, null, button)
    checker.check('element screenshot written', elementShot.text.includes('Screenshot saved'))

    const snapshotFile = join(ARTIFACTS, 'selftest-native-snapshot.txt')
    await tools.takeSnapshot(snapshotFile)
    checker.check('snapshot file written', (await readFile(snapshotFile, 'utf8')).includes('Browser Agent Self Test'))

    const consoleText = (await tools.listConsoleMessages()).text
    printBlock('list_console_messages', consoleText)
    checker.check('console message captured', consoleText.includes('selftest page ready'))
    const errorConsole = (await tools.listConsoleMessages(['error'])).text
    checker.check('console type filter works', !errorConsole.includes('selftest page ready'))

    // Network buffers reset on navigation; trigger a request afterwards.
    await tools.evaluateScript("() => fetch('selftest.html?probe=1').then((response) => response.status)")
    await sleep(300)
    const networkText = (await tools.listNetworkRequests()).text
    printBlock('list_network_requests', networkText, 600)
    checker.check('network request captured', networkText.includes('selftest.html'))
    const documentNetwork = (await tools.listNetworkRequests(['document'])).text
    checker.check('network type filter works', documentNetwork.includes('document'))

    const pagesText = (await tools.listPages()).text
    printBlock('list_pages', pagesText)
    checker.check('page listed', pagesText.includes('selftest.html'))

    // Dialog flow: trigger confirm in the background, then handle it.
    const dialogTask = tools.evaluateScript("() => confirm('Delete the record?')")
    await sleep(400)
    const handled = (await tools.handleDialog('dismiss')).text
    printBlock('handle_dialog', handled)
    const dialogResult = await dialogTask
    checker.check('dialog was pending', handled.includes('Dismissed'))
    checker.check('dialog result returned', dialogResult.text.includes('false'))
    checker.check('no-dialog message', (await tools.handleDialog('dismiss')).text.includes('No dialog'))

    // Multi-page: open a second tab, list, select, and inspect it.
    const secondPage = await session._context.newPage()
    await secondPage.goto(`http://127.0.0.1:${new URL(url).port}/selftest_inner.html`, { waitUntil: 'domcontentloaded' })
    const twoPages = (await tools.listPages()).text
    printBlock('list_pages (two tabs)', twoPages)
    checker.check('second page listed', twoPages.includes('Inner Frame'))
    printBlock('select_page', (await tools.selectPage(1)).text)
    const secondSnapshot = (await tools.takeSnapshot()).text
    checker.check('selected second page snapshot', secondSnapshot.includes('Inner Frame'))
    await tools.selectPage(0)

    // The tool layer must reject stale uids after navigation.
    await tools.navigatePage('url', `${url}?reloaded=1`)
    try {
      await tools.click(textbox)
      checker.check('stale uid rejected', false, 'click unexpectedly succeeded')
    } catch (error) {
      checker.check('stale uid rejected', error instanceof ToolError && error.message.includes('Unknown uid'), error)
    }

    const methods = new Set(
      Object.getOwnPropertyNames(BrowserTools.prototype).filter(
        (name) => !name.startsWith('_') && typeof tools[name] === 'function',
      ),
    )
    const expected = [
      'click',
      'download',
      'drag',
      'evaluateScript',
      'fill',
      'handleDialog',
      'hover',
      'listConsoleMessages',
      'listNetworkRequests',
      'listPages',
      'navigatePage',
      'pressKey',
      'selectPage',
      'takeScreenshot',
      'takeSnapshot',
      'uploadFile',
      'waitFor',
    ]
    checker.check('all 17 tool methods present', expected.every((name) => methods.has(name)))
  } finally {
    await session.stop()
    server.close()
  }

  return checker.report()
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
