import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
// Журнал ошибок + мгновенное уведомление тренеру. Файл с подчёркиванием —
// не serverless-функция.
import { reportError } from './_logError.js'
// Выход наружу: на своём сервере адреса Telegram и Anthropic переписываются
// на мост (см. api/_egress.js), на Vercel остаются как есть — там оба API
// доступны напрямую. Файл с подчёркиванием — не serverless-функция.
import { egressFetch } from './_egress.js'

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
//
// ЭКСПОРТИРУЕТСЯ РАДИ ТЕСТА. У этой функции есть близнец на фронте —
// telegramChatIdOf() в src/config.js: он решает, писать ли в Настройках
// «Придут в Telegram» или «Чтобы получать напоминания, подключите Telegram».
// Разойдись они — интерфейс начнёт врать ровно в том месте, где обещает не
// врать. Совпадение проверяет test-telegram-auth.mjs.
export function extractChatId(user) {
  const fromMeta = user?.user_metadata?.telegram_id
  if (fromMeta != null && String(fromMeta).trim()) return String(fromMeta).trim()
  const email = user?.email || ''
  const m = email.match(/^tg(\d+)@telegram\.fitpro$/i)
  return m ? m[1] : null
}

// ── Сводка новых ошибок тренеру ──────────────────────────────────────────────
// Журнал error_log (src/logError.js) сам по себе никого не зовёт: чтобы увидеть
// сбой, тренер должен зайти в аналитику. Этот крон и так ходит каждые 15 минут,
// поэтому сводку вешаем сюда — новых serverless-функций не заводим (лимит
// Vercel в 12 штук исчерпан).
//
// Окно 16 минут при шаге крона в 15 — намеренный нахлёст: иначе запись,
// сделанная в стык между запусками, не попала бы ни в одну сводку. Обратная
// сторона нахлёста — пограничная ошибка может попасть в две соседние сводки.
// Дедуп через notification_log не подходит: там PRIMARY KEY с sent_date, то
// есть суточная гранулярность, а нам нужна четвертьчасовая.
const ERROR_WINDOW_MIN = 16
const ERROR_LIST_LIMIT = 20   // больше — не перечисляем, а зовём в аналитику
const ERROR_TOP_CONTEXTS = 3
// До скольких РАЗНЫХ пользователей называем поимённо. Смысл сводки — чтобы
// владелец мог сразу написать тому, у кого сломалось; когда людей много, список
// имён превращается в простыню и всё равно бесполезен — тогда только количества.
const ERROR_NAMES_MAX_USERS = 5

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Тот же порядок, что в resolveTrainerId (api/prodamus-webhook.js): сначала
// переменная окружения, иначе профиль с role='trainer'. Хелпер там не
// экспортирован, а импортировать сам вебхук нельзя — вместе с ним приедет его
// `export const config` (пофункциональная настройка Vercel). Функция крошечная,
// дублируем — как и остальные мелкие хелперы в api/.
async function resolveTrainerId(supabaseAdmin) {
  const fromEnv = (process.env.TRAINER_USER_ID || '').trim()
  if (fromEnv) {
    if (UUID_RE.test(fromEnv)) return fromEnv
    console.warn('send-reminders: TRAINER_USER_ID задан, но это не UUID — игнорируем')
  }
  const { data, error } = await supabaseAdmin
    .from('profiles').select('id').eq('role', 'trainer').limit(1).maybeSingle()
  if (error) {
    console.error('send-reminders: ошибка поиска тренера:', error)
    return null
  }
  return data?.id || null
}

const pluralErrors = n => {
  const m = Math.abs(n) % 100, d = m % 10
  if (m > 10 && m < 20) return 'ошибок'
  if (d > 1 && d < 5) return 'ошибки'
  if (d === 1) return 'ошибка'
  return 'ошибок'
}

