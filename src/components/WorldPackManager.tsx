import { useRef, useState } from 'react'
import { Package, PackagePlus, Check, X, AlertTriangle, Download } from 'lucide-react'
import { useLibraryStore } from '@/stores/library'
import { exportPack, importPackFile } from '@/utils/worldPack'
import { collectSave } from '@/utils/saveFile'
import { parseWorldbook, worldbookToPack } from '@/utils/worldbook'
import { fromSillyTavernLorebook, isSillyTavernLorebook, toSillyTavernLorebook } from '@/utils/stLorebook'
import { describePreset, fromSillyTavernPreset, isSillyTavernPreset } from '@/utils/stPreset'
import { readStCardFromPng } from '@/utils/pngCard'
import { stCardToWorld } from '@/utils/stCardToWorld'
import { downloadFile, safeFilename, timestampSuffix } from '@/utils/files'

/**
 * 世界包导出 / 导入。
 *
 * 与「存档」入口的分工：
 *  - 存档   = 备份**进度**（换设备继续玩）
 *  - 世界包 = 备份 / 分享**创作**（世界卡及其内嵌的角色卡）
 *
 * 两点实现上的取舍（都是我一开始想错、看了代码才改的）：
 *
 * 1. **角色卡不是独立集合**。这个项目里角色卡嵌在 `WorldCard.characters` 里，
 *    library store 也只有 `worlds`。所以导出世界卡就等于带上了它的角色卡，
 *    不存在"另外再挑一批角色卡"这回事。
 *
 * 2. **冲突策略不在这里做**。`library.importWorlds` 已经处理了 id 撞车
 *    （给导入的卡换新 id，而不是覆盖本地那张）。导入时应该复用它 ——
 *    自己再实现一套"覆盖/跳过"只会和既有行为打架。
 */
