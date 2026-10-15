/**
 * NPC 立绘与描述贴合度对照图。
 *
 * ## 这个脚本现在测两件事（2026-10 第三轮）
 *
 * 它原本只测一条路径：**中文描述 → `inferTraits` 291 条正则 → 猜部件**。
 * 那条路径是**兜底**，用于导入的第三方卡；而玩家反馈的"局内 NPC 立绘对不上"
 * 说的其实是另一条路径 —— AI 在游戏里**现场创造**的 NPC，它们过去一个 `look`
 * 都没有，全部落在那条兜底路径上。
 *
 * 所以现在每一组并排渲染两张：
 *
 *   · **左：只给描述**（旧的兜底路径，等于"AI 没登记外观"）
 *   · **右：描述 + AI 登记的 `appearance`**（新路径，见 `utils/lookSpec.ts`）
 *
 * 两张的差别就是这一轮改造的收益。为了能肉眼判断，下面还配了一组
 * **客观断言**：AI 明确登记过的项（发色、性别、帽子…），右图必须真的画成那样。
 *
 * ## 为什么必须画出来看
 *
 * 贴合度是主观判断，靠断言测不出来。
 * 上一轮用像素覆盖率统计判断"哪件衣服露躯干"完全失败，
 * 最后就是靠渲染对照图才看清的。
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
const PORT = Number(process.env.CDP_PORT || 9850)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJson = u => new Promise((res, rej) => {
  http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)) } catch (e) { rej(e) } }) }).on('error', rej)
})
fs.mkdirSync(OUT, { recursive: true })
const PROFILE = profileDir('npc')
const edge = spawn(EDGE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1500,1200', 'about:blank'], { stdio: 'ignore' })
let v = null
for (let i = 0; i < 60; i++) { try { v = await getJson(`http://127.0.0.1:${PORT}/json/version`); break } catch { await sleep(500) } }
if (!v) { console.error('端口未就绪'); process.exit(1) }
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

/**
 * 真实角色描述 —— 前三个来自玩家截图，其余覆盖常见搭配。
 *
 * 第 4 项是每一项的 **AI 登记外观**（`appearance`）：模拟数据 AI 照
 * `aiLookCatalogPrompt()` 的清单认真登记之后会给出什么。
 * 它的取值刻意**只包含描述里确实写到的东西** —— 这正是提示词里的硬要求。
 */
const CASES = [
  ['管家',
    '巴斯蒂安是一位年龄成谜的男性精灵，岁月没有在他脸上留下沧桑，反而沉淀出一种醇酒般的古典优雅。他有着一头乌黑锃亮的长发，每日用特制精油打理得一丝不苟，利落地向后束成一条及腰的马尾。他的右眼佩戴着一枚镶有银丝的精致单片眼镜，深邃的暗绿色眼眸透过镜片观察着一切。他身着一丝不苟的黑色燕尾服，纯白的衬衫上没有一丝褶皱，领口系着暗藏荆棘纹的领结，手上永远戴着不染纤尘的白手套。他身形修长挺拔，走路时几乎没有声响，就像一道优雅的黑色阴影。',
    '男', { sex: 'male', age: 'adult', hair: 'ponytail', hairColor: 'black', cloth: 'jacket', eye: 'green' }],
  ['挑书的浅发女子', '约莫二十出头的年轻女子，浅亚麻色长发编成一条辫子垂在肩前，皮肤白净，穿着一件洗得发软的旧裙子', '女',
    { sex: 'female', age: 'youth', hair: 'braid', hairColor: 'sandy', skin: 'light', cloth: 'dress', clothColor: 'white' }],
  ['搬箱子的少年', '约莫十五六岁的黑发少年，瘦，穿洗得发白的粗布短衫，袖口卷到肘上', '男',
    { sex: 'male', age: 'youth', build: 'slim', hair: 'short', hairColor: 'black', cloth: 'peasant', clothColor: 'white' }],
  ['闻香料的银叶精灵', '男性森林精灵，银叶王庭出身，浅金色长发用木簪松松挽着，穿月白亚麻长衫', '男',
    { sex: 'male', age: 'adult', hair: 'half_up', hairColor: 'blonde', cloth: 'robe', eye: 'green' }],
  ['独眼茶摊老板', '月桂街街角茶摊的老板，独眼，沉默寡言，穿深褐色粗布短打', '男',
    { sex: 'male', age: 'adult', hair: 'short', hairColor: 'brown', cloth: 'peasant', clothColor: 'brown' }],
  ['陌生佣兵', '三名穿皮甲、腰挂佩刀的男人', '男',
    { sex: 'male', age: 'adult', cloth: 'armour', legs: 'pants' }],
  ['和服少女', '穿红色和服的少女，黑发，齐刘海', '女',
    { sex: 'female', age: 'youth', hair: 'bangs', hairColor: 'black', cloth: 'kimono' }],
  ['板甲骑士', '穿板甲的骑士，戴着全罩头盔，肩披白色披风', '男',
    { sex: 'male', age: 'adult', cloth: 'plate', hat: 'greathelm', cape: 'plain' }],
  ['白裙贵妇', '穿白色长裙的贵妇，一头金发盘起，戴金色头冠', '女',
    { sex: 'female', age: 'adult', hair: 'bun', hairColor: 'blonde', cloth: 'dress', clothColor: 'white', hat: 'crown' }],
  ['现代学生', '穿深蓝色制服短裙的女学生，黑发扎双马尾', '女',
    { sex: 'female', age: 'youth', hair: 'idol', hairColor: 'black', cloth: 'formal', clothColor: 'navy', legs: 'skirt' }],
]

