/* GMM Service Charge & Incentive Tool — user interface (vanilla JS, no login, everything stays in this browser). */
(function () {
  'use strict';
  const E = GMM.engine, X = GMM.exporter, AI = GMM.ai;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rm = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const n2 = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toFixed(2));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const CAT = { MGMT: 'Management (HQ)', PERM: 'Local staff', CASUAL: 'Casual labour', FW: 'Foreign worker / agent' };
  const EXIT = { '': '—', RESIGN_FULL: 'Resigned (full notice)', MIA: 'MIA / absconded / short notice', ROLLBACK: 'Roll back (e.g. permit issue)' };

  // ------------------------------------------------------------------ state + persistence
  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const savedSettings = store.get('gmm.settings');
  const state = {
    settings: E.mergeSettings(savedSettings),
    ws: store.get('gmm.workspace'),
    dir: store.get('gmm.directory') || {}, // staff memory: positions, join dates, points HR typed in earlier months
    ui: { step: 1, outletId: null, scheme: 'sc', drawerRow: null, settingsTab: 'ai', att: { pages: [], pageResults: null, records: null, rotate: 'auto', fileName: '', progress: null, outletId: null } },
    results: null,
  };
  state.settings.ai.keys = { gemini: '', anthropic: '', openai: '', ...(state.settings.ai.keys || {}) };
  if (state.settings.ai.apiKey && !state.settings.ai.keys[state.settings.ai.provider]) state.settings.ai.keys[state.settings.ai.provider] = state.settings.ai.apiKey; // older saved settings
  state.settings.ai.apiKey = '';
  const hasKey = () => !!AI.keyFor(state.settings.ai);
  const stripKeys = (ai) => ({ ...ai, apiKey: '', keys: { gemini: '', anthropic: '', openai: '' } });
  if (state.ws && state.ws.outlets && state.ws.outlets.length) state.ui.step = 3;

  function saveSettings() {
    const copy = E.deepClone(state.settings);
    if (!copy.ai.rememberKey) copy.ai = stripKeys(copy.ai);
    delete copy.ai._resolvedNote; delete copy.ai._resolvedModel;
    store.set('gmm.settings', copy);
  }
  let saveTimer = null;
  function saveWorkspace() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!state.ws) return;
      if (!store.set('gmm.workspace', state.ws)) toast('Browser storage is full or blocked — use "Save backup" to keep your work.');
      state.ws.outlets.forEach((o) => E.rememberOutlet(state.dir, o)); store.set('gmm.directory', state.dir);
    }, 300);
  }
  function recompute() {
    if (!state.ws) { state.results = null; return; }
    try { state.results = E.computeWorkspace(state.ws, state.settings); } catch (e) { state.results = null; toast('Calculation error: ' + e.message); console.error(e); }
  }
  function outlet(id = state.ui.outletId) { return state.ws && state.ws.outlets.find((o) => o.id === id); }
  function ensureOutlet() {
    if (!state.ws || !state.ws.outlets.length) return null;
    if (!outlet()) state.ui.outletId = state.ws.outlets[0].id;
    return outlet();
  }
  function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.classList.add('open'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('open'), ms); }
  const monthLabel = (ym) => { if (!ym) return ''; const [y, m] = ym.split('-'); return `${MONTHS[Number(m) - 1]} ${y}`; };
  const shiftMonth = (ym, d) => { const [y, m] = ym.split('-').map(Number); const dt = new Date(y, m - 1 + d, 1); return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`; };

  function newWorkspace() {
    const now = new Date(); const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return { month: ym, attendanceMonth: shiftMonth(ym, -1), daysInMonth: E.daysInMonth(shiftMonth(ym, -1)), outlets: [] };
  }
  function ensureWs() { if (!state.ws) state.ws = newWorkspace(); return state.ws; }

  // ------------------------------------------------------------------ rendering shell
  function render() {
    recompute();
    const ws = state.ws;
    $('#monthPill').textContent = ws && ws.outlets.length ? `Payout ${monthLabel(ws.month)} · Attendance ${monthLabel(ws.attendanceMonth)} (${ws.daysInMonth} days) · ${ws.outlets.length} outlet(s)` : 'Start by uploading attendance';
    $$('.step').forEach((b) => { const s = Number(b.dataset.step); b.classList.toggle('active', s === state.ui.step); b.classList.toggle('done', s < state.ui.step); });
    const v = $('#view');
    if (state.ui.step === 1) v.innerHTML = viewAttendance();
    else if (state.ui.step === 2) v.innerHTML = viewOutlets();
    else if (state.ui.step === 3) v.innerHTML = viewReview();
    else v.innerHTML = viewExport();
    if (state.ui.drawerRow) renderDrawer();
  }
  function go(step) { state.ui.step = step; closePopover(); render(); window.scrollTo(0, 0); }

  // ------------------------------------------------------------------ step 1: attendance (AI)
  function viewAttendance() {
    const a = state.ui.att; const s = state.settings;
    const prov = AI.PROVIDERS[s.ai.provider] || AI.PROVIDERS.gemini;
    return `
    <div class="grid2">
      <section class="card">
        <div class="card-head"><h2>1. Upload attendance</h2></div>
        <p class="muted small">Scanned PDF or photos. Works with the "List of Logs" printout (many staff per page, e.g. ATSB) and the "Daily Time Record" (one staff per page),
        including HR's handwritten codes (OFF, AL, PH, MC, TRN…) and circled totals. No previous Excel files are needed.</p>
        <div class="dropzone" id="attDrop" tabindex="0" role="button" aria-label="Choose attendance file">
          <b>Drop the attendance PDF (or photos) here</b> or click to choose
          <input type="file" id="attInput" accept=".pdf,image/*" multiple hidden>
        </div>
        ${a.pages.length ? `
          <div class="row" style="margin-top:10px"><b>${esc(a.fileName)}</b><span class="muted">${a.pages.length} page(s)</span><span class="spacer" style="flex:1"></span>
            <label class="field" style="flex-direction:row;align-items:center;gap:6px">Rotate pages
              <select id="rotSel">${['auto', '0', '90', '180', '270'].map((r) => `<option value="${r}" ${String(a.rotate) === r ? 'selected' : ''}>${r === 'auto' ? 'Auto-detect' : r + '°'}</option>`).join('')}</select></label></div>
          <div class="thumbs" style="margin-top:8px">${a.pages.map((p, i) => `<img src="${p.dataUrl}" alt="Page ${i + 1}" data-act="zoomPage" data-i="${i}">`).join('')}</div>
          <p class="small muted">Pages should read upright. Auto-detect turns sideways printouts; if a page still looks wrong, pick a rotation.</p>` : ''}
      </section>
      <section class="card">
        <div class="card-head"><h2>AI reading</h2><span class="spacer"></span><button class="btn sm" data-act="settings" data-tab="ai">AI settings</button></div>
        <div class="row"><label class="field" style="flex:1">AI model${modelSelect('quickPreset', s.ai.preset)}</label>
          <span class="small" style="margin-top:16px">key ${hasKey() ? '<span class="okmark">✓ set</span>' : `<span class="badmark">missing</span> <button class="btn sm" data-act="settings" data-tab="ai">add key</button>`}</span></div>
        <p class="small muted">${esc((AI.presetById(s.ai.preset) || {}).note || `${prov.label} · ${s.ai.model}`)}${s.ai.fallbackPreset ? ` · Fallback if it fails: <b>${esc(AI.presetById(s.ai.fallbackPreset).label)}</b>` : ''}</p>
        <label class="field">External circumstances / extra instructions for the AI (optional)
          <textarea id="aiInstr" placeholder="e.g. Outlet closed 15 July for renovation – treat as PH for everyone.\nAdam's MC on 22 July was appealed and approved by COO – do not deduct.\nKesh Bahadur transferred to KLIA 2 from 18 July.">${esc(s.ai.instructions || '')}</textarea></label>
        <div class="row" style="margin-top:10px">
          <button class="btn primary" data-act="extract" ${a.pages.length && !a.busy ? '' : 'disabled'}>Read attendance with AI</button>
          ${a.busy ? '<button class="btn" data-act="cancelExtract">Cancel</button>' : ''}
          <label class="btn">Load extraction (.json)<input type="file" id="extractInput" accept=".json" hidden></label>
          ${a.pageResults ? '<button class="btn" data-act="saveExtract">Save extraction (.json)</button>' : ''}
        </div>
        ${a.progress ? `<div style="margin-top:10px"><div class="progress"><div style="width:${Math.round(a.progress.done / a.progress.total * 100)}%"></div></div><p class="small muted">${esc(a.progress.text)}</p></div>` : ''}
        ${a.error ? `<div class="notice bad" style="margin-top:10px">${esc(a.error)}</div>` : ''}
        <p class="small muted" style="margin-top:10px">Tip: save the extraction after a successful run — you can reload it later without paying for / waiting on the AI again.</p>
      </section>
    </div>
    ${a.records ? attendanceTable(a.records) : ''}`;
  }

  function dayStrip(days) {
    const s = state.settings;
    return `<span class="days">${days.map((d) => { const cat = E.codeCategory(d.code, s); const lab = d.code === 'W' ? (/LATE/i.test(d.note) ? 'L' : '') : d.code === 'BLANK' ? '·' : d.code === 'NOTEMP' ? '' : d.code.slice(0, 3);
      return `<span class="day ${cat}" title="Day ${d.day}: ${esc(d.code)}${d.firstIn ? ' · in ' + esc(d.firstIn) : ''}${d.note ? ' · ' + esc(d.note) : ''}">${esc(lab)}</span>`; }).join('')}</span>`;
  }

  function attendanceTable(recs) {
    const a = state.ui.att; const dim = a.dim || (state.ws && state.ws.daysInMonth) || 31; const m = a.meta || {};
    const blank = recs.filter((r) => E.summariseDays(r.days, state.settings, dim).allBlank).length;
    return `<section class="card">
      <div class="card-head"><h2>What the AI read — ${recs.length} staff</h2>
        <span class="small muted">${[m.company, m.periodStart && m.periodEnd ? `${m.periodStart} → ${m.periodEnd}` : '', m.layout ? m.layout.replace(/_/g, ' ') : '', blank ? `${blank} with blank attendance (not recorded)` : ''].filter(Boolean).map(esc).join(' · ')}</span>
        <span class="spacer"></span>
        <span class="legend">${['WORK:worked', 'NODEDUCT:OFF/AL/PH/TRN (no deduction)', 'MC:MC/HL', 'UPL:UPL', 'ABSENT:absent', 'NOTEMP:not employed', 'REVIEW:unknown code'].map((x) => { const [c, l] = x.split(':'); return `<span><span class="day ${c}" style="display:inline-block;width:14px;height:12px"></span> ${l}</span>`; }).join('')}</span></div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Name</th><th>ID</th><th>Dept</th><th>Day 1 → ${dim}</th><th>Worked</th><th>MC</th><th>UPL</th><th>Absent</th><th>AL</th><th>OFF</th><th>Late</th><th>Not emp.</th><th title="Circled total written by HR">HR total</th><th>Printed totals / notes</th></tr></thead>
        <tbody>${recs.map((r, i) => {
          const s = E.summariseDays(r.days, state.settings, dim);
          return `<tr class="${s.allBlank ? 'excluded' : ''}">
            <td><input type="text" data-rec="${i}" data-rf="name" value="${esc(r.name)}" style="width:230px;font-weight:600">${s.allBlank ? ' <span class="tag">blank – not recorded</span>' : ''}</td>
            <td><input type="text" data-rec="${i}" data-rf="employeeId" value="${esc(r.employeeId)}" style="width:80px" class="mono"></td><td class="small">${esc(r.department)}</td>
            <td>${dayStrip(r.days)}</td><td class="num">${s.worked || ''}</td><td class="num">${s.MC || ''}</td><td class="num">${s.UPL || ''}</td><td class="num">${s.ABSENT || ''}</td><td class="num">${s.AL || ''}</td><td class="num">${s.OFF || ''}</td><td class="num">${s.late || ''}</td><td class="num">${s.NOTEMP || ''}</td>
            <td class="center">${esc(r.handwrittenTotal || '')}</td>
            <td class="small">${esc([r.printedTotals, r.notes].filter(Boolean).join(' · '))}</td></tr>`;
        }).join('')}</tbody></table></div>
      <div class="row" style="margin-top:12px"><button class="btn primary" data-act="go" data-step="2">Next: choose outlet &amp; entitlement →</button>
        <span class="small muted">You can fix names / IDs here. Day codes can be changed later per staff in Review.</span></div>
    </section>`;
  }

  // ------------------------------------------------------------------ step 2: outlet & entitlement
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function monthYearPicker(prefix, ym, label) {
    const [y, m] = (ym || '').split('-').map(Number);
    return `<label class="field">${label}<div class="row" style="gap:6px"><select data-my="${prefix}" data-part="m">${MONTH_NAMES.map((n, i) => `<option value="${i + 1}" ${m === i + 1 ? 'selected' : ''}>${i + 1} – ${n}</option>`).join('')}</select>
      <input type="number" data-my="${prefix}" data-part="y" value="${y || new Date().getFullYear()}" style="width:90px" aria-label="${label} year"></div></label>`;
  }
  function viewOutlets() {
    const a = state.ui.att; const s = state.settings; const ws = state.ws;
    const g = state.ui.asg || (state.ui.asg = defaultAssignment());
    const def = s.outlets.find((x) => x.name === g.outlet);
    const existing = ws && ws.outlets.find((o) => o.sheetName === g.outlet);
    const recs = a.records;
    const withData = recs ? recs.filter((r) => !E.summariseDays(r.days, s, a.dim || 31).allBlank).length : 0;
    const assign = recs && a.assignedTo && !state.ui.reassign ? `<section class="card"><div class="row"><span>✓ <b>${esc(a.fileName)}</b> was used for <b>${esc(a.assignedTo)}</b>.</span>
        <button class="btn sm" data-act="reassign">Use it for a different outlet / redo</button><button class="btn sm primary" data-act="go" data-step="1">Scan the next outlet's attendance</button></div></section>` : recs ? `
      <section class="card">
        <div class="card-head"><h2>2. Which outlet is this attendance for?</h2><span class="small muted">${esc(a.fileName)} · ${withData} staff with attendance${a.meta && a.meta.company ? ' · ' + esc(a.meta.company) : ''}</span></div>
        <div class="grid2">
          <div class="stack">
            <fieldset class="outlet-pick"><legend>Outlet</legend>
              ${s.outlets.map((x) => { const done = ws && ws.outlets.some((o) => o.sheetName === x.name); return `<label class="check"><input type="radio" name="asgOutlet" value="${esc(x.name)}" ${x.name === g.outlet ? 'checked' : ''}> ${esc(x.name)}${done ? ' <span class="tag ok">done</span>' : ''}</label>`; }).join('')}
              <button class="btn sm" data-act="newOutlet" type="button">+ New outlet</button></fieldset>
            ${def && def.kind === 'central' ? '<p class="small muted">Central Kitchen is paid from the other outlets\' CK/HQ % — set the amounts in Review if those outlets are not in this month\'s files.</p>' : ''}
            <div class="row">${monthYearPicker('pay', g.payMonth, 'Service charge / incentive month (Excel title)')}</div>
            <div class="row">${monthYearPicker('att', g.attMonth, 'Attendance month')}<label class="field">Days<input type="number" min="28" max="31" id="asgDays" value="${g.days}" style="width:70px"></label></div>
          </div>
          <div class="stack">
            <b>Entitlement</b>
            <label class="check"><input type="checkbox" data-asg="sc" ${g.sc ? 'checked' : ''}> Service charge</label>
            <label class="check"><input type="checkbox" data-asg="inc" ${g.inc ? 'checked' : ''}> Incentive <span class="small muted">(only when the outlet achieved its target)</span></label>
            ${g.sc && !(def && def.kind === 'central') ? `<label class="field">Total service charge collected (RM)<input type="number" step="0.01" data-asg="scCollected" value="${g.scCollected || ''}" placeholder="e.g. 70146.18"></label>` : ''}
            ${g.inc ? `<div class="row"><label class="field">Total net sales (RM)<input type="number" step="0.01" data-asg="netSales" value="${g.netSales || ''}"></label>
              <label class="field">Incentive % of net sales<input type="number" step="0.01" data-asg="incPct" value="${E.xlRound(g.incPct * 100, 4)}" style="width:100px"></label></div>` : ''}
            <p class="small muted">You can change all of these later in Review.</p>
          </div>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" data-act="createOutlet" ${g.sc || g.inc ? '' : 'disabled'}>${existing ? `Replace ${esc(g.outlet)} staff list →` : `Create ${esc(g.outlet)} ${g.sc && g.inc ? 'service charge + incentive' : g.inc ? 'incentive' : 'service charge'} →`}</button>
          <span class="small muted">Staff and attendance come straight from the scan. Positions / join dates you type are remembered for next month.</span>
        </div>
      </section>` : `<section class="card"><h2>2. Outlet &amp; entitlement</h2><p class="muted">Upload and read an attendance file first.</p><button class="btn primary" data-act="go" data-step="1">Go to step 1</button></section>`;
    const list = ws && ws.outlets.length ? `
      <section class="card">
        <div class="card-head"><h2>Outlets in this month's files</h2><span class="small muted">Scan another attendance file to add the next outlet.</span></div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Export</th><th>Outlet</th><th>Staff</th><th>Service charge</th><th>Incentive</th><th>SC collected (RM)</th><th>Net sales (RM)</th><th>Incentive %</th><th>1 service point</th><th>1 incentive point</th><th></th></tr></thead>
          <tbody>${ws.outlets.map((o) => { const r = state.results && state.results[o.id] || {};
            return `<tr><td class="center"><input type="checkbox" data-o="${o.id}" data-of="export" ${o.export !== false ? 'checked' : ''} aria-label="Export ${esc(o.sheetName)}"></td>
              <td><b>${esc(o.sheetName)}</b><div class="small muted">${esc(o.company || '')}${o.attendance ? ' · ' + esc(o.attendance.file || '') : ''}</div></td>
              <td class="num">${o.employees.filter((e) => e.include !== false).length}</td>
              <td class="center"><input type="checkbox" data-o="${o.id}" data-of="scEnabled" ${o.scEnabled !== false ? 'checked' : ''} aria-label="Service charge"></td>
              <td class="center"><input type="checkbox" data-o="${o.id}" data-of="incEnabled" ${o.incEnabled ? 'checked' : ''} aria-label="Incentive"></td>
              <td>${o.kind === 'central' ? '<span class="small muted">other outlets\' CK %</span>' : `<input type="number" step="0.01" data-o="${o.id}" data-of="scCollected" value="${o.scCollected || 0}" style="width:120px">`}</td>
              <td>${o.incEnabled ? `<input type="number" step="0.01" data-o="${o.id}" data-of="netSales" value="${o.netSales || 0}" style="width:120px">` : '<span class="muted small">—</span>'}</td>
              <td>${o.incEnabled ? `<input type="number" step="0.01" data-o="${o.id}" data-of="incPct" data-pct value="${E.xlRound(E.num(o.incPct, s.inc.pct) * 100, 4)}" style="width:80px">` : ''}</td>
              <td class="num">${r.sc ? rm(r.sc.summary.PointValue) : ''}</td><td class="num">${r.inc ? rm(r.inc.summary.PointValue) : ''}</td>
              <td class="nowrap"><button class="btn sm" data-act="openOutlet" data-id="${o.id}">Review →</button> <button class="btn sm danger" data-act="removeOutlet" data-id="${o.id}" aria-label="Remove ${esc(o.sheetName)}">✕</button></td></tr>`; }).join('')}</tbody></table></div>
      </section>` : '';
    return assign + list;
  }

  function defaultAssignment() {
    const a = state.ui.att; const s = state.settings; const m = a.meta || {};
    let att = (m.periodStart || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(att)) att = state.ws ? state.ws.attendanceMonth : shiftMonth(newWorkspace().month, -1);
    const pay = state.ws && state.ws.outlets.length ? state.ws.month : shiftMonth(att, 1);
    return { outlet: suggestOutlet(), payMonth: pay, attMonth: att, days: a.dim || E.daysInMonth(att), sc: true, inc: false, scCollected: '', netSales: '', incPct: s.inc.pct };
  }
  // Suggest the outlet: staff remembered from earlier months vote for their outlet; else match the company name.
  function suggestOutlet() {
    const a = state.ui.att; const s = state.settings; const votes = {};
    (a.records || []).forEach((r) => { const p = E.lookupDirectory(state.dir, r); if (p && p.outlet) votes[p.outlet] = (votes[p.outlet] || 0) + 1; });
    const best = Object.entries(votes).sort((x, y) => y[1] - x[1])[0];
    if (best) return best[0];
    const comp = String((a.meta || {}).company || '').toUpperCase();
    const byCompany = s.outlets.filter((x) => comp && x.company && comp.includes(x.company.split(' ')[0]));
    if (byCompany.length === 1) return byCompany[0].name;
    // otherwise keep the outlet chosen last time (HR usually scans outlets in the same order) or the first one
    return state.ui.lastOutlet && s.outlets.some((x) => x.name === state.ui.lastOutlet) ? state.ui.lastOutlet : s.outlets[0].name;
  }

  // ------------------------------------------------------------------ step 3: review grid
  const Q = (id, ctx = '') => `<button class="qbtn" data-q="${id}" data-ctx="${esc(ctx)}" aria-label="How is this calculated?" title="How is this calculated?">?</button>`;

  function viewReview() {
    const o = ensureOutlet();
    if (!o) return `<section class="card"><h2>3. Review</h2><p>No outlets yet. Upload and read an attendance file (step 1), then choose the outlet (step 2).</p><button class="btn primary" data-act="go" data-step="1">Go to step 1</button></section>`;
    const scheme = state.ui.scheme === 'inc' && o.incEnabled ? 'inc' : 'sc';
    if (scheme === 'sc' && o.scEnabled === false) state.ui.scheme = 'inc';
    const res = state.results[o.id][scheme];
    const S = res.summary, T = res.totals;
    const flagged = o.employees.filter((r) => r.flags && r.flags.length && r.include !== false).length;
    return `
    <div class="row" style="margin-bottom:10px">
      <select id="outletSel" aria-label="Outlet">${state.ws.outlets.map((x) => `<option value="${x.id}" ${x.id === o.id ? 'selected' : ''}>${esc(x.sheetName)}</option>`).join('')}</select>
      <div class="row" role="tablist">
        ${o.scEnabled !== false ? `<button class="btn ${scheme === 'sc' ? 'primary' : ''}" data-act="scheme" data-s="sc">Service charge</button>` : ''}
        ${o.incEnabled ? `<button class="btn ${scheme === 'inc' ? 'primary' : ''}" data-act="scheme" data-s="inc">Incentive</button>` : '<button class="btn" data-act="enableInc">+ Incentive for this outlet</button>'}
      </div>
      <span class="spacer" style="flex:1"></span>
      <button class="btn" data-act="aiReview">✨ AI review &amp; summary</button>
      <button class="btn" data-act="addRow">+ Add staff</button>
      <button class="btn" data-act="addRow" data-mgmt="1" title="HQ management are not on the outlet's attendance; once added they are remembered every month">+ Add HQ management</button>
      <button class="btn primary" data-act="go" data-step="4">Export →</button>
    </div>
    ${summaryCards(o, scheme, S, T)}
    ${o.aiReview && o.aiReview.scheme === scheme ? aiReviewPanel(o) : ''}
    ${flagged ? `<div class="notice warn" style="margin-bottom:10px">⚠ ${flagged} included staff have notes to check (marked ⚠). Click a name to see the day-by-day attendance.</div>` : ''}
    ${gridTable(o, scheme, res)}
    ${scheme === 'sc' && o.kind !== 'central' ? fixedTable(o) : ''}
    ${scheme === 'sc' && o.kind === 'central' ? ckSourcesTable(o, S) : ''}
    <div class="legend" style="margin-top:8px">${legendHtml()}</div>`;
  }

  function legendHtml() {
    const c = state.settings.colors;
    const sw = (argb) => `<span class="swatch" style="background:#${argb.slice(-6)}"></span>`;
    return [[c.MGMT, 'Management (orange)'], [c.HEAD, 'Outlet head'], [c.HELPER, 'Helping from other outlet (light green)'], [c.RASA, 'Rasa by Grandmama (blue)'], [c.CASUAL, 'Casual labour (green)'], [c.FW, 'Foreign worker (red)'], [c.DEDUCT, 'Attendance deduction 4+ days (purple)']]
      .map(([a, l]) => `<span>${sw(a)} ${l}</span>`).join('') + `<span style="color:#${c.fontNew.slice(-6)}">Blue text = new joiner</span><span style="color:#${c.fontLeaving.slice(-6)}">Red text = resigned / absconded</span><span><span class="swatch ov"></span> value typed by you (overrides the formula)</span>`;
  }

  function summaryCards(o, scheme, S, T) {
    const card = (k, v, q, cls = '') => `<div class="kpi ${cls}"><div class="k">${k}${q ? Q(q, 'summary') : ''}</div><div class="v">${v}</div></div>`;
    const inputCard = (k, field, val) => `<div class="kpi hl"><div class="k">${k}</div><input type="number" step="0.01" data-o="${o.id}" data-of="${field}" value="${val || 0}"></div>`;
    let html = '<div class="kpis">';
    if (scheme === 'sc') {
      if (o.kind === 'central') html += card('From other outlets (CK %)', rm(S.Nett + T.fixed), null);
      else {
        html += inputCard('Service charge collected (RM)', 'scCollected', o.scCollected);
        html += card(`Distribute ${E.xlRound((o.distributePct || state.settings.sc.distributePct) * 100, 2)}%`, rm(S.Distributable), 'distributable');
        html += card(`Less ${E.xlRound((o.ckPct || state.settings.sc.ckPct) * 100, 2)}% CK / HQ`, rm(S.CKDeduction), 'ckDeduction');
        if (T.fixed) html += card('Fixed SC (COO approved)', rm(T.fixed), null);
      }
      html += card('Nett to pay to outlet', rm(S.Nett), 'nett');
      html += card('Total points (sum of K)', n2(S.TotalPoints), null);
      html += card('1 Service Point', rm(S.PointValue), 'pointValue', 'hl');
      if (S.CompanyTopUp > 0.005) html += card('Company top-up to minimum', rm(S.CompanyTopUp), 'companyTopUp');
    } else {
      html += inputCard('Total net sales (RM)', 'netSales', o.netSales);
      html += `<div class="kpi hl"><div class="k">Incentive % of net sales</div><input type="number" step="0.01" data-o="${o.id}" data-of="incPct" data-pct value="${E.xlRound(E.num(o.incPct, state.settings.inc.pct) * 100, 4)}"></div>`;
      html += card(`Incentive ${E.xlRound((o.incPct || state.settings.inc.pct) * 100, 2)}%`, rm(S.IncentiveTotal), 'incentiveTotal');
      html += card('Total points (sum of K)', n2(S.TotalPoints), null);
      html += card('1 Incentive point', rm(S.PointValue), 'incPointValue', 'hl');
    }
    html += card('Paid to staff', rm(T.entitled), null);
    html += card('Rolled back to company', rm(T.rollback), null);
    html += card('Retained to pool', rm(T.pool), null);
    html += card('Difference (nett − grand total)', rm(T.variance), null, Math.abs(T.variance) > 1 ? 'hl' : '');
    return html + '</div>';
  }

  function gridTable(o, scheme, res) {
    const s = state.settings; const sc = scheme === 'sc';
    const byId = new Map(res.rows.map((x) => [x.row.id, x]));
    const pts = (r) => ({ ...E.computeRowPoints(r, scheme, s, state.ws.daysInMonth) });
    const ovKey = sc ? 'overrides' : 'incOverrides';
    const rows = o.employees.filter((r) => (sc ? r.inSC !== false : r.inIncentive !== false && r.category !== 'MGMT'));
    const head = `<thead>
      <tr class="grp"><th colspan="4">Staff</th><th colspan="6">Attendance (days)</th><th colspan="${sc ? 4 : 3}">Points</th><th colspan="4">RM</th><th colspan="3">Notes</th></tr>
      <tr><th title="Include in this month's list">Incl.</th><th>Name</th><th>Category / status</th><th>Base${Q('base')}</th>
        <th>Join date</th><th title="Days before join / after last day">Not emp.${Q('notEmployed')}</th><th>MC / HL</th><th>UPL</th><th>Absent${Q('absent')}</th><th>Late (days)${Q('late')}</th>
        <th>K${Q('entitlement')}</th><th>L${Q('daysWorked')}</th><th>M${Q('points')}</th>${sc ? `<th>N${Q('reserved')}</th>` : ''}
        <th>Tier${Q('tier')}</th><th>Entitled${Q('entitledNormal')}</th><th>Rolled back${Q('rollback')}</th><th>Pool${Q('poolAmount')}</th>
        <th>Exit${Q('exit')}</th><th title="Appeal approved – no tier deduction">Waive tier${Q('waive')}</th><th>Remarks (Excel)</th></tr></thead>`;
    const body = rows.map((r, i) => {
      const x = byId.get(r.id);
      const v = x ? x.vars : pts(r);
      const st = E.rowStyle(r, v, s);
      const ov = r[ovKey] || {};
      const bg = st.fill ? `#${st.fill.slice(-6)}` : '#fff';
      const fc = `#${st.font.slice(-6)}`;
      const oin = (k, val, step = '0.01') => `<input type="number" step="${step}" data-r="${r.id}" data-ov="${k}" class="${ov[k] !== undefined && ov[k] !== '' ? 'ov' : 'calc'}" value="${ov[k] !== undefined && ov[k] !== '' ? ov[k] : ''}" placeholder="${val === undefined ? '' : (step === '1' ? val : n2(val))}" title="Calculated ${val}. Type a number to override; clear to go back to the formula.">`;
      const fin = (k, val) => `<input type="number" step="1" min="0" data-r="${r.id}" data-f="${k}" value="${val || 0}">`;
      const a = x ? x.alloc : null;
      const rb = a ? a.mia + a.deduction + a.fwCompany : 0;
      const exitKey = sc ? 'exitType' : (r.incExitType !== undefined ? 'incExitType' : 'exitType');
      const waiveKey = sc ? 'waiveTier' : (r.incWaiveTier !== undefined ? 'incWaiveTier' : 'waiveTier');
      const remark = r.remarkOverride || E.autoRemark(r, s, v);
      return `<tr class="${r.include === false ? 'excluded' : ''}" style="background:${bg};color:${fc}">
        <td class="center keep"><input type="checkbox" data-r="${r.id}" data-f="include" ${r.include !== false ? 'checked' : ''} aria-label="Include ${esc(r.name)}"></td>
        <td class="name"><button class="namebtn" data-act="openRow" data-id="${r.id}" style="color:${fc}">${esc(r.name)}</button>${r.flags && r.flags.length ? ` <span class="flag" title="${esc(r.flags.join('\n'))}">⚠</span>` : ''}
          <div class="small muted">${esc(r.empNo)} · ${esc(r.dept)} · ${esc(r.position || '—')}${r.info ? ` <span title="${esc(r.info)}" aria-label="${esc(r.info)}">ⓘ</span>` : ''}</div></td>
        <td><select data-r="${r.id}" data-f="category">${Object.entries(CAT).map(([k, l]) => `<option value="${k}" ${r.category === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <div class="small muted">${esc(r.status)}${r.fromOutlet ? ' · from ' + esc(r.fromOutlet) : ''}${r.rasa ? ' · Rasa' : ''}</div></td>
        <td><input type="number" step="0.01" data-r="${r.id}" data-f="${sc ? 'base' : 'incBase'}" value="${sc ? r.base : (r.incBase !== undefined ? r.incBase : r.base)}" style="width:52px"></td>
        <td><input type="date" data-r="${r.id}" data-f="joinDate" value="${esc(r.joinDate || '')}" style="width:128px"></td>
        <td>${fin(sc || r.incNotEmployed === undefined || r.incNotEmployed === null ? 'notEmployed' : 'incNotEmployed', sc ? r.notEmployed : (r.incNotEmployed !== undefined && r.incNotEmployed !== null ? r.incNotEmployed : r.notEmployed))}</td>
        <td>${fin('mc', r.mc)}</td><td>${fin('upl', r.upl)}</td><td>${fin('absent', r.absent)}</td><td>${fin('lateDays', r.lateDays)}${r.lateCount ? `<div class="small muted">${r.lateCount} late</div>` : ''}</td>
        <td>${oin('K', v.PointEntitlement)}</td><td>${oin('L', v.DaysWorked, '1')}</td><td>${oin('M', v.Points)}</td>${sc ? `<td>${v.CompanyShare ? oin('N', v.ReservedPoints) : ''}</td>` : ''}
        <td class="center">${v.tier && v.tier.pct > 0 ? `<span class="tag tier">${esc(v.tier.text)}</span>` : (v.DeductDays ? '<span class="tag">prorate</span>' : '')}</td>
        <td class="num">${a ? `<button class="cellbtn" data-cell="entitled" data-r="${r.id}">${rm(a.entitled)}</button>` : ''}</td>
        <td class="num">${a && rb ? `<button class="cellbtn" data-cell="rollback" data-r="${r.id}">${rm(rb)}</button>` : ''}</td>
        <td class="num">${a && a.pool ? `<button class="cellbtn" data-cell="pool" data-r="${r.id}">${rm(a.pool)}</button>` : ''}</td>
        <td><select data-r="${r.id}" data-f="${exitKey}" style="max-width:150px">${Object.entries(EXIT).map(([k, l]) => `<option value="${k}" ${(r[exitKey] || '') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
        <td class="center"><input type="checkbox" data-r="${r.id}" data-f="${waiveKey}" ${r[waiveKey] ? 'checked' : ''} aria-label="Waive tier deduction"></td>
        <td class="small" style="min-width:220px;white-space:pre-wrap">${esc(remark)}</td></tr>`;
    }).join('');
    return `<div class="tbl-wrap"><table class="tbl" id="grid">${head}<tbody>${body}</tbody></table></div>`;
  }

  function fixedTable(o) {
    const rows = o.fixedRows || [];
    return `<section class="card" style="margin-top:14px">
      <div class="card-head"><h3>Fixed Service Charge approved by COO (helpers from other outlets)</h3><span class="spacer"></span><button class="btn sm" data-act="addFixed">+ Add helper</button></div>
      ${rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>From outlet</th><th>Employee no</th><th>Name</th><th>Position</th><th>Days</th><th>Fixed RM</th><th>Remarks</th><th></th></tr></thead><tbody>
      ${rows.map((f, i) => `<tr>${['fromOutlet', 'empNo', 'name', 'position'].map((k) => `<td><input type="text" data-fx="${i}" data-ff="${k}" value="${esc(f[k] || '')}"></td>`).join('')}
        <td><input type="number" data-fx="${i}" data-ff="days" value="${esc(f.days || '')}" style="width:60px"></td><td><input type="number" step="0.01" data-fx="${i}" data-ff="amount" value="${f.amount || 0}" style="width:100px"></td>
        <td><input type="text" data-fx="${i}" data-ff="remark" value="${esc(f.remark || '')}" style="width:280px"></td><td><button class="btn sm danger" data-act="delFixed" data-i="${i}">✕</button></td></tr>`).join('')}
      </tbody></table></div><p class="small muted">The total is deducted before the point value is calculated (line "Fixed SC allowance").</p>` : '<p class="small muted">None this month.</p>'}
    </section>`;
  }

  function ckSourcesTable(o, S) {
    return `<section class="card" style="margin-top:14px"><div class="card-head"><h3>Central Kitchen funding — CK/HQ % from other outlets</h3></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Outlet</th><th>Amount (RM)</th><th>Source</th></tr></thead><tbody>
      ${(S.sources || []).map((src, i) => `<tr><td>${esc(src.outlet)}</td><td>${src.live ? rm(src.amount) : `<input type="number" step="0.01" data-ck="${i}" value="${src.amount}">`}</td><td class="small muted">${src.live ? 'calculated from that outlet in this workspace' : 'typed amount (outlet not in workspace or no SC entered)'}</td></tr>`).join('')}
      </tbody></table></div></section>`;
  }

  function aiReviewPanel(o) {
    const rv = o.aiReview;
    return `<section class="card"><div class="card-head"><h3>✨ AI summary</h3><span class="small muted">${esc(rv.at || '')}</span><span class="spacer"></span><button class="btn sm" data-act="closeReview">Hide</button></div>
      <div class="ai-summary">${esc(rv.summary || '')}</div>
      ${(rv.suggestions || []).length ? `<h3 style="margin-top:12px">Suggested changes</h3><div class="tbl-wrap" style="margin-top:6px"><table class="tbl"><thead><tr><th>Staff</th><th>Change</th><th>Why</th><th></th></tr></thead><tbody>
      ${rv.suggestions.map((sg, i) => `<tr><td>${esc(sg.name || sg.empNo)}</td><td class="mono">${esc(sg.field)} → ${esc(JSON.stringify(sg.value))}</td><td class="small">${esc(sg.reason || '')}</td>
        <td>${sg.applied ? '<span class="tag ok">applied</span>' : `<button class="btn sm" data-act="applySug" data-i="${i}">Apply</button>`}</td></tr>`).join('')}</tbody></table></div>` : ''}
    </section>`;
  }

  // ------------------------------------------------------------------ drawer: one staff member
  function renderDrawer() {
    const o = ensureOutlet(); const r = o && o.employees.find((e) => e.id === state.ui.drawerRow);
    const d = $('#drawer');
    if (!r) { d.classList.remove('open'); return; }
    const s = state.settings; const dim = state.ws.daysInMonth; const a = r.attendance;
    const codes = s.codes.map((c) => c.code);
    const res = state.results[o.id][state.ui.scheme === 'inc' && o.incEnabled ? 'inc' : 'sc'];
    const x = res.rows.find((y) => y.row.id === r.id);
    d.innerHTML = `<div class="dh"><div><h2>${esc(r.name)}</h2><div class="small muted">${esc(r.empNo)} · ${esc(r.dept)} · ${esc(o.sheetName)}</div></div><span class="spacer" style="flex:1"></span><button class="btn" data-act="closeDrawer" aria-label="Close">✕</button></div>
    <div class="db stack">
      ${r.flags && r.flags.length ? `<div class="notice warn">${r.flags.map(esc).join('<br>')}</div>` : ''}
      <div class="grid2" style="grid-template-columns:1fr 1fr">
        ${[['name', 'Name'], ['empNo', 'Employee no'], ['dept', 'Dept'], ['position', 'Position'], ['status', 'Status (Excel)'], ['fromOutlet', 'Helping from outlet (light green)']].map(([k, l]) => `<label class="field">${l}<input type="text" data-r="${r.id}" data-f="${k}" value="${esc(r[k] || '')}"></label>`).join('')}
        <label class="field">Join date<input type="date" data-r="${r.id}" data-f="joinDate" value="${esc(r.joinDate || '')}"></label>
        <label class="field">Resignation date<input type="date" data-r="${r.id}" data-f="resignDate" value="${esc(r.resignDate || '')}"></label>
      </div>
      <div class="row">${[['isNew', 'New joiner (blue text)'], ['rasa', 'Rasa by Grandmama'], ['outletHead', 'Outlet head'], ['inIncentive', 'In incentive list'], ['keepWithoutAttendance', 'Keep even without attendance']].map(([k, l]) => `<label class="check"><input type="checkbox" data-r="${r.id}" data-f="${k}" ${k === 'inIncentive' ? (r.inIncentive !== false ? 'checked' : '') : (r[k] ? 'checked' : '')}> ${l}</label>`).join('')}</div>
      <label class="field">Extra remark (added to the Excel remark)<input type="text" data-r="${r.id}" data-f="extraRemark" value="${esc(r.extraRemark || '')}"></label>
      <label class="field">Replace whole remark (optional)<textarea data-r="${r.id}" data-f="remarkOverride" placeholder="${esc(E.autoRemark(r, s, x && x.vars))}">${esc(r.remarkOverride || '')}</textarea></label>
      ${a ? `<h3>Attendance (${esc(a.name)}, ID ${esc(a.employeeId)}, page ${esc((a.pages || []).join(', '))})</h3>
        <p class="small muted">HR handwritten total: <b>${esc(a.handwrittenTotal || '—')}</b>${a.notes ? ` · Notes: ${esc(a.notes)}` : ''}</p>
        <div class="cal">${a.days.map((dd, i) => `<div class="c"><div class="d"><span>${dd.day}</span><span class="muted">${esc(dd.firstIn || '')}</span></div>
          <select data-day="${i}" data-r="${r.id}" class="day ${E.codeCategory(dd.code, s)}" style="width:100%;height:auto">${[...new Set([dd.code, ...codes, 'BLANK'])].map((c) => `<option ${c === dd.code ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>`).join('')}</div>
        <div class="row"><button class="btn" data-act="recount" data-id="${r.id}">Re-count MC / UPL / absent from these days</button></div>
        ${(a.pages || []).map((p) => state.ui.att.pages[p - 1] ? `<img src="${state.ui.att.pages[p - 1].dataUrl}" alt="Scanned page ${p}" style="width:100%;border:1px solid var(--line);border-radius:6px;cursor:zoom-in" data-act="zoomPage" data-i="${p - 1}">` : '').join('')}`
      : '<p class="muted small">No attendance record linked (management, helper, or not on the log).</p>'}
      ${x ? `<h3>Calculation for this row</h3>${rowExplain(x)}` : ''}
      <div class="row"><button class="btn danger" data-act="delRow" data-id="${r.id}">Delete staff from this outlet</button></div>
    </div>`;
    d.classList.add('open');
  }

  function rowExplain(x) {
    const ids = ['entitlement', 'daysWorked', 'points', ...(x.vars.CompanyShare ? ['reserved'] : []), 'poolPoints', 'poolAmount', x.fx.entitled, x.fx.mia, x.fx.deduction, x.fx.fwCompany].filter((f) => f && f !== 'override');
    return ids.map((id) => { const e = explain(id, x.vars); return `<div class="formula-row"><b>${esc(E.DEFAULT_FORMULAS[id].label)}</b><div class="mono">${esc(e.expr)}</div><div class="mono muted">= ${esc(e.subst)} = <b>${esc(e.result)}</b></div></div>`; }).join('');
  }

  // ------------------------------------------------------------------ formula popovers
  const EXTRA_HELP = {
    base: ['Base entitlement', 'Full-month points for this person: 1 for most staff, 0.5 for some HQ management in this outlet, 2 for outlet heads in the incentive list. K is the base prorated by days employed.'],
    notEmployed: ['Not employed days', 'Days in the attendance month before the join date or after the last day (or days a helper was not here). They reduce K and L but are not leave. Taken from NOTEMP days read by the AI, or type it.'],
    absent: ['Absent', 'Days with no punch and no leave code. When "Count absent as UPL" is on (Settings → Rules) they go to the UPL column in Excel and are deducted.'],
    late: ['Lateness (days)', 'Lateness converted to days for the Excel "Lateness" column. Automatic detection is off by default (Settings → Rules) because shift times vary; the number of late punches found is shown under the box.'],
    tier: ['Deduction tier', 'Total Days = MC/HL + UPL + Lateness. 1–3 days: prorate only. 4–5: 30% deduction. 6–7: 50%. 8 & above: 100%. Change the tiers in Settings → Rules.'],
    rollback: ['Rolled back to company', 'MIA / short notice, deduction based on attendance (tiers) and the foreign workers\' 0.75 share. Formulas: "mia", "deductionTier", "deductionFull", "fwCompany".'],
    exit: ['Exit status', 'Resigned with full notice = prorated points as normal. MIA / absconded / short notice = not entitled, amount rolled back. Roll back = amount goes to "Deduction based on attendance" (e.g. permit issue).'],
    waive: ['Waive tier deduction', 'Tick when the COO approved an appeal: the staff is paid prorated on actual days with no 30/50/100% tier deduction (stakeholder example: "HL: 28 (Appeal & approved by COO)").'],
  };

  function renderWithValues(expr, vars) {
    const sub = (ast) => {
      switch (ast.t) {
        case 'id': return { t: 'num', v: vars[ast.n] === undefined ? ast.n : E.xlRound(Number(vars[ast.n]), 4) };
        case 'paren': return { t: 'paren', a: sub(ast.a) };
        case 'neg': return { t: 'neg', a: sub(ast.a) };
        case 'call': return { t: 'call', f: ast.f, args: ast.args.map(sub) };
        case 'bin': return { t: 'bin', op: ast.op, a: sub(ast.a), b: sub(ast.b) };
        default: return ast;
      }
    };
    return E.render(sub(E.parse(expr)));
  }
  function explain(id, vars) {
    const expr = state.settings.formulas[id] || E.DEFAULT_FORMULAS[id].expr;
    let subst = '', result = '';
    try { subst = renderWithValues(expr, vars); const r = E.evaluate(E.parse(expr), vars); result = String(E.xlRound(r, state.settings.precisionAsDisplayed === false ? 4 : 2)); } catch (e) { subst = e.message; }
    return { expr, subst, result };
  }

  function showFormula(id, anchor, ctx) {
    const pop = $('#popover');
    const o = ensureOutlet(); const scheme = state.ui.scheme === 'inc' && o && o.incEnabled ? 'inc' : 'sc';
    const res = o && state.results[o.id][scheme];
    let html = '';
    if (EXTRA_HELP[id]) {
      html = `<h4>${esc(EXTRA_HELP[id][0])}</h4><p>${esc(EXTRA_HELP[id][1])}</p>`;
    } else {
      const def = E.DEFAULT_FORMULAS[id]; if (!def) return;
      const expr = state.settings.formulas[id] || def.expr;
      html = `<h4>${esc(def.label)}</h4><p class="muted">${esc(def.help)}</p><div class="expr mono">${esc(expr)}</div>`;
      let vars = null, rowNo = null;
      if (ctx && ctx.rowId && res) { const x = res.rows.find((y) => y.row.id === ctx.rowId); if (x) { vars = { ...x.vars, PointValue: res.summary.PointValue }; rowNo = res.rows.indexOf(x); } }
      else if (ctx === 'summary' && res) vars = { ...res.summary, FixedAllowance: res.totals.fixed };
      else if (res && res.rows.length) { const x = res.rows.find((y) => y.fx.entitled === id || y.fx.deduction === id || y.fx.mia === id || y.fx.fwCompany === id) || res.rows.find((y) => y.vars.DeductDays) || res.rows[0]; vars = { ...x.vars, PointValue: res.summary.PointValue }; rowNo = res.rows.indexOf(x); ctx = { name: x.row.name }; }
      if (vars) {
        const e = explain(id, vars);
        html += `<div class="small muted">${ctx && ctx.name ? 'Example – ' + esc(ctx.name) : rowNo !== null ? 'This row' : 'This outlet'}:</div><div class="expr mono">= ${esc(e.subst)}<br>= <b>${esc(e.result)}</b></div>`;
        if (rowNo !== null && res) {
          try {
            const lay = X.planColumns(res.rows, scheme); const r = 12 + rowNo; const C = (k) => lay.cols[k].L;
            const refs = { DaysInMonth: '$L$10', DaysWorked: `L${r}`, PointEntitlement: `K${r}`, Points: `M${r}`, ReservedPoints: `N${r}`, MC: `${C('mc')}${r}`, UPL: `${C('upl')}${r}`, Late: `${C('late')}${r}`,
              DeductDays: `${C('mc')}${r}+${C('upl')}${r}+${C('late')}${r}`, PoolPoints: `${C('poolPts')}${r}`, PoolAmount: `${C('pool')}${r}`, PointValue: '$PV$', Base: vars.Base, Share: vars.Share,
              CompanyShare: vars.CompanyShare, TierPct: vars.TierPct, NotEmployed: vars.NotEmployed, EligibleDays: vars.EligibleDays, Entitled: 'Entitled', MinimumPayout: 0 };
            html += `<div class="small muted">In the Excel file (row ${r}; $PV$ = the "1 point" cell):</div><div class="expr mono">${esc(E.toExcel(expr, refs))}</div>`;
          } catch (e) { /* not a row formula */ }
        }
      }
      html += `<div class="row" style="margin-top:8px"><button class="btn sm" data-act="editFormula" data-id="${id}">Edit this formula</button>${expr !== def.expr ? '<span class="tag bad">changed from default</span>' : ''}</div>`;
    }
    pop.innerHTML = html;
    pop.classList.add('open');
    const r = anchor.getBoundingClientRect();
    const w = Math.min(460, window.innerWidth - 20);
    pop.style.left = Math.max(10, Math.min(r.left, window.innerWidth - w - 10)) + 'px';
    pop.style.top = (r.bottom + 6 + 300 > window.innerHeight ? Math.max(10, r.top - 6 - pop.offsetHeight) : r.bottom + 6) + 'px';
  }
  function closePopover() { $('#popover').classList.remove('open'); }

  // ------------------------------------------------------------------ step 4: export
  function viewExport() {
    const ws = state.ws;
    if (!ws || !ws.outlets.length) return `<section class="card"><h2>4. Export</h2><p>Nothing to export yet.</p></section>`;
    const rows = ws.outlets.map((o) => {
      const r = state.results[o.id];
      const inc = o.employees.filter((e) => e.include !== false);
      const flags = inc.filter((e) => e.flags && e.flags.length).length;
      const noJoin = inc.filter((e) => !e.joinDate && e.category !== 'MGMT').length;
      const issues = [];
      if (o.kind !== 'central' && o.scEnabled !== false && !E.num(o.scCollected)) issues.push('service charge collected is 0');
      if (o.incEnabled && !E.num(o.netSales)) issues.push('net sales is 0');
      if (flags) issues.push(`${flags} staff with notes`);
      if (noJoin) issues.push(`${noJoin} without join date`);
      if (r.sc && Math.abs(r.sc.totals.variance) > 1) issues.push(`SC difference RM ${rm(r.sc.totals.variance)}`);
      return `<tr><td class="center"><input type="checkbox" data-o="${o.id}" data-of="export" ${o.export !== false ? 'checked' : ''} aria-label="Export ${esc(o.sheetName)}"></td><td><b>${esc(o.sheetName)}</b><div class="small muted">${[o.scEnabled !== false ? 'Service charge' : '', o.incEnabled ? 'Incentive' : ''].filter(Boolean).join(' + ')}</div></td><td class="num">${inc.length}</td>
        <td class="num">${r.sc ? rm(r.sc.summary.PointValue) : '—'}</td><td class="num">${r.inc ? rm(r.inc.summary.PointValue) : '—'}</td>
        <td>${issues.length ? issues.map((i) => `<span class="tag bad">${esc(i)}</span>`).join(' ') : '<span class="tag ok">ready</span>'}</td></tr>`;
    }).join('');
    const mm = monthLabel(ws.month).replace(' 20', '');
    return `<section class="card">
      <div class="card-head"><h2>4. Download Excel files</h2></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Export</th><th>Outlet tab</th><th>Staff included</th><th>1 service point</th><th>1 incentive point</th><th>Checks</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="row" style="margin-top:14px">
        <button class="btn primary" data-act="export" data-s="sc">⬇ Service Charge - ${esc(mm)}.xlsx</button>
        ${ws.outlets.some((o) => o.incEnabled) ? `<button class="btn primary" data-act="export" data-s="inc">⬇ Incentive - ${esc(mm)}.xlsx</button>` : '<span class="small muted">No outlet has incentive ticked — only the service charge file is produced.</span>'}
      </div>
      <p class="small muted" style="margin-top:10px">Each outlet becomes one tab in the stakeholder layout. All calculated cells are live Excel formulas (points, amounts, totals, point value), the yellow cells are the inputs,
      and "Precision as displayed" is switched on like in the stakeholder file so Excel gives exactly the numbers shown here. Grey "Check" columns on the right should read TRUE / 0.</p>
    </section>
    <section class="card"><div class="card-head"><h3>This month's work</h3></div>
      <div class="row"><button class="btn" data-act="saveBackup">Save backup (.json)</button><label class="btn">Load backup<input type="file" id="backupInput" accept=".json" hidden></label>
        <button class="btn danger" data-act="resetWs">Start a new month (clear outlets)</button></div>
      <p class="small muted">Everything stays in this browser. Positions, join dates and points you typed are remembered for next month (Settings → Outlets &amp; staff memory).</p></section>`;
  }

  async function doExport(scheme) {
    const ws = state.ws; const ids = ws.outlets.filter((o) => o.export !== false && (scheme === 'sc' ? o.scEnabled !== false : o.incEnabled)).map((o) => o.id);
    if (!ids.length) { toast('Tick at least one outlet.'); return; }
    try {
      const wb = X.exportWorkbook(ws, scheme, state.settings, ExcelJS, { outletIds: ids, results: state.results });
      if (!wb.worksheets.length) { toast(scheme === 'inc' ? 'No ticked outlet has incentive turned on.' : 'No ticked outlet has service charge.'); return; }
      const buf = await X.toBuffer(wb, state.settings, window.JSZip);
      const mm = monthLabel(ws.month).replace(' 20', '');
      download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${scheme === 'sc' ? 'Service Charge' : 'Incentive'} - ${mm}.xlsx`);
    } catch (e) { console.error(e); toast('Export failed: ' + e.message, 6000); }
  }
  function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }

  // ------------------------------------------------------------------ settings modal
  function openSettings(tab) { if (tab) state.ui.settingsTab = tab; $('#modalBg').classList.add('open'); renderSettings(); }
  function closeSettings() { $('#modalBg').classList.remove('open'); render(); }
  function modelSelect(field, value) {
    const groups = [['Google Gemini', AI.MODEL_PRESETS.filter((x) => x.provider === 'gemini')], ['Anthropic Claude', AI.MODEL_PRESETS.filter((x) => x.provider === 'anthropic')], ['Other', AI.MODEL_PRESETS.filter((x) => x.id === 'custom')]];
    return `<select data-s="ai.${field === 'quickPreset' ? 'preset' : field}" id="${field}">${groups.map(([g, list]) => `<optgroup label="${g}">${list.map((x) => `<option value="${x.id}" ${value === x.id ? 'selected' : ''}>${esc(x.label)}${x.provider && !AI.keyFor(state.settings.ai, x.provider) ? ' — no key yet' : ''}</option>`).join('')}</optgroup>`).join('')}</select>`;
  }

  function renderSettings() {
    const s = state.settings; const t = state.ui.settingsTab;
    const tabs = [['ai', 'AI'], ['outlets', 'Outlets & staff memory'], ['rules', 'Rules'], ['codes', 'Leave codes'], ['formulas', 'Formulas'], ['look', 'Colours & sign-off'], ['help', 'Help']];
    let body = '';
    if (t === 'ai') {
      const p = AI.PROVIDERS[s.ai.provider] || AI.PROVIDERS.gemini;
      body = `<div class="grid2">
        <div class="stack">
          <label class="field">AI model used to read attendance${modelSelect('preset', s.ai.preset)}</label>
          ${s.ai.preset === 'custom' ? `<div class="row">
            <label class="field">Provider<select data-s="ai.provider">${Object.entries(AI.PROVIDERS).map(([k, v]) => `<option value="${k}" ${s.ai.provider === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
            <label class="field" style="flex:1">Model name<div class="row"><input type="text" data-s="ai.model" value="${esc(s.ai.model || p.defaultModel)}" list="modelList" style="flex:1"><button class="btn sm" data-act="listModels">List models</button></div><datalist id="modelList">${(state.ui.models || []).map((m) => `<option value="${esc(m)}">`).join('')}</datalist></label></div>`
            : `<p class="small muted">${esc((AI.presetById(s.ai.preset) || {}).note || '')} · model id <span class="mono">${esc(s.ai.model)}</span> <button class="btn sm link" data-act="listModels">see all models for this key</button></p>
               ${(state.ui.models || []).length ? `<p class="small mono" style="max-height:90px;overflow:auto">${state.ui.models.map(esc).join(' · ')}</p>` : ''}`}
          <label class="field">If it fails (quota / error), switch to<select data-s="ai.fallbackPreset"><option value="">— no fallback —</option>${AI.MODEL_PRESETS.filter((x) => x.id !== 'custom' && x.id !== s.ai.preset).map((x) => `<option value="${x.id}" ${s.ai.fallbackPreset === x.id ? 'selected' : ''}>${esc(x.label)}${AI.keyFor(s.ai, x.provider) ? '' : ' (needs key)'}</option>`).join('')}</select></label>
          <h3 style="margin-top:6px">API keys (each provider keeps its own key)</h3>
          ${[['gemini', 'Google Gemini key'], ['anthropic', 'Anthropic Claude key'], ['openai', 'OpenAI-compatible key (custom only)']].map(([k, l]) => `<label class="field">${l} <a href="${AI.PROVIDERS[k].keyUrl}" target="_blank" rel="noopener">get a key</a>
            <input type="password" data-key="${k}" value="${esc(s.ai.keys[k] || '')}" autocomplete="off" placeholder="${k === s.ai.provider ? 'required for the selected model' : 'optional'}"></label>`).join('')}
          <label class="check"><input type="checkbox" data-s="ai.rememberKey" ${s.ai.rememberKey ? 'checked' : ''}> Remember keys in this browser</label>
          ${s.ai.provider === 'openai' ? `<label class="field">Base URL (OpenAI-compatible)<input type="text" data-s="ai.baseUrl" value="${esc(s.ai.baseUrl || '')}" placeholder="${p.baseUrl}"></label>
            <p class="small muted">OpenRouter: https://openrouter.ai/api/v1 · Groq: https://api.groq.com/openai/v1 · OpenAI: leave empty</p>` : ''}
          <div class="row"><button class="btn" data-act="testAI">Test connection</button><span id="aiTest" class="small"></span></div>
        </div>
        <div class="notice">${aiAdvice()}</div></div>`;
    } else if (t === 'rules') {
      body = `<h3>Deduction tiers (Total days = MC/HL + UPL + Lateness)</h3>
        <div class="tbl-wrap" style="max-height:none;margin:8px 0 14px"><table class="tbl"><thead><tr><th>From day</th><th>To day</th><th>Deduction %</th><th>Label</th><th>Text in Excel</th><th></th></tr></thead><tbody>
        ${s.tiers.map((tr, i) => `<tr><td><input type="number" data-tier="${i}" data-tf="from" value="${tr.from}"></td><td><input type="number" data-tier="${i}" data-tf="to" value="${tr.to}"></td><td><input type="number" step="1" data-tier="${i}" data-tf="pct" value="${E.xlRound(tr.pct * 100, 2)}"></td>
          <td><input type="text" data-tier="${i}" data-tf="label" value="${esc(tr.label)}"></td><td><input type="text" data-tier="${i}" data-tf="text" value="${esc(tr.text)}" style="width:260px"></td><td><button class="btn sm danger" data-act="delTier" data-i="${i}">✕</button></td></tr>`).join('')}
        </tbody></table></div><button class="btn sm" data-act="addTier">+ Add tier</button>
        <div class="grid2" style="margin-top:14px">
          <div class="stack"><h3>Service charge</h3>
            <label class="field">Distribute % of service charge collected<input type="number" step="0.01" data-s="sc.distributePct" data-pct value="${E.xlRound(s.sc.distributePct * 100, 4)}"></label>
            <label class="field">Central Kitchen / HQ %<input type="number" step="0.01" data-s="sc.ckPct" data-pct value="${E.xlRound(s.sc.ckPct * 100, 4)}"></label>
            <label class="field">Foreign worker share of a point<input type="number" step="0.01" data-s="fwShare" value="${s.fwShare}"></label>
            <label class="field">Company share of a foreign-worker point<input type="number" step="0.01" data-s="companyShare" value="${s.companyShare}"></label>
            <label class="field">Minimum rule (top-up)<select data-s="sc.minMode"><option value="off" ${s.sc.minMode === 'off' ? 'selected' : ''}>Off</option><option value="point" ${s.sc.minMode === 'point' ? 'selected' : ''}>Minimum RM per service point</option><option value="staff" ${s.sc.minMode === 'staff' ? 'selected' : ''}>Minimum RM per staff payout</option></select></label>
            <label class="field">Minimum amount (RM)<input type="number" step="1" data-s="sc.minValue" value="${s.sc.minValue}"></label>
            <p class="small muted">Stakeholder: "Minimum RM 450, top up until RM 450". Default reading: if 1 service point is worth less than RM 450 the company tops it up. Choose "per staff" if the minimum is per person's payout.</p></div>
          <div class="stack"><h3>Incentive</h3>
            <label class="field">Incentive % of net sales<input type="number" step="0.01" data-s="inc.pct" data-pct value="${E.xlRound(s.inc.pct * 100, 4)}"></label>
            <label class="field">Foreign worker share of an incentive point<input type="number" step="0.01" data-s="inc.fwShare" value="${s.inc.fwShare}"></label>
            <label class="field">Minimum rule<select data-s="inc.minMode"><option value="off" ${s.inc.minMode === 'off' ? 'selected' : ''}>Off</option><option value="point" ${s.inc.minMode === 'point' ? 'selected' : ''}>Minimum RM per point</option><option value="staff" ${s.inc.minMode === 'staff' ? 'selected' : ''}>Minimum RM per staff</option></select></label>
            <label class="field">Minimum amount (RM)<input type="number" step="1" data-s="inc.minValue" value="${s.inc.minValue}"></label>
            <h3 style="margin-top:12px">Attendance</h3>
            <label class="check"><input type="checkbox" data-s="absentCountsAsUPL" ${s.absentCountsAsUPL ? 'checked' : ''}> Count absent / blank days as UPL (deducted)</label>
            <label class="check"><input type="checkbox" data-s="lateDetection" ${s.lateDetection ? 'checked' : ''}> Detect lateness from first punch</label>
            <div class="row"><label class="field">Shift start<input type="text" data-s="shiftStart" value="${esc(s.shiftStart)}" style="width:80px"></label><label class="field">Grace (min)<input type="number" data-s="lateGraceMinutes" value="${s.lateGraceMinutes}" style="width:80px"></label>
              <label class="field">Lates = 1 day (0 = count only)<input type="number" data-s="lateCountPerDay" value="${s.lateCountPerDay}" style="width:80px"></label></div>
            <label class="check"><input type="checkbox" data-s="precisionAsDisplayed" ${s.precisionAsDisplayed !== false ? 'checked' : ''}> Precision as displayed (round every cell to 2 decimals — same as the stakeholder workbook)</label>
          </div></div>`;
    } else if (t === 'codes') {
      body = `<p class="muted">How each code written on the attendance log is treated. "No deduction" codes (OFF, AL, PH…) do not reduce points (K stays). MC and UPL categories are deducted (M goes down). HS/MC = MC category.</p>
        <div class="tbl-wrap" style="max-height:60vh"><table class="tbl"><thead><tr><th>Code</th><th>Category</th><th>Description</th><th></th></tr></thead><tbody>
        ${s.codes.map((c, i) => `<tr><td><input type="text" data-code="${i}" data-cf="code" value="${esc(c.code)}" style="width:100px"></td><td><select data-code="${i}" data-cf="category">${[['WORK', 'Worked'], ['NODEDUCT', 'No deduction (K)'], ['MC', 'MC / HL (deduct)'], ['UPL', 'Unpaid (deduct)'], ['ABSENT', 'Absent (deduct as UPL)'], ['NOTEMP', 'Not employed']].map(([k, l]) => `<option value="${k}" ${c.category === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
          <td><input type="text" data-code="${i}" data-cf="desc" value="${esc(c.desc)}" style="width:100%"></td><td><button class="btn sm danger" data-act="delCode" data-i="${i}">✕</button></td></tr>`).join('')}
        </tbody></table></div><button class="btn sm" data-act="addCode" style="margin-top:8px">+ Add code</button>`;
    } else if (t === 'formulas') {
      body = `<p class="muted">Every number is produced by these formulas — on screen and as real Excel formulas in the download. Use the variable names below, numbers, + − * / ^, brackets and ROUND, ROUNDUP, ROUNDDOWN, MAX, MIN, IF, ABS. Changes apply immediately.</p>
        ${Object.entries(E.DEFAULT_FORMULAS).map(([id, d]) => {
          const cur = s.formulas[id] || d.expr; let status = '';
          try { const ast = E.parse(cur); const unknown = [...E.identifiers(ast)].filter((v) => !E.VARIABLES[v]); status = unknown.length ? `<span class="badmark">Unknown: ${esc(unknown.join(', '))}</span>` : '<span class="okmark">✓ valid</span>'; } catch (e) { status = `<span class="badmark">${esc(e.message)}</span>`; }
          return `<div class="formula-row" id="f-${id}"><div class="row"><b>${esc(d.label)}</b><span class="spacer" style="flex:1"></span>${status}${cur !== d.expr ? ` <button class="btn sm" data-act="resetFormula" data-id="${id}">Reset to default</button>` : ''}</div>
            <div class="small muted">${esc(d.help)}</div><textarea data-formula="${id}" spellcheck="false">${esc(cur)}</textarea></div>`;
        }).join('')}
        <h3>Variables</h3><div class="tbl-wrap" style="max-height:none"><table class="tbl"><tbody>${Object.entries(E.VARIABLES).map(([k, v]) => `<tr><td class="mono">${k}</td><td class="small">${esc(v)}</td></tr>`).join('')}</tbody></table></div>`;
    } else if (t === 'look') {
      const c = s.colors;
      const names = { MGMT: 'Management (orange)', HEAD: 'Outlet head', HELPER: 'Helping from other outlet (light green)', RASA: 'Rasa by Grandmama (blue)', CASUAL: 'Casual labour (green)', FW: 'Foreign worker (red)', DEDUCT: 'Attendance deduction 4+ days (purple)', fontNew: 'Font – new joiner', fontLeaving: 'Font – resigned / absconded', fontNormal: 'Font – current staff' };
      body = `<div class="grid2"><div class="stack"><h3>Row colours in Excel</h3>${Object.entries(names).map(([k, l]) => `<label class="row"><input type="color" data-color="${k}" value="#${c[k].slice(-6)}"> ${l}</label>`).join('')}</div>
        <div class="stack"><h3>Sign-off block</h3>${s.signatories.map((sg, i) => `<div class="row"><input type="text" data-sig="${i}" data-sf="role" value="${esc(sg.role)}" style="width:110px"><input type="text" data-sig="${i}" data-sf="name" value="${esc(sg.name)}" style="width:150px"><input type="text" data-sig="${i}" data-sf="position" value="${esc(sg.position)}" style="width:90px"></div>`).join('')}
        <h3>Terms & conditions (one per line)</h3><textarea data-terms style="min-height:140px">${esc(s.terms.join('\n'))}</textarea></div></div>
        <div class="row" style="margin-top:12px"><button class="btn" data-act="exportSettings">Export settings (.json)</button><label class="btn">Import settings<input type="file" id="settingsInput" accept=".json" hidden></label><button class="btn danger" data-act="resetSettings">Reset all settings</button></div>`;
    } else if (t === 'outlets') {
      const dirN = Object.keys(state.dir).length;
      body = `<p class="muted">Outlets you can assign an attendance file to. Company and title go into the Excel heading ("COMPANY - GRANDMAMA'S RESTAURANT - TITLE"); the code appears in "Details - GMM CODE".</p>
        <div class="tbl-wrap" style="max-height:none"><table class="tbl"><thead><tr><th>Tab name</th><th>Company</th><th>Title in Excel</th><th>Code</th><th>Central kitchen</th><th>Tab colour</th><th></th></tr></thead><tbody>
        ${s.outlets.map((x, i) => `<tr>${['name', 'company', 'title', 'code'].map((k) => `<td><input type="text" data-od="${i}" data-odf="${k}" value="${esc(x[k] || '')}" style="width:${k === 'company' ? 210 : 150}px"></td>`).join('')}
          <td class="center"><input type="checkbox" data-od="${i}" data-odf="central" ${x.kind === 'central' ? 'checked' : ''} aria-label="Central kitchen"></td>
          <td><input type="color" data-od="${i}" data-odf="tab" value="#${(x.tab || 'FF92D050').slice(-6)}"></td><td><button class="btn sm danger" data-act="delOutletDef" data-i="${i}">✕</button></td></tr>`).join('')}
        </tbody></table></div><button class="btn sm" data-act="addOutletDef" style="margin-top:8px">+ Add outlet</button>
        <h3 style="margin-top:16px">Staff memory</h3>
        <p class="muted small">${dirN} staff remembered. When the same person appears on a future attendance file, their position, join date, status, category, points and outlet are filled in automatically. HQ management rows added to an outlet are re-added every month.</p>
        <button class="btn sm danger" data-act="clearDir">Forget remembered staff</button>`;
    } else body = helpHtml();
    $('#modal').innerHTML = `<div class="mh"><h2>Settings</h2><span style="flex:1"></span><button class="btn" data-act="closeSettings" aria-label="Close">✕</button></div>
      <div class="mb"><div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${t === k ? 'active' : ''}" data-act="settingsTab" data-tab="${k}">${l}</button>`).join('')}</div>${body}</div>`;
  }

  function aiAdvice() {
    return `<b>Which AI to use?</b><br>
    • <b>Gemini 3.8 Flash</b> (default) — best of the Gemini models on your key for scanned tables and handwriting.<br>
    • <b>Gemini 3.5 Flash</b> — set as the automatic fallback: if 3.8 hits its quota or errors, the run continues on 3.5 instead of stopping.<br>
    • <b>Gemini 3.5 Flash Lite</b> — fastest and cheapest; may misread handwritten codes, so check the day strips.<br>
    • <b>Claude Sonnet / Opus / Haiku</b> — ready for when you have an Anthropic key: paste it under "Anthropic Claude key" and pick a Claude model. The tool uses the newest model of that family your key can access.<br>
    • <b>Custom</b> — any other Gemini, Claude or OpenAI-compatible model id.<br>
    The AI only reads the log; all calculations are done by the tool, so switching models never changes the rules. Keys go only from this browser to the provider.
    On Gemini's free tier Google may use the data to improve its products — a billed key avoids that.`;
  }

  function helpHtml() {
    return `<div class="stack">
      <h3>How the tool works</h3>
      <ol>
        <li><b>Attendance</b>: upload the scanned attendance (List of Logs or Daily Time Record). The AI reads each page: punches, printed status, HR's handwritten codes (OFF, AL, PH, MC, TRN, UPL…), notes and circled totals. You can add "external circumstances" for the AI.</li>
        <li><b>Outlet &amp; entitlement</b>: pick the outlet, the month and year, and tick Service charge and/or Incentive (only when the outlet hit its target). The staff list is created from the attendance — no previous Excel needed. Staff with blank attendance are not recorded.</li>
        <li><b>Review</b>: every number can be edited. Click <span class="qbtn" style="display:inline-block">?</span> to see a formula with this row's numbers. Typed numbers turn yellow and override the formula.</li>
        <li><b>Export</b> the Service Charge and Incentive workbooks with live Excel formulas.</li>
      </ol>
      <h3>Rules used (from the stakeholder files)</h3>
      <ul>
        <li>K (Point Entitlement) = 1 point (0.5 for some HQ managers, 2 for outlet heads in incentive), prorated for days employed. Non-deductible leave (OFF, AL, PH…) does not change K.</li>
        <li>L (Days Worked) = days in month − not-employed days − MC/HL − UPL − lateness. M (No. of points) = ROUND(L / days, 2). Foreign workers: M × 0.25, N = × 0.75 (company).</li>
        <li>Total Days (MC/HL + UPL + Lateness): 1–3 prorate · 4–5 30% deduction · 6–7 50% · 8+ 100%. Points lost go to the pool; the rest of a tier deduction is rolled back to the company.</li>
        <li>Service point = (Collected × 80% − 11% CK/HQ − fixed SC) ÷ total K. Minimum RM 450 top-up (configurable). Incentive point = 1.5% of net sales ÷ total K.</li>
        <li>Absconded / short notice: not entitled, rolled back. Resigned with full notice: prorated.</li>
      </ul>
      <h3>Privacy</h3><p>No login and no server: files, staff data and the API key stay in this browser (local storage). Only the page images are sent to the AI provider you choose.</p></div>`;
  }

  // ------------------------------------------------------------------ actions
  async function loadAttendanceFiles(files) {
    const a = state.ui.att; a.error = null; a.records = null; a.pageResults = null;
    a.fileName = [...files].map((f) => f.name).join(', ');
    a.rawFiles = [...files];
    await renderAttendancePages();
  }
  async function renderAttendancePages() {
    const a = state.ui.att; a.pages = []; a.progress = { done: 0, total: 1, text: 'Rendering pages…' }; render();
    try {
      for (const f of a.rawFiles || []) {
        if (/pdf$/i.test(f.name) || f.type === 'application/pdf') a.pages.push(...await AI.renderPdf(await f.arrayBuffer(), window.pdfjsLib, { rotate: a.rotate }));
        else a.pages.push(await AI.imageFileToPage(f, a.pages.length + 1, a.rotate));
      }
      a.pages.forEach((p, i) => { p.n = i + 1; });
    } catch (e) { a.error = 'Could not open the file: ' + e.message; }
    a.progress = null; render();
  }

  async function runExtraction() {
    const a = state.ui.att; const s = state.settings;
    if (!hasKey()) { openSettings('ai'); toast(`Add a key for ${AI.currentLabel(s.ai)} first.`); return; }
    a.error = null; a.busy = true; a.abort = new AbortController();
    a.progress = { done: 0, total: a.pages.length, text: 'Starting…' }; render();
    try {
      const pr = await AI.extractPages(a.pages, s, 31, (p) => {
        a.progress = { done: p.status === 'done' ? p.page : p.page - 1, total: p.pages, text: p.status === 'done' ? `Page ${p.page}/${p.pages}: ${p.count} staff (${p.model})` : p.status === 'fallback' ? p.text : `Reading page ${p.page} of ${p.pages} with ${AI.currentLabel(s.ai)}…` };
        if (p.status === 'fallback') toast(p.text, 8000);
        const bar = $('.progress > div'); if (bar) { bar.style.width = Math.round(a.progress.done / a.progress.total * 100) + '%'; $('.progress + p').textContent = a.progress.text; }
      }, a.abort.signal);
      if (s.ai._resolvedNote) { toast(s.ai._resolvedNote, 8000); delete s.ai._resolvedNote; saveSettings(); }
      setScan(pr);
      a.progress = { done: 1, total: 1, text: `Done — ${a.records.length} staff read from ${pr.length} page(s) with ${pr.modelUsed}${pr.fallbackUsed ? ` (fallback ${pr.fallbackUsed} used)` : ''}.` };
      a.modelUsed = pr.modelUsed;
    } catch (e) { a.error = e.name === 'AbortError' ? 'Cancelled.' : e.message; a.progress = null; }
    a.busy = false; render();
  }
  function createOutletFromScan() {
    const a = state.ui.att; const s = state.settings; const g = state.ui.asg;
    const ws = ensureWs();
    if (ws.outlets.length && ws.attendanceMonth !== g.attMonth && !confirm(`The outlets already in this month's files use attendance ${monthLabel(ws.attendanceMonth)}. Switch everything to ${monthLabel(g.attMonth)}?`)) return;
    ws.month = g.payMonth; ws.attendanceMonth = g.attMonth; ws.daysInMonth = Number(g.days) || E.daysInMonth(g.attMonth);
    const def = s.outlets.find((x) => x.name === g.outlet) || { name: g.outlet, company: (a.meta && a.meta.company) || '', title: g.outlet.toUpperCase(), code: g.outlet.toUpperCase(), kind: 'outlet', tab: 'FF92D050' };
    let o = ws.outlets.find((x) => x.sheetName === def.name);
    if (o && !confirm(`${def.name} already has a staff list this month. Replace it with this attendance file?`)) return;
    if (!o) { o = { id: 'o' + Date.now().toString(36), fixedRows: [] }; ws.outlets.push(o); }
    Object.assign(o, { sheetName: def.name, company: def.company || (a.meta && a.meta.company) || '', brand: "GRANDMAMA'S RESTAURANT", outletTitle: def.title || def.name.toUpperCase(), code: def.code || def.name.toUpperCase(),
      kind: def.kind || 'outlet', tabColor: def.tab || 'FF92D050', scEnabled: !!g.sc, incEnabled: !!g.inc, scCollected: Number(g.scCollected) || 0, netSales: Number(g.netSales) || 0, incPct: g.incPct, export: true, aiReview: null });
    if (o.kind === 'central') o.ckSources = s.outlets.filter((x) => x.kind !== 'central').map((x) => ({ outlet: x.name, amount: 0 }));
    const recs = a.records.map((r) => ({ ...r, days: AI.normaliseDays(r.days, ws.daysInMonth) }));
    const rep = E.buildOutletFromAttendance(o, recs, s, ws.daysInMonth, state.dir, ws.attendanceMonth);
    o.attendance = { file: a.fileName, appliedAt: new Date().toISOString(), report: rep, model: a.modelUsed || '' };
    state.ui.outletId = o.id; state.ui.scheme = o.scEnabled ? 'sc' : 'inc'; state.ui.asg = null; state.ui.lastOutlet = o.sheetName; a.assignedTo = o.sheetName; state.ui.reassign = false;
    saveWorkspace();
    toast(`${o.sheetName}: ${o.employees.filter((e) => e.include !== false).length} staff created${rep.blank.length ? `, ${rep.blank.length} with blank attendance not recorded` : ''}.`, 6000);
    go(3);
  }

  // After the AI (or a saved extraction): work out the period / days from the report itself.
  function setScan(pr) {
    const a = state.ui.att;
    a.pageResults = pr; a.meta = AI.reportMeta(pr);
    const end = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a.meta.periodEnd || '');
    const start = /^(\d{4})-(\d{2})/.exec(a.meta.periodStart || '');
    const lens = pr.flatMap((p) => (p.employees || []).map((e) => (e.days || []).length)).filter((n) => n >= 28 && n <= 31);
    a.dim = end ? Number(end[3]) : start ? E.daysInMonth(`${start[1]}-${start[2]}`) : (lens.sort((x, y) => lens.filter((v) => v === y).length - lens.filter((v) => v === x).length)[0] || 31);
    a.records = AI.mergePages(pr, a.dim);
    state.ui.asg = null; a.assignedTo = null;
  }

  async function runReview() {
    const o = ensureOutlet(); const scheme = state.ui.scheme === 'inc' && o.incEnabled ? 'inc' : 'sc';
    if (!hasKey()) { openSettings('ai'); toast(`Add a key for ${AI.currentLabel(state.settings.ai)} first.`); return; }
    toast('Asking the AI to review…', 20000);
    try {
      const res = await AI.reviewOutlet(state.settings, o, state.results[o.id][scheme].rows, state.ws.daysInMonth);
      o.aiReview = { scheme, summary: res.summary || '', suggestions: Array.isArray(res.suggestions) ? res.suggestions : [], at: new Date().toLocaleString() };
      saveWorkspace(); render(); toast('AI review ready.');
    } catch (e) { toast('AI review failed: ' + e.message, 7000); }
  }
  function applySuggestion(i) {
    const o = ensureOutlet(); const sg = o.aiReview.suggestions[i];
    const r = o.employees.find((e) => (sg.empNo && E.normId(e.empNo) === E.normId(sg.empNo)) || (sg.name && E.nameScore(sg.name, e.name) >= 0.9));
    if (!r) { toast('Could not find that staff member.'); return; }
    const numeric = ['mc', 'upl', 'absent', 'lateDays', 'notEmployed'];
    if (!['mc', 'upl', 'absent', 'lateDays', 'notEmployed', 'exitType', 'waiveTier', 'include', 'extraRemark'].includes(sg.field)) { toast('Unsupported field: ' + sg.field); return; }
    r[sg.field] = numeric.includes(sg.field) ? E.num(sg.value) : sg.field === 'waiveTier' || sg.field === 'include' ? sg.value === true || sg.value === 'true' : sg.value;
    sg.applied = true; saveWorkspace(); render();
  }

  // ------------------------------------------------------------------ event wiring
  function setPath(obj, path, val) { const ks = path.split('.'); let o = obj; ks.slice(0, -1).forEach((k) => { o = o[k] = o[k] || {}; }); o[ks[ks.length - 1]] = val; }

  document.addEventListener('click', async (ev) => {
    const q = ev.target.closest('[data-q]');
    if (q) { ev.stopPropagation(); const ctx = q.dataset.ctx === 'summary' ? 'summary' : null; showFormula(q.dataset.q, q, ctx); return; }
    const cell = ev.target.closest('[data-cell]');
    if (cell) {
      const o = ensureOutlet(); const scheme = state.ui.scheme === 'inc' && o.incEnabled ? 'inc' : 'sc';
      const x = state.results[o.id][scheme].rows.find((y) => y.row.id === cell.dataset.r);
      const id = cell.dataset.cell === 'entitled' ? x.fx.entitled : cell.dataset.cell === 'pool' ? 'poolAmount' : (x.fx.mia || x.fx.deduction || x.fx.fwCompany);
      if (id && id !== 'override') showFormula(id, cell, { rowId: x.row.id, name: x.row.name }); else toast('This value was typed in (override).');
      return;
    }
    if (!ev.target.closest('#popover')) closePopover();
    const t = ev.target.closest('[data-act]'); if (!t) {
      if (ev.target.closest('#attDrop')) $('#attInput').click();
      if (ev.target.closest('.step')) go(Number(ev.target.closest('.step').dataset.step));
      return;
    }
    const act = t.dataset.act; const o = outlet();
    switch (act) {
      case 'go': go(Number(t.dataset.step)); break;
      case 'settings': openSettings(t.dataset.tab); break;
      case 'closeSettings': saveSettings(); closeSettings(); break;
      case 'settingsTab': state.ui.settingsTab = t.dataset.tab; renderSettings(); break;
      case 'help': openSettings('help'); break;
      case 'openOutlet': state.ui.outletId = t.dataset.id; go(3); break;
      case 'scheme': state.ui.scheme = t.dataset.s; render(); break;
      case 'enableInc': o.incEnabled = true; state.ui.scheme = 'inc'; saveWorkspace(); render(); toast('Incentive turned on — enter the net sales.'); break;
      case 'openRow': state.ui.drawerRow = t.dataset.id; renderDrawer(); break;
      case 'closeDrawer': state.ui.drawerRow = null; $('#drawer').classList.remove('open'); break;
      case 'addRow': { const mg = !!t.dataset.mgmt; const r = { id: 'r' + Date.now().toString(36), dept: mg ? 'SERVICE' : '', empNo: '', name: mg ? 'HQ MANAGER' : 'NEW STAFF', position: '', joinDate: '', status: 'PERMANENT', category: mg ? 'MGMT' : 'PERM', base: 1, mc: 0, upl: 0, absent: 0, lateDays: 0, notEmployed: 0, overrides: {}, incOverrides: {}, include: true, isNew: !mg, keepWithoutAttendance: mg, inIncentive: !mg, flags: mg ? [] : ['Added manually'] };
        if (mg) { const i = o.employees.findIndex((e) => e.category !== 'MGMT'); o.employees.splice(i < 0 ? o.employees.length : i, 0, r); } else
        o.employees.push(r); state.ui.drawerRow = r.id; saveWorkspace(); render(); break; }
      case 'delRow': if (confirm('Remove this staff member from the outlet?')) { o.employees = o.employees.filter((e) => e.id !== t.dataset.id); state.ui.drawerRow = null; $('#drawer').classList.remove('open'); saveWorkspace(); render(); } break;
      case 'recount': { const r = o.employees.find((e) => e.id === t.dataset.id); const s = E.summariseDays(r.attendance.days, state.settings, state.ws.daysInMonth);
        Object.assign(r, { mc: s.MC, upl: s.UPL, absent: s.ABSENT, notEmployed: s.NOTEMP }); r.attendance.codeString = r.attendance.days.map((d) => d.code).join(' '); saveWorkspace(); render(); toast('Counts updated from the day codes.'); break; }
      case 'addFixed': (o.fixedRows = o.fixedRows || []).push({ fromOutlet: '', empNo: '', name: '', position: '', days: '', amount: 0, remark: '' }); saveWorkspace(); render(); break;
      case 'delFixed': o.fixedRows.splice(Number(t.dataset.i), 1); saveWorkspace(); render(); break;
      case 'aiReview': runReview(); break;
      case 'closeReview': o.aiReview = null; saveWorkspace(); render(); break;
      case 'applySug': applySuggestion(Number(t.dataset.i)); break;
      case 'extract': runExtraction(); break;
      case 'cancelExtract': state.ui.att.abort && state.ui.att.abort.abort(); break;
      case 'saveExtract': { const a = state.ui.att; download(new Blob([JSON.stringify({ file: a.fileName, meta: a.meta, daysInMonth: a.dim, pages: a.pageResults }, null, 1)], { type: 'application/json' }), `attendance-extraction-${(a.fileName || 'scan').replace(/\.[a-z]+$/i, '')}.json`); break; }
      case 'zoomPage': { const p = state.ui.att.pages[Number(t.dataset.i)]; const w = window.open(); if (w) w.document.write(`<title>Page ${p.n}</title><img src="${p.dataUrl}" style="width:100%">`); break; }
      case 'export': doExport(t.dataset.s); break;
      case 'saveBackup': download(new Blob([JSON.stringify({ workspace: state.ws, settings: { ...state.settings, ai: stripKeys(state.settings.ai) } }, null, 1)], { type: 'application/json' }), `gmm-workspace-${state.ws.month}.json`); break;
      case 'resetWs': if (confirm('Start a new month? All outlets in this month\'s files are cleared from this browser (settings and remembered staff details are kept).')) { state.ws = null; store.del('gmm.workspace'); state.ui.outletId = null; go(1); } break;
      case 'createOutlet': createOutletFromScan(); break;
      case 'reassign': state.ui.reassign = true; state.ui.asg = null; render(); break;
      case 'newOutlet': { const n = prompt('Name of the new outlet (tab name in Excel):'); if (n && n.trim()) { state.settings.outlets.push({ name: n.trim(), company: (state.ui.att.meta && state.ui.att.meta.company) || '', title: n.trim().toUpperCase(), code: n.trim().toUpperCase(), kind: 'outlet', tab: 'FF92D050' }); saveSettings(); state.ui.asg.outlet = n.trim(); render(); } break; }
      case 'removeOutlet': if (confirm('Remove this outlet from this month\'s files?')) { state.ws.outlets = state.ws.outlets.filter((x) => x.id !== t.dataset.id); state.ui.outletId = null; saveWorkspace(); render(); } break;
      case 'addOutletDef': state.settings.outlets.push({ name: 'New outlet', company: '', title: 'NEW OUTLET', code: 'NEW', kind: 'outlet', tab: 'FF92D050' }); saveSettings(); renderSettings(); break;
      case 'delOutletDef': state.settings.outlets.splice(Number(t.dataset.i), 1); saveSettings(); renderSettings(); break;
      case 'clearDir': if (confirm('Forget all remembered staff details (positions, join dates, points)?')) { state.dir = {}; store.set('gmm.directory', {}); renderSettings(); } break;
      case 'listModels': try { state.ui.models = await AI.listModels(state.settings); renderSettings(); toast(`${state.ui.models.length} models available.`); } catch (e) { toast(e.message, 6000); } break;
      case 'testAI': { $('#aiTest').textContent = 'Testing…'; try { await AI.callModel(state.settings, [{ text: 'Reply with JSON {"ok":true}' }], { maxTokens: 1024 }); const ai = state.settings.ai; const used = ai._resolvedModel || ai.model; delete ai._resolvedModel;
          const note = ai._resolvedNote; delete ai._resolvedNote; saveSettings(); renderSettings();
          $('#aiTest').innerHTML = `<span class="okmark">✓ Connected — ${esc(AI.currentLabel(ai))} (model id ${esc(used)})</span>${note ? `<br><span class="small">${esc(note)}</span>` : ''}`; } catch (e) { $('#aiTest').innerHTML = `<span class="badmark">${esc(e.message)}</span>`; } break; }
      case 'editFormula': closePopover(); openSettings('formulas'); setTimeout(() => { const el = $(`#f-${t.dataset.id}`); if (el) { el.scrollIntoView({ block: 'center' }); $('textarea', el).focus(); } }, 50); break;
      case 'resetFormula': state.settings.formulas[t.dataset.id] = E.DEFAULT_FORMULAS[t.dataset.id].expr; saveSettings(); renderSettings(); break;
      case 'addTier': state.settings.tiers.push({ from: 0, to: 0, pct: 0, label: '', text: '' }); renderSettings(); break;
      case 'delTier': state.settings.tiers.splice(Number(t.dataset.i), 1); saveSettings(); renderSettings(); break;
      case 'addCode': state.settings.codes.push({ code: '', category: 'NODEDUCT', desc: '' }); renderSettings(); break;
      case 'delCode': state.settings.codes.splice(Number(t.dataset.i), 1); saveSettings(); renderSettings(); break;
      case 'exportSettings': download(new Blob([JSON.stringify({ ...state.settings, ai: stripKeys(state.settings.ai) }, null, 1)], { type: 'application/json' }), 'gmm-settings.json'); break;
      case 'resetSettings': if (confirm('Reset all settings (rules, codes, formulas, colours) to defaults? Your API key is kept.')) { const keys = state.settings.ai.keys; state.settings = E.mergeSettings(); state.settings.ai.keys = keys; saveSettings(); renderSettings(); } break;
      default: break;
    }
  });

  document.addEventListener('change', async (ev) => {
    const el = ev.target; const o = outlet();
    if (el.id === 'attInput') return loadAttendanceFiles(el.files);
    if (el.id === 'outletSel') { state.ui.outletId = el.value; state.ui.drawerRow = null; $('#drawer').classList.remove('open'); return render(); }
    if (el.name === 'asgOutlet') { state.ui.asg.outlet = el.value; return render(); }
    if (el.dataset.asg) { const g = state.ui.asg; const k = el.dataset.asg; g[k] = el.type === 'checkbox' ? el.checked : k === 'incPct' ? Number(el.value) / 100 : el.value; return render(); }
    if (el.dataset.my) { const g = state.ui.asg; const key = el.dataset.my === 'pay' ? 'payMonth' : 'attMonth'; const [y, m] = g[key].split('-'); const ny = el.dataset.part === 'y' ? el.value : y; const nm = el.dataset.part === 'm' ? String(el.value).padStart(2, '0') : m;
      g[key] = `${ny}-${nm}`; if (key === 'attMonth') g.days = E.daysInMonth(g[key]); return render(); }
    if (el.id === 'asgDays') { state.ui.asg.days = Number(el.value); return; }
    if (el.dataset.rec !== undefined) { state.ui.att.records[Number(el.dataset.rec)][el.dataset.rf] = el.value.trim(); return; }
    if (el.id === 'rotSel') { state.ui.att.rotate = el.value; return renderAttendancePages(); }
    if (el.id === 'aiInstr') { state.settings.ai.instructions = el.value; return saveSettings(); }
    if (el.id === 'extractInput') {
      try { const j = JSON.parse(await el.files[0].text()); const a = state.ui.att; setScan(j.pages || j); a.fileName = a.fileName || j.file || el.files[0].name; render(); toast(`Loaded ${a.records.length} staff from the saved extraction.`); } catch (e) { toast('Not a valid extraction file: ' + e.message); }
      return;
    }
    if (el.id === 'backupInput') { try { const j = JSON.parse(await el.files[0].text()); state.ws = j.workspace || j; if (j.settings) { const keys = state.settings.ai.keys; state.settings = E.mergeSettings(j.settings); state.settings.ai.keys = keys; saveSettings(); } state.ui.outletId = null; saveWorkspace(); render(); toast('Backup loaded.'); } catch (e) { toast('Not a valid backup: ' + e.message); } return; }
    if (el.id === 'settingsInput') { try { const j = JSON.parse(await el.files[0].text()); const keys = state.settings.ai.keys; state.settings = E.mergeSettings(j); state.settings.ai.keys = keys; saveSettings(); renderSettings(); toast('Settings imported.'); } catch (e) { toast('Not a valid settings file.'); } return; }
    if (el.dataset.match !== undefined) { const r = state.ui.att.records[Number(el.dataset.match)]; if (el.value === '__new') { r.forceNew = true; delete r.forceRowId; } else { r.forceRowId = el.value; delete r.forceNew; } return render(); }
    if (el.dataset.ws) { const ws = state.ws; ws[el.dataset.ws] = el.type === 'number' ? Number(el.value) : el.value; if (el.dataset.ws === 'attendanceMonth' && el.value) ws.daysInMonth = E.daysInMonth(el.value); saveWorkspace(); return render(); }
    if (el.dataset.o) { const ox = outlet(el.dataset.o); const f = el.dataset.of; ox[f] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) / (el.dataset.pct !== undefined ? 100 : 1) : el.value;
      if (f === 'scEnabled' || f === 'incEnabled') { if (!ox.scEnabled && !ox.incEnabled) { ox[f] = true; toast('Tick at least service charge or incentive.'); } }
      saveWorkspace(); return render(); }
    if (el.dataset.ck !== undefined) { o.ckSources[Number(el.dataset.ck)].amount = Number(el.value); saveWorkspace(); return render(); }
    if (el.dataset.fx !== undefined) { const f = o.fixedRows[Number(el.dataset.fx)]; f[el.dataset.ff] = el.type === 'number' ? Number(el.value) : el.value; saveWorkspace(); return render(); }
    if (el.dataset.day !== undefined) { const r = o.employees.find((e) => e.id === el.dataset.r); r.attendance.days[Number(el.dataset.day)].code = el.value; el.className = 'day ' + E.codeCategory(el.value, state.settings); saveWorkspace(); return; }
    if (el.dataset.r && (el.dataset.f || el.dataset.ov)) {
      const r = o.employees.find((e) => e.id === el.dataset.r); if (!r) return;
      const scheme = state.ui.scheme === 'inc' && o.incEnabled ? 'inc' : 'sc';
      if (el.dataset.ov) { const key = scheme === 'inc' ? 'incOverrides' : 'overrides'; r[key] = r[key] || {}; if (el.value === '') delete r[key][el.dataset.ov]; else r[key][el.dataset.ov] = Number(el.value); }
      else { const f = el.dataset.f; r[f] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value; }
      saveWorkspace(); const focusSel = el.dataset.ov ? `[data-r="${r.id}"][data-ov="${el.dataset.ov}"]` : null; render(); if (focusSel) { const nx = $(focusSel); if (nx) nx.focus(); }
      return;
    }
    // settings fields
    if (el.dataset.s) { let v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value; if (el.dataset.pct !== undefined) v = v / 100;
      setPath(state.settings, el.dataset.s, v);
      if (el.dataset.s === 'ai.provider') { state.settings.ai.model = AI.PROVIDERS[v].defaultModel; state.settings.ai.baseUrl = ''; state.ui.models = []; }
      if (el.dataset.s === 'ai.preset') { state.ui.models = []; if (v !== 'custom') state.settings.ai = AI.withPreset(state.settings, v).ai; if (state.settings.ai.fallbackPreset === v) state.settings.ai.fallbackPreset = ''; }
      saveSettings(); recompute();
      if (el.id === 'quickPreset') { toast(`AI model: ${AI.currentLabel(state.settings.ai)}`); return render(); }
      return renderSettings(); }
    if (el.dataset.key) { state.settings.ai.keys[el.dataset.key] = el.value.trim(); saveSettings(); return renderSettings(); }
    if (el.dataset.tier !== undefined) { const tr = state.settings.tiers[Number(el.dataset.tier)]; const f = el.dataset.tf; tr[f] = f === 'pct' ? Number(el.value) / 100 : el.type === 'number' ? Number(el.value) : el.value; saveSettings(); return; }
    if (el.dataset.code !== undefined) { const c = state.settings.codes[Number(el.dataset.code)]; c[el.dataset.cf] = el.dataset.cf === 'code' ? el.value.toUpperCase().trim() : el.value; saveSettings(); return; }
    if (el.dataset.formula) { state.settings.formulas[el.dataset.formula] = el.value.trim(); try { E.computeWorkspace(state.ws || { outlets: [], daysInMonth: 31 }, state.settings); saveSettings(); } catch (e) { toast('Formula error: ' + e.message, 6000); } return renderSettings(); }
    if (el.dataset.od !== undefined) { const d = state.settings.outlets[Number(el.dataset.od)]; const f = el.dataset.odf;
      if (f === 'central') d.kind = el.checked ? 'central' : 'outlet'; else if (f === 'tab') d.tab = 'FF' + el.value.slice(1).toUpperCase(); else d[f] = el.value; saveSettings(); return; }
    if (el.dataset.color) { state.settings.colors[el.dataset.color] = 'FF' + el.value.slice(1).toUpperCase(); saveSettings(); return; }
    if (el.dataset.sig !== undefined) { state.settings.signatories[Number(el.dataset.sig)][el.dataset.sf] = el.value; saveSettings(); return; }
    if (el.dataset.terms !== undefined) { state.settings.terms = el.value.split('\n').map((x) => x.trim()).filter(Boolean); saveSettings(); }
  });

  // drag & drop
  document.addEventListener('dragover', (ev) => { const z = ev.target.closest('.dropzone'); if (z) { ev.preventDefault(); z.classList.add('over'); } });
  document.addEventListener('dragleave', (ev) => { const z = ev.target.closest('.dropzone'); if (z) z.classList.remove('over'); });
  document.addEventListener('drop', (ev) => {
    const z = ev.target.closest('.dropzone'); if (!z) return; ev.preventDefault(); z.classList.remove('over');
    loadAttendanceFiles(ev.dataTransfer.files);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { closePopover(); if ($('#modalBg').classList.contains('open')) { saveSettings(); closeSettings(); } else if (state.ui.drawerRow) { state.ui.drawerRow = null; $('#drawer').classList.remove('open'); } }
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList.contains('dropzone')) { ev.preventDefault(); $('input[type=file]', ev.target).click(); }
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList.contains('step')) { ev.preventDefault(); go(Number(ev.target.dataset.step)); }
  });
  $('#modalBg').addEventListener('click', (ev) => { if (ev.target.id === 'modalBg') { saveSettings(); closeSettings(); } });

  if (window.pdfjsLib && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    const w = document.getElementById('pdfWorkerSrc');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = w ? URL.createObjectURL(new Blob([w.textContent], { type: 'text/javascript' })) : 'vendor/pdf.worker.min.js';
  }
  window.GMMApp = { state, render, go }; // for debugging / automated tests
  render();
})();
