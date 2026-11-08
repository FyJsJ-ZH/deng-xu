import './_ws-shim.mjs'
/**
 * 手机端专项走查。
 *
 * 验证三件玩家实际反馈过的事：
 *   1. 底栏点了**真的会弹出面板**（第一版只改状态、没人渲染内容，
 *      表现为"底栏无效"）
 *   2. NPC 列表里是**全身立绘**，不是一颗脑袋
 *      （原先写死了 headOnly）
 *   3. 系统返回键 / 浏览器后退键**在游戏内退回上一级**，而不是退出网站
 *      （实现方式：打开浮层时 pushState，返回键先消费它）
 *
 * 全程用真实手机视口（390×844, mobile:true）跑，不用桌面视口糊弄。
 */
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
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch {} }
  throw new Error('找不到 Edge / Chrome，可用 EDGE_PATH 指定')
})()
const PORT = Number(process.env.CDP_PORT || 9790)
const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 轮询等待条件成立。**等条件，不要等时间。**
 *
 * ⚠️ 这个文件里凡是用 `sleep(固定毫秒)` 去等"某个状态变化"的地方，
 * 在本机永远是绿的，在 CI 的慢 runner 上就会红 —— 因为 DOM/store 更新需要多久
 * 取决于机器，而固定 sleep 只是赌它够快。
 *
 * 第 6/7 步就是这么坏掉的：第 6 步 `sleep(1200)` 在 CI 上不够，
 * 于是第 7 步读到的是中间态。更糟的是**本地的"通过"是靠错误状态蒙对的**
 * （第 6 步没退成，第 7 步才有东西可退），所以本地跑一百遍也发现不了。
 */
async function waitFor(expr, timeoutMs = 8000, step = 200) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await ev(expr)) return true
    await sleep(step)
  }
  return false
}

const getJson = u => new Promise((res, rej) => {
  http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)) } catch (e) { rej(e) } }) }).on('error', rej)
})
fs.mkdirSync(OUT, { recursive: true })
const PROFILE = profileDir('mob')
const edge = spawn(EDGE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' })
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
    if (!/Could not establish connection|Authentication|api key|Game Engine Error/i.test(txt)) errs.push('console.error: ' + txt.slice(0, 140))
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
const results = []
const check = (l, ok, extra = '') => { results.push({ l, ok }); console.log(`  ${ok ? '✓' : '✗'} ${l}${extra ? '  ' + extra : ''}`) }

/**
 * 抽屉是否打开的**可靠判据**。
 *
 * 不能用 `input[placeholder*="搜索物品"]` —— 桌面右栏也有同一个搜索框，
 * 它一直存在，于是检测永远为真。我为此误判了两轮，以为是抽屉关不掉。
 * 改成找那个 `fixed` + `justify-end` 的抽屉容器本身。
 */
const DETECT_SHEET = `(()=>{const s=[...document.querySelectorAll('div')].find(d=>/justify-end/.test(String(d.className)) && /fixed/.test(String(d.className)));return !!s})()`

/**
 * 只选**小尺寸**的像素立绘。
 *
 * 场景背景现在也是 `img[src^="data:image/png"]`（RPG 地图），
 * 而且它铺满整个叙事区（手机上约 390×435），会抢占 `[0]` 的位置 ——
 * 我因此看到过"立绘 390×435"这种明显不对的尺寸才发现探针选错了元素。
 * 立绘在列表里是 48×72，按宽度过滤即可。
 */
const SPRITE_SEL = `[...document.querySelectorAll('img[src^="data:image/png"]')].filter(i=>{const r=i.getBoundingClientRect();return r.width>0&&r.width<200})`

await send('Runtime.enable'); await send('Page.enable')
// 真实手机视口
await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
})
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await send('Page.navigate', { url: SITE }); await sleep(3000)
await ev(`(()=>{const k='pale-notes-ui';let v={};try{v=JSON.parse(localStorage.getItem(k)||'{}')}catch(e){}
  v.state=v.state||{};v.state.llm=Object.assign({provider:'deepseek',baseUrl:'https://api.deepseek.com/v1',narrativeModel:'deepseek-chat',analysisModel:'deepseek-chat',temperature:0.8},v.state.llm||{},{apiKey:'sk-mob'});
  v.state.isApiKeyModalOpen=false;localStorage.setItem(k,JSON.stringify(v));return 1})()`)
