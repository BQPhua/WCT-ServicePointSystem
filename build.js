// Builds dist/GMM-ServiceCharge-Tool.html: one self-contained file (all libraries inlined, works offline except the AI call).
const fs = require('fs'); const path = require('path');
const rd = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const safe = (js) => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
let html = rd('index.html');
html = html.replace('<link rel="stylesheet" href="src/styles.css">', `<style>\n${rd('src/styles.css')}\n</style>`);
const vendor = ['vendor/exceljs.min.js', 'vendor/jszip.min.js', 'vendor/pdf.min.js'].map((f) => `<script>/* ${path.basename(f)} */\n${safe(rd(f))}\n</script>`).join('\n')
  + `\n<script type="text/plain" id="pdfWorkerSrc">${safe(rd('vendor/pdf.worker.min.js'))}</script>`;
const app = ['src/engine.js', 'src/exporter.js', 'src/ai.js', 'src/app.js'].map((f) => `<script>/* ${f} */\n${safe(rd(f))}\n</script>`).join('\n');
html = html.replace(/<!--VENDOR-->[\s\S]*<!--\/VENDOR-->/, () => vendor).replace(/<!--APP-->[\s\S]*<!--\/APP-->/, () => app);
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist/GMM-ServiceCharge-Tool.html'), html);
console.log('dist/GMM-ServiceCharge-Tool.html', (html.length / 1024 / 1024).toFixed(2), 'MB');
