// Thin wrapper over supabase-js for the queries App.jsx needs. Keeping this
// separate from App.jsx mirrors Upkaran ERP's db.js/App.jsx split.
import { supabase } from './supabaseClient.js';

export function hasBackend() {
  return !!supabase;
}

// ── Auth ─────────────────────────────────────────────────────────────────
export async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signUp(email, password) {
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data?.session || null;
}

export function onAuthChange(cb) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session));
  return () => data.subscription.unsubscribe();
}

// IREPS itself surfaces a couple of non-real "railway" values on its own
// site -- "IREPS" and "IREPS-TESTING" -- for its own sandbox/test unit, not
// an actual zone. No genuine lot ever carries either value (and MSTC/Matex
// never populate `railway` at all), so excluding them is safe everywhere
// lots are read, not just on the Lots tab.
const FAKE_RAILWAYS = '(IREPS-TESTING,IREPS)';
function excludeTestRailways(q) {
  return q.not('railway', 'in', FAKE_RAILWAYS);
}

// ── Lots ─────────────────────────────────────────────────────────────────
// Everything a list view (the Lots table, FullLotRow, WatchlistRow, etc.)
// actually reads -- deliberately NOT the full `detail` jsonb, which is the
// whole scraped catalogue page and far bigger than anything else in the
// row; pulling it for up to 500 rows on every load/keystroke is what blew
// through this project's Supabase egress quota. The three `detail->>`
// entries are the one part of it a list row does need -- custodianLocation
// 's precise Location column -- so PostgREST extracts just those three
// flat strings instead of the whole blob. Anything that needs the rest of
// `detail` (the lot detail modal, Print, PDF) fetches it separately, once,
// on demand -- see ensureDetail/fetchLotDetail.
const LOT_LIST_COLUMNS = [
  'lot_no', 'lot_id', 'source', 'railway', 'depot', 'qty_unit', 'category', 'min_incr',
  'material_descr', 'next_auction', 'status', 'change_tag', 'change_detail', 'relist_count',
  'custodian:detail->>Custodian', 'detail_location:detail->>Location', 'detail_state:detail->>State',
].join(',');

