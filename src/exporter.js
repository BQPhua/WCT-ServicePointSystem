/* Build the Service Charge / Incentive workbook in the stakeholder's layout with live Excel formulas.
 * exportWorkbook(ws, scheme, settings, ExcelJS, {outletIds}) -> ExcelJS.Workbook
 * Every formula is produced from the same expression the app uses on screen (engine.toExcel), and each
 * formula cell also carries the computed result so the file shows numbers even before Excel recalculates.
 */
(function (root) {
  'use strict';
  const E = (root.GMM && root.GMM.engine) || (typeof require !== 'undefined' ? require('./engine.js') : null);

  const colL = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const FONT = 'Calibri';
  const GREY = 'FFD9D9D9';
  const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
  const ACC = '_-* #,##0.00_-;\\-* #,##0.00_-;_-* "-"??_-;_-@_-';

  // ---------------------------------------------------------------- column plan
  function planColumns(rows, scheme) {
    const any = (cat) => rows.some((r) => r.row.category === cat);
    const sc = scheme === 'sc';
    const defs = [
      ['no', 'No.', 7], ['dept', 'Dept', 12], ['empNo', 'Employee No', 13], ['name', 'Name', 16.7], ['e', '', 10], ['f', '', 14],
      ['position', 'Position', 32], ['joinDate', 'Join Date', 13.5], ['resignDate', 'Resignation Date', 13.5], ['status', 'Status', 15],
      ['K', 'Point Entitlement', 13], ['L', 'Days Worked', 10.5], ['M', 'No. of points', 11.5],
    ];
    if (sc) defs.push(['N', 'No of Points (Reserved)', 12.5]);
    const ent = [];
    if (sc && any('MGMT')) ent.push(['mgmt', 'Operational Mgmt', 13.9]);
    ent.push(['perm', 'Permenant', 13.9]);
    if (any('CASUAL')) ent.push(['casual', 'Casual Labour (Entitle)', 13.9]);
    ent.push(['fw', sc ? 'Foreign Worker \n0.25 points' : 'Foreign Worker', 13.9]);
    const rb = [['mia', 'MIA / Short Notice\n(Permenant)', 13.9], ['deduction', 'Deduction based on attendance', 13.9], ['miaFW', 'MIA\n(Foreign Worker)', 13.9]];
    if (sc) rb.push(['fw075', 'Foreign Worker \n0.75 points', 13.9]);
    const pool = [['mc', 'MC / HL', 9.7], ['upl', 'UPL', 9], ['late', 'Lateness', 10], ['poolPts', 'No. of points', 10], ['pool', 'Pool', 12.7]];
    const all = [...defs, ...ent, ...rb, ...pool, ['remarks', 'Remarks', 45], ['gap', '', 3], ['chkPts', 'Check: points', 11], ['chkOk', 'Check: = K', 10], ['chkDays', 'Check: days', 10], ['topUp', 'Top-up to min', 13]];
    const cols = {}; const list = [];
    all.forEach(([key, label, width], i) => { const c = { key, label, width, idx: i + 1, L: colL(i + 1) }; cols[key] = c; list.push(c); });
    return { cols, list, entKeys: ent.map((x) => x[0]), rbKeys: rb.map((x) => x[0]), poolKeys: pool.map((x) => x[0]) };
  }

  // ---------------------------------------------------------------- row plan (positions of every block)
  function planLayout(outlet, res, scheme, settings) {
    const plan = planColumns(res.rows, scheme);
    const first = 12;
    const last = first + Math.max(res.rows.length, 1) - 1;
    const totalRow = last + 1, totalSCRow = last + 2;
    let cursor = totalSCRow + 3;
    const fixed = scheme === 'sc' ? (outlet.fixedRows || []) : [];
    let fixedPlan = null;
    if (fixed.length) { fixedPlan = { title: cursor, header: cursor + 1, first: cursor + 2, last: cursor + 1 + fixed.length, total: cursor + 2 + fixed.length }; cursor = fixedPlan.total + 3; }
    const d0 = cursor;
    const reconLabel = plan.cols.remarks.idx - 5;
    const detLabel = 12; // column L
    const detValue = Math.min(detLabel + 7, reconLabel - 2);
    const lines = []; // details block lines [key,label]
    const dimLabel = `01/${outlet._mm}/${outlet._yyyy} - ${outlet._dim}/${outlet._mm}/${outlet._yyyy}`;
    const minOn = scheme === 'sc' ? settings.sc.minMode === 'point' && E.num(settings.sc.minValue) > 0 : settings.inc.minMode === 'point' && E.num(settings.inc.minValue) > 0;
    if (scheme === 'sc') {
      if (outlet.kind === 'central') {
        lines.push(['srcNote', '(selected % out of 80% distribution from other GMMs)']);
        (res.summary.sources || []).forEach((s, i) => lines.push(['src' + i, `${s.outlet}: ${pct(outlet.ckPct || settings.sc.ckPct)}`]));
      } else {
        lines.push(['collected', `Total service charge collected: ${dimLabel}`]);
        lines.push(['distributable', `Distribute ${pct(outlet.distributePct || settings.sc.distributePct)} of Total Service Charge`]);
        lines.push(['ck', `Less ${pct(outlet.ckPct || settings.sc.ckPct)} for Central Kitchen/HQ`]);
      }
      if (fixed.length) lines.push(['fixed', 'Fixed SC allowance']);
      lines.push(['nett', 'Nett Total of Service Charge to pay to outlet']);
      lines.push(['points', 'No. of Total Points']);
      if (minOn) lines.push(['min', 'Minimum value per point (top-up rule)']);
      lines.push(['pv', '1 Service Point (fixed)']);
      if (minOn) lines.push(['topup', 'Company top-up to minimum point value']);
    } else {
      lines.push(['sales', `Total Net Sales - ${dimLabel}`]);
      lines.push(['incTotal', `Distribute ${pct(outlet.incPct || settings.inc.pct)} of Total Net Sales `]);
      lines.push(['incTotal2', 'Total of Incentive']);
      lines.push(['nett', 'Nett Total of Incentive to pay to outlet']);
      lines.push(['points', 'Total Points']);
      if (minOn) lines.push(['min', 'Minimum value per point (top-up rule)']);
      lines.push(['pv', '1 Incentive point (fixed)']);
      if (minOn) lines.push(['topup', 'Company top-up to minimum point value']);
    }
    const det = {}; lines.forEach(([k], i) => { det[k] = d0 + 1 + i; });
    det.check = d0 + 1 + lines.length;
    const pvAddr = `$${colL(detValue)}$${det.pv}`;
    return { plan, first, last, totalRow, totalSCRow, fixedPlan, d0, detLabel, detValue, reconLabel, lines, det, pvAddr, minOn,
      ckAddr: det.ck ? `$${colL(detValue)}$${det.ck}` : null };
  }
  const pct = (x) => `${E.xlRound(E.num(x) * 100, 4)}%`;

  // ---------------------------------------------------------------- styles
  const thin = { style: 'thin' }, medium = { style: 'medium' };
  const box = (b = thin) => ({ top: b, left: b, bottom: b, right: b });
  const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  function setCell(ws, addr, value, style = {}) {
    const c = ws.getCell(addr);
    c.value = value;
    c.font = { name: FONT, size: 12, ...(style.font || {}) };
    if (style.fill) c.fill = solid(style.fill);
    if (style.numFmt) c.numFmt = style.numFmt;
    if (style.alignment) c.alignment = style.alignment;
    if (style.border) c.border = style.border;
    return c;
  }
  const F = (formula, result) => ({ formula: formula.replace(/^=/, ''), result: typeof result === 'number' && isFinite(result) ? result : undefined });

  // ---------------------------------------------------------------- main
  function exportWorkbook(wsData, scheme, settings, ExcelJS, opts = {}) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'GMM Service Charge & Incentive Tool';
    wb.created = new Date();
    wb.calcProperties = { fullCalcOnLoad: true };
    const [yyyy, mm] = (wsData.month || '2026-01').split('-');
    const dim = wsData.daysInMonth;
    const all = opts.results || E.computeWorkspace(wsData, settings);
    const outlets = wsData.outlets.filter((o) => (!opts.outletIds || opts.outletIds.includes(o.id)) && (scheme === 'sc' ? o.scEnabled !== false : o.incEnabled));
    // pass 1: layouts (needed for cross-sheet links from Central Kitchen)
    const layouts = {};
    for (const o of outlets) {
      Object.assign(o, { _mm: mm, _yyyy: yyyy, _dim: dim });
      layouts[o.id] = planLayout(o, all[o.id][scheme], scheme, settings);
    }
    for (const o of outlets) writeSheet(wb, o, all[o.id][scheme], layouts[o.id], scheme, settings, wsData, { outlets, layouts, yyyy, mm, dim });
    return wb;
  }

  function sheetRef(name) { return /^[A-Za-z0-9_]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`; }

  function writeSheet(wb, o, res, lay, scheme, settings, wsData, ctx) {
    const name = (o.sheetName || o.outletTitle || 'Outlet').slice(0, 31).replace(/[\\/*?:[\]]/g, ' ');
    const ws = wb.addWorksheet(name, { properties: { tabColor: o.tabColor ? { argb: o.tabColor } : { argb: 'FF92D050' } }, views: [{ state: 'frozen', xSplit: 4, ySplit: 11, zoomScale: 75 }] });
    const { cols, list, entKeys, rbKeys } = lay.plan;
    const C = (k) => cols[k].L;
    const dim = ctx.dim;
    list.forEach((c) => { ws.getColumn(c.idx).width = c.width; });
    const lastCol = C('remarks');
    const isSC = scheme === 'sc';
    const monthName = MONTHS[Number(ctx.mm) - 1] || '';

    // title + legend
    setCell(ws, 'A1', `${o.company || ''} - ${o.brand || "GRANDMAMA'S RESTAURANT"} -  ${o.outletTitle || o.sheetName}`.replace(/^ - /, ''), { font: { bold: true, size: 16 } });
    setCell(ws, 'A2', `${isSC ? 'SERVICE POINTS' : 'INCENTIVE'} DISTRIBUTION LIST FOR THE MONTH OF ${monthName} ${ctx.yyyy}`, { font: { bold: true, size: 14 } });
    ws.getRow(1).height = 20.25; ws.getRow(3).height = 48;
    const tp = C('poolPts'), tq = C('pool');
    ws.mergeCells(`${tp}3:${tq}3`);
    setCell(ws, `${tp}3`, 'Total Days\n(MC/HL, UPL & Lateness)', { font: { bold: true }, fill: GREY, alignment: { wrapText: true, horizontal: 'center', vertical: 'middle' }, border: box() });
    setCell(ws, `${lastCol}3`, `Deduction from ${isSC ? 'Service Point' : 'Incentive Point'}`, { font: { bold: true }, fill: GREY, alignment: { horizontal: 'center', vertical: 'middle' }, border: box() });
    settings.tiers.forEach((t, i) => {
      const r = 4 + i; ws.mergeCells(`${tp}${r}:${tq}${r}`);
      setCell(ws, `${tp}${r}`, t.label, { alignment: { horizontal: 'center' }, border: box() });
      setCell(ws, `${lastCol}${r}`, t.text, { border: box() });
    });
    // colour legend (A3:D9)
    const c = settings.colors;
    const legend = [[c.MGMT, 'Management (HQ)'], [c.HEAD, 'Outlet head'], [c.HELPER, 'Helping from other outlet'], [c.RASA, 'Rasa by Grandmama'], [c.CASUAL, 'Casual labour'], [c.FW, 'Foreign worker / agent'], [c.DEDUCT, 'Attendance deduction (4+ days)']];
    setCell(ws, 'A3', 'Legend', { font: { bold: true, size: 10 } });
    legend.forEach(([argb, label], i) => {
      setCell(ws, `A${4 + i}`, '', { fill: argb, border: box() });
      setCell(ws, `B${4 + i}`, label, { font: { size: 10 } });
    });
    setCell(ws, 'D4', 'Blue font = new joiner', { font: { size: 10, color: { argb: c.fontNew } } });
    setCell(ws, 'D5', 'Red font = resigned / absconded', { font: { size: 10, color: { argb: c.fontLeaving } } });
    setCell(ws, 'D6', 'Black font = current staff', { font: { size: 10 } });

    // row 10: days in month + group headers
    setCell(ws, 'L10', dim, { font: { color: { argb: 'FFFF0000' } }, alignment: { horizontal: 'center' } });
    const grp = (keys, text, color) => {
      const a = C(keys[0]), b = C(keys[keys.length - 1]);
      if (a !== b) ws.mergeCells(`${a}10:${b}10`);
      setCell(ws, `${a}10`, text, { font: { bold: true, color: { argb: color } }, alignment: { horizontal: 'center', vertical: 'middle', wrapText: true } });
    };
    grp(entKeys, isSC ? 'Entitle for Service Charge' : 'Entitle for Incentive', 'FF000000');
    grp(rbKeys, 'Amount rolled back to company', 'FFFF0000');
    grp(['mc', 'upl', 'late', 'poolPts', 'pool'], 'Amount retent to pool', 'FF0000FF');
    ws.getRow(10).height = 21;

    // header row 11
    const headerRow = (r) => {
      list.forEach((col) => {
        if (['e', 'f', 'gap'].includes(col.key) || (col.key === 'topUp' && !hasStaffMin(settings, scheme))) return;
        const chk = col.key.startsWith('chk') || col.key === 'topUp';
        setCell(ws, `${col.L}${r}`, col.label, { font: { bold: true, size: chk ? 10 : 12 }, fill: chk ? 'FFF2F2F2' : GREY, alignment: { wrapText: true, horizontal: 'center', vertical: 'middle' }, border: box(chk ? thin : medium) });
      });
      ws.getRow(r).height = 60.75;
    };
    headerRow(11);
    ws.mergeCells('D11:F11');

    // employee rows
    const pvAddr = lay.pvAddr;
    res.rows.forEach((x, i) => writeEmployeeRow(ws, x, lay.first + i, i, lay, settings, scheme, dim, pvAddr));
    if (!res.rows.length) setCell(ws, `D${lay.first}`, '(no staff included)', { font: { italic: true } });

    // totals
    const tr = lay.totalRow, tsr = lay.totalSCRow, f1 = lay.first, l1 = lay.last;
    ws.mergeCells(`G${tr}:L${tr}`);
    setCell(ws, `G${tr}`, `TOTAL POINTS & ${isSC ? 'SERVICE CHARGES' : 'INCENTIVE'} DISBURSED`, { font: { bold: true }, alignment: { horizontal: 'right' } });
    const sumKeys = ['M', ...(isSC ? ['N'] : []), ...entKeys, ...rbKeys, 'mc', 'upl', 'late', 'poolPts', 'pool'];
    const totVal = { M: res.totals.points, N: res.totals.reserved, poolPts: res.totals.poolPoints, pool: res.totals.pool };
    const colSum = (k) => res.rows.reduce((s, x) => s + (cellNumber(x, k, settings) || 0), 0);
    sumKeys.forEach((k) => {
      const red = rbKeys.includes(k);
      setCell(ws, `${C(k)}${tr}`, F(`SUM(${C(k)}${f1}:${C(k)}${l1})`, round2(totVal[k] !== undefined ? totVal[k] : colSum(k))), { font: { bold: true, color: red ? { argb: 'FFFF0000' } : undefined }, numFmt: '#,##0.00', alignment: { horizontal: 'center' }, border: box(medium) });
    });
    ws.mergeCells(`G${tsr}:${colL(cols[entKeys[0]].idx - 1)}${tsr}`);
    setCell(ws, `G${tsr}`, `TOTAL ${isSC ? 'SERVICE CHARGES' : 'INCENTIVE'}`, { font: { bold: true }, alignment: { horizontal: 'right' } });
    const mergeSum = (keys, red, value) => {
      const a = C(keys[0]), b = C(keys[keys.length - 1]);
      if (a !== b) ws.mergeCells(`${a}${tsr}:${b}${tsr}`);
      setCell(ws, `${a}${tsr}`, F(`SUM(${a}${tr}:${b}${tr})`, round2(value)), { font: { bold: true, color: red ? { argb: 'FFFF0000' } : undefined }, fill: GREY, numFmt: '#,##0.00', alignment: { horizontal: 'center' }, border: box(medium) });
    };
    mergeSum(entKeys, false, res.totals.entitled);
    mergeSum(rbKeys, true, res.totals.rollback);
    ['mc', 'upl', 'late', 'poolPts', 'pool'].forEach((k) => setCell(ws, `${C(k)}${tsr}`, F(`${C(k)}${tr}`, round2(k === 'pool' ? res.totals.pool : k === 'poolPts' ? res.totals.poolPoints : colSum(k))), { font: { bold: true }, fill: GREY, numFmt: '#,##0.00', alignment: { horizontal: 'center' }, border: box(medium) }));

    // fixed SC table
    if (lay.fixedPlan) writeFixed(ws, o, lay, settings);

    writeSignatures(ws, lay, settings);
    writeDetails(ws, o, res, lay, settings, scheme, ctx);
    writeRecon(ws, o, res, lay, settings, scheme);

    // terms
    const tStart = Math.max(lay.d0 + 9, lay.det.check + 2);
    setCell(ws, `A${tStart}`, 'Terms & Conditions:', { font: { bold: true } });
    (settings.terms || []).forEach((t, i) => setCell(ws, `A${tStart + 1 + i}`, `${i + 1}. ${t}`));

    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
    return ws;
  }

  const round2 = (x) => E.xlRound(x || 0, 2);
  const hasStaffMin = (settings, scheme) => (scheme === 'sc' ? settings.sc : settings.inc).minMode === 'staff';

  // which RM column a row's allocation goes to
  function entCol(row) { return row.category === 'MGMT' ? 'mgmt' : row.category === 'CASUAL' ? 'casual' : row.category === 'FW' ? 'fw' : 'perm'; }
  function miaCol(row) { return row.category === 'FW' ? 'miaFW' : 'mia'; }
  function cellNumber(x, key, settings) {
    const r = x.row, a = x.alloc;
    if (key === 'mc') return x.vars.MC; if (key === 'upl') return x.vars.UPL; if (key === 'late') return x.vars.Late;
    if (key === entCol(r)) return a.entitled;
    if (key === miaCol(r)) return a.mia;
    if (key === 'deduction') return a.deduction;
    if (key === 'fw075') return a.fwCompany;
    return 0;
  }

  function writeEmployeeRow(ws, x, r, i, lay, settings, scheme, dim, pvAddr) {
    const { cols } = lay.plan;
    const C = (k) => cols[k].L;
    const row = x.row, v = x.vars, a = x.alloc, fx = x.fx;
    const st = E.rowStyle(row, v, settings);
    const font = { color: { argb: st.font } };
    const base = { font, fill: st.fill || undefined, border: box(), alignment: { vertical: 'middle' } };
    const put = (k, value, extra = {}) => setCell(ws, `${C(k)}${r}`, value, { ...base, ...extra, alignment: { ...base.alignment, ...(extra.alignment || {}) } });
    const ctr = { alignment: { horizontal: 'center', wrapText: true } };
    ws.getRow(r).height = 24;
    put('no', i === 0 ? 1 : F(`A${r - 1}+1`, i + 1), ctr);
    put('dept', row.dept || '');
    put('empNo', row.empNo || '');
    put('name', row.name || '', { border: { top: thin, bottom: thin, left: thin } });
    put('e', null, { border: { top: thin, bottom: thin } }); put('f', null, { border: { top: thin, bottom: thin, right: thin } });
    put('position', row.position || '');
    put('joinDate', toDate(row.joinDate), { numFmt: 'dd-mmm-yy', alignment: { horizontal: 'center' } });
    put('resignDate', toDate(row.resignDate), { numFmt: 'dd-mmm-yy', alignment: { horizontal: 'center' } });
    put('status', row.status || '');
    put('K', v.PointEntitlement, { numFmt: '0.00', ...ctr });
    const ov = (scheme === 'inc' ? row.incOverrides : row.overrides) || {};
    const Lparts = [v.NotEmployed, v.DeductDays].filter((n) => n);
    const Lval = ov.L !== undefined && ov.L !== '' ? v.DaysWorked : (Lparts.length ? F(`${dim}-${Lparts.join('-')}`, v.DaysWorked) : dim);
    put('L', Lval, ctr);
    const refs = {
      DaysInMonth: '$L$10', DaysWorked: `L${r}`, PointEntitlement: `K${r}`, Points: `M${r}`, ReservedPoints: cols.N ? `N${r}` : 0,
      MC: `${C('mc')}${r}`, UPL: `${C('upl')}${r}`, Late: `${C('late')}${r}`, DeductDays: `${C('mc')}${r}+${C('upl')}${r}+${C('late')}${r}`,
      PoolPoints: `${C('poolPts')}${r}`, PoolAmount: `${C('pool')}${r}`, PointValue: pvAddr, Base: v.Base, Share: v.Share, CompanyShare: v.CompanyShare,
      TierPct: v.TierPct, NotEmployed: v.NotEmployed, EligibleDays: v.EligibleDays, Entitled: `${C(entCol(row))}${r}`, MinimumPayout: E.num((scheme === 'sc' ? settings.sc : settings.inc).minValue),
    };
    const fx2 = (id, result) => F(E.toExcel(settings.formulas[id] || E.DEFAULT_FORMULAS[id].expr, refs), result);
    const money = { numFmt: '#,##0.00', ...ctr };
    put('M', ov.M !== undefined && ov.M !== '' ? v.Points : fx2('points', v.Points), money);
    if (cols.N) put('N', v.CompanyShare ? (ov.N !== undefined && ov.N !== '' ? v.ReservedPoints : fx2('reserved', v.ReservedPoints)) : null, money);
    // RM columns
    const allRM = [...lay.plan.entKeys, ...lay.plan.rbKeys];
    allRM.forEach((k) => put(k, null, money));
    const place = (key, fid, value) => {
      if (!fid || !cols[key]) return;
      if (fid === 'override') { put(key, value, money); return; }
      const refsT = fid === 'entitledTier' || fid === 'deductionTier' ? { ...refs, PointEntitlement: v.Share === 1 ? `K${r}` : `K${r}*${v.Share}` } : refs;
      put(key, F(E.toExcel(settings.formulas[fid] || E.DEFAULT_FORMULAS[fid].expr, refsT), value), money);
    };
    place(entCol(row), fx.entitled, a.entitled);
    place(miaCol(row), fx.mia, a.mia);
    place('deduction', fx.deduction, a.deduction);
    place('fw075', fx.fwCompany, a.fwCompany);
    put('mc', v.MC || null, ctr); put('upl', v.UPL || null, ctr); put('late', v.Late || null, ctr);
    put('poolPts', ov.poolPts !== undefined && ov.poolPts !== '' ? v.PoolPoints : fx2('poolPoints', v.PoolPoints), { numFmt: '0.00', ...ctr });
    put('pool', fx.pool === 'override' ? a.pool : fx2('poolAmount', a.pool), { numFmt: '0.00', ...ctr });
    const remark = row.remarkOverride !== undefined && row.remarkOverride !== null && row.remarkOverride !== '' ? row.remarkOverride : E.autoRemark(row, settings, v);
    put('remarks', remark, { alignment: { wrapText: true, horizontal: 'left' } });
    if (remark.includes('\n')) ws.getRow(r).height = Math.min(24 + 16 * (remark.split('\n').length - 1), 90);
    // checks (grey, small) — same idea as the stakeholder's hidden check columns
    const chkFont = { size: 9, color: { argb: 'FF808080' } };
    const chkPts = E.xlRound(v.PoolPoints + v.Points + v.ReservedPoints, 2);
    setCell(ws, `${C('chkPts')}${r}`, F(`${C('poolPts')}${r}+M${r}${cols.N ? `+N${r}` : ''}`, chkPts), { font: chkFont, numFmt: '0.00' });
    setCell(ws, `${C('chkOk')}${r}`, { formula: `ROUND(${C('chkPts')}${r},2)=ROUND(K${r},2)`, result: Math.abs(chkPts - v.PointEntitlement) < 0.005 }, { font: chkFont });
    setCell(ws, `${C('chkDays')}${r}`, F(`L${r}+${C('mc')}${r}+${C('upl')}${r}+${C('late')}${r}-$L$10`, v.DaysWorked + v.DeductDays - dim), { font: chkFont });
    if (hasStaffMin(settings, scheme)) setCell(ws, `${C('topUp')}${r}`, a.topUp ? fx2('staffTopUp', a.topUp) : null, { numFmt: '#,##0.00', font: { color: { argb: 'FF7030A0' } } });
  }

  function toDate(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : String(s);
  }

  function writeFixed(ws, o, lay, settings) {
    const fp = lay.fixedPlan; const { cols, list } = lay.plan; const C = (k) => cols[k].L;
    setCell(ws, `A${fp.title}`, 'Fixed Service Charge approved by COO', { font: { bold: true } });
    list.forEach((col) => {
      if (['e', 'f', 'gap', 'chkPts', 'chkOk', 'chkDays', 'topUp'].includes(col.key)) return;
      setCell(ws, `${col.L}${fp.header}`, col.label, { font: { bold: true }, fill: GREY, alignment: { wrapText: true, horizontal: 'center', vertical: 'middle' }, border: box(medium) });
    });
    ws.getRow(fp.header).height = 60.75;
    ws.mergeCells(`D${fp.header}:F${fp.header}`);
    const amtCol = cols.perm ? 'perm' : lay.plan.entKeys[0];
    (o.fixedRows || []).forEach((f, i) => {
      const r = fp.first + i; const st = { fill: settings.colors.HELPER, border: box() };
      setCell(ws, `A${r}`, i + 1, { ...st, alignment: { horizontal: 'center' } });
      setCell(ws, `B${r}`, f.fromOutlet || '', st); setCell(ws, `C${r}`, f.empNo || '', st); setCell(ws, `D${r}`, f.name || '', st);
      setCell(ws, `G${r}`, f.position || '', st); setCell(ws, `H${r}`, toDate(f.joinDate), { ...st, numFmt: 'dd-mmm-yy' }); setCell(ws, `J${r}`, f.status || 'PERMANENT', st);
      setCell(ws, `L${r}`, f.days === '' || f.days === undefined ? null : Number(f.days) || f.days, { ...st, alignment: { horizontal: 'center' } });
      setCell(ws, `M${r}`, '-', { ...st, alignment: { horizontal: 'center' } }); if (cols.N) setCell(ws, `N${r}`, '-', { ...st, alignment: { horizontal: 'center' } });
      setCell(ws, `${C(amtCol)}${r}`, E.num(f.amount), { ...st, numFmt: '#,##0.00' });
      setCell(ws, `${C('remarks')}${r}`, f.remark || `From ${f.fromOutlet}\nFixed SC approved by COO: RM${E.num(f.amount)}`, { ...st, alignment: { wrapText: true } });
      ws.getRow(r).height = 33;
    });
    setCell(ws, `${C(amtCol)}${fp.total}`, F(`SUM(${C(amtCol)}${fp.first}:${C(amtCol)}${fp.last})`, (o.fixedRows || []).reduce((s, f) => s + E.num(f.amount), 0)), { font: { bold: true }, numFmt: '#,##0.00', border: box(medium) });
  }

  function writeSignatures(ws, lay, settings) {
    const d0 = lay.d0; const sig = settings.signatories || [];
    sig.slice(0, 4).forEach((s, i) => {
      const col = colL(2 + i);
      setCell(ws, `${col}${d0}`, s.role, { font: { bold: true }, fill: GREY, border: box(), alignment: { horizontal: 'center' } });
      for (let k = 1; k <= 3; k++) setCell(ws, `${col}${d0 + k}`, null, { border: box() });
      setCell(ws, `${col}${d0 + 4}`, s.name, { font: { bold: true }, border: box(), alignment: { horizontal: 'center' } });
      setCell(ws, `${col}${d0 + 5}`, s.position, { font: { bold: true }, border: box(), alignment: { horizontal: 'center' } });
      setCell(ws, `${col}${d0 + 6}`, null, { border: box() });
    });
    ws.mergeCells(`A${d0 + 1}:A${d0 + 3}`);
    setCell(ws, `A${d0 + 1}`, 'Signature', { font: { bold: true }, border: box(), alignment: { vertical: 'middle' } });
    setCell(ws, `A${d0 + 4}`, 'Name', { font: { bold: true }, border: box() });
    setCell(ws, `A${d0 + 5}`, 'Position', { font: { bold: true }, border: box() });
    setCell(ws, `A${d0 + 6}`, 'Date', { font: { bold: true }, border: box() });
  }

  function writeDetails(ws, o, res, lay, settings, scheme, ctx) {
    const S = res.summary; const det = lay.det; const vc = colL(lay.detValue); const lc = colL(lay.detLabel);
    const V = (k) => `${vc}${det[k]}`;
    const label = (r, text, opt = {}) => { ws.mergeCells(`${lc}${r}:${colL(lay.detValue - 1)}${r}`); setCell(ws, `${lc}${r}`, text, { font: { bold: true, ...(opt.font || {}) }, fill: opt.fill, border: box() }); };
    const val = (k, v, opt = {}) => setCell(ws, V(k), v, { font: { bold: true }, numFmt: ACC, border: box(), fill: opt.fill });
    ws.mergeCells(`${lc}${lay.d0}:${vc}${lay.d0}`);
    setCell(ws, `${lc}${lay.d0}`, `Details - GMM ${o.code || o.sheetName}`, { font: { bold: true }, fill: GREY, border: box(), alignment: { horizontal: 'center' } });
    const fx = (id, refs, result) => F(E.toExcel(settings.formulas[id] || E.DEFAULT_FORMULAS[id].expr, refs), result);
    const minRef = lay.minOn ? V('min') : 0;
    lay.lines.forEach(([k, text]) => label(det[k], text, { fill: k === 'fixed' ? settings.colors.HELPER : undefined, font: k === 'incTotal2' ? { color: { argb: 'FFED0000' } } : {} }));
    if (scheme === 'sc') {
      if (o.kind === 'central') {
        (S.sources || []).forEach((s, i) => {
          const src = ctx.outlets.find((x) => x.sheetName.toLowerCase() === String(s.outlet).toLowerCase() && x.kind !== 'central');
          const lay2 = src && ctx.layouts[src.id];
          val('src' + i, lay2 && lay2.ckAddr ? F(`${sheetRef(src.sheetName.slice(0, 31))}!${lay2.ckAddr}`, s.amount) : s.amount, { fill: 'FFFFFFCC' });
        });
        const n = (S.sources || []).length;
        val('nett', n ? F(`SUM(${V('src0')}:${V('src' + (n - 1))})${det.fixed ? `-${V('fixed')}` : ''}`, S.Nett) : 0);
      } else {
        val('collected', E.num(o.scCollected), { fill: 'FFFFFF00' });
        val('distributable', fx('distributable', { Collected: V('collected'), DistributePct: E.num(o.distributePct || settings.sc.distributePct) }, S.Distributable));
        val('ck', fx('ckDeduction', { Distributable: V('distributable'), CKPct: E.num(o.ckPct || settings.sc.ckPct) }, S.CKDeduction));
        val('nett', fx('nett', { Distributable: V('distributable'), CKDeduction: V('ck'), FixedAllowance: det.fixed ? V('fixed') : 0 }, S.Nett));
      }
      if (det.fixed) { const fp = lay.fixedPlan; const amt = lay.plan.cols.perm ? lay.plan.cols.perm.L : lay.plan.cols[lay.plan.entKeys[0]].L; val('fixed', F(`${amt}${fp.total}`, S.FixedAllowance !== undefined ? S.FixedAllowance : res.totals.fixed), { fill: settings.colors.HELPER }); }
      val('points', F(`SUM(K${lay.first}:K${lay.last})`, S.TotalPoints));
      if (lay.minOn) val('min', E.num(settings.sc.minValue), { fill: 'FFFFFF00' });
      val('pv', fx('pointValue', { Nett: V('nett'), TotalPoints: V('points'), MinPointValue: minRef }, S.PointValue), { fill: 'FFFFFF00' });
      if (lay.minOn) val('topup', fx('companyTopUp', { PointValue: V('pv'), TotalPoints: V('points'), Nett: V('nett'), MinPointValue: minRef }, S.CompanyTopUp));
    } else {
      val('sales', E.num(o.netSales), { fill: 'FFFFFF00' });
      val('incTotal', fx('incentiveTotal', { NetSales: V('sales'), IncentivePct: E.num(o.incPct || settings.inc.pct) }, S.IncentiveTotal));
      val('incTotal2', F(V('incTotal'), S.IncentiveTotal));
      val('nett', F(V('incTotal2'), S.Nett));
      val('points', F(`SUM(K${lay.first}:K${lay.last})`, S.TotalPoints));
      if (lay.minOn) val('min', E.num(settings.inc.minValue), { fill: 'FFFFFF00' });
      val('pv', fx('incPointValue', { IncentiveTotal: V('nett'), TotalPoints: V('points'), MinPointValue: minRef }, S.PointValue), { fill: 'FFFFFF00' });
      if (lay.minOn) val('topup', F(`MAX(0,${V('pv')}*${V('points')}-${V('nett')})`, S.CompanyTopUp));
    }
    // check: nett - everything distributed (should be ~0, small rounding differences are normal)
    const C = (k) => lay.plan.cols[k].L;
    setCell(ws, `${vc}${det.check}`, F(`${V('nett')}${lay.minOn && det.topup ? `+${V('topup')}` : ''}-${C(lay.plan.entKeys[0])}${lay.totalSCRow}-${C(lay.plan.rbKeys[0])}${lay.totalSCRow}-${C('pool')}${lay.totalRow}`, round2(S.Nett + (lay.minOn ? S.CompanyTopUp : 0) - res.totals.grand)), { numFmt: ACC, font: { size: 10, color: { argb: 'FF808080' } } });
    setCell(ws, `${lc}${det.check}`, 'Check (should be ≈ 0)', { font: { size: 10, color: { argb: 'FF808080' } } });
  }

  function writeRecon(ws, o, res, lay, settings, scheme) {
    const { cols, entKeys, rbKeys } = lay.plan; const C = (k) => cols[k].L;
    const lc = colL(lay.reconLabel), vc = C('remarks');
    let r = lay.d0;
    const tr = lay.totalRow;
    const line = (text, formula, result, opt = {}) => {
      ws.mergeCells(`${lc}${r}:${colL(cols.remarks.idx - 1)}${r}`);
      setCell(ws, `${lc}${r}`, text, { font: { bold: true }, fill: opt.fill, border: box() });
      setCell(ws, `${vc}${r}`, F(formula, result), { font: { bold: !!opt.bold }, fill: opt.fill, numFmt: ACC, border: box() });
      return r++;
    };
    const subs = [];
    const LABEL = { mgmt: 'Management (HQ)', perm: 'Staff - Permanent', casual: 'Casual Labour', fw: scheme === 'sc' ? 'Foreign Worker (0.25 points)' : 'Foreign Worker',
      mia: 'Rollback: Permenant - MIA / Short Notice', deduction: 'Rollback: Deduction based on attendance', miaFW: 'Rollback: Foreign Worker (MIA)', fw075: 'Rollback: Foreign Worker (0.75 points)' };
    const tot = (k) => res.rows.reduce((s, x) => s + (cellNumber(x, k, settings) || 0), 0);
    const group = (keys) => {
      const start = r;
      if (keys.includes('mgmt')) res.rows.forEach((x, i) => { if (x.row.category === 'MGMT') line(`Management - ${x.row.name}`, `${C('mgmt')}${lay.first + i}`, x.alloc.entitled); });
      keys.filter((k) => k !== 'mgmt').forEach((k) => line(LABEL[k], `${C(k)}${tr}`, round2(tot(k))));
      subs.push(line('Subtotal ', `SUM(${vc}${start}:${vc}${r - 1})`, 0, { fill: GREY, bold: true }));
    };
    group(entKeys);
    group(rbKeys);
    const ps = r; line('Retent to Pool', `${C('pool')}${tr}`, res.totals.pool);
    subs.push(line('Subtotal ', `SUM(${vc}${ps}:${vc}${r - 1})`, res.totals.pool, { fill: GREY, bold: true }));
    r++;
    line('Grand total', subs.map((s) => `${vc}${s}`).join('+'), res.totals.grand, { fill: 'FFFFC000', bold: true });
    setCell(ws, `${vc}${r}`, F(`${colL(lay.detValue)}${lay.det.nett}-${vc}${r - 1}`, round2(res.summary.Nett - res.totals.grand)), { numFmt: ACC, font: { size: 10, color: { argb: 'FF808080' } } });
    // fill subtotal results
    subs.forEach((sr) => { const c = ws.getCell(`${vc}${sr}`); const f = c.value.formula; const m = /SUM\(([A-Z]+)(\d+):[A-Z]+(\d+)\)/.exec(f); if (m) { let s = 0; for (let k = +m[2]; k <= +m[3]; k++) { const v = ws.getCell(`${vc}${k}`).value; s += (v && v.result) || 0; } c.value = { formula: f, result: round2(s) }; } });
  }

  // Post-process: switch on "Precision as displayed" (same as the stakeholder workbook) using JSZip.
  async function toBuffer(wb, settings, JSZip) {
    let buf = await wb.xlsx.writeBuffer();
    if (settings.precisionAsDisplayed !== false && JSZip) {
      const zip = await JSZip.loadAsync(buf);
      let xml = await zip.file('xl/workbook.xml').async('string');
      if (/<calcPr[^>]*\/>/.test(xml)) xml = xml.replace(/<calcPr([^>]*?)\s*\/>/, (m, a) => `<calcPr${a.replace(/\sfullPrecision="[^"]*"/, '')} fullPrecision="0"/>`);
      else xml = xml.replace('</workbook>', '<calcPr calcId="191029" fullCalcOnLoad="1" fullPrecision="0"/></workbook>');
      zip.file('xl/workbook.xml', xml);
      buf = await zip.generateAsync({ type: typeof window === 'undefined' ? 'nodebuffer' : 'arraybuffer', compression: 'DEFLATE' });
    }
    return buf;
  }

  const api = { exportWorkbook, toBuffer, planColumns, planLayout, colL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GMM = root.GMM || {}; root.GMM.exporter = api;
})(typeof window !== 'undefined' ? window : globalThis);
