/* Import last month's stakeholder workbook(s) (Service Charge and/or Incentive) as the employee master.
 * Works with ExcelJS in the browser and in Node. Reads values (cached results for formula cells),
 * colours (fill + font), the summary inputs and the "Fixed Service Charge approved by COO" table.
 */
(function (root) {
  'use strict';
  const E = (root.GMM && root.GMM.engine) || (typeof require !== 'undefined' ? require('./engine.js') : null);

  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

  function cellVal(cell) {
    let v = cell && cell.value;
    if (v && typeof v === 'object') {
      if (v instanceof Date) return v;
      if ('result' in v) return v.result;
      if ('formula' in v || 'sharedFormula' in v) return v.result;
      if (v.richText) return v.richText.map((r) => r.text).join('');
      if ('text' in v) return v.text;
      if ('error' in v) return null;
    }
    return v;
  }
  function cellFormula(cell) {
    const v = cell && cell.value;
    if (v && typeof v === 'object') return v.formula || v.sharedFormula || null;
    return null;
  }
  function hasContent(cell) { const v = cell && cell.value; return v !== null && v !== undefined && v !== ''; }

  // Excel 2007 "Office" theme accents used in the stakeholder files
  const THEME_MAP = { 9: 'MGMT', 5: 'FW', 6: 'CASUAL', 7: 'DEDUCT', 4: 'DEDUCT' };
  function fillKind(cell) {
    const f = cell && cell.fill;
    if (!f || f.type !== 'pattern' || !f.fgColor) return null;
    const c = f.fgColor;
    if (c.argb) {
      const a = c.argb.toUpperCase().slice(-6);
      if (a === 'E1FFE1') return 'HELPER';
      if (a === 'E2E9F2') return 'RASA';
      if (a === 'FFFFCC') return 'HEAD';
      return null;
    }
    if (c.theme !== undefined) return THEME_MAP[c.theme] || null;
    return null;
  }
  function fontKind(cell) {
    const c = cell && cell.font && cell.font.color;
    if (!c || !c.argb) return null;
    const a = c.argb.toUpperCase().slice(-6);
    if (a === 'FF0000' || a === 'ED0000') return 'RED';
    if (a === '0000FF') return 'BLUE';
    return null;
  }

  const HEADER_KEYS = [
    ['no.', 'no'], ['dept', 'dept'], ['employee no', 'empNo'], ['name', 'nameHdr'], ['position', 'position'], ['join date', 'joinDate'],
    ['resignation date', 'resignDate'], ['status', 'status'], ['point entitlement', 'K'], ['days worked', 'L'], ['no of points (reserved)', 'N'],
    ['operational mgmt', 'mgmt'], ['permenant', 'perm'], ['permanent', 'perm'], ['casual labour (entitle)', 'casual'], ['mc / hl', 'mc'], ['upl', 'upl'], ['lateness', 'late'],
    ['pool', 'pool'], ['remarks', 'remarks'], ['deduction based on attendance', 'deduction'],
  ];

  function mapHeader(ws, r) {
    const cols = {};
    let pointsSeen = 0;
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell, c) => {
      const h = norm(cellVal(cell));
      if (!h) return;
      if (h === 'no. of points') { cols[pointsSeen++ === 0 ? 'M' : 'poolPts'] = c; return; }
      if (h.startsWith('mia / short notice')) { cols.mia = c; return; }
      if (h.startsWith('mia') && (h.includes('foreign') || h.includes('agent'))) { cols.miaFW = c; return; }
      if ((h.includes('foreign worker') || h.startsWith('agent')) && h.includes('0.75')) { cols.fw075 = c; return; }
      if (h.includes('foreign worker') || h.startsWith('agent')) { cols.fw = c; return; }
      for (const [k, key] of HEADER_KEYS) if (h === k || (k.length > 4 && h.startsWith(k))) { if (!(key in cols)) cols[key] = c; return; }
    });
    return cols;
  }

  function findCell(ws, pred, fromRow = 1) {
    let hit = null;
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      if (hit || r < fromRow) return;
      row.eachCell({ includeEmpty: false }, (cell, c) => { if (!hit && pred(norm(cellVal(cell)), cell)) hit = { r, c, text: String(cellVal(cell)) }; });
    });
    return hit;
  }
  function numberRightOf(ws, hit, maxCols = 10) {
    if (!hit) return null;
    for (let c = hit.c + 1; c <= hit.c + maxCols; c++) {
      const v = cellVal(ws.getCell(hit.r, c));
      if (typeof v === 'number') return { value: v, r: hit.r, c };
    }
    return null;
  }
  const pctIn = (text) => { const m = /([\d.]+)\s*%/.exec(text || ''); return m ? parseFloat(m[1]) / 100 : null; };

  function toDate(v) {
    if (!v) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'number') return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
    return String(v);
  }

  const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

  function parseSheet(ws, schemeHint) {
    const hdr = findCell(ws, (t) => t === 'employee no');
    if (!hdr) return null;
    const cols = mapHeader(ws, hdr.r);
    const nameCol = cols.empNo + 1;
    const title = String(cellVal(ws.getCell(1, 1)) || '');
    const sub = String(cellVal(ws.getCell(2, 1)) || '');
    const scheme = /INCENTIVE/i.test(sub) ? 'inc' : (schemeHint || 'sc');
    const tparts = title.split(/\s+-\s+/).map((s) => s.trim());
    const monthM = new RegExp(`(${MONTHS.join('|')})\\s+(\\d{4})`, 'i').exec(sub);
    const dimCell = cols.L ? cellVal(ws.getCell(hdr.r - 1, cols.L)) : null;
    const codeHit = findCell(ws, (t) => t.startsWith('details - gmm'));

    const employees = [];
    let r = hdr.r + 1;
    for (; r <= ws.rowCount; r++) {
      const name = cellVal(ws.getCell(r, nameCol));
      const rowText = [cols.L, cols.K, cols.M].map((c) => norm(cellVal(ws.getCell(r, c - 1)))).join(' ') + ' ' + norm(cellVal(ws.getCell(r, cols.L)));
      if (/total points/.test(rowText) || /total points/.test(norm(cellVal(ws.getCell(r, 7))))) break;
      if (!name) { if (!cellVal(ws.getCell(r, cols.empNo))) continue; }
      employees.push(readRow(ws, r, cols, nameCol, scheme));
    }
    const totalRow = r;

    // Fixed Service Charge approved by COO (helpers paid a fixed RM)
    const fixedRows = [];
    const fixedHit = findCell(ws, (t) => t.startsWith('fixed service charge approved'), totalRow);
    if (fixedHit) {
      const fh = findCell(ws, (t) => t === 'employee no', fixedHit.r);
      if (fh) {
        const fcols = mapHeader(ws, fh.r);
        for (let rr = fh.r + 1; rr <= fh.r + 60; rr++) {
          const nm = cellVal(ws.getCell(rr, fcols.empNo + 1));
          if (!nm) break;
          const amt = [fcols.mgmt, fcols.perm, fcols.casual, fcols.fw].map((c) => c && cellVal(ws.getCell(rr, c))).find((x) => typeof x === 'number') || 0;
          fixedRows.push({
            fromOutlet: String(cellVal(ws.getCell(rr, fcols.dept)) || ''), empNo: String(cellVal(ws.getCell(rr, fcols.empNo)) || ''), name: String(nm),
            position: String(cellVal(ws.getCell(rr, fcols.position)) || ''), joinDate: toDate(cellVal(ws.getCell(rr, fcols.joinDate))),
            status: String(cellVal(ws.getCell(rr, fcols.status)) || '').trim(), days: cellVal(ws.getCell(rr, fcols.L)) || '', amount: amt,
            remark: String(cellVal(ws.getCell(rr, fcols.remarks)) || ''),
          });
        }
      }
    }

    const out = {
      sheetName: ws.name, scheme, title, company: tparts[0] || '', brand: tparts[1] || "GRANDMAMA'S RESTAURANT", outletTitle: tparts.slice(2).join(' - ') || ws.name,
      code: codeHit ? codeHit.text.replace(/^details\s*-\s*gmm\s*/i, '').trim() : ws.name.toUpperCase().slice(0, 4),
      month: monthM ? `${monthM[2]}-${String(MONTHS.indexOf(monthM[1].toUpperCase()) + 1).padStart(2, '0')}` : '',
      daysInMonth: typeof dimCell === 'number' ? dimCell : null,
      tabColor: ws.properties && ws.properties.tabColor ? ws.properties.tabColor.argb : null,
      colWidths: Array.from({ length: 40 }, (_, i) => ws.getColumn(i + 1).width || null),
      employees, fixedRows,
    };
    if (scheme === 'sc') {
      const coll = numberRightOf(ws, findCell(ws, (t) => t.startsWith('total service charge collected')));
      const dist = findCell(ws, (t) => t.startsWith('distribute') && t.includes('service charge'));
      const ck = findCell(ws, (t) => t.startsWith('less') && t.includes('central kitchen'));
      out.scCollected = coll ? coll.value : 0;
      out.distributePct = dist ? pctIn(dist.text) : null;
      out.ckPct = ck ? pctIn(ck.text) : null;
      const pv = numberRightOf(ws, findCell(ws, (t) => t.startsWith('1 service point')));
      out.templatePointValue = pv ? pv.value : null;
      const sel = findCell(ws, (t) => t.startsWith('(selected %'));
      if (sel) { // Central Kitchen: funded by the CK/HQ % of the other outlets
        out.kind = 'central'; out.ckSources = [];
        for (let rr = sel.r + 1; rr < sel.r + 20; rr++) {
          const lab = String(cellVal(ws.getCell(rr, sel.c)) || '');
          const m = /^(.+?):\s*[\d.]+\s*%$/.exec(lab.trim());
          if (!m) break;
          const nv = numberRightOf(ws, { r: rr, c: sel.c });
          out.ckSources.push({ outlet: m[1].trim(), amount: nv ? nv.value : 0 });
        }
      }
    } else {
      const ns = numberRightOf(ws, findCell(ws, (t) => t.startsWith('total net sales')));
      const pc = findCell(ws, (t) => t.startsWith('distribute') && t.includes('net sales'));
      out.netSales = ns ? ns.value : 0;
      out.incPct = pc ? pctIn(pc.text) : null;
      const pv = numberRightOf(ws, findCell(ws, (t) => t.startsWith('1 incentive point')));
      out.templatePointValue = pv ? pv.value : null;
    }
    return out;
  }

  function readRow(ws, r, cols, nameCol, scheme) {
    const g = (k) => (cols[k] ? ws.getCell(r, cols[k]) : null);
    const v = (k) => (cols[k] ? cellVal(ws.getCell(r, cols[k])) : null);
    const filled = (k) => cols[k] && hasContent(ws.getCell(r, cols[k]));
    const status = String(v('status') || '').trim();
    const fk = fillKind(ws.getCell(r, cols.empNo)) || fillKind(ws.getCell(r, nameCol));
    const ft = fontKind(ws.getCell(r, nameCol)) || fontKind(ws.getCell(r, cols.empNo));
    const remarks = String(v('remarks') || '');
    let category = 'PERM';
    if (filled('mgmt')) category = 'MGMT';
    else if (filled('fw') || filled('fw075') || filled('miaFW') || filled('N')) category = 'FW';
    else if (filled('casual') || /CASUAL/i.test(status)) category = 'CASUAL';
    else if (/^(AGENT|EDISIJUTA)/i.test(status) || fk === 'FW') category = 'FW';
    else if (fk === 'MGMT') category = 'MGMT';
    else if (fk === 'CASUAL') category = 'CASUAL';
    const K = Number(v('K')) || 0;
    const L = Number(v('L')) || 0;
    const mc = Number(v('mc')) || 0, upl = Number(v('upl')) || 0, late = Number(v('late')) || 0;
    const dim = 31; // corrected after import when L10 is known
    const isNew = ft === 'BLUE';
    let base = 1;
    if ([0.5, 1, 2].includes(K) && !(isNew || ft === 'RED') ) base = K;
    else if (K >= 1.5) base = 2;
    let exitType = '';
    const entitledFilled = ['mgmt', 'perm', 'casual', 'fw'].some((k) => filled(k) && Number(v(k)) > 0);
    if (filled('mia') || filled('miaFW')) exitType = 'MIA';
    else if (filled('deduction') && !entitledFilled && mc + upl + late < 8) exitType = 'ROLLBACK';
    else if (/resign with full notice/i.test(remarks)) exitType = 'RESIGN_FULL';
    // deductible days reach a % tier but the stakeholder paid the normal prorated amount (e.g. appeal approved by COO)
    const waiveTier = mc + upl + late >= 4 && !filled('deduction') && !exitType && entitledFilled;
    const fromM = /(?:From|Helping)\s+([A-Z0-9 ()]+?)\s*:/i.exec(remarks);
    const row = {
      id: 'r' + Math.random().toString(36).slice(2, 9),
      dept: String(v('dept') || ''), empNo: String(v('empNo') || '').trim(), name: String(cellVal(ws.getCell(r, nameCol)) || '').trim(),
      position: String(v('position') || '').trim(), joinDate: toDate(v('joinDate')), resignDate: toDate(v('resignDate')), status,
      category, base, rasa: fk === 'RASA' || /^rasa$/i.test(String(v('dept') || '')), outletHead: fk === 'HEAD',
      fromOutlet: fk === 'HELPER' && fromM && /^from/i.test(fromM[0]) ? fromM[1].trim() : '', helperNote: fk === 'HELPER' ? remarks.split('\n')[0] : '',
      isNew, exitType, waiveTier, mc, upl, absent: 0, lateDays: late, notEmployed: 0,
      template: { K, L, Lformula: cellFormula(g('L')), mc, upl, late, remarks, fill: fk, font: ft,
        Mconst: cols.M && !cellFormula(g('M')) && typeof v('M') === 'number' ? v('M') : null,
        Nconst: cols.N && !cellFormula(g('N')) && typeof v('N') === 'number' ? v('N') : null,
        amounts: Object.fromEntries(['M', 'N', 'mgmt', 'perm', 'casual', 'fw', 'mia', 'deduction', 'miaFW', 'fw075', 'poolPts', 'pool'].filter((k) => cols[k]).map((k) => [k, Number(v(k)) || 0])) },
      extraRemark: '', overrides: {}, incOverrides: {}, include: true,
    };
    row._rawL = L; row._dimGuess = dim;
    return row;
  }

  // Combine SC + Incentive workbooks into a workspace {month, daysInMonth, outlets:[...]}
  async function importWorkbooks(files, ExcelJS) {
    const outlets = new Map();
    let month = '', dim = null;
    const notes = [];
    for (const f of files) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(f.buffer);
      const hint = /incentive/i.test(f.name) ? 'inc' : 'sc';
      wb.eachSheet((ws) => {
        if (ws.state && ws.state !== 'visible') return;
        const p = parseSheet(ws, hint);
        if (!p) return;
        month = month || p.month; dim = dim || p.daysInMonth;
        const key = p.sheetName.trim().toLowerCase();
        if (p.scheme === 'sc') {
          const o = outlets.get(key) || newOutlet(p);
          Object.assign(o, { sheetName: p.sheetName, company: p.company, brand: p.brand, outletTitle: p.outletTitle, code: p.code, tabColor: p.tabColor, colWidths: p.colWidths,
            scCollected: p.scCollected, fixedRows: p.fixedRows, templatePointValue: p.templatePointValue, scEnabled: true, kind: p.kind || 'outlet', ckSources: p.ckSources || [] });
          if (p.distributePct) o.distributePct = p.distributePct; if (p.ckPct) o.ckPct = p.ckPct;
          // merge incentive info already loaded
          const prevInc = o._incRows || [];
          o.employees = p.employees;
          applyIncRows(o, prevInc);
          outlets.set(key, o);
        } else {
          const o = outlets.get(key) || newOutlet(p);
          o.incEnabled = true; o.netSales = p.netSales; o.incPct = p.incPct; o.templateIncPointValue = p.templatePointValue;
          if (!o.employees.length) { o.employees = p.employees.map((e) => ({ ...e, inSC: false, inIncentive: true, incBase: e.base, incTemplate: e.template, incExitType: e.exitType, incWaiveTier: e.waiveTier })); o.scEnabled = false; }
          else applyIncRows(o, p.employees);
          o._incRows = p.employees;
          outlets.set(key, o);
        }
        notes.push(`${f.name} → ${p.sheetName} (${p.scheme === 'sc' ? 'service charge' : 'incentive'}): ${p.employees.length} staff` + (p.fixedRows.length ? `, ${p.fixedRows.length} fixed-SC helpers` : ''));
      });
    }
    dim = dim || (month ? E.daysInMonth(month) : 31);
    for (const o of outlets.values()) {
      delete o._incRows;
      for (const e of o.employees) {
        finaliseTemplateRow(e, e.template, dim, 'overrides', 'notEmployed', e.base);
        if (e.incTemplate) finaliseTemplateRow(e, e.incTemplate, dim, 'incOverrides', 'incNotEmployed', e.incBase);
        delete e._rawL; delete e._dimGuess;
      }
    }
    return { month, daysInMonth: dim, outlets: [...outlets.values()], notes };
  }

  // Derive days not employed and keep the stakeholder's hand-keyed numbers (K, constant M/N) as overrides,
  // so re-computing the template month reproduces the stakeholder file.
  function finaliseTemplateRow(e, t, dim, ovKey, neKey, base) {
    e[neKey] = Math.max(0, Math.round(dim - t.L - t.mc - t.upl - t.late));
    t.ne = e[neKey];
    const elig = dim - e[neKey];
    const kCalc = elig >= dim ? base : Math.round(elig / dim * 100) / 100 * base;
    e[ovKey] = e[ovKey] || {};
    if (Math.abs(kCalc - t.K) > 0.0001) e[ovKey].K = t.K;
    if (t.Mconst !== null && t.Mconst !== undefined) e[ovKey].M = t.Mconst;
    if (t.Nconst !== null && t.Nconst !== undefined) e[ovKey].N = t.Nconst;
  }

  function newOutlet(p) {
    return { id: 'o' + Math.random().toString(36).slice(2, 8), sheetName: p.sheetName, company: p.company, brand: p.brand, outletTitle: p.outletTitle, code: p.code,
      tabColor: p.tabColor, colWidths: p.colWidths, employees: [], fixedRows: [], scCollected: 0, netSales: 0, scEnabled: false, incEnabled: false, attendance: null };
  }

  function applyIncRows(o, incRows) {
    if (!incRows.length) return;
    const byNo = new Map(incRows.map((r) => [E.normId(r.empNo), r]));
    for (const e of o.employees) {
      const ir = byNo.get(E.normId(e.empNo));
      if (ir) { e.inIncentive = true; e.incBase = ir.base; e.incTemplate = ir.template; e.incExitType = ir.exitType; e.incWaiveTier = ir.waiveTier; byNo.delete(E.normId(e.empNo)); }
      else e.inIncentive = false;
    }
    for (const ir of byNo.values()) o.employees.push({ ...ir, inSC: false, inIncentive: true, incBase: ir.base, incTemplate: ir.template, incExitType: ir.exitType, incWaiveTier: ir.waiveTier });
  }

  const api = { importWorkbooks, parseSheet, cellVal, cellFormula };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GMM = root.GMM || {}; root.GMM.importer = api;
})(typeof window !== 'undefined' ? window : globalThis);
