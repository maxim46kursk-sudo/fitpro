import crypto from 'node:crypto'
import { sendMail } from './_mail.js'
import { egressFetch } from './_egress.js'
import { ownerChatId } from './_logError.js'

/**
 * АКЦИЯ «SKODA OCTAVIA» (окт–нояб 2026): номера участников после оплаты.
 *
 * Вызывается из api/prodamus-webhook.js ПОСЛЕ того, как платёж записан в журнал
 * и клуб начислен. Что делает:
 *   1. выдаёт номера (база, функция promo_issue): 3000 ₽ → 1 номер,
 *      9000 ₽ (3+1) → 4 номера, служебный test50 → 1 тестовый номер с 9001;
 *   2. заводит/обновляет анкету участника: почта и телефон из кассы, личный
 *      ключ входа из письма (действует 14 дней);
 *   3. шлёт письмо с номером и кнопкой «Войти в клуб»;
 *   4. пишет владельцу в Telegram.
 * Сбой писем или Telegram номера не отменяет: номер выдан, письмо можно
 * отправить повторно (promo_participants.mail_error).
 */

export const PROMO_KEY = 'octavia-2026-11'
// Приём участников — до конца 10 ноября по Москве.
export const PROMO_ENDS_MS = Date.parse('2026-11-11T00:00:00+03:00')
export const CLUB_SITE = 'https://zmclubonline.ru'
// Ссылка входа в письме — на сайт клуба: человек платил на zmclubonline.ru и
// должен туда же и вернуться (окт 2026, решение владельца). Отправитель пока
// noreply@fitproapp.ru — когда переедет на адрес в zmclubonline.ru, домены
// ссылки и отправителя совпадут.
export const LOGIN_SITE = 'https://zmclubonline.ru'
const LOGIN_TTL_MS = 14 * 24 * 3600 * 1000
// Мест в акции — 600 номеров. Выдали 600-й — приём закрыт (create-payment
// больше не выписывает ссылки на клуб до конца акции). Тестовые номера (9001+)
// не считаются.
export const PROMO_CAP = 600

/** Акция ещё принимает участников (по дате). */
export const promoActive = () => Date.now() < PROMO_ENDS_MS

/** Сколько номеров ещё можно выдать. Ошибка базы → бросает. */
export async function promoLeft(db) {
  const { count, error } = await db.from('promo_tickets')
    .select('number', { count: 'exact', head: true }).eq('promo', PROMO_KEY).eq('is_test', false)
  if (error) throw new Error(`promoLeft: ${error.message}`)
  return Math.max(0, PROMO_CAP - (count || 0))
}

export function ticketCount(plan, sum) {
  if (plan === 'club' && sum === 3000) return 1
  if (plan === 'club4' && sum === 9000) return 4
  if (plan === 'test50' && sum === 50) return 1
  return 0
}

