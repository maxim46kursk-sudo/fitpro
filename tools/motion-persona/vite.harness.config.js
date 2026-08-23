/**
 * СБОРКА СТРАНИЦЫ ПРОГОНА — той же конфигурацией, что и боевая.
 *
 * Наследуется от `vite.config.js` целиком и меняет ровно три вещи: точку входа,
 * куда класть результат и базовый путь. Всё, что влияет на то, КАК выполняется
 * код, — цель компиляции (es2019/safari14), формат воркера (`es`, без него
 * MediaPipe не поднимается в WebKit), плагин React — остаётся общим.
 *
 * Собственная копия настроек была бы ошибкой: разойдись она с боевой хоть в
 * цели компиляции, прогон мерил бы другой код, чем тот, который у людей.
 */
import { fileURLToPath } from 'node:url'
import { mergeConfig } from 'vite'
import base from '../../vite.config.js'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))

export default async (env) => {
  const resolved = typeof base === 'function' ? await base(env) : base
  return mergeConfig(resolved, {
    /**
     * Корень — папка прогона, а не проекта: иначе собранная страница ложится в
     * `harness-dist/tools/motion-persona/harness.html`, повторяя путь входа, и
     * сервер прогона ищет её не там. Исходники приложения при этом берутся по
     * относительным путям (`../../src/motion/...`) и никуда не переезжают.
     */
    root: here('.'),
    // относительный базовый путь: страница поднимается простым файловым
    // сервером прогона, а не Vercel'ом с его корнем
    base: './',
    build: {
      outDir: here('../.cache/harness-dist'),
      emptyOutDir: true,
      rollupOptions: {
        input: here('./harness.html'),
      },
    },
  })
}
