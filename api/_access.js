// Уровни доступа для серверных функций. Дублирует логику effectiveAccess из
// src/plans.js БЕЗ UI-части (label, until, isTrial) — намеренно: импорт из src/
// в api/ рискует не разрешиться при сборке функции на Vercel, а сломанный
// деплой дороже дублирования нескольких строк.
//
// !!! При изменении набора пакетов или TRIAL_LEVEL правь ОБА файла:
// src/plans.js (что видит пользователь) и этот (что реально пускает сервер).
//
// Имя файла с подчёркиванием — Vercel не делает из таких файлов эндпоинты.

export const PLAN_LEVELS = { start: 0, base: 1, profit: 2, premium: 3 }
export const TRIAL_LEVEL = 2   // пробный открывает уровень ПРОФИТ

// Текущий уровень по строке profiles. Возвращает число 0..3.
// Просроченные plan_until/trial_until не считаются: уровень падает обратно в 0.
export function effectiveLevel(profile, now) {
  // Тренер (владелец) — максимальный уровень в обход тарифа. Зеркало раннего
  // выхода в effectiveAccess (src/plans.js). Требует, чтобы вызывающий код
  // ВЫБРАЛ поле role из profiles — иначе тренер молча поедет по plan/trial.
  if (profile?.role === 'trainer') return 3
  now = now || Date.now()
  const paidActive = profile?.plan_until && new Date(profile.plan_until).getTime() > now
  const paidLevel = paidActive ? (PLAN_LEVELS[profile.plan] ?? 0) : 0
  const trialActive = profile?.trial_until && new Date(profile.trial_until).getTime() > now
  const trialLevel = trialActive ? TRIAL_LEVEL : 0
  return Math.max(0, paidLevel, trialLevel)
}

// Уровень, с которого открыт ИИ-ассистент (ПРОФИТ).
export const AI_MIN_LEVEL = 2
