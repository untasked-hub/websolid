#!/usr/bin/env python3
"""Headless smoke test for the portable part file (save + open round trip).

Checks:
  1. The editor loads with the new Save file / Open file controls.
  2. The downloaded .websolid.json is a valid part file with no mesh.
  3. Re-opening a modified part file rebuilds the part (features, holes,
     sketch dimensions) and keeps it out of the server library.

Requires Chrome and websocket-client, like handoff-smoke.py.
"""
import http.server, json, os, subprocess, tempfile, threading, time, urllib.request
import websocket

root = os.path.abspath(os.path.join(os.path.dirname(__file__), 'public'))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=root, **kwargs)

    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

with tempfile.TemporaryDirectory() as d:
    chrome = subprocess.Popen(
        ['google-chrome', '--headless', '--no-sandbox', '--disable-gpu',
         '--remote-allow-origins=*', '--remote-debugging-port=0',
         '--user-data-dir=' + d, 'about:blank'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                with open(os.path.join(d, 'DevToolsActivePort')) as f:
                    port = f.readline().strip()
                tabs = json.load(urllib.request.urlopen('http://127.0.0.1:' + port + '/json'))
                break
            except (OSError, ValueError):
                time.sleep(.1)
        else:
            raise AssertionError('Chrome did not start')

        page = next(tab for tab in tabs if tab.get('type') == 'page' and tab.get('url') == 'about:blank')
        ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=10, suppress_origin=True)
        counter = [0]

        def call(method, params=None):
            counter[0] += 1
            mid = counter[0]
            ws.send(json.dumps({'id': mid, 'method': method, 'params': params or {}}))
            while True:
                msg = json.loads(ws.recv())
                if msg.get('id') == mid:
                    assert 'error' not in msg, msg
                    return msg.get('result', {})

        def js(expr):
            r = call('Runtime.evaluate', {'expression': expr, 'returnByValue': True, 'awaitPromise': True})
            assert 'exceptionDetails' not in r, r
            return r['result'].get('value')

        call('Page.enable')
        call('Runtime.enable')
        downloads = os.path.join(d, 'downloads')
        os.mkdir(downloads)
        call('Page.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': downloads})
        call('Page.navigate', {'url': f'http://127.0.0.1:{server.server_port}/cad.html'})
        for _ in range(150):
            if js("!!document.querySelector('#btn-savefile') && document.readyState === 'complete'"
                  " && !!document.querySelector('#viewport canvas')"):
                break
            time.sleep(.1)
        else:
            raise AssertionError('Modeler did not load: ' + str(js(
                "({url:location.href, ready:document.readyState, body:document.body.innerText.slice(0,300)})")))
        time.sleep(1)

        # 1. Controls present and discoverable in the formats panel copy.
        panel_text = js("document.getElementById('handoff-panel').innerText")
        assert 'JSON · part file' in panel_text, panel_text[:400]
        assert 'no mesh' in panel_text.lower()

        # 2. Export: download the part file and inspect it.
        js("document.getElementById('btn-savefile').click()")
        target = None
        deadline = time.time() + 15
        while time.time() < deadline:
            files = [f for f in os.listdir(downloads) if f.endswith('.json')]
            if files:
                path = os.path.join(downloads, files[0])
                if os.path.getsize(path) > 0:
                    target = path
                    break
            time.sleep(.2)
        assert target, 'part file was not downloaded'
        with open(target) as f:
            payload = json.load(f)
        assert payload['format'] == 'websolid-part', payload.get('format')
        assert payload['version'] == 1
        assert 'mesh' not in json.dumps(payload['part']).lower()
        assert payload['part']['holes'], 'part file lost the hole list'
        original_name = payload['part']['name']
        assert '.websolid.json' in os.path.basename(target)

        # 3. Round trip: change the part, re-import the file (must undo the change).
        js("window.__solid.getPart().name")
        changed = js("""
          (function(){
            var p = window.__solid.getPart();
            p.name = 'Edited in session';
            p.extrude.depth = 40;
            p.holes = [{x:0,y:0,d:4}];
            window.__solid.loadPart(p, null);
            return window.__solid.getPart().name + '|' + window.__solid.getPart().extrude.depth;
          })()
        """)
        assert changed == 'Edited in session|40', changed

        restored = js("window.__solid.importPartFile(" + json.dumps(json.dumps(payload)) + ")")
        assert restored is True, restored
        state = js("""(function(){
            var p = window.__solid.getPart();
            var m = window.__solid.getMetrics();
            return {name: p.name, depth: p.extrude.depth, holes: p.holes.length,
                    tris: m ? m.tris : 0, vol: m ? Math.round(m.volumeMm3) : 0,
                    session: window.__solid.session().state};
        })()""")
        assert state['name'] == original_name, state
        assert state['depth'] != 40, state
        assert state['holes'] == len(payload['part']['holes']), state
        assert state['tris'] > 0 and state['vol'] > 0, state
        assert state['session'] in ('local', 'unsaved'), state

        # 4. Reject non-part JSON and leave the current part untouched.
        bad = js("window.__solid.importPartFile('{\"hello\":1}')")
        assert bad is False, bad
        assert js("window.__solid.getPart().name") == original_name

        print(json.dumps({
            'ok': True,
            'file': os.path.basename(target),
            'bytes': os.path.getsize(target),
            'restored': state,
        }, indent=2))
    finally:
        chrome.terminate()
        server.shutdown()
