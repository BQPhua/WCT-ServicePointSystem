# AI code path with mocked providers (no real key needed):
#  run 1: Gemini 3.8 Flash returns 429 (quota) -> automatic fallback to Gemini 3.5 Flash; key accepted only as Bearer.
#  run 2: switch to "Claude Sonnet (newest)" with an Anthropic key -> alias resolved via /v1/models -> Messages API.
#  then: AI review + apply suggestion.
import os, json, sys
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fx = json.load(open(os.path.join(ROOT, 'fixtures/SAMPLE-genting-extraction-synthetic.json')))
gem_models, claude_models, auth_seen = [], [], set()

def page_json(prompt):
    n = int(prompt.split('This is page ')[1].split(' ')[0])
    return fx['pages'][n - 1] if n <= len(fx['pages']) else {'page': n, 'employees': []}
REVIEW = {'summary': '• 43 staff matched.\n• Faez: MC 1 + HL 4 = 5 days → 30% deduction.', 'suggestions': [{'empNo': 'AT0010', 'name': 'HADI A/L KUANG LEE', 'field': 'extraRemark', 'value': 'Checked by AI', 'reason': 'test'}]}

def gemini(route, req):
    if req.headers.get('x-goog-api-key'):
        auth_seen.add('key'); return route.fulfill(status=401, content_type='application/json', body=json.dumps({'error': {'message': 'API key not valid.'}}))
    auth_seen.add('bearer')
    if req.method == 'GET':
        return route.fulfill(status=200, content_type='application/json', body=json.dumps({'models': [{'name': 'models/' + n, 'supportedGenerationMethods': ['generateContent']} for n in ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite']]}))
    model = req.url.split('/models/')[1].split(':')[0]
    if model == 'gemini-3.8-flash':
        return route.fulfill(status=429, content_type='application/json', body=json.dumps({'error': {'code': 429, 'message': 'Resource has been exhausted (e.g. check quota).'}}))
    gem_models.append(model)
    prompt = json.loads(req.post_data)['contents'][0]['parts'][0]['text']
    text = json.dumps(page_json(prompt) if 'List of Logs' in prompt else REVIEW)
    route.fulfill(status=200, content_type='application/json', body=json.dumps({'candidates': [{'content': {'parts': [{'text': text}]}, 'finishReason': 'STOP'}]}))

def anthropic(route, req):
    assert req.headers.get('x-api-key') == 'CLAUDE-KEY' and req.headers.get('anthropic-dangerous-direct-browser-access') == 'true'
    if req.method == 'GET':
        return route.fulfill(status=200, content_type='application/json', body=json.dumps({'data': [{'id': i} for i in ['claude-opus-5-0', 'claude-sonnet-5-0', 'claude-sonnet-4-5', 'claude-haiku-4-5']]}))
    body = json.loads(req.post_data); claude_models.append(body['model'])
    content = body['messages'][0]['content']; prompt = content[0]['text']
    assert any(c['type'] == 'image' for c in content) or 'List of Logs' not in prompt
    text = json.dumps(page_json(prompt) if 'List of Logs' in prompt else REVIEW)
    route.fulfill(status=200, content_type='application/json', body=json.dumps({'content': [{'type': 'text', 'text': text}], 'stop_reason': 'end_turn'}))

errors = []
with sync_playwright() as p:
    b = p.chromium.launch(headless=True); pg = b.new_page(viewport={'width': 1500, 'height': 950})
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.route('https://generativelanguage.googleapis.com/**', gemini)
    pg.route('https://api.anthropic.com/**', anthropic)
    pg.goto('file://' + os.path.join(ROOT, 'dist/GMM-ServiceCharge-Tool.html')); pg.wait_for_load_state('networkidle')
    pg.evaluate("localStorage.clear()"); pg.reload(); pg.wait_for_load_state('networkidle')
    pg.set_input_files('#xlsxInput', [os.path.join(ROOT, 'fixtures/Service Charge - Aug26.xlsx'), os.path.join(ROOT, 'fixtures/Incentive - Aug26.xlsx')])
    pg.wait_for_selector('text=Imported', timeout=30000)
    pg.click('header [data-act="settings"]')
    print('model options:', pg.eval_on_selector('#preset', 'e => [...e.options].map(o => o.text)'))
    pg.fill('input[data-key="gemini"]', 'GEM-KEY'); pg.dispatch_event('input[data-key="gemini"]', 'change')
    pg.screenshot(path=os.path.join(ROOT, 'out/ui_11_ai_settings.png'))
    pg.click('[data-act="closeSettings"]')
    pg.click('.step[data-step="2"]')
    pg.set_input_files('#attInput', os.path.join(ROOT, 'fixtures/ATSB.pdf')); pg.wait_for_selector('.thumbs img', timeout=60000)
    pg.screenshot(path=os.path.join(ROOT, 'out/ui_12_attendance_model.png'))
    # run 1: Gemini 3.8 -> 429 -> fallback 3.5
    pg.click('[data-act="extract"]'); pg.wait_for_selector('text=What the AI read', timeout=180000)
    print('run 1:', pg.inner_text('.progress + p'), '| gemini models used:', sorted(set(gem_models)), '| auth tried:', sorted(auth_seen))
    # run 2: switch to Claude Sonnet via quick picker, add Anthropic key
    pg.select_option('#quickPreset', 'claude-sonnet'); pg.wait_for_timeout(200)
    print('key status after switch:', pg.inner_text('#view .card:nth-child(2) .row').split('\n')[-1][:40])
    pg.click('header [data-act="settings"]'); pg.fill('input[data-key="anthropic"]', 'CLAUDE-KEY'); pg.dispatch_event('input[data-key="anthropic"]', 'change'); pg.click('[data-act="closeSettings"]')
    pg.click('[data-act="extract"]'); pg.wait_for_function("document.querySelector('.progress + p') && document.querySelector('.progress + p').innerText.startsWith('Done') && document.querySelector('.progress + p').innerText.includes('claude')", timeout=180000)
    print('run 2:', pg.inner_text('.progress + p'), '| claude model ids sent:', sorted(set(claude_models)))
    pg.click('[data-act="applyAtt"]'); pg.wait_for_selector('#grid')
    pg.click('[data-act="aiReview"]'); pg.wait_for_selector('text=Suggested changes', timeout=20000)
    pg.click('[data-act="applySug"]'); pg.wait_for_timeout(300)
    print('suggestion applied:', 'Checked by AI' in pg.inner_text('tr:has-text("HADI A/L KUANG LEE")'))
    stored = pg.evaluate("localStorage.getItem('gmm.settings')")
    print('keys stored without "remember":', 'GEM-KEY' in stored or 'CLAUDE-KEY' in stored)
    b.close()
print('JS errors:', errors); sys.exit(1 if errors else 0)
