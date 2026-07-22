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
