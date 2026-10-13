/**
 * 探针：找出一份文件里的**不可见 / 非法字符**，并核对反引号是否配平。
 *
 * 为什么需要它：TypeScript 报 `TS1127: Invalid character` 时，
 * 屏幕上那一行看起来完全正常 —— 因为它骂的不是可见字符，
 * 而是零宽空格、不换行空格（NBSP）、BOM 之类**看不见的东西**。
 * 靠肉眼看那一行是白费功夫，必须把码点打出来。
 *
 * 用法：node scripts/probe-invisible.mjs <文件>
 *      （或 `pnpm probe:invisible <文件>`）
 *
 * ⚠️ 它还会报**反引号是否为偶数**。这一条同样重要：
 * 模板字符串少一个收尾的反引号时，`tsc` 报的仍是 `TS1127: Invalid character`，
 * 而报错位置是**字符串开头那一行**，与真正漏掉的位置可能隔着几百行 ——
 * 2026-10 写四张新世界卡时，一位作者就卡在这个报错上（第 310 行看起来毫无问题，
 * 实际是那一行的模板字符串没收尾）。
 */
import fs from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('用法：node scripts/probe-invisible.mjs <文件>')
  process.exit(1)
}

const text = fs.readFileSync(file, 'utf8')
const lines = text.split('\n')

const NAME = {
  0x200b: 'ZERO WIDTH SPACE',
  0x200c: 'ZWNJ',
  0x200d: 'ZWJ',
  0xfeff: 'BOM / ZERO WIDTH NO-BREAK SPACE',
  0x00a0: 'NO-BREAK SPACE',
  0x2028: 'LINE SEPARATOR',
  0x2029: 'PARAGRAPH SEPARATOR',
  0x3000: 'IDEOGRAPHIC SPACE（正常，中文文本里合法）',
  0xff40: 'HALFWIDTH KATAKANA VOICED SOUND MARK',
}

let hits = 0
lines.forEach((ln, i) => {
  for (const [j, ch] of [...ln].entries()) {
    const cp = ch.codePointAt(0)
    const suspicious =
      cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff ||
      cp === 0x00a0 || cp === 0x2028 || cp === 0x2029 || cp === 0xff40 ||
      (cp < 0x20 && cp !== 0x09)
    if (!suspicious) continue
    hits++
    console.log(
      `  ${file}:${i + 1}:${j + 1}  U+${cp.toString(16).toUpperCase().padStart(4, '0')}  ` +
      `${NAME[cp] || ''}`,
    )
  }
})

// 反引号配平（模板字符串写坏了会让后面整片代码错位，报错位置与真凶无关）
const ticks = (text.match(/`/g) || []).length
console.log(`\n不可见字符 ${hits} 处`)
console.log(`反引号 ${ticks} 个（${ticks % 2 === 0 ? '偶数，配平' : '⚠️ 奇数 —— 有一个模板字符串没闭合'}）`)

// 顺带报一下花括号/圆括号的朴素计数差（只做提示，不保证准确）
const count = (re) => (text.match(re) || []).length
console.log(`{ ${count(/\{/g)} / } ${count(/\}/g)}    ( ${count(/\(/g)} / ) ${count(/\)/g)}    [ ${count(/\[/g)} / ] ${count(/\]/g)}`)
