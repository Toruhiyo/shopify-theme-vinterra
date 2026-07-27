(function () {
  function initFloatingScrollbar() {
    var lib = window.OverlayScrollbarsGlobal;
    if (!lib || !lib.OverlayScrollbars) return;

    lib.OverlayScrollbars(
      {
        target: document.body,
        cancel: { nativeScrollbarsOverlaid: false },
      },
      {
        scrollbars: {
          theme: 'os-theme-crimson',
          autoHide: 'leave',
          autoHideDelay: 600,
        },
      }
    );

    document.documentElement.classList.add('os-initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFloatingScrollbar);
  } else {
    initFloatingScrollbar();
  }
})();
