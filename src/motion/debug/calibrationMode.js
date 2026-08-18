/**
 * Переключатель «идёт калибровка движений».
 *
 * Калибровка живёт внутри диагностической панели, а обычная логика — в корне
 * модуля, и они не видят друг друга. Пока этого переключателя не было, под
 * экраном калибровки продолжал работать автозапуск: он видел человека в кадре,
 * отсчитывал пять секунд и запускал разминку прямо посреди записи движений.
 *
 * Поэтому переключатель отдельным модулем, а не пропсом: его читает и корень
 * модуля, и панель, между которыми нет общего состояния.
 */

let calibrating = false
const subscribers = new Set()

export function isCalibrating() {
  return calibrating
}

export function setCalibrating(next) {
  const value = !!next
  if (value === calibrating) return calibrating
  calibrating = value
  for (const fn of subscribers) fn(calibrating)
  return calibrating
}

export function subscribeCalibration(fn) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/**
 * Забыть режим при закрытии раздела.
 *
 * Переключатель модульный, то есть переживает размонтирование: человек ушёл из
 * Motion с открытой калибровкой — и следующее открытие встретило бы его тем же
 * режимом, в котором ни автозапуска, ни экранов. Раньше это лечила перезагрузка
 * страницы, которой внутри FitPro больше не будет.
 *
 * Подписчиков трогать нельзя: их снимают сами компоненты в своём cleanup, а
 * чужой Set здесь — не наша забота.
 */
export function resetCalibration() {
  calibrating = false
}
