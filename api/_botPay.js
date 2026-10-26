import crypto from 'node:crypto'
import { egressFetch } from './_egress.js'
import { sendMail } from './_mail.js'
import { ownerChatId, reportError } from './_logError.js'
import { issuePromo, annulPromo, promoActive, promoLeft, LOGIN_SITE, CLUB_SITE, PROMO_KEY } from './_promo.js'
import { PLAN_DAYS_BY_KEY, PLAN_DAYS_DEFAULT } from './prodamus-webhook.js'

/**
 * ОПЛАТА ПЕРЕВОДОМ ЧЕРЕЗ БОТА (окт 2026). Таблицы — sql/2026-10-26_bot_pay.sql.
 *
 * Почему: Продамус на рассрочке удерживал ~40%, и ещё ~4% с каждого платежа.
 *
 * Путь покупателя:
 *   «Вступить» на сайте → api/create-payment.js заводит заказ и отдаёт ссылку
 *   t.me/<бот>?start=o_<ключ> → человек жмёт Start → бот показывает пакет,
 *   сумму и реквизиты → человек переводит и присылает чек (фото или PDF) →
 *   пока владелец проверяет, бот собирает анкету (телефон, ФИО, дата рождения,
 *   согласие с правилами).
 *
 * Путь владельца (окт 2026). ПО УМОЛЧАНИЮ ПОДТВЕРЖДАЕТ ЧЕЛОВЕК: ИИ читает чек
 *   и пишет подсказку в подписи (сумма, получатель, повтор), решает менеджер
 *   кнопкой ✅/❌. Вне режима работы (/часы, по умолчанию 9–24 МСК) покупатель
 *   видит «подтвердим утром», а в начале рабочего дня бот пересылает все
 *   ночные чеки заново (botPayTick). Ночной автопилот (/ночь, по умолчанию
 *   выключен) и круглосуточный /авто (выключен): ИИ читает чек —
 *   получатель против реквизитов, номер операции, признаки монтажа; тот же чек
 *   (номер операции или файл) второй раз не принимается. Всё сошлось — доступ
 *   сразу, владельцу копия с кнопкой «↩️ Аннулировать» (если денег в банке нет).
 *   Не сошлось — чек владельцу с кнопками ✅ / ❌, как раньше. /авто — выкл/вкл.
 *   Подтверждение ✅ → аккаунт (по Telegram-id, тот же, что даёт
 *   вход через Telegram на сайте) → клуб на 1 или 4 месяца → номера акции
 *   (promo_issue, общий счётчик с Продамусом) → покупателю: номер, кнопка в
 *   группу клуба и кнопка входа на сайт без пароля.
 *
 * Команды владельца (в личке боту):
 *   /реквизиты <текст> — сохранить реквизиты и включить оплату через бота;
 *   /касса — вернуть оплату через Продамус; /бот — снова через бота;
 *   /заказы — чеки, ждущие проверки; /часы 9-23 — режим работы;
 *   /авто — автовыдача по чеку без менеджера (вкл/выкл).
 *
 * БОТ ОПЛАТЫ — отдельный (PAY_BOT_TOKEN, напр. @zmclubonline_bot), чтобы у
 * покупателя и имя, и адрес бота были «ZM Club». Нет переменной — работает
 * старый @maxim_fitpro_bot (TELEGRAM_BOT_TOKEN). В группу клуба по-прежнему
 * пускает старый бот: ссылку-заявку выписывает он (clubCall).
 * Обновления забирает опрос (api/club-chat.js, action=poll) — вебхука нет.
 */

const PLANS = {
  club: { title: '1 месяц клуба', amount: 3000, tickets: 1 },
  club4: { title: 'Пакет 3+1 · 4 месяца клуба', amount: 9000, tickets: 4 },
}
const rub = n => n.toLocaleString('ru-RU').replace(/ /g, ' ') + ' ₽'
const LINK_TTL_S = 7 * 24 * 3600
// Совершеннолетие — на день итогов (как в api/promo.js).
const DRAW_DAY = [2026, 11, 12]

/** Токен бота оплаты: отдельный, если задан, иначе бот клуба. */
export const payToken = () => process.env.PAY_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
/** Отдельный бот оплаты включён? */
export const separatePayBot = () => !!process.env.PAY_BOT_TOKEN && process.env.PAY_BOT_TOKEN !== process.env.TELEGRAM_BOT_TOKEN

export async function tgCall(method, body, token = payToken()) {
  if (!token) throw new Error('токен бота не настроен')
  const r = await egressFetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => null)
  if (!j?.ok) throw new Error(`${method}: ${j?.description || r.status}`)
  return j.result
}
const send = (chat_id, text, extra = {}) => tgCall('sendMessage', { chat_id, text, disable_web_page_preview: true, ...extra })

let botName = null
async function botUsername() {
  if (botName) return botName
  const me = await tgCall('getMe', {})
  return (botName = me.username)
}

export async function paySettings(db) {
  const { data } = await db.from('club_settings').select('pay_requisites, pay_via_bot, pay_mode, pay_auto, pay_hours, pay_night, pay_reminded_on, chat_id').eq('id', 1).maybeSingle()
  const [from, to] = parseHours(data?.pay_hours)
  // Режим оплаты: 'transfer' — на сайте, 'bot' — через бота, 'prodamus' — касса.
  const mode = data?.pay_mode && data.pay_mode !== 'prodamus' ? data.pay_mode : (data?.pay_via_bot ? 'bot' : 'prodamus')
  const has = !!data?.pay_requisites
  return {
    requisites: data?.pay_requisites || null, mode,
    viaBot: has && mode === 'bot', viaSite: has && mode === 'transfer',
    autoAlways: data?.pay_auto === true, chatId: data?.chat_id || null,
    hoursFrom: from, hoursTo: to, remindedOn: data?.pay_reminded_on || null,
    night: parseNight(data?.pay_night ?? 'off'),
    get auto() { return this.autoAlways || inNight(this.night) },
  }
}

// ── Ночной автопилот: в эти часы (по Москве) чеки, где ИИ всё сходится,
// выдаются сразу, без менеджера. «0-9» = с 00:00 до 09:00; можно через полночь
// («23-9»). null — выключен. Меняется командой /ночь.
function parseNight(v) {
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(String(v || '').trim())
  if (!m) return null
  const a = +m[1], b = +m[2]
  return a >= 0 && a <= 23 && b >= 0 && b <= 24 && a !== b ? [a, b] : null
}
function inNight(n) {
  if (!n) return false
  const h = mskNow().getUTCHours()
  return n[0] < n[1] ? h >= n[0] && h < n[1] : h >= n[0] || h < n[1]
}

// ── Режим работы (подтверждение оплат вручную) ──────────────────────────────
// Часы по Москве, «9-23» = с 9:00 до 23:00. Меняется командой /часы.
function parseHours(v) {
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(String(v || '').trim())
  const a = m ? +m[1] : 9, b = m ? +m[2] : 24
  return a >= 0 && a <= 23 && b >= 1 && b <= 24 && a < b ? [a, b] : [9, 24]
}
const mskNow = () => new Date(Date.now() + 3 * 3600e3) // поля getUTC* = московское время
const mskDate = () => mskNow().toISOString().slice(0, 10)
export const workingNow = st => { const h = mskNow().getUTCHours(); return h >= st.hoursFrom && h < st.hoursTo }
export const hh = h => `${String(h % 24).padStart(2, '0')}:00`

/** Что сказать покупателю, пока чек ждёт менеджера. */
function waitText(st, again) {
  if (again) return '📎 Добавил чек к заказу.'
  if (workingNow(st)) {
    return '✅ Чек получил! Менеджер проверит оплату — обычно в течение 30 минут. Номер участника и доступ в клуб придут сюда.'
  }
  const h = mskNow().getUTCHours()
  const when = h >= st.hoursTo ? 'завтра утром' : 'утром'
  return [
    '✅ Платёж принят, заказ сохранён.',
    '',
    `Менеджер выдаёт номера с ${hh(st.hoursFrom)} до ${hh(st.hoursTo)} по Москве. ${when[0].toUpperCase() + when.slice(1)}, после ${hh(st.hoursFrom)}, он проверит перевод и выдаст тебе номер участника и доступ в клуб — они придут сюда.`,
    '',
    'Ничего больше делать не нужно 👌',
  ].join('\n')
}

