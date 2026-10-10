/* 設定・使い方:
 * HTTPSで配信してください（PC開発時はlocalhostも利用可能）。外部依存はありません。
 * カメラ起動 → 写真/動画 → 撮影 → 共有して保存。音声は録画開始前に選択します。
 * JPEG_QUALITY、MAX_ZOOM、MIME_CANDIDATES は下記で調整できます。
 * 連続撮影中はプレビュー小窓でライブ映像を表示。非表示時には必ず停止します。
 * 撮影データはメモリと一時Blob URLだけに保持し、永続保存・通信は行いません。
 * サイト独自のシャッター音・操作音は一切再生しません。
 */
'use strict';

(() => {
  const JPEG_QUALITY = 0.92;
  const MAX_ZOOM = 4; // デジタルズーム。光学ズームではなく中央の切り出しです。
  // iPhone SafariのMP4を優先。固定拡張子にせず、実際の出力MIMEを確認します。
  const MIME_CANDIDATES = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const $ = (id) => document.getElementById(id);
  const ui = {
    camera: $('camera-video'), photo: $('photo-preview'), video: $('video-preview'),
    empty: $('empty-state'), start: $('start-camera'), status: $('camera-status'),
    statusText: $('camera-status-text'), recording: $('recording-status'), elapsed: $('elapsed'),
    caption: $('live-caption'), message: $('message'), photoMode: $('photo-mode'),
    videoMode: $('video-mode'), switch: $('switch-camera'), stop: $('stop-camera'),
    capture: $('capture'), audioOption: $('audio-option'), audio: $('audio-enabled'),
    audioLabel: $('audio-label'), hint: $('capture-hint'), captureControls: $('capture-controls'),
    previewControls: $('preview-controls'), details: $('file-details'), share: $('share-save'),
    retake: $('retake'), viewfinder: document.querySelector('.viewfinder'),
    canvas: $('zoom-preview'), zoomControls: $('zoom-controls'), zoom: $('zoom-level'),
    zoomValue: $('zoom-value'), zoomIn: $('zoom-in'), zoomOut: $('zoom-out'), zoomReset: $('zoom-reset'),
    expand: $('expand-view'), continuous: $('continuous'), previewStop: $('preview-stop-camera'),
    download: $('download-save'),
  };
  let mode = 'photo';
  let facing = 'environment';
  let cameraStream = null;
  let micStream = null;
  let recorder = null;
  let phase = 'idle';
  let busy = false;
  let operation = 0; // 遅れて返ってくる権限要求・変換処理を無効化する世代番号。
  let capturedFile = null;
  let capturedURL = null;
  let recordingStarted = 0;
  let clock = null;
  let stopWatchdog = null;
  let zoom = 1;
  let frameRequest = null;
  let lastFrameTime = 0;
  let digitalRecordingStream = null;
  let videoZoomAvailable = typeof ui.canvas.captureStream === 'function';
  const pointers = new Map();
  let pinch = null;
  const frameContext = ui.canvas.getContext('2d', { alpha: false });
  videoZoomAvailable = videoZoomAvailable && Boolean(frameContext);

  function cameraIsActive() {
    return Boolean(cameraStream?.getVideoTracks().some((track) => track.readyState === 'live'));
  }

  function drawZoomedFrame(context, width, height) {
    const sourceWidth = ui.camera.videoWidth;
    const sourceHeight = ui.camera.videoHeight;
    if (!sourceWidth || !sourceHeight) return false;
    // 録画途中の回転では出力サイズを固定し、中央を切り出して歪みを防ぎます。
    const ratio = width / height;
    const cropWidth = Math.min(sourceWidth, sourceHeight * ratio) / zoom;
    const cropHeight = cropWidth / ratio;
    context.drawImage(ui.camera, (sourceWidth - cropWidth) / 2, (sourceHeight - cropHeight) / 2,
      cropWidth, cropHeight, 0, 0, width, height);
    return true;
  }

  function drawLiveCanvas() {
    if (!frameContext || !ui.camera.videoWidth || ui.camera.readyState < 2) return;
    if (!digitalRecordingStream && (ui.canvas.width !== ui.camera.videoWidth || ui.canvas.height !== ui.camera.videoHeight)) {
      ui.canvas.width = ui.camera.videoWidth;
      ui.canvas.height = ui.camera.videoHeight;
    }
    drawZoomedFrame(frameContext, ui.canvas.width, ui.canvas.height);
  }

  function renderFrames(time) {
    if (!cameraIsActive() || document.visibilityState === 'hidden') {
      frameRequest = null;
      return;
    }
    if ((zoom > 1 || digitalRecordingStream) && time - lastFrameTime >= 1000 / 30) {
      try {
        drawLiveCanvas();
      } catch {
        if (recorder) recorder.onerror?.(new Event('error'));
        else {
          zoom = 1;
          render();
          tell('ズーム映像を表示できませんでした。1倍で撮影してください。', true);
        }
      }
      lastFrameTime = time;
    }
    if (cameraIsActive()) frameRequest = requestAnimationFrame(renderFrames);
  }

  function setZoom(value) {
    if (!cameraIsActive() || capturedFile || busy || (mode === 'video' && !videoZoomAvailable)) return;
    zoom = Math.round(Math.min(MAX_ZOOM, Math.max(1, Number(value))) * 10) / 10;
    try {
      drawLiveCanvas();
    } catch {
      zoom = 1;
      if (recorder) recorder.onerror?.(new Event('error'));
      else tell('ズーム映像を表示できませんでした。1倍で撮影してください。', true);
    }
    render();
  }

  function stopDigitalRecordingStream() {
    digitalRecordingStream?.getTracks().forEach((track) => track.stop());
    digitalRecordingStream = null;
  }

  function tell(message, error = false) {
    ui.message.textContent = message;
    ui.message.classList.toggle('error', error);
  }

  function supportedMime() {
    if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return null;
    try {
      return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) || null;
    } catch {
      return null;
    }
  }

  function videoFormat(type) {
    const base = (type || '').split(';')[0].trim().toLowerCase();
    return { 'video/mp4': 'mp4', 'video/webm': 'webm' }[base] || null;
  }

  function render() {
    const cameraActive = cameraIsActive();
    const recording = phase === 'recording';
    const preview = Boolean(capturedFile);
    const canvasLive = zoom > 1 || Boolean(digitalRecordingStream);
    // iOSの元映像の再生を止めないよう、ズームCanvasは表示中のvideoに重ねます。
    ui.camera.hidden = !cameraActive;
    ui.camera.setAttribute('aria-hidden', String(canvasLive));
    ui.canvas.hidden = !cameraActive || !canvasLive;
    ui.empty.hidden = cameraActive || preview;
    ui.start.disabled = busy;
    ui.start.textContent = phase === 'starting' ? 'カメラを起動中…' : 'カメラを起動';
    ui.status.classList.toggle('active', cameraActive);
    ui.statusText.textContent = cameraActive ? (micStream ? 'カメラ・マイク使用中' : 'カメラ使用中') : 'カメラ停止中';
    ui.recording.hidden = !recording;
    ui.viewfinder.classList.toggle('recording', recording);
    ui.viewfinder.classList.toggle('live', cameraActive && !preview);
    ui.viewfinder.classList.toggle('session-preview', cameraActive && preview);
    ui.caption.hidden = !cameraActive;
    ui.caption.textContent = preview ? 'ライブ · カメラ維持中' : facing === 'user' ? '前面カメラ · プレビューは鏡表示' : '背面カメラ';
    ui.camera.classList.toggle('mirrored', facing === 'user');
    ui.canvas.classList.toggle('mirrored', facing === 'user');
    ui.zoomControls.hidden = !cameraActive || preview;
    const zoomDisabled = busy || !frameContext || (mode === 'video' && !videoZoomAvailable);
    ui.zoom.disabled = zoomDisabled;
    ui.zoomIn.disabled = zoomDisabled || zoom >= MAX_ZOOM;
    ui.zoomOut.disabled = ui.zoomReset.disabled = zoomDisabled || zoom <= 1;
    ui.zoom.value = String(zoom);
    ui.zoomValue.textContent = `${zoom.toFixed(1)}×`;
    ui.expand.hidden = !cameraActive || preview;
    ui.expand.textContent = document.body.classList.contains('expanded') ? '通常表示に戻す' : '画面を広げる';
    ui.expand.setAttribute('aria-pressed', String(document.body.classList.contains('expanded')));
    ui.continuous.disabled = busy || recording;
    ui.previewStop.hidden = !cameraActive || !preview;
    ui.previewStop.disabled = busy;
    if (!cameraActive || preview) document.body.classList.remove('expanded');
    ui.captureControls.hidden = preview;
    ui.previewControls.hidden = !preview;
    ui.photoMode.classList.toggle('selected', mode === 'photo');
    ui.videoMode.classList.toggle('selected', mode === 'video');
    ui.photoMode.setAttribute('aria-pressed', String(mode === 'photo'));
    ui.videoMode.setAttribute('aria-pressed', String(mode === 'video'));
    ui.photoMode.disabled = ui.videoMode.disabled = busy || recording;
    ui.switch.disabled = !cameraActive || busy || recording;
    ui.stop.disabled = !cameraActive || busy;
    ui.capture.disabled = !cameraActive || busy || (mode === 'video' && !supportedMime());
    ui.capture.classList.toggle('video-mode', mode === 'video');
    ui.capture.classList.toggle('is-recording', recording);
    ui.capture.setAttribute('aria-label', recording ? '録画を停止' : mode === 'photo' ? '写真を撮影' : '録画を開始');
    ui.audioOption.hidden = mode !== 'video';
    ui.audio.disabled = busy || recording;
    ui.audioLabel.textContent = ui.audio.checked ? 'あり' : 'なし';
    ui.hint.textContent = mode === 'photo' ? 'JPEG · ピンチでズーム' : '形式を自動選択';
    ui.hint.hidden = mode === 'video';
    ui.share.disabled = ui.retake.disabled = ui.download.disabled = busy;
  }

  function stopMicrophone() {
    if (micStream) micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }

  function releaseCamera() {
    stopDigitalRecordingStream();
    cancelAnimationFrame(frameRequest);
    frameRequest = null;
    pointers.clear();
    pinch = null;
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    stopMicrophone();
    ui.camera.pause();
    ui.camera.srcObject = null;
    ui.canvas.width = ui.canvas.height = 0;
  }

  function clearCapture() {
    ui.video.pause();
    ui.video.removeAttribute('src');
    ui.video.load();
    ui.photo.removeAttribute('src');
    ui.photo.hidden = ui.video.hidden = true;
    if (capturedURL) URL.revokeObjectURL(capturedURL);
    capturedURL = null;
    capturedFile = null;
    ui.details.textContent = '';
    ui.share.textContent = '共有して保存';
    delete ui.share.dataset.download;
  }

  function permissionError(error, target) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      return `${target}の利用が許可されませんでした。iPhoneのSafari／Webサイト設定で許可し、もう一度お試しください。`;
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') return `${target}が見つかりません。対応する端末でお試しください。`;
    if (error.name === 'NotReadableError' || error.name === 'TrackStartError') return `${target}を起動できません。他のアプリでの利用を終了してお試しください。`;
    if (error.name === 'OverconstrainedError') return `${target}の条件に対応していません。別のカメラでお試しください。`;
    return `${target}を利用できませんでした。Safariを開き直してお試しください。`;
  }

  async function startCamera() {
    if (busy || recorder || document.visibilityState === 'hidden') return;
    if (!window.isSecureContext) {
      tell('カメラにはHTTPS接続が必要です。HTTPSのURLで開いてください。', true);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      tell('このブラウザではカメラを利用できません。対応するiPhoneのSafariで開いてください。', true);
      return;
    }
    const token = ++operation;
    busy = true;
    phase = 'starting';
    releaseCamera();
    render();
    tell('カメラの許可を確認しています…');
    try {
      // facingModeは希望条件。指定カメラがない端末も起動可能にします。
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      if (token !== operation || document.visibilityState === 'hidden') {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      cameraStream = stream;
      const track = stream.getVideoTracks()[0];
      const actualFacing = track?.getSettings().facingMode;
      if (actualFacing === 'user' || actualFacing === 'environment') facing = actualFacing;
      track?.addEventListener('ended', () => {
        if (cameraStream !== stream) return;
        interrupt('カメラの接続が終了しました。録画中の場合は利用できるデータをプレビューします。');
      });
      ui.camera.srcObject = stream;
      // iOSでも映像要素を表示した状態で再生を開始し、使用中表示をすぐ更新します。
      render();
      await ui.camera.play();
      if (token !== operation) return;
      if (zoom > 1) drawLiveCanvas();
      if (frameRequest === null) frameRequest = requestAnimationFrame(renderFrames);
      phase = 'live';
      tell(mode === 'video' && !supportedMime() ? 'このブラウザは対応する動画形式がありません。写真撮影を利用してください。' : 'カメラ使用中です。撮影ボタンで撮影できます。');
    } catch (error) {
      if (token !== operation) return;
      releaseCamera();
      phase = 'idle';
      tell(permissionError(error, 'カメラ'), true);
    } finally {
      if (token === operation) {
        busy = false;
        render();
      }
    }
  }

  function timestamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${String(now.getMilliseconds()).padStart(3, '0')}`;
  }

  function showCapture(blob, extension, description) {
    clearCapture();
    stopDigitalRecordingStream();
    stopMicrophone();
    if (!ui.continuous.checked || document.visibilityState === 'hidden') releaseCamera();
    capturedFile = new File([blob], `temoto-${timestamp()}.${extension}`, { type: blob.type, lastModified: Date.now() });
    capturedURL = URL.createObjectURL(capturedFile);
    if (extension === 'jpg') {
      ui.photo.src = capturedURL;
      ui.photo.hidden = false;
    } else {
      ui.video.muted = true;
      ui.video.src = capturedURL;
      ui.video.hidden = false;
    }
    phase = 'preview';
    busy = false;
    const size = capturedFile.size >= 1024 * 1024 ? `${(capturedFile.size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(capturedFile.size / 1024)} KB`;
    ui.details.textContent = `${description} · ${size}`;
    render();
    tell(cameraIsActive() ? '撮影しました。小窓でカメラを維持しています。続けて撮るか、保存を選んでください。' : '撮影しました。カメラは停止しています。保存を選んでください。');
  }

  async function takePhoto() {
    if (busy || !cameraStream || recorder) return;
    // CSS表示サイズや固定値ではなく、カメラ映像本来の解像度を使います。
    const width = ui.camera.videoWidth;
    const height = ui.camera.videoHeight;
    if (!width || !height || ui.camera.readyState < 2) {
      tell('映像の準備ができていません。少し待ってから撮影してください。', true);
      return;
    }
    const token = ++operation;
    busy = true;
    phase = 'capturing';
    render();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas unavailable');
      drawZoomedFrame(context, width, height);
      if (!ui.continuous.checked) releaseCamera();
      render();
      tell('写真を処理しています…');
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
      if (token !== operation) return;
      if (!blob || blob.type !== 'image/jpeg') throw new Error('JPEG encoding failed');
      showCapture(blob, 'jpg', `JPEG · ${width} × ${height} · ${zoom.toFixed(1)}倍`);
    } catch {
      if (token !== operation) return;
      clearCapture();
      phase = cameraStream ? 'live' : 'idle';
      tell('写真を生成できませんでした。カメラを起動して撮り直してください。', true);
    } finally {
      canvas.width = canvas.height = 0;
      if (token === operation) {
        busy = false;
        render();
      }
    }
  }

  function updateElapsed() {
    const seconds = Math.floor((performance.now() - recordingStarted) / 1000);
    const text = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    if (ui.elapsed.textContent !== text) ui.elapsed.textContent = text;
  }

  function clearTimers() {
    clearInterval(clock);
    clearTimeout(stopWatchdog);
    clock = stopWatchdog = null;
  }

  async function startRecording() {
    if (busy || !cameraStream || recorder) return;
    const mimeType = supportedMime();
    if (!mimeType) {
      tell('このSafariでは対応する動画形式がありません。写真撮影を利用してください。', true);
      return;
    }
    if (!ui.camera.videoWidth || ui.camera.readyState < 2) {
      tell('映像の準備ができていません。少し待ってから録画してください。', true);
      return;
    }
    const token = ++operation;
    const includeAudio = ui.audio.checked;
    let requestingMicrophone = includeAudio;
    busy = true;
    render();
    try {
      if (includeAudio) {
        tell('マイクの許可を確認しています…');
        // 音声ありの録画時にだけマイクを取得。拒否時に無音録画へ勝手に切り替えません。
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (token !== operation || document.visibilityState === 'hidden') {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        micStream = stream;
        requestingMicrophone = false;
        for (const track of stream.getAudioTracks()) {
          track.addEventListener('ended', () => {
            if (micStream === stream) interrupt('マイクの接続が終了したため、録画を停止しました。');
          });
        }
      }
      if (token !== operation || !cameraStream) return;
      let videoTracks = cameraStream.getVideoTracks();
      if (videoZoomAvailable) {
        try {
          drawLiveCanvas();
          digitalRecordingStream = ui.canvas.captureStream(30);
          videoTracks = digitalRecordingStream.getVideoTracks();
          if (!videoTracks.length) throw new Error('Canvas recording unavailable');
        } catch {
          stopDigitalRecordingStream();
          videoZoomAvailable = false;
          if (zoom > 1) throw new Error('Zoom recording unavailable');
          videoTracks = cameraStream.getVideoTracks();
        }
      }
      const stream = new MediaStream([...videoTracks, ...(micStream?.getAudioTracks() || [])]);
      const currentRecorder = new MediaRecorder(stream, { mimeType });
      const chunks = [];
      let failed = false;
      recorder = currentRecorder;
      currentRecorder.ondataavailable = (event) => {
        if (recorder === currentRecorder && event.data.size > 0) chunks.push(event.data);
      };
      currentRecorder.onerror = () => {
        if (recorder !== currentRecorder) return;
        failed = true;
        tell('録画に失敗しました。撮り直してください。', true);
        stopRecording(false);
      };
      currentRecorder.onstop = () => {
        if (recorder !== currentRecorder) return;
        clearTimers();
        recorder = null;
        stopDigitalRecordingStream();
        stopMicrophone();
        if (!ui.continuous.checked || document.visibilityState === 'hidden') releaseCamera();
        busy = false;
        phase = 'idle';
        try {
          // dataavailableの実際の形式を優先し、recorder.mimeTypeを補助に使います。
          const actualType = chunks.find((chunk) => chunk.type)?.type || currentRecorder.mimeType;
          const extension = videoFormat(actualType);
          if (failed || !chunks.length || !extension) throw new Error('No usable recording');
          const blob = new Blob(chunks, { type: actualType });
          if (!blob.size) throw new Error('Empty recording');
          showCapture(blob, extension, `${extension.toUpperCase()} · 音声${includeAudio ? 'あり' : 'なし'}`);
          if (document.visibilityState === 'hidden') ui.video.pause();
        } catch {
          clearCapture();
          tell('録画に失敗したか、保存できる動画データがありません。カメラを起動して撮り直してください。', true);
          render();
        } finally {
          chunks.length = 0;
        }
      };
      currentRecorder.start(1000);
      phase = 'recording';
      recordingStarted = performance.now();
      updateElapsed();
      clock = setInterval(updateElapsed, 1000);
      tell(`録画中です。音声${includeAudio ? 'あり' : 'なし'}。赤い停止ボタンで終了します。`);
    } catch (error) {
      if (token !== operation) return;
      if (recorder) {
        recorder.onstop = recorder.ondataavailable = recorder.onerror = null;
        try {
          if (recorder.state !== 'inactive') recorder.stop();
        } catch { /* 取得済みのマイクは下で必ず停止します。 */ }
        recorder = null;
      }
      stopMicrophone();
      stopDigitalRecordingStream();
      const zoomRecordingFailed = !videoZoomAvailable && zoom > 1;
      if (!videoZoomAvailable) zoom = 1;
      phase = cameraStream ? 'live' : 'idle';
      tell(requestingMicrophone ? permissionError(error, 'マイク') : zoomRecordingFailed ? 'ズームした動画を録画できませんでした。1倍に戻しましたので、もう一度お試しください。' : '録画を開始できませんでした。音声設定を確認して、もう一度お試しください。', true);
    } finally {
      if (token === operation) {
        busy = false;
        render();
      }
    }
  }

  function stopRecording(keepCamera = ui.continuous.checked && document.visibilityState !== 'hidden') {
    if (!recorder || phase === 'stopping') return;
    const currentRecorder = recorder;
    busy = true;
    phase = 'stopping';
    clearInterval(clock);
    tell('録画を終了して動画を処理しています…');
    try {
      if (currentRecorder.state !== 'inactive') currentRecorder.stop();
      // 録画とマイクは即停止。連続撮影時はライブ小窓用カメラだけ維持します。
      stopMicrophone();
      stopDigitalRecordingStream();
      if (!keepCamera) releaseCamera();
      render();
      stopWatchdog = setTimeout(() => {
        if (recorder !== currentRecorder) return;
        currentRecorder.onstop = currentRecorder.ondataavailable = currentRecorder.onerror = null;
        recorder = null;
        busy = false;
        phase = 'idle';
        clearTimers();
        tell('録画の終了処理に失敗しました。動画を保存できません。撮り直してください。', true);
        render();
      }, 10000);
    } catch {
      currentRecorder.onstop = currentRecorder.ondataavailable = currentRecorder.onerror = null;
      recorder = null;
      releaseCamera();
      clearTimers();
      busy = false;
      phase = 'idle';
      tell('録画の停止に失敗しました。動画を保存できません。撮り直してください。', true);
      render();
    }
  }

  function interrupt(message) {
    ++operation;
    if (recorder) {
      stopRecording(false);
      releaseCamera();
    }
    else {
      releaseCamera();
      // 共有シートで画面が非表示になっても、完了するまでは撮り直しを許可しません。
      busy = Boolean(capturedFile && busy);
      phase = capturedFile ? 'preview' : 'idle';
    }
    ui.video.pause();
    render();
    if (message) tell(message);
  }

  function downloadCapture(fallback = false) {
    if (!capturedFile || !capturedURL) return;
    const anchor = document.createElement('a');
    anchor.href = capturedURL;
    anchor.download = capturedFile.name;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // SafariがURLを読み取るまで保持し、撮り直し・ページ終了時に解放します。
    tell(`${fallback ? 'ファイル共有を利用できないため、' : ''}ダウンロードを開始しました。Safariのダウンロード一覧を確認してください。写真アプリへの保存は「共有して保存」を使ってください。`);
  }

  async function shareCapture() {
    if (!capturedFile || busy) return;
    const files = [capturedFile];
    let canShare = false;
    try {
      canShare = typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files });
    } catch { /* canShare自体が失敗した場合もダウンロードを使います。 */ }
    if (!canShare) {
      downloadCapture(true);
      return;
    }
    busy = true;
    render();
    try {
      // タップのユーザーアクティベーション内で呼びます。直前に非同期処理を挟みません。
      await navigator.share({ files });
      if (capturedFile !== files[0]) return;
      tell('共有シートを閉じました。保存できたか、選んだ保存先で確認してください。');
    } catch (error) {
      if (capturedFile !== files[0]) return;
      if (error.name === 'AbortError') {
        tell('共有をキャンセルしました。撮影データはまだプレビューにあります。');
      } else {
        // shareの失敗後はタップの権限が失われ得るため、次のタップで保存します。
        ui.share.textContent = 'ダウンロードして保存';
        ui.share.dataset.download = 'true';
        tell('ファイルを共有できませんでした。「ダウンロードして保存」を押してください。', true);
      }
    } finally {
      if (capturedFile === files[0]) {
        busy = false;
        render();
      }
    }
  }

  ui.start.addEventListener('click', startCamera);
  ui.switch.addEventListener('click', () => {
    if (busy || recorder) return;
    facing = facing === 'environment' ? 'user' : 'environment';
    startCamera();
  });
  ui.stop.addEventListener('click', () => interrupt('カメラとマイクを停止しました。再開するにはカメラを起動してください。'));
  ui.previewStop.addEventListener('click', () => interrupt('カメラを停止しました。撮影データはプレビューに残っています。'));
  ui.continuous.addEventListener('change', () => {
    if (capturedFile && !ui.continuous.checked) releaseCamera();
    render();
  });
  ui.zoom.addEventListener('input', () => setZoom(ui.zoom.value));
  ui.zoomIn.addEventListener('click', () => setZoom(zoom + 0.5));
  ui.zoomOut.addEventListener('click', () => setZoom(zoom - 0.5));
  ui.zoomReset.addEventListener('click', () => setZoom(1));
  ui.expand.addEventListener('click', () => {
    document.body.classList.toggle('expanded');
    render();
  });
  // ピンチ操作はライブ映像の範囲だけ。ページ全体の拡大やアクセス許可は変更しません。
  const distance = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  ui.viewfinder.addEventListener('pointerdown', (event) => {
    if (!cameraIsActive() || capturedFile || event.target.closest('button, input, label')) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    ui.viewfinder.setPointerCapture(event.pointerId);
    if (pointers.size === 2) pinch = { distance: distance(), zoom };
  });
  ui.viewfinder.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2 && pinch?.distance > 0) setZoom(pinch.zoom * distance() / pinch.distance);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    ui.viewfinder.addEventListener(name, (event) => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinch = null;
    });
  }
  ui.capture.addEventListener('click', () => {
    if (phase === 'recording') stopRecording();
    else if (mode === 'photo') takePhoto();
    else startRecording();
  });
  for (const [button, value] of [[ui.photoMode, 'photo'], [ui.videoMode, 'video']]) {
    button.addEventListener('click', () => {
      if (busy || recorder) return;
      mode = value;
      if (mode === 'video' && !videoZoomAvailable) zoom = 1;
      render();
      tell(mode === 'video' && !supportedMime() ? 'このブラウザでは対応する動画形式がありません。写真撮影を利用してください。' : mode === 'video' && !videoZoomAvailable ? 'このブラウザでは動画のズームを利用できません。1倍で録画できます。写真ではズームできます。' : mode === 'video' ? '動画の音声を選び、赤いボタンで録画を開始します。' : '写真はJPEG形式で撮影します。');
    });
  }
  ui.audio.addEventListener('change', render);
  ui.share.addEventListener('click', () => {
    if (ui.share.dataset.download === 'true') downloadCapture(true);
    else shareCapture();
  });
  ui.download.addEventListener('click', () => downloadCapture());
  ui.retake.addEventListener('click', () => {
    if (busy) return;
    ++operation;
    clearCapture();
    phase = 'idle';
    if (cameraIsActive()) {
      phase = 'live';
      render();
      tell('カメラをそのまま使って次の撮影ができます。');
    } else startCamera();
  });

  // 非表示・ページ離脱時は必ず停止。復帰時は自動で撮影を再開しません。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') interrupt('画面が非表示になったため、カメラとマイクを停止しました。');
  });
  window.addEventListener('pagehide', () => {
    interrupt();
    clearCapture();
    // 遅延onstopが離脱後にBlob URLを作らないよう、録画ハンドラを破棄します。
    if (recorder) recorder.onstop = recorder.ondataavailable = recorder.onerror = null;
    recorder = null;
    clearTimers();
    releaseCamera();
    busy = false;
    phase = 'idle';
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      render();
      tell('ページに戻りました。カメラを起動してください。以前の撮影データは保持していません。');
    }
  });

  render();
  // PWAは同一オリジンの固定ファイルだけをキャッシュ。登録失敗でも撮影は可能です。
  if (window.isSecureContext && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {
      if (phase === 'idle' && !busy && !ui.message.classList.contains('error')) {
        tell('オフライン機能を準備できませんでした。オンラインで撮影機能を利用できます。');
      }
    });
  }
})();
