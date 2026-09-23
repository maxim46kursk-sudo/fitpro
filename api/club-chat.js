import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { egressFetch } from './_egress.js'
import { effectiveLevel } from './_access.js'
import { ownerChatId, reportError } from './_logError.js'
import { rateLimit } from './_ratelimit.js'

// ── ЧАТ КЛУБА ZMCLUB (сент 2026) ────────────────────────────────────────────
//
// Отдельная Телеграм-группа клуба. Пускает и убирает людей бот @maxim_fitpro_bot
// (TELEGRAM_BOT_TOKEN) — руками тренер никого не добавляет и не удаляет.
//
// Три действия в одной ручке:
//
//   POST ?action=link   (из приложения, Bearer-токен)
//     Участник жмёт «Чат». Уже в группе — отдаём ссылку на саму группу.
//     Нет — бот выписывает ЛИЧНУЮ ссылку-заявку (creates_join_request) и
//     запоминает, чья она. Ссылка сама по себе никого не пускает: по ней
//     приходит заявка, и решает её бот.
//
//   POST ?action=hook&key=…   (вебхук бота)
//     • бота сделали админом группы, и сделал это ВЛАДЕЛЕЦ (его Telegram-id
//       совпал с ownerChatId) — группа запоминается как чат клуба, владельцу
//       приходит подтверждение. Настраивать id руками не нужно.
//     • заявка на вступление: ссылка наша, её хозяин сейчас в клубе и ссылкой
//       ещё не пользовались — одобряем, запоминаем Telegram-id, ссылку гасим.
//       Иначе — отклоняем. Переслать ссылку другу бессмысленно: сработает
//       один раз.
//
//   GET|POST ?action=sync&secret=…   (крон, раз в час)
//     Всех, у кого доступ к клубу кончился, убираем из группы (бан + сразу
//     разбан: это «удалить», а не «забанить навсегда» — оплатит снова и
//     вернётся по новой ссылке). Тренера не трогаем никогда.
//
// Таблицы — sql/2026-09-23_club_chat.sql. Доступ к ним только со служебным
// ключом: RLS включён, политик нет.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
const CLUB_MIN_LEVEL = 1          // тот же порог, что у программ (SLOTS_MIN_LEVEL)
const LINK_TTL_S = 7 * 24 * 3600  // личная ссылка живёт неделю

function secretOk(given, expected) {
  if (!expected || typeof given !== 'string' || !given) return false
  const a = Buffer.from(given), b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

async function tg(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не настроен')
  const r = await egressFetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => null)
  if (!j?.ok) throw new Error(`${method}: ${j?.description || r.status}`)
  return j.result
}

async function clubChat(db) {
  const { data } = await db.from('club_settings').select('chat_id, chat_title').eq('id', 1).maybeSingle()
  return data?.chat_id ? data : null
}

// Ссылка «открыть группу» для того, кто уже в ней: t.me/c/<id без -100>.
const openUrl = chatId => `https://t.me/c/${String(chatId).replace(/^-100/, '')}/1`

async function hasAccess(db, userId) {
  const { data: p } = await db.from('profiles')
    .select('role, plan, plan_until, trial_until').eq('id', userId).maybeSingle()
  if (!p) return false
  return effectiveLevel(p) >= CLUB_MIN_LEVEL
}

