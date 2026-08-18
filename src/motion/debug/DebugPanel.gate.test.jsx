// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

/**
 * ПАНЕЛИ НЕТ В ПРОДЕ ВОВСЕ — ни панели, ни мишени тройного тапа.
 *
 * Игра уходит участникам челленджа. Тройной тап по углу задумывался как
 * «обычный пользователь такое не найдёт», но угол экрана человек задевает
 * ладонью, ставя телефон, — и получает поверх тренировки окно с ползунками
 * порогов, записью сырых точек и кнопкой калибровки. На кону деньги: случайно
 * сдвинутый порог это уже не косметика.
 */

afterEach(cleanup)

async function fresh({ dev, search }) {
  vi.resetModules()
  vi.stubEnv('DEV', dev)
  vi.stubGlobal('location', { search, hash: '' })
  return import('./DebugPanel.jsx')
}

describe('доступ к диагностической панели', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    try {
      globalThis.localStorage?.clear()
    } catch {
      // нет хранилища — и не надо
    }
  })

  it('в проде без ключа нет ни панели, ни мишени тапа', async () => {
    const { default: DebugPanel } = await fresh({ dev: false, search: '' })
    render(<DebugPanel />)
    expect(screen.queryByTestId('debug-hit')).toBeNull()
  })

  it('в проде ?motion-debug=1 её открывает', async () => {
    const { default: DebugPanel } = await fresh({ dev: false, search: '?motion-debug=1' })
    render(<DebugPanel />)
    expect(screen.queryByTestId('debug-hit')).toBeTruthy()
  })

  it('чужой ?debug=1 её больше не открывает', async () => {
    /**
     * Ключ переименован ради переезда. `debug` — слово, которое хозяйское
     * приложение может завести под свою отладку в любой момент, и тогда его ключ
     * открывал бы поверх боевого экрана ползунки порогов судейства. На кону
     * деньги: случайно сдвинутый порог это уже не косметика.
     */
    const { default: DebugPanel } = await fresh({ dev: false, search: '?debug=1' })
    render(<DebugPanel />)
    expect(screen.queryByTestId('debug-hit')).toBeNull()
  })

  it('на дев-сервере панель на месте: там она основной инструмент', async () => {
    const { default: DebugPanel } = await fresh({ dev: true, search: '' })
    render(<DebugPanel />)
    expect(screen.queryByTestId('debug-hit')).toBeTruthy()
  })

  it('память прошлого раза в проде панель не открывает', async () => {
    /**
     * Тонкое место: панель запоминала своё состояние в localStorage. Человек,
     * открывший её один раз на деве или по ключу, получал бы её потом всегда —
     * и разработчик, проверяя прод, видел бы не то, что видит участник.
     */
    const { debugAllowed } = await fresh({ dev: false, search: '' })
    globalThis.localStorage?.setItem('fitpro-motion.debug.open.v1', '1')
    expect(debugAllowed()).toBe(false)

    const { default: DebugPanel } = await fresh({ dev: false, search: '' })
    render(<DebugPanel />)
    expect(screen.queryByTestId('debug-hit')).toBeNull()
  })
})
