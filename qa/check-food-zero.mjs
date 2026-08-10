// Живая проверка трёх правок в еде по штрих-коду — на НАСТОЯЩЕМ компоненте
// BarcodeScanner, через обычный путь пользователя (ручной ввод кода → поиск →
// либо экран порции, либо фото → сверка → сохранение).
//
// Почему не юнит-тестами: все три правки живут в клиенте и проверяются только
// поведением экрана. hasUsableMacros и checkMacros прогоняются в
// test-barcode.mjs, а вот «кнопка на воде активна», «в поле жиров подставился
// 0» и «правленые числа уехали как label» — это здесь.
//
// Запуск: node qa/check-food-zero.mjs   (dev-сервер поднимает сам)
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'

const PORT = 5234
const BASE = `http://localhost:${PORT}/qa/confirm-card.html`

let bad = 0
const check = (name, ok, detail = '') => {
  if (!ok) bad++
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// Блок проверок, который не роняет остальные. Без этого первый же сломанный
// сценарий (клик по погасшей кнопке — таймаут playwright) обрывал весь прогон,
// и про остальные правки отчёт молчал — а молчание читается как «всё хорошо».
const section = async (title, fn) => {
  console.log(`\n── ${title} ──`)
  try {
    await fn()
  } catch (e) {
    bad++
    console.log(`  ✗ блок оборвался: ${String(e?.message || e).split('\n')[0]}`)
  }
}

// vite прямым запуском, без npx и shell: иначе на Windows kill() убивает
// обёртку cmd.exe, а сам сервер остаётся держать порт.
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'],
  { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })

const ready = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite не поднялся за 60 с')), 60000)
  vite.stdout.on('data', d => { if (String(d).includes('ready in') || String(d).includes(`:${PORT}`)) { clearTimeout(t); resolve() } })
  vite.stderr.on('data', d => process.stderr.write(String(d)))
  vite.on('exit', c => { clearTimeout(t); reject(new Error(`vite упал, код ${c}`)) })
})

