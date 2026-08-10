// Живая проверка настроек камеры в сканере штрих-кода.
//
// ГЛАВНОЕ, РАДИ ЧЕГО ЭТОТ ФАЙЛ, — случай ?mode=fail: камера без фонарика и без
// управления фокусом, отвечающая отказом на любой applyConstraints. Это
// десктоп и половина WebView, и это единственное место, где правка настроек
// трека может сломать то, что сейчас живое. Сканер обязан поднять камеру,
// крутить распознавание и не показывать неживых кнопок.
//
// Камера настоящая: chromium запускается с фальшивым устройством
// (--use-fake-device-for-media-stream), поэтому getUserMedia действительно
// отдаёт поток, а не заглушку. Подменены только наблюдатели — см. qa/camera.jsx.
//
// Запуск: node qa/check-camera.mjs   (dev-сервер поднимает сам)
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'

const PORT = 5233
const URL_BASE = `http://localhost:${PORT}/qa/camera.html`

let bad = 0
const results = []
const check = (mode, name, ok, detail = '') => {
  results.push({ mode, name, ok, detail })
  if (!ok) bad++
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// ── dev-сервер
//
// Запускаем vite НЕ через npx и не через shell:true. На Windows shell:true
// делает нашим потомком cmd.exe, и kill() убивает именно его — сам vite
// остаётся держать порт, а следующий прогон падает с «Port already in use».
// Прямой запуск скрипта тем же node делает vite нашим прямым потомком.
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'],
  { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })

const ready = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite не поднялся за 60 с')), 60000)
  vite.stdout.on('data', d => { if (String(d).includes('ready in') || String(d).includes(`:${PORT}`)) { clearTimeout(t); resolve() } })
  vite.stderr.on('data', d => process.stderr.write(String(d)))
  vite.on('exit', c => { clearTimeout(t); reject(new Error(`vite упал, код ${c}`)) })
})

const stopVite = () => { try { vite.kill() } catch { /* уже мёртв */ } }

