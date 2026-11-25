/* ==========================================================================
   쇼츠 스튜디오 · 9:16 세로 영상 편집기
   HTML5 Canvas + Web Audio + MediaRecorder · 서버 없이 브라우저에서만 동작
   ========================================================================== */
(function () {
  'use strict';

  var W = 1080, H = 1920, FADE = 0.4, FPS = 30;
  var FONT = '"Pretendard","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  var $ = function (id) { return document.getElementById(id); };

  var cvs = $('canvas');
  var ctx = cvs.getContext('2d');
  var stageEmpty = $('stageEmpty');
  var safeLayer = $('safeLayer');
  var dropZone = $('dropZone');
  var cutListEl = $('cutList');
  var bgmAudio = $('bgmAudio');
  var mediaPool = $('mediaPool');

  var state = {
    cuts: [],
    selId: null,
    safe: true,
    hook: { on: true, text: '솔직 후기 요약 🔥', bg: '#ff3d6e', color: '#ffffff' },
    bgm: { name: '', vol: 0.6 },
    playing: false,
    playhead: 0,
    exporting: false,
    format: 'auto'
  };

  var cutSeq = 0;
  function uid() { cutSeq += 1; return 'c' + cutSeq + Math.random().toString(36).slice(2, 6); }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function fmt(v) { return (Math.round(v * 10) / 10).toFixed(1); }
  function ease(p) { return p * p * (3 - 2 * p); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ------------------------------------------------------------------ 토스트 */
  var toastTimer = null;
  function toast(msg, isErr) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3200);
  }

  /* ------------------------------------------------------------------ 타임라인 계산 */
  function totalDuration() {
    var t = 0;
    for (var i = 0; i < state.cuts.length; i++) t += state.cuts[i].duration;
    return t;
  }
  function cutStart(i) {
    var s = 0;
    for (var k = 0; k < i; k++) s += state.cuts[k].duration;
    return s;
  }
  function activeIndex(t) {
    var acc = 0;
    for (var i = 0; i < state.cuts.length; i++) {
      acc += state.cuts[i].duration;
      if (t < acc - 1e-6) return i;
    }
    return Math.max(0, state.cuts.length - 1);
  }

  /* ------------------------------------------------------------------ 그리기 도구 */
  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function wrapText(text, maxW) {
    var lines = [];
    var paras = String(text).split('\n');
    for (var pi = 0; pi < paras.length; pi++) {
      var para = paras[pi];
      if (!para.trim()) { lines.push(''); continue; }
      var words = para.split(' ');
      var line = '';
      for (var wi = 0; wi < words.length; wi++) {
        var word = words[wi];
        if (word === '') continue;
        var cand = line ? line + ' ' + word : word;
        if (ctx.measureText(cand).width <= maxW) { line = cand; continue; }
        if (line) { lines.push(line); line = ''; }
        if (ctx.measureText(word).width > maxW) {
          var cur = '';
          for (var ci = 0; ci < word.length; ci++) {
            var ch = word.charAt(ci);
            if (ctx.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ch; }
            else cur += ch;
          }
          line = cur;
        } else {
          line = word;
        }
      }
      if (line) lines.push(line);
    }
    return lines.length ? lines : [''];
  }

  /* ------------------------------------------------------------------ 프레임 그리기 */
  function drawCutFrame(cut, local) {
    var el = cut.el;
    if (!el) return;
    var sw, sh;
    if (cut.kind === 'image') {
      sw = el.naturalWidth || el.width;
      sh = el.naturalHeight || el.height;
      if (!el.complete || !sw || !sh) return;
    } else {
      sw = el.videoWidth;
      sh = el.videoHeight;
      if (!sw || !sh) {
        ctx.fillStyle = '#0b0c12';
        ctx.fillRect(0, 0, W, H);
        return;
      }
    }
    var p = cut.duration > 0 ? clamp(local / cut.duration, 0, 1) : 1;
    var e = ease(p);
    var cover = Math.max(W / sw, H / sh);
    var zoom = 1;
    if (cut.motion === 'in') zoom = 1 + 0.12 * e;
    else if (cut.motion === 'out') zoom = 1.12 - 0.12 * e;
    else if (cut.motion === 'pan') zoom = 1.12;

    var dw = sw * cover * zoom;
    var dh = sh * cover * zoom;
    var dx, dy = (H - dh) / 2;
    if (cut.motion === 'pan') dx = (W - dw) * e;
    else dx = (W - dw) / 2;

    try {
      ctx.drawImage(el, dx, dy, dw, dh);
    } catch (err) { /* 프레임이 아직 없을 수 있음 */ }

    drawSubtitle(cut);
  }

  function drawSubtitle(cut) {
    var text = (cut.text || '').trim();
    if (!text) return;
    var size = cut.size || 64;
    ctx.save();
    ctx.font = '900 ' + size + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var lines = wrapText(text, W * 0.86);
    var lh = Math.round(size * 1.3);
    var blockH = lines.length * lh;
    var anchor = cut.pos === 'top' ? 0.30 : cut.pos === 'middle' ? 0.50 : 0.70;
    var cy = H * anchor;
    var topLimit = H * 0.145, bottomLimit = H * 0.752;
    var half = blockH / 2;
    if (cy - half < topLimit) cy = topLimit + half;
    if (cy + half > bottomLimit) cy = bottomLimit - half;

    var maxLineW = 0;
    for (var i = 0; i < lines.length; i++) maxLineW = Math.max(maxLineW, ctx.measureText(lines[i]).width);

    var style = cut.style || 'outline';
    var padX = Math.round(size * 0.55), padY = Math.round(size * 0.42);
    var boxW = maxLineW + padX * 2;
    var boxH = blockH + padY * 2;
    var bx = W / 2 - boxW / 2;
    var by = cy - boxH / 2;

    if (style === 'box' || style === 'yellow' || style === 'pink') {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.35)';
      ctx.shadowBlur = 26;
      ctx.shadowOffsetY = 8;
      roundRect(bx, by, boxW, boxH, Math.min(30, size * 0.36));
      if (style === 'box') ctx.fillStyle = 'rgba(0,0,0,.62)';
      else if (style === 'yellow') ctx.fillStyle = '#ffe94a';
      else {
        var g = ctx.createLinearGradient(bx, by, bx + boxW, by + boxH);
        g.addColorStop(0, '#ff4d8d');
        g.addColorStop(1, '#c9317f');
        ctx.fillStyle = g;
      }
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = style === 'yellow' ? '#111318' : '#ffffff';
      for (var j = 0; j < lines.length; j++) {
        ctx.fillText(lines[j], W / 2, by + padY + lh / 2 + j * lh);
      }
    } else {
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = Math.max(6, size * 0.18);
      ctx.strokeStyle = 'rgba(0,0,0,.95)';
      ctx.fillStyle = '#ffffff';
      for (var k = 0; k < lines.length; k++) {
        var y = cy - blockH / 2 + lh / 2 + k * lh;
        ctx.strokeText(lines[k], W / 2, y);
        ctx.fillText(lines[k], W / 2, y);
      }
    }
    ctx.restore();
  }

  function drawHook() {
    var h = state.hook;
    if (!h.on) return;
    var text = (h.text || '').trim();
    if (!text) return;
    var size = 68;
    ctx.save();
    ctx.font = '900 ' + size + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var lines = wrapText(text, W * 0.82);
    var lh = Math.round(size * 1.24);
    var padX = 46, padY = 24;
    var maxW = 0;
    for (var i = 0; i < lines.length; i++) maxW = Math.max(maxW, ctx.measureText(lines[i]).width);
    var bw = Math.min(W * 0.92, maxW + padX * 2);
    var bh = lines.length * lh + padY * 2;
    var x = (W - bw) / 2;
    var y = H * 0.112;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.45)';
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 10;
    roundRect(x, y, bw, bh, 26);
    ctx.fillStyle = h.bg;
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = h.color;
    for (var j = 0; j < lines.length; j++) {
      ctx.fillText(lines[j], W / 2, y + padY + lh / 2 + j * lh);
    }
    ctx.restore();
  }

  function renderAt(t) {
    var total = totalDuration();
    t = clamp(t, 0, total);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    if (state.cuts.length) {
      var i = activeIndex(t);
      var cut = state.cuts[i];
      var local = clamp(t - cutStart(i), 0, cut.duration);
      if (cut.transition === 'fade' && i > 0 && local < FADE) {
        var a = clamp(local / FADE, 0, 1);
        drawCutFrame(state.cuts[i - 1], state.cuts[i - 1].duration);
        ctx.save();
        ctx.globalAlpha = a;
        drawCutFrame(cut, local);
        ctx.restore();
      } else {
        drawCutFrame(cut, local);
      }
      drawHook();
    }
    updateTimeUI(t);
  }

  var renderQueued = false;
  function requestRender() {
    if (state.playing || state.exporting) return;
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      renderAt(state.playhead);
    });
  }

  function updateTimeUI(t) {
    var total = totalDuration();
    $('timeLabel').textContent = fmt(t) + ' / ' + fmt(total) + '초';
    $('totalLabel').textContent = '총 ' + fmt(total) + '초';
    var seek = $('seek');
    var pct = total > 0 ? clamp(t / total, 0, 1) * 1000 : 0;
    seek.value = String(Math.round(pct));
    seek.style.setProperty('--fill', (pct / 10) + '%');
  }

  /* ------------------------------------------------------------------ 미디어 추가 */
  function pushCut(partial) {
    var cut = Object.assign({
      id: uid(), kind: 'image', name: '', el: null, url: '', thumb: '',
      duration: 2.5, motion: 'none', transition: 'cut',
      text: '', pos: 'bottom', size: 64, style: 'outline'
    }, partial);
    state.cuts.push(cut);
    state.selId = cut.id;
    renderCutList();
    fillForm();
    updateLength();
    updateStageEmpty();
    requestRender();
    return cut;
  }

  function addFiles(files) {
    var arr = Array.prototype.slice.call(files || []);
    if (!arr.length) return;
    arr.forEach(function (file) {
      var name = file.name || 'clip';
      var isVideo = /^video\//.test(file.type) || /\.(mp4|mov|m4v|webm|ogv)$/i.test(name);
      var isImage = /^image\//.test(file.type) || /\.(jpe?g|png|webp|avif|gif)$/i.test(name);
      if (isVideo) addVideo(file);
      else if (isImage) addImage(file);
      else toast('‘' + name + '’ — 지원하지 않는 형식입니다.', true);
    });
  }

  function addImage(file) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      pushCut({ kind: 'image', name: file.name, el: img, url: url, thumb: url });
      toast('사진 1장을 추가했습니다.');
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      toast('이미지를 불러오지 못했습니다: ' + file.name, true);
    };
    img.src = url;
  }

  function addVideo(file) {
    var url = URL.createObjectURL(file);
    var v = document.createElement('video');
    v.src = url;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.preload = 'auto';
    mediaPool.appendChild(v);
    var settled = false;
    v.addEventListener('loadeddata', function () {
      if (settled) return;
      settled = true;
      var thumb = makeVideoThumb(v);
      var clipDur = (isFinite(v.duration) && v.duration > 0) ? v.duration : 2.5;
      var cutDur = Math.round(Math.min(2.5, Math.max(0.5, clipDur)) * 10) / 10;
      pushCut({ kind: 'video', name: file.name, el: v, url: url, thumb: thumb, duration: cutDur });
      toast('영상 클립을 추가했습니다 · ' + fmt(cutDur) + '초 구간으로 잘라 놓았어요.');
      v.addEventListener('seeked', function () {
        if (!state.playing && !state.exporting) requestRender();
      });
    });
    v.addEventListener('error', function () {
      if (settled) return;
      settled = true;
      toast('‘' + file.name + '’ — 브라우저가 이 코덱을 재생하지 못합니다. MP4(H.264)로 변환 후 올려 주세요.', true);
      if (v.parentNode) v.parentNode.removeChild(v);
      URL.revokeObjectURL(url);
    });
  }

  function makeVideoThumb(v) {
    try {
      var c = document.createElement('canvas');
      c.width = 90; c.height = 90;
      var g = c.getContext('2d');
      var vw = v.videoWidth || 16, vh = v.videoHeight || 9;
      var cover = Math.max(c.width / vw, c.height / vh);
      g.drawImage(v, (c.width - vw * cover) / 2, (c.height - vh * cover) / 2, vw * cover, vh * cover);
      return c.toDataURL('image/jpeg', 0.7);
    } catch (e) { return ''; }
  }

  /* ------------------------------------------------------------------ 컷 목록 UI */
  function renderCutList() {
    cutListEl.innerHTML = '';
    state.cuts.forEach(function (cut, idx) {
      var li = document.createElement('li');
      li.className = 'cut' + (cut.id === state.selId ? ' sel' : '');
      li.dataset.id = cut.id;
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.setAttribute('aria-label', (idx + 1) + '번 컷 ' + (cut.name || ''));

      var th = document.createElement('div');
      th.className = 'cut-thumb';
      if (cut.thumb) {
        var im = document.createElement('img');
        im.src = cut.thumb;
        im.alt = '';
        th.appendChild(im);
      } else {
        th.textContent = cut.kind === 'video' ? '🎞️' : '🖼️';
      }

      var info = document.createElement('div');
      info.className = 'cut-info';
      var nm = document.createElement('div');
      nm.className = 'cut-name';
      nm.textContent = cut.name || ('컷 ' + (idx + 1));
      var meta = document.createElement('div');
      meta.className = 'cut-meta';
      meta.dataset.meta = '1';
      info.appendChild(nm);
      info.appendChild(meta);

      var acts = document.createElement('div');
      acts.className = 'cut-actions';
      [['up', '↑', '위로'], ['down', '↓', '아래로'], ['dup', '⧉', '복제'], ['del', '✕', '삭제']].forEach(function (a) {
        var b = document.createElement('button');
        b.type = 'button';
        b.dataset.act = a[0];
        b.textContent = a[1];
        b.title = a[2];
        b.setAttribute('aria-label', a[2]);
        acts.appendChild(b);
      });

      li.appendChild(th);
      li.appendChild(info);
      li.appendChild(acts);
      cutListEl.appendChild(li);
      fillMeta(li, cut, idx);
    });
    $('cutCount').textContent = state.cuts.length + '컷';
    $('cutEmpty').hidden = state.cuts.length > 0;
  }

  function fillMeta(li, cut, idx) {
    var meta = li.querySelector('[data-meta]');
    if (!meta) return;
    meta.innerHTML = '';
    var base = document.createElement('span');
    base.textContent = (cut.kind === 'video' ? '영상' : '이미지') + ' · ' + fmt(cut.duration) + '초';
    meta.appendChild(base);
    if ((cut.text || '').trim()) {
      var t = document.createElement('span');
      t.className = 'tag';
      t.textContent = '자막';
      meta.appendChild(t);
    }
    if (cut.motion !== 'none') {
      var m = document.createElement('span');
      m.className = 'tag';
      m.textContent = cut.motion === 'in' ? '줌인' : cut.motion === 'out' ? '줌아웃' : '패닝';
      meta.appendChild(m);
    }
    if (cut.transition === 'fade') {
      var f = document.createElement('span');
      f.className = 'tag';
      f.textContent = '페이드';
      meta.appendChild(f);
    }
    if (li) li.setAttribute('aria-label', (idx + 1) + '번 컷 ' + (cut.name || ''));
  }

  function refreshRow(cut) {
    var idx = state.cuts.indexOf(cut);
    if (idx < 0) return;
    var li = cutListEl.querySelector('li[data-id="' + cut.id + '"]');
    if (li) fillMeta(li, cut, idx);
  }

  cutListEl.addEventListener('click', function (e) {
    var li = e.target.closest ? e.target.closest('li.cut') : null;
    if (!li) return;
    var idx = state.cuts.findIndex(function (c) { return c.id === li.dataset.id; });
    if (idx < 0) return;
    var btn = e.target.closest('button[data-act]');
    if (state.exporting) { toast('영상을 만드는 중에는 편집할 수 없어요.'); return; }
    if (!btn) { selectCut(state.cuts[idx].id); return; }
    var act = btn.dataset.act;
    if (act === 'up' && idx > 0) { moveCut(idx, idx - 1); }
    else if (act === 'down' && idx < state.cuts.length - 1) { moveCut(idx, idx + 1); }
    else if (act === 'dup') { duplicateCut(idx); }
    else if (act === 'del') { removeCut(idx); }
  });

  cutListEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var li = e.target.closest ? e.target.closest('li.cut') : null;
    if (!li) return;
    e.preventDefault();
    selectCut(li.dataset.id);
  });

  function selectCut(id) {
    state.selId = id;
    Array.prototype.forEach.call(cutListEl.children, function (li) {
      li.classList.toggle('sel', li.dataset.id === id);
    });
    fillForm();
  }

  function moveCut(from, to) {
    var cut = state.cuts.splice(from, 1)[0];
    state.cuts.splice(to, 0, cut);
    state.playhead = Math.min(state.playhead, totalDuration());
    renderCutList();
    updateLength();
    requestRender();
  }

  function duplicateCut(idx) {
    var src = state.cuts[idx];
    var copy = Object.assign({}, src, { id: uid(), name: (src.name || '컷') + ' 복사' });
    if (src.kind === 'video') {
      var v = document.createElement('video');
      v.src = src.url;
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.preload = 'auto';
      mediaPool.appendChild(v);
      copy.el = v;
    }
    state.cuts.splice(idx + 1, 0, copy);
    state.selId = copy.id;
    renderCutList();
    fillForm();
    updateLength();
    updateStageEmpty();
    requestRender();
    toast('컷을 복제했습니다.');
  }

  function removeCut(idx) {
    var cut = state.cuts[idx];
    if (cut.kind === 'video' && cut.el) {
      try { cut.el.pause(); } catch (e) {}
      if (cut.el.parentNode) cut.el.parentNode.removeChild(cut.el);
    }
    state.cuts.splice(idx, 1);
    if (state.selId === cut.id) {
      var next = state.cuts[Math.min(idx, state.cuts.length - 1)];
      state.selId = next ? next.id : null;
    }
    state.playhead = clamp(state.playhead, 0, totalDuration());
    renderCutList();
    fillForm();
    updateLength();
    updateStageEmpty();
    requestRender();
  }

  function updateStageEmpty() {
    stageEmpty.classList.toggle('gone', state.cuts.length > 0);
  }

  function updateLength() {
    var total = totalDuration();
    if (state.playhead > total) state.playhead = total;
    var val = $('lengthVal');
    val.textContent = fmt(total) + '초';
    val.classList.toggle('over', total > 60);
    $('lengthCap').textContent = total > 90 ? '/ 릴스 90초 초과' : total > 60 ? '/ 60초 초과' : '/ 60초 쇼츠 권장';
    $('totalLabel').textContent = '총 ' + fmt(total) + '초';
    var hint = $('lengthHint');
    if (!state.cuts.length) hint.textContent = '컷을 2개 이상 넣으면 이어 붙인 영상이 만들어집니다.';
    else if (total > 90) hint.textContent = '90초를 넘었습니다. 유튜브 쇼츠·인스타 릴스 업로드 길이를 확인해 주세요.';
    else if (total > 60) hint.textContent = '쇼츠는 60초, 릴스는 90초까지 올릴 수 있어요. 길이를 줄이면 노출에 유리합니다.';
    else hint.textContent = '쇼츠·릴스에 알맞은 길이입니다. 첫 3초에 훅 타이틀과 자막을 배치해 보세요.';
    updateTimeUI(state.playhead);
  }

  /* ------------------------------------------------------------------ 선택 컷 폼 */
  function selectedCut() {
    return state.cuts.find(function (c) { return c.id === state.selId; }) || null;
  }

  function setSeg(container, value) {
    Array.prototype.forEach.call(container.children, function (b) {
      var on = b.dataset.v === value;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  function fillForm() {
    var cut = selectedCut();
    var form = $('cutForm');
    if (!cut) {
      form.hidden = true;
      $('formEmpty').hidden = false;
      $('selBadge').textContent = '선택 없음';
      return;
    }
    form.hidden = false;
    $('formEmpty').hidden = true;
    var idx = state.cuts.indexOf(cut);
    $('selBadge').textContent = (idx + 1) + '번 컷';
    $('durRange').value = String(Math.min(10, cut.duration));
    $('durNum').value = String(cut.duration);
    $('motionSel').value = cut.motion;
    setSeg($('transSeg'), cut.transition);
    $('subText').value = cut.text || '';
    setSeg($('posSeg'), cut.pos);
    $('sizeRange').value = String(cut.size);
    $('sizeVal').textContent = cut.size + 'px';
    setSeg($('styleGrid'), cut.style);
  }

  function patchSelected(patch, opts) {
    if (state.exporting) { toast('영상을 만드는 중에는 편집할 수 없어요.'); return; }
    var cut = selectedCut();
    if (!cut) return;
    Object.assign(cut, patch);
    refreshRow(cut);
    if (patch.duration !== undefined) updateLength();
    if (!opts || !opts.skipRender) requestRender();
  }

  $('durRange').addEventListener('input', function (e) {
    var v = clamp(parseFloat(e.target.value) || 0.5, 0.5, 30);
    $('durNum').value = String(Math.round(v * 10) / 10);
    patchSelected({ duration: Math.round(v * 10) / 10 });
  });
  $('durNum').addEventListener('input', function (e) {
    var v = parseFloat(e.target.value);
    if (!isFinite(v)) return;
    v = clamp(v, 0.5, 30);
    $('durRange').value = String(Math.min(10, v));
    patchSelected({ duration: Math.round(v * 10) / 10 });
  });
  $('durNum').addEventListener('blur', function (e) {
    var v = clamp(parseFloat(e.target.value) || 2.5, 0.5, 30);
    e.target.value = String(Math.round(v * 10) / 10);
  });

  $('motionSel').addEventListener('change', function (e) {
    patchSelected({ motion: e.target.value });
  });

  $('transSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-v]');
    if (!b) return;
    patchSelected({ transition: b.dataset.v });
    setSeg($('transSeg'), b.dataset.v);
  });

  $('subText').addEventListener('input', function (e) {
    patchSelected({ text: e.target.value });
  });

  $('posSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-v]');
    if (!b) return;
    patchSelected({ pos: b.dataset.v });
    setSeg($('posSeg'), b.dataset.v);
  });

  $('sizeRange').addEventListener('input', function (e) {
    var v = parseInt(e.target.value, 10) || 64;
    $('sizeVal').textContent = v + 'px';
    patchSelected({ size: v });
  });

  $('styleGrid').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-v]');
    if (!b) return;
    patchSelected({ style: b.dataset.v });
    setSeg($('styleGrid'), b.dataset.v);
  });

  $('applyAllBtn').addEventListener('click', function () {
    var cut = selectedCut();
    if (!cut) return;
    if (state.exporting) { toast('영상을 만드는 중에는 편집할 수 없어요.'); return; }
    state.cuts.forEach(function (c) {
      c.style = cut.style;
      c.size = cut.size;
      c.pos = cut.pos;
    });
    renderCutList();
    renderAt(state.playhead);
    toast('자막 스타일을 ' + state.cuts.length + '개 컷에 모두 적용했습니다.');
  });

  /* ------------------------------------------------------------------ 훅 타이틀 */
  $('hookOn').addEventListener('change', function (e) {
    state.hook.on = e.target.checked;
    requestRender();
  });
  $('hookText').addEventListener('input', function (e) {
    state.hook.text = e.target.value;
    requestRender();
  });
  $('hookBg').addEventListener('input', function (e) {
    state.hook.bg = e.target.value;
    requestRender();
  });
  $('hookColor').addEventListener('input', function (e) {
    state.hook.color = e.target.value;
    requestRender();
  });
  $('hookSwatches').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-bg]');
    if (!b) return;
    state.hook.bg = b.dataset.bg;
    state.hook.color = b.dataset.fg;
    $('hookBg').value = b.dataset.bg;
    $('hookColor').value = b.dataset.fg;
    requestRender();
  });

  /* ------------------------------------------------------------------ 재생 */
  var rafId = null, lastTs = 0;

  function updatePlayBtn() {
    var btn = $('playBtn');
    btn.querySelector('.pb-icon').textContent = state.playing ? '❚❚' : '▶';
    btn.querySelector('.pb-label').textContent = state.playing ? '일시정지' : '재생';
    btn.setAttribute('aria-label', state.playing ? '일시정지' : '재생');
  }

  function play() {
    if (state.exporting) return;
    if (!state.cuts.length) { toast('먼저 사진이나 영상을 추가하세요.'); return; }
    if (state.playing) return;
    ensureAudio();
    if (actx && actx.state === 'suspended') actx.resume().catch(function () {});
    var total = totalDuration();
    if (state.playhead >= total - 0.05) { state.playhead = 0; seekVideos(0); }
    state.playing = true;
    lastTs = 0;
    syncBgm(true);
    updatePlayBtn();
    rafId = requestAnimationFrame(tick);
  }

  function pause() {
    state.playing = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    try { bgmAudio.pause(); } catch (e) {}
    state.cuts.forEach(function (c) {
      if (c.kind === 'video' && c.el && !c.el.paused) { try { c.el.pause(); } catch (e) {} }
    });
    updatePlayBtn();
  }

  function tick(ts) {
    if (!state.playing) { rafId = null; return; }
    if (!lastTs) lastTs = ts;
    var dt = Math.min(0.1, (ts - lastTs) / 1000);
    lastTs = ts;
    var total = totalDuration();
    state.playhead = Math.min(total, state.playhead + dt);
    syncVideos(state.playhead, true);
    renderAt(state.playhead);
    if (state.playhead >= total - 0.001) {
      pause();
      renderAt(total);
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function seekVideos(t) {
    state.cuts.forEach(function (cut) {
      if (cut.kind !== 'video' || !cut.el) return;
      try { cut.el.currentTime = 0; } catch (e) {}
      if (!cut.el.paused) cut.el.pause();
    });
  }

  function syncVideos(t, playing) {
    var acc = 0;
    state.cuts.forEach(function (cut) {
      var s = acc;
      acc += cut.duration;
      var e = acc;
      if (cut.kind !== 'video' || !cut.el) return;
      var v = cut.el;
      var inRange = t >= s && t < e - 1e-6;
      if (inRange) {
        var local = clamp(t - s, 0, cut.duration);
        var vdur = (isFinite(v.duration) && v.duration > 0) ? v.duration : cut.duration;
        var want = local % vdur;
        if (playing) {
          if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
          if (!v.seeking && Math.abs(v.currentTime - want) > 0.34) {
            try { v.currentTime = want; } catch (err) {}
          }
        } else {
          if (!v.paused) { try { v.pause(); } catch (err) {} }
          if (!v.seeking && Math.abs(v.currentTime - want) > 0.04) {
            try { v.currentTime = want; } catch (err) {}
          }
        }
      } else if (!v.paused) {
        try { v.pause(); } catch (err) {}
      }
    });
  }

  $('playBtn').addEventListener('click', function () {
    if (state.playing) pause(); else play();
  });

  $('restartBtn').addEventListener('click', function () {
    if (state.exporting) return;
    pause();
    state.playhead = 0;
    seekVideos(0);
    try { if (bgmAudio.src) bgmAudio.currentTime = 0; } catch (e) {}
    renderAt(0);
  });

  $('seek').addEventListener('input', function (e) {
    if (state.exporting) return;
    if (state.playing) pause();
    var total = totalDuration();
    state.playhead = (Number(e.target.value) / 1000) * total;
    syncVideos(state.playhead, false);
    renderAt(state.playhead);
  });

  /* ------------------------------------------------------------------ 오디오 */
  var actx = null, srcNode = null, gainNode = null, destNode = null;

  function ensureAudio() {
    if (actx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      actx = new AC();
      srcNode = actx.createMediaElementSource(bgmAudio);
      gainNode = actx.createGain();
      destNode = actx.createMediaStreamDestination();
      srcNode.connect(gainNode);
      gainNode.connect(destNode);
      gainNode.connect(actx.destination);
      applyVolume();
    } catch (e) {
      actx = null;
    }
  }

  function applyVolume() {
    if (!gainNode) return;
    gainNode.gain.value = clamp(state.bgm.vol, 0, 1) * 0.9;
  }

  function syncBgm(shouldPlay) {
    if (!state.bgm.name) return;
    var dur = bgmAudio.duration;
    try {
      if (isFinite(dur) && dur > 0.2) {
        var want = state.playhead % dur;
        if (Math.abs(bgmAudio.currentTime - want) > 0.35) bgmAudio.currentTime = want;
      } else if (state.playhead < 0.2) {
        bgmAudio.currentTime = 0;
      }
    } catch (e) {}
    if (shouldPlay) {
      var p = bgmAudio.play();
      if (p && p.catch) p.catch(function () { toast('음악을 재생하려면 화면을 한 번 눌러 주세요.', true); });
    }
  }

  $('bgmPickBtn').addEventListener('click', function () { $('bgmInput').click(); });
  $('bgmInput').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!/^audio\//.test(f.type) && !/\.(mp3|m4a|wav|aac|ogg|oga)$/i.test(f.name)) {
      toast('음악 파일(MP3 · M4A · WAV)을 올려 주세요.', true);
      return;
    }
    try {
      if (bgmAudio.dataset.url) URL.revokeObjectURL(bgmAudio.dataset.url);
    } catch (err) {}
    var url = URL.createObjectURL(f);
    bgmAudio.dataset.url = url;
    bgmAudio.src = url;
    bgmAudio.load();
    state.bgm.name = f.name;
    $('bgmName').textContent = f.name;
    $('bgmName').classList.add('has');
    $('bgmRemoveBtn').hidden = false;
    ensureAudio();
    applyVolume();
    toast('배경음악을 올렸습니다.');
  });

  $('bgmRemoveBtn').addEventListener('click', function () {
    try { bgmAudio.pause(); } catch (e) {}
    try { if (bgmAudio.dataset.url) URL.revokeObjectURL(bgmAudio.dataset.url); } catch (e) {}
    bgmAudio.removeAttribute('src');
    try { bgmAudio.load(); } catch (e) {}
    state.bgm.name = '';
    $('bgmName').textContent = '선택된 음악 없음';
    $('bgmName').classList.remove('has');
    $('bgmRemoveBtn').hidden = true;
  });

  $('bgmVol').addEventListener('input', function (e) {
    state.bgm.vol = Number(e.target.value) / 100;
    $('volVal').textContent = e.target.value + '%';
    applyVolume();
  });

  /* ------------------------------------------------------------------ 안전 영역 */
  $('safeBtn').addEventListener('click', function () {
    state.safe = !state.safe;
    safeLayer.classList.toggle('off', !state.safe);
    $('safeBtn').classList.toggle('on', state.safe);
    $('safeBtn').setAttribute('aria-pressed', String(state.safe));
    $('stageHint').textContent = state.safe
      ? '미리보기 · 안전 영역은 저장되는 영상에 그려지지 않습니다'
      : '안전 영역 가이드 숨김 · 저장되는 영상에는 원래 그려지지 않습니다';
  });

  /* ------------------------------------------------------------------ 파일 입력 / 드래그 */
  $('pickBtn').addEventListener('click', function (e) { e.stopPropagation(); $('fileInput').click(); });
  dropZone.addEventListener('click', function (e) {
    if (e.target.closest('#pickBtn')) return;
    $('fileInput').click();
  });
  $('fileInput').addEventListener('change', function (e) {
    addFiles(e.target.files);
    e.target.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (ev) {
    dropZone.addEventListener(ev, function (e) {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('drag');
    });
  });
  ['dragleave', 'dragend'].forEach(function (ev) {
    dropZone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropZone.classList.remove('drag');
    });
  });
  dropZone.addEventListener('drop', function (e) {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drag');
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    if (!dropZone.contains(e.target)) e.preventDefault();
  });

  $('clearBtn').addEventListener('click', function () {
    if (state.exporting) { toast('영상을 만드는 중에는 비울 수 없어요.'); return; }
    if (!state.cuts.length && !state.bgm.name) { toast('이미 비어 있습니다.'); return; }
    if (!window.confirm('컷 ' + state.cuts.length + '개와 설정을 모두 비울까요? 저장하지 않은 작업은 사라집니다.')) return;
    pause();
    state.cuts.forEach(function (c) {
      if (c.kind === 'video' && c.el && c.el.parentNode) c.el.parentNode.removeChild(c.el);
      if (c.url && c.url.indexOf('blob:') === 0) { try { URL.revokeObjectURL(c.url); } catch (e) {} }
    });
    state.cuts = [];
    state.selId = null;
    state.playhead = 0;
    renderCutList();
    fillForm();
    updateLength();
    updateStageEmpty();
    renderAt(0);
    toast('작업 공간을 비웠습니다.');
  });

  /* ------------------------------------------------------------------ 샘플 컷 */
  var SAMPLES = [
    { bg1: '#1b1140', bg2: '#7c5cff', badge: 'UNBOXING', big: '01', label: '3만 원대 언박싱', text: '이 가격에 이 퀄리티?', style: 'yellow', pos: 'bottom', motion: 'in' },
    { bg1: '#3a0f24', bg2: '#ff4d8d', badge: '1 MONTH LATER', big: '02', label: '한 달 써 본 후기', text: '한 달 써 보고\n달라진 점 3가지', style: 'outline', pos: 'middle', motion: 'none' },
    { bg1: '#06251f', bg2: '#00c2a8', badge: 'VERDICT', big: '03', label: '결론', text: '결론은 재구매입니다 ✅', style: 'box', pos: 'bottom', motion: 'in' }
  ];

  function addSamples() {
    if (state.exporting) return;
    SAMPLES.forEach(function (s, i) {
      var c = document.createElement('canvas');
      c.width = 1080; c.height = 1920;
      var g = c.getContext('2d');
      var grd = g.createLinearGradient(0, 0, 1080, 1920);
      grd.addColorStop(0, s.bg1);
      grd.addColorStop(1, s.bg2);
      g.fillStyle = grd;
      g.fillRect(0, 0, 1080, 1920);

      g.save();
      g.globalAlpha = 0.18;
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2;
      for (var r = 0; r < 6; r++) {
        g.beginPath();
        g.arc(880, 300, 220 + r * 130, 0, Math.PI * 2);
        g.stroke();
      }
      g.restore();

      g.save();
      g.globalAlpha = 0.12;
      g.fillStyle = '#ffffff';
      g.font = '900 640px ' + FONT;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(s.big, 540, 1180);
      g.restore();

      g.fillStyle = 'rgba(0,0,0,.35)';
      roundRectOn(g, 540 - 200, 520, 400, 76, 38);
      g.fill();
      g.fillStyle = '#ffffff';
      g.font = '800 32px ' + FONT;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(s.badge, 540, 559);

      g.fillStyle = 'rgba(255,255,255,.7)';
      g.font = '700 30px ' + FONT;
      g.fillText('SHORTS STUDIO · SAMPLE', 540, 1720);

      var url = c.toDataURL('image/png');
      var thumb = makeThumbFromCanvas(c);
      var img = new Image();
      img.onload = function () {
        pushCut({
          kind: 'image',
          name: '샘플 ' + (i + 1) + ' · ' + s.label,
          el: img,
          url: url,
          thumb: thumb,
          duration: 2.5,
          motion: s.motion,
          transition: i === 1 ? 'fade' : 'cut',
          text: s.text,
          pos: s.pos,
          size: 64,
          style: s.style
        });
      };
      img.src = url;
    });
    toast('샘플 컷 3개를 추가했습니다. 바로 재생해 보세요.');
  }

  function roundRectOn(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y);
    g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r);
    g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r);
    g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }

  function makeThumbFromCanvas(c) {
    try {
      var t = document.createElement('canvas');
      t.width = 90; t.height = 160;
      var g = t.getContext('2d');
      g.drawImage(c, 0, 0, 90, 160);
      return t.toDataURL('image/jpeg', 0.7);
    } catch (e) { return ''; }
  }

  $('sampleBtn').addEventListener('click', addSamples);
  $('emptySampleBtn').addEventListener('click', addSamples);

  /* ------------------------------------------------------------------ 내보내기 */
  function pickMime() {
    if (typeof window.MediaRecorder === 'undefined') return '';
    var mp4 = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4'
    ];
    var webm = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    var list = state.format === 'webm' ? webm : mp4.concat(webm);
    for (var i = 0; i < list.length; i++) {
      try { if (MediaRecorder.isTypeSupported(list[i])) return list[i]; } catch (e) {}
    }
    return '';
  }

  function setProgress(pct, title, foot) {
    $('exBar').style.width = clamp(pct, 0, 100) + '%';
    $('exPct').textContent = Math.round(clamp(pct, 0, 100)) + '%';
    if (title) $('exTitle').textContent = title;
    if (foot) $('exFoot').textContent = foot;
  }

  function stamp() {
    var d = new Date();
    function two(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes());
  }

  function failExport(msg) {
    state.exporting = false;
    $('exportBtn').disabled = false;
    $('exTitle').textContent = '저장하지 못했습니다';
    $('exFoot').textContent = msg;
    toast(msg, true);
  }

  function exportVideo() {
    if (state.exporting) return;
    if (!state.cuts.length) { toast('먼저 사진이나 영상을 추가하세요.', true); return; }
    if (typeof window.MediaRecorder === 'undefined') { toast('이 브라우저는 MediaRecorder를 지원하지 않아 저장할 수 없습니다.', true); return; }

    pause();
    state.exporting = true;
    $('exportBtn').disabled = true;
    $('exportCard').hidden = false;
    setProgress(0, '영상 준비 중…', '첫 프레임을 준비하고 있어요.');

    var mime = pickMime();
    var stream, rec, chunks = [];
    var total = totalDuration();
    var t0 = 0;
    var stoppedResolve;
    var stopped = new Promise(function (res) { stoppedResolve = res; });

    function cleanup() {
      try { bgmAudio.pause(); } catch (e) {}
      state.cuts.forEach(function (c) {
        if (c.kind === 'video' && c.el) { try { c.el.pause(); } catch (e) {} }
      });
      try { stream.getVideoTracks().forEach(function (tr) { tr.stop(); }); } catch (e) {}
    }

    function begin() {
      state.playhead = 0;
      state.cuts.forEach(function (c) {
        if (c.kind === 'video' && c.el) { try { c.el.currentTime = 0; } catch (e) {} }
      });
      renderAt(0);

      try {
        stream = cvs.captureStream(FPS);
      } catch (e) {
        cleanup();
        failExport('이 브라우저는 캔버스 녹화(captureStream)를 지원하지 않습니다.');
        return;
      }

      if (state.bgm.name) {
        ensureAudio();
        if (actx && actx.state === 'suspended') actx.resume().catch(function () {});
        applyVolume();
        if (destNode) {
          var at = destNode.stream.getAudioTracks()[0];
          if (at) stream.addTrack(at);
        }
      }

      var opts = { videoBitsPerSecond: 12000000 };
      if (mime) opts.mimeType = mime;
      try {
        rec = new MediaRecorder(stream, opts);
      } catch (e1) {
        try { rec = new MediaRecorder(stream); } catch (e2) {
          cleanup();
          failExport('이 브라우저에서는 영상 녹화를 시작할 수 없습니다. Chrome 또는 Safari 최신 버전에서 다시 시도해 주세요.');
          return;
        }
      }

      rec.ondataavailable = function (e) {
        if (e.data && e.data.size) chunks.push(e.data);
      };
      rec.onstop = function () { stoppedResolve(); };
      rec.onerror = function () {
        cleanup();
        failExport('녹화 중 오류가 발생했습니다. 다시 시도해 주세요.');
      };

      try {
        rec.start(250);
      } catch (e) {
        cleanup();
        failExport('녹화를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.');
        return;
      }

      if (state.bgm.name) {
        try { bgmAudio.currentTime = 0; } catch (e) {}
        var pr = bgmAudio.play();
        if (pr && pr.catch) pr.catch(function () {});
      }

      var shownMime = (rec.mimeType || mime || 'video/webm').indexOf('mp4') >= 0 ? 'MP4' : 'WebM';
      t0 = performance.now();

      function step() {
        if (!state.exporting) { finish(true); return; }
        var elapsed = (performance.now() - t0) / 1000;
        var t = Math.min(elapsed, total);
        state.playhead = t;
        syncVideos(t, true);
        renderAt(t);
        var pct = total > 0 ? Math.min(99, (elapsed / total) * 100) : 0;
        var remain = Math.max(0, Math.ceil(total - elapsed));
        setProgress(pct, '영상 만드는 중… ' + shownMime, '남은 시간 약 ' + remain + '초 · 이 화면을 유지해 주세요.');
        if (elapsed >= total) { finish(false); return; }
        requestAnimationFrame(step);
      }

      function finish(aborted) {
        if (!state.exporting) return;
        state.exporting = false;
        try { rec.stop(); } catch (e) {}
        stopped.then(function () {
          cleanup();
          $('exportBtn').disabled = false;
          if (aborted) {
            $('exTitle').textContent = '저장이 중단되었습니다';
            $('exFoot').textContent = '다시 “영상 저장”을 눌러 주세요.';
            return;
          }
          var type = (rec.mimeType || mime || 'video/webm').split(';')[0];
          var blob = new Blob(chunks, { type: type });
          if (!blob.size) {
            $('exTitle').textContent = '저장하지 못했습니다';
            $('exFoot').textContent = '녹화된 데이터가 없습니다. 다시 시도해 주세요.';
            return;
          }
          var ext = type.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
          var codecs = rec.mimeType || mime || '';
          var audioOpus = /opus/i.test(codecs);
          var name = 'shorts_' + stamp() + '.' + ext;
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 60000);

          var mb = (blob.size / 1048576).toFixed(1);
          setProgress(100, '저장 완료 · ' + (ext === 'mp4' ? 'MP4' : 'WebM'), name + ' · ' + fmt(total) + '초 · ' + mb + 'MB 내려받기 시작');
          var footEl = $('exFoot');
          if (ext === 'webm' && state.format !== 'webm') {
            footEl.textContent += ' · 이 브라우저는 MP4 녹화를 지원하지 않아 WebM으로 저장했습니다. 유튜브는 그대로 업로드되고, 인스타 릴스는 MP4 변환이 필요할 수 있어요.';
          } else if (ext === 'webm') {
            footEl.textContent += ' · 유튜브 업로드에 최적인 형식입니다.';
          } else if (audioOpus && state.bgm.name) {
            footEl.textContent += ' · 오디오는 Opus로 담겼습니다. 아이폰·인스타에서 소리가 인식되지 않으면 저장 형식을 WebM으로 바꿔 유튜브에 올려 주세요.';
          }
          toast('영상 저장 완료 · ' + name);
          state.playhead = 0;
          renderAt(0);
        });
      }

      requestAnimationFrame(step);
    }

    // 첫 프레임이 그려진 뒤 시작 (검은 첫 프레임 방지)
    requestAnimationFrame(function () {
      setTimeout(begin, 60);
    });
  }

  $('exportBtn').addEventListener('click', exportVideo);

  $('formatSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-v]');
    if (!b || state.exporting) return;
    state.format = b.dataset.v;
    setSeg($('formatSeg'), state.format);
    $('formatNote').textContent = state.format === 'webm'
      ? '유튜브 업로드에 최적입니다. 오디오가 항상 정상으로 들어갑니다.'
      : 'MP4는 아이폰·인스타에 바로 올리기 좋습니다.';
  });

  /* ------------------------------------------------------------------ 도움말 */
  $('helpBtn').addEventListener('click', function () { $('helpModal').hidden = false; });
  $('helpClose').addEventListener('click', function () { $('helpModal').hidden = true; });
  $('helpModal').addEventListener('click', function (e) {
    if (e.target === $('helpModal')) $('helpModal').hidden = true;
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('helpModal').hidden) $('helpModal').hidden = true;
  });

  /* ------------------------------------------------------------------ 초기화 */
  function init() {
    renderCutList();
    fillForm();
    updateLength();
    updateStageEmpty();
    updatePlayBtn();
    $('volVal').textContent = Math.round(state.bgm.vol * 100) + '%';
    renderAt(0);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { requestRender(); });
    }
    // 비디오 시킹 후 미리보기 프레임 갱신
    state.cuts.forEach(function (c) {
      if (c.kind === 'video' && c.el) {
        c.el.addEventListener('seeked', function () {
          if (!state.playing && !state.exporting) requestRender();
        });
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
