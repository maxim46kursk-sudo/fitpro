import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabase.js'
import { track, flush } from './track.js'
import PromoInfo from './PromoInfo.jsx'
import { BG, SURF, SURF2, HAIR, PUR, ACCENT2, DANGER, TEA } from './theme.js'

/**
 * ОПЛАТА ПЕРЕВОДОМ НА САЙТЕ (окт 2026). Покупатель не уходит с сайта:
 *   1. Реквизиты — сумма, СБП по номеру, банк, получатель, кнопки «скопировать».
 *   2. Чек и анкета — скриншот/PDF чека, ФИО, дата рождения, телефон, почта, согласие.
 *   3. «Платёж принят» — днём «проверим за 30 минут», ночью «выдадим утром».
 *      Страница сама опрашивает статус: подтвердили — номера и «Войти в клуб».
 * Сервер — api/pay-transfer.js; чек уходит владельцу в Telegram с кнопками ✅/❌.
 *
 * РЕКВИЗИТЫ ЗАШИТЫ ЗДЕСЬ (REQ). Если поменялся номер/банк — править тут и
 * командой /реквизиты боту (по тексту в базе ИИ сверяет получателя в чеках).
 */

const REQ = {
  phone: '+7 960 677-00-09',
  phoneCopy: '+79606770009',
  bank: 'Т-Банк',
  name: 'Максим Игоревич Завалишин',
  role: 'самозанятый',
  abroadTg: 'maxim_athlete',
  email: 'maxim-46kursk@mail.ru',
}
const PKGS = {
  club: { title: '1 месяц клуба', price: 3000, note: '1 номер участника' },
  club4: { title: '3+1 · 4 месяца клуба', price: 9000, note: '4 номера участника' },
}
const ORDER_KEY = 'zm_transfer_order'
const MAX_IMG_SIDE = 1800
const MAX_PDF = 6.5 * 1024 * 1024

const rub = n => n.toLocaleString('ru-RU').replace(/ /g, ' ') + ' ₽'
const hh = h => `${String((h ?? 0) % 24).padStart(2, '0')}:00`
const T2 = 'rgba(255,255,255,0.72)'
const T3 = 'rgba(255,255,255,0.45)'

export function savedOrder() {
  try { const o = JSON.parse(localStorage.getItem(ORDER_KEY) || 'null'); return o?.token && Date.now() - (o.at || 0) < 21 * 864e5 ? o : null } catch { return null }
}
const saveOrder = o => { try { localStorage.setItem(ORDER_KEY, JSON.stringify(o)) } catch { /* приватный режим */ } }
export const clearOrder = () => { try { localStorage.removeItem(ORDER_KEY) } catch { /* */ } }

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true } catch { /* старые браузеры */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); return true
  } catch { return false }
}

const toB64 = buf => {
  let s = ''; const b = new Uint8Array(buf); const step = 0x8000
  for (let i = 0; i < b.length; i += step) s += String.fromCharCode.apply(null, b.subarray(i, i + step))
  return btoa(s)
}

/** Картинку — ужать до 1800 px в JPEG; PDF — как есть. */
async function prepareFile(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    if (file.size > MAX_PDF) throw new Error('PDF слишком большой — сделай скриншот чека')
    return { mime: 'application/pdf', data: toB64(await file.arrayBuffer()), preview: null }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url })
    const k = Math.min(1, MAX_IMG_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
    const c = document.createElement('canvas')
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k)
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height)
    const dataUrl = c.toDataURL('image/jpeg', 0.86)
    return { mime: 'image/jpeg', data: dataUrl.split(',')[1], preview: dataUrl }
  } catch {
    throw new Error('Не получилось открыть файл — пришли скриншот чека (JPG, PNG) или PDF')
  } finally { URL.revokeObjectURL(url) }
}