// Server-side filtering/search via PostgREST, mirroring webapp.py's /lots
// route (search across lot_no/material_descr/railway/depot, category,
// change_tag, status filters).
export async function fetchLots({ search = '', category = '', changeTag = '', status = 'active', sources = [], anyKeywords = [], limit = 500 } = {}) {
  let q = supabase.from('lots').select(LOT_LIST_COLUMNS).order('publish_date', { ascending: false }).limit(limit);
  q = excludeTestRailways(q);
  if (status) q = q.eq('status', status);
  if (category) q = q.eq('category', category);
  if (changeTag) q = q.eq('change_tag', changeTag);
  if (sources.length) q = q.in('source', sources);
  const esc = (s) => s.replace(/[%,]/g, '');
  // The keyword-tab selection and the free-text search box are independent
  // and combine with AND (e.g. search "sambalpur" + keyword tab "60kg" ->
  // rows that mention Sambalpur AND match the 60kg keyword) -- each is its
  // own .or() call, and calling .or() more than once ANDs the groups
  // together (PostgREST semantics), which is exactly what we want here.
  if (anyKeywords.length) {
    // Keyword tabs: OR across every selected keyword (matches any one of
    // them), as one .or() call.
    q = q.or(anyKeywords.map(k => `material_descr.ilike.%${esc(k)}%,category.ilike.%${esc(k)}%`).join(','));
  }
  if (search.trim()) {
    const terms = search.split(',').map(t => t.trim()).filter(Boolean);
    for (const term of terms) {
      q = q.or(`lot_no.ilike.%${esc(term)}%,material_descr.ilike.%${esc(term)}%,railway.ilike.%${esc(term)}%,depot.ilike.%${esc(term)}%`);
    }
  }
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// Per-source lot counts under the Lots tab's current OTHER filters (status/
// category/changeTag/search/keyword-tabs) -- deliberately ignores sourceFilters
// itself, so each chip shows "how many lots would show if I picked this one",
// not how many are in the currently-loaded (already source-filtered) set.
// Three cheap HEAD (count-only, no rows) requests rather than one grouped
// query, mirroring fetchKeywordSourceCount's existing pattern.
export async function fetchSourceCounts({ search = '', category = '', changeTag = '', status = 'active', anyKeywords = [] } = {}) {
  const esc = (s) => s.replace(/[%,]/g, '');
  const sources = ['IREPS', 'Matex', 'MSTC'];
  const counts = {};
  await Promise.all(sources.map(async (src) => {
    let q = supabase.from('lots').select('*', { count: 'exact', head: true }).eq('source', src);
    q = excludeTestRailways(q);
    if (status) q = q.eq('status', status);
    if (category) q = q.eq('category', category);
    if (changeTag) q = q.eq('change_tag', changeTag);
    if (anyKeywords.length) q = q.or(anyKeywords.map(k => `material_descr.ilike.%${esc(k)}%,category.ilike.%${esc(k)}%`).join(','));
    if (search.trim()) {
      const terms = search.split(',').map(t => t.trim()).filter(Boolean);
      for (const term of terms) q = q.or(`lot_no.ilike.%${esc(term)}%,material_descr.ilike.%${esc(term)}%,railway.ilike.%${esc(term)}%,depot.ilike.%${esc(term)}%`);
    }
    const { count, error } = await q;
    if (!error) counts[src] = count || 0;
  }));
  return counts;
}

// Active vs expired lot counts under the Lots tab's current OTHER filters
// (source/category/changeTag/search/keyword-tabs) -- ignores `status` itself,
// for the same reason as fetchSourceCounts above. The "active" count is the
// server's status='active' count, which can include a handful of lots whose
// own auction date has in fact just passed (the next scan hasn't caught up
// yet) -- the Lots tab's rendered list corrects for that client-side, so the
// two can differ by a small amount; not worth a second full-table date-aware
// query just to keep a label in sync with a list that's already correct.
export async function fetchStatusCounts({ search = '', category = '', changeTag = '', sources = [], anyKeywords = [] } = {}) {
  const esc = (s) => s.replace(/[%,]/g, '');
  const statuses = ['active', 'expired'];
  const counts = {};
  await Promise.all(statuses.map(async (st) => {
    let q = supabase.from('lots').select('*', { count: 'exact', head: true }).eq('status', st);
    q = excludeTestRailways(q);
    if (category) q = q.eq('category', category);
    if (changeTag) q = q.eq('change_tag', changeTag);
    if (sources.length) q = q.in('source', sources);
    if (anyKeywords.length) q = q.or(anyKeywords.map(k => `material_descr.ilike.%${esc(k)}%,category.ilike.%${esc(k)}%`).join(','));
    if (search.trim()) {
      const terms = search.split(',').map(t => t.trim()).filter(Boolean);
      for (const term of terms) q = q.or(`lot_no.ilike.%${esc(term)}%,material_descr.ilike.%${esc(term)}%,railway.ilike.%${esc(term)}%,depot.ilike.%${esc(term)}%`);
    }
    const { count, error } = await q;
    if (!error) counts[st] = count || 0;
  }));
  return counts;
}

export async function fetchCategoryCounts(sources = []) {
  // The project's PostgREST max-rows setting caps any single response
  // (1000 by default), which silently under-counted categories once total
  // active lots passed that -- a client-side .limit() can't override a
  // server-side cap, so page through with .range() instead.
  const counts = {};
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let q = supabase.from('lots').select('category').eq('status', 'active').range(from, from + pageSize - 1);
    q = excludeTestRailways(q);
    if (sources.length) q = q.in('source', sources);
    const { data, error } = await q;
    if (error) throw error;
    for (const row of data || []) counts[row.category] = (counts[row.category] || 0) + 1;
    if (!data || data.length < pageSize) break;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

// Lightweight full-dataset pull (material_descr/category/source only, no
// detail jsonb) across every active lot regardless of source, paginated
// past the server's max-rows cap -- used for the keyword-suggestion engine
// and the category explorer, both of which need to see everything at once
// rather than whatever page/filter happens to be active on the Lots tab.
export async function fetchActiveLotsSummary() {
  const out = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await excludeTestRailways(supabase
      .from('lots').select('material_descr,category,source')
      .eq('status', 'active').range(from, from + pageSize - 1));
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return out;
}

export async function fetchLotsByNos(lotNos) {
  if (!lotNos.length) return [];
  const { data, error } = await supabase.from('lots').select('*').in('lot_no', lotNos);
  if (error) throw error;
  return data || [];
}

// The full `detail` jsonb for exactly one lot -- single row, single column,
// used only once a lot is actually opened (detail modal, Print, PDF), never
// as part of a list load. See LOT_LIST_COLUMNS above for why list views
// don't carry this.
export async function fetchLotDetail(lotNo) {
  const { data, error } = await supabase.from('lots').select('detail').eq('lot_no', lotNo).maybeSingle();
  if (error) throw error;
  return data?.detail ?? null;
}

export async function fetchLatestScan() {
  const { data, error } = await supabase.from('scans').select('*').order('finished_at', { ascending: false }).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

// Most recent scans row per source (IREPS/Matex/MSTC each push their own
// row -- see autoscan.py/matex_autoscan.py/mstc_import.py). Rows from
// before each script started tagging `source` have it as null and are
// simply never the latest for any of these three, so they just drop out
// once a source's first tagged row lands.
export async function fetchLatestScans() {
  const sources = ['IREPS', 'Matex', 'MSTC'];
  const entries = await Promise.all(sources.map(async (src) => {
    const { data, error } = await supabase.from('scans').select('*').eq('source', src).order('finished_at', { ascending: false }).limit(1);
    if (error) throw error;
    return [src, (data && data[0]) || null];
  }));
  return Object.fromEntries(entries);
}

// ── Bookmarks (per signed-in user, RLS-scoped) ──────────────────────────
export async function fetchBookmarks() {
  const { data, error } = await supabase
    .from('bookmarks')
    .select('*, lots(*)')
    .order('bookmarked_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(row => ({ ...row.lots, ...row }));
}

export async function isBookmarked(lotNo) {
  const { data, error } = await supabase.from('bookmarks').select('lot_no').eq('lot_no', lotNo).maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function fetchBookmarkedLotNos() {
  const { data, error } = await supabase.from('bookmarks').select('lot_no');
  if (error) throw error;
  return new Set((data || []).map(r => r.lot_no));
}

export async function addBookmark(lotNo) {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData?.session?.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { error } = await supabase.from('bookmarks').insert({ user_id: userId, lot_no: lotNo });
  if (error) throw error;
}

export async function removeBookmark(lotNo) {
  const { error } = await supabase.from('bookmarks').delete().eq('lot_no', lotNo);
  if (error) throw error;
}

export async function updateBookmark(lotNo, fields) {
  const { error } = await supabase.from('bookmarks').update(fields).eq('lot_no', lotNo);
  if (error) throw error;
}

// ── Keywords (per signed-in user, RLS-scoped) ───────────────────────────
export async function fetchKeywords() {
  const { data, error } = await supabase.from('keywords').select('*').order('sort_order', { ascending: true, nullsFirst: false }).order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function addKeyword(keyword) {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData?.session?.user?.id;
  if (!userId) throw new Error('Not signed in');
  // New keywords go to the end of the user's own drag order -- one extra
  // read to find the current max, rather than a server-side default, since
  // sort_order is scoped per-user and plain column defaults can't see that.
  const { data: maxRow } = await supabase.from('keywords').select('sort_order').eq('user_id', userId).order('sort_order', { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
  const nextOrder = (maxRow?.sort_order ?? -1) + 1;
  const { error } = await supabase.from('keywords').insert({ user_id: userId, keyword, sort_order: nextOrder });
  if (error) throw error;
}

export async function removeKeyword(id) {
  const { error } = await supabase.from('keywords').delete().eq('id', id);
  if (error) throw error;
}

// Persists a drag-and-drop reorder: `orderedIds` is every one of the user's
// keyword ids in their new display order. One update per row -- the list is
// always small (a handful to a few dozen keywords), so this is simpler than
// a bulk upsert/RPC for what's a rare, user-driven action.
export async function reorderKeywords(orderedIds) {
  const { error } = await (async () => {
    for (let i = 0; i < orderedIds.length; i++) {
      const { error: err } = await supabase.from('keywords').update({ sort_order: i }).eq('id', orderedIds[i]);
      if (err) return { error: err };
    }
    return { error: null };
  })();
  if (error) throw error;
}

// Active lots matching any saved keyword (material_descr/category ilike),
// for the "Keyword Matches" view -- auctions of interest, regardless of
// whether they've been starred yet.
export async function fetchKeywordMatches(keywords) {
  if (!keywords.length) return [];
  let q = supabase.from('lots').select(LOT_LIST_COLUMNS).eq('status', 'active').order('next_auction', { ascending: true }).limit(500);
  q = excludeTestRailways(q);
  const esc = (k) => k.replace(/[%,]/g, '');
  const orExpr = keywords.map(k => `material_descr.ilike.%${esc(k)}%,category.ilike.%${esc(k)}%`).join(',');
  q = q.or(orExpr);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// Accurate per-source match count for one keyword -- a head request (no
// rows returned, just the exact count), since deriving "how many match"
// from fetchKeywordMatches's own 500-row-capped result would badly
// undercount a common keyword (most of them, in practice).
export async function fetchKeywordSourceCount(keyword, source) {
  const esc = keyword.replace(/[%,]/g, '');
  let q = supabase.from('lots').select('*', { count: 'exact', head: true }).eq('status', 'active');
  q = excludeTestRailways(q);
  if (source) q = q.eq('source', source);
  q = q.or(`material_descr.ilike.%${esc}%,category.ilike.%${esc}%`);
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

// ── External auctions (MSTC/MJunction/other, per signed-in user) ───────────
export async function fetchExternalLots() {
  const { data, error } = await supabase.from('external_lots').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function addExternalLot(fields) {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData?.session?.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { error } = await supabase.from('external_lots').insert({ user_id: userId, ...fields });
  if (error) throw error;
}

export async function updateExternalLot(id, fields) {
  const { error } = await supabase.from('external_lots').update(fields).eq('id', id);
  if (error) throw error;
}

export async function removeExternalLot(id) {
  const { error } = await supabase.from('external_lots').delete().eq('id', id);
  if (error) throw error;
}

// ── Awarded lots (per signed-in user) ───────────────────────────────────
export async function fetchAwardedLots() {
  const { data, error } = await supabase.from('awarded_lots').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function addAwardedLot(fields) {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData?.session?.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { data, error } = await supabase.from('awarded_lots').insert({ user_id: userId, ...fields }).select().single();
  if (error) throw error;
  return data;
}

export async function updateAwardedLot(id, fields) {
  const { error } = await supabase.from('awarded_lots').update(fields).eq('id', id);
  if (error) throw error;
}

export async function removeAwardedLot(id) {
  const { error } = await supabase.from('awarded_lots').delete().eq('id', id);
  if (error) throw error;
}

// ── Award documents (Supabase Storage, private bucket) ──────────────────
export async function listAwardDocuments(awardId) {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData?.session?.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { data, error } = await supabase.storage.from('award-documents').list(`${userId}/${awardId}`);
  if (error) throw error;
  return (data || []).filter(f => f.name !== '.emptyFolderPlaceholder');
}

export async function uploadAwardDocument(awardId, file) {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData?.session?.user?.id;
  if (!userId) throw new Error('Not signed in');
  const path = `${userId}/${awardId}/${Date.now()}-${file.name}`;
  const { error } = await supabase.storage.from('award-documents').upload(path, file);
  if (error) throw error;
}

export async function getAwardDocumentUrl(awardId, filename) {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData?.session?.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { data, error } = await supabase.storage.from('award-documents').createSignedUrl(`${userId}/${awardId}/${filename}`, 60);
  if (error) throw error;
  return data.signedUrl;
}

export async function deleteAwardDocument(awardId, filename) {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData?.session?.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { error } = await supabase.storage.from('award-documents').remove([`${userId}/${awardId}/${filename}`]);
  if (error) throw error;
}

// ── Lifted material (per signed-in user) ────────────────────────────────
export async function fetchLiftedMaterial() {
  const { data, error } = await supabase.from('lifted_material').select('*').order('lifted_date', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function addLiftedMaterial(fields) {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData?.session?.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { error } = await supabase.from('lifted_material').insert({ user_id: userId, ...fields });
  if (error) throw error;
}

export async function updateLiftedMaterial(id, fields) {
  const { error } = await supabase.from('lifted_material').update(fields).eq('id', id);
  if (error) throw error;
}

export async function removeLiftedMaterial(id) {
  const { error } = await supabase.from('lifted_material').delete().eq('id', id);
  if (error) throw error;
}

// ── Sale orders (per signed-in user) ────────────────────────────────────
export async function fetchSaleOrders() {
  const { data, error } = await supabase.from('sale_orders').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function addSaleOrder(fields) {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData?.session?.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { error } = await supabase.from('sale_orders').insert({ user_id: userId, ...fields });
  if (error) throw error;
}

export async function updateSaleOrder(id, fields) {
  const { error } = await supabase.from('sale_orders').update(fields).eq('id', id);
  if (error) throw error;
}

export async function removeSaleOrder(id) {
  const { error } = await supabase.from('sale_orders').delete().eq('id', id);
  if (error) throw error;
}
