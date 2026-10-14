import './_ws-shim.mjs'
/**
 * 玩家体验走查（第 2 版）—— 修正上一版探针的 4 处错误判据。
 *
 * 上一版误报的原因（都是探针的问题，不是应用的问题）：
 *  1. 行动输入框的 placeholder 是「输入你的行动…」（带省略号），我只匹配到「输入你的行动」
 *  2. 用假 API Key → 开场生成必然失败 → history 本来就是 0，我却断言"进度没被清掉"
 *  3. 「模型设置 / 物品 / 人物」是在**回到标题页之后**才检查的，那时游戏界面已经不渲染了
 *  4. 返回后继续按钮的实际文字不是我以为的「继续…」
 *
 * 这一版把「游玩中」的检查都放在游戏界面还开着的时候做。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { outDir, profileDir, removeProfile } from './_browser.mjs'

const SITE = process.env.SITE || 'http://localhost:5199/'
// 必须绝对路径：--user-data-dir 用相对路径时 Chromium 会静默失败（见 _browser.mjs 的 outDir）
const OUT = outDir()
/**
 * Edge / Chrome 路径。**必须自动探测**：
 * 本地 Edge 在 Program Files (x86)，CI（windows-latest）在 Program Files，
 * 写死路径会让走查在 CI 上直接跑不起来。
 */
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
const PORT = 9701
const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJson = u => new Promise((res, rej) => {
  http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)) } catch (e) { rej(e) } }) }).on('error', rej)
})
fs.mkdirSync(OUT, { recursive: true })
const PROFILE = profileDir('play2')
const edge = spawn(EDGE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,950', 'about:blank'], { stdio: 'ignore' })
let v = null
for (let i = 0; i < 40; i++) { try { v = await getJson(`http://127.0.0.1:${PORT}/json/version`); break } catch { await sleep(500) } }
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
    if (!/Could not establish connection|Authentication Fails|api key|Game Engine Error/i.test(txt)) errs.push('console.error: ' + txt.slice(0, 140))
  }
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
}
const send = (m, p = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })
  return r.result?.exceptionDetails ? 'THREW ' + (r.result.exceptionDetails.exception?.description || '') : r.result?.result?.value
}
const shot = async (n) => {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  if (s.result?.data) fs.writeFileSync(path.join(OUT, n + '.png'), Buffer.from(s.result.data, 'base64'))
}
const click = (txt) => ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()===${JSON.stringify(txt)});if(!b)return 'no';if(b.disabled)return 'disabled';b.click();return 'ok'})()`)
/** 按正则找按钮（实际文字常带省略号/空格，精确匹配很脆） */
const clickRe = (re) => ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>${re}.test((x.textContent||'').trim()));if(!b)return 'no:'+JSON.stringify([...document.querySelectorAll('button')].map(x=>(x.textContent||'').trim()).filter(Boolean).slice(0,12));if(b.disabled)return 'disabled';b.click();return 'ok'})()`)

const results = []
const check = (l, ok, extra = '') => { results.push({ l, ok }); console.log(`  ${ok ? '✓' : '✗'} ${l}${extra ? '  ' + extra : ''}`) }

await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: SITE }); await sleep(3000)
await ev(`(()=>{const k='pale-notes-ui';let v={};try{v=JSON.parse(localStorage.getItem(k)||'{}')}catch(e){}
  v.state=v.state||{};v.state.llm=Object.assign({provider:'deepseek',baseUrl:'https://api.deepseek.com/v1',narrativeModel:'deepseek-chat',analysisModel:'deepseek-chat',temperature:0.8},v.state.llm||{},{apiKey:'sk-playtest'});
  v.state.isApiKeyModalOpen=false;localStorage.setItem(k,JSON.stringify(v));return 1})()`)
await send('Page.navigate', { url: SITE }); await sleep(9000)

console.log('=== 1) 首次打开：主菜单 ===')
/*
  流程已改：打开网站先进**主菜单**，不再直接铺卡片墙。
  （"门户大开"的问题：新玩家一眼看到九张卡与一堆导入导出按钮，
   不知道自己该从哪开始，也看不出上次玩到哪了。）
*/
const first = JSON.parse(await ev(`(()=>{
  const T=document.body.innerText;
  const bs=[...document.querySelectorAll('button')].map(b=>(b.textContent||'').trim());
  return JSON.stringify({
    hasTitle:/灯叙/.test(T),
    hasNewGame: bs.some(x=>/开始新游戏/.test(x)),
    hasWorldbook: bs.some(x=>/世界书/.test(x)),
    hasLibrary: bs.some(x=>/卡片库/.test(x)),
    hasSettings: bs.some(x=>/模型设置/.test(x)),
  });})()`))
check('主菜单认得出来是什么', first.hasTitle)
check('有「开始新游戏」', first.hasNewGame)
check('有「世界书」', first.hasWorldbook)
check('有「卡片库」', first.hasLibrary)
check('有「模型设置」', first.hasSettings)
await shot('p2-01-title')