const CSS = `
.zt{--acc:${ACCENT2};--pur:${PUR}}
.zt *{box-sizing:border-box}
.zt-orb{position:fixed;border-radius:50%;filter:blur(60px);pointer-events:none;z-index:0;opacity:.5}
.zt-orb.a{width:320px;height:320px;background:${PUR};top:-120px;left:-90px;animation:ztFA 14s ease-in-out infinite alternate}
.zt-orb.b{width:280px;height:280px;background:#4d47b0;bottom:-80px;right:-120px;opacity:.35;animation:ztFB 18s ease-in-out infinite alternate}
@keyframes ztFA{to{transform:translate(80px,110px) scale(1.15)}}
@keyframes ztFB{to{transform:translate(-70px,-140px) scale(.9)}}
.zt-in{opacity:0;transform:translateY(16px);animation:ztUp .65s cubic-bezier(.2,.8,.2,1) forwards;animation-delay:var(--d,0ms)}
@keyframes ztUp{to{opacity:1;transform:none}}
.zt-card{background:${SURF};border:1px solid ${HAIR};border-radius:18px;padding:16px;position:relative;overflow:hidden}
.zt-card.sweep::before{content:"";position:absolute;inset:0;background:linear-gradient(120deg,transparent 30%,${PUR}33 50%,transparent 70%);transform:translateX(-120%);animation:ztSweep 1.3s ease-out .35s forwards}
@keyframes ztSweep{to{transform:translateX(120%)}}
.zt-grad{background:linear-gradient(90deg,#fff 0%,var(--acc) 35%,#fff 60%,var(--acc) 100%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:ztSheen 6s linear infinite}
@keyframes ztSheen{to{background-position:-250% 0}}
.zt-btn{position:relative;overflow:hidden;display:block;width:100%;padding:17px 18px;border-radius:999px;border:none;cursor:pointer;background:linear-gradient(180deg,${ACCENT2},${PUR});color:#fff;font-size:15.5px;font-weight:900;letter-spacing:.3px;text-transform:uppercase;animation:ztPulse 2.6s ease-in-out infinite;transition:transform .15s,opacity .2s}
.zt-btn:active{transform:scale(.97)}
.zt-btn:disabled{opacity:.6;animation:none;cursor:default}
.zt-btn::after{content:"";position:absolute;top:0;left:-60%;width:40%;height:100%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.5),transparent);transform:skewX(-20deg);animation:ztShine 3.2s ease-in-out infinite}
@keyframes ztPulse{0%,100%{box-shadow:0 8px 26px ${PUR}55}50%{box-shadow:0 10px 44px ${PUR}aa}}
@keyframes ztShine{0%,55%{left:-60%}100%{left:130%}}
.zt-ghost{display:block;width:100%;padding:14px 18px;border-radius:999px;cursor:pointer;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.04);color:#fff;font-size:15px;font-weight:700;margin-top:10px;transition:background .2s,transform .15s}
.zt-ghost:active{transform:scale(.97);background:rgba(255,255,255,.1)}
.zt-steps{display:flex;gap:6px;align-items:center}
.zt-steps .s{flex:1;height:4px;border-radius:4px;background:rgba(255,255,255,.12);overflow:hidden}
.zt-steps .s i{display:block;height:100%;width:0;background:linear-gradient(90deg,${ACCENT2},${PUR});border-radius:4px;transition:width .6s cubic-bezier(.2,.8,.2,1)}
.zt-steps .s.on i{width:100%}
.zt-pkg{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
.zt-pkg button{padding:10px 12px;border-radius:14px;border:1px solid ${HAIR};background:${SURF2}66;color:#fff;cursor:pointer;text-align:left;transition:border-color .2s,background .2s,transform .15s}
.zt-pkg button:active{transform:scale(.97)}
.zt-pkg button.on{border:2px solid ${ACCENT2};background:${PUR}26}
.zt-sum{font-size:44px;font-weight:900;letter-spacing:-1px;line-height:1;margin-top:6px}
.zt-sum.pop{animation:ztPop .5s cubic-bezier(.2,1.6,.4,1)}
@keyframes ztPop{from{transform:scale(.85);opacity:.4}to{transform:none;opacity:1}}
.zt-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid ${HAIR}}
.zt-row:first-child{border-top:none;padding-top:2px}
.zt-row .ic{width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:18px;background:${PUR}22;border:1px solid ${PUR}44;flex:0 0 auto}
.zt-row .l{font-size:11.5px;color:${T3};letter-spacing:.3px}
.zt-row .v{font-size:16px;font-weight:800;margin-top:2px;word-break:break-word}
.zt-copy{flex:0 0 auto;border:1px solid ${PUR}66;background:${PUR}1f;color:#fff;border-radius:999px;padding:8px 12px;font-size:12.5px;font-weight:800;cursor:pointer;min-width:104px;transition:background .25s,border-color .25s,transform .15s}
.zt-copy:active{transform:scale(.94)}
.zt-copy.ok{background:${TEA}26;border-color:${TEA}99;animation:ztPop .4s cubic-bezier(.2,1.6,.4,1)}
.zt-note{display:flex;gap:10px;align-items:flex-start;font-size:13.5px;color:${T2};line-height:1.45}
.zt-note b{color:#fff}
.zt-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:150px;border-radius:18px;border:2px dashed ${PUR}88;background:${PUR}10;cursor:pointer;text-align:center;padding:18px;transition:background .2s,border-color .2s;animation:ztGlow 2.8s ease-in-out infinite}
.zt-drop:active{background:${PUR}22}
@keyframes ztGlow{0%,100%{box-shadow:0 0 0 0 ${PUR}00}50%{box-shadow:0 0 0 6px ${PUR}22}}
.zt-drop .big{font-size:34px;animation:ztBob 2.4s ease-in-out infinite}
@keyframes ztBob{50%{transform:translateY(-5px)}}
.zt-file{display:flex;gap:12px;align-items:center;padding:10px;border-radius:16px;background:${SURF2}88;border:1px solid ${TEA}66;animation:ztUp .45s cubic-bezier(.2,.8,.2,1) both}
.zt-file img{width:64px;height:64px;object-fit:cover;border-radius:10px;border:1px solid ${HAIR}}
.zt-file .pdf{width:64px;height:64px;border-radius:10px;background:${DANGER}26;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:14px;color:#ff8a80}
.zt-lbl{font-size:12.5px;color:${T2};margin:14px 0 6px}
.zt-inp{width:100%;padding:13px 14px;border-radius:12px;border:1px solid ${HAIR};background:${SURF2};color:#fff;font-size:16px;outline:none;transition:border-color .2s,box-shadow .2s;-webkit-appearance:none;appearance:none}
.zt-inp:focus{border-color:${ACCENT2};box-shadow:0 0 0 3px ${PUR}33}
.zt-inp.bad{border-color:${DANGER}}
.zt-chk{display:flex;gap:11px;align-items:flex-start;font-size:13.5px;color:${T2};line-height:1.4;margin-top:16px;cursor:pointer}
.zt-chk .bx{width:22px;height:22px;border-radius:7px;border:2px solid ${PUR};flex:0 0 auto;display:flex;align-items:center;justify-content:center;transition:background .2s;margin-top:-1px}
.zt-chk .bx.on{background:${PUR}}
.zt-chk .bx.on svg{animation:ztPop .35s cubic-bezier(.2,1.6,.4,1)}
.zt-err{margin-top:12px;padding:11px 13px;border-radius:12px;background:${DANGER}1f;border:1px solid ${DANGER}66;color:#ffb4ab;font-size:13.5px;animation:ztShake .4s}
@keyframes ztShake{20%,60%{transform:translateX(-5px)}40%,80%{transform:translateX(5px)}}
.zt-spin{display:inline-block;width:16px;height:16px;border:2.5px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:ztRot .8s linear infinite;vertical-align:-3px;margin-right:9px}
@keyframes ztRot{to{transform:rotate(360deg)}}
.zt-ok{position:relative;width:120px;height:120px;margin:10px auto 0}
.zt-ok .ring{position:absolute;inset:0;border-radius:50%;border:2px solid ${ACCENT2};opacity:0;animation:ztRing 2.4s ease-out infinite}
.zt-ok .ring.r2{animation-delay:.8s}
@keyframes ztRing{0%{transform:scale(.7);opacity:.7}100%{transform:scale(1.5);opacity:0}}
.zt-ok svg{position:relative;width:120px;height:120px}
.zt-ok .c{stroke-dasharray:340;stroke-dashoffset:340;animation:ztDraw .9s cubic-bezier(.65,0,.35,1) .1s forwards}
.zt-ok .t{stroke-dasharray:80;stroke-dashoffset:80;animation:ztDraw .5s cubic-bezier(.65,0,.35,1) .85s forwards}
@keyframes ztDraw{to{stroke-dashoffset:0}}
.zt-pill{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;font-size:13px;font-weight:800;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.16)}
.zt-pill i{width:8px;height:8px;border-radius:50%;background:#ffcc00;box-shadow:0 0 10px #ffcc00;animation:ztBlink 1.4s ease-in-out infinite}
.zt-pill.ok i{background:${TEA};box-shadow:0 0 10px ${TEA};animation:none}
.zt-pill.bad i{background:${DANGER};box-shadow:0 0 10px ${DANGER};animation:none}
@keyframes ztBlink{50%{opacity:.3}}
.zt-num{display:inline-block;padding:10px 18px;margin:5px;border-radius:16px;font-size:30px;font-weight:900;background:linear-gradient(180deg,${ACCENT2},${PUR});box-shadow:0 12px 34px ${PUR}66;opacity:0;animation:ztNum .7s cubic-bezier(.2,1.6,.4,1) forwards;animation-delay:var(--d,0ms)}
@keyframes ztNum{from{transform:scale(.3) rotate(-8deg);opacity:0}to{transform:none;opacity:1}}
.zt-conf{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.zt-conf i{position:absolute;top:-12px;width:8px;height:14px;border-radius:2px;opacity:0;animation:ztFall 2.6s ease-in forwards}
@keyframes ztFall{0%{opacity:1;transform:translateY(0) rotate(0)}100%{opacity:0;transform:translateY(560px) rotate(540deg)}}
@media (prefers-reduced-motion: reduce){.zt *,.zt *::before,.zt *::after{animation:none!important;transition:none!important}.zt-in,.zt-num{opacity:1;transform:none}.zt-ok .c,.zt-ok .t{stroke-dashoffset:0}}
`

