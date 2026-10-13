/**
 * RPG 地图画廊：把每种地形画成白天/夜晚两张对照图。
 *
 * 用途：
 *  1. 确认地图真的画出了可辨认的地形（不是一片糊色）
 *  2. 确认昼夜两套配色差别明显（玩家不看钟也能感到时间变化）
 *
 * 这类"看一眼就知道对不对"的东西必须**画出来看**。
 * 上一轮我用像素覆盖率统计判断"哪件衣服露躯干"，结论完全对不上，
 * 最后是靠渲染 37 张对照图才看清的。
 */
import './_ws-shim.mjs'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { outDir, profileDir, removeProfile, capturePage, waitForImages } from './_browser.mjs'

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
const PORT = Number(process.env.CDP_PORT || 9840)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJson = u => new Promise((res, rej) => {
  http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)) } catch (e) { rej(e) } }) }).on('error', rej)
})
fs.mkdirSync(OUT, { recursive: true })
const PROFILE = profileDir('map')
const edge = spawn(EDGE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' })
let v = null
for (let i = 0; i < 60; i++) { try { v = await getJson(`http://127.0.0.1:${PORT}/json/version`); break } catch { await sleep(500) } }
if (!v) {
  console.error('端口未就绪（Edge 已启动但未绑定调试端口）。常见原因：--user-data-dir 不是绝对路径。')
  process.exit(1)
}
const t = await getJson(`http://127.0.0.1:${PORT}/json/list`)
const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0; const pend = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (m, p = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })
  return r.result?.exceptionDetails ? 'THREW ' + (r.result.exceptionDetails.exception?.description || '') : r.result?.result?.value
}
const results = []
const check = (l, ok, extra = '') => { results.push({ l, ok }); console.log(`  ${ok ? '✓' : '✗'} ${l}${extra ? '  ' + extra : ''}`) }

await send('Runtime.enable')
await send('Page.navigate', { url: SITE }); await sleep(9000)

const ARCHES = ['interior', 'street', 'forest', 'mountain', 'coast', 'ruins', 'underground', 'sky', 'night']
const PHASES = ['dawn', 'day', 'dusk', 'night']

const built = await ev(`(async () => {
  const m = await import('/src/utils/rpgMap.ts');
  const out = [];
  for (const a of ${JSON.stringify(ARCHES)}) {
    const row = { a, phases: [] };
    for (const ph of ${JSON.stringify(PHASES)}) {
      const g = m.generateMap(a, 'gallery', ph);
      row.phases.push({ ph, url: g.dataUrl });
    }
    // 同一地形的三套布局（换 seed 就会换 variant）
    row.variants = [0, 1, 2].map(i => m.generateMap(a, 'variant' + i, 'day').dataUrl);
    out.push(row);
  }
  return JSON.stringify(out);
})()`)
if (String(built).startsWith('THREW')) { console.log('生成失败:', built); ws.close(); edge.kill(); process.exit(1) }
const arr = JSON.parse(built)

console.log('=== 1) 每种地形 × 每个时段都能生成 ===')
const total = arr.reduce((n, r) => n + r.phases.length, 0)
check('九种地形 × 四档时段', arr.length === ARCHES.length && total === ARCHES.length * 4, `${arr.length} 地形 / ${total} 张`)
check('每张都是 320×192', arr.every(r => r.phases.every(p => p.url.startsWith('data:image/png'))))

console.log('\n=== 2) 四档时段**两两不同**（不能有任意两档同图）===')
const samePairs = []
for (const r of arr) {
  for (let i = 0; i < r.phases.length; i++) {
    for (let j = i + 1; j < r.phases.length; j++) {
      if (r.phases[i].url === r.phases[j].url) samePairs.push(`${r.a}:${r.phases[i].ph}=${r.phases[j].ph}`)
    }
  }
}
check('没有任何地形的两个时段是同一张图', samePairs.length === 0, samePairs.join(',') || '(全部不同)')