const normEmail = e => {
  const s = String(e || '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null
  if (s.endsWith('@guest.fitproapp.ru')) return null
  return s
}
const normPhone = p => {
  const d = String(p || '').replace(/[^\d+]/g, '')
  return d.replace(/\D/g, '').length >= 10 ? d.slice(0, 20) : null
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

export function promoMail({ numbers, loginUrl, until, isTest }) {
  const many = numbers.length > 1
  const list = numbers.map(n => `№${n}`).join(', ')
  const subject = `ZM Club: ${many ? 'твои номера участника' : 'твой номер участника'} ${list}${isTest ? ' (тест)' : ''}`
  const untilTxt = until ? new Date(until).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' }) : null
  const text = [
    'Привет! Оплата прошла, добро пожаловать в ZM Club.',
    '',
    `${many ? 'Твои номера участника' : 'Твой номер участника'}: ${list}`,
    'Итоги — 12 ноября в прямом эфире. Ссылку на эфир пришлём заранее.',
    '',
    'Что сделать сейчас:',
    `1. Войти в клуб (вход в один клик, без пароля): ${loginUrl}`,
    '2. Заполнить анкету участника: ФИО, дата рождения, телефон. Без анкеты номер не участвует в акции.',
    '3. Вступить в Telegram-группу клуба — кнопка будет сразу после анкеты.',
    '',
    untilTxt ? `Доступ к клубу открыт до ${untilTxt}.` : '',
    'Если победишь — позвоним на телефон из анкеты.',
  ].filter(l => l !== null).join('\n')
  const html = `<!doctype html><html><body style="margin:0;background:#0b0b0d;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#ffffff">
<div style="max-width:520px;margin:0 auto;padding:28px 20px">
  <div style="font-size:22px;font-weight:900;color:#9d96ff;letter-spacing:.5px">ZM CLUB</div>
  <div style="font-size:16px;margin-top:18px;line-height:1.5">Привет! Оплата прошла, добро пожаловать в клуб.</div>
  <div style="margin:22px 0;padding:20px;border-radius:18px;background:#1c1c1e;border:1px solid #7c7af055;text-align:center">
    <div style="font-size:12px;letter-spacing:2px;color:#9d96ff;font-weight:800">${many ? 'ТВОИ НОМЕРА УЧАСТНИКА' : 'ТВОЙ НОМЕР УЧАСТНИКА'}</div>
    <div style="font-size:${many ? 30 : 44}px;font-weight:900;margin-top:6px">${esc(list)}</div>
    <div style="font-size:13px;color:#b9b9c4;margin-top:8px">Итоги — 12 ноября в прямом эфире</div>
  </div>
  <div style="font-size:16px;font-weight:800;margin-bottom:10px">Что сделать сейчас — 3 шага:</div>
  <div style="font-size:15px;line-height:1.6;color:#e6e6ee">
    1. Войти в клуб — в один клик, без пароля.<br>
    2. Заполнить анкету участника: ФИО, дата рождения, телефон. <b>Без анкеты номер не участвует в акции.</b><br>
    3. Вступить в Telegram-группу клуба — кнопка будет сразу после анкеты.
  </div>
  <a href="${esc(loginUrl)}" style="display:block;margin:24px 0;padding:17px;border-radius:999px;background:#7c7af0;color:#ffffff;text-align:center;font-size:16px;font-weight:900;text-decoration:none">ВОЙТИ В КЛУБ</a>
  ${untilTxt ? `<div style="font-size:13px;color:#b9b9c4">Доступ к клубу открыт до ${esc(untilTxt)}.</div>` : ''}
  <div style="font-size:13px;color:#b9b9c4;margin-top:6px">Если победишь — позвоним на телефон из анкеты.</div>
  <div style="font-size:12px;color:#77777f;margin-top:28px">Кнопка входа личная, не пересылай это письмо. Если кнопка не работает, открой ${esc(CLUB_SITE)} и войди по этой почте.</div>
</div></body></html>`
  return { subject, text, html }
}

async function tellOwner(db, text) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) return
    const chatId = await ownerChatId(db)
    if (!chatId) return
    await egressFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
  } catch { /* уведомление владельцу не должно ничего ломать */ }
}

/**
 * Выдать номера по оплате. Возвращает массив номеров или null (не акционный
 * платёж). Бросает только если НЕ удалось выдать номера — это вызывающий
 * обязан громко зарепортить.
 */