function Copy({ value, label = 'Скопировать', what }) {
  const [ok, setOk] = useState(false)
  const t = useRef(null)
  useEffect(() => () => clearTimeout(t.current), [])
  return (
    <button type="button" className={`zt-copy${ok ? ' ok' : ''}`} onClick={async () => {
      if (await copyText(value)) { setOk(true); track('promo', { s: 'tr_copy', w: what }, '/club'); clearTimeout(t.current); t.current = setTimeout(() => setOk(false), 1800) }
    }}>{ok ? '✓ Скопировано' : label}</button>
  )
}

function Confetti() {
  const cols = [ACCENT2, PUR, '#fff', '#ffcc00', TEA, '#ff6b9a']
  return (
    <div className="zt-conf" aria-hidden="true">
      {Array.from({ length: 36 }, (_, i) => (
        <i key={i} style={{ left: `${(i * 37) % 100}%`, background: cols[i % cols.length], animationDelay: `${(i % 12) * 70}ms`, animationDuration: `${2 + (i % 5) * 0.3}s` }} />
      ))}
    </div>
  )
}

export default function PayTransfer({ plan: plan0 = 'club', working: working0 = true, hoursFrom: hf0 = 9, hoursTo: ht0 = 24, token: token0 = null, user, onClose }) {
  const [step, setStep] = useState(token0 ? 3 : 1)
  const [plan, setPlan] = useState(plan0 === 'club4' ? 'club4' : 'club')
  const [hours, setHours] = useState({ working: working0, from: hf0, to: ht0 })
  const [file, setFile] = useState(null)        // { mime, data, preview, name }
  const [fileBusy, setFileBusy] = useState(false)
  const uEmail = user?.email && !/@(telegram\.fitpro|guest\.fitproapp\.ru|clients\.fitproapp\.ru)$/i.test(user.email) ? user.email : ''
  const [f, setF] = useState({ name: '', birth: '', phone: '', email: uEmail, consent: false })
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [busyText, setBusyText] = useState('')
  const [order, setOrder] = useState(token0 ? { token: token0 } : null)  // { token, id, email }
  const [status, setStatus] = useState(null)    // ответ api status
  const [rules, setRules] = useState(false)
  const [sumPop, setSumPop] = useState(0)
  const fileRef = useRef(null)
  const rootRef = useRef(null)
  const pkg = PKGS[plan]

  useEffect(() => { track('promo', { s: 'tr_open', plan: plan0, resume: !!token0 }, '/club') }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { rootRef.current?.scrollTo({ top: 0, behavior: 'smooth' }) }, [step])

  // ── Статус заказа: опрос, пока ждёт проверки.
  useEffect(() => {
    if (step !== 3 || !order?.token) return
    let stop = false, timer = null
    const tick = async () => {
      try {
        const r = await fetch('/api/pay-transfer?action=status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: order.token }) })
        if (r.status === 404) { clearOrder(); if (!stop) onClose(); return }
        const b = await r.json()
        if (stop) return
        setStatus(b)
        setHours({ working: b.working, from: b.hoursFrom, to: b.hoursTo })
        if (b.status === 'confirmed') track('promo', { s: 'tr_confirmed' }, '/club')
        if (b.status !== 'receipt') return
      } catch { /* сеть — попробуем снова */ }
      if (!stop) timer = setTimeout(tick, 15000)
    }
    tick()
    const onVis = () => { if (document.visibilityState === 'visible') { clearTimeout(timer); tick() } }
    document.addEventListener('visibilitychange', onVis)
    return () => { stop = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis) }
  }, [step, order?.token]) // eslint-disable-line react-hooks/exhaustive-deps

  const pickPlan = k => { if (k === plan) return; setPlan(k); setSumPop(x => x + 1); track('promo', { s: 'tr_pkg', plan: k }, '/club') }

  const onFile = async e => {
    const fl = e.target.files?.[0]
    e.target.value = ''
    if (!fl) return
    setErr(null); setFileBusy(true)
    try { const p = await prepareFile(fl); setFile({ ...p, name: fl.name }); track('promo', { s: 'tr_file', t: p.mime === 'application/pdf' ? 'pdf' : 'img' }, '/club') } catch (er) { setErr({ text: er.message, field: 'file' }) } finally { setFileBusy(false) }
  }

  const submit = async () => {
    setErr(null)
    if (!file) return setErr({ text: 'Прикрепи чек об оплате', field: 'file' })
    if (f.name.trim().split(/\s+/).length < 2) return setErr({ text: 'Укажи фамилию и имя', field: 'name' })
    if (!f.birth) return setErr({ text: 'Укажи дату рождения', field: 'birth' })
    if (f.phone.replace(/\D/g, '').length < 10) return setErr({ text: 'Проверь номер телефона', field: 'phone' })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.trim())) return setErr({ text: 'Проверь почту — на неё придёт номер участника', field: 'email' })
    if (!f.consent) return setErr({ text: 'Нужно согласие с правилами акции', field: 'consent' })
    setBusy(true); setBusyText('Загружаем чек…')
    const t2 = setTimeout(() => setBusyText('Передаём менеджеру…'), 2500)
    track('promo', { s: 'tr_submit', plan }, '/club')
    try {
      const headers = { 'Content-Type': 'application/json' }
      try { const { data: { session } } = await supabase.auth.getSession(); if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}` } catch { /* гость */ }
      const r = await fetch('/api/pay-transfer?action=submit', {
        method: 'POST', headers,
        body: JSON.stringify({ plan, name: f.name.trim(), birth: f.birth, phone: f.phone.trim(), email: f.email.trim(), consent: true, file: { mime: file.mime, data: file.data } }),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok || !b.token) { setErr({ text: b.error || 'Не удалось отправить, попробуй ещё раз', field: b.field }); track('promo', { s: 'tr_fail', why: `http_${r.status}` }, '/club'); return }
      const o = { token: b.token, id: b.id, email: f.email.trim(), at: Date.now() }
      saveOrder(o); setOrder(o)
      setHours({ working: b.working, from: b.hoursFrom, to: b.hoursTo })
      setStatus({ status: 'receipt', id: b.id, email: o.email, numbers: [] })
      track('promo', { s: 'tr_ok', plan, night: !b.working }, '/club'); flush()
      setStep(3)
    } catch {
      setErr({ text: 'Нет связи — проверь интернет и попробуй ещё раз' }); track('promo', { s: 'tr_fail', why: 'network' }, '/club')
    } finally { clearTimeout(t2); setBusy(false) }
  }

  const bad = k => err?.field === k ? ' bad' : ''
  const st = status?.status || 'receipt'
  const close = () => { if (st === 'confirmed' || st === 'rejected' || st === 'annulled') clearOrder(); onClose() }

  return (
    <div ref={rootRef} className="zt" data-testid="pay-transfer" style={{
      position: 'fixed', inset: 0, zIndex: 3500, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch',
      background: BG, color: '#fff', fontFamily: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif', textAlign: 'left',
    }}>
      <style>{CSS}</style>
      <div className="zt-orb a" /><div className="zt-orb b" />

      {/* Шапка */}
      <div style={{ position: 'sticky', top: 0, zIndex: 3, background: `${BG}e6`, backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', borderBottom: `1px solid ${HAIR}` }}>
        <div style={{ maxWidth: 520, margin: '0 auto', padding: '12px 16px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={() => (step === 2 && !busy ? setStep(1) : close())} aria-label="Назад" style={{ background: SURF, border: `1px solid ${HAIR}`, color: '#fff', width: 40, height: 40, borderRadius: 999, fontSize: 18, cursor: 'pointer', flex: '0 0 auto' }}>{step === 2 ? '←' : '✕'}</button>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, letterSpacing: 2, color: ACCENT2, fontWeight: 800, textTransform: 'uppercase' }}>ZM Club · шаг {step} из 3</div>
              <div style={{ fontSize: 17, fontWeight: 900, marginTop: 1 }}>{step === 1 ? 'Перевод по СБП' : step === 2 ? 'Чек и анкета' : st === 'confirmed' ? 'Добро пожаловать!' : 'Платёж принят'}</div>
            </div>
          </div>
          <div className="zt-steps" style={{ marginTop: 12 }}>
            {[1, 2, 3].map(i => <div key={i} className={`s${step >= i ? ' on' : ''}`}><i /></div>)}
          </div>
        </div>
      </div>

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 520, margin: '0 auto', padding: '18px 16px calc(40px + env(safe-area-inset-bottom))' }}>

        {/* ── ШАГ 1: реквизиты */}
        {step === 1 && (
          <div key="s1">
            <div className="zt-card sweep zt-in" style={{ '--d': '0ms', textAlign: 'center', padding: '18px 16px', border: `1px solid ${PUR}55`, boxShadow: `0 18px 50px ${PUR}33` }}>
              <div style={{ fontSize: 11, letterSpacing: 2.4, color: ACCENT2, fontWeight: 800, textTransform: 'uppercase' }}>Сумма к оплате</div>
              <div key={sumPop} className={`zt-sum zt-grad${sumPop ? ' pop' : ''}`}>{rub(pkg.price)}</div>
              <div style={{ fontSize: 13, color: T2, marginTop: 6 }}>{pkg.title} · {pkg.note}</div>
              <div className="zt-pkg">
                {Object.entries(PKGS).map(([k, p]) => (
                  <button key={k} className={plan === k ? 'on' : ''} onClick={() => pickPlan(k)}>
                    <div style={{ fontSize: 11.5, color: T2 }}>{k === 'club' ? '1 месяц' : '3+1 · 4 месяца'}</div>
                    <div style={{ fontSize: 17, fontWeight: 900 }}>{rub(p.price)}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="zt-in" style={{ '--d': '120ms', fontSize: 11, letterSpacing: 2.4, color: ACCENT2, fontWeight: 800, textTransform: 'uppercase', margin: '24px 0 10px' }}>Реквизиты для перевода</div>
            <div className="zt-card zt-in" style={{ '--d': '180ms' }}>
              <div className="zt-row">
                <div className="ic">⚡</div>
                <div style={{ flex: 1, minWidth: 0 }}><div className="l">СБП ПО НОМЕРУ ТЕЛЕФОНА</div><div className="v">{REQ.phone}</div></div>
                <Copy value={REQ.phoneCopy} what="phone" />
              </div>
              <div className="zt-row">
                <div className="ic">💳</div>
                <div style={{ flex: 1, minWidth: 0 }}><div className="l">БАНК ПОЛУЧАТЕЛЯ</div><div className="v">{REQ.bank}</div></div>
              </div>
              <div className="zt-row">
                <div className="ic">👤</div>
                <div style={{ flex: 1, minWidth: 0 }}><div className="l">ПОЛУЧАТЕЛЬ · {REQ.role.toUpperCase()}</div><div className="v">{REQ.name}</div></div>
              </div>
              <div className="zt-row">
                <div className="ic">₽</div>
                <div style={{ flex: 1, minWidth: 0 }}><div className="l">СУММА</div><div className="v">{rub(pkg.price)}</div></div>
                <Copy value={String(pkg.price)} what="sum" />
              </div>
            </div>

            <div className="zt-in" style={{ '--d': '260ms', display: 'grid', gap: 12, margin: '16px 4px 0' }}>
              <div className="zt-note"><span>✅</span><span>Перевод по СБП — <b>без комиссии</b>. В банке выбери «Перевод по номеру телефона» → {REQ.bank}.</span></div>
              <div className="zt-note"><span>✍️</span><span>Комментарий к переводу <b>не пиши</b> — номер участника привяжем по чеку.</span></div>
              <div className="zt-note"><span>📸</span><span>После перевода <b>сохрани чек</b> (скриншот или PDF) — прикрепишь его на следующем шаге.</span></div>
            </div>

            <a href={`https://t.me/${REQ.abroadTg}`} target="_blank" rel="noreferrer" className="zt-card zt-in" onClick={() => track('promo', { s: 'tr_abroad' }, '/club')} style={{ '--d': '320ms', display: 'flex', gap: 12, alignItems: 'center', marginTop: 18, textDecoration: 'none', color: '#fff' }}>
              <div style={{ fontSize: 26 }}>🌎</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 800, fontSize: 14.5 }}>Платишь из другой страны?</div>
                <div style={{ fontSize: 13, color: T2, marginTop: 2 }}>Напиши <span style={{ color: ACCENT2, fontWeight: 700 }}>@{REQ.abroadTg}</span> — подскажем, как оплатить</div>
              </div>
              <div style={{ color: ACCENT2, fontSize: 18 }}>→</div>
            </a>

            <div className="zt-in" style={{ '--d': '380ms', marginTop: 22 }}>
              <button className="zt-btn" onClick={() => { track('promo', { s: 'tr_paid', plan }, '/club'); setStep(2) }}>Я перевёл(а) — прикрепить чек</button>
              <div style={{ fontSize: 12, color: T3, textAlign: 'center', marginTop: 10 }}>Вопросы по оплате: {REQ.email}</div>
            </div>
          </div>
        )}

        {/* ── ШАГ 2: чек и анкета */}
        {step === 2 && (
          <div key="s2">
            <div className="zt-in" style={{ '--d': '0ms', fontSize: 14, color: T2, lineHeight: 1.5 }}>
              Оплата <b style={{ color: '#fff' }}>{rub(pkg.price)}</b> · {pkg.title}. Прикрепи чек и заполни анкету — по ней позвоним, если победишь.
            </div>

            <input ref={fileRef} type="file" accept="image/*,application/pdf" onChange={onFile} style={{ display: 'none' }} />
            <div className="zt-in" style={{ '--d': '80ms', marginTop: 16 }}>
              {!file ? (
                <div className="zt-drop" role="button" tabIndex={0} onClick={() => fileRef.current?.click()} style={err?.field === 'file' ? { borderColor: DANGER } : undefined}>
                  {fileBusy ? <><span className="zt-spin" /><div style={{ fontWeight: 800 }}>Готовим файл…</div></> : <>
                    <div className="big">🧾</div>
                    <div style={{ fontWeight: 900, fontSize: 16 }}>Прикрепить чек</div>
                    <div style={{ fontSize: 13, color: T2 }}>Скриншот из банка или PDF</div>
                  </>}
                </div>
              ) : (
                <div className="zt-file">
                  {file.preview ? <img src={file.preview} alt="Чек" /> : <div className="pdf">PDF</div>}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 800, color: TEA }}>✓ Чек прикреплён</div>
                    <div style={{ fontSize: 12.5, color: T3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.name}</div>
                  </div>
                  <button onClick={() => fileRef.current?.click()} style={{ background: 'none', border: `1px solid ${HAIR}`, color: '#fff', borderRadius: 999, padding: '8px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>Заменить</button>
                </div>
              )}
            </div>

            <div className="zt-card zt-in" style={{ '--d': '160ms', marginTop: 16, paddingTop: 4 }}>
              <div className="zt-lbl">Фамилия и имя</div>
              <input className={`zt-inp${bad('name')}`} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="Иванова Анна" autoComplete="name" />
              <div className="zt-lbl">Дата рождения</div>
              <input className={`zt-inp${bad('birth')}`} type="date" value={f.birth} max="2008-11-12" onChange={e => setF({ ...f, birth: e.target.value })} style={{ colorScheme: 'dark' }} />
              <div className="zt-lbl">Телефон — позвоним, если победишь</div>
              <input className={`zt-inp${bad('phone')}`} type="tel" inputMode="tel" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} placeholder="+7 900 000-00-00" autoComplete="tel" />
              <div className="zt-lbl">Почта — сюда придёт номер участника и вход в клуб</div>
              <input className={`zt-inp${bad('email')}`} type="email" inputMode="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} placeholder="you@mail.ru" autoComplete="email" autoCapitalize="none" />
              <div className="zt-chk" role="checkbox" aria-checked={f.consent} onClick={() => setF({ ...f, consent: !f.consent })}>
                <span className={`bx${f.consent ? ' on' : ''}`} style={err?.field === 'consent' ? { borderColor: DANGER } : undefined}>
                  {f.consent && <svg width="13" height="13" viewBox="0 0 13 13"><path d="M2 7l3 3 6-7" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                </span>
                <span>Согласен(на) с <a href="#rules" onClick={e => { e.preventDefault(); e.stopPropagation(); setRules(true) }} style={{ color: ACCENT2 }}>правилами акции</a> и обработкой персональных данных, мне есть 18 лет</span>
              </div>
            </div>

            {err && <div key={err.text} className="zt-err">{err.text}</div>}

            <div style={{ marginTop: 18 }}>
              <button className="zt-btn" disabled={busy || fileBusy} onClick={submit}>{busy ? <><span className="zt-spin" />{busyText}</> : 'Отправить чек'}</button>
              <button className="zt-ghost" disabled={busy} onClick={() => setStep(1)}>← К реквизитам</button>
            </div>
          </div>
        )}

        {/* ── ШАГ 3: принято / подтверждено / отклонено */}
        {step === 3 && (
          <div key="s3" style={{ position: 'relative', textAlign: 'center' }}>
            {st === 'confirmed' ? (
              <>
                <Confetti />
                <div className="zt-in" style={{ fontSize: 54, '--d': '0ms' }}>🎉</div>
                <div className="zt-in" style={{ '--d': '120ms', fontSize: 26, fontWeight: 900, textTransform: 'uppercase', lineHeight: 1.1, marginTop: 6 }}>
                  Оплата <span className="zt-grad">подтверждена</span>
                </div>
                {status?.numbers?.length > 0 && (
                  <div className="zt-card zt-in" style={{ '--d': '240ms', marginTop: 20, border: `1px solid ${PUR}66` }}>
                    <div style={{ fontSize: 11, letterSpacing: 2.4, color: ACCENT2, fontWeight: 800 }}>{status.numbers.length > 1 ? 'ТВОИ НОМЕРА УЧАСТНИКА' : 'ТВОЙ НОМЕР УЧАСТНИКА'}</div>
                    <div style={{ marginTop: 8 }}>
                      {status.numbers.map((n, i) => <span key={n} className="zt-num" style={{ '--d': `${450 + i * 140}ms` }}>№{n}</span>)}
                    </div>
                    <div style={{ fontSize: 13, color: T2, marginTop: 10 }}>Итоги — 12 ноября в прямом эфире</div>
                  </div>
                )}
                <div className="zt-in" style={{ '--d': '360ms', fontSize: 14, color: T2, lineHeight: 1.5, marginTop: 16 }}>
                  Номер и кнопку входа мы также отправили на <b style={{ color: '#fff' }}>{status?.email}</b>.
                </div>
                <div className="zt-in" style={{ '--d': '460ms', marginTop: 20 }}>
                  {status?.login ? (
                    <button className="zt-btn" onClick={() => { clearOrder(); track('promo', { s: 'tr_login' }, '/club'); window.location.assign(`/?promo_login=${encodeURIComponent(status.login)}`) }}>Войти в клуб</button>
                  ) : user ? (
                    <button className="zt-btn" onClick={() => { clearOrder(); window.location.reload() }}>Открыть клуб</button>
                  ) : (
                    <div className="zt-card" style={{ fontSize: 14, color: T2, lineHeight: 1.5 }}>Войди в клуб под почтой <b style={{ color: '#fff' }}>{status?.email}</b> — доступ уже открыт.</div>
                  )}
                  <button className="zt-ghost" onClick={close}>Закрыть</button>
                </div>
              </>
            ) : st === 'rejected' || st === 'annulled' ? (
              <>
                <div className="zt-in" style={{ fontSize: 50, '--d': '0ms' }}>😕</div>
                <div className="zt-in" style={{ '--d': '100ms', fontSize: 22, fontWeight: 900, marginTop: 6 }}>{st === 'annulled' ? 'Оплата не поступила' : 'Перевод не найден'}</div>
                <div className="zt-in" style={{ '--d': '160ms', marginTop: 12 }}><span className="zt-pill bad"><i />Заказ #{status?.id}</span></div>
                <div className="zt-in" style={{ '--d': '220ms', fontSize: 14, color: T2, lineHeight: 1.55, marginTop: 14 }}>
                  Мы не нашли перевод по присланному чеку. Проверь сумму и реквизиты и отправь чек ещё раз. Если уверен(а), что всё верно, — напиши <b style={{ color: '#fff' }}>@{REQ.abroadTg}</b> или на {REQ.email}.
                </div>
                <div className="zt-in" style={{ '--d': '300ms', marginTop: 20 }}>
                  <button className="zt-btn" onClick={() => { clearOrder(); setOrder(null); setStatus(null); setFile(null); setStep(1) }}>Оплатить ещё раз</button>
                  <button className="zt-ghost" onClick={close}>Закрыть</button>
                </div>
              </>
            ) : (
              <>
                <div className="zt-ok">
                  <span className="ring" /><span className="ring r2" />
                  <svg viewBox="0 0 120 120"><circle className="c" cx="60" cy="60" r="54" fill="none" stroke={ACCENT2} strokeWidth="5" /><path className="t" d="M38 62l15 15 30-33" fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </div>
                <div className="zt-in" style={{ '--d': '900ms', fontSize: 26, fontWeight: 900, textTransform: 'uppercase', lineHeight: 1.1, marginTop: 14 }}>
                  Платёж <span className="zt-grad">принят</span>
                </div>
                <div className="zt-in" style={{ '--d': '1000ms', marginTop: 12 }}>
                  <span className="zt-pill"><i />{status?.id ? `Заказ #${status.id} · ` : ''}ждёт проверки</span>
                </div>
                <div className="zt-card zt-in" style={{ '--d': '1100ms', marginTop: 18, textAlign: 'left', fontSize: 14.5, color: T2, lineHeight: 1.55 }}>
                  {hours.working ? (
                    <>Менеджер проверит перевод — <b style={{ color: '#fff' }}>обычно в течение 30 минут</b>. Номер участника и вход в клуб придут на почту <b style={{ color: '#fff' }}>{status?.email || order?.email}</b> и появятся на этой странице.</>
                  ) : (
                    <>Номера выдаём <b style={{ color: '#fff' }}>с {hh(hours.from)} до {hh(hours.to)} по Москве</b>. Утром, после {hh(hours.from)}, менеджер проверит перевод и выдаст номер участника — он придёт на почту <b style={{ color: '#fff' }}>{status?.email || order?.email}</b> и появится на этой странице.</>
                  )}
                  <div style={{ marginTop: 10, fontSize: 13, color: T3 }}>Можно закрыть сайт — ничего больше делать не нужно. Если письма нет, проверь «Спам».</div>
                </div>
                <div className="zt-in" style={{ '--d': '1200ms', marginTop: 20 }}>
                  <button className="zt-ghost" onClick={close}>Вернуться на сайт</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <PromoInfo open={rules} initial="rules" onClose={() => setRules(false)} />
    </div>
  )
}
