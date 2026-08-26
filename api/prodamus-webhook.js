import qs from 'qs'
import { createClient } from '@supabase/supabase-js'
// Журнал ошибок + мгновенное уведомление тренеру. Файл с подчёркиванием —
// не serverless-функция.
import { reportError } from './_logError.js'
import { verifySignature, PLAN_PRICE, CHALLENGE_ITEM } from './_prodamus.js'
// Какой поток человеку — общее правило на клиент и обе платёжные ручки.
import { resolveSeasonFor } from './_challengeSeason.js'
import { ступеньСервера } from './_challengeLog.js'
// Продажа билета — событие, о котором владелец узнаёт немедленно, а не из сводки.
import { сообщитьОбОплате } from './_challengeSale.js'

// Вебхук уведомлений Продамуса. Тело подписано, поэтому НЕ даём Vercel его
// разобрать — подпись считается по точной сырой форме, любой репарсинг
// (порядок ключей, типы) её ломает. Читаем поток сами и разбираем через qs,
// т.к. Продамус шлёт вложенные ключи products[0][name] — качественно их
// разворачивает именно qs, повторяя структуру, которую подписывал их PHP.
export const config = { api: { bodyParser: false } }

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'

// Сумма платежа → пакет. Основа опознания — СУММА, а не order_id: order_id
// приходит из ссылки и пользователь теоретически может его подменить, а сумму
// подтверждает подписанное уведомление. Ключи — числа рублей. Ярлык платежа
// (см. resolveItem ниже) эту таблицу не отменяет: он только выбирает между
// товарами ОДНОЙ цены, и без совпадения по сумме не значит ничего.
// БАЗА снята с продажи — суммы её пакета (тест 50 / бой 1000) убраны, начислять
// по ним больше нечего. Ранее купившим доступ сохраняет их profiles.plan='base'.
// Только БОЕВЫЕ суммы: тестовые (60/70) убраны — иначе платёж на 70 ₽ мимо
// нашей ссылки начислил бы ПРЕМИУМ.
// 50 — служебный тариф test50 (проверка живой оплаты). Сумма настоящая: он и
// нужен затем, чтобы деньги прошли по боевым рельсам.
//
// ⚠ ПОБОЧНОЕ СЛЕДСТВИЕ, ПРО КОТОРОЕ НАДО ЗНАТЬ: определение пакета идёт по
// сумме, поэтому ЛЮБОЙ платёж ровно на 50 ₽ через эту кассу — хоть мимо нашей
// ссылки — начислит сутки уровня ПРОФИТ. Раньше по той же причине убрали
// тестовые 60 и 70: платёж на 70 ₽ начислял ПРЕМИУМ. Здесь цена ущерба —
// одни сутки; за 60 и 70 давали месяц, и это была совсем другая история.
const AMOUNT_TO_PLAN = {
  2990: 'profit', 9990: 'premium', 50: 'test50',
}

// ── ЯРЛЫК ПЛАТЕЖА И ПОЧЕМУ ОДНОЙ СУММЫ БОЛЬШЕ НЕ ХВАТАЕТ ────────────────────
//
// Билет челленджа стоит те же 2990, что и ПРОФИТ. По прежнему правилу («сумма
// решает всё») покупка билета начислила бы человеку тариф ПРОФИТ — не тот
// товар за те же деньги.
//
// Новое правило: если ярлык называет ИЗВЕСТНЫЙ товар И оплаченная сумма равна
// цене ИМЕННО ЭТОГО товара — начисляем товар из ярлыка; во всех остальных
// случаях работает прежний путь по сумме.
//
// ПОЧЕМУ ЭТО НЕ ОСЛАБЛЕНИЕ. Ярлык приезжает из нашей же ссылки, подписанной
// нашим ключом, но сам по себе доверия не заслуживает — подпись покрывает всё
// уведомление целиком, а не происхождение ярлыка. Поэтому ярлык здесь ничего
// не разрешает, он только ВЫБИРАЕТ между товарами одной цены: сумма осталась
// сторожем и обязана сойтись. Подменивший ярлык не получит ничего дороже
// оплаченного — в худшем случае он купит за свои деньги другой товар той же
// цены. Прежнее правило такого выбора не давало вовсе, поэтому новое строго
// надёжнее, а не слабее.
//
// Ярлык — часть ПОСЛЕ последнего '__' в customer_extra (запасной вариант —
// order_id, как и с userId).
const extractItemTag = src => {
  if (!src) return null
  const cut = src.lastIndexOf('__')
  if (cut < 0) return null
  const tag = src.slice(cut + 2).trim()
  return tag || null
}

