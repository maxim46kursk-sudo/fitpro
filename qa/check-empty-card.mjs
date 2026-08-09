// Живая проверка: карточка без КБЖУ не даёт нажать «Добавить в дневник».
import { chromium } from 'playwright'

const browser = await chromium.launch()
let bad = 0

for (const width of [390, 320]) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  await page.goto(`http://localhost:5199/qa/confirm-card.html?found=empty`, { waitUntil: 'networkidle' })

  const input = page.locator('input[placeholder="4600682000129"]')
  await input.waitFor({ state: 'visible', timeout: 25000 })
  await input.fill('4607091380101')
  await page.getByRole('button', { name: 'Найти' }).click()

  const addBtn = page.getByRole('button', { name: 'Добавить в дневник' })
  await addBtn.waitFor({ timeout: 10000 })

  const disabled = await addBtn.isDisabled()
  const explained = await page.getByText('его КБЖУ — нет', { exact: false }).count()
  const dashes = (await page.locator('body').innerText()).includes('—')
  const box = await addBtn.boundingBox()
  const overflowX = await page.evaluate(() => Math.max(0, document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth))

  const problems = []
  if (!disabled) problems.push('кнопка «Добавить в дневник» АКТИВНА при неизвестных КБЖУ')
  if (!explained) problems.push('нет объяснения, почему кнопка погасла')
  if (overflowX > 0) problems.push(`горизонтальная прокрутка ${overflowX}px`)
  if (box && box.y + box.height > 845) problems.push('кнопка ниже экрана')

  await page.screenshot({ path: `qa/shots/empty-${width}.png` })
  console.log(`${problems.length ? '✗' : '✓'} ${width}px — кнопка ${disabled ? 'заблокирована' : 'АКТИВНА'}, объяснение ${explained ? 'есть' : 'НЕТ'}, прочерки в цифрах: ${dashes ? 'да' : 'нет'}`)
  if (problems.length) { bad++; console.log(`    ПРОБЛЕМЫ: ${problems.join('; ')}`) }
  await ctx.close()
}

await browser.close()
console.log(bad ? `\nПроблемных случаев: ${bad}` : '\nПроверка пройдена')
process.exit(bad ? 1 : 0)
