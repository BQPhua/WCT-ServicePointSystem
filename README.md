# GMM Service Charge & Incentive Tool

Browser-only HR tool: upload the scanned attendance log (e.g. ATSB PDF), let an AI read it, review/edit, and download the
**Service Charge** and **Incentive** workbooks in the stakeholder's layout with live Excel formulas. No login, no server.

## Run it
Open `dist/GMM-ServiceCharge-Tool.html` in Chrome or Edge (double-click, or host it on any static site / SharePoint).
Everything (ExcelJS, pdf.js, JSZip) is inlined, so only the AI call needs internet. **Only the attendance file is needed** — no previous Excel.

1. **Attendance (AI)** – drop the scanned PDF/photos. Supported: "List of Logs" (many staff per page, printed sideways – auto-rotated) and
   "Daily Time Record" (one staff per page, printed Status + handwritten Remarks such as PH / AL / MC / TRN). Pick the AI model, add any
   external circumstances, click *Read attendance with AI*. Fix names / IDs in the table if needed. Save the extraction (.json) to reuse it.
2. **Outlet & entitlement** – tick the outlet, the month and year, and the entitlement: *Service charge* and/or *Incentive*
   (incentive only when the outlet hit its target). Enter service charge collected, net sales and the **incentive %** (default 1.5%, adjustable).
   The staff list is created from the attendance; blank attendance is not recorded. Scan the next outlet's file to add more outlets.
3. **Review & edit** – every input is editable; typed numbers override formulas (yellow). `?` buttons show each formula with that row's numbers,
   its Excel form, and *Edit this formula*. Add HQ management once (they are not on outlet attendance) – they are remembered.
4. **Export** – one Service Charge workbook (outlets with service charge ticked) and one Incentive workbook (outlets with incentive ticked).

**Staff memory:** positions, join dates, status, points and outlet that HR types are remembered in the browser and pre-filled next month
(Settings → Outlets & staff memory). The outlet list (company, Excel title, code, tab colour, central kitchen) is editable there too.

## AI models (Settings → AI, or the "AI model" picker on the Attendance step)
| Choice | Key | Notes |
|---|---|---|
| Gemini 3.8 Flash (default) | Google Gemini key | Best of the Gemini models on the current key. |
| Gemini 3.5 Flash | Google Gemini key | Default automatic fallback when 3.8 hits quota / errors. |
| Gemini 3.5 Flash Lite | Google Gemini key | Fastest / cheapest; weaker on handwriting. |
| Claude Sonnet / Opus / Haiku (newest) | Anthropic key | Resolves to the newest model of that family the key can use. |
| Custom | any | Any Gemini, Claude or OpenAI-compatible (OpenAI, OpenRouter, Groq) model id. |

Each provider keeps its own key, so switching never loses a key. If a model id isn't available for the key, the tool picks the
closest available one and says so. Gemini keys are sent as an API key and, if rejected, as a Bearer token.
The AI only reads the log; all counting and money is done by the deterministic engine.

## Rules implemented (derived from the stakeholder workbooks)
- K Point Entitlement = base (1; 0.5 some HQ mgmt; 2 outlet heads in incentive) prorated for days employed. Non-deductible leave (OFF/AL/PH…) never changes K.
- L Days Worked = days − not-employed − MC/HL − UPL − lateness (written as `=31-2`). M = `ROUND(L/L10,2)`; foreign workers ×0.25, N ×0.75 (company).
- Total days (MC/HL+UPL+Lateness): 1–3 prorate · 4–5 30% · 6–7 50% · 8+ 100%. Lost points → pool; rest of the tier → rolled back.
- Service point = (Collected×80% − 11% CK/HQ − fixed SC by COO) ÷ ΣK; Central Kitchen = Σ other outlets' 11%. Incentive point = 1.5% net sales ÷ ΣK (foreign workers full point).
- MIA / absconded / short notice → rolled back. Appeal approved by COO → "Waive tier". Blank attendance → not recorded.
- Minimum RM 450: default = minimum per service point (company top-up line). Switchable to "per staff" or off — **confirm with stakeholder**.
- Colours: orange mgmt · light green helping from other outlet · blue Rasa · green casual · red foreign worker · purple attendance deduction · light yellow outlet head; blue font new joiner, red font resigned/absconded.

## Verification (`tests/`)
- `node tests/compare_template.test.js` – engine re-computes all 8 SC tabs + 2 incentive tabs of the Aug-26 files: every point value identical, every staff amount within RM 0.01.
- `node tests/export.test.js` + LibreOffice recalc + `python3 tests/compare_recalc.py` – exported formulas recalculate to the stakeholder values (1,980 values, max difference 0.00).
- `node tests/attendance_e2e.test.js` – AI-style extraction → name matching → calculation reproduces the Genting tab.
- `fixtures/REFERENCE-central-kitchen-DTR-July2026-extraction.json` – my transcription of the Central Kitchen Daily Time Record scan (for testing / comparing the AI's reading).
- `python3 tests/ui_e2e.py`, `python3 tests/ui_ai_mock.py` – Playwright tests of the built HTML: Daily Time Record read by a mocked Gemini → Central Kitchen SC + 2% incentive; List of Logs → Genting SC; export + LibreOffice recalc; Gemini 3.8 → quota → 3.5 fallback; Claude run; AI review.
`fixtures/SAMPLE-genting-extraction-synthetic.json` is **synthetic** (built from the Excel), not a reading of the PDF.

## Code
`src/engine.js` formulas/rules, staff memory (pure, Node-testable) · `src/importer.js` reads stakeholder workbooks (tests only) · `src/exporter.js` writes them ·
`src/ai.js` PDF rendering + providers + prompts · `src/app.js` UI · `build.js` → single-file `dist/`.
Dev: `npm install` then open `index.html`; `node build.js` to rebuild.
