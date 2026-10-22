import { PROMO_KEY, PROMO_CAP } from './_promo.js'

/**
 * ВОРОНКА АКЦИИ ДЛЯ ВЛАДЕЛЬЦА (окт 2026) — api/promo.js?action=funnel.
 *
 * Два источника, и это важно:
 *  • ДЕЙСТВИЯ НА САЙТЕ — журнал app_events (событие 'promo', шаг в props.s).
 *    Люди считаются по anon_id (браузер), каждый шаг — один раз на человека.
 *    Это оценка поведения: блокировщики и приватные вкладки часть событий
 *    теряют.
 *  • ДЕНЬГИ, АНКЕТЫ, ГРУППА — только из базы (promo_tickets,
 *    promo_participants, club_chat_members). Тут ничего не теряется.
 * Тестовые номера (9001+) не считаются нигде.
 */

// Начало акции: всё, что раньше, — наши тесты лендинга.
const PROMO_START = '2026-10-20T00:00:00+03:00'
const PAGE = 1000
const MAX_ROWS = 200000

function since(period) {
  const now = new Date()
  if (period === 'today') {
    const msk = new Date(now.getTime() + 3 * 3600e3)
    return new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate()) - 3 * 3600e3).toISOString()
  }
  if (period === '7d') return new Date(now.getTime() - 7 * 864e5).toISOString()
  return new Date(PROMO_START).toISOString()
}

// Блоки лендинга сверху вниз — как data-blk в src/ClubLanding.jsx. 'pre' — быстрый
// первый экран (index.html), пока не загрузился полный лендинг.
const BLOCKS = [
  ['pre', 'Не дождались полной страницы'],
  ['video', 'Ролик с машиной'],
  ['prizes', 'Призы'],
  ['why', 'Почему это выгодно'],
  ['buy', 'Пакеты и кнопка «Вступить»'],
  ['about', '«Тренируйся по научным данным»'],
  ['inside', 'Что внутри клуба'],
  ['goals', 'Для кого'],
  ['value', 'Стоимость по отдельности'],
  ['price', 'Почему так недорого'],
  ['results', 'Результаты участниц'],
  ['reviews', 'Отзывы'],
  ['final', 'Финальная кнопка'],
]
const BIDX = Object.fromEntries(BLOCKS.map(([k], i) => [k, i]))
const TIME = [[10, 'до 10 с'], [30, '10–30 с'], [60, '30 с – 1 мин'], [180, '1–3 мин'], [Infinity, 'больше 3 мин']]

const mskDay = iso => new Date(new Date(iso).getTime() + 3 * 3600e3).toISOString().slice(0, 10)

function speed(arr) {
  const a = arr.filter(n => Number.isFinite(n) && n >= 0 && n < 120000).sort((x, y) => x - y)
  if (!a.length) return null
  const q = p => a[Math.min(a.length - 1, Math.floor(p * a.length))]
  return { n: a.length, med: q(0.5), p90: q(0.9), slow: a.filter(x => x > 5000).length }
}

