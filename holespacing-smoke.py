#!/usr/bin/env python3
"""Headless smoke test for hole-to-hole spacing and overlap checks.

Checks the narrowest effective hole pair, per-hole nearest-hole readouts,
overlap/warning/healthy states, mirrored-hole participation, and reset after
removing every hole. Requires Chrome and websocket-client.
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
        call('Page.navigate', {'url': f'http://127.0.0.1:{server.server_port}/cad.html'})
        for _ in range(150):
            if js("document.readyState === 'complete' && !!window.__solid"
                  " && !!document.querySelector('#spacing-summary')"):
                break
            time.sleep(.1)
        else:
            raise AssertionError('Modeler did not load')
        time.sleep(.5)

        def load(holes, mirror=False, min_wall=2):
            return js("""
              (function(){
                var p = window.__solid.getPart();
                p.feature = 'extrude';
                p.holes = %s;
                p.mirror = p.mirror || {};
                p.mirror.axis = %s ? 'x' : 'none';
                p.minWall = %s;
                window.__solid.loadPart(p, null);
                var s = document.getElementById('spacing-summary');
                return {analysis: window.__solid.holeSpacing(), text: s.textContent,
                        cls: s.className, panel: document.getElementById('hole-fields').innerText};
              })()
            """ % (json.dumps(holes), 'true' if mirror else 'false', json.dumps(min_wall)))

        # Centers 30 mm apart with diameters 6 and 8 leave a 23 mm ligament.
        healthy = load([{'x': 0, 'y': 0, 'd': 6}, {'x': 30, 'y': 0, 'd': 8}])
        assert healthy['analysis'] and abs(healthy['analysis']['gap'] - 23) < .001, healthy
        assert healthy['analysis']['a'] == 0 and healthy['analysis']['b'] == 1, healthy
        assert healthy['cls'] == 'hint clearance-ok', healthy
        assert '23.00 mm' in healthy['text'], healthy['text']
        assert healthy['panel'].count('Nearest hole') == 2, healthy['panel']
        assert 'Hole 2 · 23.00 mm gap' in healthy['panel'], healthy['panel']

        # The narrowest pair, not simply the first pair, must drive the summary.
        narrow = load([{'x': 0, 'y': 0, 'd': 6}, {'x': 40, 'y': 0, 'd': 6},
                       {'x': 10, 'y': 0, 'd': 6}])
        assert abs(narrow['analysis']['gap'] - 4) < .001, narrow
        assert narrow['cls'] == 'hint clearance-ok', narrow
        assert 'between holes 1 and 3' in narrow['text'], narrow['text']

        # Positive gap below the configured minimum wall is advisory, not overlap.
        warning = load([{'x': 0, 'y': 0, 'd': 6}, {'x': 7, 'y': 0, 'd': 6}], min_wall=2)
        assert abs(warning['analysis']['gap'] - 1) < .001, warning
        assert warning['cls'] == 'hint clearance-warn', warning
        assert 'below 2 mm min wall' in warning['text'], warning['text']
        assert 'overlap' not in warning['text'].lower(), warning['text']

        # Coincident circles overlap by their combined radii and get a bad state.
        overlap = load([{'x': 0, 'y': 0, 'd': 6}, {'x': 0, 'y': 0, 'd': 6}])
        assert abs(overlap['analysis']['gap'] + 6) < .001, overlap
        assert overlap['cls'] == 'hint clearance-bad', overlap
        assert 'overlap by 6.00 mm' in overlap['text'], overlap['text']
        assert 'overlaps by 6.00 mm' in overlap['panel'], overlap['panel']

        # One physical hole is insufficient unless mirroring creates another.
        single = load([{'x': 10, 'y': 0, 'd': 6}])
        assert single['analysis'] is None, single
        assert single['cls'] == 'hint clearance-neutral', single
        assert 'add a second hole' in single['text'], single['text']
        mirrored = load([{'x': 10, 'y': 0, 'd': 6}], mirror=True)
        assert mirrored['analysis'] and mirrored['analysis']['count'] == 2, mirrored
        assert abs(mirrored['analysis']['gap'] - 14) < .001, mirrored
        assert 'mirrored copy' in mirrored['text'], mirrored['text']

        # Removing all holes must clear both old measurements and warning classes.
        empty = load([])
        assert empty['analysis'] is None, empty
        assert empty['text'] == 'Hole-to-hole spacing: add at least two holes to compare gaps.', empty
        assert empty['cls'] == 'hint clearance-neutral', empty
        assert js("document.getElementById('clearance-summary').className") == 'hint clearance-neutral'
        assert js("document.getElementById('clearance-summary').textContent") == 'Add holes to check edge clearance.'
        assert '23.00 mm' not in empty['panel'] and 'Nearest hole' not in empty['panel'], empty['panel']

        print(json.dumps({'ok': True, 'healthyGapMm': healthy['analysis']['gap'],
                          'warningGapMm': warning['analysis']['gap'],
                          'overlapMm': -overlap['analysis']['gap'],
                          'mirroredGapMm': mirrored['analysis']['gap'],
                          'emptyReset': True}, indent=2))
    finally:
        chrome.terminate()
        server.shutdown()
