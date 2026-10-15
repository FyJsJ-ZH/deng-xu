import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { CharacterCard, PlayerCard, WorldCard } from '@/types/cards'

/**
 * 本局会话 store
 *
 * 保存「正在玩哪张世界卡、玩家扮演谁、哪些角色在场」。
 * 之所以把整张世界卡快照存进来，是因为：
 *  1. 引擎每次组提示词都要读它，同步读比异步查 IndexedDB 简单得多；
 *  2. 即使玩家之后去卡片库改了那张卡，进行中的存档也不会莫名其妙变样。
 */
interface SessionState {
  /** 当前世界卡快照 */
  world: WorldCard | null
  /** 当前玩家卡快照 */
  player: PlayerCard | null
  /** 在场角色卡 id（对应 world.characters） */
  activeCharacterIds: string[]
  /** 各背景槽选中的 option id */
  backgroundChoices: Record<string, string>
  /**
   * 玩家在「我自己写」背景项里填的自由文本：`{ 槽位 label → 文本 }`。
   *
   * 之所以和 `backgroundChoices` 分开存：`choices` 存的是"哪个槽位选了哪一项"，
   * 而玩家自己写的那段文本**不是任何一个预设项**，它是那个槽位的正文。
   * 两者的消费方式也不同 —— `choices` 还要拿去查数值加成与开局物品，
   * 自定义文本只进提示词。见 `BackgroundOption.custom`。
   */
  backgroundCustom: Record<string, string>
  /** 玩家分配的属性点 */
  attributeAllocation: Record<string, number>

  setSession: (payload: {
    world: WorldCard
    player: PlayerCard
    activeCharacterIds: string[]
    backgroundChoices: Record<string, string>
    backgroundCustom?: Record<string, string>
    attributeAllocation: Record<string, number>
  }) => void
  /** 存档进行中时更新世界卡快照（例如开场被覆写） */
  patchWorld: (patch: Partial<WorldCard>) => void
  setPlayer: (player: PlayerCard) => void
  setActiveCharacters: (ids: string[]) => void
  clearSession: () => void

  /** 取在场的角色卡对象 */
  getActiveCharacters: () => CharacterCard[]
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      world: null,
      player: null,
      activeCharacterIds: [],
      backgroundChoices: {},
      backgroundCustom: {},
      attributeAllocation: {},

      setSession: ({ world, player, activeCharacterIds, backgroundChoices, backgroundCustom, attributeAllocation }) => set({
        // 存快照而不是引用，避免卡片库后续编辑影响进行中的存档
        world: JSON.parse(JSON.stringify(world)),
        player: JSON.parse(JSON.stringify(player)),
        activeCharacterIds: [...activeCharacterIds],
        backgroundChoices: { ...backgroundChoices },
        backgroundCustom: { ...(backgroundCustom || {}) },
        attributeAllocation: { ...attributeAllocation }
      }),

      patchWorld: (patch) => set((state) => (
        state.world ? { world: { ...state.world, ...patch } } : state
      )),

      setPlayer: (player) => set({ player }),
      setActiveCharacters: (ids) => set({ activeCharacterIds: [...ids] }),
      clearSession: () => set({
        world: null,
        player: null,
        activeCharacterIds: [],
        backgroundChoices: {},
        backgroundCustom: {},
        attributeAllocation: {}
      }),

      getActiveCharacters: () => {
        const { world, activeCharacterIds } = get();
        if (!world) return [];
        const ids = new Set(activeCharacterIds);
        return world.characters.filter(c => ids.has(c.id));
      }
    }),
    {
      name: 'pale-notes-session',
      storage: createJSONStorage(() => localStorage)
    }
  )
)
