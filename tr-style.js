/* ============================================================
   Speedy Insurance Agency — TurboRater for Websites skin
   Hosted: https://speedyins.com/tr-style.js
   Injected via TfW Admin → Design → Custom JavaScript Urls
   (per ITC FAQ #415). Applies to New + Legacy raters.

   Safe by design: only appends <link> and <style> to <head>.
   Never touches rater markup, form fields, or submission logic.
   Fully wrapped in try/catch — if anything fails, the rater
   renders stock and quoting is unaffected.
   ============================================================ */
(function () {
  'use strict';

  var STYLE_ID = 'speedy-tfw-skin';

  var CSS = [
    /* ---------- TYPOGRAPHY ---------- */
    'body, input, select, textarea, button, label, span, div, p, a, li, td, th {',
    '  font-family: "Outfit", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;',
    '}',
    'h1, h2, h3, h4 {',
    '  font-family: "Bebas Neue", "Outfit", sans-serif !important;',
    '  letter-spacing: 2px !important;',
    '  color: #0B1829 !important;',
    '}',

    /* ---------- KILL THE ITC TEAL ---------- */
    '[style*="1da0a9"], [style*="1DA0A9"] { color: #0B1829 !important; }',
    'a { color: #1A4FA0 !important; }',
    'a:hover { color: #D42B2B !important; }',

    /* ---------- PRIMARY BUTTONS ---------- */
    'input.pageButton, .pageButton, button.pageButton {',
    '  background: #D42B2B !important;',
    '  background-image: none !important;',
    '  border: 1px solid #D42B2B !important;',
    '  color: #FFFFFF !important;',
    '  border-radius: 8px !important;',
    '  font-weight: 700 !important;',
    '  letter-spacing: .3px !important;',
    '  padding: 12px 30px !important;',
    '  cursor: pointer !important;',
    '  box-shadow: 0 4px 16px rgba(212,43,43,0.22) !important;',
    '  transition: background .2s ease !important;',
    '}',
    'input.pageButton:hover, .pageButton:hover, button.pageButton:hover {',
    '  background: #a81f1f !important;',
    '  border-color: #a81f1f !important;',
    '}',

    /* ---------- SECONDARY / BACK ---------- */
    'input.previousPage, .previousPage {',
    '  background: transparent !important;',
    '  background-image: none !important;',
    '  border: 1px solid #C8C5BD !important;',
    '  color: #4A4844 !important;',
    '  border-radius: 8px !important;',
    '  font-weight: 600 !important;',
    '  padding: 12px 26px !important;',
    '  cursor: pointer !important;',
    '}',
    'input.previousPage:hover, .previousPage:hover {',
    '  border-color: #0B1829 !important;',
    '  color: #0B1829 !important;',
    '}',

    /* ---------- INPUTS ---------- */
    'input[type="text"], input[type="tel"], input[type="email"],',
    'input[type="number"], input[type="password"], select, textarea {',
    '  color: #1A1918 !important;',
    '  border-bottom-color: #C8C5BD !important;',
    '}',
    'input[type="text"]:focus, input[type="tel"]:focus, input[type="email"]:focus,',
    'input[type="number"]:focus, select:focus, textarea:focus {',
    '  border-bottom-color: #D42B2B !important;',
    '  outline: none !important;',
    '}',
    'select { color: #1A4FA0 !important; font-weight: 600 !important; }',
    '::placeholder { color: #8A8780 !important; opacity: 1 !important; }',

    /* ---------- CARDS ---------- */
    '.tombstone, [class*="tombstone"] {',
    '  border-color: #E5E3DE !important;',
    '  border-radius: 14px !important;',
    '}'
  ].join('\n');

  function inject() {
    try {
      if (document.getElementById(STYLE_ID)) return;      // idempotent
      var head = document.head || document.getElementsByTagName('head')[0];
      if (!head) return;

      // Google Fonts
      var pre = document.createElement('link');
      pre.rel = 'preconnect';
      pre.href = 'https://fonts.gstatic.com';
      pre.crossOrigin = 'anonymous';
      head.appendChild(pre);

      var font = document.createElement('link');
      font.rel = 'stylesheet';
      font.href = 'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=Bebas+Neue&display=swap';
      head.appendChild(font);

      // Skin
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.type = 'text/css';
      style.appendChild(document.createTextNode(CSS));
      head.appendChild(style);
    } catch (e) {
      /* fail silent — never break the rater */
    }
  }

  inject();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  }
  window.addEventListener('load', inject);
})();
