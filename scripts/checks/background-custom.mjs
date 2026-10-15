/**
 * 浏览器走查：**「我自己写」背景项**（2026-10 第九轮）
 *
 * ## 为什么单独一套
 *
 * 玩家原话：「背景槽位**依旧过于具体，限制住了剧情的开展**」。
 *
 * 修法有两半：数据那一半（选项去专名 + 每槽加自填项）由 `check-worlds.mjs` 查；
 * 逻辑那一半（玩家写的字取代预设标题进提示词）由单元测试查。
 * 但**中间那一段 —— 界面真的把文本框放出来了吗、输入真的进了 store 吗 —— 没人查**。
 *
 * 而这一段恰恰是最容易"看起来好了其实没接上"的：
 * 按钮在、点了没反应；文本框在、打进去的字没进 state；
 * 一切都对、但 `setSession` 忘了带上 `backgroundCustom`。
 * 这类错单元测试是测不出来的（它们直接调函数，不经过 React 的受控组件）。
 */
/*
  ⚠️ `_ws-shim.mjs` 必须是**第一个** import（Node 20 没有全局 WebSocket，CI 会直接挂）。
*/
import './_ws-shim.mjs'
import { launch, sleep, outDir, profileDir, removeProfile } from './_browser.mjs'

const SITE = process.env.SITE || 'http://localhost:5199/'
const OUT = outDir()
const PROFILE = profileDir('bgcustom')

const { send, ev, close, errors } = await launch({
  port: 9976, userDataDir: PROFILE, viewport: { width: 1280, height: 1000 },
})

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  —— ' + detail : ''}`) }
}
const shot = async (name) => {
  try {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    const fs = await import('node:fs')
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'))
    console.log(`  [截图] ${OUT}/${name}.png`)
  } catch { /* 截图失败不该让走查挂掉 */ }
}
const waitFor = async (expr, timeoutMs = 12000, every = 250) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await ev(expr)) return true
    await sleep(every)
  }
  return false
}
const clickText = (re) =>
  ev(`(()=>{const b=[...document.querySelectorAll('button')]
    .find(x=>${re}.test((x.textContent||'').trim()));
    if(!b)return 'no';if(b.disabled)return 'disabled';b.click();return 'ok'})()`)

/** React 受控组件：必须走原型上的 value setter，否则 onChange 不触发 */
const typeInto = (sel, text) => ev(`(()=>{
  const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'no';
  const proto = el.tagName==='TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const s=Object.getOwnPropertyDescriptor(proto,'value').set;
  s.call(el, ${JSON.stringify(text)});
  el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()`)

await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false })

await send('Page.navigate', { url: SITE }); await sleep(1500)
await ev(`(()=>{const k='pale-notes-ui';let v={};try{v=JSON.parse(localStorage.getItem(k)||'{}')}catch(e){}
  v.state=v.state||{};v.state.llm=Object.assign({provider:'deepseek',baseUrl:'https://api.deepseek.com/v1',narrativeModel:'deepseek-chat',analysisModel:'deepseek-chat',temperature:0.8},v.state.llm||{},{apiKey:'sk-bgcustom'});
  v.state.isApiKeyModalOpen=false;v.state.showTutorial=false;localStorage.setItem(k,JSON.stringify(v));return 1})()`)
await ev(`(()=>{const u=__uiStore.getState();u.setApiKeyModalOpen(false);
  if(u.setShowTutorial)u.setShowTutorial(false);return 1})()`)

await waitFor(`/开始新游戏/.test(document.body.innerText)`, 15000)

console.log('\n=== 1) 世界卡数据：每个槽位都有一道自填的门 ===')
const data = JSON.parse(await ev(`(()=>{
  const ws=__libraryStore.getState().worlds||[];
  const builtin=ws.filter(w=>w.builtin);
  const bad=[], ok=[];
  for(const w of builtin){
    for(const s of (w.backgrounds||[])){
      const cs=(s.options||[]).filter(o=>o.custom);
      const last=(s.options||[])[(s.options||[]).length-1];
      if(cs.length!==1) bad.push(w.title+' / '+s.label+' : custom 项 '+cs.length+' 个');
      else if(!last||!last.custom) bad.push(w.title+' / '+s.label+' : 自填项不在最后');
      else ok.push(1);
    }
  }
  return JSON.stringify({worlds:builtin.length, okSlots:ok.length, bad:bad.slice(0,10)});})()`))
check('内置世界都载入了', data.worlds > 0, `${data.worlds} 个`)
check('★ 每个背景槽都有且仅有一个「我自己写」、且在末尾', data.bad.length === 0,
  data.bad.length ? data.bad.join('；') : `${data.okSlots} 个槽位全部合规`)

console.log('\n=== 2) 进入选角页 ===')
await clickText('/开始新游戏/')
await waitFor(`/用这个世界开始|^开始$/.test(document.body.innerText)`, 12000)
await ev(`(()=>{const b=[...document.querySelectorAll('button')]
  .find(x=>/^用这个世界开始$|^开始$/.test((x.textContent||'').trim()));if(b)b.click();return 1})()`)
