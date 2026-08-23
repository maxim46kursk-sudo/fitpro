/**
 * ИМЯ ОТЛАДОЧНОГО КЛЮЧА — отдельным модулем, без React и без панели.
 *
 * Раньше константа жила в `DebugPanel.jsx`. Пока её читала только сама панель,
 * это было честно; теперь тот же ключ решает, публиковать ли список летящих
 * мишеней (`liveTargets.js`), а тот модуль тянется из экрана боя. Импортируй он
 * панель — в бой уехала бы вся панель со своими ползунками и компонентами
 * ровно ради одной строки.
 *
 * Своё имя, а не общее `debug`: у хозяина приложения свой отладочный ключ, и
 * его нажатие не должно открывать поверх боевого экрана ползунки порогов
 * судейства.
 */
export const DEBUG_PARAM = 'motion-debug'

/**
 * Стоит ли ключ в адресе.
 *
 * `?motion-debug=0` выключает явно — этим гасят отладку, не переписывая адрес
 * целиком. Хеш `#motion-debug` остаётся вторым входом, но внутри FitPro на него
 * полагаться нельзя: хозяин переписывает адрес на старте и хеш теряется.
 *
 * @returns {boolean|null} true/false — сказано явно; null — в адресе ничего нет
 */
export function readDebugParam() {
  try {
    const search = new URLSearchParams(globalThis.location?.search || '')
    const hash = (globalThis.location?.hash || '').toLowerCase()
    if (search.get(DEBUG_PARAM) === '0') return false
    if (search.has(DEBUG_PARAM) || hash.includes(DEBUG_PARAM)) return true
  } catch {
    // нет location — не беда
  }
  return null
}
