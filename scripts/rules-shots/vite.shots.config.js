/**
 * Сборка страницы съёмки — боевой конфигурацией, как и у прогона персонажа.
 *
 * Наследуется от vite.config.js целиком: цель компиляции, формат воркера и
 * плагин React обязаны совпадать с тем, что уезжает людям, — иначе снимок
 * показывал бы другой код, чем тот, который они увидят.
 */
import { fileURLToPath } from 'node:url'
import { mergeConfig } from 'vite'
import base from '../../vite.config.js'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))

export default async (env) => {
  const resolved = typeof base === 'function' ? await base(env) : base
  return mergeConfig(resolved, {
    root: here('.'),
    base: './',
    build: {
      outDir: here('../../tools/.cache/rules-harness'),
      emptyOutDir: true,
      rollupOptions: { input: here('./harness.html') },
    },
  })
}
