// test-nutrition.mjs — точечный регрессионный тест методики расчёта нормы
// КБЖУ (calcMacroGoals из src/aiPrompt.js). Импортирует РЕАЛЬНУЮ функцию,
// ничего не мокается, сверяет вывод с эталонными числами, посчитанными
// вручную отдельно от кода. По духу — как test-progression.mjs, но про
// питание: дефицит 15% для Похудения/Рельефа, неизменность белка/жира,
// нижний порог калорий и флаг недобора массы. В сборку не входит.

import { calcMacroGoals } from './src/aiPrompt.js'

let pass = 0, fail = 0
function report(label, ok, detail) {
  if (ok) { pass++; console.log(`✓ PASS  ${label}`) }
  else { fail++; console.log(`✗ FAIL  ${label}${detail ? '  — ' + detail : ''}`) }
}
function assertEqual(label, actual, expected) {
  const ok = actual === expected
  report(label, ok, ok ? '' : `ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`)
}

// Базовый профиль: рост 180, вес 90, мужчина, малоподвижный. По методике
// базовый вес = рабочая масса (180−100 = 80, т.к. реальный вес 90 больше),
// коэффициент активности ×1.2. Белок НЕ множится на активность: p = 2×80 = 160.
// Жир и углеводы — с активностью: f = 1×80×1.2 = 96, c(поддерж.) = 3×80×1.2 = 288.
const base = { height: 180, weight: 90, gender: 'male', activity_level: 'sedentary' }
const cut  = calcMacroGoals({ ...base, goal: 'Похудение' })
const rel  = calcMacroGoals({ ...base, goal: 'Рельеф' })
const mnt  = calcMacroGoals({ ...base, goal: 'Поддержание' })
const gain = calcMacroGoals({ ...base, goal: 'Набор массы' })

console.log('── Дефицит: Похудение (норма поддержания 2656 − 15%) ──────────────')
// Поддержание = 160×4 + 288×4 + 96×9 = 2656 ккал; 85% = 2257.6; углеводами
// добираем до него при p=160/f=96 → c = round((2257.6 − 640 − 864)/4) = 188;
// итоговые калории = 640 + 752 + 864 = 2256.
assertEqual('Похудение: kcal = 2256', cut.kcal, 2256)
assertEqual('Похудение: p = 160', cut.p, 160)
assertEqual('Похудение: c = 188 (углеводы срезаны дефицитом)', cut.c, 188)
assertEqual('Похудение: f = 96', cut.f, 96)
assertEqual('Похудение: deficitApplied = true', cut.deficitApplied, true)
assertEqual('Похудение: floored = false (порог не задет)', cut.floored, false)

console.log('── Дефицит: Рельеф (тот же дефицит, что у Похудения) ──────────────')
assertEqual('Рельеф: kcal = 2256', rel.kcal, 2256)
assertEqual('Рельеф: p = 160', rel.p, 160)
assertEqual('Рельеф: c = 188', rel.c, 188)
assertEqual('Рельеф: f = 96', rel.f, 96)
assertEqual('Рельеф: deficitApplied = true', rel.deficitApplied, true)

console.log('── Без дефицита: Поддержание и Набор массы ────────────────────────')
assertEqual('Поддержание: kcal = 2656', mnt.kcal, 2656)
assertEqual('Поддержание: c = 288 (углеводы 3 г/кг × 96)', mnt.c, 288)
assertEqual('Поддержание: deficitApplied = false', mnt.deficitApplied, false)
assertEqual('Набор массы: deficitApplied = false', gain.deficitApplied, false)
report('Набор массы: kcal больше поддержания', gain.kcal > mnt.kcal,
  `kcal набора ${gain.kcal} должен быть > ${mnt.kcal}`)

console.log('── Белок и жир при дефиците не режутся ────────────────────────────')
// Ключевая гарантия методики: дефицит уходит только в углеводы, а якорные
// белок (2 г/кг) и жир (1 г/кг) в Похудении равны тем же в Поддержании.
assertEqual('Похудение p == Поддержание p (белок держится)', cut.p, mnt.p)
assertEqual('Похудение f == Поддержание f (жир держится)', cut.f, mnt.f)

console.log('── Нижний порог калорий (calFloor) ───────────────────────────────')
// Маленькая женщина (рост 140, вес 48): базовый вес 30. p=60 (2×30, без
// активности), f=36, c=108 → до защиты 60×4+108×4+36×9 = 996 ккал, ниже
// женского порога 1200. Углеводы поднимаются: недобор 204 делится на 4 без
// остатка (+51 г углеводов), kcal становится ровно 1200.
const low = calcMacroGoals({ height: 140, weight: 48, gender: 'female', goal: 'Поддержание', activity_level: 'sedentary' })
assertEqual('Порог: floored = true', low.floored, true)
assertEqual('Порог: kcal поднят до calFloor', low.kcal, low.calFloor)
assertEqual('Порог: calFloor = 1200 (женский)', low.calFloor, 1200)

console.log('── Инвариант: активность НЕ трогает белок ────────────────────────')
// Тот же базовый вес (h180/w90 → 80), одна цель (Поддержание), разная
// активность: белок должен совпадать (2 г/кг, без активности), а углеводы и
// жир — различаться (энергия масштабируется активностью).
const sed  = calcMacroGoals({ ...base, goal: 'Поддержание' })                              // ×1.2
const high = calcMacroGoals({ ...base, goal: 'Поддержание', activity_level: 'high' })       // ×1.55
assertEqual('Белок одинаков при разной активности (sed.p === high.p)', sed.p, high.p)
assertEqual('Белок = 160 (2×80, без активности)', high.p, 160)
report('Углеводы РАЗНЫЕ при разной активности (энергия ×активность)', sed.c !== high.c,
  `sed.c=${sed.c}, high.c=${high.c} должны различаться`)
report('Жир РАЗНЫЙ при разной активности (энергия ×активность)', sed.f !== high.f,
  `sed.f=${sed.f}, high.f=${high.f} должны различаться`)

console.log('── Недобор массы (underweight, ИМТ < 18.5) ───────────────────────')
// Рост 180 при весе 55 → ИМТ 17, ниже границы ВОЗ 18.5.
const uw = calcMacroGoals({ height: 180, weight: 55, gender: 'male', goal: 'Поддержание', activity_level: 'sedentary' })
assertEqual('Недобор: underweight = true', uw.underweight, true)
report('Недобор: ИМТ < 18.5', uw.bmi < 18.5, `ИМТ ${uw.bmi} должен быть < 18.5`)

console.log(`\nИтого: ${pass}/${pass + fail}`)
if (fail > 0) process.exit(1)
