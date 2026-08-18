/**
 * ОШИБКИ КЛИЕНТА ДОЕЗЖАЮТ САМИ — как и всё остальное в логе.
 *
 * Зачем. До сих пор упавшее приложение видел только человек: на телефоне нет
 * консоли, и любая необработанная ошибка превращалась в белый экран или в
 * карточку ErrorBoundary, которую надо догадаться скопировать и переслать. На
 * челлендже догадываться будет некому: человек просто закроет вкладку и решит,
 * что игра не работает, а мы об этом не узнаем вовсе.
 *
 * ТРИ ИСТОЧНИКА, ОДНА СТРОКА. Ошибка рендера ловится ErrorBoundary, ошибка вне
 * рендера — слушателем error, забытый отказ промиса — unhandledrejection. Раньше
 * до нас не доходил ни один из трёх; теперь все три пишут `client.error` в тот
 * же лог, который и так уезжает в хранилище.
 *
 * СТЕК ОБРЕЗАН. Пятьсот символов — это верхушка стека, где и лежит виновник;
 * дальше идут кадры библиотек, одинаковые у всех падений. Целый стек с
 * минифицированными именами занял бы в буфере место десятка событий и вытеснил
 * бы контекст, ради которого лог и читают.
 *
 * ПОТОЛОК В ДВАДЦАТЬ ОШИБОК ЗА СЕССИЮ — не экономия, а условие того, что строки
 * ошибок вообще имеет смысл беречь от вытеснения. Ошибка в цикле отрисовки
 * повторяется шестьдесят раз в секунду: без потолка она за десять секунд забила
 * бы весь буфер собой, и защита «ошибки не вытесняются» уничтожила бы лог
 * вернее любого переполнения. Повторы того же падения тоже не пишутся: знать
 * надо, ЧТО упало, а не сколько раз подряд.
 *
 * ДВА ПОТОЛКА, А НЕ ОДИН — потому что слушатели висят на window, а окно внутри
 * FitPro общее. Перехватчик ловит и чужие падения: не Motion, а хозяйского
 * приложения, его сети, его виджетов. Пока Motion был всем приложением, чужих
 * ошибок не существовало вовсе. Внутри FitPro их будет подавляющее большинство,
 * и с одним общим потолком они выбрали бы его ДО того, как упадёт Motion, — то
 * есть глобальный перехват не просто шумел бы, он глушил бы собственную
 * диагностику ровно в тот заход, ради которого лог и читают.
 *
 * Поэтому у чужих падений свой маленький потолок. Совсем их не писать нельзя:
 * упавшее хозяйское приложение объясняет оборванную тренировку не хуже
 * собственной ошибки. Но занять место наших они больше не могут.
 */

import { logEvent } from './logShipper.js'

/** Сколько символов стека доезжает. Верхушка — это и есть виновник. */
export const STACK_MAX = 500
/** Сколько РАЗНЫХ СВОИХ ошибок за сессию попадает в лог. */
export const MAX_REPORTS = 20
/** Сколько чужих. Их дело — объяснить оборванный заход, а не занять весь лог. */
export const MAX_FOREIGN = 5

/**
 * Источники, которые заведомо наши: по ним зовёт код Motion, а не браузер.
 * `render` — ErrorBoundary модуля, `report` — явный вызов из его кода.
 */
const OWN_SOURCES = new Set(['render', 'report'])

let screen = 'boot'
let reported = 0
let foreignReported = 0
const seen = new Set()
let installed = false

/**
 * Наш ли стек. Подсказка, а не приговор: в разработке путь модуля в стеке виден
 * («/motion/» или «\motion\»), в собранном виде от него не остаётся ничего.
 * Поэтому на ней ничего не держится — она только повышает чужую на вид ошибку
 * до своей, когда это очевидно. Гарантию даёт разделение потолков, а не эта
 * проверка.
 */
