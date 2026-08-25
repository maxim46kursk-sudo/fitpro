/**
 * КАКОЙ ПОТОК ЧЕЛЛЕНДЖА ПОКАЗАТЬ ЧЕЛОВЕКУ И В КАКОЙ ЕГО ЗАЧИСЛЯТЬ.
 *
 * Правило одно на всё приложение и живёт ЗДЕСЬ ЦЕЛИКОМ. Спрашивают его в
 * четырёх местах: экран челленджа (что показать — цену или номер участника),
 * выписка платёжной ссылки (api/create-payment.js — на какую сумму), вебхук
 * (api/prodamus-webhook.js — куда зачислять и какая цена билета считается
 * совпавшей) и тесты. Посчитай его каждый сам — и однажды ссылка выпишется на
 * цену одного потока, а зачисление уйдёт в другой.
 *
 * Файл лежит в api/ и с подчёркиванием (Vercel не делает из таких эндпоинт), но
 * его импортирует и клиент (src/challengeSeason.js). Поэтому здесь НЕТ и не
 * должно появиться ни одного импорта: ни node:*, ни supabase-клиента, ни
 * ничего, чего нет в браузере. Функция, работающая с базой, ниже — она
 * получает уже готовый клиент параметром и в браузерную сборку не попадает.
 *
 * САМО ПРАВИЛО:
 *   тренер  → служебный поток, если он есть, иначе открытый;
 *   человек → только open/running, служебного для него не существует.
 *
 * И над обоими — поток, в котором человек УЖЕ состоит: пока идёт его поток,
 * набор в следующий может быть уже открыт, и показать ему цену нового билета
 * вместо собственного номера было бы обманом.
 */

/** Служебный поток: живой и покупаемый, но только тренером. */
export const STAFF_STATUS = 'staff'

/** Состояния, в которых поток можно увидеть участником и купить в него билет. */
export const LIVE_STATUSES = ['open', 'running', STAFF_STATUS]

/**
 * Кому вообще существует служебный поток. Роль, а не флаг из тела запроса:
 * роль читается из базы под auth.uid(), и подставить её клиент не может.
 */
export const seesStaffSeason = (role) => role === 'trainer'

/**
 * Выбрать поток из уже прочитанных строк. Чистая функция — ничего не читает и
 * ничего не решает про права; кому положен служебный, ей говорят параметром.
 *
 * ДВА ВЫЗЫВАЮЩИХ И ПОЧЕМУ У НИХ РАЗНЫЙ staffAllowed.
 *   Клиент читает базу своим ключом, и служебный поток ему не отдаст RLS
 *   (sql/2026-08-25_challenge_staff_season.sql): раз строка приехала — человек
 *   тренер, и передавать true честно.
 *   Сервер читает service_role-ключом, который RLS не касается: там приезжает
 *   ВСЁ, и решение принимается по роли из profiles.
 *
 * @param {object[]} rows строки challenge_seasons, по возрастанию id
 * @param {{staffAllowed?: boolean, hasEntry?: (row: object) => boolean}} [opts]
 * @returns {object|null}
 */
export function pickSeason(rows, { staffAllowed = false, hasEntry = () => false } = {}) {
  const live = (Array.isArray(rows) ? rows : []).filter(
    (row) => LIVE_STATUSES.includes(row?.status) && (row.status !== STAFF_STATUS || staffAllowed),
  )
  if (!live.length) return null
  // Порядок важен и читается сверху вниз: свой поток → служебный → открытый →
  // первый живой (это running, когда открытого набора нет вовсе).
  return live.find(hasEntry)
      || live.find((row) => row.status === STAFF_STATUS)
      || live.find((row) => row.status === 'open')
      || live[0]
}

/**
 * ТОТ ЖЕ ВЫБОР, НО С ЧТЕНИЕМ БАЗЫ — для серверных ручек.
 *
 * Читает service_role-клиентом (RLS не участвует, поэтому служебный поток
 * отсекает не база, а seesStaffSeason по роли) и возвращает ровно один поток —
 * тот, в котором человеку положено участвовать прямо сейчас.
 *
 * Ошибку чтения НЕ проглатывает и в null не превращает: «сезона нет» и «базу не
 * спросили» — разные события, и вебхук отвечает на них по-разному (тревога
 * против записи в журнал).
 *
 * @returns {Promise<{season: object|null, error: object|null}>}
 */
export async function resolveSeasonFor(supabaseAdmin, role) {
  const { data, error } = await supabaseAdmin
    .from('challenge_seasons')
    .select('id, title, status, price_rub, starts_on')
    .in('status', LIVE_STATUSES)
    .order('id')
  if (error) return { season: null, error }
  return { season: pickSeason(data, { staffAllowed: seesStaffSeason(role) }), error: null }
}
