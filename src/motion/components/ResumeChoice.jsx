import { closePending, dropSession } from '../game/day.js'

/**
 * НЕЗАВЕРШЁННАЯ СЕССИЯ: ПРОДОЛЖИТЬ ИЛИ НАЧАТЬ ЗАНОВО.
 *
 * Один компонент на оба экрана, где этот выбор встречается: перед выбором
 * уровня и в комнате, на ячейке дня. Разъедься они — человек получил бы два
 * разных ответа на один вопрос, а «Начать заново» в одном месте закрывало бы
 * попытку, а в другом нет. Здесь же и вся механика закрытия, чтобы её нельзя
 * было забыть на втором вызове.
 *
 * ПОЧЕМУ ВЫБОР, А НЕ АВТОМАТИЧЕСКОЕ ПРОДОЛЖЕНИЕ. Сессия идёт двадцать минут, и
 * человек, вернувшийся через день, может хотеть и того и другого: доиграть
 * начатое или переиграть его целиком с чистого листа. Решить за него нельзя —
 * оба варианта тратят его попытки по-разному.
 */
export default function ResumeChoice({ resume, onContinue, onRestart, compact = false }) {
  if (!resume) return null
  return (
    <div
      className={`mt-levels__resume ${compact ? 'mt-levels__resume--compact' : ''}`}
      data-testid="session-resume"
    >
      <div className="mt-levels__resumeTitle">Тренировка начата и не завершена</div>
      <div className="mt-levels__resumeText">
        {`Круг ${resume.cycle}, набрано ${resume.totals?.score ?? 0}`}
      </div>
      <button
        type="button"
        className="mt-levels__resumeGo"
        data-testid="session-resume-continue"
        onClick={() => onContinue?.(resume)}
      >
        Продолжить со следующего круга
      </button>
      <button
        type="button"
        className="mt-levels__resumeDrop"
        data-testid="session-resume-restart"
        onClick={() => {
          /**
           * НАЧАТЬ ЗАНОВО = закрыть прошлый заход честной попыткой. Он
           * состоялся: человек играл, набирал очки, и растворять его в новом
           * заходе значило бы потерять его результат вовсе.
           */
          closePending()
          dropSession()
          onRestart?.()
        }}
      >
        Начать заново
      </button>
    </div>
  )
}