// ── POST ?action=link ───────────────────────────────────────────────────────
async function handleLink(req, res, db) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!rateLimit(req, res, { name: 'club-chat-ip', limit: 60 })) return
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' })
  const { data: a, error: aErr } = await db.auth.getUser(token)
  if (aErr || !a?.user?.id) return res.status(401).json({ error: 'Требуется авторизация' })
  const userId = a.user.id
  if (!rateLimit(req, res, { name: 'club-chat', limit: 10, subject: userId })) return

  if (!(await hasAccess(db, userId))) {
    return res.status(403).json({ error: 'Чат доступен участникам клуба', reason: 'no_access' })
  }
  const chat = await clubChat(db)
  if (!chat) return res.status(409).json({ error: 'Чат клуба скоро откроется', reason: 'no_chat' })

  const { data: member } = await db.from('club_chat_members')
    .select('tg_user_id').eq('user_id', userId).is('removed_at', null).maybeSingle()
  if (member) return res.status(200).json({ url: openUrl(chat.chat_id), member: true })

  // Непросроченная неиспользованная ссылка уже есть — отдаём её же, чтобы не
  // плодить ссылки на каждое нажатие.
  const { data: inv } = await db.from('club_chat_invites')
    .select('invite_link, expires_at').eq('user_id', userId).eq('chat_id', chat.chat_id)
    .is('used_at', null).gt('expires_at', new Date(Date.now() + 3600e3).toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (inv) return res.status(200).json({ url: inv.invite_link })

  try {
    const expires = Math.floor(Date.now() / 1000) + LINK_TTL_S
    const link = await tg('createChatInviteLink', {
      chat_id: chat.chat_id,
      name: `zm-${userId.slice(0, 8)}`,
      creates_join_request: true,
      expire_date: expires,
    })
    const { error } = await db.from('club_chat_invites').insert({
      invite_link: link.invite_link, user_id: userId, chat_id: chat.chat_id,
      expires_at: new Date(expires * 1000).toISOString(),
    })
    if (error) throw new Error(`club_chat_invites: ${error.message}`)
    return res.status(200).json({ url: link.invite_link })
  } catch (e) {
    reportError('api:club-chat:link', ['ссылка в чат клуба не выписалась:', e], { message: e?.message, status: 500, userId })
    return res.status(500).json({ error: 'Не удалось открыть чат, попробуй ещё раз' })
  }
}

// ── POST ?action=hook ───────────────────────────────────────────────────────
async function handleHook(req, res, db) {
  if (!secretOk(req.query?.key, process.env.TG_WEBHOOK_KEY)) return res.status(404).end()
  if (req.method !== 'POST') return res.status(404).end()
  return clubUpdate(req.body || {}, res, db)
}

/**
 * Разбор одного обновления бота. Экспортирован: если у бота уже есть вебхук
 * на /api/tg/<key> (api/set-exercise.js), тот передаёт сюда обновления про
 * группы, и второй вебхук не нужен.
 */
export async function clubUpdate(u, res, db) {
  if (!db) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!key) return res.status(200).end()
    db = createClient(SUPABASE_URL, key)
  }
  try {
    await processUpdate(u, db)
  } catch (e) {
    reportError('api:club-chat:hook', ['вебхук чата клуба:', e], { message: e?.message, status: 500 })
  }
  return res.status(200).end()
}

async function processUpdate(u, db) {
  {
    // 1. Бота сделали админом группы — если это сделал владелец, это чат клуба.
    const mcm = u.my_chat_member
    if (mcm && ['group', 'supergroup'].includes(mcm.chat?.type)) {
      const становитсяАдмином = mcm.new_chat_member?.status === 'administrator'
      const owner = await ownerChatId(db)
      // В журнал сервера — на случай, если Telegram-id владельца не найден и
      // группу придётся прописать руками (club_settings).
      console.log(`club-chat: статус бота в «${mcm.chat.title}» (${mcm.chat.id}) → ${mcm.new_chat_member?.status}, изменил ${mcm.from?.id}, владелец ${owner}`)
      if (становитсяАдмином && owner && String(mcm.from?.id) === String(owner)) {
        const rights = mcm.new_chat_member
        await db.from('club_settings').upsert({
          id: 1, chat_id: mcm.chat.id, chat_title: mcm.chat.title || null, updated_at: new Date().toISOString(),
        })
        const нехватает = [
          !rights.can_invite_users && 'приглашать пользователей',
          !rights.can_restrict_members && 'блокировать пользователей',
        ].filter(Boolean)
        await tg('sendMessage', {
          chat_id: owner,
          text: нехватает.length
            ? `⚠ Группа «${mcm.chat.title}» подключена как чат ZMClub, но боту не хватает прав: ${нехватает.join(', ')}. Включи их в настройках админа.`
            : `✅ Группа «${mcm.chat.title}» подключена как чат ZMClub. Бот сам впускает оплативших и убирает тех, у кого закончился доступ.`,
        }).catch(() => {})
      }
      return
    }

    // 3. Сообщение в группе клуба: команда «сюда отчёты» или ответ тренера на отчёт.
    const msg = u.message
    if (msg && msg.chat && ['group', 'supergroup'].includes(msg.chat.type)) {
      await handleGroupMessage(msg, db)
      return
    }

    // 2. Заявка на вступление.
    const jr = u.chat_join_request
    if (jr) {
      const chat = await clubChat(db)
      if (!chat || String(jr.chat?.id) !== String(chat.chat_id)) return
      const link = jr.invite_link?.invite_link
      const tgId = jr.from?.id
      let ok = false, inv = null
      if (link) {
        const { data } = await db.from('club_chat_invites')
          .select('invite_link, user_id, used_at, expires_at').eq('invite_link', link).maybeSingle()
        inv = data
        ok = !!inv && !inv.used_at && new Date(inv.expires_at).getTime() > Date.now() && await hasAccess(db, inv.user_id)
      }
      if (!ok) {
        await tg('declineChatJoinRequest', { chat_id: chat.chat_id, user_id: tgId }).catch(() => {})
        return
      }
      await tg('approveChatJoinRequest', { chat_id: chat.chat_id, user_id: tgId })
      await db.from('club_chat_invites').update({ used_at: new Date().toISOString(), tg_user_id: tgId }).eq('invite_link', link)
      await db.from('club_chat_members').upsert({
        user_id: inv.user_id, tg_user_id: tgId, chat_id: chat.chat_id, joined_at: new Date().toISOString(), removed_at: null,
      })
      await tg('revokeChatInviteLink', { chat_id: chat.chat_id, invite_link: link }).catch(() => {})
      return
    }
    return
  }
}

