// Auction Tracker — web dashboard (Supabase-backed, static, deployed to
// GitHub Pages). Same feature set as the local Flask app (webapp.py /
// templates/index.html): browse/search/filter scanned lots, bookmark lots
// with your own notes/rates, print selected lots, and download a
// locally-generated PDF catalogue per lot. Scanning itself stays a local,
// manually-triggered Python step (see ../push_to_supabase.py) — this app
// only reads/writes Supabase.
import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { supabase } from './supabaseClient.js';
import * as DB from './dataClient.js';
import { describeLocation, describeRailway, decipherCustodian, CITY_CODES } from './codes.js';
import { daysToAuction, formatDaysTo } from './dates.js';
import './App.css';

const IREPS_LOT_URL = (lotId) => `https://ireps.gov.in/eps/auction/viewLotAnon.do?lotId=${encodeURIComponent(lotId)}`;
const MATEX_URL = 'https://www.matexnet.com/Index.aspx';
const MSTC_URL = 'https://www.mstcecommerce.com/auctionhome/aucsearch/search.jsp';

// MSTC has no public per-lot URL (per-lot detail sits behind a login we
// don't have), so its "View on..." link just goes to the search page
// instead. Matex rows scraped via the logged-in path (see
// matex_autoscan.py) carry a real per-auction URL in detail['Detail URL']
// -- only reachable if the *viewer* is themselves logged in to Matex (no
// anonymous equivalent exists there), so rows without one (public-only
// scrape, or an older row from before this existed) fall back to the
// generic homepage same as before.
function sourceLink(row) {
  if (row.source === 'Matex') {
    return { url: row.detail?.['Detail URL'] || MATEX_URL, label: 'View on Matex' };
  }
  if (row.source === 'MSTC') return { url: MSTC_URL, label: 'View on MSTC' };
  return { url: IREPS_LOT_URL(row.lot_id), label: 'View on IREPS' };
}

const C = {
  bg: '#f7f8fa', surf: '#fff', bdr: '#e5e7eb', bdrSoft: '#eef0f3', txt: '#18181b', sub: '#6b7280',
  blue: '#2563eb', green: '#16a34a', red: '#dc2626', amber: '#d97706',
  // Added for source color-coding (IREPS/Matex/MSTC) and general visual
  // texture -- distinct hues chosen to stay legible alongside the existing
  // blue/green/red/amber status palette rather than compete with it.
  purple: '#7c3aed', teal: '#0d9488',
};

function Badge({ text, color }) {
  return <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 999, background: `${color}1a`, color }}>{text}</span>;
}

// Which auction source a row came from is the single most useful thing to
// recognise at a glance across every table in the app (far more scannable
// than reading the word itself), so every "Source" column renders through
// this one small badge instead of plain text.
const SOURCE_COLOR = { IREPS: C.blue, Matex: C.purple, MSTC: C.teal, MJunction: C.amber, Other: C.sub };
function SourceBadge({ source }) {
  const s = source || 'IREPS';
  return <Badge text={s} color={SOURCE_COLOR[s] || C.sub} />;
}

const TAG_COLOR = { new: C.green, updated: C.amber, expired: C.red, unchanged: C.sub };

const WATCH_STATUSES = ['watching', 'shortlisted', 'inspected', 'participating', 'won', 'lost'];
const WATCH_STATUS_COLOR = { watching: C.sub, shortlisted: C.blue, inspected: C.amber, participating: C.amber, won: C.green, lost: C.red };
const INSPECTION_STATUSES = ['pending', 'scheduled', 'done', 'skipped'];
const EXTERNAL_SOURCES = ['MSTC', 'MJunction', 'Other'];
const AWARD_SOURCES = ['IREPS', 'MSTC', 'MJunction', 'Other'];
const AWARD_STATUSES = ['awarded', 'payment_pending', 'payment_done', 'lifting', 'completed', 'cancelled'];
const AWARD_STATUS_COLOR = { awarded: C.blue, payment_pending: C.amber, payment_done: C.blue, lifting: C.amber, completed: C.green, cancelled: C.red };
const PAYMENT_STATUSES = ['pending', 'partial', 'paid'];
const SALE_ORDER_STATUSES = ['draft', 'confirmed', 'dispatched', 'delivered', 'cancelled'];
const SALE_ORDER_STATUS_COLOR = { draft: C.sub, confirmed: C.blue, dispatched: C.amber, delivered: C.green, cancelled: C.red };

function parseNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Shared click handler for every multi-select filter-tab row (Source,
// Division, Sub-Division, Keyword tabs): toggles one value's membership in
// its layer's Set, leaving every other selected value alone.
function toggleInSet(setFn, value) {
  setFn(prev => {
    const next = new Set(prev);
    if (next.has(value)) next.delete(value); else next.add(value);
    return next;
  });
}

// target rate + estimated lifting/transport expenses -- what the lot would
// actually cost us if we win it at our target, before we ever place a bid.
function landingCost(row) {
  const target = parseNum(row.target_rate);
  if (target === null) return null;
  const lifting = parseNum(row.lifting_expense) || 0;
  const transport = parseNum(row.transport_expense) || 0;
  return target + lifting + transport;
}

// The real custodian/material location as printed on the IREPS catalogue
// page itself (lots.detail.Location, synced by autoscan.py) -- much more
// useful than our zone-level railway/depot guess, which is only a fallback
// for lots whose catalogue detail hasn't been synced yet.
function custodianLocation(row) {
  const detail = row.detail || {};
  // For IREPS, the catalogue's own "Custodian" field (e.g.
  // "DMS-MISC-AMV-LKO") is what actually identifies who holds the
  // material -- show it deciphered rather than the free-text "Location"
  // field. Matex/MSTC have no such field, so they fall through unchanged.
  const isIreps = !row.source || row.source === 'IREPS';
  if (isIreps && detail.Custodian) return decipherCustodian(detail.Custodian);
  const loc = detail.Location;
  if (loc) return detail.State ? `${loc} (${detail.State})` : loc;
  if (!row.railway) return '';
  return describeLocation(row.railway, row.depot);
}

// Which of the user's saved keywords this lot actually matches -- the same
// material_descr/category ilike check dataClient.js's fetchKeywordMatches
// does server-side, replicated client-side so every table that lists lots
// (not just the dedicated keyword-match views) can show which keyword(s)
// are why a row might be of interest, right under its material description.
function matchingKeywordsFor(row, keywordList) {
  if (!keywordList || !keywordList.length) return [];
  const text = `${row.material_descr || ''} ${row.category || ''}`.toLowerCase();
  return keywordList.filter(k => text.includes(k.keyword.toLowerCase()));
}

function KeywordMatchChips({ row, keywords }) {
  const matches = matchingKeywordsFor(row, keywords);
  if (!matches.length) return null;
  return (
    <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 3 }}>
      {matches.map(k => (
        <span key={k.id} style={{ fontSize: 9.5, fontWeight: 700, padding: '0px 6px', borderRadius: 999, background: `${C.amber}1a`, color: C.amber, whiteSpace: 'nowrap' }}>
          {k.keyword}
        </span>
      ))}
    </div>
  );
}

// The field/value pairs to show for a lot's detail view (modal/print/PDF).
// When the real catalogue detail has been synced (lots.detail, scraped from
// the same page "View on IREPS" opens), that IS the content -- it already
// includes Railway/Depot, Category, Qty, Location etc. in the catalogue's
// A readable summary of lots.change_detail (the field-level diff the
// scraper/importer computes whenever change_tag becomes "updated") --
// shown as a hover tooltip on the "updated" badge/location cell, so you
// don't have to open the detail modal just to see what actually changed.
function changeTooltip(row) {
  const cd = row.change_detail;
  if (!cd || !Object.keys(cd).length) return 'Updated — what changed wasn\'t tracked for this lot.';
  return Object.entries(cd).map(([field, { from, to }]) => `${field}: "${from || '(blank)'}" → "${to || '(blank)'}"`).join('\n');
}

// own wording, so we show it as-is plus our own Next Auction date (which
// isn't a catalogue field). Otherwise fall back to our own scan summary.
function buildDetailRows(row) {
  const entries = Object.entries(row.detail || {});
  if (entries.length) return [...entries, ['Next Auction', row.next_auction || '-']];
  const rows = [];
  if (row.railway) rows.push(['Railway / Depot', `${row.railway} / ${row.depot}`]);
  rows.push(['Location', custodianLocation(row)]);
  if (row.category) rows.push(['Category', row.category]);
  if (row.qty_unit) rows.push(['Qty / Unit', row.qty_unit]);
  if (row.min_incr) rows.push(['Min Increment', row.min_incr]);
  rows.push(['Next Auction', row.next_auction || '-']);
  return rows;
}

// ── Login / sign-up ─────────────────────────────────────────────────────
function LoginScreen({ onSignedIn }) {
  const [mode, setMode] = useState('signin'); // signin | signup
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!email || !password) { setErr('Enter email and password'); return; }
    setBusy(true); setErr(''); setMsg('');
    try {
      if (mode === 'signin') {
        await DB.signIn(email.trim(), password);
        onSignedIn();
      } else {
        await DB.signUp(email.trim(), password);
        setMsg('Account created. Check your email to confirm, then sign in.');
        setMode('signin');
      }
    } catch (e) {
      setErr(e.message || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: C.bg, padding: 16, boxSizing: 'border-box' }}>
      <form onSubmit={submit} style={{ width: 'min(340px, 100%)', background: C.surf, borderRadius: 12, border: `1px solid ${C.bdr}`, padding: 28, boxShadow: '0 4px 20px rgba(0,0,0,0.06)', boxSizing: 'border-box' }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🚂</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.txt }}>Auction Tracker</div>
          <div style={{ fontSize: 12, color: C.sub, marginTop: 4 }}>Sign in to see your bookmarks and rates</div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: C.sub, marginBottom: 4 }}>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" autoFocus
            style={{ width: '100%', padding: '9px 12px', borderRadius: 7, border: `1.5px solid ${C.bdr}`, fontSize: 13, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: C.sub, marginBottom: 4 }}>Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            style={{ width: '100%', padding: '9px 12px', borderRadius: 7, border: `1.5px solid ${C.bdr}`, fontSize: 13, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }} />
        </div>
        {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 12 }}>{err}</div>}
        {msg && <div style={{ fontSize: 12, color: C.green, marginBottom: 12 }}>{msg}</div>}
        <button type="submit" disabled={busy} style={{ width: '100%', padding: '10px 0', borderRadius: 7, border: 'none', background: C.blue, color: '#fff', fontSize: 13, fontWeight: 700, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1, fontFamily: 'inherit' }}>
          {busy ? 'Please wait…' : (mode === 'signin' ? 'Sign in' : 'Create account')}
        </button>
        <div style={{ textAlign: 'center', marginTop: 14, fontSize: 12, color: C.sub }}>
          {mode === 'signin' ? (
            <>No account? <a href="#" onClick={e => { e.preventDefault(); setMode('signup'); setErr(''); setMsg(''); }}>Sign up</a></>
          ) : (
            <>Already have an account? <a href="#" onClick={e => { e.preventDefault(); setMode('signin'); setErr(''); setMsg(''); }}>Sign in</a></>
          )}
        </div>
      </form>
    </div>
  );
}

// ── PDF catalogue (client-side, mirrors the Python reportlab version) ───
function downloadCataloguePdf(row) {
  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.text(`Lot Catalogue - Lot ${row.lot_no}`, 14, 18);

  const hasDetail = !!(row.detail && Object.keys(row.detail).length);
  autoTable(doc, {
    startY: 24,
    head: [['Field', 'Value']],
    body: buildDetailRows(row),
    styles: { fontSize: 8, cellPadding: 3 },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 55 } },
    headStyles: { fillColor: [37, 99, 235] },
  });

  let finalY = doc.lastAutoTable.finalY;
  if (!hasDetail) {
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text('Full catalogue detail not synced yet for this lot — showing our own scan summary instead.', 14, finalY + 8);
    finalY += 8;
  }

  doc.setFontSize(7);
  doc.setTextColor(150);
  doc.text(`Generated locally from publicly scraped ${row.source || 'IREPS'} lot data. This is not an official catalogue document.`, 14, finalY + 10);

  doc.save(`lot_${row.lot_no}_catalogue.pdf`);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Generic printable-table window, used for both the Lots and Watchlist
// "print all / print selected" actions -- same look, different column sets.
function printRows(title, columns, rows) {
  const win = window.open('', '_blank');
  const thead = columns.map(c => `<th>${escapeHtml(c.header)}</th>`).join('');
  const trs = rows.map(r => `<tr>${columns.map(c => `<td>${escapeHtml(c.get(r))}</td>`).join('')}</tr>`).join('');
  win.document.write(`<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title><style>
    body{font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#222;margin:1.5rem}
    h1{font-size:1.2rem} table{border-collapse:collapse;width:100%;font-size:0.8rem}
    th,td{border:1px solid #999;padding:0.4rem 0.6rem;text-align:left;vertical-align:top}
    th{background:#eee}
    </style></head><body>
    <h1>${escapeHtml(title)} (${rows.length})</h1>
    <table><tr>${thead}</tr>${trs}</table>
    <script>window.onload = () => window.print();</script>
    </body></html>`);
  win.document.close();
}

const LOT_PRINT_COLUMNS = [
  { header: 'Source', get: r => r.source || 'IREPS' },
  { header: 'Railway', get: r => r.railway },
  { header: 'Depot', get: r => r.depot },
  { header: 'Location', get: r => r.location || describeLocation(r.railway, r.depot) },
  { header: 'Lot No', get: r => r.lot_no },
  { header: 'Qty/Unit', get: r => r.qty_unit },
  { header: 'Category', get: r => r.category },
  { header: 'Min Incr', get: r => r.min_incr },
  { header: 'Material Descr.', get: r => r.material_descr },
  { header: 'Next Auction', get: r => r.next_auction || '' },
];

const WATCHLIST_PRINT_COLUMNS = [
  ...LOT_PRINT_COLUMNS,
  { header: 'Status', get: r => r.watch_status || 'watching' },
  { header: 'Team', get: r => r.team || '' },
  { header: 'Target Rate', get: r => r.target_rate || '' },
  { header: 'Landing Cost', get: (r) => { const c = landingCost(r); return c === null ? '' : c.toFixed(2); } },
];

