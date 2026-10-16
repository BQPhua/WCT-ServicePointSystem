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
      if (opts.rotate === 'auto' || opts.rotate === undefined) rot = vp0.height > vp0.width ? 270 : 0; // attendance logs are wide tables printed sideways
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

  async function imageFileToPage(file, n, rotate) {
    const url = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
    const rot = Number(rotate === 'auto' ? 0 : rotate) || 0;
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
    return `You are reading ONE page of a scanned "List of Logs" attendance report (fingerprint clock) from a Malaysian restaurant.
Each employee block has a header line "Employee ID : … Employee Name : … Department : …", a row with day numbers 1..${ctx.dim},
and under each day the punch times (e.g. "[10:00 ] 08:51 14:02 15:57 17:33" — "[10:00" is the scheduled start, the rest are punches; "." means nothing).
HR staff have written on the printout by hand: leave codes on empty days (OFF, AL, PH, MC, HL, UPL, ML…), sometimes over punched days,
times written by hand (e.g. "7pm", "10AM-8PM" = forgot to punch, still WORKED), circled totals next to the name (e.g. "31", "-1", "-3" — copy them as handwritten_total),
and notes such as "PAVILION KL STAFF", "Start at GMM Genting 18/7/26", "Last day at GMM Genting 17/07/26", "RESIGN", "No break".

Return JSON only, matching this shape:
{"page": <page number>, "employees": [ {
  "employee_id": "AT001", "name": "ADAM ABDUL RAHMAN", "department": "FT SERVICE",
  "continued_from_previous_page": false,   // true ONLY for a day grid at the very top of the page that has no header (it belongs to the last employee of the previous page)
  "grid_on_next_page": false,              // true when this header is the last thing on the page and its day grid is on the next page
  "handwritten_total": "-2", "notes": "free text: every handwritten note about this employee",
  "days": ["W|08:58", "OFF", "AL", "MC", "BLANK", ...]   // exactly ${ctx.dim} strings, day 1 first
} ] }

Rules for each day string, format CODE or CODE|first_punch_time or CODE|first_punch_time|note:
- W = the day has punch times or handwritten working hours. Put the first real punch after 05:00 as first_punch_time (ignore "00:00"/"00:01" overnight punches).
- A handwritten leave code on the day wins over the punches: write that code (e.g. "MC", "AL", "OFF", "PH", "HL", "UPL"). If the code is crossed out, ignore it.
- Allowed codes: ${codes}. Map synonyms: "Unpaid", "UNP", "UWP", "NPL" -> UPL; "HS" -> HS; "Off", "0FF" -> OFF; "A/L" -> AL.
- BLANK = no punches and no handwriting.
- NOTEMP = days before the employee started / after the last day / after resignation, or days a staff from ANOTHER outlet was not helping here (use the notes).
- Keep employees in the same order as on the page. Never invent employees. If a name is hand-written, copy it.
${ctx.previous ? `\nThe previous page ended with employee "${ctx.previous.name}" (ID ${ctx.previous.employee_id || '?'})${ctx.previous.grid_on_next_page ? ' whose day grid continues at the top of this page' : ''}.` : ''}
${settings.ai.instructions ? `\nAdditional instructions from HR (external circumstances) — follow them:\n${settings.ai.instructions}` : ''}
This is page ${ctx.page} of ${ctx.pages}.`;
  }

  const EXTRACT_SCHEMA = {
    type: 'OBJECT',
    properties: {
      page: { type: 'INTEGER' },
      employees: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
        employee_id: { type: 'STRING' }, name: { type: 'STRING' }, department: { type: 'STRING' },
        continued_from_previous_page: { type: 'BOOLEAN' }, grid_on_next_page: { type: 'BOOLEAN' },
        handwritten_total: { type: 'STRING' }, notes: { type: 'STRING' },
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
      out.push({ page: i + 1, employees: emps });
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
        recs.push({ employeeId: String(e.employee_id || '').trim(), name: String(e.name || '').trim(), department: String(e.department || '').trim(),
          handwrittenTotal: e.handwritten_total || '', notes: e.notes || '', days, pages: [pr.page] });
      }
    }
    return recs;
  }

  function normaliseDays(arr, dim) {
    const out = [];
    for (let d = 1; d <= dim; d++) {
      const raw = Array.isArray(arr) ? arr[d - 1] : null;
      let code = 'BLANK', firstIn = '', note = '';
      if (raw && typeof raw === 'object') { code = raw.code || 'BLANK'; firstIn = raw.in || raw.firstIn || ''; note = raw.note || ''; }
      else if (raw) { const p = String(raw).split('|'); code = p[0]; firstIn = p[1] || ''; note = p.slice(2).join('|'); }
      code = String(code).trim().toUpperCase().replace(/^0FF$/, 'OFF').replace(/^A\/L$/, 'AL').replace(/^WORK(ED)?$/, 'W') || 'BLANK';
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

  const api = { PROVIDERS, MODEL_PRESETS, presetById, keyFor, withPreset, currentLabel, resolveModel, renderPdf, imageFileToPage, extractionPrompt, callModel, listModels, extractPages, mergePages, normaliseDays, reviewOutlet, parseJsonLoose };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GMM = root.GMM || {}; root.GMM.ai = api;
})(typeof window !== 'undefined' ? window : globalThis);