// ── ЦЕНА БИЛЕТА ПРИЕЗЖАЕТ ИЗ ПОТОКА, А НЕ ИЗ КОНСТАНТЫ ──────────────────────
//
// Здесь стояла зашитая CHALLENGE_PRICE = 2990, и пока поток был один, этого
// хватало. Со служебным потоком за 50 ₽ (sql/2026-08-25_challenge_staff_season.sql)
// перестало: 50 ₽ уже занято тарифом ТЕСТ 50, и билет, сверенный с зашитой
// ценой, ярлыком бы не опознался — платёж за место в потоке начислил бы тариф.
// Поэтому challengePrice — это price_rub ТОГО потока, куда человека зачисляют
// (какого именно — решает api/_challengeSeason.js).
//
// ПРАВИЛО «ЯРЛЫК ДЕЙСТВУЕТ ТОЛЬКО ПРИ СОВПАДЕНИИ СУММЫ» ОСТАЁТСЯ. Сумма
// по-прежнему сторож: подменивший ярлык не получит ничего дороже оплаченного.
//
// А ВОТ ЧТО ДОБАВИЛОСЬ: ярлык билета отменяет разбор по сумме насовсем. Раньше
// «__challenge на чужую сумму» откатывался к таблице сумм, и это было безобидно
// ровно до тех пор, пока цена билета была константой. Теперь цены может не быть
// вовсе (потока нет) — и старый откат означал бы, что билет за 2990 без
// открытого потока молча превращается в ПРОФИТ вместо честного 'no_open_season'.
// Ущерба подменившему ярлык это не даёт и дать не может: он получит НЕ БОЛЬШЕ,
// а меньше — билет вместо тарифа или вовсе ничего.
//
// Экспортируется ради теста — правило дороже, чем то, что вокруг него.
export function resolveItem(tag, sumNum, challengePrice) {
  if (!Number.isFinite(sumNum)) return undefined
  if (tag === CHALLENGE_ITEM) {
    return challengePrice === sumNum ? CHALLENGE_ITEM : undefined
  }
  // Object.hasOwn, а не просто PLAN_PRICE[tag]: ярлык приходит снаружи, и
  // 'constructor' или 'toString' достали бы из прототипа не цену, а функцию.
  const taggedPrice = tag && Object.hasOwn(PLAN_PRICE, tag) ? PLAN_PRICE[tag] : undefined
  if (taggedPrice !== undefined && taggedPrice === sumNum) return tag
  return AMOUNT_TO_PLAN[sumNum]
}

// Срок пакета в днях. Правило то же, что на клиенте (src/plans.js,
// daysOfPlan): у тарифа либо свой срок, либо общее умолчание. Таблица здесь
// копией, а не импортом из src/ — по той же причине, что и цены в
// _prodamus.js: api/ и src/ собираются раздельно. Расхождение стережёт тест.
export const PLAN_DAYS_DEFAULT = 30
export const PLAN_DAYS_BY_KEY = { test50: 1 }
const daysForPlan = key => PLAN_DAYS_BY_KEY[key] || PLAN_DAYS_DEFAULT
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Подпись — общая с исходящей ссылкой (api/_prodamus.js): один алгоритм,
// уже принятый Продамусом на входящих уведомлениях.

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

