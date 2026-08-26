/**
 * ГДЕ ИМЕННО ОТКРЫТ РАЗДЕЛ — браузер, встроенный он или обычный, и можно ли
 * тут вообще спрашивать камеру.
 *
 * Зачем понадобилось. Разбор журнала за август: 58 сессий встали сразу после
 * `model.ready` — ни `camera.ready`, ни `camera.error`. По журналу их нельзя
 * было отличить друг от друга, потому что в нём не было ни одного поля про
 * обстановку: только строка user agent в `session.start`, которую никто не
 * разбирал. Разбор пришлось делать задним числом и вручную.
 *
 * ЧТО ЭТО НЕ ЛЕЧИТ. Те 58 сессий встроенными браузерами НЕ БЫЛИ: 42 обычный
 * Safari, 10 Chrome на iOS, 5 настольный Chrome и ровно один Instagram. Их
 * причина другая (камера там не спрашивалась вовсе — см. `camera.off` в
 * index.jsx). Этот модуль нужен для другого: чтобы следующая такая же строка
 * в журнале читалась сразу, а тот единственный человек из Instagram получил
 * внятный ответ вместо чёрного экрана.
 *
 * ПОЧЕМУ ПО user agent, А НЕ ПРОБОЙ. Проба — это и есть вызов getUserMedia, и
 * внутри Instagram он не отвечает ничем: ни успехом, ни отказом. Единственное,
 * что известно ДО вызова, — строка, которую приложение само о себе пишет.
 * Поэтому эвристика, и поэтому она осторожная: ошибиться в сторону «обычный
 * браузер» безопасно (человек увидит обычный ход), ошибиться в сторону
 * «встроенный» — значит зря напугать того, у кого всё работает.
 */

/**
 * Встроенные браузеры, у которых на iOS нет доступа к камере из веб-страницы.
 *
 * Строки взяты ИЗ НАШЕГО ЖУРНАЛА, а не из статьи в интернете: Instagram —
 * реальная строка сессии от 25 августа (см. browserEnv.test.js). Остальные
 * добавлены по тем же меткам, которые эти приложения ставят много лет:
 * FBAN/FBAV — Facebook и Messenger, VKAndroidApp — клиент VK.
 */
const IN_APP = [
  { re: /Instagram/i, name: 'Instagram' },
  { re: /FBAN|FBAV|FB_IAB|FBIOS|FBMD/i, name: 'Facebook' },
  { re: /VKAndroidApp|com\.vk\.|VKClient/i, name: 'VK' },
  { re: /TikTok|musical_ly|BytedanceWebview/i, name: 'TikTok' },
  { re: /OKApp|ru\.ok\.android/i, name: 'Одноклассники' },
  /**
   * Telegram НА ANDROID открывает ссылки в своём webview и метку ставит; на
   * iOS он отдаёт страницу системному Safari, и там всё работает. Ловим только
   * то, что подписалось само, — гадать по остальному нельзя.
   */
  { re: /TelegramWebview|Telegram-Android/i, name: 'Telegram' },
]

/** Обычные браузеры. Порядок значим: CriOS и YaBrowser тоже содержат Safari. */
const BROWSERS = [
  { re: /YaBrowser/i, name: 'Яндекс.Браузер' },
  { re: /CriOS/i, name: 'Chrome (iOS)' },
  { re: /FxiOS/i, name: 'Firefox (iOS)' },
  { re: /EdgiOS|EdgA?\//i, name: 'Edge' },
  { re: /SamsungBrowser/i, name: 'Samsung Internet' },
  { re: /OPR\/|Opera/i, name: 'Opera' },
  { re: /Firefox/i, name: 'Firefox' },
  { re: /Chrome\//i, name: 'Chrome' },
  { re: /Safari\//i, name: 'Safari' },
]

/**
 * Обобщённый признак чужого webview на Android: система дописывает `; wv)` в
 * строку любого приложения, которое показывает страницу внутри себя. Имя
 * приложения при этом неизвестно, и врать про него не надо.
 */
const ANDROID_WV = /;\s*wv\)|\bWebView\b/i

/**
 * Что за браузер и встроенный ли он.
 *
 * @param {string} [ua] строка user agent; по умолчанию — текущая
 * @returns {{name: string, inApp: boolean, app: string|null, ios: boolean}}
 */
export function browserOf(ua = globalThis.navigator?.userAgent || '') {
  const s = String(ua || '')
  const ios = /iPhone|iPad|iPod/i.test(s)

  for (const { re, name } of IN_APP) {
    if (re.test(s)) return { name, inApp: true, app: name, ios }
  }
  if (ANDROID_WV.test(s)) {
    return { name: 'встроенный браузер', inApp: true, app: null, ios }
  }
  for (const { re, name } of BROWSERS) {
    if (re.test(s)) return { name, inApp: false, app: null, ios }
  }
  return { name: s ? 'неизвестный браузер' : '—', inApp: false, app: null, ios }
}

/**
 * ЗАБЛОКИРОВАНА ЛИ КАМЕРА САМИМ БРАУЗЕРОМ — до всякой попытки её спросить.
 *
 * Правда здесь ровно одна и только про iOS: доступ к камере из веб-страницы
 * там отдан исключительно Safari и браузерам с его движком, а встроенный
 * webview приложения его не получает — getUserMedia в нём не отвечает вовсе.
 * На Android встроенные браузеры камеру обычно отдают (приложение может и не
 * дать разрешение, но тогда придёт честный отказ, а не тишина), поэтому пугать
 * там заранее нельзя.
 *
 * @param {string} [ua]
 * @returns {boolean}
 */
export function cameraBlockedByBrowser(ua = globalThis.navigator?.userAgent || '') {
  const b = browserOf(ua)
  return b.inApp && b.ios
}

/**
 * Обстановка для журнала. Одной строкой отвечает на вопросы, которые в августе
 * пришлось выяснять перебором: какой браузер, встроенный ли, защищено ли
 * соединение и существует ли вообще то, что мы собираемся звать.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Самой строки user agent: она уже уезжает в `session.start`
 * один раз за сессию, и дублировать её в каждом событии значит платить за одно
 * и то же место в буфере по несколько раз.
 */
export function cameraEnv(ua = globalThis.navigator?.userAgent || '') {
  const b = browserOf(ua)
  return {
    браузер: b.name,
    webview: b.inApp,
    ios: b.ios,
    secure: typeof window === 'undefined' ? null : !!window.isSecureContext,
    /**
     * Есть ли вообще API. Отдельным полем, потому что «нет mediaDevices» и
     * «есть, но молчит» — две разные поломки с разным лечением, а в журнале
     * они до сих пор выглядели одинаково: пустотой.
     */
    api: typeof navigator === 'undefined' ? null : !!navigator.mediaDevices?.getUserMedia,
  }
}