function printLotDetail(row) {
  const hasDetail = !!(row.detail && Object.keys(row.detail).length);
  const rowsHtml = buildDetailRows(row).map(([k, v]) => `<tr><td><b>${escapeHtml(k)}</b></td><td>${escapeHtml(v)}</td></tr>`).join('');
  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>Lot ${escapeHtml(row.lot_no)}</title><style>
    body{font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#222;margin:1.5rem}
    h1{font-size:1.2rem} table{border-collapse:collapse;width:100%;font-size:0.85rem;margin-bottom:1rem}
    td{border:1px solid #999;padding:0.4rem 0.6rem;text-align:left;vertical-align:top}
    </style></head><body>
    <h1>Lot ${escapeHtml(row.lot_no)} - ${escapeHtml(row.material_descr)}</h1>
    <table>${rowsHtml}</table>
    ${!hasDetail ? '<p><i>Full catalogue detail not synced yet for this lot — showing our own scan summary instead.</i></p>' : ''}
    <script>window.onload = () => window.print();</script>
    </body></html>`);
  win.document.close();
}

// ── Lot detail modal ────────────────────────────────────────────────────
function LotDetailModal({ row, onClose }) {
  if (!row) return null;
  const rows = buildDetailRows(row);
  const hasDetail = !!(row.detail && Object.keys(row.detail).length);
  const link = sourceLink(row);
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surf, borderRadius: 10, width: 'min(560px, 94vw)', maxHeight: '85vh', overflow: 'auto', padding: 22, boxShadow: '0 10px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Lot {row.lot_no}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: C.sub, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 14 }}>{row.material_descr}</div>

        {row.change_tag === 'updated' && row.change_detail && Object.keys(row.change_detail).length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6 }}>What changed</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <tbody>
                {Object.entries(row.change_detail).map(([field, { from, to }]) => (
                  <tr key={field} style={{ borderTop: `1px solid ${C.bdr}` }}>
                    <td style={{ ...td, fontWeight: 600, width: 140 }}>{field}</td>
                    <td style={td}><span style={{ color: C.red, textDecoration: 'line-through' }}>{from || '(blank)'}</span> → <span style={{ color: C.green }}>{to || '(blank)'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6 }}>
          {hasDetail ? `Catalogue detail (same as "${link.label}")` : 'Summary'}
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, marginBottom: 8 }}>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} style={{ borderTop: `1px solid ${C.bdr}` }}>
                <td style={{ ...td, fontWeight: 600, width: 140 }}>{k}</td><td style={td}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!hasDetail && (
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 14 }}>
            Full catalogue detail not synced yet for this lot — it'll be fetched on the next daily scan.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a href={link.url} target="_blank" rel="noopener noreferrer" style={{ ...smallBtn, textDecoration: 'none', display: 'inline-block' }}>
            {link.label} ↗
          </a>
          <button onClick={() => printLotDetail(row)} style={smallBtn}>Print</button>
          <button onClick={() => downloadCataloguePdf(row)} style={smallBtn}>Download PDF</button>
        </div>
      </div>
    </div>
  );
}

const field = { display: 'flex', flexDirection: 'column', gap: 3 };
const label = { fontSize: 11, fontWeight: 600, color: C.sub };
const modalInput = { padding: '6px 8px', borderRadius: 5, border: `1px solid ${C.bdr}`, fontSize: 12.5, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' };

function WatchlistEditModal({ row, onSave, onClose }) {
  const [f, setF] = useState({
    watch_status: row.watch_status || 'watching',
    team: row.team || '',
    notes: row.notes || '',
    inspection_status: row.inspection_status || 'pending',
    inspection_notes: row.inspection_notes || '',
    emd_required: !!row.emd_required,
    emd_amount: row.emd_amount || '',
    emd_paid: !!row.emd_paid,
    target_rate: row.target_rate || '',
    lifting_expense: row.lifting_expense || '',
    transport_expense: row.transport_expense || '',
    last_bid: row.last_bid || '',
    sold_rate: row.sold_rate || '',
    won_by: row.won_by || '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF(prev => ({ ...prev, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const save = async () => {
    setSaving(true);
    await onSave(row.lot_no, f);
    setSaving(false);
    onClose();
  };

  const cost = landingCost(f);

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surf, borderRadius: 10, width: 'min(560px, 94vw)', maxHeight: '85vh', overflow: 'auto', padding: 22, boxShadow: '0 10px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Watchlist · Lot {row.lot_no}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: C.sub, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 16 }}>{row.material_descr}</div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 14 }}>
          <label style={field}>
            <span style={label}>Status</span>
            <select value={f.watch_status} onChange={set('watch_status')} style={modalInput}>
              {WATCH_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label style={field}>
            <span style={label}>Team</span>
            <input value={f.team} onChange={set('team')} style={modalInput} placeholder="Who's on this" />
          </label>
        </div>

        <label style={{ ...field, marginBottom: 14 }}>
          <span style={label}>Notes</span>
          <textarea value={f.notes} onChange={set('notes')} rows={2} style={{ ...modalInput, resize: 'vertical' }} />
        </label>

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>Inspection</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 14 }}>
          <label style={field}>
            <span style={label}>Status</span>
            <select value={f.inspection_status} onChange={set('inspection_status')} style={modalInput}>
              {INSPECTION_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label style={field}>
            <span style={label}>Inspection notes</span>
            <input value={f.inspection_notes} onChange={set('inspection_notes')} style={modalInput} />
          </label>
        </div>

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>EMD</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 12, alignItems: 'end', marginBottom: 14 }}>
          <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={f.emd_required} onChange={set('emd_required')} />
            <span style={label}>Required</span>
          </label>
          <label style={field}>
            <span style={label}>Amount</span>
            <input value={f.emd_amount} onChange={set('emd_amount')} style={modalInput} disabled={!f.emd_required} />
          </label>
          <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={f.emd_paid} onChange={set('emd_paid')} disabled={!f.emd_required} />
            <span style={label}>Paid</span>
          </label>
        </div>

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>Rates &amp; landing cost</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, marginBottom: 6 }}>
          <label style={field}>
            <span style={label}>Target rate</span>
            <input value={f.target_rate} onChange={set('target_rate')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Lifting expense</span>
            <input value={f.lifting_expense} onChange={set('lifting_expense')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Transport expense</span>
            <input value={f.transport_expense} onChange={set('transport_expense')} style={modalInput} />
          </label>
        </div>
        <div style={{ fontSize: 12, color: C.sub, marginBottom: 14 }}>
          Estimated landing cost: <strong style={{ color: C.txt }}>{cost === null ? '-' : cost.toFixed(2)}</strong>
        </div>

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>Auction-day log</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, marginBottom: 18 }}>
          <label style={field}>
            <span style={label}>Last bid</span>
            <input value={f.last_bid} onChange={set('last_bid')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Sold rate</span>
            <input value={f.sold_rate} onChange={set('sold_rate')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Won by</span>
            <input value={f.won_by} onChange={set('won_by')} style={modalInput} placeholder="If not us" />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={save} disabled={saving} style={{ ...smallBtn, background: C.blue, color: '#fff', borderColor: C.blue }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onClose} style={smallBtn}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ExternalLotModal({ row, onSave, onClose }) {
  const isNew = !row;
  const [f, setF] = useState({
    source: row?.source || 'MSTC',
    external_lot_no: row?.external_lot_no || '',
    title: row?.title || '',
    location: row?.location || '',
    category: row?.category || '',
    qty_unit: row?.qty_unit || '',
    auction_date: row?.auction_date || '',
    source_url: row?.source_url || '',
    notes: row?.notes || '',
    watch_status: row?.watch_status || 'watching',
    team: row?.team || '',
    inspection_status: row?.inspection_status || 'pending',
    inspection_notes: row?.inspection_notes || '',
    emd_required: !!row?.emd_required,
    emd_amount: row?.emd_amount || '',
    emd_paid: !!row?.emd_paid,
    target_rate: row?.target_rate || '',
    lifting_expense: row?.lifting_expense || '',
    transport_expense: row?.transport_expense || '',
    last_bid: row?.last_bid || '',
    sold_rate: row?.sold_rate || '',
    won_by: row?.won_by || '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF(prev => ({ ...prev, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const save = async () => {
    if (!f.title.trim()) { setErr('Title is required'); return; }
    setSaving(true);
    try {
      const fields = { ...f, auction_date: f.auction_date || null };
      await onSave(fields);
      onClose();
    } catch (e) {
      setErr(e.message || String(e));
      setSaving(false);
    }
  };

  const cost = landingCost(f);

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surf, borderRadius: 10, width: 'min(560px, 94vw)', maxHeight: '85vh', overflow: 'auto', padding: 22, boxShadow: '0 10px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{isNew ? 'Add External Lot' : 'Edit External Lot'}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: C.sub, lineHeight: 1 }}>×</button>
        </div>

        {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 12 }}>{err}</div>}

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>Lot details</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
          <label style={field}>
            <span style={label}>Source</span>
            <select value={f.source} onChange={set('source')} style={modalInput}>
              {EXTERNAL_SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label style={field}>
            <span style={label}>Lot No</span>
            <input value={f.external_lot_no} onChange={set('external_lot_no')} style={modalInput} />
          </label>
        </div>
        <label style={{ ...field, marginBottom: 12 }}>
          <span style={label}>Title / material description</span>
          <input value={f.title} onChange={set('title')} style={modalInput} placeholder="Required" />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
          <label style={field}>
            <span style={label}>Location</span>
            <input value={f.location} onChange={set('location')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Category</span>
            <input value={f.category} onChange={set('category')} style={modalInput} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
          <label style={field}>
            <span style={label}>Qty / Unit</span>
            <input value={f.qty_unit} onChange={set('qty_unit')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Auction date</span>
            <input type="date" value={f.auction_date || ''} onChange={set('auction_date')} style={modalInput} />
          </label>
        </div>
        <label style={{ ...field, marginBottom: 16 }}>
          <span style={label}>Link to auction page</span>
          <input value={f.source_url} onChange={set('source_url')} style={modalInput} placeholder="https://..." />
        </label>

        <label style={{ ...field, marginBottom: 14 }}>
          <span style={label}>Notes</span>
          <textarea value={f.notes} onChange={set('notes')} rows={2} style={{ ...modalInput, resize: 'vertical' }} />
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 14 }}>
          <label style={field}>
            <span style={label}>Status</span>
            <select value={f.watch_status} onChange={set('watch_status')} style={modalInput}>
              {WATCH_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label style={field}>
            <span style={label}>Team</span>
            <input value={f.team} onChange={set('team')} style={modalInput} placeholder="Who's on this" />
          </label>
        </div>

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>Inspection</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 14 }}>
          <label style={field}>
            <span style={label}>Status</span>
            <select value={f.inspection_status} onChange={set('inspection_status')} style={modalInput}>
              {INSPECTION_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label style={field}>
            <span style={label}>Inspection notes</span>
            <input value={f.inspection_notes} onChange={set('inspection_notes')} style={modalInput} />
          </label>
        </div>

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>EMD</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 12, alignItems: 'end', marginBottom: 14 }}>
          <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={f.emd_required} onChange={set('emd_required')} />
            <span style={label}>Required</span>
          </label>
          <label style={field}>
            <span style={label}>Amount</span>
            <input value={f.emd_amount} onChange={set('emd_amount')} style={modalInput} disabled={!f.emd_required} />
          </label>
          <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={f.emd_paid} onChange={set('emd_paid')} disabled={!f.emd_required} />
            <span style={label}>Paid</span>
          </label>
        </div>

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>Rates &amp; landing cost</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, marginBottom: 6 }}>
          <label style={field}>
            <span style={label}>Target rate</span>
            <input value={f.target_rate} onChange={set('target_rate')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Lifting expense</span>
            <input value={f.lifting_expense} onChange={set('lifting_expense')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Transport expense</span>
            <input value={f.transport_expense} onChange={set('transport_expense')} style={modalInput} />
          </label>
        </div>
        <div style={{ fontSize: 12, color: C.sub, marginBottom: 14 }}>
          Estimated landing cost: <strong style={{ color: C.txt }}>{cost === null ? '-' : cost.toFixed(2)}</strong>
        </div>

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>Auction-day log</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, marginBottom: 18 }}>
          <label style={field}>
            <span style={label}>Last bid</span>
            <input value={f.last_bid} onChange={set('last_bid')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Sold rate</span>
            <input value={f.sold_rate} onChange={set('sold_rate')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Won by</span>
            <input value={f.won_by} onChange={set('won_by')} style={modalInput} placeholder="If not us" />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={save} disabled={saving} style={{ ...smallBtn, background: C.blue, color: '#fff', borderColor: C.blue }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onClose} style={smallBtn}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function AwardDocuments({ awardId }) {
  const [docs, setDocs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      setDocs(await DB.listAwardDocuments(awardId));
    } catch (e) {
      setErr(e.message || String(e));
    }
  }, [awardId]);

  useEffect(() => { load(); }, [load]);

  const onUpload = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setErr('');
    try {
      await DB.uploadAwardDocument(awardId, file);
      await load();
    } catch (ex) {
      setErr(ex.message || String(ex));
    } finally {
      setBusy(false);
    }
  };

  const open = async (name) => {
    try {
      const url = await DB.getAwardDocumentUrl(awardId, name);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setErr(e.message || String(e));
    }
  };

  const del = async (name) => {
    try {
      await DB.deleteAwardDocument(awardId, name);
      await load();
    } catch (e) {
      setErr(e.message || String(e));
    }
  };

  return (
    <div>
      {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 8 }}>{err}</div>}
      {docs.map(d => (
        <div key={d.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderTop: `1px solid ${C.bdr}`, fontSize: 12.5 }}>
          <button onClick={() => open(d.name)} style={{ background: 'none', border: 'none', color: C.blue, cursor: 'pointer', padding: 0, textAlign: 'left' }}>
            {d.name.replace(/^\d+-/, '')}
          </button>
          <button onClick={() => del(d.name)} style={{ background: 'none', border: 'none', color: C.red, cursor: 'pointer', fontSize: 11 }}>Delete</button>
        </div>
      ))}
      {!docs.length && <div style={{ fontSize: 12, color: C.sub, padding: '5px 0' }}>No documents uploaded yet.</div>}
      <input type="file" onChange={onUpload} disabled={busy} style={{ fontSize: 12, marginTop: 8 }} />
    </div>
  );
}

function AwardedLotModal({ row, onSave, onClose }) {
  const isNew = !row?.id;
  const [f, setF] = useState({
    source: row?.source || 'IREPS',
    lot_no: row?.lot_no || '',
    title: row?.title || '',
    location: row?.location || '',
    category: row?.category || '',
    qty_unit: row?.qty_unit || '',
    sold_rate: row?.sold_rate || '',
    awarded_date: row?.awarded_date || '',
    status: row?.status || 'awarded',
    payment_due_date: row?.payment_due_date || '',
    payment_status: row?.payment_status || 'pending',
    amount_paid: row?.amount_paid || '',
    delivery_due_date: row?.delivery_due_date || '',
    qty_lifted: row?.qty_lifted || '',
    qty_balance: row?.qty_balance || '',
    expenses: row?.expenses || '',
    notes: row?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(row?.id ? row : null);
  const set = (k) => (e) => setF(prev => ({ ...prev, [k]: e.target.value }));

  const save = async () => {
    if (!f.title.trim()) { setErr('Title is required'); return; }
    setSaving(true);
    try {
      const fields = {
        ...f,
        awarded_date: f.awarded_date || null,
        payment_due_date: f.payment_due_date || null,
        delivery_due_date: f.delivery_due_date || null,
      };
      const result = await onSave(fields, saved?.id);
      if (!saved && result) setSaved(result);
      setSaving(false);
    } catch (e) {
      setErr(e.message || String(e));
      setSaving(false);
    }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surf, borderRadius: 10, width: 'min(560px, 94vw)', maxHeight: '85vh', overflow: 'auto', padding: 22, boxShadow: '0 10px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{isNew ? 'Add Awarded Lot' : 'Edit Awarded Lot'}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: C.sub, lineHeight: 1 }}>×</button>
        </div>

        {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 12 }}>{err}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
          <label style={field}>
            <span style={label}>Source</span>
            <select value={f.source} onChange={set('source')} style={modalInput}>
              {AWARD_SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label style={field}>
            <span style={label}>Lot No</span>
            <input value={f.lot_no} onChange={set('lot_no')} style={modalInput} />
          </label>
        </div>
        <label style={{ ...field, marginBottom: 12 }}>
          <span style={label}>Title / material description</span>
          <input value={f.title} onChange={set('title')} style={modalInput} placeholder="Required" />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
          <label style={field}>
            <span style={label}>Location</span>
            <input value={f.location} onChange={set('location')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Category</span>
            <input value={f.category} onChange={set('category')} style={modalInput} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, marginBottom: 16 }}>
          <label style={field}>
            <span style={label}>Qty / Unit</span>
            <input value={f.qty_unit} onChange={set('qty_unit')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Sold rate</span>
            <input value={f.sold_rate} onChange={set('sold_rate')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Awarded date</span>
            <input type="date" value={f.awarded_date || ''} onChange={set('awarded_date')} style={modalInput} />
          </label>
        </div>

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>Status</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12, marginBottom: 14 }}>
          <label style={field}>
            <span style={label}>Overall status</span>
            <select value={f.status} onChange={set('status')} style={modalInput}>
              {AWARD_STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
          </label>
        </div>

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>Payment</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, marginBottom: 14 }}>
          <label style={field}>
            <span style={label}>Due date</span>
            <input type="date" value={f.payment_due_date || ''} onChange={set('payment_due_date')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Status</span>
            <select value={f.payment_status} onChange={set('payment_status')} style={modalInput}>
              {PAYMENT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label style={field}>
            <span style={label}>Amount paid</span>
            <input value={f.amount_paid} onChange={set('amount_paid')} style={modalInput} />
          </label>
        </div>

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>Delivery &amp; lifting</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, marginBottom: 14 }}>
          <label style={field}>
            <span style={label}>Delivery due</span>
            <input type="date" value={f.delivery_due_date || ''} onChange={set('delivery_due_date')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Qty lifted</span>
            <input value={f.qty_lifted} onChange={set('qty_lifted')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Qty balance</span>
            <input value={f.qty_balance} onChange={set('qty_balance')} style={modalInput} />
          </label>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 14 }}>
          <label style={field}>
            <span style={label}>Expenses</span>
            <input value={f.expenses} onChange={set('expenses')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Notes</span>
            <input value={f.notes} onChange={set('notes')} style={modalInput} />
          </label>
        </div>

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>Documents</div>
        {saved?.id ? (
          <div style={{ marginBottom: 16 }}><AwardDocuments awardId={saved.id} /></div>
        ) : (
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 16 }}>Save this award first to attach documents.</div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={save} disabled={saving} style={{ ...smallBtn, background: C.blue, color: '#fff', borderColor: C.blue }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onClose} style={smallBtn}>{saved ? 'Close' : 'Cancel'}</button>
        </div>
      </div>
    </div>
  );
}

function LiftedMaterialModal({ row, onSave, onClose }) {
  const isNew = !row?.id;
  const [f, setF] = useState({
    award_id: row?.award_id ?? null,
    lot_no: row?.lot_no || '',
    title: row?.title || '',
    lifted_date: row?.lifted_date || '',
    qty: row?.qty || '',
    vehicle_no: row?.vehicle_no || '',
    transporter: row?.transporter || '',
    gate_pass_no: row?.gate_pass_no || '',
    destination: row?.destination || '',
    notes: row?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF(prev => ({ ...prev, [k]: e.target.value }));

  const save = async () => {
    if (!f.title.trim()) { setErr('Title is required'); return; }
    setSaving(true);
    try {
      await onSave({ ...f, lifted_date: f.lifted_date || null }, row?.id);
      onClose();
    } catch (e) {
      setErr(e.message || String(e));
      setSaving(false);
    }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surf, borderRadius: 10, width: 'min(480px, 94vw)', maxHeight: '85vh', overflow: 'auto', padding: 22, boxShadow: '0 10px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{isNew ? 'Log Lifting' : 'Edit Lifting Entry'}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: C.sub, lineHeight: 1 }}>×</button>
        </div>

        {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 12 }}>{err}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
          <label style={field}>
            <span style={label}>Lot No</span>
            <input value={f.lot_no} onChange={set('lot_no')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Lifted date</span>
            <input type="date" value={f.lifted_date || ''} onChange={set('lifted_date')} style={modalInput} />
          </label>
        </div>
        <label style={{ ...field, marginBottom: 12 }}>
          <span style={label}>Title / material description</span>
          <input value={f.title} onChange={set('title')} style={modalInput} placeholder="Required" />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
          <label style={field}>
            <span style={label}>Qty lifted</span>
            <input value={f.qty} onChange={set('qty')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Vehicle no</span>
            <input value={f.vehicle_no} onChange={set('vehicle_no')} style={modalInput} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
          <label style={field}>
            <span style={label}>Transporter</span>
            <input value={f.transporter} onChange={set('transporter')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Gate pass no</span>
            <input value={f.gate_pass_no} onChange={set('gate_pass_no')} style={modalInput} />
          </label>
        </div>
        <label style={{ ...field, marginBottom: 12 }}>
          <span style={label}>Destination</span>
          <input value={f.destination} onChange={set('destination')} style={modalInput} />
        </label>
        <label style={{ ...field, marginBottom: 18 }}>
          <span style={label}>Notes</span>
          <input value={f.notes} onChange={set('notes')} style={modalInput} />
        </label>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={save} disabled={saving} style={{ ...smallBtn, background: C.blue, color: '#fff', borderColor: C.blue }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onClose} style={smallBtn}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function SaleOrderModal({ row, onSave, onClose }) {
  const isNew = !row?.id;
  const [f, setF] = useState({
    order_no: row?.order_no || '',
    buyer_name: row?.buyer_name || '',
    buyer_contact: row?.buyer_contact || '',
    lot_no: row?.lot_no || '',
    title: row?.title || '',
    qty: row?.qty || '',
    rate: row?.rate || '',
    total_amount: row?.total_amount || '',
    order_date: row?.order_date || '',
    delivery_date: row?.delivery_date || '',
    status: row?.status || 'draft',
    payment_status: row?.payment_status || 'pending',
    amount_received: row?.amount_received || '',
    notes: row?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF(prev => ({ ...prev, [k]: e.target.value }));

  const save = async () => {
    if (!f.buyer_name.trim()) { setErr('Buyer name is required'); return; }
    if (!f.title.trim()) { setErr('Title is required'); return; }
    setSaving(true);
    try {
      const fields = { ...f, award_id: row?.award_id ?? null, order_date: f.order_date || null, delivery_date: f.delivery_date || null };
      await onSave(fields, row?.id);
      onClose();
    } catch (e) {
      setErr(e.message || String(e));
      setSaving(false);
    }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surf, borderRadius: 10, width: 'min(540px, 94vw)', maxHeight: '85vh', overflow: 'auto', padding: 22, boxShadow: '0 10px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{isNew ? 'Add Sale Order' : 'Edit Sale Order'}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: C.sub, lineHeight: 1 }}>×</button>
        </div>

        {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 12 }}>{err}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
          <label style={field}>
            <span style={label}>Order no</span>
            <input value={f.order_no} onChange={set('order_no')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Order date</span>
            <input type="date" value={f.order_date || ''} onChange={set('order_date')} style={modalInput} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
          <label style={field}>
            <span style={label}>Buyer name</span>
            <input value={f.buyer_name} onChange={set('buyer_name')} style={modalInput} placeholder="Required" />
          </label>
          <label style={field}>
            <span style={label}>Buyer contact</span>
            <input value={f.buyer_contact} onChange={set('buyer_contact')} style={modalInput} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
          <label style={field}>
            <span style={label}>Lot No</span>
            <input value={f.lot_no} onChange={set('lot_no')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Title / material description</span>
            <input value={f.title} onChange={set('title')} style={modalInput} placeholder="Required" />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, marginBottom: 16 }}>
          <label style={field}>
            <span style={label}>Qty</span>
            <input value={f.qty} onChange={set('qty')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Rate</span>
            <input value={f.rate} onChange={set('rate')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Total amount</span>
            <input value={f.total_amount} onChange={set('total_amount')} style={modalInput} />
          </label>
        </div>

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>Status &amp; delivery</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 14 }}>
          <label style={field}>
            <span style={label}>Status</span>
            <select value={f.status} onChange={set('status')} style={modalInput}>
              {SALE_ORDER_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label style={field}>
            <span style={label}>Delivery date</span>
            <input type="date" value={f.delivery_date || ''} onChange={set('delivery_date')} style={modalInput} />
          </label>
        </div>

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>Payment</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 14 }}>
          <label style={field}>
            <span style={label}>Status</span>
            <select value={f.payment_status} onChange={set('payment_status')} style={modalInput}>
              {PAYMENT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label style={field}>
            <span style={label}>Amount received</span>
            <input value={f.amount_received} onChange={set('amount_received')} style={modalInput} />
          </label>
        </div>

        <label style={{ ...field, marginBottom: 18 }}>
          <span style={label}>Notes</span>
          <input value={f.notes} onChange={set('notes')} style={modalInput} />
        </label>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={save} disabled={saving} style={{ ...smallBtn, background: C.blue, color: '#fff', borderColor: C.blue }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onClose} style={smallBtn}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── Main app ─────────────────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(undefined); // undefined = checking, null = signed out
  const [lots, setLots] = useState([]);
  const [bookmarks, setBookmarks] = useState([]);
  const [bookmarkedSet, setBookmarkedSet] = useState(new Set());
  const [categoryCounts, setCategoryCounts] = useState({});
  const [sourceCounts, setSourceCounts] = useState({});
  const [statusCounts, setStatusCounts] = useState({});
  const [latestScan, setLatestScan] = useState(null);
  const [latestScans, setLatestScans] = useState({});
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('active');
  // Layer 1-4 of the Lots tab's drill-down are all multi-select: each is a
  // Set of chosen values (OR'd together within its own layer), empty =
  // "All" for that layer. toggleInSet below is the shared click handler.
  const [sourceFilters, setSourceFilters] = useState(new Set());
  const [changeTag, setChangeTag] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [selectedWatch, setSelectedWatch] = useState(new Set());
  const [visibleCols, setVisibleCols] = useState(loadVisibleCols);
  const [expandedCategory, setExpandedCategory] = useState(null);
  const [divisionFilters, setDivisionFilters] = useState(new Set());
  const [subDivisionFilters, setSubDivisionFilters] = useState(new Set());
  const [selectedKeywordTabs, setSelectedKeywordTabs] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [keywords, setKeywords] = useState([]);
  const [keywordMatches, setKeywordMatches] = useState([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [showInlineKeywordAdd, setShowInlineKeywordAdd] = useState(false);
  const [draggedKeywordId, setDraggedKeywordId] = useState(null);
  // onDrop needs the id that was actually being dragged *right now* --
  // state updated in onDragStart isn't guaranteed to have committed to a
  // new render (and thus a fresh onDrop closure) by the time drop fires, so
  // the payload itself is tracked in a ref (always current, no re-render
  // needed) while `draggedKeywordId` state stays purely for the dimmed
  // "being dragged" visual feedback.
  const draggedKeywordIdRef = useRef(null);
  const [detailLot, setDetailLot] = useState(null);
  const [editWatchRow, setEditWatchRow] = useState(null);
  const [externalLots, setExternalLots] = useState([]);
  const [editExternalLot, setEditExternalLot] = useState(undefined); // undefined = modal closed, null = new
  const [awardedLots, setAwardedLots] = useState([]);
  const [editAward, setEditAward] = useState(undefined); // undefined = modal closed, null = new
  const [liftedMaterial, setLiftedMaterial] = useState([]);
  const [editLifting, setEditLifting] = useState(undefined); // undefined = modal closed, null = new
  const [saleOrders, setSaleOrders] = useState([]);
  const [editSaleOrder, setEditSaleOrder] = useState(undefined); // undefined = modal closed, null = new
  const [activeTab, setActiveTab] = useState('dashboard');
  // Shared across Keyword Watch's suggestion engine and the Categories tab
  // -- a full-dataset (material_descr/category/source) snapshot of every
  // active lot, loaded on demand (not on every page load) and reused by
  // both rather than each fetching it separately.
  const [materialSummary, setMaterialSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryErr, setSummaryErr] = useState('');

  // Watchlisted IREPS lots + manually-tracked external lots, grouped by
  // category and ranked by landing cost within each group, so the cheapest
  // option to actually land is obvious before you commit to bidding on any
  // one of them -- regardless of which site it's being auctioned on.
  const landingComparison = useMemo(() => {
    const combined = [
      ...bookmarks.map(row => ({ key: row.lot_no, source: 'IREPS', row, cost: landingCost(row) })),
      ...externalLots.map(row => ({ key: `ext-${row.id}`, source: row.source, row, cost: landingCost(row) })),
    ];
    const byCategory = {};
    for (const item of combined) {
      const cat = item.row.category || 'Uncategorized';
      (byCategory[cat] = byCategory[cat] || []).push(item);
    }
    for (const cat of Object.keys(byCategory)) {
      byCategory[cat].sort((a, b) => {
        if (a.cost === null) return 1;
        if (b.cost === null) return -1;
        return a.cost - b.cost;
      });
    }
    return Object.entries(byCategory).sort((a, b) => a[0].localeCompare(b[0]));
  }, [bookmarks, externalLots]);

  // Dashboard: new lots (this scan) that match a saved keyword of interest.
  const newKeywordMatches = useMemo(
    () => keywordMatches.filter(r => r.change_tag === 'new'),
    [keywordMatches]
  );

  // Dashboard: keyword matches whose next auction falls within the next 7
  // days, soonest first.
  const upcomingKeywordMatches = useMemo(() => {
    return keywordMatches
      .map(r => ({ ...r, _daysTo: daysToAuction(r.next_auction) }))
      .filter(r => r._daysTo !== null && r._daysTo >= 0 && r._daysTo <= 7)
      .sort((a, b) => a._daysTo - b._daysTo);
  }, [keywordMatches]);

  // Keyword Watch: for each saved keyword, how many matches it has in each
  // source -- computed client-side over the already-fetched (OR'd-together)
  // keywordMatches, by re-checking each row against one keyword at a time.
  const [keywordSourceCounts, setKeywordSourceCounts] = useState({});
  useEffect(() => {
    if (!session || !keywords.length) { setKeywordSourceCounts({}); return; }
    let cancelled = false;
    (async () => {
      const sources = ['IREPS', 'Matex', 'MSTC'];
      const entries = await Promise.all(keywords.map(async k => {
        const bySource = {};
        await Promise.all(sources.map(async src => {
          try {
            const n = await DB.fetchKeywordSourceCount(k.keyword, src);
            if (n) bySource[src] = n;
          } catch { /* leave this source out on error */ }
        }));
        return [k.keyword, bySource];
      }));
      if (!cancelled) setKeywordSourceCounts(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [session, keywords]);

  // Categories tab: every active lot's category, grouped into a top-level
  // category -> sub-category tree with counts, from the on-demand full
  // dataset snapshot (materialSummary) -- category values that encode a
  // sub-category as "Top - Sub" (seen from Matex/MSTC) split there; plain
  // ones (most of IREPS's) just roll up at the top level.
  const categoryTree = useMemo(() => {
    if (!materialSummary) return null;
    const tree = {};
    for (const row of materialSummary) {
      const cat = (row.category || 'Uncategorized').trim() || 'Uncategorized';
      const [top, ...rest] = cat.split(' - ');
      const sub = rest.join(' - ').trim();
      const topKey = top || 'Uncategorized';
      if (!tree[topKey]) tree[topKey] = { total: 0, subs: {} };
      tree[topKey].total++;
      if (sub) tree[topKey].subs[sub] = (tree[topKey].subs[sub] || 0) + 1;
    }
    return Object.entries(tree)
      .map(([name, { total, subs }]) => ({
        name, total,
        subs: Object.entries(subs).sort((a, b) => b[1] - a[1]),
      }))
      .sort((a, b) => b.total - a.total);
  }, [materialSummary]);

  // Lots tab, layer 3 (Division): distinct divisions within the currently
  // loaded (source/category/status/search-filtered) lots, by count --
  // capped so a source with hundreds of depots doesn't produce hundreds of
  // tabs. divisionFilters itself then narrows what's actually rendered --
  // multi-select, so any division in the set (OR'd together) matches.
  const divisions = useMemo(() => {
    const counts = {};
    for (const row of lots) {
      const d = divisionOf(row);
      if (!d) continue;
      counts[d] = (counts[d] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25);
  }, [lots]);

  // Layer 4 (Sub-Division, IREPS only): depots within whichever railway
  // (Division/-ies) is currently selected.
  const withinDivision = useMemo(
    () => divisionFilters.size ? lots.filter(r => divisionFilters.has(divisionOf(r))) : lots,
    [lots, divisionFilters]
  );
  // No explicit source check needed here: subDivisionOf is '' for every
  // non-IREPS row, so a division made up entirely of MSTC/Matex rows simply
  // yields no sub-divisions and the row stays hidden on its own.
  const subDivisions = useMemo(() => {
    if (!divisionFilters.size) return [];
    const counts = {};
    for (const row of withinDivision) {
      const d = subDivisionOf(row);
      if (!d) continue;
      counts[d] = (counts[d] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25);
  }, [withinDivision, divisionFilters]);

  const visibleLots = useMemo(
    () => subDivisionFilters.size ? withinDivision.filter(r => subDivisionFilters.has(subDivisionOf(r))) : withinDivision,
    [withinDivision, subDivisionFilters]
  );

  const sourceColumns = columnsForSources(sourceFilters);

  // Dashboard: auctions (IREPS watchlist + external) we've marked ourselves
  // down to participate in, soonest first.
  const upcomingParticipating = useMemo(() => {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const items = [
      ...bookmarks.filter(b => b.watch_status === 'participating').map(b => ({
        key: b.lot_no, source: 'IREPS', lot_no: b.lot_no, material_descr: b.material_descr,
        when: b.next_auction || '-', days: daysToAuction(b.next_auction), row: b, kind: 'bookmark',
      })),
      ...externalLots.filter(e => e.watch_status === 'participating').map(e => {
        const d = e.auction_date ? new Date(e.auction_date) : null;
        return {
          key: `ext-${e.id}`, source: e.source, lot_no: e.external_lot_no || '-', material_descr: e.title,
          when: e.auction_date || '-', days: d ? Math.round((d - startOfToday) / 86400000) : null,
          row: e, kind: 'external',
        };
      }),
    ];
    items.sort((a, b) => {
      if (a.days === null) return 1;
      if (b.days === null) return -1;
      return a.days - b.days;
    });
    return items;
  }, [bookmarks, externalLots]);

  useEffect(() => {
    if (!supabase) { setSession(null); return; }
    DB.getSession().then(setSession);
    return DB.onAuthChange(setSession);
  }, []);

  // Note: `keywords` is deliberately NOT a dependency here -- anyKeywords
  // comes from selectedKeywordTabs (what the user has actually toggled
  // on), not from the full saved-keywords list. Depending on `keywords`
  // itself used to create a feedback loop: the sign-in effect reloads
  // keywords and lots together, loadKeywords hands back a new array
  // reference every time (even with identical content), which changed
  // loadLots's identity, which re-ran that same effect -- an infinite
  // "Loading…"/"Refresh" flicker with no actual filter change involved.
  const loadLots = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const filterArgs = { search, category, changeTag, anyKeywords: [...selectedKeywordTabs] };
      const [rows, counts, bmSet, srcCounts, stCounts] = await Promise.all([
        DB.fetchLots({ ...filterArgs, status, sources: [...sourceFilters] }),
        DB.fetchCategoryCounts([...sourceFilters]),
        DB.fetchBookmarkedLotNos(),
        DB.fetchSourceCounts({ ...filterArgs, status }),
        DB.fetchStatusCounts({ ...filterArgs, sources: [...sourceFilters] }),
      ]);
      // The scan that marks a lot expired runs once a day -- in the hours
      // between an auction's own date/time passing and that next run, it's
      // still status='active' in the DB. Rather than show it as "active"
      // with a date in the past, drop it from the Active view client-side
      // (statusCounts' own "active" count is the cheaper, un-corrected
      // server count, so it can run a little ahead of what's actually shown
      // here -- see the comment on fetchStatusCounts).
      const corrected = status === 'active'
        ? rows.filter(r => { const d = daysToAuction(r.next_auction); return d === null || d >= 0; })
        : rows;
      setLots(corrected.map(r => ({ ...r, location: custodianLocation(r) })));
      setCategoryCounts(counts);
      setBookmarkedSet(bmSet);
      setSourceCounts(srcCounts);
      setStatusCounts(stCounts);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [search, category, changeTag, status, sourceFilters, selectedKeywordTabs]);

  // Reset the Division/Sub-Division drill-down the moment an upstream
  // filter changes (synchronously, in the same render) -- not from
  // loadLots's own completion, which could otherwise race a division
  // click made while an earlier fetch (e.g. from switching Source) was
  // still in flight and wipe it out moments after the user made it.
  useEffect(() => {
    setDivisionFilters(new Set());
    setSubDivisionFilters(new Set());
  }, [sourceFilters, search, category, changeTag, status, selectedKeywordTabs]);

  const loadMaterialSummary = useCallback(async () => {
    setSummaryLoading(true); setSummaryErr('');
    try {
      setMaterialSummary(await DB.fetchActiveLotsSummary());
    } catch (e) {
      setSummaryErr(e.message || String(e));
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  const loadBookmarks = useCallback(async () => {
    try {
      const rows = await DB.fetchBookmarks();
      setBookmarks(rows.map(r => ({ ...r, location: custodianLocation(r) })));
    } catch (e) {
      setErr(e.message || String(e));
    }
  }, []);

  const loadKeywords = useCallback(async () => {
    try {
      const rows = await DB.fetchKeywords();
      setKeywords(rows);
    } catch (e) {
      setErr(e.message || String(e));
    }
  }, []);

  const loadExternalLots = useCallback(async () => {
    try {
      const rows = await DB.fetchExternalLots();
      setExternalLots(rows);
    } catch (e) {
      setErr(e.message || String(e));
    }
  }, []);

  const loadAwardedLots = useCallback(async () => {
    try {
      const rows = await DB.fetchAwardedLots();
      setAwardedLots(rows);
    } catch (e) {
      setErr(e.message || String(e));
    }
  }, []);

  const loadLiftedMaterial = useCallback(async () => {
    try {
      const rows = await DB.fetchLiftedMaterial();
      setLiftedMaterial(rows);
    } catch (e) {
      setErr(e.message || String(e));
    }
  }, []);

  const loadSaleOrders = useCallback(async () => {
    try {
      const rows = await DB.fetchSaleOrders();
      setSaleOrders(rows);
    } catch (e) {
      setErr(e.message || String(e));
    }
  }, []);

  // One-time load of everything else on sign-in. loadLots is deliberately
  // run from its own effect below (keyed to the actual filter values)
  // rather than listed here -- see the comment on loadLots for why mixing
  // the two caused an infinite reload loop.
  useEffect(() => {
    if (session) {
      loadBookmarks();
      loadKeywords();
      loadExternalLots();
      loadAwardedLots();
      loadLiftedMaterial();
      loadSaleOrders();
      DB.fetchLatestScan().then(setLatestScan).catch(() => {});
      DB.fetchLatestScans().then(setLatestScans).catch(() => {});
    }
  }, [session, loadBookmarks, loadKeywords, loadExternalLots, loadAwardedLots, loadLiftedMaterial, loadSaleOrders]);

  // Lots tab: (re)load whenever the user signs in or actually changes a
  // filter -- loadLots's own useCallback deps are the real primitive
  // filter values, not derived state like `keywords`, so this only fires
  // on a genuine change.
  useEffect(() => {
    if (session) loadLots();
  }, [session, loadLots]);

  useEffect(() => {
    if (!session || !keywords.length) { setKeywordMatches([]); return; }
    DB.fetchKeywordMatches(keywords.map(k => k.keyword))
      .then(rows => setKeywordMatches(rows.map(r => ({ ...r, location: custodianLocation(r) }))))
      .catch(e => setErr(e.message || String(e)));
  }, [session, keywords]);

  if (!supabase) {
    return <div style={{ padding: 40, fontFamily: 'sans-serif' }}>
      <h2>Not configured</h2>
      <p>VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are missing from this build.</p>
    </div>;
  }
  if (session === undefined) return <div style={{ padding: 40 }}>Loading…</div>;
  if (!session) return <LoginScreen onSignedIn={() => {}} />;

  const toggleSelect = (lotNo) => {
    setSelected(s => { const n = new Set(s); n.has(lotNo) ? n.delete(lotNo) : n.add(lotNo); return n; });
  };

  const toggleBookmark = async (lotNo) => {
    try {
      if (bookmarkedSet.has(lotNo)) await DB.removeBookmark(lotNo);
      else await DB.addBookmark(lotNo);
      await Promise.all([loadLots(), loadBookmarks()]);
    } catch (e) {
      setErr(e.message || String(e));
    }
  };

  const saveBookmark = async (lotNo, fields) => {
    try {
      await DB.updateBookmark(lotNo, fields);
      await loadBookmarks();
    } catch (e) {
      setErr(e.message || String(e));
    }
  };

  const saveExternalLot = async (fields) => {
    if (editExternalLot) await DB.updateExternalLot(editExternalLot.id, fields);
    else await DB.addExternalLot(fields);
    await loadExternalLots();
  };

  const removeExternalLot = async (id) => {
    try {
      await DB.removeExternalLot(id);
      await loadExternalLots();
    } catch (e) {
      setErr(e.message || String(e));
    }
  };

  const saveAward = async (fields, id) => {
    let result = null;
    if (id) await DB.updateAwardedLot(id, fields);
    else result = await DB.addAwardedLot(fields);
    await loadAwardedLots();
    return result;
  };

  const removeAward = async (id) => {
    try {
      await DB.removeAwardedLot(id);
      await loadAwardedLots();
    } catch (e) {
      setErr(e.message || String(e));
    }
  };

  const saveLifting = async (fields, id) => {
    if (id) await DB.updateLiftedMaterial(id, fields);
    else await DB.addLiftedMaterial(fields);
    await loadLiftedMaterial();
  };

  const removeLifting = async (id) => {
    try {
      await DB.removeLiftedMaterial(id);
      await loadLiftedMaterial();
    } catch (e) {
      setErr(e.message || String(e));
    }
  };

  const saveSaleOrder = async (fields, id) => {
    if (id) await DB.updateSaleOrder(id, fields);
    else await DB.addSaleOrder(fields);
    await loadSaleOrders();
  };

  const removeSaleOrder = async (id) => {
    try {
      await DB.removeSaleOrder(id);
      await loadSaleOrders();
    } catch (e) {
      setErr(e.message || String(e));
    }
  };

  const jumpToCategory = (catString) => {
    setCategory(catString);
    setSourceFilters(new Set());
    setActiveTab('lots');
  };

  const addKeywordDirect = async (kw) => {
    kw = kw.trim();
    if (!kw) return;
    kw = kw.charAt(0).toUpperCase() + kw.slice(1);
    try {
      await DB.addKeyword(kw);
      await loadKeywords();
    } catch (e) {
      setErr(e.message || String(e));
    }
  };

  const addKeyword = async (e) => {
    e.preventDefault();
    await addKeywordDirect(newKeyword);
    setNewKeyword('');
  };

  const removeKeyword = async (id) => {
    try {
      await DB.removeKeyword(id);
      await loadKeywords();
    } catch (e) {
      setErr(e.message || String(e));
    }
  };

  // Drag-and-drop reorder of the saved-keywords chip row: reorders local
  // state immediately (so the drag feels responsive) and persists the new
  // order in the background. Keyword Watch and the Lots tab's own keyword
  // filter chips both render from this same `keywords` state, so a reorder
  // here is reflected in both without any extra wiring.
  const reorderKeywordsTo = async (draggedId, targetId) => {
    if (draggedId === targetId) return;
    const current = [...keywords];
    const fromIdx = current.findIndex(k => k.id === draggedId);
    const toIdx = current.findIndex(k => k.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const [moved] = current.splice(fromIdx, 1);
    current.splice(toIdx, 0, moved);
    setKeywords(current);
    try {
      await DB.reorderKeywords(current.map(k => k.id));
    } catch (e) {
      setErr(e.message || String(e));
      await loadKeywords();
    }
  };

  const landingItemCount = landingComparison.reduce((n, [, items]) => n + items.length, 0);

  // A small icon per nav tab -- a consistent visual anchor that's faster
  // to spot while scanning the sidebar than reading each label in full,
  // and reinforces which section you're in from muscle memory over time.
  const TABS = [
    { id: 'dashboard', label: 'Dashboard', icon: '📊' },
    { id: 'lots', label: 'Lots', icon: '📦' },
    { id: 'categories', label: 'Categories', icon: '🗂️' },
    { id: 'keywords', label: 'Keyword Watch', icon: '🔎' },
    { id: 'watchlist', label: 'Watchlist', icon: '⭐', count: bookmarks.length },
    { id: 'external', label: 'External Auctions', icon: '🌐', count: externalLots.length },
    { id: 'landing', label: 'Landing Cost', icon: '💰', count: landingItemCount },
    { id: 'awarded', label: 'Awarded Lots', icon: '🏆', count: awardedLots.length },
    { id: 'lifted', label: 'Lifted Material', icon: '🚚', count: liftedMaterial.length },
    { id: 'sales', label: 'Sale Orders', icon: '🧾', count: saleOrders.length },
  ];

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: '-apple-system,Segoe UI,Arial,sans-serif', color: C.txt }}>
      <header className="app-header" style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 22px',
        background: 'linear-gradient(135deg, #ffffff 0%, #f0f4ff 100%)', borderBottom: `1px solid ${C.bdr}`,
      }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 17, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 20 }}>🚂</span> Auction Tracker
          </div>
          <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>
            {latestScan ? (
              <>
                Last scan: {new Date(latestScan.finished_at).toLocaleString()} · {latestScan.total_lots} lots
                {' ('}
                <span style={{ color: C.green, fontWeight: 600 }}>{latestScan.new_count} new</span>
                {', '}
                <span style={{ color: C.amber, fontWeight: 600 }}>{latestScan.updated_count} updated</span>
                {', '}
                <span style={{ color: C.red, fontWeight: 600 }}>{latestScan.expired_count} expired</span>
                {')'}
              </>
            ) : 'No scan data yet'}
          </div>
        </div>
        <button onClick={() => DB.signOut()} style={{ padding: '6px 14px', borderRadius: 6, border: `1px solid ${C.bdr}`, background: '#fff', cursor: 'pointer', fontSize: 12 }}>Sign out</button>
      </header>

      {err && <div style={{ margin: 16, padding: 10, background: '#fef2f2', color: C.red, borderRadius: 6, fontSize: 13 }}>{err}</div>}

      <div className="app-shell" style={{ display: 'flex', alignItems: 'flex-start' }}>
        <nav className="app-nav" style={{ width: 196, flexShrink: 0, borderRight: `1px solid ${C.bdr}`, padding: '16px 0' }}>
          {TABS.map(t => {
            const active = activeTab === t.id;
            return (
              <button key={t.id} className={active ? '' : 'nav-btn'} onClick={() => setActiveTab(t.id)} style={{
                display: 'flex', alignItems: 'center', gap: 9, width: 'calc(100% - 10px)', textAlign: 'left', padding: '9px 16px 9px 17px',
                margin: '1px 0', border: 'none', borderRadius: '0 999px 999px 0',
                background: active ? `${C.blue}14` : 'transparent',
                borderLeft: `3px solid ${active ? C.blue : 'transparent'}`,
                color: active ? C.blue : C.txt, fontWeight: active ? 600 : 400,
                fontSize: 13, cursor: 'pointer',
              }}>
                <span style={{ fontSize: 14, opacity: active ? 1 : 0.75 }}>{t.icon}</span>
                <span style={{ flex: 1 }}>{t.label}</span>
                {t.count !== undefined && (
                  <span style={{
                    fontSize: 10.5, fontWeight: 700, color: active ? '#fff' : C.sub,
                    background: active ? C.blue : C.bdrSoft, borderRadius: 999, padding: '1px 6px', minWidth: 8, textAlign: 'center',
                  }}>
                    {t.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="app-content" style={{ padding: 20, flex: 1, minWidth: 0 }}>
      {activeTab === 'dashboard' && (<>
        <h2 style={{ fontSize: 15, margin: '0 0 10px' }}>Scan status by source</h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 26 }}>
          {['IREPS', 'Matex', 'MSTC'].map(src => {
            const s = latestScans[src];
            return (
              <div key={src} style={{ background: C.surf, borderRadius: 10, border: `1px solid ${C.bdr}`, boxShadow: '0 1px 3px rgba(15,23,42,0.05)', padding: '12px 16px', minWidth: 200, flex: '1 1 200px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <SourceBadge source={src} />
                  <span style={{ fontSize: 11, color: C.sub }}>{s ? new Date(s.finished_at).toLocaleString() : 'No scan data yet'}</span>
                </div>
                {s && (<>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>{s.total_lots} lots</div>
                  <div style={{ fontSize: 11.5 }}>
                    <span style={{ color: C.green, fontWeight: 600 }}>{s.new_count} new</span>
                    {', '}
                    <span style={{ color: C.amber, fontWeight: 600 }}>{s.updated_count} updated</span>
                    {', '}
                    <span style={{ color: C.red, fontWeight: 600 }}>{s.expired_count} expired</span>
                  </div>
                </>)}
              </div>
            );
          })}
        </div>

        <h2 style={{ fontSize: 15, margin: '0 0 10px' }}>New lots matching your keywords</h2>
        <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>Found in the most recent scan — from your saved keywords on the Keyword Watch tab.</div>
        <div style={{ background: C.surf, borderRadius: 10, border: `1px solid ${C.bdr}`, boxShadow: '0 1px 3px rgba(15,23,42,0.05)', overflow: 'auto', marginBottom: 26 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, tableLayout: 'fixed' }}>
            <thead><FullLotColumnsHeader /></thead>
            <tbody>
              {newKeywordMatches.map(row => (
                <FullLotRow key={row.lot_no} row={row} onDetails={() => setDetailLot(row)} keywords={keywords} />
              ))}
              {!newKeywordMatches.length && <tr><td colSpan={10} style={{ ...td, whiteSpace: 'normal', textAlign: 'center', color: C.sub }}>No new lots from the last scan match your saved keywords.</td></tr>}
            </tbody>
          </table>
        </div>

        <h2 style={{ fontSize: 15, margin: '0 0 10px' }}>Upcoming (next 7 days) matching your keywords</h2>
        <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>Keyword matches whose auction falls within the next 7 days, soonest first.</div>
        <div style={{ background: C.surf, borderRadius: 10, border: `1px solid ${C.bdr}`, boxShadow: '0 1px 3px rgba(15,23,42,0.05)', overflow: 'auto', marginBottom: 26 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, tableLayout: 'fixed' }}>
            <thead><FullLotColumnsHeader /></thead>
            <tbody>
              {upcomingKeywordMatches.map(row => (
                <FullLotRow key={row.lot_no} row={row} onDetails={() => setDetailLot(row)} keywords={keywords} />
              ))}
              {!upcomingKeywordMatches.length && <tr><td colSpan={10} style={{ ...td, whiteSpace: 'normal', textAlign: 'center', color: C.sub }}>No keyword matches auctioning in the next 7 days.</td></tr>}
            </tbody>
          </table>
        </div>

        <h2 style={{ fontSize: 15, margin: '0 0 10px' }}>Upcoming auctions you're participating in</h2>
        <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>Watchlist / external lots marked "participating", soonest first.</div>
        <div style={{ background: C.surf, borderRadius: 10, border: `1px solid ${C.bdr}`, boxShadow: '0 1px 3px rgba(15,23,42,0.05)', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, tableLayout: 'fixed' }}>
            <thead>
              <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                <th style={{ ...th, width: '8%' }}>Source</th><th style={{ ...th, width: '14%' }}>Lot No</th><th style={th}>Material Descr.</th>
                <th style={{ ...th, width: '15%' }}>Auction</th><th style={{ ...th, width: '12%' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {upcomingParticipating.map(item => {
                const relistCount = item.kind === 'bookmark' ? item.row.relist_count : 0;
                return (
                  <tr key={item.key} style={{ borderTop: `1px solid ${C.bdr}` }}>
                    <td style={td}><SourceBadge source={item.source} /></td>
                    <td style={td} title={item.lot_no}>{item.lot_no}</td>
                    <td style={{ ...td, whiteSpace: 'normal' }}>
                      {item.material_descr}
                      <KeywordMatchChips row={{ material_descr: item.material_descr, category: item.row.category }} keywords={keywords} />
                    </td>
                    <td style={{ ...td, whiteSpace: 'normal' }}>
                      <div style={{ fontWeight: 700 }}>{item.when}</div>
                      <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginTop: 2, flexWrap: 'wrap' }}>
                        {item.days !== null && (
                          <span style={{ fontSize: 10.5, fontWeight: 700, color: dayBadgeColor(item.days) }}>{formatDaysTo(item.days)}</span>
                        )}
                        {relistCount > 0 && (
                          <span title={relistTooltip(item.row)} style={{
                            fontSize: 10, fontWeight: 700, color: C.amber, background: `${C.amber}1a`,
                            borderRadius: 999, padding: '1px 5px', cursor: 'help',
                          }}>
                            ↻ {relistCount}×
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ ...td, whiteSpace: 'normal' }}>
                      {item.kind === 'bookmark'
                        ? <button onClick={() => setDetailLot(item.row)} style={smallBtn}>Details</button>
                        : <button onClick={() => setEditExternalLot(item.row)} style={smallBtn}>Edit</button>}
                    </td>
                  </tr>
                );
              })}
              {!upcomingParticipating.length && <tr><td colSpan={5} style={{ ...td, whiteSpace: 'normal', textAlign: 'center', color: C.sub }}>Nothing marked "participating" yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </>)}

      {activeTab === 'categories' && (<>
        <h2 style={{ fontSize: 15, margin: '0 0 10px' }}>Categories</h2>
        <div style={{ fontSize: 12, color: C.sub, marginBottom: 10 }}>
          Every kind of material currently active across all sources, grouped into category and sub-category — click one to jump to it on the Lots tab.
        </div>
        <button onClick={loadMaterialSummary} style={smallBtn} disabled={summaryLoading}>
          {summaryLoading ? 'Analysing…' : (categoryTree ? 'Refresh' : 'Analyse all data')}
        </button>
        {summaryErr && <div style={{ fontSize: 12, color: C.red, margin: '10px 0' }}>{summaryErr}</div>}
        {categoryTree && (
          <div style={{ background: C.surf, borderRadius: 10, border: `1px solid ${C.bdr}`, boxShadow: '0 1px 3px rgba(15,23,42,0.05)', marginTop: 14 }}>
            {categoryTree.map(({ name, total, subs }) => {
              const subTotal = subs.reduce((n, [, c]) => n + c, 0);
              const unlabeled = total - subTotal;
              const isOpen = expandedCategory === name;
              return (
                <div key={name} style={{ borderTop: `1px solid ${C.bdr}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 14px' }}>
                    <button onClick={() => setExpandedCategory(isOpen ? null : name)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, textAlign: 'left', flex: 1, padding: 0 }}>
                      {subs.length ? (isOpen ? '▾ ' : '▸ ') : '• '}{name}
                    </button>
                    <span style={{ fontSize: 11.5, color: C.sub, marginRight: 10 }}>{total}</span>
                    <button onClick={() => jumpToCategory(name)} style={smallBtn}>View in Lots</button>
                  </div>
                  {isOpen && subs.length > 0 && (
                    <div style={{ padding: '0 14px 10px 30px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {subs.map(([sub, count]) => (
                        <div key={sub} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5 }}>
                          <span>{sub}</span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ color: C.sub }}>{count}</span>
                            <button onClick={() => jumpToCategory(`${name} - ${sub}`)} style={smallBtn}>View</button>
                          </span>
                        </div>
                      ))}
                      {unlabeled > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: C.sub, fontStyle: 'italic' }}>
                          <span>(no sub-category)</span><span>{unlabeled}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </>)}

      {activeTab === 'keywords' && (<>
        <h2 style={{ fontSize: 15, margin: '0 0 10px' }}>Keyword Watch</h2>
        <div style={{ fontSize: 12, color: C.sub, marginBottom: 10 }}>
          Saved permanently to your account — these keywords persist across sign-ins and devices, and the matches below are re-checked after every scan.
        </div>
        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6 }}>Saved keywords</div>
        <form onSubmit={addKeyword} style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {keywords.map(k => {
            const bySource = keywordSourceCounts[k.keyword] || {};
            const total = Object.values(bySource).reduce((a, b) => a + b, 0);
            const breakdown = Object.entries(bySource).map(([s, n]) => `${s} ${n}`).join(' · ');
            return (
              <span key={k.id} draggable title={breakdown || 'No matches yet'}
                onDragStart={() => { draggedKeywordIdRef.current = k.id; setDraggedKeywordId(k.id); }}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); reorderKeywordsTo(draggedKeywordIdRef.current, k.id); draggedKeywordIdRef.current = null; setDraggedKeywordId(null); }}
                onDragEnd={() => { draggedKeywordIdRef.current = null; setDraggedKeywordId(null); }}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, padding: '4px 6px 4px 8px', borderRadius: 999,
                  background: `${C.blue}1a`, color: C.blue, cursor: 'grab', opacity: draggedKeywordId === k.id ? 0.4 : 1,
                }}>
                <span style={{ color: C.sub, fontSize: 10 }}>⠿</span>
                {k.keyword}
                <span style={{ fontSize: 10.5, fontWeight: 700, color: '#fff', background: C.blue, borderRadius: 999, padding: '1px 6px' }}>{total}</span>
                <button type="button" onClick={() => removeKeyword(k.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.blue, fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
              </span>
            );
          })}
          <input value={newKeyword} onChange={e => setNewKeyword(e.target.value)} placeholder="Add a keyword to watch…"
            style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${C.bdr}`, fontSize: 12.5, width: 200 }} />
          <button type="submit" style={smallBtn}>Add</button>
        </form>
        {keywords.length > 0 && (
          <div style={{ fontSize: 11, color: C.sub, marginBottom: 16 }}>
            Hover a keyword for its per-source breakdown (the badge is the total across all sources). Drag a keyword (⠿) to reorder.
          </div>
        )}

        <KeywordSuggestions existingKeywords={keywords} onAdd={addKeywordDirect}
          summary={materialSummary} loading={summaryLoading} err={summaryErr} onLoad={loadMaterialSummary} />

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6, marginTop: 18 }}>Matches</div>
        {keywords.length > 0 && (
          <div style={{ background: C.surf, borderRadius: 10, border: `1px solid ${C.bdr}`, boxShadow: '0 1px 3px rgba(15,23,42,0.05)', overflow: 'auto', marginBottom: 26 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, tableLayout: 'fixed' }}>
              <thead><FullLotColumnsHeader /></thead>
              <tbody>
                {keywordMatches.map(row => (
                  <FullLotRow key={row.lot_no} row={row} onDetails={() => setDetailLot(row)} keywords={keywords} />
                ))}
                {!keywordMatches.length && <tr><td colSpan={10} style={{ ...td, whiteSpace: 'normal', textAlign: 'center', color: C.sub }}>No active lots match your keywords yet.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </>)}

      {activeTab === 'lots' && (<>
        {/* Layer 1: Source -- multi-select; "All sources" clears the set.
            Counts reflect the current search/category/status/keyword
            filters but never sourceFilters itself, so each chip reads "how
            many lots would show if I picked this one". */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
          {[{ id: '', label: 'All sources' }, { id: 'IREPS', label: 'IREPS' }, { id: 'Matex', label: 'Matex' }, { id: 'MSTC', label: 'MSTC' }].map(s => {
            const active = s.id === '' ? sourceFilters.size === 0 : sourceFilters.has(s.id);
            const count = s.id === '' ? Object.values(sourceCounts).reduce((a, b) => a + b, 0) : sourceCounts[s.id];
            return (
              <button key={s.id || 'all'} onClick={() => {
                if (s.id === '') setSourceFilters(new Set()); else toggleInSet(setSourceFilters, s.id);
                setCategory('');
              }}
                style={{
                  padding: '6px 14px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                  border: `1px solid ${active ? C.blue : C.bdr}`,
                  background: active ? C.blue : '#fff',
                  color: active ? '#fff' : C.txt,
                }}>
                {s.label}{count !== undefined ? ` (${count})` : ''}
              </button>
            );
          })}
        </div>

        {/* Layer 2: Keyword -- multi-select, independent of the free-text
            search box below (the two combine with AND: e.g. search
            "sambalpur" + keyword tab "60kg" narrows to lots matching both).
            The row itself (and its "+") always shows, even with zero saved
            keywords yet, so adding your first one doesn't require a trip to
            Keyword Watch; the "All"/"All Keywords"/per-keyword chips only
            make sense once at least one keyword exists. */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: C.sub, fontWeight: 600 }}>Keyword:</span>
          {keywords.length > 0 && <>
            <button onClick={() => setSelectedKeywordTabs(new Set())}
              style={{
                padding: '5px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                border: `1px solid ${!selectedKeywordTabs.size ? C.amber : C.bdr}`,
                background: !selectedKeywordTabs.size ? `${C.amber}1a` : '#fff',
                color: !selectedKeywordTabs.size ? C.amber : C.txt,
              }}>
              All
            </button>
            <button onClick={() => setSelectedKeywordTabs(new Set(keywords.map(k => k.keyword)))}
              style={{
                padding: '5px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                border: `1px solid ${selectedKeywordTabs.size === keywords.length ? C.amber : C.bdr}`,
                background: selectedKeywordTabs.size === keywords.length ? `${C.amber}1a` : '#fff',
                color: selectedKeywordTabs.size === keywords.length ? C.amber : C.txt,
              }}>
              All Keywords
            </button>
            {keywords.map(k => {
              const isActive = selectedKeywordTabs.has(k.keyword);
              const bySource = keywordSourceCounts[k.keyword] || {};
              const total = Object.values(bySource).reduce((a, b) => a + b, 0);
              return (
                <button key={k.id} onClick={() => toggleInSet(setSelectedKeywordTabs, k.keyword)}
                  style={{
                    padding: '5px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    border: `1px solid ${isActive ? C.amber : C.bdr}`,
                    background: isActive ? `${C.amber}1a` : '#fff',
                    color: isActive ? C.amber : C.txt,
                  }}>
                  {k.keyword} ({total})
                </button>
              );
            })}
          </>}
          <button type="button" onClick={() => setShowInlineKeywordAdd(o => !o)}
            title="Add a new keyword without leaving Lots"
            style={{
              padding: '5px 10px', borderRadius: 999, fontSize: 13, fontWeight: 700, cursor: 'pointer',
              border: `1px dashed ${C.blue}`, background: '#fff', color: C.blue, lineHeight: 1,
            }}>
            +
          </button>
        </div>

        {/* Inline "add a keyword" panel -- same suggestion engine as
            Keyword Watch, opened in place so adding a keyword doesn't
            require switching tabs and losing your current filters. */}
        {showInlineKeywordAdd && (
          <div style={{ background: C.surf, borderRadius: 10, border: `1px solid ${C.bdr}`, padding: 14, marginBottom: 14 }}>
            <form onSubmit={addKeyword} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input value={newKeyword} onChange={e => setNewKeyword(e.target.value)} placeholder="Add a keyword to watch…" autoFocus
                style={{ flex: 1, maxWidth: 280, padding: '6px 10px', borderRadius: 6, border: `1px solid ${C.bdr}`, fontSize: 12.5 }} />
              <button type="submit" style={smallBtn}>Add</button>
              <button type="button" onClick={() => setShowInlineKeywordAdd(false)} style={smallBtn}>Close</button>
            </form>
            <KeywordSuggestions existingKeywords={keywords} onAdd={addKeywordDirect}
              summary={materialSummary} loading={summaryLoading} err={summaryErr} onLoad={loadMaterialSummary} />
          </div>
        )}

        {/* Layer 3: Division -- railway zone (IREPS), city (MSTC), state
            (Matex); multi-select. Only shown once at least one specific
            Source is picked (mixing divisions across all three at once
            isn't meaningful). */}
        {sourceFilters.size > 0 && divisions.length > 0 && (() => {
          const soleSource = sourceFilters.size === 1 ? [...sourceFilters][0] : null;
          const label = soleSource === 'MSTC' ? 'City:' : soleSource === 'Matex' ? 'State:' : 'Division:';
          return (
            <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: C.sub, fontWeight: 600 }}>{label}</span>
              <button onClick={() => { setDivisionFilters(new Set()); setSubDivisionFilters(new Set()); }}
                style={{
                  padding: '5px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  border: `1px solid ${!divisionFilters.size ? C.green : C.bdr}`,
                  background: !divisionFilters.size ? `${C.green}1a` : '#fff', color: !divisionFilters.size ? C.green : C.txt,
                }}>
                All ({lots.length})
              </button>
              {divisions.map(([name, count]) => {
                const fullName = describeRailway(name);
                return (
                  <button key={name} onClick={() => { toggleInSet(setDivisionFilters, name); setSubDivisionFilters(new Set()); }}
                    title={fullName !== name ? fullName : undefined}
                    style={{
                      padding: '5px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      border: `1px solid ${divisionFilters.has(name) ? C.green : C.bdr}`,
                      background: divisionFilters.has(name) ? `${C.green}1a` : '#fff', color: divisionFilters.has(name) ? C.green : C.txt,
                    }}>
                    {name} ({count})
                  </button>
                );
              })}
            </div>
          );
        })()}

        {/* Layer 4: Sub-Division -- IREPS depots within the selected
            railway(s); multi-select. */}
        {divisionFilters.size > 0 && subDivisions.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: C.sub, fontWeight: 600 }}>Sub-Division:</span>
            <button onClick={() => setSubDivisionFilters(new Set())}
              style={{
                padding: '5px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                border: `1px solid ${!subDivisionFilters.size ? C.red : C.bdr}`,
                background: !subDivisionFilters.size ? `${C.red}1a` : '#fff', color: !subDivisionFilters.size ? C.red : C.txt,
              }}>
              All ({withinDivision.length})
            </button>
            {subDivisions.map(([name, count]) => (
              <button key={name} onClick={() => toggleInSet(setSubDivisionFilters, name)}
                style={{
                  padding: '5px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  border: `1px solid ${subDivisionFilters.has(name) ? C.red : C.bdr}`,
                  background: subDivisionFilters.has(name) ? `${C.red}1a` : '#fff', color: subDivisionFilters.has(name) ? C.red : C.txt,
                }}>
                {name} ({count})
              </button>
            ))}
          </div>
        )}

        <div className="filters-bar" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <input placeholder="Search keyword(s), comma-separated…" value={search} onChange={e => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 220, padding: '8px 10px', borderRadius: 6, border: `1px solid ${C.bdr}`, fontSize: 13 }} />
          <select value={category} onChange={e => setCategory(e.target.value)} style={{ padding: '8px 10px', borderRadius: 6, border: `1px solid ${C.bdr}`, fontSize: 13 }}>
            <option value="">All categories</option>
            {Object.keys(categoryCounts).map(c => <option key={c} value={c}>{c} ({categoryCounts[c]})</option>)}
          </select>
          <div style={{ display: 'flex', gap: 4 }}>
            {[{ id: 'active', label: 'Active' }, { id: 'expired', label: 'Expired' }, { id: '', label: 'All' }].map(s => {
              const active = status === s.id;
              const count = s.id === '' ? (statusCounts.active || 0) + (statusCounts.expired || 0) : statusCounts[s.id];
              return (
                <button key={s.id || 'all-status'} onClick={() => setStatus(s.id)}
                  style={{
                    padding: '8px 12px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    border: `1px solid ${active ? C.blue : C.bdr}`,
                    background: active ? C.blue : '#fff', color: active ? '#fff' : C.txt,
                  }}>
                  {s.label}{count !== undefined ? ` (${count})` : ''}
                </button>
              );
            })}
          </div>
          <select value={changeTag} onChange={e => setChangeTag(e.target.value)} style={{ padding: '8px 10px', borderRadius: 6, border: `1px solid ${C.bdr}`, fontSize: 13 }}>
            <option value="">Any change</option>
            <option value="new">New</option>
            <option value="updated">Updated</option>
            <option value="unchanged">Unchanged</option>
          </select>
          <button onClick={loadLots} style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: C.blue, color: '#fff', fontSize: 13, cursor: 'pointer' }}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button disabled={!selected.size} onClick={() => printRows('Selected Lots', LOT_PRINT_COLUMNS, visibleLots.filter(l => selected.has(l.lot_no)))}
            style={{ padding: '8px 16px', borderRadius: 6, border: `1px solid ${C.bdr}`, background: '#fff', fontSize: 13, cursor: selected.size ? 'pointer' : 'default', opacity: selected.size ? 1 : 0.5 }}>
            Print selected ({selected.size})
          </button>
          <button disabled={!visibleLots.length} onClick={() => printRows('All Lots', LOT_PRINT_COLUMNS, visibleLots)}
            style={{ padding: '8px 16px', borderRadius: 6, border: `1px solid ${C.bdr}`, background: '#fff', fontSize: 13, cursor: visibleLots.length ? 'pointer' : 'default', opacity: visibleLots.length ? 1 : 0.5 }}>
            Print all ({visibleLots.length})
          </button>
          <ColumnPicker visible={visibleCols} onChange={setVisibleCols} columns={sourceColumns} />
        </div>

        {loading && <div className="progress-bar"><div className="progress-bar-fill" /></div>}

        <div style={{ background: C.surf, borderRadius: 10, border: `1px solid ${C.bdr}`, boxShadow: '0 1px 3px rgba(15,23,42,0.05)', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, tableLayout: 'fixed' }}>
            <thead>
              <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                <th style={{ ...th, width: '3%' }}></th><th style={{ ...th, width: '3%' }}>★</th>
                {sourceColumns.some(c => c.id === 'source') && visibleCols.source && <th style={{ ...th, width: '7%' }}>Source</th>}
                {sourceColumns.some(c => c.id === 'railway') && visibleCols.railway && <th style={{ ...th, width: '7%' }}>Railway</th>}
                {sourceColumns.some(c => c.id === 'depot') && visibleCols.depot && <th style={{ ...th, width: '7%' }}>{sourceFilters.size === 1 && [...sourceFilters][0] === 'MSTC' ? 'Office' : 'Depot'}</th>}
                {visibleCols.location && <th style={{ ...th, width: '8%' }}>Location</th>}
                <th style={{ ...th, width: '8%' }}>Lot No</th>
                {visibleCols.qty_unit && <th style={{ ...th, width: '5%' }}>Qty/Unit</th>}
                {visibleCols.category && <th style={{ ...th, width: '6%' }}>Category</th>}
                {visibleCols.material_descr && <th style={th}>Material Descr.</th>}
                {visibleCols.next_auction && <th style={{ ...th, width: '8%' }}>Next Auction</th>}
                {visibleCols.tag && <th style={{ ...th, width: '3%' }}>Tag</th>}
                <th style={{ ...th, width: '8%' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleLots.map(row => (
                <tr key={row.lot_no} style={{ borderTop: `1px solid ${C.bdr}` }}>
                  <td style={td}><input type="checkbox" checked={selected.has(row.lot_no)} onChange={() => toggleSelect(row.lot_no)} /></td>
                  <td style={td}>
                    <button onClick={() => toggleBookmark(row.lot_no)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, color: bookmarkedSet.has(row.lot_no) ? C.amber : C.bdr }}>★</button>
                  </td>
                  {sourceColumns.some(c => c.id === 'source') && visibleCols.source && <td style={td}><SourceBadge source={row.source} /></td>}
                  {sourceColumns.some(c => c.id === 'railway') && visibleCols.railway && <td style={td}>{row.railway}</td>}
                  {sourceColumns.some(c => c.id === 'depot') && visibleCols.depot && <td style={td}>{row.depot}</td>}
                  {visibleCols.location && <td style={{ ...td, whiteSpace: 'normal' }} title={row.change_tag === 'updated' ? changeTooltip(row) : undefined}>{row.location}</td>}
                  <td style={td} title={row.lot_no}>{row.lot_no}</td>
                  {visibleCols.qty_unit && <td style={td}>{row.qty_unit}</td>}
                  {visibleCols.category && <td style={td} title={row.category}>{row.category}</td>}
                  {visibleCols.material_descr && (
                    <td style={{ ...td, whiteSpace: 'normal' }}>
                      {row.material_descr}
                      <KeywordMatchChips row={row} keywords={keywords} />
                    </td>
                  )}
                  {visibleCols.next_auction && <NextAuctionCell row={row} />}
                  {visibleCols.tag && (
                    <td style={td}>
                      {row.change_tag && (
                        <span title={row.change_tag === 'updated' ? changeTooltip(row) : undefined}>
                          <Badge text={row.change_tag} color={TAG_COLOR[row.change_tag] || C.sub} />
                        </span>
                      )}
                    </td>
                  )}
                  <td style={{ ...td, whiteSpace: 'normal' }}>
                    <button onClick={() => setDetailLot(row)} style={smallBtn}>Details</button>{' '}
                    <button onClick={() => downloadCataloguePdf(row)} style={smallBtn}>PDF</button>
                  </td>
                </tr>
              ))}
              {!visibleLots.length && !loading && <tr><td colSpan={4 + sourceColumns.filter(c => visibleCols[c.id] !== false).length} style={{ ...td, textAlign: 'center', color: C.sub }}>No lots match these filters.</td></tr>}
            </tbody>
          </table>
        </div>
      </>)}

      {activeTab === 'watchlist' && (<>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, margin: '0 0 10px' }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>Watchlist ({bookmarks.length})</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button disabled={!selectedWatch.size} onClick={() => printRows('Selected Watchlist Lots', WATCHLIST_PRINT_COLUMNS, bookmarks.filter(b => selectedWatch.has(b.lot_no)))}
              style={{ padding: '8px 16px', borderRadius: 6, border: `1px solid ${C.bdr}`, background: '#fff', fontSize: 13, cursor: selectedWatch.size ? 'pointer' : 'default', opacity: selectedWatch.size ? 1 : 0.5 }}>
              Print selected ({selectedWatch.size})
            </button>
            <button disabled={!bookmarks.length} onClick={() => printRows('Watchlist', WATCHLIST_PRINT_COLUMNS, bookmarks)}
              style={{ padding: '8px 16px', borderRadius: 6, border: `1px solid ${C.bdr}`, background: '#fff', fontSize: 13, cursor: bookmarks.length ? 'pointer' : 'default', opacity: bookmarks.length ? 1 : 0.5 }}>
              Print all ({bookmarks.length})
            </button>
          </div>
        </div>
        <div style={{ background: C.surf, borderRadius: 10, border: `1px solid ${C.bdr}`, boxShadow: '0 1px 3px rgba(15,23,42,0.05)', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                <th style={th}>
                  <input type="checkbox" checked={bookmarks.length > 0 && selectedWatch.size === bookmarks.length}
                    onChange={() => setSelectedWatch(s => s.size === bookmarks.length ? new Set() : new Set(bookmarks.map(b => b.lot_no)))} />
                </th>
                <th style={th}>Source</th><th style={th}>Railway</th><th style={th}>Depot</th><th style={th}>Lot No</th>
                <th style={th}>Location</th><th style={th}>Qty/Unit</th><th style={th}>Category</th>
                <th style={th}>Material Descr.</th><th style={th}>Next Auction</th>
                <th style={th}>Status</th><th style={th}>Team</th><th style={th}>Target Rate</th>
                <th style={th}>Landing Cost</th><th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {bookmarks.map(row => (
                <WatchlistRow key={row.lot_no} row={row}
                  selected={selectedWatch.has(row.lot_no)}
                  onToggleSelect={() => setSelectedWatch(s => { const n = new Set(s); n.has(row.lot_no) ? n.delete(row.lot_no) : n.add(row.lot_no); return n; })}
                  onRemove={() => toggleBookmark(row.lot_no)} onDetails={() => setDetailLot(row)} onEdit={() => setEditWatchRow(row)} keywords={keywords}
                  onAward={() => setEditAward({ source: 'IREPS', lot_no: row.lot_no, title: row.material_descr, location: row.location, category: row.category, qty_unit: row.qty_unit, sold_rate: row.sold_rate })} />
              ))}
              {!bookmarks.length && <tr><td colSpan={15} style={{ ...td, textAlign: 'center', color: C.sub }}>Nothing on your watchlist yet — star a lot above.</td></tr>}
            </tbody>
          </table>
        </div>
      </>)}

      {activeTab === 'external' && (<>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0 0 10px' }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>External Auctions ({externalLots.length})</h2>
          <button onClick={() => setEditExternalLot(null)} style={smallBtn}>Add External Lot</button>
        </div>
        <div style={{ background: C.surf, borderRadius: 10, border: `1px solid ${C.bdr}`, boxShadow: '0 1px 3px rgba(15,23,42,0.05)', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                <th style={th}>Source</th><th style={th}>Lot No</th><th style={th}>Title</th>
                <th style={th}>Auction Date</th><th style={th}>Status</th><th style={th}>Target Rate</th>
                <th style={th}>Landing Cost</th><th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {externalLots.map(row => (
                <ExternalLotRow key={row.id} row={row} onRemove={() => removeExternalLot(row.id)} onEdit={() => setEditExternalLot(row)}
                  onAward={() => setEditAward({ source: row.source, lot_no: row.external_lot_no, title: row.title, location: row.location, category: row.category, qty_unit: row.qty_unit, sold_rate: row.sold_rate })} />
              ))}
              {!externalLots.length && <tr><td colSpan={8} style={{ ...td, textAlign: 'center', color: C.sub }}>Nothing tracked from MSTC/MJunction/other sites yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </>)}

      {activeTab === 'landing' && (<>
        <h2 style={{ fontSize: 15, margin: '0 0 10px' }}>Landing Cost Comparison</h2>
        <div style={{ background: C.surf, borderRadius: 10, border: `1px solid ${C.bdr}`, boxShadow: '0 1px 3px rgba(15,23,42,0.05)', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                <th style={th}>Category</th><th style={th}>Source</th><th style={th}>Lot No</th>
                <th style={th}>Material Descr.</th><th style={th}>Target Rate</th><th style={th}>Lifting</th>
                <th style={th}>Transport</th><th style={th}>Landing Cost</th>
              </tr>
            </thead>
            <tbody>
              {landingComparison.map(([cat, items]) => items.map(({ key, source, row, cost }, i) => (
                <tr key={key} style={{ borderTop: `1px solid ${C.bdr}` }}>
                  <td style={{ ...td, fontWeight: i === 0 ? 600 : 400, color: i === 0 ? C.txt : C.sub }}>{i === 0 ? cat : ''}</td>
                  <td style={td}>{source}</td>
                  <td style={td}>{row.lot_no || row.external_lot_no || '-'}</td>
                  <td style={{ ...clipTd, maxWidth: 260 }} title={row.material_descr || row.title}>{row.material_descr || row.title}</td>
                  <td style={td}>{row.target_rate || '-'}</td>
                  <td style={td}>{row.lifting_expense || '-'}</td>
                  <td style={td}>{row.transport_expense || '-'}</td>
                  <td style={{ ...td, fontWeight: i === 0 && cost !== null ? 700 : 400, color: i === 0 && cost !== null ? C.green : C.txt }}>
                    {cost === null ? '-' : cost.toFixed(2)}
                  </td>
                </tr>
              )))}
              {!landingItemCount && <tr><td colSpan={8} style={{ ...td, textAlign: 'center', color: C.sub }}>Nothing to compare yet — add a target rate to a Watchlist or External Auction lot.</td></tr>}
            </tbody>
          </table>
        </div>
      </>)}

      {activeTab === 'awarded' && (<>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0 0 10px' }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>Awarded Lots ({awardedLots.length})</h2>
          <button onClick={() => setEditAward(null)} style={smallBtn}>Add Awarded Lot</button>
        </div>
        <div style={{ background: C.surf, borderRadius: 10, border: `1px solid ${C.bdr}`, boxShadow: '0 1px 3px rgba(15,23,42,0.05)', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                <th style={th}>Source</th><th style={th}>Lot No</th><th style={th}>Title</th>
                <th style={th}>Status</th><th style={th}>Payment</th><th style={th}>Qty Lifted / Balance</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {awardedLots.map(row => (
                <AwardedLotRow key={row.id} row={row} onRemove={() => removeAward(row.id)} onEdit={() => setEditAward(row)}
                  onLogLifting={() => setEditLifting({ award_id: row.id, lot_no: row.lot_no, title: row.title })}
                  onSell={() => setEditSaleOrder({ award_id: row.id, lot_no: row.lot_no, title: row.title, qty: row.qty_lifted || row.qty_unit, rate: row.sold_rate })} />
              ))}
              {!awardedLots.length && <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: C.sub }}>No lots awarded yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </>)}

      {activeTab === 'lifted' && (<>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0 0 10px' }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>Lifted Material ({liftedMaterial.length})</h2>
          <button onClick={() => setEditLifting(null)} style={smallBtn}>Log Lifting</button>
        </div>
        <div style={{ background: C.surf, borderRadius: 10, border: `1px solid ${C.bdr}`, boxShadow: '0 1px 3px rgba(15,23,42,0.05)', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                <th style={th}>Date</th><th style={th}>Lot No</th><th style={th}>Title</th>
                <th style={th}>Qty</th><th style={th}>Vehicle No</th><th style={th}>Transporter</th>
                <th style={th}>Gate Pass No</th><th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {liftedMaterial.map(row => (
                <LiftedMaterialRow key={row.id} row={row} onRemove={() => removeLifting(row.id)} onEdit={() => setEditLifting(row)} />
              ))}
              {!liftedMaterial.length && <tr><td colSpan={8} style={{ ...td, textAlign: 'center', color: C.sub }}>No lifting logged yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </>)}

      {activeTab === 'sales' && (<>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0 0 10px' }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>Sale Orders ({saleOrders.length})</h2>
          <button onClick={() => setEditSaleOrder(null)} style={smallBtn}>Add Sale Order</button>
        </div>
        <div style={{ background: C.surf, borderRadius: 10, border: `1px solid ${C.bdr}`, boxShadow: '0 1px 3px rgba(15,23,42,0.05)', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                <th style={th}>Order No</th><th style={th}>Buyer</th><th style={th}>Title</th>
                <th style={th}>Qty</th><th style={th}>Total</th><th style={th}>Status</th>
                <th style={th}>Payment</th><th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {saleOrders.map(row => (
                <SaleOrderRow key={row.id} row={row} onRemove={() => removeSaleOrder(row.id)} onEdit={() => setEditSaleOrder(row)} />
              ))}
              {!saleOrders.length && <tr><td colSpan={8} style={{ ...td, textAlign: 'center', color: C.sub }}>No sale orders yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </>)}
        </div>
      </div>
      {detailLot && <LotDetailModal row={detailLot} onClose={() => setDetailLot(null)} />}
      {editWatchRow && <WatchlistEditModal row={editWatchRow} onSave={saveBookmark} onClose={() => setEditWatchRow(null)} />}
      {editExternalLot !== undefined && <ExternalLotModal row={editExternalLot} onSave={saveExternalLot} onClose={() => setEditExternalLot(undefined)} />}
      {editAward !== undefined && <AwardedLotModal row={editAward} onSave={saveAward} onClose={() => setEditAward(undefined)} />}
      {editLifting !== undefined && <LiftedMaterialModal row={editLifting} onSave={saveLifting} onClose={() => setEditLifting(undefined)} />}
      {editSaleOrder !== undefined && <SaleOrderModal row={editSaleOrder} onSave={saveSaleOrder} onClose={() => setEditSaleOrder(undefined)} />}
    </div>
  );
}

function SaleOrderRow({ row, onRemove, onEdit }) {
  return (
    <tr style={{ borderTop: `1px solid ${C.bdr}` }}>
      <td style={td}>{row.order_no || '-'}</td>
      <td style={td}>{row.buyer_name}</td>
      <td style={{ ...td, maxWidth: 220 }}>{row.title}</td>
      <td style={td}>{row.qty || '-'}</td>
      <td style={td}>{row.total_amount || '-'}</td>
      <td style={td}><Badge text={row.status} color={SALE_ORDER_STATUS_COLOR[row.status] || C.sub} /></td>
      <td style={td}>{row.payment_status}{row.amount_received ? ` · ${row.amount_received}` : ''}</td>
      <td style={td}>
        <button onClick={onEdit} style={smallBtn}>Edit</button>{' '}
        <button onClick={onRemove} style={{ ...smallBtn, color: C.red }}>Remove</button>
      </td>
    </tr>
  );
}

function AwardedLotRow({ row, onRemove, onEdit, onLogLifting, onSell }) {
  return (
    <tr style={{ borderTop: `1px solid ${C.bdr}` }}>
      <td style={td}><SourceBadge source={row.source} /></td>
      <td style={td}>{row.lot_no || '-'}</td>
      <td style={{ ...td, maxWidth: 240 }}>{row.title}</td>
      <td style={td}><Badge text={row.status.replace('_', ' ')} color={AWARD_STATUS_COLOR[row.status] || C.sub} /></td>
      <td style={td}>{row.payment_status}{row.amount_paid ? ` · ${row.amount_paid}` : ''}</td>
      <td style={td}>{row.qty_lifted || '-'} / {row.qty_balance || '-'}</td>
      <td style={td}>
        <button onClick={onEdit} style={smallBtn}>Edit</button>{' '}
        <button onClick={onLogLifting} style={smallBtn}>Log Lifting</button>{' '}
        <button onClick={onSell} style={smallBtn}>Sell</button>{' '}
        <button onClick={onRemove} style={{ ...smallBtn, color: C.red }}>Remove</button>
      </td>
    </tr>
  );
}

function LiftedMaterialRow({ row, onRemove, onEdit }) {
  return (
    <tr style={{ borderTop: `1px solid ${C.bdr}` }}>
      <td style={td}>{row.lifted_date || '-'}</td>
      <td style={td}>{row.lot_no || '-'}</td>
      <td style={{ ...td, maxWidth: 240 }}>{row.title}</td>
      <td style={td}>{row.qty || '-'}</td>
      <td style={td}>{row.vehicle_no || '-'}</td>
      <td style={td}>{row.transporter || '-'}</td>
      <td style={td}>{row.gate_pass_no || '-'}</td>
      <td style={td}>
        <button onClick={onEdit} style={smallBtn}>Edit</button>{' '}
        <button onClick={onRemove} style={{ ...smallBtn, color: C.red }}>Remove</button>
      </td>
    </tr>
  );
}

function ExternalLotRow({ row, onRemove, onEdit, onAward }) {
  const cost = landingCost(row);
  return (
    <tr style={{ borderTop: `1px solid ${C.bdr}` }}>
      <td style={td}><SourceBadge source={row.source} /></td>
      <td style={td}>{row.external_lot_no || '-'}</td>
      <td style={{ ...td, maxWidth: 240 }}>
        {row.source_url ? (
          <a href={row.source_url} target="_blank" rel="noopener noreferrer" style={{ color: C.blue }}>{row.title} ↗</a>
        ) : row.title}
      </td>
      <td style={td}>{row.auction_date || '-'}</td>
      <td style={td}><Badge text={row.watch_status || 'watching'} color={WATCH_STATUS_COLOR[row.watch_status] || C.sub} /></td>
      <td style={td}>{row.target_rate || '-'}</td>
      <td style={td}>{cost === null ? '-' : cost.toFixed(2)}</td>
      <td style={td}>
        <button onClick={onEdit} style={smallBtn}>Edit</button>{' '}
        {row.watch_status === 'won' && <>
          <button onClick={onAward} style={{ ...smallBtn, color: C.green, borderColor: C.green }}>Mark Awarded</button>{' '}
        </>}
        <button onClick={onRemove} style={{ ...smallBtn, color: C.red }}>Remove</button>
      </td>
    </tr>
  );
}

function WatchlistRow({ row, selected, onToggleSelect, onRemove, onDetails, onEdit, onAward, keywords }) {
  const cost = landingCost(row);
  return (
    <tr style={{ borderTop: `1px solid ${C.bdr}` }}>
      <td style={td}><input type="checkbox" checked={!!selected} onChange={onToggleSelect} /></td>
      <td style={td}><SourceBadge source={row.source} /></td>
      <td style={td}>{row.railway}</td>
      <td style={td}>{row.depot}</td>
      <td style={td}>{row.lot_no}</td>
      <td style={{ ...td, whiteSpace: 'normal' }}>{row.location}</td>
      <td style={td}>{row.qty_unit}</td>
      <td style={td}>{row.category}</td>
      <td style={{ ...td, whiteSpace: 'normal', maxWidth: 240 }}>
        {row.material_descr}
        <KeywordMatchChips row={row} keywords={keywords} />
      </td>
      <NextAuctionCell row={row} />
      <td style={td}><Badge text={row.watch_status || 'watching'} color={WATCH_STATUS_COLOR[row.watch_status] || C.sub} /></td>
      <td style={td}>{row.team || '-'}</td>
      <td style={td}>{row.target_rate || '-'}</td>
      <td style={td}>{cost === null ? '-' : cost.toFixed(2)}</td>
      <td style={td}>
        <button onClick={onEdit} style={smallBtn}>Edit</button>{' '}
        <button onClick={onDetails} style={smallBtn}>Details</button>{' '}
        {row.watch_status === 'won' && <>
          <button onClick={onAward} style={{ ...smallBtn, color: C.green, borderColor: C.green }}>Mark Awarded</button>{' '}
        </>}
        <button onClick={onRemove} style={{ ...smallBtn, color: C.red }}>Remove</button>
      </td>
    </tr>
  );
}

// Base cell styles default to single-line ellipsis truncation (full text
// still available via the native title tooltip): harmless on a table left
// at its default table-layout (columns just size to content as before,
// so nothing visually changes there), and what stops a wide column's text
// from forcing the table wider than its container -- and the page into a
// horizontal scrollbar -- on every table below that opts into
// tableLayout:'fixed' with explicit per-column widths.
const th = { padding: '8px 10px', fontSize: 11, fontWeight: 600, color: C.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const td = { padding: '7px 10px', verticalAlign: 'top', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
// Kept as an alias (same styling as td now) so existing call sites that
// pass a maxWidth override alongside it keep working unchanged.
const clipTd = td;

// How urgently an auction's own date deserves attention: today/tomorrow in
// red, within the week in amber, otherwise green: this is what makes the
// date "evident" at a glance rather than just more plain text in a row of
// plain text.
function dayBadgeColor(days) {
  if (days === null || days === undefined || days < 0) return C.sub;
  if (days <= 1) return C.red;
  if (days <= 7) return C.amber;
  return C.green;
}

// How many times this exact lot has been relisted (its own next_auction
// date moved to a new value because it didn't sell last time), per
// lots.relist_count -- a persistent counter maintained server-side by
// autoscan.py/matex_autoscan.py/mstc_import.py, since change_detail itself
// only ever holds the single most recent diff.
function relistTooltip(row) {
  if (!row.relist_count) return undefined;
  const times = `${row.relist_count} time${row.relist_count > 1 ? 's' : ''}`;
  const prevDate = row.change_detail?.['Next Auction']?.from;
  return prevDate
    ? `Relisted ${times} so far -- didn't sell at its previous auction (${prevDate})`
    : `Relisted ${times} so far -- didn't sell at a previous auction`;
}

