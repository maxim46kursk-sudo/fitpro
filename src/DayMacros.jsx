import { TXT, TXT2, TXT3, TEA, BLU, COR, KCAL, PUR } from './theme.js'
import { overBy, pctOf, remainingOf } from './foodMeals.js'

/**
 * СЪЕДЕНО ЗА ДЕНЬ ПРОТИВ НОРМЫ — один блок на всё приложение.
 *
 * Жил внутри дневника питания разметкой по месту. Понадобился второй раз — в
 * комнате участника челленджа, где питание половина зачёта, — и вот тут-то
 * выяснилось, ради чего его стоит вынести. В комнате стояли четыре сухие
 * плитки «осталось 2000 ккал»: человек видел, сколько ему ЕЩЁ надо, и не видел,
 * сколько уже съел. Ноль и две тысячи выглядели одинаково, и понять по такому
 * блоку, идёшь ты в норму или нет, было нельзя.
 *
 * Нарисовать рядом второй такой же блок было бы худшим из решений: два
 * изображения одних и тех же данных расходятся на первой же правке — в дневнике
 * поправили коридор, а в комнате осталось по-старому, и человек увидел бы в
 * двух местах разные цифры о собственном дне.
 *
 * ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ. Есть съеденное, норма, остаток (или перебор) и
 * четыре шкалы. Нет ни даты, ни переключателя дней, ни загрузки, ни ошибок —
 * это обвязка дневника, и в комнате её нет. Блок получает два объекта чисел и
 * ничего не спрашивает у сети.
 *
 * ЗАЧЁТ ЧЕЛЛЕНДЖА ЭТОТ БЛОК НЕ СЧИТАЕТ. Проценты питания в потоке считает
 * src/challengeNutrition.js по своим правилам (коридор, порог приёмов пищи), и
 * заполненность шкалы здесь — это «сколько съедено от нормы», а не «сколько
 * баллов за день». Путать их нельзя: шкала на сто процентов и сто баллов — не
 * одно и то же.
 */

/** Строки шкал: подпись, ключ, цвет. Порядок тот же, что в дневнике. */
const BARS = [
  ['Белки', 'p', TEA],
  ['Углеводы', 'c', BLU],
  ['Жиры', 'f', COR],
]

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * @param {{kcal: number, p: number, c: number, f: number}} props.totals съедено
 * @param {{kcal: number, p: number, c: number, f: number}} props.goals норма
 * @param {() => void} [props.onSetGoal] нормы нет — увести туда, где её задают.
 *   Не дали — вместо кнопки молчание: бывает место, где вести человека некуда.
 * @param {string} [props.testId]
 */
export default function DayMacros({ totals, goals, onSetGoal = null, testId = 'day-macros' }) {
  const eaten = {
    kcal: Math.round(num(totals?.kcal)),
    p: num(totals?.p),
    c: num(totals?.c),
    f: num(totals?.f),
  }
  const goal = {
    kcal: Math.round(num(goals?.kcal)),
    p: num(goals?.p),
    c: num(goals?.c),
    f: num(goals?.f),
  }
  const hasGoal = goal.kcal > 0
  const over = overBy(eaten.kcal, goal.kcal)

  return (
    <div data-testid={testId}>
      {/* Съеденное — крупно, норма рядом мелко: главный вопрос «сколько я уже» */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        <div
          data-testid={`${testId}-kcal`}
          style={{ fontSize: 44, fontWeight: 800, color: TXT, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}
        >
          {eaten.kcal}
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: TXT3, paddingBottom: 4 }}>
          {hasGoal ? `из ${goal.kcal} ккал` : 'ккал'}
        </div>
      </div>

      {/* Остаток или перебор — одной строкой, крупно. Норма не задана — вместо
          остатка ссылка туда, где её задают: без неё «осталось» не из чего
          считать, а промолчать значило бы спрятать настройку. */}
      {hasGoal ? (
        <div
          data-testid={`${testId}-left`}
          style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: over > 0 ? COR : TEA }}
        >
          {over > 0 ? `перебор ${over} ккал` : `осталось ${remainingOf(eaten.kcal, goal.kcal)} ккал`}
        </div>
      ) : onSetGoal ? (
        <button
          type="button"
          onClick={onSetGoal}
          data-testid={`${testId}-set-goal`}
          style={{ background: 'none', border: 'none', color: PUR, fontSize: 13, fontWeight: 700, cursor: 'pointer', padding: 0, marginBottom: 12, minHeight: 'unset' }}
        >
          Задать норму
        </button>
      ) : null}

      <div style={{ height: 10, background: 'rgba(255,255,255,.10)', borderRadius: 6, overflow: 'hidden', marginBottom: 14 }}>
        <div style={{ height: '100%', width: `${pctOf(eaten.kcal, goal.kcal)}%`, background: `linear-gradient(90deg, ${KCAL}, #e07bff)`, borderRadius: 6, transition: 'width 0.3s' }} />
      </div>

      {/* Три тонкие шкалы Б/У/Ж */}
      {BARS.map(([label, key, color]) => {
        const ov = overBy(eaten[key], goal[key])
        return (
          <div key={key} data-testid={`${testId}-${key}`} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4, gap: 4, flexWrap: 'wrap' }}>
              <span style={{ color: TXT2, fontWeight: 600 }}>{label}</span>
              <span style={{ fontWeight: 700, color }}>{Math.round(eaten[key])} г</span>
              <span style={{ flex: 1 }} />
              {goal[key] > 0 && (ov > 0
                ? <span style={{ fontSize: 11, color: COR }}>+{ov} г перебор</span>
                : <span style={{ fontSize: 11, color: TXT3 }}>осталось {remainingOf(eaten[key], goal[key])} г</span>)}
              {goal[key] > 0 && <span style={{ fontSize: 11, color: TXT3 }}>/ {Math.round(goal[key])} г</span>}
            </div>
            <div style={{ height: 7, background: 'rgba(255,255,255,.10)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pctOf(eaten[key], goal[key])}%`, background: ov > 0 ? COR : color, borderRadius: 4, transition: 'width 0.3s' }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