console.log('\n=== 2) 选角 ===')
// 主菜单 → 开始新游戏 → 卡片列表
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/开始新游戏/.test((x.textContent||'').trim()));if(b)b.click();return 1})()`)
await sleep(2200)
// 卡片列表 → 点第一张卡的开局按钮。
// 文案从「开始」改成了「用这个世界开始」（主页三个入口区分开之后，
// "开始"这个词在同一屏里有歧义），所以两种写法都要认。
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^用这个世界开始$|^开始$/.test((x.textContent||'').trim()));if(b)b.click();return 1})()`)
await sleep(2500)
const setup = JSON.parse(await ev(`(()=>{
  const T=document.body.innerText;
  const inputs=[...document.querySelectorAll('input,textarea')].map(e=>e.placeholder||'');
  return JSON.stringify({
    hasSteps:['扮演角色','出场角色','背景','属性'].every(s=>T.includes(s)),
    hasNameInput: inputs.includes('你的名字'),
    hasBack:/返回卡库/.test(T),
    noPortraitUpload: !/上传头像/.test(T),
    explainsNoPortrait: /主角不设立绘/.test(T),
  });})()`))
check('四个步骤都有标签', setup.hasSteps)
check('有名字输入框', setup.hasNameInput)
check('能返回卡库（不会卡死）', setup.hasBack)
check('主角头像上传已移除', setup.noPortraitUpload)
check('说明了主角为什么没有立绘', setup.explainsNoPortrait)
await shot('p2-02-setup')

console.log('\n=== 3) 开局 ===')
await ev(`(()=>{const el=document.querySelector('input[placeholder="你的名字"]');if(!el)return 0;
  const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,'体验测试者');
  el.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`)
