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
      return res.status(200).end()
    }

    // 2. Заявка на вступление.
    const jr = u.chat_join_request
    if (jr) {
      const chat = await clubChat(db)
      if (!chat || String(jr.chat?.id) !== String(chat.chat_id)) return res.status(200).end()
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
        return res.status(200).end()
      }
      await tg('approveChatJoinRequest', { chat_id: chat.chat_id, user_id: tgId })
      await db.from('club_chat_invites').update({ used_at: new Date().toISOString(), tg_user_id: tgId }).eq('invite_link', link)
      await db.from('club_chat_members').upsert({
        user_id: inv.user_id, tg_user_id: tgId, chat_id: chat.chat_id, joined_at: new Date().toISOString(), removed_at: null,
      })
      await tg('revokeChatInviteLink', { chat_id: chat.chat_id, invite_link: link }).catch(() => {})
      return res.status(200).end()
    }
    return res.status(200).end()
  } catch (e) {
    reportError('api:club-chat:hook', ['вебхук чата клуба:', e], { message: e?.message, status: 500 })
    return res.status(200).end()
  }
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
  return res.status(404).json({ error: 'Not Found' })
}