try {
  await ready
  await new Promise(r => setTimeout(r, 800))
  const browser = await chromium.launch()

  // Доводит сканер до поиска по коду: ручной ввод → «Найти».
  const open = async (query, code = '4607091380101') => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(String(e.message)))
    await page.goto(`${BASE}?${query}`, { waitUntil: 'networkidle' })
    const input = page.locator('input[placeholder="4600682000129"]')
    await input.waitFor({ state: 'visible', timeout: 25000 })
    await input.fill(code)
    await page.getByRole('button', { name: 'Найти' }).click()
    return { ctx, page, errors }
  }

  // Доводит до экрана сверки: код не найден → «Сфотографировать упаковку».
  const toConfirm = async (query) => {
    const r = await open(query)
    await r.page.getByRole('button', { name: 'Сфотографировать упаковку' }).first().click()
    // Файловый вход скрыт; подсовываем файл напрямую — распознавание всё равно
    // подменено, содержимое картинки роли не играет.
    await r.page.locator('input[type=file]').setInputFiles({
      name: 'label.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'),
    })
    await r.page.getByText('Проверь, совпадает ли с этикеткой').waitFor({ timeout: 15000 })
    return r
  }

  const savedBody = page => page.evaluate(() => window.__saved)

  await section('1. Вода 0/0/0/0 — находится и заносится в дневник', async () => {
    const { ctx, page, errors } = await open('found=water', '4607050690492')
    const addBtn = page.getByRole('button', { name: 'Добавить в дневник' })
    await addBtn.waitFor({ timeout: 15000 })
    const text = await page.locator('body').innerText()

    check('вода найдена по коду, показан экран порции', text.includes('Вода питьевая'))
    check('нули показаны нулями, а не прочерками', /0 ккал/.test(text) && !text.includes('— ккал'))
    check('кнопка «Добавить в дневник» АКТИВНА', !(await addBtn.isDisabled()))
    check('нет плашки «продукт нашёлся, а его КБЖУ — нет»', !text.includes('его КБЖУ — нет'))

    await addBtn.click()
    await page.waitForTimeout(200)
    const added = await page.evaluate(() => window.__added)
    check('запись ушла в дневник', !!added, JSON.stringify(added?.entry))
    check('в дневник ушли нули', added?.entry?.kcal === 0 && added?.entry?.p === 0 && added?.entry?.c === 0 && added?.entry?.f === 0)
    check('приём пищи передан родителю', added?.meal === 'snack')
    check('страница без ошибок', errors.length === 0, errors.join('; '))
    await ctx.close()
  })

  await section('2. Пустая карточка из OFF по-прежнему НЕ пускает в дневник', async () => {
    const { ctx, page } = await open('found=empty')
    const addBtn = page.getByRole('button', { name: 'Добавить в дневник' })
    await addBtn.waitFor({ timeout: 15000 })
    check('кнопка заблокирована (регрессия не пролезла)', await addBtn.isDisabled())
    check('объяснение на месте', (await page.locator('body').innerText()).includes('его КБЖУ — нет'))
    await ctx.close()
  })

  await section('3. Продукт без строки «жиры» в таблице', async () => {
    const { ctx, page, errors } = await toConfirm('basis=nofat')
    const vals = await page.locator('input[inputmode=decimal]').evaluateAll(els => els.map(e => e.value))
    check('жиры подставлены нулём, поле не пустое', vals.includes('0'), `поля: ${JSON.stringify(vals)}`)
    check('распознанные числа не тронуты', vals.includes('326') && vals.includes('0.8') && vals.includes('79'))

    const saveBtn = page.getByRole('button', { name: 'Всё верно, сохранить' })
    check('кнопка сохранения АКТИВНА', !(await saveBtn.isDisabled()))
    await saveBtn.click()
    await page.waitForTimeout(400)
    const saved = await savedBody(page)
    check('карточка сохранена с Ж=0', saved !== null && Number(saved.f100) === 0, JSON.stringify(saved))
    check('подставленный нами ноль правкой не считается → basis=estimate', saved?.basis === 'estimate', `basis=${saved?.basis}`)
    check('страница без ошибок', errors.length === 0, errors.join('; '))
    await ctx.close()
  })

  await section('4. Все четыре null (labelEmpty) — поведение не изменилось', async () => {
    const { ctx, page } = await toConfirm('basis=empty')
    const vals = await page.locator('input[inputmode=decimal]').evaluateAll(els => els.map(e => e.value))
    check('поля остались ПУСТЫМИ, нули не подставлены', vals.every(v => v === ''), JSON.stringify(vals))
    check('кнопка сохранения заблокирована', await page.getByRole('button', { name: 'Всё верно, сохранить' }).isDisabled())
    check('просьба вписать КБЖУ на месте', (await page.locator('body').innerText()).includes('Заполни все четыре числа'))
    await ctx.close()
  })

  await section('5. Вода на экране СВЕРКИ (сохранение своей карточки)', async () => {
    const { ctx, page } = await toConfirm('basis=water')
    const saveBtn = page.getByRole('button', { name: 'Всё верно, сохранить' })
    check('кнопка сохранения активна на 0/0/0/0', !(await saveBtn.isDisabled()))
    check('нет требования «заполни все четыре числа»',
      !(await page.locator('body').innerText()).includes('Заполни все четыре числа'))
    await saveBtn.click()
    await page.waitForTimeout(400)
    const saved = await savedBody(page)
    check('вода ушла на сервер нулями',
      saved !== null && [saved.kcal100, saved.p100, saved.c100, saved.f100].every(v => Number(v) === 0), JSON.stringify(saved))
    await ctx.close()
  })

  console.log('\n══ 6. Правил ли человек числа → basis ══')

  await section('6a. Числа не тронуты', async () => {
    const { ctx, page } = await toConfirm('basis=estimate')
    await page.getByRole('button', { name: 'Всё верно, сохранить' }).click()
    await page.waitForTimeout(400)
    const saved = await savedBody(page)
    check('числа не тронуты → basis=estimate', saved?.basis === 'estimate', `basis=${saved?.basis}`)
    const text = await page.locator('body').innerText()
    check('на экране порции НЕТ пометки «примерные значения»', !text.includes('примерные значения'))
    await ctx.close()
  })

  await section('6b. Поправлена калорийность', async () => {
    const { ctx, page } = await toConfirm('basis=estimate')
    await page.locator('input[inputmode=decimal]').first().fill('330')
    await page.getByRole('button', { name: 'Всё верно, сохранить' }).click()
    await page.waitForTimeout(400)
    const saved = await savedBody(page)
    check('поправил калорийность → basis=label', saved?.basis === 'label', `basis=${saved?.basis}`)
    check('уехало исправленное число', Number(saved?.kcal100) === 330)
    // Стенд отвечает так же, как сервер: basis=label → source=ai_photo. На
    // экране порции source больше не показывается (правка 4), поэтому смотрим
    // на числа: вернулось исправленное, а не то, что дала модель.
    const text = await page.locator('body').innerText()
    check('на экране порции исправленные 330, а не 326', text.includes('330') && !text.includes('326'))
    await ctx.close()
  })

  await section('6c. То же число, записанное иначе', async () => {
    const { ctx, page } = await toConfirm('basis=estimate')
    await page.locator('input[inputmode=decimal]').first().fill('326.0')
    await page.getByRole('button', { name: 'Всё верно, сохранить' }).click()
    await page.waitForTimeout(400)
    const saved = await savedBody(page)
    check('«326.0» вместо «326» — не правка, basis=estimate', saved?.basis === 'estimate', `basis=${saved?.basis}`)
    await ctx.close()
  })

  await section('6d. Поправлено только название', async () => {
    const { ctx, page } = await toConfirm('basis=estimate')
    await page.locator('input[placeholder="Творог 5%"]').fill('Зефир ванильный в шоколаде')
    await page.getByRole('button', { name: 'Всё верно, сохранить' }).click()
    await page.waitForTimeout(400)
    const saved = await savedBody(page)
    check('поправил только название → basis=estimate', saved?.basis === 'estimate', `basis=${saved?.basis}`)
    check('название всё же уехало', saved?.name === 'Зефир ванильный в шоколаде')
    await ctx.close()
  })

  await section('6e. Модель прочитала таблицу — label остаётся label', async () => {
    const { ctx, page } = await toConfirm('basis=label')
    await page.getByRole('button', { name: 'Всё верно, сохранить' }).click()
    await page.waitForTimeout(400)
    const saved = await savedBody(page)
    check('нетронутое чтение таблицы → basis=label', saved?.basis === 'label', `basis=${saved?.basis}`)
    await ctx.close()
  })

  console.log('\n══ 7. Экран порции: пометок о происхождении цифр нет ══')
  for (const [mode, was] of [['estimate', '≈ примерные значения'], ['web', 'По данным карточки магазина']]) {
    await section(`7. source=${mode}`, async () => {
      const { ctx, page } = await open(`found=${mode}`)
      await page.getByRole('button', { name: 'Добавить в дневник' }).waitFor({ timeout: 15000 })
      const text = await page.locator('body').innerText()
      check(`source=${mode}: пометки «${was}» нет`, !text.includes(was))
      check(`source=${mode}: сам продукт и цифры на месте`, text.includes('Зефир ванильный') && text.includes('326'))
      await ctx.close()
    })
  }

  await browser.close()
} finally {
  try { vite.kill() } catch { /* уже мёртв */ }
}

console.log(bad ? `\nпровалено: ${bad}` : '\nвсё пройдено')
process.exit(bad ? 1 : 0)
