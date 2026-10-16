// Export the re-computed template month to xlsx; then run LibreOffice recalc and compare with stakeholder values.
const fs = require('fs'); const path = require('path');
const ExcelJS = require('exceljs'); const JSZip = require('jszip');
const E = require('../src/engine.js'); global.GMM = { engine: E };
const I = require('../src/importer.js'); const X = require('../src/exporter.js');
(async () => {
  const dir = path.join(__dirname, '../fixtures');
  const files = ['Service Charge - Aug26.xlsx', 'Incentive - Aug26.xlsx'].map((n) => ({ name: n, buffer: fs.readFileSync(path.join(dir, n)) }));
  const ws = await I.importWorkbooks(files, ExcelJS);
  const settings = E.mergeSettings();
  fs.mkdirSync(path.join(__dirname, '../out'), { recursive: true });
  for (const scheme of ['sc', 'inc']) {
    const wb = X.exportWorkbook(ws, scheme, settings, ExcelJS);
    const buf = await X.toBuffer(wb, settings, JSZip);
    const f = path.join(__dirname, `../out/${scheme === 'sc' ? 'Service Charge' : 'Incentive'} - regenerated.xlsx`);
    fs.writeFileSync(f, buf); console.log('wrote', f);
  }
})().catch((e) => { console.error(e); process.exit(1); });
