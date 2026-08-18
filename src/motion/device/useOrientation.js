import { useEffect, useState } from 'react'
import { createTransitionLog } from '../debug/logShipper.js'

/**
 * Просит ли устройство повернуться в портрет.
 *
 * Оверлей «поверни телефон» имеет смысл только на телефоне: на десктопе окно
 * почти всегда шире, чем выше, и блокировать там нечего. Поэтому условие —
 * ландшафт И тач-устройство (pointer: coarse).
 */
/** Поворот пишется переходом: за один поворот приходит пачка событий resize. */
const noteOrientation = createTransitionLog(1000)

export function useLandscapeBlock() {
  const [blocked, setBlocked] = useState(() => check())

  useEffect(() => {
    const update = () => {
      const next = check()
      /**
       * ПОВОРОТ ТЕЛЕФОНА — отклонение от штатной работы: тренировка идёт в
       * портрете, а в ландшафте её закрывает оверлей. Без этой строки по логу
       * непонятно, почему человек «перестал играть» на две минуты.
       */
      noteOrientation('orientation.change', next, {
        landscape: next,
        size: typeof window === 'undefined' ? null : window.innerWidth + 'x' + window.innerHeight,
      })
      setBlocked(next)
    }

    const landscape = window.matchMedia('(orientation: landscape)')
    const coarse = window.matchMedia('(pointer: coarse)')

    landscape.addEventListener?.('change', update)
    coarse.addEventListener?.('change', update)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)

    update()

    return () => {
      landscape.removeEventListener?.('change', update)
      coarse.removeEventListener?.('change', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])

  return blocked
}

function check() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  const isLandscape = window.matchMedia('(orientation: landscape)').matches
  const isTouch = window.matchMedia('(pointer: coarse)').matches
  return isLandscape && isTouch
}