// The Next Auction cell shared by every table that lists lots: the date
// itself bolded (so it doesn't get lost among plainer columns), a
// color-coded "days to go" badge right under it, and -- when this lot has
// ever been relisted -- a "↻ Nx" badge with the relist history on hover.
function NextAuctionCell({ row }) {
  const days = daysToAuction(row.next_auction);
  return (
    <td style={{ ...td, whiteSpace: 'normal' }}>
      <div style={{ fontWeight: 700 }}>{row.next_auction || '-'}</div>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginTop: 2, flexWrap: 'wrap' }}>
        {days !== null && (
          <span style={{ fontSize: 10.5, fontWeight: 700, color: dayBadgeColor(days) }}>{formatDaysTo(days)}</span>
        )}
        {row.relist_count > 0 && (
          <span title={relistTooltip(row)} style={{
            fontSize: 10, fontWeight: 700, color: C.amber, background: `${C.amber}1a`,
            borderRadius: 999, padding: '1px 5px', cursor: 'help',
          }}>
            ↻ {row.relist_count}×
          </span>
        )}
      </div>
    </td>
  );
}

// Shared header/row for the handful of places that show a lot in the same
// full column set as the Lots table itself (Dashboard's keyword-match
// lists, Keyword Watch's own matches) -- keeps those in parity with Lots
// without re-typing the same columns in each spot. Fixed-width + ellipsis
// everywhere so none of these ever need a horizontal scrollbar either.
function FullLotColumnsHeader() {
  return (
    <tr style={{ background: '#fafafa', textAlign: 'left' }}>
      <th style={{ ...th, width: '8%' }}>Source</th><th style={{ ...th, width: '8%' }}>Railway</th>
      <th style={{ ...th, width: '8%' }}>Depot</th><th style={{ ...th, width: '11%' }}>Location</th>
      <th style={{ ...th, width: '9%' }}>Lot No</th><th style={{ ...th, width: '5%' }}>Qty/Unit</th>
      <th style={{ ...th, width: '7%' }}>Category</th>
      <th style={th}>Material Descr.</th><th style={{ ...th, width: '9%' }}>Next Auction</th>
      <th style={{ ...th, width: '8%' }}>Actions</th>
    </tr>
  );
}

