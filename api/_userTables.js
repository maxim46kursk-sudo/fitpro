// Единый перечень «таблица → столбец пользователя» для api/delete-account.js
// (удаление по 152-ФЗ) и api/export-data.js (выгрузка по 152-ФЗ). Списки
// обязаны совпадать: если удаление знает про таблицу, а выгрузка нет (или
// наоборот) — пользователь получит неполный ответ на законный запрос. Новая
// таблица с персональными данными добавляется СЮДА, и оба эндпоинта
// подхватывают её сами.
//
// Имя файла начинается с подчёркивания намеренно: Vercel не превращает такие
// файлы внутри api/ в отдельные эндпоинты, они остаются просто модулями.

// Порядок ВАЖЕН для удаления. Почти все внешние ключи на auth.users объявлены
// как NO ACTION, поэтому auth.admin.deleteUser() откажется удалять аккаунт,
// пока в public остаётся хоть одна его строка. Внутри public есть и свои связи
// (constructor_sets → constructor_exercises, workout_sets → workouts), так что
// дочерние таблицы идут раньше родительских.
export const USER_TABLES = [
  { table: 'constructor_sets',      column: 'user_id' },
  { table: 'constructor_exercises', column: 'user_id' },
  { table: 'workout_sets',          column: 'user_id' },
  { table: 'workouts',              column: 'user_id' },
  // Служебный журнал отправленных напоминаний (api/send-reminders.js). Внешнего
  // ключа на auth.users нет, удалению аккаунта он не мешает, но это данные
  // пользователя — чистим вместе с остальным.
  { table: 'notification_log',      column: 'user_id' },
  // Технический журнал ошибок приложения (src/logError.js). Персональных данных
  // не содержит, но user_id есть — значит это данные пользователя. Внешний ключ
  // на auth.users здесь NO ACTION, поэтому строка обязана удаляться до
  // auth.admin.deleteUser(): весь USER_TABLES чистится раньше profiles и раньше
  // самого auth-пользователя, так что место в списке подходит любое.
  { table: 'error_log',             column: 'user_id' },
  // Ссылки доступа клиента, которого завёл тренер (sql/2026-08-04_client_access.sql).
  // Открытых токенов тут нет, только sha256-хэши, но строки привязаны к user_id —
  // значит это данные пользователя. Внешний ключ user_id → auth.users объявлен
  // с ON DELETE CASCADE, то есть удалению аккаунта он не мешает; чистим явно,
  // чтобы выгрузка и удаление знали про таблицу одинаково. Столбец trainer_id
  // (NO ACTION) закрывается тем же удалением строк клиента.
  { table: 'client_access_tokens',  column: 'user_id' },
  // Посуточный счётчик расхода ИИ-возможностей (sql/2026-08-05_feature_usage.sql).
  // Персональных данных не содержит — только «пользователь X разобрал N этикеток
  // такого-то числа», — но user_id есть, значит по правилу этого файла место ему
  // здесь. Внешний ключ объявлен с ON DELETE CASCADE, то есть удалению аккаунта
  // строки не мешают; чистим явно, чтобы выгрузка и удаление знали про таблицу
  // одинаково. Соседний ai_usage в списке отсутствует — это давняя недоделка,
  // а не образец для подражания.
  { table: 'feature_usage',         column: 'user_id' },
  { table: 'planned_workouts',      column: 'user_id' },
  { table: 'chat_messages',         column: 'user_id' },
  { table: 'food_diary',            column: 'user_id' },
  { table: 'food_goals',            column: 'user_id' },
  { table: 'measurements',          column: 'user_id' },
  { table: 'custom_exercises',      column: 'user_id' },
  { table: 'training_survey',       column: 'user_id' },
  { table: 'workout_templates',     column: 'user_id' },
  // trainer_clients: колонки клиента в схеме нет вообще — только trainer_id и
  // текстовое name. «Сторона клиента» здесь физически отсутствует, строки
  // этого списка принадлежат тренеру.
  { table: 'trainer_clients',       column: 'trainer_id' },
]

// Таблицы, связанные с пользователем с ДВУХ сторон: он может быть и клиентом,
// и тренером, обе стороны ссылаются на auth.users.
export const TWO_SIDED_TABLES = [
  { table: 'assigned_programs', columns: ['client_id', 'trainer_id'] },
]

// Профиль стоит особняком: при удалении идёт последним среди public (на него
// ссылается coach_id других пользователей), при выгрузке это один объект,
// а не массив.
export const PROFILE_TABLE = { table: 'profiles', column: 'id' }

// PostgREST-фильтр «любая из сторон равна пользователю» — общий для удаления
// и выгрузки, чтобы условие не разъехалось между эндпоинтами.
export const twoSidedFilter = (columns, userId) =>
  columns.map(c => `${c}.eq.${userId}`).join(',')
