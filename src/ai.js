/* AI attendance extraction + review.
 * Providers: Google Gemini (free tier), any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, …), Anthropic Claude.
 * The AI only READS the scanned attendance log (day-by-day codes and notes). All counting and money
 * calculations are done by the deterministic engine, so results are repeatable and auditable.
 */
(function (root) {
  'use strict';
  const E = (root.GMM && root.GMM.engine) || (typeof require !== 'undefined' ? require('./engine.js') : null);

  const PROVIDERS = {
    gemini: { label: 'Google Gemini (free tier available)', defaultModel: 'gemini-3.8-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyUrl: 'https://aistudio.google.com/apikey' },
    openai: { label: 'OpenAI-compatible (OpenAI, OpenRouter, Groq…)', defaultModel: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
    anthropic: { label: 'Anthropic Claude', defaultModel: 'claude-sonnet-4-5', baseUrl: 'https://api.anthropic.com/v1', keyUrl: 'https://console.anthropic.com/settings/keys' },
  };

  // Ready-made choices shown in the model picker. Gemini IDs are the ones listed for the stakeholder's key;
  // Claude entries resolve to the newest model of that family the key can use (via the /models list).
  const MODEL_PRESETS = [
    { id: 'gemini-3.8-flash', provider: 'gemini', model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', note: 'Newest Flash – best accuracy of the Gemini options (recommended)' },
    { id: 'gemini-3.5-flash', provider: 'gemini', model: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', note: 'Good accuracy, separate quota – useful as fallback' },
    { id: 'gemini-3.5-flash-lite', provider: 'gemini', model: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', note: 'Fastest / cheapest; may misread handwriting' },
    { id: 'claude-sonnet', provider: 'anthropic', model: 'claude-sonnet-latest', label: 'Claude Sonnet (newest)', note: 'Strong at tables + handwriting; paid Anthropic key' },
    { id: 'claude-opus', provider: 'anthropic', model: 'claude-opus-latest', label: 'Claude Opus (newest)', note: 'Most capable Claude, slower and pricier' },
    { id: 'claude-haiku', provider: 'anthropic', model: 'claude-haiku-latest', label: 'Claude Haiku (newest)', note: 'Fast, low cost Claude' },
    { id: 'custom', provider: null, model: null, label: 'Custom (choose provider + type model)', note: 'Any Gemini, Claude or OpenAI-compatible model' },
  ];
  const presetById = (id) => MODEL_PRESETS.find((p) => p.id === id);
  // Each provider keeps its own key, so switching models never loses a key.
  function keyFor(ai, provider = ai.provider) { return (ai.keys && ai.keys[provider]) || (provider === ai.provider ? ai.apiKey : '') || ''; }
  function withPreset(settings, presetId) {
    const p = presetById(presetId);
    if (!p || p.id === 'custom') return settings;
    return { ...settings, ai: { ...settings.ai, preset: p.id, provider: p.provider, model: p.model, baseUrl: '' } };
  }
  function currentLabel(ai) {
    const p = presetById(ai.preset);
    return p && p.id !== 'custom' ? p.label : `${(PROVIDERS[ai.provider] || PROVIDERS.gemini).label.split(' (')[0]} · ${ai.model}`;
  }

  // ------------------------------------------------------------------ PDF -> page images (pdf.js)
  async function renderPdf(arrayBuffer, pdfjsLib, opts = {}) {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const vp0 = page.getViewport({ scale: 1 });
      let rot = 0;
      if (opts.rotate === 'auto' || opts.rotate === undefined) rot = (await pageLooksSideways(page, vp0)) ? 270 : 0;
      else rot = Number(opts.rotate) || 0;
      const vpR = page.getViewport({ scale: 1, rotation: (page.rotate + rot) % 360 });
      const scale = (opts.maxSide || 2200) / Math.max(vpR.width, vpR.height);
      const vp = page.getViewport({ scale, rotation: (page.rotate + rot) % 360 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      pages.push({ n: i, dataUrl: canvas.toDataURL('image/jpeg', 0.85), width: canvas.width, height: canvas.height, rotation: rot });
    }
    return pages;
  }

  // Auto-rotate: text lines on an upright page make the ink vary much more from row to row than from
  // column to column; on a page printed sideways it is the other way round. (Checked on both the
  // "List of Logs" printouts, which are sideways, and the "Daily Time Record" pages, which are upright.)
  function inkProfileSideways(ctx, w, h) {
    const data = ctx.getImageData(0, 0, w, h).data;
    const rows = new Float64Array(h), cols = new Float64Array(w);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4; const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (g < 150) { rows[y]++; cols[x]++; }
    }
    const nv = (a) => { const m = a.reduce((s, v) => s + v, 0) / a.length; if (!m) return 0; return a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length / (m * m); };
    return nv(cols) > nv(rows) * 1.15;
  }
  async function pageLooksSideways(page, vp0) {
    const scale = 420 / Math.max(vp0.width, vp0.height);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return inkProfileSideways(ctx, c.width, c.height);
  }

  async function imageFileToPage(file, n, rotate) {
    const url = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
    let rot = Number(rotate === 'auto' ? 0 : rotate) || 0;
    if (rotate === 'auto' || rotate === undefined) {
      const sc = 420 / Math.max(img.width, img.height); const t = document.createElement('canvas'); t.width = Math.round(img.width * sc); t.height = Math.round(img.height * sc);
      const tc = t.getContext('2d', { willReadFrequently: true }); tc.fillStyle = '#fff'; tc.fillRect(0, 0, t.width, t.height); tc.drawImage(img, 0, 0, t.width, t.height);
      if (inkProfileSideways(tc, t.width, t.height)) rot = 270;
    }
    const scale = Math.min(1, 2200 / Math.max(img.width, img.height));
    const w = img.width * scale, h = img.height * scale;
    const canvas = document.createElement('canvas');
    const swap = rot === 90 || rot === 270;
    canvas.width = swap ? h : w; canvas.height = swap ? w : h;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(rot * Math.PI / 180); ctx.drawImage(img, -w / 2, -h / 2, w, h);
    return { n, dataUrl: canvas.toDataURL('image/jpeg', 0.85), width: canvas.width, height: canvas.height, rotation: rot };
  }

  // ------------------------------------------------------------------ prompts
  function extractionPrompt(settings, ctx) {
    const codes = settings.codes.map((c) => `${c.code} = ${c.desc}`).join('; ');
    return `You are reading ONE page of a scanned attendance report from a Malaysian restaurant group (Grandmama's). The image may be slightly rotated or skewed – read it carefully.
Two layouts are common:
(A) "List of Logs" (fingerprint clock): MANY employees per page. Each block has "Employee ID : … Employee Name : … Department : …", a row of day numbers 1..28/29/30/31 (the report period),
    and under each day the punch times (e.g. "[10:00 ] 08:51 14:02 15:57 17:33" — "[10:00" is the scheduled start, the rest are punches; "." means nothing).
(B) "Daily Time Record": ONE employee per page with "Employee No.", "Name", "Shift", "Dept" and one row per date with columns Date, Day, Check In, Break Out/In, Check Out,
    OverTime, LOW, OT, Total, UT, LT (lates), Others: Status (printed, e.g. "Rest Day", "Absent") and Holidays, and Remarks. At the bottom a printed TOTAL box
    (Rest Day, Leave, Day Work, Absences, Lates…). In this layout: a day with any Check In or Check Out time = W; printed "Rest Day" = OFF; printed "Absent" with nothing
    written in Remarks = ABSENT; a code hand-written in Remarks (PH, AL, MC, TRN, PL, HL, UPL…) REPLACES the printed status for that day; a value in the LT column = late (add note LATE).
Any other layout: apply the same ideas.
HR staff write on the printouts by hand: leave codes, times (e.g. "7pm", "10AM-8PM" = forgot to punch, still WORKED), a circled total near the name (e.g. "31", "-1", "-3" — copy it
as handwritten_total), employee numbers added by hand, and notes such as "PAVILION KL STAFF", "KITCHEN", "Start at GMM Genting 18/7/26", "Last day 17/07/26", "RESIGN".

Return JSON only, matching this shape:
{"page": <page number>, "layout": "list_of_logs" | "daily_time_record" | "other", "company": "CHAMPION VISTA SDN BHD", "period_start": "2026-07-01", "period_end": "2026-07-31",
 "employees": [ {
  "employee_id": "AT001", "name": "ADAM ABDUL RAHMAN", "department": "FT SERVICE",
  "continued_from_previous_page": false,   // true ONLY for a day grid at the very top of the page that has no header (it belongs to the last employee of the previous page)
  "grid_on_next_page": false,              // true when this header is the last thing on the page and its day grid is on the next page
  "handwritten_total": "-2", "printed_totals": "Rest Day 8, Leave 0, Day Work 22, Absences 1, Lates 0", "notes": "every handwritten note about this employee",
  "days": ["W|08:58", "OFF", "AL", "MC", "BLANK", ...]   // one string per day of the report period (28–31), day 1 first
} ] }

Rules for each day string — CODE, or CODE|first_in_time, or CODE|first_in_time|note:
- W = worked (punch / check-in / check-out time, or hand-written working hours). first_in_time = first real time after 05:00 in 24h HH:MM (ignore "00:00"/"00:01" overnight punches). Add note LATE if the report marks the day late.
- A hand-written leave code on the day wins over printed values and punches: write that code (MC, AL, OFF, PH, HL, UPL, TRN, PL…). Ignore codes that are crossed out.
- Allowed codes: ${codes}. Map synonyms: "Rest Day", "Off", "0FF", "RD" -> OFF; "A/L" -> AL; "Unpaid", "UNP", "UWP", "NPL" -> UPL; "HS" -> HS; "Absent" (printed, no remark) -> ABSENT.
- BLANK = nothing printed and nothing written for that day (List of Logs layout).
- NOTEMP = days before the employee started / after the last day or resignation, or days a staff from ANOTHER outlet was not helping here (use the notes).
- Keep employees in page order. Never invent employees or days. Copy hand-written names / numbers as written.
${ctx.previous ? `\nThe previous page ended with employee "${ctx.previous.name}" (ID ${ctx.previous.employee_id || '?'})${ctx.previous.grid_on_next_page ? ' whose day grid continues at the top of this page' : ''}.` : ''}
${settings.ai.instructions ? `\nAdditional instructions from HR (external circumstances) — follow them:\n${settings.ai.instructions}` : ''}
This is page ${ctx.page} of ${ctx.pages}.`;
  }

  const EXTRACT_SCHEMA = {
    type: 'OBJECT',
    properties: {
      page: { type: 'INTEGER' }, layout: { type: 'STRING' }, company: { type: 'STRING' }, period_start: { type: 'STRING' }, period_end: { type: 'STRING' },
      employees: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
        employee_id: { type: 'STRING' }, name: { type: 'STRING' }, department: { type: 'STRING' },
        continued_from_previous_page: { type: 'BOOLEAN' }, grid_on_next_page: { type: 'BOOLEAN' },
        handwritten_total: { type: 'STRING' }, printed_totals: { type: 'STRING' }, notes: { type: 'STRING' },
        days: { type: 'ARRAY', items: { type: 'STRING' } },
      }, required: ['name', 'days'] } },
    },
    required: ['employees'],
  };

  // ------------------------------------------------------------------ provider calls
  async function callModel(settings, parts, { json = true, schema = null, maxTokens = 16000, signal } = {}) {
    const ai = settings.ai; const p = PROVIDERS[ai.provider] || PROVIDERS.gemini;
    const base = (ai.baseUrl || p.baseUrl).replace(/\/$/, '');
    const model = ai.model || p.defaultModel;
    const apiKey = keyFor(ai);
    if (!apiKey) throw new Error(`No API key for ${p.label.split(' (')[0]}. Open Settings → AI and paste the key.`);
    let res, data, text;
    if (ai.provider === 'openai') {
      const content = parts.map((x) => (x.text !== undefined ? { type: 'text', text: x.text } : { type: 'image_url', image_url: { url: x.dataUrl } }));
      res = await fetch(`${base}/chat/completions`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens, ...(json ? { response_format: { type: 'json_object' } } : {}), messages: [{ role: 'user', content }] }) });
      data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiError(data, res));
      text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    } else if (ai.provider === 'anthropic') {
      const content = parts.map((x) => (x.text !== undefined ? { type: 'text', text: x.text } : { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: x.dataUrl.split(',')[1] } }));
      if (/-latest$/.test(model) && !settings._modelRetry) return retryWithResolved(settings, model, parts, { json, schema, maxTokens, signal }, true);
      res = await fetch(`${base}/messages`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model, max_tokens: Math.min(maxTokens, 32000), temperature: 0, messages: [{ role: 'user', content: json ? [...content, { type: 'text', text: 'Reply with the JSON object only.' }] : content }] }) });
      data = await res.json().catch(() => ({}));
      if (!res.ok && isModelMissing(res, data) && !settings._modelRetry) return retryWithResolved(settings, model, parts, { json, schema, maxTokens, signal });
      if (!res.ok) throw new Error(apiError(data, res));
      text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    } else {
      const gparts = parts.map((x) => (x.text !== undefined ? { text: x.text } : { inline_data: { mime_type: 'image/jpeg', data: x.dataUrl.split(',')[1] } }));
      const generationConfig = { temperature: 0, maxOutputTokens: maxTokens };
      if (json) { generationConfig.responseMimeType = 'application/json'; if (schema) generationConfig.responseSchema = schema; }
      const body = JSON.stringify({ contents: [{ role: 'user', parts: gparts }], generationConfig });
      res = await googleFetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', signal, body }, apiKey);
      data = await res.json().catch(() => ({}));
      if (!res.ok && isModelMissing(res, data) && !settings._modelRetry) return retryWithResolved(settings, model, parts, { json, schema, maxTokens, signal });
      if (!res.ok) throw new Error(apiError(data, res));
      const cand = data.candidates && data.candidates[0];
      text = cand && cand.content && (cand.content.parts || []).map((x) => x.text || '').join('');
      if (!text && cand && cand.finishReason) throw new Error(`Model stopped: ${cand.finishReason}`);
    }
    if (!text) throw new Error('Empty response from the AI model.');
    return json ? parseJsonLoose(text) : text;
  }

  // The model name does not exist for this key (or is a "-latest" family alias): pick the closest available model and retry once.
  async function retryWithResolved(settings, model, parts, opts, silent) {
    const ai = settings.ai;
    const list = await listModels(settings);
    const pick = resolveModel(model, list);
    if (!pick) throw new Error(`Model "${model}" is not available for this key, and no similar model was found. Use Settings → AI → List models.`);
    if (!silent) ai._resolvedNote = `Model "${model}" was not found for this key — using "${pick}" instead.`;
    ai._resolvedModel = pick;
    return callModel({ ...settings, ai: { ...ai, model: pick }, _modelRetry: true }, parts, opts);
  }

  // Google accepts API keys in the x-goog-api-key header; OAuth-style tokens need "Authorization: Bearer".
  // Try the key header first and fall back automatically, remembering what worked.
  let googleAuthMode = null;
  async function googleFetch(url, opts, key) {
    const mk = (mode) => ({ ...opts, headers: { 'Content-Type': 'application/json', ...(mode === 'bearer' ? { Authorization: `Bearer ${key}` } : { 'x-goog-api-key': key }) } });
    const first = googleAuthMode || 'key';
    let res = await fetch(url, mk(first));
    if (!googleAuthMode && (res.status === 400 || res.status === 401 || res.status === 403)) {
      const txt = await res.clone().text();
      if (/api key|credential|authenticat|unauthori[sz]ed|permission/i.test(txt)) {
        const res2 = await fetch(url, mk('bearer'));
        if (res2.ok || ![400, 401, 403].includes(res2.status)) { googleAuthMode = 'bearer'; return res2; }
      }
    }
    if (res.ok && !googleAuthMode) googleAuthMode = first;
    return res;
  }
  function isModelMissing(res, data) {
    const m = String((data && data.error && data.error.message) || '');
    return res.status === 404 || /not found|is not supported for generatecontent|unknown model|invalid model/i.test(m);
  }
  // Closest available model to what the user typed, e.g. "gemini-3.8-flash" -> best "flash" model with the nearest version.
  function resolveModel(requested, list) {
    const req = String(requested).toLowerCase().replace(/\s+/g, '-');
    if (/claude/.test(req)) {
      // Anthropic lists newest models first; keep the order and pick the first of the same family
      const fam = (/opus|sonnet|haiku|fable/.exec(req) || [''])[0];
      const exactC = list.find((n) => n.toLowerCase() === req);
      if (exactC) return exactC;
      return list.find((n) => /claude/i.test(n) && (!fam || n.toLowerCase().includes(fam))) || null;
    }
    const want = { flash: /flash/.test(req), pro: /pro/.test(req), lite: /lite/.test(req) };
    const ver = (n) => { const m = /(\d+(?:\.\d+)?)/.exec(n.replace(/^gemini-/, '')); return m ? parseFloat(m[1]) : 0; };
    const rv = ver(req);
    const cands = list.filter((n) => /gemini/i.test(n) && !/embed|tts|image|audio|live|aqa|robotics|computer-use/i.test(n))
      .filter((n) => (want.flash ? /flash/i.test(n) : want.pro ? /pro/i.test(n) : true))
      .filter((n) => (want.lite ? true : !/lite/i.test(n)));
    if (!cands.length) return null;
    const exact = cands.find((n) => n.toLowerCase() === req || n.toLowerCase().startsWith(req));
    if (exact) return exact;
    const score = (n) => -Math.abs(ver(n) - rv) * 10 + ver(n) + (/preview|exp/i.test(n) ? -0.05 : 0) + (/latest/i.test(n) ? 0.01 : 0);
    return cands.sort((a, b) => score(b) - score(a))[0];
  }

  function apiError(data, res) {
    const m = (data && data.error && (data.error.message || data.error.type)) || (data && data.message) || res.statusText;
    if (res.status === 429) return `Rate limit / quota reached (429). Wait a minute and retry, or use a paid key. Details: ${m}`;
    if (res.status === 401 || res.status === 403) return `API key rejected (${res.status}). Check the key and provider. Details: ${m}`;
    return `AI request failed (${res.status}): ${m}`;
  }

  function parseJsonLoose(text) {
    const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { return JSON.parse(t); } catch (e) {
      const a = t.indexOf('{'), b = t.lastIndexOf('}');
      if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
      throw new Error('The AI did not return valid JSON.');
    }
  }

  async function listModels(settings) {
    const ai = settings.ai; const p = PROVIDERS[ai.provider] || PROVIDERS.gemini;
    const base = (ai.baseUrl || p.baseUrl).replace(/\/$/, '');
    let res, data;
    const apiKey = keyFor(ai);
    if (ai.provider === 'openai') { res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${apiKey}` } }); data = await res.json(); if (!res.ok) throw new Error(apiError(data, res)); return (data.data || []).map((m) => m.id).sort(); }
    if (ai.provider === 'anthropic') { res = await fetch(`${base}/models?limit=100`, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } }); data = await res.json(); if (!res.ok) throw new Error(apiError(data, res)); return (data.data || []).map((m) => m.id); }
    res = await googleFetch(`${base}/models?pageSize=200`, {}, apiKey); data = await res.json(); if (!res.ok) throw new Error(apiError(data, res));
    return (data.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
  }

  // ------------------------------------------------------------------ extraction pipeline
  async function extractPages(pages, settings, dim, onProgress, signal) {
    const out = []; let previous = null;
    let active = { ...settings, ai: { ...settings.ai } }; let usedFallback = null;
    for (let i = 0; i < pages.length; i++) {
      onProgress && onProgress({ page: i + 1, pages: pages.length, status: 'reading' });
      let json, err;
      const tryPage = async (cfg, attempts) => {
        for (let attempt = 0; attempt < attempts; attempt++) {
          try {
            json = await callModel(cfg, [{ text: extractionPrompt(cfg, { dim, page: i + 1, pages: pages.length, previous }) }, { dataUrl: pages[i].dataUrl }], { schema: EXTRACT_SCHEMA, signal, maxTokens: 32768 });
            if (cfg.ai._resolvedModel) { cfg.ai.model = cfg.ai._resolvedModel; delete cfg.ai._resolvedModel; }
            err = null; return true;
          } catch (e) { err = e; if (signal && signal.aborted) throw e; if (!/429|quota|rate|500|503|overloaded|JSON|Empty|stopped/i.test(e.message)) return false; await sleep(4000 * (attempt + 1)); }
        }
        return false;
      };
      let ok = await tryPage(active, 3);
      const fb = settings.ai.fallbackPreset;
      if (!ok && fb && fb !== active.ai.preset && keyFor(withPreset(settings, fb).ai)) {
        // primary model failed (quota, outage, bad output): switch to the fallback model for the rest of the run
        const firstErr = err.message;
        active = withPreset(settings, fb);
        onProgress && onProgress({ page: i + 1, pages: pages.length, status: 'fallback', text: `${currentLabel(settings.ai)} failed (${firstErr.slice(0, 80)}) – switching to ${currentLabel(active.ai)}` });
        usedFallback = currentLabel(active.ai);
        ok = await tryPage(active, 2);
      }
      if (!ok) throw new Error(`Page ${i + 1}: ${err.message}`);
      const emps = (json.employees || []).map((e) => ({ ...e, page: i + 1 }));
      out.push({ page: i + 1, layout: json.layout || '', company: json.company || '', period_start: json.period_start || '', period_end: json.period_end || '', employees: emps });
      if (emps.length) previous = emps[emps.length - 1];
      onProgress && onProgress({ page: i + 1, pages: pages.length, status: 'done', count: emps.length, model: currentLabel(active.ai) });
    }
    if (active.ai.model !== settings.ai.model && !usedFallback && settings.ai.provider === active.ai.provider) settings.ai._resolvedNote = settings.ai._resolvedNote || `Using "${active.ai.model}" (closest available to "${settings.ai.model}").`;
    out.modelUsed = active.ai.model; out.fallbackUsed = usedFallback;
    return out;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Merge per-page results into one record per employee (handles day grids that continue on the next page)
  function mergePages(pageResults, dim) {
    const recs = [];
    for (const pr of pageResults) {
      for (const e of pr.employees || []) {
        const days = normaliseDays(e.days, dim);
        if (e.continued_from_previous_page && recs.length) {
          const last = recs[recs.length - 1];
          last.days = last.days.map((d, i) => (d.code === 'BLANK' && days[i].code !== 'BLANK' ? days[i] : d));
          if (e.notes) last.notes = [last.notes, e.notes].filter(Boolean).join('; ');
          if (e.handwritten_total && !last.handwrittenTotal) last.handwrittenTotal = e.handwritten_total;
          last.pages.push(pr.page);
          continue;
        }
        const id = String(e.employee_id || '').trim().replace(/\.+$/, '');
        const same = id && /\d/.test(id) && recs.find((r) => r.employeeId === id);
        if (same) { // the same employee printed on another page (e.g. a 2-page Daily Time Record)
          same.days = same.days.map((d, i) => (['BLANK', 'NOTEMP'].includes(d.code) && !['BLANK', 'NOTEMP'].includes(days[i].code) ? days[i] : d));
          same.pages.push(pr.page); continue;
        }
        recs.push({ employeeId: id, name: String(e.name || '').trim().replace(/\s*\.$/, ''), department: String(e.department || '').trim(),
          handwrittenTotal: e.handwritten_total || '', printedTotals: e.printed_totals || '', notes: e.notes || '', days, pages: [pr.page] });
      }
    }
    return recs;
  }

  // Report-level facts (company, period, layout) — the most common value across pages.
  function reportMeta(pageResults) {
    const pick = (k) => { const c = {}; pageResults.forEach((p) => { const v = String(p[k] || '').trim(); if (v) c[v] = (c[v] || 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1]).map((x) => x[0])[0] || ''; };
    return { company: pick('company'), periodStart: pick('period_start'), periodEnd: pick('period_end'), layout: pick('layout') };
  }

  function normaliseDays(arr, dim) {
    const out = [];
    for (let d = 1; d <= dim; d++) {
      const raw = Array.isArray(arr) ? arr[d - 1] : null;
      let code = 'BLANK', firstIn = '', note = '';
      if (raw && typeof raw === 'object') { code = raw.code || 'BLANK'; firstIn = raw.in || raw.firstIn || ''; note = raw.note || ''; }
      else if (raw) { const p = String(raw).split('|'); code = p[0]; firstIn = p[1] || ''; note = p.slice(2).join('|'); }
      code = String(code).trim().toUpperCase().replace(/^0FF$/, 'OFF').replace(/^(REST\s*DAY|RD)$/, 'OFF').replace(/^A\/L$/, 'AL').replace(/^WORK(ED)?$/, 'W') || 'BLANK';
      out.push({ day: d, code, firstIn: firstIn.trim(), note: note.trim() });
    }
    return out;
  }

  // ------------------------------------------------------------------ AI review / summary
  async function reviewOutlet(settings, outlet, compRows, dim) {
    const table = compRows.map((x) => {
      const r = x.row; const a = r.attendance || {};
      return { name: r.name, empNo: r.empNo, category: r.category, status: r.status, include: r.include !== false, joinDate: r.joinDate, resignDate: r.resignDate,
        mc: r.mc, upl: r.upl, absent: r.absent, lateDays: r.lateDays, notEmployed: r.notEmployed, exitType: r.exitType || '', waiveTier: !!r.waiveTier,
        K: x.vars.PointEntitlement, L: x.vars.DaysWorked, tier: x.vars.tier ? x.vars.tier.label : '', codes: a.codeString || '', handwrittenTotal: a.handwrittenTotal || '', notes: a.notes || '', flags: r.flags || [] };
    });
    const prompt = `You are an HR payroll assistant for a Malaysian restaurant group. Review the attendance-based service charge input for outlet "${outlet.sheetName}" (${dim} days).
Rules: deductible days = MC/HL + UPL (+ absent) + lateness days. Tiers: ${settings.tiers.map((t) => `${t.label}: ${t.text}`).join('; ')}. Non-deductible: OFF, AL, PH etc.
Foreign workers get ${settings.fwShare} point (rest to company). Staff with blank attendance are not recorded. Helpers from other outlets get points for days helped.
"codes" is the day-by-day string (W=worked, BLANK=no punch, NOTEMP=not employed). "handwrittenTotal" is HR's circled total on the printout (e.g. "-2" means 2 deductible days, "31" means full month) — compare it with mc+upl+absent.
${settings.ai.instructions ? `External circumstances / HR instructions to apply:\n${settings.ai.instructions}\n` : ''}
Data (JSON): ${JSON.stringify(table)}

Return JSON: {"summary": "short plain-English summary for HR (bullets with • allowed): headcount, who has MC/UPL/absence, tier deductions, new joiners/leavers, anything unusual",
"suggestions": [{"empNo": "...", "name": "...", "field": "mc|upl|absent|lateDays|notEmployed|exitType|waiveTier|include|extraRemark", "value": <number|string|boolean>, "reason": "..."}]}
Only suggest a change when the data clearly supports it (e.g. handwritten total disagrees, BLANK days that look like OFF days, a note says resigned/absconded, an HR instruction applies). Max 25 suggestions.`;
    return callModel(settings, [{ text: prompt }], { maxTokens: 8000 });
  }

  const api = { PROVIDERS, MODEL_PRESETS, presetById, keyFor, withPreset, currentLabel, resolveModel, renderPdf, imageFileToPage, extractionPrompt, callModel, listModels, extractPages, mergePages, reportMeta, normaliseDays, inkProfileSideways, reviewOutlet, parseJsonLoose };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GMM = root.GMM || {}; root.GMM.ai = api;
})(typeof window !== 'undefined' ? window : globalThis);
