// Живая проверка экрана «тот же продукт или другой вкус»: обе карточки видны
// с цифрами, обе кнопки доступны, вёрстка не едет на узких экранах.
import { chromium } from 'playwright'

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
  'base64',
)

const browser = await chromium.launch()
let bad = 0

for (const width of [390, 320]) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))

  await page.goto('http://localhost:5199/qa/confirm-card.html?basis=estimate&similar=1', { waitUntil: 'networkidle' })
  const code = page.locator('input[placeholder="4600682000129"]')
  await code.waitFor({ state: 'visible', timeout: 25000 })
  await code.fill('1647516027856')
  await page.getByRole('button', { name: 'Найти' }).click()
  await page.locator('input[type=file]').setInputFiles({ name: 'p.jpg', mimeType: 'image/jpeg', buffer: JPEG })
  await page.getByRole('button', { name: 'Всё верно, сохранить' }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: 'Всё верно, сохранить' }).click()

  const same = page.getByRole('button', { name: 'Это тот же продукт' })
  await same.waitFor({ timeout: 10000 })
  const other = page.getByRole('button', { name: 'Это другой вкус' })

  const text = await page.locator('body').innerText()
  const bothCards = text.includes('УЖЕ В БАЗЕ') && text.includes('ТО, ЧТО ТЫ СНЯЛ')
  const bothNumbers = text.includes('138') && text.includes('135')
  const otherBox = await other.boundingBox()
  const overflowX = await page.evaluate(() => Math.max(0, document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth))

  const problems = []
  if (!bothCards) problems.push('видны не обе карточки')
  if (!bothNumbers) problems.push('не видно обеих КБЖУ — сравнить нечем')
  if (!(await same.isEnabled()) || !(await other.isEnabled())) problems.push('кнопка выбора недоступна')
  if (overflowX > 0) problems.push(`горизонтальная прокрутка ${overflowX}px`)
  if (errors.length) problems.push(`ошибки: ${errors[0]}`)

  await page.screenshot({ path: `qa/shots/similar-${width}.png` })
  console.log(`${problems.length ? '✗' : '✓'} ${width}px — обе карточки: ${bothCards ? 'да' : 'НЕТ'}, обе цифры: ${bothNumbers ? 'да' : 'НЕТ'}, низ второй кнопки ${otherBox ? Math.round(otherBox.y + otherBox.height) : '?'}/844`)
  if (problems.length) { bad++; console.log(`    ПРОБЛЕМЫ: ${problems.join('; ')}`) }

  // Выбор «другой вкус» доводит до экрана порции со СВОИМИ числами.
  if (width === 390) {
    await other.click()
    await page.getByRole('button', { name: 'Добавить в дневник' }).waitFor({ timeout: 10000 })
    console.log('    выбор «другой вкус» → экран порции открылся')
  }
  await ctx.close()
}

await browser.close()
console.log(bad ? `\nПроблемных случаев: ${bad}` : '\nПроверка пройдена')
process.exit(bad ? 1 : 0)