await sleep(600)
for (let i = 0; i < 6; i++) { const r = await click('下一步'); await sleep(1100); if (r !== 'ok') break }
const budget = await ev(`__libraryStore.getState().worlds[0].attributePoints`)
for (let k = 0; k < budget; k++) {
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='+' && !x.disabled);if(b)b.click();return 1})()`)
  await sleep(300)
}
await sleep(1200)
await click('开始故事')
await sleep(4500)

console.log('=== 4) 游戏界面：玩家能不能开始玩 ===')
const g = JSON.parse(await ev(`(()=>{
  const G=__gameStore.getState();
  const inputs=[...document.querySelectorAll('input,textarea')].map(e=>({ph:e.placeholder||'', type:e.type}));
  const T=document.body.innerText;
  return JSON.stringify({
    started:G.isGameStarted, playerName:G.playerName,
    actionInput: inputs.some(i=>/输入你的行动/.test(i.ph)),
    inputCount: inputs.length,
    // 有错误横幅时玩家知道发生了什么
    hasErrorBanner: /API Key|鉴权|Authentication/.test(T),
    hasRetry: /重试/.test(T),
  });})()`))
console.log('  ' + JSON.stringify(g))
check('进入游戏界面', g.started)
check('主角名带进来了', g.playerName === '体验测试者', g.playerName)
check('有行动输入框（能找到怎么继续）', g.actionInput, JSON.stringify(g.inputCount))
check('API Key 无效时给出了明确错误与重试入口', g.hasErrorBanner && g.hasRetry)
await shot('p2-03-game')

console.log('\n=== 5) 游戏内操作可达性（**趁游戏还开着**检查）===')
const mid = JSON.parse(await ev(`(()=>{
  const bs=[...document.querySelectorAll('button')].map(b=>(b.textContent||'').trim());
  const T=document.body.innerText;
  /*
    ⚠️ 属性/资源名**必须从当前世界卡里读**，不能写死。
    原先这里写死的正则匹配的是 体魄 / 洞察 / 共鸣 与 生命 —— 那是旧内置世界的属性名。
    2026-10 把 9 个世界整合成 3 个深度世界后，属性改成了
    武力/智识/魅力/意志/权限（地渊）等**完全不同的名字**，
    于是那条断言变成"永远为假"，报"状态栏不显示属性" —— 而界面其实是对的。
    探针写死内容词，内容一改就必然假失败。
  */
  let attrNames = [], resNames = [];
  try {
    const st = window.__gameStore ? window.__gameStore.getState() : null;
    const lib = window.__libraryStore ? window.__libraryStore.getState() : null;
    if (lib && Array.isArray(lib.worlds) && lib.worlds.length) {
      // 优先取当前世界；取不到时回退到"卡库里的第一个世界"——
      // 这条断言的意图是"状态栏画出了属性名"，不必依赖具体是哪一张卡。
      const w = (st && st.currentWorldId && lib.worlds.find(x => x.id === st.currentWorldId)) || lib.worlds[0];
      attrNames = (w.attributes || []).map(a => a.name);
      resNames = (w.resources || []).map(r => r.name);
    }
  } catch (e) { /* 探针失败不该让断言炸掉 */ }
  const hasAny = (names) => names.length > 0 && names.some(n => T.includes(n));
  return JSON.stringify({
    settings: bs.some(x=>/模型设置/.test(x)),
    returnBtn: bs.some(x=>/返回标题/.test(x)),
    currentWorld: /当前世界/.test(T),
    trustHint: /进度已自动保存在本机/.test(T),
    inventoryTab: bs.some(x=>x==='物品') || /物品栏/.test(T),
    castTab: bs.some(x=>x==='人物') || bs.some(x=>x==='关系'),
    // 状态栏要能看出自己是谁、有什么
    showsName: T.includes('体验测试者'),
    showsResources: hasAny(resNames),
    showsAttributes: hasAny(attrNames),
    attrNames, resNames,
  });})()`))
console.log('  ' + JSON.stringify(mid))
check('游戏内有模型设置入口', mid.settings)
check('游戏内有返回标题入口', mid.returnBtn)
check('显示当前世界（知道自己在哪里）', mid.currentWorld)
check('提示进度已保存（消除顾虑）', mid.trustHint)
check('能查看物品', mid.inventoryTab)
check('能查看人物', mid.castTab)
check('状态栏显示主角名', mid.showsName)
check('状态栏显示资源', mid.showsResources)
check('状态栏显示属性', mid.showsAttributes)

console.log('\n=== 6) 返回标题 → 继续 ===')
await click('返回标题')
await sleep(900)
const cf = JSON.parse(await ev(`(()=>{const T=document.body.innerText;return JSON.stringify({
  asksConfirm:/确认返回/.test(T), canCancel:/继续玩/.test(T), explains:/仍然保留/.test(T) });})()`))
check('返回前有确认', cf.asksConfirm)
check('可以取消', cf.canCancel)
check('说明进度保留', cf.explains)

const beforeHist = await ev(`(__gameStore.getState().history||[]).length`)
// ⚠️ 也要记下**离开前的在场角色数**。原先这条断言写的是 `after.chars > 0`，
// 它其实是靠「角色卡预设为在场」撑着的 —— 2026-10 用户要求所有预设 NPC
// 一律 `present: false`（谁在场由玩家勾选或 AI 在开场现场决定），
// 于是**玩家一个都没勾时 chars 本来就是 0**，`> 0` 会把正确行为判成失败。
// 真正要验证的是"回去之后东西没丢"，所以改成与离开前**一致**。
const beforeChars = await ev(`(__gameStore.getState().characters||[]).length`)
await click('确认返回')
await sleep(2500)
const back = JSON.parse(await ev(`(()=>{const G=__gameStore.getState();
  const bs=[...document.querySelectorAll('button')].map(b=>(b.textContent||'').trim());
  return JSON.stringify({ backToTitle:!G.isGameStarted, hist:(G.history||[]).length,
    resumeButtons: bs.filter(x=>/继续游戏|回到这一局|尚未开场|进行中/.test(x)),
    stillHasWorld: !!__sessionStore.getState().world });})()`))
console.log('  ' + JSON.stringify(back))
check('回到标题页', back.backToTitle)
check('历史条数未变（进度没被清）', back.hist === beforeHist, `${beforeHist} → ${back.hist}`)
check('世界卡还在（能继续）', back.stillHasWorld)
check('标题页有继续入口', back.resumeButtons.length > 0, JSON.stringify(back.resumeButtons))

const resumed = await clickRe('/继续游戏|回到这一局|尚未开场|进行中/')
console.log('  点继续:', resumed)
await sleep(3000)
const after = JSON.parse(await ev(`(()=>{const G=__gameStore.getState();return JSON.stringify({
  started:G.isGameStarted, playerName:G.playerName, chars:(G.characters||[]).length,
  inventory:(G.inventory||[]).length })})()`))
console.log('  ' + JSON.stringify(after))
check('继续游戏回到了游戏界面', after.started)
check('主角档案还在', after.playerName === '体验测试者')
check('在场角色数与离开前一致（没被清掉）', after.chars === beforeChars, `${beforeChars} → ${after.chars}`)
check('开局物品还在', after.inventory > 0, `${after.inventory} 件`)

const failed = results.filter(r => !r.ok)
console.log('\n=== 汇总 ===')
console.log(`  通过 ${results.length - failed.length}/${results.length}`)
if (failed.length) { console.log('  未通过:'); failed.forEach(r => console.log('    · ' + r.l)) }
console.log('  运行期异常:', errs.length ? [...new Set(errs)].slice(0, 4) : '(无)')

ws.close(); edge.kill(); await sleep(300); removeProfile(PROFILE)
process.exit(failed.length === 0 && errs.length === 0 ? 0 : 1)
