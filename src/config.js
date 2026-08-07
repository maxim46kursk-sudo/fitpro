// Общие константы, которые должны совпадать в нескольких местах приложения —
// один источник правды вместо копирования строк по файлам.

// Telegram тренера Максима — тот же контакт для кнопки "Написать Максиму"
// (AIAssistant.jsx, маркер [CONTACT_MAX]), "Написать тренеру" в Настройках
// (App.jsx, SettingsView) и в модалке завершения программы.
export const MAX_TELEGRAM_URL = 'https://t.me/maxim_athlete'

// Бот, в котором живёт Mini App. Из него собирается ссылка-приглашение
// тренера: https://t.me/<BOT_USERNAME>?startapp=coach_<id тренера>. Параметр
// startapp прилетает в приложение как start_param (см. App.jsx,
// pendingInviteRef) и превращается в привязку через api/link-client.js.
export const BOT_USERNAME = 'maxim_fitpro_bot'

// Почта тренера для публичного контакта (блок «Связаться с тренером» в
// Настройках). Отдельно от Telegram намеренно: ссылка t.me работает и в вебе,
// но у пользователя может не быть Telegram вообще — тогда почта единственный
// способ достучаться.
export const MAX_EMAIL = 'maxim46kursk@gmail.com'

// ── Технические (синтетические) почты ────────────────────────────────────────
// В auth.users почта есть у ВСЕХ, но у двух категорий она поддельная и писем
// не принимает:
//   tg<id>@telegram.fitpro     — вход через Telegram (api/telegram-auth.js)
//   c<hex>@clients.fitproapp.ru — клиент, заведённый тренером (api/link-client.js)
// Показывать такую строку как «почта клиента» с mailto: нельзя — это обещание
// связи, которого нет: письмо просто уйдёт в никуда. Поэтому везде, где почта
// показывается КАК КОНТАКТ, она сначала проходит через realEmail().
export const TELEGRAM_EMAIL_DOMAIN = '@telegram.fitpro'
export const CLIENT_EMAIL_DOMAIN = '@clients.fitproapp.ru'

export const isSyntheticEmail = email => {
  const v = (email || '').toLowerCase()
  return v.endsWith(TELEGRAM_EMAIL_DOMAIN) || v.endsWith(CLIENT_EMAIL_DOMAIN)
}

// Почта, на которую реально можно написать, либо null. Единственный источник
// правды для всех mailto: в интерфейсе.
export const realEmail = email => {
  const v = (email || '').trim()
  return v && !isSyntheticEmail(v) ? v : null
}

// ── Куда реально уйдёт напоминание ───────────────────────────────────────────
// ЗЕРКАЛО extractChatId() из api/send-reminders.js — держать один в один.
// Расходиться им нельзя: если здесь сказать «придут в Telegram», а крон
// chat_id не найдёт, интерфейс соврёт ровно в том месте, где обещал не врать.
//
// Напоминания уходят ТОЛЬКО в Telegram — почтовой доставки в
// api/send-reminders.js нет вообще (там единственный вызов —
// api.telegram.org/sendMessage). Поэтому «канал» тут двоичный: либо Telegram,
// либо никуда.
export const telegramChatIdOf = authUser => {
  const fromMeta = authUser?.user_metadata?.telegram_id
  if (fromMeta != null && String(fromMeta).trim()) return String(fromMeta).trim()
  const m = (authUser?.email || '').match(/^tg(\d+)@telegram\.fitpro$/i)
  return m ? m[1] : null
}
