import { useEffect } from 'react'
import { logEvent } from '../debug/logShipper.js'

/**
 * Не даёт экрану гаснуть, пока идёт подход.
 *
 * Screen Wake Lock есть не везде (Safari < 16.4, часть Android-браузеров) —
 * там просто ничего не делаем, без ошибок и предупреждений пользователю.
 * Система снимает лок при сворачивании вкладки, поэтому перезапрашиваем
 * его на visibilitychange.
 */
export function useWakeLock(active) {
  useEffect(() => {
    if (!active || !navigator.wakeLock?.request) return undefined

    let sentinel = null
    let released = false

    const acquire = async () => {
      if (released || document.visibilityState !== 'visible') return
      try {
        sentinel = await navigator.wakeLock.request('screen')
        sentinel.addEventListener?.('release', () => {
          sentinel = null
          /**
           * Лок сняли не мы. Дальше экран волен погаснуть посреди подхода, а
           * погасший экран человек объясняет как «игра зависла» — по логу это
           * не отличить от настоящего зависания, если промолчать здесь.
           */
          if (!released) logEvent('wakelock.lost', { visibility: document.visibilityState })
        })
      } catch {
        // отказ браузера/системы — молча живём дальше
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !sentinel) acquire()
    }

    acquire()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      released = true
      document.removeEventListener('visibilitychange', onVisibility)
      sentinel?.release?.().catch(() => {})
      sentinel = null
    }
  }, [active])
}
