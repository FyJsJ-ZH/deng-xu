/**
 * 把一段文字放进剪贴板。
 *
 * ## 为什么不是一句 `navigator.clipboard.writeText`
 *
 * 这个功能最需要它的地方是**手机**：玩家想回到第 6 轮，得先把那一轮写过的
 * 那一大段行动抄出来，改两个字再发一次。而手机上的失败率远高于桌面：
 *
 *  - `navigator.clipboard` 只在**安全上下文**（https / localhost）里存在；
 *  - iOS Safari 还额外要求调用发生在**用户手势**的同一个任务里 ——
 *    任何 `await` 之前就取到权限，晚一步就静默失败；
 *  - 权限被拒（`NotAllowedError`）不会抛到 catch 外面，但也不会真的写进去。
 *
 * 所以这里走两条路：先试现代 API，失败就退回 `textarea + execCommand`。
 * 后者早就被标成废弃，但它恰恰是"老 Safari / 非 https"唯一还能用的那条。
 *
 * ## 返回值
 *
 * 成功与否**必须返回**：调用方要据此改按钮文案（"已复制" / "复制失败"）。
 * 静默失败是最坏的一种 —— 玩家以为抄好了，粘贴出来是空的。
 */
export async function copyText(text: string): Promise<boolean> {
  const value = String(text ?? '')
  // 全是空白等同于没内容：写进去只会让玩家粘出一片空气，
  // 而按钮还会显示"已复制"—— 那比不给按钮更糟
  if (!value.trim()) return false

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // 落到下面那一条：权限被拒 / 非安全上下文 / 用户取消
  }

  try {
    if (typeof document === 'undefined') return false
    const ta = document.createElement('textarea')
    ta.value = value
    // readonly 防止 iOS 弹出键盘；fixed + 移出视口防止页面跳动
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '0'
    ta.style.width = '1px'
    ta.style.height = '1px'
    ta.style.padding = '0'
    ta.style.border = 'none'
    ta.style.outline = 'none'
    ta.style.boxShadow = 'none'
    ta.style.background = 'transparent'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    /*
      iOS 上 `select()` 对 readonly 的 textarea 可能只选中一部分，
      必须再显式给一次 range —— 少了这一句，粘出来是半句话。
    */
    ta.setSelectionRange(0, value.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
