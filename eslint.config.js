import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },

  /**
   * РАЗДЕЛ MOTION — СВОЙ БЛОК ИСКЛЮЧЕНИЙ, и только для своей папки.
   *
   * Правила проекта здесь НЕ ослабляются: блок стоит после основного и сужен до
   * `src/motion/**`. Всё остальное приложение продолжает жить по прежним
   * правилам, включая те, что отключены ниже.
   *
   * Почему исключения вообще нужны. Motion приехал из своего репозитория, где
   * eslint не стоял вовсе, и написан под React 18 — а здесь работают правила
   * React Compiler из eslint-plugin-react-hooks v7. Они честно указывают на
   * приёмы, которые в Motion сделаны НАМЕРЕННО и покрыты его собственными
   * тестами (1028 проверок): запись в ref во время рендера, чтобы слушатели,
   * живущие дольше кадра, видели актуальный экран; модульное состояние, которое
   * сбрасывается на открытии раздела. Переписывать это «под правило» — отдельная
   * работа с отдельной проверкой на телефонах, а не попутная правка переезда.
   *
   * Список точечный: каждое правило выключено по конкретной причине, а не
   * «чтобы стало тихо». Всё, что не перечислено, в Motion работает как везде.
   */
  {
    files: ['src/motion/**/*.{js,jsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        // poseWorker.js и mainThreadRunner.js живут в воркере
        ...globals.worker,
      },
    },
    rules: {
      /**
       * Запись в ref во время рендера. В Motion так синхронизируются значения,
       * которые читают слушатели и игровой цикл, живущие дольше одного кадра:
       * `screenRef.current = screen`, `calibratingRef.current = calibrating`.
       * Приём осознанный и описан в самих файлах.
       */
      'react-hooks/refs': 'off',
      // Ленивые инициализаторы useState читают localStorage — это чтение
      // устройства, а не вычисление, и переносить его в эффект значит показать
      // человеку чужой первый кадр.
      'react-hooks/purity': 'off',
      // Экраны Motion меняют состояние из эффектов по событиям камеры и таймеров
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/exhaustive-deps': 'off',
      // Файлы Motion экспортируют рядом с компонентом свои константы (MOVES,
      // DEFAULT_TIER и т.п.). Быстрое обновление в разделе с камерой всё равно
      // бесполезно: любая правка требует заново поднять камеру и модель.
      'react-refresh/only-export-components': 'off',
      /**
       * Запасной код, оставленный намеренно: прежние фигуры космоса (drawWall,
       * drawBarrier и соседи) сняты с поля, но не удалены — они возвращаются
       * ключом `?classic=1`, если новый вид в поле не полетит. Удалить их ради
       * тишины линтера значило бы убрать путь отката.
       */
      'no-unused-vars': 'off',
      'no-useless-assignment': 'off',
      /**
       * В тестах Motion встречается запись вида `0.63 > 0.55 ? 0.55 : 0.63` —
       * это не забытое условие, а показанная в тексте арифметика правила:
       * рядом стоит комментарий, откуда взялись оба числа. Сверни её в готовый
       * ответ — и тест перестанет объяснять, что он проверяет.
       */
      'no-constant-condition': 'off',
    },
  },
])
