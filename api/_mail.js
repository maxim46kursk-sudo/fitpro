import tls from 'node:tls'
import crypto from 'node:crypto'

/**
 * ОТПРАВКА ПИСЕМ (окт 2026, письмо участнику акции после оплаты).
 *
 * Тот же ящик, через который Supabase шлёт письма входа: noreply@fitproapp.ru
 * на smtp.yandex.ru:465. Своя маленькая отправка на node:tls вместо пакета —
 * на сервере выкладка идёт без npm install, а протокол здесь нужен простейший:
 * вход, одно письмо, выход.
 *
 * Переменные окружения fitpro-app: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
 * SMTP_FROM_NAME (по умолчанию «ZM Club»). Адрес отправителя = SMTP_USER:
 * Яндекс не пропускает письмо от чужого адреса.
 */

const b64 = s => Buffer.from(String(s), 'utf8').toString('base64')
const encHeader = s => `=?UTF-8?B?${b64(s)}?=`
const wrap76 = s => s.replace(/.{1,76}/g, m => m + '\r\n')

function buildMessage({ from, fromName, to, subject, text, html }) {
  const boundary = 'zm' + crypto.randomBytes(12).toString('hex')
  const domain = from.split('@')[1] || 'localhost'
  return [
    `From: ${encHeader(fromName)} <${from}>`,
    `To: <${to}>`,
    `Subject: ${encHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(text)),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(html)),
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

/** Отправить одно письмо. Бросает ошибку, если сервер почты отказал. */
export async function sendMail({ to, subject, text, html }) {
  const host = process.env.SMTP_HOST
  const port = Number(process.env.SMTP_PORT || 465)
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  const fromName = process.env.SMTP_FROM_NAME || 'ZM Club'
  if (!host || !user || !pass) throw new Error('SMTP не настроен (SMTP_HOST/SMTP_USER/SMTP_PASS)')
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(to || ''))) throw new Error('неверный адрес получателя')

  const sock = tls.connect({ host, port, servername: host })
  sock.setEncoding('utf8')
  let buf = ''
  const waiters = []
  let failed = null
  const fail = e => {
    failed = failed || e
    while (waiters.length) waiters.shift().reject(failed)
  }
  sock.on('data', d => {
    buf += d
    for (;;) {
      const m = /^(\d{3}) .*\r?\n/m.exec(buf)
      if (!m) return
      const end = m.index + m[0].length
      const reply = { code: Number(m[1]), text: buf.slice(0, end).trim() }
      buf = buf.slice(end)
      const w = waiters.shift()
      if (w) w.resolve(reply)
    }
  })
  sock.on('error', fail)
  sock.on('close', () => fail(new Error('SMTP: соединение закрыто')))
  sock.setTimeout(20000, () => { fail(new Error('SMTP: таймаут')); sock.destroy() })

  const read = () => failed ? Promise.reject(failed) : new Promise((resolve, reject) => waiters.push({ resolve, reject }))
  const step = async (line, ok) => {
    if (line != null) sock.write(line + '\r\n')
    const r = await read()
    if (!ok.includes(r.code)) throw new Error(`SMTP ${r.code}: ${r.text.slice(0, 200)}`)
    return r
  }

  try {
    await step(null, [220])
    await step('EHLO zmclubonline.ru', [250])
    await step('AUTH LOGIN', [334])
    await step(b64(user), [334])
    await step(b64(pass), [235])
    await step(`MAIL FROM:<${user}>`, [250])
    await step(`RCPT TO:<${to}>`, [250, 251])
    await step('DATA', [354])
    await step(buildMessage({ from: user, fromName, to, subject, text, html }) + '\r\n.', [250])
    sock.write('QUIT\r\n')
  } finally {
    setTimeout(() => sock.destroy(), 500)
  }
}
