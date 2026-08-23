import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ensureFoodDiaryMigrated, resetFoodDiaryMigration } from './foodDiaryMigrate.js'

/**
 * ПЕРЕЕЗД ГОСТЕВОГО ДНЕВНИКА — то, на чём держится обещание «при регистрации не
 * потеряется ничего». Проверяется четыре вещи, и каждая закрывает свой способ
 * это обещание нарушить:
 *
 *   потерять   — гостевые записи не доехали до базы;
 *   удвоить    — кэш облачных записей уехал в базу ещё раз, и человек «съел»
 *                свой завтрак дважды;
 *   бросить    — одна запись не легла, и вместе с ней потерялись остальные;
 *   удвоить-2  — повторный вызов (а их четыре, по одному на каждый эффект
 *                загрузки) перенёс всё заново.
 */

const KEY = 'fitpro_food_diary'

/** Хранилище в памяти: jsdom-овское между тестами не сбрасывается. */
function installStorage() {
  const map = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  })
  return map
}

/**
 * Заглушка Supabase ровно под используемую цепочку:
 * `.from(t).insert(row).select().single()`.
 *
 * @param {(row: object) => {data?: object, error?: object}} respond
 */
function fakeSupabase(respond) {
  const inserted = []
  return {
    inserted,
    from: () => ({
      insert: (row) => {
        inserted.push(row)
        return {
          select: () => ({
            single: async () => respond(row),
          }),
        }
      },
    }),
  }
}

const guest = (name, over = {}) => ({
  id: 1700000000000,
  name,
  kcal: 100,
  p: 1,
  c: 2,
  f: 3,
  meal: 'breakfast',
  local: true,
  ...over,
})
const cloud = (id, name) => ({ id, name, kcal: '200', p: '4', c: '5', f: '6', meal: null })

