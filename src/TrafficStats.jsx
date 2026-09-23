import { useEffect, useState } from 'react'
import { supabase } from './supabase.js'
import { SURF, SURF2, HAIR, TXT, TXT2, TXT3, PUR, ACCENT2, TEA, COR, DANGER } from './theme.js'

/**
 * ПОСЕЩАЕМОСТЬ — блок тренера на экране «Настройки → Аналитика» (ZMClub, сент 2026).
 *
 * Отвечает на три вопроса: сколько людей пришло за сутки (и сколько новых),
 * куда они ходят и где останавливаются. Данные — свой журнал app_events,
 * функции в sql/2026-09-23_traffic_stats.sql (только тренеру).
 */

// Человеческие названия шагов. Незнакомое показываем как есть — новое событие
// из свежего кода видно сразу, а не прячется.
const LABELS = {
  'screen:club_landing': 'Лендинг клуба',
  'screen:club_look': '«Посмотреть клуб изнутри»',
  'screen:club_join': '«Вступить» на лендинге',
  'screen:club_trial': '«Хочу пробный период» на лендинге',
  'screen:workouts': 'Тренировки',
  'screen:nutrition': 'Питание',
  'screen:library': 'Упражнения',
  'screen:progress': 'Прогресс',
  'screen:clients': 'Клиенты',
  'screen:dashboard': 'Главная',
  'screen:motion': 'ZMClub Motion',
  'screen:chat': 'Кнопка «Чат»',
  'screen:report_open': 'Открыл видео-отчёт',
  'screen:report_sent': 'Отправил видео-отчёт',
  plans_open: 'Экран оплаты',
  plan_click: 'Выбрал тариф',
  pay_start: 'Ушёл на оплату',
  pay_done: 'Оплатил',
  programs_open: 'Список программ',
  program_open: 'Открыл программу',
  program_pick: 'Выбрал программу',
  slot_open: 'Открыл тренировку',
  slot_locked: 'Упёрся в закрытую тренировку',
  workout_start: 'Начал тренировку',
  workout_finish: 'Завершил тренировку',
  workout_quit: 'Бросил тренировку',
  rating_set: 'Поставил оценку нагрузки',
  video_play: 'Смотрел видео упражнения',
  'paywall:library': 'Замок: упражнения',
  'paywall:ration': 'Замок: рацион',
  'paywall:workouts': 'Замок: Мои тренировки',
  'paywall:exercises': 'Замок: прогресс по упражнениям',
  'paywall:chat': 'Замок: чат',
  'paywall:reports': 'Замок: мои отчёты',
  load_fail: 'Что-то не загрузилось',
  error_shown: 'Показана ошибка',
  app_open: 'Открыл приложение',
  app_open_guest: 'Открыл приложение (гость)',
}
const label = s => LABELS[s] || (s?.startsWith('paywall:') ? `Замок: ${s.slice(8)}` : s?.startsWith('screen:') ? s.slice(7) : s)

const PERIODS = [[1, 'Сутки'], [7, '7 дней'], [30, '30 дней']]

function Tile({ v, l, c = PUR }) {
  return (
    <div style={{ background: SURF, border: `1px solid ${HAIR}`, borderRadius: 14, padding: '12px 12px 10px' }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: c, lineHeight: 1.1 }}>{v ?? '—'}</div>
      <div style={{ fontSize: 11.5, color: TXT3, marginTop: 4, lineHeight: 1.3 }}>{l}</div>
    </div>
  )
}

function Bar({ name, n, max, total, c = PUR }) {
  const w = max ? Math.max(3, Math.round(n / max * 100)) : 0
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: TXT2, marginBottom: 3, gap: 8 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <span style={{ flexShrink: 0, color: TXT }}>{n}{total ? <span style={{ color: TXT3 }}> · {Math.round(n / total * 100)}%</span> : null}</span>
      </div>
      <div style={{ height: 6, borderRadius: 4, background: SURF2 }}>
        <div style={{ height: '100%', width: `${w}%`, borderRadius: 4, background: c }} />
      </div>
    </div>
  )
}

const H = ({ children }) => <div style={{ fontSize: 13, fontWeight: 800, color: TXT, textTransform: 'uppercase', letterSpacing: '.4px', margin: '20px 0 10px' }}>{children}</div>

