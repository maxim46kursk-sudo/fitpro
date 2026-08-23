import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_THRESHOLDS,
  THRESHOLD_META,
  getThresholds,
  isDefaultThresholds,
  resetThresholds,
  setThresholds,
  subscribeThresholds,
} from '../exercises/thresholds.js'
import {
  buildLogText,
  copyText,
  formatLogEntry,
  formatMinDistance,
  getLive,
  getRecentLog,
} from './diagnostics.js'
import { nameOf } from '../pose/landmarks.js'
import { getAudioState, isAudioEnabled, isAudioReady } from '../feedback/audio.js'
import {
  downloadRecording,
  isRecording,
  recordedCount,
  sendRecording,
  subscribeRecorder,
  toggleRecording,
} from './recorder.js'
import { getShippedText, isShipping, logSessionId } from './logShipper.js'
import { describeAspect } from '../pose/viewport.js'
import MoveCalibration from './MoveCalibration.jsx'
import { KEYS, readRaw, writeRaw } from '../storage.js'
import { DEBUG_PARAM, readDebugParam } from './debugParam.js'

const ZONE_RU = {
  head: 'голова',
  shoulders: 'плечи',
  hips: 'бёдра',
  knees: 'колени',
  ankles: 'стопы',
}

const STORAGE_KEY = KEYS.debugOpen
/**
 * Имя ключа и его чтение переехали в `debugParam.js` — без React и без панели.
 * Тот же ключ теперь решает, публиковать ли список летящих мишеней
 * (`liveTargets.js`), а тот модуль тянется из экрана боя: импортируй он панель,
 * в бой уехала бы вся панель ради одной строки.
 *
 * Реэкспорт остаётся: на `DEBUG_PARAM` из этого файла ссылаются тесты панели.
 */
export { DEBUG_PARAM }
/** Три тапа должны уложиться в это время, иначе счётчик сбрасывается. */
const TAP_WINDOW_MS = 1200
const TAPS_REQUIRED = 3
/** Панель обновляется 10 раз в секунду — глазу хватает, телефон не греется. */
const REFRESH_MS = 100

/**
 * Панель открывается тремя способами, потому что от неё зависит вся диагностика
 * в поле, и она обязана открыться:
 *
 *   1. ?motion-debug=1 в адресе — самый надёжный: не зависит ни от попадания
 *      пальцем, ни от того, как браузер раздаёт касания у края экрана
 *   2. тройной тап по верхнему правому углу
 *   3. запомненное состояние в localStorage
 *
 * Тройной тап по невидимой мишени 68×68 в углу оказался ненадёжным на телефоне:
 * промахнуться легко, обратной связи никакой, и понять «не попал» или «не работает»
 * невозможно.
 *
 * КЛЮЧ НАЗЫВАЕТСЯ ПО ИМЕНИ МОДУЛЯ, а не просто `debug`. Пока Motion — всё
 * приложение, адрес принадлежит ему одному, и короткое имя честно. Внутри FitPro
 * адрес общий: `?debug` — слово, которое чужое приложение может завести под свою
 * отладку в любой момент, и тогда его ключ открывал бы поверх боевого экрана
 * ползунки порогов судейства. Имя с префиксом столкнуться не может ни с чем.
 *
 * Хеш `#motion-debug` остаётся вторым входом, но внутри FitPro на него полагаться
 * нельзя: хозяин переписывает адрес на старте четырьмя эффектами подряд и
 * собирает его как `pathname + '?' + params`, то есть хеш теряется до того, как
 * раздел вообще откроется.
 */
/**
 * ПАНЕЛИ НЕТ В ПРОДЕ ВОВСЕ — ни панели, ни тапов по углу, ни памяти о том, что
 * она когда-то была открыта. Пускает только `?motion-debug=1`.
 *
 * Игра уходит участникам челленджа. Тройной тап по углу задумывался как «обычный
 * пользователь такое не найдёт», но угол экрана человек задевает ладонью, когда
 * ставит телефон, — и получает поверх тренировки окно с ползунками порогов,
 * записью сырых точек и кнопкой калибровки. На кону деньги: случайно сдвинутый
 * порог это уже не косметика.
 *
 * Дев-сервер не трогаем: там панель — основной инструмент, и открывать её тапом
 * по-прежнему быстрее, чем править адрес.
 */
export function debugAllowed() {
  if (readDebugParam() === true) return true
  try {
    return !!import.meta.env?.DEV
  } catch {
    return false
  }
}

