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
        // TRY_HARDER — второй, куда более дотошный проход по кадру: ридер
        // пробует больше линий развёртки и оба направления чтения. Это заметно
        // поднимает шанс на мятой плёнке, бликах и коде, снятом под углом, —
        // то есть ровно на том, как выглядит пачка в руке у полки.
        //
        // Цена — лишний такт процессора на кадр. Она нам по карману: тик идёт
        // раз в POLL_MS (300 мс) и следующий не стартует, пока считается
        // предыдущий (busyRef), так что в худшем случае мы просто пропустим
        // кадр, а не устроим очередь.
        hints.set(DecodeHintType.TRY_HARDER, true)
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
  // Калорийность не сошлась с макросами: 'swapped' — похоже, жиры и углеводы
  // переставлены местами, 'too_high'/'too_low' — просто не сходится. Сервер
  // такие числа уже понизил до примерных; здесь остаётся объяснить человеку,
  // что именно проверить.
  const [macroIssue, setMacroIssue] = useState(null)
  // Съёмка ничего не дала, но карточка на этот код уже была — на экране лежат
  // ПРЕЖНИЕ цифры, а не результат этого снимка. Молчать об этом нельзя: человек
  // решит, что таблица прочиталась, и подтвердит чужую прикидку как точную.
  const [keptPrevious, setKeptPrevious] = useState(false)
  // Фонарик: есть ли он у этой камеры вообще и горит ли сейчас. Кнопку
  // показываем ТОЛЬКО когда трек сам заявил о поддержке (getCapabilities().torch)
  // — на ноутбуке и в большинстве десктопных браузеров её не будет вовсе.
  // Неживая кнопка хуже отсутствующей: человек жмёт, ничего не происходит, и
  // он решает, что сломан сканер.
  const [torchAvailable, setTorchAvailable] = useState(false)
  const [torchOn, setTorchOn] = useState(false)

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const pollRef = useRef(null)
  const detectorRef = useRef(null)
  const fileInputRef = useRef(null)
  const busyRef = useRef(false)   // тик ещё считает предыдущий кадр
  const doneRef = useRef(false)   // код уже распознан — больше не смотрим
  // Видеотрек текущего потока — по нему переключается фонарик. Отдельно от
  // streamRef, потому что нужен из обработчика нажатия, а не только из эффекта.
  const trackRef = useRef(null)
  // Зеркало torchAvailable в ref: stopCamera читает его в момент остановки, а
  // не в момент своего создания. Через состояние он был бы всегда false —
  // useCallback([]) замкнул бы первое значение.
  const torchOkRef = useRef(false)
  // Четыре числа в том виде, в каком они впервые легли на экран сверки. По ним
  // при сохранении решается, правил человек цифры или подтвердил чужие, —
  // отсюда и source карточки. В ref, а не в состоянии: на отрисовку это не
  // влияет, а лишние перерисовки формы ввода ни к чему.
  const shownNumsRef = useRef([null, null, null, null])

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
      for (const track of stream.getTracks()) {
        // ФОНАРИК ГАСИМ ДО stop(), И ТОЛЬКО ЕСЛИ ОН ЗДЕСЬ ЕСТЬ. На части
        // Android остановка трека не выключает подсветку — телефон убирают в
        // карман с горящим фонарём. После stop() трек уже мёртв, и погасить
        // его нечем, поэтому порядок здесь не косметический.
        //
        // Проверка torchOkRef важна вторым: без неё мы дёргали бы
        // applyConstraints на каждой камере при каждой остановке, в том числе
        // на десктопе, где этот путь сейчас просто работает.
        //
        // Без await — stopCamera синхронная и зовётся из cleanup эффекта.
        // Обещание всё равно ловим: несбывшийся applyConstraints иначе
        // всплывает unhandled rejection в консоли.
        if (torchOkRef.current && track.kind === 'video') {
          try { track.applyConstraints({ advanced: [{ torch: false }] })?.catch?.(() => {}) } catch { /* не умеет */ }
        }
        try { track.stop() } catch { /* трек уже мёртв */ }
      }
      streamRef.current = null
    }
    trackRef.current = null
    torchOkRef.current = false
    setTorchAvailable(false)
    setTorchOn(false)
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
        //
        // РАЗРЕШЕНИЕ ПРОСИМ ЯВНО. Без width/height браузер выдаёт поток по
        // своему умолчанию — а это 640×480. Штрих-код в такой кадр попадает
        // полосками в считанные пиксели шириной, и декодер честно не находит
        // ничего: дело не в нём, а в том, что в кадре информации уже нет.
        //
        // ideal, а НЕ exact и не min — по той же причине, что и facingMode:
        // там, где 1920×1080 не выдаст никто (веб-камера ноутбука, старый
        // WebView), должно отдаться лучшее из возможного. exact бросил бы
        // OverconstrainedError, и сканер ушёл бы в ручной ввод на ровном месте.
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        })
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

      // ── Донастройка трека: автофокус и фонарик
      //
      // ВСЁ, ЧТО НИЖЕ, — НЕОБЯЗАТЕЛЬНОЕ УЛУЧШЕНИЕ. Ни один отказ здесь не имеет
      // права уронить сканер: focusMode и torch не описаны в основном стандарте
      // MediaTrackConstraints, их поддержка кончается ровно на Android Chrome, а
      // на десктопе и в iOS Safari applyConstraints на них либо молча ничего не
      // делает, либо отклоняет обещание. Поэтому каждый вызов — в своём
      // try/catch, отказ проглатывается, поток остаётся тем же.
      const track = stream.getVideoTracks()[0] || null
      trackRef.current = track

      // Непрерывный автофокус. Часть Android-камер по умолчанию держит фокус
      // фиксированным, и с 10–15 см — то есть с того расстояния, с которого
      // человек и подносит пачку, — картинка размыта. Полоски штрих-кода
      // сливаются, и декодеру опять нечего читать.
      try {
        await track?.applyConstraints({ advanced: [{ focusMode: 'continuous' }] })
      } catch { /* камера не умеет управлять фокусом — снимаем как есть */ }

      // Фонарик показываем, только если трек сам о нём заявил. getCapabilities
      // нет в Safari вовсе — отсюда и вызов через ?., и try/catch поверх.
      let torchSupported = false
      try { torchSupported = Boolean(track?.getCapabilities?.().torch) } catch { /* нет такого API */ }
      torchOkRef.current = torchSupported
      if (!cancelled) { setTorchAvailable(torchSupported); setTorchOn(false) }

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

  // Переключение фонарика. Если камера соврала о поддержке (getCapabilities
  // сказал torch, а applyConstraints отказал) — убираем кнопку совсем, вместо
  // того чтобы оставить её мёртвой на экране.
  const toggleTorch = async () => {
    const track = trackRef.current
    if (!track) return
    const next = !torchOn
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] })
      setTorchOn(next)
    } catch {
      torchOkRef.current = false
      setTorchAvailable(false)
      setTorchOn(false)
    }
  }

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

    // НЕТ ОДНОЙ СТРОКИ В ТАБЛИЦЕ — ЭТО НЕ ПРОБЕЛ, А НОЛЬ. У воды нет ни белков,
    // ни жиров, ни углеводов; у растительного масла нет углеводов; строку
    // «жиры 0 г» производители сплошь и рядом просто не печатают. Модель в
    // таком случае честно отдаёт null, и раньше человек упирался в погасшую
    // кнопку с требованием заполнить то, чего на пачке нет.
    //
    // Подставляем 0 ВИДИМО, в само поле ввода: человек читает нули, сверяет с
    // пачкой и правит, если жиры там всё-таки есть. Молчаливая подстановка при
    // отправке была бы хуже — она решает за него и ничего не показывает.
    //
    // Только когда калорийность распознана: если её нет, нулями будет нечего
    // поверять, а «все четыре null» — это отдельный случай (labelEmpty ниже),
    // где модель узнала продукт, но не увидела цифр вовсе. Там поля остаются
    // пустыми, и просьба вписать КБЖУ честна.
    //
    // Страховка — проверка Атвотера на сервере: если жиры на деле есть, а в
    // поле 0, калорийность не сойдётся с макросами и плашка предупредит.
    const macro = v => (v === null || v === undefined ? (p.kcal100 === null ? '' : '0') : String(v))
    const form = {
      name: p.name || '', brand: p.brand || '',
      kcal100: s(p.kcal100), p100: macro(p.p100), c100: macro(p.c100), f100: macro(p.f100),
    }
    setLabelForm(form)

    // Что человек УВИДЕЛ на экране сверки — отправная точка для решения, правил
    // он числа или нет (см. saveProduct). Именно увиденное, а не сырой ответ
    // модели: подставленные выше нули придумали мы, и если человек их не
    // тронул, точной карточка от этого не стала.
    shownNumsRef.current = [form.kcal100, form.p100, form.c100, form.f100].map(parseGrams)
    setLabelPer(p.per || '100g')
    setLabelBasis(['estimate', 'web'].includes(p.basis) ? p.basis : 'label')
    setLabelSource(p.sourceName && p.sourceUrl ? { name: p.sourceName, url: p.sourceUrl } : null)
    setMacroIssue(p.macroIssue || null)
    setKeptPrevious(json.keptPrevious === true)
    setLabelEmpty(p.kcal100 === null && p.p100 === null && p.c100 === null && p.f100 === null)
    setStage('confirm')
  }

  // ── Подтверждённая карточка → в общий справочник → сразу к порции
  //
  // Аргументов нет намеренно: функция висит прямо на onClick, то есть первым
  // аргументом ей прилетает событие клика. Пока здесь был параметр ответа на
  // вопрос о похожем продукте, это была мина — нажатие кнопки означало «ответ
  // передан», просто ни одно из значений не совпадало.
  const saveProduct = async () => {
    if (saving) return
    if (!String(labelForm.name).trim()) { setPhotoError('Впиши название продукта'); return }
    setSaving(true)
    setPhotoError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { setPhotoError('Сессия истекла. Войди заново и повтори.'); return }

      // ЧЕЛОВЕК ПЕРЕПИСАЛ ЦИФРЫ С ПАЧКИ — ЭТО УЖЕ НЕ ПРИКИДКА.
      //
      // Раньше basis уезжал таким, каким его выставила модель, и карточка,
      // где все четыре числа переписаны с этикетки вручную, ложилась в общий
      // справочник как ai_estimate — с пометкой «≈ примерные значения» и правом
      // быть вытесненной чьей угодно следующей прикидкой. Обидно вдвойне:
      // человек сделал самую точную работу из возможных, а результат помечен
      // как догадка.
      //
      // Признак правки — расхождение с тем, что лежало в полях при открытии
      // экрана (shownNumsRef). Сравниваем ЧИСЛА, а не строки: «5.0» и «5» — одно
      // и то же, и объявлять это правкой было бы враньём в другую сторону.
      //
      // Сверяемся именно с показанным, а не с сырым ответом модели: нули,
      // подставленные нами вместо ненапечатанных строк таблицы, придумали мы, и
      // если человек их не тронул — карточка от этого точной не стала.
      //
      // Имя и бренд НЕ учитываются намеренно: поправить опечатку в названии —
      // не то же самое, что сверить числа с упаковкой.
      const nowNums = [labelForm.kcal100, labelForm.p100, labelForm.c100, labelForm.f100].map(parseGrams)
      const edited = nowNums.some((v, i) => v !== shownNumsRef.current[i])
      const basis = edited ? 'label' : labelBasis

      let res
      try {
        res = await fetch('/api/set-exercise?action=save-product', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          // basis, а НЕ source: какой источник записать, решает сервер
          // (api/_foodProduct.js, basisToSource). Клиент, объявляющий свою
          // карточку точной, навсегда закрыл бы её от обновления из OFF.
          body: JSON.stringify({ barcode: scannedCode, basis, ...labelForm }),
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
      // Числа на экране порции могут отличаться от только что подтверждённых —
      // молча подменять их под носом нельзя, объясняем причину. Причина
      // осталась одна: карточку на ЭТОТ код кто-то завёл раньше нас, и сервер
      // вернул её (данные OFF и чужой труд не перезаписываем).
      setProductNote(
        json.created === false ? 'Карточку на этот штрих-код уже завели раньше — используем её данные.' : null,
      )
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

  // Карточка годна к занесению в дневник? Известны все четыре числа.
  // Зеркало серверного hasUsableMacros (api/_foodProduct.js) — правило одно, но
  // проверка нужна с обеих сторон: сервер решает, что писать в общий
  // справочник, клиент — что показывать и давать нажать.
  //
  // Без этой проверки карточка с прочерками вместо цифр (Open Food Facts знает
  // товар, но не знает пищевую ценность) давала активную кнопку, а в дневник
  // уезжал ноль калорий. Человек этого не замечает — день просто считается
  // неправильно.
  //
  // Все нули при этом ЗАКОННЫ и кнопку не гасят: вода и чай без сахара —
  // настоящие 0/0/0/0. Отсутствие числа приезжает как null, и его ловит
  // проверка выше; ноль — это ответ, а не молчание.
  const usable = v => typeof v === 'number' && Number.isFinite(v)
  const macrosKnown = !!product
    && [product.kcal100, product.p100, product.c100, product.f100].every(usable)

  const addToDiary = () => {
    if (!product || gramsClamped === null || !macrosKnown) return
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
  // Сохранять нечего, пока в карточке заполнены НЕ ВСЕ четыре числа: такая
  // строка в общем справочнике хуже отсутствия — следующий отсканирует, увидит
  // название с прочерками и не сможет ни занести в дневник, ни добраться до
  // настоящих данных.
  //
  // Раньше требовалась одна калорийность, и только когда модель не дала вообще
  // ничего (labelEmpty). Карточка с белками, но без ккал проезжала насквозь и
  // ложилась в общую базу — ровно так пустые строки туда и попадали.
  // Условие зеркалит серверное hasUsableMacros; сервер теперь такую карточку
  // отвергает 400-м, и кнопка не должна доводить до этого отказа.
  //
  // ЧЕТЫРЕ НУЛЯ КНОПКУ БОЛЬШЕ НЕ ГАСЯТ — это была третья копия того же
  // ошибочного правила (первые две в hasUsableMacros и macrosKnown). Из-за неё
  // человек, сфотографировавший бутылку воды, упирался в мёртвую кнопку и
  // требование «заполни все четыре числа» — при том что все четыре заполнены,
  // просто нулями. Пустое поле по-прежнему даёт null и кнопку гасит.
  const labelNums = [labelForm.kcal100, labelForm.p100, labelForm.c100, labelForm.f100].map(parseGrams)
  const needsKcal = labelNums.some(v => v === null)

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
              {/* Фонарик — под нижним краем рамки прицела (её половина высоты
                  65px плюс отступ), чтобы палец не закрывал сам код.
                  Кнопки нет вовсе, когда камера не заявила о поддержке:
                  на десктопе этот блок не отрисуется никогда. */}
              {torchAvailable && (
                <button
                  onClick={toggleTorch}
                  aria-label={torchOn ? 'Выключить фонарик' : 'Включить фонарик'}
                  aria-pressed={torchOn}
                  style={{
                    position: 'absolute', left: '50%', top: 'calc(50% + 79px)', transform: 'translateX(-50%)',
                    display: 'flex', alignItems: 'center', gap: 7,
                    padding: '9px 16px', borderRadius: 999, minHeight: 'unset', cursor: 'pointer',
                    border: `1px solid ${torchOn ? COR : HAIR}`,
                    background: torchOn ? 'rgba(255,159,10,0.18)' : 'rgba(0,0,0,0.55)',
                    color: torchOn ? COR : TXT,
                    fontSize: 13, fontWeight: 600,
                  }}>
                  <GlassIcon name="bulb" size={18} />
                  {torchOn ? 'Фонарик включён' : 'Фонарик'}
                </button>
              )}
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
              {/* ПОМЕТОК О ПРОИСХОЖДЕНИИ ЦИФР ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО.
                  Стояли «≈ примерные значения» и «По данным карточки магазина» —
                  убраны. Человек отсканировал код и нашёл товар в справочнике;
                  откуда у нас взялись числа — ai_estimate, ai_web или чтение
                  таблицы, — наша внутренняя кухня, а не его забота.
                  Пометка на экране СВЕРКИ (ниже, stage 'confirm') остаётся: там
                  она про действие — сверь с пачкой перед тем, как это уйдёт в
                  общую базу, — а не ярлык на чужой карточке.
                  Поле source, ранги источников и вытеснение прикидок данными
                  OFF работают как работали: это правка интерфейса. */}
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

            {/* Цифр нет — объясняем ПОЧЕМУ кнопка погасла и куда идти дальше.
                Погашенная кнопка без объяснения читается как поломка. */}
            {!macrosKnown && (
              <div style={{ background: SURF2, border: `1px solid ${HAIR}`, borderRadius: 12, padding: '12px 14px', marginBottom: 12, fontSize: 15, lineHeight: 1.45, color: TXT }}>
                Продукт нашёлся, а его КБЖУ — нет. В дневник так записывать нельзя:
                день посчитается неправильно. Сними таблицу «Пищевая ценность» с упаковки
                или введи числа вручную.
              </div>
            )}

            <button onClick={addToDiary} disabled={gramsClamped === null || !macrosKnown}
              style={{ ...primaryBtn, opacity: (gramsClamped === null || !macrosKnown) ? 0.45 : 1, cursor: (gramsClamped === null || !macrosKnown) ? 'default' : 'pointer' }}>
              Добавить в дневник
            </button>
            {!macrosKnown && userId && (
              <button onClick={openPhotoPicker} style={{ ...ghostBtn, marginTop: 10 }}>Сфотографировать упаковку</button>
            )}
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

            {/* Съёмка не дала пригодных чисел, но карточка уже была — на
                экране прежние цифры. Говорим прямо и сразу даём выход. */}
            {keptPrevious && (
              <div style={{ background: SURF2, border: `1px solid ${HAIR}`, borderRadius: 12, padding: '12px 14px', marginBottom: 12, fontSize: 15, lineHeight: 1.45, color: TXT }}>
                Таблицу разобрать не смог, оставил прежние цифры.
                Переснимите резче — так, чтобы таблица занимала весь кадр, — или поправьте числа руками.
              </div>
            )}

            {/* Калорийность не сошлась с макросами по Атвотеру (4/4/9).
                Это НЕ придирка: у чипсов так вылезли 749 ккал при макросах на
                447, у молока — переставленные местами жиры и углеводы.
                Переставленное не чиним молча: какой столбец какой, знает только
                человек с пачкой в руках, а угадывать за него — то же самое, что
                оставить ошибку. */}
            {macroIssue && (
              <div style={{ background: `${COR}18`, border: `1px solid ${COR}55`, borderRadius: 12, padding: '12px 14px', marginBottom: 12, fontSize: 15, lineHeight: 1.45, color: TXT }}>
                {macroIssue === 'swapped'
                  ? 'Кажется, жиры и углеводы перепутаны местами — по калорийности сходится, если поменять их. Проверь по таблице на упаковке и поправь, или переснимите её покрупнее.'
                  : 'Калорийность не сходится с белками, жирами и углеводами. Проверь числа по таблице на упаковке — где-то съехала строка.'}
              </div>
            )}

            {/* Числа — оценка модели, а не чтение таблицы.
                Плашка СПОКОЙНАЯ, а не тревожно-жёлтая: это не ошибка и не сбой,
                а нормальный исход, когда таблицы не было в кадре. Оранжевый тут
                читался бы как «что-то пошло не так» и подталкивал переснимать
                там, где достаточно взглянуть на пачку.
                Голос — ассистента, от первого лица и обычными словами: человек
                только что дал ему фотографию и ждёт ответа, а не уведомления
                системы. Размер 15px и основной цвет текста, потому что это
                главное, что надо прочесть на экране, — раньше оно было мельче
                подписи под заголовком и терялось. */}
            {labelBasis === 'estimate' && (
              <div style={{ background: SURF2, border: `1px solid ${HAIR}`, borderRadius: 12, padding: '12px 14px', marginBottom: 12, fontSize: 15, lineHeight: 1.45, color: TXT }}>
                {labelEmpty
                  ? 'Продукт узнал, а цифры — нет. Впиши КБЖУ с упаковки, и я их запомню: дальше этот продукт будет находиться сразу.'
                  : 'Готово. Сверь с таблицей на упаковке — у разных производителей цифры отличаются. Поправишь — запомню, и дальше будет точно.'}
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
              <MacroInputs suffix="100" type="decimal" values={labelForm} highlightEmpty={needsKcal}
                onChange={(k, v) => setLabelForm(f => ({ ...f, [k]: v }))} />
            </div>

            {photoError && (
              <div style={{ fontSize: 12, color: COR, marginBottom: 10, textAlign: 'center' }}>{photoError}</div>
            )}

            {/* Неполная карточка в общем справочнике бесполезна и вредна:
                следующий отсканирует код, увидит название с прочерками и не
                сможет ни занести продукт в дневник, ни добраться до настоящих
                чисел — «уже нашли». Поэтому нужны все четыре. */}
            {needsKcal && (
              <div style={{ fontSize: 13, color: TXT2, marginBottom: 10, textAlign: 'center', lineHeight: 1.45 }}>
                Заполни все четыре числа — калорийность, белки, жиры и углеводы.
                Неполную карточку сохранить нельзя: по ней потом не посчитать день.
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
