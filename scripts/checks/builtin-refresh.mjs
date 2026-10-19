/**
 * 浏览器走查：**内置卡内容更新**（2026-10 第十一轮）
 *
 * ## 为什么单开一套
 *
 * 玩家的原话（第三次说"改了没生效"）：
 * > 「我打开网页用起来输出的字数没变化，世界书设定内的叙事参数……
 * >   依然是 800 字，怎么回事？浏览器网页的自动更新不起作用？还是你没改好？」
 *
 * 根因不在构建、也不在缓存，而在 `stores/library.ts` 只补「**缺 id**」的内置卡：
 * 老玩家库里那个 id 一直都在，于是那张卡永远停在第一次播种时的样子。
 *
 * 修法是内容指纹 + 整批刷新。逻辑由 `library.builtinRefresh.test.ts` 的 10 条守着，
 * 但单元测试用的是**假 kv**（内存 Map）—— 它们证明不了"真机上 IndexedDB 写入、
 * 刷新页面、重新读回来"这条链路真的通。
 *
 * 而这条链路恰恰是最容易"看着对、其实没接上"的地方：
 * 指纹算了、判了、也 set 了，但 stamp 写在了 worlds 之前（顺序反了），
 * 或者刷新时用了 concat 把卡甩到列表末尾 —— 这些只有真跑一遍才看得见。
 *
 * ## 这一套在验什么
 *
 * 1. 首次进入，库里是新的（1800）；
 * 2. 把 IndexedDB 里的库**改回老玩家的样子**（那张卡退回 800、抹掉指纹）；
 * 3. 刷新页面；
 * 4. 卡**必须**变回 1800，指纹**必须**写回去，卡片的顺序**不许**变。
 */

import './_ws-shim.mjs'
import { launch, sleep, outDir, profileDir, removeProfile } from './_browser.mjs'

const SITE = process.env.SITE || 'http://localhost:5199/'
const OUT = outDir()
const PROFILE = profileDir('brefresh')

const { send, ev, close, errors } = await launch({
  port: 9981, userDataDir: PROFILE, viewport: { width: 1280, height: 900 },
})

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  —— ' + detail : ''}`) }
}
const waitFor = async (expr, timeoutMs = 20000, every = 250) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await ev(expr)) return true
    await sleep(every)
  }
  return false
}

const CARD = 'builtin_london1905'

/** 页内的 IndexedDB 读写（与 `utils/idb.ts` 同一个库：pale-notes / kv，out-of-line key） */
const IDB_HELPERS = `
  const openDb = () => new Promise((res, rej) => {
    const r = indexedDB.open('pale-notes', 1)
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
    r.onupgradeneeded = () => {}
  })
  const read = (db, k) => new Promise((res, rej) => {
    const t = db.transaction('kv', 'readonly')
    const q = t.objectStore('kv').get(k)
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error)
  })
  const write = (db, k, v) => new Promise((res, rej) => {
    const t = db.transaction('kv', 'readwrite')
    if (v === undefined) t.objectStore('kv').delete(k)
    else t.objectStore('kv').put(v, k)
    t.oncomplete = () => res(1); t.onerror = () => rej(t.error)
  })
`

await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })

await send('Page.navigate', { url: SITE }); await sleep(1600)

// 关掉首次进入的弹窗（Tutorial / API Key），否则会挡住标题页
await ev(`(()=>{try{const u=__uiStore.getState();u.setApiKeyModalOpen&&u.setApiKeyModalOpen(false);
  u.setShowTutorial&&u.setShowTutorial(false);}catch(e){}return 1})()`)

console.log('=== 1) 首次进入：库里应该是新卡 ===')
const ready = await waitFor(`typeof __libraryStore!=='undefined' && __libraryStore.getState().loaded`, 25000)
check('卡片库加载完成', ready)
if (!ready) {
  console.log('  （库没加载出来，后面无法继续）')
  await close(); removeProfile(PROFILE); process.exit(1)
}

const readLen = `__libraryStore.getState().worlds.find(w=>w.id===${JSON.stringify(CARD)})?.narrative.replyLength`
const beforeLen = await ev(readLen)
const beforeIds = await ev(`__libraryStore.getState().worlds.map(w=>w.id).join('|')`)
check('库里九张内置卡都在', (beforeIds || '').split('|').length >= 9, `${(beforeIds || '').split('|').length} 张`)
check('★ 首次拿到的是源码里的篇幅（1800）', beforeLen === 1800, String(beforeLen))

console.log('\n=== 2) 把库改成「老玩家」的样子：那张卡退回 800、抹掉指纹 ===')
const seeded = await ev(`(async () => {${IDB_HELPERS}
  const db = await openDb()
  try {
    const raw = await read(db, 'worlds')
    if (!raw) return 'no-worlds'
    const arr = JSON.parse(raw)
    const w = arr.find(x => x.id === ${JSON.stringify(CARD)})
    if (!w) return 'no-card'
    w.narrative.replyLength = 800
    await write(db, 'worlds', JSON.stringify(arr))
    await write(db, 'builtinStamp', undefined)
    return 'ok'
  } finally { db.close() }
})()`)
check('改库成功', seeded === 'ok', String(seeded))

console.log('\n=== 3) 刷新页面：应该自动把旧卡换新 ===')
await send('Page.reload', { ignoreCache: true })
await sleep(1600)
await ev(`(()=>{try{const u=__uiStore.getState();u.setApiKeyModalOpen&&u.setApiKeyModalOpen(false);
  u.setShowTutorial&&u.setShowTutorial(false);}catch(e){}return 1})()`)
const ready2 = await waitFor(`typeof __libraryStore!=='undefined' && __libraryStore.getState().loaded`, 30000)
check('刷新后卡片库加载完成', ready2)

const afterLen = await ev(readLen)
check('★ 旧卡被换成了 1800（这一条就是玩家等了三轮的那个修复）', afterLen === 1800, String(afterLen))

const afterIds = await ev(`__libraryStore.getState().worlds.map(w=>w.id).join('|')`)
check('★ 卡片顺序没有被打乱（刷新是就地替换）', afterIds === beforeIds, afterIds === beforeIds ? '一致' : '顺序变了')

const stamp = await ev(`(async () => {${IDB_HELPERS}
  const db = await openDb()
  try { return await read(db, 'builtinStamp') || '' } finally { db.close() }
})()`)
check('★ 指纹写回了库里（下次启动不再重复刷）', typeof stamp === 'string' && stamp.length > 0, String(stamp).slice(0, 24))

console.log('\n=== 4) 再刷新一次：指纹一致，不该回退 ===')
await send('Page.reload', { ignoreCache: true })
await sleep(1600)
await ev(`(()=>{try{const u=__uiStore.getState();u.setApiKeyModalOpen&&u.setApiKeyModalOpen(false);
  u.setShowTutorial&&u.setShowTutorial(false);}catch(e){}return 1})()`)
await waitFor(`typeof __libraryStore!=='undefined' && __libraryStore.getState().loaded`, 30000)
const len3 = await ev(readLen)
check('★ 第二次刷新后仍然是 1800', len3 === 1800, String(len3))

const failed = fail
console.log(`\n=== 汇总 ===\n  通过 ${pass}/${pass + fail}`)
if (errors?.length) console.log(`  页面错误 ${errors.length} 条：${errors.slice(0, 3).join(' | ')}`)
await close(); removeProfile(PROFILE)
process.exit(failed === 0 && !(errors?.length) ? 0 : 1)