const built = await ev(`(async () => {
 try {
  const lp = await import('/src/utils/lpcSprite.ts');
  const ap = await import('/src/utils/appearance.ts');
  const ls = await import('/src/utils/lookSpec.ts');
  const cases = ${JSON.stringify(CASES)};
  const out = [];
  for (let i = 0; i < cases.length; i++) {
    const [tag, desc, gender, appearance] = cases[i];
    const profile = { name: tag, description: desc };
    const traits = ap.inferTraits(profile);

    // ── 左：只给描述（旧的兜底路径） ──
    const rOld = lp.recipeFor('npc' + i, { profile, gender });
    const imgOld = await lp.renderSprite(rOld, 'down', 3);

    // ── 右：描述 + AI 登记的 appearance ──
    const look = ls.resolveAiLook(appearance, 'npc' + i);
    const rNew = look ? lp.recipeFor('npc' + i, { profile, gender, look }) : rOld;
    const imgNew = look ? await lp.renderSprite(rNew, 'down', 3) : imgOld;

    out.push({
      tag, desc, appearance,
      cloth: traits.cloth || '(未推断)',
      clothAll: (traits.clothAll || []).join('/') || '-',
      role: (traits.role || []).join('/') || '-',
      headwear: (traits.headwear || []).join('/') || '-',
      torso: rOld.clothing,
      parts: rOld.parts.join(' '),
      imgOld, imgNew,
      lookKeys: look ? Object.keys(look).join(',') : '(未解析)',
      colorsOld: JSON.stringify(rOld.colors || {}),
      colorsNew: JSON.stringify(rNew.colors || {}),
      partsNew: rNew.parts.join(' '),
    });
  }
  return JSON.stringify(out);
 } catch (e) {
  return 'ERR:' + (e && (e.stack || e.message) || String(e));
 }
})()`)
if (String(built).startsWith('THREW')) { console.log('生成失败:', built); ws.close(); edge.kill(); process.exit(1) }
if (String(built).startsWith('ERR:')) { console.log('页内异常:\n', built); ws.close(); edge.kill(); process.exit(1) }
if (built === undefined || built === null) { console.log('页内返回空 —— evaluate 没有得到值'); ws.close(); edge.kill(); process.exit(1) }
const arr = JSON.parse(built)

