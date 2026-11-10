/**
 * 浏览器走查：**叙事预设的逐条勾选**（2026-11 第三十七轮）
 *
 * ## 玩家原话
 *
 * > 「现在的酒馆预设都有勾选功能，但本项目没有可自定义的选项，导入以后就固定了，
 * >   加入这个功能」
 *
 * ## 这套走查盯的是什么
 *
 * 单测已经钉住了「勾掉的条目不再进提示词」这条**逻辑**。
 * 但玩家碰到的失败从来不在逻辑那一层：
 *
 *  - 复选框在、点了没反应（store action 名字写错 / 忘了 `void`）；
 *  - store 变了、界面没变（没订阅 `narrativePresets`，读的是旧引用）；
 *  - 界面变了、但拼出来的三段快照没跟上（注入的还是全量，玩家以为开关坏了）。
 *
 * 这三条都是"看起来好了其实没接上"，单元测试测不到 —— 它们直接调函数，
 * 不经过 React 的受控组件与 zustand 的订阅。
 */
/*
  ⚠️ `_ws-shim.mjs` 必须是**第一个** import（Node 20 没有全局 WebSocket，CI 会直接挂）。
*/
import './_ws-shim.mjs'
import { launch, sleep, outDir, profileDir, removeProfile } from './_browser.mjs'

const SITE = process.env.SITE || 'http://localhost:5199/'
const OUT = outDir()
const PROFILE = profileDir('preset-toggle')