/** Оплата сейчас идёт через бота? Для api/create-payment.js. */
export async function payViaBot(db) {
  try { return (await paySettings(db)).viaBot } catch { return false }
}

/** Заказ с сайта → ссылка в бота. */
export async function createBotOrder(db, { plan, userId = null }) {
  if (!PLANS[plan]) throw new Error('неизвестный пакет')
  const token = crypto.randomBytes(12).toString('base64url')
  const { error } = await db.from('bot_orders').insert({ token, plan, amount: PLANS[plan].amount, user_id: userId })
  if (error) throw new Error(`bot_orders: ${error.message}`)
  return { url: `https://t.me/${await botUsername()}?start=o_${token}` }
}

// ── Места акции ─────────────────────────────────────────────────────────────
async function seatsProblem(db, plan) {
  if (!promoActive()) return null // после акции клуб продаётся как обычно
  let left
  try { left = await promoLeft(db) } catch { return null }
  const need = PLANS[plan].tickets
  if (left >= need) return null
  return left > 0 ? `Осталось мест: ${left} — пакет 3+1 уже не помещается, выбери 1 месяц.` : 'Места в акции закончились — приём участников закрыт.'
}

// ── Сообщения покупателю ────────────────────────────────────────────────────
const pkgButtons = () => ({ inline_keyboard: [[
  { text: '1 месяц · 3 000 ₽', callback_data: 'pk:club' },
  { text: '3+1 · 9 000 ₽', callback_data: 'pk:club4' },
]] })

async function sendPayInfo(db, chatId, order) {
  const st = await paySettings(db)
  const p = PLANS[order.plan]
  if (!st.requisites) {
    await send(chatId, 'Оплата через бота сейчас настраивается. Загляни чуть позже 🙏')
    await tellOwner(db, '⚠️ Покупатель открыл бота, а реквизиты не заданы. Пришли: /реквизиты <текст>')
    return
  }
  const seats = await seatsProblem(db, order.plan)
  if (seats) { await send(chatId, seats, order.plan === 'club4' ? { reply_markup: pkgButtons() } : {}); return }
  await send(chatId, [
    `🚗 ZM Club — ${p.title}`,
    `Сумма: ${rub(p.amount)}${p.tickets > 1 ? ` · ${p.tickets} номера участника` : ' · 1 номер участника'}`,
    '',
    `Переведи ровно ${rub(p.amount)} по реквизитам:`,
    '',
    st.requisites,
    '',
    '📎 После перевода пришли сюда чек — скриншот или PDF из банка.',
    'Как только оплата подтвердится, я пришлю твой номер участника и доступ в клуб.',
  ].join('\n'), { reply_markup: { inline_keyboard: [[{ text: 'Сменить пакет', callback_data: 'chg' }]] } })
}

async function tellOwner(db, text, extra = {}) {
  try {
    const owner = await ownerChatId(db)
    if (owner) await send(owner, text, extra)
  } catch { /* уведомление не должно ломать покупку */ }
}

// ── Анкета ──────────────────────────────────────────────────────────────────
async function buyer(db, tgId) {
  const { data } = await db.from('bot_buyers').select('*').eq('tg_user_id', tgId).maybeSingle()
  return data
}
async function saveBuyer(db, tgId, fields) {
  await db.from('bot_buyers').upsert({ tg_user_id: tgId, ...fields, updated_at: new Date().toISOString() })
}
const anketaDone = b => !!(b?.phone && b?.full_name && b?.birth_date && b?.consent_at)

