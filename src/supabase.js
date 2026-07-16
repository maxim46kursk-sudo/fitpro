import { createClient } from '@supabase/supabase-js'
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://kybazlnscyzfrrafggxe.supabase.co'
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY || 'sb_publishable_8E9Baxz1q-rKOiV8-jbXtw_DIGOztMg'
// Явный storageKey (а не дефолтный, который supabase-js сам вычисляет из
// хоста) — чтобы код логаута (App.jsx) точно знал, какой ключ localStorage
// чистить руками, если signOut() не успеет сделать это сам (сетевой сбой).
export const SUPABASE_AUTH_STORAGE_KEY = 'sb-kybazlnscyzfrrafggxe-auth-token'
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storageKey: SUPABASE_AUTH_STORAGE_KEY },
})