export function isOwnStack(stack) {
  return /[/\\]motion[/\\]/.test(String(stack ?? ''))
}

/**
 * ГДЕ ЧЕЛОВЕК БЫЛ, когда упало. Без этого сообщение вроде «t is undefined»
 * не сужает поиск вообще: экранов в приложении восемь, и падать может любой.
 */
export function noteScreen(name) {
  screen = String(name || 'unknown')
}

export function currentScreen() {
  return screen
}

export function trimStack(stack) {
  const text = String(stack ?? '')
  return text.length > STACK_MAX ? `${text.slice(0, STACK_MAX)}…` : text
}

/** Один ключ на одно падение: сообщение и верхняя строка стека. */
function keyOf(message, stack) {
  return `${message}|${String(stack ?? '').split('\n')[0] ?? ''}`
}

/**
 * Записать ошибку в лог. Зовут и перехватчики, и ErrorBoundary.
 *
 * @param {unknown} error что упало
 * @param {{source?: string, screen?: string}} [extra] откуда узнали
 * @returns {boolean} записали ли (нет — повтор или исчерпан потолок)
 */
export function reportError(error, extra = {}) {
  const message = String(error?.message ?? error ?? 'неизвестная ошибка').slice(0, 300)
  const stack = trimStack(error?.stack ?? extra.stack ?? '')
  const source = extra.source ?? 'report'
  const key = keyOf(message, stack)

  const own = OWN_SOURCES.has(source) || isOwnStack(stack)
  if (seen.has(key)) return false
  if (own ? reported >= MAX_REPORTS : foreignReported >= MAX_FOREIGN) return false

  seen.add(key)
  if (own) reported += 1
  else foreignReported += 1

  logEvent('client.error', {
    message,
    stack,
    screen: extra.screen ?? screen,
    source,
    // пометка для читающего: это упало не в Motion, а вокруг него
    ...(own ? null : { foreign: true }),
  })
  return true
}

/**
 * Повесить перехватчики. Через addEventListener, а не присваиванием
 * window.onerror: последнее затирает чужой обработчик — и наш затрут так же,
 * стоит подключить модуль в хозяйское приложение (а он туда и едет целиком).
 *
 * @returns {() => void} снять перехватчики; нужен тестам и горячей перезагрузке
 */
export function installErrorReporter(target = globalThis) {
  if (installed || !target?.addEventListener) return () => {}
  installed = true

  const onError = (event) => {
    reportError(event?.error ?? { message: event?.message, stack: '' }, {
      source: 'window.error',
      // у ошибок загрузки скрипта стека нет вовсе — тогда хоть файл и строка
      stack: event?.error?.stack ?? `${event?.filename ?? ''}:${event?.lineno ?? ''}`,
    })
  }
  const onRejection = (event) => {
    const reason = event?.reason
    reportError(reason instanceof Error ? reason : { message: String(reason) }, {
      source: 'unhandledrejection',
      stack: reason?.stack ?? '',
    })
  }

  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)

  return () => {
    installed = false
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}

/**
 * Забыть потолки, повторы и экран — при КАЖДОМ открытии раздела.
 *
 * Счётчики модульные и переживают размонтирование. Пока Motion был всем
 * приложением, «за сессию» означало «до перезагрузки страницы», и это совпадало
 * с «за один заход человека». Внутри FitPro перезагрузки нет: двадцать ошибок,
 * набранных в первой тренировке, заткнули бы диагностику всех следующих за день,
 * и выглядело бы это как «лог перестал приходить».
 *
 * Флаг установки перехватчиков здесь НЕ трогается намеренно: снять слушатели
 * может только тот, кто их вешал, — деинсталлятор, который вернул
 * installErrorReporter. Сбросить флаг, не сняв слушатели, значит оставить их на
 * чужом окне навсегда.
 */
export function resetErrorReporter() {
  reported = 0
  foreignReported = 0
  seen.clear()
  screen = 'boot'
}
