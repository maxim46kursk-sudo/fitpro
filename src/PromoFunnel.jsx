import { useEffect, useState } from 'react'
import { supabase } from './supabase.js'
import { SURF, SURF2, HAIR, TXT, TXT2, TXT3, PUR, ACCENT2, TEA, COR, DANGER } from './theme.js'

/**
 * ВОРОНКА АКЦИИ «SKODA OCTAVIA» — блок владельца на экране «Аналитика»
 * (окт 2026). Каждый шаг человека от захода на лендинг до группы, скорость
 * загрузки и кассы, источники. Данные — api/promo.js?action=funnel
 * (api/_promoFunnel.js): действия на сайте из журнала, деньги и анкеты из базы.
 */

const PERIODS = [['today', 'Сегодня'], ['7d', '7 дней'], ['all', 'Вся акция']]
const SRC = { ig_stories: 'Instagram · сторис', ig_reels: 'Instagram · рилс', ig_bio: 'Instagram · шапка профиля', ig_post: 'Instagram · пост', ig: 'Instagram', tg: 'Telegram', vk: 'VK', yt: 'YouTube', tiktok: 'TikTok', direct: 'Прямой заход' }
const WHY = { sold_out: 'места закончились', network: 'нет связи', pre_error: 'ошибка (быстрая версия)' }
const rub = n => Number(n || 0).toLocaleString('ru-RU') + ' ₽'
const sec = ms => ms == null ? '—' : `${(ms / 1000).toFixed(1)} с`
const pct = (a, b) => b ? Math.round(a / b * 100) : 0

const H = ({ children, sub }) => (
  <div style={{ margin: '20px 0 10px' }}>
    <div style={{ fontSize: 13, fontWeight: 800, color: TXT, textTransform: 'uppercase', letterSpacing: '.4px' }}>{children}</div>
    {sub && <div style={{ fontSize: 12, color: TXT3, marginTop: 3 }}>{sub}</div>}
  </div>
)

function Tile({ v, l, c = PUR }) {
  return (
    <div style={{ background: SURF, border: `1px solid ${HAIR}`, borderRadius: 14, padding: '12px 12px 10px' }}>
      <div style={{ fontSize: 21, fontWeight: 800, color: c, lineHeight: 1.1 }}>{v ?? '—'}</div>
      <div style={{ fontSize: 11.5, color: TXT3, marginTop: 4, lineHeight: 1.3 }}>{l}</div>
    </div>
  )
}

function Step({ i, label, n, prev, first, db }) {
  const w = first ? Math.max(3, Math.round(n / first * 100)) : 0
  const lost = prev != null ? prev - n : null
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, color: TXT2, marginBottom: 4 }}>
        <span><b style={{ color: TXT3 }}>{i}.</b> {label}{db && <span style={{ color: TXT3, fontSize: 11 }}> · база</span>}</span>
        <span style={{ flexShrink: 0, color: TXT, fontWeight: 700 }}>{n}<span style={{ color: TXT3, fontWeight: 400 }}> · {pct(n, first)}%</span></span>
      </div>
      <div style={{ height: 8, borderRadius: 5, background: SURF2 }}>
        <div style={{ height: '100%', width: `${w}%`, borderRadius: 5, background: db ? TEA : PUR }} />
      </div>
      {lost > 0 && <div style={{ fontSize: 11.5, color: COR, marginTop: 3 }}>−{lost} ({pct(lost, prev)}% от прошлого шага)</div>}
    </div>
  )
}

function SpeedRow({ name, s, hint }) {
  return (
    <tr style={{ borderTop: `1px solid ${HAIR}` }}>
      <td style={{ padding: '7px 10px', color: TXT }}>{name}<div style={{ fontSize: 11, color: TXT3 }}>{hint}</div></td>
      <td style={{ padding: '7px 10px', textAlign: 'right', color: TXT, fontWeight: 700 }}>{sec(s?.med)}</td>
      <td style={{ padding: '7px 10px', textAlign: 'right' }}>{sec(s?.p90)}</td>
      <td style={{ padding: '7px 10px', textAlign: 'right', color: s?.slow ? COR : TXT2 }}>{s ? `${s.slow} из ${s.n}` : '—'}</td>
    </tr>
  )
}

