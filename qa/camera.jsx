// Стенд для проверки НАСТРОЕК КАМЕРЫ в сканере штрих-кода.
//
// Монтирует настоящий BarcodeScanner — он открывается сразу на стадии 'scan',
// то есть на камере. Саму камеру не подменяем: браузер запускается с
// --use-fake-device-for-media-stream, и getUserMedia отдаёт настоящий
// MediaStream. Подменяются только НАБЛЮДАТЕЛИ поверх него, чтобы из теста было
// видно, о чём сканер попросил трек.
//
// Открывается вручную (vite dev + /qa/camera.html) и драйвером
// qa/check-camera.mjs; в бой не собирается — index.html единственная точка
// входа сборки.
import { createRoot } from 'react-dom/client'
import BarcodeScanner from '../src/BarcodeScanner.jsx'

// ?mode=plain — десктоп как он есть: ничего не трогаем, работают настоящие
//               applyConstraints и getCapabilities этого браузера;
// ?mode=fail  — ГЛАВНЫЙ СЛУЧАЙ: камера, у которой нет ни фонарика, ни
//               управления фокусом, и которая на любой applyConstraints
//               отвечает отказом. Сканер обязан работать как работал;
// ?mode=torch — камера с фонариком: проверяем кнопку и порядок гашения.
const MODE = new URLSearchParams(location.search).get('mode') || 'plain'

// Всё, что стенд подсмотрел. events — упорядоченный список: по нему видно не
// только ЧТО вызвали, но и В КАКОМ ПОРЯДКЕ (фонарик обязан гаснуть до stop()).
const cam = { gum: [], apply: [], events: [], ticks: 0, errors: [], vibrate: [], frames: [] }
window.__cam = cam

// ?catch=1 — фальшивая камера показывает тестовую картинку, а не штрих-код,
// поэтому «поимку» подсовываем через СИСТЕМНЫЙ детектор: сканер сам выбирает
// его, когда браузер такой умеет (nativeDetectorOrNull). Логику распознавания
// это не подменяет — подменяется окружение, ровно как настоящий Android Chrome.
const CATCH = new URLSearchParams(location.search).get('catch') === '1'
const CODE = '4600605034750'
if (CATCH) {
  let calls = 0
  window.BarcodeDetector = class {
    static getSupportedFormats() { return Promise.resolve(['ean_13', 'ean_8', 'upc_a', 'upc_e']) }
    // Первый тик пустой, второй отдаёт код: так проверяется и то, что до
    // поимки рамка «ищет», и сама поимка. Счётчик тиков здесь НЕ трогаем —
    // ниже detect оборачивается общим счётчиком, и второй инкремент дал бы
    // вдвое завышенные цифры.
    detect() {
      return Promise.resolve(++calls < 2 ? [] : [{ rawValue: CODE }])
    }
  }
}

// Вибрация: считаем вызовы. В mode=fail её не будет вовсе — так проверяется,
// что отсутствие API ничего не роняет (iOS Safari).
//
// Удалять надо С ПРОТОТИПА: vibrate объявлен на Navigator.prototype, у самого
// navigator такого СВОЕГО свойства нет, и `delete navigator.vibrate` тихо
// возвращает true, ничего не удалив. Первая версия стенда так и делала — и
// проверка «API отсутствует» видела function.
if (MODE === 'fail') {
  delete Navigator.prototype.vibrate
} else {
  Object.defineProperty(navigator, 'vibrate', {
    configurable: true,
    value: (...a) => { cam.vibrate.push(a[0]); return true },
  })
}

// Цвет рамки прицела на КАЖДОМ кадре отрисовки. Вспышка живёт 250 мс и
// сменяется экраном поиска — поймать её одним опросом из теста ненадёжно,
// поэтому пишем всё, что рамка успела показать, а тест смотрит на список.
;(function sampleFrame() {
  const el = document.querySelector('[data-aim-frame]')
  if (el) {
    const cs = getComputedStyle(el)
    const v = `${el.dataset.aimFrame}|${cs.borderTopColor}|${cs.backgroundColor}|${cs.animationName}`
    if (cam.frames[cam.frames.length - 1] !== v) cam.frames.push(v)
  }
  requestAnimationFrame(sampleFrame)
})()

