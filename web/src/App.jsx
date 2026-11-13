// IREPS Tracker — web dashboard (Supabase-backed, static, deployed to
// GitHub Pages). Same feature set as the local Flask app (webapp.py /
// templates/index.html): browse/search/filter scanned lots, bookmark lots
// with your own notes/rates, print selected lots, and download a
// locally-generated PDF catalogue per lot. Scanning itself stays a local,
// manually-triggered Python step (see ../push_to_supabase.py) — this app
// only reads/writes Supabase.
import { useEffect, useMemo, useState, useCallback } from 'react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { supabase } from './supabaseClient.js';
import * as DB from './dataClient.js';
import { describeLocation } from './codes.js';
import { daysToAuction, formatDaysTo } from './dates.js';

const IREPS_LOT_URL = (lotId) => `https://ireps.gov.in/eps/auction/viewLotAnon.do?lotId=${encodeURIComponent(lotId)}`;

const C = {
  bg: '#f7f7f8', surf: '#fff', bdr: '#e4e4e7', txt: '#18181b', sub: '#71717a',
  blue: '#2563eb', green: '#16a34a', red: '#dc2626', amber: '#d97706',
};

function Badge({ text, color }) {
  return <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 999, background: `${color}1a`, color }}>{text}</span>;
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

function parseNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
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
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: C.bg }}>
      <form onSubmit={submit} style={{ width: 340, background: C.surf, borderRadius: 12, border: `1px solid ${C.bdr}`, padding: 28, boxShadow: '0 4px 20px rgba(0,0,0,0.06)' }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🚂</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.txt }}>IREPS Tracker</div>
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

  const location = describeLocation(row.railway, row.depot);
  autoTable(doc, {
    startY: 24,
    theme: 'plain',
    styles: { fontSize: 9, cellPadding: 2 },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 40 } },
    body: [
      ['Railway / Depot', `${row.railway} / ${row.depot}`],
      ['Location', location],
      ['Category', row.category],
      ['Qty / Unit', row.qty_unit],
      ['Min Increment', row.min_incr],
      ['Publish Date', row.publish_date],
      ['Next Auction', row.next_auction || '-'],
    ],
  });

  const detail = row.detail || {};
  const detailRows = Object.entries(detail);
  if (detailRows.length) {
    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 8,
      head: [['Field', 'Value']],
      body: detailRows,
      styles: { fontSize: 8, cellPadding: 3 },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 55 } },
      headStyles: { fillColor: [37, 99, 235] },
    });
  } else {
    doc.setFontSize(9);
    doc.setTextColor(150);
    doc.text('No detail fetched yet for this lot — bookmark it, then re-run push_to_supabase.py to fetch full details.', 14, doc.lastAutoTable.finalY + 10);
  }

  const finalY = (doc.lastAutoTable && doc.lastAutoTable.finalY) || 40;
  doc.setFontSize(7);
  doc.setTextColor(150);
  doc.text('Generated locally from publicly scraped IREPS lot data. This is not the official IREPS catalogue document.', 14, finalY + 10);

  doc.save(`lot_${row.lot_no}_catalogue.pdf`);
}

function printSelected(rows) {
  const win = window.open('', '_blank');
  const trs = rows.map(r => `
    <tr>
      <td>${r.railway}</td><td>${r.depot}</td><td>${describeLocation(r.railway, r.depot)}</td>
      <td>${r.lot_no}</td><td>${r.qty_unit}</td><td>${r.category}</td><td>${r.min_incr}</td>
      <td>${r.material_descr}</td><td>${r.publish_date}</td><td>${r.next_auction || ''}</td>
    </tr>`).join('');
  win.document.write(`<!DOCTYPE html><html><head><title>Selected Lots</title><style>
    body{font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#222;margin:1.5rem}
    h1{font-size:1.2rem} table{border-collapse:collapse;width:100%;font-size:0.8rem}
    th,td{border:1px solid #999;padding:0.4rem 0.6rem;text-align:left;vertical-align:top}
    th{background:#eee}
    </style></head><body>
    <h1>Selected Lots (${rows.length})</h1>
    <table><tr><th>Railway</th><th>Depot</th><th>Location</th><th>Lot No</th><th>Qty/Unit</th>
    <th>Category</th><th>Min Incr</th><th>Material Descr.</th><th>Publish Date</th><th>Next Auction</th></tr>
    ${trs}</table>
    <script>window.onload = () => window.print();</script>
    </body></html>`);
  win.document.close();
}

