// test-trainer-draft.mjs — незавершённое занятие тренера и возврат в него.
//
// Что было. Занятие пишется в базу по ходу дела, поэтому данные не терялись.
// Терялось СОСТОЯНИЕ: тренировка, из которой тренер вышел, не нажав
// «Завершить», ложилась в список «Мои записи» неотличимой от законченной.
// Вернуться в неё можно было только через «Изменить» — а это другой режим:
// секундомера нет, длительность занятия не пишется вовсе.
//
// Что проверяется:
//
//   • ПОМЕТКА ПЕРЕЖИВАЕТ УХОД. Ради этого всё и делалось — тренер обязан
//     увидеть незавершённое занятие, вернувшись в карточку клиента.
//   • ПОМЕТКА СНИМАЕТСЯ ТОЛЬКО СВОЯ. Завершение одной тренировки не имеет права
//     стереть пометку о другой: та осталась бы незавершённой навсегда.
//   • ЧУЖОГО КЛИЕНТА НЕ ПОКАЗЫВАЕМ. Пометка одна на приложение, а карточек
//     клиентов много.
//   • ХРАНИЛИЩЕ МОЖЕТ ОТСУТСТВОВАТЬ ИЛИ ВРАТЬ (приватный режим, мусор в ключе)
//     — экран тренера от этого падать не должен.
//
// Плюс проверка по исходнику, что экран действительно ставит и снимает пометку
// в нужных местах, а карточка клиента предлагает продолжить: поднимать React с
// Supabase в node дороже, чем это тут стоит (тот же приём, что в
// test-constructor.mjs).
//
// Запуск: node test-trainer-draft.mjs

import { readFileSync } from 'node:fs'

// ── Поддельное localStorage. Ставится ДО импорта модуля: тот читает глобаль
//    при каждом вызове, но честнее иметь его на месте с самого начала.
function makeStorage() {
  const map = new Map()
  return {
    map,
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: k => { map.delete(k) },
  }
}
globalThis.localStorage = makeStorage()

const { TRAINER_DRAFT_KEY, clearDraft, draftForClient, readDraft, saveDraft } =
  await import('./src/trainerDraft.js')

let pass = 0, fail = 0
function report(label, ok, detail) {
  if (ok) { pass++; console.log(`✓ PASS  ${label}`) }
  else { fail++; console.log(`✗ FAIL  ${label}${detail ? '  — ' + detail : ''}`) }
}
const eq = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  report(label, ok, ok ? '' : `получено ${JSON.stringify(actual)}, ждали ${JSON.stringify(expected)}`)
}
const reset = () => { globalThis.localStorage = makeStorage() }

