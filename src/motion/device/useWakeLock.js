import { useEffect } from 'react'
import { logEvent } from '../debug/logShipper.js'

/**
 * Не даёт экрану гаснуть, пока человек тренируется.
 *
 * ОДИН ЛОК НА ВЕСЬ РАЗДЕЛ, А НЕ ПО ОДНОМУ НА ЭКРАН. Во время подхода
 * смонтированы сразу два-три экрана (сессия, тренировка, игра), и каждый честно
 * просил свой лок. Экран от этого не держался крепче — система и так гасит его
 * последним, — зато в журнале на одно снятие приходило по две строки, и
 * «wakelock.lost два раза за тренировку» читалось как два срыва. Счётчик
 * ссылок: первый экран берёт лок, последний отпускает.
 *
 * ЧЕСТНОЕ ИМЯ СОБЫТИЯ. Система снимает лок при сворачивании вкладки — это не
 * срыв, а штатная работа, и `wakelock.lost` о ней врал. Полевой разбор двух
 * сессий: обе строки пришли через 26–28 с после последнего блока, ровно вместе
 * с page.hidden, то есть экран во время подхода не гас ни разу. Теперь такое
 * снятие называется `wakelock.paused`, а `wakelock.lost` остаётся за тем, ради
 * чего заводился: лок сняли, а человек СМОТРИТ на экран. Погасший посреди
 * подхода экран человек объясняет как «игра зависла», и по журналу это не
 * отличить от настоящего зависания, если промолчать.
 *
 * Screen Wake Lock есть не везде (Safari < 16.4, часть Android-браузеров) —
 * там просто ничего не делаем, без ошибок и предупреждений пользователю.
 */

/** Сколько экранов сейчас просят держать экран включённым. */
let holders = 0
/** Живой лок, один на всех. */
let sentinel = null
/** Запрос в полёте: без него два экрана в один кадр возьмут по локу. */
let pending = null
/** Отпускаем сами — снятие ожидаемо, в журнал не идёт. */
let releasing = false

const visible = () => globalThis.document?.visibilityState === 'visible'

async function acquire() {
  if (sentinel || pending || !holders || !visible()) return
  if (!globalThis.navigator?.wakeLock?.request) return
  try {
    pending = globalThis.navigator.wakeLock.request('screen')
    const got = await pending
    // пока ждали, последний экран успел уйти — лок уже не нужен
    if (!holders) {
      releasing = true
      got.release?.().catch(() => {})
      return
    }
    sentinel = got
    // новый лок взят — прошлое снятие отыграно, флаг не должен пережить его
    releasing = false
    got.addEventListener?.('release', () => {
      // мог сработать на ПРОШЛОМ локе, когда новый уже взят
      if (sentinel !== got) return
      sentinel = null
      if (releasing) {
        releasing = false
        return
      }
      logEvent(visible() ? 'wakelock.lost' : 'wakelock.paused', {})
    })
  } catch {
    // отказ браузера или системы — молча живём дальше
  } finally {
    pending = null
  }
}

function onVisibility() {
  if (visible()) acquire()
}

export function useWakeLock(active) {
  useEffect(() => {
    if (!active) return undefined

    holders += 1
    if (holders === 1) globalThis.document?.addEventListener('visibilitychange', onVisibility)
    acquire()

    return () => {
      holders -= 1
      if (holders > 0) return
      globalThis.document?.removeEventListener('visibilitychange', onVisibility)
      if (sentinel) {
        releasing = true
        sentinel.release?.().catch(() => {})
        sentinel = null
      }
    }
  }, [active])
}

/** Только для тестов: разобрать общее состояние между прогонами. */
export function resetWakeLock() {
  holders = 0
  sentinel = null
  pending = null
  releasing = false
  globalThis.document?.removeEventListener('visibilitychange', onVisibility)
}