console.log('=== 每个角色的推断与实际选件 ===')
for (const c of arr) {
  console.log(`\n  【${c.tag}】`)
  console.log(`    推断衣色: ${c.cloth}   全部衣色: ${c.clothAll}`)
  console.log(`    推断身份: ${c.role}   头饰: ${c.headwear}`)
  console.log(`    旧上衣: ${c.torso}`)
  console.log(`    AI 登记: ${c.lookKeys}`)
  console.log(`    旧色: ${c.colorsOld}`)
  console.log(`    新色: ${c.colorsNew}`)
}

console.log('\n=== 自动断言（客观可测的部分）===')
// 管家：描述明确写"黑色燕尾服"，上衣不该是随机的怪东西
const butler = arr.find(c => c.tag === '管家')
check('管家推断出黑色', butler.cloth === 'black', butler.cloth)
check('管家收集到黑+白两种衣色', butler.clothAll.includes('black') && butler.clothAll.includes('white'), butler.clothAll)

// 和服少女：应拿到和服类部件
const kimono = arr.find(c => c.tag === '和服少女')
check('和服少女拿到和服类部件', /dress_.*kimono|dress_sash|dress_bodice/.test(kimono.torso), kimono.torso)

// 板甲骑士：应拿到盔甲
const knight = arr.find(c => c.tag === '板甲骑士')
check('板甲骑士拿到盔甲/披风', /armour|cape/.test(knight.parts), knight.parts.split(' ').filter(p => /armour|cape/.test(p)).join(','))

// 女性角色不应拿到裤子（当描述有裙装时）
for (const c of arr) {
  if (!/裙|和服|礼服/.test(c.desc)) continue
  const pants = c.parts.split(' ').filter(p => /^legs_/.test(p) && !/skirt/i.test(p))
  check(`${c.tag} 穿裙装时没有裤子`, pants.length === 0, pants.join(',') || '(无)')
}

// 没有角色应该裸露躯干（外层件必须配打底）
for (const c of arr) {
  const outer = ['torso_aprons_apron', 'torso_aprons_apron_full', 'torso_aprons_apron_half',
    'torso_aprons_overalls', 'torso_jacket_tabard', 'torso_jacket_pockets', 'legs_skirt_overskirt']
  const hit = outer.find(o => c.parts.includes(o))
  if (!hit) continue
  const base = c.parts.split(' ').some(p => /^torso_clothes_(longsleeve|shortsleeve|tshirt)/.test(p))
  check(`${c.tag} 外层件(${hit})配了打底`, base, c.parts)
}

/* ── 新增：AI 登记的项必须真的生效（这一组才是本轮改造的验收） ── */
console.log('\n=== AI 登记外观 → 实际落件（本轮新增） ===')
const wantColor = (tag, mat, key) => {
  const c = arr.find(x => x.tag === tag)
  const got = JSON.parse(c.colorsNew)[mat]
  check(`${tag} 的 ${mat} 色 = ${key}`, got === key, `实际 ${got}`)
}
wantColor('管家', 'hair', 'black')
wantColor('挑书的浅发女子', 'hair', 'sandy')
wantColor('搬箱子的少年', 'hair', 'black')
wantColor('闻香料的银叶精灵', 'hair', 'blonde')
wantColor('白裙贵妇', 'hair', 'blonde')

