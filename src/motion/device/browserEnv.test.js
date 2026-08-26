import { describe, expect, it } from 'vitest'
import { browserOf, cameraBlockedByBrowser } from './browserEnv.js'

/**
 * СТРОКИ — ИЗ ПРОДА, А НЕ ИЗ ГОЛОВЫ.
 *
 * Все шесть взяты дословно из public.motion_log за 26 июля — 26 августа 2026:
 * это ровно те user agent, которыми представились 58 сессий, вставших после
 * `model.ready`. Проверять эвристику на выдуманной строке бессмысленно —
 * выдумать можно ту, которую она и так ловит.
 */
const ПРОД = {
  safariIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1',
  safariIOS2:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1',
  chromeIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/151.0.7922.112 Mobile/15E148 Safari/604.1',
  desktopChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  headless:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.7922.34 Safari/537.36',
  instagram:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/23G83 Instagram 443.0.0.33.78 (iPhone18,2; iOS 26_6_1; ru_RU; ru; scale=3.00; 1320x2868; IABMV/1; 1043399932) Safari/604.1',
}

describe('браузер по строке из прода', () => {
  it('Instagram на iPhone опознаётся как встроенный, и камера в нём закрыта', () => {
    const b = browserOf(ПРОД.instagram)
    expect(b.inApp).toBe(true)
    expect(b.app).toBe('Instagram')
    expect(b.ios).toBe(true)
    expect(cameraBlockedByBrowser(ПРОД.instagram)).toBe(true)
  })

  /**
   * САМАЯ ВАЖНАЯ ПРОВЕРКА ФАЙЛА. Строка Instagram заканчивается на
   * `Safari/604.1`, а строка обычного Safari — тоже; отличается она вставленным
   * посередине словом Instagram. Неаккуратный порядок правил (сначала Safari,
   * потом встроенные) дал бы «обычный Safari» для Instagram, а слишком жадное
   * правило встроенных — «встроенный» для всех 42 обычных сессий, то есть
   * предупреждение о неработающей камере тем, у кого она работает.
   */
  it.each([
    ['Safari', ПРОД.safariIOS],
    ['Safari', ПРОД.safariIOS2],
    ['Chrome (iOS)', ПРОД.chromeIOS],
    ['Chrome', ПРОД.desktopChrome],
    ['Chrome', ПРОД.headless],
  ])('%s из прода — обычный браузер, не webview', (имя, ua) => {
    const b = browserOf(ua)
    expect(b.name).toBe(имя)
    expect(b.inApp).toBe(false)
    expect(cameraBlockedByBrowser(ua)).toBe(false)
  })

  it('пустая строка не считается встроенным браузером', () => {
    expect(browserOf('').inApp).toBe(false)
    expect(cameraBlockedByBrowser('')).toBe(false)
  })

  /**
   * Android-webview ловится, но камеру там НЕ запрещаем: доступ обычно есть, а
   * если приложение его не дало — придёт честный отказ, а не молчание. Пугать
   * заранее человека, у которого всё работает, дороже, чем промолчать.
   */
  it('Android-webview опознан, но камеру не блокирует', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 13; SM-A536B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36'
    expect(browserOf(ua).inApp).toBe(true)
    expect(cameraBlockedByBrowser(ua)).toBe(false)
  })

  it('Facebook и VK на iPhone тоже закрывают камеру', () => {
    const fb =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21A329 [FBAN/FBIOS;FBAV/440.0.0.32.109]'
    expect(cameraBlockedByBrowser(fb)).toBe(true)
    expect(browserOf(fb).app).toBe('Facebook')
  })
})
