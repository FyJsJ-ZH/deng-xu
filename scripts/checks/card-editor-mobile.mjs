import './_ws-shim.mjs'
/**
 * 手机端「世界卡编辑器」的横向溢出走查。
 *
 * ## 为什么专门写这一套
 *
 * 2026-11 用户拍了一张手机截图：编辑器「角色卡」页签里，
 * 每行文字**从屏幕左边外面开始**，页签上的「基础」被切成「础」，
 * 整页可以左右拖。原话是「世界书内的角色卡编辑ui不适配手机太宽了」。
 *
 * 病根不是字号也不是 padding，是 **Tailwind 网格的默认列宽**：
 * 只写 `grid md:grid-cols-2` 时，`<md` 走的是 `grid-template-columns: none`，
 * 也就是单列 **auto** —— 列宽由内容决定。而这些表单里躺着整段人物小传
 * （「宋修竹（大徒弟）：周景贤最……」），auto 列被撑到几千像素宽，
 * 内容区于是横向可滚，玩家看到的就是"左边被裁掉半行字"。
 *
 * 修法是给每一处都补 `grid-cols-1`（= `minmax(0,1fr)`）。
 * 这条走查守的就是这件事：**任何一级容器的 scrollWidth 都不许超过 clientWidth**。
 *
 * ⚠️ 要跑 dev server（`__libraryStore` / `__uiStore` 只在 DEV 挂到 window）。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { outDir, profileDir } from './_browser.mjs'

const SITE = process.env.SITE || 'http://localhost:5199/'
const OUT = outDir()
const EDGE = (() => {
  const cands = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch {} }
  throw new Error('找不到 Edge / Chrome，可用 EDGE_PATH 指定')
})()
const PORT = Number(process.env.CDP_PORT || 9796)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const getJson = u => new Promise((res, rej) => {
  http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)) } catch (e) { rej(e) } }) }).on('error', rej)
})
fs.mkdirSync(OUT, { recursive: true })
const PROFILE = profileDir('ced')
const edge = spawn(EDGE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' })
let v = null
for (let i = 0; i < 40; i++) { try { v = await getJson(`http://127.0.0.1:${PORT}/json/version`); break } catch { await sleep(500) } }
if (!v) { console.error('端口未就绪'); process.exit(1) }
const tabs = await getJson(`http://127.0.0.1:${PORT}/json/list`)
const ws = new WebSocket(tabs.find(x => x.type === 'page').webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0; const pend = new Map(); const errs = []
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').split('\n')[0])
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
}
const send = (m, p = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })
  return r.result?.exceptionDetails ? 'THREW ' + (r.result.exceptionDetails.exception?.description || '') : r.result?.result?.value
}
const shot = async n => {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  if (s.result?.data) fs.writeFileSync(path.join(OUT, n + '.png'), Buffer.from(s.result.data, 'base64'))
}
const results = []
const check = (l, ok, extra = '') => { results.push({ l, ok }); console.log(`  ${ok ? '✓' : '✗'} ${l}${extra ? '  ' + extra : ''}`) }
const waitFor = async (expr, timeoutMs = 10000, step = 200) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) { if (await ev(expr)) return true; await sleep(step) }
  return false
}

/**
 * 找所有**真的**横向溢出的容器。
 *
 * ⚠️ 只认 `overflow-x: visible` 的元素。
 * `truncate`（= `overflow:hidden + text-overflow:ellipsis + nowrap`）和
 * `overflow-x:auto` 的容器，`scrollWidth` 本来就大于 `clientWidth` ——
 * 前者是把长文裁掉、后者是给人横向滚，都不是 bug。第一版探针没排除它们，
 * 于是把角色列表里那些"备长关系描述"全报成溢出，红得毫无意义。
 */
const OVERFLOW_PROBE = `(() => {
  const bad = []
  for (const el of document.querySelectorAll('div,section,main,aside,form')) {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    if (cs.overflowX !== 'visible') continue
    if (el.clientWidth <= 0) continue
    if (el.scrollWidth > el.clientWidth + 1) {
      bad.push({
        cls: (el.className || '').toString().slice(0, 90),
        sw: el.scrollWidth, cw: el.clientWidth,
        over: el.scrollWidth - el.clientWidth,
      })
    }
  }
  return bad.slice(0, 6)
})()`