function printLotDetail(row) {
  const summary = [
    ['Railway / Depot', `${row.railway} / ${row.depot}`],
    ['Location', describeLocation(row.railway, row.depot)],
    ['Category', row.category],
    ['Qty / Unit', row.qty_unit],
    ['Min Increment', row.min_incr],
    ['Publish Date', row.publish_date],
    ['Next Auction', row.next_auction || '-'],
  ];
  const detailRows = Object.entries(row.detail || {});
  const rowsHtml = (rows) => rows.map(([k, v]) => `<tr><td><b>${k}</b></td><td>${v}</td></tr>`).join('');
  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>Lot ${row.lot_no}</title><style>
    body{font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#222;margin:1.5rem}
    h1{font-size:1.2rem} table{border-collapse:collapse;width:100%;font-size:0.85rem;margin-bottom:1rem}
    td{border:1px solid #999;padding:0.4rem 0.6rem;text-align:left;vertical-align:top}
    </style></head><body>
    <h1>Lot ${row.lot_no} - ${row.material_descr}</h1>
    <table>${rowsHtml(summary)}</table>
    ${detailRows.length ? `<table>${rowsHtml(detailRows)}</table>` : '<p><i>No extended detail synced yet.</i></p>'}
    <script>window.onload = () => window.print();</script>
    </body></html>`);
  win.document.close();
}

// ── Lot detail modal ────────────────────────────────────────────────────
function LotDetailModal({ row, onClose }) {
  if (!row) return null;
  const summary = [
    ['Railway / Depot', `${row.railway} / ${row.depot}`],
    ['Location', describeLocation(row.railway, row.depot)],
    ['Category', row.category],
    ['Qty / Unit', row.qty_unit],
    ['Min Increment', row.min_incr],
    ['Publish Date', row.publish_date],
    ['Next Auction', row.next_auction || '-'],
  ];
  const detailRows = Object.entries(row.detail || {});
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surf, borderRadius: 10, width: 560, maxHeight: '85vh', overflow: 'auto', padding: 22, boxShadow: '0 10px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Lot {row.lot_no}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: C.sub, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 14 }}>{row.material_descr}</div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, marginBottom: 14 }}>
          <tbody>
            {summary.map(([k, v]) => (
              <tr key={k} style={{ borderTop: `1px solid ${C.bdr}` }}>
                <td style={{ ...td, fontWeight: 600, width: 140 }}>{k}</td><td style={td}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6 }}>Extended detail</div>
        {detailRows.length ? (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 14 }}>
            <tbody>
              {detailRows.map(([k, v]) => (
                <tr key={k} style={{ borderTop: `1px solid ${C.bdr}` }}>
                  <td style={{ ...td, fontWeight: 600, width: 140 }}>{k}</td><td style={td}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 14 }}>
            No extended detail synced yet — star this lot and it'll be fetched on the next daily autoscan.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a href={IREPS_LOT_URL(row.lot_id)} target="_blank" rel="noopener noreferrer" style={{ ...smallBtn, textDecoration: 'none', display: 'inline-block' }}>
            View on IREPS ↗
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
      <div onClick={e => e.stopPropagation()} style={{ background: C.surf, borderRadius: 10, width: 560, maxHeight: '85vh', overflow: 'auto', padding: 22, boxShadow: '0 10px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Watchlist · Lot {row.lot_no}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: C.sub, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 16 }}>{row.material_descr}</div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 12, alignItems: 'end', marginBottom: 14 }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 6 }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 18 }}>
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
      <div onClick={e => e.stopPropagation()} style={{ background: C.surf, borderRadius: 10, width: 560, maxHeight: '85vh', overflow: 'auto', padding: 22, boxShadow: '0 10px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{isNew ? 'Add External Lot' : 'Edit External Lot'}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: C.sub, lineHeight: 1 }}>×</button>
        </div>

        {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 12 }}>{err}</div>}

        <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>Lot details</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <label style={field}>
            <span style={label}>Location</span>
            <input value={f.location} onChange={set('location')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Category</span>
            <input value={f.category} onChange={set('category')} style={modalInput} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
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

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 12, alignItems: 'end', marginBottom: 14 }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 6 }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 18 }}>
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
      <div onClick={e => e.stopPropagation()} style={{ background: C.surf, borderRadius: 10, width: 560, maxHeight: '85vh', overflow: 'auto', padding: 22, boxShadow: '0 10px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{isNew ? 'Add Awarded Lot' : 'Edit Awarded Lot'}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: C.sub, lineHeight: 1 }}>×</button>
        </div>

        {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 12 }}>{err}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <label style={field}>
            <span style={label}>Location</span>
            <input value={f.location} onChange={set('location')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Category</span>
            <input value={f.category} onChange={set('category')} style={modalInput} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
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

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
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
      <div onClick={e => e.stopPropagation()} style={{ background: C.surf, borderRadius: 10, width: 480, maxHeight: '85vh', overflow: 'auto', padding: 22, boxShadow: '0 10px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{isNew ? 'Log Lifting' : 'Edit Lifting Entry'}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: C.sub, lineHeight: 1 }}>×</button>
        </div>

        {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 12 }}>{err}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <label style={field}>
            <span style={label}>Qty lifted</span>
            <input value={f.qty} onChange={set('qty')} style={modalInput} />
          </label>
          <label style={field}>
            <span style={label}>Vehicle no</span>
            <input value={f.vehicle_no} onChange={set('vehicle_no')} style={modalInput} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
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

// ── Main app ─────────────────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(undefined); // undefined = checking, null = signed out
  const [lots, setLots] = useState([]);
  const [bookmarks, setBookmarks] = useState([]);
  const [bookmarkedSet, setBookmarkedSet] = useState(new Set());
  const [categoryCounts, setCategoryCounts] = useState({});
  const [latestScan, setLatestScan] = useState(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('active');
  const [changeTag, setChangeTag] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [keywords, setKeywords] = useState([]);
  const [keywordMatches, setKeywordMatches] = useState([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [detailLot, setDetailLot] = useState(null);
  const [editWatchRow, setEditWatchRow] = useState(null);
  const [externalLots, setExternalLots] = useState([]);
  const [editExternalLot, setEditExternalLot] = useState(undefined); // undefined = modal closed, null = new
  const [awardedLots, setAwardedLots] = useState([]);
  const [editAward, setEditAward] = useState(undefined); // undefined = modal closed, null = new
  const [liftedMaterial, setLiftedMaterial] = useState([]);
  const [editLifting, setEditLifting] = useState(undefined); // undefined = modal closed, null = new

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

  useEffect(() => {
    if (!supabase) { setSession(null); return; }
    DB.getSession().then(setSession);
    return DB.onAuthChange(setSession);
  }, []);

  const loadLots = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const [rows, counts, bmSet] = await Promise.all([
        DB.fetchLots({ search, category, changeTag, status }),
        DB.fetchCategoryCounts(),
        DB.fetchBookmarkedLotNos(),
      ]);
      setLots(rows.map(r => ({ ...r, location: describeLocation(r.railway, r.depot) })));
      setCategoryCounts(counts);
      setBookmarkedSet(bmSet);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [search, category, changeTag, status]);

  const loadBookmarks = useCallback(async () => {
    try {
      const rows = await DB.fetchBookmarks();
      setBookmarks(rows.map(r => ({ ...r, location: describeLocation(r.railway, r.depot) })));
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

  useEffect(() => {
    if (session) {
      loadLots();
      loadBookmarks();
      loadKeywords();
      loadExternalLots();
      loadAwardedLots();
      loadLiftedMaterial();
      DB.fetchLatestScan().then(setLatestScan).catch(() => {});
    }
  }, [session, loadLots, loadBookmarks, loadKeywords, loadExternalLots, loadAwardedLots, loadLiftedMaterial]);

  useEffect(() => {
    if (!session || !keywords.length) { setKeywordMatches([]); return; }
    DB.fetchKeywordMatches(keywords.map(k => k.keyword))
      .then(rows => setKeywordMatches(rows.map(r => ({ ...r, location: describeLocation(r.railway, r.depot) }))))
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

  const addKeyword = async (e) => {
    e.preventDefault();
    const kw = newKeyword.trim();
    if (!kw) return;
    try {
      await DB.addKeyword(kw);
      setNewKeyword('');
      await loadKeywords();
    } catch (e) {
      setErr(e.message || String(e));
    }
  };

  const removeKeyword = async (id) => {
    try {
      await DB.removeKeyword(id);
      await loadKeywords();
    } catch (e) {
      setErr(e.message || String(e));
    }
  };

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: '-apple-system,Segoe UI,Arial,sans-serif', color: C.txt }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 22px', background: C.surf, borderBottom: `1px solid ${C.bdr}` }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>🚂 IREPS Tracker</div>
          <div style={{ fontSize: 11, color: C.sub }}>
            {latestScan ? `Last scan: ${new Date(latestScan.finished_at).toLocaleString()} · ${latestScan.total_lots} lots (${latestScan.new_count} new, ${latestScan.updated_count} updated, ${latestScan.expired_count} expired)` : 'No scan data yet'}
          </div>
        </div>
        <button onClick={() => DB.signOut()} style={{ padding: '6px 14px', borderRadius: 6, border: `1px solid ${C.bdr}`, background: '#fff', cursor: 'pointer', fontSize: 12 }}>Sign out</button>
      </header>

      {err && <div style={{ margin: 16, padding: 10, background: '#fef2f2', color: C.red, borderRadius: 6, fontSize: 13 }}>{err}</div>}

      <div style={{ padding: 20 }}>
        <h2 style={{ fontSize: 15, margin: '0 0 10px' }}>Keyword Watch</h2>
        <form onSubmit={addKeyword} style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {keywords.map(k => (
            <span key={k.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, padding: '4px 6px 4px 10px', borderRadius: 999, background: `${C.blue}1a`, color: C.blue }}>
              {k.keyword}
              <button type="button" onClick={() => removeKeyword(k.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.blue, fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
            </span>
          ))}
          <input value={newKeyword} onChange={e => setNewKeyword(e.target.value)} placeholder="Add a keyword to watch…"
            style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${C.bdr}`, fontSize: 12.5, width: 200 }} />
          <button type="submit" style={smallBtn}>Add</button>
        </form>

        {keywords.length > 0 && (
          <div style={{ background: C.surf, borderRadius: 8, border: `1px solid ${C.bdr}`, overflow: 'auto', marginBottom: 26 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                  <th style={th}>Lot No</th><th style={th}>Location</th><th style={th}>Category</th>
                  <th style={th}>Material Descr.</th><th style={th}>Next Auction</th><th style={th}>Days To</th><th style={th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {keywordMatches.map(row => (
                  <tr key={row.lot_no} style={{ borderTop: `1px solid ${C.bdr}` }}>
                    <td style={td}>{row.lot_no}</td>
                    <td style={td}>{row.location}</td>
                    <td style={td}>{row.category}</td>
                    <td style={{ ...td, maxWidth: 320 }}>{row.material_descr}</td>
                    <td style={td}>{row.next_auction}</td>
                    <td style={td}>{formatDaysTo(daysToAuction(row.next_auction))}</td>
                    <td style={td}><button onClick={() => setDetailLot(row)} style={smallBtn}>Details</button></td>
                  </tr>
                ))}
                {!keywordMatches.length && <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: C.sub }}>No active lots match your keywords yet.</td></tr>}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <input placeholder="Search keyword(s), comma-separated…" value={search} onChange={e => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 220, padding: '8px 10px', borderRadius: 6, border: `1px solid ${C.bdr}`, fontSize: 13 }} />
          <select value={category} onChange={e => setCategory(e.target.value)} style={{ padding: '8px 10px', borderRadius: 6, border: `1px solid ${C.bdr}`, fontSize: 13 }}>
            <option value="">All categories</option>
            {Object.keys(categoryCounts).map(c => <option key={c} value={c}>{c} ({categoryCounts[c]})</option>)}
          </select>
          <select value={status} onChange={e => setStatus(e.target.value)} style={{ padding: '8px 10px', borderRadius: 6, border: `1px solid ${C.bdr}`, fontSize: 13 }}>
            <option value="active">Active</option>
            <option value="expired">Expired</option>
            <option value="">All</option>
          </select>
          <select value={changeTag} onChange={e => setChangeTag(e.target.value)} style={{ padding: '8px 10px', borderRadius: 6, border: `1px solid ${C.bdr}`, fontSize: 13 }}>
            <option value="">Any change</option>
            <option value="new">New</option>
            <option value="updated">Updated</option>
            <option value="unchanged">Unchanged</option>
          </select>
          <button onClick={loadLots} style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: C.blue, color: '#fff', fontSize: 13, cursor: 'pointer' }}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button disabled={!selected.size} onClick={() => printSelected(lots.filter(l => selected.has(l.lot_no)))}
            style={{ padding: '8px 16px', borderRadius: 6, border: `1px solid ${C.bdr}`, background: '#fff', fontSize: 13, cursor: selected.size ? 'pointer' : 'default', opacity: selected.size ? 1 : 0.5 }}>
            Print selected ({selected.size})
          </button>
        </div>

        <div style={{ background: C.surf, borderRadius: 8, border: `1px solid ${C.bdr}`, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                <th style={th}></th><th style={th}>★</th><th style={th}>Railway</th><th style={th}>Depot</th>
                <th style={th}>Location</th><th style={th}>Lot No</th><th style={th}>Qty/Unit</th>
                <th style={th}>Category</th><th style={th}>Material Descr.</th><th style={th}>Publish Date</th>
                <th style={th}>Next Auction</th><th style={th}>Tag</th><th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {lots.map(row => (
                <tr key={row.lot_no} style={{ borderTop: `1px solid ${C.bdr}` }}>
                  <td style={td}><input type="checkbox" checked={selected.has(row.lot_no)} onChange={() => toggleSelect(row.lot_no)} /></td>
                  <td style={td}>
                    <button onClick={() => toggleBookmark(row.lot_no)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, color: bookmarkedSet.has(row.lot_no) ? C.amber : C.bdr }}>★</button>
                  </td>
                  <td style={td}>{row.railway}</td>
                  <td style={td}>{row.depot}</td>
                  <td style={td}>{row.location}</td>
                  <td style={td}>{row.lot_no}</td>
                  <td style={td}>{row.qty_unit}</td>
                  <td style={td}>{row.category}</td>
                  <td style={{ ...td, maxWidth: 320 }}>{row.material_descr}</td>
                  <td style={td}>{row.publish_date}</td>
                  <td style={td}>{row.next_auction}</td>
                  <td style={td}>{row.change_tag && <Badge text={row.change_tag} color={TAG_COLOR[row.change_tag] || C.sub} />}</td>
                  <td style={td}>
                    <button onClick={() => setDetailLot(row)} style={smallBtn}>Details</button>{' '}
                    <button onClick={() => downloadCataloguePdf(row)} style={smallBtn}>PDF</button>
                  </td>
                </tr>
              ))}
              {!lots.length && !loading && <tr><td colSpan={13} style={{ ...td, textAlign: 'center', color: C.sub }}>No lots match these filters.</td></tr>}
            </tbody>
          </table>
        </div>

        <h2 style={{ fontSize: 15, margin: '26px 0 10px' }}>Watchlist ({bookmarks.length})</h2>
        <div style={{ background: C.surf, borderRadius: 8, border: `1px solid ${C.bdr}`, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                <th style={th}>Lot No</th><th style={th}>Location</th><th style={th}>Material Descr.</th>
                <th style={th}>Status</th><th style={th}>Team</th><th style={th}>Target Rate</th>
                <th style={th}>Landing Cost</th><th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {bookmarks.map(row => (
                <WatchlistRow key={row.lot_no} row={row} onRemove={() => toggleBookmark(row.lot_no)} onDetails={() => setDetailLot(row)} onEdit={() => setEditWatchRow(row)}
                  onAward={() => setEditAward({ source: 'IREPS', lot_no: row.lot_no, title: row.material_descr, location: row.location, category: row.category, qty_unit: row.qty_unit, sold_rate: row.sold_rate })} />
              ))}
              {!bookmarks.length && <tr><td colSpan={8} style={{ ...td, textAlign: 'center', color: C.sub }}>Nothing on your watchlist yet — star a lot above.</td></tr>}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '26px 0 10px' }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>External Auctions ({externalLots.length})</h2>
          <button onClick={() => setEditExternalLot(null)} style={smallBtn}>Add External Lot</button>
        </div>
        <div style={{ background: C.surf, borderRadius: 8, border: `1px solid ${C.bdr}`, overflow: 'auto' }}>
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

        {(bookmarks.length > 0 || externalLots.length > 0) && (
          <>
            <h2 style={{ fontSize: 15, margin: '26px 0 10px' }}>Landing Cost Comparison</h2>
            <div style={{ background: C.surf, borderRadius: 8, border: `1px solid ${C.bdr}`, overflow: 'auto' }}>
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
                      <td style={{ ...td, maxWidth: 260 }}>{row.material_descr || row.title}</td>
                      <td style={td}>{row.target_rate || '-'}</td>
                      <td style={td}>{row.lifting_expense || '-'}</td>
                      <td style={td}>{row.transport_expense || '-'}</td>
                      <td style={{ ...td, fontWeight: i === 0 && cost !== null ? 700 : 400, color: i === 0 && cost !== null ? C.green : C.txt }}>
                        {cost === null ? '-' : cost.toFixed(2)}
                      </td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '26px 0 10px' }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>Awarded Lots ({awardedLots.length})</h2>
          <button onClick={() => setEditAward(null)} style={smallBtn}>Add Awarded Lot</button>
        </div>
        <div style={{ background: C.surf, borderRadius: 8, border: `1px solid ${C.bdr}`, overflow: 'auto' }}>
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
                  onLogLifting={() => setEditLifting({ award_id: row.id, lot_no: row.lot_no, title: row.title })} />
              ))}
              {!awardedLots.length && <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: C.sub }}>No lots awarded yet.</td></tr>}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '26px 0 10px' }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>Lifted Material ({liftedMaterial.length})</h2>
          <button onClick={() => setEditLifting(null)} style={smallBtn}>Log Lifting</button>
        </div>
        <div style={{ background: C.surf, borderRadius: 8, border: `1px solid ${C.bdr}`, overflow: 'auto' }}>
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
      </div>
      {detailLot && <LotDetailModal row={detailLot} onClose={() => setDetailLot(null)} />}
      {editWatchRow && <WatchlistEditModal row={editWatchRow} onSave={saveBookmark} onClose={() => setEditWatchRow(null)} />}
      {editExternalLot !== undefined && <ExternalLotModal row={editExternalLot} onSave={saveExternalLot} onClose={() => setEditExternalLot(undefined)} />}
      {editAward !== undefined && <AwardedLotModal row={editAward} onSave={saveAward} onClose={() => setEditAward(undefined)} />}
      {editLifting !== undefined && <LiftedMaterialModal row={editLifting} onSave={saveLifting} onClose={() => setEditLifting(undefined)} />}
    </div>
  );
}