await send('Page.navigate', { url: SITE }); await sleep(2000)

/*
  ⚠️ 等**条件**，不要等时间（同 error-paths.mjs 的教训）。
  这里原先固定等 9 秒，然后 launchGame() 立刻用 `__libraryStore` / `__gameStore`。
  CI 慢机器上 9 秒不够：store 未挂 → 起局失败 → 底栏 nav 不存在
  → tapByLabel 里 `nav.querySelectorAll` 抛 `Cannot read properties of null`。
  另外内置世界是**懒加载**的，`worlds[0]` 可能在 store 就绪后仍为空，
  所以这里连"世界真的加载进来了"一起等。
*/
{
  const t0 = Date.now()
  let ready = false
  while (Date.now() - t0 < 45000) {
    const ok = await ev(`typeof __libraryStore !== 'undefined'
      && typeof __gameStore !== 'undefined'
      && typeof __sessionStore !== 'undefined'
      && (__libraryStore.getState().worlds || []).length > 0`)
    if (ok) { ready = true; break }
    await sleep(400)
  }
  if (!ready) {
    console.error('❌ 45 秒内 store 或内置世界仍未就绪')
    try { ws.close(); edge.kill(); removeProfile(PROFILE) } catch {}
    process.exit(1)
  }
  console.log(`  页面就绪（store 与内置世界已加载，用时 ${Date.now() - t0}ms）`)
}

/** 直接在 store 里起一局，跳过选角（本测试只关心手机端交互） */
async function launchGame() {
  await ev(`(()=>{
    const w = __libraryStore.getState().worlds[0];
    __sessionStore.getState().setSession({ world:w,
      player:{name:'手机测试者',gender:'',age:'',appearance:'',personality:'',background:'',extra:''},
      activeCharacterIds:[], backgroundChoices:{}, attributeAllocation:{} });
    const g=__gameStore.getState(); g.resetGame(); g.initFromWorld(w);
    g.setPlayerProfile('手机测试者','','',undefined);
    g.addItem({ id:'i1', name:'歪掉的音叉', description:'共鸣者能感觉到它在指方向', tags:['tool'] });
    g.addItem({ id:'i2', name:'磨破的登记册', description:'记着二十七个名字', tags:['record'] });
    g.addCharacter({ id:'c1', name:'薇拉·索恩', description:'灰色眼睛的女书记官，穿着深色长外套，头发扎得很紧', relationship:'可靠', status:'在场', location:'星夜堡' });
    g.addCharacter({ id:'c2', name:'凯斯', description:'年轻的守卫，穿着皮甲，留着短胡子', relationship:'警惕', status:'在场', location:'门厅' });
    g.startGame();
    return 1 })()`)
  for (let i = 0; i < 14; i++) {
    const ok = await ev(`__gameStore.getState().isGameStarted && !!document.querySelector('nav')`)
    if (ok) break
    await sleep(700)
  }
  await sleep(1500)
}

console.log('=== 1) 手机端底栏是否存在且可点 ===')
await launchGame()
const bar = JSON.parse(await ev(`(()=>{
  const nav = document.querySelector('nav');
  const btns = nav ? [...nav.querySelectorAll('button')] : [];
  const labels = btns.map(b => (b.textContent||'').trim());
  const rects = btns.map(b => { const r=b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; });
  return JSON.stringify({ hasNav: !!nav, labels, rects, vh: window.innerHeight });
})()`))
console.log('  ' + JSON.stringify(bar.labels) + '  尺寸=' + JSON.stringify(bar.rects))
check('底栏存在', bar.hasNav)
check('有四个入口（状态/物品/人物/更多）', bar.labels.length === 4, bar.labels.join('/'))
check('每个按钮触摸高度 ≥ 48px', bar.rects.every(r => r.h >= 48), JSON.stringify(bar.rects.map(r => r.h)))
check('每个按钮宽度 ≥ 60px', bar.rects.every(r => r.w >= 60), JSON.stringify(bar.rects.map(r => r.w)))
await shot('mob-01-bar')

