// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import RulesScreen from './RulesScreen.jsx'
import { RULES } from './rulesContent.js'

/**
 * ПРАВИЛА ДОЛЖНЫ БЫТЬ ПРОЧИТАНЫ ДО ДЕНЕГ.
 *
 * На кону призовой фонд, вылет за подставного человека и ноль за пропущенный
 * день — то есть всё то, что потом упирается в «я не знал». Поэтому здесь
 * проверяется не вёрстка, а ворота: галочки и кнопки вступления не существует,
 * пока человек не дошёл до двенадцатого экрана, и кнопка не работает, пока не
 * стоит галочка.
 *
 * И обратное, не менее важное: перечитывающему правила ворота не показываются
 * вовсе. Он уже согласился, и требовать это второй раз — издевательство.
 */

afterEach(cleanup)

const PAGES = [
  { title: 'Первый', body: ['раз'], image: '/rules/rules-01.webp', alt: 'первая картинка' },
  { title: 'Второй', body: ['два'] },
  { title: 'Третий', body: ['три'] },
]

const toLast = () => {
  for (let i = 1; i < PAGES.length; i += 1) act(() => screen.getByTestId('rules-next').click())
}

describe('ворота: без прочтения и галочки вступить нельзя', () => {
  it('на первом экране галочки и кнопки нет вовсе', () => {
    render(<RulesScreen screens={PAGES} gate price={2990} />)

    expect(screen.getByTestId('rules-page-1')).toBeTruthy()
    expect(screen.queryByTestId('rules-gate')).toBeNull()
    expect(screen.queryByTestId('rules-agree')).toBeNull()
    expect(screen.queryByTestId('rules-join')).toBeNull()
  })

  it('на середине их тоже нет', () => {
    render(<RulesScreen screens={PAGES} gate price={2990} />)
    act(() => screen.getByTestId('rules-next').click())

    expect(screen.getByTestId('rules-page-2')).toBeTruthy()
    expect(screen.queryByTestId('rules-join')).toBeNull()
  })

  it('на последнем — галочка и кнопка, но кнопка не работает без галочки', () => {
    const onJoin = vi.fn()
    render(<RulesScreen screens={PAGES} gate price={2990} onJoin={onJoin} />)
    toLast()

    const join = screen.getByTestId('rules-join')
    expect(join.disabled).toBe(true)
    expect(join.textContent).toContain('2990')
    act(() => join.click())
    expect(onJoin).not.toHaveBeenCalled()
  })

  it('галочка включает кнопку, и она зовёт вступление', async () => {
    const onJoin = vi.fn().mockResolvedValue({ ok: true })
    render(<RulesScreen screens={PAGES} gate price={2990} onJoin={onJoin} />)
    toLast()

    fireEvent.click(screen.getByTestId('rules-agree'))
    expect(screen.getByTestId('rules-join').disabled).toBe(false)

    await act(async () => screen.getByTestId('rules-join').click())
    expect(onJoin).toHaveBeenCalled()
  })

  it('снял галочку — кнопка снова не работает', () => {
    render(<RulesScreen screens={PAGES} gate price={2990} onJoin={() => {}} />)
    toLast()

    fireEvent.click(screen.getByTestId('rules-agree'))
    fireEvent.click(screen.getByTestId('rules-agree'))
    expect(screen.getByTestId('rules-join').disabled).toBe(true)
  })

  it('вернулся посмотреть предыдущий экран — прочитанное не отбирается', () => {
    // человек дошёл до конца и вернулся свериться с таблицей уровней; ворота
    // обязаны быть на месте, когда он снова долистает до конца
    render(<RulesScreen screens={PAGES} gate price={2990} onJoin={() => {}} />)
    toLast()
    act(() => screen.getByTestId('rules-prev').click())
    expect(screen.queryByTestId('rules-join')).toBeNull()

    act(() => screen.getByTestId('rules-next').click())
    expect(screen.getByTestId('rules-join')).toBeTruthy()
  })

  it('перепрыгнуть по точкам на последний экран — тоже прочитал', () => {
    // Точки — законная навигация, а не лазейка: человек, ткнувший в последнюю
    // точку, всё равно оказался на экране с правилами, и запрещать ему это
    // значило бы ломать листалку ради вида строгости.
    render(<RulesScreen screens={PAGES} gate price={2990} onJoin={() => {}} />)
    act(() => screen.getByTestId(`rules-dot-${PAGES.length}`).click())
    expect(screen.getByTestId('rules-join')).toBeTruthy()
  })
})

describe('повторное чтение: свободно и без ворот', () => {
  it('без gate ни галочки, ни кнопки нет даже на последнем экране', () => {
    render(<RulesScreen screens={PAGES} />)
    toLast()

    expect(screen.getByTestId('rules-page-3')).toBeTruthy()
    expect(screen.queryByTestId('rules-gate')).toBeNull()
    expect(screen.queryByTestId('rules-join')).toBeNull()
  })

  it('открывается с любого места и листается в обе стороны', () => {
    render(<RulesScreen screens={PAGES} />)
    // на первом экране «назад» некуда — кнопки нет вовсе, она не занимает
    // место под большим пальцем зря
    expect(screen.queryByTestId('rules-prev')).toBeNull()

    act(() => screen.getByTestId('rules-dot-2').click())
    expect(screen.getByTestId('rules-page-2')).toBeTruthy()
    act(() => screen.getByTestId('rules-prev').click())
    expect(screen.getByTestId('rules-page-1')).toBeTruthy()
  })

  it('на последнем экране без ворот — кнопка «Закрыть», а не «Далее»', () => {
    const onExit = vi.fn()
    render(<RulesScreen screens={PAGES} onExit={onExit} />)
    toLast()

    expect(screen.queryByTestId('rules-next')).toBeNull()
    act(() => screen.getByTestId('rules-done').click())
    expect(onExit).toHaveBeenCalled()
  })
})

