// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * СОГЛАСИЕ С ПРАВИЛАМИ ЖИВЁТ НА СЕРВЕРЕ, А НЕ В БРАУЗЕРЕ.
 *
 * Это здесь и проверяется, и проверять это надо именно так — по тому, ЧТО
 * модуль спрашивает у базы и чего он НЕ пишет на устройство. Галочка в
 * localStorage отвечает на «я не знал правил» ровно до первой очистки кэша и
 * ровно на одном телефоне: человек, прочитавший правила на телефоне и
 * открывший челлендж с компьютера, увидел бы их снова — и был бы прав, решив,
 * что его согласие никто не сохранил.
 */

const USER = '6838d807-fb05-4c7d-af71-a13360373dcd'

/** Что «лежит в базе» и что модуль в неё написал. */
let rows = []
let inserts = []
let insertError = null
let selectedColumns = ''

vi.mock('./supabase.js', () => ({
  supabase: {
    from: (table) => ({
      select: (cols) => {
        selectedColumns = cols
        return { in: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }
      },
      insert: (row) => {
        inserts.push({ table, row })
        return Promise.resolve({ error: insertError })
      },
    }),
    auth: {
      getSession: async () => ({ data: { session: { access_token: 't', user: { id: USER } } } }),
    },
  },
}))

const SEASON = {
  id: 1,
  title: 'Поток 1',
  starts_on: null,
  price_rub: 2990,
  prize_pct: 50,
  prize_split: [50, 30, 20],
  status: 'open',
  challenge_entries: [],
  challenge_rules_consent: [],
}

/** Свежий модуль — это и есть «перезагрузил страницу»: память модуля пуста. */
async function freshModule() {
  vi.resetModules()
  return import('./challengeSeason.js')
}

beforeEach(() => {
  rows = [{ ...SEASON }]
  inserts = []
  insertError = null
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('согласие читается с сервера', () => {
  it('нет строки согласия — правила ещё не читаны', async () => {
    const { loadChallengeState, hasAcceptedRules } = await freshModule()
    const state = await loadChallengeState({})

    expect(state.season.price_rub).toBe(2990)
    expect(state.rulesAcceptedAt).toBe(null)
    expect(hasAcceptedRules(state)).toBe(false)
  })

  it('есть строка согласия — правила прочитаны, и это видно сразу', async () => {
    rows = [{ ...SEASON, challenge_rules_consent: [{ accepted_at: '2026-08-24T10:00:00Z' }] }]
    const { loadChallengeState, hasAcceptedRules } = await freshModule()
    const state = await loadChallengeState({})

    expect(state.rulesAcceptedAt).toBe('2026-08-24T10:00:00Z')
    expect(hasAcceptedRules(state)).toBe(true)
  })

  it('у участника согласие видно и по самой записи', async () => {
    // копия в challenge_entries — то, по чему судят приз: строка участника
    // должна отвечать на вопрос «согласился ли» сама
    rows = [{
      ...SEASON,
      challenge_entries: [{ id: 1, participant_no: 7, display_name: 'Пётр', paid_at: 'x', rules_accepted_at: '2026-08-20T09:00:00Z' }],
      challenge_rules_consent: [],
    }]
    const { loadChallengeState } = await freshModule()
    const state = await loadChallengeState({})

    expect(state.rulesAcceptedAt).toBe('2026-08-20T09:00:00Z')
  })

  it('согласие спрашивается тем же единственным запросом, что и участие', async () => {
    const { loadChallengeState } = await freshModule()
    await loadChallengeState({})

    expect(selectedColumns).toContain('challenge_rules_consent')
    expect(selectedColumns).toContain('challenge_entries')
  })
})

describe('согласие переживает перезагрузку и другое устройство', () => {
  it('после перезагрузки согласие снова приезжает с сервера, а не из браузера', async () => {
    rows = [{ ...SEASON, challenge_rules_consent: [{ accepted_at: '2026-08-24T10:00:00Z' }] }]

    const first = await freshModule()
    expect((await first.loadChallengeState({})).rulesAcceptedAt).toBe('2026-08-24T10:00:00Z')
    // ничего на устройство не писали — писать туда согласие и нельзя
    expect(localStorage.length).toBe(0)

    // «перезагрузка»: память модуля пуста, хранилище пусто
    localStorage.clear()
    const second = await freshModule()
    expect((await second.loadChallengeState({})).rulesAcceptedAt).toBe('2026-08-24T10:00:00Z')
    expect(localStorage.length).toBe(0)
  })

  it('гость согласия не имеет и в базу за ним не ходит', async () => {
    const { loadChallengeState } = await freshModule()
    expect(await loadChallengeState({ guest: true })).toBe(null)
    expect(inserts.length).toBe(0)
  })
})

describe('запись согласия', () => {
  it('пишет строку своего потока и своего человека', async () => {
    const { acceptRules } = await freshModule()
    const result = await acceptRules(1)

    expect(result).toEqual({ ok: true })
    expect(inserts).toEqual([{ table: 'challenge_rules_consent', row: { season_id: 1, user_id: USER } }])
  })

  it('повторное согласие — не ошибка: первая дата остаётся', async () => {
    // человек мог согласиться с телефона и нажать ещё раз с компьютера;
    // уникальность (season_id, user_id) стережёт ПЕРВУЮ дату
    insertError = { code: '23505', message: 'duplicate key value violates unique constraint' }
    const { acceptRules } = await freshModule()

    expect(await acceptRules(1)).toEqual({ ok: true })
  })

  it('настоящий сбой записи — честная ошибка, а не молчаливое «согласился»', async () => {
    insertError = { code: '42501', message: 'permission denied' }
    const { acceptRules } = await freshModule()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await acceptRules(1)
    expect(result.ok).toBeUndefined()
    expect(result.error).toContain('permission denied')
  })

  it('без потока соглашаться не с чем', async () => {
    const { acceptRules } = await freshModule()
    expect((await acceptRules(null)).error).toBeTruthy()
    expect(inserts.length).toBe(0)
  })
})
