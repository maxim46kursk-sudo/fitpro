export const TEST_MODE = true       // true → показываем тестовые цены
export const TRIAL_DAYS = 5
export const TRIAL_LEVEL = 2        // пробный открывает уровень ПРОФИТ

export const PLANS = [
  { key:'start',  level:0, name:'СТАРТ',  price:0,    testPrice:0,  tagline:'Бесплатно',
    features:['Дневник тренировок','Рационы питания','Общий тоннаж','Аналитика питания за день и неделю','Первые 3 тренировки в каждом из 4 шаблонов','Полная база упражнений'] },
  { key:'base',   level:1, name:'БАЗА',   price:1000, testPrice:50, tagline:'Всё из СТАРТ, плюс:',
    features:['Все тренировки во всех шаблонах','Прогресс по упражнениям'] },
  { key:'profit', level:2, name:'ПРОФИТ', price:2990, testPrice:60, highlight:true, tagline:'Всё из БАЗЫ, плюс:',
    features:['ИИ-ассистент по тренировкам и питанию'] },
  { key:'premium',level:3, name:'ПРЕМИУМ',price:9990, testPrice:70, tagline:'Всё из ПРОФИТ, плюс:',
    features:['Персональная программа под тебя','Разбор и корректировка питания','Ежедневная проверка отчётов (видео подходов и питание)'] },
]
export const VIP = { name:'VIP', desc:'Индивидуальные условия. Подробности — в личных сообщениях.' }

// Мастер-список возможностей приложения: min — уровень, с которого пункт
// открывается. Один источник для экрана Тарифов: на выбранном тарифе пункты с
// min <= level горят, остальные гаснут. У VIP горят все (см. VIP_LEVEL).
export const FEATURES = [
  { t:'Дневник тренировок и питания', min:0 },
  { t:'Рационы и аналитика питания', min:0 },
  { t:'Общий тоннаж', min:0 },
  { t:'Полная база упражнений', min:0 },
  // startOnly — строка осмысленна только на СТАРТ: выше её заменяет
  // «Доступ ко всем программам тренировок», и показывать обе разом нельзя.
  { t:'Первые 3 тренировки в каждой программе', min:0, startOnly:true },
  { t:'Доступ ко всем программам тренировок', min:1 },
  { t:'Прогресс по каждому упражнению', min:1 },
  { t:'ИИ-ассистент по тренировкам и питанию 24/7', min:2 },
  { t:'Персональная программа от тренера', min:3 },
  { t:'Разбор и корректировка питания под цель', min:3 },
  { t:'Ежедневная проверка отчётов (видео подходов)', min:3 },
]

// VIP выше всех пакетов — «уровень» нужен только для подсветки списка на
// экране Тарифов, в effectiveAccess и гейтах он не участвует (VIP не выдаётся
// через plan, это индивидуальная договорённость).
export const VIP_LEVEL = 99

export function planByKey(k){ return PLANS.find(p=>p.key===k) || PLANS[0] }
export function planByLevel(l){ return PLANS.find(p=>p.level===l) || PLANS[0] }
export function priceOf(p){ return TEST_MODE ? p.testPrice : p.price }

// Текущий доступ по профилю. now — Date.now(). Возвращает {level,label,until,isTrial,planKey}.
export function effectiveAccess(profile, now){
  now = now || Date.now()
  // Тренер (владелец) не упирается в собственные платные гейты: отдаём
  // максимальный уровень, все гейты считают по access.level и откроются сами.
  // Зеркало серверной проверки в api/_access.js — правь оба файла.
  if (profile?.role === 'trainer')
    return { level:3, label:'Тренер', until:null, isTrial:false, planKey:'premium' }
  const paidActive  = profile?.plan_until  && new Date(profile.plan_until).getTime()  > now
  const paidLevel   = paidActive ? planByKey(profile.plan).level : 0
  const trialActive = profile?.trial_until && new Date(profile.trial_until).getTime() > now
  const trialLevel  = trialActive ? TRIAL_LEVEL : 0
  const level = Math.max(0, paidLevel, trialLevel)
  if (trialActive && trialLevel >= paidLevel)
    return { level, label:'Пробный период', until:profile.trial_until, isTrial:true, planKey:planByLevel(level).key }
  if (paidActive)
    return { level, label:planByKey(profile.plan).name, until:profile.plan_until, isTrial:false, planKey:profile.plan }
  return { level:0, label:'СТАРТ (бесплатный)', until:null, isTrial:false, planKey:'start' }
}