describe('листание', () => {
  it('свайп влево ведёт вперёд, вправо — назад', () => {
    render(<RulesScreen screens={PAGES} />)
    const root = screen.getByTestId('rules-screen')

    fireEvent.touchStart(root, { changedTouches: [{ clientX: 300, clientY: 200 }] })
    fireEvent.touchEnd(root, { changedTouches: [{ clientX: 100, clientY: 210 }] })
    expect(screen.getByTestId('rules-page-2')).toBeTruthy()

    fireEvent.touchStart(root, { changedTouches: [{ clientX: 100, clientY: 200 }] })
    fireEvent.touchEnd(root, { changedTouches: [{ clientX: 300, clientY: 190 }] })
    expect(screen.getByTestId('rules-page-1')).toBeTruthy()
  })

  it('вертикальное движение страницу не листает — это прокрутка', () => {
    render(<RulesScreen screens={PAGES} />)
    const root = screen.getByTestId('rules-screen')

    fireEvent.touchStart(root, { changedTouches: [{ clientX: 200, clientY: 400 }] })
    fireEvent.touchEnd(root, { changedTouches: [{ clientX: 170, clientY: 100 }] })
    expect(screen.getByTestId('rules-page-1')).toBeTruthy()
  })

  it('уровни показаны карточками, а не таблицей — экран шириной в ладонь', () => {
    // четыре колонки на телефоне превращаются либо в мелкий шрифт, либо в
    // горизонтальную прокрутку, и человек разбирает вёрстку вместо уровней
    render(<RulesScreen screens={RULES} />)
    act(() => screen.getByTestId('rules-dot-5').click())

    const levels = screen.getByTestId('rules-levels')
    expect(levels.children.length).toBe(3)
    expect(document.querySelector('table')).toBeNull()
    expect(levels.textContent).toContain('НОВИЧОК')
    expect(levels.textContent).toContain('200 очков')
  })

  it('точек столько же, сколько экранов, и активная отмечена', () => {
    render(<RulesScreen screens={PAGES} />)
    expect(screen.getByTestId('rules-dots').children.length).toBe(PAGES.length)
    expect(screen.getByTestId('rules-dot-1').getAttribute('aria-current')).toBe('true')
  })
})

describe('текст правил', () => {
  it('двенадцать экранов, у каждого заголовок и текст', () => {
    // Правила — предмет спора о деньгах: экран без текста здесь не мелочь, а
    // пропавший пункт договора.
    expect(RULES.length).toBe(12)
    for (const page of RULES) {
      expect(page.title.length > 0).toBe(true)
      expect(page.body.length > 0).toBe(true)
    }
  })

  it('одиннадцать картинок, каждая с подписью; двенадцатый экран — текстом', () => {
    /**
     * Картинки снимает scripts/rules-shots.mjs, и пути обязаны совпадать с
     * тем, что он кладёт в public/rules. Двенадцатый экран — прямой разговор
     * про совесть, иллюстрация его только смягчила бы.
     */
    const withImage = RULES.filter((p) => p.image)
    expect(withImage.length).toBe(11)
    expect(RULES[11].image).toBeUndefined()
    for (const page of withImage) {
      expect(page.image).toMatch(/^\/rules\/rules-\d\d\.webp$/)
      expect(page.alt.length > 10).toBe(true)
    }
  })

  it('картинки ленивые — двенадцать штук разом на телефоне не грузятся', () => {
    render(<RulesScreen screens={PAGES} />)
    const img = screen.getByTestId('rules-image')
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(img.getAttribute('alt')).toBe('первая картинка')
  })

  it('НИ ОДНОГО СЫРОГО СИМВОЛА РАЗМЕТКИ ни на одном из двенадцати экранов', () => {
    /**
     * Человек читает правила, а не исходник: звёздочки, решётки и дефисы
     * списков на экране — это признак того, что разметку забыли разобрать, и
     * витрина, по которой решают платить 2990, сразу выглядит недоделанной.
     * Проверяются ВСЕ экраны, а не первый: сломаться может любой абзац.
     */
    for (let i = 0; i < RULES.length; i += 1) {
      cleanup()
      render(<RulesScreen screens={RULES} />)
      act(() => screen.getByTestId(`rules-dot-${i + 1}`).click())
      const text = screen.getByTestId('rules-screen').textContent
      expect(text.includes('**'), `экран ${i + 1}: звёздочки в тексте`).toBe(false)
      expect(text.includes('#'), `экран ${i + 1}: решётка в тексте`).toBe(false)
      expect(/(?:^|\s)[-*]\s/.test(text), `экран ${i + 1}: дефис списка в тексте`).toBe(false)
    }
  })

  it('жирный действительно жирный, а не звёздочки', () => {
    render(<RulesScreen screens={RULES} />)
    const strong = screen.getByTestId('rules-screen').querySelectorAll('b')
    expect(strong.length > 0).toBe(true)
    expect([...strong].some((b) => b.textContent.includes('30 дней'))).toBe(true)
  })

  it('главные правила потока видны как есть', () => {
    // Пропущенный день и сумма мест — те самые строки, которые цитируют в споре
    render(<RulesScreen screens={RULES} />)
    act(() => screen.getByTestId('rules-dot-9').click())
    expect(screen.getByTestId('rules-quote').textContent).toContain('Пропустил день')

    act(() => screen.getByTestId('rules-dot-10').click())
    expect(screen.getByTestId('rules-quote').textContent).toContain('сумма двух твоих мест')
  })
})