const { send, ev, close, errors } = await launch({
  port: 9982, userDataDir: PROFILE, viewport: { width: 1280, height: 1000 },
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
const waitFor = async (expr, timeoutMs = 25000, every = 200) => {
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

await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false })

await send('Page.navigate', { url: SITE }); await sleep(1500)

// 先把 API key 塞好，别让 onboarding 弹窗挡住
await ev(`(()=>{const k='pale-notes-ui';let v={};try{v=JSON.parse(localStorage.getItem(k)||'{}')}catch(e){}
  v.state=v.state||{};v.state.llm=Object.assign({provider:'deepseek',baseUrl:'https://api.deepseek.com/v1',narrativeModel:'deepseek-chat',analysisModel:'deepseek-chat',temperature:0.8,thinking:'off'},v.state.llm||{},{apiKey:'sk-presettoggle'});
  localStorage.setItem(k,JSON.stringify(v));return 'ok'})()`)
await send('Page.navigate', { url: SITE }); await sleep(1800)

/*
  等 store 挂上。CI 的冷启动比本地慢得多 —— 首屏要先从 IndexedDB 播种
  14 张内置卡，才轮到 `main.tsx` 那段动态 import 把 store 挂到 window。
  12 秒在本地绰绰有余，在 Windows runner 上不一定，所以放到 25 秒。
*/
const ready = await waitFor('!!window.__libraryStore && !!window.__navStore')
check('store 就绪（dev server）', ready)
if (!ready) {
  console.log('  页面文本片段:', String(await ev('document.body.innerText.slice(0,200)')).replace(/\s+/g, ' '))
  await close(); removeProfile(PROFILE); process.exit(1)
}

console.log('\n=== 1) 造一份带逐条清单的预设，并启用它 ===')
const seeded = await ev(`(async()=>{
  const s = window.__libraryStore.getState();
  const entries = [
    { id:'r1', name:'规则甲', kind:'rules', content:'不许替玩家做决定', enabled:true },
    { id:'r2', name:'规则乙', kind:'rules', content:'正文里不要出现属性名', enabled:true },
    { id:'s1', name:'文风甲', kind:'style', content:'比喻要克制', enabled:true },
    { id:'o1', name:'作者说明', kind:'other', content:'禁止二创，下载后 24h 内删掉', enabled:true },
  ];
  await s.saveNarrativePreset({
    id:'pt-walk', name:'走查用预设', source:'walk.json',
    rules: '【规则甲】\\n不许替玩家做决定\\n\\n【规则乙】\\n正文里不要出现属性名',
    style: '【文风甲】\\n比喻要克制',
    lore: '【作者说明】\\n禁止二创，下载后 24h 内删掉',
    entries,
    counts:{ total:4, rules:2, style:1, other:1, dropped:[] },
    createdAt: Date.now(), updatedAt: Date.now(),
  }, { activate:true });
  const p = window.__libraryStore.getState().getNarrativePreset('pt-walk');
  return JSON.stringify({ has: !!p, entries: p ? p.entries.length : 0, active: window.__libraryStore.getState().activeNarrativePresetId });
})()`)
const seed = JSON.parse(seeded || '{}')
check('预设已存进库里', seed.has === true)
check('条目清单跟着存下来了', seed.entries === 4, `entries=${seed.entries}`)
check('已经启用', seed.active === 'pt-walk')

console.log('\n=== 2) 进「叙事预设」页，展开它 ===')
await ev(`(()=>{ window.__navStore.getState().push({ name:'presets' }); return 'ok' })()`)
await sleep(900)
check('页面标题是「叙事预设」', await waitFor(`/叙事预设/.test(document.body.innerText)`))
check('列表里有这份预设', await ev(`/走查用预设/.test(document.body.innerText)`))
check('页面上有「启用中」徽标（启用状态没丢）', await ev(`/启用中/.test(document.body.innerText)`))
/*
  ⚠️ 展开只能点右边那个 chevron，**不能点名字** ——
  名字那一整块是"启用 / 取消启用"的按钮（酒馆里也是这个语义）。
  我第一版这里 `clickText('/走查用预设/')` 点下去，等于把刚启用的预设又关掉了，
  后面所有断言都建立在一个"未启用"的预设上。
*/
await ev(`(()=>{const b=[...document.querySelectorAll('button')]
  .find(x=>(x.getAttribute('title')||'')==='查看内容'); if(b){b.click();return 'ok'} return 'no'})()`)
await sleep(500)
check('展开之后仍然启用（点的是 chevron，不是名字）', await ev(`/启用中/.test(document.body.innerText)`))

const ui = await ev(`(()=>{
  const T = document.body.innerText;
  const boxes = document.querySelectorAll('[role="checkbox"]');
  return JSON.stringify({
    boxes: boxes.length,
    hasGroupRules: /规则/.test(T),
    hasGroupStyle: /文风/.test(T),
    hasGroupOther: /其他/.test(T),
    count22: /2\\/2/.test(T),
    text: T.slice(0, 400),
  });
})()`)
const u = JSON.parse(ui || '{}')
check('每一条都有一个复选框', u.boxes === 4, `boxes=${u.boxes}`)
check('三类分组都在（规则 / 文风 / 其他）', u.hasGroupRules && u.hasGroupStyle && u.hasGroupOther)
check('分组标题报了「勾了几条 / 共几条」', u.count22 === true)
await shot('preset-01-open')

console.log('\n=== 3) 点掉「规则甲」：store 与界面都要跟着变 ===')
const toggled = await ev(`(async()=>{
  const boxes = [...document.querySelectorAll('[role="checkbox"]')];
  const target = boxes.find(b => (b.getAttribute('aria-label')||'') === '规则甲');
  if (!target) return JSON.stringify({ ok:false });
  target.click();
  await new Promise(r => setTimeout(r, 400));
  const p = window.__libraryStore.getState().getNarrativePreset('pt-walk');
  const e = p.entries.find(x => x.id === 'r1');
  return JSON.stringify({
    ok: true,
    enabled: e.enabled,
    rulesSnapshot: p.rules,
    countsRules: p.counts.rules,
    ariaChecked: [...document.querySelectorAll('[role="checkbox"]')]
      .find(b => (b.getAttribute('aria-label')||'') === '规则甲').getAttribute('aria-checked'),
    bodyHasCount: /1\\/2/.test(document.body.innerText),
  });
})()`)
const t = JSON.parse(toggled || '{}')
check('点到了「规则甲」的复选框', t.ok === true)
check('★ store 里这一条变成未勾选', t.enabled === false)
check('★ 三段快照跟着重算了（「不许替玩家做决定」已不在 rules 里）',
  typeof t.rulesSnapshot === 'string' && !t.rulesSnapshot.includes('不许替玩家做决定'), t.rulesSnapshot || '')
check('规则类的 counts 从 2 变 1', t.countsRules === 1, `counts.rules=${t.countsRules}`)
check('★ 界面上的 aria-checked 也跟着变（不是只有 store 变了）', t.ariaChecked === 'false')
check('界面上的计数变成「1/2」', t.bodyHasCount === true)
await shot('preset-02-toggled-off')

console.log('\n=== 4) 分组按钮：全关 → 全勾 ===')
// 上一步关掉了 r1，先把规则组恢复成 2/2，这样按钮才处于「全关」状态
await ev(`(async()=>{ await window.__libraryStore.getState().toggleNarrativePresetEntry('pt-walk','r1', true); return 'ok' })()`)
await sleep(400)

const bulk = await ev(`(async()=>{
  const btn = document.querySelector('[data-preset-kind="rules"]');
  if (!btn) return JSON.stringify({ step:'no-button' });
  const labelBefore = (btn.textContent||'').trim();
  btn.click();
  await new Promise(r => setTimeout(r, 400));
  const p1 = window.__libraryStore.getState().getNarrativePreset('pt-walk');
  const off = { r1: p1.entries.find(e=>e.id==='r1').enabled, r2: p1.entries.find(e=>e.id==='r2').enabled };

  const btn2 = document.querySelector('[data-preset-kind="rules"]');
  if (!btn2) return JSON.stringify({ step:'no-button2', off });
  const labelMid = (btn2.textContent||'').trim();
  btn2.click();
  await new Promise(r => setTimeout(r, 400));
  const p2 = window.__libraryStore.getState().getNarrativePreset('pt-walk');
  return JSON.stringify({
    step:'ok', labelBefore, labelMid, off,
    on: { r1: p2.entries.find(e=>e.id==='r1').enabled, r2: p2.entries.find(e=>e.id==='r2').enabled },
    rulesBack: p2.rules.includes('不许替玩家做决定') && p2.rules.includes('正文里不要出现属性名'),
  });
})()`)
const b = JSON.parse(bulk || '{}')
check('找得到「规则」这一组的全关/全勾按钮', b.step === 'ok', b.step || '')
check('全勾时按钮显示「全关」', b.labelBefore === '全关', b.labelBefore || '')
check('★ 全关把这一类都关掉', b.off && b.off.r1 === false && b.off.r2 === false, JSON.stringify(b.off))
check('全关后按钮变成「全勾」', b.labelMid === '全勾', b.labelMid || '')
check('★ 全勾把它们又都勾回来', b.on && b.on.r1 === true && b.on.r2 === true, JSON.stringify(b.on))
check('★ 勾回来之后 rules 快照恢复完整', b.rulesBack === true)

console.log('\n=== 5) 手机宽度（390×844）不许横向溢出 ===')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await sleep(700)
const narrow = await ev(`(()=>{
  const doc = document.documentElement;
  const over = [...document.querySelectorAll('*')].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.right > doc.clientWidth + 1;
  }).length;
  return JSON.stringify({ scrollW: doc.scrollWidth, clientW: doc.clientWidth, over });
})()`)
const n = JSON.parse(narrow || '{}')
check('页面本身不横向滚动', n.scrollW <= n.clientW + 1, `scrollWidth=${n.scrollW} clientWidth=${n.clientW}`)
check('没有元素溢出容器', n.over === 0, `溢出 ${n.over} 个`)
await shot('preset-03-mobile')

console.log('\n=== 6) 刷新后勾选状态还在（写回 IndexedDB 了）===')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false })
await ev(`(async()=>{
  const s = window.__libraryStore.getState();
  await s.toggleNarrativePresetEntry('pt-walk','s1', false);
  return 'ok';
})()`)
await sleep(600)
await send('Page.navigate', { url: SITE }); await sleep(2000)
const persisted = await ev(`(()=>{
  const p = window.__libraryStore.getState().getNarrativePreset('pt-walk');
  if (!p) return JSON.stringify({ has:false });
  return JSON.stringify({
    has:true,
    s1: p.entries.find(e=>e.id==='s1').enabled,
    styleSnapshot: p.style,
  });
})()`)
const pe = JSON.parse(persisted || '{}')
check('刷新后预设还在', pe.has === true)
check('★ 刷新后被关掉的那条仍然是关着的', pe.s1 === false, `enabled=${pe.s1}`)
check('★ 刷新后快照也不含它（说明真的写回磁盘了）',
  typeof pe.styleSnapshot === 'string' && !pe.styleSnapshot.includes('比喻要克制'), pe.styleSnapshot || '')

