import { useEffect, useState } from 'react'
import {
  isAudioEnabled,
  setAudioEnabled,
  subscribeAudio,
  unlockAudio,
} from '../feedback/audio.js'

/** Тумблер звука в углу. Речи в модуле нет — выключает звуковые сигналы. */
export default function AudioToggle() {
  const [on, setOn] = useState(isAudioEnabled)

  useEffect(() => subscribeAudio(setOn), [])

  const toggle = () => {
    // клик — это жест пользователя, заодно разблокируем AudioContext
    unlockAudio()
    setAudioEnabled(!on)
  }

  return (
    <button
      className={`mt-corner mt-corner--right-bottom ${on ? 'is-on' : 'is-off'}`}
      onClick={toggle}
      aria-label={on ? 'Выключить звук' : 'Включить звук'}
      data-testid="audio-toggle"
      data-on={on ? '1' : '0'}
    >
      {on ? '🔊' : '🔇'}
    </button>
  )
}