export async function issuePromo(db, { paymentKey, userId, plan, sum, data = {}, planUntil = null }) {
  const count = ticketCount(plan, sum)
  if (!count || !userId || !paymentKey) return null
  if (Date.now() >= PROMO_ENDS_MS && plan !== 'test50') return null
  const isTest = plan === 'test50'

  const { data: numbers, error } = await db.rpc('promo_issue', {
    p_key: paymentKey, p_count: count, p_user: userId, p_amount: sum, p_test: isTest,
  })
  if (error || !Array.isArray(numbers) || !numbers.length) {
    throw new Error(`promo_issue: ${error?.message || 'пустой ответ'}`)
  }

  // ── Анкета и ключ входа. Ошибки дальше номера не отменяют.
  // Две почты: та, что ввели в кассе, и та, на которую заведён аккаунт. Они
  // могут различаться (вошёл в приложение под одной, в кассе ввёл другую) —
  // тогда письмо уходит на ОБЕ: номер принадлежит аккаунту, а кнопка входа из
  // любого письма открывает именно его.
  const checkoutEmail = normEmail(data.customer_email)
  let accountEmail = null
  try {
    const { data: u } = await db.auth.admin.getUserById(userId)
    accountEmail = normEmail(u?.user?.email)
  } catch { /* без почты аккаунта — шлём на почту из кассы */ }
  const email = checkoutEmail || accountEmail
  const phone = normPhone(data.customer_phone)
  const { data: prev } = await db.from('promo_participants')
    .select('email, phone, login_token, login_token_exp').eq('user_id', userId).maybeSingle()
  const tokenAlive = prev?.login_token && prev.login_token_exp && new Date(prev.login_token_exp).getTime() > Date.now() + 3 * 24 * 3600 * 1000
  const loginToken = tokenAlive ? prev.login_token : crypto.randomBytes(24).toString('base64url')
  const row = {
    user_id: userId,
    promo: PROMO_KEY,
    email: prev?.email || email,
    phone: prev?.phone || phone,
    login_token: loginToken,
    login_token_exp: new Date(Date.now() + LOGIN_TTL_MS).toISOString(),
    updated_at: new Date().toISOString(),
  }
  const { error: upErr } = await db.from('promo_participants').upsert(row, { onConflict: 'user_id' })
  if (upErr) console.error('promo: анкета не записана:', upErr)

  // ── Письмо: на почту из кассы, на почту аккаунта и на сохранённую ранее
  // (без повторов). Хоть одно ушло — считаем отправленным.
  const recipients = [...new Set([checkoutEmail, accountEmail, row.email].filter(Boolean))]
  const to = recipients[0] || null
  if (recipients.length && !upErr) {
    const mail = promoMail({ numbers, loginUrl: `${LOGIN_SITE}/?promo_login=${loginToken}`, until: planUntil, isTest })
    let sent = 0, lastErr = null
    for (const addr of recipients) {
      try { await sendMail({ to: addr, ...mail }); sent++ } catch (e) { lastErr = e; console.error(`promo: письмо на ${addr} не ушло:`, e?.message) }
    }
    if (sent) {
      await db.from('promo_participants').update({ mail_sent_at: new Date().toISOString(), mail_error: null }).eq('user_id', userId)
    } else {
      await db.from('promo_participants').update({ mail_error: String(lastErr?.message || lastErr).slice(0, 300) }).eq('user_id', userId)
      await tellOwner(db, `⚠️ Акция: письмо участнику ${numbers.map(n => '№' + n).join(', ')} НЕ ушло: ${String(lastErr?.message || lastErr).slice(0, 120)}`)
    }
  }

  // Перебор лимита возможен только если кассу открыли до 600-го номера, а
  // оплатили после. Номер выдан (человек заплатил), решение — за владельцем.
  if (!isTest && Math.max(...numbers) > PROMO_CAP) {
    await tellOwner(db, `⚠️ Акция: выдан номер сверх лимита ${PROMO_CAP}: ${numbers.map(n => '№' + n).join(', ')}. Реши — оставить или вернуть оплату.`)
  }
  await tellOwner(db, `🚗 Акция${isTest ? ' [ТЕСТ]' : ''}: оплата ${sum} ₽ → ${numbers.map(n => '№' + n).join(', ')}${to ? '' : ' (почты нет — письмо не отправлено)'}`)
  return numbers
}

/**
 * НОМЕР В TELEGRAM (окт 2026). Вызывается из api/club-chat.js, когда участник
 * по своей личной ссылке подаёт заявку в группу клуба — ДО одобрения заявки:
 * Telegram разрешает боту написать человеку в личку, пока его заявка не
 * разобрана (user_chat_id), даже если тот ни разу не нажимал Start.
 *
 *   send(chatId, text) — отправка сообщения ботом группы.
 * Ничего не бросает: номер и вход в группу важнее уведомлений.
 */
export async function promoTelegramHello(db, { userId, userChatId, from, send }) {
  try {
    const { data: t } = await db.from('promo_tickets')
      .select('number, is_test').eq('user_id', userId).eq('promo', PROMO_KEY).order('number')
    if (!t?.length) return
    const nums = t.map(x => '№' + x.number).join(', ')
    const many = t.length > 1
    if (userChatId) {
      await send(userChatId, [
        `🚗 ZM Club: ${many ? 'твои номера участника' : 'твой номер участника'} — ${nums}`,
        '',
        'Итоги акции — 12 ноября в прямом эфире. Ссылку на эфир пришлём в группу клуба.',
        'Если победишь — позвоним на телефон из анкеты и напишем сюда.',
        '',
        'Сохрани это сообщение 👌',
      ].join('\n')).catch(() => {})
    }
    const { data: p } = await db.from('promo_participants').select('full_name').eq('user_id', userId).maybeSingle()
    const parts = String(p?.full_name || '').trim().split(/\s+/)
    // В анкете «Фамилия Имя …»: показываем «Имя Ф.».
    const who = parts.length >= 2 ? `${parts[1]} ${parts[0][0]}.` : (parts[0] || 'без анкеты')
    const tgName = from?.username ? '@' + from.username : [from?.first_name, from?.last_name].filter(Boolean).join(' ') || `id ${from?.id}`
    await tellOwner(db, `✅ ${nums} — ${who}, ${tgName}: вступил в группу, номер получил в Telegram`)
  } catch (e) {
    console.error('promo: приветствие в Telegram не ушло:', e?.message)
  }
}