async function askNext(db, chatId, tgId) {
  const b = await buyer(db, tgId)
  if (!b?.phone) {
    await saveBuyer(db, tgId, { chat_id: chatId, step: 'phone' })
    return send(chatId, 'Пока проверяю оплату — заполним анкету участника (1 минута). По этому телефону позвоним, если победишь.\n\nНажми кнопку ниже 👇', {
      reply_markup: { keyboard: [[{ text: '📱 Отправить мой номер', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
    })
  }
  if (!b.full_name) {
    await saveBuyer(db, tgId, { step: 'name' })
    return send(chatId, 'Напиши фамилию и имя (как в паспорте):', { reply_markup: { remove_keyboard: true } })
  }
  if (!b.birth_date) {
    await saveBuyer(db, tgId, { step: 'birth' })
    return send(chatId, 'Дата рождения в формате ДД.ММ.ГГГГ (например, 05.03.1995):')
  }
  if (!b.consent_at) {
    await saveBuyer(db, tgId, { step: 'consent' })
    return send(chatId, `Последний шаг: подтверди согласие с правилами акции и обработкой персональных данных (правила — на ${CLUB_SITE}, кнопка «Правила»).`, {
      reply_markup: { inline_keyboard: [[{ text: '✅ Согласен(на)', callback_data: 'cs' }]] },
    })
  }
  await saveBuyer(db, tgId, { step: null })
  await syncAnketa(db, tgId)
  return send(chatId, '✅ Анкета заполнена.', { reply_markup: { remove_keyboard: true } })
}

function parseBirth(t) {
  const m = /^(\d{1,2})[.\-/ ](\d{1,2})[.\-/ ](\d{4})$/.exec(String(t).trim())
  if (!m) return { err: 'Не понял дату. Напиши так: 05.03.1995' }
  const d = +m[1], mo = +m[2], y = +m[3]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (y < 1920 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { err: 'Такой даты нет — проверь, пожалуйста.' }
  const [dy, dm, dd] = DRAW_DAY
  const age = dy - y - ((dm < mo || (dm === mo && dd < d)) ? 1 : 0)
  if (age < 18) return { err: 'Участвовать в акции можно с 18 лет.' }
  return { iso: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` }
}

/** Анкету из бота — в анкету акции, если у человека уже есть подтверждённая оплата. */
async function syncAnketa(db, tgId) {
  const b = await buyer(db, tgId)
  if (!b) return
  const { data: o } = await db.from('bot_orders').select('user_id').eq('tg_user_id', tgId).eq('status', 'confirmed')
    .not('user_id', 'is', null).order('decided_at', { ascending: false }).limit(1).maybeSingle()
  if (!o?.user_id) return
  const row = { user_id: o.user_id, promo: PROMO_KEY, updated_at: new Date().toISOString() }
  if (b.phone) row.phone = b.phone
  if (b.full_name) row.full_name = b.full_name
  if (b.birth_date) row.birth_date = b.birth_date
  if (b.consent_at) row.consent_at = b.consent_at
  const { error } = await db.from('promo_participants').upsert(row, { onConflict: 'user_id' })
  if (error) console.error('botPay: анкета не перенесена:', error.message)
}

// ── Заказы ──────────────────────────────────────────────────────────────────
const tgName = f => [f?.first_name, f?.last_name].filter(Boolean).join(' ') + (f?.username ? ` @${f.username}` : '')

async function newOrderFor(db, from, plan) {
  const { data, error } = await db.from('bot_orders')
    .insert({ plan, amount: PLANS[plan].amount, tg_user_id: from.id, tg_name: tgName(from).slice(0, 120) })
    .select('*').single()
  if (error) throw new Error(`bot_orders: ${error.message}`)
  return data
}

async function openOrder(db, tgId) {
  const { data } = await db.from('bot_orders').select('*').eq('tg_user_id', tgId)
    .in('status', ['new', 'rejected', 'receipt']).order('created_at', { ascending: false }).limit(1).maybeSingle()
  return data
}

async function onStart(db, msg) {
  const from = msg.from, chatId = msg.chat.id
  const arg = String(msg.text || '').trim().split(/\s+/)[1] || ''
  let order = null
  const m = /^o_([A-Za-z0-9_-]{8,40})$/.exec(arg)
  if (m) {
    const { data } = await db.from('bot_orders').select('*').eq('token', m[1]).maybeSingle()
    if (data && data.status === 'new' && (!data.tg_user_id || String(data.tg_user_id) === String(from.id))) {
      const { data: upd } = await db.from('bot_orders')
        .update({ tg_user_id: from.id, tg_name: tgName(from).slice(0, 120) }).eq('id', data.id).select('*').single()
      order = upd
    }
  }
  await saveBuyer(db, from.id, { chat_id: chatId })
  if (!order) {
    return send(chatId, '🚗 ZM Club. Выбери пакет — каждый месяц клуба даёт номер участника акции:', { reply_markup: pkgButtons() })
  }
  await sendPayInfo(db, chatId, order)
}

// ── Чтение чека ИИ ──────────────────────────────────────────────────────────
//
// Модель та же, что у ассистента в приложении (api/chat.js), запрос — через
// egressFetch (с российского сервера Anthropic идёт через мост).
const AI_MODEL = 'claude-sonnet-4-6'
const AI_TIMEOUT_MS = 30_000

async function downloadTgFile(fileId) {
  const f = await tgCall('getFile', { file_id: fileId })
  const r = await egressFetch(`https://api.telegram.org/file/bot${payToken()}/${f.file_path}`)
  if (!r.ok) throw new Error(`файл чека: ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  return { buf, path: f.file_path }
}

/** Разбор чека. Бросает при сбое — тогда чек идёт владельцу на ручную проверку. */
async function readReceipt({ fileId, isPhoto, mime, requisites, expected }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY не настроен')
  const { buf, path } = await downloadTgFile(fileId)
  const ext = String(path).split('.').pop().toLowerCase()
  const isPdf = !isPhoto && (mime === 'application/pdf' || ext === 'pdf')
  const imgType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
  return readReceiptBuf({ buf, isPdf, imgType, requisites, expected })
}

/** То же по готовому файлу (чек, загруженный на сайте). */
async function readReceiptBuf({ buf, isPdf, imgType, requisites, expected }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY не настроен')
  if (!isPdf && buf.length > 4.5 * 1024 * 1024) throw new Error('картинка чека слишком большая')
  const media = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: imgType, data: buf.toString('base64') } }
  const prompt = [
    'Это чек (квитанция) банковского перевода, который покупатель прислал как подтверждение оплаты.',
    `Ожидаемая сумма: ${expected} ₽. Реквизиты продавца, куда должны были перевести:`,
    '"""', requisites, '"""',
    'Ответь ТОЛЬКО JSON без пояснений:',
    '{"is_receipt": bool (это действительно чек/квитанция банковского перевода или оплаты, а не другая картинка),',
    ' "success": bool (операция выполнена успешно, а не «в обработке», «отклонена», «отменена»),',
    ' "amount": number|null (сумма перевода в рублях без комиссии),',
    ' "datetime": "YYYY-MM-DDTHH:MM"|null (дата и время операции, как в чеке),',
    ' "recipient": string|null (получатель как в чеке: имя, телефон, карта),',
    ' "recipient_matches": bool (получатель соответствует реквизитам продавца: совпадает имя/инициалы, телефон или последние цифры карты; если данных недостаточно — false),',
    ' "operation_id": string|null (номер операции / идентификатор СБП / номер документа / номер квитанции),',
    ' "bank": string|null,',
    ' "suspicious": bool (есть признаки монтажа: разные шрифты, сдвинутые цифры, следы редактирования, нереалистичный интерфейс),',
    ' "note": string (коротко по-русски, что не так, или «ок»)}',
  ].join('\n')
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), AI_TIMEOUT_MS)
  try {
    const r = await egressFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 600, messages: [{ role: 'user', content: [media, { type: 'text', text: prompt }] }] }),
    })
    const j = await r.json().catch(() => null)
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${j?.error?.message || ''}`)
    const txt = (j?.content || []).map(c => c.text || '').join('')
    const m = txt.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('ИИ не вернул JSON')
    return JSON.parse(m[0])
  } finally { clearTimeout(t) }
}

/** Решение по разобранному чеку: null — можно выдавать автоматически, иначе причина. */
async function autoProblem(db, order, ai, uniqueId) {
  if (!ai?.is_receipt) return 'это не похоже на чек'
  if (!ai.success) return 'операция не завершена'
  if (ai.suspicious) return `подозрение на монтаж: ${ai.note || ''}`.trim()
  if (!ai.recipient_matches) return `получатель не совпал с реквизитами (${ai.recipient || '—'})`
  const amount = Number(ai.amount)
  if (!Number.isFinite(amount) || Math.round(amount) < order.amount) return `сумма ${ai.amount ?? '—'} ₽ вместо ${order.amount} ₽`
  if (!ai.datetime) return 'не видно даты операции'
  const at = Date.parse(`${String(ai.datetime).slice(0, 16)}:00+03:00`)
  if (!Number.isFinite(at)) return `непонятная дата ${ai.datetime}`
  // Перевод — не раньше заказа (запас 15 мин на разницу часов/поясов) и не из будущего.
  if (at < new Date(order.created_at).getTime() - 15 * 60e3) return `перевод раньше заказа (${ai.datetime})`
  if (at > Date.now() + 3 * 3600e3) return `дата из будущего (${ai.datetime})`
  if (!ai.operation_id) return 'нет номера операции'
  const opId = String(ai.operation_id).replace(/\s+/g, '').slice(0, 80)
  const { data: dupOp } = await db.from('bot_orders').select('id').eq('receipt_op_id', opId).neq('id', order.id)
    .in('status', ['confirming', 'confirmed']).limit(1).maybeSingle()
  if (dupOp) return `этот чек уже использован в заказе #${dupOp.id}`
  if (uniqueId) {
    const { data: dupFile } = await db.from('bot_orders').select('id').eq('receipt_unique_id', uniqueId).neq('id', order.id).limit(1).maybeSingle()
    if (dupFile) return `тот же файл уже присылали в заказе #${dupFile.id}`
  }
  return null
}

async function onReceipt(db, msg) {
  const from = msg.from, chatId = msg.chat.id
  const order = await openOrder(db, from.id)
  if (!order) {
    return send(chatId, 'Сначала выбери пакет, а потом пришли чек ещё раз 👇', { reply_markup: pkgButtons() })
  }
  const isPhoto = !!msg.photo?.length
  const file = isPhoto ? msg.photo[msg.photo.length - 1] : msg.document
  const fileId = file.file_id
  const uniqueId = file.file_unique_id || null
  const again = order.status === 'receipt'
  await db.from('bot_orders').update({
    status: 'receipt', receipt_file_id: fileId, receipt_type: isPhoto ? 'photo' : 'document',
    receipt_unique_id: uniqueId, receipt_at: new Date().toISOString(),
  }).eq('id', order.id)

  const st = await paySettings(db)
  const b = await buyer(db, from.id)
  const p = PLANS[order.plan]

  // ── Покупателю — сразу, до проверки: в рабочие часы «до 30 минут»,
  // ночью — «менеджер подтвердит утром». В режиме /авто ответит сама проверка.
  if (!st.auto) await send(chatId, waitText(st, again)).catch(() => {})
  else await send(chatId, '🔎 Чек получил, проверяю…').catch(() => {})

  // ── ИИ читает чек. По умолчанию это ПОДСКАЗКА менеджеру (сумма, время,
  // получатель, повтор чека) — решает человек. Только в режиме /авто всё
  // сошедшееся выдаётся сразу.
  let ai = null, problem = null
  try {
    ai = await readReceipt({ fileId, isPhoto, mime: msg.document?.mime_type, requisites: st.requisites || '', expected: order.amount })
    problem = await autoProblem(db, order, ai, uniqueId)
  } catch (e) {
    problem = `ИИ не смог прочитать чек (${String(e?.message || e).slice(0, 80)})`
  }
  await db.from('bot_orders').update({
    receipt_ai: ai, receipt_op_id: ai?.operation_id ? String(ai.operation_id).replace(/\s+/g, '').slice(0, 80) : null,
    receipt_check: problem ? problem.slice(0, 200) : 'ok',
  }).eq('id', order.id)

  const aiLine = ai ? `🤖 ${ai.amount ?? '?'} ₽ · ${ai.datetime || '?'} · ${ai.recipient || '?'} · оп. ${ai.operation_id || '?'}` : null
  const head = [
    `🧾 ${again ? 'Ещё чек по заказу' : 'Заказ'} #${order.id} · ${p.title} · ${rub(order.amount)}`,
    `От: ${tgName(from) || 'без имени'} (id ${from.id})`,
    b?.phone ? `Тел.: ${b.phone}` : null,
    aiLine,
  ].filter(Boolean)
  const owner = await ownerChatId(db).catch(() => null)
  const toOwner = async (caption, kb) => {
    try {
      if (!owner) throw new Error('не найден Telegram-id владельца')
      const sent = await tgCall(isPhoto ? 'sendPhoto' : 'sendDocument', {
        chat_id: owner, [isPhoto ? 'photo' : 'document']: fileId, caption: caption.slice(0, 1024), reply_markup: kb,
      })
      await db.from('bot_orders').update({ owner_msg_id: sent.message_id }).eq('id', order.id)
    } catch (e) {
      reportError('api:botpay:receipt', ['чек не ушёл владельцу:', e], { message: `чек #${order.id} не ушёл владельцу: ${e?.message}`, status: 500 })
    }
  }

  if (!problem && st.auto) {
    const r = await confirmOrder(db, order.id, { auto: true })
    if (r.done) {
      await toOwner([...head, '', `✅ АВТО: доступ выдан → ${r.numbers?.length ? r.numbers.map(n => '№' + n).join(', ') : 'клуб'}`,
        'Если денег в банке нет — жми «Аннулировать».'].join('\n'),
      { inline_keyboard: [[{ text: '↩️ Аннулировать', callback_data: `an:${order.id}` }]] })
      return
    }
    problem = `автовыдача не прошла: ${r.msg}`
  }

  // ── Менеджеру на подтверждение (с подсказкой ИИ).
  await toOwner([...head, problem ? `⚠️ ИИ: ${problem}` : '🤖 ИИ: сумма, получатель и дата сходятся, чек новый', '', 'Проверь поступление в банке и нажми кнопку.'].join('\n'),
    { inline_keyboard: [[
      { text: `✅ Подтвердить ${rub(order.amount)}`, callback_data: `ok:${order.id}` },
      { text: '❌ Нет оплаты', callback_data: `no:${order.id}` },
    ]] })
  if (st.auto) await send(chatId, waitText(st, again)).catch(() => {})
  if (!anketaDone(b)) await askNext(db, chatId, from.id)
}

// ── Аннулирование автовыдачи владельцем ─────────────────────────────────────
async function annulOrder(db, id) {
  const { data: o } = await db.from('bot_orders').update({ status: 'annulled', decided_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'confirmed').select('*').maybeSingle()
  if (!o) return { done: false, msg: 'заказ не в статусе «подтверждён»' }
  const key = `bot:${o.id}`
  let numbers = []
  try { numbers = (await annulPromo(db, { paymentKey: key, reason: 'чек без поступления' })).numbers || [] } catch (e) { console.error('botPay annul promo:', e?.message) }
  // Клуб: снимаем срок этого заказа.
  if (o.user_id) {
    const { data: prof } = await db.from('profiles').select('plan_until').eq('id', o.user_id).maybeSingle()
    if (prof?.plan_until) {
      const until = new Date(new Date(prof.plan_until).getTime() - (PLAN_DAYS_BY_KEY[o.plan] || PLAN_DAYS_DEFAULT) * 864e5).toISOString()
      await db.from('profiles').update({ plan_until: until }).eq('id', o.user_id)
    }
  }
  await db.from('payments').update({ status: 'annulled' }).eq('provider_order_num', key)
  const annulTxt = '⚠️ Перевод по твоему чеку не поступил, поэтому доступ к клубу и номер участника аннулированы.'
  if (o.source === 'site') {
    if (o.email) await mailBuyer(o.email, 'ZM Club: оплата не поступила', [annulTxt, '', `Если это ошибка — напиши нам: ${SUPPORT_EMAIL} или в Telegram ${SUPPORT_TG}, приложи чек.`]).catch(() => {})
  } else {
    const b = await buyer(db, o.tg_user_id)
    await send(b?.chat_id || o.tg_user_id, `${annulTxt} Если это ошибка — пришли сюда чек ещё раз или напиши.`).catch(() => {})
  }
  return { done: true, numbers }
}

// ── Подтверждение владельцем ────────────────────────────────────────────────
async function findOrCreateTgUser(db, tgId, name) {
  const email = `tg${tgId}@telegram.fitpro` // тот же адрес, что даёт вход через Telegram на сайте
  const { data: found } = await db.rpc('auth_user_id_by_email', { em: email })
  if (found) return found
  const { data: created, error } = await db.auth.admin.createUser({
    email, email_confirm: true,
    password: crypto.randomBytes(24).toString('base64url'),
    user_metadata: { name: name || '', telegram_id: String(tgId), created_via: 'bot_pay' },
  })
  if (error) throw new Error(`createUser: ${error.message}`)
  return created.user.id
}

/** Аккаунт по почте (заказ с сайта): есть — платёж ему, нет — новый. */
async function findOrCreateEmailUser(db, email, name) {
  const { data: found } = await db.rpc('auth_user_id_by_email', { em: email })
  if (found) return { id: found, isNew: false }
  const { data: created, error } = await db.auth.admin.createUser({
    email, email_confirm: true,
    password: crypto.randomBytes(24).toString('base64url'),
    user_metadata: { name: name || '', created_via: 'site_transfer' },
  })
  if (error) throw new Error(`createUser: ${error.message}`)
  return { id: created.user.id, isNew: true }
}

const SUPPORT_EMAIL = 'maxim-46kursk@mail.ru'
const SUPPORT_TG = '@maxim_athlete'
const escH = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

/** Простое письмо покупателю в стиле писем акции. lines — строки текста. */
async function mailBuyer(to, subject, lines, button = null) {
  const text = [...lines, button ? `\n${button.text}: ${button.url}` : ''].join('\n')
  const html = `<!doctype html><html><body style="margin:0;background:#0b0b0d;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#fff">
<div style="max-width:520px;margin:0 auto;padding:28px 20px">
  <div style="font-size:22px;font-weight:900;color:#9d96ff;letter-spacing:.5px">ZM CLUB</div>
  <div style="font-size:15px;line-height:1.6;margin-top:18px;color:#e6e6ee">${lines.map(l => l ? escH(l) : '<br>').join('<br>')}</div>
  ${button ? `<a href="${escH(button.url)}" style="display:block;margin:24px 0;padding:17px;border-radius:999px;background:#7c7af0;color:#fff;text-align:center;font-size:16px;font-weight:900;text-decoration:none">${escH(button.text.toUpperCase())}</a>` : ''}
</div></body></html>`
  await sendMail({ to, subject, text, html })
}

async function inviteLink(db, userId, chatId) {
  if (!chatId) return null
  try {
    const { data: inv } = await db.from('club_chat_invites').select('invite_link').eq('user_id', userId).eq('chat_id', chatId)
      .is('used_at', null).gt('expires_at', new Date(Date.now() + 3600e3).toISOString()).limit(1).maybeSingle()
    if (inv) return inv.invite_link
    const expires = Math.floor(Date.now() / 1000) + LINK_TTL_S
    // Ссылку в группу выписывает бот клуба — он админ группы.
    const link = await tgCall('createChatInviteLink', { chat_id: chatId, name: `zm-${userId.slice(0, 8)}`, creates_join_request: true, expire_date: expires }, process.env.TELEGRAM_BOT_TOKEN)
    await db.from('club_chat_invites').insert({ invite_link: link.invite_link, user_id: userId, chat_id: chatId, expires_at: new Date(expires * 1000).toISOString() })
    return link.invite_link
  } catch (e) {
    console.error('botPay: ссылка в группу не выписалась:', e?.message)
    return null
  }
}

async function confirmOrder(db, id, { auto = false } = {}) {
  // Захват заказа: две быстрых ✅ не начислят дважды.
  const { data: o } = await db.from('bot_orders').update({ status: 'confirming' })
    .eq('id', id).eq('status', 'receipt').select('*').maybeSingle()
  if (!o) {
    const { data: cur } = await db.from('bot_orders').select('status, numbers').eq('id', id).maybeSingle()
    return { done: false, msg: cur ? `уже: ${cur.status}${cur.numbers?.length ? ' ' + cur.numbers.map(n => '№' + n).join(', ') : ''}` : 'заказ не найден' }
  }
  const key = `bot:${o.id}`
  try {
    const isSite = o.source === 'site'
    let userId = o.user_id, isNew = false
    if (!userId) {
      if (isSite) ({ id: userId, isNew } = await findOrCreateEmailUser(db, o.email, o.buyer_name))
      else userId = await findOrCreateTgUser(db, o.tg_user_id, String(o.tg_name || '').replace(/\s@.*$/, ''))
    }

    // Клуб: продлеваем от максимума (сейчас, текущий срок) — как вебхук Продамуса.
    let newUntil = null
    const { error: payErr } = await db.from('payments').insert({
      provider_order_num: key, order_id: key, user_id: userId, plan: o.plan, amount: o.amount,
      status: 'success', raw: { via: isSite ? 'site' : 'bot', tg_user_id: o.tg_user_id, email: o.email, order: o.id },
    })
    if (payErr && payErr.code !== '23505') throw new Error(`payments: ${payErr.message}`)
    const { data: prof } = await db.from('profiles').select('plan_until').eq('id', userId).maybeSingle()
    if (!payErr) {
      const cur = prof?.plan_until ? new Date(prof.plan_until).getTime() : 0
      const base = Math.max(Date.now(), Number.isFinite(cur) ? cur : 0)
      newUntil = new Date(base + (PLAN_DAYS_BY_KEY[o.plan] || PLAN_DAYS_DEFAULT) * 864e5).toISOString()
      const { error: updErr } = await db.from('profiles').update({ plan: o.plan, plan_until: newUntil }).eq('id', userId)
      if (updErr) throw new Error(`profiles: ${updErr.message}`)
    } else {
      newUntil = prof?.plan_until || null // повтор: клуб уже начислен
    }

    const b = isSite ? null : await buyer(db, o.tg_user_id)
    // Сайт: письмо с номером и кнопкой входа шлёт сама выдача номеров (почта из заказа).
    const numbers = await issuePromo(db, {
      paymentKey: key, userId, plan: o.plan, sum: o.amount, planUntil: newUntil,
      data: isSite ? { customer_email: o.email, customer_phone: o.phone, via: 'site' } : { customer_phone: b?.phone || null, via: 'bot' },
    }) || []

    await db.from('bot_orders').update({ status: 'confirmed', user_id: userId, numbers, auto, decided_at: new Date().toISOString(), ...(isNew ? { new_account: true } : {}) }).eq('id', o.id)
    if (isSite) {
      // Анкета заполнена вместе с чеком — переносим в анкету акции.
      const { error: aErr } = await db.from('promo_participants').upsert({
        user_id: userId, promo: PROMO_KEY, full_name: o.buyer_name, birth_date: o.birth_date, phone: o.phone,
        email: o.email, consent_at: o.consent_at || new Date().toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })
      if (aErr) console.error('botPay: анкета с сайта не перенесена:', aErr.message)
    } else {
      await syncAnketa(db, o.tg_user_id)
    }

    try {
      await db.from('app_events').insert({ user_id: userId, anon_id: null, session_id: key, name: 'pay_done', path: null, props: { plan: o.plan, via: isSite ? 'site' : 'bot' } })
    } catch { /* аналитика не важнее денег */ }

    if (isSite) {
      // После акции номеров нет — письмо о доступе шлём сами.
      if (!numbers.length && o.email) {
        const { data: pp } = await db.from('promo_participants').select('login_token').eq('user_id', userId).maybeSingle()
        await mailBuyer(o.email, 'ZM Club: оплата подтверждена', [
          'Привет! Оплата подтверждена, добро пожаловать в ZM Club.',
          newUntil ? `Доступ к клубу открыт до ${new Date(newUntil).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' })}.` : '',
        ], { text: 'Войти в клуб', url: pp?.login_token && isNew ? `${LOGIN_SITE}/?promo_login=${pp.login_token}` : LOGIN_SITE }).catch(e => console.error('botPay: письмо не ушло:', e?.message))
      }
      return { done: true, numbers }
    }

    // Покупателю: номер, группа, вход на сайт.
    const st = await paySettings(db)
    const link = await inviteLink(db, userId, st.chatId)
    const { data: pp } = await db.from('promo_participants').select('login_token').eq('user_id', userId).maybeSingle()
    const loginUrl = pp?.login_token ? `${LOGIN_SITE}/?promo_login=${pp.login_token}` : LOGIN_SITE
    const many = numbers.length > 1
    const untilTxt = newUntil ? new Date(newUntil).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' }) : null
    const fresh = await buyer(db, o.tg_user_id)
    const text = [
      '🎉 Оплата подтверждена — добро пожаловать в ZM Club!',
      '',
      numbers.length ? `🚗 ${many ? 'Твои номера участника' : 'Твой номер участника'}: ${numbers.map(n => '№' + n).join(', ')}` : null,
      numbers.length ? 'Итоги — 12 ноября в прямом эфире, ссылку пришлём в группу клуба.' : null,
      numbers.length ? '' : null,
      'Что дальше:',
      `1. ${link ? 'Вступи в группу клуба — кнопка ниже.' : 'Ссылку в группу клуба пришлю отдельно.'}`,
      '2. Открой клуб на сайте — кнопка ниже, вход без пароля (кнопка личная, не пересылай).',
      anketaDone(fresh) ? null : '3. Допиши анкету участника — без неё номер не участвует в акции.',
      untilTxt ? `\nДоступ к клубу открыт до ${untilTxt}.` : null,
      numbers.length ? 'Сохрани это сообщение 👌' : null,
    ].filter(v => v !== null).join('\n')
    const buttons = []
    if (link) buttons.push([{ text: '💬 Вступить в группу клуба', url: link }])
    buttons.push([{ text: '🏋️ Открыть клуб', url: loginUrl }])
    const chat = fresh?.chat_id || o.tg_user_id
    try { await send(chat, text, { reply_markup: { inline_keyboard: buttons } }) } catch (e) {
      await tellOwner(db, `⚠️ Заказ #${o.id} подтверждён, но бот не смог написать покупателю: ${e?.message}`)
    }
    if (!anketaDone(fresh)) await askNext(db, chat, o.tg_user_id).catch(() => {})
    return { done: true, numbers }
  } catch (e) {
    // Шаги повторяемы (журнал платежей и выдача номеров — по ключу заказа),
    // поэтому возвращаем заказ на проверку: владелец нажмёт ✅ ещё раз.
    await db.from('bot_orders').update({ status: 'receipt' }).eq('id', o.id)
    reportError('api:botpay:confirm', [`заказ #${o.id} не подтвердился:`, e], { message: `заказ #${o.id}: ${e?.message}`, status: 500 })
    return { done: false, msg: `ошибка: ${String(e?.message || e).slice(0, 150)} — нажми ✅ ещё раз` }
  }
}

async function rejectOrder(db, id) {
  const { data: o } = await db.from('bot_orders').update({ status: 'rejected', decided_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'receipt').select('*').maybeSingle()
  if (!o) return { done: false, msg: 'заказ уже обработан' }
  if (o.source === 'site') {
    if (o.email) await mailBuyer(o.email, 'ZM Club: перевод не найден', [
      `Мы не нашли перевод на ${rub(o.amount)} по присланному чеку.`,
      '',
      `Проверь сумму и реквизиты и отправь чек ещё раз на сайте — или напиши нам: ${SUPPORT_EMAIL}, Telegram ${SUPPORT_TG}.`,
    ], { text: 'Открыть сайт', url: CLUB_SITE }).catch(() => {})
    return { done: true }
  }
  const b = await buyer(db, o.tg_user_id)
  await send(b?.chat_id || o.tg_user_id, `😕 Не нашёл перевод по этому чеку (${rub(o.amount)}). Проверь сумму и реквизиты и пришли чек ещё раз — или напиши, если что-то не так.`).catch(() => {})
  return { done: true }
}

// ── Команды владельца ───────────────────────────────────────────────────────
async function ownerCommand(db, msg) {
  const raw = String(msg.text || '').trim()
  const cmd = raw.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '')
  const chatId = msg.chat.id
  if (cmd === '/реквизиты' || cmd === '/rekv') {
    const text = raw.replace(/^\S+\s*/, '').trim()
    if (!text) {
      const st = await paySettings(db)
      await send(chatId, st.requisites ? `Текущие реквизиты:\n\n${st.requisites}\n\nЗаменить: /реквизиты и новый текст.` : 'Напиши так:\n/реквизиты\nСБП по номеру +7 900 000-00-00\nБанк: Т-Банк\nПолучатель: Максим З.')
      return true
    }
    await db.from('club_settings').upsert({ id: 1, pay_requisites: text.slice(0, 1500), updated_at: new Date().toISOString() })
    await send(chatId, `✅ Реквизиты сохранены (по ним ИИ сверяет получателя в чеках):\n\n${text}\n\n⚠️ На странице оплаты сайта реквизиты прописаны в коде (src/PayTransfer.jsx) — если поменялся номер или банк, скажи разработчику.`)
    return true
  }
  const setMode = async (mode, txt) => {
    const st = await paySettings(db)
    if (mode !== 'prodamus' && !st.requisites) { await send(chatId, 'Сначала задай реквизиты: /реквизиты <текст>'); return true }
    await db.from('club_settings').upsert({ id: 1, pay_mode: mode, pay_via_bot: mode === 'bot', updated_at: new Date().toISOString() })
    await send(chatId, txt)
    return true
  }
  if (cmd === '/касса' || cmd === '/kassa') return setMode('prodamus', '✅ Кнопка «Вступить» снова ведёт в Продамус. Оплата переводом на сайте — /сайт')
  if (cmd === '/сайт' || cmd === '/site') return setMode('transfer', '✅ Оплата переводом на сайте: реквизиты → чек → твоё подтверждение. Вернуть Продамус — /касса')
  if (cmd === '/бот' || cmd === '/bot') return setMode('bot', '✅ Кнопка «Вступить» ведёт в Telegram-бота. Оплата на сайте — /сайт, Продамус — /касса')
  if (cmd === '/часы' || cmd === '/hours') {
    const arg = raw.replace(/^\S+\s*/, '').trim()
    if (!arg) {
      const st = await paySettings(db)
      await send(chatId, `Режим работы: с ${hh(st.hoursFrom)} до ${hh(st.hoursTo)} по Москве.\nИзменить: /часы 9-23`)
      return true
    }
    if (!/^\d{1,2}\s*-\s*\d{1,2}$/.test(arg) || parseHours(arg).join('-') !== arg.replace(/\s+/g, '').split('-').map(Number).join('-')) {
      await send(chatId, 'Напиши так: /часы 9-23 (с 9:00 до 23:00 по Москве)')
      return true
    }
    await db.from('club_settings').upsert({ id: 1, pay_hours: arg.replace(/\s+/g, ''), updated_at: new Date().toISOString() })
    const [a, b] = parseHours(arg)
    await send(chatId, `✅ Режим работы: с ${hh(a)} до ${hh(b)} по Москве. Вне этих часов бот пишет покупателю, что оплату подтвердят утром, а в ${hh(a)} пришлёт тебе все ночные чеки.`)
    return true
  }
  if (cmd === '/ночь' || cmd === '/night') {
    const arg = raw.replace(/^\S+\s*/, '').trim().toLowerCase()
    if (!arg) {
      const st = await paySettings(db)
      await send(chatId, st.night
        ? `🌙 Ночной автопилот: с ${hh(st.night[0])} до ${hh(st.night[1])} по Москве — чеки, где ИИ всё сходится, выдаются сразу.\nИзменить: /ночь 0-9 · выключить: /ночь выкл`
        : '🌙 Ночной автопилот выключен. Включить: /ночь 0-9')
      return true
    }
    if (['выкл', 'off', 'нет', '0'].includes(arg)) {
      await db.from('club_settings').upsert({ id: 1, pay_night: 'off', updated_at: new Date().toISOString() })
      await send(chatId, '🌙 Ночной автопилот выключен: ночью покупатель видит «подтвердим утром». Включить: /ночь 0-9')
      return true
    }
    const n = parseNight(arg)
    if (!n) { await send(chatId, 'Напиши так: /ночь 0-9 (с 00:00 до 09:00 по Москве) или /ночь выкл'); return true }
    await db.from('club_settings').upsert({ id: 1, pay_night: `${n[0]}-${n[1]}`, updated_at: new Date().toISOString() })
    await send(chatId, `🌙 Ночной автопилот: с ${hh(n[0])} до ${hh(n[1])} по Москве. Чеки, где ИИ всё сходится, выдаются сразу; сомнительные ждут тебя утром. Утром пришлю список выданных ночью — сверь с банком.`)
    return true
  }
  if (cmd === '/авто' || cmd === '/auto') {
    const st = await paySettings(db)
    await db.from('club_settings').upsert({ id: 1, pay_auto: !st.autoAlways, updated_at: new Date().toISOString() })
    await send(chatId, !st.autoAlways
      ? '⚡ Автовыдача ВКЛЮЧЕНА круглосуточно: чеки, где ИИ всё сходится, выдаются сразу; сомнительные — тебе. Выключить — /авто'
      : '✅ Круглосуточная автовыдача выключена: днём подтверждаешь сам, ночью — по /ночь. Включить — /авто')
    return true
  }
  if (cmd === '/заказы' || cmd === '/orders') {
    const { data } = await db.from('bot_orders').select('id, plan, amount, tg_name, receipt_at').eq('status', 'receipt').order('receipt_at').limit(30)
    await send(chatId, data?.length
      ? `Ждут проверки (${data.length}):\n` + data.map(o => `#${o.id} · ${rub(o.amount)} · ${o.tg_name || ''}`).join('\n') + '\n\nКнопки ✅/❌ — под чеками выше.'
      : 'Непроверенных чеков нет 👌')
    return true
  }
  return false
}

// ── Разбор обновлений бота (из api/club-chat.js) ────────────────────────────
/** true — обновление про оплату и разобрано здесь. */
export async function botPayUpdate(u, db) {
  const cq = u.callback_query
  if (cq) {
    const data = String(cq.data || '')
    const chatId = cq.message?.chat?.id
    const answer = text => tgCall('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text } : {}) }).catch(() => {})

    if (/^an:\d+$/.test(data)) {
      const owner = await ownerChatId(db)
      if (!owner || String(cq.from?.id) !== String(owner)) { await answer('Нет доступа'); return true }
      await answer('Секунду…')
      const r = await annulOrder(db, Number(data.slice(3)))
      const result = r.done ? `↩️ АННУЛИРОВАН${r.numbers.length ? ' → ' + r.numbers.map(n => '№' + n).join(', ') : ''} — покупателю написал` : `⚠️ ${r.msg}`
      await tgCall('editMessageCaption', {
        chat_id: chatId, message_id: cq.message.message_id, caption: `${cq.message?.caption || ''}\n\n${result}`.slice(0, 1024), reply_markup: { inline_keyboard: [] },
      }).catch(() => send(chatId, result).catch(() => {}))
      return true
    }
    if (/^(ok|no):\d+$/.test(data)) {
      const owner = await ownerChatId(db)
      if (!owner || String(cq.from?.id) !== String(owner)) { await answer('Нет доступа'); return true }
      await answer('Секунду…')
      const id = Number(data.split(':')[1])
      const r = data.startsWith('ok') ? await confirmOrder(db, id) : await rejectOrder(db, id)
      const result = data.startsWith('ok')
        ? (r.done ? `✅ ПОДТВЕРЖДЁН → ${r.numbers?.length ? r.numbers.map(n => '№' + n).join(', ') : 'клуб начислен'}` : `⚠️ ${r.msg}`)
        : (r.done ? '❌ Отклонён — покупателю написал' : `⚠️ ${r.msg}`)
      const cap = `${cq.message?.caption || ''}\n\n${result}`.slice(0, 1024)
      const keepButtons = !r.done && /нажми ✅/.test(r.msg || '')
      await tgCall('editMessageCaption', {
        chat_id: chatId, message_id: cq.message.message_id, caption: cap,
        ...(keepButtons ? { reply_markup: cq.message.reply_markup } : { reply_markup: { inline_keyboard: [] } }),
      }).catch(() => send(chatId, `Заказ #${id}: ${result}`).catch(() => {}))
      return true
    }
    if (data === 'pk:club' || data === 'pk:club4' || data === 'chg') {
      await answer()
      if (data === 'chg') { await send(chatId, 'Выбери пакет:', { reply_markup: pkgButtons() }); return true }
      const plan = data.slice(3)
      const seats = await seatsProblem(db, plan)
      if (seats) { await send(chatId, seats); return true }
      // Неоплаченный заказ — меняем пакет в нём же, а не плодим новые.
      const cur = await openOrder(db, cq.from.id)
      let order
      if (cur && cur.status !== 'receipt') {
        const { data: upd } = await db.from('bot_orders').update({ plan, amount: PLANS[plan].amount, status: 'new' }).eq('id', cur.id).select('*').single()
        order = upd
      } else {
        order = await newOrderFor(db, cq.from, plan)
      }
      await saveBuyer(db, cq.from.id, { chat_id: chatId })
      await sendPayInfo(db, chatId, order)
      return true
    }
    if (data === 'cs') {
      await answer('Спасибо!')
      await saveBuyer(db, cq.from.id, { consent_at: new Date().toISOString() })
      await askNext(db, chatId, cq.from.id)
      return true
    }
    return false
  }

  const msg = u.message
  if (!msg || msg.chat?.type !== 'private') return false
  const from = msg.from
  const text = String(msg.text || '').trim()

  const owner = await ownerChatId(db)
  if (owner && String(from?.id) === String(owner) && text.startsWith('/') && !/^\/start\b/i.test(text)) {
    if (await ownerCommand(db, msg)) return true
  }

  if (/^\/start\b/i.test(text)) { await onStart(db, msg); return true }
  if (msg.photo?.length || msg.document) { await onReceipt(db, msg); return true }

  const b = await buyer(db, from.id)
  if (msg.contact) {
    if (String(msg.contact.user_id) !== String(from.id)) { await send(msg.chat.id, 'Нужен именно твой номер — нажми кнопку «📱 Отправить мой номер».'); return true }
    const phone = String(msg.contact.phone_number || '').replace(/[^\d+]/g, '').slice(0, 20)
    await saveBuyer(db, from.id, { phone: phone.startsWith('+') ? phone : '+' + phone })
    await askNext(db, msg.chat.id, from.id)
    return true
  }
  if (b?.step === 'phone' && text) {
    const d = text.replace(/\D/g, '')
    if (d.length < 10 || d.length > 15) { await send(msg.chat.id, 'Проверь номер или нажми кнопку «📱 Отправить мой номер».'); return true }
    await saveBuyer(db, from.id, { phone: text.replace(/[^\d+]/g, '').slice(0, 20) })
    await askNext(db, msg.chat.id, from.id)
    return true
  }
  if (b?.step === 'name' && text) {
    const name = text.replace(/\s+/g, ' ').slice(0, 120)
    if (name.split(' ').length < 2 || /\d/.test(name)) { await send(msg.chat.id, 'Нужны фамилия и имя, например: Иванова Анна'); return true }
    await saveBuyer(db, from.id, { full_name: name })
    await askNext(db, msg.chat.id, from.id)
    return true
  }
  if (b?.step === 'birth' && text) {
    const r = parseBirth(text)
    if (r.err) { await send(msg.chat.id, r.err); return true }
    await saveBuyer(db, from.id, { birth_date: r.iso })
    await askNext(db, msg.chat.id, from.id)
    return true
  }
  if (b?.step === 'consent') { await askNext(db, msg.chat.id, from.id); return true }

  const open = await openOrder(db, from.id)
  if (open?.status === 'receipt') {
    await send(msg.chat.id, 'Чек на проверке — номер придёт сюда, как только оплата подтвердится 👌')
  } else if (open) {
    await send(msg.chat.id, 'Жду чек об оплате — пришли скриншот или PDF из банка 📎')
  } else {
    await send(msg.chat.id, 'Чтобы вступить в ZM Club и получить номер участника, выбери пакет:', { reply_markup: pkgButtons() })
  }
  return true
}

// ── Утро: все ночные чеки — менеджеру заново, с кнопками ────────────────────
//
// Вызывается из опроса бота (api/club-chat.js) каждую минуту; срабатывает раз
// в день, в первый час рабочего времени, если есть неподтверждённые чеки.
// Чеки пересылаются заново, чтобы не листать ночную переписку вверх.
export async function botPayTick(db) {
  try {
    const st = await paySettings(db)
    if (!st.viaBot || !workingNow(st) || mskNow().getUTCHours() !== st.hoursFrom) return
    const today = mskDate()
    if (st.remindedOn === today) return
    await db.from('club_settings').upsert({ id: 1, pay_reminded_on: today, updated_at: new Date().toISOString() })
    const owner = await ownerChatId(db)
    if (!owner) return
    // Выданные ночным автопилотом за последние 14 часов — списком, сверить с банком.
    const { data: autos } = await db.from('bot_orders').select('id, amount, tg_name, buyer_name, numbers, receipt_ai')
      .eq('status', 'confirmed').eq('auto', true).gte('decided_at', new Date(Date.now() - 14 * 3600e3).toISOString()).order('decided_at').limit(60)
    if (autos?.length) {
      const sum = autos.reduce((a, o) => a + (o.amount || 0), 0)
      await send(owner, [
        `🌙 Ночью автопилот выдал доступ: ${autos.length} (на ${rub(sum)}). Сверь с поступлениями в банке:`,
        ...autos.map(o => `#${o.id} · ${rub(o.amount)} · ${o.receipt_ai?.datetime?.slice(11, 16) || '?'} · ${o.buyer_name || o.tg_name || ''} → ${(o.numbers || []).map(n => '№' + n).join(', ')}`),
        '',
        'Если какого-то перевода нет — кнопка «↩️ Аннулировать» под его чеком выше, или /возврат №номер.',
      ].join('\n').slice(0, 4000))
    }
    const { data: list } = await db.from('bot_orders')
      .select('id, plan, amount, tg_name, tg_user_id, source, buyer_name, email, phone, receipt_file_id, receipt_type, receipt_check, receipt_ai').eq('status', 'receipt').order('receipt_at').limit(40)
    if (!list?.length) return
    await send(owner, `☀️ Доброе утро! Ждут твоего подтверждения: ${list.length}. Пересылаю — проверь поступления и подтверди.`)
    for (const o of list) {
      const ai = o.receipt_ai
      const caption = [
        `🧾 Заказ #${o.id} · ${PLANS[o.plan]?.title || o.plan} · ${rub(o.amount)}`,
        o.source === 'site' ? `🌐 Сайт: ${o.buyer_name || ''} · ${o.phone || ''} · ${o.email || ''}` : `От: ${o.tg_name || 'без имени'} (id ${o.tg_user_id})`,
        ai ? `🤖 ${ai.amount ?? '?'} ₽ · ${ai.datetime || '?'} · ${ai.recipient || '?'} · оп. ${ai.operation_id || '?'}` : null,
        o.receipt_check && o.receipt_check !== 'ok' ? `⚠️ ИИ: ${o.receipt_check}` : (o.receipt_check === 'ok' ? '🤖 ИИ: всё сходится' : null),
      ].filter(Boolean).join('\n')
      const kb = { inline_keyboard: [[
        { text: `✅ Подтвердить ${rub(o.amount)}`, callback_data: `ok:${o.id}` },
        { text: '❌ Нет оплаты', callback_data: `no:${o.id}` },
      ]] }
      try {
        const sent = await tgCall(o.receipt_type === 'photo' ? 'sendPhoto' : 'sendDocument', {
          chat_id: owner, [o.receipt_type === 'photo' ? 'photo' : 'document']: o.receipt_file_id, caption: caption.slice(0, 1024), reply_markup: kb,
        })
        await db.from('bot_orders').update({ owner_msg_id: sent.message_id }).eq('id', o.id)
      } catch (e) { console.error('botPay утро: чек не переслан:', e?.message) }
    }
  } catch (e) {
    console.error('botPayTick:', e?.message)
  }
}

// ── ОПЛАТА НА САЙТЕ (api/pay-transfer.js) ───────────────────────────────────
//
// Покупатель прикрепил чек и анкету на странице оплаты. Заказ сразу в статусе
// «чек на проверке», чек — владельцу в Telegram с кнопками ✅/❌ (дальше всё
// как у бота: confirmOrder/rejectOrder/annulOrder, утренняя пересылка). ИИ
// читает чек уже после ответа покупателю и дописывает подсказку в подпись.

export class PayError extends Error { constructor(status, msg) { super(msg); this.status = status } }

export async function siteSubmit(db, { plan, userId = null, email, phone, name, birth, file }) {
  if (!PLANS[plan]) throw new PayError(400, 'Неизвестный пакет')
  const st = await paySettings(db)
  if (!st.viaSite) throw new PayError(409, 'Оплата переводом сейчас недоступна — обнови страницу')
  const seats = await seatsProblem(db, plan)
  if (seats) throw new PayError(409, seats)

  const isPdf = file.mime === 'application/pdf'
  const isImg = /^image\/(jpeg|png|webp)$/.test(file.mime)
  const uniqueId = crypto.createHash('sha256').update(file.buf).digest('hex').slice(0, 40)
  const token = crypto.randomBytes(18).toString('base64url')
  const { data: o, error } = await db.from('bot_orders').insert({
    token, plan, amount: PLANS[plan].amount, user_id: userId, source: 'site',
    email, phone, buyer_name: name, birth_date: birth, consent_at: new Date().toISOString(),
    status: 'receipt', receipt_type: isImg ? 'photo' : 'document', receipt_unique_id: uniqueId, receipt_at: new Date().toISOString(),
  }).select('*').single()
  if (error) throw new Error(`bot_orders: ${error.message}`)

  // ── Чек владельцу (без него заказ не существует — при сбое просим повторить).
  const head = [
    `🌐 Сайт · Заказ #${o.id} · ${PLANS[plan].title} · ${rub(o.amount)}`,
    `${name} · ${phone}`,
    email,
  ]
  const kb = { inline_keyboard: [[
    { text: `✅ Подтвердить ${rub(o.amount)}`, callback_data: `ok:${o.id}` },
    { text: '❌ Нет оплаты', callback_data: `no:${o.id}` },
  ]] }
  let sent
  try {
    const owner = await ownerChatId(db)
    if (!owner) throw new Error('не найден Telegram-id владельца')
    const form = new FormData()
    form.append('chat_id', String(owner))
    form.append('caption', [...head, '', '🤖 ИИ читает чек…'].join('\n').slice(0, 1024))
    form.append('reply_markup', JSON.stringify(kb))
    const ext = isPdf ? 'pdf' : file.mime.split('/')[1] || 'bin'
    form.append(isImg ? 'photo' : 'document', new Blob([file.buf], { type: file.mime }), `check-${o.id}.${ext}`)
    const r = await egressFetch(`https://api.telegram.org/bot${payToken()}/${isImg ? 'sendPhoto' : 'sendDocument'}`, { method: 'POST', body: form })
    const j = await r.json().catch(() => null)
    if (!j?.ok) throw new Error(j?.description || `telegram ${r.status}`)
    sent = j.result
  } catch (e) {
    await db.from('bot_orders').update({ status: 'rejected', receipt_check: `чек не доставлен владельцу: ${String(e?.message).slice(0, 120)}` }).eq('id', o.id)
    reportError('api:botpay:site', ['чек с сайта не ушёл владельцу:', e], { message: `чек с сайта не ушёл: ${e?.message}`, status: 502 })
    throw new PayError(502, 'Не удалось отправить чек — попробуй ещё раз через минуту')
  }
  const fileId = isImg ? sent.photo?.[sent.photo.length - 1]?.file_id : sent.document?.file_id
  await db.from('bot_orders').update({ receipt_file_id: fileId || null, owner_msg_id: sent.message_id }).eq('id', o.id)

  // ── ИИ — после ответа покупателю.
  setTimeout(() => { siteAiCheck(db, o, file, { isPdf, isImg, uniqueId, head, kb, msgId: sent.message_id, chatId: sent.chat.id }).catch(e => console.error('botPay site ai:', e?.message)) }, 0)

  return { token, id: o.id, working: workingNow(st), hoursFrom: st.hoursFrom, hoursTo: st.hoursTo }
}

async function siteAiCheck(db, o, file, { isPdf, isImg, uniqueId, head, kb, msgId, chatId }) {
  const st = await paySettings(db)
  let ai = null, problem = null
  if (!isPdf && !isImg) problem = 'формат файла ИИ не читает — проверь глазами'
  else {
    try {
      ai = await readReceiptBuf({ buf: file.buf, isPdf, imgType: file.mime, requisites: st.requisites || '', expected: o.amount })
      problem = await autoProblem(db, o, ai, uniqueId)
    } catch (e) {
      problem = `ИИ не смог прочитать чек (${String(e?.message || e).slice(0, 80)})`
    }
  }
  await db.from('bot_orders').update({
    receipt_ai: ai, receipt_op_id: ai?.operation_id ? String(ai.operation_id).replace(/\s+/g, '').slice(0, 80) : null,
    receipt_check: problem ? problem.slice(0, 200) : 'ok',
  }).eq('id', o.id)
  const aiLine = ai ? `🤖 ${ai.amount ?? '?'} ₽ · ${ai.datetime || '?'} · ${ai.recipient || '?'} · оп. ${ai.operation_id || '?'}` : null
  const edit = (lines, markup) => tgCall('editMessageCaption', { chat_id: chatId, message_id: msgId, caption: lines.filter(Boolean).join('\n').slice(0, 1024), reply_markup: markup }).catch(() => {})

  if (!problem && st.auto) {
    const r = await confirmOrder(db, o.id, { auto: true })
    if (r.done) {
      await edit([...head, aiLine, '', `✅ АВТО: доступ выдан → ${r.numbers?.length ? r.numbers.map(n => '№' + n).join(', ') : 'клуб'}`, 'Если денег в банке нет — жми «Аннулировать».'],
        { inline_keyboard: [[{ text: '↩️ Аннулировать', callback_data: `an:${o.id}` }]] })
      return
    }
  }
  // Заказ могли уже подтвердить, пока ИИ читал, — тогда подпись не трогаем.
  const { data: cur } = await db.from('bot_orders').select('status').eq('id', o.id).maybeSingle()
  if (cur?.status !== 'receipt') return
  await edit([...head, aiLine, problem ? `⚠️ ИИ: ${problem}` : '🤖 ИИ: сумма, получатель и дата сходятся, чек новый', '', 'Проверь поступление в банке и нажми кнопку.'], kb)
}

/** Статус заказа с сайта — для страницы «Платёж принят». */
export async function siteStatus(db, token) {
  const { data: o } = await db.from('bot_orders').select('id, status, numbers, email, user_id, new_account, plan')
    .eq('token', token).eq('source', 'site').maybeSingle()
  if (!o) return null
  const status = o.status === 'confirming' ? 'receipt' : o.status
  let login = null
  // Ссылку входа отдаём только в новый аккаунт, заведённый этим заказом: иначе,
  // оплатив с чужой почтой, можно было бы войти в чужой аккаунт.
  if (status === 'confirmed' && o.new_account && o.user_id) {
    const { data: pp } = await db.from('promo_participants').select('login_token').eq('user_id', o.user_id).maybeSingle()
    login = pp?.login_token || null
  }
  const st = await paySettings(db)
  return { id: o.id, status, numbers: o.numbers || [], email: o.email, login, plan: o.plan, working: workingNow(st), hoursFrom: st.hoursFrom, hoursTo: st.hoursTo }
}
