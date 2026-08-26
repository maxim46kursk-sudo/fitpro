// ГЛУБИНА ПРОКРУТКИ В СВОДКЕ — считаются ЛЮДИ И СЕКУНДЫ, а не события.
//
// ЗАЧЕМ ЭТОТ ТЕСТ. Отметки 25/50/75 нужны ради одного вопроса: где внутри
// лендинга уходят люди и успевают ли они там что-то прочитать. Ответ собирается
// из журнала — и ровно там его легче всего испортить незаметно:
//   • посчитать события вместо людей (один человек, качнувший страницу, даст
//     десяток «дошедших» — и число будет выглядеть отлично, будучи мусором);
//   • взять среднее вместо медианы (одна вкладка, забытая на час, сдвинет
//     ответ так, что он перестанет описывать хоть кого-нибудь);
//   • потерять «конец»: он приезжает не отдельным событием, а ступенью
//     `scroll`, и его легко не связать с разрезом страницы.
//
// Ни на что живое тест не ходит: PostgREST подменён в globalThis.fetch, база
// отвечает заранее написанным журналом.
//
// Запуск: node test-motion-health.mjs

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key'
process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
process.env.MONITOR_KEY = 'test-monitor-key'

const { default: handler } = await import('./api/set-exercise.js')

const SUPA_HOST = new URL(process.env.VITE_SUPABASE_URL).host
const REAL_FETCH = globalThis.fetch

let pass = 0, fail = 0
function report(label, ok, detail) {
  if (ok) { pass++; console.log(`✓ PASS  ${label}`) }
  else { fail++; console.log(`✗ FAIL  ${label}${detail ? '  — ' + detail : ''}`) }
}
function assertEqual(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  report(label, ok, ok ? '' : `ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`)
}

/** Строка журнала ровно в том виде, в каком её пишет logShipper. */
const строка = (тег, данные) => `12:00:00 [${тег}] ${JSON.stringify(данные)}`

/**
 * Подменённый PostgREST: motion_log отдаёт наш журнал, остальные таблицы —
 * пусто. Сводке этого хватает: она собирает блоки независимо друг от друга.
 */
function stub(lines) {
  globalThis.fetch = async (url) => {
    const u = new URL(String(url))
    if (u.host !== SUPA_HOST) throw new Error(`неожиданный запрос наружу: ${u.href}`)
    const тело = u.pathname.endsWith('/motion_log') ? [{ payload: { lines } }] : []
    return new Response(JSON.stringify(тело), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-range': '0-0/*' },
    })
  }
}

async function сводка(lines) {
  stub(lines)
  let ответ = null
  const res = {
    setHeader() { return res },
    status(code) { res.code = code; return res },
    json(body) { ответ = body; return res },
    end() { return res },
  }
  await handler({ method: 'GET', query: { action: 'motion-health', key: 'test-monitor-key' }, headers: {} }, res)
  return ответ
}

console.log('\n── Глубина прокрутки в сводке motion-health ───────────────────────')

// Три посетителя с разной судьбой:
//   аня  — долистала до конца, быстро: 4 / 9 / 14 / 20 секунд;
//   боря — застрял на половине, но читал: 30 и 90 секунд;
//   вика — качнула страницу до четверти дважды (два события, один человек).
const журнал = [
  строка('challenge.open', { vid: 'аня', s: 'tg', сек: 1.2 }),
  строка('challenge.depth', { vid: 'аня', гл: 25, сек: 4 }),
  строка('challenge.depth', { vid: 'аня', гл: 50, сек: 9 }),
  строка('challenge.depth', { vid: 'аня', гл: 75, сек: 14 }),
  строка('challenge.scroll', { vid: 'аня', сек: 20 }),

  строка('challenge.open', { vid: 'боря', s: 'tg', сек: 2 }),
  строка('challenge.depth', { vid: 'боря', гл: 25, сек: 30 }),
  строка('challenge.depth', { vid: 'боря', гл: 50, сек: 90 }),

  строка('challenge.open', { vid: 'вика', s: 'vk', сек: 3 }),
  строка('challenge.depth', { vid: 'вика', гл: 25, сек: 8 }),
  строка('challenge.depth', { vid: 'вика', гл: 25, сек: 8 }),
]

const ответ = await сводка(журнал)
const глубина = ответ?.час?.воронка?.глубина

report('в сводке появился разрез страницы', Array.isArray(глубина), JSON.stringify(глубина))
assertEqual('строк ровно четыре: 25/50/75 и конец', глубина?.map((г) => г.до), ['25%', '50%', '75%', 'конец'])
assertEqual('людей на каждой отметке — люди, а не события', глубина?.map((г) => г.людей), [3, 2, 1, 1])
// 25%: 4, 8, 30 → 8. 50%: 9 и 90 → медиана 49.5, среднее было бы тем же, но
// ниже видно, зачем именно медиана. 75% и конец — по одному человеку.
assertEqual('медиана секунд до каждой отметки', глубина?.map((г) => г.медиана_сек), [8, 49.5, 14, 20])

// «Конец» — это ступень scroll, отдельного события у него нет.
const безКонца = await сводка(журнал.filter((l) => !l.includes('[challenge.scroll]')))
assertEqual('без ступени scroll конец пуст, а не выдуман',
  безКонца?.час?.воронка?.глубина?.at(-1), { до: 'конец', людей: 0, медиана_сек: null })

// Забытая вкладка: один человек с часом на странице не должен утаскивать ответ.
const сЗабытой = await сводка([
  ...журнал,
  строка('challenge.open', { vid: 'гена', сек: 1 }),
  строка('challenge.depth', { vid: 'гена', гл: 25, сек: 3600 }),
])
// Ряд до четверти становится 4, 8, 30, 3600 — медиана 19 секунд. Среднее на
// том же ряду дало бы 910: почти четверть часа «типичного» чтения там, где три
// человека из четырёх уложились в полминуты.
const до25 = сЗабытой?.час?.воронка?.глубина?.[0]
assertEqual('час в одной вкладке не утаскивает ответ (среднее дало бы 910)', до25?.медиана_сек, 19)
assertEqual('но человека считает', до25?.людей, 4)

// Ступени воронки от разреза не пострадали: depth не должен стать ступенью.
assertEqual('глубина не влезла в ряд ступеней',
  ответ?.час?.воронка?.ступени?.map((с) => с.ступень),
  ['open', 'scroll', 'join-click', 'auth', 'pay-start', 'paid'])
assertEqual('открывших по-прежнему трое', ответ?.час?.воронка?.ступени?.[0]?.людей, 3)

// Старые записи — без поля `сек`: человек дошёл, времени про него мы не знаем.
const старое = await сводка([строка('challenge.depth', { vid: 'дима', гл: 50 })])
assertEqual('запись без секунд — это дошедший человек без времени',
  старое?.час?.воронка?.глубина?.[1], { до: '50%', людей: 1, медиана_сек: null })

globalThis.fetch = REAL_FETCH
console.log(`\nИтог: ${pass} пройдено, ${fail} провалено`)
process.exit(fail ? 1 : 0)