function FullLotRow({ row, onDetails, keywords }) {
  return (
    <tr style={{ borderTop: `1px solid ${C.bdr}` }}>
      <td style={td}><SourceBadge source={row.source} /></td>
      <td style={td}>{row.railway}</td>
      <td style={td}>{row.depot}</td>
      <td style={{ ...td, whiteSpace: 'normal' }}>{row.location}</td>
      <td style={td} title={row.lot_no}>{row.lot_no}</td>
      <td style={td}>{row.qty_unit}</td>
      <td style={td} title={row.category}>{row.category}</td>
      <td style={{ ...td, whiteSpace: 'normal' }}>
        {row.material_descr}
        <KeywordMatchChips row={row} keywords={keywords} />
      </td>
      <NextAuctionCell row={row} />
      <td style={{ ...td, whiteSpace: 'normal' }}><button onClick={onDetails} style={smallBtn}>Details</button></td>
    </tr>
  );
}

// ── Lots column visibility (per-browser, via localStorage) ─────────────
const LOT_COLUMNS = [
  { id: 'source', label: 'Source' },
  { id: 'railway', label: 'Railway' },
  { id: 'depot', label: 'Depot' },
  { id: 'location', label: 'Location' },
  { id: 'qty_unit', label: 'Qty/Unit' },
  { id: 'category', label: 'Category' },
  { id: 'material_descr', label: 'Material Descr.' },
  { id: 'next_auction', label: 'Next Auction' },
  { id: 'tag', label: 'Tag' },
];
const LOT_COLUMNS_STORAGE_KEY = 'auctionTracker.lotsVisibleColumns';

