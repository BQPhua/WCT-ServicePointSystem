# End-to-end UI test of the single-file build: attendance only (no previous Excel), two attendance layouts.
#  A) Daily Time Record (Central Kitchen) read by a mocked Gemini 3.8 Flash -> outlet + SC + incentive (2%) -> export both
#  B) List of Logs (ATSB / Genting) via a saved extraction -> Genting, service charge only -> export
import os, json, sys
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out'); os.makedirs(OUT, exist_ok=True)
ref = json.load(open(os.path.join(ROOT, 'fixtures/REFERENCE-central-kitchen-DTR-July2026-extraction.json')))
def gemini(route, req):
    prompt = json.loads(req.post_data)['contents'][0]['parts'][0]['text']
    assert 'Daily Time Record' in prompt and 'List of Logs' in prompt
    n = int(prompt.split('This is page ')[1].split(' ')[0])
    route.fulfill(status=200, content_type='application/json', body=json.dumps({'candidates': [{'content': {'parts': [{'text': json.dumps(ref['pages'][n - 1])}]}, 'finishReason': 'STOP'}]}))
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(headless=True); pg = b.new_page(viewport={'width': 1550, 'height': 1000}, accept_downloads=True)
    pg.on('pageerror', lambda e: errors.append(str(e))); pg.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    pg.route('https://generativelanguage.googleapis.com/**', gemini)
    pg.goto('file://' + os.path.join(ROOT, 'dist/GMM-ServiceCharge-Tool.html')); pg.wait_for_load_state('networkidle')
    pg.evaluate('localStorage.clear()'); pg.reload(); pg.wait_for_load_state('networkidle')
    print('steps:', [t.strip() for t in pg.locator('.step').all_inner_texts()])
    pg.click('header [data-act="settings"]'); pg.fill('input[data-key="gemini"]', 'KEY'); pg.dispatch_event('input[data-key="gemini"]', 'change'); pg.click('[data-act="closeSettings"]')
    # ---- A: Daily Time Record
    pg.set_input_files('#attInput', os.path.join(ROOT, 'fixtures/DTR-central-kitchen.pdf')); pg.wait_for_selector('.thumbs img', timeout=60000)
    rot = pg.evaluate('GMMApp.state.ui.att.pages.map(p => p.rotation)'); print('DTR auto-rotation:', set(rot))
    pg.screenshot(path=f'{OUT}/v2_1_upload_dtr.png')
    pg.click('[data-act="extract"]'); pg.wait_for_selector('text=What the AI read', timeout=120000)
    print('DTR read:', pg.inner_text('.progress + p'))
    pg.screenshot(path=f'{OUT}/v2_2_read_dtr.png', full_page=True)
    pg.click('[data-act="go"][data-step="2"]')
    pg.check('input[name="asgOutlet"][value="Central Kitchen"]')
    pg.check('input[data-asg="inc"]')
    pg.fill('input[data-asg="netSales"]', '200000'); pg.dispatch_event('input[data-asg="netSales"]', 'change')
    pg.fill('input[data-asg="incPct"]', '2'); pg.dispatch_event('input[data-asg="incPct"]', 'change')
    pg.screenshot(path=f'{OUT}/v2_3_outlet_step.png', full_page=True)
    pg.click('[data-act="createOutlet"]'); pg.wait_for_selector('#grid')
    print('CK staff rows:', pg.locator('#grid tbody tr').count(), '| toast:', pg.inner_text('#toast'), '| months', pg.evaluate('GMMApp.state.ws.month + " " + GMMApp.state.ws.attendanceMonth'))
    pg.click('[data-act="scheme"][data-s="inc"]'); pg.wait_for_timeout(200)
    print('incentive card:', [t.replace('\n', ' ') for t in pg.locator('.kpi').all_inner_texts()][:5])
    pg.screenshot(path=f'{OUT}/v2_4_review_inc.png')
    # ---- B: List of Logs via saved extraction
    pg.click('.step[data-step="1"]')
    pg.set_input_files('#attInput', os.path.join(ROOT, 'fixtures/ATSB.pdf')); pg.wait_for_selector('.thumbs img', timeout=60000)
    rot = pg.evaluate('GMMApp.state.ui.att.pages.map(p => p.rotation)'); print('ATSB auto-rotation:', set(rot))
    pg.set_input_files('#extractInput', os.path.join(ROOT, 'fixtures/SAMPLE-genting-extraction-synthetic.json'))
    pg.wait_for_selector('text=What the AI read', timeout=10000)
    pg.click('[data-act="go"][data-step="2"]')
    print('suggested outlet:', pg.eval_on_selector('input[name="asgOutlet"]:checked', 'e => e.value'), pg.evaluate('JSON.stringify(GMMApp.state.ui.asg)'))
    pg.check('input[name="asgOutlet"][value="Genting"]')
    pg.fill('input[data-asg="scCollected"]', '70146.18'); pg.dispatch_event('input[data-asg="scCollected"]', 'change')
    pg.click('[data-act="createOutlet"]'); pg.wait_for_selector('#grid')
    print('Genting 1 service point:', pg.locator('.kpi.hl .v').first.inner_text())
    pg.click('.step[data-step="2"]'); pg.screenshot(path=f'{OUT}/v2_5_outlets_list.png', full_page=True)
    pg.click('.step[data-step="4"]'); pg.screenshot(path=f'{OUT}/v2_6_export.png', full_page=True)
    with pg.expect_download() as d: pg.click('[data-act="export"][data-s="sc"]')
    d.value.save_as(f'{OUT}/v2_ServiceCharge.xlsx'); print('downloaded', d.value.suggested_filename)
    with pg.expect_download() as d: pg.click('[data-act="export"][data-s="inc"]')
    d.value.save_as(f'{OUT}/v2_Incentive.xlsx'); print('downloaded', d.value.suggested_filename)
    print('staff remembered:', pg.evaluate("Object.keys(JSON.parse(localStorage.getItem('gmm.directory')||'{}')).length"))
    b.close()
print('JS errors:', errors); sys.exit(1 if errors else 0)
