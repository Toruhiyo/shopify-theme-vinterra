/* ============================================
   BIZMIS DEMO — early-access install loop (BIZ-134)
   --------------------------------------------
   bizmis.ai/demo redirects here with ?ref=<lead>&code=<early-access-code>&utm_*.
   The redirect only lands on the entry page, so we persist the attribution and
   re-apply it to every install CTA + code chip as the visitor browses the store.
   ============================================ */

(function () {
  'use strict';

  var STORAGE_KEY = 'bizmis:demo:attribution';
  var COACH_COLLAPSED_KEY = 'bizmis:coach:collapsed';

  /* Coachmark timing (kept slow + calm) and layout. */
  var COACH_START_MS = 1600;   // wait for the widget to mount before the first hint
  var COACH_SHOW_MS = 4800;    // how long a hint lingers
  var COACH_GAP_MS = 250;      // brief pause between hints (kept short)
  var COACH_FADE_MS = 600;     // matches the CSS fade duration
  var COACH_WORD_MS = 340;     // karaoke dwell per word (matches the landing page)
  var COACH_MARGIN = 12;       // viewport edge padding
  var COACH_GAP_PX = 10;       // gap between the hint and the widget card
  var COACH_FIND_MS = 250;     // how often to re-scan for the widget card
  var WIDGET_SELECTORS = ['#bizmis-avatar-embed', '.bizmis-avatar-widget-root', '#avatar-root', '[data-avatar-widget]'];
  /* Rendered by the widget when the visitor tucks it into the corner bubble
     (BIZ-275) — the coachmark must disappear with the card. */
  var WIDGET_MINIMIZED_SELECTOR = '.bizmis-minimized-bubble';
  var COACH_MINIMIZED_POLL_MS = 250;

  function isAttributionParam(key) {
    return key === 'ref' || key === 'code' || key.indexOf('utm_') === 0;
  }

  function readStored() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch (error) {
      return {};
    }
  }

  function writeStored(attribution) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(attribution));
    } catch (error) {
      /* Private mode / quota — attribution stays in-memory for this page only. */
    }
  }

  /* Merge fresh URL params over anything we persisted on an earlier page. */
  function resolveAttribution() {
    var stored = readStored();
    var params = new URLSearchParams(window.location.search);
    var changed = false;

    params.forEach(function (value, key) {
      if (isAttributionParam(key) && value) {
        stored[key] = value;
        changed = true;
      }
    });

    if (changed) writeStored(stored);
    return stored;
  }

  function effectiveCode(attribution, fallbackCode) {
    return attribution.code || fallbackCode || '';
  }

  function buildInstallUrl(base, attribution, fallbackCode) {
    var url;
    try {
      url = new URL(base, window.location.origin);
    } catch (error) {
      return base;
    }
    Object.keys(attribution).forEach(function (key) {
      if (isAttributionParam(key) && attribution[key]) {
        url.searchParams.set(key, attribution[key]);
      }
    });
    var code = effectiveCode(attribution, fallbackCode);
    if (code) url.searchParams.set('code', code);
    return url.toString();
  }

  function hydrateInstallLinks(attribution, fallbackCode) {
    var hasCode = Boolean(effectiveCode(attribution, fallbackCode));
    /* The long with-code label blows up the promo bar on phones; the code
       still rides along in the URL either way. */
    var compact = window.matchMedia('(max-width: 749px)').matches;
    document.querySelectorAll('[data-bizmis-install]').forEach(function (link) {
      if (!link.dataset.base) link.dataset.base = link.getAttribute('href') || '';
      link.setAttribute('href', buildInstallUrl(link.dataset.base, attribution, fallbackCode));

      var label = hasCode && !compact ? link.dataset.labelWithCode : link.dataset.labelNoCode;
      if (label) {
        var labelTarget = link.querySelector('[data-bizmis-install-label]') || link;
        labelTarget.textContent = label;
      }
    });
  }

  function findWidgetRoot() {
    for (var i = 0; i < WIDGET_SELECTORS.length; i++) {
      var el = document.querySelector(WIDGET_SELECTORS[i]);
      if (el) return el;
    }
    return null;
  }

  function hasBackground(el) {
    var style = window.getComputedStyle(el);
    var bg = style.backgroundColor;
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return true;
    /* Glassy surfaces may paint via a gradient only. */
    return style.backgroundImage !== 'none';
  }

  /* The visible widget is a framer-motion draggable card inside the fixed mount.
     The card overflows a much taller transparent avatar canvas, so we can't use
     the largest descendant. Instead take the largest element that actually paints
     a background — that's the card box, and it follows drags/scrolls/resizes. */
  function findWidgetCard(root) {
    var nodes = root.getElementsByTagName('*');
    var best = null;
    var bestArea = 0;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var r = el.getBoundingClientRect();
      var area = r.width * r.height;
      if (area <= bestArea) continue;
      if (!hasBackground(el)) continue;
      bestArea = area;
      best = el;
    }
    return best;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /* Keep the hint pinned just above the widget card every frame so it rides
     along with drags, scrolls, and resizes. */
  function trackToWidget(coach) {
    var root = null;
    var target = null;
    var lastFind = 0;

    function frame() {
      if (!root || !root.isConnected) root = findWidgetRoot();
      if (root && (!target || !target.isConnected)) {
        var now = (window.performance && performance.now()) || Date.now();
        if (now - lastFind > COACH_FIND_MS) { target = findWidgetCard(root); lastFind = now; }
      }

      var rect = target ? target.getBoundingClientRect() : (root ? root.getBoundingClientRect() : null);

      /* Match the widget card's width so the two stack as one column. The
         collapsed chip keeps its own compact size instead. */
      if (coach.classList.contains('is-collapsed')) {
        coach.style.width = '';
      } else if (rect && rect.width) {
        coach.style.width = rect.width + 'px';
      }

      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var w = coach.offsetWidth;
      var h = coach.offsetHeight;

      var centerX;
      var anchorTop;
      if (rect && (rect.width || rect.height)) {
        centerX = rect.left + rect.width / 2;
        anchorTop = rect.top;
      } else {
        centerX = vw - 56;       // fallback: roughly where the bottom-right widget sits
        anchorTop = vh - 96;
      }

      coach.style.left = clamp(centerX - w / 2, COACH_MARGIN, vw - w - COACH_MARGIN) + 'px';
      coach.style.top = Math.max(anchorTop - COACH_GAP_PX - h, COACH_MARGIN) + 'px';

      window.requestAnimationFrame(frame);
    }

    window.requestAnimationFrame(frame);
  }

  /* Pop one tagged use case at a time: fade in, linger, fade out, pause, next.
     Pauses while hovered so it can be read. */
  function initCoach() {
    var coach = document.querySelector('[data-bizmis-coach]');
    if (!coach) return;

    var bubble = coach.querySelector('[data-bizmis-coach-bubble]');
    var slides = coach.querySelectorAll('[data-bizmis-coach-slide]');
    if (!slides.length) return;

    var benefitEl = coach.querySelector('[data-bizmis-coach-benefit]');
    var subEl = coach.querySelector('[data-bizmis-coach-sub]');

    coach.hidden = false;
    trackToWidget(coach);

    var index = 0;
    var timer = null;
    var wordTimers = [];
    var shownBenefit = null;

    function clearWordTimers() {
      for (var i = 0; i < wordTimers.length; i++) window.clearTimeout(wordTimers[i]);
      wordTimers = [];
    }

    /* Karaoke caption: sweep the highlight across the words one at a time, like
       the landing page. */
    function runKaraoke(slide) {
      clearWordTimers();
      var words = slide.querySelectorAll('.bizmis-coach__word');
      if (!words.length) return;

      function step(i) {
        for (var w = 0; w < words.length; w++) words[w].classList.remove('is-current');
        if (i >= words.length) return;
        words[i].classList.add('is-current');
        wordTimers.push(window.setTimeout(function () { step(i + 1); }, COACH_WORD_MS));
      }
      step(0);
    }

    /* Reveal the eyebrow for a slide. The benefit only re-animates when it
       actually changes, so it holds steady across same-benefit slides; the
       sub-benefit fades in with every prompt. */
    function showEyebrow(slide) {
      var benefit = slide.getAttribute('data-benefit') || '';
      var sub = slide.getAttribute('data-sub') || '';

      if (benefitEl) {
        if (benefit !== shownBenefit) {
          benefitEl.textContent = benefit;
          shownBenefit = benefit;
        }
        benefitEl.classList.add('is-shown');
      }

      if (subEl) {
        subEl.textContent = sub;
        subEl.hidden = !sub;
        subEl.classList.add('is-shown');
      }
    }

    function deactivateAllSlides() {
      for (var i = 0; i < slides.length; i++) slides[i].classList.remove('is-active');
    }

    /* The card stays put; only the suggestion text fades in, lingers, fades
       out, pauses, then the next one fades in. Only one slide may ever be
       active, so we clear any pending timer and stray actives first. */
    function showText() {
      if (timer) { window.clearTimeout(timer); timer = null; }
      deactivateAllSlides();
      var slide = slides[index];
      showEyebrow(slide);
      slide.classList.add('is-active');
      runKaraoke(slide);
      if (slides.length < 2) return;
      timer = window.setTimeout(hideText, COACH_SHOW_MS);
    }

    function hideText() {
      clearWordTimers();
      var nextIndex = (index + 1) % slides.length;
      var sameBenefit = slides[nextIndex].getAttribute('data-benefit') === slides[index].getAttribute('data-benefit');

      slides[index].classList.remove('is-active');
      if (subEl) subEl.classList.remove('is-shown');
      if (!sameBenefit && benefitEl) benefitEl.classList.remove('is-shown');

      timer = window.setTimeout(function () {
        index = nextIndex;
        showText();
      }, COACH_FADE_MS + COACH_GAP_MS);
    }

    if (bubble && slides.length > 1) {
      bubble.addEventListener('mouseenter', function () {
        if (coach.classList.contains('is-collapsed')) return;
        if (timer) { window.clearTimeout(timer); timer = null; }
        showEyebrow(slides[index]);
        slides[index].classList.add('is-active');
      });
      bubble.addEventListener('mouseleave', function () {
        if (coach.classList.contains('is-collapsed')) return;
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(hideText, COACH_SHOW_MS);
      });
    }

    /* Collapse to a compact chip / expand back. The choice persists across
       pages so a visitor who tucked the hint away isn't nagged again. */
    function readCollapsed() {
      try { return localStorage.getItem(COACH_COLLAPSED_KEY) === '1'; } catch (error) { return false; }
    }

    function storeCollapsed(collapsed) {
      try {
        if (collapsed) localStorage.setItem(COACH_COLLAPSED_KEY, '1');
        else localStorage.removeItem(COACH_COLLAPSED_KEY);
      } catch (error) { /* Private mode — state lasts this page only. */ }
    }

    function stopRotation() {
      if (timer) { window.clearTimeout(timer); timer = null; }
      clearWordTimers();
      deactivateAllSlides();
      if (subEl) subEl.classList.remove('is-shown');
      if (benefitEl) benefitEl.classList.remove('is-shown');
      shownBenefit = null;
    }

    function collapse() {
      stopRotation();
      coach.classList.add('is-collapsed');
      storeCollapsed(true);
    }

    function expand() {
      stopRotation();
      coach.classList.remove('is-collapsed');
      storeCollapsed(false);
      showText();
    }

    var closeBtn = coach.querySelector('[data-bizmis-coach-close]');
    var expandBtn = coach.querySelector('[data-bizmis-coach-expand]');
    if (closeBtn) closeBtn.addEventListener('click', collapse);
    if (expandBtn) expandBtn.addEventListener('click', expand);

    if (readCollapsed()) coach.classList.add('is-collapsed');

    /* Hide the whole coachmark (bubble and chip) while the widget is
       minimized to its corner bubble; resume the rotation on restore. */
    var widgetMinimized = false;
    window.setInterval(function () {
      var minimized = Boolean(document.querySelector(WIDGET_MINIMIZED_SELECTOR));
      if (minimized === widgetMinimized) return;
      widgetMinimized = minimized;
      if (minimized) {
        stopRotation();
        coach.classList.add('is-widget-minimized');
      } else {
        coach.classList.remove('is-widget-minimized');
        if (coach.classList.contains('is-shown') && !coach.classList.contains('is-collapsed')) showText();
      }
    }, COACH_MINIMIZED_POLL_MS);

    timer = window.setTimeout(function () {
      coach.classList.add('is-shown');
      if (!coach.classList.contains('is-collapsed')) showText();
    }, COACH_START_MS);
  }

  function init() {
    var coach = document.querySelector('[data-bizmis-coach]');
    var fallbackCode = coach ? (coach.dataset.fallbackCode || '') : '';
    var attribution = resolveAttribution();

    hydrateInstallLinks(attribution, fallbackCode);
    initCoach();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
