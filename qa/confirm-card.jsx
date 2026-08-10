// Стенд для проверки вёрстки карточки «Проверь данные» на узких экранах.
//
// Монтирует НАСТОЯЩИЙ BarcodeScanner и доводит его до состояния confirm через
// обычный путь пользователя (ручной ввод кода → продукт не найден → фото), а
// сеть подменяет через window.fetch. Смысл именно в настоящем компоненте:
// пересобранная в стенде разметка проверяла бы стенд, а не приложение.
//
// Открывается только вручную (vite dev + /qa/confirm-card.html) и в бой не
// собирается: index.html — единственная точка входа сборки.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import BarcodeScanner from '../src/BarcodeScanner.jsx'
import { supabase } from '../src/supabase.js'

// Сканер перед отправкой фото спрашивает сессию — без неё он до /api/chat не
// доходит. Подменяем ровно этот вызов на том же экземпляре клиента, что
// импортирует компонент.
supabase.auth.getSession = async () => ({ data: { session: { access_token: 'stub' } } })

// ?basis=… — какой из исходов распознавания показать.
//   estimate — модель прикинула по лицевой стороне;
//   label    — прочитала таблицу;
//   empty    — узнала продукт, но цифр не дала вовсе (все четыре null);
//   nofat    — прочитала таблицу, но строки «жиры» в ней нет (f100: null).
//              Законный случай: производители её сплошь и рядом не печатают;
//   water    — вода: все четыре числа честные нули.
const basis = new URLSearchParams(location.search).get('basis') || 'estimate'

const PRODUCT = {
  estimate: { name: 'Зефир ванильный', brand: 'Шармэль', kcal100: 326, p100: 0.8, c100: 79, f100: 0.1, per: '100g', basis: 'estimate', sourceName: null, sourceUrl: null },
  label: { name: 'Зефир ванильный', brand: 'Шармэль', kcal100: 330, p100: 1, c100: 81, f100: 0.1, per: '100g', basis: 'label', sourceName: null, sourceUrl: null },
  empty: { name: 'Зефир ванильный', brand: 'Шармэль', kcal100: null, p100: null, c100: null, f100: null, per: 'unknown', basis: 'estimate', sourceName: null, sourceUrl: null },
  nofat: { name: 'Зефир ванильный', brand: 'Шармэль', kcal100: 326, p100: 0.8, c100: 79, f100: null, per: '100g', basis: 'estimate', sourceName: null, sourceUrl: null },
  water: { name: 'Вода питьевая', brand: 'Святой Источник', kcal100: 0, p100: 0, c100: 0, f100: 0, per: '100g', basis: 'estimate', sourceName: null, sourceUrl: null },
}[basis]

const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

// Камеры в стенде нет и не нужно: путь до карточки идёт через ручной ввод
// кода. Отказываем сразу и предсказуемо — иначе getUserMedia в headless-браузере
// то отваливается, то висит, и экран ручного ввода появляется через раз.
// (navigator.mediaDevices — свойство только для чтения, поэтому подменяем
// метод на нём, а не сам объект: присваивание объекту бросает в strict-режиме
// модуля и молча ломает весь стенд.)
Object.defineProperty(navigator, 'mediaDevices', {
  configurable: true,
  value: {
    getUserMedia: async () => {
      const e = new Error('камеры в стенде нет')
      e.name = 'NotFoundError'
      throw e
    },
  },
})

// ?found=… — что отвечает поиск по штрих-коду.
//   empty — код НАХОДИТСЯ, но карточка без КБЖУ. Так выглядела пустышка из
//           Open Food Facts: название и марка есть, цифр нет. Кнопка
//           «Добавить в дневник» на таком продукте обязана быть недоступна;
//   water — вода: карточка с честными нулями. Кнопка обязана РАБОТАТЬ;
//   estimate / web — карточка с известным source. Проверяем, что на экране
//           порции нет пометок о происхождении цифр;
//   (иначе) — не найдено, и путь идёт через фото.
const found = new URLSearchParams(location.search).get('found')
const EMPTY_CARD = { barcode: '4607091380101', name: 'Зефир VITAMIN с кусочками брусники', brand: 'Neo botanica', kcal100: null, p100: null, c100: null, f100: null, source: 'off' }
const WATER_CARD = { barcode: '4607050690492', name: 'Вода питьевая', brand: 'Святой Источник', kcal100: 0, p100: 0, c100: 0, f100: 0, source: 'off' }
const GUESSED_CARD = { barcode: '4607091380101', name: 'Зефир ванильный', brand: 'Шармэль', kcal100: 326, p100: 0.8, c100: 79, f100: 0.1, source: 'ai_estimate' }
const WEB_CARD = { ...GUESSED_CARD, source: 'ai_web' }
const FOUND_CARD = { empty: EMPTY_CARD, water: WATER_CARD, estimate: GUESSED_CARD, web: WEB_CARD }[found] || null

// Тело последнего запроса на сохранение — по нему тест видит, какой basis
// уехал на сервер и с какими числами. Иначе решение «правил человек цифры или
// нет» проверить нечем: оно нигде не отображается.
window.__saved = null

const realFetch = window.fetch.bind(window)
window.fetch = async (url, opts) => {
  const u = String(url)
  if (u.includes('action=barcode')) {
    return json(FOUND_CARD ? { found: true, product: FOUND_CARD } : { found: false })
  }
  if (u.includes('/api/chat')) return json({ ok: true, product: { ...PRODUCT, barcode: '4607091380101' } })
  if (u.includes('save-product')) {
    const body = JSON.parse(opts.body)
    window.__saved = body
    // Отдаём ровно то, что прислал клиент, приведя basis к source по тому же
    // правилу, что и сервер (api/_foodProduct.js, basisToSource). Стенд обязан
    // повторять эту связь, иначе экран порции покажет чужие числа.
    const source = { label: 'ai_photo', web: 'ai_web' }[body.basis] || 'ai_estimate'
    const n = v => (v === '' || v === null || v === undefined ? null : Number(String(v).replace(',', '.')))
    return json({
      ok: true,
      created: true,
      product: {
        barcode: body.barcode, name: body.name, brand: body.brand,
        kcal100: n(body.kcal100), p100: n(body.p100), c100: n(body.c100), f100: n(body.f100),
        source,
      },
    })
  }
  if (u.includes('/auth/v1/')) return json({ access_token: 'stub', user: { id: 'stub' } })
  return realFetch(url, opts)
}

// Что ушло в дневник — для проверки, что вода реально добавляется.
window.__added = null

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BarcodeScanner userId="stub-user" onClose={() => {}} onAdd={(entry, meal) => { window.__added = { entry, meal } }} meal="snack" />
  </StrictMode>,
)
