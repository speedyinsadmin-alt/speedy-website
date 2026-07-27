/* ============================================================
   Speedy Insurance Agency — TurboRater for Websites skin
   Hosted: https://speedyins.com/tr-style.js
   Injected via TfW Admin → Design → Custom JavaScript Urls
   (per ITC FAQ #415). Applies to New + Legacy raters.

   SAFETY CONTRACT
   - Only ever: appends <link>/<style> to <head>, and adds a
     className to existing card containers.
   - Never reads, writes, or clears form values.
   - Never adds/removes/reorders DOM nodes.
   - Never touches submit, navigation, or event handlers.
   - Everything wrapped in try/catch. On any failure the rater
     renders stock and quoting is completely unaffected.
   ============================================================ */
(function () {
  'use strict';

  var STYLE_ID = 'speedy-tfw-skin';
  var CHOICE   = 'speedy-card-choice';   /* clickable line-of-business cards */
  var FIELD    = 'speedy-card-field';    /* cards that contain form inputs    */

  var CSS = [
    /* ---------- PAGE ---------- */
    'body { background: #FAF9F6 !important; }',

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

    /* ---------- CARDS ---------- */
    '.' + CHOICE + ', .' + FIELD + ' {',
    '  background: #FFFFFF !important;',
    '  border: 1px solid #E5E3DE !important;',
    '  border-radius: 14px !important;',
    '  box-shadow: 0 1px 3px rgba(0,0,0,0.06) !important;',
    '  transition: box-shadow .2s ease, border-color .2s ease, transform .2s ease !important;',
    '}',
    '.' + CHOICE + ' {',
    '  cursor: pointer !important;',
    '  padding: 22px 18px !important;',
    '}',
    '.' + CHOICE + ':hover {',
    '  border-color: #D42B2B !important;',
    '  box-shadow: 0 12px 32px rgba(11,24,41,0.13) !important;',
    '  transform: translateY(-3px) !important;',
    '}',
    '.' + CHOICE + ' img {',
    '  max-height: 92px !important;',
    '  width: auto !important;',
    '  opacity: .88 !important;',
    '}',
    '.' + CHOICE + ' h1, .' + CHOICE + ' h2, .' + CHOICE + ' h3,',
    '.' + FIELD  + ' h1, .' + FIELD  + ' h2, .' + FIELD  + ' h3 {',
    '  color: #0B1829 !important;',
    '  font-weight: 700 !important;',
    '}',
    '.' + FIELD + ':hover { border-color: #C8C5BD !important; }',
    '.' + FIELD + ' img { max-height: 74px !important; width: auto !important; opacity: .8 !important; }',

    /* ---------- LANGUAGE TOGGLE ---------- */
    'input[value="Espa\u00f1ol"], input[value="Espanol"],',
    'input[value="English"], input[value="Ingl\u00e9s"] {',
    '  background: transparent !important;',
    '  background-image: none !important;',
    '  border: 1.5px solid #D42B2B !important;',
    '  color: #D42B2B !important;',
    '  border-radius: 999px !important;',
    '  font-size: 13px !important;',
    '  font-weight: 700 !important;',
    '  padding: 7px 20px !important;',
    '  box-shadow: none !important;',
    '  width: auto !important;',
    '  min-width: 0 !important;',
    '}',
    'input[value="Espa\u00f1ol"]:hover, input[value="Espanol"]:hover,',
    'input[value="English"]:hover, input[value="Ingl\u00e9s"]:hover {',
    '  background: #D42B2B !important;',
    '  color: #FFFFFF !important;',
    '}',

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
    '::placeholder { color: #8A8780 !important; opacity: 1 !important; }'
  ].join('\n');

  /* ---------- 1. inject stylesheet ---------- */
  function injectStyle() {
    try {
      if (document.getElementById(STYLE_ID)) return;
      var head = document.head || document.getElementsByTagName('head')[0];
      if (!head) return;

      var pre = document.createElement('link');
      pre.rel = 'preconnect';
      pre.href = 'https://fonts.gstatic.com';
      pre.crossOrigin = 'anonymous';
      head.appendChild(pre);

      var font = document.createElement('link');
      font.rel = 'stylesheet';
      font.href = 'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=Bebas+Neue&display=swap';
      head.appendChild(font);

      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.appendChild(document.createTextNode(CSS));
      head.appendChild(style);
    } catch (e) { /* silent */ }
  }

  /* ---------- 2. tag cards by STRUCTURE, not class name ----------
     Finds sibling containers that each hold an <img>. A group of
     2-6 same-parent siblings is treated as a card row. Immune to
     ITC renaming their CSS classes.                              */
  function tagCards() {
    try {
      var imgs = document.getElementsByTagName('img');
      var seen = [];
      var i, j;

      for (i = 0; i < imgs.length; i++) {
        var node = imgs[i].parentNode, card = null, hops = 0;
        while (node && node.nodeType === 1 && hops < 5) {
          var r = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
          if (r && r.width >= 140 && r.height >= 110) { card = node; break; }
          node = node.parentNode; hops++;
        }
        if (!card || card === document.body) continue;
        if (seen.indexOf(card) !== -1) continue;
        seen.push(card);
      }

      var byParent = [];
      for (i = 0; i < seen.length; i++) {
        var p = seen[i].parentNode, found = null;
        for (j = 0; j < byParent.length; j++) {
          if (byParent[j].parent === p) { found = byParent[j]; break; }
        }
        if (!found) { found = { parent: p, kids: [] }; byParent.push(found); }
        found.kids.push(seen[i]);
      }

      for (i = 0; i < byParent.length; i++) {
        var kids = byParent[i].kids;
        if (kids.length < 2 || kids.length > 6) continue;
        for (j = 0; j < kids.length; j++) {
          var el = kids[j];
          if (el.className && String(el.className).indexOf('speedy-card') !== -1) continue;
          var hasInput = el.querySelector && el.querySelector('input, select, textarea');
          el.className = (el.className ? el.className + ' ' : '') + (hasInput ? FIELD : CHOICE);
        }
      }
    } catch (e) { /* silent */ }
  }

  /* ---------- 3. run + watch for React re-renders ---------- */
  var pending = null;
  function run() {
    injectStyle();
    if (pending) clearTimeout(pending);
    pending = setTimeout(tagCards, 120);
  }

  function observe() {
    try {
      if (window.MutationObserver && document.body) {
        new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
      }
    } catch (e) { /* silent */ }
  }

  run();
  observe();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { run(); observe(); });
  }
  window.addEventListener('load', run);
})();
