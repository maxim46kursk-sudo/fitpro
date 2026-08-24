import { supabase } from './supabase.js'

/**
 * УЧАСТНИК ПОТОКА ИЛИ НЕТ — единственный источник правды на клиенте.
 *
 * Зачем отдельный файл. Ответ на этот вопрос нужен в трёх разных местах:
 * экрану челленджа (что показать — цену или номер участника), выбору уровня
 * (открыты ли дни после пятого) и правилам зачёта (счётчик попыток видит
 * только участник). Посчитай его каждый из них сам — и они разойдутся: один
 * успеет прочитать базу, другой нет, и человек увидит на одном экране, что он
 * участник, а на соседнем, что нет.
 *
 * ЧИТАЕМ БАЗУ НАПРЯМУЮ, без ручки в api/. RLS уже описывает ровно то, что тут
 * нужно (sql/2026-08-24_challenge_seasons.sql): сезоны, кроме черновиков, видны
 * всем вошедшим, а из записей человеку видна только своя. Серверная ручка
 * повторила бы эти же два правила третьим местом, где они могут разъехаться.
 *
 * ОДИН ЗАПРОС НА ВХОД В РАЗДЕЛ. Сезон и своя запись в нём приезжают вместе,
 * вложением: два отдельных запроса означали бы промежуточное состояние «сезон
 * уже знаю, про себя ещё нет», в котором экран успел бы нарисовать цену
 * человеку, который давно оплатил. Результат живёт в памяти модуля: пока
 * вкладка открыта, участие не меняется само по себе — оно меняется покупкой, и
 * покупка сама просит перечитать.
 *
 * ГОСТЬ — ВСЕГДА НЕ УЧАСТНИК И БЕЗ ЗАПРОСА. У него нет ни токена, ни строки в
 * базе; запрос вернул бы пустоту, но стоил бы задержки на входе в раздел.
 *
 * ЗАПРОС НЕ УДАЛСЯ — ТОЖЕ НЕ УЧАСТНИК, И ЭТО НЕ ОШИБКА ЭКРАНА. Сеть отвалилась
 * в метро — человек увидит обычные пять бесплатных дней, а не заставку с
 * извинениями. Хуже всего здесь был бы третий вариант: пустить в челлендж «на
 * всякий случай», потому что база не ответила.
 */

/** Сезоны, в которых человек может состоять участником прямо сейчас. */
const LIVE_STATUSES = ['open', 'running']

/**
 * ЦЕНА БИЛЕТА ДЛЯ ВИТРИНЫ, пока живого потока нет.
 *
 * Настоящую цену объявляет сезон (challenge_seasons.price_rub), и как только он
 * есть — берётся она. Но правила читают и до открытия набора, а экран, который
 * в этот момент говорит «Участвовать — 0 ₽», выглядит поломкой. Деньги по этому
 * числу не берутся ни при каких условиях: цену платежа ставит сервер
 * (api/_prodamus.js), клиенту в этом месте не верят вовсе.
 */
export const CHALLENGE_PRICE = 2990

/**
 * undefined — ещё не читали, null — читали и участия нет (или сезона нет
 * вовсе), объект — сезон и, возможно, своя запись в нём.
 */
let state
/** Запрос в полёте: два экрана, открытые подряд, не должны спрашивать дважды. */
let pending = null

/**
 * ДНЕВНАЯ НОРМА ЧЕЛОВЕКА — вторым запросом, параллельно сезону.
 *
 * Вложением её не взять: food_goals с сезонами не связана и связываться не
 * должна — норма живёт у человека, а не у потока. Зато запрос уходит вместе с
 * первым и ничего не задерживает, а знать её экрану необходимо: без нормы
 * билет не продаётся (api/create-payment.js), и говорить об этом надо ДО
 * нажатия, а не отказом после.
 */
async function readGoals() {
  const { data, error } = await supabase
    .from('food_goals')
    .select('kcal, p, c, f')
    .maybeSingle()
  if (error) throw error
  return data || null
}