// id тренера, к которому привязываем покупателей ПРЕМИУМ. Приоритет у
// TRAINER_USER_ID: переменная однозначна и переживёт появление второго тренера
// в базе, тогда как поиск по роли в этом случае вернёт произвольного. Если
// тренера определить не удалось — возвращаем null, привязку просто пропускаем
// (начисление пакета от этого не зависит и падать не должно).
async function resolveTrainerId(supabaseAdmin) {
  const fromEnv = (process.env.TRAINER_USER_ID || '').trim()
  if (fromEnv) {
    if (UUID_RE.test(fromEnv)) return fromEnv
    console.warn('Prodamus webhook: TRAINER_USER_ID задан, но это не UUID — игнорируем')
  }
  const { data, error } = await supabaseAdmin
    .from('profiles').select('id').eq('role', 'trainer').limit(1).maybeSingle()
  if (error) {
    console.error('Prodamus webhook: ошибка поиска тренера:', error)
    return null
  }
  return data?.id || null
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed')

  const secret = process.env.PRODAMUS_SECRET_KEY
  if (!secret) {
    reportError('api:prodamus:config', ['PRODAMUS_SECRET_KEY не настроен — уведомление принять нельзя'], { message: 'PRODAMUS_SECRET_KEY не настроен', status: 500 })
    return res.status(500).send('Server not configured')
  }
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    reportError('api:prodamus:config', ['SUPABASE_SERVICE_ROLE_KEY не настроен'], { message: 'SUPABASE_SERVICE_ROLE_KEY не настроен', status: 500 })
    return res.status(500).send('Server not configured')
  }

  let raw
  try {
    raw = await readRawBody(req)
  } catch (e) {
    console.error('Prodamus webhook: не удалось прочитать тело:', e)
    return res.status(400).send('Bad request')
  }

  const data = qs.parse(raw)
  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey)

  // ── Проверка подписи. Подпись — из заголовка sign, запасной вариант — поле
  // signature в теле. В лог — только факт отказа: ни секрет, ни ожидаемая
  // подпись, ни подписываемая строка наружу попадать не должны.
  const provided = (req.headers['sign'] || data.signature || '').toString()
  if (!verifySignature(data, secret, provided)) {
    console.error('Prodamus webhook: подпись не сошлась', { order_num: data.order_num ?? null })
    return res.status(400).send('Bad signature')
  }

  // Подпись верна — логируем только служебные поля, без персональных данных.
  console.log('Prodamus webhook: подтверждённое уведомление', {
    order_num: data.order_num ?? null,
    sum: data.sum ?? null,
    payment_status: data.payment_status ?? null,
  })

  const orderId = data.order_id != null ? String(data.order_id) : null
  const orderNum = data.order_num != null ? String(data.order_num) : null
  const paymentStatus = data.payment_status != null ? String(data.payment_status) : ''
  const sumNum = Number(data.sum)

  // ── КЛЮЧ ИДЕМПОТЕНТНОСТИ. Живой сбой, стоивший двух оплат.
  //
  // Здесь стоял order_num — и это было неверно. Продамус присылает ДВА разных
  // поля, и они значат разное:
  //   order_num — НАШ ярлык `userId__план`, который мы сами положили в ссылку;
  //               Продамус возвращает его эхом. Он ОДИНАКОВ у всех покупок
  //               одного тарифа одним человеком;
  //   order_id  — СОБСТВЕННЫЙ номер платежа Продамуса (47568192). Уникален у
  //               каждой оплаты, повторяется только при ретрае того же
  //               уведомления.
  //
  // На provider_order_num стоит UNIQUE, поэтому со старым ключом ВТОРАЯ ПОКУПКА
  // ТОГО ЖЕ ТАРИФА молча отбрасывалась как повтор: деньги списаны, строки в
  // журнале нет, пакет не начислен. Это касалось не только служебного test50 —
  // так же терялось бы любое ежемесячное ПРОДЛЕНИЕ ПРОФИТ или ПРЕМИУМ. Ошибка
  // лежала спящей, потому что до сих пор все платежи в проде были от разных
  // людей и каждый покупал по одному разу.
  //
  // Правильный ключ — order_id: ретрай одного уведомления он по-прежнему
  // отбрасывает (номер тот же), а новую оплату пропускает (номер другой).
  // order_num оставлен запасным вариантом: у части старых потоков (оплата по
  // статической ссылке из бота) приходил именно он.
  const dedupKey = (orderId && orderId.trim()) || (orderNum && orderNum.trim()) || null

  // Совсем без ключа не начисляем и не пишем: два таких уведомления с NULL
  // прошли бы UNIQUE и могли начислить дважды. Отвечаем 200, чтобы Prodamus не
  // зациклил ретраи.
  if (!dedupKey) {
    console.error('Prodamus webhook: уведомление без order_id и order_num — пропускаем без начисления')
    return res.status(200).send('OK')
  }

  // userId — часть до последнего '__'. Берём из customer_extra: наш order_id
  // Продамус подменяет своим номером, а customer_extra возвращает эхом. Если
  // customer_extra пуст — запасной разбор order_id (на случай старых ссылок).
  // Пишем в user_id только валидный uuid, иначе NULL (мусор не должен ронять
  // запись в журнал).
  const extractUserId = src => {
    if (!src) return null
    const cut = src.lastIndexOf('__')
    const candidate = cut > 0 ? src.slice(0, cut) : src
    return UUID_RE.test(candidate) ? candidate : null
  }
  const customerExtra = data.customer_extra != null ? String(data.customer_extra) : null
  const userId = extractUserId(customerExtra) || extractUserId(orderId)

  const itemTag = extractItemTag(customerExtra) || extractItemTag(orderId)
  const wantsChallenge = itemTag === CHALLENGE_ITEM

  // ── ПРОФИЛЬ ЧИТАЕТСЯ РАНЬШЕ ОПОЗНАНИЯ ТОВАРА, и порядок здесь не случайный.
  //
  // Цена билета живёт в потоке, а какой поток человеку — зависит от его роли
  // (api/_challengeSeason.js). Значит, чтобы понять, билет это или тариф, надо
  // сперва узнать, кто платил. Раньше профиль читался позже, потому что цена
  // билета была константой и роль ни на что не влияла.
  //
  // Читаем и при неуспешной оплате тоже: в журнал платежей идёт опознанный
  // товар, и строка «отказ по билету» не должна числиться отказом по тарифу.
  // Имя нужно здесь же — билет снимает его в момент покупки
  // (sql/2026-08-24_challenge_entries_fix.sql).
  let prof = null
  let profErr = null
  if (userId) {
    ({ data: prof, error: profErr } = await supabaseAdmin
      .from('profiles').select('id, name, role, plan_until, coach_id').eq('id', userId).maybeSingle())
    if (profErr) console.error(`Prodamus webhook: ошибка проверки пользователя ${userId}:`, profErr)
  }

  // Поток, в который зачисляем ЭТОГО человека, и его цена. Спрашиваем только
  // когда платёж вообще назвался билетом — тарифам поток не нужен.
  let season = null
  let seasonErr = null
  if (wantsChallenge && prof) {
    ({ season, error: seasonErr } = await resolveSeasonFor(supabaseAdmin, prof.role))
    if (seasonErr) console.error('Prodamus webhook: ошибка чтения сезонов челленджа:', seasonErr)
  }

  // Товар платежа: ярлык, подтверждённый суммой, иначе прежний разбор по сумме
  // (см. resolveItem выше). undefined → опознать нечем.
  const item = resolveItem(itemTag, sumNum, season?.price_rub)
  const isChallenge = item === CHALLENGE_ITEM

  // Решаем статус для журнала и что делать дальше. Действуем только при
  // успешной оплате, опознанном товаре и реально существующем пользователе.
  let status
  let accruePlan = null
  let enrollChallenge = null
  if (paymentStatus !== 'success') {
    status = paymentStatus || 'unknown'
  } else if (!userId) {
    status = 'user_not_found'
  } else if (profErr) {
    // Отдаём 200, но НЕ начисляем и в журнал пишем как ошибку — Продамус
    // не должен зациклить ретраи из-за нашего сбоя чтения.
    status = 'user_check_failed'
  } else if (!prof) {
    status = 'user_not_found'
  } else if (wantsChallenge && seasonErr) {
    status = 'season_lookup_failed'
  } else if (wantsChallenge && !season) {
    // Деньги взяты, а зачислить некуда. Не начисляем ничего, но платёж
    // обязан попасть в журнал — по нему потом зачисляют руками.
    status = 'no_open_season'
  } else if (!item) {
    status = 'unknown_amount'
  } else if (isChallenge) {
    status = 'success'
    enrollChallenge = { seasonId: season.id, displayName: prof.name || null }
  } else {
    status = 'success'
    accruePlan = { plan: item, currentUntil: prof.plan_until, coachId: prof.coach_id }
  }

  // ── Идемпотентность + журнал. Одна вставка: она же защищает от повторов по
  // UNIQUE(provider_order_num). Повтор того же order_num → уведомление уже
  // обработано, второй раз НЕ начисляем.
  const { error: insErr } = await supabaseAdmin.from('payments').insert({
    provider_order_num: dedupKey,
    order_id: orderId,
    user_id: userId,
    // В журнал пишем опознанный товар — в том числе 'challenge' и в том числе
    // когда начисления не было: иначе строку потом не с чем сопоставить.
    // Платёж, назвавшийся билетом, числится билетом даже если потока для него
    // не нашлось: цены тогда нет, опознать по сумме нечем, а разбираться с
    // такой строкой руками будут именно как с билетом.
    plan: item || (wantsChallenge ? CHALLENGE_ITEM : null),
    amount: Number.isFinite(sumNum) ? sumNum : null,
    status,
    raw: data,
  })
  if (insErr) {
    if (insErr.code === '23505') {
      // ОТБРОШЕННЫЙ ПОВТОР ТЕПЕРЬ ВИДЕН В ЖУРНАЛЕ. Раньше эта ветка молчала в
      // консоль Vercel, и когда она сработала не по делу (см. ключ выше),
      // пропажу платежа пришлось искать руками по отсутствию строки.
      //
      // С правильным ключом сюда попадают только настоящие ретраи одного
      // уведомления — событие редкое, канал не зашумит. А если ветка вдруг
      // снова начнёт глотать живые оплаты, это будет видно сразу.
      reportError('api:prodamus:duplicate',
        [`Prodamus webhook: повторное уведомление ${dedupKey}, пропускаем`],
        { message: `повтор платежа ${dedupKey} отброшен как уже обработанный`, userId })
      return res.status(200).send('OK')
    }
    reportError('api:prodamus:payment', ['Prodamus webhook: ошибка записи в журнал платежей:', insErr], { message: insErr?.message, status: 500 })
    return res.status(500).send('Journal error')
  }

  // ── Билет челленджа: зачисление вместо начисления тарифа.
  //
  // Строго ПОСЛЕ записи в журнал: вставка выше — это и есть защита от повтора,
  // и зачислять раньше неё значило бы зачислять до проверки. Сама
  // challenge_enroll тоже идемпотентна (по payment_id и по человеку), так что
  // рубежа здесь два, а не один.
  //
  // Тариф при этом НЕ начисляется вовсе: билет — разовый товар, уровень
  // доступа он не даёт.
  if (enrollChallenge) {
    const { data: participantNo, error: enrollErr } = await supabaseAdmin.rpc('challenge_enroll', {
      p_season_id: enrollChallenge.seasonId,
      p_user_id: userId,
      // Тот же ключ, что и у журнала: обычно это order_id Продамуса, а если
      // его не прислали — order_num. Пустым он тут быть не может, выше стоит
      // отказ без ключа.
      p_payment_id: dedupKey,
      p_display_name: enrollChallenge.displayName,
    })
    if (enrollErr) {
      // Деньги взяты, платёж записан, а в поток человек не попал. Это ровно
      // тот случай, когда молчать нельзя.
      reportError('api:prodamus:challenge',
        [`Prodamus webhook: платёж ${dedupKey} записан, но НЕ удалось зачислить ${userId} в поток ${enrollChallenge.seasonId}:`, enrollErr],
        { message: `билет оплачен, зачисление НЕ прошло: ${enrollErr?.message}`, status: 500, userId })
      return res.status(200).send('OK')
    }
    console.log(`Prodamus webhook: ${userId} зачислен в поток ${enrollChallenge.seasonId} участником №${participantNo}`)
    /**
     * СТУПЕНЬ 6: оплата подтверждена. Строго после зачисления — «оплатил» и
     * «попал в поток» это одно событие, и записывать первое, не убедившись во
     * втором, значило бы считать успехом наполовину сделанное.
     *
     * Номера посетителя здесь нет: касса его не возвращает. В сводке он
     * подставляется по предыдущей ступени того же человека — их и связывает
     * `uid`.
     */
    await ступеньСервера(supabaseAdmin, 'paid', {
      userId,
      поток: enrollChallenge.seasonId,
      номер: participantNo,
    })
    /**
     * И СРАЗУ ВЛАДЕЛЬЦУ В TELEGRAM. Строго здесь: сообщение про участника №N
     * имеет смысл, только когда участник №N уже есть. Ветки выше, где билет
     * оплачен, а зачислить не вышло, кричат своим путём — через reportError.
     *
     * Сбой отправки ответ кассе не меняет (см. _challengeSale.js): Продамус
     * ждёт «OK» об оплате, а не об уведомлении.
     */
    await сообщитьОбОплате(supabaseAdmin, {
      поток: enrollChallenge.seasonId,
      номер: participantNo,
      сумма: sumNum,
      userId,
    })
    return res.status(200).send('OK')
  }

  // ОПЛАЧЕННЫЙ БИЛЕТ, КОТОРЫЙ НЕ СТАЛ УЧАСТИЕМ. Поток не нашёлся, базу не
  // спросили, сумма не сошлась с ценой потока — исходы разные, а последствие
  // одно: деньги взяты, человека в потоке нет. Платёж в журнале, зачисление
  // делается руками по нему, поэтому про это надо узнать сразу, а не из жалобы
  // участника.
  //
  // Условие по wantsChallenge, а не по опознанному товару: когда цены не
  // нашлось, товар как раз и не опознан — а именно этот случай и надо поймать.
  if (wantsChallenge && paymentStatus === 'success' && status !== 'success') {
    reportError('api:prodamus:challenge',
      [`Prodamus webhook: билет ${dedupKey} оплачен, но зачислить некуда (${status})`],
      { message: `билет челленджа оплачен, а зачислить некуда: ${status}`, status: 500, userId })
    return res.status(200).send('OK')
  }

  // Не начисляем — но платёж уже в журнале, отвечаем 200.
  if (!accruePlan) {
    console.log(`Prodamus webhook: платёж записан со статусом '${status}', пакет не начислен`)
    return res.status(200).send('OK')
  }

  // ── Начисление: продлеваем от максимума (сейчас, текущий plan_until) на срок
  // пакета, чтобы оплата во время активной подписки прибавляла срок, а не
  // затирала его. plan/plan_until пишет service_role — триггер это разрешает.
  //
  // Срок берётся по ключу пакета — ЭТО ЕДИНСТВЕННОЕ, чем служебный test50
  // отличается от боевых. Отдельной ветки под него здесь нет и быть не должно:
  // весь смысл служебного тарифа в том, что он идёт общим путём, а значит
  // проверяет именно тот код, который начисляет настоящие покупки.
  const now = Date.now()
  const currentUntilMs = accruePlan.currentUntil ? new Date(accruePlan.currentUntil).getTime() : 0
  const baseMs = Math.max(now, Number.isFinite(currentUntilMs) ? currentUntilMs : 0)
  const newUntil = new Date(baseMs + daysForPlan(accruePlan.plan) * 24 * 60 * 60 * 1000).toISOString()

  const updateFields = { plan: accruePlan.plan, plan_until: newUntil }

  // ── Привязка к тренеру: покупка ПРЕМИУМ делает человека клиентом тренера.
  // Только при пустом coach_id — уже привязанного клиента не перетаскиваем к
  // другому тренеру. coach_id здесь НИКОГДА не очищается: истечение подписки
  // не отвязывает клиента, это осознанно. Не нашли тренера — начисляем пакет
  // как обычно, просто без привязки.
  if (accruePlan.plan === 'premium' && !accruePlan.coachId) {
    const trainerId = await resolveTrainerId(supabaseAdmin)
    if (!trainerId) {
      console.warn(`Prodamus webhook: тренер не найден, ПРЕМИУМ ${userId} начислен без привязки`)
    } else if (trainerId === userId) {
      // Тренер купил ПРЕМИУМ сам себе. У тренера coach_id пустой (см. App.jsx,
      // hasCoach) — ссылку на самого себя не ставим.
      console.log(`Prodamus webhook: ${userId} — сам тренер, привязка не нужна`)
    } else {
      updateFields.coach_id = trainerId
    }
  }

  // .select() возвращает строку ПОСЛЕ триггеров: если guard_profile_privileged
  // откатит coach_id, мы это увидим и не соврём в логе о привязке.
  const { data: updated, error: updErr } = await supabaseAdmin
    .from('profiles')
    .update(updateFields)
    .eq('id', userId)
    .select('coach_id')
    .maybeSingle()
  if (updErr) {
    // Платёж уже в журнале со статусом success — начисление можно будет
    // доиграть вручную по журналу. 200, чтобы Продамус не слал повторы.
    reportError('api:prodamus:grant', [`Prodamus webhook: платёж ${orderNum} записан, но НЕ удалось начислить пакет пользователю ${userId}:`, updErr], { message: `платёж записан, пакет НЕ начислен: ${updErr?.message}`, status: 500, userId: userId })
    return res.status(200).send('OK')
  }

  if (updateFields.coach_id) {
    if (updated?.coach_id === updateFields.coach_id) {
      console.log(`Prodamus webhook: ${userId} привязан к тренеру ${updateFields.coach_id}`)
    } else {
      // Пакет начислен, но привязка не легла — почти наверняка её срезал
      // триггер. Громко, чтобы не искать потом «почему клиент не появился».
      reportError('api:prodamus:coach', [`Prodamus webhook: coach_id для ${userId} НЕ записан (в базе ${updated?.coach_id ?? 'null'}) — проверь guard_profile_privileged`], { message: 'coach_id не записан — проверь guard_profile_privileged', userId: userId })
    }
  }

  console.log(`Prodamus webhook: пользователю ${userId} начислен ${accruePlan.plan} до ${newUntil}`)
  return res.status(200).send('OK')
}
