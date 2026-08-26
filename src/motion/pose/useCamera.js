import { useCallback, useEffect, useRef, useState } from 'react'
import { cameraEnv } from '../device/browserEnv.js'
import { logEvent } from '../debug/logShipper.js'
import { KEYS, readRaw, remove, writeRaw } from '../storage.js'

/**
 * Доступ к камере. Возвращает поток, параметры трека и список камер устройства.
 * Коды ошибок: INSECURE_CONTEXT | PERMISSION_DENIED | NO_CAMERA | CAMERA_FAILED
 *              | CAMERA_TIMEOUT
 *
 * ВАЖНО про constraints: здесь НЕ запрашивается ни aspectRatio, ни width/height.
 * Любой запрос соотношения заставляет браузер кропать кадр под него, а кроп по
 * краям — это фактически зум: человек перестаёт влезать с нормального расстояния.
 * Берём нативный формат сенсора как есть, а вертикальную картинку делает вёрстка
 * (`object-fit: contain`), а не камера.
 */

const STORAGE_KEY = KEYS.cameraDevice

/**
 * Ниже этих значений камера считается ОСЛАБЛЕННОЙ. 24 кадра в секунду — та
 * граница, за которой распознавание начинает пропускать быстрые движения;
 * 480 точек в ширину — ровно столько уходит в модель (INFERENCE_WIDTH), и
 * меньше значит, что кадр к тому же растягивается.
 *
 * Отдельная строка в логе нужна потому, что camera.ready читают как «всё в
 * порядке», и жалоба «игра рваная» после неё разбирается вслепую.
 */
const MIN_FRAME_RATE = 24
const MIN_WIDTH = 480

/**
 * Метки камер, которые фронталкой быть не должны: телевик режет обзор,
 * depth/IR-сенсоры для видео не годятся. На Android метки часто безликие
 * («camera2 1, facing front») — тогда эвристика просто не сработает,
 * и остаётся ручной выбор из диагностической панели.
 */
const SUSPICIOUS_LABEL = /tele|telephoto|depth|infrared|\bir\b|monochrome|macro/i

/**
 * СКОЛЬКО ЖДЁМ ОТВЕТА ОТ getUserMedia, ПРЕЖДЕ ЧЕМ СЧИТАТЬ, ЧТО ЕГО НЕ БУДЕТ.
 *
 * Обещание камеры не обязано разрешаться вообще. Внутри встроенного браузера
 * (Instagram и подобные на iOS) оно не отвечает ни успехом, ни отказом —
 * навсегда. Прежний код в этом случае оставлял `status === 'requesting'`, то
 * есть экран калибровки без картинки, без ошибки и без единой строки в
 * журнале; самая долгая такая сессия в проде висела 54 минуты.
 *
 * Десять секунд — это заведомо больше любого честного ответа (разрешение уже
 * выдано — доли секунды; спрашивают впервые — столько, сколько человек читает
 * системный вопрос) и заведомо меньше терпения человека перед мёртвым экраном.
 *
 * ВАЖНО: истёкшее ожидание НЕ отменяет запрос. Человек мог просто думать над
 * системным вопросом; ответит — камера поднимется и экран сменится сам
 * (см. ниже: `then` и `catch` продолжают работать после срабатывания часов).
 */
const CAMERA_TIMEOUT_MS = 10000

