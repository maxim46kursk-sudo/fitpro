import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

// Отправка напоминаний от бота по расписанию. Дёргается кроном, поэтому
// защищено секретом (cron знает REMINDERS_CRON_SECRET). Идемпотентность в
// пределах суток держит notification_log: PRIMARY KEY (user_id, type,
// sent_date) не даёт отправить одно и то же напоминание дважды за день, даже
// если крон сработает несколько раз.
//
// Тот же env и тот же безопасный fallback для URL (несекретен), что и у
// остальных функций api/.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'

// Ссылка на бота — та же, что в приглашении и возврате после оплаты
// (см. src/config.js BOT_USERNAME).
const BOT_URL = 'https://t.me/maxim_fitpro_bot'

// Шлём только напоминания о тренировке и дневнике питания.
const REMINDER_TYPES = ['workout', 'diary']
const TEXTS = {
  workout: '💪 Пора на тренировку! Открывай FitPro и погнали.',
  diary: '🍎 Не забудь заполнить дневник питания за сегодня.',
}

// 'HH:MM' → минуты от полуночи; null если формат не такой.
function parseHHMM(str) {
  if (typeof str !== 'string') return null
  const m = str.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1]), min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

// chat_id из auth-пользователя: сперва user_metadata.telegram_id, иначе
// разбираем из технического email вида tg<цифры>@telegram.fitpro, которым
// заводится телеграм-аккаунт (api/telegram-auth.js). null — не нашли.
function extractChatId(user) {
  const fromMeta = user?.user_metadata?.telegram_id
  if (fromMeta != null && String(fromMeta).trim()) return String(fromMeta).trim()
  const email = user?.email || ''
  const m = email.match(/^tg(\d+)@telegram\.fitpro$/i)
  return m ? m[1] : null
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Секрет — из query (?secret=) или заголовка x-cron-secret. Если переменная
  // не задана, валидировать нечем — закрываемся (fail closed), а не пускаем.
  const cronSecret = process.env.REMINDERS_CRON_SECRET
  const provided = (req.query?.secret || req.headers['x-cron-secret'] || '').toString()
  // Constant-time сравнение: пустой/короткий/несовпадающий по длине — сразу отказ
  // (timingSafeEqual бросает на разной длине), иначе побайтно.
  const okSecret = !!cronSecret && !!provided && provided.length === cronSecret.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(cronSecret))
  if (!okSecret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!botToken || !serviceRoleKey) {
    console.error('send-reminders: не настроены TELEGRAM_BOT_TOKEN или SUPABASE_SERVICE_ROLE_KEY')
    return res.status(500).json({ error: 'Сервер не настроен' })
  }
  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey)

  // Время по МСК (UTC+3, без переходов на летнее время). Сдвигаем UTC на 3 часа
  // и дальше читаем getUTC* у сдвинутой даты — так расписание клиента ('HH:MM'
  // по Москве) сравнивается с московским «сейчас».
  const msk = new Date(Date.now() + 3 * 60 * 60 * 1000)
  const minutesNow = msk.getUTCHours() * 60 + msk.getUTCMinutes()
  const dayNow = msk.getUTCDay() // 0=Вс..6=Сб
  const pad = n => String(n).padStart(2, '0')
  const todayStr = `${msk.getUTCFullYear()}-${pad(msk.getUTCMonth() + 1)}-${pad(msk.getUTCDate())}`

  const { data: profiles, error: profErr } = await supabaseAdmin
    .from('profiles').select('id, notifs').not('notifs', 'is', null)
  if (profErr) {
    console.error('send-reminders: ошибка чтения профилей:', profErr)
    return res.status(500).json({ error: 'Не удалось прочитать профили' })
  }

  let checked = 0
  let sent = 0

  for (const profile of profiles || []) {
    for (const type of REMINDER_TYPES) {
      const cfg = profile.notifs?.[type]
      if (!cfg?.enabled) continue
      if (!Array.isArray(cfg.days) || !cfg.days.includes(dayNow)) continue
      const schedMin = parseHHMM(cfg.time)
      if (schedMin == null) continue
      // Ещё не наступило запланированное время — придёт на более позднем
      // запуске крона в тот же день.
      if (minutesNow < schedMin) continue

      checked++

      // Заявка на отправку = дедуп. Кладём строку ДО отправки: если она уже
      // есть (23505), напоминание сегодня уже ушло — пропускаем.
      const { error: insErr } = await supabaseAdmin
        .from('notification_log')
        .insert({ user_id: profile.id, type, sent_date: todayStr })
      if (insErr) {
        if (insErr.code !== '23505') {
          console.error(`send-reminders: ошибка записи журнала (${type}):`, insErr)
        }
        continue
      }

      // Строка заявки уже есть — при любом сбое ниже её надо снять, чтобы
      // следующий запуск крона повторил попытку.
      const dropClaim = async () => {
        const { error } = await supabaseAdmin
          .from('notification_log')
          .delete()
          .match({ user_id: profile.id, type, sent_date: todayStr })
        if (error) console.error(`send-reminders: не удалось снять заявку (${type}):`, error)
      }

      const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.getUserById(profile.id)
      if (userErr) {
        console.error(`send-reminders: ошибка чтения auth-пользователя (${type}):`, userErr)
        await dropClaim()
        continue
      }
      const chatId = extractChatId(userData?.user)
      if (!chatId) {
        console.warn(`send-reminders: нет chat_id, пропуск (${type})`)
        await dropClaim()
        continue
      }

      try {
        const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: TEXTS[type],
            reply_markup: { inline_keyboard: [[{ text: 'Открыть FitPro', url: BOT_URL }]] },
          }),
        })
        if (!tgRes.ok) {
          // Тело ответа Telegram может содержать причину — печатаем статус и
          // описание, без персональных данных.
          let desc = ''
          try { desc = (await tgRes.json())?.description || '' } catch {}
          console.error(`send-reminders: Telegram вернул ${tgRes.status} (${type}): ${desc}`)
          await dropClaim()
          continue
        }
      } catch (e) {
        console.error(`send-reminders: сетевая ошибка отправки (${type}):`, e)
        await dropClaim()
        continue
      }

      sent++
    }
  }

  return res.status(200).json({ checked, sent })
}
