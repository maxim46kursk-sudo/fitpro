import { describe, expect, it } from 'vitest'
import { describeAspect, fitContain, projectX, projectY } from './viewport.js'

describe('fitContain', () => {
  it('вписывает 640×480 в портретный 390×844 без потерь по краям', () => {
    const fit = fitContain(640, 480, 390, 844)

    // ограничение по ширине: 390/640 < 844/480
    expect(fit.scale).toBeCloseTo(390 / 640, 10)
    expect(fit.dw).toBeCloseTo(390, 10)
    expect(fit.dh).toBeCloseTo(292.5, 10)

    // весь кадр внутри контейнера — ничего не обрезано
    expect(fit.ox).toBeCloseTo(0, 10)
    expect(fit.oy).toBeCloseTo((844 - 292.5) / 2, 10)
    expect(fit.dw).toBeLessThanOrEqual(390 + 1e-9)
    expect(fit.dh).toBeLessThanOrEqual(844 + 1e-9)
  })

  it('крайние точки кадра попадают ровно на границы отрисованной области', () => {
    const fit = fitContain(640, 480, 390, 844)

    expect(projectX(0, fit)).toBeCloseTo(fit.ox, 10)
    expect(projectX(1, fit)).toBeCloseTo(fit.ox + fit.dw, 10)
    expect(projectY(0, fit)).toBeCloseTo(fit.oy, 10)
    expect(projectY(1, fit)).toBeCloseTo(fit.oy + fit.dh, 10)

    // и остаются внутри экрана
    expect(projectX(0, fit)).toBeGreaterThanOrEqual(0)
    expect(projectX(1, fit)).toBeLessThanOrEqual(390)
    expect(projectY(0, fit)).toBeGreaterThanOrEqual(0)
    expect(projectY(1, fit)).toBeLessThanOrEqual(844)
  })

  it('центр кадра ложится в центр отрисованной области', () => {
    const fit = fitContain(640, 480, 390, 844)
    expect(projectX(0.5, fit)).toBeCloseTo(195, 10)
    expect(projectY(0.5, fit)).toBeCloseTo(422, 10)
  })

  it('не искажает пропорции: 1 нормализованная единица по X и Y даёт один масштаб', () => {
    const fit = fitContain(1280, 720, 390, 844)
    expect(fit.dw / 1280).toBeCloseTo(fit.dh / 720, 10)
  })

  it('в отличие от cover ничего не выходит за пределы контейнера', () => {
    const contain = fitContain(1280, 720, 390, 844)
    const coverScale = Math.max(390 / 1280, 844 / 720)

    expect(contain.dh).toBeLessThanOrEqual(844)
    // cover в этом случае вылез бы по ширине далеко за экран — это и был баг
    expect(1280 * coverScale).toBeGreaterThan(390)
  })

  it('вертикальный кадр в вертикальном контейнере тоже вписывается целиком', () => {
    const fit = fitContain(720, 1280, 390, 844)
    expect(fit.dh).toBeLessThanOrEqual(844 + 1e-9)
    expect(fit.dw).toBeLessThanOrEqual(390 + 1e-9)
    expect(Math.min(fit.ox, fit.oy)).toBeGreaterThanOrEqual(0)
  })

  it('возвращает null на некорректных размерах', () => {
    expect(fitContain(0, 480, 390, 844)).toBe(null)
    expect(fitContain(640, 480, 0, 844)).toBe(null)
  })
})

describe('describeAspect', () => {
  it('узнаёт стандартные соотношения', () => {
    expect(describeAspect(640, 480)).toBe('4:3')
    expect(describeAspect(1280, 720)).toBe('16:9')
    expect(describeAspect(720, 1280)).toBe('9:16')
    expect(describeAspect(480, 480)).toBe('1:1')
  })

  it('нестандартное отдаёт числом', () => {
    expect(describeAspect(1000, 700)).toBe('1.43')
    expect(describeAspect(0, 0)).toBe('—')
  })
})
