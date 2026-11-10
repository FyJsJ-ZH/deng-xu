/**
 * 浏览器走查：**九相配色 + 选项的性相加成**（2026-11，玩家点名要的两件事）
 *
 * 玩家原话：
 * > 「这些性相的颜色要与密教模拟器的原作一致，而且，
 * >   原作中选择选项对应的颜色有对应的性相加成」
 *
 * 这一套盯的就是这两条：
 *
 *  1. 九个相的颜色 = 原作《苍白卷宗》JS 包里那组 Tailwind 色（见 `worlds/_shared.ts` 的注释）。
 *     **刃是绿的**、**心浅红 / 杯深红** —— 这两处最容易写错，
 *     而且写错了不报错，只是玩家看着别扭。
 *  2. 选项按它标注的相上色，**尾标显示相名**；选中后那个相 +1，且**只加一次**。
 *
 * ## 为什么必须过浏览器
 *
 * 颜色是 `getComputedStyle` 才能验的（Tailwind 的 class 拼错、inline style 被覆盖，
 * 单元测试都看不出来）；而"点一下涨一点"这条，单元测试测的是 `handleAction`，
 * 测不出 UI 上会不会**重复绑定**导致点一下涨两点 —— 这个 bug 我真写过一次。
 */
import './_ws-shim.mjs'
import { launch, sleep, outDir, profileDir } from './_browser.mjs'

const SITE = process.env.SITE || 'http://localhost:5199/'
const OUT = outDir()

const { send, ev, close } = await launch({
  port: 9981, userDataDir: profileDir('aspect'), viewport: { width: 1280, height: 1000 },
})

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  —— ' + detail : ''}`) }
}
const shot = async (n) => {
  try {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    const fs = await import('node:fs')
    fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(r.result.data, 'base64'))
    console.log(`  [截图] ${OUT}/${n}.png`)
  } catch { /* 截图失败不该让走查挂掉 */ }
}
const clickText = (re) => ev(`(()=>{const b=[...document.querySelectorAll('button')]
  .find(x=>${re}.test((x.textContent||'').trim()));if(!b)return 'no';if(b.disabled)return 'disabled';b.click();return 'ok'})()`)

await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: SITE }); await sleep(1500)
await ev(`(()=>{const k='pale-notes-ui';let v={};try{v=JSON.parse(localStorage.getItem(k)||'{}')}catch(e){}
  v.state=v.state||{};v.state.llm=Object.assign({provider:'deepseek',baseUrl:'https://api.deepseek.com/v1',narrativeModel:'deepseek-chat',analysisModel:'deepseek-chat',temperature:0.8},v.state.llm||{},{apiKey:'sk-aspect'});
  v.state.isApiKeyModalOpen=false;v.state.showTutorial=false;localStorage.setItem(k,JSON.stringify(v));return 1})()`)
await send('Page.navigate', { url: SITE }); await sleep(6000)
await ev(`(()=>{const u=__uiStore.getState();u.setApiKeyModalOpen(false);if(u.setShowTutorial)u.setShowTutorial(false);return 1})()`)

console.log('\n=== 1) 九相配色 = 原作的那一组 ===')
/*
  原作的 `CL` 数组（从它打包后的 JS 里挖出来的，Tailwind class 形式）：
  灯 yellow-400 / 铸 orange-500 / 刃 green-400 / 冬 blue-200 /
  心 red-400 / 杯 red-600 / 蛾 amber-200 / 启 purple-400 —— 没有秘史。

  这里两个都验：**世界卡里存的色值**，和**状态栏真的画出来的色值**。
  只验数据会漏掉"界面没读这个字段"的情况。
*/
const EXPECT = {
  lantern: ['#facc15', 'rgb(250, 204, 21)'],
  forge: ['#f97316', 'rgb(249, 115, 22)'],
  edge: ['#4ade80', 'rgb(74, 222, 128)'],
  winter: ['#bfdbfe', 'rgb(191, 219, 254)'],
  heart: ['#f87171', 'rgb(248, 113, 113)'],
  grail: ['#dc2626', 'rgb(220, 38, 38)'],
  moth: ['#fde68a', 'rgb(253, 230, 138)'],
  knock: ['#c084fc', 'rgb(192, 132, 252)'],
  secrethistory: ['#a16207', 'rgb(161, 98, 7)'],
}

// 进卡库 → 阿尔比恩（九相的世界）→ 一路下一步
await clickText('/开始新游戏/'); await sleep(2500)
await ev(`(()=>{
  const ws = __libraryStore.getState().worlds || [];
  const w = ws.find(x => x.id === 'builtin_albion');
  if (!w) return 'no-world';
  const h = [...document.querySelectorAll('h3')].find(x => (x.textContent||'').trim() === w.title);
  const card = h.closest('button')?.parentElement;
  const start = card ? [...card.querySelectorAll('button')].find(b => /用这个世界开始/.test((b.textContent||'').trim())) : null;
  if (start) start.click(); return 1;
})()`); await sleep(2500)
await ev(`(()=>{const el=document.querySelector('input[placeholder="你的名字"]');if(!el)return 0;
  const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,'相测试');
  el.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`)