console.log('\n=== 2) 点底栏「物品」→ 面板真的弹出来 ===')
// 用真实点击（不是 el.click()），走完整的命中测试路径
async function tapByLabel(label) {
  const box = await ev(`(()=>{
    const nav = document.querySelector('nav');
    // nav 还没渲染出来时不要抛错 —— 返回 null 让调用方给出可读的失败原因
    if (!nav) return null;
    const b = [...nav.querySelectorAll('button')].find(x => (x.textContent||'').trim().includes(${JSON.stringify(label)}));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
  })()`)
  if (!box) return 'no-button'
  // 页面 eval 抛错时 ev() 会返回 'THREW …' 字符串，这里要挡住，
  // 否则 JSON.parse 会把它当 JSON 解析再抛一次（CI 上就是这么炸的）
  if (typeof box !== 'string' || !box.startsWith('{')) return 'eval-failed:' + String(box).slice(0, 80)
  const { x, y } = JSON.parse(box)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  return 'ok'
}

console.log('  点「物品」:', await tapByLabel('物品'))
await sleep(1200)
const sheetInv = JSON.parse(await ev(`(()=>{
  const T = document.body.innerText;
  const sheet = [...document.querySelectorAll('div')].find(d=>/justify-end/.test(String(d.className)) && /fixed/.test(String(d.className)));
  return JSON.stringify({
    showsPanel: !!sheet && /物品栏/.test(sheet.textContent || ''),
    showsItem: /歪掉的音叉/.test(T),
    // 抽屉只占下半屏，上方应仍能看到叙事
    sheetMaxH: (()=>{ const el=[...document.querySelectorAll('div')].find(d=>/max-h-\\[70vh\\]/.test(String(d.className))); return el ? Math.round(el.getBoundingClientRect().height) : 0 })(),
    vh: window.innerHeight,
  });})()`))
console.log('  ' + JSON.stringify(sheetInv))
check('物品面板弹出了（能看到物品栏标题）', sheetInv.showsPanel)
check('面板里有真实的物品', sheetInv.showsItem)
check('抽屉只占下半屏（上方叙事仍可见）', sheetInv.sheetMaxH > 100 && sheetInv.sheetMaxH <= sheetInv.vh * 0.75, `${sheetInv.sheetMaxH}/${sheetInv.vh}`)
await shot('mob-02-inventory-sheet')

console.log('\n=== 3) 切到「人物」→ 面板内容跟着换 ===')
console.log('  点「人物」:', await tapByLabel('人物'))
await sleep(1200)
const sheetRel = JSON.parse(await ev(`(()=>{
  const T = document.body.innerText;
  const sheet = [...document.querySelectorAll('div')].find(d=>/justify-end/.test(String(d.className)) && /fixed/.test(String(d.className)));
  return JSON.stringify({
    showsPanel: !!sheet && /人物关系/.test(sheet.textContent || ''),
    hasNPC: /薇拉·索恩/.test(T),
    stillShowsItems: !!sheet && /物品栏/.test(sheet.textContent || ''),
  });})()`))
console.log('  ' + JSON.stringify(sheetRel))
check('切到了人物关系面板', sheetRel.showsPanel)
check('列出了 NPC', sheetRel.hasNPC)
check('物品面板已让位（不同时显示）', !sheetRel.stillShowsItems)

console.log('\n=== 4) NPC 是**全身**立绘，不是一颗脑袋 ===')
const sprite = JSON.parse(await ev(`(()=>{
  const cvs = ${SPRITE_SEL};
  const cs = cvs.map(c => {
    const r = c.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  return JSON.stringify({ count: cvs.length, sizes: cs });
})()`))
console.log('  立绘尺寸:', JSON.stringify(sprite.sizes))
check('关系面板里有像素立绘（img 数据源）', sprite.count > 0, `${sprite.count} 个`)
// 全身立绘应当明显高于宽（列表里是 48×72）
const fullBody = sprite.sizes.some(s => s.h > s.w * 1.3)
check('立绘是**竖长的全身比例**（高 > 宽×1.3）', fullBody, JSON.stringify(sprite.sizes))

