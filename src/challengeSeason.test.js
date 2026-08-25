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

/**
 * И ЗАОДНО — КАКОЙ ПОТОК ЭКРАН ВООБЩЕ ПОКАЗЫВАЕТ. Служебный тест-поток за 50 ₽
 * (sql/2026-08-25_challenge_staff_season.sql) живёт рядом с боевым, и цену
 * человек видит именно ту, что решил этот модуль. Ошибись он — владелец увидел
 * бы 2990 там, где платит 50, или, что хуже, участник увидел бы 50.
 *
 * `rows` здесь — это то, что ОТДАЛА БАЗА, то есть уже после RLS. Служебная
 * строка приезжает только тренеру, и «участник его не видит» проверяется не
 * тут, а на самой миграции (test-challenge-staff.mjs): решает это база, и
 * подменять её решение проверкой роли в браузере было бы враньём про то, где
 * стоит защита.
 */

/** Что «лежит в базе» и что модуль в неё написал. */
let rows = []
/**
 * Строки food_goals, КОТОРЫЕ ОТДАЁТ БАЗА. Массив, а не одна строка, и это
 * важно: у клиента RLS оставляет ровно свою, а тренеру видны ещё и нормы его
 * клиентов (политика trainer_reads_client_goals). Мок ниже повторяет это
 * буквально — фильтрует по user_id, только если запрос его назвал, — иначе
 * проверка «спрашиваем чью-то конкретную норму» проверяла бы саму себя.
 */
let goalRows = []
let goalsFilter = null
let inserts = []
let insertError = null
let rpcCalls = []
let selectedColumns = ''