// Not every column means something for every source -- Railway/Depot are
// IREPS-specific (blank for Matex/MSTC; MSTC's own "depot" field actually
// holds its office code, so that one stays relevant there).
function columnsForSource(source) {
  if (source === 'Matex') return LOT_COLUMNS.filter(c => c.id !== 'railway' && c.id !== 'depot');
  if (source === 'MSTC') return LOT_COLUMNS.filter(c => c.id !== 'railway');
  return LOT_COLUMNS; // IREPS or All (mixed) -- show everything
}

// Multi-select version: with exactly one source chosen, defer to the
// single-source rules above; with none (All) or more than one selected at
// once, show every column (same as "All" always did).
function columnsForSources(sources) {
  if (sources.size === 1) return columnsForSource([...sources][0]);
  return LOT_COLUMNS;
}

// Layer 3 of the Lots tab's Source > Keyword > Division (> Sub-Division)
// drill-down: for IREPS this is the railway zone (depot is the finer
// Sub-Division layer below it); MSTC has no such two-level structure, so
// its office code is deciphered to the full city name and used directly;
// Matex only ever gives us a state.
function divisionOf(row) {
  if (row.source === 'Matex') return row.location || '';
  if (row.source === 'MSTC') return CITY_CODES[row.depot] || row.depot || '';
  return row.railway || ''; // IREPS
}

