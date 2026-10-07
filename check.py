from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b=p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    page=b.new_page(viewport={"width":1280,"height":900}, device_scale_factor=1)
    errors=[]
    page.on('pageerror', lambda e: errors.append('page:'+str(e)))
    page.on('console', lambda m: errors.append('console:'+m.text) if m.type=='error' else None)
    page.goto('http://127.0.0.1:3999/', wait_until='networkidle')
    if page.locator('#rulesOk').is_visible(): page.click('#rulesOk')
    page.evaluate("showTab('pnote')")
    page.wait_for_timeout(300)
    print('errors=', errors)
    print('tools=', page.locator('#pTools1 button').count())
    print('function=', page.get_by_text('함수 보정', exact=True).count())
    print('degree=', page.locator('#pTools1 select').count())
    print('auto=', page.get_by_text('도형 자동', exact=True).count())
    b.close()