function readOpen() {
  const fromUrl = readDebugParam()
  if (fromUrl !== null) {
    writeOpen(fromUrl)
    return fromUrl
  }
  // без ключа в проде панель не открывается ничем, включая память прошлого раза
  if (!debugAllowed()) return false
  return readRaw(STORAGE_KEY) === '1'
}

function writeOpen(open) {
  writeRaw(STORAGE_KEY, open ? '1' : '0')
}

/**
 * Диагностическая панель. Открывается тройным тапом по верхнему правому углу —
 * обычный пользователь такое не найдёт, а в поле открывается одной рукой.
 */
export default function DebugPanel({ onSelectCamera }) {
  const [open, setOpen] = useState(readOpen)
  const tapsRef = useRef({ count: 0, lastAt: 0 })

  const toggle = () => {
    setOpen((prev) => {
      writeOpen(!prev)
      return !prev
    })
  }

  const handleCornerTap = () => {
    const now = Date.now()
    const taps = tapsRef.current
    taps.count = now - taps.lastAt > TAP_WINDOW_MS ? 1 : taps.count + 1
    taps.lastAt = now
    if (taps.count >= TAPS_REQUIRED) {
      taps.count = 0
      toggle()
    }
  }

  // в проде без ?motion-debug=1 нет ни панели, ни мишени тапа: клиент её не найдёт
  // даже случайно, потому что находить нечего
  if (!debugAllowed()) return null

  return (
    <>
      <div
        className="mt-debug-hit"
        onPointerDown={handleCornerTap}
        aria-hidden="true"
        data-testid="debug-hit"
      />
      {open && <PanelBody onClose={toggle} onSelectCamera={onSelectCamera} />}
    </>
  )
}

