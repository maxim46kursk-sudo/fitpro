import qs from 'qs'
import { createClient } from '@supabase/supabase-js'
import { createSignature, buildPaymentData, STAFF_PLANS, CHALLENGE_ITEM } from './_prodamus.js'
// Какой поток человеку — общее правило на клиент и обе платёжные ручки.
import { resolveSeasonFor } from './_challengeSeason.js'
import { rateLimit } from './_ratelimit.js'

// Статические ссылки Продамуса не могут нести наш идентификатор пользователя
// (Продамус подменяет order_id своим номером). Поэтому ссылку строим здесь:
// подписываем данными с userId в order_id и customer_extra тем же ключом и тем
// же алгоритмом, что уже принят на входящих уведомлениях (api/_prodamus.js).
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'

// Домен платёжной формы. Тот же, что в уведомлениях (raw.domain).
const PAYFORM_BASE = 'https://maximathlete.payform.ru/'

// Адрес возврата после оплаты больше не константа — он зависит от того, откуда
// человек платит (см. returnUrlFor/buildPaymentData в _prodamus.js).

// БАЗА снята с продажи — ручка отказывает на прямой запрос plan:'base', иначе
// пакет остаётся покупаемым в обход спрятанной пилюли на экране Тарифов.
//
// test50 — служебный тариф проверки оплаты. В списке покупаемых он есть, но
// ниже стоит проверка роли: спрятанная пилюля на экране Тарифов от прямого
// POST не защищает, а 50 ₽ за сутки ПРОФИТ — слишком дешёвый способ обойти
// прайс. Отсюда правило: скрытие в интерфейсе — удобство, отказ здесь — защита.
const PAID_PLANS = new Set(['profit', 'premium', 'test50'])

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  /**
   * ЗАСЛОН ДО ТОКЕНА — грубый и только по адресу: личности мы ещё не знаем.
   *
   * Сто двадцать в минуту — это полсотни человек из одной сети, каждый жмёт
   * «Участвовать» и разок промахивается. ЧЕМ ПЛАТИМ: с одного адреса можно
   * заставить сервер сто двадцать раз в минуту сходить в GoTrue за проверкой
   * токена. Это два запроса в секунду к своей же базе — заметно дешевле, чем
   * отказать одиннадцатому покупателю с офисного вайфая.
   */
  if (!rateLimit(req, res, { name: 'create-payment-ip', limit: 120 })) return

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const secret = process.env.PRODAMUS_SECRET_KEY
  if (!serviceRoleKey || !secret) {
    console.error('create-payment: не настроены SUPABASE_SERVICE_ROLE_KEY или PRODAMUS_SECRET_KEY')
    return res.status(500).json({ error: 'Сервер не настроен' })
  }

  // Личность — исключительно из подписанного токена, не из тела: иначе можно
  // было бы выписать ссылку с чужим userId в customer_extra.
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' })

  const supabaseAdmin = createClient(SUPABASE_URL, serviceRoleKey)
  const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token)
  if (authError || !authData?.user?.id) return res.status(401).json({ error: 'Требуется авторизация' })
  const userId = authData.user.id

  /**
   * НАСТОЯЩИЙ ЛИМИТ — ПО ЧЕЛОВЕКУ, и он ровно там, где надо: покупка это
   * редкое действие, десять ссылок в минуту одному человеку хватит на любое
   * количество передумываний. Здесь же он и защищает от перебора: подделать
   * ключ нельзя — он взят из подписанного токена, а не из тела запроса.
   */
  if (!rateLimit(req, res, { name: 'create-payment', limit: 10, subject: userId })) return

  const plan = req.body?.plan
  // Билет челленджа — не тариф: уровня доступа он не даёт и в PAID_PLANS его
  // нет. Покупает кто угодно из вошедших — но КАКОЙ поток ему достанется,
  // зависит от роли (см. resolveSeasonFor ниже).
  const isChallenge = plan === CHALLENGE_ITEM
  if (!isChallenge && !PAID_PLANS.has(plan)) return res.status(400).json({ error: 'Неизвестный пакет' })

  // ── РОЛЬ: ИЗ БАЗЫ, service_role-ключом, и только когда она нужна ───────────
  // Ни телу запроса, ни метаданным токена тут верить нельзя: и то и другое
  // клиент подставляет сам. От роли зависят ровно две вещи — доступ к
  // служебному тарифу и то, какой поток челленджа человеку положен. Боевым
  // пакетам она не нужна вовсе, и лишний запрос в профиль на каждой покупке
  // был бы платой за одну служебную кнопку.
  let role = null
  if (STAFF_PLANS.has(plan) || isChallenge) {
    const { data: me, error: roleErr } = await supabaseAdmin
      .from('profiles').select('role').eq('id', userId).maybeSingle()
    if (roleErr) {
      console.error(`create-payment: ошибка чтения роли ${userId}:`, roleErr)
      return res.status(500).json({ error: 'Не удалось проверить доступ' })
    }
    role = me?.role || null
  }

  // Цена билета — из потока, а не из константы: у каждого потока она своя
  // (challenge_seasons.price_rub). Заполняется в ветке билета ниже.
  let priceRub

  // Второй билет в тот же поток — это деньги, за которые человек ничего не
  // получит: challenge_enroll идемпотентна по user_id и вернёт ему прежний
  // номер, а оплата останется. Поэтому отказываем ДО выписки ссылки, пока
  // платить ещё не начали.
  //
  // ЖИВОГО ПОТОКА НЕТ — ССЫЛКУ БОЛЬШЕ НЕ ВЫПИСЫВАЕМ, и это перемена. Прежде
  // выписывали: цена билета была константой, а сезон могли открыть той же
  // минутой. Теперь цену объявляет сам поток, и без потока её просто неоткуда
  // взять — ссылка ушла бы на выдуманную сумму, которую вебхук потом не
  // сопоставит ни с чем. Отказ здесь честнее: человек не платит за то, чего
  // ещё нет.
  if (isChallenge) {
    /**
     * АНКЕТЫ ПЕРЕД ДЕНЬГАМИ БОЛЬШЕ НЕТ.
     *
     * Здесь стоял отказ 409 тому, у кого не заполнена дневная норма: питание —
     * половина зачёта, и человек без нормы играл бы половину. Довод верный, а
     * решение неверное: форма между человеком и кнопкой оплаты убивает продажу
     * вернее любой цены, и мы теряли не «неподготовленных», а покупателей.
     *
     * Правило никуда не делось — оно переехало ТУДА, ГДЕ ОНО РАБОТАЕТ. Данные о
     * себе просят после оплаты, в комнате участника: там человек уже свой, и
     * заполнение занимает минуту. А дни без нормы честно считаются нулём
     * (sql/2026-08-25_norm_freeze_on_start.sql) — цену промедления платит тот,
     * кто медлит, а не касса.
     */
    /**
     * КУДА ИМЕННО ПРОДАЁМ БИЛЕТ. Тренеру — служебный поток, если он есть; всем
     * остальным — открытый. Правило одно на всё приложение и живёт в
     * api/_challengeSeason.js: разъедься оно с экраном, человек увидел бы одну
     * цену, а заплатил другую.
     *
     * ЭТО И ЕСТЬ ЗАЩИТА СЛУЖЕБНОГО ПОТОКА ОТ ПРЯМОГО ЗАПРОСА. Скрытие в
     * интерфейсе — удобство; отказ здесь — защита. Постороннему служебный поток
     * не выбирается вовсе, поэтому и ссылки на 50 ₽ он не получит ни телом
     * запроса, ни ярлыком, ни как-либо ещё: сумму ставит сервер по выбранному
     * потоку, а не клиент.
     */
    const { season, error: seasonErr } = await resolveSeasonFor(supabaseAdmin, role)
    if (seasonErr) {
      console.error('create-payment: ошибка чтения сезонов челленджа:', seasonErr)
      return res.status(500).json({ error: 'Не удалось проверить участие' })
    }
    if (!season) {
      console.warn(`create-payment: ${userId} просит билет, но живого потока нет`)
      return res.status(409).json({
        error: 'Набор в поток пока закрыт — откроем и объявим',
        reason: 'no_season',
      })
    }
    priceRub = season.price_rub

    const { data: mine, error: entryErr } = await supabaseAdmin
      .from('challenge_entries').select('id').eq('user_id', userId).eq('season_id', season.id).limit(1)
    if (entryErr) {
      console.error(`create-payment: ошибка проверки участия ${userId}:`, entryErr)
      return res.status(500).json({ error: 'Не удалось проверить участие' })
    }
    if (mine?.length) {
      console.warn(`create-payment: ${userId} уже в потоке ${season.id}, второй билет не выписываем`)
      // reason важен: это ЕДИНСТВЕННЫЙ 409, который значит «всё в порядке» —
      // человек уже в потоке, и экрану надо не ругаться, а показать комнату.
      // Остальные 409 этой ручки — отказы (см. no_season выше).
      return res.status(409).json({
        error: 'Вы уже участвуете в этом потоке — второй билет покупать не нужно',
        reason: 'already',
      })
    }
  }

  // Служебный тариф — только тренеру (роль прочитана выше). Ответ намеренно тот
  // же, что на несуществующий пакет, — знать о служебном тарифе постороннему
  // незачем.
  if (STAFF_PLANS.has(plan) && role !== 'trainer') {
    console.warn(`create-payment: ${userId} просит служебный тариф ${plan}, но он не тренер`)
    return res.status(400).json({ error: 'Неизвестный пакет' })
  }

  // Откуда платят — только метка, не адрес: 'web' даёт возврат в приложение,
  // всё остальное (в том числе отсутствие поля) — прежнее поведение, ссылку на
  // бота. Разбор и защита — в returnUrlFor, там же объяснено, почему URL из
  // тела принимать нельзя.
  const source = req.body?.source

  // Цену и адрес возврата подставляет buildPaymentData — на сервере, не из
  // тела: сумму доверять клиенту нельзя (по ней вебхук определяет пакет), а
  // адрес возврата тем более.
  const data = buildPaymentData({ userId, plan, source, priceRub })

  // Подпись считается по данным, в которых адрес возврата УЖЕ подставлен —
  // иначе Продамус отклонит ссылку как неподписанную по этим полям.
  const signature = createSignature(data, secret)
  const url = PAYFORM_BASE + '?' + qs.stringify({ ...data, signature })

  return res.status(200).json({ url })
}
