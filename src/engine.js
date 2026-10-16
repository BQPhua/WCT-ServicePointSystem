/* GMM Service Charge & Incentive Tool — calculation engine.
 * Pure functions only (no DOM). Works in the browser (window.GMM.engine) and in Node (module.exports).
 *
 * Every number the tool produces comes from a named formula in `settings.formulas`.
 * A formula is a small Excel-like expression over named variables, e.g.
 *     ROUND(DaysWorked/DaysInMonth,2)*Base*Share
 * The same expression is (a) evaluated in JS for the on-screen preview and
 * (b) translated to a real Excel formula (variables -> cell references) on export,
 * so the screen and the spreadsheet always agree, and HR can change a formula in one place.
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ expression language
  const FUNCS = {
    ROUND: (x, n = 0) => xlRound(x, n),
    ROUNDUP: (x, n = 0) => { const f = 10 ** n; return Math.sign(x) * Math.ceil(Math.abs(x) * f - 1e-9) / f; },
    ROUNDDOWN: (x, n = 0) => { const f = 10 ** n; return Math.sign(x) * Math.floor(Math.abs(x) * f + 1e-9) / f; },
    MAX: (...a) => Math.max(...a),
    MIN: (...a) => Math.min(...a),
    ABS: (x) => Math.abs(x),
    IF: (c, a, b = 0) => (c ? a : b),
    SUM: (...a) => a.reduce((s, v) => s + v, 0),
    AND: (...a) => a.every(Boolean),
    OR: (...a) => a.some(Boolean),
  };

  function xlRound(x, n) {
    if (!isFinite(x)) return x;
    const s = x < 0 ? -1 : 1;
    // Excel rounds half away from zero; the '+e' trick avoids binary float artefacts (1.005 -> 1.01)
    return s * Number(Math.round(Number(Math.abs(x) + 'e' + n)) + 'e-' + n);
  }

  function tokenize(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c)) {
        let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++;
        let v = parseFloat(src.slice(i, j));
        if (src[j] === '%') { v = v / 100; j++; }
        out.push({ t: 'num', v }); i = j; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
        out.push({ t: 'id', v: src.slice(i, j) }); i = j; continue;
      }
      const two = src.slice(i, i + 2);
      if (['<=', '>=', '<>'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
      if ('+-*/^(),<>='.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
      throw new Error(`Unexpected character "${c}" at position ${i + 1}`);
    }
    return out;
  }

  const PREC = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '+': 2, '-': 2, '*': 3, '/': 3, '^': 4 };

  function parse(src) {
    const toks = tokenize(String(src));
    let p = 0;
    const peek = () => toks[p];
    const eat = (v) => {
      const t = toks[p];
      if (!t || (v && t.v !== v)) throw new Error(`Expected "${v}"` + (t ? ` but found "${t.v}"` : ' at end of formula'));
      p++; return t;
    };
    function primary() {
      const t = peek();
      if (!t) throw new Error('Formula ended unexpectedly');
      if (t.t === 'num') { p++; return { t: 'num', v: t.v }; }
      if (t.v === '(') { p++; const e = expr(0); eat(')'); return { t: 'paren', a: e }; }
      if (t.v === '-') { p++; return { t: 'neg', a: primary() }; }
      if (t.v === '+') { p++; return primary(); }
      if (t.t === 'id') {
        p++;
        if (peek() && peek().v === '(') {
          const name = t.v.toUpperCase();
          if (!FUNCS[name]) throw new Error(`Unknown function ${t.v}()`);
          p++; const args = [];
          if (peek() && peek().v !== ')') { args.push(expr(0)); while (peek() && peek().v === ',') { p++; args.push(expr(0)); } }
          eat(')');
          return { t: 'call', f: name, args };
        }
        return { t: 'id', n: t.v };
      }
      throw new Error(`Unexpected "${t.v}"`);
    }
    function expr(minPrec) {
      let left = primary();
      for (;;) {
        const t = peek();
        if (!t || t.t !== 'op' || PREC[t.v] === undefined || PREC[t.v] < minPrec) break;
        const op = t.v; p++;
        const right = expr(op === '^' ? PREC[op] : PREC[op] + 1);
        left = { t: 'bin', op, a: left, b: right };
      }
      return left;
    }
    const ast = expr(0);
    if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}"`);
    return ast;
  }

  function evaluate(ast, vars) {
    switch (ast.t) {
      case 'num': return ast.v;
      case 'paren': return evaluate(ast.a, vars);
      case 'neg': return -evaluate(ast.a, vars);
      case 'id': {
        if (!(ast.n in vars)) throw new Error(`Unknown variable "${ast.n}"`);
        const v = vars[ast.n];
        return typeof v === 'number' ? v : Number(v) || 0;
      }
      case 'call': return FUNCS[ast.f](...ast.args.map((a) => evaluate(a, vars)));
      case 'bin': {
        const a = evaluate(ast.a, vars), b = evaluate(ast.b, vars);
        switch (ast.op) {
          case '+': return a + b; case '-': return a - b; case '*': return a * b;
          case '/': return b === 0 ? 0 : a / b; case '^': return a ** b;
          case '=': return a === b ? 1 : 0; case '<>': return a !== b ? 1 : 0;
          case '<': return a < b ? 1 : 0; case '>': return a > b ? 1 : 0;
          case '<=': return a <= b ? 1 : 0; case '>=': return a >= b ? 1 : 0;
        }
      }
    }
    throw new Error('Bad expression');
  }

  function identifiers(ast, acc = new Set()) {
    if (ast.t === 'id') acc.add(ast.n);
    ['a', 'b'].forEach((k) => ast[k] && identifiers(ast[k], acc));
    (ast.args || []).forEach((x) => identifiers(x, acc));
    return acc;
  }

  // Replace variables by Excel references or literal numbers, then fold constants and drop "*1".
  function substitute(ast, refs) {
    switch (ast.t) {
      case 'id': {
        const r = refs[ast.n];
        if (r === undefined) throw new Error(`No Excel mapping for "${ast.n}"`);
        if (typeof r === 'number') return { t: 'num', v: r };
        return { t: 'ref', v: r };
      }
      case 'paren': { const a = substitute(ast.a, refs); return a.t === 'num' || a.t === 'ref' ? a : { t: 'paren', a }; }
      case 'neg': { const a = substitute(ast.a, refs); return a.t === 'num' ? { t: 'num', v: -a.v } : { t: 'neg', a }; }
      case 'call': return { t: 'call', f: ast.f, args: ast.args.map((x) => substitute(x, refs)) };
      case 'bin': {
        const a = substitute(ast.a, refs), b = substitute(ast.b, refs);
        if (a.t === 'num' && b.t === 'num' && '+-*/'.includes(ast.op)) return { t: 'num', v: xlRound(evaluate({ t: 'bin', op: ast.op, a, b }, {}), 10) };
        if (ast.op === '*' && b.t === 'num' && b.v === 1) return a;
        if (ast.op === '*' && a.t === 'num' && a.v === 1) return b;
        if (ast.op === '/' && b.t === 'num' && b.v === 1) return a;
        if ((ast.op === '-' || ast.op === '+') && b.t === 'num' && b.v === 0) return a;
        return { t: 'bin', op: ast.op, a, b };
      }
      default: return ast;
    }
  }

  function render(ast, prec = 0) {
    switch (ast.t) {
      case 'num': return String(ast.v);
      case 'ref': return /[+\-*/]/.test(ast.v) ? `(${ast.v})` : ast.v;
      case 'id': return ast.n;
      case 'paren': return `(${render(ast.a)})`;
      case 'neg': return `-${render(ast.a, 5)}`;
      case 'call': return `${ast.f}(${ast.args.map((x) => render(x)).join(',')})`;
      case 'bin': {
        const p = PREC[ast.op];
        const s = `${render(ast.a, p)}${ast.op}${render(ast.b, p + (ast.op === '-' || ast.op === '/' ? 1 : 0))}`;
        return p < prec ? `(${s})` : s;
      }
    }
    return '';
  }

  function toExcel(expr, refs) { return '=' + render(substitute(parse(expr), refs)); }

  // ------------------------------------------------------------------ formula registry
  // vars: documentation of every variable a formula may use (shown in the ? popover and formula editor)
  const VARIABLES = {
    DaysInMonth: 'Calendar days in the attendance month (cell L10).',
    NotEmployed: 'Days in the month before join date / after last day (not counted as leave).',
    EligibleDays: 'DaysInMonth − NotEmployed. Days the staff was on this outlet\'s payroll.',
    MC: 'MC / HL / HS days (medical category) — deductible.',
    UPL: 'Unpaid leave days (+ absent days when "count absent as UPL" is on) — deductible.',
    Late: 'Lateness converted to days — deductible.',
    DeductDays: 'MC + UPL + Late (the "Total Days" used for the deduction tier).',
    DaysWorked: 'Column L "Days Worked".',
    Base: 'Full-month point entitlement for this staff (1 for local staff, 0.5 for some HQ management, 2 for incentive outlet heads).',
    Share: 'Share of points paid to the staff: 1 for local staff, 0.25 for foreign workers (service charge).',
    CompanyShare: 'Share of foreign-worker points that belongs to the company (0.75).',
    PointEntitlement: 'Column K "Point Entitlement".',
    Points: 'Column M "No. of points".',
    ReservedPoints: 'Column N "No of Points (Reserved)" — company share for foreign workers.',
    PoolPoints: '"No. of points" retained to pool because of MC/UPL/lateness.',
    PoolAmount: 'RM amount retained to pool.',
    PointValue: '"1 Service Point (fixed)" / "1 Incentive point (fixed)" in RM.',
    TierPct: 'Deduction % of the tier the staff falls into (0.3, 0.5 or 1).',
    Entitled: 'RM amount the staff receives.',
    MinimumPayout: 'Minimum RM per staff (per-staff top-up mode).',
    Collected: 'Total service charge collected for the month (yellow input).',
    DistributePct: '% of service charge distributed to staff (80%).',
    Distributable: 'Collected × DistributePct.',
    CKPct: '% for Central Kitchen / HQ (11%).',
    CKDeduction: 'Distributable × CKPct.',
    FixedAllowance: 'Total fixed SC approved by COO for helpers from other outlets.',
    Nett: 'Nett total to pay to outlet.',
    TotalPoints: 'SUM of column K (Point Entitlement).',
    MinPointValue: 'Minimum RM per point (top-up rule, RM 450). 0 = off.',
    NetSales: 'Total net sales of the outlet for the month (incentive).',
    IncentivePct: '% of net sales distributed as incentive (1.5%).',
    IncentiveTotal: 'NetSales × IncentivePct.',
  };

  const DEFAULT_FORMULAS = {
    entitlement: { label: 'Point Entitlement (K)', col: 'K', expr: 'IF(EligibleDays>=DaysInMonth, Base, ROUND(EligibleDays/DaysInMonth,2)*Base)',
      help: 'Points the staff is entitled to before any MC/UPL/lateness. Non-deductible leave (OFF, AL, PH…) does not change K. New joiners / leavers are prorated by the days they were employed.' },
    daysWorked: { label: 'Days Worked (L)', col: 'L', expr: 'DaysInMonth-NotEmployed-DeductDays',
      help: 'Calendar days minus days not employed minus deductible leave (MC/HL, UPL, absent, lateness). Written to Excel like the stakeholder file, e.g. =31-2.' },
    points: { label: 'No. of points (M)', col: 'M', expr: 'ROUND(DaysWorked/DaysInMonth,2)*Base*Share',
      help: 'Deductible leave reduces the points. Local staff: Share = 1. Foreign workers: Share = 0.25 (the other 0.75 goes to column N / the company).' },
    reserved: { label: 'No of Points (Reserved) (N)', col: 'N', expr: 'ROUND(DaysWorked/DaysInMonth,2)*Base*CompanyShare',
      help: 'Foreign workers only: the 0.75 share of the point that belongs to the company.' },
    poolPoints: { label: 'Pool – No. of points', col: 'pool pts', expr: 'ROUND(DeductDays/DaysInMonth,2)',
      help: 'Points lost through MC/HL, UPL and lateness are retained in the outlet pool.' },
    poolAmount: { label: 'Pool (RM)', col: 'pool', expr: 'ROUND(PoolPoints*PointValue,2)', help: 'RM retained to pool.' },
    entitledNormal: { label: 'Entitled amount (0–3 days)', col: 'entitled', expr: 'ROUND(Points*PointValue,2)',
      help: 'Normal case and 1–3 deductible days: prorated on the actual number of days.' },
    entitledTier: { label: 'Entitled amount (30% / 50% tier)', col: 'entitled', expr: 'PointEntitlement*PointValue*(1-TierPct)',
      help: '4–5 days: 30% deduction, 6–7 days: 50% deduction from the full point.' },
    deductionTier: { label: 'Deduction based on attendance (tier)', col: 'deduction', expr: 'PointEntitlement*PointValue*TierPct-PoolAmount',
      help: 'The tier deduction less what already went to the pool, rolled back to the company.' },
    deductionFull: { label: 'Deduction based on attendance (100%)', col: 'deduction', expr: 'ROUND(Points*PointValue,2)',
      help: '8 days & above: 100% deduction — the whole amount is rolled back to the company.' },
    mia: { label: 'MIA / Short notice / Absconded', col: 'MIA', expr: 'ROUND(Points*PointValue,2)',
      help: 'Absconded or short-notice staff are not entitled; the amount is rolled back to the company.' },
    fwCompany: { label: 'Foreign Worker 0.75 points (RM)', col: 'FW 0.75', expr: 'ROUND(ReservedPoints*PointValue,2)',
      help: 'Company share of foreign-worker points, rolled back to the company.' },
    staffTopUp: { label: 'Top-up to minimum (per staff)', col: 'top-up', expr: 'IF(Entitled>0, MAX(0, MinimumPayout-Entitled), 0)',
      help: 'Only when the minimum rule is set to "per staff": company tops up the staff payout to the minimum.' },
    distributable: { label: 'Distribute % of Total Service Charge', col: 'summary', expr: 'ROUND(Collected*DistributePct,2)', help: '80% of the service charge collected is distributed.' },
    ckDeduction: { label: 'Less % for Central Kitchen / HQ', col: 'summary', expr: 'ROUND(Distributable*CKPct,2)', help: '11% of the distributable amount goes to Central Kitchen / HQ.' },
    nett: { label: 'Nett Total of Service Charge to pay to outlet', col: 'summary', expr: 'Distributable-CKDeduction-FixedAllowance', help: 'Distributable − CK/HQ − fixed SC allowances.' },
    pointValue: { label: '1 Service Point (fixed)', col: 'summary', expr: 'MAX(Nett/TotalPoints, MinPointValue)',
      help: 'Nett ÷ total point entitlement. If the result is below the minimum (RM 450) the company tops it up to the minimum.' },
    companyTopUp: { label: 'Company top-up to minimum point value', col: 'summary', expr: 'IF(Nett/TotalPoints<MinPointValue, MinPointValue*TotalPoints-Nett, 0)', help: 'Extra RM the company adds so each point is worth at least the minimum.' },
    incentiveTotal: { label: 'Total of Incentive', col: 'summary', expr: 'NetSales*IncentivePct', help: '1.5% of total net sales.' },
    incPointValue: { label: '1 Incentive point (fixed)', col: 'summary', expr: 'MAX(IncentiveTotal/TotalPoints, MinPointValue)', help: 'Total incentive ÷ total points (minimum applies only if set).' },
  };

  // ------------------------------------------------------------------ default settings
  const DEFAULT_CODES = [
    // code, category, description.  Categories: WORK | NODEDUCT | MC | UPL | ABSENT | NOTEMP
    ['W', 'WORK', 'Worked (has punches / handwritten hours)'],
    ['WORK', 'WORK', 'Worked'],
    ['OFF', 'NODEDUCT', 'Off day / rest day'],
    ['RD', 'NODEDUCT', 'Rest day'],
    ['AL', 'NODEDUCT', 'Annual leave'],
    ['PH', 'NODEDUCT', 'Public holiday'],
    ['RL', 'NODEDUCT', 'Replacement leave'],
    ['EL', 'NODEDUCT', 'Emergency leave (paid)'],
    ['CL', 'NODEDUCT', 'Compassionate leave'],
    ['PL', 'NODEDUCT', 'Paternity / paid leave'],
    ['MAT', 'NODEDUCT', 'Maternity leave'],
    ['TRAINING', 'NODEDUCT', 'Training / outstation'],
    ['TRN', 'NODEDUCT', 'Training'],
    ['MC', 'MC', 'Medical certificate'],
    ['HL', 'MC', 'Hospitalisation leave'],
    ['HS', 'MC', 'Hospitalisation (HS/MC = MC category)'],
    ['ML', 'MC', 'Medical leave'],
    ['UPL', 'UPL', 'Unpaid leave'],
    ['UL', 'UPL', 'Unpaid leave'],
    ['NPL', 'UPL', 'No-pay leave'],
    ['UNP', 'UPL', 'Unpaid'],
    ['ABSENT', 'ABSENT', 'Absent without leave (MIA)'],
    ['BLANK', 'ABSENT', 'No punch and no annotation — please review'],
    ['NOTEMP', 'NOTEMP', 'Not yet joined / already left / transferred'],
  ].map(([code, category, desc]) => ({ code, category, desc }));

  const DEFAULT_SETTINGS = {
    version: 1,
    tiers: [
      { from: 1, to: 3, pct: 0, label: '1 - 3 days', text: 'Prorate based on the actual number of days' },
      { from: 4, to: 5, pct: 0.3, label: '4 - 5 days', text: '30% deduction' },
      { from: 6, to: 7, pct: 0.5, label: '6 - 7 days', text: '50% deduction' },
      { from: 8, to: 999, pct: 1, label: '8 days & above', text: '100% deduction' },
    ],
    fwShare: 0.25,
    companyShare: 0.75,
    precisionAsDisplayed: true, // match the stakeholder workbook setting (File > Options > Advanced)
    absentCountsAsUPL: true,
    lateDetection: false, // detect lateness from the first punch vs shiftStart
    shiftStart: '10:00',
    lateGraceMinutes: 0,
    lateCountPerDay: 0, // 0 = lateness counted for information only; e.g. 3 = every 3 lates = 1 day deducted
    sc: { distributePct: 0.8, ckPct: 0.11, minMode: 'point', minValue: 450 },
    inc: { pct: 0.015, fwShare: 1, minMode: 'off', minValue: 0, excludeMgmt: true, headPoints: 2 },
    // Outlets the attendance can be assigned to (Settings → Outlets). kind 'central' = funded by the other outlets' CK/HQ %.
    outlets: [
      { name: 'Pavilion KL', company: 'CHAMPION VISTA SDN BHD', title: 'PAVILION KUALA LUMPUR', code: 'PKL', kind: 'outlet', tab: 'FF92D050' },
      { name: 'Pavilion Bukit Jalil', company: 'CHAMPION VISTA SDN BHD', title: 'PAVILION BUKIT JALIL', code: 'PBJ', kind: 'outlet', tab: 'FF92D050' },
      { name: 'Intermark', company: 'CHAMPION VISTA SDN BHD', title: 'INTERMARK', code: 'INTERMARK', kind: 'outlet', tab: 'FF92D050' },
      { name: 'KLIA 1', company: 'CHAMPION VISTA SDN BHD', title: 'KLIA 1', code: 'KLIA 1', kind: 'outlet', tab: 'FF92D050' },
      { name: 'KLIA 2 (L2)', company: 'CHAMPION VISTA SDN BHD', title: 'KLIA 2 (L2)', code: 'KLIA 2 (L2)', kind: 'outlet', tab: 'FF92D050' },
      { name: 'KLIA 2 (L3)', company: 'CHAMPION VISTA SDN BHD', title: 'KLIA 2 (L3)', code: 'KLIA 2 (L3)', kind: 'outlet', tab: 'FF92D050' },
      { name: 'Genting', company: 'ALIRAN TIASA SDN BHD', title: 'GENTING', code: 'GENTING', kind: 'outlet', tab: 'FFFFFF00' },
      { name: 'Central Kitchen', company: 'CHAMPION VISTA SDN BHD', title: 'CENTRAL KITCHEN', code: 'CENTRAL KITCHEN', kind: 'central', tab: 'FF92D050' },
    ],
    codes: DEFAULT_CODES,
    formulas: Object.fromEntries(Object.entries(DEFAULT_FORMULAS).map(([k, v]) => [k, v.expr])),
    colors: {
      MGMT: 'FFFDE9D9', // orange — management
      FW: 'FFF2DCDB', // red — foreign worker / agent
      CASUAL: 'FFD8E4BC', // green — casual labour
      RASA: 'FFE2E9F2', // blue — Rasa by Grandmama
      HELPER: 'FFE1FFE1', // light green — helping from other outlet
      HEAD: 'FFFFFFCC', // light yellow — outlet head (manager / chef)
      DEDUCT: 'FFE6E0EC', // purple — attendance deduction tier (4+ days) applied
      fontNew: 'FF0000FF', // blue font — new joiner
      fontLeaving: 'FFFF0000', // red font — resigned / absconded / leaving
      fontNormal: 'FF000000', // black — current staff
    },
    signatories: [
      { role: 'Prepared by', name: 'Hoi Yen', position: 'SE-HR' },
      { role: 'Verified by', name: 'Alvina', position: 'SM-HR' },
      { role: 'Reviewed by', name: 'May Chan', position: 'GM' },
      { role: 'Approved by', name: 'Lee Chee Hung', position: 'COO' },
    ],
    terms: [
      'Newly joined staff for the month will have their service point pro-rated in following month.',
      'Resigned staff (with full notice served) to receive prorated service point. Those who absconded or with short notice are not entitled to any service points.',
      'Foreign workers 75% of service charge will be rolled back to company.',
      'Foreign workers located will entitle for 25% of service charge.',
    ],
    ai: { preset: 'gemini-3.8-flash', provider: 'gemini', model: 'gemini-3.8-flash', fallbackPreset: 'gemini-3.5-flash', keys: { gemini: '', anthropic: '', openai: '' }, apiKey: '', baseUrl: '', rotate: 'auto', instructions: '' },
  };

  // ------------------------------------------------------------------ helpers
  const deepClone = (o) => JSON.parse(JSON.stringify(o));
  function mergeSettings(saved) {
    const s = deepClone(DEFAULT_SETTINGS);
    if (!saved) return s;
    for (const k of Object.keys(saved)) {
      if (saved[k] && typeof saved[k] === 'object' && !Array.isArray(saved[k]) && s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) s[k] = { ...s[k], ...saved[k] };
      else s[k] = saved[k];
    }
    return s;
  }

  function daysInMonth(ym) { // '2026-07'
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  }

  function tierFor(days, settings) {
    if (!days) return null;
    return settings.tiers.find((t) => days >= t.from && days <= t.to) || null;
  }

  function codeCategory(code, settings) {
    const c = String(code || '').trim().toUpperCase();
    if (!c) return 'ABSENT';
    const hit = settings.codes.find((x) => x.code.toUpperCase() === c);
    return hit ? hit.category : 'REVIEW';
  }

  // Summarise a day-by-day attendance array into counts. days: [{day, code, firstIn, note}]
  function summariseDays(days, settings, dim) {
    const s = { worked: 0, OFF: 0, AL: 0, PH: 0, nodeduct: 0, MC: 0, UPL: 0, ABSENT: 0, NOTEMP: 0, REVIEW: 0, late: 0, blank: 0, codes: {}, mcDays: [], uplDays: [], absentDays: [], reviewDays: [], lateDays_: [] };
    const byDay = new Map((days || []).map((d) => [Number(d.day), d]));
    for (let d = 1; d <= dim; d++) {
      const rec = byDay.get(d) || { day: d, code: 'BLANK' };
      const code = String(rec.code || 'BLANK').toUpperCase();
      const cat = codeCategory(code, settings);
      s.codes[code] = (s.codes[code] || 0) + 1;
      if (code === 'BLANK') s.blank++;
      switch (cat) {
        case 'WORK': s.worked++; if (/\bLATE\b/i.test(rec.note || '') || (settings.lateDetection && isLate(rec.firstIn, settings.shiftStart, settings.lateGraceMinutes))) { s.late++; s.lateDays_.push(d); } break;
        case 'NODEDUCT': s.nodeduct++; if (code in s) s[code]++; break;
        case 'MC': s.MC++; s.mcDays.push(d); break;
        case 'UPL': s.UPL++; s.uplDays.push(d); break;
        case 'ABSENT': s.ABSENT++; s.absentDays.push(d); break;
        case 'NOTEMP': s.NOTEMP++; break;
        default: s.REVIEW++; s.reviewDays.push(d);
      }
    }
    s.allBlank = s.worked === 0 && s.MC === 0 && s.UPL === 0 && s.nodeduct === 0;
    return s;
  }

  // Lateness detection from first punch vs scheduled start ("10:00")
  function isLate(firstIn, scheduled, graceMin) {
    const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
    const a = toMin(firstIn), b = toMin(scheduled);
    if (a === null || b === null) return false;
    if (a < 5 * 60) return false; // after-midnight punch = previous shift's clock-out
    return a > b + (graceMin || 0);
  }

  // ------------------------------------------------------------------ row computation
  // row fields used: category MGMT|PERM|CASUAL|FW, base (sc), incBase, exitType ''|RESIGN_FULL|MIA|ROLLBACK,
  // notEmployed, mc, upl, absent, lateDays, overrides{K,L,...}, fixedAmount, inIncentive
  function rowInputs(row, scheme, settings, dim) {
    const isFW = row.category === 'FW';
    const base = scheme === 'inc' ? num(row.incBase, row.outletHead && settings.inc.headPoints ? num(settings.inc.headPoints, 2) : num(row.base, 1)) : num(row.base, 1);
    const share = isFW ? (scheme === 'inc' ? num(settings.inc.fwShare, 1) : num(settings.fwShare, 0.25)) : 1;
    const companyShare = isFW && scheme === 'sc' ? num(settings.companyShare, 0.75) : 0;
    const upl = num(row.upl) + (settings.absentCountsAsUPL ? num(row.absent) : 0);
    const late = num(row.lateDays);
    const mc = num(row.mc);
    const notEmp = scheme === 'inc' && row.incNotEmployed !== undefined && row.incNotEmployed !== null ? num(row.incNotEmployed) : num(row.notEmployed);
    return { DaysInMonth: dim, NotEmployed: notEmp, EligibleDays: dim - notEmp, MC: mc, UPL: upl, Late: late, DeductDays: mc + upl + late, Base: base, Share: share, CompanyShare: companyShare };
  }

  function num(v, d = 0) { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : d; }

  // "Precision as displayed" (the stakeholder workbooks have it switched on): every stored cell value is
  // rounded to its displayed 2 decimals before other cells use it.
  function evalF(settings, id, vars) {
    const x = evaluate(parse(settings.formulas[id] || DEFAULT_FORMULAS[id].expr), vars);
    return settings.precisionAsDisplayed === false ? x : xlRound(x, 2);
  }

  // Stage 1: K, L, M, N, pool points (independent of point value)
  function computeRowPoints(row, scheme, settings, dim) {
    const v = rowInputs(row, scheme, settings, dim);
    const ov = (scheme === 'inc' ? row.incOverrides : row.overrides) || {};
    v.PointEntitlement = ov.K !== undefined && ov.K !== '' ? num(ov.K) : evalF(settings, 'entitlement', v);
    v.DaysWorked = ov.L !== undefined && ov.L !== '' ? num(ov.L) : evalF(settings, 'daysWorked', v);
    v.Points = ov.M !== undefined && ov.M !== '' ? num(ov.M) : evalF(settings, 'points', v);
    v.ReservedPoints = v.CompanyShare ? (ov.N !== undefined && ov.N !== '' ? num(ov.N) : evalF(settings, 'reserved', v)) : 0;
    v.PoolPoints = ov.poolPts !== undefined && ov.poolPts !== '' ? num(ov.poolPts) : evalF(settings, 'poolPoints', v);
    const waive = scheme === 'inc' && row.incWaiveTier !== undefined ? row.incWaiveTier : row.waiveTier;
    const tier = waive ? null : tierFor(v.DeductDays, settings);
    v.TierPct = tier ? tier.pct : 0;
    v.tier = tier;
    return v;
  }

  // Stage 2: money allocation once the point value is known.
  // returns {vars, alloc:{entitled, mia, deduction, fwCompany, pool}, kind:{entitled:'entitledNormal'|...}}
  function allocateRow(row, v, pv, scheme, settings) {
    v.PointValue = pv;
    v.PoolAmount = evalF(settings, 'poolAmount', v);
    const a = { entitled: 0, mia: 0, deduction: 0, fwCompany: 0, pool: v.PoolAmount, topUp: 0 };
    const f = { entitled: null, mia: null, deduction: null, fwCompany: null, pool: 'poolAmount' };
    const isFW = row.category === 'FW';
    if (isFW && v.CompanyShare) { a.fwCompany = evalF(settings, 'fwCompany', v); f.fwCompany = 'fwCompany'; }
    const exitType = scheme === 'inc' && row.incExitType !== undefined ? row.incExitType : row.exitType;
    if (exitType === 'MIA') { a.mia = evalF(settings, 'mia', v); f.mia = 'mia'; }
    else if (exitType === 'ROLLBACK') { a.deduction = evalF(settings, 'deductionFull', v); f.deduction = 'deductionFull'; }
    else if (v.TierPct >= 1) { a.deduction = evalF(settings, 'deductionFull', v); f.deduction = 'deductionFull'; }
    else if (v.TierPct > 0) {
      a.entitled = evalF(settings, 'entitledTier', { ...v, PointEntitlement: v.PointEntitlement * v.Share }); f.entitled = 'entitledTier';
      a.deduction = evalF(settings, 'deductionTier', { ...v, PointEntitlement: v.PointEntitlement * v.Share }); f.deduction = 'deductionTier';
    } else { a.entitled = evalF(settings, 'entitledNormal', v); f.entitled = 'entitledNormal'; }
    const ov = (scheme === 'inc' ? row.incOverrides : row.overrides) || {};
    for (const k of ['entitled', 'mia', 'deduction', 'fwCompany', 'pool']) if (ov[k] !== undefined && ov[k] !== '') { a[k] = num(ov[k]); f[k] = 'override'; }
    const min = scheme === 'inc' ? settings.inc : settings.sc;
    if (min.minMode === 'staff' && row.category !== 'FW' && row.category !== 'MGMT' && !exitType) {
      a.topUp = evaluate(parse(settings.formulas.staffTopUp), { Entitled: a.entitled, MinimumPayout: num(min.minValue) });
    }
    return { alloc: a, fx: f };
  }

  // Compute a whole outlet for one scheme ('sc' | 'inc').
  function computeOutlet(outlet, scheme, settings, dim, ctx) {
    const rows = includedRows(outlet, scheme);
    const pts = rows.map((r) => computeRowPoints(r, scheme, settings, dim));
    const totalPoints = round6(pts.reduce((s, v) => s + v.PointEntitlement, 0));
    const fixedRows = scheme === 'sc' ? (outlet.fixedRows || []) : [];
    const fixedAllowance = fixedRows.reduce((s, r) => s + num(r.amount), 0);
    let summary;
    if (scheme === 'sc') {
      const S = { Collected: num(outlet.scCollected), DistributePct: num(outlet.distributePct, num(settings.sc.distributePct)), CKPct: num(outlet.ckPct, num(settings.sc.ckPct)), FixedAllowance: fixedAllowance, TotalPoints: totalPoints,
        MinPointValue: settings.sc.minMode === 'point' ? num(settings.sc.minValue) : 0 };
      if (outlet.kind === 'central') {
        // Central Kitchen is funded by the CK/HQ % of the other outlets
        S.sources = (outlet.ckSources || []).map((src) => {
          const live = ctx && ctx.ckAmounts && ctx.ckAmounts[String(src.outlet).toLowerCase()];
          return { outlet: src.outlet, amount: live !== undefined ? live : num(src.amount), live: live !== undefined };
        });
        S.Collected = 0; S.Distributable = 0; S.CKDeduction = 0;
        S.Nett = xlRound(S.sources.reduce((a, b) => a + b.amount, 0) - fixedAllowance, 2);
      } else {
        S.Distributable = evalF(settings, 'distributable', S);
        S.CKDeduction = evalF(settings, 'ckDeduction', S);
        S.Nett = evalF(settings, 'nett', S);
      }
      S.PointValue = totalPoints ? evalF(settings, 'pointValue', S) : 0;
      S.CompanyTopUp = totalPoints ? evalF(settings, 'companyTopUp', S) : 0;
      summary = S;
    } else {
      const S = { NetSales: num(outlet.netSales), IncentivePct: num(outlet.incPct, num(settings.inc.pct)), TotalPoints: totalPoints, MinPointValue: settings.inc.minMode === 'point' ? num(settings.inc.minValue) : 0 };
      S.IncentiveTotal = evalF(settings, 'incentiveTotal', S);
      S.Nett = S.IncentiveTotal;
      S.PointValue = totalPoints ? evalF(settings, 'incPointValue', S) : 0;
      S.CompanyTopUp = Math.max(0, S.PointValue * totalPoints - S.Nett);
      summary = S;
    }
    const out = rows.map((r, i) => ({ row: r, vars: pts[i], ...allocateRow(r, pts[i], summary.PointValue, scheme, settings) }));
    const tot = (k) => round6(out.reduce((s, o) => s + o.alloc[k], 0));
    const totals = {
      points: round6(pts.reduce((s, v) => s + v.Points, 0)), reserved: round6(pts.reduce((s, v) => s + v.ReservedPoints, 0)),
      poolPoints: round6(pts.reduce((s, v) => s + v.PoolPoints, 0)), entitled: tot('entitled'), mia: tot('mia'), deduction: tot('deduction'),
      fwCompany: tot('fwCompany'), pool: tot('pool'), topUp: tot('topUp'), fixed: fixedAllowance,
    };
    totals.rollback = round6(totals.mia + totals.deduction + totals.fwCompany);
    totals.grand = round6(totals.entitled + totals.rollback + totals.pool);
    totals.variance = round6(summary.Nett - totals.grand);
    return { rows: out, summary, totals };
  }

  // Compute every outlet; Central Kitchen last so it can use the other outlets' CK/HQ amounts.
  function computeWorkspace(ws, settings) {
    const dim = ws.daysInMonth;
    const res = {}; const ckAmounts = {};
    const order = [...ws.outlets].sort((a, b) => (a.kind === 'central') - (b.kind === 'central'));
    for (const o of order) {
      res[o.id] = {};
      if (o.scEnabled !== false) {
        res[o.id].sc = computeOutlet(o, 'sc', settings, dim, { ckAmounts });
        if (o.kind !== 'central' && num(o.scCollected) > 0) ckAmounts[o.sheetName.toLowerCase()] = res[o.id].sc.summary.CKDeduction;
      }
      if (o.incEnabled) res[o.id].inc = computeOutlet(o, 'inc', settings, dim, { ckAmounts });
    }
    return res;
  }

  function includedRows(outlet, scheme) {
    return (outlet.employees || []).filter((r) => {
      if (r.include === false) return false;
      if (scheme === 'inc') return r.inIncentive !== false && !(r.category === 'MGMT');
      return r.inSC !== false;
    });
  }

  const round6 = (x) => Math.round(x * 1e6) / 1e6;

  // ------------------------------------------------------------------ remarks + row styling
  function autoRemark(row, settings, v) {
    const parts = [];
    if (row.isNew) parts.push('New.');
    if (row.fromOutlet) parts.push(row.helperNote || `From ${row.fromOutlet}.`);
    const leave = [];
    if (num(row.mc)) leave.push(`MC: ${num(row.mc)}`);
    const upl = num(row.upl) + (settings.absentCountsAsUPL ? num(row.absent) : 0);
    if (upl) leave.push(`UPL: ${upl}`);
    if (num(row.lateDays)) leave.push(`Lateness: ${num(row.lateDays)}`);
    if (leave.length) parts.push(leave.join(', '));
    if (v && v.tier && v.tier.pct > 0) parts.push(`${v.tier.label}: ${v.tier.text}`);
    if (row.exitType === 'MIA') parts.push('Absconded / short notice.');
    if (row.exitType === 'RESIGN_FULL') parts.push('Resign with full notice.');
    if (row.extraRemark) parts.push(row.extraRemark);
    return parts.join('\n');
  }

  function rowStyle(row, v, settings) {
    const c = settings.colors;
    let fill = null;
    if (row.category === 'MGMT') fill = c.MGMT;
    else if (row.fromOutlet) fill = c.HELPER;
    else if (row.rasa) fill = c.RASA;
    else if (row.category === 'FW') fill = c.FW;
    else if (row.category === 'CASUAL') fill = c.CASUAL;
    else if (row.outletHead) fill = c.HEAD;
    if (v && v.TierPct > 0 && row.category !== 'MGMT') fill = c.DEDUCT;
    let font = c.fontNormal;
    if (row.exitType || row.resignDate) font = c.fontLeaving;
    else if (row.isNew) font = c.fontNew;
    return { fill, font };
  }

  // ------------------------------------------------------------------ name matching
  const STOP = new Set(['BIN', 'BINTI', 'BT', 'BTE', 'A/L', 'A/P', 'AL', 'AP', 'B', '@', 'MOHD', 'MUHAMMAD', 'MOHAMAD', 'MOHAMMAD', 'MD', 'NIK', 'SITI']);
  function nameTokens(name) {
    return String(name || '').toUpperCase().replace(/\(.*?\)/g, ' ').replace(/[^A-Z0-9/@ ]/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t));
  }
  function nameScore(a, b) {
    const A = nameTokens(a), B = nameTokens(b);
    if (!A.length || !B.length) return 0;
    const setB = new Set(B);
    let hit = 0; for (const t of A) if (setB.has(t) || B.some((x) => x.length > 3 && t.length > 3 && (x.startsWith(t) || t.startsWith(x)))) hit++;
    const small = Math.min(A.length, B.length);
    return hit / Math.max(small, 1) * (0.75 + 0.25 * small / Math.max(A.length, B.length));
  }
  function normId(id) {
    const m = /^([A-Z]+)0*(\d+)$/i.exec(String(id || '').replace(/\s/g, ''));
    return m ? m[1].toUpperCase() + Number(m[2]) : String(id || '').toUpperCase();
  }
  // Match attendance records to master rows. Returns [{att, row, score}] (row null = new staff)
  function matchAttendance(records, rows) {
    const used = new Set();
    const res = [];
    const cands = [];
    const forced = new Map();
    records.forEach((rec, i) => {
      if (rec.forceRowId) { const j = rows.findIndex((r) => r.id === rec.forceRowId); if (j >= 0) { forced.set(i, { i, j, s: 9 }); used.add(j); } }
      else if (rec.forceNew) forced.set(i, null);
    });
    records.forEach((rec, i) => !forced.has(i) && rows.forEach((row, j) => {
      let s = nameScore(rec.name, row.name);
      if (rec.employeeId && row.empNo && normId(rec.employeeId) === normId(row.empNo)) s += 0.5;
      if (rec.employeeId && row.attendanceId && String(rec.employeeId).trim() === String(row.attendanceId).trim()) s += 1;
      if (s >= 0.6) cands.push({ i, j, s });
    }));
    cands.sort((x, y) => y.s - x.s);
    const recDone = new Map([...forced].filter(([, v]) => v));
    for (const [i, v] of forced) if (!v) recDone.set(i, null);
    for (const c of cands) { if (recDone.has(c.i) || used.has(c.j)) continue; recDone.set(c.i, c); used.add(c.j); }
    records.forEach((rec, i) => { const c = recDone.get(i); res.push({ att: rec, row: c ? rows[c.j] : null, score: c ? c.s : 0 }); });
    return res;
  }

  function deptFromAttendance(d) {
    const x = String(d || '').toUpperCase();
    if (x.includes('KITCHEN') || /CHEF|COOK|WOK|CUTTER/.test(x)) return 'KITCHEN';
    if (x.includes('SERVICE') || /WAIT|CAPTAIN|CASHIER|BAR/.test(x)) return 'SERVICE';
    return x.trim();
  }
  const FW_PREFIX = { NHL: 'AGENT NHL', KHM: 'AGENT KHM', TFH: 'AGENT TFH', KCS: 'AGENT KCS', SS: 'AGENT SS', SMS: 'AGENT SMS', ED: 'EDISIJUTA' };
  function statusFromAttendance(d, empId) {
    const pre = (/^([A-Z]+)\d/i.exec(String(empId || '').trim()) || [])[1];
    if (pre && FW_PREFIX[pre.toUpperCase()]) return { status: FW_PREFIX[pre.toUpperCase()], category: 'FW' };
    if (pre && pre.toUpperCase() === 'CL') return { status: 'CASUAL LABOUR', category: 'CASUAL' };
    const x = String(d || '').toUpperCase().trim();
    if (/^(ADMIN|DRIVER|CHEF|COOK|CASHIER|WAITER|WAITRESS|CAPTAIN|BAR|MANAGER|SUPERVISOR|STEWARD)/.test(x)) return { status: 'PERMANENT', category: 'PERM' };
    if (/^(FT|PT)?\s*(SERVICE|KITCHEN)$/.test(x) || x.startsWith('FT ')) return { status: 'PERMANENT', category: 'PERM' };
    if (x.includes('CASUAL')) return { status: 'CASUAL LABOUR', category: 'CASUAL' };
    if (x) return { status: 'AGENT ' + x, category: 'FW' };
    return { status: 'PERMANENT', category: 'PERM' };
  }

  // ------------------------------------------------------------------ apply AI attendance to an outlet
  const OUTLET_HINTS = [[/PAVILION\s*K\.?L|PKL/i, 'PKL'], [/BUKIT\s*JALIL|PBJ/i, 'PBJ'], [/INTERMARK|\bINT\b/i, 'INT'], [/KLIA\s*2/i, 'KLIA 2'], [/KLIA\s*1|KLIA/i, 'KLIA 1'],
    [/GENTING|GENT/i, 'GENTING'], [/CENTRAL\s*KITCHEN|\bCK\b/i, 'CK']];
  function helperOutlet(notes, ownCode) {
    if (!/staff|help|from/i.test(notes || '')) return '';
    for (const [re, code] of OUTLET_HINTS) if (re.test(notes) && code.toUpperCase() !== String(ownCode || '').toUpperCase()) return code;
    return '';
  }

  // ------------------------------------------------------------------ staff memory ("directory")
  // Remembers what HR typed (position, join date, status, points…) so next month's attendance is pre-filled.
  const PROFILE = ['dept', 'empNo', 'name', 'position', 'joinDate', 'resignDate', 'status', 'category', 'base', 'incBase', 'rasa', 'outletHead', 'fromOutlet', 'keepWithoutAttendance', 'inIncentive'];
  const dirKey = (r) => (r.empNo && /\d/.test(r.empNo) ? 'id:' + normId(r.empNo) : 'nm:' + nameTokens(r.name).sort().join(' '));
  function rememberOutlet(dir, outlet) {
    for (const r of outlet.employees || []) {
      if (!r.name || r.name === 'NEW STAFF' || r.name === 'HQ MANAGER') continue;
      const prof = { outlet: outlet.sheetName, updated: Date.now() };
      if (r.category === 'MGMT') prof.keepWithoutAttendance = true;
      PROFILE.forEach((k) => { if (r[k] !== undefined && r[k] !== '') prof[k] = r[k]; });
      dir[dirKey(r)] = prof;
    }
    return dir;
  }
  function lookupDirectory(dir, rec) {
    if (!dir) return null;
    if (rec.employeeId && /\d/.test(rec.employeeId) && dir['id:' + normId(rec.employeeId)]) return dir['id:' + normId(rec.employeeId)];
    const k = 'nm:' + nameTokens(rec.name).sort().join(' ');
    if (dir[k]) return dir[k];
    let best = null, bs = 0;
    for (const p of Object.values(dir)) { const sc = nameScore(rec.name, p.name); if (sc > bs) { bs = sc; best = p; } }
    return bs >= 0.95 ? best : null;
  }

  // Build an outlet's staff list straight from the attendance file (no last-month workbook needed).
  function buildOutletFromAttendance(outlet, records, settings, dim, dir, month) {
    const keep = Object.values(dir || {}).filter((p) => p.keepWithoutAttendance && p.outlet === outlet.sheetName);
    outlet.employees = keep.map((p) => newRow({ ...p, include: true, remembered: true }));
    return applyAttendance(outlet, records, settings, dim, { createAll: true, dir, month });
  }
  function newRow(f) {
    return { id: 'r' + Math.random().toString(36).slice(2, 9), dept: '', empNo: '', name: '', position: '', joinDate: '', resignDate: '', status: 'PERMANENT', category: 'PERM', base: 1,
      rasa: false, outletHead: false, fromOutlet: '', helperNote: '', isNew: false, exitType: '', waiveTier: false, mc: 0, upl: 0, absent: 0, lateDays: 0, notEmployed: 0,
      overrides: {}, incOverrides: {}, extraRemark: '', include: true, flags: [], ...f };
  }

  function applyAttendance(outlet, records, settings, dim, opts = {}) {
    const rows = outlet.employees;
    const report = { matched: [], added: [], blank: [], missing: [], mismatches: [] };
    const matches = matchAttendance(records, rows);
    const touched = new Set();
    for (const m of matches) {
      const rec = m.att;
      const s = summariseDays(rec.days, settings, dim);
      if (s.allBlank) { report.blank.push(rec.name); if (m.row) { m.row.include = false; m.row.flags = ['Attendance blank – not recorded']; touched.add(m.row); } continue; }
      let row = m.row;
      if (!row) {
        const st = statusFromAttendance(rec.department, rec.employeeId);
        const dept = deptFromAttendance(rec.department);
        const known = opts.createAll ? lookupDirectory(opts.dir, rec) : null;
        const rawDept = String(rec.department || '').toUpperCase().trim();
        row = newRow({ dept, empNo: rec.employeeId || '', attendanceId: rec.employeeId || '', name: rec.name,
          position: /^(ADMIN|DRIVER|CHEF|COOK|CASHIER|WAITER|WAITRESS|CAPTAIN|SUPERVISOR)$/.test(rawDept) ? rawDept : '', status: st.status, category: st.category, rasa: /^RG\d/i.test(rec.employeeId || ''),
          fromOutlet: helperOutlet(rec.notes, outlet.code), addedFromAttendance: true });
        if (known) { PROFILE.forEach((k) => { if (known[k] !== undefined && k !== 'keepWithoutAttendance') row[k] = known[k]; }); row.remembered = true; }
        if (row.fromOutlet) row.helperNote = `Helping from ${row.fromOutlet}`;
        // createAll: the attendance file IS the staff list. Otherwise (matching to an existing list) new names wait for HR.
        row.include = opts.createAll ? !row.fromOutlet : false;
        // staff who start / leave during the month (NOTEMP days at the start / end)
        const firstEmp = rec.days.findIndex((d) => String(d.code).toUpperCase() !== 'NOTEMP');
        const lastEmp = dim - 1 - [...rec.days].reverse().findIndex((d) => String(d.code).toUpperCase() !== 'NOTEMP');
        if (!row.joinDate && firstEmp > 0 && opts.month) { row.joinDate = `${opts.month}-${String(firstEmp + 1).padStart(2, '0')}`; row.isNew = true; row.joinEstimated = true; }
        if (!row.resignDate && lastEmp < dim - 1 && lastEmp >= 0 && /resign|last day/i.test(rec.notes || '') && opts.month) { row.resignDate = `${opts.month}-${String(lastEmp + 1).padStart(2, '0')}`; }
        rows.push(row); report.added.push(rec.name);
      } else report.matched.push({ att: rec.name, row: row.name, score: Math.round(m.score * 100) / 100 });
      touched.add(row);
      const lateDays = settings.lateCountPerDay > 0 ? Math.floor(s.late / settings.lateCountPerDay) : 0;
      // keep the template's hand-keyed numbers only while the attendance agrees with them
      const t = row.template || {};
      Object.assign(row, { mc: s.MC, upl: s.UPL, absent: s.ABSENT, notEmployed: s.NOTEMP, lateDays, lateCount: s.late, include: row.addedFromAttendance ? row.include : true });
      const uplTotal = s.UPL + (settings.absentCountsAsUPL ? s.ABSENT : 0);
      if (t.ne !== row.notEmployed) { delete row.overrides.K; if (row.incOverrides) delete row.incOverrides.K; row.incNotEmployed = undefined; }
      if (t.ne !== row.notEmployed || t.mc !== row.mc || t.upl !== uplTotal || (t.late || 0) !== lateDays) {
        for (const k of ['L', 'M', 'N', 'poolPts']) { delete row.overrides[k]; if (row.incOverrides) delete row.incOverrides[k]; }
        if (row.waiveTier && !/appeal|approved/i.test((row.template && row.template.remarks) || '')) row.waiveTier = false;
      }
      const flags = [];
      if (row.addedFromAttendance && row.fromOutlet) flags.push(`Staff of ${row.fromOutlet} helping here (${s.worked} days) – not given points; add to "Fixed SC approved by COO" or tick Include`);
      else if (row.addedFromAttendance && !opts.createAll) flags.push('Not in the staff list – tick Include if new joiner, then fill position, status, join date');
      if (row.joinEstimated) flags.push(`Join date estimated from the log (first day ${row.joinDate.slice(8)}) – please confirm`);
      if (opts.createAll && !row.remembered && row.category !== 'FW') row.info = 'New to this tool – fill position / join date once; it is remembered next month';
      if (s.ABSENT) flags.push(`${s.ABSENT} day(s) with no punch and no code (${s.absentDays.join(', ')}) counted as absent`);
      if (s.REVIEW) flags.push(`Unknown code on day(s) ${s.reviewDays.join(', ')}`);
      const ht = String(rec.handwrittenTotal || '').replace(/[()\s]/g, '');
      if (/^-?\d+$/.test(ht)) {
        const n = Number(ht); const ded = s.MC + s.UPL + s.ABSENT;
        const expect = n <= 0 ? -n : dim - n;
        if (expect !== ded && !(n > 0 && n === dim - s.NOTEMP - ded)) { flags.push(`Handwritten total "${rec.handwrittenTotal}" vs counted MC+UPL+absent = ${ded}`); report.mismatches.push(rec.name); }
      }
      row.flags = flags;
      row.attendance = { employeeId: rec.employeeId, name: rec.name, department: rec.department, days: rec.days, handwrittenTotal: rec.handwrittenTotal, notes: rec.notes, pages: rec.pages,
        counts: { worked: s.worked, OFF: s.OFF, AL: s.AL, PH: s.PH, nodeduct: s.nodeduct, MC: s.MC, UPL: s.UPL, ABSENT: s.ABSENT, NOTEMP: s.NOTEMP, late: s.late },
        codeString: rec.days.map((d) => d.code).join(' ') };
    }
    for (const r of rows) {
      if (touched.has(r)) continue;
      if (r.category === 'MGMT' || r.keepWithoutAttendance || r.remembered || (r.fromOutlet && !r.addedFromAttendance)) { r.flags = []; r.info = 'Not on this attendance file – kept (management / helper)'; continue; }
      r.include = false; r.flags = ['No attendance record found – not recorded']; report.missing.push(r.name);
    }
    return report;
  }

  const api = {
    parse, evaluate, toExcel, identifiers, render, substitute, xlRound, FUNCS, VARIABLES, DEFAULT_FORMULAS, DEFAULT_SETTINGS, DEFAULT_CODES,
    mergeSettings, deepClone, daysInMonth, tierFor, codeCategory, summariseDays, isLate, rowInputs, computeRowPoints, allocateRow,
    computeOutlet, computeWorkspace, includedRows, autoRemark, rowStyle, nameTokens, nameScore, normId, matchAttendance, deptFromAttendance, statusFromAttendance, num, applyAttendance, helperOutlet, buildOutletFromAttendance, rememberOutlet, lookupDirectory, newRow, dirKey,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GMM = root.GMM || {}; root.GMM.engine = api;
})(typeof window !== 'undefined' ? window : globalThis);
