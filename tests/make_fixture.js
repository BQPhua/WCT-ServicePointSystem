// Builds a synthetic AI-extraction JSON for Genting (as the AI would return it page by page) from the
// stakeholder's August Genting sheet, using PDF-style names/IDs. Used to test matching -> calculation -> Excel.
const fs = require('fs'); const path = require('path'); const ExcelJS = require('exceljs');
const E = require('../src/engine.js'); global.GMM = { engine: E }; const I = require('../src/importer.js');
(async () => {
  const dir = path.join(__dirname, '../fixtures');
  const ws = await I.importWorkbooks([{ name: 'Service Charge - Aug26.xlsx', buffer: fs.readFileSync(path.join(dir, 'Service Charge - Aug26.xlsx')) }], ExcelJS);
  const g = ws.outlets.find((o) => o.sheetName === 'Genting'); const dim = ws.daysInMonth;
  const emps = [];
  g.employees.filter((r) => r.category !== 'MGMT').forEach((r, idx) => {
    const t = r.template; const days = [];
    const ne = r.notEmployed; let mc = t.mc, upl = t.upl;
    for (let d = 1; d <= dim; d++) {
      if (d <= ne) days.push('NOTEMP');
      else if ((d + idx) % 7 === 0) days.push('OFF');
      else if (mc > 0 && d >= 20) { days.push(r.name.includes('FAEZ') && mc < 5 ? 'HL' : 'MC'); mc--; }
      else if (upl > 0 && d >= 10) { days.push('UPL'); upl--; }
      else days.push(`W|${String(8 + (d % 3)).padStart(2, '0')}:${String(10 + d).padStart(2, '0')}`);
    }
    const pdfName = r.name.replace(/\b(BIN|BINTI)\b/g, '').replace(/\s+/g, ' ').trim();
    emps.push({ employee_id: r.empNo.replace(/^AT0+/, 'AT0'), name: idx === 3 ? pdfName.split(' ').slice(0, 3).join(' ') : pdfName, department: r.category === 'FW' ? r.status.replace('AGENT ', '') : `FT ${r.dept}`, handwritten_total: String(-(t.mc + t.upl) || dim), notes: '', days });
  });
  // a blank employee, and a helper from Pavilion KL (both appear on the real ATSB printout)
  emps.push({ employee_id: '2130', name: 'BEH BART SIUNG', department: 'FT KITCHEN', notes: '', days: Array(dim).fill('BLANK') });
  emps.push({ employee_id: '2173', name: 'CANDY LEE XIN YEE', department: 'FT SERVICE', notes: 'PAVILION KL STAFF', days: Array.from({ length: dim }, (_, i) => (i >= 19 && i <= 25 ? 'W|11:58' : 'NOTEMP')) });
  // split into pages of 5; the 3rd employee's grid continues on the next page
  const pages = []; for (let i = 0; i < emps.length; i += 5) pages.push({ page: pages.length + 1, employees: emps.slice(i, i + 5).map((e) => ({ ...e })) });
  const lastP1 = pages[0].employees[4];
  pages[0].employees[4] = { ...lastP1, grid_on_next_page: true, days: Array(dim).fill('BLANK') };
  pages[1].employees.unshift({ name: '', continued_from_previous_page: true, days: lastP1.days });
  fs.writeFileSync(path.join(dir, 'SAMPLE-genting-extraction-synthetic.json'), JSON.stringify({ outlet: 'Genting', month: ws.month, daysInMonth: dim, pages }, null, 1));
  console.log('fixture pages', pages.length, 'employees', emps.length);
})();