{
  const c = arr.find(x => x.tag === '白裙贵妇')
  check('白裙贵妇戴上了头冠', /hat_formal_crown/.test(c.partsNew), c.partsNew.split(' ').filter(p => /^hat_/.test(p)).join(',') || '(无)')
}
{
  const c = arr.find(x => x.tag === '板甲骑士')
  check('板甲骑士戴上了全罩头盔', /helmet_greathelm|helmet_sugarloaf|helmet_barbuta/.test(c.partsNew),
    c.partsNew.split(' ').filter(p => /helmet/.test(p)).join(',') || '(无)')
}
{
  const c = arr.find(x => x.tag === '陌生佣兵')
  check('陌生佣兵穿上皮甲', /torso_armour_leather/.test(c.partsNew), c.partsNew)
}
{
  // 回归：AI 登记了 legs=skirt 时，不能被任何兜底逻辑顶成裤子
  const c = arr.find(x => x.tag === '现代学生')
  const legs = c.partsNew.split(' ').find(p => /^legs_/.test(p)) || ''
  check('现代学生（登记短裙）真的拿到裙装', /skirt/i.test(legs), legs || '(无)')
}
{
  // 反向回归：没登记 legs 时也不该把描述里的裙装顶掉
  const c = arr.find(x => x.tag === '和服少女')
  const pants = c.partsNew.split(' ').filter(p => /^legs_/.test(p) && !/skirt/i.test(p))
  check('和服少女没有被补上裤子', pants.length === 0, pants.join(',') || '(无)')
}
{
  // 所有案例：AI 登记后不该出现女性角色配男性头
  for (const c of arr) {
    if (!c.appearance || !c.appearance.sex) continue
    const heads = c.partsNew.split(' ').find(p => /^heads_/.test(p)) || ''
    const want = c.appearance.sex === 'female' ? /female/ : /male/
    check(`${c.tag} 的头部性别正确`, want.test(heads), heads)
  }
}
{
  // 发色不该落到固定橙的那两个部件上（hair_long_tied / hair_pigtails）
  for (const c of arr) {
    const bad = c.partsNew.split(' ').filter(p => p === 'hair_long_tied' || p === 'hair_pigtails')
    check(`${c.tag} 没有用到固定橙的发型件`, bad.length === 0, bad.join(','))
  }
}

const card = (c) => `<div style="background:#171717;border:1px solid #2a2a2a;border-radius:6px;padding:6px;text-align:center">
  <div style="color:#f5b942;font-size:11px;margin-bottom:4px;font-weight:bold">${c.tag}</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">
    <div>
      <img src="${c.imgOld}" style="width:100%;image-rendering:pixelated;background:#101010;border-radius:4px">
      <div style="color:#f66;font-size:9px;margin-top:2px">只给描述（推断）</div>
    </div>
    <div>
      <img src="${c.imgNew}" style="width:100%;image-rendering:pixelated;background:#101010;border-radius:4px">
      <div style="color:#6f6;font-size:9px;margin-top:2px">＋AI 登记外观</div>
    </div>
  </div>
  <div style="color:#8ab;font-size:9px;margin-top:3px">登记:${c.lookKeys}</div>
  <div style="color:#c96;font-size:9px">落件:${c.partsNew.replace(/torso_|legs_|feet_|hat_|hair_|heads_|dress_|beards_/g, '').slice(0, 90)}</div>
  <div style="color:#666;font-size:8px;margin-top:3px;text-align:left;line-height:1.3">${c.desc.slice(0, 80)}…</div>
</div>`

const html = `<!doctype html><html><body style="margin:0;background:#0e0e0e;font-family:sans-serif;padding:12px">
<div style="color:#f5b942;font-size:13px;margin-bottom:8px">左：关键词推断（旧兜底路径）　·　右：描述 + AI 登记的结构化外观（新路径）</div>
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
${arr.map(card).join('')}
</div></body></html>`
fs.writeFileSync(path.join(OUT, 'npc-gallery.html'), html, 'utf8')
/*
  加时间戳参数破坏缓存。
  `file://` 下的图片会被浏览器缓存，同一个文件名第二次打开时
  拿到的还是旧图 —— 我因此看着"没变化"的截图排查了很久。
*/
const bust = `?t=${Date.now()}`
await send('Page.navigate', { url: 'file:///' + path.join(OUT, 'npc-gallery.html').replace(/\\/g, '/') + bust })
await sleep(2500)
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
fs.writeFileSync(path.join(OUT, 'npc-gallery.png'), Buffer.from(shot.result.data, 'base64'))
console.log(`\n对照图已写入 ${path.join(OUT, 'npc-gallery.png')}`)

const failed = results.filter(r => !r.ok)
console.log('\n=== 汇总 ===')
console.log(`  通过 ${results.length - failed.length}/${results.length}`)
if (failed.length) failed.forEach(r => console.log('    · ' + r.l))
ws.close(); edge.kill(); await sleep(300); removeProfile(PROFILE)
process.exit(failed.length === 0 ? 0 : 1)