// Возвращает число ошибок, о которых сообщили (0 — если сообщать было нечего
// или отправить не удалось). Наружу не бросает по своей воле: вызывающий код
// всё равно оборачивает вызов в try/catch, но и здесь все ветки закрыты.
async function alertTrainerAboutErrors(supabaseAdmin, botToken) {
  const since = new Date(Date.now() - ERROR_WINDOW_MIN * 60 * 1000).toISOString()

  // Один запрос закрывает обе задачи: count даёт ТОЧНОЕ число за окно, а data —
  // до 20 строк на разбивку. Если ошибок больше 20, разбивка и не нужна, и
  // усечённый список нас не смущает.
  const { data, count, error } = await supabaseAdmin
    .from('error_log')
    .select('context, user_id', { count: 'exact' })
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(ERROR_LIST_LIMIT)
  if (error) {
    console.error('send-reminders: ошибка чтения журнала ошибок:', error)
    return 0
  }

  const total = count ?? (data?.length || 0)
  if (!total) return 0   // тихо: молчание и есть «всё хорошо»

  const trainerId = await resolveTrainerId(supabaseAdmin)
  if (!trainerId) {
    console.warn('send-reminders: тренер не найден, сводка ошибок не отправлена')
    return 0
  }
  const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.getUserById(trainerId)
  if (userErr) {
    console.warn('send-reminders: не удалось прочитать auth-пользователя тренера:', userErr)
    return 0
  }
  const chatId = extractChatId(userData?.user)
  if (!chatId) {
    console.warn('send-reminders: у тренера нет chat_id, сводка ошибок не отправлена')
    return 0
  }

  // Что уходит в текст: количества, имена context и — когда людей мало — ИМЯ и
  // @ник тех, у кого сломалось. Имя с ником добавлены осознанно: без них сводка
  // сообщает о сбое, но не даёт с человеком связаться, а весь её смысл в этом.
  // Получатель один и тот же — сам владелец, себе же в личку.
  //
  // Чего в тексте по-прежнему НЕТ и быть не должно: message ошибки, user_id,
  // details и любые пользовательские данные (переписка, еда, замеры). Сообщение
  // уходит во внешний сервис, и объём того, что туда утекает, ограничиваем
  // ровно тем, без чего нельзя написать человеку.
  let text
  if (total > ERROR_LIST_LIMIT) {
    text = `⚠️ FitPro: более ${ERROR_LIST_LIMIT} ошибок за 15 минут (${total}), посмотри аналитику.`
  } else {
    const byContext = new Map()   // context → { n, users:Set<user_id> }
    for (const row of data || []) {
      const key = row?.context || 'unknown'
      const entry = byContext.get(key) || { n: 0, users: new Set() }
      entry.n++
      if (row?.user_id) entry.users.add(row.user_id)
      byContext.set(key, entry)
    }

    // Подписи людей тянем ОДНИМ запросом и только если разных пользователей
    // немного. Сбой чтения профилей не отменяет сводку — уходит без имён.
    const allUsers = new Set()
    for (const entry of byContext.values()) for (const id of entry.users) allUsers.add(id)
    const labels = new Map()   // user_id → «Имя @ник»
    if (allUsers.size && allUsers.size <= ERROR_NAMES_MAX_USERS) {
      const { data: profs, error: profErr } = await supabaseAdmin
        .from('profiles').select('id, name, tg_username').in('id', [...allUsers])
      if (profErr) {
        console.warn('send-reminders: не удалось прочитать профили для сводки ошибок:', profErr)
      } else {
        for (const p of profs || []) {
          const label = [p.name || null, p.tg_username ? `@${p.tg_username}` : null].filter(Boolean).join(' ')
          if (label) labels.set(p.id, label)
        }
      }
    }

    const top = [...byContext.entries()].sort((a, b) => b[1].n - a[1].n)
    const shown = top.slice(0, ERROR_TOP_CONTEXTS).map(([ctx, entry]) => {
      const who = [...entry.users].map(id => labels.get(id)).filter(Boolean)
      return who.length ? `${ctx} — ${entry.n} (${who.join(', ')})` : `${ctx} — ${entry.n}`
    }).join(', ')
    const rest = top.length - ERROR_TOP_CONTEXTS
    text = `⚠️ FitPro: ${total} ${pluralErrors(total)} за 15 минут\n${shown}${rest > 0 ? `, и ещё ${rest} вида` : ''}`
  }

  try {
    const tgRes = await egressFetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: { inline_keyboard: [[{ text: 'Открыть FitPro', url: BOT_URL }]] },
      }),
    })
    if (!tgRes.ok) {
      let desc = ''
      try { desc = (await tgRes.json())?.description || '' } catch {}
      console.error(`send-reminders: Telegram вернул ${tgRes.status} на сводку ошибок: ${desc}`)
      return 0
    }
  } catch (e) {
    console.error('send-reminders: сетевая ошибка отправки сводки ошибок:', e)
    return 0
  }

  return total
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
    reportError('api:send-reminders:config', ['send-reminders: не настроены TELEGRAM_BOT_TOKEN или SUPABASE_SERVICE_ROLE_KEY'], { message: 'не настроены TELEGRAM_BOT_TOKEN или SUPABASE_SERVICE_ROLE_KEY', status: 500 })
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
    reportError('api:send-reminders', ['send-reminders: ошибка чтения профилей:', profErr], { message: profErr?.message, status: 500 })
    return res.status(500).json({ error: 'Не удалось прочитать профили' })
  }

  let checked = 0
  let sent = 0
  // Сколько напоминаний оказалось некуда доставить (нет chat_id). Отдельно от
  // sent: раньше такие случаи были неотличимы от «не наступило время» и тихо
  // растворялись в разнице checked − sent.
  let undeliverable = 0

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
        // ОТСУТСТВИЕ КАНАЛА — НЕ СБОЙ, а устойчивое состояние аккаунта, и
        // dropClaim() тут был вреден: заявка снималась, следующий запуск крона
        // (через 15 минут) снова доходил до этого же пользователя, снова не
        // находил chat_id и снова её снимал — и так до конца суток, ~40 лишних
        // проходов с чтением auth.users на каждого такого человека. Повторять
        // нечего: chat_id не появится оттого, что мы спросим ещё раз.
        //
        // Заявку ОСТАВЛЯЕМ — она и есть отметка «за сегодня вопрос закрыт»:
        // PRIMARY KEY (user_id, type, sent_date) не пустит второй заход в этот
        // день, а завтра строка будет уже с новой датой, и попытка повторится
        // сама. Отдельной колонки-флага сознательно не заводим — поведение,
        // ради которого всё это делается, строка обеспечивает и так.
        //
        // sent НЕ увеличиваем: ничего не отправлено, и счётчик обязан это
        // показывать честно.
        console.warn(`send-reminders: нет chat_id — напоминание (${type}) недоставляемо, до завтра больше не пробуем`)
        undeliverable++
        continue
      }

      try {
        const tgRes = await egressFetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
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

  // Сводка ошибок — ПОСЛЕ напоминаний и полностью изолированно. Напоминания
  // важнее: что бы тут ни случилось (нет таблицы на стенде, отвалился Telegram,
  // сломался запрос), ручка обязана вернуть тот же ответ, что и раньше.
  // checked/sent не трогаем — на них могут смотреть глазами и в мониторинге.
  let errorsAlerted = 0
  try {
    errorsAlerted = await alertTrainerAboutErrors(supabaseAdmin, botToken)
  } catch (e) {
    console.error('send-reminders: сбой сводки ошибок (на напоминания не влияет):', e)
  }

  return res.status(200).json({ checked, sent, undeliverable, errorsAlerted })
}