try {
  await ready
  // Ready печатается до того, как сервер реально принимает соединения.
  await new Promise(r => setTimeout(r, 800))

  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })

  // Открывает стенд и ждёт, пока сканер поднимет камеру.
  const open = async (mode) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      permissions: ['camera'],
    })
    const page = await ctx.newPage()
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(String(e.message)))
    await page.goto(`${URL_BASE}?mode=${mode}`, { waitUntil: 'networkidle' })
    // Ждём именно играющее видео: readyState ≥ 2 и ненулевой кадр.
    await page.waitForFunction(() => {
      const v = document.querySelector('video')
      return v && v.readyState >= 2 && v.videoWidth > 0
    }, { timeout: 20000 }).catch(() => {})
    return { ctx, page, pageErrors }
  }

  const snapshot = page => page.evaluate(() => {
    const v = document.querySelector('video')
    const track = v?.srcObject?.getVideoTracks?.()[0] || null
    return {
      cam: window.__cam,
      videoW: v?.videoWidth || 0,
      videoH: v?.videoHeight || 0,
      readyState: v?.readyState ?? -1,
      paused: v ? v.paused : true,
      settings: track ? track.getSettings() : null,
      live: track ? track.readyState : 'нет трека',
      text: document.body.innerText,
    }
  })

  // ════════════════════════════════════════════════════════════════════════
  // ОБЯЗАТЕЛЬНАЯ ПРОВЕРКА: десктоп без torch и без focusMode
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n── mode=fail: applyConstraints отказывает, getCapabilities бросает ──')
  {
    const { ctx, page, pageErrors } = await open('fail')
    // Даём циклу распознавания хотя бы пару тиков (POLL_MS = 300).
    await page.waitForTimeout(1200)
    const s = await snapshot(page)

    check('fail', 'камера поднялась, а не ушла в ручной ввод',
      s.text.includes('Наведи камеру на штрих-код') && !s.text.includes('Введи цифры под штрих-кодом вручную'))
    check('fail', 'видео играет', s.readyState >= 2 && !s.paused && s.videoW > 0, `${s.videoW}×${s.videoH}, readyState=${s.readyState}`)
    check('fail', 'трек живой', s.live === 'live', s.live)
    check('fail', 'цикл распознавания крутится', s.cam.ticks > 0, `тиков: ${s.cam.ticks}`)
    check('fail', 'отказ applyConstraints не выкинул ошибку в страницу',
      pageErrors.length === 0 && s.cam.errors.length === 0, [...pageErrors, ...s.cam.errors].join('; ') || 'ошибок нет')
    check('fail', 'фокус всё-таки попробовали настроить',
      s.cam.apply.some(a => a.focusMode === 'continuous'), JSON.stringify(s.cam.apply))
    check('fail', 'кнопки фонарика нет вовсе', !s.text.includes('Фонарик'))
    check('fail', 'ручной ввод по-прежнему доступен', s.text.includes('Ввести код вручную'))
    await ctx.close()
  }

  // ── Дополнительно: тот же десктоп без всяких подмен (как есть)
  console.log('\n── mode=plain: настоящий десктопный Chromium, ничего не подменено ──')
  {
    const { ctx, page, pageErrors } = await open('plain')
    await page.waitForTimeout(1200)
    const s = await snapshot(page)
    const baseline = await page.evaluate(() => window.__baselineSize())

    const asked = s.cam.gum[0]?.video || {}
    check('plain', 'запрошено 1920×1080 как ideal и задняя камера',
      asked.width?.ideal === 1920 && asked.height?.ideal === 1080 && asked.facingMode === 'environment',
      JSON.stringify(asked))
    check('plain', 'камера поднялась', s.readyState >= 2 && !s.paused && s.videoW > 0, `${s.videoW}×${s.videoH}`)
    check('plain', 'цикл распознавания крутится', s.cam.ticks > 0, `тиков: ${s.cam.ticks}`)
    check('plain', 'кадр не хуже, чем без просьбы о разрешении',
      baseline ? s.videoW >= baseline.width : true,
      baseline ? `было бы ${baseline.width}×${baseline.height}, стало ${s.videoW}×${s.videoH}` : 'сравнить не с чем')
    check('plain', 'кнопки фонарика нет (десктоп его не заявляет)', !s.text.includes('Фонарик'))
    check('plain', 'страница без ошибок', pageErrors.length === 0 && s.cam.errors.length === 0,
      [...pageErrors, ...s.cam.errors].join('; ') || 'ошибок нет')
    await ctx.close()
  }

  // ── Фонарик там, где камера о нём заявила
  console.log('\n── mode=torch: камера с фонариком ──')
  {
    const { ctx, page, pageErrors } = await open('torch')
    const btn = page.getByRole('button', { name: /фонарик/i })
    await btn.waitFor({ timeout: 10000 }).catch(() => {})

    check('torch', 'кнопка фонарика появилась', await btn.count() > 0)
    if (await btn.count() > 0) {
      await btn.click()
      await page.waitForTimeout(200)
      const on = await snapshot(page)
      check('torch', 'нажатие включает свет',
        on.cam.apply.some(a => a.torch === true) && on.text.includes('Фонарик включён'),
        JSON.stringify(on.cam.apply))

      await page.getByRole('button', { name: 'Выключить фонарик' }).click()
      await page.waitForTimeout(200)
      const off = await snapshot(page)
      check('torch', 'повторное нажатие гасит', off.cam.apply.filter(a => a.torch === false).length >= 1)

      // Снова включаем и закрываем сканер — свет обязан погаснуть ДО stop().
      await page.getByRole('button', { name: 'Включить фонарик' }).click()
      await page.waitForTimeout(200)
      await page.getByRole('button', { name: 'Закрыть' }).click()
      await page.waitForTimeout(300)
      const ev = (await snapshot(page)).cam.events
      const lastOff = ev.lastIndexOf('apply {"torch":false}')
      const lastStop = ev.lastIndexOf('stop')
      check('torch', 'при остановке свет гасится ДО track.stop()',
        lastOff !== -1 && lastStop !== -1 && lastOff < lastStop,
        ev.slice(-4).join(' → '))
    }
    check('torch', 'страница без ошибок', pageErrors.length === 0)
    await ctx.close()
  }

  await browser.close()
} finally {
  stopVite()
}

console.log(`\nпроверок: ${results.length}, провалено: ${bad}`)
process.exit(bad ? 1 : 0)