export function useCamera({ enabled = true, facingMode = 'user' } = {}) {
  const [stream, setStream] = useState(null)
  const [status, setStatus] = useState('idle') // idle | requesting | ready | error
  const [errorCode, setErrorCode] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [devices, setDevices] = useState([])
  const [info, setInfo] = useState(null)
  const [deviceId, setDeviceId] = useState(readStoredDeviceId)

  const streamRef = useRef(null)
  /** Автовыбор камеры делаем один раз за сессию, иначе можно уйти в цикл. */
  const autoPickedRef = useRef(false)

  const retry = useCallback(() => {
    setErrorCode(null)
    setStatus('idle')
    setAttempt((n) => n + 1)
  }, [])

  const selectDevice = useCallback((id) => {
    writeStoredDeviceId(id)
    autoPickedRef.current = true
    setDeviceId(id)
  }, [])

  useEffect(() => {
    if (!enabled) return undefined

    let cancelled = false

    /**
     * ОТКАЗ ДО ЗАПРОСА ТОЖЕ ПИШЕТСЯ В ЖУРНАЛ. Раньше эта ветка молчала: код
     * ошибки выставлялся, экран показывался, а в логе не оставалось НИЧЕГО —
     * ни `camera.ready`, ни `camera.error`. То есть сессия, где камеры не было
     * по самой очевидной причине, выглядела точно так же, как зависшая, и
     * отличить их при разборе было нечем.
     */
    // getUserMedia существует только в secure context (https или localhost).
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      logEvent('camera.error', { name: 'INSECURE_CONTEXT', ...cameraEnv() })
      setStatus('error')
      setErrorCode('INSECURE_CONTEXT')
      return undefined
    }

    setStatus('requesting')

    /**
     * Часы молчания. Снимаются любым исходом запроса — и успехом, и отказом, —
     * поэтому выстрелить могут только там, где не случилось ни того, ни другого.
     */
    let settled = false
    const watchdog = setTimeout(() => {
      if (cancelled || settled) return
      logEvent('camera.timeout', { ждали: CAMERA_TIMEOUT_MS, ...cameraEnv() })
      setStatus('error')
      setErrorCode('CAMERA_TIMEOUT')
    }, CAMERA_TIMEOUT_MS)
    /**
     * Ответ пришёл — часы больше не нужны. Отдельной функцией, потому что
     * снимать их надо в трёх местах (успех, отказ, размонтирование), и
     * забытое четвёртое место стоило бы ложной ошибки на живой камере.
     */
    const settle = () => {
      settled = true
      clearTimeout(watchdog)
    }

    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, frameRate: { ideal: 30 } }
        : { facingMode, frameRate: { ideal: 30 } },
    }

    navigator.mediaDevices
      .getUserMedia(constraints)
      .then(async (mediaStream) => {
        settle()
        if (cancelled) {
          stopStream(mediaStream)
          return
        }

        const track = mediaStream.getVideoTracks()[0]
        await resetZoom(track)

        // Метки камер доступны только после выданного разрешения.
        const list = await listCameras()
        if (cancelled) {
          stopStream(mediaStream)
          return
        }
        setDevices(list)

        // Если по facingMode досталась подозрительная камера, а нормальная
        // фронталка в списке есть — переключаемся на неё один раз.
        if (!deviceId && !autoPickedRef.current) {
          autoPickedRef.current = true
          const better = pickBetterFrontCamera(track, list)
          if (better) {
            stopStream(mediaStream)
            /**
             * Переключение камеры — тоже причина, по которой `camera.ready` в
             * этом заходе не появится: поток отпущен, и всё начнётся заново с
             * другим deviceId. Без этой строки промежуток между двумя запросами
             * выглядел в журнале провалом в никуда.
             */
            logEvent('camera.switch', { почему: 'подозрительная фронталка' })
            setDeviceId(better)
            return
          }
        }

        streamRef.current = mediaStream
        setStream(mediaStream)
        const described = describeTrack(track, list)
        /**
         * В ЖУРНАЛ — БЕЗ МЕТКИ И БЕЗ deviceId.
         *
         * Метка камеры почти всегда содержит модель устройства («Galaxy A54
         * front camera»), а deviceId — устойчивый отпечаток этого устройства.
         * Вместе они опознают человека надёжнее, чем нужно для разбора жалоб на
         * картинку. Всё техническое остаётся: разрешение, частота кадров,
         * фронтальная или тыловая, зум и его пределы — по ним и разбирают
         * «зум», «кроп» и «рвано».
         *
         * describeTrack продолжает отдавать полный набор: метка нужна выбору
         * камеры в диагностической панели, и она никуда не уезжает.
         */
        logEvent('camera.ready', logSafeCamera(described))
        if (
          (described.frameRate != null && described.frameRate < MIN_FRAME_RATE) ||
          (described.width != null && described.width < MIN_WIDTH)
        ) {
          logEvent('camera.degraded', {
            width: described.width,
            height: described.height,
            frameRate: described.frameRate,
          })
        }
        setInfo(described)
        /**
         * ОТВЕТ ПОСЛЕ ИСТЁКШИХ ЧАСОВ ОТМЕНЯЕТ ИХ ПРИГОВОР. Человек думал над
         * системным вопросом дольше десяти секунд и всё-таки разрешил —
         * оставить его при этом на экране «камера не ответила» значило бы
         * соврать ровно в тот момент, когда всё заработало.
         */
        setErrorCode(null)
        setStatus('ready')
      })
      .catch((error) => {
        settle()
        if (cancelled) return
        // Сохранённая камера могла исчезнуть — откатываемся на facingMode.
        if (deviceId) {
          /**
           * Тоже бывшая немая ветка: заход кончался без единой строки, а
           * следующий начинался как будто на пустом месте.
           */
          logEvent('camera.retry-default', { name: error?.name })
          writeStoredDeviceId(null)
          setDeviceId(null)
          return
        }
        logEvent('camera.error', { name: error?.name, message: error?.message, ...cameraEnv() })
        setStatus('error')
        setErrorCode(mapCameraError(error))
      })

    return () => {
      cancelled = true
      settle()
      stopStream(streamRef.current)
      streamRef.current = null
      setStream(null)
    }
  }, [enabled, facingMode, attempt, deviceId])

  return { stream, status, errorCode, retry, devices, info, selectDevice, deviceId }
}

