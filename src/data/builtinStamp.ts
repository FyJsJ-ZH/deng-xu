/**
 * 内置世界卡的**内容指纹** —— 由 `scripts/stamp-builtins.mjs` 生成，**不要手改**。
 *
 * 用途：`stores/library.ts` 拿它跟 IndexedDB 里存的那份比对。
 * 不一致就说明「内置卡在源码里改过了」，于是把已有的内置卡整批换成新的 ——
 * 没有这一步，老玩家的库里那张卡会永远停在第一次播种时的样子
 * （2026-10 的一轮里，`replyLength` 从 800 改成 1800，线上 bundle 是新的、
 * 玩家看到的却还是 800，就是这个原因）。
 *
 * 它只覆盖**内置卡**：玩家自建的卡不动，玩家主动删过的内置卡也不会因为换戳而复活。
 *
 * 重新生成：`node scripts/stamp-builtins.mjs`（`dev` / `build` 会自动跑）。
 */
export const BUILTIN_STAMP = '498555596844'
