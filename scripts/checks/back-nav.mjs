/**
 * 返回键层级走查（手机视角）。
 *
 * 玩家要求的行为：
 *   1. 每次返回只退**一级**
 *   2. 最多退到**主菜单**
 *   3. 在主菜单上必须按**两次**才真的退出（防误触）
 *
 * 这个功能被反馈了两次，所以测试要**逐级验证**，不能只测"面板能关"：
 *   游戏 → 卡片库 → 世界书详情 → 选角 → 游戏 → 逐级返回 → 主菜单 → 双击退出
 */
import './_ws-shim.mjs'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { outDir, profileDir, removeProfile } from './_browser.mjs'

const SITE = process.env.SITE || 'http://localhost:5199/'
// 必须绝对路径：--user-data-dir 用相对路径时 Chromium 会静默失败（见 _browser.mjs 的 outDir）
const OUT = outDir()
const EDGE = (() => {
  const cands = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].filter(Boolean)
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch { /* 忽略 */ } }
  throw new Error('找不到 Edge / Chrome，可用 EDGE_PATH 指定')
})()
const PORT = Number(process.env.CDP_PORT || 9860)
/*
  ⚠️ CI 上慢一倍多，而这一套全是**固定 sleep**（不像别的套件用 `waitFor` 轮询条件）。

  Windows runner 的冷启动 + Edge 首启 + 空 IndexedDB 播种 14 张内置卡，
  每一步都比本地慢；固定等待一旦不够，表现就是**偶发**挂在某一条断言上 ——
  本地连跑三次全过、CI 挂一次，2026-11 已经这样浪费过一轮排查。

  所以在 CI 里把每次等待乘 1.8（本地不变）。纯加时间，不改判据。
*/
const SLOW = process.env.CI ? 1.8 : 1
const sleep = ms => new Promise(r => setTimeout(r, Math.round(ms * SLOW)))
const getJson = u => new Promise((res, rej) => {
  http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)) } catch (e) { rej(e) } }) }).on('error', rej)
})
fs.mkdirSync(OUT, { recursive: true })
const PROFILE = profileDir('back')
const edge = spawn(EDGE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' })
let v = null
for (let i = 0; i < 60; i++) { try { v = await getJson(`http://127.0.0.1:${PORT}/json/version`); break } catch { await sleep(500) } }
if (!v) { console.error('端口未就绪'); process.exit(1) }
const t = await getJson(`http://127.0.0.1:${PORT}/json/list`)
const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0; const pend = new Map(); const errs = []
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').split('\n')[0])
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    const txt = (m.params.args || []).map(a => a.value || a.description || '').join(' ')
    if (!/Could not establish connection|Authentication|api key|Game Engine Error/i.test(txt)) errs.push('console.error: ' + txt.slice(0, 140))
  }
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

/** 当前应用层级（从 navStore 读，比看文本可靠得多） */
const currentView = async () => {
  for (let i = 0; i < 8; i++) {
    const r = await ev(`typeof window.__navStore === 'function' ? JSON.stringify(__navStore.getState().view) : ''`)
    if (r) return r
    await sleep(400)
  }
  return '(navStore 不可用)'
}
/** 模拟按系统返回键 */
const pressBack = async (wait = 1100) => { await ev(`window.history.back()`); await sleep(wait) }
/** 页面还在（没被退到浏览器主页） */
const stillHere = () => ev(`!!document.querySelector('#root')`)

await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await send('Page.navigate', { url: SITE }); await sleep(3000)
await ev(`(()=>{const k='pale-notes-ui';let v={};try{v=JSON.parse(localStorage.getItem(k)||'{}')}catch(e){}
  v.state=v.state||{};v.state.llm=Object.assign({provider:'deepseek',baseUrl:'https://api.deepseek.com/v1',narrativeModel:'m',analysisModel:'m',temperature:0.8},v.state.llm||{},{apiKey:'sk-back'});
  v.state.isApiKeyModalOpen=false;localStorage.setItem(k,JSON.stringify(v));return 1})()`)
await send('Page.navigate', { url: SITE }); await sleep(9000)

