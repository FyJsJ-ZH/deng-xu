import './_ws-shim.mjs'
/**
 * 「重开本局」的端到端走查。
 *
 * ## 为什么值得一套独立走查
 *
 * 玩家为这件事报过三次，每次修完都以为好了：
 *
 *  > 「重开一局的选项怎么没了，你做个重开功能没做出来」
 *
 * 三次的病因全在**别处**，只有真机跑一遍才看得见：
 *
 *  1. 入口挂在 `turn 0` 快照上 —— 老存档没有那份快照，选项直接消失；
 *  2. 重建时调了 `resetGame()`，它把 `isGameStarted` 设成 false，
 *     界面卸载重挂、`hasInitialized` 这个 ref 被重置，**自动开演**；
 *  3. 「换了 API key 后允许重试首轮」那个 effect 也在盯着 `history.length === 0`，
 *     重开把历史清成 0 的那一刻把闸门重新打开了 —— 于是第 2 条修好之后仍然自动生成。
 *
 * 三条都不会让单元测试变红（它们全是组件时序），只能靠这套走查。
 *
 * ## 判据
 *
 * 用一份**没有 turn 0 快照**的老存档，走完：
 * 下拉里有这一项 → 确认框说清代价 → 清空后**停住不动**（3 秒内 history 必须是 0）
 * → 点「生成第一幕」才真的生成 → 生成后快照链重建为 [0, 1]。
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { findBrowser, sleep, getJson, outDir, profileDir } from './_browser.mjs'

const SITE = process.env.SITE || 'http://localhost:5199/'
const PORT = Number(process.env.CDP_PORT || 9816)
const FAKE = Number(process.env.FAKE_PORT || 9826)
const OUT = outDir()
fs.mkdirSync(OUT, { recursive: true })

// ── 假服务商：必须支持 CORS 预检，否则真请求发不出去 ──
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '600',
}
let narrativeCalls = 0
const fake = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return }
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(raw) } catch { /* 忽略 */ }
    if (body.stream) {
      narrativeCalls++
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...CORS })
      const text = '第一幕：巷口的雨还没停。他把手从袖子里抽出来，掌心那道旧疤被雨一激，泛着白。'
      res.write(`data: ${JSON.stringify({ model: 'fake-flash-1017', choices: [{ delta: { content: text } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ model: 'fake-flash-1017', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
    res.end(JSON.stringify({
      model: 'fake-flash-1017',
      choices: [{ message: { content: JSON.stringify({ stateChanges: [], options: [{ id: 'o1', text: '往里走' }] }) } }],
      usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
    }))
  })
})
await new Promise(r => fake.listen(FAKE, '127.0.0.1', r))
console.log(`假服务商已启动 :${FAKE}（含 CORS 预检）`)

const PROFILE = profileDir('restart-run')
const edge = spawn(findBrowser(), [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=430,932', 'about:blank',
], { stdio: 'ignore' })

let v = null
for (let i = 0; i < 40; i++) { try { v = await getJson(`http://127.0.0.1:${PORT}/json/version`); break } catch { await sleep(500) } }
if (!v) { console.error('端口未就绪'); fake.close(); process.exit(1) }

const tabs = await getJson(`http://127.0.0.1:${PORT}/json/list`)
const ws = new WebSocket(tabs.find(x => x.type === 'page').webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0; const pend = new Map(); const errs = []
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') {
    errs.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').split('\n')[0])
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    const txt = (m.params.args || []).map(a => a.value || a.description || '').join(' ')
    if (!/Could not establish connection|Game Engine Error/i.test(txt)) errs.push('console.error: ' + txt.slice(0, 140))
  }
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
}
const send = (m, p = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) return 'THREW ' + (r.result.exceptionDetails.exception?.description || '')
  return r.result?.result?.value
}
const results = []
const check = (l, ok, extra = '') => { results.push({ l, ok }); console.log(`  ${ok ? '✓' : '✗'} ${l}${extra ? '  ' + extra : ''}`) }

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Page.navigate', { url: SITE })
await sleep(5000)

