/* Shopify Theme Editor — Section rendering events */
(function () {
  'use strict';

  document.addEventListener('shopify:section:load', function () {
    window.location.reload();
  });

  document.addEventListener('shopify:section:reorder', function () {
    window.location.reload();
  });
})();
