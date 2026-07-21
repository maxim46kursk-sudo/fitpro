import Model from 'react-body-highlighter'

// Анатомическая карта: нейтральный силуэт тела с подсвеченной целевой мышцей
// (классика фитнес-приложений). Решает то, чего не было в иконочных наборах —
// ягодицы, грудь, плечи: библиотека умеет gluteal / chest / front-deltoids.
// SVG рисуется локально (пакет ~20 КБ), сеть не нужна.
//
// Кардио сюда не входит: это не мышечная группа, для неё оставлена иконка
// сердца (см. MUSCLE_ICONS в App.jsx).

// Наши группы → мышцы библиотеки + нужный ракурс (спина/ягодицы видны только сзади).
const MUSCLE_MAP = {
  'Грудь':    { muscles: ['chest'],                                type: 'anterior'  },
  'Спина':    { muscles: ['upper-back', 'lower-back', 'trapezius'], type: 'posterior' },
  'Ноги':     { muscles: ['quadriceps', 'calves'],                  type: 'anterior'  },
  'Ягодицы':  { muscles: ['gluteal'],                               type: 'posterior' },
  'Плечи':    { muscles: ['front-deltoids'],                        type: 'anterior'  },
  'Руки':     { muscles: ['biceps', 'triceps', 'forearm'],          type: 'anterior'  },
  'Кор':      { muscles: ['abs', 'obliques'],                       type: 'anterior'  },
  'Всё тело': { muscles: ['chest', 'abs', 'quadriceps', 'biceps', 'front-deltoids'], type: 'anterior' },
}

export const hasMuscleMap = (m) => !!MUSCLE_MAP[m]

// height — высота силуэта; ширину SVG держит по пропорции.
// bodyColor — невыделенное тело (нейтральный тёмный), highlightedColors — наш акцент.
export function MuscleMap({ m, height = 56, color = '#7C7AF0' }) {
  const cfg = MUSCLE_MAP[m]
  if (!cfg) return null
  return (
    <Model
      type={cfg.type}
      data={[{ name: m, muscles: cfg.muscles }]}
      bodyColor="#3A3A3E"
      highlightedColors={[color]}
      style={{ height, display: 'flex', justifyContent: 'center' }}
      svgStyle={{ height, width: 'auto' }}
    />
  )
}
