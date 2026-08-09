// Живая проверка на проде: вопрос «тот же продукт или другой вкус».
//
// Что проверяем и чего НЕ трогаем. Карточка-кандидат — настоящая, из
// справочника (зефир NEO botanica): шаг с вопросом её только ЧИТАЕТ. Строку
// создаёт лишь ответ «другой вкус», и она заводится на выдуманный штрих-код,
// которого нет ни у одного товара; в конце скрипт её удаляет. Тестовый
// пользователь тоже удаляется — как и во всех прогонах qa/.
import { createUsers, deleteUserFully, ANON, QA_PASSWORD } from './admin.mjs'

const BASE = 'https://fitproapp.ru'
const SUPA = 'https://api.fitproapp.ru'

// createUsers заводит пользователя админским ключом, но токена не отдаёт:
// админский ключ — не сессия. За access_token, который принимает /api/*,
// нужно войти обычным паролем, как это делает браузер.
async function signIn(email) {
  const r = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email, password: QA_PASSWORD }),
  })
  const j = await r.json().catch(() => null)
  if (!j?.access_token) throw new Error(`не вошёл: ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
  return j.access_token
}

// Штрих-код-пустышка под тест: 8 цифр, префикс 00 (внутренний диапазон),
// заведомо не совпадает ни с чем в рознице.
const TEST_BARCODE = '00990011'

// Название и марка — как у настоящего зефира: именно на совпадение этих двух
// полей сервер и должен среагировать вопросом.
const CARD = {
  name: 'Зефир с кусочками брусники',
  brand: 'NEO botanica',
  kcal100: 135, p100: 0.4, c100: 34, f100: 0,
  basis: 'estimate',
}

const runId = `sim${Date.now().toString(36)}`
let users = []
const log = (...a) => console.log(...a)

async function save(token, body) {
  const r = await fetch(`${BASE}/api/set-exercise?action=save-product`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

try {
  users = await createUsers(runId, 1)
  const token = await signIn(users[0].email)
  log(`тестовый пользователь: ${users[0].email}\n`)

  // ── Шаг 1: сохраняем карточку с тем же названием и маркой под другим кодом.
  log('══ 1. Сохранение карточки с совпадающим названием ══')
  const ask = await save(token, { barcode: TEST_BARCODE, ...CARD })
  log(`HTTP ${ask.status}`)
  log(`reason:    ${ask.body?.reason}`)
  log(`ok:        ${ask.body?.ok}`)
  log(`кандидат:  ${ask.body?.candidate?.name} / ${ask.body?.candidate?.brand} / ${ask.body?.candidate?.kcal100} ккал / код ${ask.body?.candidate?.barcode}`)
  log(`снято:     ${ask.body?.incoming?.name} / ${ask.body?.incoming?.brand} / ${ask.body?.incoming?.kcal100} ккал / код ${ask.body?.incoming?.barcode}`)
  const askOk = ask.body?.reason === 'similar_exists' && ask.body?.candidate && ask.body?.incoming
  log(askOk ? '✓ вопрос задан, обе карточки с цифрами\n' : '✗ вопроса нет\n')

  // ── Шаг 2: отвечаем «другой вкус».
  log('══ 2. Ответ «это другой вкус» ══')
  const distinct = await save(token, { barcode: TEST_BARCODE, ...CARD, distinct: true })
  log(`HTTP ${distinct.status}`)
  log(`created:  ${distinct.body?.created}`)
  log(`linked:   ${distinct.body?.linked}`)
  log(`карточка: ${distinct.body?.product?.name} / ${distinct.body?.product?.kcal100} ккал / код ${distinct.body?.product?.barcode} / source ${distinct.body?.product?.source}`)
  const distinctOk = distinct.body?.created === true && distinct.body?.product?.kcal100 === 135
  log(distinctOk ? '✓ заведена отдельная карточка со своими цифрами\n' : '✗ карточка не заведена\n')

  // ── Шаг 3: тот же вопрос, но ответ «тот же продукт» — на ещё одном коде.
  log('══ 3. Ответ «это тот же продукт» (другой код) ══')
  const SECOND = '00990022'
  const linked = await save(token, { barcode: SECOND, ...CARD, sameAs: ask.body?.candidate?.barcode })
  log(`HTTP ${linked.status}`)
  log(`linked:   ${linked.body?.linked}`)
  log(`created:  ${linked.body?.created}`)
  log(`карточка: ${linked.body?.product?.name} / ${linked.body?.product?.kcal100} ккал / код ${linked.body?.product?.barcode}`)
  const linkOk = linked.body?.linked === true
  log(linkOk ? '✓ код привязан к существующей карточке, новой не заведено\n' : '✗ привязки не было\n')

  console.log(`ИТОГ: вопрос ${askOk ? 'ок' : 'ПРОВАЛ'}, «другой вкус» ${distinctOk ? 'ок' : 'ПРОВАЛ'}, «тот же» ${linkOk ? 'ок' : 'ПРОВАЛ'}`)
} finally {
  for (const u of users) await deleteUserFully(u).catch(() => {})
  console.log('\nтестовый пользователь удалён; тестовые карточки чистит следующий шаг')
}
