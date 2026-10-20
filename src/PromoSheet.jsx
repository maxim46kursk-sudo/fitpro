import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabase.js'
import { track } from './track.js'
import { BG, SURF, SURF2, HAIR, PUR, ACCENT2, TXT2, DANGER } from './theme.js'
import PromoInfo from './PromoInfo.jsx'

/**
 * АКЦИЯ «SKODA OCTAVIA»: номер участника и анкета (окт 2026).
 *
 * 1) Вход по кнопке из письма: ?promo_login=<ключ> → api/promo?action=login →
 *    verifyOtp. Дальше App сам подхватывает сессию (onAuthStateChange).
 * 2) Вошедшему с номером и НЕзаполненной анкетой — окно: «Твой номер №27» +
 *    ФИО, дата рождения, телефон (подставлен из кассы), согласие. После анкеты —
 *    кнопка в Telegram-группу клуба (личная ссылка, api/club-chat?action=link).
 * Заполненная анкета окно больше не открывает. Проверки (18+, телефон) — на
 * сервере, здесь только подсказки.
 */

async function authed(path, body) {
  const { data: { session } } = await supabase.auth.getSession()
  const t = session?.access_token
  if (!t) throw new Error('нет входа')
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify(body || {}),
  })
  const b = await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(b.error || `ошибка ${r.status}`); e.field = b.field; throw e }
  return b
}

const inp = { width: '100%', padding: '13px 14px', borderRadius: 12, border: `1px solid ${HAIR}`, background: SURF2, color: '#fff', fontSize: 16, outline: 'none', boxSizing: 'border-box' }
const lbl = { fontSize: 12.5, color: TXT2, margin: '12px 0 6px' }
const btn = { width: '100%', padding: 15, borderRadius: 999, border: 'none', background: `linear-gradient(180deg, ${ACCENT2}, ${PUR})`, color: '#fff', fontSize: 15.5, fontWeight: 900, cursor: 'pointer', textTransform: 'uppercase' }

