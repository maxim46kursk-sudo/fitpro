export const TEST_MODE = false      // true → показываем тестовые цены
export const TRIAL_DAYS = 5
export const TRIAL_LEVEL = 2        // пробный открывает уровень ПРОФИТ

export const PLANS = [
  { key:'start',  level:0, name:'СТАРТ',  price:0,    testPrice:0,  tagline:'Бесплатно',
    features:['Дневник тренировок','Рационы питания','Общий тоннаж','Аналитика питания за день и неделю','Первые 3 тренировки в каждом из 4 шаблонов','Библиотека упражнений'] },
  // hidden:true — пакет снят с продажи, но запись НЕ удаляем: у ранее купивших
  // (profiles.plan='base') planByKey('base') должен и дальше отдавать level:1, а
  // не схлопываться в PLANS[0] (СТАРТ) и обнулять им доступ. Из продажи выведен
  // фильтром по hidden на экране Тарифов (см. planTabs в App.jsx).
  { key:'base',   level:1, name:'БАЗА',   price:1000, testPrice:50, hidden:true, tagline:'Всё из СТАРТ, плюс:',
    features:['Все тренировки во всех шаблонах','Прогресс по упражнениям'] },
  { key:'profit', level:2, name:'ПРОФИТ', price:2990, oldPrice:4990, testPrice:60, highlight:true, tagline:'Всё из БАЗЫ, плюс:',
    features:['ИИ-ассистент по тренировкам и питанию'] },
  { key:'premium',level:3, name:'ПРЕМИУМ',price:9990, oldPrice:14990, testPrice:70, tagline:'Всё из ПРОФИТ, плюс:',
    features:['Персональная программа под тебя','Разбор и корректировка питания','Ежедневная проверка отчётов (видео подходов и питание)'] },
  // СЛУЖЕБНЫЙ ТАРИФ ДЛЯ ПРОВЕРКИ ЖИВОЙ ОПЛАТЫ.
  //
  // Зачем настоящий тариф, а не «тестовый режим»: платёж проходит по ТЕМ ЖЕ
  // рельсам, что боевые, — та же ссылка Продамуса, та же подпись, тот же
  // вебхук, то же начисление. Обходной путь проверял бы обходной путь;
  // сломаться же может именно то, что мы обошли.
  //
  // staff:true — виден ТОЛЬКО тренеру. Отдельный признак, а не hidden: у
  // hidden другой смысл — «снят с продажи, но у купивших должен продолжать
  // работать» (см. base выше). Тут наоборот: тариф живой и покупаемый, просто
  // не для клиентов. Скрытие есть и на клиенте (экран Тарифов), и на сервере
  // (api/create-payment.js отказывает не-тренеру): пилюля в интерфейсе — это
  // удобство, а не защита.
  //
  // days:1 — срок пакета. У остальных его нет, и они получают общее умолчание
  // PLAN_DAYS_DEFAULT: заводить поле каждому ради одного исключения незачем.
  // Срок живёт ЗДЕСЬ, рядом с ценой, а не отдельной веткой в вебхуке — тогда
  // код начисления остаётся один на все пакеты.
  //
  // level:2 — тот же уровень, что у ПРОФИТ: проверять надо и то, что доступ
  // действительно открывается.
  { key:'test50', level:2, name:'ТЕСТ 50', price:50, testPrice:50, staff:true, days:1,
    tagline:'Служебный тест оплаты, 50 ₽',
    features:['Проверка живой оплаты по боевым рельсам','Доступ уровня ПРОФИТ на 1 день'] },
]

// Срок пакета в днях. Одно число на все тарифы, кроме тех, у кого явно указан
// свой days. Экспортируется, потому что тем же правилом пользуется вебхук
// начисления (api/prodamus-webhook.js) — правило одно на клиент и сервер.
export const PLAN_DAYS_DEFAULT = 30
export function daysOfPlan(key){ return planByKey(key).days || PLAN_DAYS_DEFAULT }
export const VIP = { name:'VIP', desc:'Индивидуальные условия. Подробности — в личных сообщениях.' }

// Мастер-список возможностей приложения: min — уровень, с которого пункт
// открывается. Один источник для экрана Тарифов: на выбранном тарифе пункты с
// min <= level горят, остальные гаснут. У VIP горят все (см. VIP_LEVEL).
export const FEATURES = [
  { t:'Дневник тренировок и питания', min:0 },
  { t:'Рационы и аналитика питания', min:0 },
  { t:'Общий тоннаж', min:0 },
  { t:'Библиотека упражнений', min:0 },
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

// Какие тарифы показывать человеку с этой ролью.
//
// Два разных признака, и путать их нельзя:
//   hidden — снят с продажи. Не показываем НИКОМУ, включая тренера: покупать
//            его больше нельзя ни при каких обстоятельствах;
//   staff  — служебный. Живой и покупаемый, но только тренером.
//
// Функцией, а не выражением по месту: то же правило проверяется тестом, а
// список тарифов рисуется в одном месте интерфейса — разъехаться нечему.
export function visiblePlans(role){
  const isStaff = role === 'trainer'
  return PLANS.filter(p => !p.hidden && (!p.staff || isStaff))
}

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
