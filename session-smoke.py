#!/usr/bin/env python3
"""Headless smoke test for the session save status and browser-local recovery snapshot.

Checks the narrowest effective hole pair, per-hole nearest-hole readouts,
overlap/warning/healthy states, mirrored-hole participation, and reset after
removing every hole. Requires Chrome and websocket-client.
"""
import http.server, json, os, subprocess, tempfile, threading, time, urllib.request
import websocket

root = os.path.abspath(os.path.join(os.path.dirname(__file__), 'public'))
parts_available = False


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=root, **kwargs)

    def do_GET(self):
        if self.path == '/api/parts':
            if parts_available:
                payload = json.dumps({'parts': []}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            else:
                self.send_error(503, 'parts library unavailable')
            return
        super().do_GET()

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
        # Ensure the editor panels are visible for the desktop onboarding steps.
        call('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 960, 'deviceScaleFactor': 1, 'mobile': False})
        call('Page.navigate', {'url': f'http://127.0.0.1:{server.server_port}/cad.html'})
        for _ in range(150):
            if js("document.readyState === 'complete' && !!window.__solid"
                  " && !!document.querySelector('#session-status')"):
                break
            time.sleep(.1)
        else:
            raise AssertionError('Modeler did not load')
        time.sleep(.5)

        def nav():
            call('Page.navigate', {'url': f'http://127.0.0.1:{server.server_port}/cad.html'})
            time.sleep(.3)
            for _ in range(150):
                if js("document.readyState === 'complete' && !!window.__solid && window.__solid.session().armed || (window.__solid && window.__solid.session().banner)"):
                    break
                time.sleep(.1)
            else:
                raise AssertionError('Modeler did not load')
            time.sleep(.3)

        S = lambda: js('window.__solid.session()')
        # Orientation strip appears on first visit, persists dismissal locally,
        # and remains discoverable through its compact reopen button.
        assert js("!document.querySelector('#orientation-strip').hidden")
        assert js("document.querySelectorAll('#orientation-strip li').length") == 4
        js("document.querySelector('#orientation-strip a[data-guide-target=\"starter-shape\"]') && document.querySelector('#orientation-strip a[data-guide-target=\"sketch-dimension\"]')")
        js("document.querySelector('#orientation-strip a[data-guide-target=\"starter-shape\"]').click()")
        assert js("document.activeElement.classList.contains('chip') && document.activeElement.closest('#sketch-fields .shape-picker') !== null")
        assert js("document.activeElement.classList.contains('guide-highlight')")
        js("document.querySelector('#orientation-strip a[data-guide-target=\"sketch-dimension\"]').click()")
        assert js("document.activeElement === document.querySelector('#sketch-fields input')")
        js("document.querySelector('#orientation-strip a[data-guide-target=\"btn-printability\"]').click()")
        assert js("document.activeElement.id") == 'btn-printability'
        js("document.querySelector('#orientation-strip a[data-guide-target=\"btn-handoff\"]').click()")
        assert js("document.activeElement.id") == 'btn-handoff'
        js("document.querySelector('#orientation-dismiss').click()")
        assert js("document.querySelector('#orientation-strip').hidden && !document.querySelector('#orientation-show').hidden")
        assert js("localStorage.getItem('websolid.orientationDismissed.v1') === '1'")
        nav()
        assert js("document.querySelector('#orientation-strip').hidden && !document.querySelector('#orientation-show').hidden")
        js("document.querySelector('#orientation-show').click()")
        assert js("!document.querySelector('#orientation-strip').hidden")
        assert js("!!document.querySelector('#orientation-strip a')")
        # fresh load seeds a local snapshot for the initial part; no recovery banner
        js("localStorage.clear()")
        nav()
        s = S()
        assert s['state'] == 'local' and not s['banner'] and s['stored'], s

        # edit -> snapshot flush -> local state
        js("(function(){var p=window.__solid.getPart();p.name='Recovery bracket';window.__solid.loadPart(p,null);})()")
        js("window.__solid.snapshotNow()")
        # Give the saved snapshot deterministic age metadata for the recovery banner.
        js("(function(){var k='websolid.sessionSnapshot.v1',x=JSON.parse(localStorage.getItem(k));x.savedAt=new Date(Date.now()-5*60000).toISOString();localStorage.setItem(k,JSON.stringify(x));})()")
        s = S()
        assert s['stored'] and s['state'] == 'local' and 'this device' in s['status'], s

        # reload: differing local copy -> banner, status says restore
        js("localStorage.setItem('websolid.sessionSnapshot.v1', localStorage.getItem('websolid.sessionSnapshot.v1'))")
        nav()
        s = S()
        assert s['banner'] and s['state'] == 'restore', s
        assert js("document.querySelector('#restore-name').textContent") == 'Recovery bracket'
        age_text = js("document.querySelector('#restore-when').textContent")
        assert ('just now' in age_text or 'minute' in age_text) and '·' in age_text, age_text
        assert js("window.__solid.getPart().name") != 'Recovery bracket'
        rep = js("document.querySelector('#restore-replace').textContent")
        active = js("window.__solid.getPart().name")
        assert 'replaces' in rep and active in rep, rep
        discard_label = js("document.querySelector('#btn-discard-session').textContent")
        assert discard_label == 'Keep open part & discard snapshot', discard_label
        discard_title = js("document.querySelector('#btn-discard-session').title")
        assert 'discard' in discard_title.lower() and 'snapshot' in discard_title.lower(), discard_title
        js("window.__solid.restoreSession()")
        s = S()
        assert not s['banner'] and js("window.__solid.getPart().name") == 'Recovery bracket', s
        assert s['state'] == 'local', s
        assert s['localOnlyNote'] is True and s['restoredLocalOnly'] is True, s
        note_text = js("document.querySelector('#local-only-detail').textContent")
        assert 'only copy' in note_text.lower() or 'loses it' in note_text.lower(), note_text
        # Clicking Save file on the post-restore notice exports the part file and clears the notice
        js("document.querySelector('#btn-local-only-save').click()")
        s_after_save = S()
        assert s_after_save['localOnlyNote'] is False and s_after_save['restoredLocalOnly'] is False, s_after_save
        assert s_after_save['partFileSaved'] is True and s_after_save['state'] == 'exported', s_after_save

        # reload with identical part: no banner
        nav()
        # default differs so banner appears; test restore + dismiss button, then discard
        s = S()
        assert s['banner'] and not s['localOnlyNote'], s
        js("window.__solid.restoreSession()")
        s_rest = S()
        assert s_rest['localOnlyNote'] is True, s_rest
        js("document.querySelector('#btn-local-only-dismiss').click()")
        s_dis = S()
        assert s_dis['localOnlyNote'] is False and s_dis['restoredLocalOnly'] is False, s_dis
        nav()
        s = S()
        assert s['banner'], s
        js("window.__solid.discardSession('x')")
        s = S()
        assert not s['banner'] and not s['localOnlyNote'] and not s['stored'] and s['state'] == 'unsaved', s

        # storage failure -> visible not saved
        js("Storage.prototype.setItem=function(){throw new Error('quota')}")
        js("(function(){var p=window.__solid.getPart();p.name='Blocked';window.__solid.loadPart(p,null);})()")
        js("window.__solid.snapshotNow()")
        s = S()
        assert s['state'] == 'warning' and s['blocked'] and 'Not saved' in s['status'], s

        # Server-library availability gates the server-save controls, while
        # portable file export remains available. Test both startup outcomes.
        parts_available = False
        nav()
        for _ in range(30):
            if js("document.querySelector('#btn-save').getAttribute('aria-disabled') === 'true'"):
                break
            time.sleep(.1)
        assert js("document.querySelector('#btn-save').getAttribute('aria-disabled')") == 'true'
        assert js("document.querySelector('#btn-save').disabled")
        assert js("document.querySelector('#btn-save-as').getAttribute('aria-disabled')") == 'true'
        assert js("document.querySelector('#btn-save-as').disabled")
        assert not js("document.querySelector('#btn-save').classList.contains('primary')")
        assert js("!document.querySelector('#btn-savefile').disabled")
        assert js("document.querySelectorAll('#parts-library-hint').length") == 1
        assert not js("document.querySelector('#parts-library-hint').hidden")
        assert 'unavailable' in js("document.querySelector('#parts-library-hint').textContent").lower()
        assert 'save file' in js("document.querySelector('#parts-library-hint').textContent").lower()
        assert js("document.querySelector('#parts-library-hint').getAttribute('aria-live')") == 'polite'
        assert js("document.querySelector('#btn-save').getAttribute('aria-describedby')") == 'parts-library-hint'
        assert js("document.querySelector('#btn-save-as').getAttribute('aria-describedby')") == 'parts-library-hint'
        assert js("!!document.querySelector('#btn-parts-retry')")
        js("document.querySelector('#btn-save').click()")
        assert js("document.querySelector('#btn-save').disabled && !document.querySelector('#btn-savefile').disabled")
        assert 'unavailable' in js("document.querySelector('.handoff-save').textContent").lower()
        assert 'save file' in js("document.querySelector('.handoff-save').textContent").lower()

        # While library is unavailable, the local session chip title explains the server library is unavailable,
        # Ctrl+S warns instead of failing silently, and exporting a part file updates the chip to 'exported'.
        js("(function(){var p=window.__solid.getPart();p.name='Offline export test';window.__solid.loadPart(p,null);window.__solid.snapshotNow();})()")
        assert js("window.__solid.session().state") == 'local'
        assert 'unavailable' in (js("window.__solid.session().title") or '').lower()
        js("document.dispatchEvent(new KeyboardEvent('keydown', {key:'s', ctrlKey:true, bubbles:true, cancelable:true}))")
        assert 'unavailable' in js("document.querySelector('#toast').textContent").lower()
        assert 'save file' in js("document.querySelector('#toast').textContent").lower()
        js("window.__solid.exportPartFile()")
        s_exp = js("window.__solid.session()")
        assert s_exp['partFileSaved'] is True
        assert s_exp['state'] == 'exported'
        assert 'part file saved' in s_exp['status'].lower()
        assert 'unavailable' in (s_exp['title'] or '').lower()
        assert 'page session only' in (s_exp['title'] or '').lower()
        assert 'cannot tell whether' in (s_exp['title'] or '').lower()

        # Export acknowledgement is session-scoped and explicitly disclaims device-file verification.
        assert 'cannot check whether an earlier export still exists' in open(os.path.join(root, 'cad.html')).read().lower()
        assert 'cannot tell whether' in js("document.querySelector('#session-status').getAttribute('title')").lower()

        # Editing after export invalidates partFileSaved and returns the chip to 'local'.
        js("(function(){var p=window.__solid.getPart();p.name='Offline export edited';window.__solid.loadPart(p,null);window.__solid.snapshotNow();})()")
        s_after_edit = js("window.__solid.session()")
        assert s_after_edit['partFileSaved'] is False
        assert s_after_edit['state'] == 'local'

        # Ctrl+Shift+S exports a part file via keyboard shortcut.
        js("document.dispatchEvent(new KeyboardEvent('keydown', {key:'S', ctrlKey:true, shiftKey:true, bubbles:true, cancelable:true}))")
        assert js("window.__solid.session().partFileSaved") is True
        assert js("window.__solid.session().state") == 'exported'

        # New part while library is unavailable recommends Save file, not Save part.
        js("document.querySelector('#btn-new').click()")
        assert 'save file' in js("document.querySelector('#toast').textContent").lower()

        # When the server comes back, clicking the inline retry enables saving
        # without requiring a full page reload.
        parts_available = True
        js("document.querySelector('#btn-parts-retry').click()")
        for _ in range(30):
            if js("document.querySelector('#btn-save').getAttribute('aria-disabled') === 'false'"):
                break
            time.sleep(.1)
        assert js("document.querySelectorAll('#parts-library-hint').length") == 1
        assert js("document.querySelector('#btn-save').getAttribute('aria-disabled')") == 'false'
        assert not js("document.querySelector('#btn-save').disabled")
        assert js("document.querySelector('#btn-save-as').getAttribute('aria-disabled')") == 'false'
        assert not js("document.querySelector('#btn-save-as').disabled")
        assert js("document.querySelector('#parts-library-hint').hidden")
        assert not js("document.querySelector('#btn-parts-retry')")
        assert 'server-side storage' in js("document.querySelector('.handoff-save').textContent").lower()

        # Full startup with the server available also enables the buttons cleanly.
        nav()
        for _ in range(30):
            if js("document.querySelector('#btn-save').getAttribute('aria-disabled') === 'false'"):
                break
            time.sleep(.1)
        assert js("document.querySelector('#btn-save').getAttribute('aria-disabled')") == 'false'
        assert not js("document.querySelector('#btn-save').disabled")
        assert js("document.querySelector('#btn-save-as').getAttribute('aria-disabled')") == 'false'
        assert not js("document.querySelector('#btn-save-as').disabled")
        assert js("document.querySelector('#parts-library-hint').hidden")

        print(json.dumps({'ok': True}))
    finally:
        chrome.terminate()
        server.shutdown()
