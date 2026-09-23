import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase, SUPABASE_URL, SUPABASE_KEY } from './supabase.js'
import { track } from './track.js'
import { BG, SURF, SURF2, HAIR, TXT, TXT2, TXT3, PUR, ACCENT2, TEA, DANGER } from './theme.js'

/**
 * ВИДЕО-ОТЧЁТ ТРЕНЕРУ (ZMClub, сент 2026).
 *
 * Человек не уходит из тренировки: видео грузится прямо отсюда, с полосой
 * загрузки, и сервер сам публикует его в теме «Отчёты» группы клуба
 * (api/club-chat.js, action=report). Ответ тренера придёт в Телеграм от бота и
 * появится в «Прогресс → Мои отчёты».
 *
 * Два шага, и оба видны на полосе:
 *   1. файл уходит в хранилище (Supabase Storage, бакет club-reports) — XHR,
 *      потому что только он даёт настоящий процент загрузки;
 *   2. сервер забирает его оттуда и отправляет в Телеграм — это уже без
 *      процентов, «Отправляем тренеру…».
 * Хранилище посередине не случайно: Телеграм до нашего сервера достучаться не
 * может, а заливать 50 МБ через одну ручку упёрлось бы в её таймаут.
 */

export const REPORT_MAX_MB = 50   // потолок Telegram для ботов

function uploadWithProgress(url, file, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v))
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error(`хранилище ответило ${xhr.status}`))
    xhr.onerror = () => reject(new Error('нет связи'))
    xhr.ontimeout = () => reject(new Error('слишком долго'))
    xhr.timeout = 10 * 60 * 1000
    xhr.send(file)
  })
}

