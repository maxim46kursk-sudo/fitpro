/**
 * Лучший счёт. Единственное, что модуль вообще где-то сохраняет: сессии живут
 * в памяти и исчезают с перезагрузкой, а рекорд — то, ради чего человек
 * возвращается завтра. Хранится на устройстве, никуда не отправляется.
 *
 * Хранилище — через src/motion/storage.js: там же и ответ на приватный режим
 * Safari, где localStorage бросает на запись. Не сохранилось — рекорд живёт до
 * конца сессии; это дешевле упавшей игры.
 */

import { KEYS, readRaw, remove, writeRaw } from '../storage.js'

const STORAGE_KEY = KEYS.best

export function readBest() {
  const value = Number(readRaw(STORAGE_KEY))
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Записать результат раунда.
 * @returns {{best: number, isRecord: boolean}} рекорд после раунда и был ли он побит
 */
export function submitScore(score) {
  const previous = readBest()
  if (!Number.isFinite(score) || score <= previous) {
    return { best: previous, isRecord: false }
  }
  // не сохранилось — покажем рекорд хотя бы в этой сессии
  writeRaw(STORAGE_KEY, String(score))
  return { best: score, isRecord: true }
}

export function resetBest() {
  remove(STORAGE_KEY)
}