export default function TrafficStats() {
  const [days, setDays] = useState(1)
  const [daily, setDaily] = useState(null)
  const [exits, setExits] = useState(null)
  const [screens, setScreens] = useState(null)
  const [visits, setVisits] = useState(null)
  const [openSess, setOpenSess] = useState(null)
  const [path, setPath] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    setErr(''); setExits(null); setScreens(null)
    Promise.all([
      supabase.rpc('app_daily', { days: 14 }),
      supabase.rpc('app_exits', { days }),
      supabase.rpc('app_screens', { days }),
      supabase.rpc('app_visits', { days: Math.min(days, 7), lim: 40 }),
    ]).then(([d, e, s, v]) => {
      if (!alive) return
      const bad = d.error || e.error || s.error || v.error
      if (bad) { setErr(bad.message || 'ошибка'); return }
      setDaily(d.data || []); setExits(e.data || []); setScreens(s.data || []); setVisits(v.data || [])
    })
    return () => { alive = false }
  }, [days])

  const openVisit = async id => {
    if (openSess === id) { setOpenSess(null); return }
    setOpenSess(id); setPath(null)
    const { data } = await supabase.rpc('app_session', { sess: id })
    setPath(data || [])
  }

  // Сумма по выбранному периоду (из посуточной таблицы).
  // Строки только за последние `days` суток (по дате, а не по позиции: день
  // без единого захода в таблице отсутствует).
  const cutoff = (() => { const d = new Date(); d.setDate(d.getDate() - days + 1); return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' }) })()
  const rowsInPeriod = (daily || []).filter(r => String(r.day) >= cutoff)
  const sum = k => rowsInPeriod.reduce((a, r) => a + Number(r[k] || 0), 0)
  const today = rowsInPeriod[0]
  const fmtT = iso => new Date(iso).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
  const fmtD = iso => new Date(iso).toLocaleDateString('ru', { day: 'numeric', month: 'short' })
  const dur = (a, b) => { const s = Math.round((new Date(b) - new Date(a)) / 1000); return s < 60 ? `${s} с` : `${Math.round(s / 60)} мин` }

  const funnel = [
    ['Зашли', sum('visitors')],
    ['Видели лендинг', sum('landing')],
    ['Посмотрели изнутри', sum('looked')],
    ['Открыли оплату', sum('plans')],
    ['Зарегистрировались', sum('signups')],
    ['Ушли на оплату', sum('pay_start')],
    ['Оплатили', sum('pay_done')],
  ]
  const fMax = funnel[0][1]
  const exTotal = (exits || []).reduce((a, r) => a + Number(r.sessions), 0)
  const scMax = Math.max(0, ...(screens || []).map(r => Number(r.people)))

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: TXT }}>Посещаемость</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {PERIODS.map(([d, l]) => (
            <button key={d} onClick={() => setDays(d)} style={{
              fontSize: 12, padding: '5px 11px', borderRadius: 20, cursor: 'pointer', minHeight: 'unset',
              border: `1px solid ${days === d ? PUR : HAIR}`, background: days === d ? `${PUR}22` : SURF2, color: days === d ? ACCENT2 : TXT2,
            }}>{l}</button>
          ))}
        </div>
      </div>

      {err && <div style={{ fontSize: 13, color: DANGER, marginBottom: 10 }}>Не загрузилось: {err}</div>}
      {!daily && !err && <div style={{ fontSize: 13, color: TXT3 }}>Загрузка…</div>}

      {daily && (<>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
          <Tile v={sum('visitors')} l={days === 1 ? 'Зашли сегодня' : 'Зашли (людей)'} />
          <Tile v={sum('new_visitors')} l="Из них новых" c={TEA} />
          <Tile v={sum('sessions')} l="Заходов" c={TXT2} />
          <Tile v={sum('signups')} l="Регистраций" c={ACCENT2} />
          <Tile v={sum('pay_start')} l="Ушли на оплату" c={COR} />
          <Tile v={sum('pay_done')} l="Оплатили" c={TEA} />
        </div>
        {days === 1 && !today && <div style={{ fontSize: 12, color: TXT3, marginTop: 6 }}>Сегодня ещё никто не заходил.</div>}

        <H>Воронка за период</H>
        {funnel.map(([n, v], i) => <Bar key={n} name={n} n={v} max={fMax} total={i ? fMax : 0} c={i === funnel.length - 1 ? TEA : PUR} />)}

        <H>Где останавливаются</H>
        <div style={{ fontSize: 12, color: TXT3, marginTop: -4, marginBottom: 8 }}>Последний шаг захода, после которого человек ушёл</div>
        {exits?.length ? exits.slice(0, 10).map(r => <Bar key={r.step} name={label(r.step)} n={Number(r.sessions)} max={Number(exits[0].sessions)} total={exTotal} c={COR} />)
          : <div style={{ fontSize: 12.5, color: TXT3 }}>Нет данных</div>}

        <H>Куда ходят</H>
        {screens?.length ? screens.slice(0, 15).map(r => <Bar key={r.step} name={label(r.step)} n={Number(r.people)} max={scMax} />)
          : <div style={{ fontSize: 12.5, color: TXT3 }}>Нет данных</div>}

        <H>По дням</H>
        <div style={{ overflowX: 'auto', background: SURF, border: `1px solid ${HAIR}`, borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, color: TXT2, whiteSpace: 'nowrap' }}>
            <thead><tr style={{ color: TXT3, textAlign: 'right' }}>
              {['', 'Зашли', 'Новые', 'Рег.', 'К опл.', 'Опл.'].map((h, i) => <th key={i} style={{ padding: '8px 10px', fontWeight: 600, textAlign: i ? 'right' : 'left' }}>{h}</th>)}
            </tr></thead>
            <tbody>{daily.map(r => (
              <tr key={r.day} style={{ borderTop: `1px solid ${HAIR}`, textAlign: 'right' }}>
                <td style={{ padding: '7px 10px', textAlign: 'left', color: TXT }}>{fmtD(r.day)}</td>
                <td style={{ padding: '7px 10px', color: TXT, fontWeight: 700 }}>{r.visitors}</td>
                <td style={{ padding: '7px 10px', color: TEA }}>{r.new_visitors}</td>
                <td style={{ padding: '7px 10px' }}>{r.signups}</td>
                <td style={{ padding: '7px 10px' }}>{r.pay_start}</td>
                <td style={{ padding: '7px 10px', color: TEA, fontWeight: 700 }}>{r.pay_done}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>

        <H>Последние заходы</H>
        <div style={{ fontSize: 12, color: TXT3, marginTop: -4, marginBottom: 8 }}>Нажми на заход — увидишь весь путь по шагам</div>
        {(visits || []).map(v => (
          <div key={v.session_id} style={{ background: SURF, border: `1px solid ${HAIR}`, borderRadius: 12, marginBottom: 7, overflow: 'hidden' }}>
            <div onClick={() => openVisit(v.session_id)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', cursor: 'pointer' }}>
              <span style={{ fontSize: 12, color: TXT3, width: 74, flexShrink: 0 }}>{fmtD(v.started)} {fmtT(v.started)}</span>
              {v.is_new && <span style={{ fontSize: 10.5, fontWeight: 800, color: TEA, background: `${TEA}18`, borderRadius: 6, padding: '1px 6px', flexShrink: 0 }}>новый</span>}
              {v.registered && <span style={{ fontSize: 10.5, fontWeight: 800, color: ACCENT2, background: `${PUR}22`, borderRadius: 6, padding: '1px 6px', flexShrink: 0 }}>с аккаунтом</span>}
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: TXT2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right' }}>→ {label(v.last_step)}</span>
              <span style={{ fontSize: 11.5, color: TXT3, flexShrink: 0 }}>{v.steps} ш · {dur(v.started, v.ended)}</span>
            </div>
            {openSess === v.session_id && (
              <div style={{ borderTop: `1px solid ${HAIR}`, padding: '8px 12px 10px' }}>
                {!path ? <div style={{ fontSize: 12, color: TXT3 }}>Загрузка…</div> : path.map((p, i) => {
                  const step = p.name === 'screen' ? `screen:${p.props?.name}` : p.name === 'paywall' ? `paywall:${p.props?.where}` : p.name
                  const extra = p.props && p.name !== 'screen' && p.name !== 'paywall'
                    ? Object.entries(p.props).map(([k, val]) => `${k}: ${val}`).join(', ') : ''
                  return (
                    <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12.5, padding: '3px 0', color: TXT2 }}>
                      <span style={{ color: TXT3, width: 42, flexShrink: 0 }}>{fmtT(p.ts)}</span>
                      <span style={{ color: TXT }}>{label(step)}</span>
                      {extra && <span style={{ color: TXT3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{extra}</span>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </>)}
    </div>
  )
}