const КЛИЕНТ = 'client-1'
const ЗАНЯТИЕ = { workoutId: 77, clientId: КЛИЕНТ, name: 'Ноги', date: '2026-08-19', startedAt: 1_700_000_000_000 }

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Возврат в незавершённое занятие ────────────────────────────────')
{
  // ГЛАВНЫЙ ТЕСТ. Тренер ушёл, не завершив, — вернувшись, обязан увидеть
  // занятие и продолжить его с того же места и с тем же началом отсчёта.
  reset()
  saveDraft(ЗАНЯТИЕ)
  const d = draftForClient(КЛИЕНТ)
  report('незавершённое занятие видно в карточке клиента', !!d)
  eq('это та самая тренировка', d?.workoutId, 77)
  eq('название сохранилось', d?.name, 'Ноги')
  eq('дата сохранилась', d?.date, '2026-08-19')
  eq('момент старта сохранился — секундомер продолжит, а не начнёт заново',
    d?.startedAt, 1_700_000_000_000)
}
{
  // Пометка переживает перезагрузку страницы: содержимое хранилища то же,
  // модуль перечитывает его заново.
  reset()
  saveDraft(ЗАНЯТИЕ)
  const сырое = globalThis.localStorage.getItem(TRAINER_DRAFT_KEY)
  reset()
  globalThis.localStorage.setItem(TRAINER_DRAFT_KEY, сырое)
  eq('после перезахода пометка на месте', readDraft()?.workoutId, 77)
}
{
  // Завершение занятия пометку снимает — иначе оно висело бы незавершённым
  // после того, как его закрыли.
  reset()
  saveDraft(ЗАНЯТИЕ)
  clearDraft(77)
  report('после «Завершить» незавершённых нет', draftForClient(КЛИЕНТ) === null)
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Снимается только своя пометка ──────────────────────────────────')
{
  // Тренер открыл на правку СТАРУЮ запись и завершил её, пока живое занятие
  // числится незавершённым. Стереть его пометку значило бы потерять его
  // насовсем: продолжить стало бы нечем.
  reset()
  saveDraft(ЗАНЯТИЕ)
  clearDraft(999)
  eq('чужой id пометку не трогает', draftForClient(КЛИЕНТ)?.workoutId, 77)
  clearDraft(77)
  report('свой id — снимает', draftForClient(КЛИЕНТ) === null)
}
{
  // id из базы приезжает то числом, то строкой — сравнение обязано это пережить.
  reset()
  saveDraft(ЗАНЯТИЕ)
  clearDraft('77')
  report('строковый id тоже опознаётся', readDraft() === null)
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Чужой клиент ──────────────────────────────────────────────────')
{
  reset()
  saveDraft(ЗАНЯТИЕ)
  report('в карточке другого клиента пометки нет', draftForClient('client-2') === null)
  report('а в своей — есть', draftForClient(КЛИЕНТ)?.workoutId === 77)
  report('без клиента ничего не показываем', draftForClient(null) === null)
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Хранилище может врать ─────────────────────────────────────────')
{
  reset()
  globalThis.localStorage.setItem(TRAINER_DRAFT_KEY, 'не json')
  report('мусор в ключе = пометки нет', readDraft() === null)
}
{
  reset()
  globalThis.localStorage.setItem(TRAINER_DRAFT_KEY, JSON.stringify({ clientId: КЛИЕНТ, startedAt: 1 }))
  report('без workoutId продолжать нечего', readDraft() === null)
  globalThis.localStorage.setItem(TRAINER_DRAFT_KEY, JSON.stringify({ workoutId: 5, startedAt: 1 }))
  report('без clientId показывать негде', readDraft() === null)
  globalThis.localStorage.setItem(TRAINER_DRAFT_KEY, JSON.stringify({ workoutId: 5, clientId: КЛИЕНТ }))
  report('без момента старта пометку не берём', readDraft() === null)
}
{
  reset()
  report('неполную пометку не ставим вовсе', saveDraft({ workoutId: 1 }) === false)
  report('и хранилище остаётся пустым', globalThis.localStorage.map.size === 0)
}
{
  // Приватный режим Safari: setItem бросает. Занятие от этого падать не должно.
  const бросает = {
    getItem: () => { throw new Error('нет доступа') },
    setItem: () => { throw new Error('нет доступа') },
    removeItem: () => { throw new Error('нет доступа') },
  }
  globalThis.localStorage = бросает
  let упало = false
  try {
    saveDraft(ЗАНЯТИЕ); readDraft(); clearDraft(77); draftForClient(КЛИЕНТ)
  } catch { упало = true }
  report('хранилище бросает — модуль не падает', !упало)
  reset()
}
{
  // Хранилища нет вовсе (сборка без окна).
  const было = globalThis.localStorage
  delete globalThis.localStorage
  let упало = false
  try {
    report('без хранилища пометки просто нет', readDraft() === null && draftForClient(КЛИЕНТ) === null)
  } catch { упало = true; report('без хранилища пометки просто нет', false) }
  report('и это не падение', !упало)
  globalThis.localStorage = было
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n── Экран и карточка подключены ───────────────────────────────────')
{
  const сессия = readFileSync('src/TrainerSession.jsx', 'utf8')
  report('пометка ставится вместе с созданием тренировки, а не при уходе',
    /setWorkoutId\(data\.id\)[\s\S]{0,900}saveDraft\(\{/.test(сессия))
  report('правка прошлой записи пометку не ставит', /if \(!editWorkoutId\) \{\s*\n\s*saveDraft/.test(сессия))
  report('«Завершить» снимает пометку', /clearDraft\(wid\)/.test(сессия))
  report('снесённая пустышка снимает пометку тоже',
    /workouts\?id=eq\.\$\{wid\}`, 'DELETE'[\s\S]{0,200}clearDraft\(wid\)/.test(сессия))
  report('продолжение поднимает ту же тренировку из базы',
    /const openWorkoutId = editWorkoutId \?\? resumeWorkoutId/.test(сессия))
  report('и секундомер продолжает с сохранённого начала',
    /startedAtRef\.current = resumeStartedAt \|\| Date\.now\(\)/.test(сессия))
  report('длительность занятия при этом пишется (это не режим правки)',
    /if \(!editWorkoutId\) patch\.duration/.test(сессия))
}
{
  const app = readFileSync('src/App.jsx', 'utf8')
  report('карточка клиента читает пометку', /draftForClient\(client\??\.?id\)/.test(app))
  report('и предлагает продолжить', /data-testid="unfinished-resume"/.test(app))
  report('продолжение открывается занятием, а не правкой',
    /setSession\(\{editId:null,resume:\{workoutId:unfinished\.workoutId,startedAt:unfinished\.startedAt\}\}\)/.test(app))
  report('пометку можно убрать руками', /data-testid="unfinished-drop"/.test(app))
  report('экран занятия получает продолжение пропом', /resume=\{session\.resume\|\|null\}/.test(app))
}

console.log('\n' + '─'.repeat(68))
console.log(`Итог: ${pass} пройдено, ${fail} провалено`)
process.exitCode = fail ? 1 : 0
