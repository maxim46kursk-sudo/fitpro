#!/usr/bin/env node
/**
 * ЕЖЕДНЕВНАЯ СВОДКА ВОРОНКИ — 21:00 по Москве, в канал тревог.
 *
 * ЗАЧЕМ. Счётчики воронки пишутся с осени, но их никто не читает: чтобы увидеть
 * цифры, надо зайти в базу и написать запрос. Данные, за которыми надо идти, —
 * это данные, за которыми не ходят. Сводка приходит сама, в тот же канал, где
 * приходят тревоги, и читается с телефона за десять секунд.
 *
 * ГДЕ ЖИВЁТ. На сервере, в cron, а не в GitHub Actions. Расписание Actions —
 * обещание, а не гарантия (сторож за ним ходит отдельно, см.
 * watchdog-heartbeat.sh), и ставить туда то, что должно приходить каждый день в
 * одно время, значит заранее согласиться на пропуски.
 *
 * СУТКИ СЧИТАЮТСЯ ПО UTC, и это не небрежность. Так считает funnel_bump: день в
 * funnel_counts — это `(now() at time zone 'utc')::date`. Пересчитать задним
 * числом в московские сутки нельзя — в таблице лежат уже сложенные числа, без
 * времени. Поэтому сводка честно говорит, какие именно сутки показывает: с
 * 03:00 мск до 03:00 мск. В 21:00 это вчерашний день, полный и сравнимый с
 * позавчерашним; брать «сегодня» значило бы сравнивать неполные сутки с
 * полными и каждый вечер видеть выдуманное падение.
 *
 * ЧЕГО В СВОДКЕ НЕТ. Заходов из Telegram: воронка их не считает вовсе (см.
 * isTelegram в src/funnel.js) — там другой вход, и смешивать эти цифры с
 * веб-заходами значит испортить и те и другие. Про это сказано в самой сводке,
 * чтобы «ноль» не читался как «никто не пришёл».
 *
 * ОПЛАТЫ БЕРУТСЯ НЕ ИЗ СЧЁТЧИКА, А ИЗ challenge_entries. Счётчик с клиента —
 * худший из возможных источников про деньги: его теряет закрытая вкладка и не с
 * чем сверить. Билеты лежат в базе, их пишет вебхук кассы.
 *
 *   node scripts/funnel-digest.mjs           — посчитать и отправить
 *   node scripts/funnel-digest.mjs --dry     — посчитать и напечатать
 *   node scripts/funnel-digest.mjs --day=2026-08-24  — за конкретные сутки UTC
 */
import { readFileSync, existsSync } from 'node:fs'

// ── Настройки из окружения или из .env приложения ──────────────────────────
const ENV_FILES = [process.env.DIGEST_ENV, '/root/fitpro-app/.env', '.env.local', '.env'].filter(Boolean)

function изФайлов(key) {
  for (const f of ENV_FILES) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = new RegExp(`^${key}=(.*)$`).exec(line.trim())
      if (m) return m[1].replace(/^["']|["']$/g, '')
    }
  }
  return ''
}
const нужно = (key) => process.env[key] || изФайлов(key)

const SUPA = нужно('VITE_SUPABASE_URL') || 'https://api.fitproapp.ru'
const SERVICE = нужно('SUPABASE_SERVICE_ROLE_KEY')
const TOKEN = нужно('TG_ALERT_TOKEN')
const CHAT = нужно('TG_ALERT_CHAT')

const DRY = process.argv.includes('--dry')
const заданныйДень = (process.argv.find((a) => a.startsWith('--day=')) || '').slice(6)

if (!SERVICE) {
  console.error('сводка: нет SUPABASE_SERVICE_ROLE_KEY — считать нечем')
  process.exit(1)
}

// ── Сутки ──────────────────────────────────────────────────────────────────
const деньISO = (d) => d.toISOString().slice(0, 10)
const сдвиг = (iso, дней) => деньISO(new Date(Date.parse(`${iso}T00:00:00Z`) + дней * 86400000))