export default function ClubReportSheet({ exercise, setInfo, program, onClose }) {
  const fileRef = useRef(null)
  const [file, setFile] = useState(null)
  const [note, setNote] = useState('')
  const [phase, setPhase] = useState('pick') // pick | upload | send | done | error
  const [pct, setPct] = useState(0)
  const [err, setErr] = useState('')
  const [tgLinked, setTgLinked] = useState(true)

  useEffect(() => { track('screen', { name: 'report_open' }, '/report') }, [])

  const pick = e => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (f.size > REPORT_MAX_MB * 1024 * 1024) {
      setErr(`Видео ${Math.round(f.size / 1048576)} МБ — больше ${REPORT_MAX_MB} МБ. Обрежь его или сними короче (до 30–40 секунд).`)
      setFile(null); return
    }
    setErr(''); setFile(f)
  }

  const send = async () => {
    if (!file || phase === 'upload' || phase === 'send') return
    setErr(''); setPhase('upload'); setPct(0)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const uid = session?.user?.id
      if (!token || !uid) throw new Error('перезайди в приложение')
      const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'mp4'
      const path = `${uid}/${Date.now()}.${ext}`
      await uploadWithProgress(
        `${SUPABASE_URL}/storage/v1/object/club-reports/${path}`, file,
        { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY, 'Content-Type': file.type || 'video/mp4', 'x-upsert': 'false' },
        p => setPct(p),
      )
      setPhase('send')
      const res = await fetch('/api/club-chat?action=report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ path, exercise, setInfo, program, note: note.trim().slice(0, 300) }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body?.ok) throw new Error(body?.error || `сервер ответил ${res.status}`)
      setTgLinked(!!body.tgLinked)
      track('screen', { name: 'report_sent' }, '/report')
      setPhase('done')
    } catch (e) {
      track('error_shown', { kind: 'report' }, '/report')
      setErr(`Не отправилось: ${e.message}. Попробуй ещё раз.`)
      setPhase('error')
    }
  }

  const busy = phase === 'upload' || phase === 'send'
  const barPct = phase === 'send' ? 100 : Math.round(pct * 100)

  return createPortal(
    <div onClick={busy ? undefined : onClose} style={{ position: 'fixed', inset: 0, zIndex: 1500, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <style>{`@keyframes crStripe{to{background-position:40px 0}}@keyframes crPop{0%{transform:scale(.6);opacity:0}70%{transform:scale(1.08)}100%{transform:scale(1);opacity:1}}`}</style>
      <div onClick={e => e.stopPropagation()} style={{ background: SURF, borderRadius: '18px 18px 0 0', width: '100%', maxWidth: 500, padding: '18px 18px 26px', color: TXT }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: SURF2, margin: '0 auto 14px' }} />

        {phase === 'done' ? (
          <div style={{ textAlign: 'center', padding: '8px 4px 4px' }}>
            <div style={{ width: 64, height: 64, borderRadius: '50%', background: `${TEA}22`, border: `2px solid ${TEA}`, color: TEA, fontSize: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', animation: 'crPop .45s ease-out' }}>✓</div>
            <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>Отчёт отправлен тренеру</div>
            <div style={{ fontSize: 13.5, color: TXT2, lineHeight: 1.5, marginBottom: 16 }}>
              {tgLinked
                ? 'Когда Максим ответит, бот пришлёт тебе сообщение в Телеграм. Ответ будет и в «Прогресс → Мои отчёты».'
                : 'Ответ Максима появится в «Прогресс → Мои отчёты». Вступи в чат клуба (кнопка «Чат» внизу) — тогда ответы будут приходить и в Телеграм.'}
            </div>
            <button onClick={onClose} style={{ width: '100%', padding: 14, borderRadius: 12, border: 'none', background: `linear-gradient(180deg, ${ACCENT2}, ${PUR})`, color: '#fff', fontSize: 15, fontWeight: 800, cursor: 'pointer' }}>Продолжить тренировку</button>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 4 }}>📹 Отчёт тренеру</div>
            <div style={{ fontSize: 13, color: TXT3, marginBottom: 14 }}>{exercise}{setInfo ? ` · ${setInfo}` : ''}</div>

            <input ref={fileRef} type="file" accept="video/*" onChange={pick} style={{ display: 'none' }} />
            <button disabled={busy} onClick={() => fileRef.current?.click()} style={{
              width: '100%', padding: '16px 14px', borderRadius: 14, cursor: busy ? 'default' : 'pointer',
              border: `1.5px dashed ${file ? TEA : HAIR}`, background: file ? `${TEA}10` : SURF2, color: file ? TEA : TXT2,
              fontSize: 14, fontWeight: 700, textAlign: 'center', marginBottom: 10,
            }}>
              {file ? `🎬 ${file.name.length > 28 ? file.name.slice(0, 25) + '…' : file.name} · ${(file.size / 1048576).toFixed(1)} МБ` : 'Снять видео или выбрать из галереи'}
            </button>

            <textarea disabled={busy} value={note} onChange={e => setNote(e.target.value)} placeholder="Вопрос тренеру (необязательно)" rows={2}
              style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 12, border: `1.5px solid ${HAIR}`, background: SURF2, color: TXT, fontSize: 14, resize: 'none', marginBottom: 12, fontFamily: 'inherit' }} />

            {busy && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ height: 10, borderRadius: 6, background: SURF2, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', width: `${barPct}%`, borderRadius: 6, transition: 'width .25s',
                    background: phase === 'send'
                      ? `repeating-linear-gradient(45deg, ${PUR}, ${PUR} 10px, ${ACCENT2} 10px, ${ACCENT2} 20px)`
                      : `linear-gradient(90deg, ${ACCENT2}, ${PUR})`,
                    backgroundSize: phase === 'send' ? '40px 100%' : undefined,
                    animation: phase === 'send' ? 'crStripe .8s linear infinite' : undefined,
                  }} />
                </div>
                <div style={{ fontSize: 12.5, color: TXT2, marginTop: 6, textAlign: 'center' }}>
                  {phase === 'upload' ? `Загружаем видео… ${barPct}%` : 'Отправляем тренеру…'}
                </div>
              </div>
            )}

            {err && <div style={{ fontSize: 13, color: DANGER, background: 'rgba(255,69,58,.1)', border: '1px solid rgba(255,69,58,.35)', borderRadius: 10, padding: '9px 12px', marginBottom: 12, lineHeight: 1.45 }}>{err}</div>}

            <button onClick={send} disabled={!file || busy} style={{
              width: '100%', padding: 14, borderRadius: 12, border: 'none', cursor: !file || busy ? 'default' : 'pointer',
              background: `linear-gradient(180deg, ${ACCENT2}, ${PUR})`, color: '#fff', fontSize: 15, fontWeight: 800,
              opacity: !file || busy ? 0.5 : 1,
            }}>{busy ? 'Отправляется…' : 'Отправить отчёт'}</button>
            {!busy && <button onClick={onClose} style={{ width: '100%', marginTop: 8, padding: 10, border: 'none', background: 'none', color: TXT3, fontSize: 14, cursor: 'pointer' }}>Отмена</button>}
            {busy && <div style={{ fontSize: 11.5, color: TXT3, textAlign: 'center', marginTop: 8 }}>Не закрывай приложение до конца отправки</div>}
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

