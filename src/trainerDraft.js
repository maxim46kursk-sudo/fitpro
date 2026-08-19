// НЕЗАВЕРШЁННАЯ ТРЕНИРОВКА ТРЕНЕРА — пометка в localStorage.
//
// Что было. Занятие пишется в базу по ходу дела: строка workouts заводится с
// первым добавленным упражнением, подходы — по потере фокуса, при уходе с экрана
// несохранённое досылается. Данные не терялись. Терялось СОСТОЯНИЕ: тренировка,
// из которой тренер вышел, не нажав «Завершить», ложилась в список «Мои записи»
// неотличимой от законченной. Вернуться в неё можно было только через
// «Изменить» — а это другой режим: секундомера нет, длительность занятия не
// пишется вовсе, тренер попадает в правку прошлой записи вместо продолжения.
//
// Сделано так же, как у клиента (WorkoutsView, ключ fitpro_active_workout):
// пометка живёт в localStorage и переживает перезагрузку страницы и закрытие
// приложения. Своей колонки в базе нет намеренно — она потребовала бы миграции
// на проде ради флага, а duration для этого не годится: у клиентских записей
// duration IS NULL уже означает «запись в дневник», а не «не завершено».
//
// Цена решения названа честно: с другого устройства пометки не видно. Сама
// тренировка при этом никуда не девается — она в базе и доступна через
// «Изменить». Теряется удобство, не данные.
//
// Файл держится чистым (никакого React) — его проверяет test-trainer-draft.mjs.

export const TRAINER_DRAFT_KEY = 'fitpro_trainer_session'

/** localStorage может отсутствовать (SSR, тесты) или бросать (приватный режим). */
function store() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * Пометка о незавершённом занятии.
 *
 * @typedef {{workoutId:number|string, clientId:string, name:string, date:string, startedAt:number}} TrainerDraft
 */

/** Прочитать пометку. Мусор и неполные записи считаются отсутствием пометки. */
export function readDraft() {
  const s = store()
  if (!s) return null
  let d
  try {
    const raw = s.getItem(TRAINER_DRAFT_KEY)
    if (!raw) return null
    d = JSON.parse(raw)
  } catch {
    // недоступное хранилище или мусор в нём — считаем, что пометки нет
    return null
  }
  // workoutId — единственное, без чего пометка бессмысленна: продолжать нечего.
  // clientId нужен, чтобы не показать чужую тренировку в карточке другого
  // клиента; startedAt — чтобы секундомер продолжил, а не начал заново.
  if (!d || typeof d !== 'object') return null
  if (d.workoutId == null || !d.clientId || !d.startedAt) return null
  return {
    workoutId: d.workoutId,
    clientId: String(d.clientId),
    name: String(d.name || 'Тренировка с тренером'),
    date: String(d.date || ''),
    startedAt: Number(d.startedAt) || 0,
  }
}

/** Поставить пометку. Незаполненная — не ставится вовсе, а не пишется битой. */
export function saveDraft(draft) {
  const s = store()
  if (!s) return false
  if (!draft || draft.workoutId == null || !draft.clientId || !draft.startedAt) return false
  try {
    s.setItem(TRAINER_DRAFT_KEY, JSON.stringify({
      workoutId: draft.workoutId,
      clientId: String(draft.clientId),
      name: String(draft.name || 'Тренировка с тренером'),
      date: String(draft.date || ''),
      startedAt: Number(draft.startedAt),
    }))
    return true
  } catch {
    return false
  }
}

/**
 * Снять пометку.
 *
 * С аргументом снимает ТОЛЬКО пометку этой тренировки. Иначе завершение старой
 * записи, открытой на правку, стирало бы пометку о другой — живой — тренировке,
 * и та переставала бы предлагать продолжение, оставшись незавершённой навсегда.
 */
export function clearDraft(workoutId) {
  const s = store()
  if (!s) return
  if (workoutId != null) {
    const cur = readDraft()
    if (!cur || String(cur.workoutId) !== String(workoutId)) return
  }
  try {
    s.removeItem(TRAINER_DRAFT_KEY)
  } catch {
    // приватный режим — пометку просто не снять, показ её переживёт перезаход
  }
}

/** Пометка этого клиента — или ничего. */
export function draftForClient(clientId) {
  const d = readDraft()
  if (!d || !clientId) return null
  return String(d.clientId) === String(clientId) ? d : null
}
