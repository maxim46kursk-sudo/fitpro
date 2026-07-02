import { createClient } from '@supabase/supabase-js'
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://kybazlnscyzfrrafggxe.supabase.co'
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY || 'sb_publishable_8E9Baxz1q-rKOiV8-jbXtw_DIGOztMg'
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
