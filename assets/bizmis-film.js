/*
 * The Bizmis demo film in the hero (snippets/bizmis-film.liquid): a port of bizmis.ai's hero film player
 * (trujilloai-bizmis-landing src/components/Hero.tsx + src/components/film/FilmPlayer.tsx, "bare" + "fill"), as in the
 * Meridian demo store (shopify-theme-crimson-index), with the player's words in the film's language (Spanish).
 * - idle:    the hero is the film's poster: the landing's glass play button over its picture, and a click anywhere on
 *            it plays. Nothing of the film loads before the first press.
 * - playing: the film over the whole window through an iris from the button, edge to edge on black; the store's
 *            header, the hero picture, the live widget and the page's scrollbar step aside. The dock hides while the
 *            pointer rests.
 * - paused:  the frame holds, with a glass play button in the middle.
 * - ended:   the film holds its closing frame and its install title becomes a button in place.
 * ✕, Escape or a click outside the hero closes it (the iris runs back); play again resumes where it stopped.
 * Captions (off by default, the choice remembered): the .vtt's narrator and shopper lines in the landing's caption
 * pill, tagged with their voice. HLS through hls.js (loaded on the first play) or natively where there is no
 * MediaSource (iOS).
 */
(function () {
  'use strict';

  var CONTROLS_IDLE_MS = 2500;
  var PEAK_OVER_AVERAGE = 2.5; // auto quality judges a rendition by its peak: cap it at this many times its average
  var SEEK_STEP_S = 5;
  var IRIS_MS = 950;
  var CAPTIONS_KEY = 'bizmis.film.captions';
  // the player's words: Spanish by default, the visitor's language from the snippet's data-i18n (locales bizmis.film.*)
  var T = {
    play: 'Reproducir',
    pause: 'Pausa',
    replay: 'Ver de nuevo',
    mute: 'Silenciar',
    unmute: 'Activar el sonido',
    fullscreen: 'Pantalla completa',
    exitFullscreen: 'Salir de pantalla completa',
    captions: 'Subtítulos',
    auto: 'Auto'
  };
  var VOICE_LABELS = { narrator: 'Narrador', shopper: 'Cliente' };
  (function () {
    var el = document.querySelector('[data-bizmis-film][data-i18n]');
    var words = {};
    try { words = JSON.parse(el ? el.getAttribute('data-i18n') : '{}') || {}; } catch (e) { words = {}; }
    Object.keys(T).forEach(function (k) { if (words[k]) T[k] = words[k]; });
    if (words.narrator) VOICE_LABELS.narrator = words.narrator;
    if (words.shopper) VOICE_LABELS.shopper = words.shopper;
  })();
  var CAPTIONS_LANG = 'es';

  var easeInOut = function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  var formatTime = function (s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60);
    var sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  };
  var qualityLabel = function (h) { return h >= 2160 ? '4K' : h + 'p'; };
  var reducedMotion = function () { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; };

  var vttTime = function (t) { return t.trim().split(':').map(Number).reduce(function (a, n) { return a * 60 + n; }, 0); };
  // A small WebVTT reader: timings, the <v> voice, text without tags (the player lays out its own lines).
  var parseVtt = function (vtt) {
    return vtt.replace(/\r/g, '').split(/\n\n+/).reduce(function (out, block) {
      var lines = block.split('\n');
      var at = lines.findIndex(function (l) { return l.indexOf('-->') !== -1; });
      if (at === -1) return out;
      var parts = lines[at].split('-->');
      var raw = lines.slice(at + 1).join(' ');
      var voice = (raw.match(/<v(?:\.[^\s>]+)*\s+([^>]+)>/) || [])[1];
      var text = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (text) out.push({ start: vttTime(parts[0]), end: vttTime(parts[1].trim().split(/\s/)[0]), text: text, voice: voice ? voice.trim() : '' });
      return out;
    }, []);
  };
  var readCaptionsPref = function () {
    try { return window.localStorage.getItem(CAPTIONS_KEY) === 'on'; } catch (e) { return false; }
  };
  var loadScript = function (url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url; s.async = true; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  };

  function init(layer) {
    var hero = layer.closest('.hero') || layer.parentElement;
    // the player covers the whole window (over the store's header and promo strip): it lives in <body>, out of the
    // hero's stacking context and transforms
    document.body.appendChild(layer);
    var $ = function (sel) { return layer.querySelector(sel); };
    var root = $('[data-film-root]');
    var iris = $('[data-film-iris]');
    var glow = $('[data-film-glow]');
    var film = $('[data-film-video]');
    // the play disc over the hero and any other trigger in its copy (the heading's second line); the iris opens from the disc
    var openBtns = Array.prototype.slice.call(hero.querySelectorAll('[data-film-open]'));
    var disc = hero.querySelector('[data-play]') || openBtns[0];
    var resumeBtn = $('[data-film-resume]');
    var toggleBtn = $('[data-film-toggle]');
    var muteBtn = $('[data-film-mute]');
    var volumeInput = $('[data-film-volume]');
    var ccBtn = $('[data-film-cc]');
    var fsBtn = $('[data-film-fullscreen]');
    var closeBtn = $('[data-film-close]');
    var track = $('[data-film-track]');
    var played = $('[data-film-played]');
    var bufferedEl = $('[data-film-buffered]');
    var knob = $('[data-film-knob]');
    var tip = $('[data-film-tip]');
    var timeEl = $('[data-film-time]');
    var durationEl = $('[data-film-duration]');
    var endCta = $('[data-film-end-cta]');
    var ccBox = $('[data-film-cc-box]');
    var bar = $('[data-film-bar]');
    var quality = $('[data-film-quality]');
    var qualityBtn = $('[data-film-quality-btn]');
    var qualityLabelEl = $('[data-film-quality-label]');
    var qualityMenu = $('[data-film-quality-menu]');
    var icons = $('[data-film-icons]').content;
    var src = layer.getAttribute('data-src');
    var captionsSrc = layer.getAttribute('data-captions');
    var endBox = (layer.getAttribute('data-end-cta') || '').split(',').map(Number);
    // a film that fades out ends this many seconds early, on its last clean frame (the closing CTA)
    var endHold = Number(layer.getAttribute('data-end-hold')) || 0;

    var phase = 'idle';
    var hls = null;
    var ready = null;
    var hideTimer = 0;
    var waitTimer = 0;
    var scrubbing = false;
    var irisState = { r: 0, cx: 0, cy: 0, frame: 0 };
    var levels = [];
    var level = -1;
    var playingHeight = null;
    var ccOn = readCaptionsPref();
    var cues = null;
    var cuesFetch = null;
    var cueIndex = -1;
    var cueRaf = 0;
    var picture = { left: 0, top: 0, width: 0, height: 0 };

    // where the picture actually sits inside the <video> (object-fit: contain letterboxes it), in px
    function measure() {
      var w = film.clientWidth;
      var h = film.clientHeight;
      var aspect = film.videoWidth && film.videoHeight ? film.videoWidth / film.videoHeight : 16 / 9;
      var pw = Math.min(w, h * aspect);
      var ph = pw / aspect;
      picture = { left: (w - pw) / 2, top: (h - ph) / 2, width: pw, height: ph };
      placeEndCta();
      renderCue(true);
    }

    function setPhase(p) {
      phase = p;
      layer.setAttribute('data-phase', p);
      toggleBtn.setAttribute('aria-label', p === 'playing' ? T.pause : p === 'ended' ? T.replay : T.play);
      endCta.hidden = p !== 'ended';
      if (p === 'ended') placeEndCta();
      updateControls();
      runCaptions();
    }

    // Controls stay up unless the film is playing and the pointer rests.
    function updateControls() {
      var awake = layer.classList.contains('is-awake');
      var show = phase !== 'idle' && (phase !== 'playing' || awake || !quality.hidden && !qualityMenu.hidden);
      layer.classList.toggle('is-controls', show);
      renderCue(false);
    }
    function wake() {
      layer.classList.add('is-awake');
      updateControls();
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () {
        if (!scrubbing) { layer.classList.remove('is-awake'); updateControls(); }
      }, CONTROLS_IDLE_MS);
    }

    // The film's end: the film's own install title becomes a button in place (the landing's .bzf-end-cta geometry).
    function placeEndCta() {
      if (endBox.length !== 4 || !picture.width) return;
      var h = (endBox[3] + 0.08) * picture.height;
      endCta.style.left = picture.left + (endBox[0] - 0.026) * picture.width + 'px';
      endCta.style.top = picture.top + (endBox[1] - 0.04) * picture.height + 'px';
      endCta.style.width = (endBox[2] + 0.052) * picture.width + 'px';
      endCta.style.height = h + 'px';
      endCta.style.borderRadius = 0.22 * h + 'px';
    }

    // ---- HLS: hls.js sized to the player, or native
    function capToPlayer() {
      if (!hls || !hls.levels || !hls.levels.length) return;
      // 25% headroom keeps the film's small UI text crisp.
      var scale = Math.min(window.devicePixelRatio || 1, 2) * 1.25;
      var needW = film.clientWidth * scale;
      var needH = film.clientHeight * scale;
      var fit = hls.levels.findIndex(function (l) { return l.width >= needW && l.height >= needH; });
      hls.autoLevelCapping = fit === -1 ? hls.levels.length - 1 : fit;
    }
    function ensureSource() {
      if (ready) return ready;
      var isHls = /\.m3u8(\?|$)/.test(src);
      if (!isHls || !(window.MediaSource || window.ManagedMediaSource)) {
        film.src = src;
        ready = Promise.resolve();
        return ready;
      }
      ready = (window.Hls ? Promise.resolve() : loadScript(layer.getAttribute('data-hls-js'))).then(function () {
        var Hls = window.Hls;
        if (!Hls || !Hls.isSupported()) { film.src = src; return; }
        // Buffer only ~20 s ahead (40 s at most); auto quality starts from a broadband guess (3 Mbps).
        hls = new Hls({ maxBufferLength: 20, maxMaxBufferLength: 40, abrEwmaDefaultEstimate: 3000000 });
        hls.on(Hls.Events.LEVEL_SWITCHED, function (_e, data) {
          playingHeight = hls.levels[data.level] ? hls.levels[data.level].height : null;
          renderQualityLabel();
        });
        return new Promise(function (resolve) {
          hls.once(Hls.Events.MANIFEST_PARSED, function () {
            hls.levels.forEach(function (l) {
              if (l.averageBitrate && l.bitrate > l.averageBitrate * PEAK_OVER_AVERAGE) l.bitrate = Math.round(l.averageBitrate * PEAK_OVER_AVERAGE);
            });
            levels = hls.levels.map(function (l) { return l.height; });
            quality.hidden = levels.length < 2;
            renderQualityMenu();
            capToPlayer();
            resolve();
          });
          hls.loadSource(src);
          hls.attachMedia(film);
        });
      });
      return ready;
    }

    // ---- quality menu (nextLevel: playback carries on through what's buffered, no stall)
    function renderQualityLabel() {
      qualityLabelEl.textContent = level === -1 ? T.auto + (playingHeight ? ' · ' + qualityLabel(playingHeight) : '') : qualityLabel(levels[level]);
    }
    function renderQualityMenu() {
      var order = [-1].concat(levels.map(function (_, i) { return i; }).sort(function (a, b) { return levels[b] - levels[a]; }));
      qualityMenu.innerHTML = '';
      order.forEach(function (i) {
        var li = document.createElement('li');
        li.setAttribute('role', 'none');
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'bzf-quality__item';
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', String(level === i));
        b.appendChild(icons.querySelector('[data-icon="check"]').cloneNode(true));
        var label = document.createElement('span');
        label.className = 'bzf-quality__name';
        label.textContent = i === -1 ? T.auto : qualityLabel(levels[i]);
        if (i === -1 && level === -1 && playingHeight) {
          var now = document.createElement('span');
          now.className = 'bzf-quality__now';
          now.textContent = qualityLabel(playingHeight);
          label.appendChild(now);
        }
        b.appendChild(label);
        if (i !== -1 && levels[i] >= 2160) {
          var uhd = document.createElement('span');
          uhd.className = 'bzf-quality__uhd';
          uhd.textContent = 'UHD';
          b.appendChild(uhd);
        }
        b.addEventListener('click', function () { chooseLevel(i); });
        li.appendChild(b);
        qualityMenu.appendChild(li);
      });
      renderQualityLabel();
    }
    function openQuality(open) {
      qualityMenu.hidden = !open;
      qualityBtn.setAttribute('aria-expanded', String(open));
      qualityBtn.classList.toggle('is-open', open);
      if (open) {
        renderQualityMenu();
        var chosen = qualityMenu.querySelector('[aria-checked="true"]');
        if (chosen) chosen.focus({ preventScroll: true });
      }
      updateControls();
    }
    function chooseLevel(i) {
      if (hls) hls.nextLevel = i;
      level = i;
      openQuality(false);
      qualityBtn.focus({ preventScroll: true });
      renderQualityLabel();
    }
    qualityBtn.addEventListener('click', function () { openQuality(qualityMenu.hidden); });
    qualityMenu.addEventListener('keydown', function (e) {
      var items = Array.prototype.slice.call(qualityMenu.querySelectorAll('[role="menuitemradio"]'));
      var at = items.indexOf(document.activeElement);
      var go = function (i) { var it = items[(i + items.length) % items.length]; if (it) it.focus({ preventScroll: true }); };
      switch (e.key) {
        case 'ArrowDown': go(at + 1); break;
        case 'ArrowUp': go(at - 1); break;
        case 'Home': go(0); break;
        case 'End': go(items.length - 1); break;
        case 'Escape': openQuality(false); qualityBtn.focus({ preventScroll: true }); break;
        case 'Tab': openQuality(false); return;
        case ' ': case 'Enter': e.stopPropagation(); return; // the item's own click picks it
        default: return;
      }
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('pointerdown', function (e) {
      if (!qualityMenu.hidden && !qualityMenu.contains(e.target) && !qualityBtn.contains(e.target)) openQuality(false);
    }, true);

    // ---- captions: drawn by the player in the landing's caption pill, the voice tagged
    // the .vtt may name its voices in English or in Spanish
    function voiceKey(v) {
      return /^(shopper|cliente|comprador|compradora)$/i.test(v) ? 'shopper' : /^(narrator|narrador|narradora)$/i.test(v) ? 'narrator' : '';
    }
    function renderCue(force) {
      var on = ccOn && cues && phase !== 'idle' && picture.width > 0;
      var cue = on && cueIndex >= 0 ? cues[cueIndex] : null;
      ccBox.hidden = !on;
      if (!on) return;
      var fontSize = Math.min(34, Math.max(12.5, picture.width * 0.0142));
      var pillHeight = fontSize * 2;
      var below = picture.top; // the letterbox under the picture (it's centred)
      var controlsTop = picture.width < 640 ? 62 : 88; // the dock's top, plus a gap
      var inLetterbox = below >= pillHeight * 2.6 + 12;
      ccBox.style.left = picture.left + picture.width * 0.05 + 'px';
      ccBox.style.width = picture.width * 0.9 + 'px';
      if (inLetterbox) {
        ccBox.style.top = picture.top + picture.height + 12 + 'px';
        ccBox.style.bottom = '';
      } else {
        ccBox.style.top = '';
        ccBox.style.bottom = Math.max(below + picture.height * 0.03, layer.classList.contains('is-controls') ? controlsTop : 0) + 'px';
      }
      var shown = ccBox.getAttribute('data-cue');
      if (!force && shown === String(cueIndex)) {
        var p0 = ccBox.firstChild;
        if (p0) p0.style.fontSize = fontSize + 'px';
        return;
      }
      ccBox.setAttribute('data-cue', String(cueIndex));
      ccBox.innerHTML = '';
      ccBox.setAttribute('aria-hidden', String(!cue));
      if (!cue) return;
      var p = document.createElement('p');
      p.className = 'bzf-cc';
      p.lang = CAPTIONS_LANG;
      p.style.fontSize = fontSize + 'px';
      var key = voiceKey(cue.voice);
      if (cue.voice) {
        var tag = document.createElement('span');
        tag.className = 'bzf-cc__tag bzf-cc__tag--' + (key || 'other');
        var icon = icons.querySelector('[data-icon="' + (key || 'narrator') + '"]').cloneNode(true);
        icon.setAttribute('class', 'bzf-cc__mic');
        tag.appendChild(icon);
        tag.appendChild(document.createTextNode(VOICE_LABELS[key] || cue.voice));
        p.appendChild(tag);
      }
      var text = document.createElement('span');
      text.className = 'bzf-cc__text';
      text.textContent = cue.text;
      p.appendChild(text);
      ccBox.appendChild(p);
    }
    // The cue on screen, read every frame (timeupdate only fires ~4 times a second).
    function runCaptions() {
      cancelAnimationFrame(cueRaf);
      if (!ccOn || !cues || phase === 'idle') { cueIndex = -1; renderCue(true); return; }
      var tick = function () {
        var t = film.currentTime;
        var i = cues.findIndex(function (c) { return t >= c.start && t < c.end; });
        if (i !== cueIndex) { cueIndex = i; renderCue(true); }
        cueRaf = requestAnimationFrame(tick);
      };
      tick();
    }
    function loadCues() {
      if (!ccOn || !captionsSrc || cuesFetch) return;
      cuesFetch = fetch(captionsSrc)
        .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error('captions ' + r.status)); })
        .then(function (vtt) { cues = parseVtt(vtt); runCaptions(); })
        .catch(function () { cuesFetch = null; }); // try again on the next toggle
    }
    function setCc(on) {
      ccOn = on;
      try { window.localStorage.setItem(CAPTIONS_KEY, on ? 'on' : 'off'); } catch (e) { /* private mode: this visit only */ }
      if (ccBtn) ccBtn.setAttribute('aria-pressed', String(on));
      loadCues();
      runCaptions();
    }
    if (ccBtn) {
      ccBtn.setAttribute('aria-pressed', String(ccOn));
      ccBtn.addEventListener('click', function () { setCc(!ccOn); });
    }
    // iPhone fullscreen is the system player, where these captions can't be drawn: hand it the cues as a native track.
    var nativeTrack = null;
    film.addEventListener('webkitbeginfullscreen', function () {
      if (!ccOn || !cues || !cues.length) return;
      if (!nativeTrack) {
        nativeTrack = film.addTextTrack('captions', T.captions, CAPTIONS_LANG);
        cues.forEach(function (c) { nativeTrack.addCue(new VTTCue(c.start, c.end, (c.voice ? c.voice + ': ' : '') + c.text)); });
      }
      nativeTrack.mode = 'showing';
    });
    film.addEventListener('webkitendfullscreen', function () { if (nativeTrack) nativeTrack.mode = 'disabled'; });

    // ---- the iris: a soft-edged circle from the play button (and a glow riding its edge)
    function paintIris() {
      layer.style.setProperty('--r', irisState.r + 'px');
      layer.style.setProperty('--cx', irisState.cx + 'px');
      layer.style.setProperty('--cy', irisState.cy + 'px');
      var far = Math.hypot(layer.clientWidth, layer.clientHeight);
      glow.style.opacity = String(Math.max(0, Math.min(1, 1.6 * (1 - irisState.r / far))));
    }
    function runIris(to, done) {
      cancelAnimationFrame(irisState.frame);
      var from = irisState.r;
      var still = reducedMotion();
      var t0 = performance.now();
      var step = function (now) {
        var t = still ? 1 : Math.min(1, (now - t0) / IRIS_MS);
        irisState.r = from + (to - from) * easeInOut(t);
        paintIris();
        if (t < 1) irisState.frame = requestAnimationFrame(step);
        else if (done) done();
      };
      irisState.frame = requestAnimationFrame(step);
    }

    // ---- open / close
    function setOpen(open) {
      hero.classList.toggle('is-film-open', open);
      document.documentElement.classList.toggle('bizmis-film-open', open);
    }
    function play() {
      ensureSource().then(function () {
        var pr = film.play();
        if (pr && pr.catch) pr.catch(function () { setPhase('paused'); });
      });
      setPhase('playing');
      wake();
    }
    function replay() {
      film.currentTime = 0;
      var pr = film.play();
      if (pr && pr.catch) pr.catch(function () { setPhase('paused'); });
      setPhase('playing');
      wake();
    }
    function pauseInPlace() {
      film.pause();
      setPhase('paused');
    }
    function togglePlay() {
      if (phase === 'playing') pauseInPlace();
      else if (phase === 'ended') replay();
      else play();
    }
    function fullscreen() {
      if (document.fullscreenElement) return;
      if (root.requestFullscreen) root.requestFullscreen().catch(function () {});
      else if (film.webkitEnterFullscreen) film.webkitEnterFullscreen(); // iOS Safari: only the <video> goes fullscreen
    }
    function openFilm() {
      if (phase !== 'idle') return;
      layer.hidden = false; // shown (still masked shut) before it is measured
      var box = layer.getBoundingClientRect();
      var target = disc.getBoundingClientRect();
      var cx = target.left + target.width / 2 - box.left;
      var cy = target.top + target.height / 2 - box.top;
      var far = Math.max(Math.hypot(cx, cy), Math.hypot(box.width - cx, cy), Math.hypot(cx, box.height - cy), Math.hypot(box.width - cx, box.height - cy));
      irisState.cx = cx;
      irisState.cy = cy;
      paintIris();
      setOpen(true);
      if (phase === 'ended') replay();
      else play(); // in the click itself, so the film may start with sound
      root.focus({ preventScroll: true });
      measure();
      // on a phone the 16:9 film would be a strip across a portrait screen: go fullscreen
      if (window.matchMedia('(max-width: 1023px) and (pointer: coarse)').matches) fullscreen();
      runIris(far + 160);
    }
    function closeFilm() {
      if (phase === 'idle') return;
      if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
      film.pause();
      openQuality(false);
      setPhase('idle');
      setOpen(false);
      runIris(0, function () { if (phase === 'idle') layer.hidden = true; });
      (disc.closest('button') || disc).focus({ preventScroll: true });
    }

    openBtns.forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); openFilm(); }); });
    // any click on the hero plays the film, except on its links, buttons, fields and the slideshow's controls
    hero.classList.add('has-film');
    hero.addEventListener('click', function (e) {
      if (phase !== 'idle') return;
      if (e.target.closest('a, button, input, select, textarea, label, .hero__nav')) return;
      openFilm();
    });
    closeBtn.addEventListener('click', closeFilm);
    resumeBtn.addEventListener('click', play);
    toggleBtn.addEventListener('click', togglePlay);
    film.addEventListener('click', togglePlay);
    fsBtn.addEventListener('click', function () {
      if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
      else fullscreen();
    });
    document.addEventListener('fullscreenchange', function () {
      layer.classList.toggle('is-fullscreen', document.fullscreenElement === root);
      fsBtn.setAttribute('aria-label', document.fullscreenElement === root ? T.exitFullscreen : T.fullscreen);
    });

    // volume
    muteBtn.addEventListener('click', function () {
      film.muted = !film.muted;
      if (!film.muted && film.volume === 0) film.volume = 1;
    });
    volumeInput.addEventListener('input', function () {
      film.volume = Number(volumeInput.value);
      film.muted = film.volume === 0;
    });
    film.addEventListener('volumechange', function () {
      var off = film.muted || film.volume === 0;
      layer.classList.toggle('is-muted', off);
      muteBtn.setAttribute('aria-label', off ? T.unmute : T.mute);
      volumeInput.value = String(film.muted ? 0 : film.volume);
    });

    // timeline: hover tooltip + pointer scrubbing
    var duration = 0;
    function fractionAt(x) {
      var r = track.getBoundingClientRect();
      return Math.min(1, Math.max(0, (x - r.left) / r.width));
    }
    function seekTo(t) {
      if (!duration) return;
      film.currentTime = Math.min(Math.max(0, t), duration);
      renderTime();
      if (phase === 'ended' && film.currentTime < duration) setPhase('paused');
    }
    track.addEventListener('pointerdown', function (e) {
      scrubbing = true;
      track.setPointerCapture(e.pointerId);
      seekTo(fractionAt(e.clientX) * duration);
    });
    track.addEventListener('pointermove', function (e) {
      var f = fractionAt(e.clientX);
      tip.hidden = false;
      tip.style.left = f * 100 + '%';
      tip.textContent = formatTime(f * duration);
      if (scrubbing) seekTo(f * duration);
    });
    track.addEventListener('pointerup', function () { scrubbing = false; wake(); });
    track.addEventListener('pointerleave', function () { tip.hidden = true; });

    function renderTime() {
      var t = film.currentTime;
      var pct = duration ? (t / duration) * 100 : 0;
      played.style.width = pct + '%';
      knob.style.left = pct + '%';
      timeEl.textContent = formatTime(t);
      track.setAttribute('aria-valuenow', String(Math.round(t)));
      track.setAttribute('aria-valuetext', formatTime(t) + ' / ' + formatTime(duration));
    }

    // film element events
    film.addEventListener('loadedmetadata', function () {
      if (isFinite(film.duration)) {
        duration = film.duration;
        durationEl.textContent = formatTime(duration);
        track.setAttribute('aria-valuemax', String(Math.round(duration)));
      }
      measure();
    });
    film.addEventListener('timeupdate', function () {
      if (endHold && phase === 'playing' && duration && film.currentTime >= duration - endHold) {
        film.pause();
        film.currentTime = duration - endHold;
        setPhase('ended');
        wake();
      }
      renderTime();
    });
    film.addEventListener('progress', function () {
      if (film.buffered.length && duration) bufferedEl.style.width = (film.buffered.end(film.buffered.length - 1) / duration) * 100 + '%';
    });
    film.addEventListener('ended', function () { setPhase('ended'); wake(); });
    // only show the spinner for a real stall, not every brief "waiting" blip
    film.addEventListener('waiting', function () {
      clearTimeout(waitTimer);
      waitTimer = setTimeout(function () { layer.classList.add('is-stalled'); }, 250);
    });
    ['playing', 'canplay', 'pause'].forEach(function (ev) {
      film.addEventListener(ev, function () { clearTimeout(waitTimer); layer.classList.remove('is-stalled'); });
    });

    if (window.ResizeObserver) new ResizeObserver(function () { measure(); capToPlayer(); }).observe(film);

    // keyboard (on the player)
    root.addEventListener('keydown', function (e) {
      if (e.target instanceof HTMLInputElement) return;
      switch (e.key) {
        case ' ': case 'k': e.preventDefault(); togglePlay(); break;
        case 'm': film.muted = !film.muted; break;
        case 'f': if (document.fullscreenElement) document.exitFullscreen().catch(function () {}); else fullscreen(); break;
        case 'c': if (ccBtn) setCc(!ccOn); break;
        case 'ArrowLeft': e.preventDefault(); seekTo(film.currentTime - SEEK_STEP_S); break;
        case 'ArrowRight': e.preventDefault(); seekTo(film.currentTime + SEEK_STEP_S); break;
        default: break;
      }
      wake();
    });
    root.addEventListener('pointermove', function () { if (phase !== 'idle') wake(); });

    // click-off: anywhere outside the hero sends an open film back; Escape too
    document.addEventListener('pointerdown', function (e) {
      if (phase === 'idle' || document.fullscreenElement) return;
      if (!layer.contains(e.target) && !hero.contains(e.target)) closeFilm();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && phase !== 'idle' && !document.fullscreenElement && qualityMenu.hidden) closeFilm();
    });

    // ---- the clerk's invite (bizmis.ai's hero agent, HeroAgent.tsx, on the store's own clerk): it says hello with a
    // wave, says what it does, then "¡Dale al play!" while it points at the film (its right: the visitor's left, where the
    // film's button is), in its own captions (AvatarVoicechat.say); then what it does and the invite take turns. Only
    // while the film is closed, the hero in view and the clerk's card showing (phones: captions, no pointing); it stops
    // for good once the visitor turns to the clerk. ?noagent hides the clerk, and with it the invite.
    var agentLines = (layer.getAttribute('data-agent-lines') || '').split('|').map(function (l) { return l.trim(); }).filter(Boolean);
    (function invite() {
      if (agentLines.length < 2 || document.documentElement.classList.contains('no-bizmis-agent')) return;
      var START_MS = 2500;
      var HOLD_MS = 1300;
      var INVITE_REST_MS = 5000;
      var RETRY_MS = 1000;
      var desktop = window.matchMedia('(min-width: 750px)');
      var heroSeen = true;
      var stopped = false;
      var step = 0;
      var timer = 0;
      var clerk = function () {
        return window.AvatarVoicechat && typeof window.AvatarVoicechat.say === 'function' ? window.AvatarVoicechat : null;
      };
      // the clerk's card is up (not folded into its bubble): its avatar is drawn big (the widget's root itself has no
      // size, its card is fixed-positioned inside it); on phones its bar always is
      var cardShowing = function () {
        if (!desktop.matches) return true;
        return Array.prototype.some.call(document.querySelectorAll('#bizmis-avatar-embed canvas'), function (c) {
          var r = c.getBoundingClientRect();
          return r.width > 160 && r.height > 160;
        });
      };
      var stop = function () { stopped = true; clearTimeout(timer); };
      // the visitor turned to the clerk (its card, its bar or its captions): it never interrupts them again
      ['pointerdown', 'focusin', 'keydown'].forEach(function (ev) {
        document.addEventListener(ev, function (e) {
          var t = e.target;
          if (t && t.closest && t.closest('#bizmis-avatar-embed, .bizmis-viewport-portal-root')) stop();
        }, true);
      });
      if (window.IntersectionObserver) {
        new IntersectionObserver(function (entries) { heroSeen = entries[0].isIntersecting; }, { threshold: 0.35 }).observe(hero);
      }
      var tick = function () {
        if (stopped) return;
        var api = clerk();
        var root = document.documentElement;
        var waiting = !api || phase !== 'idle' || !heroSeen || document.hidden || !cardShowing()
          || root.classList.contains('is-clerk-intro') || root.classList.contains('bizmis-film-open');
        if (waiting) { timer = setTimeout(tick, RETRY_MS); return; }
        var last = step === agentLines.length - 1;
        var gesture = step === 0 ? 'waving' : last && desktop.matches ? 'pointing_right' : undefined;
        var line = agentLines[step];
        if (!api.say(line, gesture ? { gesture: gesture } : undefined)) {
          // a conversation is on: the visitor is talking to the clerk
          stop();
          return;
        }
        // the widget shows a caption ~1 s plus 0.2 s a word; the line then holds before the next
        var words = line.split(/\s+/).length;
        var next = last ? 1 : step + 1;
        var wait = 1000 + 220 * words + (last ? INVITE_REST_MS : HOLD_MS);
        step = next;
        timer = setTimeout(tick, wait);
      };
      timer = setTimeout(tick, START_MS);
    })();

    layer.classList.toggle('is-muted', false);
    if (ccBtn) loadCues();
    setPhase('idle');
  }

  function boot() {
    // html.store-hero (?storehero, ?nofilm, the recording links): the store's own hero, no film, no invite
    if (document.documentElement.classList.contains('store-hero')) return;
    document.querySelectorAll('[data-bizmis-film]').forEach(init);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