/** Последние ПОЛНЫЕ сутки UTC: сегодняшние ещё идут и сравнению не подлежат. */
const ДЕНЬ = заданныйДень || сдвиг(деньISO(new Date()), -1)
const ВЧЕРА = сдвиг(ДЕНЬ, -1)
const окно = (iso) => [`${iso}T00:00:00Z`, `${сдвиг(iso, 1)}T00:00:00Z`]

// ── База ───────────────────────────────────────────────────────────────────
const шапка = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }

async function читать(путь) {
  const r = await fetch(`${SUPA}/rest/v1/${путь}`, { headers: шапка })
  if (!r.ok) throw new Error(`${путь}: ${r.status} ${await r.text()}`)
  return await r.json()
}

/** Сколько строк подходит под условие — считает база, не мы. */
async function сколько(путь) {
  const r = await fetch(`${SUPA}/rest/v1/${путь}`, {
    method: 'HEAD',
    headers: { ...шапка, Prefer: 'count=exact' },
  })
  if (!r.ok) throw new Error(`${путь}: ${r.status}`)
  // Content-Range приходит как «*/17» или «0-24/17».
  const m = /\/(\d+)$/.exec(r.headers.get('content-range') || '')
  return m ? Number(m[1]) : 0
}

const заОкно = (таблица, поле, iso) => {
  const [от, до] = окно(iso)
  return `${таблица}?select=${поле}&created_at=gte.${от}&created_at=lt.${до}`
}

// ── Оформление ─────────────────────────────────────────────────────────────
const МЕСЯЦЫ = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
function поРусски(iso) {
  const d = new Date(`${iso}T00:00:00Z`)
  return `${d.getUTCDate()} ${МЕСЯЦЫ[d.getUTCMonth()]}`
}

/**
 * Число со знаком перемены. Без «на сколько процентов»: на числах в единицы
 * штук проценты врут — с одного до двух это «+100%», и такая строка мешает
 * читать, а не помогает.
 */
function перемена(сегодня, вчера) {
  const d = сегодня - вчера
  if (d === 0) return `${сегодня} (=)`
  return `${сегодня} (${d > 0 ? '+' : '−'}${Math.abs(d)})`
}

/** Строка сводки: подпись выравнивается точками, число прижато вправо. */
function строка(подпись, текст) {
  const ширина = 24
  const точки = подпись.length >= ширина ? ' ' : ' ' + '·'.repeat(ширина - подпись.length - 1) + ' '
  return `${подпись}${точки}${текст}`
}

// ── Сбор ───────────────────────────────────────────────────────────────────
async function собрать() {
  const счётчики = await читать(`funnel_counts?select=day,event,n&day=in.(${ДЕНЬ},${ВЧЕРА})`)
  const карта = new Map(счётчики.map((r) => [`${r.day}|${r.event}`, Number(r.n) || 0]))
  const воронка = (event) => [карта.get(`${ДЕНЬ}|${event}`) ?? 0, карта.get(`${ВЧЕРА}|${event}`) ?? 0]

  // Билеты: всего и сколько добавилось за сутки. Служебный тест-поток считаем
  // отдельно — иначе покупка владельца за 50 ₽ выглядела бы как продажа.
  const сезоны = await читать('challenge_seasons?select=id,title,status')
  const служебные = new Set(сезоны.filter((s) => s.status === 'staff').map((s) => s.id))
  const билеты = await читать('challenge_entries?select=season_id,created_at&order=created_at.desc&limit=10000')
  const боевые = билеты.filter((b) => !служебные.has(b.season_id))
  const заСутки = (список, iso) => {
    const [от, до] = окно(iso)
    return список.filter((b) => b.created_at >= от && b.created_at < до).length
  }

  const [маячкиСутки, маячкиВчера] = await Promise.all([
    читать(`${заОкно('boot_beacons', 'stage', ДЕНЬ)}&limit=1000`),
    сколько(заОкно('boot_beacons', 'stage', ВЧЕРА)),
  ])
  const поСтадиям = {}
  for (const b of маячкиСутки) поСтадиям[b.stage || '—'] = (поСтадиям[b.stage || '—'] ?? 0) + 1

  const [ошибок, ошибокВчера] = await Promise.all([
    сколько(заОкно('error_log', 'id', ДЕНЬ)),
    сколько(заОкно('error_log', 'id', ВЧЕРА)),
  ])

  return { воронка, боевые, служебныеБилеты: билеты.length - боевые.length, заСутки, поСтадиям, маячкиСутки, маячкиВчера, ошибок, ошибокВчера }
}