// 收尾：删掉走查用的预设，别污染本机库
await ev(`(async()=>{ try { await window.__libraryStore.getState().deleteNarrativePreset('pt-walk') } catch(e){} return 'ok' })()`)

/*
  ⚠️ **只有未捕获的异常才算失败**（2026-11，CI 上盲红一次才改的）。

  `launch()` 把两类东西都塞进 `errors`：CDP 的 `Runtime.exceptionThrown`
  与页面里的 `console.error`。前者是真出事，后者什么都有 ——
  CI 的 Edge 版本比本地新一点，就可能多出几条资源加载 / 字体 / 弃用警告，
  于是这条 check 在 CI 上必红、而本地全绿，且**红得毫无信息量**。

  别的走查套件（background-custom / heroes / builtin-refresh）本来就只
  「打印不判定」，这里跟它们保持一致：console.error 记录，异常才拦。
*/
const hardErrors = (errors || []).filter(e => !/^console\.error:/.test(String(e)))
const softErrors = (errors || []).filter(e => /^console\.error:/.test(String(e)))
check('没有未捕获的 JS 异常', hardErrors.length === 0, hardErrors.slice(0, 2).join(' | '))
if (softErrors.length) {
  console.log(`  （console.error ${softErrors.length} 条，仅记录不计失败：${softErrors.slice(0, 2).join(' | ')}）`)
}

console.log(`\n=== 汇总 ===\n  通过 ${pass}/${pass + fail}`)
await close()
removeProfile(PROFILE)
process.exit(fail ? 1 : 0)