/** Ответ maybeSingle() у supabase-js: больше одной строки — это ошибка. */
const asMaybeSingle = (list) => (
  list.length > 1
    ? { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
    : { data: list[0] || null, error: null }
)

vi.mock('./supabase.js', () => ({
  supabase: {
    from: (table) => ({
      select: (cols) => {
        if (table === 'challenge_seasons') selectedColumns = cols
        const goalsQuery = {
          eq: (col, value) => {
            goalsFilter = { col, value }
            return goalsQuery
          },
          maybeSingle: () => Promise.resolve(asMaybeSingle(
            goalsFilter ? goalRows.filter((g) => g[goalsFilter.col] === goalsFilter.value) : goalRows,
          )),
        }
        return {
          // сезоны читаются списком, норма — одной строкой
          in: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }),
          ...goalsQuery,
        }
      },
      insert: (row) => {
        inserts.push({ table, row })
        return Promise.resolve({ error: insertError })
      },
    }),
    rpc: (name, args) => {
      rpcCalls.push({ name, args })
      return Promise.resolve({ data: name === 'challenge_nutrition_facts' ? [] : 'norm2', error: null })
    },
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
  goalRows = [{ user_id: USER, kcal: 2000, p: 120, c: 220, f: 65 }]
  goalsFilter = null
  inserts = []
  rpcCalls = []
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

describe('какой поток показывать', () => {
  const STAFF = {
    ...SEASON,
    id: 2,
    title: 'Тест-поток',
    starts_on: '2026-09-10',
    price_rub: 50,
    status: 'staff',
  }

  it('тренеру приехал служебный поток — берётся он, и цена его', async () => {
    // RLS отдала обе строки: значит перед нами тренер.
    rows = [{ ...SEASON }, { ...STAFF }]
    const { loadChallengeState } = await freshModule()
    const state = await loadChallengeState({})

    expect(state.season.id).toBe(2)
    expect(state.season.title).toBe('Тест-поток')
    expect(state.season.price_rub).toBe(50)
    expect(state.season.starts_on).toBe('2026-09-10')
  })

  it('участнику служебной строки не приезжает — он видит боевой поток и 2990', async () => {
    rows = [{ ...SEASON }]
    const { loadChallengeState } = await freshModule()
    const state = await loadChallengeState({})

    expect(state.season.id).toBe(1)
    expect(state.season.price_rub).toBe(2990)
  })

  it('служебный поток спрашивается тем же запросом — отдельной ветки для него нет', async () => {
    // Особый путь проверял бы особый путь: смысл тест-потока в том, что он
    // читается, покупается и считается ровно как боевой.
    rows = [{ ...STAFF }]
    const { loadChallengeState, isChallengeMember } = await freshModule()
    const state = await loadChallengeState({})

    expect(state.season.id).toBe(2)
    expect(isChallengeMember(state)).toBe(false)
  })

  it('свой поток важнее служебного: купивший билет видит свой номер, а не цену', async () => {
    rows = [
      { ...SEASON, status: 'running', challenge_entries: [{ id: 9, participant_no: 3, display_name: 'Пётр', paid_at: 'x', rules_accepted_at: null }] },
      { ...STAFF },
    ]
    const { loadChallengeState, isChallengeMember } = await freshModule()
    const state = await loadChallengeState({})

    expect(state.season.id).toBe(1)
    expect(isChallengeMember(state)).toBe(true)
    expect(state.entry.participant_no).toBe(3)
  })
})

describe('норма питания', () => {
  it('норма приезжает вместе с участием — она решает, продавать ли билет', async () => {
    const { loadChallengeState, hasNorm } = await freshModule()
    const state = await loadChallengeState({})

    expect(state.goals).toEqual({ user_id: USER, kcal: 2000, p: 120, c: 220, f: 65 })
    expect(hasNorm(state)).toBe(true)
  })

  it('нормы нет или она нулевая — участвовать не в чем', async () => {
    goalRows = []
    const first = await freshModule()
    expect(first.hasNorm(await first.loadChallengeState({}))).toBe(false)

    goalRows = [{ user_id: USER, kcal: 0, p: 0, c: 0, f: 0 }]
    const second = await freshModule()
    expect(second.hasNorm(await second.loadChallengeState({}))).toBe(false)
  })

  /**
   * ЖИВОЙ СБОЙ, ИЗ-ЗА КОТОРОГО ВЛАДЕЛЕЦ НЕ ВИДЕЛ ПОТОКА ВОВСЕ.
   *
   * Запрос нормы не называл человека и полагался на RLS. У клиента своя строка
   * одна, и всё сходилось; тренеру же видны и нормы его клиентов, строк
   * приезжало несколько, maybeSingle() падал, падение ловил общий catch — и
   * весь челлендж схлопывался в «набор пока закрыт».
   *
   * Правило, которое проверяется: RLS — это ЗАПРЕТ, а не ФИЛЬТР. Запрос обязан
   * сам называть, чью строку просит, иначе он значит разное для разных ролей.
   */
  it('тренеру видны и чужие нормы — берётся своя, а поток не пропадает', async () => {
    goalRows = [
      { user_id: USER, kcal: 2000, p: 120, c: 220, f: 65 },
      { user_id: 'c0ffee00-0000-4000-8000-000000000001', kcal: 1500, p: 90, c: 150, f: 50 },
    ]
    const { loadChallengeState, hasNorm } = await freshModule()
    const state = await loadChallengeState({})

    expect(state).not.toBe(null)
    expect(state.season.id).toBe(1)
    expect(state.goals.kcal).toBe(2000)
    expect(hasNorm(state)).toBe(true)
  })

  it('запрос нормы называет человека, а не полагается на политику', async () => {
    const { loadChallengeState } = await freshModule()
    await loadChallengeState({})

    expect(goalsFilter).toEqual({ col: 'user_id', value: USER })
  })

  it('заморозка нормы просит базу, а день не называет', async () => {
    // какой сегодня день потока и пора ли снимать второй слепок, решает база:
    // прими она номер дня снаружи, «один честный пересчёт» стал бы пересчётом
    // по требованию
    const { freezeNorm } = await freshModule()
    await freezeNorm(1)

    expect(rpcCalls).toEqual([{ name: 'challenge_freeze_norm', args: { p_season_id: 1 } }])
  })

  it('сырьё по питанию берётся у базы, а проценты — нет', async () => {
    const { loadNutritionFacts } = await freshModule()
    const facts = await loadNutritionFacts(1)

    expect(rpcCalls[0]).toEqual({ name: 'challenge_nutrition_facts', args: { p_season_id: 1 } })
    expect(Array.isArray(facts)).toBe(true)
  })

  it('без сезона в базу не ходим вовсе', async () => {
    const { loadNutritionFacts, freezeNorm } = await freshModule()
    expect(await loadNutritionFacts(null)).toEqual([])
    expect(await freezeNorm(null)).toBe(null)
    expect(rpcCalls).toEqual([])
  })
})

describe('покупка билета: 409 бывают разные', () => {
  /** Ответ ручки create-payment на нажатие «Участвовать». */
  const stubFetch = (status, body) => {
    globalThis.fetch = vi.fn(async () => ({
      status,
      ok: status < 400,
      json: async () => body,
    }))
    // вкладку под оплату модуль открывает до всякого await — подменяем и её
    globalThis.open = vi.fn(() => ({ close: () => {}, location: { replace: () => {} } }))
  }

  it('«уже участник» — не ошибка: экран перечитает состояние', async () => {
    stubFetch(409, { error: 'Вы уже участвуете в этом потоке', reason: 'already' })
    const { buyTicket } = await freshModule()

    expect(await buyTicket()).toEqual({ already: true })
  })

  it('«живого потока нет» — отказ словами сервера, а не «ты уже участник»', async () => {
    // Соврать здесь особенно дорого: человек в этот момент пытается заплатить,
    // и «ты уже участник» отправит его искать несуществующую комнату.
    stubFetch(409, { error: 'Набор в поток пока закрыт — откроем и объявим', reason: 'no_season' })
    const { buyTicket } = await freshModule()
    const result = await buyTicket()

    expect(result.already).toBeUndefined()
    expect(result.error).toContain('Набор в поток пока закрыт')
  })

  it('«нормы нет» — тоже отказ, и тоже своими словами', async () => {
    stubFetch(409, { error: 'Сначала заполни данные о себе', reason: 'no_goals' })
    const { buyTicket } = await freshModule()
    const result = await buyTicket()

    expect(result.already).toBeUndefined()
    expect(result.error).toContain('Сначала заполни данные о себе')
  })

  it('409 без reason читается по-старому — как «уже участник»', async () => {
    // Совместимость на время выкладки: ответ старого сервера не должен
    // превращаться в ошибку на новом экране.
    stubFetch(409, { error: 'Вы уже участвуете в этом потоке' })
    const { buyTicket } = await freshModule()

    expect(await buyTicket()).toEqual({ already: true })
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