export default function PromoFunnel() {
  const [period, setPeriod] = useState('today')
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    setErr(''); setD(null)
    ;(async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const r = await fetch('/api/promo?action=funnel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
          body: JSON.stringify({ period }),
        })
        const b = await r.json().catch(() => ({}))
        if (!alive) return
        if (!r.ok) { setErr(b.error || `ошибка ${r.status}`); return }
        setD(b)
      } catch (e) { if (alive) setErr(e.message || 'ошибка') }
    })()
    return () => { alive = false }
  }, [period, tick])

  const f = d?.funnel || []
  const first = f[0]?.n || 0

  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: TXT }}>Акция · Skoda Octavia</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {PERIODS.map(([k, l]) => (
            <button key={k} onClick={() => setPeriod(k)} style={{
              fontSize: 12, padding: '5px 11px', borderRadius: 20, cursor: 'pointer', minHeight: 'unset',
              border: `1px solid ${period === k ? PUR : HAIR}`, background: period === k ? `${PUR}22` : SURF2, color: period === k ? ACCENT2 : TXT2,
            }}>{l}</button>
          ))}
          <button onClick={() => setTick(t => t + 1)} title="Обновить" style={{ fontSize: 12, padding: '5px 9px', borderRadius: 20, cursor: 'pointer', minHeight: 'unset', border: `1px solid ${HAIR}`, background: SURF2, color: TXT2 }}>↻</button>
        </div>
      </div>

      {err && <div style={{ fontSize: 13, color: DANGER }}>Не загрузилось: {err}</div>}
      {!d && !err && <div style={{ fontSize: 13, color: TXT3 }}>Загрузка…</div>}

      {d && (<>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
          <Tile v={first} l="Зашли на лендинг" />
          <Tile v={d.money.payments} l="Оплат" c={TEA} />
          <Tile v={rub(d.money.sum)} l="Выручка" c={TEA} />
          <Tile v={d.money.numbers} l="Выдано номеров за период" c={ACCENT2} />
          <Tile v={`${d.places.issued} / ${d.places.cap}`} l="Номеров всего (из лимита)" c={TXT2} />
          <Tile v={first ? `${(d.money.payments / first * 100).toFixed(1)}%` : '—'} l="Конверсия в оплату" c={COR} />
        </div>

        <H sub="Каждый шаг — сколько людей до него дошло и сколько отвалилось. Зелёные — из базы (точные), фиолетовые — действия на сайте.">Путь человека</H>
        {f.map((s, i) => <Step key={s.key} i={i + 1} label={s.label} n={s.n} prev={i ? f[i - 1].n : null} first={first} db={s.db} />)}

        {d.exits && (<>
          <H sub={`По ${d.exits.tracked} посетителям с разметкой блоков. Полоса — сколько долистали до блока, красным — сколько дальше него не пошли и не нажали «Вступить».`}>Где уходят</H>
          {d.exits.tracked === 0 ? <div style={{ fontSize: 13, color: TXT3 }}>Пока нет данных — появятся с новыми заходами.</div> : (<>
            {(() => { const pre = d.exits.blocks[0]; return pre.left > 0 && (
              <div style={{ fontSize: 13, color: COR, marginBottom: 10 }}>Ушли, не дождавшись загрузки страницы: <b>{pre.left}</b> ({pct(pre.left, d.exits.tracked)}%)</div>
            ) })()}
            {d.exits.blocks.slice(1).map(b => (
              <div key={b.key} style={{ marginBottom: 9 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, color: TXT2, marginBottom: 4 }}>
                  <span>{b.label}</span>
                  <span style={{ flexShrink: 0 }}>
                    <b style={{ color: TXT }}>{b.reached}</b><span style={{ color: TXT3 }}> · {pct(b.reached, d.exits.tracked)}%</span>
                    {b.left > 0 && <b style={{ color: COR, marginLeft: 8 }}>−{b.left}</b>}
                  </span>
                </div>
                <div style={{ height: 8, borderRadius: 5, background: SURF2, overflow: 'hidden', display: 'flex' }}>
                  <div style={{ height: '100%', width: `${pct(b.reached - b.left, d.exits.tracked)}%`, background: PUR }} />
                  <div style={{ height: '100%', width: `${pct(b.left, d.exits.tracked)}%`, background: COR }} />
                </div>
              </div>
            ))}
            <H sub="Только те, кто не нажал «Вступить». Время — с начала загрузки страницы до ухода.">Сколько пробыли на странице</H>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 8 }}>
              <Tile v={d.exits.time.med == null ? '—' : `${d.exits.time.med} с`} l="Медиана времени" c={COR} />
              {d.exits.time.buckets.slice(0, 2).map(b => <Tile key={b.label} v={b.n} l={b.label} c={TXT2} />)}
              {d.exits.time.buckets.slice(2).map(b => <Tile key={b.label} v={b.n} l={b.label} c={TXT2} />)}
            </div>
          </>)}
        </>)}

        <H>Что ещё делали</H>
        <div style={{ background: SURF, border: `1px solid ${HAIR}`, borderRadius: 12 }}>
          {d.side.map((s, i) => (
            <div key={s.label} style={{ padding: '8px 12px', borderTop: i ? `1px solid ${HAIR}` : 'none', fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ color: TXT2 }}>{s.label}</span>
                <b style={{ color: s.bad && s.n ? COR : TXT }}>{s.n}</b>
              </div>
              {s.why && Object.keys(s.why).length > 0 && (
                <div style={{ fontSize: 11.5, color: TXT3, marginTop: 2 }}>
                  {Object.entries(s.why).map(([k, v]) => `${WHY[k] || k}: ${v}`).join(' · ')}
                </div>
              )}
            </div>
          ))}
        </div>

        <H sub="Медиана — у половины людей быстрее. 90% — у 9 из 10 быстрее. «Дольше 5 с» — сколько ждали слишком долго.">Скорость</H>
        <div style={{ overflowX: 'auto', background: SURF, border: `1px solid ${HAIR}`, borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, color: TXT2 }}>
            <thead><tr style={{ color: TXT3 }}>
              {['', 'Медиана', '90%', 'Дольше 5 с'].map((h, i) => <th key={i} style={{ padding: '8px 10px', fontWeight: 600, textAlign: i ? 'right' : 'left' }}>{h}</th>)}
            </tr></thead>
            <tbody>
              <SpeedRow name="Быстрый лендинг" hint="первый экран с машиной и кнопкой" s={d.speed.pre} />
              <SpeedRow name="Полный лендинг" hint="после быстрого" s={d.speed.appAfterPre} />
              <SpeedRow name="Полный лендинг без быстрого" hint="повторные заходы, Telegram" s={d.speed.app} />
              <SpeedRow name="Открытие кассы" hint="от нажатия до перехода в Продамус" s={d.speed.pay} />
            </tbody>
          </table>
        </div>

        <H>Откуда приходят</H>
        <div style={{ overflowX: 'auto', background: SURF, border: `1px solid ${HAIR}`, borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, color: TXT2 }}>
            <thead><tr style={{ color: TXT3 }}>
              {['', 'Зашли', '«Вступить»', 'Касса'].map((h, i) => <th key={i} style={{ padding: '8px 10px', fontWeight: 600, textAlign: i ? 'right' : 'left' }}>{h}</th>)}
            </tr></thead>
            <tbody>{d.sources.length ? d.sources.map(r => (
              <tr key={r.src} style={{ borderTop: `1px solid ${HAIR}` }}>
                <td style={{ padding: '7px 10px', color: TXT }}>{SRC[r.src] || r.src}</td>
                <td style={{ padding: '7px 10px', textAlign: 'right', color: TXT, fontWeight: 700 }}>{r.visitors}</td>
                <td style={{ padding: '7px 10px', textAlign: 'right' }}>{r.join}</td>
                <td style={{ padding: '7px 10px', textAlign: 'right', color: TEA }}>{r.pay_ok}</td>
              </tr>
            )) : <tr><td colSpan={4} style={{ padding: 10, color: TXT3 }}>Нет данных</td></tr>}</tbody>
          </table>
        </div>
        <div style={{ fontSize: 11.5, color: TXT3, marginTop: 6 }}>Чтобы точно видеть сторис, рилс и шапку профиля, ставь в ссылку метку: zmclubonline.ru/?src=ig_stories, ?src=ig_reels, ?src=ig_bio.</div>

        {period !== 'today' && d.days.length > 0 && (<>
          <H>По дням</H>
          <div style={{ overflowX: 'auto', background: SURF, border: `1px solid ${HAIR}`, borderRadius: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, color: TXT2, whiteSpace: 'nowrap' }}>
              <thead><tr style={{ color: TXT3 }}>
                {['', 'Зашли', '«Вступить»', 'Касса', 'Оплат', 'Выручка'].map((h, i) => <th key={i} style={{ padding: '8px 10px', fontWeight: 600, textAlign: i ? 'right' : 'left' }}>{h}</th>)}
              </tr></thead>
              <tbody>{d.days.map(r => (
                <tr key={r.day} style={{ borderTop: `1px solid ${HAIR}`, textAlign: 'right' }}>
                  <td style={{ padding: '7px 10px', textAlign: 'left', color: TXT }}>{new Date(r.day + 'T12:00:00').toLocaleDateString('ru', { day: 'numeric', month: 'short' })}</td>
                  <td style={{ padding: '7px 10px', color: TXT, fontWeight: 700 }}>{r.visitors}</td>
                  <td style={{ padding: '7px 10px' }}>{r.join}</td>
                  <td style={{ padding: '7px 10px' }}>{r.pay_ok}</td>
                  <td style={{ padding: '7px 10px', color: TEA, fontWeight: 700 }}>{r.paid}</td>
                  <td style={{ padding: '7px 10px', color: TEA }}>{rub(r.money)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>)}
      </>)}
    </div>
  )
}