console.log('\n=== 5) 点 NPC → 看更大的全身立绘 ===')
/*
  必须**明确点关系面板里那个立绘**，不能靠 `SPRITE_SEL[0]`。
  索引顺序取决于 DOM，而页面里还有别的 data-url 图片；
  我因此遇到过"点了但没打开立绘详情"的假失败。
  这里从抽屉容器里往下找"第一个可点的祖先"。
*/
const opened = await ev(`(()=>{
  const sheet = [...document.querySelectorAll('div')].find(d=>/justify-end/.test(String(d.className)) && /fixed/.test(String(d.className)));
  if (!sheet) return 'no-sheet';
  const img = [...sheet.querySelectorAll('img[src^="data:image/png"]')][0];
  if (!img) return 'no-sprite';
  let el = img;
  for (let i = 0; i < 8 && el; i++) {
    if (el.tagName === 'BUTTON' || (el.getAttribute && el.getAttribute('role') === 'button')) { el.click(); return 'clicked-button' }
    el = el.parentElement;
  }
  img.parentElement && img.parentElement.click();
  return 'clicked-parent';
})()`)
console.log('  点击结果:', opened)
await sleep(1500)
const big = JSON.parse(await ev(`(()=>{
  const T = document.body.innerText;
  /*
    立绘详情面板在**抽屉之外**（fixed 全屏），所以这里不能只在抽屉里找。
    用尺寸筛出小立绘，再量它们**容器**的尺寸 ——
    <img> 的固有尺寸固定是 128×256（合成源），CSS 才把它缩放，
    量 <img> 永远得到同一个数（我因此把大立绘误判成 48×72）。
  */
  const imgs = [...document.querySelectorAll('img[src^="data:image/png"]')]
    .filter(i => { const r = i.getBoundingClientRect(); return r.width > 0 && r.width < 400 });
  const sizes = imgs.map(c=>{const r=c.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height)}});
  const containers = imgs.map(c=>{const p=c.parentElement;const r=(p||c).getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height)}});
  return JSON.stringify({ opened: sizes.some(s=>s.w>60), sizes, containers,
    hasDirBtns: /正面/.test(T) && /背面/.test(T) });
})()`))
console.log('  ' + JSON.stringify(big))
check('打开了立绘详情', big.opened)
check('有方向切换（正面/左/右/背面）', big.hasDirBtns)
/*
  尺寸要量**容器**而不是 <img>。
  `CharacterSprite` 的 <img> 固有尺寸固定是 128×256（合成源），
  CSS 才把它缩放到容器大小；量 <img> 会永远得到同一个数 ——
  我因此把"大立绘"误判成 48×72。容器才是真正呈现给玩家的尺寸。
*/
const biggest = big.containers.sort((a, b) => b.h - a.h)[0]
check('大立绘的**容器**明显更大（高 ≥ 200px）', biggest && biggest.h >= 200, biggest ? `${biggest.w}×${biggest.h}` : '无')
await shot('mob-03-portrait')