describe('перенос гостевого дневника питания в аккаунт', () => {
  let store

  beforeEach(() => {
    resetFoodDiaryMigration()
    store = installStorage()
    // отправку в счётчик воронки глушим: сети в тесте нет
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })))
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  const setCache = (obj) => store.set(KEY, JSON.stringify(obj))
  const getCache = () => JSON.parse(store.get(KEY))

  it('гостевые записи уезжают в базу, а в кэше получают облачный id без маркера', async () => {
    setCache({
      '2026-08-20': [guest('Овсянка')],
      '2026-08-21': [guest('Творог', { meal: 'lunch' })],
    })
    let next = 500
    const db = fakeSupabase(() => ({ data: { id: next++ }, error: null }))

    const res = await ensureFoodDiaryMigrated(db, 'user-1')

    expect(res).toEqual({ moved: 2, failed: 0 })
    // в базу ушли и дата (ключ кэша), и владелец — их в самой записи не было
    expect(db.inserted).toEqual([
      { user_id: 'user-1', date: '2026-08-20', name: 'Овсянка', kcal: 100, p: 1, c: 2, f: 3, meal: 'breakfast' },
      { user_id: 'user-1', date: '2026-08-21', name: 'Творог', kcal: 100, p: 1, c: 2, f: 3, meal: 'lunch' },
    ])

    const cache = getCache()
    expect(cache['2026-08-20'][0]).toMatchObject({ id: 500, name: 'Овсянка' })
    expect(cache['2026-08-21'][0]).toMatchObject({ id: 501, name: 'Творог' })
    // маркера больше нет ни у одной — иначе следующий вход повёз бы их снова
    expect('local' in cache['2026-08-20'][0]).toBe(false)
    expect('local' in cache['2026-08-21'][0]).toBe(false)
  })

  it('записи без маркера — это кэш облака, и повторно они не вставляются', async () => {
    setCache({ '2026-08-20': [cloud(11, 'Курица'), cloud(12, 'Рис')] })
    const db = fakeSupabase(() => ({ data: { id: 999 }, error: null }))

    const res = await ensureFoodDiaryMigrated(db, 'user-1')

    expect(res).toEqual({ moved: 0, failed: 0 })
    expect(db.inserted).toEqual([])
    // кэш не тронут вовсе
    expect(getCache()['2026-08-20']).toEqual([cloud(11, 'Курица'), cloud(12, 'Рис')])
  })

  it('смешанный день: едет только гостевое, облачное остаётся на месте', async () => {
    setCache({ '2026-08-20': [cloud(11, 'Курица'), guest('Кефир')] })
    const db = fakeSupabase(() => ({ data: { id: 700 }, error: null }))

    const res = await ensureFoodDiaryMigrated(db, 'user-1')

    expect(res).toEqual({ moved: 1, failed: 0 })
    expect(db.inserted).toHaveLength(1)
    expect(db.inserted[0]).toMatchObject({ name: 'Кефир' })
    const day = getCache()['2026-08-20']
    expect(day[0]).toEqual(cloud(11, 'Курица'))
    expect(day[1]).toMatchObject({ id: 700, name: 'Кефир' })
    expect('local' in day[1]).toBe(false)
  })

  it('одна запись не легла: её маркер остаётся, остальные переезжают', async () => {
    setCache({ '2026-08-20': [guest('Овсянка'), guest('Битая'), guest('Творог')] })
    let next = 800
    const db = fakeSupabase((row) =>
      row.name === 'Битая'
        ? { data: null, error: { message: 'нет связи' } }
        : { data: { id: next++ }, error: null },
    )

    const res = await ensureFoodDiaryMigrated(db, 'user-1')

    expect(res).toEqual({ moved: 2, failed: 1 })
    const day = getCache()['2026-08-20']
    expect(day[0]).toMatchObject({ id: 800 })
    expect('local' in day[0]).toBe(false)
    // упавшая осталась ровно как была — и поедет при следующем входе
    expect(day[1]).toMatchObject({ name: 'Битая', local: true, id: 1700000000000 })
    expect(day[2]).toMatchObject({ id: 801 })
    expect('local' in day[2]).toBe(false)
  })

  it('повторный вызов после успеха не вставляет ничего', async () => {
    setCache({ '2026-08-20': [guest('Овсянка')] })
    const db = fakeSupabase(() => ({ data: { id: 900 }, error: null }))

    await ensureFoodDiaryMigrated(db, 'user-1')
    expect(db.inserted).toHaveLength(1)

    // тот же заход: барьер отдаёт готовый промис, до кэша дело не доходит
    await ensureFoodDiaryMigrated(db, 'user-1')
    expect(db.inserted).toHaveLength(1)

    // и даже если барьер сбросить (перезагрузка страницы) — маркеров больше
    // нет, переносить нечего
    resetFoodDiaryMigration()
    const res = await ensureFoodDiaryMigrated(db, 'user-1')
    expect(res).toEqual({ moved: 0, failed: 0 })
    expect(db.inserted).toHaveLength(1)
  })

  /**
   * Барьер существует ради этого случая: четыре эффекта загрузки дневника
   * стартуют параллельно на одном userId, и без общего промиса каждый повёз бы
   * свою копию завтрака.
   */
  it('четыре параллельных вызова переносят один раз', async () => {
    setCache({ '2026-08-20': [guest('Овсянка')] })
    const db = fakeSupabase(() => ({ data: { id: 950 }, error: null }))

    const all = await Promise.all([
      ensureFoodDiaryMigrated(db, 'user-1'),
      ensureFoodDiaryMigrated(db, 'user-1'),
      ensureFoodDiaryMigrated(db, 'user-1'),
      ensureFoodDiaryMigrated(db, 'user-1'),
    ])

    expect(db.inserted).toHaveLength(1)
    for (const r of all) expect(r).toEqual({ moved: 1, failed: 0 })
  })

  /**
   * НОВАЯ МОДЕЛЬ ГОСТЯ: он не пишет в кэш вовсе. Его работа приезжает одним
   * буфером, отложенным в момент нажатия «Создать аккаунт».
   */
  it('буфер гостя переносится и забирается с диска', async () => {
    store.set('fitpro_guest_pending', JSON.stringify({
      workouts: [],
      food: { '2026-08-24': [{ id: 1, name: 'Овсянка', kcal: 300, p: 10, c: 50, f: 5, meal: 'breakfast' }] },
    }))
    const db = fakeSupabase(() => ({ data: { id: 4200 }, error: null }))

    const res = await ensureFoodDiaryMigrated(db, 'user-1')

    expect(res).toEqual({ moved: 1, failed: 0 })
    expect(db.inserted[0]).toMatchObject({ user_id: 'user-1', date: '2026-08-24', name: 'Овсянка' })
    // буфер исчез: держать его вторым экземпляром нельзя
    expect(store.get('fitpro_guest_pending')).toBeUndefined()
    // а запись легла в обычный кэш уже с облачным id и без маркера
    const day = getCache()['2026-08-24']
    expect(day[0]).toMatchObject({ id: 4200, name: 'Овсянка' })
    expect('local' in day[0]).toBe(false)
  })

  it('буфер и кэш складываются, а не спорят', async () => {
    setCache({ '2026-08-20': [cloud(11, 'Курица'), guest('Кефир')] })
    store.set('fitpro_guest_pending', JSON.stringify({
      workouts: [],
      food: { '2026-08-20': [{ id: 2, name: 'Гречка', kcal: 200, p: 6, c: 40, f: 2, meal: null }] },
    }))
    let next = 600
    const db = fakeSupabase(() => ({ data: { id: next++ }, error: null }))

    const res = await ensureFoodDiaryMigrated(db, 'user-1')

    expect(res).toEqual({ moved: 2, failed: 0 })
    expect(db.inserted.map((r) => r.name).sort()).toEqual(['Гречка', 'Кефир'])
    // облачная запись как лежала, так и лежит
    expect(getCache()['2026-08-20'][0]).toEqual(cloud(11, 'Курица'))
  })

  it('упавшая запись из буфера не поедет дважды: буфер уже отдан в кэш', async () => {
    store.set('fitpro_guest_pending', JSON.stringify({
      workouts: [],
      food: { '2026-08-24': [{ id: 1, name: 'Битая', kcal: 100, p: 1, c: 1, f: 1, meal: null }] },
    }))
    const db = fakeSupabase(() => ({ data: null, error: { message: 'нет связи' } }))

    const res = await ensureFoodDiaryMigrated(db, 'user-1')

    expect(res).toEqual({ moved: 0, failed: 1 })
    // буфера больше нет — запись живёт в кэше с маркером и поедет оттуда
    expect(store.get('fitpro_guest_pending')).toBeUndefined()
    expect(getCache()['2026-08-24'][0]).toMatchObject({ name: 'Битая', local: true })
  })

  it('пустой дневник и отсутствие userId — без единого запроса', async () => {
    const db = fakeSupabase(() => ({ data: { id: 1 }, error: null }))

    expect(await ensureFoodDiaryMigrated(db, null)).toEqual({ moved: 0, failed: 0 })
    expect(await ensureFoodDiaryMigrated(db, 'user-1')).toEqual({ moved: 0, failed: 0 })
    expect(db.inserted).toEqual([])
  })
})