export function WorldPackManager() {
  const worlds = useLibraryStore(s => s.worlds)
  const exportAll = useLibraryStore(s => s.exportAll)
  const importWorlds = useLibraryStore(s => s.importWorlds)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [includeSave, setIncludeSave] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = worlds.length > 0 && selected.size === worlds.length
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(worlds.map(w => w.id)))

  const charCount = (w: (typeof worlds)[number]) => (w.characters || []).length

  const handleExport = async () => {
    // 没勾任何一张时默认导出全部 —— 比弹一句"请先勾选"更顺手
    const picked = selected.size ? worlds.filter(w => selected.has(w.id)) : exportAll()
    if (!picked.length) {
      setMsg({ kind: 'err', text: '卡片库里没有可导出的世界卡' })
      return
    }
    try {
      const save = includeSave ? await collectSave() : undefined
      const { bytes, filename } = exportPack({ worlds: picked, allCharacters: [], save })
      setMsg({
        kind: 'ok',
        text: `已导出 ${filename}（${Math.round(bytes / 1024)} KB，${picked.length} 个世界）`,
      })
    } catch (e) {
      setMsg({ kind: 'err', text: `导出失败：${(e as Error)?.message || e}` })
    }
  }

  /**
   * 导出成 SillyTavern 世界书。
   *
   * 为什么世界包之外还要这个出口：本作的世界书只有自己认得的
   * `format: deng-xu-worldbook`，而 ST 生态（以及 DSH 的 `prompt_import_world`
   * 这类工具）只认 `{ entries: [...] }`。没有这个出口，辛辛苦苦写的设定
   * 就只能在自家页面里用；有了它，两张卡可以互相喂。
   *
   * 多选时合并成一本：ST 的世界书本来就是把多个主题的条目混装在一本书里，
   * 按世界拆成多个文件反而不好导入。
   */
  const handleExportSillyTavern = () => {
    const picked = selected.size ? worlds.filter(w => selected.has(w.id)) : exportAll()
    if (!picked.length) {
      setMsg({ kind: 'err', text: '卡片库里没有可导出的世界卡' })
      return
    }
    try {
      const books = picked.map(w => toSillyTavernLorebook(w) as {
        name: string
        description: string
        entries: Record<string, unknown>[]
      })
      const entries = books.flatMap((b, bi) => b.entries.map((e, i) => ({
        ...e,
        // uid / order 全局重排：合并两本书后沿用各自的序号会出现重复 uid
        // （每本按 1000 条留位，够用；真要单本超 1000 条时 uid 也只需唯一，不必连续）
        uid: bi * 1000 + i,
        order: 100 + bi * 1000 + i,
        insertion_order: 100 + bi * 1000 + i,
      })))
      const book = {
        name: books.length === 1 ? books[0].name : `${books[0].name} 等 ${books.length} 个世界`,
        description: picked.map(w => w.tagline).filter(Boolean).join(' / '),
        entries,
      }
      const base = picked.map(w => w.title).slice(0, 2).join('-') || '世界书'
      const filename = `${safeFilename(base)}-${timestampSuffix()}.sillytavern-lorebook.json`
      downloadFile(filename, book)
      setMsg({
        kind: 'ok',
        text: `已导出 ${filename}（${entries.length} 条条目，SillyTavern 格式）。`
          + '可直接导入 SillyTavern，或用 DSH 的 ST 世界书导入器打开。'
          + '本作的 lore 是全量注入的，导出时一律标成 ST 的「常驻（蓝灯）」条目。',
      })
    } catch (e) {
      setMsg({ kind: 'err', text: `导出失败：${(e as Error)?.message || e}` })
    }
  }

  const handleImport = async (file: File | undefined) => {
    if (!file) return

    // 先看是不是世界书 —— 两者都是 JSON，靠 format 字段区分，
    // 让用户不必先分辨自己手里是哪种文件该走哪个按钮
    /*
      ⚠️ 先按**字节**读，不按 `text()` 读。
      因为 ST 的"重设定卡"是 **PNG**：JSON 被 base64 塞在图片的 tEXt chunk 里，
      `file.text()` 得到的是一堆解码失败的二进制，`JSON.parse` 直接抛。
      而本作此前只认 JSON —— 这类卡等于**整批进不来**，报错还只有一句
      "文件不是合法 JSON"，玩家完全看不出发生了什么。

      2026-11 第二十六轮：加一条 PNG 卡通道（见 utils/pngCard.ts）。
      实测那张卡 `description` 是空的，226 条、26 万字的设定全在 `character_book` 里。
    */
    const buf = await file.arrayBuffer()
    let raw: unknown = null
    try {
      raw = JSON.parse(new TextDecoder().decode(buf))
    } catch {
      // 不是 JSON —— 可能是 PNG 角色卡
      const card = readStCardFromPng(buf)
      if (!card) {
        setMsg({
          kind: 'err',
          text: '这个文件既不是合法 JSON，里面也没有 SillyTavern 的角色卡数据。'
            + '（WebP / JPEG **存不了**卡数据 —— 那只是一张图，不是卡。）',
        })
        return
      }

      /*
        **卡片走"完整世界卡"这条路**（2026-11 第二十八轮）。

        原先这里只是把 `character_book` 交给 `fromSillyTavernLorebook`，
        得到的是"一本设定集"：有 worldLore，但角色表是空的、没有属性、
        没有出身、没有物品 —— 玩家点开始会发现只能读设定，玩不起来。

        而这类卡的原作者其实把属性、资源、人物档案全写在 `[initvar]` 里了。
        `stCardToWorld` 就是读那张表，把它翻成灯叙的字段。
      */
      const converted = stCardToWorld(card)
      if (!converted) {
        setMsg({
          kind: 'err',
          text: '这张 SillyTavern 角色卡里的世界书是空的（条目都被停用或没有正文）。',
        })
        return
      }
      try {
        await importWorlds([converted.world])
        const s = converted.stats
        setMsg({
          kind: 'ok',
          text: `已转换：《${converted.world.title}》—— `
            + `${s.characters} 个角色、${s.attributes} 项属性、${s.resources} 条资源、`
            + `${s.backgrounds} 个出身槽、${s.items} 件物品、${s.lores} 条设定。`
            + (s.attributes > 0 ? '机制层已开启，开局可以分配属性点。' : '')
            + (s.dropped.length ? `　（跳过变量系统 ${s.dropped.length} 条）` : ''),
        })
      } catch (e) {
        setMsg({ kind: 'err', text: `写入失败：${(e as Error)?.message || e}` })
      }
      return
    }

    /*
      SillyTavern 世界书优先判：它没有 `format` 字段，只能靠形状认
      （`{ entries: [...] }`、entries 为对象 map、或角色卡里的 character_book）。
      放在前面免得它掉进下面"既不是世界书也不是世界包"的报错里。
    */
    if (isSillyTavernLorebook(raw)) {
      const world = fromSillyTavernLorebook(raw)
      if (!world) {
        setMsg({ kind: 'err', text: '这份 SillyTavern 世界书里没有可用的条目（条目内容与标题都是空的）' })
        return
      }
      try {
        const imported = await importWorlds([world])
        setMsg({
          kind: 'ok',
          text: `已导入 SillyTavern 世界书《${world.title}》：新增 ${imported.length} 个世界，`
            + `${world.lores.length} 条知识条目。`
            + '注意：ST 的**关键词触发在本作不生效** —— 这些条目会全量注入提示词，'
            + '触发词只作为「触发词：…」一行留在条目正文里备查。',
        })
      } catch (e) {
        setMsg({ kind: 'err', text: `写入失败：${(e as Error)?.message || e}` })
      }
      return
    }

    /*
      ⚠️ **SillyTavern 的「预设」和「世界书」是两样东西**（2026-11 第二十五轮）。

      玩家拖进来两个 `.json`，说"下了两个世界书，发现不兼容"。那两个文件里
      一条世界设定都没有 —— 它们是 ST 的 completion preset
      （`temperature` / `prompts[]` / `prompt_order`），写的是"**怎么写**"，
      不是"写什么"。而本作的世界书装的是后者。所以"不兼容"不是坏了，是拿 A 当 B。

      但玩家的诉求是真的：想用上。所以这里把它**转成一张规则包**而不是报错 ——
      规则进 `rules`、文风进 `customStyle`、其余进 `worldLore`，内容一个字不丢。
      转出来的卡不是世界，文案里必须说清楚（见 `stPreset.ts` 的说明）。
    */
    if (isSillyTavernPreset(raw)) {
      const brief = describePreset(raw)
      const world = fromSillyTavernPreset(raw, file.name)
      if (!world) {
        setMsg({
          kind: 'err',
          text: '这是一份 SillyTavern 提示词预设，但里面的条目全是停用的或空的 —— 没有可转换的内容。'
            + '（预设的条目在 ST 里用开关控制，去 ST 里打开再导出一次即可。）',
        })
        return
      }
      try {
        await importWorlds([world])
        setMsg({
          kind: 'ok',
          text: `这是一份 SillyTavern **提示词预设**（不是世界书），已转成规则包《${world.title}》并导入：`
            + `${brief?.total ?? 0} 条启用条目 —— 文风 ${brief?.style ?? 0} 条进「文风」，`
            + `规则 ${brief?.rules ?? 0} 条进「规则」，其余 ${brief?.other ?? 0} 条进世界观正文。`
            + '它不是世界设定（没有地点/人物/物价）。想叠到你自己的世界上：'
            + '用卡片编辑器打开它，把「规则」与「文风」两段复制过去。'
            + '超出篇幅预算的条目名字写在每段末尾。',
        })
      } catch (e) {
        setMsg({ kind: 'err', text: `写入失败：${(e as Error)?.message || e}` })
      }
      return
    }

    const fmt = (raw as any)?.format
    if (fmt === 'deng-xu-worldbook') {
      const book = parseWorldbook(raw)
      if (!book.ok) {
        setMsg({ kind: 'err', text: book.error || '世界书校验失败' })
        return
      }
      try {
        // 转成世界包再走同一条导入通道 —— 不另写一套合并逻辑
        const asPack = worldbookToPack(book.book!)
        const imported = await importWorlds(asPack.worlds)
        setMsg({
          kind: 'ok',
          text: `已导入世界书《${book.book!.title}》：新增 ${imported.length} 个世界。`
            + (book.summary ? '（' + book.summary + '）' : ''),
        })
      } catch (e) {
        setMsg({ kind: 'err', text: `写入失败：${(e as Error)?.message || e}` })
      }
      return
    }

    const r = await importPackFile(file)
    if (!r.ok) {
      setMsg({ kind: 'err', text: r.error || '导入失败' })
      return
    }
    try {
      // 复用 store 的导入：它会为撞车的 id 生成新 id，不会覆盖你本地的卡
      const imported = await importWorlds(r.worlds || [])
      const chars = (r.worlds || []).reduce((n, w) => n + ((w.characters || []).length), 0)
      setMsg({
        kind: 'ok',
        text: `导入完成：新增 ${imported.length} 个世界（含 ${chars} 张角色卡）。`
          + '若与原卡片 id 相同，已自动分配新 id 而不会覆盖你的卡。'
          + (r.note ? '　' + r.note : ''),
      })
    } catch (e) {
      setMsg({ kind: 'err', text: `写入失败：${(e as Error)?.message || e}` })
    }
  }

  return (
    <div className="p-4 bg-surface/20 border border-text-muted/20 rounded space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-serif text-text-muted uppercase tracking-[0.2em] flex items-center gap-1.5">
          <Package size={12} /> 世界包
        </span>
        {worlds.length > 0 && (
          <button onClick={toggleAll} className="text-[10px] text-text-muted hover:text-accent-lantern transition-colors">
            {allSelected ? '取消全选' : '全选'}
          </button>
        )}
      </div>

      <p className="text-[10px] text-text-muted leading-relaxed">
        把世界卡连同它的角色卡打包成一个文件，便于备份或分享。
        {selected.size === 0 && worlds.length > 0 && '未勾选时默认导出全部。'}
        <br />
        与「存档」的区别：存档是<b>进度</b>，世界包是<b>创作</b>。
      </p>

      {worlds.length === 0 ? (
        <div className="text-[10px] text-text-muted italic">卡片库里还没有世界卡。</div>
      ) : (
        <div className="max-h-40 overflow-y-auto space-y-1 pr-1">
          {worlds.map(w => {
            const on = selected.has(w.id)
            const n = charCount(w)
            return (
              <label
                key={w.id}
                className={`flex items-center gap-2 px-2 py-1.5 rounded border cursor-pointer transition-colors text-[11px]
                  ${on ? 'bg-accent-lantern/10 border-accent-lantern/40' : 'border-text-muted/20 hover:border-text-muted/40'}`}
              >
                <input type="checkbox" checked={on} onChange={() => toggle(w.id)} className="accent-yellow-500 shrink-0" />
                <span className={`truncate ${on ? 'text-accent-lantern' : 'text-text-secondary'}`}>{w.title}</span>
                {w.builtin && <span className="text-[9px] text-text-muted/70 shrink-0">内置</span>}
                {n > 0 && <span className="text-[9px] text-text-muted shrink-0 ml-auto">{n} 角色</span>}
              </label>
            )
          })}
        </div>
      )}

      <label className="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" checked={includeSave} onChange={e => setIncludeSave(e.target.checked)}
          className="mt-0.5 accent-yellow-500 shrink-0" />
        <span className="text-[10px] text-text-secondary leading-relaxed">
          <b className="text-text-primary">附带当前存档</b><br />
          勾上会把正在进行的进度也打进包里（用于换设备继续玩）。
          <b>分享给他人时建议不要勾</b> —— 那会把你的游玩记录一起发出去。
        </span>
      </label>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => { void handleExport() }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-text-muted/40 rounded hover:border-accent-lantern/50 hover:text-accent-lantern transition-colors"
        >
          <Package size={12} /> 导出世界包
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-text-muted/40 rounded hover:border-accent-lantern/50 hover:text-accent-lantern transition-colors"
        >
          <PackagePlus size={12} /> 导入世界包
        </button>
        {/* 导入按钮同样吃 SillyTavern 世界书（靠形状自动分流），所以这里不必再放一个入口 */}
        <button
          onClick={handleExportSillyTavern}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-text-muted/40 rounded hover:border-accent-lantern/50 hover:text-accent-lantern transition-colors"
        >
          <Download size={12} /> 导出为 SillyTavern 世界书
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={e => { void handleImport(e.target.files?.[0]); e.target.value = '' }}
        />
      </div>

      <p className="text-[10px] text-text-muted leading-relaxed">
        「导入世界包」也能直接吃 <b className="text-text-secondary">SillyTavern 世界书</b>
        （<code>{'{ entries: [...] }'}</code> 那种，含角色卡内嵌的 character_book）——
        认出来就自动转成本作的世界卡。
        <br />
        <b className="text-text-secondary">注意语义差别</b>：ST 的条目靠关键词触发，
        本作的 lore 是<b>全量注入</b>，导入后所有条目都会进提示词；
        触发词会以「触发词：…」一行留在条目正文里备查，并不会真的"生效"。
      </p>
{/* 官方世界书既是范例也是可直接导入的成品 */}
<div className="text-[10px] text-text-muted leading-relaxed">
  想照着写自己的世界？{' '}
  <a href="./official-worldbook.json" download
    className="text-text-secondary hover:text-accent-lantern underline decoration-dotted">
    下载官方世界书
  </a>
  （含三个内置世界，也可直接导入回来）
</div>

{includeSave && (
        <div className="flex items-start gap-1.5 text-[10px] text-amber-300 leading-relaxed">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          <span>已选择附带存档 —— 分享前请确认这是你要的。</span>
        </div>
      )}

      {msg && (
        <div className={`flex items-start gap-1.5 text-[10px] leading-relaxed ${msg.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>
          {msg.kind === 'ok' ? <Check size={11} className="mt-0.5 shrink-0" /> : <X size={11} className="mt-0.5 shrink-0" />}
          <span>{msg.text}</span>
        </div>
      )}
    </div>
  )
}