window.addEventListener('error', e => cam.errors.push(String(e.message)))
window.addEventListener('unhandledrejection', e => cam.errors.push(`unhandled: ${e.reason}`))

// После вспышки сканер идёт искать код. Ручек /api у dev-сервера нет, и без
// подмены поиск упёрся бы в 404 — экран ошибки вместо «не найдено». Отвечаем
// «не найдено»: что показывать после поимки, этот стенд не проверяет, ему важно
// лишь, что путь доходит до конца.
const realFetch = window.fetch.bind(window)
window.fetch = async (url, opts) => {
  const u = String(url)
  if (u.includes('action=barcode')) {
    cam.events.push('lookup')
    return new Response(JSON.stringify({ found: false }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return realFetch(url, opts)
}

// Тик распознавания. Считаем и проход @zxing (рисует кадр в canvas), и
// системный BarcodeDetector — какой из них выберет браузер, стенду неважно,
// важно, что цикл ЖИВОЙ: без него сканер смотрит в камеру и не читает ничего.
const realDrawImage = CanvasRenderingContext2D.prototype.drawImage
CanvasRenderingContext2D.prototype.drawImage = function (...args) {
  cam.ticks++
  return realDrawImage.apply(this, args)
}
if (window.BarcodeDetector) {
  const realDetect = window.BarcodeDetector.prototype.detect
  window.BarcodeDetector.prototype.detect = function (...args) {
    cam.ticks++
    return realDetect.apply(this, args)
  }
}

function instrument(track) {
  const realApply = track.applyConstraints.bind(track)
  const realStop = track.stop.bind(track)
  const realCaps = track.getCapabilities ? track.getCapabilities.bind(track) : null

  track.applyConstraints = (c) => {
    const adv = (c && c.advanced && c.advanced[0]) || {}
    cam.apply.push(adv)
    cam.events.push(`apply ${JSON.stringify(adv)}`)
    if (MODE === 'fail') return Promise.reject(new Error('камера не умеет этого'))
    if (MODE === 'torch') return Promise.resolve()
    return realApply(c)
  }
  track.stop = () => { cam.events.push('stop'); return realStop() }

  if (MODE === 'fail') {
    // Хуже, чем на настоящем десктопе: getCapabilities не просто не знает про
    // torch, а бросает. Так ведут себя часть WebView.
    track.getCapabilities = () => { throw new Error('getCapabilities не поддержан') }
  } else if (MODE === 'torch') {
    track.getCapabilities = () => ({ ...(realCaps ? realCaps() : {}), torch: true })
  }
}

const realGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
navigator.mediaDevices.getUserMedia = async (constraints) => {
  cam.gum.push(JSON.parse(JSON.stringify(constraints || {})))
  const stream = await realGum(constraints)
  for (const t of stream.getVideoTracks()) instrument(t)
  return stream
}

// Для сравнения: что тот же браузер отдаёт БЕЗ просьбы о разрешении — то есть
// ровно то, что сканер получал до правки. Зовётся из теста, а не при загрузке,
// чтобы не тянуть камеру одновременно со сканером.
window.__baselineSize = async () => {
  try {
    const s = await realGum({ video: { facingMode: 'environment' } })
    const { width, height } = s.getVideoTracks()[0].getSettings()
    for (const t of s.getTracks()) t.stop()
    return { width, height }
  } catch { return null }
}

// Без StrictMode намеренно: он монтирует эффект дважды, камера успевает
// подняться, погаснуть и подняться снова — и в cam.events появляется лишний
// stop, из-за которого проверка порядка «фонарик гасим ДО stop» читалась бы
// неоднозначно. Вёрстку тут не проверяем, двойной прогон эффектов не нужен.
createRoot(document.getElementById('root')).render(
  <BarcodeScanner userId="stub-user" onClose={() => {}} onAdd={() => {}} meal="snack" />,
)
