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
export const PAY_LINKS = { base:null, profit:null, premium:null } // Фаза B: сюда вставим ссылки Продамуса

export function planByKey(k){ return PLANS.find(p=>p.key===k) || PLANS[0] }
export function planByLevel(l){ return PLANS.find(p=>p.level===l) || PLANS[0] }
export function priceOf(p){ return TEST_MODE ? p.testPrice : p.price }

// Текущий доступ по профилю. now — Date.now(). Возвращает {level,label,until,isTrial,planKey}.
export function effectiveAccess(profile, now){
  now = now || Date.now()
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