// ── 造一份没有 turn 0 快照的老存档 ──
const setup = await ev(`(() => {
  const world = window.__libraryStore.getState().worlds[0]
  if (!world) return 'no-world'
  window.__sessionStore.getState().setSession({
    world,
    player: { name: '古夜', gender: '男', age: '', appearance: '黑衣长发', personality: '', background: '', extra: '' },
    activeCharacterIds: [world.characters[0] && world.characters[0].id].filter(Boolean),
    backgroundChoices: {},
    attributeAllocation: {},
  })
  const hist = [
    { role: 'assistant', content: '第一幕：他在雨里站着。' },
    { role: 'assistant', content: '第二幕：门开了。' },
    { role: 'assistant', content: '第三幕：他进去了。' },
    { role: 'assistant', content: '第四幕：里面是空的。' },
  ]
  const snap = (turn, len, delta) => ({
    turn, historyLength: len, historyDelta: delta, playerAction: '第' + turn + '轮的行动',
    summary: '旧的摘要', memory: { bonds: [], threads: [], timeline: [], earlierSummary: '', updatedAtTurn: 0 },
    resources: {}, aspects: {}, inventory: [], characters: [], lores: [], rites: [], languages: [],
    locations: [], unlockedDoors: [], knownFacts: [], facts: [], readBooks: [], masteredLores: [],
    tags: [], story: { currentChapter: 1, completedEvents: [], activeEventId: null, flags: {}, origin: null, childhood: null, uniqueTrait: null },
    time: { year: 1, month: 1, day: 1, hour: 9, minute: 0 },
    identity: '', location: '', stage: 'init', currentOptions: [], turnsSinceLastMajorEvent: 0,
  })
  window.__gameStore.setState({
    isGameStarted: true, playerName: '古夜', location: '门内', summary: '旧的摘要',
    history: hist,
    // 只有 3、4 两轮 —— 没有 turn 0，正是老存档的样子
    turnSnapshots: [snap(3, 3, [hist[2]]), snap(4, 4, [hist[3]])],
  })
  window.__uiStore.getState().setLlm({
    provider: 'custom', baseUrl: 'http://127.0.0.1:${FAKE}/v1', apiKey: 'sk-test',
    narrativeModel: 'fake-flash-1017', analysisModel: 'fake-flash-1017', thinking: 'off',
  })
  window.__uiStore.getState().setApiKeyModalOpen(false)
  return 'ok'
})()`)
check('准备了一份没有 turn 0 快照的老存档', setup === 'ok', String(setup))
await sleep(2000)

check('下拉里有「重开本局」', await ev(`(() => {
  const sel = [...document.querySelectorAll('select')].find(s => /回到第/.test(s.textContent || ''))
  return !!sel && [...sel.options].some(o => /重开本局/.test(o.textContent))
})()`) === true)

await ev(`(() => {
  const sel = [...document.querySelectorAll('select')].find(s => /回到第/.test(s.textContent || ''))
  const opt = [...sel.options].find(o => /重开本局/.test(o.textContent))
  sel.value = opt.value
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
})()`)
await sleep(900)

const dialog = await ev(`(() => { const d = document.querySelector('[role="dialog"]'); return d ? d.innerText : 'no-dialog' })()`)
check('确认框说清这一局会作废', /所有轮次|作废/.test(String(dialog)))

await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '确定'); b && b.click(); return 'ok' })()`)

// ── 关键断言：清空之后必须**停住**，不许自动开演 ──
const afterReset = JSON.parse(await ev(`JSON.stringify({
  history: window.__gameStore.getState().history.length,
  turns: window.__gameStore.getState().turnSnapshots.map(s => s.turn),
  summary: window.__gameStore.getState().summary,
})`))
check('历史已清空', afterReset.history === 0, `history=${afterReset.history}`)
check('摘要已清空（不是留着旧摘要）', afterReset.summary === '')
check('重建出干净的 turn 0 锚点', JSON.stringify(afterReset.turns) === '[0]', JSON.stringify(afterReset.turns))

await sleep(3000)
const stillIdle = JSON.parse(await ev(`JSON.stringify({
  history: window.__gameStore.getState().history.length,
  card: /生成第一幕/.test(document.body.innerText),
})`))
check('★ 3 秒内没有自动生成（等玩家自己决定）', stillIdle.history === 0, `history=${stillIdle.history}`)
check('界面上有「生成第一幕」的入口', stillIdle.card === true)
const callsBefore = narrativeCalls

await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /生成第一幕/.test(x.textContent || '')); b && b.click(); return 'ok' })()`)
await sleep(5000)

const afterGen = JSON.parse(await ev(`JSON.stringify({
  history: window.__gameStore.getState().history.length,
  first: (window.__gameStore.getState().history[0] || {}).content || '',
  turns: window.__gameStore.getState().turnSnapshots.map(s => s.turn),
})`))
check('点了才真的生成第一幕', narrativeCalls > callsBefore, `请求数 ${callsBefore} → ${narrativeCalls}`)
check('第一幕写进了历史', afterGen.history >= 1, `history=${afterGen.history}`)
check('第一幕内容来自服务商', /第一幕/.test(String(afterGen.first)))
check('快照链重建为 [0, 1]', JSON.stringify(afterGen.turns) === '[0,1]', JSON.stringify(afterGen.turns))

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) fs.writeFileSync(path.join(OUT, 'restart-run.png'), Buffer.from(shot.result.data, 'base64'))

const failed = results.filter(r => !r.ok)
console.log(`\n  通过 ${results.length - failed.length}/${results.length}`)
if (errs.length) console.log('  运行期异常: ' + errs.slice(0, 3).join(' | '))
else console.log('  运行期异常: (无)')

ws.close(); edge.kill(); fake.close()
process.exit(failed.length === 0 && errs.length === 0 ? 0 : 1)
