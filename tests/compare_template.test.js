// Re-computes every outlet of the stakeholder August workbooks with the engine and compares
// against the cached values in the stakeholder files. Run: node tests/compare_template.test.js
const fs = require('fs'); const path = require('path');
const ExcelJS = require('exceljs');
const E = require('../src/engine.js'); global.GMM = { engine: E };
const I = require('../src/importer.js');

(async () => {
  const dir = path.join(__dirname, '../fixtures');
  const files = ['Service Charge - Aug26.xlsx', 'Incentive - Aug26.xlsx'].map((n) => ({ name: n, buffer: fs.readFileSync(path.join(dir, n)) }));
  const ws = await I.importWorkbooks(files, ExcelJS);
  const settings = E.mergeSettings();
  console.log(ws.notes.join('\n'));
  console.log('month', ws.month, 'days', ws.daysInMonth);
  let worst = 0; const issues = [];
  const all = E.computeWorkspace(ws, settings);
  for (const o of ws.outlets) {
    for (const scheme of ['sc', 'inc']) {
      if (scheme === 'sc' && !o.scEnabled) continue;
      if (scheme === 'inc' && !o.incEnabled) continue;
      const res = all[o.id][scheme];
      const tpv = scheme === 'sc' ? o.templatePointValue : o.templateIncPointValue;
      console.log(`\n== ${o.sheetName} [${scheme}] rows=${res.rows.length} PV=${res.summary.PointValue.toFixed(4)} template=${tpv} totalK=${res.summary.TotalPoints} variance=${res.totals.variance.toFixed(2)}`);
      for (const r of res.rows) {
        const t = scheme === 'inc' ? (r.row.incTemplate || r.row.template) : r.row.template; if (scheme === 'inc' && r.row.inSC !== false && o.scEnabled) { /* inc template amounts are on inc rows only */ }
        const am = t.amounts;
        const tEnt = (am.mgmt || 0) + (am.perm || 0) + (am.casual || 0) + (am.fw || 0);
        const tRb = (am.mia || 0) + (am.deduction || 0) + (am.miaFW || 0) + (am.fw075 || 0);
        const dK = Math.abs(r.vars.PointEntitlement - t.K);
        const dEnt = Math.abs(r.alloc.entitled - tEnt), dRb = Math.abs(r.alloc.mia + r.alloc.deduction + r.alloc.fwCompany - tRb), dPool = Math.abs(r.alloc.pool - (am.pool || 0));
        const d = Math.max(dEnt, dRb, dPool);
        if (d > 0.05 || dK > 0.001) issues.push(`${o.sheetName}[${scheme}] ${r.row.name.slice(0, 28).padEnd(28)} K ${r.vars.PointEntitlement}/${t.K}  ent ${r.alloc.entitled.toFixed(2)}/${tEnt.toFixed(2)}  rb ${(r.alloc.mia + r.alloc.deduction + r.alloc.fwCompany).toFixed(2)}/${tRb.toFixed(2)}  pool ${r.alloc.pool.toFixed(2)}/${(am.pool || 0).toFixed(2)}`);
        worst = Math.max(worst, d);
      }
    }
  }
  console.log('\nRow differences > RM0.05 (engine/template):\n' + issues.join('\n'));
  console.log('\nmax abs diff', worst.toFixed(2));
})();