/** «Прогресс → Мои отчёты»: список отправленных видео и ответы тренера. */
export function MyReports({ onBack }) {
  const [rows, setRows] = useState(null)
  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data } = await supabase.from('club_reports')
        .select('id, exercise, set_info, note, created_at, answered_at, reply_text, seen_at')
        .order('created_at', { ascending: false }).limit(50)
      if (!alive) return
      setRows(data || [])
      const unseen = (data || []).filter(r => r.answered_at && !r.seen_at).map(r => r.id)
      if (unseen.length) await supabase.from('club_reports').update({ seen_at: new Date().toISOString() }).in('id', unseen)
    })()
    return () => { alive = false }
  }, [])
  const fmt = iso => new Date(iso).toLocaleDateString('ru', { day: 'numeric', month: 'long' })
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: BG, zIndex: 1000, display: 'flex', flexDirection: 'column', color: TXT }}>
      <div style={{ background: SURF, borderBottom: `1px solid ${HAIR}`, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button data-back="1" onClick={onBack} style={{ background: 'none', border: 'none', color: TXT3, fontSize: 22, cursor: 'pointer', padding: 0, minHeight: 'unset' }}>‹</button>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Мои отчёты</div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px 40px' }}>
        {rows === null ? <div style={{ color: TXT3, fontSize: 13 }}>Загрузка…</div>
          : rows.length === 0 ? (
            <div style={{ color: TXT3, fontSize: 14, textAlign: 'center', padding: '40px 10px', lineHeight: 1.6 }}>
              Отчётов пока нет.<br />Отправить видео тренеру можно прямо из тренировки — кнопка 🎥 рядом с подходом.
            </div>
          ) : rows.map(r => (
            <div key={r.id} style={{ background: SURF, border: `1px solid ${r.answered_at && !r.seen_at ? PUR : HAIR}`, borderRadius: 14, padding: '13px 14px', marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{r.exercise}</div>
                <div style={{ fontSize: 12, color: TXT3, flexShrink: 0 }}>{fmt(r.created_at)}</div>
              </div>
              {r.set_info && <div style={{ fontSize: 12.5, color: TXT3, marginTop: 2 }}>{r.set_info}</div>}
              {r.note && <div style={{ fontSize: 13, color: TXT2, marginTop: 6 }}>Твой вопрос: {r.note}</div>}
              {r.answered_at ? (
                <div style={{ marginTop: 10, background: `${PUR}14`, border: `1px solid ${PUR}40`, borderRadius: 10, padding: '9px 11px' }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: ACCENT2, marginBottom: 3 }}>Ответ Максима</div>
                  <div style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{r.reply_text || 'Ответ в чате клуба'}</div>
                </div>
              ) : (
                <div style={{ marginTop: 8, fontSize: 12.5, color: TXT3 }}>⏳ Ждёт разбора тренера</div>
              )}
            </div>
          ))}
      </div>
    </div>,
    document.body,
  )
}
