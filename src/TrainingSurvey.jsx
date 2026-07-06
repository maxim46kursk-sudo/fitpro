import { useState, useEffect } from 'react'
import { supabase } from './supabase'
import { EXERCISES } from './programs.js'

const PUR = '#7F77DD'

const EXPERIENCE_OPTIONS = [
  { key: 'novice', label: 'Новичок', sub: 'до 6 мес' },
  { key: 'medium', label: 'Средний', sub: '6мес–2 года' },
  { key: 'advanced', label: 'Опытный', sub: '2+ года' },
]

const MUSCLE_OPTIONS = ['Ноги/Ягодицы', 'Спина', 'Грудь', 'Руки', 'Плечи', 'Пресс']

const SYSTEM_INFO = {
  full: 'Всё тело за одну тренировку. Лучше для новичков и при 2-3 тренировках в неделю.',
  split: 'Разные мышцы в разные дни. Для опытных при 4+ тренировках в неделю.',
}

export default function TrainingSurvey({ onClose, onSaved }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [experience, setExperience] = useState(null)
  const [contraindications, setContraindications] = useState('')
  const [favoriteExercises, setFavoriteExercises] = useState([])
  const [focusMuscles, setFocusMuscles] = useState([])
  const [system, setSystem] = useState(null)
  const [exQuery, setExQuery] = useState('')
  const [infoPopup, setInfoPopup] = useState(null) // 'full' | 'split' | null

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setLoading(false); return }
      const { data } = await supabase.from('training_survey').select('*').eq('user_id', user.id).single()
      if (data) {
        setExperience(data.experience || null)
        setContraindications(data.contraindications || '')
        setFavoriteExercises(data.favorite_exercises || [])
        setFocusMuscles(data.focus_muscles || [])
        setSystem(data.system || null)
      }
      setLoading(false)
    })()
  }, [])

  const toggleFavorite = (name) => {
    setFavoriteExercises(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name])
  }
  const toggleMuscle = (m) => {
    setFocusMuscles(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m])
  }

  const selectExperience = (key) => {
    setExperience(key)
    if (key === 'novice') setSystem('full')
  }

  const canSave = !!experience && !!system

  const save = async () => {
    if (!canSave || saving) return
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setSaving(false); return }
    const { error } = await supabase.from('training_survey').upsert({
      user_id: user.id,
      experience,
      contraindications: contraindications.trim() || null,
      favorite_exercises: favoriteExercises,
      focus_muscles: focusMuscles,
      system,
      updated_at: new Date().toISOString(),
    })
    setSaving(false)
    if (error) { console.error('Ошибка сохранения анкеты:', error); return }
    if (onSaved) onSaved()
    onClose()
  }

  const filteredEx = EXERCISES.filter(e => e.n.toLowerCase().includes(exQuery.toLowerCase()))

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1300, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#fff', borderRadius: '18px 18px 0 0', width: '100%', maxWidth: 520,
        maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 -8px 30px rgba(0,0,0,0.2)',
      }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: '#111' }}>Анкета тренировок</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, color: '#9ca3af', cursor: 'pointer', lineHeight: 1, padding: 0, minHeight: 'unset' }}>✕</button>
        </div>

        {loading ? (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Загрузка...</div>
        ) : (
          <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>

            {/* Стаж */}
            <div style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#111', marginBottom: 10 }}>Стаж тренировок</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {EXPERIENCE_OPTIONS.map(o => (
                  <button key={o.key} onClick={() => selectExperience(o.key)}
                    style={{
                      flex: '1 1 auto', minWidth: 100, padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                      border: experience === o.key ? `1.5px solid ${PUR}` : '1.5px solid #e5e7eb',
                      background: experience === o.key ? `${PUR}11` : '#fff', textAlign: 'center',
                    }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: experience === o.key ? PUR : '#111' }}>{o.label}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{o.sub}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Противопоказания */}
            <div style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#111', marginBottom: 10 }}>Есть ли противопоказания?</div>
              <textarea value={contraindications} onChange={e => setContraindications(e.target.value)}
                placeholder="Травмы, ограничения... можно оставить пустым" rows={3}
                style={{ width: '100%', padding: '10px 12px', fontSize: 13, borderRadius: 10, border: '1.5px solid #e5e7eb', outline: 'none', color: '#111', fontFamily: 'inherit', resize: 'none', boxSizing: 'border-box' }}
                onFocus={e => e.target.style.borderColor = PUR} onBlur={e => e.target.style.borderColor = '#e5e7eb'} />
            </div>

            {/* Любимые упражнения */}
            <div style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#111', marginBottom: 10 }}>
                Любимые упражнения {favoriteExercises.length > 0 && <span style={{ color: PUR, fontWeight: 500 }}>({favoriteExercises.length})</span>}
              </div>
              <input value={exQuery} onChange={e => setExQuery(e.target.value)} placeholder="Поиск упражнения..."
                style={{ width: '100%', padding: '9px 12px', fontSize: 13, borderRadius: 9, border: '1.5px solid #e5e7eb', outline: 'none', color: '#111', marginBottom: 8, boxSizing: 'border-box' }}
                onFocus={e => e.target.style.borderColor = PUR} onBlur={e => e.target.style.borderColor = '#e5e7eb'} />
              <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid #f3f4f6', borderRadius: 10 }}>
                {filteredEx.length === 0 && <div style={{ padding: 14, textAlign: 'center', color: '#c7cad1', fontSize: 12 }}>Ничего не найдено</div>}
                {filteredEx.map((ex, i) => {
                  const on = favoriteExercises.includes(ex.n)
                  return (
                    <button key={i} onClick={() => toggleFavorite(ex.n)}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '9px 12px', border: 'none', borderTop: i > 0 ? '1px solid #f3f4f6' : 'none', background: on ? `${PUR}0d` : 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                      <div>
                        <span style={{ fontSize: 13, color: '#111' }}>{ex.n}</span>
                        <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 6 }}>{ex.m}</span>
                      </div>
                      <span style={{ fontSize: 14, color: on ? PUR : '#d1d5db' }}>{on ? '✓' : '+'}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Акцент на мышцы */}
            <div style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#111', marginBottom: 10 }}>Акцент на мышцы</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {MUSCLE_OPTIONS.map(m => {
                  const on = focusMuscles.includes(m)
                  return (
                    <button key={m} onClick={() => toggleMuscle(m)}
                      style={{ padding: '8px 14px', borderRadius: 20, cursor: 'pointer', fontSize: 12.5, fontWeight: on ? 600 : 400,
                        border: on ? `1.5px solid ${PUR}` : '1.5px solid #e5e7eb', background: on ? `${PUR}11` : '#fff', color: on ? PUR : '#6b7280' }}>
                      {m}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Система тренировок */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#111', marginBottom: 10 }}>Система тренировок</div>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 1, position: 'relative' }}>
                  <button onClick={() => setSystem('full')}
                    style={{ width: '100%', padding: '12px 10px', borderRadius: 10, cursor: 'pointer', textAlign: 'center',
                      border: system === 'full' ? `1.5px solid ${PUR}` : '1.5px solid #e5e7eb', background: system === 'full' ? `${PUR}11` : '#fff' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: system === 'full' ? PUR : '#111' }}>Фулбади</span>
                  </button>
                  <button onClick={() => setInfoPopup(infoPopup === 'full' ? null : 'full')}
                    style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%', border: 'none', background: '#9ca3af', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'unset' }}>!</button>
                </div>
                <div style={{ flex: 1, position: 'relative' }}>
                  <button onClick={() => experience !== 'novice' && setSystem('split')} disabled={experience === 'novice'}
                    style={{ width: '100%', padding: '12px 10px', borderRadius: 10, textAlign: 'center',
                      cursor: experience === 'novice' ? 'not-allowed' : 'pointer',
                      opacity: experience === 'novice' ? 0.45 : 1,
                      border: system === 'split' ? `1.5px solid ${PUR}` : '1.5px solid #e5e7eb', background: system === 'split' ? `${PUR}11` : '#fff' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: system === 'split' ? PUR : '#111' }}>Сплит</span>
                  </button>
                  <button onClick={() => setInfoPopup(infoPopup === 'split' ? null : 'split')}
                    style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%', border: 'none', background: '#9ca3af', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'unset' }}>!</button>
                </div>
              </div>
              {infoPopup && (
                <div style={{ marginTop: 8, padding: '9px 12px', borderRadius: 9, background: '#f9fafb', border: '1px solid #f0f0f0', fontSize: 12, color: '#6b7280', lineHeight: 1.5 }}>
                  {SYSTEM_INFO[infoPopup]}
                </div>
              )}
              {experience === 'novice' && (
                <div style={{ marginTop: 8, fontSize: 12, color: PUR }}>Начинающим рекомендуется Фулбади</div>
              )}
            </div>
          </div>
        )}

        <div style={{ padding: '14px 20px', borderTop: '1px solid #f0f0f0', flexShrink: 0 }}>
          <button onClick={save} disabled={!canSave || saving}
            style={{ width: '100%', padding: '13px', borderRadius: 12, border: 'none', fontSize: 14, fontWeight: 700, color: '#fff',
              background: canSave ? PUR : '#d1d5db', cursor: canSave && !saving ? 'pointer' : 'default' }}>
            {saving ? 'Сохранение...' : 'Сохранить анкету'}
          </button>
        </div>
      </div>
    </div>
  )
}