// ── Сообщения в группе ──────────────────────────────────────────────────────
//
// Бот в группе с режимом приватности видит только команды и ответы на свои
// сообщения — ровно то, что здесь нужно.
//   • /reports (или /отчеты) от владельца в какой-то теме — отчёты будут
//     публиковаться в эту тему;
//   • ответ владельца на пост-отчёт бота — запоминаем ответ и сообщаем
//     участнику: личкой от бота, а если личка закрыта (человек не нажимал
//     Start у бота) — упоминанием в группе. В приложении ответ виден всегда.
async function handleGroupMessage(msg, db) {
  const chat = await clubChat(db)
  if (!chat || String(msg.chat.id) !== String(chat.chat_id)) return
  const owner = await ownerChatId(db)
  if (!owner || String(msg.from?.id) !== String(owner)) return

  const cmd = String(msg.text || '').trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, '')
  if (cmd === '/reports' || cmd === '/отчеты' || cmd === '/отчёты') {
    const thread = msg.is_topic_message ? msg.message_thread_id : null
    await db.from('club_settings').upsert({ id: 1, reports_thread_id: thread, updated_at: new Date().toISOString() })
    await tg('sendMessage', {
      chat_id: chat.chat_id, ...(thread ? { message_thread_id: thread } : {}),
      text: '✅ Сюда будут приходить видео-отчёты участников. Отвечай на них ответом (reply) — участник получит уведомление.',
    }).catch(() => {})
    return
  }

  const replyTo = msg.reply_to_message?.message_id
  if (!replyTo) return
  const { data: rep } = await db.from('club_reports')
    .select('id, user_id, exercise, answered_at').eq('chat_id', chat.chat_id).eq('tg_message_id', replyTo).maybeSingle()
  if (!rep) return

  const text = msg.text || msg.caption
    || (msg.voice ? '🎤 Голосовой ответ — послушай в чате клуба'
      : msg.video_note ? '🎥 Видео-ответ — посмотри в чате клуба'
        : msg.video ? '🎥 Видео-ответ — посмотри в чате клуба'
          : msg.photo ? '🖼 Ответ с фото — посмотри в чате клуба' : 'Ответ в чате клуба')
  // Несколько ответов подряд — склеиваем, чтобы в приложении было всё.
  const { data: prev } = await db.from('club_reports').select('reply_text').eq('id', rep.id).maybeSingle()
  const joined = prev?.reply_text ? `${prev.reply_text}\n\n${text}` : text
  await db.from('club_reports').update({ answered_at: new Date().toISOString(), reply_text: joined.slice(0, 4000), seen_at: null }).eq('id', rep.id)

  const { data: m } = await db.from('club_chat_members').select('tg_user_id').eq('user_id', rep.user_id).is('removed_at', null).maybeSingle()
  if (!m?.tg_user_id) return
  const link = `https://t.me/c/${String(chat.chat_id).replace(/^-100/, '')}/${msg.message_id}`
  try {
    await tg('sendMessage', {
      chat_id: m.tg_user_id,
      text: `💬 Максим ответил на твой отчёт «${rep.exercise}»:\n\n${String(text).slice(0, 3000)}`,
      reply_markup: { inline_keyboard: [[{ text: 'Открыть в чате клуба', url: link }]] },
    })
  } catch {
    // Личка закрыта — зовём упоминанием прямо под ответом тренера.
    await tg('sendMessage', {
      chat_id: chat.chat_id, reply_to_message_id: msg.message_id, parse_mode: 'HTML',
      text: `<a href="tg://user?id=${m.tg_user_id}">👆 тренер ответил на твой отчёт</a>`,
    }).catch(() => {})
  }
}