function PanelBody({ onClose, onSelectCamera }) {
  const [, forceTick] = useState(0)
  const [thresholds, setLocalThresholds] = useState(getThresholds)
  const [copied, setCopied] = useState(null)
  const [rec, setRec] = useState({ recording: isRecording(), count: recordedCount() })
  const [showText, setShowText] = useState(false)
  const [sent, setSent] = useState(null)
  /** Пороги под ползунками: разворачиваются только явным тапом. */
  const [tuning, setTuning] = useState(false)
  const [calibrating, setCalibrating] = useState(false)

  // живые цифры тянем поллингом из общей шины, а не через пропсы
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  useEffect(() => subscribeThresholds(setLocalThresholds), [])
  useEffect(() => subscribeRecorder(setRec), [])

  const live = getLive()
  const recent = getRecentLog(15)
  const audio = getAudioState()

  const onCopy = async () => {
    const ok = await copyText(buildLogText())
    setCopied(ok ? 'Скопировано' : 'Не вышло — выдели вручную')
    setTimeout(() => setCopied(null), 2000)
  }

  if (calibrating) return <MoveCalibration onClose={() => setCalibrating(false)} />

  return (
    <div className="mt-dbg">
      {/* крестик слева: справа сверху лежит невидимая мишень тройного тапа,
          она перехватила бы клик по кнопке */}
      <div className="mt-dbg__head">
        <button className="mt-dbg__x" onClick={onClose} data-testid="panel-close">
          ✕ Закрыть
        </button>
        <strong>Диагностика</strong>
      </div>

      <div className="mt-dbg__grid">
        <Row
          k="поток"
          v={
            live.camera?.width
              ? `${live.camera.width}×${live.camera.height} · ${describeAspect(live.camera.width, live.camera.height)}`
              : '—'
          }
        />
        <Row
          k="зум"
          v={
            live.camera?.zoomRange
              ? `${live.camera.zoom ?? '?'} (мин ${live.camera.zoomRange.min}, макс ${live.camera.zoomRange.max})`
              : 'камера не сообщает'
          }
          bad={
            !!live.camera?.zoomRange &&
            live.camera.zoom != null &&
            live.camera.zoom > live.camera.zoomRange.min
          }
        />
        <Row k="object-fit" v={live.videoFit || '—'} bad={live.videoFit === 'cover'} />
        <Row
          k="показ"
          v={
            live.videoSync === 'sync'
              ? 'синхронный: кадр и поза вместе'
              : `живое видео${live.videoSyncWhy ? ` — ${live.videoSyncWhy}` : ''}`
          }
          // живое видео это резерв: скелет на нём отстаёт от тела на инференс
          bad={live.videoSync != null && live.videoSync !== 'sync'}
        />
        <Row k="мин. дистанция" v={formatMinDistance(live.camera)} />
        <Row k="камера" v={live.camera?.label || '—'} />
        <Row k="инференс" v={`${live.fps} fps · ${Math.round(live.inferenceMs)} мс`} />
        <Row
          k="считает в"
          v={live.thread === 'main' ? 'ГЛАВНЫЙ ПОТОК — резерв, воркер не поднялся' : 'воркере'}
          bad={live.thread === 'main'}
        />
        <Row
          k="зоны тела"
          v={
            Object.keys(live.zones || {}).length
              ? Object.entries(live.zones)
                  .map(([k, v]) => `${v ? '✓' : '✗'}${ZONE_RU[k] || k}`)
                  .join(' ')
              : '—'
          }
          bad={Object.values(live.zones || {}).some((v) => !v)}
        />
        <Row k="причина" v={live.frameReason || '—'} bad={live.frameReason && live.frameReason !== 'ok'} />
        <Row
          k="fps сессии"
          v={
            live.perf
              ? `мин ${live.perf.fpsMin ?? '—'} · сред ${live.perf.fpsAvg == null ? '—' : live.perf.fpsAvg.toFixed(1)} · макс ${live.perf.fpsMax ?? '—'}`
              : '—'
          }
          bad={!!live.perf?.fpsMin && live.perf.fpsMin < 10}
        />
        <Row
          k="инференс сессии"
          v={
            live.perf
              ? `сред ${live.perf.inferenceAvg == null ? '—' : Math.round(live.perf.inferenceAvg)} · макс ${Math.round(live.perf.inferenceMax)} мс`
              : '—'
          }
        />
        <Row
          k="задержка"
          v={live.perf ? `${Math.round(live.perf.latencyMs)} · макс ${Math.round(live.perf.latencyMax)} мс` : '—'}
          bad={!!live.perf && live.perf.latencyMs > 300}
        />
        <Row
          k="дроп/зависания"
          v={live.perf ? `${live.perf.dropped} / ${live.perf.stalls} · смен делегата ${live.perf.delegateSwitches}` : '—'}
          bad={!!live.perf && (live.perf.stalls > 0 || live.perf.delegateSwitches > 0)}
        />
        <Row
          k="режим глубины"
          v={live.mode === 'hip' ? 'резервный по тазу' : 'по колену'}
          bad={live.mode === 'hip'}
        />
        <Row
          k="захват кадра"
          v={`${live.perf?.grabMode || '—'}${live.perf?.grabErrors ? ` · ошибок ${live.perf.grabErrors}` : ''} · кадров ${live.perf?.results ?? 0}`}
          bad={!!live.perf && (live.perf.grabErrors > 0 || live.perf.results === 0)}
        />
        {/* Почему последний закрытый цикл не стал повтором — без этого
            отладка счётчика в поле идёт вслепую. */}
        <Row
          k="отклонён цикл"
          v={live.lastReject || (live.reps ? 'нет, последний засчитан' : 'циклов ещё не было')}
          bad={!!live.lastReject}
        />
        <Row
          k="звук"
          v={
            !isAudioEnabled()
              ? 'выключен тумблером'
              : isAudioReady()
                ? 'сигналы включены'
                : 'ждёт касания экрана'
          }
          bad={isAudioEnabled() && !isAudioReady()}
        />
        {/* Сырое состояние из самого модуля — то же, что уходит в лог снимком. */}
        <Row
          k="звук (сырое)"
          v={`${audio.enabled ? 'вкл' : 'выкл'}, контекст: ${audio.ctxState}`}
          bad={audio.enabled && audio.ctxState !== 'running'}
        />
        <Row
          k="калибровка"
          v={
            thresholds.standAngle == null
              ? 'ещё не мерена — постой в кадре 2 с'
              : `стойка ${thresholds.standAngle}° -> UP ${thresholds.upAngle}° / DOWN ${thresholds.downAngle}°`
          }
          bad={thresholds.standAngle == null}
        />
        <Row
          k="лог"
          v={isShipping() ? `шлётся на компьютер (${logSessionId()})` : 'только на устройстве'}
        />
        <Row k="экран" v={live.screen} />
        <Row
          k="угол"
          v={`${fmt(live.angle, 1)}° сглаж · ${fmt(live.rawAngle, 1)}° сырой`}
        />
        <Row k="автомат" v={`${live.state || '—'} · ${zoneLabel(live.zone)}`} />
        <Row k="повторов" v={live.reps} />
        <Row k="мин. в повторе" v={live.minAngleInRep == null ? '—' : `${fmt(live.minAngleInRep, 1)}°`} />
        <Row
          k="в кадре"
          v={
            live.outOfFrame
              ? `нет — ${live.missing?.length ? live.missing.map(nameOf).join(', ') : 'точек нет вообще'}`
              : 'да'
          }
          bad={live.outOfFrame}
        />
      </div>

      {/* Постоянная строка по каждой из шести ключевых точек: без неё
          пороги видимости настраиваются вслепую. */}
      <div className="mt-dbg__points" data-testid="point-rows">
        <div className="mt-dbg__k">точки: visibility · координата (порог)</div>
        {live.points?.length ? (
          live.points.map((p) => (
            <div key={p.index} className={`mt-dbg__point ${p.ok ? '' : 'is-bad'}`}>
              <span>{nameOf(p.index)}</span>
              <span>
                {p.visibility == null ? '—' : p.visibility.toFixed(2)}
                <i> /{p.threshold}</i>
              </span>
              <span>
                {p.x == null ? '—' : `${p.x.toFixed(2)}, ${p.y.toFixed(2)}`}
              </span>
              <span>{p.ok ? '✓' : '✗'}</span>
            </div>
          ))
        ) : (
          <div className="mt-dbg__empty">нет данных</div>
        )}
      </div>

      {live.devices?.length > 1 && (
        <div className="mt-dbg__cams">
          <div className="mt-dbg__k">камеры устройства ({live.devices.length}) — можно переключить</div>
          {live.devices.map((d) => (
            <button
              key={d.deviceId}
              className={`mt-dbg__cam ${d.deviceId === live.camera?.deviceId ? 'is-active' : ''}`}
              onClick={() => onSelectCamera?.(d.deviceId)}
            >
              {d.deviceId === live.camera?.deviceId ? '● ' : '○ '}
              {d.label}
            </button>
          ))}
        </div>
      )}

      {/* Запись сырых точек: единственный способ настраивать пороги по факту,
          а не по описанию «считает не идеально». */}
      {/* Пошаговая запись движений: единственный способ получить материал по
          движению, которое не ловится, — в игре обучение уводит дальше. */}
      <div className="mt-dbg__sliders">
        <button
          className="mt-dbg__btn"
          data-testid="open-calibration"
          onClick={() => setCalibrating(true)}
        >
          Калибровка движений
        </button>
      </div>

      <div className="mt-dbg__sliders">
        <button
          className={`mt-dbg__btn ${rec.recording ? 'is-active' : ''}`}
          data-testid="record-toggle"
          onClick={() => setRec({ recording: toggleRecording(), count: recordedCount() })}
        >
          {rec.recording ? `● ИДЁТ ЗАПИСЬ — кадров ${rec.count}` : '○ Записать сырые точки'}
        </button>
        <button
          className="mt-dbg__btn"
          data-testid="log-download"
          onClick={() => {
            const text = [buildLogText(), '', '--- события ---', getShippedText()].join('\n')
            const blob = new Blob([text], { type: 'text/plain' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `${logSessionId()}.log`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            setTimeout(() => URL.revokeObjectURL(url), 5000)
          }}
        >
          Скачать лог файлом
        </button>
        {/* Запись, скачанная на телефон, там и остаётся — с дев-сервера она
            уезжает прямо в recordings/, где её ждут разбор и тест. */}
        <button
          className="mt-dbg__btn"
          disabled={!rec.count}
          data-testid="record-send"
          onClick={async () => {
            setSent('отправляю…')
            const meta = {
              thresholds: getThresholds(),
              camera: live.camera,
              delegate: live.delegate,
              fps: live.fps,
            }
            const result = await sendRecording(meta)
            setSent(
              result.ok
                ? `на компьютере: ${result.file}`
                : `не ушло (${result.error}) — скачай файлом`,
            )
            setTimeout(() => setSent(null), 6000)
          }}
        >
          {sent || `Отправить запись на компьютер (${rec.count} кадров)`}
        </button>
        <button
          className="mt-dbg__btn"
          disabled={!rec.count}
          data-testid="record-download"
          onClick={() =>
            downloadRecording({
              thresholds: getThresholds(),
              camera: live.camera,
              delegate: live.delegate,
              fps: live.fps,
            })
          }
        >
          Скачать запись ({rec.count} кадров)
        </button>
      </div>

      {/*
        Пороги спрятаны под явный тап. На телефоне панель листают пальцем, и
        ползунок сдвигается от одного касания — человек уезжает с рабочих
        порогов, сам того не заметив, а потом «счётчик врёт». Состояние не
        запоминается: каждое открытие панели начинается со свёрнутого блока.
      */}
      <div className="mt-dbg__sliders">
        <button
          className="mt-dbg__btn"
          data-testid="thresholds-toggle"
          onClick={() => setTuning((v) => !v)}
        >
          Настройки порогов {tuning ? '▾' : '▸'}
        </button>
      </div>

      {tuning && (
        <>
          <div className="mt-dbg__warn" data-testid="thresholds-warning">
            Менять только по инструкции разработчика
          </div>
        {/* Аварийный откат на старую логику прямо с устройства. */}
        <div className="mt-dbg__sliders">
          <button
            className={`mt-dbg__btn ${thresholds.autoCalibrate ? 'is-active' : ''}`}
            data-testid="auto-calibrate"
            onClick={() => setThresholds({ autoCalibrate: !thresholds.autoCalibrate })}
          >
            {thresholds.autoCalibrate
              ? '● Пороги подстраиваются под твою стойку'
              : '○ Пороги фиксированные (без калибровки)'}
          </button>
          <button
            className={`mt-dbg__btn ${thresholds.simpleMode ? 'is-active' : ''}`}
            data-testid="simple-mode"
            onClick={() => setThresholds({ simpleMode: !thresholds.simpleMode })}
          >
            {thresholds.simpleMode
              ? '● ПРОСТОЙ РЕЖИМ: только пороги (форма цикла не проверяется)'
              : '○ Простой режим — откат на старую логику порогов'}
          </button>
        </div>

        <div className="mt-dbg__sliders">
          {THRESHOLD_META.map((meta) => (
            <label key={meta.key} className="mt-dbg__slider">
              <span>
                {meta.label}
                <b>
                  {thresholds[meta.key]}
                  {meta.unit}
                </b>
              </span>
              <input
                type="range"
                min={meta.min}
                max={meta.max}
                step={meta.step}
                value={thresholds[meta.key]}
                onChange={(e) => setThresholds({ [meta.key]: Number(e.target.value) })}
              />
            </label>
          ))}
          <button className="mt-dbg__btn" onClick={resetThresholds} disabled={isDefaultThresholds()}>
            Сбросить к значениям по умолчанию (
            {DEFAULT_THRESHOLDS.upAngle}/{DEFAULT_THRESHOLDS.downAngle})
          </button>
        </div>
        </>
      )}

      <div className="mt-dbg__log">
        <div className="mt-dbg__logHead">
          <span>Лог повторов</span>
          <button className="mt-dbg__btn mt-dbg__btn--inline" onClick={onCopy}>
            {copied || 'Скопировать лог'}
          </button>
          <button
            className="mt-dbg__btn mt-dbg__btn--inline"
            data-testid="log-as-text"
            onClick={() => setShowText((v) => !v)}
          >
            {showText ? 'Свернуть' : 'Текстом'}
          </button>
        </div>
        {/* На iOS буфер обмена часто недоступен из скрипта — тогда лог можно
            выделить и скопировать вручную долгим нажатием. */}
        {showText && (
          <textarea
            className="mt-dbg__text"
            data-testid="log-text"
            readOnly
            rows={12}
            value={buildLogText()}
            onFocus={(e) => e.target.select()}
          />
        )}
        {recent.length === 0 && <div className="mt-dbg__empty">пока пусто</div>}
        {recent.map((e) => (
          <div key={e.key} className={`mt-dbg__row mt-dbg__row--${e.kind}`}>
            {formatLogEntry(e)}
          </div>
        ))}
      </div>
    </div>
  )
}

function Row({ k, v, bad }) {
  return (
    <>
      <span className="mt-dbg__k">{k}</span>
      <span className={`mt-dbg__v ${bad ? 'is-bad' : ''}`}>{v}</span>
    </>
  )
}

function fmt(v, digits) {
  return v == null ? '—' : v.toFixed(digits)
}

function zoneLabel(zone) {
  if (zone === 'up') return 'зона UP'
  if (zone === 'down') return 'зона DOWN'
  if (zone === 'dead') return 'мёртвая зона'
  return '—'
}