function собратьТекст(д) {
  const { воронка } = д
  const ступени = [
    ['Пришли на вход', 'open'],
    ['Зашли гостем', 'open_guest'],
    null,
    ['Открыли челлендж', 'ch_open'],
    ['Дочитали до галочки', 'ch_rules'],
    ['Нажали «Участвовать»', 'ch_join'],
    ['Пошли заводить аккаунт', 'ch_signup'],
    ['Завелись', 'register'],
    ['Открыли оплату', 'ch_pay'],
  ]

  const строки = ступени.map((ст) => {
    if (!ст) return ''
    const [подпись, event] = ст
    const [сег, вч] = воронка(event)
    return строка(подпись, перемена(сег, вч))
  })

  const оплатилиСег = д.заСутки(д.боевые, ДЕНЬ)
  const оплатилиВч = д.заСутки(д.боевые, ВЧЕРА)
  строки.push(строка('Оплатили', перемена(оплатилиСег, оплатилиВч)))

  const стадии = Object.entries(д.поСтадиям).map(([k, v]) => `${k} ${v}`).join(', ')
  const хвост = [
    строка('Маячки загрузки', перемена(д.маячкиСутки.length, д.маячкиВчера) + (стадии ? ` — ${стадии}` : '')),
    строка('Ошибок в error_log', перемена(д.ошибок, д.ошибокВчера)),
  ]

  return [
    `📊 FitPro за ${поРусски(ДЕНЬ)}`,
    `сутки по UTC: с 03:00 мск ${поРусски(ДЕНЬ)} до 03:00 мск ${поРусски(сдвиг(ДЕНЬ, 1))}`,
    '',
    ...строки,
    '',
    `В боевых потоках всего: ${д.боевые.length}`
      + (д.служебныеБилеты ? ` (плюс ${д.служебныеБилеты} в тест-потоке)` : ''),
    '',
    ...хвост,
    '',
    'Заходы из Telegram в эти числа не входят — у Mini App своя воронка.',
  ].join('\n')
}

// ── Отправка ───────────────────────────────────────────────────────────────
const д = await собрать()
const текст = собратьТекст(д)

if (DRY || !TOKEN || !CHAT) {
  if (!DRY) console.error('сводка: нет TG_ALERT_TOKEN/TG_ALERT_CHAT — печатаю сюда')
  console.log(текст)
  process.exit(0)
}

const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: CHAT, text: текст, disable_web_page_preview: true }),
})
const ответ = await r.json().catch(() => ({}))
if (!ответ?.ok) {
  console.error('сводка: Telegram отказал —', JSON.stringify(ответ))
  process.exit(1)
}
console.log(`сводка за ${ДЕНЬ} отправлена`)

// ── Установка ────────────────────────────────────────────────────────────────
//   scp scripts/funnel-digest.mjs fitpro:/root/fitpro/funnel-digest.mjs
//   в crontab (сервер живёт по Москве, поэтому 21:00 — это просто 21):
//     0 21 * * * /opt/node22/bin/node /root/fitpro/funnel-digest.mjs >> /root/fitpro/digest.log 2>&1