function AwardedLotRow({ row, onRemove, onEdit, onLogLifting }) {
  return (
    <tr style={{ borderTop: `1px solid ${C.bdr}` }}>
      <td style={td}>{row.source}</td>
      <td style={td}>{row.lot_no || '-'}</td>
      <td style={{ ...td, maxWidth: 240 }}>{row.title}</td>
      <td style={td}><Badge text={row.status.replace('_', ' ')} color={AWARD_STATUS_COLOR[row.status] || C.sub} /></td>
      <td style={td}>{row.payment_status}{row.amount_paid ? ` · ${row.amount_paid}` : ''}</td>
      <td style={td}>{row.qty_lifted || '-'} / {row.qty_balance || '-'}</td>
      <td style={td}>
        <button onClick={onEdit} style={smallBtn}>Edit</button>{' '}
        <button onClick={onLogLifting} style={smallBtn}>Log Lifting</button>{' '}
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
      <td style={td}>{row.source}</td>
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

function WatchlistRow({ row, onRemove, onDetails, onEdit, onAward }) {
  const cost = landingCost(row);
  return (
    <tr style={{ borderTop: `1px solid ${C.bdr}` }}>
      <td style={td}>{row.lot_no}</td>
      <td style={td}>{row.location}</td>
      <td style={{ ...td, maxWidth: 240 }}>{row.material_descr}</td>
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

const th = { padding: '8px 10px', fontSize: 11, fontWeight: 600, color: C.sub, whiteSpace: 'nowrap' };
const td = { padding: '7px 10px', verticalAlign: 'top' };
const smallBtn = { padding: '4px 9px', borderRadius: 5, border: `1px solid ${C.bdr}`, background: '#fff', fontSize: 11, cursor: 'pointer' };