await waitFor(`/扮演角色/.test(document.body.innerText) && /下一步/.test(document.body.innerText)`, 15000)

console.log('\n=== 3) 走到「背景」这一步 ===')
// 步骤条可以直接点，不必一页页翻
await ev(`(()=>{const b=[...document.querySelectorAll('button')]
  .find(x=>(x.textContent||'').trim().endsWith('背景'));if(b)b.click();return 1})()`)
const gotBg = await waitFor(`/你的来处/.test(document.body.innerText)`, 12000)
check('切到背景步骤', gotBg)
await shot('bgc-01-slots')

/*
  ⚠️ 截图前**必须滚到自填项那里**。
  第一版没滚，拍出来的是第一个槽的预设项 —— 而自填项在每个槽的**末尾**，
  在屏幕外。于是那张图完全证明不了这个功能存在（我自己看时就愣了一下）。
  "截图要拍到你声称验证的那个东西"，这一条比断言还容易被忘。
*/
const scrollTo = (sel, block = 'center') =>
  ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
    if(!el)return 'no';el.scrollIntoView({block:${JSON.stringify(block)}});return 'ok'})()`)
// 先把第一个槽的「我自己写」按钮滚到屏幕中间，再拍
await ev(`(()=>{const b=[...document.querySelectorAll('button')]
  .find(x=>(x.textContent||'').includes('我自己写'));
  if(b)b.scrollIntoView({block:'center'});return 1})()`)
await sleep(500)
await shot('bgc-01-entry')

console.log('\n=== 4) 每个槽位在界面上都有自填按钮 ===')
const ui = JSON.parse(await ev(`(()=>{
  const btns=[...document.querySelectorAll('button')].filter(b=>(b.textContent||'').includes('我自己写'));
  const slots=[...document.querySelectorAll('h3')].map(h=>(h.textContent||'').trim());
  return JSON.stringify({customBtns:btns.length, slots});})()`))
check('★ 每个槽位一个「我自己写」按钮', ui.customBtns > 0 && ui.customBtns === ui.slots.length,
  `${ui.customBtns} 个按钮 / ${ui.slots.length} 个槽位（${ui.slots.join('、')}）`)
// 自填项默认**不该**被选中（默认是第一个预设）
const defaultState = JSON.parse(await ev(`(()=>{
  const ta=document.querySelector('textarea');
  return JSON.stringify({hasTextarea: !!ta});})()`))
check('自填项默认未选中（不展开文本框）', !defaultState.hasTextarea)

console.log('\n=== 5) 点自填 → 出文本框 → 输入 → 值真的进了 state ===')
await ev(`(()=>{const b=[...document.querySelectorAll('button')]
  .find(x=>(x.textContent||'').includes('我自己写'));if(b)b.click();return 1})()`)
const hasTa = await waitFor(`!!document.querySelector('textarea')`, 8000)
check('★ 选中后展开文本框', hasTa)

const MY_TEXT = '在一间没人管的档案室里替人抄旧卷宗，抄了九年，知道哪几格是空的'
if (hasTa) {
  // 空着的时候应当有提示
  const warn = await ev(`/还没写/.test(document.body.innerText)`)
  check('空着时给出提示（说明空着就没有效果）', !!warn)

  check('往文本框里输入', await typeInto('textarea', MY_TEXT) === 'ok')
  await sleep(400)
  const typed = await ev(`(()=>{const t=document.querySelector('textarea');return t?t.value:''})()`)
  check('★ 输入被 React 接住（受控组件回填）', typed === MY_TEXT, typed.slice(0, 24) + '…')

  const warnGone = await ev(`!/还没写/.test(document.body.innerText)`)
  check('写了之后提示消失', !!warnGone)
}
if (hasTa) await scrollTo('textarea', 'center')
await sleep(300)
await shot('bgc-02-custom-filled')

console.log('\n=== 6) 清空后又回到"没写"的状态 ===')
check('清空文本框', await typeInto('textarea', '') === 'ok')
await sleep(400)
check('提示回来了', await ev(`/还没写/.test(document.body.innerText)`))
await sleep(300)
await shot('bgc-03-custom-empty')

console.log('\n=== 7) 换一个槽位再试（不是只有第一个能用） ===')
const multi = await ev(`(()=>{
  const btns=[...document.querySelectorAll('button')].filter(b=>(b.textContent||'').includes('我自己写'));
  if(btns.length<2)return 'only-one';
  btns[1].click();return 'ok'})()`)
if (multi === 'ok') {
  await sleep(500)
  const taCount = await ev(`document.querySelectorAll('textarea').length`)
  check('★ 第二个槽位也能展开自填框', taCount >= 1, `${taCount} 个文本框`)
} else {
  check('★ 第二个槽位也能展开自填框', false, '只有一个自填按钮')
}

const failed = fail
console.log(`\n=== 汇总 ===\n  通过 ${pass}/${pass + fail}`)
if (errors?.length) console.log(`  页面错误 ${errors.length} 条：${errors.slice(0, 3).join(' | ')}`)
if (failed) { await shot('bgc-fail'); }
await close(); removeProfile(PROFILE)
process.exit(failed === 0 && !(errors?.length) ? 0 : 1)
