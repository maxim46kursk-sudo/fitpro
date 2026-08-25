/**
 * СТОРОЖ CSP: НОВЫЙ ВНЕШНИЙ АДРЕС ОБЯЗАН ЛОМАТЬ СБОРКУ, А НЕ ПРИЛОЖЕНИЕ.
 *
 * Зачем. С момента, как в server.mjs появилась строгая CSP, у приложения есть
 * ровно один способ сломаться незаметно: кто-то добавляет библиотеку или
 * сервис, который ходит на адрес, в политике не перечисленный. Сборка проходит,
 * тесты проходят, выкладка проходит — и уже у живого человека молча не
 * загружается шрифт, счётчик или картинка. Ни ошибки, ни падения: браузер
 * просто не делает запрос.
 *
 * Такую беду нельзя ловить внимательностью — её надо ловить сборкой.
 *
 * Как. Разбираем dist/ на внешние адреса, разбираем CSP на разрешённые хосты
 * (ту самую, что уходит в ответ, — она импортируется из server.mjs, а не
 * переписывается сюда) и сверяем. Всё, чего нет ни в политике, ни в списке
 * заведомо несетевых строк ниже, — это отказ сборки с именем адреса.
 *
 * Что делать, когда сторож сработал. Ровно два честных пути:
 *   • адрес действительно нужен → дописать его в нужную директиву buildCsp()
 *     в server.mjs (connect-src для fetch, img-src для картинок, и т.д.);
 *   • адрес в сеть не ходит (строка в комментарии, ссылка в тексте) → добавить
 *     сюда, в НЕ_СЕТЕВЫЕ, с объяснением почему.
 * Чего делать нельзя: глушить сторожа или ослаблять политику до `*`.
 *
 * Запуск: node tools/csp-check.mjs (после vite build).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCsp } from '../server.mjs'

const КОРЕНЬ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(КОРЕНЬ, 'dist')

/**
 * Хосты, которые в бандле встречаются, но запросов к ним не бывает.
 *
 * Каждая строка — с причиной. Без причины строка тут не живёт: этот список —
 * единственная дырка в стороже, и она должна оставаться маленькой и понятной.
 */
const НЕ_СЕТЕВЫЕ = {
  'www.w3.org': 'пространство имён SVG внутри разметки иконок — не адрес',
  'react.dev': 'ссылка в тексте ошибки React',
  'github.com': 'ссылка в комментарии зависимости',
  'jcgt.org': 'ссылка на статью в комментарии three.js',
  't.me': 'обычные ссылки на телеграм — переход, а не запрос; CSP навигацию не ограничивает',
  'api.iconify.design': 'запасной путь @iconify/react; все иконки зарегистрированы локально (src/iconData.js, src/glassIcons.jsx), в сеть он не идёт',
  'api.simplesvg.com': 'то же зеркало Iconify',
  'api.unisvg.com': 'то же зеркало Iconify',
  'game.com': 'пример адреса в комментариях telegram-web-app.js (urlAppendHashParams) — шесть вхождений, все в пояснениях к коду; запроса туда нет',
  localhost: 'адрес для разработки, в проде не используется',
  '127.0.0.1': 'адрес для разработки, в проде не используется',
}

/** Хосты, разрешённые политикой (все директивы, где адреса вообще бывают). */
function хостыИзCsp(csp) {
  const out = new Set()
  for (const m of csp.matchAll(/https?:\/\/([a-zA-Z0-9.*-]+)/g)) out.add(m[1])
  return out
}

/** `*.telegram.org` разрешает `web.telegram.org`. */
function разрешён(хост, разрешённые) {
  if (разрешённые.has(хост)) return true
  for (const шаблон of разрешённые) {
    if (шаблон.startsWith('*.') && (хост === шаблон.slice(2) || хост.endsWith(шаблон.slice(1)))) return true
  }
  return false
}

function файлы(каталог) {
  const out = []
  for (const item of fs.readdirSync(каталог, { withFileTypes: true })) {
    const полный = path.join(каталог, item.name)
    if (item.isDirectory()) out.push(...файлы(полный))
    else if (/\.(js|mjs|css|html|json|webmanifest)$/i.test(item.name)) out.push(полный)
  }
  return out
}

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('csp-check: нет dist/index.html — сначала vite build')
  process.exit(1)
}

const csp = buildCsp(fs.readFileSync(path.join(DIST, 'index.html'), 'utf8'))
const разрешённые = хостыИзCsp(csp)

/** хост → в каких файлах встретился */
const найдено = new Map()
for (const файл of файлы(DIST)) {
  const текст = fs.readFileSync(файл, 'utf8')
  for (const m of текст.matchAll(/https?:\/\/([a-zA-Z0-9._-]+)/g)) {
    const хост = m[1].replace(/[.]+$/, '')
    if (!найдено.has(хост)) найдено.set(хост, new Set())
    найдено.get(хост).add(path.relative(КОРЕНЬ, файл))
  }
}

const чужие = [...найдено.keys()]
  .filter(хост => !разрешён(хост, разрешённые))
  .filter(хост => !(хост in НЕ_СЕТЕВЫЕ))
  .sort()

if (чужие.length) {
  console.error('\ncsp-check: в сборке есть внешние адреса, которых нет в CSP.\n')
  for (const хост of чужие) {
    console.error(`  ${хост}`)
    for (const файл of [...найдено.get(хост)].slice(0, 3)) console.error(`      ${файл}`)
  }
  console.error(
    '\nЕсли адрес нужен — добавь его в нужную директиву buildCsp() в server.mjs.' +
      '\nЕсли он в сеть не ходит — впиши его в НЕ_СЕТЕВЫЕ в tools/csp-check.mjs с причиной.' +
      '\nБез этого браузер молча не выполнит запрос уже в проде.\n',
  )
  process.exit(1)
}

console.log(
  `csp-check: внешних адресов в сборке — ${найдено.size}, ` +
    `разрешено политикой — ${[...найдено.keys()].filter(х => разрешён(х, разрешённые)).length}, ` +
    `помечено несетевыми — ${[...найдено.keys()].filter(х => х in НЕ_СЕТЕВЫЕ).length}. Незакрытых нет.`,
)
