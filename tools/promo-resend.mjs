// Повторная отправка писем участникам акции, у которых письмо не ушло
// (promo_participants.mail_sent_at пуст). Запуск на сервере из папки проекта
// с переменными окружения сервиса fitpro-app:
//   set -a; . <EnvironmentFile fitpro-app>; set +a; /opt/node22/bin/node tools/promo-resend.mjs
import { createClient } from '@supabase/supabase-js'
import { promoMail, LOGIN_SITE, PROMO_KEY } from '../api/_promo.js'
import { sendMail } from '../api/_mail.js'

const db = createClient(process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru', process.env.SUPABASE_SERVICE_ROLE_KEY)
const { data: rows, error } = await db.from('promo_participants')
  .select('user_id, email, login_token').eq('promo', PROMO_KEY).is('mail_sent_at', null)
if (error) { console.error(error); process.exit(1) }
let ok = 0, bad = 0
for (const r of rows || []) {
  if (!r.email || !r.login_token) continue
  const { data: t } = await db.from('promo_tickets').select('number, is_test').eq('user_id', r.user_id).is('annulled_at', null).order('number')
  if (!t?.length) continue
  const { data: p } = await db.from('profiles').select('plan_until').eq('id', r.user_id).maybeSingle()
  try {
    await sendMail({ to: r.email, ...promoMail({ numbers: t.map(x => x.number), loginUrl: `${LOGIN_SITE}/?promo_login=${r.login_token}`, until: p?.plan_until, isTest: t.some(x => x.is_test) }) })
    await db.from('promo_participants').update({ mail_sent_at: new Date().toISOString(), mail_error: null }).eq('user_id', r.user_id)
    ok++
  } catch (e) {
    await db.from('promo_participants').update({ mail_error: String(e?.message || e).slice(0, 300) }).eq('user_id', r.user_id)
    console.error('не ушло:', e?.message); bad++
  }
}
console.log(`отправлено: ${ok}, ошибок: ${bad}`)
