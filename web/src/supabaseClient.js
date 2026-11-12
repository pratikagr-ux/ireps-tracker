// Single Supabase client instance, shared by dataClient.js (lots/bookmarks
// queries) and the login screen in App.jsx (auth). VITE_SUPABASE_URL /
// VITE_SUPABASE_ANON_KEY are the project's public "anon"/"publishable" key
// — meant to be embedded in a client bundle (this app ships to public
// GitHub Pages). Row-Level Security on the `lots`/`bookmarks` tables, not
// this key, is what actually protects the data — see supabase/schema.sql.
//
// Set these in a local .env.local (gitignored) for `npm run dev`, and as
// repo secrets injected into the build step for the GitHub Pages deploy —
// see .github/workflows/deploy.yml.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.warn('[supabaseClient] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set — app cannot load data.');
}

export const supabase = (url && anonKey) ? createClient(url, anonKey) : null;
