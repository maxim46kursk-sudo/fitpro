// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import StandingsScreen from './StandingsScreen.jsx'

/**
 * ТАБЛИЦА ПОТОКА НА ЭКРАНЕ. Проверяется не вёрстка, а то, из-за чего человек
 * ей не поверит: своё место должно быть видно, до старта таблица не имеет
 * права показывать нули, а слагаемые итога обязаны стоять рядом с итогом.
 */

afterEach(cleanup)

const NORM = { norm_kcal: 2000, norm_p: 120, norm_f: 65, norm_c: 220 }

const rowsFor = (p, { score, eat }) =>
  Array.from({ length: 30 }, (_, i) => ({
    participant_no: p.no,
    display_name: p.name,
    is_me: !!p.me,
    days_done: p.daysDone ?? 30,
    day: i + 1,
    best_score: score,
    kcal: 2000 * eat,
    p: 120 * eat,
    f: 65 * eat,
    c: 220 * eat,
    meals: 4,
    ...NORM,
  }))

const yesterday = () => {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const tomorrow = () => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Пять участников — тот же расклад, что нарисован человеку в правилах: Аня
 * третья в движении и первая в питании (сумма 4), Игорь первый в движении и
 * пятый в питании (сумма 6). Троих для этого мало: у всех троих сумма
 * получается одинаковой, и пример перестаёт что-либо показывать.
 */
const ROWS = [
  ...rowsFor({ no: 3, name: 'Игорь' }, { score: 5000, eat: 0.3 }),
  ...rowsFor({ no: 7, name: 'Аня', me: true }, { score: 3000, eat: 1 }),
  ...rowsFor({ no: 11, name: 'Борис' }, { score: 4000, eat: 0.5 }),
  ...rowsFor({ no: 12, name: 'Вера' }, { score: 2500, eat: 0.55 }),
  ...rowsFor({ no: 15, name: 'Глеб' }, { score: 1000, eat: 0.6 }),
]

describe('таблица показывает слагаемые итога, а не только итог', () => {
  it('место, номер, имя, движение, питание и сумма мест', () => {
    render(<StandingsScreen rows={ROWS} startsOn={yesterday()} />)

    const me = screen.getByTestId('standings-me')
    expect(me.textContent).toContain('Ты')
    expect(me.textContent).toContain('№ 7')
    // 3000 × 30 дней = 90 000 очков движения и 100% питания
    expect(me.textContent).toContain('90')
    expect(me.textContent).toContain('100%')
    // сумма мест: третий в движении и первый в питании
    expect(me.textContent).toContain('4')
  })

  it('порядок строк — по сумме мест, а не по очкам', () => {
    render(<StandingsScreen rows={ROWS} startsOn={yesterday()} />)
    const list = screen.getByTestId('standings-list')
    const names = [...list.children].map((el) => el.querySelector('.mt-st__name').textContent)

    // Аня слабее Игоря в игре, но вытянула питание — и стоит выше
    expect(names[0]).toBe('Ты')
    expect(names).toContain('Игорь')
    expect(names.indexOf('Ты')).toBeLessThan(names.indexOf('Игорь'))
  })

  it('своя строка подсвечена', () => {
    render(<StandingsScreen rows={ROWS} startsOn={yesterday()} />)
    expect(screen.getByTestId('standings-me').className).toContain('is-me')
  })
})

describe('до старта таблица честно пустая', () => {
  it('поток ещё не начался — говорим об этом, а не показываем нули', () => {
    render(<StandingsScreen rows={ROWS} startsOn={tomorrow()} />)

    expect(screen.getByTestId('standings-not-started').textContent).toContain('в день старта')
    expect(screen.queryByTestId('standings-list')).toBeNull()
  })

  it('даты старта нет вовсе — тоже честно', () => {
    render(<StandingsScreen rows={ROWS} startsOn={null} />)
    expect(screen.getByTestId('standings-not-started').textContent).toContain('будет объявлена')
  })

  it('поток идёт, а участников нет — отдельный текст, а не пустой список', () => {
    render(<StandingsScreen rows={[]} startsOn={yesterday()} />)
    expect(screen.getByTestId('standings-empty')).toBeTruthy()
  })

  it('пока читаем — так и написано', () => {
    render(<StandingsScreen rows={null} loading startsOn={yesterday()} />)
    expect(screen.getByTestId('standings-loading')).toBeTruthy()
  })
})

describe('таблица переживает неполные данные', () => {
  it('участник без единого захода не ломает экран', () => {
    const rows = [
      ...rowsFor({ no: 1, name: 'Играет' }, { score: 2000, eat: 1 }),
      ...rowsFor({ no: 2, name: 'Молчит', daysDone: 0 }, { score: 0, eat: 0 }),
    ]
    render(<StandingsScreen rows={rows} startsOn={yesterday()} />)

    const list = screen.getByTestId('standings-list')
    expect(list.children.length).toBe(2)
    expect(screen.getByTestId('standings-row-2').textContent).toContain('0%')
  })
})
