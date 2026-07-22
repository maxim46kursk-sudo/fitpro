import { createClient } from '@supabase/supabase-js'
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://api.fitproapp.ru'
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg0NzE0NTM5LCJleHAiOjE5NDIzOTQ1Mzl9.fKJZOQkyBX7sa0n0lbJ7xxGRsn5hcEyaX5ijl9P5404'
// Явный storageKey (а не дефолтный, который supabase-js вычисляет из хоста) —
// чтобы код логаута (App.jsx) точно знал, какой ключ localStorage чистить
// руками, если signOut() не успеет сделать это сам (сетевой сбой).
// Значение НЕ завязано на адрес бэкенда: при прошлом переезде оно менялось
// вместе с хостом, и все сессии молча инвалидировались.
export const SUPABASE_AUTH_STORAGE_KEY = 'fitpro-auth'
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storageKey: SUPABASE_AUTH_STORAGE_KEY },
})
