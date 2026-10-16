// extraction JSON -> merge pages -> match to master -> compute -> compare with the stakeholder Genting sheet
const fs = require('fs'); const path = require('path'); const ExcelJS = require('exceljs');
const E = require('../src/engine.js'); global.GMM = { engine: E }; const I = require('../src/importer.js'); const A = require('../src/ai.js');
(async () => {
  const dir = path.join(__dirname, '../fixtures');
  const ws = await I.importWorkbooks(['Service Charge - Aug26.xlsx', 'Incentive - Aug26.xlsx'].map((n) => ({ name: n, buffer: fs.readFileSync(path.join(dir, n)) })), ExcelJS);
  const fx = JSON.parse(fs.readFileSync(path.join(dir, 'SAMPLE-genting-extraction-synthetic.json')));
  const settings = E.mergeSettings();
  const g = ws.outlets.find((o) => o.sheetName === 'Genting');
  const before = E.computeWorkspace(ws, settings)[g.id].sc;
  // wipe attendance numbers so they must come from the extraction
  g.employees.forEach((r) => { if (r.category !== 'MGMT') Object.assign(r, { mc: 9, upl: 9, notEmployed: 0 }); });
  const recs = A.mergePages(fx.pages, ws.daysInMonth);
  const rep = E.applyAttendance(g, recs, settings, ws.daysInMonth);
  console.log('records', recs.length, 'matched', rep.matched.length, 'added', rep.added, 'blank', rep.blank, 'missing', rep.missing, 'handwritten mismatches', rep.mismatches);
  rep.matched.filter((m) => m.score < 1).forEach((m) => console.log('  fuzzy match', m));
  const after = E.computeWorkspace(ws, settings)[g.id].sc;
  let bad = 0;
  const key = (x) => x.row.id;
  const bm = new Map(before.rows.map((x) => [key(x), x]));
  for (const x of after.rows) {
    const b = bm.get(key(x)); if (!b) { console.log('  extra row', x.row.name); bad++; continue; }
    for (const k of ['entitled', 'mia', 'deduction', 'fwCompany', 'pool']) if (Math.abs(b.alloc[k] - x.alloc[k]) > 0.001) { console.log('  diff', x.row.name, k, b.alloc[k], x.alloc[k]); bad++; }
  }
  console.log('PV before', before.summary.PointValue, 'after', after.summary.PointValue, 'rows', before.rows.length, after.rows.length);
  console.log(bad ? `FAIL ${bad} differences` : 'PASS: attendance-driven Genting result equals the stakeholder sheet');
  process.exit(bad ? 1 : 0);
})();