async function allEvents(db, from) {
  const rows = []
  for (let off = 0; off < MAX_ROWS; off += PAGE) {
    const { data, error } = await db.from('app_events')
      .select('anon_id, session_id, ts, props')
      .eq('name', 'promo').gte('ts', from)
      .order('ts', { ascending: true })
      .range(off, off + PAGE - 1)
    if (error) throw new Error(`app_events: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

export async function promoFunnel(db, period) {
  const from = since(period)
  const ev = await allEvents(db, from)

  // ── Действия на сайте: кто какой шаг сделал (по разу на человека).
  const people = new Map() // who → { src, steps:Set, day }
  const loads = { pre: [], app: [], appAfterPre: [], pay: [] }
  const fails = {}
  let failN = 0
  for (const e of ev) {
    const p = e.props || {}
    const s = p.s
    if (!s) continue
    const who = e.anon_id || e.session_id
    let rec = people.get(who)
    if (!rec) { rec = { src: null, steps: new Set(), day: mskDay(e.ts), far: -1, blk: false, leave: null }; people.set(who, rec) }
    if (s === 'blk' && p.b in BIDX) { rec.blk = true; rec.far = Math.max(rec.far, BIDX[p.b]) }
    if (s === 'leave' && p.b in BIDX) rec.leave = { b: p.b, t: Number(p.t) }
    if (s === 'seen_end') rec.far = Math.max(rec.far, BIDX.final)
    if (!rec.src && p.src) rec.src = String(p.src)
    if (s === 'pkg' && p.plan === 'club4') rec.steps.add('pkg4')
    else rec.steps.add(s)
    if (s === 'land_pre') loads.pre.push(Number(p.ms))
    if (s === 'land') (p.pre ? loads.appAfterPre : loads.app).push(Number(p.ms))
    if (s === 'pay_ok') loads.pay.push(Number(p.ms))
    if (s === 'pay_fail') { failN++; const w = String(p.why || '?'); fails[w] = (fails[w] || 0) + 1 }
  }
  const has = (r, s) => r.steps.has(s)
  const visitors = [...people.values()].filter(r => has(r, 'land') || has(r, 'land_pre'))
  const cnt = s => visitors.filter(r => has(r, s)).length

  // ── Где уходят: до какого блока долистали и на каком остановились.
  // Считаем только тех, у кого есть разметка блоков (заходы после её выкладки)
  // или кто ушёл с быстрого экрана.
  const tracked = visitors.filter(r => r.blk || r.leave?.b === 'pre')
  const exits = BLOCKS.map(([key, label], i) => {
    const reached = i === 0 ? tracked.length : tracked.filter(r => r.far >= i).length
    const left = tracked.filter(r => !has(r, 'join') && (i === 0 ? r.far < 1 : r.far === i)).length
    return { key, label, reached, left }
  })
  const noJoin = tracked.filter(r => !has(r, 'join') && r.leave && Number.isFinite(r.leave.t))
  const secs = noJoin.map(r => r.leave.t).sort((a, b) => a - b)
  const time = {
    n: secs.length,
    med: secs.length ? secs[Math.floor(secs.length / 2)] : null,
    buckets: TIME.map(([lim, label], i) => ({ label, n: secs.filter(t => t < lim && (i === 0 || t >= TIME[i - 1][0])).length })),
  }

  // ── База: оплаты за период, анкеты, письма, группа.
  const { data: tix, error: tErr } = await db.from('promo_tickets')
    .select('number, payment_key, user_id, amount, created_at')
    .eq('promo', PROMO_KEY).eq('is_test', false).is('annulled_at', null).gte('created_at', from)
  if (tErr) throw new Error(`promo_tickets: ${tErr.message}`)
  const pays = new Map()
  for (const t of tix || []) if (!pays.has(t.payment_key)) pays.set(t.payment_key, t)
  const payers = [...new Set((tix || []).map(t => t.user_id).filter(Boolean))]

  let part = [], inGroup = 0
  if (payers.length) {
    const { data: pp } = await db.from('promo_participants')
      .select('user_id, full_name, birth_date, phone, consent_at, mail_sent_at, mail_error').in('user_id', payers)
    part = pp || []
    const { data: gm } = await db.from('club_chat_members')
      .select('user_id').in('user_id', payers).is('removed_at', null)
    inGroup = (gm || []).length
  }
  const anketa = part.filter(p => p.full_name && p.birth_date && p.phone && p.consent_at).length
  const mailOk = part.filter(p => p.mail_sent_at).length
  const mailBad = part.filter(p => !p.mail_sent_at && p.mail_error).length

  const { count: issued } = await db.from('promo_tickets')
    .select('number', { count: 'exact', head: true }).eq('promo', PROMO_KEY).eq('is_test', false).is('annulled_at', null)

  // ── Источники: заход → «Вступить» → касса.
  const bySrc = {}
  for (const r of visitors) {
    const k = r.src || 'direct'
    const b = bySrc[k] || (bySrc[k] = { src: k, visitors: 0, join: 0, pay_ok: 0 })
    b.visitors++
    if (has(r, 'join')) b.join++
    if (has(r, 'pay_ok')) b.pay_ok++
  }

  // ── По дням (МСК).
  const byDay = {}
  const day = d => byDay[d] || (byDay[d] = { day: d, visitors: 0, join: 0, pay_ok: 0, paid: 0, money: 0 })
  for (const r of visitors) {
    const b = day(r.day); b.visitors++
    if (has(r, 'join')) b.join++
    if (has(r, 'pay_ok')) b.pay_ok++
  }
  for (const t of pays.values()) { const b = day(mskDay(t.created_at)); b.paid++; b.money += Number(t.amount || 0) }

  const money = [...pays.values()].reduce((a, t) => a + Number(t.amount || 0), 0)
  return {
    period, from,
    funnel: [
      { key: 'visit', label: 'Зашли на лендинг', n: visitors.length },
      { key: 'seen_buy', label: 'Долистали до кнопки «Вступить»', n: cnt('seen_buy') },
      { key: 'join', label: 'Нажали «Вступить»', n: cnt('join') },
      { key: 'pay_ok', label: 'Касса открылась', n: cnt('pay_ok') },
      { key: 'paid', label: 'Оплатили', n: payers.length, db: true },
      { key: 'anketa', label: 'Заполнили анкету', n: anketa, db: true },
      { key: 'group', label: 'В группе, номер получили в Telegram', n: inGroup, db: true },
    ],
    side: [
      { label: 'Открыли «Как участвовать»', n: cnt('how') },
      { label: 'Открыли «Правила»', n: cnt('rules') },
      { label: 'Долистали до конца страницы', n: cnt('seen_end') },
      { label: 'Выбирали пакет 3+1', n: cnt('pkg4') },
      { label: 'Нажали карточку «3+1 · шанс ×4»', n: cnt('deal') },
      { label: 'Ушли смотреть клуб изнутри', n: cnt('look') },
      { label: 'Вернулись из кассы, не оплатив', n: cnt('back_nopay'), bad: true },
      { label: 'Касса не открылась (раз)', n: failN, bad: true, why: fails },
      { label: 'Увидели окно с номером', n: cnt('sheet') },
      { label: 'Нажали «Вступить в группу»', n: cnt('group') },
      { label: 'Письмо с номером ушло', n: mailOk },
      { label: 'Письмо НЕ ушло', n: mailBad, bad: true },
    ],
    money: { payments: pays.size, sum: money, numbers: (tix || []).length },
    places: { cap: PROMO_CAP, issued: issued || 0, left: Math.max(0, PROMO_CAP - (issued || 0)) },
    exits: { tracked: tracked.length, blocks: exits, time },
    speed: { pre: speed(loads.pre), app: speed(loads.app), appAfterPre: speed(loads.appAfterPre), pay: speed(loads.pay) },
    sources: Object.values(bySrc).sort((a, b) => b.visitors - a.visitors).slice(0, 12),
    days: Object.values(byDay).sort((a, b) => b.day.localeCompare(a.day)),
  }
}
