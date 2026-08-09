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

// ?basis=estimate|label|empty — какой из трёх исходов распознавания показать.
const basis = new URLSearchParams(location.search).get('basis') || 'estimate'

const PRODUCT = {
  estimate: { name: 'Зефир ванильный', brand: 'Шармэль', kcal100: 326, p100: 0.8, c100: 79, f100: 0.1, per: '100g', basis: 'estimate', sourceName: null, sourceUrl: null },
  label: { name: 'Зефир ванильный', brand: 'Шармэль', kcal100: 330, p100: 1, c100: 81, f100: 0.1, per: '100g', basis: 'label', sourceName: null, sourceUrl: null },
  empty: { name: 'Зефир ванильный', brand: 'Шармэль', kcal100: null, p100: null, c100: null, f100: null, per: 'unknown', basis: 'estimate', sourceName: null, sourceUrl: null },
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

// ?found=empty — штрих-код НАХОДИТСЯ, но карточка без КБЖУ. Так выглядела
// пустышка из Open Food Facts: название и марка есть, цифр нет. Проверяем, что
// кнопка «Добавить в дневник» на таком продукте недоступна.
const found = new URLSearchParams(location.search).get('found')
const EMPTY_CARD = { barcode: '4607091380101', name: 'Зефир VITAMIN с кусочками брусники', brand: 'Neo botanica', kcal100: null, p100: null, c100: null, f100: null, source: 'off' }

const realFetch = window.fetch.bind(window)
window.fetch = async (url, opts) => {
  const u = String(url)
  if (u.includes('action=barcode')) {
    return json(found === 'empty' ? { found: true, product: EMPTY_CARD } : { found: false })
  }
  if (u.includes('/api/chat')) return json({ ok: true, product: { ...PRODUCT, barcode: '4607091380101' } })
  // ?similar=1 — сервер нашёл товар с таким же названием и маркой и спрашивает,
  // тот же это продукт или другой вкус.
  if (u.includes('save-product')) {
    const body = JSON.parse(opts.body)
    if (new URLSearchParams(location.search).get('similar') && !body.sameAs && !body.distinct) {
      return json({
        ok: false,
        reason: 'similar_exists',
        candidate: { barcode: '2627326027856', name: 'Зефир с кусочками брусники', brand: 'NEO botanica', kcal100: 138, p100: 0.4, c100: 34, f100: 0 },
        incoming: { barcode: '1647516027856', name: 'Зефир с кусочками брусники', brand: 'NEO botanica', kcal100: 135, p100: 0.4, c100: 34, f100: 0 },
      })
    }
    return json({ ok: true, created: true, product: { ...PRODUCT, barcode: '1647516027856' } })
  }
  if (u.includes('/auth/v1/')) return json({ access_token: 'stub', user: { id: 'stub' } })
  return realFetch(url, opts)
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BarcodeScanner userId="stub-user" onClose={() => {}} onAdd={() => {}} meal="snack" />
  </StrictMode>,
)
