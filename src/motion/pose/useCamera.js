import { useCallback, useEffect, useRef, useState } from 'react'
import { logEvent } from '../debug/logShipper.js'
import { KEYS, readRaw, remove, writeRaw } from '../storage.js'

/**
 * Доступ к камере. Возвращает поток, параметры трека и список камер устройства.
 * Коды ошибок: INSECURE_CONTEXT | PERMISSION_DENIED | NO_CAMERA | CAMERA_FAILED
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

    // getUserMedia существует только в secure context (https или localhost).
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setStatus('error')
      setErrorCode('INSECURE_CONTEXT')
      return undefined
    }

    setStatus('requesting')

    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, frameRate: { ideal: 30 } }
        : { facingMode, frameRate: { ideal: 30 } },
    }

    navigator.mediaDevices
      .getUserMedia(constraints)
      .then(async (mediaStream) => {
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
        setStatus('ready')
      })
      .catch((error) => {
        if (cancelled) return
        // Сохранённая камера могла исчезнуть — откатываемся на facingMode.
        if (deviceId) {
          writeStoredDeviceId(null)
          setDeviceId(null)
          return
        }
        logEvent('camera.error', { name: error?.name, message: error?.message })
        setStatus('error')
        setErrorCode(mapCameraError(error))
      })

    return () => {
      cancelled = true
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
