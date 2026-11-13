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

// ── Lots ─────────────────────────────────────────────────────────────────
// Server-side filtering/search via PostgREST, mirroring webapp.py's /lots
// route (search across lot_no/material_descr/railway/depot, category,
// change_tag, status filters).
export async function fetchLots({ search = '', category = '', changeTag = '', status = 'active', limit = 500 } = {}) {
  let q = supabase.from('lots').select('*').order('publish_date', { ascending: false }).limit(limit);
  if (status) q = q.eq('status', status);
  if (category) q = q.eq('category', category);
  if (changeTag) q = q.eq('change_tag', changeTag);
  if (search.trim()) {
    const terms = search.split(',').map(t => t.trim()).filter(Boolean);
    for (const term of terms) {
      const esc = term.replace(/[%,]/g, '');
      q = q.or(`lot_no.ilike.%${esc}%,material_descr.ilike.%${esc}%,railway.ilike.%${esc}%,depot.ilike.%${esc}%`);
    }
  }
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function fetchCategoryCounts() {
  const { data, error } = await supabase.from('lots').select('category').eq('status', 'active');
  if (error) throw error;
  const counts = {};
  for (const row of data || []) counts[row.category] = (counts[row.category] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

export async function fetchLotsByNos(lotNos) {
  if (!lotNos.length) return [];
  const { data, error } = await supabase.from('lots').select('*').in('lot_no', lotNos);
  if (error) throw error;
  return data || [];
}

export async function fetchLatestScan() {
  const { data, error } = await supabase.from('scans').select('*').order('finished_at', { ascending: false }).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
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
  const { data, error } = await supabase.from('keywords').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function addKeyword(keyword) {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData?.session?.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { error } = await supabase.from('keywords').insert({ user_id: userId, keyword });
  if (error) throw error;
}

export async function removeKeyword(id) {
  const { error } = await supabase.from('keywords').delete().eq('id', id);
  if (error) throw error;
}

// Active lots matching any saved keyword (material_descr/category ilike),
// for the "Keyword Matches" view -- auctions of interest, regardless of
// whether they've been starred yet.
export async function fetchKeywordMatches(keywords) {
  if (!keywords.length) return [];
  let q = supabase.from('lots').select('*').eq('status', 'active').order('next_auction', { ascending: true }).limit(500);
  const esc = (k) => k.replace(/[%,]/g, '');
  const orExpr = keywords.map(k => `material_descr.ilike.%${esc(k)}%,category.ilike.%${esc(k)}%`).join(',');
  q = q.or(orExpr);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
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