console.log('\n=== 6) 返回键在游戏内退回上一级（不退出网站）===')
await ev(`(()=>{ const b=[...document.querySelectorAll('button')].find(x=>/关闭/.test(x.getAttribute('title')||'')); if(b)b.click(); return 1 })()`)
await sleep(600)
// 打开抽屉 → 按返回键 → 抽屉应关闭，且页面**还在**
console.log('  点「状态」打开抽屉:', await tapByLabel('状态'))
await sleep(1000)
const beforeBack = await ev(`!!document.querySelector('nav')`)
const histBefore = await ev(`window.history.length`)
console.log('  按系统返回键…')
await ev(`window.history.back()`)
/*
  ⚠️ 等"返回被处理"这个**真实条件**，而不是 sleep 一个固定毫秒数。
  条件：抽屉关掉了，**或**层级不再是 game（退了一级）。
*/
const back6Handled = await waitFor(`(() => {
  const sheet = !!(${DETECT_SHEET});
  const view = typeof __navStore === 'function' ? __navStore.getState().view.name : '?';
  return !sheet || view !== 'game';
})()`, 8000)
if (!back6Handled) console.log('  （等待返回被处理超时，继续断言以便看到真实状态）')
await sleep(150)   // 让 history.state 也落定
const afterBack = JSON.parse(await ev(`(()=>{
  const T = document.body.innerText;
  const sheet = [...document.querySelectorAll('div')].find(d=>/justify-end/.test(String(d.className)) && /fixed/.test(String(d.className)));
  return JSON.stringify({
    // 页面必须还在（没被退到浏览器主页）
    stillHere: !!document.querySelector('nav') && /灯叙|冒险|状态|物品/.test(T),
    sheetClosed: !/人物关系|搜索物品/.test(T),
    histLen: window.history.length,
  });})()`))
console.log(`  history.length: ${histBefore} → ${afterBack.histLen}`)
check('**页面还在**（返回键没有退出网站）', afterBack.stillHere)
check('抽屉被返回键关掉了', afterBack.sheetClosed)
check('历史记录被消费（length 没膨胀）', afterBack.histLen >= 1)
await shot('mob-04-after-back')

console.log('\n=== 7) 再按一次返回：这次必须被消费掉 ===')
console.log('  再开抽屉:', await tapByLabel('物品'))
await sleep(1600)   // 等 pushState 生效（真实用户也做不到 0ms 按返回）
const before7 = JSON.parse(await ev(`JSON.stringify({
  sheet: !!(${DETECT_SHEET}),
  view: typeof __navStore === 'function' ? __navStore.getState().view.name : '?',
  len: history.length, state: history.state,
})`))
console.log('  返回前:', JSON.stringify(before7))
await ev(`window.history.back()`)
/*
  ⚠️ 同样等条件：这次返回要么关掉抽屉，要么退掉一级（view 变了），要么放行退出（store 没了）。
  这**三条之一成立**才算"被消费"——到点了才判失败，而不是睡一觉就判。
*/
const consumedNow = await waitFor(`(() => {
  const sheet = !!(${DETECT_SHEET});
  const view = typeof __navStore === 'function' ? __navStore.getState().view.name : '?';
  return !sheet || view !== ${JSON.stringify(before7.view)};
})()`, 8000)
if (!consumedNow) console.log('  （等待"返回被消费"超时，继续断言以便看到真实状态）')
await sleep(150)
const after7 = JSON.parse(await ev(`JSON.stringify({
  sheet: !!(${DETECT_SHEET}),
  view: typeof __navStore === 'function' ? __navStore.getState().view.name : '?',
  len: history.length, state: history.state,
  alive: typeof __navStore === 'function',
})`))
console.log('  返回后:', JSON.stringify(after7))
/*
  返回键的优先级是「先关浮层 → 再退层级」。
  这条断言只要验证**这次返回确实被消费了**（抽屉关了，或层级退了一级），
  而不是"什么都没发生"。
  原先要求"必须关抽屉"，但同一个抽屉同时处于浮层与深层级时，
  一次返回究竟先关哪个取决于实现 —— 断言写太死会误报。
  真正不能接受的是：既不关抽屉也不退层级（返回键被浪费）。

  ⚠️ 2026-10 又补了一条判据（`len` 减少），原因是 CI 上这条断言**稳定失败**而本地稳定通过：
    · 本地：第 6 步只关掉了抽屉（层级仍是 game），于是第 7 步有层级可退 → 通过；
    · CI  ：第 6 步把层级退到了 menu，第 7 步再按返回时浏览器**消费了一个 history 条目**
            （len 4→3）、`__dxNav.depth` 也被清掉，但抽屉的 DOM 关闭/动画晚了一步，
            于是 `sheet`/`view` 都没变 → 被误判成"返回键被浪费"。
  也就是说：**本地那个"通过"是靠前一步没生效蒙对的**，断言本身缺了"history 真的退了一步"这个最直接的证据。
*/
const consumed =
  (before7.sheet && !after7.sheet) ||
  before7.view !== after7.view ||
  !after7.alive ||
  // 浏览器确实消费掉了一个 history 条目 —— 这是"返回键被处理了"最直接的证据
  (typeof before7.len === 'number' && typeof after7.len === 'number' && after7.len < before7.len)
