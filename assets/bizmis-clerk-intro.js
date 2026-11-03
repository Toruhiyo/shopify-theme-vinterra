/* ============================================================
   BIZMIS CLERK INTRO (?intro=bizmis on the home page)
   ------------------------------------------------------------
   The opening of a store demo film, ported from the Meridian theme
   (shopify-theme-crimson-index, ClerkIntro). On a blank page the Bizmis
   logo comes in alone, moves aside for the Bizmis clerk, who waves; under
   a bloom of light the clerk becomes this store's own clerk as the store's
   logo takes the Bizmis logo's place, then glides into its corner while
   the store fades in under it. The demo recorder follows the phases on
   <html data-clerk-intro> and the film's intro line is timed to them.

   Loaded in <head>, before the app embed: it wraps AvatarVoicechat.init
   the moment the widget publishes it, so the clerk first draws in Bizmis
   clothes. layout/theme.liquid sets html.is-clerk-intro(-bizmis).
   ============================================================ */

(function () {
  'use strict';

  const root = document.documentElement;
  if (!root.classList.contains('is-clerk-intro-bizmis')) return;

  const BIZMIS_ORANGE = '#F9A353';
  const BIZMIS_MODEL_URL = 'https://cdn.bizmis.ai/common/avatars/models/yusuke.glb';
  const BIZMIS_MESH_COLORS = { UPPERBODY_Top: BIZMIS_ORANGE, HEAD_Hat: BIZMIS_ORANGE };
  const BIZMIS_STAMP_SCALE = 0.9;
  const BIZMIS_STAMP_OFFSET_X = -0.022;

  const SCALE = 2.6;
  const CANVAS_WIDTH_PX = 760;   // 288 px card x the intro scale: the canvas stays sharp at full size
  const READY_TIMEOUT_MS = 8000;
  const SETTLE_MS = 900;         // after the canvas mounts: model and first pose on screen
  const APPEAR_MS = 550;
  const GLIDE_MS = 1150;
  // timed to the film's intro line (Meridian's: the line is anchored on the swap)
  const SHIFT_AT_MS = 1500;      // the logo comes in alone, centred, then moves aside for the clerk
  const APPEAR_AT_MS = 2550;     // once the logo has finished moving aside (both at once stuttered)
  const SWAP_AT_MS = 5960;
  const GLIDE_AT_MS = 7900;      // at the earliest, and only after the bloom has given the store's clerk back
  const SHOWN_BEAT_MS = 350;     // the store's clerk stands in the open before it glides
  const GAP_PX = 96;
  const FIGURE_WIDTH = 0.38;     // the clerk's figure across its (square) canvas: the rest is empty sides
  const BLOOM_RISE_MS = 320;     // until the light covers the whole clerk
  const BLOOM_HOLD_MS = 60;
  const BLOOM_FADE_MS = 450;
  const BLOOM_MAX_COVER_MS = 1200;
  const BLOOM_REVEAL_IN_RISE_MS = 250;   // a held look: revealed in the rise (its cut lands two frames on, at the peak)
  const BLOOM_SWAP_IN_RISE_MS = 190;     // otherwise swapped once the light is ~95% opaque over the whole clerk
  const PREPARE_MAX_MS = 4000;
  const INIT_WRAP_TRIES = 120;

  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const nextFrames = (n) => new Promise((resolve) => {
    const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });

  /* --- The widget: drawn as the Bizmis clerk first, the store's look kept for the swap --- */

  let storeConfig = null;
  let stampUrl = null;
  let stampReady = false;
  const stampWaiters = [];

  // the Bizmis logo as a solid white stamp (the shirt prints it white on orange)
  function hardenStamp(url) {
    const done = (value) => {
      stampUrl = value;
      stampReady = true;
      stampWaiters.splice(0).forEach((run) => run());
    };
    if (!url) { done(null); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const px = image.data;
      for (let i = 0; i < px.length; i += 4) {
        if (!px[i + 3]) continue;
        px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
      done(canvas.toDataURL('image/png'));
    };
    img.onerror = () => done(url);
    img.src = url;
  }

  function bizmisLook(config) {
    return Object.assign({}, config, {
      avatarModelUrl: BIZMIS_MODEL_URL,
      avatarMeshColors: Object.assign({}, config.avatarMeshColors || {}, BIZMIS_MESH_COLORS),
      shirtStampUrl: stampUrl || config.shirtStampUrl,
      shirtStampScale: BIZMIS_STAMP_SCALE,
      shirtStampOffsetX: BIZMIS_STAMP_OFFSET_X,
      canvasWidth: CANVAS_WIDTH_PX,
    });
  }

  function wrapInit(api) {
    if (!api || api.__clerkIntroWrapped || typeof api.init !== 'function') return false;
    const originalInit = api.init.bind(api);
    api.init = function (config) {
      storeConfig = config || {};
      const start = () => originalInit(bizmisLook(storeConfig));
      if (stampReady) return start();
      stampWaiters.push(start);
      return undefined;
    };
    api.__clerkIntroWrapped = true;
    return true;
  }

  // the widget publishes window.AvatarVoicechat and calls init right after (its auto-init or the app embed):
  // the setter wraps init at once; the poll covers a widget that defines the global some other way
  (function armInitWrap() {
    let current = window.AvatarVoicechat;
    if (wrapInit(current)) return;
    try {
      Object.defineProperty(window, 'AvatarVoicechat', {
        configurable: true,
        enumerable: true,
        get() { return current; },
        set(value) { current = value; wrapInit(value); },
      });
    } catch (e) { /* a non-configurable global: the poll below */ }
    let tries = 0;
    const tick = () => {
      if (wrapInit(window.AvatarVoicechat) || tries > INIT_WRAP_TRIES) return;
      tries += 1;
      window.setTimeout(tick, 50);
    };
    tick();
  })();

  hardenStamp(root.getAttribute('data-bizmis-stamp'));

  // the store's own clerk, as its widget config draws it
  function storeAppearance() {
    if (!storeConfig) return null;
    return {
      avatarModelUrl: storeConfig.avatarModelUrl || null,
      avatarMeshColors: storeConfig.avatarMeshColors || {},
      shirtStampUrl: storeConfig.shirtStampUrl || null,
      shirtStampScale: typeof storeConfig.shirtStampScale === 'number' ? storeConfig.shirtStampScale : 1,
      shirtStampOffsetX: storeConfig.shirtStampOffsetX || 0,
      shirtStampOffsetY: storeConfig.shirtStampOffsetY || 0,
    };
  }

  // resolves when the widget fires `name` for the look's model, or after timeoutMs
  function lookEvent(name, look, timeoutMs) {
    const file = (url) => (url || '').split('?')[0].split('/').pop();
    const want = file(look?.avatarModelUrl);
    return new Promise((resolve) => {
      if (!want || !timeoutMs) { resolve(); return; }
      const done = () => { window.removeEventListener(name, onEvent); resolve(); };
      const onEvent = (event) => { if (file(event.detail?.model) === want) done(); };
      window.addEventListener(name, onEvent);
      window.setTimeout(done, timeoutMs);
    });
  }

  // a cut, not the widget's crossfade: under the bloom the old look must not linger
  function becomeStoreClerk(timeoutMs) {
    const api = window.AvatarVoicechat;
    const look = storeAppearance();
    const shown = lookEvent('bizmis:avatar-look-shown', look, timeoutMs);
    if (look && typeof api?.setAppearance === 'function') api.setAppearance(look, { swap: 'cut' });
    return shown;
  }

  // builds the store's clerk unseen behind the Bizmis clerk: true once it is drawn (or after timeoutMs), false when
  // the widget cannot hold a look (becomeStoreClerk then swaps under the light)
  function prepareHeldClerk(timeoutMs) {
    const api = window.AvatarVoicechat;
    const look = storeAppearance();
    if (!look || typeof api?.revealAppearance !== 'function' || typeof api.setAppearance !== 'function') return Promise.resolve(false);
    const ready = lookEvent('bizmis:avatar-look-ready', look, timeoutMs);
    api.setAppearance(look, { swap: 'cut', hold: true });
    return ready.then(() => true);
  }

  function revealHeldClerk(timeoutMs) {
    const shown = lookEvent('bizmis:avatar-look-shown', storeAppearance(), timeoutMs);
    window.AvatarVoicechat?.revealAppearance?.();
    return shown;
  }

  /* --- The intro --- */

  class ClerkIntro {
    constructor(node) {
      this.node = node;
      this.storeClerkShown = Promise.resolve();
    }

    phase(name) {
      root.dataset.clerkIntro = name;
    }

    async start() {
      const card = await this.waitForClerk();
      if (!card || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        this.dismiss();
        return;
      }
      const dock = card.closest('.bizmis-desktop-lite-chat') || card;
      const avatar = card.querySelector('canvas')?.parentElement?.closest('.block') || card;
      const box = avatar.getBoundingClientRect();
      const scale = Math.min(SCALE, (window.innerHeight * 0.8) / Math.max(box.height, 1));
      const brands = this.node.querySelector('[data-clerk-intro-brands]');
      // the logo and the clerk stand side by side, the pair centred
      const logoW = Math.max(...[...brands.children].map((el) => el.getBoundingClientRect().width));
      const clerkW = box.width * scale * FIGURE_WIDTH;
      const left = (window.innerWidth - (logoW + GAP_PX + clerkW)) / 2;
      const centreX = left + logoW + GAP_PX + clerkW / 2;
      brands.style.width = `${logoW}px`;
      brands.style.left = `${left}px`;
      brands.style.top = `${window.innerHeight * 0.47}px`;
      // the logo opens alone at the centre of the screen (placed there without a transition: no slide in)
      brands.style.transition = 'none';
      brands.style.setProperty('--brands-shift', `${(window.innerWidth - logoW) / 2 - left}px`);
      void brands.offsetWidth;
      brands.style.transition = '';

      const dx = centreX - (box.left + box.width / 2);
      // the pair sits a touch above centre (the figure's weight is low: a bust, hands at the bottom)
      const dy = window.innerHeight * 0.47 - (box.top + box.height / 2);
      const dockBox = dock.getBoundingClientRect();
      dock.style.transformOrigin = `${box.left + box.width / 2 - dockBox.left}px ${box.top + box.height / 2 - dockBox.top}px`;
      // the separate translate and scale properties, not transform: the widget's own motion (framer-motion) writes
      // the dock's transform at any re-render, which once wiped the big pose mid-intro
      root.classList.add('is-clerk-intro-bare');
      dock.style.transition = 'none';
      dock.style.opacity = '0';
      dock.style.translate = `${dx}px ${dy}px`;
      dock.style.scale = `${scale * 0.94}`;
      await nextFrames(2);

      const prepared = this.prepareStoreClerk();
      await Promise.race([prepared, wait(PREPARE_MAX_MS)]);
      // the page is still for a beat after the build before the logo comes in
      await nextFrames(6);
      this.phase('logo');
      this.node.classList.add('is-brand-in');
      await wait(SHIFT_AT_MS);
      this.phase('shift');
      brands.style.setProperty('--brands-shift', '0px');
      await wait(APPEAR_AT_MS - SHIFT_AT_MS);

      this.phase('appear');
      const appearedAt = performance.now();
      root.classList.add('is-clerk-intro-staged');
      dock.style.transition = `opacity ${APPEAR_MS}ms ease-out, scale ${APPEAR_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
      dock.style.opacity = '1';
      dock.style.scale = `${scale}`;
      window.dispatchEvent(new CustomEvent('avatar-animation', { detail: { name: 'waving', lifecycle: { times: 1, when: null, duration_in_ms: null }, toolCallId: `clerk-intro-waving-${Date.now()}` } }));
      // a widget that cannot hold a look parses the store clerk's model while the pair stands still
      prepared.then((held) => { if (!held) window.setTimeout(() => this.preloadStoreClerk(), APPEAR_MS + 150); });
      await wait(SWAP_AT_MS - APPEAR_AT_MS - (performance.now() - appearedAt));
      const held = await prepared;
      this.phase('swap');
      const swapDone = this.becomeStoreClerk(card, held);
      // the glide starts once the light has cleared and the store's clerk has been seen standing a beat
      await Promise.all([wait(GLIDE_AT_MS - SWAP_AT_MS), this.storeClerkShown]);
      await wait(SHOWN_BEAT_MS);

      // the glide: the clerk settles into its corner while the store fades in under it; the widget's card only
      // comes back once the clerk has landed in it
      this.phase('glide');
      dock.style.transition = `translate ${GLIDE_MS}ms cubic-bezier(0.65, 0, 0.35, 1), scale ${GLIDE_MS}ms cubic-bezier(0.65, 0, 0.35, 1)`;
      dock.style.translate = '0px 0px';
      dock.style.scale = '1';
      this.node.classList.add('is-fading');
      await wait(GLIDE_MS + 40);
      root.classList.remove('is-clerk-intro-bare');
      await swapDone;
      await wait(440);
      this.phase('done');
      dock.style.transition = '';
      dock.style.translate = '';
      dock.style.scale = '';
      dock.style.transformOrigin = '';
      dock.style.opacity = '';
      this.dismiss();
    }

    async prepareStoreClerk() {
      const api = window.AvatarVoicechat;
      if (typeof api?.revealAppearance !== 'function') return false;
      let look = null;
      for (let left = 80; left > 0 && !look; left -= 1) {
        look = storeAppearance();
        if (!look) await wait(100);
      }
      if (!look) return false;
      if (look.avatarModelUrl && typeof api.preloadAvatars === 'function') await api.preloadAvatars([look.avatarModelUrl]).catch(() => {});
      if (look.shirtStampUrl) { const img = new Image(); img.crossOrigin = 'anonymous'; img.src = look.shirtStampUrl; }
      return prepareHeldClerk(PREPARE_MAX_MS);
    }

    preloadStoreClerk() {
      const look = storeAppearance();
      const api = window.AvatarVoicechat;
      if (!look) return;
      if (look.avatarModelUrl && typeof api?.preloadAvatars === 'function') api.preloadAvatars([look.avatarModelUrl]).catch(() => {});
      if (look.shirtStampUrl) { const img = new Image(); img.crossOrigin = 'anonymous'; img.src = look.shirtStampUrl; }
    }

    async becomeStoreClerk(card, held) {
      // a bloom of light over the clerk; under it the clerk takes the store's look and the logos trade places
      let shown;
      this.storeClerkShown = new Promise((resolve) => { shown = resolve; });   // set before the first await: start() reads it
      const box = (card.querySelector('canvas')?.parentElement?.closest('.block') || card).getBoundingClientRect();
      const bloom = document.createElement('div');
      bloom.className = 'clerk-intro-bloom';
      bloom.style.left = `${box.left + box.width / 2}px`;
      bloom.style.top = `${box.top + box.height * 0.5}px`;
      bloom.style.setProperty('--size', `${Math.max(box.width, box.height) * 1.6}px`);
      for (let i = 0; i < 16; i += 1) {
        const spark = document.createElement('span');
        const a = (i / 16) * Math.PI * 2 + (i % 3) * 0.21;
        const d = 0.55 + ((i * 37) % 120) / 260;
        spark.style.setProperty('--x', `${Math.cos(a) * d}`);
        spark.style.setProperty('--y', `${Math.sin(a) * d}`);
        spark.style.setProperty('--delay', `${(i % 5) * 35}ms`);
        spark.style.setProperty('--s', `${0.6 + ((i * 11) % 16) / 22}`);
        if (i % 2) spark.classList.add('is-gold');
        bloom.appendChild(spark);
      }
      document.body.appendChild(bloom);
      await nextFrames(1);
      bloom.classList.add('is-on');
      this.node.classList.add('is-swapped');
      // the look changes late in the rise, the light already near-opaque over the whole clerk; the light leaves right
      // after its peak (a burst, not a held flash)
      const inRise = held ? BLOOM_REVEAL_IN_RISE_MS : BLOOM_SWAP_IN_RISE_MS;
      await wait(inRise);
      const peak = wait(BLOOM_RISE_MS + BLOOM_HOLD_MS - inRise);
      const shownNow = held ? revealHeldClerk(BLOOM_MAX_COVER_MS) : becomeStoreClerk(BLOOM_MAX_COVER_MS);
      await Promise.all([peak, shownNow]);
      bloom.classList.add('is-off');
      await wait(BLOOM_FADE_MS);
      shown();
      await wait(900);
      bloom.remove();
    }

    async waitForClerk() {
      const end = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < end) {
        const card = document.querySelector('#bizmis-avatar-embed [class*="group/card"]');
        if (card && card.querySelector('canvas')) {
          await wait(SETTLE_MS);
          return card;
        }
        await wait(100);
      }
      return null;
    }

    dismiss() {
      this.node.remove();
      root.classList.remove('is-clerk-intro', 'is-clerk-intro-bare', 'is-clerk-intro-staged', 'is-clerk-intro-bizmis');
    }
  }

  function boot() {
    const node = document.querySelector('[data-clerk-intro]');
    if (node) new ClerkIntro(node).start();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
