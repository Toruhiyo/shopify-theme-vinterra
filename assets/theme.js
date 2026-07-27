/* ============================================================
   CRIMSON INDEX — Theme JavaScript
   ============================================================ */

(function () {
  'use strict';

  /* --- Cart Lock (prevents concurrent cart API mutations) --- */
  const cartLock = {
    _locked: false,
    _queue: [],
    async acquire() {
      if (!this._locked) { this._locked = true; return; }
      return new Promise(r => this._queue.push(r));
    },
    release() {
      if (this._queue.length > 0) this._queue.shift()();
      else this._locked = false;
    }
  };

  /* --- Cart Sync Bus (keeps drawer + page + header badge in sync) --- */
  const cartBus = {
    _listeners: [],
    on(fn) { this._listeners.push(fn); },
    emit(cart) {
      const badge = document.querySelector('[data-cart-count]');
      if (badge) {
        badge.textContent = cart.item_count;
        badge.style.display = cart.item_count > 0 ? '' : 'none';
      }
      this._listeners.forEach(fn => fn(cart));
    }
  };

  /* --- Cart Drawer --- */
  class CartDrawer {
    constructor() {
      this.drawer = document.querySelector('.cart-drawer');
      this.backdrop = document.querySelector('.cart-drawer__backdrop');
      if (!this.drawer) return;

      this.modal = this.drawer.querySelector('[data-remove-modal]');
      this.modalBackdrop = this.drawer.querySelector('[data-modal-backdrop]');
      this.pendingRemoveKey = null;
      this.debounceTimers = new Map();
      this.DEBOUNCE_MS = 400;

      this.bindEvents();
      this.bindCartItems();
      this.bindModal();
      cartBus.on(cart => this.refreshDrawer(cart));
    }

    bindEvents() {
      document.querySelectorAll('[data-cart-toggle]').forEach(btn => {
        btn.addEventListener('click', (e) => { e.preventDefault(); this.toggle(); });
      });
      if (this.backdrop) this.backdrop.addEventListener('click', () => this.close());
      this.drawer.querySelector('[data-cart-close]')?.addEventListener('click', () => this.close());
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          if (this.modal?.style.display !== 'none') { this.hideModal(); return; }
          if (this.isOpen()) this.close();
        }
      });
    }

    _itemId(el) {
      return (el.dataset.itemKey || el.dataset.variantId || '').trim();
    }

    bindCartItems() {
      this.drawer.querySelectorAll('[data-cart-item]').forEach(item => {
        const input = item.querySelector('[data-qty-input]');
        const minus = item.querySelector('[data-qty-minus]');
        const plus = item.querySelector('[data-qty-plus]');
        const remove = item.querySelector('[data-remove-item]');

        minus?.addEventListener('click', () => {
          const id = this._itemId(item);
          const val = parseInt(input.value, 10) - 1;
          if (val <= 0) { this.confirmRemove(id); return; }
          input.value = val;
          this.scheduleUpdate(id, val);
        });

        plus?.addEventListener('click', () => {
          const id = this._itemId(item);
          const val = Math.min(parseInt(input.value, 10) + 1, 99);
          input.value = val;
          this.scheduleUpdate(id, val);
        });

        input?.addEventListener('change', () => {
          const id = this._itemId(item);
          const val = parseInt(input.value, 10);
          if (isNaN(val) || val <= 0) { this.confirmRemove(id); input.value = 1; return; }
          input.value = Math.min(val, 99);
          this.scheduleUpdate(id, Math.min(val, 99));
        });

        remove?.addEventListener('click', () => this.confirmRemove(this._itemId(item)));
      });
    }

    bindModal() {
      this.drawer.querySelector('[data-modal-cancel]')?.addEventListener('click', () => this.hideModal());
      this.drawer.querySelector('[data-modal-confirm]')?.addEventListener('click', () => {
        if (this.pendingRemoveKey) this.removeItem(this.pendingRemoveKey);
        this.hideModal();
      });
      this.modalBackdrop?.addEventListener('click', () => this.hideModal());
    }

    confirmRemove(key) {
      this.pendingRemoveKey = key;
      if (this.modal) this.modal.style.display = '';
      if (this.modalBackdrop) this.modalBackdrop.style.display = '';
    }

    hideModal() {
      this.pendingRemoveKey = null;
      if (this.modal) this.modal.style.display = 'none';
      if (this.modalBackdrop) this.modalBackdrop.style.display = 'none';
    }

    removeItem(id) {
      const el = this.drawer.querySelector(`[data-item-key="${id}"]`)
        || this.drawer.querySelector(`[data-variant-id="${id}"]`);
      if (el) {
        el.style.transition = 'opacity 200ms ease, max-height 300ms ease';
        el.style.opacity = '0';
        el.style.maxHeight = el.offsetHeight + 'px';
        requestAnimationFrame(() => { el.style.maxHeight = '0'; el.style.overflow = 'hidden'; });
        setTimeout(() => el.remove(), 300);
      }

      const remaining = this.drawer.querySelectorAll('[data-cart-item]').length - 1;
      this.updateCartCount(remaining);

      this.updateCart(id, 0);
    }

    updateCartCount(count) {
      const title = this.drawer.querySelector('.cart-drawer__title');
      if (title) title.textContent = `${title.textContent.split('(')[0].trim()} (${count})`;
    }

    scheduleUpdate(key, quantity) {
      clearTimeout(this.debounceTimers.get(key));
      this.debounceTimers.set(key, setTimeout(() => this.updateCart(key, quantity), this.DEBOUNCE_MS));
    }

    async _cartChange(id, quantity) {
      const res = await fetch('/cart/change.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ id, quantity })
      });
      const data = await res.json();
      if (data.items) return data;
      return null;
    }

    async updateCart(id, quantity) {
      await cartLock.acquire();
      try {
        let cart = await this._cartChange(id, quantity);
        if (!cart) {
          const freshCart = await (await fetch('/cart.js')).json();
          const match = freshCart.items?.find(i =>
            i.key === id || String(i.variant_id) === String(id)
          );
          if (match) cart = await this._cartChange(match.key, quantity);
        }
        if (cart) cartBus.emit(cart);
      } catch { /* network failure */ }
      finally { cartLock.release(); }
    }

    _findLineItem(cart, el) {
      const key = el.dataset.itemKey;
      const vid = el.dataset.variantId;
      return cart.items.find(i => i.key === key)
        || cart.items.find(i => String(i.key) === String(key))
        || cart.items.find(i => String(i.variant_id) === String(vid));
    }

    refreshDrawer(cart) {
      if (!this.drawer) return;
      this.updateCartCount(cart.item_count);

      if (cart.item_count === 0) {
        const items = this.drawer.querySelector('[data-cart-items]');
        const footer = this.drawer.querySelector('.cart-drawer__footer');
        const empty = this.drawer.querySelector('.cart-drawer__empty');
        if (items) items.remove();
        if (footer) footer.remove();
        if (empty) { empty.style.display = ''; }
        else {
          this.drawer.insertAdjacentHTML('beforeend',
            '<div class="cart-drawer__empty"><p>Your cart is empty</p><a href="/" class="btn btn--primary">Continue shopping</a></div>');
        }
        return;
      }

      this.drawer.querySelectorAll('[data-cart-item]').forEach(el => {
        const lineItem = this._findLineItem(cart, el);
        if (!lineItem) { el.remove(); return; }

        if (lineItem.key) el.dataset.itemKey = lineItem.key;

        const input = el.querySelector('[data-qty-input]');
        if (input) input.value = lineItem.quantity;

        const priceEl = el.querySelector('[data-line-price]');
        if (priceEl) {
          let html = formatMoney(lineItem.final_line_price);
          if (lineItem.original_line_price > lineItem.final_line_price) {
            html += ` <s class="cart-drawer__item-compare">${formatMoney(lineItem.original_line_price)}</s>`;
          }
          priceEl.innerHTML = html;
        }
      });

      const subtotalEl = this.drawer.querySelector('.cart-drawer__subtotal span:last-child');
      if (subtotalEl) subtotalEl.textContent = formatMoney(cart.total_price);

      const savingsEl = this.drawer.querySelector('.cart-drawer__savings');
      let totalSavings = 0;
      for (const item of cart.items) {
        if (item.original_line_price > item.final_line_price) {
          totalSavings += item.original_line_price - item.final_line_price;
        }
      }
      if (savingsEl) {
        if (totalSavings > 0) {
          savingsEl.style.display = '';
          const savingsAmt = savingsEl.querySelector('span:last-child');
          if (savingsAmt) savingsAmt.textContent = `-${formatMoney(totalSavings)}`;
        } else {
          savingsEl.style.display = 'none';
        }
      }
    }

    isOpen() { return this.drawer.classList.contains('is-open'); }

    open() {
      this.drawer.classList.add('is-open');
      this.backdrop?.classList.add('is-open');
      document.body.style.overflow = 'hidden';
      this.drawer.querySelector('[data-cart-close]')?.focus();
    }

    close() {
      this.drawer.classList.remove('is-open');
      this.backdrop?.classList.remove('is-open');
      document.body.style.overflow = '';
    }

    toggle() { this.isOpen() ? this.close() : this.open(); }
  }

  /* --- Cart Page (AJAX qty updates for /cart) --- */
  class CartPage {
    constructor() {
      this.section = document.querySelector('.main-cart-section');
      this.form = this.section?.querySelector('[data-cart-form]');
      if (!this.form) return;

      this.debounceTimers = new Map();
      this.DEBOUNCE_MS = 500;
      this.bindInputs();
      cartBus.on(cart => this.refreshPage(cart));
    }

    _itemId(el) {
      return (el.dataset.itemKey || el.dataset.variantId || '').trim();
    }

    bindInputs() {
      this.form.querySelectorAll('[data-cart-page-item]').forEach(row => {
        const selector = row.querySelector('.qty-selector');
        const input = selector?.querySelector('[data-qty-input]');
        if (!input) return;

        const minus = selector.querySelector('[data-qty-minus]');
        const plus = selector.querySelector('[data-qty-plus]');

        minus?.addEventListener('click', (e) => {
          e.preventDefault();
          const val = Math.max(parseInt(input.value, 10) - 1, 0);
          input.value = val;
          this.scheduleUpdate(this._itemId(row), val);
        });

        plus?.addEventListener('click', (e) => {
          e.preventDefault();
          const val = Math.min(parseInt(input.value, 10) + 1, 99);
          input.value = val;
          this.scheduleUpdate(this._itemId(row), val);
        });

        input.addEventListener('change', () => {
          const val = Math.max(0, Math.min(parseInt(input.value, 10) || 0, 99));
          input.value = val;
          this.scheduleUpdate(this._itemId(row), val);
        });
      });
    }

    scheduleUpdate(id, quantity) {
      clearTimeout(this.debounceTimers.get(id));
      this.debounceTimers.set(id, setTimeout(() => this.updateItem(id, quantity), this.DEBOUNCE_MS));
    }

    async _cartChange(id, quantity) {
      const res = await fetch('/cart/change.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ id, quantity })
      });
      const data = await res.json();
      if (data.items) return data;
      return null;
    }

    async updateItem(id, quantity) {
      await cartLock.acquire();
      try {
        let cart = await this._cartChange(id, quantity);
        if (!cart) {
          const freshCart = await (await fetch('/cart.js')).json();
          const match = freshCart.items?.find(i =>
            i.key === id || String(i.variant_id) === String(id)
          );
          if (match) cart = await this._cartChange(match.key, quantity);
        }
        if (cart) cartBus.emit(cart);
      } catch { /* network failure */ }
      finally { cartLock.release(); }
    }

    _findItem(cart, el) {
      const key = (el.dataset.itemKey || '').trim();
      const vid = (el.dataset.variantId || '').trim();
      return cart.items.find(i => i.key === key)
        || cart.items.find(i => String(i.key) === String(key))
        || cart.items.find(i => String(i.variant_id) === String(vid));
    }

    refreshPage(cart) {
      if (!this.form) return;
      if (cart.item_count === 0) {
        window.location.reload();
        return;
      }

      this.form.querySelectorAll('[data-cart-page-item]').forEach(row => {
        const lineItem = this._findItem(cart, row);
        if (!lineItem) { row.remove(); return; }

        if (lineItem.key) row.dataset.itemKey = lineItem.key;

        const input = row.querySelector('[data-qty-input]');
        if (input) input.value = lineItem.quantity;

        const totalEl = row.querySelector('[data-line-total]');
        if (totalEl) {
          let html = `<span style="font-weight: 700;">${formatMoney(lineItem.final_line_price)}</span>`;
          if (lineItem.original_line_price > lineItem.final_line_price) {
            html += `<br><s class="text-muted" style="font-size: 0.8125rem;">${formatMoney(lineItem.original_line_price)}</s>`;
          }
          totalEl.innerHTML = html;
        }
      });

      const subtotalEl = this.form.querySelector('[data-cart-page-subtotal]');
      if (subtotalEl) subtotalEl.textContent = formatMoney(cart.total_price);

      const savingsRow = this.form.querySelector('[data-cart-page-savings]');
      let totalSavings = 0;
      for (const item of cart.items) {
        if (item.original_line_price > item.final_line_price) {
          totalSavings += item.original_line_price - item.final_line_price;
        }
      }
      if (savingsRow) {
        if (totalSavings > 0) {
          savingsRow.style.display = '';
          const amt = savingsRow.querySelector('[data-savings-amount]');
          if (amt) amt.textContent = `-${formatMoney(totalSavings)}`;
        } else {
          savingsRow.style.display = 'none';
        }
      }
    }
  }

  /* --- Desktop Navigation (mega menus driven by menu links) --- */
  class DesktopNav {
    constructor() {
      this.header = document.querySelector('[data-header]');
      if (!this.header) return;

      this.megaItems = this.header.querySelectorAll('[data-nav-mega]');
      this.activeMega = null;
      this.hoverTimeout = null;
      this.leaveTimeout = null;

      this.bindMegaItems();
      this.bindHeaderLeave();
      this.bindKeyboard();
    }

    bindMegaItems() {
      this.megaItems.forEach(item => {
        item.addEventListener('mouseenter', () => {
          clearTimeout(this.leaveTimeout);
          clearTimeout(this.hoverTimeout);
          this.hoverTimeout = setTimeout(() => this.showMega(item), 80);
        });

        item.addEventListener('mouseleave', () => {
          clearTimeout(this.hoverTimeout);
          this.leaveTimeout = setTimeout(() => this.hideMega(), 150);
        });

        const trigger = item.querySelector('.header__nav-link');
        trigger?.addEventListener('click', (e) => {
          if (window.innerWidth < 990) return;
          const isActive = item.classList.contains('is-mega-active');
          if (isActive) {
            this.hideMega();
          } else {
            e.preventDefault();
            this.showMega(item);
          }
        });
      });
    }

    bindHeaderLeave() {
      this.header.addEventListener('mouseleave', () => {
        clearTimeout(this.hoverTimeout);
        this.leaveTimeout = setTimeout(() => this.hideMega(), 200);
      });

      this.header.addEventListener('mouseenter', () => {
        clearTimeout(this.leaveTimeout);
      });
    }

    bindKeyboard() {
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.activeMega) {
          const trigger = this.activeMega.querySelector('.header__nav-link');
          this.hideMega();
          trigger?.focus();
        }
      });
    }

    showMega(item) {
      if (this.activeMega && this.activeMega !== item) {
        this.setExpanded(this.activeMega, false);
      }
      this.setExpanded(item, true);
      this.activeMega = item;
    }

    hideMega() {
      if (this.activeMega) {
        this.setExpanded(this.activeMega, false);
        this.activeMega = null;
      }
    }

    setExpanded(item, expanded) {
      item.classList.toggle('is-mega-active', expanded);
      const trigger = item.querySelector('[aria-expanded]');
      if (trigger) trigger.setAttribute('aria-expanded', String(expanded));
    }
  }

  /* --- Nav overflow: move items that don't fit into "More" dropdown --- */
  class NavOverflow {
    constructor() {
      this.nav = document.querySelector('[data-header] .header__nav');
      this.list = document.querySelector('[data-nav-list]');
      if (!this.nav || !this.list) return;

      this.moreItem = this.list.querySelector('[data-more]');
      this.moreContent = this.list.querySelector('[data-more-content]');
      this.moreTrigger = this.list.querySelector('[data-more-trigger]');
      if (!this.moreItem || !this.moreContent || !this.moreTrigger) return;

      this.items = () => Array.from(this.list.querySelectorAll('[data-nav-item]:not([data-more])'));
      this.overflowClass = 'header__nav-item--overflow';
      this.moreActiveClass = 'header__nav-item--more-active';

      this.moreTrigger.addEventListener('click', (e) => {
        if (window.innerWidth < 990) return;
        e.preventDefault();
        this.toggleMore();
      });
      this.moreItem.addEventListener('mouseenter', () => this.openMore());
      this.moreItem.addEventListener('mouseleave', () => this.closeMore());
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') this.closeMore();
      });

      this.resizeObserver = new ResizeObserver(() => this.update());
      this.resizeObserver.observe(this.nav);
      this.update();
      // Re-measure once the web font is in: fallback-font widths at
      // DOMContentLoaded are narrower and skip the collapse.
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => this.update());
      }
      window.addEventListener('load', () => this.update());
    }

    update() {
      if (window.innerWidth < 990) {
        this.moreItem.setAttribute('aria-hidden', 'true');
        this.moreItem.classList.remove(this.moreActiveClass);
        this.items().forEach(el => el.classList.remove(this.overflowClass));
        return;
      }

      // Reveal everything before measuring: hidden items report 0 width.
      const itemEls = this.items();
      itemEls.forEach(el => el.classList.remove(this.overflowClass));
      this.moreItem.removeAttribute('aria-hidden');

      const listWidth = this.list.getBoundingClientRect().width;
      const moreWidth = this.moreItem.getBoundingClientRect().width;
      const available = listWidth - moreWidth - 8;

      let total = 0;
      let overflowStart = itemEls.length;

      for (let i = 0; i < itemEls.length; i++) {
        const w = itemEls[i].getBoundingClientRect().width;
        if (total + w > available) {
          overflowStart = i;
          break;
        }
        total += w;
      }

      if (overflowStart >= itemEls.length) {
        this.moreItem.setAttribute('aria-hidden', 'true');
        this.moreItem.classList.remove(this.moreActiveClass);
        this.moreContent.innerHTML = '';
        itemEls.forEach(el => el.classList.remove(this.overflowClass));
        return;
      }

      itemEls.forEach((el, i) => {
        el.classList.toggle(this.overflowClass, i >= overflowStart);
      });
      this.buildMoreContent(itemEls.slice(overflowStart));
      this.moreItem.removeAttribute('aria-hidden');
    }

    buildMoreContent(overflowItems) {
      const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const parts = [];
      overflowItems.forEach(item => {
        const link = item.querySelector('.header__nav-link');
        const tiles = item.querySelectorAll('.mega-menu__tile');
        const href = escape(link?.getAttribute('href') || '#');
        const title = escape(link?.textContent?.trim() || '');
        if (tiles.length > 0) {
          parts.push(`<div class="header__more-group"><a href="${href}" class="header__more-link header__more-link--parent">${title}</a>`);
          tiles.forEach(tile => {
            const tHref = escape(tile.getAttribute('href') || '#');
            const tTitle = escape(tile.querySelector('.mega-menu__tile-title')?.textContent?.trim() || tile.textContent?.trim() || '');
            parts.push(`<a href="${tHref}" class="header__more-link header__more-link--child" role="menuitem">${tTitle}</a>`);
          });
          parts.push('</div>');
        } else {
          parts.push(`<a href="${href}" class="header__more-link" role="menuitem">${title}</a>`);
        }
      });
      this.moreContent.innerHTML = parts.join('');
    }

    openMore() {
      if (this.moreContent.innerHTML) this.moreItem.classList.add(this.moreActiveClass);
      const trigger = this.moreTrigger;
      if (trigger) trigger.setAttribute('aria-expanded', 'true');
    }

    closeMore() {
      this.moreItem.classList.remove(this.moreActiveClass);
      const trigger = this.moreTrigger;
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    }

    toggleMore() {
      if (this.moreItem.classList.contains(this.moreActiveClass)) this.closeMore();
      else this.openMore();
    }
  }

  /* --- Support Dropdown --- */
  class SupportDropdown {
    constructor() {
      this.el = document.querySelector('[data-support-dropdown]');
      if (!this.el) return;

      this.timeout = null;

      this.el.addEventListener('mouseenter', () => {
        clearTimeout(this.timeout);
        this.el.classList.add('is-open');
      });

      this.el.addEventListener('mouseleave', () => {
        this.timeout = setTimeout(() => this.el.classList.remove('is-open'), 150);
      });

      this.el.querySelector('.header__support-trigger')?.addEventListener('click', () => {
        this.el.classList.toggle('is-open');
      });

      document.addEventListener('click', (e) => {
        if (!this.el.contains(e.target)) {
          this.el.classList.remove('is-open');
        }
      });
    }
  }

  /* --- Locale Selector --- */
  class LocaleSelector {
    constructor() {
      document.querySelectorAll('[data-locale-selector]').forEach(el => {
        const trigger = el.querySelector('.locale-selector__trigger');
        if (!trigger) return;

        trigger.addEventListener('click', (e) => {
          e.stopPropagation();
          document.querySelectorAll('[data-locale-selector].is-open').forEach(other => {
            if (other !== el) other.classList.remove('is-open');
          });
          const open = el.classList.toggle('is-open');
          trigger.setAttribute('aria-expanded', open);
          el.querySelector('.locale-selector__dropdown')?.setAttribute('aria-hidden', !open);
        });
      });

      document.addEventListener('click', () => {
        document.querySelectorAll('[data-locale-selector].is-open').forEach(el => {
          el.classList.remove('is-open');
          el.querySelector('.locale-selector__trigger')?.setAttribute('aria-expanded', 'false');
          el.querySelector('.locale-selector__dropdown')?.setAttribute('aria-hidden', 'true');
        });
      });
    }
  }

  /* --- Mobile Menu --- */
  class MobileMenu {
    constructor() {
      this.menu = document.querySelector('.mobile-menu');
      if (!this.menu) return;

      this.bindEvents();
      this.initAccordions();
    }

    bindEvents() {
      document.querySelectorAll('[data-menu-toggle]').forEach(btn => {
        btn.addEventListener('click', () => this.toggle());
      });

      this.menu.querySelector('[data-menu-close]')?.addEventListener('click', () => this.close());

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.isOpen()) this.close();
      });
    }

    initAccordions() {
      this.menu.querySelectorAll('[data-mobile-accordion-trigger]').forEach(trigger => {
        trigger.addEventListener('click', () => {
          const parent = trigger.closest('[data-mobile-accordion]');
          const content = parent?.querySelector('[data-mobile-accordion-content]');
          if (!content) return;

          const isOpen = trigger.getAttribute('aria-expanded') === 'true';
          trigger.setAttribute('aria-expanded', String(!isOpen));
          content.setAttribute('aria-hidden', String(isOpen));

          if (isOpen) {
            content.style.maxHeight = '0';
          } else {
            content.style.maxHeight = content.scrollHeight + 'px';
            this.updateParentHeights(content);
          }
        });
      });
    }

    updateParentHeights(el) {
      let parent = el.parentElement?.closest('[data-mobile-accordion-content]');
      while (parent) {
        parent.style.maxHeight = parent.scrollHeight + el.scrollHeight + 'px';
        parent = parent.parentElement?.closest('[data-mobile-accordion-content]');
      }
    }

    isOpen() {
      return this.menu.classList.contains('is-open');
    }

    open() {
      this.menu.classList.add('is-open');
      document.body.style.overflow = 'hidden';
    }

    close() {
      this.menu.classList.remove('is-open');
      document.body.style.overflow = '';
    }

    toggle() {
      this.isOpen() ? this.close() : this.open();
    }
  }

  /* --- Search Overlay --- */
  class SearchOverlay {
    constructor() {
      this.overlay = document.querySelector('.search-overlay');
      if (!this.overlay) return;

      this.input = this.overlay.querySelector('.search-overlay__input');
      this.bindEvents();
    }

    bindEvents() {
      document.querySelectorAll('[data-search-toggle]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          this.toggle();
        });
      });

      this.overlay.addEventListener('click', (e) => {
        if (e.target === this.overlay) this.close();
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.isOpen()) this.close();
        if (e.key === '/' && !this.isOpen() && !isInputFocused()) {
          e.preventDefault();
          this.open();
        }
      });
    }

    isOpen() {
      return this.overlay.classList.contains('is-open');
    }

    open() {
      this.overlay.classList.add('is-open');
      document.body.style.overflow = 'hidden';
      setTimeout(() => this.input?.focus(), 100);
    }

    close() {
      this.overlay.classList.remove('is-open');
      document.body.style.overflow = '';
    }

    toggle() {
      this.isOpen() ? this.close() : this.open();
    }
  }

  /* --- Tabs --- */
  class Tabs {
    constructor(container) {
      this.container = container;
      this.tabs = container.querySelectorAll('.tabs__tab');
      this.panels = container.querySelectorAll('.tabs__panel');

      this.tabs.forEach(tab => {
        tab.addEventListener('click', () => this.activate(tab.dataset.tab));
      });
    }

    activate(id) {
      this.tabs.forEach(t => t.classList.toggle('is-active', t.dataset.tab === id));
      this.panels.forEach(p => p.classList.toggle('is-active', p.dataset.panel === id));
    }
  }

  /* --- Accordion --- */
  class Accordion {
    constructor(container) {
      this.items = container.querySelectorAll('.accordion__item');

      this.items.forEach(item => {
        const trigger = item.querySelector('.accordion__trigger');
        const content = item.querySelector('.accordion__content');

        trigger?.addEventListener('click', () => {
          const isOpen = trigger.getAttribute('aria-expanded') === 'true';
          trigger.setAttribute('aria-expanded', !isOpen);
          content.setAttribute('aria-hidden', isOpen);

          if (!isOpen) {
            content.style.maxHeight = content.scrollHeight + 'px';
          } else {
            content.style.maxHeight = '0';
          }
        });
      });
    }
  }

  /* --- Product Gallery --- */
  class ProductGallery {
    constructor(container) {
      this.main = container.querySelector('.pdp__gallery-main img');
      this.thumbs = container.querySelectorAll('.pdp__gallery-thumb');

      this.thumbs.forEach(thumb => {
        thumb.addEventListener('click', () => {
          this.thumbs.forEach(t => t.classList.remove('is-active'));
          thumb.classList.add('is-active');
          if (this.main) {
            this.main.src = thumb.querySelector('img').dataset.fullSrc || thumb.querySelector('img').src;
          }
        });
      });
    }
  }

  /* --- Quantity Selector --- */
  class QuantitySelector {
    constructor(container) {
      this.input = container.querySelector('input');
      const minus = container.querySelector('[data-qty-minus]');
      const plus = container.querySelector('[data-qty-plus]');

      minus?.addEventListener('click', () => this.update(-1));
      plus?.addEventListener('click', () => this.update(1));
    }

    update(delta) {
      const current = parseInt(this.input.value) || 1;
      const min = parseInt(this.input.min) || 1;
      const max = parseInt(this.input.max) || 99;
      this.input.value = Math.min(Math.max(current + delta, min), max);
      this.input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  /* --- Carousel --- */
  class Carousel {
    constructor(container) {
      this.track = container.querySelector('.carousel__track');
      if (!this.track) return;

      this.prevBtn = container.querySelector('[data-carousel-prev]');
      this.nextBtn = container.querySelector('[data-carousel-next]');

      this.prevBtn?.addEventListener('click', () => this.scroll(-1));
      this.nextBtn?.addEventListener('click', () => this.scroll(1));

      this.track.addEventListener('scroll', () => this.updateArrows(), { passive: true });
      this.updateArrows();

      this.initDrag();
    }

    scroll(direction) {
      const slide = this.track.querySelector('.carousel__slide');
      if (!slide) return;
      const gap = parseFloat(getComputedStyle(this.track).gap) || 16;
      this.track.scrollBy({ left: direction * (slide.offsetWidth + gap), behavior: 'smooth' });
    }

    updateArrows() {
      const { scrollLeft, scrollWidth, clientWidth } = this.track;
      const atStart = scrollLeft <= 2;
      const atEnd = scrollLeft + clientWidth >= scrollWidth - 2;
      if (this.prevBtn) this.prevBtn.classList.toggle('is-hidden', atStart);
      if (this.nextBtn) this.nextBtn.classList.toggle('is-hidden', atEnd);
    }

    initDrag() {
      const DRAG_THRESHOLD_PX = 8;
      const SNAP_THRESHOLD_PX = 30;
      let isPointerDown = false;
      let hasDragged = false;
      let startX = 0;
      let scrollStart = 0;
      let activePointerId = null;

      const endDrag = (e) => {
        if (!isPointerDown) return;
        isPointerDown = false;
        this.track.style.scrollSnapType = '';
        this.track.style.cursor = '';

        if (hasDragged && activePointerId != null) {
          try {
            this.track.releasePointerCapture(activePointerId);
          } catch (_) { /* already released */ }

          const dx = e.clientX - startX;
          if (Math.abs(dx) > SNAP_THRESHOLD_PX) {
            this.scroll(dx < 0 ? 1 : -1);
          }
        }

        activePointerId = null;
      };

      this.track.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        isPointerDown = true;
        hasDragged = false;
        startX = e.clientX;
        scrollStart = this.track.scrollLeft;
        activePointerId = e.pointerId;
      });

      this.track.addEventListener('pointermove', (e) => {
        if (!isPointerDown) return;

        const dx = e.clientX - startX;
        if (!hasDragged) {
          if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
          hasDragged = true;
          this.track.style.scrollSnapType = 'none';
          this.track.style.cursor = 'grabbing';
          this.track.setPointerCapture(e.pointerId);
        }

        this.track.scrollLeft = scrollStart - dx;
      });

      this.track.addEventListener('pointerup', endDrag);
      this.track.addEventListener('pointercancel', endDrag);

      // Only suppress link/button activation after a real drag, not on a tap/click.
      this.track.addEventListener('click', (e) => {
        if (hasDragged) {
          e.preventDefault();
          e.stopPropagation();
          hasDragged = false;
        }
      }, true);
    }
  }

  /* --- Sticky Header --- */
  /* Transparent over the hero, solid chrome once it scrolls past. On pages
     without a hero the header is just a solid sticky bar. */
  class StickyHeader {
    constructor() {
      this.header = document.querySelector('.header');
      if (!this.header) return;

      this.section = this.header.closest('.header-section');
      this.promo = document.querySelector('.announcement-bar-section');
      this.hero = document.querySelector('.hero-section');
      this.heroExitOffset = 100;
      this.scrollThreshold = 50;

      this.update = this.update.bind(this);
      this.update();
      window.addEventListener('scroll', this.update, { passive: true });
      window.addEventListener('resize', this.update, { passive: true });
    }

    update() {
      const scrollY = window.pageYOffset;

      if (this.hero) {
        const inHero = scrollY < this.hero.offsetHeight - this.heroExitOffset;
        if (this.section) this.section.classList.toggle('is-pinned', !inHero);
        if (this.promo) this.promo.classList.toggle('is-pinned', !inHero);
        this.header.classList.toggle('is-transparent', inHero);
        this.header.classList.toggle('scrolled', !inHero);
      } else {
        this.header.classList.toggle('scrolled', scrollY > this.scrollThreshold);
      }
    }
  }

  /* --- Bizmis voice demo (snippets/bizmis-voice-demo.liquid) ---
     Cycles the shopper "say this" prompts. The benefit pills hold steady across
     same-benefit slides while the sub-benefit + enabling feature fade in with
     each one, mirroring the coachmark. Pauses on hover so a prompt can be read. */
  class VoiceDemo {
    constructor(root) {
      this.root = root;
      this.slides = Array.from(root.querySelectorAll('[data-voice-demo-slide]'));
      if (!this.slides.length) return;

      const sceneScope = root.closest('[data-voice-demo-scope]') || document;
      this.scenes = Array.from(sceneScope.querySelectorAll('[data-voice-demo-scene]'));

      this.benefitPills = Array.from(root.querySelectorAll('[data-benefit-pill]'));
      this.subEl = root.querySelector('[data-voice-demo-sub]');
      this.featureEl = root.querySelector('[data-voice-demo-feature]');
      this.askEl = root.querySelector('[data-voice-demo-ask]');
      this.dotsWrap = root.querySelector('[data-voice-demo-dots]');
      this.index = 0;
      this.timer = null;
      this.paused = false;
      this.showMs = 3600;
      this.fadeMs = 600;
      this.gapMs = 250;
      this.wordMs = 340;
      this.askDelayMs = 550;
      this.wordTimers = [];

      this.show = this.show.bind(this);
      this.hide = this.hide.bind(this);
      this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.dots = this.buildDots();
      this.bindBenefitPills();

      this.show();

      if (!this.reduceMotion && this.slides.length > 1) {
        root.addEventListener('mouseenter', () => this.pause());
        root.addEventListener('mouseleave', () => this.resume());
      }
    }

    /* Benefit badges act as tabs: jump to the first sub-benefit of that branch. */
    bindBenefitPills() {
      this.benefitPills.forEach(pill => {
        pill.addEventListener('click', () => {
          const type = pill.getAttribute('data-benefit-pill');
          const idx = this.slides.findIndex(s => s.getAttribute('data-benefit-type') === type);
          if (idx >= 0) this.jumpTo(idx);
        });
      });
    }

    buildDots() {
      if (!this.dotsWrap) return [];
      return this.slides.map((slide, i) => {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'voice-demo__dot';
        dot.setAttribute('aria-label', `Show example ${i + 1} of ${this.slides.length}`);
        dot.addEventListener('click', () => this.jumpTo(i));
        this.dotsWrap.appendChild(dot);
        return dot;
      });
    }

    setScene(i) {
      if (!this.scenes.length) return;
      this.scenes.forEach((scene, k) => scene.classList.toggle('is-active', k === i));
    }

    updateDots(slide) {
      if (!this.dots.length) return;
      const isSupport = slide.getAttribute('data-benefit-type') === 'support';
      this.dots.forEach((dot, i) => {
        const active = i === this.index;
        dot.classList.toggle('is-active', active);
        dot.classList.toggle('is-support', active && isSupport);
      });
    }

    clearTimer() {
      if (this.timer) {
        window.clearTimeout(this.timer);
        this.timer = null;
      }
    }

    jumpTo(i) {
      if (i === this.index && this.timer) return;
      this.clearWordTimers();
      this.clearTimer();
      const current = this.slides[this.index];
      current.classList.remove('is-active');
      current.querySelectorAll('.voice-demo__word').forEach(w => w.classList.remove('is-current'));
      if (this.askEl) this.askEl.classList.remove('is-shown');
      if (this.subEl) this.subEl.classList.remove('is-shown');
      if (this.featureEl) this.featureEl.classList.remove('is-shown');
      this.index = i;
      this.paused = false;
      this.show();
    }

    showEyebrow(slide) {
      const sub = slide.getAttribute('data-sub') || '';
      const benefitType = slide.getAttribute('data-benefit-type');

      this.benefitPills.forEach(pill => {
        pill.classList.toggle('is-active', pill.getAttribute('data-benefit-pill') === benefitType);
      });

      if (this.subEl) {
        this.subEl.textContent = sub;
        this.subEl.hidden = !sub;
        this.subEl.classList.toggle('is-support', benefitType === 'support');
        this.subEl.classList.add('is-shown');
      }

      if (this.featureEl) {
        const feature = slide.getAttribute('data-feature') || '';
        this.featureEl.textContent = feature;
        this.featureEl.hidden = !feature;
        this.featureEl.classList.toggle('is-support', benefitType === 'support');
        this.featureEl.classList.add('is-shown');
      }
    }

    clearWordTimers() {
      this.wordTimers.forEach(t => window.clearTimeout(t));
      this.wordTimers = [];
    }

    /* Sweep the red highlight chip across the phrase one word at a time. */
    runKaraoke(words) {
      this.clearWordTimers();
      if (!words.length) return;

      const step = (i) => {
        words.forEach(w => w.classList.remove('is-current'));
        if (i >= words.length) return;
        words[i].classList.add('is-current');
        this.wordTimers.push(window.setTimeout(() => step(i + 1), this.wordMs));
      };
      step(0);
    }

    /* Staggered reveal: the outcome (sub-benefit + feature) lands first, then
       the ask ("Just say" + use case phrase) follows and the karaoke starts. */
    show() {
      this.clearTimer();
      const slide = this.slides[this.index];
      this.showEyebrow(slide);
      this.updateDots(slide);
      this.setScene(this.index);
      this.slides.forEach(s => s.classList.remove('is-active'));
      if (this.askEl) this.askEl.classList.remove('is-shown');

      const revealAsk = () => {
        slide.classList.add('is-active');
        if (this.askEl) this.askEl.classList.add('is-shown');
        const words = slide.querySelectorAll('.voice-demo__word');
        this.runKaraoke(words);
        const dwell = Math.max(this.showMs, words.length * this.wordMs + 1400);
        if (!this.reduceMotion && this.slides.length > 1) {
          this.timer = window.setTimeout(this.hide, dwell);
        }
      };

      if (this.reduceMotion) {
        revealAsk();
      } else {
        this.timer = window.setTimeout(revealAsk, this.askDelayMs);
      }
    }

    hide() {
      if (this.paused) return;
      this.clearWordTimers();
      this.clearTimer();
      const current = this.slides[this.index];
      current.querySelectorAll('.voice-demo__word').forEach(w => w.classList.remove('is-current'));
      current.classList.remove('is-active');
      if (this.askEl) this.askEl.classList.remove('is-shown');
      if (this.subEl) this.subEl.classList.remove('is-shown');
      if (this.featureEl) this.featureEl.classList.remove('is-shown');

      this.timer = window.setTimeout(() => {
        this.timer = null;
        if (this.paused) return;
        this.index = (this.index + 1) % this.slides.length;
        this.show();
      }, this.fadeMs + this.gapMs);
    }

    /* Pause/resume always restart the current slide cleanly so the rotation can
       never get stranded mid-fade with no active slide. */
    pause() {
      this.paused = true;
      this.clearWordTimers();
      this.clearTimer();
    }

    resume() {
      if (!this.paused) return;
      this.paused = false;
      this.show();
    }
  }

  /* --- Variant Selector --- */
  class VariantSelector {
    constructor(container) {
      this.form = container;
      this.idInput = container.querySelector('[data-variant-id-input]');
      this.variants = JSON.parse(
        (container.querySelector('[data-product-variants]') || {}).textContent || '[]'
      );
      this.pills = container.querySelectorAll('.variant-pill');
      this.priceEl = document.querySelector('.pdp__price');
      this.compareEl = document.querySelector('.pdp__compare-price');
      this.badgeEl = document.querySelector('.pdp__price-row .badge--sale');
      this.addBtn = container.querySelector('[type="submit"]');
      this.mainImage = document.getElementById('pdp-main-image');
      this.stickyPrice = document.querySelector('[data-sticky-price]');
      this.stickyCompare = document.querySelector('[data-sticky-compare]');
      this.stickyBadge = document.querySelector('[data-sticky-badge]');

      this.initFromUrl();
      this.pills.forEach(pill => pill.addEventListener('click', () => this.onPillClick(pill)));
      this.interceptProductLinkClicks();
    }

    initFromUrl() {
      const params = new URLSearchParams(window.location.search);

      const variantId = parseInt(params.get('variant'), 10);
      if (variantId) {
        const variant = this.variants.find(v => v.id === variantId);
        if (variant) {
          this.selectVariantPills(variant);
          this.updateVariant(variant);
          return;
        }
      }

      const size = params.get('size');
      if (size && this.variants.length > 0) {
        const variant = this.variants.find(v =>
          v.available && v.options.some(o => o === size)
        ) || this.variants.find(v => v.options.some(o => o === size));
        if (variant) {
          this.selectVariantPills(variant);
          this.updateVariant(variant);
        }
      }
    }

    selectVariantPills(variant) {
      const groups = this.form.querySelectorAll('.pdp__variants');
      let optionIdx = 0;
      groups.forEach(group => {
        if (group.querySelector('[data-product-link-group]')) return;
        const targetValue = variant.options[optionIdx];
        if (targetValue) {
          group.querySelectorAll('.variant-pill').forEach(p => {
            p.classList.toggle('is-active', p.dataset.optionValue === targetValue);
          });
        }
        optionIdx++;
      });
    }

    interceptProductLinkClicks() {
      const links = this.form.querySelectorAll('[data-product-link]');
      links.forEach(link => {
        link.addEventListener('click', (e) => {
          const activeOption = this.getSelectedNonLinkOption();
          if (!activeOption) return;
          e.preventDefault();
          const url = new URL(link.href, window.location.origin);
          url.searchParams.set('size', activeOption);
          window.location.href = url.toString();
        });
      });
    }

    getSelectedNonLinkOption() {
      const groups = this.form.querySelectorAll('.pdp__variants');
      for (const group of groups) {
        if (group.querySelector('[data-product-link-group]')) continue;
        const active = group.querySelector('.variant-pill.is-active');
        if (active) return active.dataset.optionValue;
      }
      return null;
    }

    onPillClick(pill) {
      const group = pill.closest('.pdp__variants');
      group.querySelectorAll('.variant-pill').forEach(p => p.classList.remove('is-active'));
      pill.classList.add('is-active');

      const selectedOptions = [];
      this.form.querySelectorAll('.pdp__variants').forEach(g => {
        const active = g.querySelector('.variant-pill.is-active');
        if (active) selectedOptions.push(active.dataset.optionValue);
      });

      const variant = this.variants.find(v =>
        v.options.length === selectedOptions.length &&
        v.options.every((opt, i) => opt === selectedOptions[i])
      );

      if (variant) this.updateVariant(variant);
    }

    updateVariant(variant) {
      if (this.idInput) this.idInput.value = variant.id;

      const url = new URL(window.location);
      url.searchParams.set('variant', variant.id);
      window.history.replaceState({}, '', url);

      let onSale = variant.compare_at_price && variant.compare_at_price > variant.price;
      let displayPrice = variant.price_formatted;
      let strikePrice = variant.compare_at_price_formatted;
      let salePct = 0;

      if (onSale) {
        salePct = Math.round((variant.compare_at_price - variant.price) / variant.compare_at_price * 100);
      }

      if (this.priceEl) {
        this.priceEl.textContent = displayPrice;
        this.priceEl.classList.toggle('pdp__price--sale', onSale);
      }
      if (this.compareEl) {
        this.compareEl.textContent = onSale ? strikePrice : '';
        this.compareEl.style.display = onSale ? '' : 'none';
      }
      if (this.badgeEl) {
        this.badgeEl.textContent = onSale ? `-${salePct}%` : '';
        this.badgeEl.style.display = onSale ? '' : 'none';
      }

      if (this.addBtn) {
        if (variant.available) {
          this.addBtn.disabled = false;
          this.addBtn.innerHTML = `${this.addBtn.textContent.split('\u2014')[0].trim()} \u2014 ${displayPrice}`;
        } else {
          this.addBtn.disabled = true;
          this.addBtn.textContent = 'Sold Out';
        }
      }

      if (this.stickyPrice) this.stickyPrice.textContent = displayPrice;
      if (this.stickyCompare) {
        this.stickyCompare.textContent = onSale ? strikePrice : '';
        this.stickyCompare.style.display = onSale ? '' : 'none';
      }
      if (this.stickyBadge) {
        this.stickyBadge.textContent = onSale ? `-${salePct}%` : '';
        this.stickyBadge.style.display = onSale ? '' : 'none';
      }

      if (variant.featured_image && this.mainImage) {
        this.mainImage.src = variant.featured_image;
      }
    }
  }

  /* --- Collection Filters --- */
  class CollectionFilters {
    constructor() {
      this.section = document.querySelector('[data-collection-section]');
      if (!this.section) return;

      this.drawer = this.section.querySelector('[data-filter-drawer]');
      this.overlay = this.section.querySelector('[data-filter-overlay]');
      this.form = this.section.querySelector('[data-filter-form]');
      this.productsContainer = this.section.querySelector('[data-collection-products]');
      this.badgesContainer = this.section.querySelector('[data-filter-badges]');
      this.sortSelect = this.section.querySelector('#sort-by');
      this.sectionId = this.section.dataset.sectionId;

      this.debounceTimer = null;
      this.bindEvents();
    }

    bindEvents() {
      this.section.querySelectorAll('[data-filter-toggle]').forEach(btn =>
        btn.addEventListener('click', () => this.openDrawer())
      );
      this.section.querySelector('[data-filter-close]')?.addEventListener('click', () => this.closeDrawer());
      this.overlay?.addEventListener('click', () => this.closeDrawer());

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.drawer?.classList.contains('is-open')) this.closeDrawer();
      });

      this.form?.addEventListener('change', () => this.onFilterChange());

      this.section.querySelectorAll('[data-filter-remove]').forEach(link => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          this.applyUrl(link.href);
        });
      });

      this.section.querySelector('[data-filter-clear]')?.addEventListener('click', (e) => {
        e.preventDefault();
        this.applyUrl(e.currentTarget.href);
        this.closeDrawer();
      });

      this.sortSelect?.addEventListener('change', () => {
        const url = new URL(window.location.href);
        url.searchParams.set('sort_by', this.sortSelect.value);
        this.applyUrl(url.toString());
      });

      this.section.querySelectorAll('[data-price-min], [data-price-max]').forEach(input => {
        input.addEventListener('change', () => this.onFilterChange());
      });
    }

    openDrawer() {
      this.drawer?.classList.add('is-open');
      this.overlay?.classList.add('is-open');
      document.body.style.overflow = 'hidden';
    }

    closeDrawer() {
      this.drawer?.classList.remove('is-open');
      this.overlay?.classList.remove('is-open');
      document.body.style.overflow = '';
    }

    onFilterChange() {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        const formData = new FormData(this.form);
        const url = new URL(window.location.href);

        const filterParams = Array.from(url.searchParams.entries())
          .filter(([key]) => key.startsWith('filter.') || key === 'page');
        filterParams.forEach(([key]) => url.searchParams.delete(key));

        for (const [key, value] of formData.entries()) {
          if (value !== '') url.searchParams.append(key, value);
        }

        url.searchParams.delete('page');
        this.applyUrl(url.toString());
      }, 300);
    }

    async applyUrl(urlString) {
      const url = new URL(urlString);
      url.searchParams.set('sections', this.sectionId);

      history.replaceState({}, '', urlString);
      this.section.classList.add('is-loading');

      try {
        const res = await fetch(url.toString());
        const data = await res.json();
        const html = data[this.sectionId];
        if (!html) return;

        const doc = new DOMParser().parseFromString(html, 'text/html');

        const newProducts = doc.querySelector('[data-collection-products]');
        if (newProducts && this.productsContainer) {
          this.productsContainer.innerHTML = newProducts.innerHTML;
        }

        const newBadges = doc.querySelector('[data-filter-badges]');
        if (newBadges && this.badgesContainer) {
          this.badgesContainer.innerHTML = newBadges.innerHTML;
          this.badgesContainer.querySelectorAll('[data-filter-remove]').forEach(link => {
            link.addEventListener('click', (e) => {
              e.preventDefault();
              this.applyUrl(link.href);
            });
          });
        }

        const newForm = doc.querySelector('[data-filter-form]');
        if (newForm && this.form) {
          this.form.innerHTML = newForm.innerHTML;
          this.section.querySelectorAll('[data-price-min], [data-price-max]').forEach(input => {
            input.addEventListener('change', () => this.onFilterChange());
          });
        }

        const newCount = doc.querySelector('[data-products-count]');
        const currentCount = this.section.querySelector('[data-products-count]');
        if (newCount && currentCount) {
          currentCount.textContent = newCount.textContent;
        }

        const newSort = doc.querySelector('#sort-by');
        if (newSort && this.sortSelect) {
          this.sortSelect.value = newSort.value;
        }
      } catch {
        window.location = urlString;
      } finally {
        this.section.classList.remove('is-loading');
      }
    }
  }

  /* --- Search Infinite Scroll --- */
  class SearchInfiniteScroll {
    constructor() {
      this.section = document.querySelector('[data-search-section]');
      if (!this.section) return;

      this.grid = this.section.querySelector('[data-search-results]');
      this.sentinel = this.section.querySelector('[data-search-load-more]');
      if (!this.grid || !this.sentinel) return;

      this.loading = false;
      this.observer = new IntersectionObserver(
        (entries) => {
          if (this.loading) return;
          if (entries[0].isIntersecting) this.loadNext();
        },
        { rootMargin: '200px', threshold: 0 }
      );
      this.observer.observe(this.sentinel);
    }

    getFetchUrl() {
      const nextUrl = this.sentinel.dataset.nextUrl;
      if (!nextUrl) return null;
      const sectionId = this.section.dataset.sectionId;
      if (!sectionId) return null;
      const sep = nextUrl.includes('?') ? '&' : '?';
      const base = window.Shopify?.routes?.root ?? '/';
      const path = nextUrl.startsWith('/') ? nextUrl : base + nextUrl;
      return `${path}${sep}sections=${encodeURIComponent(sectionId)}`;
    }

    async loadNext() {
      const url = this.getFetchUrl();
      if (!url) return;

      this.loading = true;
      this.sentinel.classList.add('is-loading');

      try {
        const res = await fetch(url);
        const data = await res.json();
        const sectionId = this.section.dataset.sectionId;
        const html = data[sectionId];
        if (!html) return;

        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const newGrid = doc.querySelector('[data-search-results]');
        const newSentinel = doc.querySelector('[data-search-load-more]');

        if (newGrid) {
          while (newGrid.firstChild) {
            this.grid.appendChild(newGrid.firstChild);
          }
        }

        if (newSentinel?.dataset.nextUrl) {
          this.sentinel.dataset.nextUrl = newSentinel.dataset.nextUrl;
        } else {
          this.sentinel.remove();
          this.observer.disconnect();
        }
      } catch {
        this.sentinel.classList.remove('is-loading');
      } finally {
        this.loading = false;
        this.sentinel.classList.remove('is-loading');
      }
    }
  }

  /* --- Helpers --- */
  function isInputFocused() {
    const el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  /* --- Hero Slideshow --- */
  class HeroSlideshow {
    constructor(el) {
      this.el = el;
      this.slides = el.querySelectorAll('[data-hero-slide]');
      this.dots = el.querySelectorAll('[data-hero-dot]');
      this.current = 0;
      this.total = this.slides.length;
      this.interval = parseInt(el.dataset.autoplayInterval, 10) || 6000;
      this.timer = null;
      this.paused = false;

      if (this.total <= 1) return;

      this.bindControls();
      this.startAutoplay();
    }

    bindControls() {
      this.el.querySelector('[data-hero-prev]')?.addEventListener('click', () => this.prev());
      this.el.querySelector('[data-hero-next]')?.addEventListener('click', () => this.next());
      this.dots.forEach(dot => {
        dot.addEventListener('click', () => this.goTo(parseInt(dot.dataset.heroDot, 10)));
      });

      // No hover pause: the hero is fullscreen, so the cursor is almost always
      // over it and pausing made the slideshow look stuck. Focus pause stays
      // so keyboard users can operate the controls.
      this.el.addEventListener('focusin', () => this.pause());
      this.el.addEventListener('focusout', () => this.resume());

      this.bindSwipe();
    }

    // Touch devices hide the nav pill (base.css), so a horizontal swipe is
    // the way to change slides there.
    bindSwipe() {
      const SWIPE_MIN_PX = 48;
      let startX = null;
      let startY = null;

      this.el.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
      }, { passive: true });

      this.el.addEventListener('touchend', (e) => {
        if (startX === null) return;
        const dx = e.changedTouches[0].clientX - startX;
        const dy = e.changedTouches[0].clientY - startY;
        startX = null;
        startY = null;
        // Mostly-horizontal gestures only; let vertical scrolling through.
        if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy)) return;
        if (dx < 0) this.next(); else this.prev();
      }, { passive: true });
    }

    goTo(index) {
      if (index === this.current) return;
      this.slides[this.current].classList.remove('is-active');
      this.dots[this.current]?.classList.remove('is-active');
      this.current = (index + this.total) % this.total;
      this.slides[this.current].classList.add('is-active');
      this.dots[this.current]?.classList.add('is-active');
      this.resetAutoplay();
    }

    next() { this.goTo(this.current + 1); }
    prev() { this.goTo(this.current - 1); }

    startAutoplay() {
      this.timer = setInterval(() => {
        if (!this.paused) this.next();
      }, this.interval);
    }

    resetAutoplay() {
      clearInterval(this.timer);
      this.startAutoplay();
    }

    pause() { this.paused = true; }
    resume() { this.paused = false; }
  }

  /* --- Money Formatter --- */
  function formatMoney(cents) {
    const fmt = window.Shopify?.money_format || '${{amount}}';
    const raw = (cents / 100).toFixed(2);
    const withCommas = raw.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const noDecimals = Math.round(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return fmt
      .replace('{{amount_with_comma_separator}}', raw.replace('.', ','))
      .replace('{{amount_no_decimals_with_comma_separator}}', Math.round(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'))
      .replace('{{amount_no_decimals}}', noDecimals)
      .replace('{{amount}}', withCommas);
  }

  /* --- Newsletter Confetti --- */
  function fireConfetti() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    const primary = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim() || '#D1001A';
    const gravity = 0.32;
    const drag = 0.006;
    const duration = 2600;
    const originX = canvas.width / 2;
    const originY = canvas.height * 0.35;

    const particles = Array.from({ length: 150 }, () => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 4 + Math.random() * 11;
      return {
        x: originX,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 4,
        size: 6 + Math.random() * 6,
        color: primary,
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.3,
      };
    });

    const start = performance.now();

    const frame = (now) => {
      const elapsed = now - start;
      const life = Math.max(0, 1 - elapsed / duration);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      particles.forEach(p => {
        p.vy += gravity;
        p.vx *= (1 - drag);
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.spin;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.globalAlpha = life;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      });

      if (elapsed < duration) {
        requestAnimationFrame(frame);
      } else {
        window.removeEventListener('resize', resize);
        canvas.remove();
      }
    };

    requestAnimationFrame(frame);
  }

  /* --- Subscription celebration ---
     After a successful subscribe, Shopify reloads with ?customer_posted=true
     and the form id as the fragment (e.g. #footer-newsletter). Auto-scroll to
     that section, then fire confetti once the scroll has settled. */
  function whenScrollSettles(callback) {
    let done = false;
    let idle;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('scroll', onScroll);
      clearTimeout(idle);
      clearTimeout(safety);
      callback();
    };
    const onScroll = () => {
      clearTimeout(idle);
      idle = setTimeout(finish, 140);
    };
    const safety = setTimeout(finish, 2000);
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  function initSubscriptionCelebration() {
    const successEl = document.querySelector('[data-newsletter-success]');
    if (!successEl) return;

    const hashId = window.location.hash.length > 1
      ? decodeURIComponent(window.location.hash.slice(1))
      : null;
    const target = (hashId && document.getElementById(hashId))
      || successEl.closest('section, .footer__newsletter-banner')
      || successEl;

    const absoluteTop = target.getBoundingClientRect().top + window.scrollY;
    const centerMargin = Math.max(0, (window.innerHeight - target.offsetHeight) / 2);
    const targetY = Math.max(0, absoluteTop - centerMargin);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduceMotion || Math.abs(window.scrollY - targetY) < 4) {
      window.scrollTo(0, targetY);
      fireConfetti();
      return;
    }

    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    window.scrollTo(0, 0);
    whenScrollSettles(fireConfetti);
    requestAnimationFrame(() => window.scrollTo({ top: targetY, behavior: 'smooth' }));
  }

  /* --- Bizmis voice clerk trigger ---
     "Talk to the clerk" starts a voicechat through the widget's imperative API
     (window.AvatarVoicechat.startVoicechat) and locks itself for the duration
     of the call via the widget's lifecycle events. Older widget builds without
     that API fall back to surfacing + pulsing the floating widget. */
  const VOICE_WIDGET_SELECTORS = ['#bizmis-avatar-embed', '.bizmis-avatar-widget-root', '#avatar-root', '[data-avatar-widget]'];

  function findVoiceWidget() {
    for (let i = 0; i < VOICE_WIDGET_SELECTORS.length; i++) {
      const el = document.querySelector(VOICE_WIDGET_SELECTORS[i]);
      if (el) return el;
    }
    return null;
  }

  function openVoiceClerk() {
    const api = window.AvatarVoicechat;
    if (api && typeof api.startVoicechat === 'function' && api.startVoicechat()) return;

    const widget = findVoiceWidget();
    if (!widget) return;

    widget.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    widget.classList.add('bizmis-widget-pulse');
    window.setTimeout(() => widget.classList.remove('bizmis-widget-pulse'), 1800);
  }

  function setVoiceClerkLocked(locked) {
    document.querySelectorAll('[data-open-voice-clerk]').forEach(btn => {
      btn.disabled = locked;
    });
  }

  function initVoiceClerkTriggers() {
    document.querySelectorAll('[data-open-voice-clerk]').forEach(btn => {
      btn.addEventListener('click', openVoiceClerk);
    });

    window.addEventListener('bizmis:voicechat-started', () => setVoiceClerkLocked(true));
    window.addEventListener('bizmis:voicechat-ended', () => setVoiceClerkLocked(false));
  }

  /* Measure the demo promo bar so the index header floats just below it (and the
     hero fills exactly the remaining viewport). Handles wrapping on small screens. */
  function initPromoBar() {
    const bar = document.querySelector('.promo-bar');
    if (!bar) return;
    const apply = () => document.body.style.setProperty('--promo-height', `${bar.offsetHeight}px`);
    apply();
    window.addEventListener('resize', apply, { passive: true });
    window.addEventListener('load', apply);
  }

  /* --- Initialize --- */
  function init() {
    new CartDrawer();
    new CartPage();
    new CollectionFilters();
    new SearchInfiniteScroll();
    new DesktopNav();
    new NavOverflow();
    new SupportDropdown();
    new LocaleSelector();
    new MobileMenu();
    new SearchOverlay();
    new StickyHeader();

    document.querySelectorAll('[data-tabs]').forEach(el => new Tabs(el));
    document.querySelectorAll('[data-accordion]').forEach(el => new Accordion(el));
    document.querySelectorAll('.pdp__gallery').forEach(el => new ProductGallery(el));
    document.querySelectorAll('.qty-selector:not(.cart-drawer .qty-selector):not(.main-cart-section .qty-selector)').forEach(el => new QuantitySelector(el));
    document.querySelectorAll('.carousel').forEach(el => new Carousel(el));
    document.querySelectorAll('[data-hero-slideshow]').forEach(el => new HeroSlideshow(el));
    document.querySelectorAll('[data-voice-demo]').forEach(el => new VoiceDemo(el));
    initVoiceClerkTriggers();
    initPromoBar();
    document.querySelectorAll('[data-variant-selector]').forEach(el => {
      new VariantSelector(el);
    });
  }

  function dismissLoader() {
    const loader = document.getElementById('page-loader');
    if (!loader) return;
    loader.classList.add('is-hidden');
    loader.addEventListener('transitionend', () => loader.remove(), { once: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('load', () => {
    dismissLoader();
    // Wait out the loader fade so the scroll and confetti are not hidden behind it.
    setTimeout(initSubscriptionCelebration, 600);
  });
})();