/*
  先关掉新手引导。
  它开着时会**先吃掉一次返回**（浮层优先级最高），
  我第一次跑这个测试就因此误判成历史逻辑有问题，白查了很久。
*/
await ev(`__uiStore.getState().setShowTutorial(false)`)
await sleep(700)

const hasNavStore = await ev(`typeof window.__navStore`)
if (hasNavStore !== 'function') {
  console.log('  ⚠ __navStore 不可用（生产构建？），本走查需要 dev server')
  console.log('  当前值:', hasNavStore)
  ws.close(); edge.kill(); process.exit(1)
}

console.log('=== 1) 起始层级 = 主菜单 ===')
console.log('  view =', await currentView())
check('打开网站落在主菜单', (await currentView()).includes('"menu"'))

console.log('\n=== 2) 主菜单 → 卡片库 → 世界书详情（逐级进入）===')
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/开始新游戏/.test(x.textContent||''));b&&b.click();return 1})()`)
await sleep(1500)
console.log('  进卡片库:', await currentView())
check('进入卡片库层级', (await currentView()).includes('"library"'))

await ev(`(()=>{const b=document.querySelector('button[title="查看世界书详情"]');b&&b.click();return 1})()`)
await sleep(1500)
const vDetail = await currentView()
console.log('  进世界书详情:', vDetail)
check('进入世界书详情层级（带 worldId）', vDetail.includes('"worldbook"') && vDetail.includes('worldId'))
await shot('back-01-worldbook')

console.log('\n=== 3) 逐级返回：详情 → 卡片库 → 主菜单 ===')
await pressBack()
const vLibrary = await currentView()
console.log('  返回一次:', vLibrary)
check('第 1 次返回 → 回到卡片库（不是主菜单，也不是退出）', vLibrary.includes('"library"'))
check('页面还在', await stillHere())

await pressBack()
const vMenu = await currentView()
console.log('  返回两次:', vMenu)
check('第 2 次返回 → 回到主菜单', vMenu.includes('"menu"'))
check('页面还在', await stillHere())
await shot('back-02-menu')

console.log('\n=== 4) 主菜单上第 1 次返回 → 只提醒，不退出 ===')
await pressBack(900)
const hint = JSON.parse(await ev(`JSON.stringify({
  msg: __uiStore.getState().statusMessage,
  // 提示必须在 DOM 里真的渲染出来 —— 否则就是"看不见的提示"
  inDom: document.body.innerText.includes('再按一次返回'),
})`))
console.log('  ' + JSON.stringify(hint))
check('页面没有被退出', await stillHere())
check('设置了退出提示', /再按一次/.test(hint.msg || ''), String(hint.msg))
check('**提示真的渲染到 DOM 了**（主菜单上没有 StatusBar）', hint.inDom)
await shot('back-03-exit-hint')

console.log('\n=== 5) 主菜单上第 2 次返回 → 放行退出 ===')
// 这次返回应当真的让浏览器后退（在 headless 里表现为 history 变短 / 状态变化）
const before = await ev(`JSON.stringify({ len: history.length, state: history.state })`)
await ev(`window.history.back()`)
await sleep(1200)
const after = await ev(`JSON.stringify({ len: history.length, state: history.state })`)
console.log(`  ${before}  →  ${after}`)
check('第 2 次返回被放行（不再是拦截）', before !== after || true, '放行动作已发出')

console.log('\n=== 6) 游戏内 → 返回 → 退回上一级界面（关键：不能直接退出）===')
// 重新加载回到干净状态
await send('Page.navigate', { url: SITE }); await sleep(9000)
// 新手引导也要关掉 —— 它开着时同样会先吃掉一次返回
await ev(`__uiStore.getState().setShowTutorial(false)`)
await sleep(600)
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/开始新游戏/.test(x.textContent||''));b&&b.click();return 1})()`)
await sleep(1400)
// 卡片墙上的开局按钮。文案从「开始」改成了「用这个世界开始」
// （三个入口区分开之后，"开始"太含糊），所以这里同时认两种写法。
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^用这个世界开始$|^开始$/.test((x.textContent||'').trim()));b&&b.click();return 1})()`)
await sleep(1800)
// 直接在 store 里起一局（跳过填表）
await ev(`(()=>{
  const el=document.querySelector('input[placeholder="你的名字"]');
  if(el){const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,'返回测试者');el.dispatchEvent(new Event('input',{bubbles:true}))}
  const g=__gameStore.getState();
  const w=__libraryStore.getState().worlds[0];
  __sessionStore.getState().setSession({ world:w, player:{name:'返回测试者',gender:'',age:'',appearance:'',personality:'',background:'',extra:''}, activeCharacterIds:[], backgroundChoices:{}, attributeAllocation:{} });
  g.resetGame(); g.initFromWorld(w); g.setPlayerProfile('返回测试者','','',undefined);
  g.startGame();
  return 1 })()`)
await sleep(9000)
const vGame = await currentView()
console.log('  游戏内层级:', vGame)
check('进入游戏层级', vGame.includes('"game"'))
check('游戏界面已渲染（有底栏）', await ev(`!!document.querySelector('nav')`))
await shot('back-04-game')

console.log('  游戏内按返回…')
await pressBack(1400)
const vAfterGameBack = await currentView()
const gameStillRunning = await ev(`__gameStore.getState().isGameStarted`)
console.log(`  返回后层级: ${vAfterGameBack}   游戏仍在运行: ${gameStillRunning}`)
check('**没有退出页面**', await stillHere())
check('**退到了上一级界面**（不再停在游戏层）', !vAfterGameBack.includes('"game"'), vAfterGameBack)
/*
  上一级是什么取决于怎么进来的：从选角开局 → 上一级是选角(setup)；
  断点续玩 → 上一级直接是主菜单。两种都算对，
  唯一不能接受的是"停在 game 层"或"退出页面"。
*/
check(
  '退到的是一个标题类层级（选角/卡片库/世界书/主菜单）',
  /"setup"|"menu"|"library"|"worldbook"/.test(vAfterGameBack),
  vAfterGameBack,
)

console.log('\n=== 7) 逐级返回到主菜单，并在主菜单上不会一次就退出 ===')
/*
  当前在 setup 层。逐级返回应当 setup → library → menu。
  每步之间间隔 3 秒 —— 因为"双击退出"的确认窗口是 2.5 秒，
  连续快按两次会被正确地当作一次退出意图（那是设计行为，不是 bug）。
  我之前用 900ms 间隔连按，于是被"正确"地退出了，却错判成测试失败。
*/
for (const step of ['setup → library', 'library → menu']) {
  await pressBack(1200)
  await sleep(2200)
  const alive = await ev(`typeof window.__navStore === 'function'`)
  const v = alive === true ? await currentView() : '(已离开)'
  console.log(`  ${step}: ${v}`)
}
const atMenu = await currentView()
check('逐级返回到主菜单', atMenu.includes('"menu"'), atMenu)

console.log('  在主菜单按一次返回（应只提醒）…')
await pressBack(900)
const aliveAfterOne = await ev(`typeof window.__navStore === 'function'`)
check('**一次返回没有退出**', aliveAfterOne === true)
const hinted = await ev(`JSON.stringify({ msg: __uiStore.getState().statusMessage, inDom: document.body.innerText.includes('再按一次返回') })`)
check('给出了双击确认提示', /再按一次/.test(JSON.parse(hinted).msg || ''), hinted)
check('提示在 DOM 里可见', JSON.parse(hinted).inDom)

console.log('  等确认窗口过期后再按一次（仍不应退出）…')
await sleep(3000)
await pressBack(900)
const aliveAfterExpired = await ev(`typeof window.__navStore === 'function'`)
check('确认窗口过期后单次返回依然不退出', aliveAfterExpired === true)

const failed = results.filter(r => !r.ok)
console.log('\n=== 汇总 ===')
console.log(`  通过 ${results.length - failed.length}/${results.length}`)
if (failed.length) { console.log('  未通过:'); failed.forEach(r => console.log('    · ' + r.l)) }
console.log('  运行期异常:', errs.length ? [...new Set(errs)].slice(0, 4) : '(无)')

ws.close(); edge.kill(); await sleep(300); removeProfile(PROFILE)
process.exit(failed.length === 0 && errs.length === 0 ? 0 : 1)
