import { createClient } from '@supabase/supabase-js';
import { SUPABASE_KEY, SUPABASE_URL } from '../config';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  realtime: { params: { eventsPerSecond: 20 } },
});
export const hasBackend = SUPABASE_URL.length > 0 && SUPABASE_KEY.length > 0;