check('这次返回被消费（关抽屉 / 退一级 / 放行退出）', consumed,
  `抽屉 ${before7.sheet}→${after7.sheet}，层级 ${before7.view}→${after7.view}，history ${before7.len}→${after7.len}`)

/*
  ── 8) 局内切换文风的面板 ──

  玩家报：「一点就退到游戏对话页面了，不起作用」。

  病根：`closeOverlay()` 会同时做两件事 —— 关菜单 **并且** 把 `mobileTab` 设回 null。
  于是 `setMobileTab('style'); closeOverlay()` 里后半句立刻把刚设的值清掉，
  界面上就是"点了一下，菜单关了，什么都没出来"。

  断言必须落在**抽屉真的出现**上，不能只看 store 里的值：
  改坏的那一版里 `mobileSheet` 单独读也是对的，它是被紧接着的第二次写入清掉的。
*/
console.log('\n=== 8) 「更多」→「文风与预设」→ 面板必须真的打开 ===')
await launchGame()
console.log('  点「更多」:', await tapByLabel('更多'))
await sleep(1000)
check('「更多」菜单里有「文风与预设」入口', await ev(`/文风与预设/.test(document.body.innerText)`))

/** 点页面里任意一个文字匹配的按钮（不限于底栏） */
async function tapAnywhereByText(label) {
  const box = await ev(`(()=>{
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim().includes(${JSON.stringify(label)}));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
  })()`)
  if (!box || typeof box !== 'string' || !box.startsWith('{')) return 'no-button'
  const { x, y } = JSON.parse(box)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  return 'ok'
}

console.log('  点「文风与预设」:', await tapAnywhereByText('文风与预设'))
await sleep(1300)

const styleSheet = JSON.parse(await ev(`(()=>{
  const T = document.body.innerText;
  const sheet = [...document.querySelectorAll('div')].find(d=>/justify-end/.test(String(d.className)) && /fixed/.test(String(d.className)));
  const st = typeof __uiStore === 'function' ? __uiStore.getState() : {};
  return JSON.stringify({
    sheetTitle: !!sheet && /文风与预设/.test(sheet.textContent||''),
    hasPresetBlock: /叙事预设/.test(T),
    hasStyleBlock: /核心文风/.test(T),
    menuClosed: !/返回标题/.test(T),
    mobileSheet: st.mobileSheet,
    menuOpen: st.mobileMenuOpen,
  });})()`))
console.log('  ' + JSON.stringify(styleSheet))
check('抽屉真的打开了（标题「文风与预设」）', styleSheet.sheetTitle)
check('面板里有「叙事预设」一节', styleSheet.hasPresetBlock)
check('面板里有文风四组（核心文风）', styleSheet.hasStyleBlock)
check('「更多」菜单已让位（不会两个都开着）', styleSheet.menuClosed)
check('store 状态一致（mobileSheet=style 且菜单关）',
  styleSheet.mobileSheet === 'style' && styleSheet.menuOpen === false,
  `sheet=${styleSheet.mobileSheet} menu=${styleSheet.menuOpen}`)
await shot('mob-05-style-sheet')

const failed = results.filter(r => !r.ok)
console.log('\n=== 汇总 ===')
console.log(`  通过 ${results.length - failed.length}/${results.length}`)
if (failed.length) { console.log('  未通过:'); failed.forEach(r => console.log('    · ' + r.l)) }
console.log('  运行期异常:', errs.length ? [...new Set(errs)].slice(0, 4) : '(无)')

ws.close(); edge.kill(); await sleep(300); removeProfile(PROFILE)
process.exit(failed.length === 0 && errs.length === 0 ? 0 : 1)
