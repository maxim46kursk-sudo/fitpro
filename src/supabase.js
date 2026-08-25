import { createClient } from '@supabase/supabase-js'
// Экспортируются намеренно: есть один путь, где обычный клиент не годится, —
// досохранение программы в момент закрытия страницы (App.jsx, ProgramEditor).
// supabase-js не умеет fetch с keepalive, поэтому тот запрос собирается руками
// и обязан идти НА ТОТ ЖЕ адрес с тем же публичным ключом, что и всё остальное,
// а не на свою копию значений.
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
export const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg0NzE0NTM5LCJleHAiOjE5NDIzOTQ1Mzl9.fKJZOQkyBX7sa0n0lbJ7xxGRsn5hcEyaX5ijl9P5404'
// Явный storageKey (а не дефолтный, который supabase-js вычисляет из хоста) —
// чтобы код логаута (App.jsx) точно знал, какой ключ localStorage чистить
// руками, если signOut() не успеет сделать это сам (сетевой сбой).
// Значение НЕ завязано на адрес бэкенда: при прошлом переезде оно менялось
// вместе с хостом, и все сессии молча инвалидировались.
export const SUPABASE_AUTH_STORAGE_KEY = 'fitpro-auth'
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storageKey: SUPABASE_AUTH_STORAGE_KEY },
  global: {
    /**
     * МЕТКА `data` ДЛЯ СТОРОЖА ЗАГРУЗКИ (index.html).
     *
     * Ставится на ПЕРВОМ ответе базы — любом: сторожу важно не что именно
     * ответили, а что канал живой. Приложение, которое смонтировалось и молча
     * ждёт базу, для человека выглядит так же, как не запустившееся, и
     * различать их надо здесь.
     *
     * Обёртка вокруг fetch, а не подписка: у supabase-js нет события «первый
     * ответ», а весь его обмен идёт через эту функцию — значит она и есть то
     * единственное место, мимо которого не пройти.
     */
    fetch: (...args) => globalThis.fetch(...args).then((res) => {
      globalThis.__bootStage?.('data')
      return res
    }),
  },
})