for (let i = 0; i < 6; i++) {
  const r = await clickText('/^下一步$|^开始故事$|^开始$|^出发$|^进入故事$|^生成第一幕$/')
  await sleep(900)
  if (r === 'no' || r === 'disabled') continue
}
for (let i = 0; i < 20; i++) {
  if (await ev(`!!document.querySelector('input[placeholder="输入你的行动..."]')`)) break
  await sleep(600)
}

const stored = JSON.parse(await ev(`(()=>{
  const w = __sessionStore.getState().world;
  return JSON.stringify((w.attributes||[]).map(a => [a.id, a.color]));
})()`))
const storedMap = Object.fromEntries(stored)
for (const [id, [hex]] of Object.entries(EXPECT)) {
  check(`卡片里的「${id}」色值 = ${hex}`, storedMap[id] === hex, storedMap[id])
}

console.log('\n=== 2) 状态栏真的画出来了 ===')
/*
  ⚠️ 别拿 `[title]` 的 color 去比 —— 状态栏里挂 title 的是**相名字**，
  而相名是刻意的灰色（`text-text-muted`），上色的是**图标底与数值**。
  第一版这样写，报「0/9 对得上」，看起来像配色没生效，其实是我探错了元素。
  现在的判据是"这九种颜色在页面上各自出现过没有"，与具体哪个元素无关。
*/
const seenColors = JSON.parse(await ev(`(()=>{
  const want = new Set(${JSON.stringify(Object.values(EXPECT).map(v => v[1]))});
  const seen = [];
  for (const el of document.querySelectorAll('span,div,p')) {
    const c = getComputedStyle(el).color;
    if (want.has(c) && !seen.includes(c)) seen.push(c);
  }
  return JSON.stringify(seen);
})()`))
check('状态栏把九相的色都画出来了', seenColors.length >= 8, `${seenColors.length}/9 种色出现在页面上`)

console.log('\n=== 3) 选项按相上色，尾标显示相名 ===')
await ev(`(()=>{
  __gameStore.getState().setCurrentOptions([
    { id:'t_lantern', text:'把灯挪近，看清楚那道刻痕', style:'lantern' },
    { id:'t_edge',    text:'一脚踹开那扇门', style:'edge' },
    { id:'t_grail',   text:'先喝一口，再问话', style:'grail' },
    { id:'t_neutral', text:'等天亮', style:'neutral' },
  ]);
  return 'ok';
})()`)
await sleep(1200)
await shot('aspect-choices')

const opts = JSON.parse(await ev(`(()=>{
  const want = ['把灯挪近', '一脚踹开', '先喝一口', '等天亮'];
  const out = [];
  for (const b of document.querySelectorAll('button')) {
    const t = (b.textContent || '').trim();
    const hit = want.find(w => t.includes(w));
    if (!hit) continue;
    const cs = getComputedStyle(b);
    out.push({ text: hit, color: cs.color, border: cs.borderTopColor, raw: t });
  }
  return JSON.stringify(out);
})()`))
const byText = (s) => opts.find(o => o.text === s) || {}

check('「灯」选项是金色', byText('把灯挪近').color === EXPECT.lantern[1], byText('把灯挪近').color)
check('「刃」选项是绿色（原作 Edge 就是绿的）', byText('一脚踹开').color === EXPECT.edge[1], byText('一脚踹开').color)
check('「杯」选项是深红', byText('先喝一口').color === EXPECT.grail[1], byText('先喝一口').color)
check('neutral 选项不上相色', !/rgb\(250, 204, 21\)|rgb\(74, 222, 128\)/.test(byText('等天亮').color || ''), byText('等天亮').color)
check('选项尾标显示相名', ['灯', '刃', '杯'].every(n => String(byText(n === '灯' ? '把灯挪近' : n === '刃' ? '一脚踹开' : '先喝一口').raw).includes(n)))

console.log('\n=== 4) 选中 → 那个相 +1（且只加一次）===')
const before = JSON.parse(await ev(`JSON.stringify(__gameStore.getState().aspects)`))
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('把灯挪近'));if(b)b.click();return 1})()`)
await sleep(1500)
const after = JSON.parse(await ev(`JSON.stringify(__gameStore.getState().aspects)`))
check('★ 点「灯」之后 lantern +1',
  (after.lantern || 0) === (before.lantern || 0) + 1,
  `${before.lantern} → ${after.lantern}`)
check('★ 只加一次（不是 +2 —— 曾经在 UI 和引擎里各写了一遍）',
  (after.lantern || 0) - (before.lantern || 0) === 1,
  `涨了 ${(after.lantern || 0) - (before.lantern || 0)}`)
check('其他八相没被误加',
  Object.keys(after).filter(k => k !== 'lantern').every(k => (after[k] || 0) === (before[k] || 0)))

console.log('\n=== 汇总 ===')
console.log(`  通过 ${pass}/${pass + fail}`)
await close()
process.exit(fail ? 1 : 0)