async function readState() {
  const { data, error } = await supabase
    .from('challenge_seasons')
    .select(
      'id, title, starts_on, price_rub, prize_pct, prize_split, status,'
      + ' challenge_entries (id, participant_no, display_name, paid_at, rules_accepted_at),'
      + ' challenge_rules_consent (accepted_at)',
    )
    .in('status', LIVE_STATUSES)
    .order('id')
  if (error) throw error

  const rows = Array.isArray(data) ? data : []
  if (!rows.length) return null
  const goals = await readGoals()

  /**
   * Сезон, в котором человек уже состоит, важнее просто открытого: пока идёт
   * его поток, набор в следующий может быть уже открыт, и показать ему цену
   * нового билета вместо собственного номера было бы обманом.
   */
  const withEntry = rows.find((row) => row.challenge_entries?.length)
  const row = withEntry || rows.find((r) => r.status === 'open') || rows[0]
  const { challenge_entries: entries, challenge_rules_consent: consent, ...season } = row
  return {
    season,
    entry: entries?.[0] || null,
    /**
     * Когда человек согласился с правилами ЭТОГО потока. NULL — ещё не читал:
     * правила ему покажут до вступления и обязательно до конца. У участника
     * согласие обычно есть и в самой записи (rules_accepted_at) — это копия на
     * момент зачисления; здесь берём ту, что старше и первичнее.
     */
    rulesAcceptedAt: consent?.[0]?.accepted_at || entries?.[0]?.rules_accepted_at || null,
    /**
     * Норма питания человека на сейчас. Нужна ровно для одного вопроса: можно
     * ли ему вообще продавать билет. Зачёт считается не по ней, а по слепку,
     * снятому при вступлении (challenge_entries.norm1/norm2).
     */
    goals,
  }
}

/**
 * Прочитать участие. Один запрос на раздел; повторные вызовы отдают то же
 * самое из памяти.
 *
 * @param {{guest?: boolean, force?: boolean}} [opts] force — перечитать после
 *   покупки: до неё человек не участник, после — участник, и это единственный
 *   момент, когда ответ меняется под ногами.
 * @returns {Promise<{season: object, entry: object|null}|null>}
 */
export async function loadChallengeState({ guest = false, force = false } = {}) {
  if (guest) {
    state = null
    return null
  }
  if (state !== undefined && !force) return state
  if (!pending || force) {
    pending = readState()
      .catch((e) => {
        // Не участник — но и не ошибка экрана: см. заголовок файла.
        console.warn('challenge: не удалось прочитать сезон', e?.message || e)
        return null
      })
      .then((value) => {
        state = value
        pending = null
        return value
      })
  }
  return pending
}

/** Что уже прочитано, без запроса. До первого чтения — null. */
export const challengeState = () => (state === undefined ? null : state)

/** Участник ли человек: есть своя запись в живом сезоне. */
export const isChallengeMember = (value = challengeState()) => !!value?.entry

/** Читал ли человек правила этого потока и согласился ли с ними. */
export const hasAcceptedRules = (value = challengeState()) => !!value?.rulesAcceptedAt

/**
 * Есть ли у человека дневная норма. Ноль калорий — это «нормы нет»: строка в
 * food_goals заводится и пустой, и считать по ней нечего.
 */
export const hasNorm = (value = challengeState()) => Number(value?.goals?.kcal) > 0

/**
 * СЫРЬЁ ПО ПИТАНИЮ ЗА ПОТОК. Тридцать строк: съеденное за день, число разных
 * приёмов пищи и норма, по которой день судится. Процентов тут нет и не будет —
 * их считает src/challengeNutrition.js, один судья на приложение, тесты и
 * будущий рейтинг.
 *
 * @returns {Promise<object[]>} пустой массив, если спросить не удалось
 */
export async function loadNutritionFacts(seasonId) {
  if (!seasonId) return []
  try {
    const { data, error } = await supabase.rpc('challenge_nutrition_facts', { p_season_id: seasonId })
    if (error) throw error
    return Array.isArray(data) ? data : []
  } catch (e) {
    console.warn('challenge: не удалось прочитать питание', e?.message || e)
    return []
  }
}

/**
 * ТАБЛИЦА ПОТОКА — сырьё по всем участникам (challenge_standings).
 *
 * Мест и процентов тут нет: считает их src/challengeStandings.js. Читать может
 * только участник этого потока — посторонний получает отказ, и это правильно:
 * пустая таблица читалась бы как «в потоке никого».
 *
 * @returns {Promise<object[]>} пустой массив, если спросить не удалось
 */
export async function loadStandings(seasonId) {
  if (!seasonId) return []
  try {
    const { data, error } = await supabase.rpc('challenge_standings', { p_season_id: seasonId })
    if (error) throw error
    return Array.isArray(data) ? data : []
  } catch (e) {
    console.warn('challenge: не удалось прочитать таблицу потока', e?.message || e)
    return []
  }
}

/**
 * ЗАМОРОЗИТЬ НОРМУ. Зовётся при открытии челленджа участником и ничего не
 * решает сама: какой сегодня день потока и пора ли снимать второй слепок,
 * считает база (sql/2026-08-25_challenge_nutrition.sql). Идемпотентна — уже
 * снятый слепок не переписывается никогда.
 */
export async function freezeNorm(seasonId) {
  if (!seasonId) return null
  try {
    const { data, error } = await supabase.rpc('challenge_freeze_norm', { p_season_id: seasonId })
    if (error) throw error
    return data || null
  } catch (e) {
    console.warn('challenge: не удалось заморозить норму', e?.message || e)
    return null
  }
}

