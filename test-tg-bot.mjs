/**
 * КОМАНДЫ БОТА: отвечаем ТОЛЬКО своему чату.
 *
 * Единственная проверка, ради которой этот файл заведён. Адрес вебхука знает
 * Телеграм, но адрес — не пропуск: в него постучится любой, кто его добудет, а
 * за командой стоит сводка по боевой базе. Ошибиться тут можно ровно один раз.
 *
 * Проверяется поведение целиком, через настоящий обработчик: подставлены только
 * окружение, база и исходящая сеть.
 */
import assert from 'node:assert'

let pass = 0
let fail = 0
function проверка(имя, ок, что = '') {
  if (ок) {
    pass += 1
    console.log(`✓ PASS  ${имя}`)
  } else {
    fail += 1
    console.log(`✗ FAIL  ${имя}${что ? `  — ${что}` : ''}`)
  }
}

const СВОЙ = '111222333'
const ЧУЖОЙ = '999888777'
const СЕКРЕТ = 'секрет-вебхука-для-прогона'

process.env.TG_WEBHOOK_KEY = СЕКРЕТ
process.env.TG_ALERT_CHAT = СВОЙ
process.env.TG_ALERT_TOKEN = 'bot-token-for-test'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-for-test'
process.env.VITE_SUPABASE_URL = 'https://base.example'

/** Что бот отправил наружу за прогон. */
let отправлено = []
const REAL_FETCH = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const адрес = String(url)
  // ответ бота в чат
  if (адрес.includes('api.telegram.org')) {
    отправлено.push(JSON.parse(init?.body ?? '{}'))
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  // всё, что идёт в базу: пустые выборки — сводке этого хватает
  return {
    ok: true,
    status: 200,
    headers: new Map([['content-range', '0-0/0']]),
    json: async () => [],
    text: async () => '[]',
  }
}

const { default: handler } = await import('./api/set-exercise.js')

/** Поддельные req/res: ровно то, что читает обработчик. */
function запрос({ chat, текст, key = СЕКРЕТ, method = 'POST' }) {
  const req = {
    method,
    query: { action: 'tg', key },
    headers: { 'content-type': 'application/json' },
    body: { message: { chat: { id: chat }, text: текст } },
    socket: { remoteAddress: '127.0.0.1' },
  }
  const res = {
    statusCode: null,
    payload: undefined,
    setHeader() {},
    status(code) {
      this.statusCode = code
      return this
    },
    json(v) {
      this.payload = v
      return this
    },
    end(v) {
      this.payload = v
      return this
    },
  }
  return { req, res }
}

console.log('КОМАНДЫ БОТА — отвечаем только своему чату\n')

// ── 1. свой чат получает цифры ─────────────────────────────────────────────
{
  отправлено = []
  const { req, res } = запрос({ chat: СВОЙ, текст: '/сводка' })
  await handler(req, res)
  const ответ = отправлено[0]
  проверка('свой чат: код 200', res.statusCode === 200, `код ${res.statusCode}`)
  проверка('свой чат: бот ответил', отправлено.length === 1, `отправок ${отправлено.length}`)
  проверка(
    'свой чат: ответ ушёл именно в его chat_id',
    ответ?.chat_id === СВОЙ,
    `chat_id ${ответ?.chat_id}`,
  )
  проверка(
    'свой чат: в ответе цифры, а не пустая строка',
    typeof ответ?.text === 'string' && /за сутки|за час/.test(ответ.text),
    JSON.stringify(ответ?.text ?? '').slice(0, 80),
  )
  проверка(
    'ответ не длиннее потолка Телеграма',
    (ответ?.text?.length ?? 0) <= 4000,
    `${ответ?.text?.length} знаков`,
  )
}

// ── 2. ЧУЖОЙ чат не получает НИЧЕГО ────────────────────────────────────────
{
  отправлено = []
  const { req, res } = запрос({ chat: ЧУЖОЙ, текст: '/сводка' })
  await handler(req, res)
  проверка('чужой чат: код 200 (Телеграм не должен повторять)', res.statusCode === 200, `код ${res.statusCode}`)
  проверка('чужой чат: НИ ОДНОЙ отправки', отправлено.length === 0, `отправок ${отправлено.length}`)
  проверка('чужой чат: тело ответа пустое', res.payload === undefined, JSON.stringify(res.payload))
}

// ── 3. неверный секрет — 404, и это не 200 ─────────────────────────────────
{
  отправлено = []
  const { req, res } = запрос({ chat: СВОЙ, текст: '/сводка', key: 'не-тот-секрет' })
  await handler(req, res)
  проверка('чужой секрет: 404', res.statusCode === 404, `код ${res.statusCode}`)
  проверка('чужой секрет: ничего не отправлено', отправлено.length === 0)
}

// ── 4. остальные команды отвечают своему чату ──────────────────────────────
for (const команда of ['/час', '/игра', '/help']) {
  отправлено = []
  const { req, res } = запрос({ chat: СВОЙ, текст: команда })
  await handler(req, res)
  проверка(`${команда}: свой чат получил ответ`, отправлено.length === 1 && res.statusCode === 200)
}

// ── 5. не команда — молчим ─────────────────────────────────────────────────
{
  отправлено = []
  const { req, res } = запрос({ chat: СВОЙ, текст: 'привет, как дела' })
  await handler(req, res)
  проверка('обычное сообщение: бот молчит', отправлено.length === 0 && res.statusCode === 200)
}

globalThis.fetch = REAL_FETCH
console.log(`\nИтог: ${pass} пройдено, ${fail} провалено`)
assert.equal(fail, 0)
process.exit(fail ? 1 : 0)
