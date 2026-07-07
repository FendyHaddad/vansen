import { createClient } from '@supabase/supabase-js';
import { environment } from '../../../environments/environment';

/**
 * The ONLY direct Supabase surface on the client, and it is auth-only.
 * All data access goes through the api Edge Function (see ApiService).
 */
export const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);
