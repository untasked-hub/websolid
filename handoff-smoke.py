#!/usr/bin/env python3
"""Headless browser smoke test for export handoff. Requires Chrome and websocket-client."""
import http.server, json, os, subprocess, tempfile, threading, time, urllib.request
import websocket

root = os.path.abspath(os.path.join(os.path.dirname(__file__), 'public'))
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs): super().__init__(*args, directory=root, **kwargs)
    def log_message(self, *args): pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory() as d:
    chrome = subprocess.Popen(['google-chrome', '--headless', '--no-sandbox', '--disable-gpu', '--remote-allow-origins=*', '--remote-debugging-port=0', '--user-data-dir='+d, 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                with open(os.path.join(d, 'DevToolsActivePort')) as f: port = f.readline().strip()
                tabs = json.load(urllib.request.urlopen('http://127.0.0.1:'+port+'/json'))
                break
            except (OSError, ValueError): time.sleep(.1)
        else: raise AssertionError('Chrome did not start')
        page = next(tab for tab in tabs if tab.get('type') == 'page' and tab.get('url') == 'about:blank')
        ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=10, suppress_origin=True)
        counter = [0]
        def call(method, params=None):
            counter[0] += 1; mid = counter[0]
            ws.send(json.dumps({'id':mid,'method':method,'params':params or {}}))
            while True:
                msg=json.loads(ws.recv())
                if msg.get('id') == mid:
                    assert 'error' not in msg, msg
                    return msg.get('result', {})
        def js(expr):
            r=call('Runtime.evaluate', {'expression':expr, 'returnByValue':True, 'awaitPromise':True})
            assert 'exceptionDetails' not in r, r
            return r['result'].get('value')
        call('Page.enable'); call('Runtime.enable')
        downloads=os.path.join(d,'downloads'); os.mkdir(downloads)
        call('Page.setDownloadBehavior', {'behavior':'allow','downloadPath':downloads})
        call('Page.navigate', {'url':f'http://127.0.0.1:{server.server_port}/cad.html'})
        for _ in range(150):
            if js("!!document.querySelector('#btn-stl') && document.readyState === 'complete' && !!document.querySelector('#viewport canvas')"): break
            time.sleep(.1)
        else: raise AssertionError('Modeler did not load: ' + str(js("({url:location.href, ready:document.readyState, three:typeof THREE, body:document.body.innerText.slice(0,300), canvas:!!document.querySelector('#viewport canvas')})")))
        time.sleep(1)
        for button, token, extension in [('btn-stl','STL','.stl'),('btn-dxf','DXF','.dxf'),('btn-drawing','SVG','.svg'),('btn-bom','CSV','.csv')]:
            js(f"document.getElementById('{button}').click()")
            state=js("({open:!document.getElementById('handoff-panel').hidden, focus:document.activeElement.id, summary:document.getElementById('handoff-summary').textContent, steps:[...document.querySelectorAll('#handoff-checklist li')].map(x=>x.textContent), confirm:!document.getElementById('btn-handoff-export').hidden})")
            assert state['open'] and state['focus']=='btn-handoff-close' and state['confirm'], state
            assert token in state['summary'] and len(state['steps'])==3, state
            receipt=js("document.getElementById('artifact-receipt').textContent")
            assert 'Artifact: ' + token in receipt and 'Scope:' in receipt and 'Units:' in receipt, receipt
            assert 'not an editable WebSolid part' in receipt and 'Save file' in receipt, receipt
            expected = {'STL':'no unit field', 'DXF':'$INSUNITS = 4', 'SVG':'reference', 'CSV':'mass in g'}
            assert expected[token] in receipt.lower() if token == 'SVG' else expected[token] in receipt, receipt
            assert all(any(step.startswith(x) for step in state['steps']) for x in ('Scope:', 'Units:', 'Next step:')),state
            report=js("({blocking:[...document.querySelectorAll('#preflight-blocking li')].map(x=>x.textContent), advisory:[...document.querySelectorAll('#preflight-advisory li')].map(x=>x.textContent), exportEnabled:!document.getElementById('btn-handoff-export').disabled})")
            assert report['blocking'] and report['advisory'] and report['exportEnabled'], report
            assert any('No hole circles cross' in line for line in report['blocking']), report
            js("document.getElementById('handoff-panel').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
            assert js("document.getElementById('handoff-panel').hidden && document.activeElement.id === 'btn-handoff'")
            js("document.getElementById('btn-handoff').click()")
            assert js("document.getElementById('btn-handoff-export').hidden && document.querySelectorAll('#handoff-checklist li').length === 0 && document.getElementById('artifact-receipt').textContent === ''")
            js("document.getElementById('btn-handoff-close').click()")
            js(f"document.getElementById('{button}').click(); document.getElementById('btn-handoff-export').click()")
            for _ in range(50):
                files=os.listdir(downloads)
                if any(f.lower().endswith(extension) for f in files): break
                time.sleep(.1)
            else: raise AssertionError(f'{button} did not download: {files}')
            assert js("document.getElementById('handoff-panel').hidden && document.activeElement.id === 'btn-handoff'")
            if button == 'btn-drawing':
                svg_path = os.path.join(downloads, next(f for f in files if f.lower().endswith('.svg')))
                with open(svg_path, encoding='utf-8') as f:
                    svg_text = f.read()
                for token in ('Scale: ', 'px/mm', 'Overall bounds:', 'TOP', 'FRONT', 'RIGHT', 'Reference preview only — not a toleranced manufacturing drawing'):
                    assert token in svg_text, f'SVG drawing missing {token!r}'
                assert svg_text.count('class="dim"') == 4, 'expected three view dimensions plus title-block metadata'
            print(button, 'PASS', state['steps'])
        # Move one hole outside the sketch: the blocker is reported but export remains available.
        js("(() => { const field=[...document.querySelectorAll('.hole-card .field')].find(x=>x.textContent.trim().startsWith('X')); const input=field.querySelector('input'); input.value='100'; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); document.getElementById('btn-stl').click(); })()")
        outside=js("({blocking:[...document.querySelectorAll('#preflight-blocking li')].map(x=>x.textContent), enabled:!document.getElementById('btn-handoff-export').disabled, visible:!document.getElementById('btn-handoff-export').hidden})")
        assert any('crosses or lies outside' in line for line in outside['blocking']), outside
        assert outside['enabled'] and outside['visible'], outside
        print('Four formats, blocker/advisory split, export-anyway path, cancellation, and downloads passed.')
    finally:
        chrome.terminate(); chrome.wait(timeout=10); server.shutdown()
