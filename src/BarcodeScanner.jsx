// Сканер штрих-кода для дневника питания — полноэкранный оверлей поверх
// раздела «Питание» (App.jsx, DiaryView).
//
// Зачем отдельный файл: здесь живёт вся возня с камерой (getUserMedia,
// покадровое распознавание, остановка треков), которой в App.jsx делать
// нечего. Плюс подключается он лениво (React.lazy) — тяжёлый декодер
// @zxing тогда не попадает в основной бандл, а к тем, у кого работает
// системный BarcodeDetector, не приезжает вовсе.
//
// Путь пользователя: навёл камеру → код распознан → GET /api/set-exercise
// ?action=barcode → экран порции (сколько граммов съел) → запись уходит в
// дневник обычным addFood.
// На каждом шаге есть выход в ручной ввод: камера может быть запрещена,
// штрих-код — стёрт, продукта может не оказаться в базе.

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { GlassIcon } from './glassIcons'
import { supabase } from './supabase.js'
import MacroInputs from './MacroInputs.jsx'
import {
  buildFoodEntry, scaleProduct, clampGrams, parseGrams,
  GRAMS_DEFAULT, GRAMS_MIN, GRAMS_MAX,
} from './nutrition.js'

// Те же токены тёмной темы, что в App.jsx. Скопированы, а не импортированы —
// ровно как в TrainerSession.jsx и AIAssistant.jsx: App.jsx подгружает этот
// файл лениво, обратный импорт замкнул бы зависимость в кольцо.
const BG = '#0b0b0d'
const SURF = '#1c1c1e'
const SURF2 = '#2c2c2e'
const HAIR = 'rgba(255,255,255,0.12)'
const TXT = '#ffffff'
const TXT2 = 'rgba(235,235,245,0.62)'
const TXT3 = 'rgba(235,235,245,0.30)'
const PUR = '#7C7AF0'
const TEA = '#30D158'
const BLU = '#0A84FF'
const COR = '#FF9F0A'
const KCAL = '#BF5AF2'

// Форматы товарных штрих-кодов. Названия — как их принимает системный
// BarcodeDetector; для @zxing те же четыре формата перечислены отдельно
// (loadZxing ниже), потому что там своё перечисление.
const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e']

// Раз в 300 мс. Чаще — греем телефон впустую (декодер съедает кадр целиком),
// реже — человек успевает решить, что сканер завис.
const POLL_MS = 300

const isValidCode = c => /^[0-9]{8,14}$/.test(c)

// Системный детектор есть в Chrome на Android. Проверяем именно наличие
// конструктора, а не браузер: в Telegram WebView состав API отличается от
// «обычного» Chrome той же версии.
//
// Наличия конструктора МАЛО. На десктопном Chrome под Linux и в части WebView
// BarcodeDetector есть, но список поддерживаемых форматов пуст или состоит из
// одних QR — товарных штрих-кодов он не увидит НИКОГДА. Без этой проверки
// сканер в таком браузере просто молча смотрит в камеру и ничего не находит,
// вместо того чтобы честно переключиться на @zxing.
async function nativeDetectorOrNull() {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats()
    const usable = NATIVE_FORMATS.filter(f => supported.includes(f))
    if (!usable.length) return null
    return new window.BarcodeDetector({ formats: usable })
  } catch {
    return null
  }
}

// @zxing грузится динамически и ТОЛЬКО когда системного детектора нет: на
// Android это несколько сотен килобайт, которые там незачем скачивать.
let zxingPromise = null
function loadZxing() {
  if (!zxingPromise) {
    zxingPromise = Promise.all([import('@zxing/browser'), import('@zxing/library')])
      .then(([browser, library]) => {
        const { BrowserMultiFormatOneDReader } = browser
        const { DecodeHintType, BarcodeFormat } = library
        // Одномерный ридер вместо универсального: QR и Datamatrix на упаковке
        // продукта нам не нужны, а каждый лишний формат — это лишний проход
        // по кадру на каждом тике.
        const hints = new Map()
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
        ])
        return new BrowserMultiFormatOneDReader(hints)
      })
      .catch(e => { zxingPromise = null; throw e })
  }
  return zxingPromise
}

const cameraErrorText = e => {
  const name = e?.name || ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Доступ к камере запрещён'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Камера не найдена'
  if (name === 'NotReadableError') return 'Камера занята другим приложением'
  return 'Не удалось включить камеру'
}

const num = v => (v === null || v === undefined ? '—' : String(v))