// Layer 4, IREPS only: the depot within whichever railway (Division) was
// picked above.
function subDivisionOf(row) {
  if (row.source && row.source !== 'IREPS') return '';
  return row.depot || '';
}

function loadVisibleCols() {
  const defaults = Object.fromEntries(LOT_COLUMNS.map(c => [c.id, true]));
  try {
    const saved = JSON.parse(localStorage.getItem(LOT_COLUMNS_STORAGE_KEY) || '{}');
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

function ColumnPicker({ visible, onChange, columns = LOT_COLUMNS }) {
  const [open, setOpen] = useState(false);
  const toggle = (id) => {
    const next = { ...visible, [id]: !visible[id] };
    onChange(next);
    try { localStorage.setItem(LOT_COLUMNS_STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} style={{ padding: '8px 16px', borderRadius: 6, border: `1px solid ${C.bdr}`, background: '#fff', fontSize: 13, cursor: 'pointer' }}>
        Columns ▾
      </button>
      {open && (
        <div onMouseLeave={() => setOpen(false)} style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: C.surf, border: `1px solid ${C.bdr}`, borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,0.12)', padding: 10, zIndex: 20, minWidth: 170 }}>
          {columns.map(c => (
            <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, padding: '4px 2px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={visible[c.id] !== false} onChange={() => toggle(c.id)} />
              {c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// Generic filler words that show up in almost every lot regardless of what
// it actually is, so they'd never make a useful keyword on their own --
// plus units/measures, which are numerous but not materials.
const KEYWORD_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'etc', 'all', 'lot', 'lots', 'items', 'item',
  'scrap', 'as', 'per', 'is', 'at', 'in', 'on', 'to', 'of', 'a', 'an', 'no', 'nos',
  'qty', 'unit', 'units', 'kg', 'kgs', 'mt', 'ltr', 'ltrs', 'nos', 'total', 'approx',
  'basis', 'where', 'various', 'other', 'others', 'material', 'materials', 'description',
  'annexure', 'please', 'refer', 'see', 'note', 'qty.', 'misc', 'miscellaneous', 'used',
  'old', 'new', 'type', 'types', 'size', 'sizes', 'kind', 'kinds', 'piece', 'pieces',
  'depot', 'non', 'consisting', 'sort', 'mtr', 'mtrs', 'cond', 'stock', 'including',
  'total', 'approximately', 'approx', 'nearly', 'about', 'more', 'less', 'than',
  // Boilerplate/fragments/test-data artifacts, not material names.
  'created', 'selenium', 'actual', 'lying', 'cut', 'auction', 'matex', 'details',
  'cat', 'iii', 'unsv', 'comp', 'structure', 'scraps', 'tms', 'sale', 'intimation',
  'letter', 'annexure', 'click', 'here', 'enclosed', 'format', 'rate', 'quantity',
  'given', 'without', 'above', 'remarks', 'descriptionmaterial',
]);

// A curated vocabulary of specific Indian Railways / industrial scrap
// material and equipment terms, checked for actual presence in the data
// (any count >= 1) rather than ranked by frequency -- some of these (e.g.
// "fish plate", "trolley") are real, specific things worth watching for
// even when rare, and would never surface in a frequency-ranked top-N
// list crowded out by far more common words.
const KNOWN_DOMAIN_TERMS = [
  'wagon', 'trolley', 'fish plate', 'melting', 'bogie', 'axle', 'girder', 'sleeper',
  'coupling', 'spring', 'bearing', 'insulator', 'conductor', 'transformer', 'bolt', 'nut',
  'washer', 'pipe', 'tube', 'sheet', 'coil', 'ingot', 'billet', 'rod', 'mesh', 'chassis',
  'wheel', 'bush', 'gear', 'motor', 'generator', 'compressor', 'pump', 'valve', 'relay',
  'fuse', 'breaker', 'panel', 'cabinet', 'container', 'cylinder', 'filter', 'radiator',
  'condenser', 'fan', 'gasket', 'clutch', 'brake', 'shaft', 'crank', 'piston', 'buffer',
  'coupler', 'crossing', 'signal', 'locomotive', 'coach', 'points', 'girders', 'angle',
  'channel', 'plate', 'chair', 'clip', 'pad', 'bridge', 'crane', 'hoist', 'forklift',
  'ladder', 'switchgear', 'alternator', 'armature', 'winding', 'stator', 'rotor', 'guide',
  'roller', 'bracket', 'clamp', 'lock', 'grill',
];

function suggestKnownTermsFrom(rows, existingKeywords) {
  const existing = new Set(existingKeywords.map(k => k.toLowerCase()));
  const terms = KNOWN_DOMAIN_TERMS.filter(t => !existing.has(t));
  const counts = Object.fromEntries(terms.map(t => [t, 0]));
  for (const row of rows) {
    const text = `${row.material_descr || ''} ${row.category || ''}`.toLowerCase();
    for (const term of terms) {
      if (text.includes(term)) counts[term]++;
    }
  }
  return Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
}

// Suggests candidate keywords by frequency-counting words in material
// descriptions across every active lot in every source, excluding generic
// filler and whatever's already saved -- so the list is specific terms
// (material/equipment names) that actually distinguish one lot from
// another, not noise that's in every row anyway.
function suggestKeywordsFrom(rows, existingKeywords, limit = 60) {
  const existing = new Set(existingKeywords.map(k => k.toLowerCase()));
  const freq = {};
  for (const row of rows) {
    const text = `${row.material_descr || ''} ${row.category || ''}`.toLowerCase();
    // Split on real word boundaries, then reject (not truncate) anything
    // outside 3-15 letters -- a few test-data rows have run-on placeholder
    // text ("DescriptionMaterial DescriptionMaterial...") with no word
    // breaks at all, which would otherwise match as one long "word" (or,
    // worse, get chopped into equally meaningless fixed-length fragments).
    const words = (text.match(/[a-z]+/g) || []).filter(w => w.length >= 3 && w.length <= 15);
    const seenInRow = new Set();
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const wIsNoise = KEYWORD_STOPWORDS.has(w);
      if (!wIsNoise && !existing.has(w) && !seenInRow.has(w)) {
        seenInRow.add(w);
        freq[w] = (freq[w] || 0) + 1;
      }
      // Also count two-word phrases (e.g. "fish plate") -- a single
      // material name is often two words, and neither half alone would
      // necessarily be frequent enough to surface on its own.
      if (!wIsNoise && i + 1 < words.length) {
        const w2 = words[i + 1];
        if (!KEYWORD_STOPWORDS.has(w2)) {
          const bigram = `${w} ${w2}`;
          if (!existing.has(bigram) && !seenInRow.has(bigram)) {
            seenInRow.add(bigram);
            freq[bigram] = (freq[bigram] || 0) + 1;
          }
        }
      }
    }
  }
  return Object.entries(freq)
    .filter(([term, n]) => term.includes(' ') ? n >= 3 : n >= 2) // bigrams need a bit more support to avoid noise
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function KeywordSuggestions({ existingKeywords, onAdd, summary, loading, err, onLoad }) {
  const existingList = useMemo(() => existingKeywords.map(k => k.keyword), [existingKeywords]);
  const suggestions = useMemo(
    () => summary ? suggestKeywordsFrom(summary, existingList) : null,
    [summary, existingList]
  );
  const knownTerms = useMemo(
    () => summary ? suggestKnownTermsFrom(summary, existingList) : null,
    [summary, existingList]
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 12.5 }}>Suggested keywords</div>
        <button onClick={onLoad} style={smallBtn} disabled={loading}>
          {loading ? 'Analysing…' : (summary ? 'Refresh suggestions' : 'Suggest keywords')}
        </button>
      </div>
      {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 8 }}>{err}</div>}

      {knownTerms && knownTerms.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: C.sub, marginBottom: 6 }}>
            Railway/scrap-specific terms found in your data (checked for any presence, not just the most frequent):
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {knownTerms.map(([word, count]) => (
              <button key={word} onClick={() => onAdd(word)}
                style={{ fontSize: 12, padding: '4px 10px', borderRadius: 999, border: `1px dashed ${C.green}`, background: '#fff', color: C.green, cursor: 'pointer' }}>
                + {word} ({count})
              </button>
            ))}
          </div>
        </div>
      )}

      {suggestions && (
        suggestions.length ? (
          <div>
            <div style={{ fontSize: 11, color: C.sub, marginBottom: 6 }}>Most frequent other terms across your data:</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {suggestions.map(([word, count]) => (
                <button key={word} onClick={() => onAdd(word)}
                  style={{ fontSize: 12, padding: '4px 10px', borderRadius: 999, border: `1px dashed ${C.blue}`, background: '#fff', color: C.blue, cursor: 'pointer' }}>
                  + {word} ({count})
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: C.sub }}>No new suggestions found — your saved keywords already cover the common terms.</div>
        )
      )}
    </div>
  );
}

const smallBtn = { padding: '4px 9px', borderRadius: 5, border: `1px solid ${C.bdr}`, background: '#fff', fontSize: 11, cursor: 'pointer' };