/**
 * ЗАФИКСИРОВАТЬ СОГЛАСИЕ С ПРАВИЛАМИ — в базе, а не в браузере.
 *
 * Спор о призах упирается в «я не знал правил», и ответ на это обязан лежать
 * там, куда участник не дотянется: галочка в localStorage живёт до первой
 * очистки кэша и только на одном телефоне. Пишет человек сам, своей строкой под
 * своим auth.uid() — RLS другого user_id не пропустит, а переписать или удалить
 * уже данное согласие не даёт отсутствие политик на update и delete
 * (sql/2026-08-24_challenge_rules.sql).
 *
 * Повторное согласие не переписывает первое: важна ПЕРВАЯ дата, та, что была до
 * покупки. Уникальность (season_id, user_id) её и стережёт, а 23505 здесь не
 * ошибка, а «уже согласился».
 *
 * @returns {Promise<{ok?: true, error?: string}>}
 */
export async function acceptRules(seasonId) {
  if (!seasonId) return { error: 'нет потока, с правилами которого соглашаться' }
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const userId = session?.user?.id
    if (!userId) throw new Error('нет активной сессии, перезайди в приложение')

    const { error } = await supabase
      .from('challenge_rules_consent')
      .insert({ season_id: seasonId, user_id: userId })
    // 23505 — согласие уже стоит. Это удача, а не сбой: человек мог прочитать
    // правила на телефоне и нажать «согласен» ещё раз с компьютера.
    if (error && error.code !== '23505') throw error

    await loadChallengeState({ force: true })
    return { ok: true }
  } catch (e) {
    console.error('challenge: не удалось записать согласие с правилами', e)
    return { error: e?.message || 'не удалось записать согласие' }
  }
}

/**
 * Забыть прочитанное. Нужно на выходе из аккаунта (следующий человек за тем же
 * экраном — уже другой) и тестам.
 */
export function resetChallengeState() {
  state = undefined
  pending = null
}

/**
 * КУПИТЬ БИЛЕТ — та же дорога, что у тарифов: ссылку Продамуса строит сервер
 * (api/create-payment.js), потому что статическая ссылка не может нести наш
 * userId, а подписывать её ключом на клиенте нельзя.
 *
 * ПУСТАЯ ВКЛАДКА ОТКРЫВАЕТСЯ ПЕРВОЙ СТРОКОЙ, до единого await. Это не
 * стилистика: жест пользователя «тратится» на первом же ожидании, и window.open
 * после двух запросов Safari с мобильным Chrome блокируют как всплывающее окно.
 * Человек нажимает «Купить билет», и не происходит ровно ничего. Поэтому вкладку
 * держим заранее и подставляем в неё адрес, когда сервер ответит.
 *
 * 409 — «уже участник». Не ошибка: так отвечает сервер тому, кто уже в потоке
 * (второй билет ему не нужен), и экран на это перечитывает своё состояние.
 *
 * @returns {Promise<{ok?: true, already?: true, error?: string}>}
 */
export async function buyTicket() {
  const tg = globalThis.Telegram?.WebApp
  const inTelegram = !!tg?.initData
  // 'noopener' здесь передавать НЕЛЬЗЯ: с ним window.open возвращает null, и
  // ссылки на вкладку не остаётся. Связь рвём через opener = null ниже.
  const win = inTelegram ? null : globalThis.open?.('about:blank', '_blank') || null
  const closeWin = () => {
    try { win?.close() } catch { /* уже закрыта человеком */ }
  }

  try {
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token
    if (!token) throw new Error('нет активной сессии, перезайди в приложение')

    const res = await fetch('/api/create-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      // source — МЕТКА, а не адрес: сервер подписывает адрес возврата своим
      // ключом, и принимать URL из тела было бы открытым редиректом.
      body: JSON.stringify({ plan: 'challenge', source: inTelegram ? 'telegram' : 'web' }),
    })
    const body = await res.json().catch(() => ({}))

    if (res.status === 409) {
      closeWin()
      return { already: true }
    }
    if (!res.ok || !body?.url) throw new Error(body?.error || `сервер вернул ${res.status}`)

    if (inTelegram) tg.openLink(body.url)
    else if (win) {
      try { win.opener = null } catch { /* кросс-origin ещё не наступил */ }
      win.location.replace(body.url)
    } else {
      // Вкладку заблокировали жёсткие настройки браузера — уходим на оплату в
      // текущей. Хуже новой вкладки, но несравнимо лучше молчания: Продамус
      // вернёт человека обратно.
      globalThis.location.assign(body.url)
    }
    return { ok: true }
  } catch (e) {
    closeWin()
    console.error('challenge: не удалось открыть оплату', e)
    return { error: e?.message || 'не удалось открыть оплату' }
  }
}