// Сжатие снимка перед отправкой. Кадр с камеры телефона — это 4–8 МБ и
// 4000px по длинной стороне; для чтения таблицы КБЖУ этого избыточно, а вот в
// лимит тела Vercel (4.5 МБ) и в счёт за токены упирается сразу.
// 1280px/q0.8 даёт ~200–400 КБ и читается моделью не хуже оригинала.
//
// Через <img> + objectURL, а не createImageBitmap: последнего нет в старых
// WebView, а сюда мы приходим в том числе из Telegram на iOS. Ориентацию EXIF
// браузер применяет к <img> сам (image-orientation: from-image — умолчание),
// поэтому снятое вертикально не ложится на бок.
function compressImage(file, maxSide = 1280, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      try {
        // Math.min(1, …) — не растягиваем мелкие снимки: апскейл только
        // раздул бы файл, не добавив ни пикселя информации.
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
        const w = Math.max(1, Math.round(img.naturalWidth * scale))
        const h = Math.max(1, Math.round(img.naturalHeight * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', quality))
      } catch (e) { reject(e) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось прочитать фото')) }
    img.src = url
  })
}

const EMPTY_LABEL = { name: '', brand: '', kcal100: '', p100: '', c100: '', f100: '' }

export default function BarcodeScanner({ onClose, onAdd, userId, meal = null }) {
  // meal — приём пищи, из которого сканер открыли. Сканер его не использует, а
  // возвращает обратно вторым аргументом onAdd: решение «куда положить» принял
  // родитель, и хранить это решение где-то ещё значило бы завести второй
  // источник правды.
  // scan — камера ищет код; manual — ручной ввод; lookup — ждём ответ ручки;
  // result — экран порции; notfound — кода нет в базе; error — источник лёг;
  // photo — снимок ушёл на распознавание; confirm — человек сверяет прочитанное
  // моделью с этикеткой перед тем, как это уйдёт в ОБЩИЙ справочник.
  const [stage, setStage] = useState('scan')
  const [scanToken, setScanToken] = useState(0)   // бампаем, чтобы перезапустить камеру
  const [cameraError, setCameraError] = useState(null)
  const [manualCode, setManualCode] = useState('')
  const [product, setProduct] = useState(null)
  const [grams, setGrams] = useState(String(GRAMS_DEFAULT))
  const [lookupError, setLookupError] = useState(null)
  // Код, который сейчас в работе: нужен и фото-режиму (карточка заводится
  // именно на него), и повтору поиска.
  const [scannedCode, setScannedCode] = useState('')
  // Распознанное моделью, приведённое к строкам для полей ввода.
  const [labelForm, setLabelForm] = useState(EMPTY_LABEL)
  const [labelPer, setLabelPer] = useState('100g')
  // Откуда числа: 'label' — прочитаны с таблицы КБЖУ на фото, 'web' — найдены
  // поиском в интернете по названию, 'estimate' — оценка модели. От этого
  // зависит и плашка на экране сверки, и source, под которым карточка ляжет в
  // общий справочник.
  const [labelBasis, setLabelBasis] = useState('label')
  // Откуда взяты числа при basis='web': { name: 'ozon.ru', url: '…' }.
  // Показываем и имя, и рабочую ссылку — человек должен не просто прочитать
  // «из интернета», а иметь возможность открыть страницу и убедиться, что это
  // его товар, ДО того как подтвердит карточку в общий справочник.
  // Домен уже проверен сервером по белому списку (api/_foodProduct.js,
  // cleanSourceLink) — сюда произвольная ссылка из ответа модели не доедет.
  const [labelSource, setLabelSource] = useState(null)
  // Модель опознала продукт, но чисел не дала вовсе (нишевый товар). Тогда
  // поля пустые, и сохранять нечего, пока человек не впишет хотя бы ккал.
  const [labelEmpty, setLabelEmpty] = useState(false)
  const [photoError, setPhotoError] = useState(null)
  const [saving, setSaving] = useState(false)
  // «Карточку успел завести кто-то другой» — показываем на экране порции,
  // иначе расхождение с набранными числами выглядит как потеря правки.
  const [productNote, setProductNote] = useState(null)

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const pollRef = useRef(null)
  const detectorRef = useRef(null)
  const fileInputRef = useRef(null)
  const busyRef = useRef(false)   // тик ещё считает предыдущий кадр
  const doneRef = useRef(false)   // код уже распознан — больше не смотрим

  // ГЛАВНОЕ В ЭТОМ ФАЙЛЕ. Треки MediaStream живут независимо от React: если их
  // не остановить явно, камера остаётся занятой после закрытия оверлея — в
  // Telegram WebView это видно сразу (горит индикатор, второй запуск сканера
  // падает с NotReadableError), и лечится только перезапуском клиента.
  // Поэтому stopCamera зовётся отовсюду: при закрытии, при уходе со стадии
  // 'scan' и при размонтировании компонента.
  const stopCamera = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    const stream = streamRef.current
    if (stream) {
      for (const track of stream.getTracks()) { try { track.stop() } catch { /* трек уже мёртв */ } }
      streamRef.current = null
    }
    const v = videoRef.current
    if (v) {
      try { v.pause() } catch { /* не начинал играть */ }
      v.srcObject = null
    }
  }, [])

  // Страховка на размонтирование: сюда попадаем и когда пользователь нажал
  // «закрыть», и когда родитель убрал сканер сам (ушёл с экрана питания).
  useEffect(() => stopCamera, [stopCamera])

  const closeAll = useCallback(() => { stopCamera(); onClose?.() }, [stopCamera, onClose])

  // ── Поиск продукта
  const lookup = useCallback(async (code) => {
    stopCamera()
    setScannedCode(code)
    setProductNote(null)
    setStage('lookup')
    setLookupError(null)
    let res
    try {
      // Ветка внутри /api/set-exercise, а не своя функция: на Vercel Hobby
      // лимит 12 serverless-функций и он выбран целиком (см. шапку
      // api/set-exercise.js).
      res = await fetch(`/api/set-exercise?action=barcode&code=${encodeURIComponent(code)}`)
    } catch {
      // Сети нет вовсе — для пользователя это то же самое, что упавший
      // источник: «не найден» тут сказать нельзя, мы просто не спросили.
      setLookupError('Сервис поиска временно недоступен, попробуй позже или введи вручную')
      setStage('error')
      return
    }
    if (res.status === 400) {
      setLookupError('Неверный штрих-код — должно быть 8–14 цифр')
      setStage('error')
      return
    }
    if (res.status === 429) {
      setLookupError('Слишком много запросов, попробуй через минуту')
      setStage('error')
      return
    }
    if (!res.ok) {
      // 502 source_unavailable и любой другой сбой сервера. Формулировка
      // намеренно отличается от «не найден»: там человек идёт вводить руками
      // навсегда, здесь — имеет смысл повторить тот же скан.
      setLookupError('Сервис поиска временно недоступен, попробуй позже или введи вручную')
      setStage('error')
      return
    }
    let json
    try { json = await res.json() } catch {
      setLookupError('Сервис поиска временно недоступен, попробуй позже или введи вручную')
      setStage('error')
      return
    }
    if (json?.found && json.product) {
      setProduct(json.product)
      setGrams(String(GRAMS_DEFAULT))
      setStage('result')
    } else {
      setStage('notfound')
    }
  }, [stopCamera])

  // ── Камера и распознавание
  useEffect(() => {
    if (stage !== 'scan') return
    let cancelled = false
    doneRef.current = false
    busyRef.current = false

    const onCode = (code) => {
      // Первое же успешное распознавание закрывает лавочку: без doneRef
      // следующий тик (кадр-то тот же самый) отправил бы второй запрос, а на
      // экране порции значения молча перезаписались бы поверх набранных.
      if (doneRef.current || cancelled) return
      doneRef.current = true
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      lookup(code)
    }

    const readFrame = async () => {
      const v = videoRef.current
      if (!v || doneRef.current || busyRef.current) return
      // Кадра ещё нет — video.readyState < HAVE_CURRENT_DATA бывает первые
      // доли секунды после play(), и декодер на нём падает.
      if (v.readyState < 2 || !v.videoWidth) return
      busyRef.current = true
      try {
        if (detectorRef.current?.kind === 'native') {
          const found = await detectorRef.current.detector.detect(v)
          const raw = found?.[0]?.rawValue
          if (raw && isValidCode(raw)) onCode(raw)
        } else if (detectorRef.current?.kind === 'zxing') {
          const canvas = canvasRef.current
          if (canvas) {
            canvas.width = v.videoWidth
            canvas.height = v.videoHeight
            canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height)
            // decodeFromCanvas синхронно кидает NotFoundException, когда в
            // кадре ничего нет, — это норма, а не ошибка.
            const result = detectorRef.current.reader.decodeFromCanvas(canvas)
            const raw = result?.getText?.()
            if (raw && isValidCode(raw)) onCode(raw)
          }
        }
      } catch { /* в кадре нет кода — ждём следующий */ }
      busyRef.current = false
    }

    ;(async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('Камера недоступна в этом браузере')
        setStage('manual')
        return
      }
      let stream
      try {
        // facingMode:'environment' — задняя камера. Не exact: на ноутбуке и
        // части WebView задней камеры нет, и exact уронил бы сканер там, где
        // фронтальной вполне хватает.
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      } catch (e) {
        if (!cancelled) { setCameraError(cameraErrorText(e)); setStage('manual') }
        return
      }
      // Пока мы ждали разрешение, пользователь мог закрыть оверлей. Поток уже
      // выдан — гасим его сразу, иначе камера останется гореть.
      if (cancelled) { for (const t of stream.getTracks()) { try { t.stop() } catch { /* ok */ } } return }
      streamRef.current = stream
      const v = videoRef.current
      if (!v) { stopCamera(); return }
      v.srcObject = stream
      // play() отвергается, если элемент успели убрать; для нас это не ошибка.
      try { await v.play() } catch { /* размонтировались */ }

      // Выбор декодера: системный, если он есть и умеет наши форматы, иначе
      // @zxing. Решение принимается один раз и переживает перезапуск камеры.
      if (!detectorRef.current) {
        const native = await nativeDetectorOrNull()
        if (cancelled) return
        if (native) detectorRef.current = { kind: 'native', detector: native }
      }
      if (!detectorRef.current) {
        try {
          const reader = await loadZxing()
          if (cancelled) return
          detectorRef.current = { kind: 'zxing', reader }
        } catch {
          if (!cancelled) { setCameraError('Не удалось загрузить распознавание'); setStage('manual') }
          return
        }
      }
      if (cancelled) return
      pollRef.current = setInterval(readFrame, POLL_MS)
    })()

    return () => { cancelled = true; stopCamera() }
  }, [stage, scanToken, lookup, stopCamera])

  const restartScan = () => {
    setProduct(null)
    setLookupError(null)
    setCameraError(null)
    setScanToken(t => t + 1)
    setStage('scan')
  }

  const openManual = () => { stopCamera(); setStage('manual') }

  const submitManual = () => { if (isValidCode(manualCode)) lookup(manualCode) }

  // ── Фото этикетки → распознавание
  // Камеру гасим ДО открытия файлового пикера: системная «Камера», которую
  // поднимает capture="environment", не сможет захватить объектив, пока его
  // держит наш MediaStream, — в Telegram WebView это кончается чёрным кадром.
  const openPhotoPicker = () => {
    stopCamera()
    setPhotoError(null)
    fileInputRef.current?.click()
  }

  const recognizeLabel = async (file) => {
    if (!file) return
    stopCamera()
    setPhotoError(null)
    setStage('photo')

    let dataUrl
    try {
      dataUrl = await compressImage(file)
    } catch {
      setPhotoError('Не удалось прочитать фото. Попробуй снять ещё раз.')
      return
    }

    // api/chat требует Supabase-токен (см. тот файл) — без сессии запрос
    // бессмысленен, сервер ответит 401 ещё до обращения к модели.
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) {
      setPhotoError('Сессия истекла. Войди заново и повтори.')
      return
    }

    let res
    try {
      res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ type: 'food_label', barcode: scannedCode, image: dataUrl }),
      })
    } catch {
      setPhotoError('Нет связи с сервером. Проверь интернет и попробуй ещё раз.')
      return
    }

    if (res.status === 413) { setPhotoError('Фото слишком большое. Сними ближе, без лишнего фона.'); return }
    if (res.status === 401) { setPhotoError('Нужно войти в аккаунт.'); return }
    if (res.status === 429) {
      // Три разных исчерпания, и путать их нельзя: «попробуй через час» тому,
      // кто упёрся в СУТОЧНУЮ квоту, — враньё, у него раньше завтра ничего не
      // изменится. Признак приходит полем reason (api/chat.js); почасовой
      // потолок его не ставит вовсе.
      const body = await res.json().catch(() => null)
      setPhotoError(
        body?.reason === 'free_daily_limit' ? 'Лимит 3 фото в день исчерпан. Больше — на тарифе ПРОФИТ'
          : body?.reason === 'daily_limit' ? 'Дневной лимит фото исчерпан, продолжим завтра'
            : 'Слишком много запросов, попробуй через час')
      return
    }
    if (!res.ok) { setPhotoError('Распознавание сейчас недоступно. Попробуй ещё раз через минуту.'); return }

    let json
    try { json = await res.json() } catch {
      setPhotoError('Распознавание сейчас недоступно. Попробуй ещё раз через минуту.')
      return
    }

    if (!json?.ok) {
      // reason:'unreadable' — модель не разглядела таблицу. Подсказка
      // конкретная: человеку надо знать, ЧТО переснять, а не просто «ошибка».
      setPhotoError('Не разглядел продукт. Сфотографируй упаковку целиком, с названием')
      return
    }

    // Числа кладём в поля ввода строками: null («на этикетке нет») превращаем
    // в пустую строку, чтобы человек сразу видел, что вписать.
    const p = json.product
    const s = v => (v === null || v === undefined ? '' : String(v))
    setLabelForm({ name: p.name || '', brand: p.brand || '', kcal100: s(p.kcal100), p100: s(p.p100), c100: s(p.c100), f100: s(p.f100) })
    setLabelPer(p.per || '100g')
    setLabelBasis(['estimate', 'web'].includes(p.basis) ? p.basis : 'label')
    setLabelSource(p.sourceName && p.sourceUrl ? { name: p.sourceName, url: p.sourceUrl } : null)
    setLabelEmpty(p.kcal100 === null && p.p100 === null && p.c100 === null && p.f100 === null)
    setStage('confirm')
  }

  // ── Подтверждённая карточка → в общий справочник → сразу к порции
  const saveProduct = async () => {
    if (saving) return
    if (!String(labelForm.name).trim()) { setPhotoError('Впиши название продукта'); return }
    setSaving(true)
    setPhotoError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { setPhotoError('Сессия истекла. Войди заново и повтори.'); return }
      let res
      try {
        res = await fetch('/api/set-exercise?action=save-product', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          // basis, а НЕ source: какой источник записать, решает сервер
          // (api/_foodProduct.js, basisToSource). Клиент, объявляющий свою
          // карточку точной, навсегда закрыл бы её от обновления из OFF.
          body: JSON.stringify({ barcode: scannedCode, basis: labelBasis, ...labelForm }),
        })
      } catch {
        setPhotoError('Нет связи с сервером. Проверь интернет и попробуй ещё раз.')
        return
      }
      if (!res.ok) {
        setPhotoError(res.status === 401 ? 'Нужно войти в аккаунт.' : 'Не удалось сохранить продукт. Попробуй ещё раз.')
        return
      }
      const json = await res.json().catch(() => null)
      if (!json?.ok || !json.product) {
        setPhotoError('Не удалось сохранить продукт. Попробуй ещё раз.')
        return
      }
      // created:false — карточку на этот штрих-код кто-то завёл раньше нас, и
      // сервер вернул ЕЁ, а не нашу (данные OFF и чужой труд не перезаписываем).
      // Молча подменять числа под носом нельзя — говорим прямо.
      setProductNote(json.created === false
        ? 'Карточку на этот штрих-код уже завели раньше — используем её данные.'
        : null)
      setProduct(json.product)
      setGrams(String(GRAMS_DEFAULT))
      setStage('result')
    } finally {
      setSaving(false)
    }
  }

  // ── Пересчёт порции
  // Считаем от УЖЕ поджатого веса, чтобы предпросмотр показывал ровно те
  // числа, которые уйдут в дневник: набранные «5000 г» сохранятся как 3000,
  // и увидеть это лучше до нажатия кнопки, а не после.
  const gramsClamped = clampGrams(grams)
  const gramsRaw = parseGrams(grams)
  const scaled = product ? scaleProduct(product, gramsClamped) : null
  const gramsClipped = gramsRaw !== null && gramsClamped !== null && gramsRaw !== gramsClamped

  const addToDiary = () => {
    if (!product || gramsClamped === null) return
    onAdd?.(buildFoodEntry(product, gramsClamped), meal)
  }

  // ── Стили
  const overlay = { position: 'fixed', inset: 0, background: BG, zIndex: 2000, display: 'flex', flexDirection: 'column' }
  const header = { background: SURF, borderBottom: `1px solid ${HAIR}`, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }
  const body = { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }
  const pad = { padding: '18px 16px 28px' }
  const primaryBtn = { width: '100%', padding: '13px', borderRadius: 12, border: 'none', background: PUR, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', minHeight: 'unset' }
  const ghostBtn = { width: '100%', padding: '12px', borderRadius: 12, border: `2px dashed ${PUR}55`, background: 'transparent', color: PUR, fontSize: 14, fontWeight: 600, cursor: 'pointer', minHeight: 'unset' }
  const inputStyle = { width: '100%', padding: '12px 14px', fontSize: 16, borderRadius: 10, border: `1.5px solid ${HAIR}`, outline: 'none', boxSizing: 'border-box', color: TXT, background: SURF2 }

  // Поле ввода числа на экране подтверждения — те же стили, что у формы еды
  // в дневнике (App.jsx), чтобы экран не выглядел чужим.
  // Сохранять нечего, пока в карточке нет ни одного числа: такая строка в
  // общем справочнике хуже отсутствия — следующий отсканирует и получит пусто.
  // Требуем только ккал; макросы остаются необязательными, как и раньше.
  const needsKcal = labelEmpty && parseGrams(labelForm.kcal100) === null

  const headerTitle =
    stage === 'result' ? 'Порция'
      : stage === 'manual' ? 'Ввод штрих-кода'
        : stage === 'confirm' ? 'Проверь данные'
          : stage === 'photo' ? 'Этикетка'
            : 'Сканирование'

  return createPortal(
    <div style={overlay}>
      <div style={header}>
        <span style={{ fontSize: 17, fontWeight: 700, color: TXT, flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
          <GlassIcon name="video" size={26} />{headerTitle}
        </span>
        <button onClick={closeAll} aria-label="Закрыть"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: TXT3, padding: 0, minHeight: 'unset', lineHeight: 1 }}>
          <GlassIcon name="close" size={28} />
        </button>
      </div>

      {/* Скрытый файловый вход — живёт вне ветвлений по стадии, иначе
          fileInputRef.current окажется null ровно в тот момент, когда по нему
          кликают. capture="environment" открывает сразу заднюю камеру.
          Сброс value обязателен: без него повторный выбор ТОГО ЖЕ файла
          («переснял так же») не поднимет change и экран замрёт. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; recognizeLabel(f) }}
      />

      <div style={body}>
        {/* ── Камера */}
        {stage === 'scan' && (
          <>
            <div style={{ padding: '14px 16px 10px', textAlign: 'center', fontSize: 14, fontWeight: 600, color: TXT }}>
              Наведи камеру на штрих-код
            </div>
            <div style={{ position: 'relative', flex: 1, minHeight: 240, background: '#000', overflow: 'hidden' }}>
              {/* playsInline и muted обязательны: без них iOS и Telegram
                  WebView разворачивают видео в системный плеер на весь экран
                  вместо того, чтобы играть его внутри страницы. */}
              <video ref={videoRef} playsInline muted autoPlay
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              {/* Рамка прицела: подсказывает, куда попасть, и ничего не режет —
                  распознаём мы весь кадр целиком. */}
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <div style={{ width: '76%', maxWidth: 320, height: 130, border: `2px solid ${PUR}`, borderRadius: 14, boxShadow: '0 0 0 100vmax rgba(0,0,0,0.45)' }} />
              </div>
            </div>
            <canvas ref={canvasRef} style={{ display: 'none' }} />
            <div style={{ padding: '14px 16px 24px' }}>
              <div style={{ fontSize: 12, color: TXT3, textAlign: 'center', marginBottom: 12 }}>
                Держи код в рамке — распознается сам
              </div>
              <button onClick={openManual} style={ghostBtn}>Ввести код вручную</button>
            </div>
          </>
        )}

        {/* ── Ручной ввод */}
        {stage === 'manual' && (
          <div style={pad}>
            {cameraError && (
              <div style={{ background: SURF, border: `1px solid ${HAIR}`, borderRadius: 12, padding: '12px 14px', marginBottom: 14, fontSize: 13, color: TXT2 }}>
                {cameraError}. Введи цифры под штрих-кодом вручную.
              </div>
            )}
            <div style={{ fontSize: 12, color: TXT3, fontWeight: 600, marginBottom: 6 }}>Штрих-код, 8–14 цифр</div>
            <input
              value={manualCode}
              // Чистим ввод на месте: с цифровой клавиатуры всё равно
              // прилетают пробелы и дефисы (вставка из заметок, автозамена).
              onChange={e => setManualCode(e.target.value.replace(/\D/g, '').slice(0, 14))}
              onKeyDown={e => { if (e.key === 'Enter') submitManual() }}
              inputMode="numeric"
              placeholder="4600682000129"
              autoFocus
              style={inputStyle}
              onFocus={e => e.target.style.borderColor = PUR}
              onBlur={e => e.target.style.borderColor = HAIR}
            />
            <button onClick={submitManual} disabled={!isValidCode(manualCode)}
              style={{ ...primaryBtn, marginTop: 14, opacity: isValidCode(manualCode) ? 1 : 0.45, cursor: isValidCode(manualCode) ? 'pointer' : 'default' }}>
              Найти
            </button>
            <button onClick={restartScan} style={{ ...ghostBtn, marginTop: 10 }}>Вернуться к камере</button>
          </div>
        )}

        {/* ── Ждём ответ */}
        {stage === 'lookup' && (
          <div style={{ ...pad, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: TXT }}>Ищу продукт…</div>
            <div style={{ fontSize: 12, color: TXT3 }}>Это занимает пару секунд</div>
          </div>
        )}

        {/* ── Нашли: экран порции */}
        {stage === 'result' && product && (
          <div style={pad}>
            {productNote && (
              <div style={{ background: `${PUR}18`, border: `1px solid ${PUR}44`, borderRadius: 10, padding: '10px 12px', marginBottom: 12, fontSize: 12, color: TXT2 }}>
                {productNote}
              </div>
            )}
            <div style={{ background: SURF, border: `1px solid ${HAIR}`, borderRadius: 14, padding: '14px 16px', marginBottom: 14 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: TXT, marginBottom: 2 }}>{product.name}</div>
              {product.brand && <div style={{ fontSize: 13, color: TXT2, marginBottom: 8 }}>{product.brand}</div>}
              <div style={{ fontSize: 12, color: TXT3 }}>
                На 100 г: <span style={{ color: KCAL, fontWeight: 700 }}>{num(product.kcal100)} ккал</span>
                {' · '}Б {num(product.p100)} · У {num(product.c100)} · Ж {num(product.f100)}
              </div>
              {/* Карточку кто-то завёл, не читая таблицу с упаковки: числа
                  либо оценка модели, либо находка в интернете по названию.
                  Молчать об этом нельзя: человек считает их фактом и заносит в
                  дневник. Две формулировки, а не одна, — разница существенная:
                  «из интернета» можно проверить, «примерные» проверить нечем. */}
              {product.source === 'ai_estimate' && (
                <div style={{ fontSize: 11, color: COR, marginTop: 6 }}>≈ примерные значения</div>
              )}
              {/* Найденное в интернете помечаем СПОКОЙНО и БЕЗ «≈»: у этих
                  чисел есть источник, они не прикидка. Ссылку показать уже
                  нечем — в справочнике хранится только вид источника, не
                  адрес, — поэтому просто говорим, откуда они родом. */}
              {product.source === 'ai_web' && (
                <div style={{ fontSize: 11, color: TXT3, marginTop: 6 }}>По данным карточки магазина</div>
              )}
            </div>

            <div style={{ fontSize: 12, color: TXT3, fontWeight: 600, marginBottom: 6 }}>Вес порции, г</div>
            <input
              value={grams}
              onChange={e => setGrams(e.target.value)}
              inputMode="decimal"
              placeholder={String(GRAMS_DEFAULT)}
              style={{ ...inputStyle, fontSize: 28, fontWeight: 800, textAlign: 'center', padding: '14px' }}
              onFocus={e => e.target.style.borderColor = PUR}
              onBlur={e => e.target.style.borderColor = HAIR}
            />
            {gramsClamped === null
              ? <div style={{ fontSize: 12, color: COR, marginTop: 6 }}>Укажи вес порции числом</div>
              : gramsClipped
                ? <div style={{ fontSize: 12, color: COR, marginTop: 6 }}>Считаем как {gramsClamped} г — допустимо от {GRAMS_MIN} до {GRAMS_MAX} г</div>
                : null}

            <div style={{ background: SURF, border: `1px solid ${HAIR}`, borderRadius: 14, padding: '14px 16px', margin: '14px 0' }}>
              <div style={{ fontSize: 11, color: TXT3, fontWeight: 600, marginBottom: 8 }}>
                ИТОГО НА {gramsClamped === null ? '—' : gramsClamped} Г
              </div>
              <div style={{ fontSize: 34, fontWeight: 800, color: KCAL, lineHeight: 1, marginBottom: 10 }}>
                {num(scaled?.kcal)} <span style={{ fontSize: 15, color: TXT3, fontWeight: 700 }}>ккал</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
                {[['Белки', scaled?.p, TEA], ['Углеводы', scaled?.c, BLU], ['Жиры', scaled?.f, COR]].map(([l, v, c]) => (
                  <div key={l} style={{ background: SURF2, borderRadius: 10, padding: '8px 6px', textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: TXT3, marginBottom: 2 }}>{l}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: c }}>{num(v)} г</div>
                  </div>
                ))}
              </div>
            </div>

            <button onClick={addToDiary} disabled={gramsClamped === null}
              style={{ ...primaryBtn, opacity: gramsClamped === null ? 0.45 : 1, cursor: gramsClamped === null ? 'default' : 'pointer' }}>
              Добавить в дневник
            </button>
            <button onClick={restartScan} style={{ ...ghostBtn, marginTop: 10 }}>Сканировать ещё</button>
          </div>
        )}

        {/* ── Кода нет в базе */}
        {stage === 'notfound' && (
          <div style={pad}>
            <div style={{ background: SURF, border: `1px solid ${HAIR}`, borderRadius: 14, padding: '16px', marginBottom: 14, textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: TXT, marginBottom: 6 }}>Продукт не найден в базе</div>
              <div style={{ fontSize: 13, color: TXT2 }}>
                {userId
                  ? 'Сфотографируй упаковку так, чтобы было видно название. Если в кадр попадёт таблица КБЖУ — цифры будут точнее'
                  : 'Такого штрих-кода нет в открытом справочнике. Добавь продукт вручную — числа с упаковки.'}
              </div>
            </div>
            {/* Фото-режим только вошедшим: карточка уходит в ОБЩИЙ справочник,
                и api/chat всё равно ответит 401 без токена. Анониму показываем
                ровно то, что у него работает. */}
            {userId && <button onClick={openPhotoPicker} style={primaryBtn}>Сфотографировать упаковку</button>}
            <button onClick={openManual} style={userId ? { ...ghostBtn, marginTop: 10 } : primaryBtn}>Ввести вручную</button>
            <button onClick={restartScan} style={{ ...ghostBtn, marginTop: 10 }}>Сканировать ещё</button>
          </div>
        )}

        {/* ── Фото ушло на распознавание */}
        {stage === 'photo' && (
          photoError ? (
            <div style={pad}>
              <div style={{ background: SURF, border: `1px solid ${COR}44`, borderRadius: 14, padding: '16px', marginBottom: 14, textAlign: 'center' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: COR }}>{photoError}</div>
              </div>
              <button onClick={openPhotoPicker} style={primaryBtn}>Переснять</button>
              {/* Та же подсказка, что и на экране сверки: сюда человек попадает
                  после неудачи, и «переснять» без ответа на «как именно» —
                  предложение повторить то же самое. */}
              <div style={{ fontSize: 11, color: TXT3, marginTop: 8, textAlign: 'center', lineHeight: 1.5 }}>
                Точнее всего — снимок таблицы «Пищевая ценность» с обратной стороны.
                Мелкий шрифт читается нормально, если кадр резкий.
              </div>
              <button onClick={openManual} style={{ ...ghostBtn, marginTop: 10 }}>Ввести вручную</button>
              <button onClick={restartScan} style={{ ...ghostBtn, marginTop: 10 }}>Сканировать ещё</button>
            </div>
          ) : (
            <div style={{ ...pad, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: TXT }}>Распознаю этикетку…</div>
              <div style={{ fontSize: 12, color: TXT3 }}>Обычно занимает несколько секунд</div>
            </div>
          )
        )}

        {/* ── Сверка распознанного с этикеткой */}
        {stage === 'confirm' && (
          <div style={pad}>
            <div style={{ fontSize: 13, color: TXT2, marginBottom: 4 }}>Проверь, совпадает ли с этикеткой</div>
            <div style={{ fontSize: 11, color: TXT3, marginBottom: 14 }}>
              Эти данные уйдут в общую базу — по ним продукт найдут другие. Поправь, если модель ошиблась.
            </div>

            {/* Числа найдены в интернете — это НЕ прикидка, и предупреждать
                тут не о чем: у значений есть проверяемый источник, и человек
                может открыть его одним касанием. Поэтому не жёлтая плашка
                тревоги, а спокойная подпись со ссылкой — тем же синим, что и
                прочие ссылки приложения.
                rel обязателен: target=_blank без noopener отдаёт открытой
                вкладке доступ к window.opener нашей страницы. */}
            {labelBasis === 'web' && labelSource && (
              <div style={{ background: `${BLU}14`, border: `1px solid ${BLU}3a`, borderRadius: 10, padding: '10px 12px', marginBottom: 12, fontSize: 12, color: TXT2 }}>
                Значения по данным{' '}
                <a href={labelSource.url} target="_blank" rel="noopener noreferrer"
                  style={{ color: BLU, fontWeight: 600, textDecoration: 'underline' }}>
                  {labelSource.name}
                </a>
                {' — открой и сверь, что это тот же вкус и вес, что у тебя в руках.'}
              </div>
            )}

            {/* Числа — оценка модели, а не чтение таблицы и не находка в
                интернете. Сказать об этом надо прямо: человек должен понимать,
                что сверять не с чем, и либо довериться, либо переснять сторону
                с составом. */}
            {labelBasis === 'estimate' && (
              <div style={{ background: `${COR}18`, border: `1px solid ${COR}44`, borderRadius: 10, padding: '10px 12px', marginBottom: 12, fontSize: 12, color: TXT2 }}>
                {labelEmpty
                  ? 'Продукт опознан, но точных значений нет. Впиши КБЖУ с упаковки — или переснимите сторону с таблицей.'
                  : 'Значения примерные (по данным ИИ) — в интернете точных не нашлось. Если на упаковке есть таблица КБЖУ — сверь или переснимите ту сторону.'}
              </div>
            )}

            {/* per !== '100g' — модель не увидела на упаковке, что таблица
                приведена к 100 г. Числа могли быть посчитаны с порции, и
                проверить их глазами тут особенно важно. Для 'web' и 'estimate'
                этот случай не возникает: там модель просят сразу давать на
                100 г, — плашка только для чтения таблицы с фото. */}
            {labelBasis === 'label' && labelPer !== '100g' && (
              <div style={{ background: `${COR}18`, border: `1px solid ${COR}44`, borderRadius: 10, padding: '10px 12px', marginBottom: 12, fontSize: 12, color: TXT2 }}>
                {labelPer === 'portion'
                  ? 'На этикетке значения указаны на порцию — мы пересчитали их на 100 г. Сверь особенно внимательно.'
                  : 'На этикетке не указано, на какой вес приведена таблица. Мы считаем, что на 100 г — проверь.'}
              </div>
            )}

            <div style={{ fontSize: 12, color: TXT3, fontWeight: 600, marginBottom: 6 }}>Название</div>
            <input value={labelForm.name} onChange={e => setLabelForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Творог 5%" style={{ ...inputStyle, marginBottom: 10 }}
              onFocus={e => e.target.style.borderColor = PUR} onBlur={e => e.target.style.borderColor = HAIR} />

            <div style={{ fontSize: 12, color: TXT3, fontWeight: 600, marginBottom: 6 }}>Бренд</div>
            <input value={labelForm.brand} onChange={e => setLabelForm(f => ({ ...f, brand: e.target.value }))}
              placeholder="Простоквашино" style={{ ...inputStyle, marginBottom: 14 }}
              onFocus={e => e.target.style.borderColor = PUR} onBlur={e => e.target.style.borderColor = HAIR} />

            <div style={{ fontSize: 12, color: TXT3, fontWeight: 600, marginBottom: 6 }}>На 100 г</div>
            {/* type="decimal", а не "number": значения приходят от модели и
                человек правит их с телефонной клавиатуры, где легко ввести
                запятую — type="number" такое поле молча обнулил бы. */}
            <div style={{ marginBottom: 16 }}>
              <MacroInputs suffix="100" type="decimal" values={labelForm}
                onChange={(k, v) => setLabelForm(f => ({ ...f, [k]: v }))} />
            </div>

            {photoError && (
              <div style={{ fontSize: 12, color: COR, marginBottom: 10, textAlign: 'center' }}>{photoError}</div>
            )}

            {/* Карточка без единого числа в общем справочнике бесполезна —
                следующий отсканирует её и не получит ничего. Поэтому когда
                модель чисел не дала, требуем хотя бы калорийность; макросы
                по-прежнему необязательны. */}
            {needsKcal && (
              <div style={{ fontSize: 12, color: TXT3, marginBottom: 10, textAlign: 'center' }}>
                Впиши хотя бы калорийность, чтобы сохранить
              </div>
            )}

            <button onClick={saveProduct} disabled={saving || needsKcal}
              style={{ ...primaryBtn, opacity: (saving || needsKcal) ? 0.5 : 1, cursor: (saving || needsKcal) ? 'default' : 'pointer' }}>
              {saving ? 'Сохраняю…' : 'Всё верно, сохранить'}
            </button>
            <button onClick={openPhotoPicker} style={{ ...ghostBtn, marginTop: 10 }}>Переснять</button>
            {/* Подсказка под кнопкой, а не в плашке выше: она нужна ровно в тот
                момент, когда человек решает, пересниматься ли, — и должна
                отвечать на вопрос «а зачем». Отвечаем прямо: таблица с обратной
                стороны даёт ТОЧНЫЕ цифры вместо любых косвенных, и мелкий шрифт
                этому не помеха, если кадр резкий. Говорим это ВСЕГДА, а не
                только при прикидке: даже найденное в интернете — про товар с
                тем же названием, а не про пачку в руках. */}
            <div style={{ fontSize: 11, color: TXT3, marginTop: 8, textAlign: 'center', lineHeight: 1.5 }}>
              Точнее всего — снимок таблицы «Пищевая ценность» с обратной стороны.
              Мелкий шрифт читается нормально, если кадр резкий: держи телефон в 10–15 см
              и дай камере навестись.
            </div>
          </div>
        )}

        {/* ── Источник недоступен */}
        {stage === 'error' && (
          <div style={pad}>
            <div style={{ background: SURF, border: `1px solid ${COR}44`, borderRadius: 14, padding: '16px', marginBottom: 14, textAlign: 'center' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: COR }}>{lookupError}</div>
            </div>
            <button onClick={restartScan} style={primaryBtn}>Сканировать ещё</button>
            <button onClick={openManual} style={{ ...ghostBtn, marginTop: 10 }}>Ввести код вручную</button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