try {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await send('Page.navigate', { url: SITE })
  await sleep(1200)

  console.log('=== 1) 打开编辑器 ===')
  const ready = await waitFor(`!!(window.__libraryStore && window.__uiStore && window.__libraryStore.getState().loaded)`)
  check('store 就绪（dev server）', ready)
  // 没配 key 时「模型设置」会盖在编辑器上面（z 更高），截图与点击都被它挡住。
  // 走查只关心布局，随便填一个假 key 把它收起来。
  await ev(`window.__uiStore.getState().setLlm({ apiKey: 'sk-check-dummy' })`)
  await sleep(300)

  /*
    内置卡不能直接编辑（按钮上写的是「复制一份以便修改」），
    而这张走查要验的正是编辑器布局 —— 所以先造一张可编辑的副本，
    再**用 DOM 点击**那个「编辑」按钮。

    ⚠️ 必须走真实点击，不能 `__uiStore.getState().setCardEditorOpen(true)`：
    组件里那个调用被 `startTransition` 包过，直接调 store 等于绕过它，
    于是又变成"在同步输入里 suspend"，整页会闪。
  */
  await ev(`window.__navStore.getState().push({ name: 'library', intent: 'library' })`)
  await sleep(900)
  const dup = await ev(`(async () => {
    const lib = window.__libraryStore.getState()
    const src = (lib.worlds || []).find(w => w.builtin) || (lib.worlds || [])[0]
    if (!src) return 'NO_WORLD'
    const copy = await lib.duplicateWorld(src.id)
    return copy ? copy.title : 'DUP_FAIL'
  })()`)
  check('能复制出一张可编辑的卡', typeof dup === 'string' && dup !== 'NO_WORLD' && dup !== 'DUP_FAIL', String(dup))
  await sleep(700)

  const clicked = await ev(`(() => {
    const b = [...document.querySelectorAll('button[title="编辑"]')][0]
    if (!b) return false
    b.click(); return true
  })()`)
  check('点「编辑」能打开编辑器', clicked)

  // ⚠️ 别用 `document.querySelector('h2')`：没配 key 时 ApiKeyModal 也是 h2
  // （「模型设置」），它会先被选中，于是判据永远假。
  const mounted = await waitFor(
    `[...document.querySelectorAll('h2')].some(h => h.textContent.includes('编辑世界卡'))`,
    20000,
  )
  check('编辑器已挂载', mounted)
  if (!mounted) {
    console.log('    uiStore:', await ev(`JSON.stringify({ open: window.__uiStore.getState().isCardEditorOpen, wid: window.__uiStore.getState().editingWorldId })`))
    console.log('    h2:', await ev(`[...document.querySelectorAll('h2')].map(h => h.textContent).join(' | ')`))
    console.log('    body:', String(await ev(`document.body.innerText`)).replace(/\s+/g, ' ').slice(0, 260))
  }
  await shot('01-editor-open')

  console.log('=== 2) 切到「角色卡」页签 ===')
  const clickedTab = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().endsWith('角色卡'))
    if (!b) return false
    b.click(); return true
  })()`)
  check('找到并点击「角色卡」页签', clickedTab)
  await sleep(600)

  const listOk = await ev(`!!document.querySelector('button') && [...document.querySelectorAll('button')].some(b => b.textContent.includes('新建'))`)
  check('角色列表有「新建」按钮', listOk)

  console.log('=== 3) 页面不许横向溢出（用户报障的核心）===')
  const docOver = await ev(`document.documentElement.scrollWidth - window.innerWidth`)
  check('页面本身不横向滚动', docOver <= 1, `差 ${docOver}px`)

  const listOver = await ev(OVERFLOW_PROBE)
  if (Array.isArray(listOver) && listOver.length) {
    console.log('    溢出元素：', JSON.stringify(listOver, null, 0).slice(0, 500))
  }
  check('列表态没有容器溢出', Array.isArray(listOver) && listOver.length === 0, Array.isArray(listOver) ? `${listOver.length} 个` : '探针失败')
  await shot('02-characters-list')

  console.log('=== 4) 选中一张角色 → 详情页 ===')
  const picked = await ev(`(() => {
    // 列表项：按钮里含「在场 / 未登场」小字的那一批
    const items = [...document.querySelectorAll('button')].filter(b => /在场|未登场/.test(b.textContent))
    if (!items.length) return 'NONE'
    items[0].click()
    return items[0].textContent.trim().slice(0, 20)
  })()`)
  check('能点开一张角色卡', picked !== 'NONE', String(picked))
  await sleep(700)

  const backBtn = await ev(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('角色列表'))`)
  check('详情页有「← 角色列表」出口', backBtn)

  const detailOver = await ev(OVERFLOW_PROBE)
  if (Array.isArray(detailOver) && detailOver.length) {
    console.log('    溢出元素：', JSON.stringify(detailOver, null, 0).slice(0, 500))
  }
  check('详情态没有容器溢出', Array.isArray(detailOver) && detailOver.length === 0, Array.isArray(detailOver) ? `${detailOver.length} 个` : '探针失败')
  await shot('03-character-detail')

  const docOver2 = await ev(`document.documentElement.scrollWidth - window.innerWidth`)
  check('详情态页面仍不横向滚动', docOver2 <= 1, `差 ${docOver2}px`)

  console.log('=== 5) 长文本字段本身可读 ===')
  const taOk = await ev(`(() => {
    const tas = [...document.querySelectorAll('textarea')]
    if (!tas.length) return null
    const bad = tas.filter(t => t.scrollWidth > t.clientWidth + 2 && t.value.length > 40)
    return { total: tas.length, bad: bad.length }
  })()`)
  check('textarea 不会因为长文而横向滚', taOk && taOk.bad === 0, JSON.stringify(taOk))

  console.log('=== 6) 返回列表 ===')
  const back = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('角色列表'))
    if (!b) return false
    b.click(); return true
  })()`)
  check('点「角色列表」能回列表', back)
  await sleep(500)
  const backToList = await ev(`[...document.querySelectorAll('button')].some(b => /在场|未登场/.test(b.textContent))`)
  check('确实回到了列表', backToList)

  console.log('')
  const okCount = results.filter(r => r.ok).length
  console.log(`=== 汇总 ===\n  通过 ${okCount}/${results.length}`)
  if (errs.length) console.log('  运行期异常: ' + errs.slice(0, 3).join(' | '))
  await shot('04-final')
  const failed = results.filter(r => !r.ok)
  console.log(`\n${failed.length ? '✗ 卡片编辑器（手机）未通过' : '✓ 卡片编辑器（手机）通过'}`)
  process.exitCode = failed.length ? 1 : 0
} catch (e) {
  console.error('走查崩溃：', e)
  process.exitCode = 1
} finally {
  try { ws.close() } catch {}
  try { edge.kill() } catch {}
}
