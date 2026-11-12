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

const C = {
  bg: '#f7f7f8', surf: '#fff', bdr: '#e4e4e7', txt: '#18181b', sub: '#71717a',
  blue: '#2563eb', green: '#16a34a', red: '#dc2626', amber: '#d97706',
};

function Badge({ text, color }) {
  return <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 999, background: `${color}1a`, color }}>{text}</span>;
}

const TAG_COLOR = { new: C.green, updated: C.amber, expired: C.red, unchanged: C.sub };

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

  useEffect(() => {
    if (session) {
      loadLots();
      loadBookmarks();
      DB.fetchLatestScan().then(setLatestScan).catch(() => {});
    }
  }, [session, loadLots, loadBookmarks]);

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
                <th style={th}>Next Auction</th><th style={th}>Tag</th><th style={th}>Catalogue</th>
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
                  <td style={td}><button onClick={() => downloadCataloguePdf(row)} style={smallBtn}>PDF</button></td>
                </tr>
              ))}
              {!lots.length && !loading && <tr><td colSpan={13} style={{ ...td, textAlign: 'center', color: C.sub }}>No lots match these filters.</td></tr>}
            </tbody>
          </table>
        </div>

        <h2 style={{ fontSize: 15, margin: '26px 0 10px' }}>Bookmarks ({bookmarks.length})</h2>
        <div style={{ background: C.surf, borderRadius: 8, border: `1px solid ${C.bdr}`, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                <th style={th}>Lot No</th><th style={th}>Location</th><th style={th}>Material Descr.</th>
                <th style={th}>Notes</th><th style={th}>Target Rate</th><th style={th}>Secured Rate</th>
                <th style={th}>Sold Rate</th><th style={th}>Expenses</th><th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {bookmarks.map(row => (
                <BookmarkRow key={row.lot_no} row={row} onSave={saveBookmark} onRemove={() => toggleBookmark(row.lot_no)} />
              ))}
              {!bookmarks.length && <tr><td colSpan={9} style={{ ...td, textAlign: 'center', color: C.sub }}>No bookmarks yet — star a lot above.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function BookmarkRow({ row, onSave, onRemove }) {
  const [notes, setNotes] = useState(row.notes || '');
  const [target, setTarget] = useState(row.target_rate || '');
  const [secured, setSecured] = useState(row.secured_rate || '');
  const [sold, setSold] = useState(row.sold_rate || '');
  const [expenses, setExpenses] = useState(row.expenses || '');
  const [status, setStatus] = useState('');

  const save = async () => {
    setStatus('Saving…');
    await onSave(row.lot_no, { notes, target_rate: target, secured_rate: secured, sold_rate: sold, expenses });
    setStatus('Saved');
    setTimeout(() => setStatus(''), 1500);
  };

  return (
    <tr style={{ borderTop: `1px solid ${C.bdr}` }}>
      <td style={td}>{row.lot_no}</td>
      <td style={td}>{row.location}</td>
      <td style={{ ...td, maxWidth: 240 }}>{row.material_descr}</td>
      <td style={td}><input value={notes} onChange={e => setNotes(e.target.value)} style={input} /></td>
      <td style={td}><input value={target} onChange={e => setTarget(e.target.value)} style={{ ...input, width: 80 }} /></td>
      <td style={td}><input value={secured} onChange={e => setSecured(e.target.value)} style={{ ...input, width: 80 }} /></td>
      <td style={td}><input value={sold} onChange={e => setSold(e.target.value)} style={{ ...input, width: 80 }} /></td>
      <td style={td}><input value={expenses} onChange={e => setExpenses(e.target.value)} style={{ ...input, width: 80 }} /></td>
      <td style={td}>
        <button onClick={save} style={smallBtn}>Save</button>{' '}
        <button onClick={onRemove} style={{ ...smallBtn, color: C.red }}>Remove</button>{' '}
        <span style={{ fontSize: 11, color: C.sub }}>{status}</span>
      </td>
    </tr>
  );
}

const th = { padding: '8px 10px', fontSize: 11, fontWeight: 600, color: C.sub, whiteSpace: 'nowrap' };
const td = { padding: '7px 10px', verticalAlign: 'top' };
const input = { width: 110, padding: '4px 6px', borderRadius: 4, border: `1px solid ${C.bdr}`, fontSize: 12, fontFamily: 'inherit' };
const smallBtn = { padding: '4px 9px', borderRadius: 5, border: `1px solid ${C.bdr}`, background: '#fff', fontSize: 11, cursor: 'pointer' };
