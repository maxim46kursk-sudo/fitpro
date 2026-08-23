/**
 * ОТКРЫТИЕ И ЗАКРЫТИЕ РАЗДЕЛА — одно место на весь модуль.
 *
 * Зачем это вообще понадобилось. Motion писался как всё приложение, и у всего
 * приложения есть одна особенность: оно закрывается вместе со страницей. Поэтому
 * модульное состояние можно было не сбрасывать (его убирала перезагрузка),
 * слушатели на window можно было не снимать (окно умирало вместе с ними), а
 * AudioContext можно было не закрывать (его закрывал браузер).
 *
 * Внутри FitPro не верно ни одно из трёх. Раздел открывается и закрывается
 * сколько угодно раз за одну загрузку страницы, а всё, что модуль оставил после
 * себя, продолжает жить в чужом приложении: слушатели ловят чужие касания,
 * потолок ошибок молчит про чужие падения, выключенная отправка лога не
 * включается обратно, а незакрытый AudioContext держит аудиовыход телефона.
 *
 * СИММЕТРИЯ ЗДЕСЬ — ГЛАВНОЕ. Каждой строке в openMotion соответствует строка в
 * закрытии, и наоборот. Пока обе половины лежат рядом, забыть одну из них
 * заметно глазами; разложенные по десяти модулям, они расходятся молча — и
 * расходились: слушатели logShipper вешались при импорте, а снимал их никто.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Сюда не переезжает ничто, что и так снимается своим хуком:
 * камера гаснет в cleanup useCamera, воркер завершается в cleanup
 * usePoseLandmarker, ориентация и wake lock снимают своих слушателей сами. Это
 * не забывчивость, а граница: React уже гарантирует симметрию для того, что
 * живёт внутри его дерева, и дублировать её значит получить два места, где
 * закрывают камеру.
 */

import { disposeAudio } from './feedback/audio.js'
import { resetCalibration } from './debug/calibrationMode.js'
import { resetDiagnostics } from './debug/diagnostics.js'
import { resetErrorReporter, installErrorReporter } from './debug/errorReporter.js'
import { attachLogShipper, flush, resetLogShipper } from './debug/logShipper.js'
import { resetRecorder } from './debug/recorder.js'
import { resetLiveTargets } from './debug/liveTargets.js'

/**
 * Открыть раздел: забыть прошлый заход и повесить то, что живёт дольше рендера.
 *
 * ПОРЯДОК ЗНАЧИМ. Сбросы идут ДО подписок: сначала чистая память, потом
 * слушатели, которые в неё пишут. Иначе первое же событие нового захода легло бы
 * в буфер прошлого и уехало бы с его номером сессии.
 *
 * @returns {() => void} закрыть раздел. Идемпотентно: второй вызов ничего не
 *   делает — React в StrictMode зовёт cleanup дважды, и падать на этом нельзя.
 */
export function openMotion() {
  resetLogShipper()
  resetErrorReporter()
  resetDiagnostics()
  resetRecorder()
  resetLiveTargets()
  resetCalibration()

  const detachLog = attachLogShipper()
  const uninstallReporter = installErrorReporter()

  let closed = false
  return function closeMotion() {
    if (closed) return
    closed = true

    // Сначала снимаем слушатели, потом отдаём накопленное: иначе flush мог бы
    // разойтись с последним событием, которое эти же слушатели и пишут.
    uninstallReporter()
    detachLog()

    /**
     * Последняя отправка — ДО сброса буфера. Человек закрыл раздел на середине
     * тренировки, и именно этот лог объясняет, почему он его закрыл; выбросить
     * его вместе с остальным состоянием значило бы потерять ровно ту сессию,
     * ради которой лог и читают.
     */
    flush()

    disposeAudio()
    resetRecorder()
    resetLiveTargets()
    resetCalibration()
  }
}
