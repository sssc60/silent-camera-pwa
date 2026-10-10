"""使い方: リポジトリのルートで python3 tests/browser_smoke.py。

Playwright + Chromium の模擬カメラで実際のJPEG/動画を生成します。
iPhoneの実機・OS共有シートの確認はREADMEの手順を別途実施してください。
サーバー・ブラウザ・ダウンロード用一時ディレクトリは終了時に破棄します。
"""
import functools
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import unittest

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]

INSTRUMENT = """(() => {
  window.testStreams = [];
  window.createdURLs = [];
  window.revokedURLs = [];
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await gum(constraints);
    window.testStreams.push(stream);
    return stream;
  };
  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => { const url = create(blob); window.createdURLs.push(url); return url; };
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (url) => { window.revokedURLs.push(url); revoke(url); };
})()"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


class CameraSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 親から配信して、GitHub Pagesと同じサブディレクトリ構成を検証します。
        handler = functools.partial(QuietHandler, directory=str(ROOT.parent))
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}/{ROOT.name}/'
        cls.pw = sync_playwright().start()
        executable = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
        cls.browser = cls.pw.chromium.launch(
            executable_path=executable,
            args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        )

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 390, 'height': 844},
                                                is_mobile=True, has_touch=True, accept_downloads=True)
        self.context.grant_permissions(['camera', 'microphone'])
        self.context.add_init_script(INSTRUMENT)
        self.page = self.context.new_page()
        self.errors = []
        self.requests = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.on('request', lambda request: self.requests.append(request.url))
        self.temp = tempfile.TemporaryDirectory(prefix='temoto-test-')

    def tearDown(self):
        self.context.close()
        self.temp.cleanup()
        self.assertEqual(self.errors, [], 'JavaScript runtime errors')

    def open(self, extra_script=None):
        if extra_script:
            self.context.add_init_script(extra_script)
        self.page.goto(self.url)
        expect(self.page.locator('#start-camera')).to_be_visible()

    def start(self):
        self.page.locator('#start-camera').click()
        expect(self.page.locator('#camera-status-text')).to_have_text('カメラ使用中')
        self.page.wait_for_function("() => document.querySelector('#camera-video').videoWidth > 0 && document.querySelector('#camera-video').readyState >= 2")

    def photo(self):
        self.start()
        dimensions = self.page.locator('#camera-video').evaluate('(v) => [v.videoWidth, v.videoHeight]')
        self.page.locator('#capture').click()
        expect(self.page.locator('#photo-preview')).to_be_visible()
        self.page.wait_for_function("() => document.querySelector('#photo-preview').naturalWidth > 0")
        return dimensions

    def assert_tracks_stopped(self):
        self.assertTrue(self.page.evaluate("testStreams.flatMap(s => s.getTracks()).every(t => t.readyState === 'ended')"))

    def download(self):
        with self.page.expect_download() as event:
            self.page.locator('#share-save').click()
        download = event.value
        path = Path(self.temp.name) / download.suggested_filename
        download.save_as(path)
        self.assertGreater(path.stat().st_size, 0)
        return path

    def hide(self):
        self.page.evaluate("Object.defineProperty(document, 'visibilityState', {configurable:true, value:'hidden'}); document.dispatchEvent(new Event('visibilitychange'))")

    def test_initial_privacy_and_layout(self):
        self.open()
        self.assertEqual(self.page.evaluate('testStreams.length'), 0)
        expect(self.page.locator('#camera-status-text')).to_have_text('カメラ停止中')
        for width, height in [(390, 844), (320, 568), (844, 390)]:
            self.page.set_viewport_size({'width': width, 'height': height})
            self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
            for selector in ['#start-camera', '#capture', '#photo-mode', '#video-mode']:
                self.assertGreaterEqual(self.page.locator(selector).bounding_box()['height'], 44)

    def test_photo_jpeg_resolution_download_and_release(self):
        self.open("Object.defineProperty(navigator, 'canShare', {value: () => false})")
        width, height = self.photo()
        self.assertEqual(self.page.locator('#photo-preview').evaluate('(v) => [v.naturalWidth, v.naturalHeight]'), [width, height])
        self.assert_tracks_stopped()
        expect(self.page.locator('#camera-status-text')).to_have_text('カメラ停止中')
        path = self.download()
        self.assertEqual(path.suffix, '.jpg')
        self.assertEqual(path.read_bytes()[:3], b'\xff\xd8\xff')
        self.page.locator('#retake').click()
        expect(self.page.locator('#camera-status-text')).to_have_text('カメラ使用中')
        self.assertEqual(self.page.evaluate('revokedURLs'), self.page.evaluate('createdURLs'))
        self.assertTrue(all(url.startswith(self.url) or url.startswith('blob:') for url in self.requests))

    def test_camera_switch_and_manual_stop(self):
        self.open()
        self.start()
        self.page.locator('#switch-camera').click()
        self.page.wait_for_function('() => testStreams.length === 2')
        self.assertTrue(self.page.evaluate("testStreams[0].getTracks().every(t => t.readyState === 'ended')"))
        expect(self.page.locator('#camera-status-text')).to_have_text('カメラ使用中')
        self.page.locator('#stop-camera').click()
        self.assert_tracks_stopped()
        expect(self.page.locator('#start-camera')).to_be_visible()

    def test_camera_denied(self):
        self.open("navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); }")
        self.page.locator('#start-camera').click()
        expect(self.page.locator('#message')).to_contain_text('カメラの利用が許可されませんでした')
        expect(self.page.locator('#start-camera')).to_be_enabled()

    def test_pending_permission_is_cancelled_on_hide(self):
        self.open("window.lateStopped = 0; navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.resolveCamera = resolve; });")
        self.page.locator('#start-camera').click()
        self.page.wait_for_function('() => typeof resolveCamera === "function"')
        self.hide()
        self.page.evaluate('resolveCamera({getTracks: () => [{stop: () => lateStopped++}]})')
        self.page.wait_for_function('() => lateStopped === 1')
        expect(self.page.locator('#camera-status-text')).to_have_text('カメラ停止中')

    def test_microphone_denied_does_not_record(self):
        self.open("const realGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = c => c.audio ? Promise.reject(new DOMException('denied', 'NotAllowedError')) : realGum(c);")
        self.start()
        self.page.locator('#video-mode').click()
        self.page.locator('#audio-enabled').check()
        self.page.locator('#capture').click()
        expect(self.page.locator('#message')).to_contain_text('マイクの利用が許可されませんでした')
        expect(self.page.locator('#recording-status')).to_be_hidden()
        expect(self.page.locator('#camera-status-text')).to_have_text('カメラ使用中')

    def record_and_check(self, audio):
        self.open("Object.defineProperty(navigator, 'canShare', {value: () => false})")
        self.start()
        self.page.locator('#video-mode').click()
        if audio:
            self.page.locator('#audio-enabled').check()
        self.page.locator('#capture').click()
        expect(self.page.locator('#recording-status')).to_be_visible()
        expect(self.page.locator('#switch-camera')).to_be_disabled()
        expect(self.page.locator('#audio-enabled')).to_be_disabled()
        self.page.wait_for_function("() => document.querySelector('#elapsed').textContent !== '00:00'")
        self.page.locator('#capture').click()
        expect(self.page.locator('#video-preview')).to_be_visible()
        self.assert_tracks_stopped()
        self.assertTrue(self.page.locator('#video-preview').evaluate('(v) => v.muted'))
        path = self.download()
        details = self.page.locator('#file-details').inner_text()
        self.assertIn(path.suffix[1:].upper(), details)
        self.assertIn('音声あり' if audio else '音声なし', details)
        if shutil.which('ffprobe'):
            result = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(path)], check=True, capture_output=True, text=True)
            streams = json.loads(result.stdout)['streams']
            types = [stream['codec_type'] for stream in streams]
            self.assertIn('video', types)
            self.assertEqual('audio' in types, audio)
        else:
            print('  ffprobe unavailable: codec/track inspection unrun')

    def test_real_recording_without_audio(self):
        self.record_and_check(False)

    def test_real_recording_with_audio(self):
        self.record_and_check(True)

    def test_recording_stops_on_hide_without_resume(self):
        self.open()
        self.start()
        self.page.locator('#video-mode').click()
        self.page.locator('#capture').click()
        expect(self.page.locator('#recording-status')).to_be_visible()
        self.page.wait_for_function("() => document.querySelector('#elapsed').textContent !== '00:00'")
        self.hide()
        self.assert_tracks_stopped()
        expect(self.page.locator('#video-preview')).to_be_visible()
        count = self.page.evaluate('testStreams.length')
        self.page.evaluate("Object.defineProperty(document, 'visibilityState', {configurable:true, value:'visible'}); document.dispatchEvent(new Event('visibilitychange'))")
        self.assertEqual(self.page.evaluate('testStreams.length'), count)
        expect(self.page.locator('#camera-status-text')).to_have_text('カメラ停止中')

    def test_unsupported_recorder_preserves_photo(self):
        self.open('MediaRecorder.isTypeSupported = () => false;')
        self.start()
        self.page.locator('#video-mode').click()
        expect(self.page.locator('#capture')).to_be_disabled()
        expect(self.page.locator('#message')).to_contain_text('対応する動画形式がありません')
        self.page.locator('#photo-mode').click()
        self.page.locator('#capture').click()
        expect(self.page.locator('#photo-preview')).to_be_visible()

    def test_recorder_failure(self):
        self.open('const NativeRecorder = MediaRecorder; window.MediaRecorder = class extends NativeRecorder { constructor(...args) { super(...args); window.testRecorder = this; } };')
        self.start()
        self.page.locator('#video-mode').click()
        self.page.locator('#capture').click()
        expect(self.page.locator('#recording-status')).to_be_visible()
        self.page.evaluate("testRecorder.onerror(new Event('error'))")
        expect(self.page.locator('#message')).to_contain_text('録画に失敗')
        expect(self.page.locator('#video-preview')).to_be_hidden()
        self.assert_tracks_stopped()

    def test_mp4_priority_and_actual_output_extension(self):
        self.open("""window.mimeChecks = []; window.chosenMime = null;
          window.MediaRecorder = class {
            static isTypeSupported(type) { mimeChecks.push(type); return type === 'video/mp4' || type === 'video/webm'; }
            constructor(stream, options) { chosenMime = options.mimeType; this.mimeType = 'video/webm'; this.state = 'inactive'; }
            start() { this.state = 'recording'; }
            stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable({data: new Blob(['format-test'], {type: this.mimeType})}); this.onstop(); }); }
          }; Object.defineProperty(navigator, 'canShare', {value: () => false});""")
        self.start()
        self.page.locator('#video-mode').click()
        self.page.locator('#capture').click()
        expect(self.page.locator('#recording-status')).to_be_visible()
        self.assertEqual(self.page.evaluate('chosenMime'), 'video/mp4')
        self.page.locator('#capture').click()
        expect(self.page.locator('#file-details')).to_contain_text('WEBM')
        self.assertEqual(self.download().suffix, '.webm')

    def test_share_success_uses_file_and_canshare(self):
        self.open("window.shareChecks = []; window.shared = null; Object.defineProperty(navigator, 'canShare', {value: ({files}) => { shareChecks.push(files[0].type); return true; }}); Object.defineProperty(navigator, 'share', {value: async ({files}) => { shared = {name: files[0].name, type: files[0].type, size: files[0].size}; }});")
        self.photo()
        self.page.locator('#share-save').click()
        expect(self.page.locator('#message')).to_contain_text('保存できたか')
        self.assertEqual(self.page.evaluate('shareChecks'), ['image/jpeg'])
        shared = self.page.evaluate('shared')
        self.assertEqual(shared['type'], 'image/jpeg')
        self.assertTrue(shared['name'].endswith('.jpg'))
        self.assertGreater(shared['size'], 0)

    def test_share_cancel_keeps_preview(self):
        self.open("Object.defineProperty(navigator, 'canShare', {value: () => true}); Object.defineProperty(navigator, 'share', {value: async () => { throw new DOMException('cancel', 'AbortError'); }});")
        self.photo()
        self.page.locator('#share-save').click()
        expect(self.page.locator('#message')).to_contain_text('キャンセル')
        expect(self.page.locator('#photo-preview')).to_be_visible()
        expect(self.page.locator('#share-save')).to_have_text('共有して保存')

    def test_share_failure_falls_back_on_next_tap(self):
        self.open("Object.defineProperty(navigator, 'canShare', {value: () => true}); Object.defineProperty(navigator, 'share', {value: async () => { throw new DOMException('failed', 'DataError'); }});")
        self.photo()
        self.page.locator('#share-save').click()
        expect(self.page.locator('#share-save')).to_have_text('ダウンロードして保存')
        self.assertEqual(self.download().suffix, '.jpg')

    def test_canshare_throw_falls_back(self):
        self.open("Object.defineProperty(navigator, 'canShare', {value: () => { throw new Error('unsupported'); }});")
        self.photo()
        self.assertEqual(self.download().suffix, '.jpg')

    def test_pagehide_releases_capture(self):
        self.open()
        self.photo()
        self.page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}))")
        self.assertEqual(self.page.evaluate('createdURLs'), self.page.evaluate('revokedURLs'))
        self.page.evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}))")
        expect(self.page.locator('#start-camera')).to_be_visible()
        expect(self.page.locator('#photo-preview')).to_be_hidden()

    def test_pending_share_cannot_modify_new_capture_after_pagehide(self):
        self.open("Object.defineProperty(navigator, 'canShare', {value: () => true}); Object.defineProperty(navigator, 'share', {value: () => new Promise((resolve, reject) => {window.rejectShare = reject;})});")
        self.photo()
        self.page.locator('#share-save').click()
        self.hide()
        expect(self.page.locator('#retake')).to_be_disabled()
        self.page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true})); Object.defineProperty(document, 'visibilityState', {configurable:true, value:'visible'}); window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}));")
        self.photo()
        self.page.evaluate("rejectShare(new DOMException('failed', 'DataError'))")
        expect(self.page.locator('#share-save')).to_have_text('共有して保存')
        expect(self.page.locator('#photo-preview')).to_be_visible()
        expect(self.page.locator('#retake')).to_be_enabled()

    def test_offline_shell_and_no_capture_storage(self):
        self.open()
        self.page.wait_for_function('() => navigator.serviceWorker.controller !== null')
        manifest = self.page.evaluate("fetch('./manifest.json').then(r => r.json())")
        self.assertEqual(manifest['start_url'], './')
        self.assertNotIn('orientation', manifest)
        self.photo()
        self.assertEqual(self.page.evaluate('localStorage.length'), 0)
        self.assertEqual(self.page.evaluate('document.cookie'), '')
        self.assertEqual(self.page.evaluate('indexedDB.databases().then(d => d.length)'), 0)
        cached = self.page.evaluate("caches.keys().then(async names => (await Promise.all(names.map(async n => (await (await caches.open(n)).keys()).map(r => r.url)))).flat())")
        self.assertEqual(len(cached), 10)
        self.assertTrue(all(url.startswith(self.url) for url in cached))
        self.assertTrue(all(not url.startswith('blob:') for url in cached))
        self.context.set_offline(True)
        self.page.reload()
        expect(self.page.locator('#start-camera')).to_be_visible()
        expect(self.page.locator('#camera-status-text')).to_have_text('カメラ停止中')


if __name__ == '__main__':
    unittest.main(verbosity=2)