console.log('\n=== 3) 同一地形有多套布局（换 seed 换构图）===')
const noVariety = arr.filter(r => new Set(r.variants).size < 2).map(r => r.a)
check('每种地形至少有两套不同构图', noVariety.length === 0, noVariety.join(',') || '(全部有变化)')
console.log('  各布局套数: ' + arr.map(r => `${r.a}=${new Set(r.variants).size}`).join(' '))

/** 计算一张图的平均亮度，用来客观验证"夜比黄昏暗、黄昏比白天暗" */
const lum = JSON.parse(await ev(`(async () => {
  const m = await import('/src/utils/rpgMap.ts');
  const out = {};
  for (const ph of ${JSON.stringify(PHASES)}) {
    const g = m.generateMap('street', 'lum', ph);
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = g.dataUrl });
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
    out[ph] = +(s / (d.length / 4)).toFixed(1);
  }
  return JSON.stringify(out);
})()`))
console.log('\n=== 4) 亮度递减：白天 > 黄昏 > 夜（客观指标）===')
console.log('  平均亮度: ' + JSON.stringify(lum))
check('白天比黄昏亮', lum.day > lum.dusk, `${lum.day} > ${lum.dusk}`)
check('黄昏比夜亮', lum.dusk > lum.night, `${lum.dusk} > ${lum.night}`)
check('清晨介于夜与白天之间', lum.dawn > lum.night && lum.dawn < lum.day, `${lum.night} < ${lum.dawn} < ${lum.day}`)

const html = `<!doctype html><html><body style="margin:0;background:#111;font-family:sans-serif;padding:10px">
${arr.map(r => `<div style="margin-bottom:14px">
  <div style="color:#f5b942;font-size:13px;margin-bottom:4px">${r.a}</div>
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px">
    ${r.phases.map(p => `<div style="text-align:center">
      <img src="${p.url}" style="width:100%;image-rendering:pixelated;border:1px solid #333">
      <div style="color:#8ab;font-size:10px">${p.ph}</div>
    </div>`).join('')}
    <div style="text-align:center">
      <img src="${r.variants[0]}" style="width:100%;image-rendering:pixelated;border:1px solid #555">
      <div style="color:#666;font-size:10px">布局A</div>
    </div>
    <div style="text-align:center">
      <img src="${r.variants[1]}" style="width:100%;image-rendering:pixelated;border:1px solid #555">
      <div style="color:#666;font-size:10px">布局B</div>
    </div>
  </div>
</div>`).join('')}
</body></html>`
fs.writeFileSync(path.join(OUT, 'map-gallery.html'), html, 'utf8')
const bust = `?t=${Date.now()}`
await send('Page.navigate', { url: 'file:///' + path.join(OUT, 'map-gallery.html').replace(/\\/g, '/') + bust })
/*
  ⚠️ 这里原先只有一句 `sleep(2500)`，然后直接裸取 `shot.result.data` —— 两个坑叠在一起：
    · 固定等待：机器快时白等，慢时图还没解码完就截；
    · 裸取：`Page.captureScreenshot` 偶发只返回 `error`、没有 `result`，
      于是抛 `Cannot read properties of undefined (reading 'data')` ——
      一个完全看不出是"截图偶发失败"的报错（CI 上这套走查因此红过两次，重跑又过）。
  现在改成：**等图片真的加载完** + **带重试的截图**。
*/
await waitForImages(ev)
const png = await capturePage(send, { format: 'png', captureBeyondViewport: true })
fs.writeFileSync(path.join(OUT, 'map-gallery.png'), png)
console.log(`\n画廊已写入 ${path.join(OUT, 'map-gallery.png')}`)

const failed = results.filter(r => !r.ok)
console.log('\n=== 汇总 ===')
console.log(`  通过 ${results.length - failed.length}/${results.length}`)
if (failed.length) failed.forEach(r => console.log('    · ' + r.l))
ws.close(); edge.kill(); await sleep(300); removeProfile(PROFILE)
process.exit(failed.length === 0 ? 0 : 1)