function stopStream(mediaStream) {
  mediaStream?.getTracks?.().forEach((t) => t.stop())
}

/**
 * Часть Android-камер стартует с ненулевым зумом — принудительно уводим
 * в минимум, иначе теряется обзор ровно так же, как от кропа.
 */
async function resetZoom(track) {
  try {
    const caps = track?.getCapabilities?.()
    if (!caps || typeof caps.zoom?.min !== 'number') return
    const settings = track.getSettings?.() || {}
    if (settings.zoom === caps.zoom.min) return
    await track.applyConstraints({ advanced: [{ zoom: caps.zoom.min }] })
  } catch {
    // не поддерживается — не беда
  }
}

async function listCameras() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all
      .filter((d) => d.kind === 'videoinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label || 'камера без названия' }))
  } catch {
    return []
  }
}

/** @returns {string|null} deviceId камеры получше, либо null если текущая нормальная */
function pickBetterFrontCamera(track, list) {
  const current = track?.getSettings?.().deviceId
  const currentLabel = list.find((d) => d.deviceId === current)?.label || track?.label || ''

  if (!SUSPICIOUS_LABEL.test(currentLabel)) return null

  const alternative = list.find(
    (d) => d.deviceId !== current && !SUSPICIOUS_LABEL.test(d.label),
  )
  return alternative?.deviceId || null
}

/**
 * То же описание камеры, но без того, что опознаёт устройство и человека.
 * Экспортируется ради теста: правило «метки в журнале нет» должно быть
 * проверяемым, а не обещанным в комментарии.
 */
export function logSafeCamera(info) {
  if (!info) return null
  const { label, deviceId, ...safe } = info
  void label
  void deviceId
  return safe
}

function describeTrack(track, list) {
  const settings = track?.getSettings?.() || {}
  const caps = track?.getCapabilities?.() || {}
  const label = list.find((d) => d.deviceId === settings.deviceId)?.label || track?.label || '—'

  return {
    label,
    deviceId: settings.deviceId || null,
    width: settings.width || null,
    height: settings.height || null,
    frameRate: settings.frameRate || null,
    facingMode: settings.facingMode || null,
    zoom: typeof settings.zoom === 'number' ? settings.zoom : null,
    zoomRange:
      typeof caps.zoom?.min === 'number' ? { min: caps.zoom.min, max: caps.zoom.max } : null,
  }
}

function readStoredDeviceId() {
  return readRaw(STORAGE_KEY) || null
}

function writeStoredDeviceId(id) {
  if (id) writeRaw(STORAGE_KEY, id)
  else remove(STORAGE_KEY)
}

function mapCameraError(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'PERMISSION_DENIED'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'NO_CAMERA'
    default:
      return 'CAMERA_FAILED'
  }
}
