// ОПЛАЧЕННЫЙ БИЛЕТ ЧЕЛЛЕНДЖА — СРАЗУ В TELEGRAM ВЛАДЕЛЬЦУ.
//
// ЗАЧЕМ. Продажа — это событие, а не строка отчётности. До сих пор о ней можно
// было узнать только из сводки motion-health, то есть в лучшем случае на
// следующий день: поток набирается днями, а решения по нему (докрутить рекламу,
// написать человеку, остановить продажи) принимаются в тот же час. Тревоги о
// поломках сюда уже ходят (_logError.js) — канал есть, и он тот же.
//
// ЧТО В СООБЩЕНИИ: номер участника, сумма и источник. Ни имени, ни почты, ни
// телефона: ограничение то же, что у журнала ошибок, и по той же причине —
// сообщение уходит во внешний сервис. Номер участника личностью не является, а
// сопоставить его с человеком владелец может у себя в базе.
//
// ИСТОЧНИК БЕРЁТСЯ ИЗ ВОРОНКИ. Касса меток не возвращает и вернуть не может —
// она про них не знает. Зато их знает наш же create-payment: открывая кассу, он
// пишет ступень `pay-start` вместе с `s`/`m`, снятыми в браузере
// (api/_challengeLog.js). Здесь эта строка и читается обратно. Не нашлась —
// «прямой», ровно как на клиенте: отсутствие метки это тоже ответ.
//
// НИЧЕГО НЕ ЛОМАЕТ. Билет к этому моменту уже оплачен и зачислен. Любой сбой —
// нет токена, нет чата, Telegram не ответил — глотается молча: не сообщить о
// продаже плохо, а сорвать из-за этого ответ кассе несравнимо хуже, потому что
// Продамус начнёт слать повторы.
//
// Имя файла с подчёркиванием — Vercel не делает из таких файлов эндпоинты.

import { egressFetch } from './_egress.js'
import { ownerChatId } from './_logError.js'

/**
 * Откуда пришёл человек, оплативший билет.
 *
 * Ищется ПОСЛЕДНЯЯ его ступень «касса открыта»: у одного человека их может быть
 * несколько (передумал, вернулся), и метка последней — та, по которой он в
 * итоге дошёл до оплаты. Строки этой ступени лежат в motion_log под своей
 * сессией `srv-pay-start-…`, поэтому выборка узкая и в неё не попадает журнал
 * тренировок того же человека.
 */
async function источник(db, userId) {
  if (!userId) return 'прямой'
  try {
    const { data } = await db
      .from('motion_log')
      .select('payload')
      .eq('user_id', userId)
      .like('session', 'srv-pay-start-%')
      .order('at', { ascending: false })
      .limit(1)
    for (const line of data?.[0]?.payload?.lines ?? []) {
      if (!String(line).includes('[challenge.pay-start]')) continue
      const д = JSON.parse(String(line).slice(String(line).indexOf('{')))
      const s = д?.s ? String(д.s).slice(0, 40) : null
      const m = д?.m ? String(д.m).slice(0, 40) : null
      if (s && m) return `${s}/${m}`
      if (s || m) return s || m
    }
  } catch {
    // Метку не достали — сообщение уходит без неё, оно и без метки нужное.
  }
  return 'прямой'
}

/**
 * Сообщить владельцу об оплаченном билете. Не бросает никогда.
 *
 * @param {object} db      клиент Supabase со служебным ключом
 * @param {object} что
 * @param {number|string} что.поток  номер потока — без него номер участника не читается
 * @param {number|string} что.номер  номер участника в потоке
 * @param {number} [что.сумма]       оплачено, рублей
 * @param {string} [что.userId]      кто оплатил; в сообщение НЕ идёт, нужен для метки
 * @returns {Promise<boolean>} ушло ли сообщение
 */
export async function сообщитьОбОплате(db, { поток, номер, сумма, userId } = {}) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN
    if (!botToken) return false
    const chatId = await ownerChatId(db)
    if (!chatId) return false

    const откуда = await источник(db, userId)
    const деньги = Number.isFinite(Number(сумма)) ? `${Number(сумма)} ₽` : 'сумма неизвестна'
    const text = `💰 Челлендж: поток ${поток}, участник №${номер}, ${деньги}, источник: ${откуда}`

    const res = await egressFetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
    return !!res?.ok
  } catch {
    return false
  }
}