// ── POST ?action=report ─────────────────────────────────────────────────────
//
// Видео уже лежит в хранилище (бакет club-reports, папка = id человека) —
// приложение залило его само, с полосой загрузки. Здесь забираем файл и
// публикуем в группе клуба, в теме «Отчёты», подписью: кто, упражнение,
// подход, вопрос. После отправки файл из хранилища удаляем — видео живёт в
// Телеграме.
const esc = t => String(t ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))

async function handleReport(req, res, db) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!rateLimit(req, res, { name: 'club-report-ip', limit: 60 })) return
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' })
  const { data: a, error: aErr } = await db.auth.getUser(token)
  if (aErr || !a?.user?.id) return res.status(401).json({ error: 'Требуется авторизация' })
  const user = a.user
  if (!rateLimit(req, res, { name: 'club-report', limit: 20, subject: user.id })) return
  if (!(await hasAccess(db, user.id))) return res.status(403).json({ error: 'Отчёты доступны участникам клуба' })

  const b = req.body || {}
  const path = String(b.path || '')
  // Только свой файл: путь обязан начинаться с id человека (так же стережёт
  // политика хранилища на загрузке).
  if (!path.startsWith(`${user.id}/`) || path.includes('..')) return res.status(400).json({ error: 'Неверный файл' })
  const chat = await clubChat(db)
  if (!chat) return res.status(409).json({ error: 'Чат клуба ещё не подключён' })
  const { data: st } = await db.from('club_settings').select('reports_thread_id').eq('id', 1).maybeSingle()

  const { data: blob, error: dlErr } = await db.storage.from('club-reports').download(path)
  if (dlErr || !blob) return res.status(404).json({ error: 'Видео не найдено, загрузи ещё раз' })

  const { data: prof } = await db.from('profiles').select('name').eq('id', user.id).maybeSingle()
  const { data: mem } = await db.from('club_chat_members').select('tg_user_id').eq('user_id', user.id).is('removed_at', null).maybeSingle()
  const name = esc(prof?.name || user.user_metadata?.name || 'Участник')
  const who = mem?.tg_user_id ? `<a href="tg://user?id=${mem.tg_user_id}">${name}</a>` : `<b>${name}</b>`
  const exercise = String(b.exercise || 'Упражнение').slice(0, 80)
  const caption = [
    `📹 Отчёт: ${who}`,
    `🏋️ <b>${esc(exercise)}</b>${b.setInfo ? ` — ${esc(String(b.setInfo).slice(0, 60))}` : ''}`,
    b.program ? `Тренировка: ${esc(String(b.program).slice(0, 60))}` : null,
    b.note ? `💬 ${esc(String(b.note).slice(0, 300))}` : null,
    '',
    '<i>Ответь на это сообщение (reply) — участник получит уведомление.</i>',
  ].filter(v => v !== null).join('\n').slice(0, 1024)

  let sent = null, lastErr = null
  for (let attempt = 0; attempt < 2 && !sent; attempt++) {
    try {
      const form = new FormData()
      form.append('chat_id', String(chat.chat_id))
      if (st?.reports_thread_id) form.append('message_thread_id', String(st.reports_thread_id))
      form.append('caption', caption)
      form.append('parse_mode', 'HTML')
      form.append('supports_streaming', 'true')
      form.append('video', blob, path.split('/').pop())
      const r = await egressFetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendVideo`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(30000),
      })
      const j = await r.json().catch(() => null)
      if (!j?.ok) throw new Error(j?.description || `telegram ${r.status}`)
      sent = j.result
    } catch (e) { lastErr = e }
  }
  if (!sent) {
    reportError('api:club-chat:report', ['отчёт не ушёл в Телеграм:', lastErr], { message: lastErr?.message, status: 502, userId: user.id })
    return res.status(502).json({ error: 'Телеграм не ответил, попробуй ещё раз' })
  }

  await db.from('club_reports').insert({
    user_id: user.id, chat_id: chat.chat_id, tg_message_id: sent.message_id,
    exercise, set_info: b.setInfo ? String(b.setInfo).slice(0, 60) : null, note: b.note ? String(b.note).slice(0, 300) : null,
  })
  await db.storage.from('club-reports').remove([path]).catch(() => {})
  return res.status(200).json({ ok: true, tgLinked: !!mem?.tg_user_id })
}

// ── ?action=poll ────────────────────────────────────────────────────────────
//
// ПОЧЕМУ ОПРОС, А НЕ ВЕБХУК. Вебхук требует, чтобы Telegram сам достучался до
// сервера, а входящие соединения с адресов Telegram до нашего сервера в России
// не доходят (сент 2026: last_error_message «Connection timed out», в журнале
// Caddy ни одного запроса от 149.154.*/91.108.*). Исходящие запросы к Telegram
// при этом работают. Поэтому крон раз в минуту сам забирает обновления
// (getUpdates) — у бота при этом вебхука быть НЕ должно (иначе 409).
// Смещение хранится в club_settings.tg_offset, чтобы ничего не обработать дважды.
async function handlePoll(req, res, db) {
  const given = (req.query?.secret || req.headers['x-cron-secret'] || '').toString()
  if (!secretOk(given, process.env.REMINDERS_CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' })
  const { data: st } = await db.from('club_settings').select('tg_offset').eq('id', 1).maybeSingle()
  let offset = st?.tg_offset ?? 0
  let updates
  try {
    updates = await tg('getUpdates', { offset, timeout: 0, limit: 100, allowed_updates: ['my_chat_member', 'chat_join_request', 'message'] })
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message })
  }
  let handled = 0
  for (const u of updates || []) {
    try { await processUpdate(u, db); handled++ } catch (e) {
      reportError('api:club-chat:poll', ['обновление бота не обработалось:', e], { message: e?.message, status: 500 })
    }
    offset = u.update_id + 1
    await db.from('club_settings').upsert({ id: 1, tg_offset: offset, updated_at: new Date().toISOString() })
  }
  return res.status(200).json({ ok: true, got: updates?.length || 0, handled })
}

// ── ?action=sync ────────────────────────────────────────────────────────────
async function handleSync(req, res, db) {
  const given = (req.query?.secret || req.headers['x-cron-secret'] || '').toString()
  if (!secretOk(given, process.env.REMINDERS_CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' })
  const chat = await clubChat(db)
  if (!chat) return res.status(200).json({ ok: true, skipped: 'no_chat' })

  const { data: members, error } = await db.from('club_chat_members')
    .select('user_id, tg_user_id').eq('chat_id', chat.chat_id).is('removed_at', null)
  if (error) return res.status(500).json({ error: error.message })

  let removed = 0
  for (const m of members || []) {
    if (await hasAccess(db, m.user_id)) continue
    try {
      await tg('banChatMember', { chat_id: chat.chat_id, user_id: m.tg_user_id, until_date: Math.floor(Date.now() / 1000) + 60 })
      await tg('unbanChatMember', { chat_id: chat.chat_id, user_id: m.tg_user_id, only_if_banned: true })
      await db.from('club_chat_members').update({ removed_at: new Date().toISOString() }).eq('user_id', m.user_id)
      removed++
    } catch (e) {
      reportError('api:club-chat:sync', ['не удалось убрать из чата клуба:', e], { message: e?.message, status: 500, userId: m.user_id })
    }
  }
  return res.status(200).json({ ok: true, checked: members?.length || 0, removed })
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-cron-secret')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) return res.status(500).json({ error: 'Сервер не настроен' })
  const db = createClient(SUPABASE_URL, serviceRoleKey)

  const action = req.query?.action
  if (action === 'link') return handleLink(req, res, db)
  if (action === 'hook') return handleHook(req, res, db)
  if (action === 'sync') return handleSync(req, res, db)
  if (action === 'poll') return handlePoll(req, res, db)
  if (action === 'report') return handleReport(req, res, db)
  return res.status(404).json({ error: 'Not Found' })
}