export default function PromoSheet({ user, blocked }) {
  const [me, setMe] = useState(null)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ full_name: '', birth_date: '', phone: '', consent: false })
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [loginMsg, setLoginMsg] = useState(null)
  const [rules, setRules] = useState(false)
  const asked = useRef(false)

  // ── Вход по кнопке из письма.
  useEffect(() => {
    let tok = null
    try { tok = new URLSearchParams(window.location.search).get('promo_login') } catch { /* */ }
    if (!tok) return
    try { const u = new URL(window.location.href); u.searchParams.delete('promo_login'); window.history.replaceState(null, '', u.pathname + u.search + u.hash) } catch { /* */ }
    try { sessionStorage.setItem('fitpro_welcome_seen', '1') } catch { /* */ }
    ;(async () => {
      try {
        const r = await fetch('/api/promo?action=login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok }) })
        const b = await r.json().catch(() => ({}))
        if (!r.ok || !b.token_hash) { setLoginMsg(b.error || 'Не удалось войти по ссылке. Войди по своей почте.'); return }
        const { error } = await supabase.auth.verifyOtp({ token_hash: b.token_hash, type: 'magiclink' })
        if (error) throw error
        track('screen', { name: 'promo_mail_login' }, '/club')
        asked.current = false
        setOpen(true)
      } catch (e) {
        console.error('Вход по письму:', e)
        setLoginMsg('Не удалось войти по ссылке. Войди по своей почте.')
      }
    })()
  }, [])

  // ── Есть ли у вошедшего номер и заполнена ли анкета.
  useEffect(() => {
    if (!user || asked.current) return
    asked.current = true
    authed('/api/promo?action=me').then(b => {
      setMe(b)
      if (b.anketa) setForm(f => ({ ...f, full_name: b.anketa.full_name || '', birth_date: b.anketa.birth_date || '', phone: b.anketa.phone || '', consent: !!b.anketa.consent }))
      if (b.numbers?.length && !b.complete) setOpen(true)
    }).catch(() => { asked.current = false })
  }, [user])

  const save = async () => {
    setErr(null); setBusy(true)
    try {
      await authed('/api/promo?action=save', form)
      track('screen', { name: 'promo_anketa_done' }, '/club')
      setDone(true)
      setMe(m => ({ ...m, complete: true }))
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  const joinGroup = async () => {
    try {
      const b = await authed('/api/club-chat?action=link')
      if (b.url) {
        if (window.Telegram?.WebApp?.openTelegramLink && /t\.me/.test(b.url)) window.Telegram.WebApp.openTelegramLink(b.url)
        else window.open(b.url, '_blank', 'noopener')
      }
    } catch (e) { setErr(e.message) }
  }

  if (loginMsg && !user) {
    return (
      <div style={{ position: 'fixed', left: 16, right: 16, bottom: 20, zIndex: 3300, background: SURF, border: `1px solid ${HAIR}`, borderRadius: 14, padding: '14px 16px', color: '#fff', fontSize: 14, lineHeight: 1.45 }} onClick={() => setLoginMsg(null)}>
        {loginMsg}
      </div>
    )
  }
  if (!open || blocked || !user || !me?.numbers?.length) return null

  const nums = me.numbers.map(n => `№${n}`).join(', ')
  const many = me.numbers.length > 1

  if (rules) return <PromoInfo open initial="rules" onClose={() => setRules(false)} />
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3150, background: 'rgba(0,0,0,0.82)', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <div style={{ maxWidth: 440, margin: '0 auto', padding: '24px 16px 40px', color: '#fff', fontFamily: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif' }}>
        <div style={{ background: BG, border: `1px solid ${PUR}66`, borderRadius: 22, padding: '22px 18px' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 11.5, letterSpacing: 2, color: ACCENT2, fontWeight: 800 }}>{many ? 'ТВОИ НОМЕРА УЧАСТНИКА' : 'ТВОЙ НОМЕР УЧАСТНИКА'}{me.test ? ' · ТЕСТ' : ''}</div>
            <div style={{ fontSize: many ? 30 : 46, fontWeight: 900, marginTop: 4 }}>{nums}</div>
            <div style={{ fontSize: 13, color: TXT2, marginTop: 6 }}>Итоги — 12 ноября в прямом эфире</div>
          </div>

          {!done && !me.complete ? (
            <>
              <div style={{ marginTop: 20, padding: '12px 14px', borderRadius: 12, background: `${PUR}22`, fontSize: 13.5, lineHeight: 1.5 }}>
                Заполни анкету участника — <b>без неё номер не участвует в розыгрыше.</b> Если победишь, позвоним на этот телефон.
              </div>
              <div style={lbl}>Фамилия и имя</div>
              <input style={inp} value={form.full_name} placeholder="Иванов Иван" autoComplete="name"
                onChange={e => setForm({ ...form, full_name: e.target.value })} />
              <div style={lbl}>Дата рождения</div>
              <input style={inp} type="date" value={form.birth_date} max="2008-11-12"
                onChange={e => setForm({ ...form, birth_date: e.target.value })} />
              <div style={lbl}>Телефон для связи</div>
              <input style={inp} type="tel" value={form.phone} placeholder="+7 900 000-00-00" autoComplete="tel"
                onChange={e => setForm({ ...form, phone: e.target.value })} />
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 14, fontSize: 13, color: TXT2, lineHeight: 1.45, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.consent} onChange={e => setForm({ ...form, consent: e.target.checked })} style={{ marginTop: 3, width: 18, height: 18, flex: '0 0 auto' }} />
                <span>Мне есть 18 лет. Согласен с <a href="#" onClick={e => { e.preventDefault(); setRules(true) }} style={{ color: ACCENT2 }}>правилами акции</a> и на обработку моих данных для её проведения: на эфире объявят номер и имя с первой буквой фамилии, телефон не публикуется.</span>
              </label>
              {err && <div style={{ color: DANGER, fontSize: 13.5, marginTop: 12 }}>{err}</div>}
              <button style={{ ...btn, marginTop: 18, opacity: busy ? 0.7 : 1 }} disabled={busy} onClick={save}>{busy ? 'Сохраняем…' : 'Сохранить анкету'}</button>
              <button onClick={() => setOpen(false)} style={{ display: 'block', margin: '14px auto 0', background: 'none', border: 'none', color: TXT2, fontSize: 13, textDecoration: 'underline', cursor: 'pointer' }}>Заполню позже</button>
            </>
          ) : (
            <>
              <div style={{ marginTop: 20, padding: '14px', borderRadius: 12, background: '#30D15822', fontSize: 14, lineHeight: 1.5, textAlign: 'center' }}>
                ✅ Анкета заполнена — {many ? 'номера участвуют' : 'номер участвует'} в розыгрыше.
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.5, marginTop: 16, color: TXT2, textAlign: 'center' }}>Последний шаг — вступи в Telegram-группу клуба: там программы, рационы и ссылка на эфир.</div>
              {err && <div style={{ color: DANGER, fontSize: 13.5, marginTop: 12 }}>{err}</div>}
              <button style={{ ...btn, marginTop: 16 }} onClick={joinGroup}>Вступить в группу клуба</button>
              <button onClick={() => setOpen(false)} style={{ display: 'block', margin: '14px auto 0', background: 'none', border: 'none', color: TXT2, fontSize: 13, textDecoration: 'underline', cursor: 'pointer' }}>Перейти в клуб</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
