// Progressive enhancements; every page also works without JavaScript.
(function () {
  'use strict';

  // Timestamps rendered in the viewer's local timezone.
  var lang = document.documentElement.lang;
  var locale = lang === 'uk' ? 'uk-UA' : lang === 'de' ? 'de-DE' : 'en-GB';
  Array.prototype.forEach.call(document.querySelectorAll('time[data-localtime]'), function (el) {
    var d = new Date(el.getAttribute('datetime'));
    if (isNaN(d.getTime())) return;
    try {
      var style = el.getAttribute('data-localtime');
      var opts = { year: 'numeric', month: 'short', day: 'numeric' };
      if (style !== 'date') {
        opts.hour = '2-digit';
        opts.minute = '2-digit';
      }
      if (style === 'full') {
        opts.second = '2-digit';
        opts.timeZoneName = 'short';
      }
      el.textContent = d.toLocaleString(locale, opts);
      el.title = d.toISOString();
    } catch (e) { /* keep the server-rendered text */ }
  });

  document.addEventListener('submit', function (ev) {
    var form = ev.target;
    var msg = form.getAttribute && form.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) ev.preventDefault();
  });

  document.addEventListener('change', function (ev) {
    if (ev.target.hasAttribute && ev.target.hasAttribute('data-autosubmit')) ev.target.form.submit();
  });

  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest && ev.target.closest('[data-copy]');
    if (!btn) return;
    var input = document.getElementById(btn.getAttribute('data-copy'));
    if (!input) return;
    input.select();
    var done = function () {
      var old = btn.textContent;
      btn.textContent = '\u2713';
      setTimeout(function () { btn.textContent = old; }, 1200);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(input.value).then(done, function () {});
    else { document.execCommand('copy'); done(); }
  });

  // Color fields: a swatch button opens a modal dialog, so the picker
  // must be closed (Done or Cancel/Escape) before anything else on the
  // page can be used.
  var colorDialog = document.querySelector('dialog.color-dialog');
  if (colorDialog && colorDialog.showModal) {
    var HEX_RE = /^#[0-9a-fA-F]{6}$/;
    var part = function (name) { return colorDialog.querySelector('[data-part=' + name + ']'); };
    var hue = part('hue'), sat = part('saturation'), light = part('lightness');
    var hexInput = part('hex'), previewBox = part('preview');
    var target = null, current = '#000000';

    var hexToHsl = function (hex) {
      var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
      var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      var h = 0, l = (max + min) / 2, s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
      if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h = (h * 60 + 360) % 360;
      }
      return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
    };
    var hslToHex = function (h, s, l) {
      s /= 100; l /= 100;
      var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
      var rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
      return '#' + rgb.map(function (v) { return ('0' + Math.round((v + m) * 255).toString(16)).slice(-2); }).join('');
    };
    var show = function (hex, fromSliders) {
      current = hex.toLowerCase();
      previewBox.style.background = current;
      if (document.activeElement !== hexInput) hexInput.value = current;
      if (!fromSliders) {
        var hsl = hexToHsl(current);
        hue.value = hsl[0]; sat.value = hsl[1]; light.value = hsl[2];
      }
    };

    [hue, sat, light].forEach(function (el) {
      el.addEventListener('input', function () { show(hslToHex(+hue.value % 360, +sat.value, +light.value), true); });
    });
    hexInput.addEventListener('input', function () {
      var v = hexInput.value.trim();
      if (v.charAt(0) !== '#') v = '#' + v;
      if (HEX_RE.test(v)) show(v);
    });
    colorDialog.querySelectorAll('[data-color]').forEach(function (sw) {
      sw.addEventListener('click', function () { show(sw.getAttribute('data-color')); });
    });
    colorDialog.addEventListener('close', function () {
      if (target && colorDialog.returnValue === 'ok') {
        target.value = current;
        target.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (target) target.previousSibling.focus();
      target = null;
    });

    document.querySelectorAll('input[data-color-picker]').forEach(function (input) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-button';
      btn.setAttribute('aria-label', document.getElementById('color-dialog-title').textContent);
      var sync = function () { if (HEX_RE.test(input.value)) btn.style.background = input.value; };
      sync();
      input.addEventListener('input', sync);
      input.parentNode.insertBefore(btn, input);
      btn.addEventListener('click', function () {
        target = input;
        show(HEX_RE.test(input.value) ? input.value : '#000000');
        colorDialog.returnValue = '';
        colorDialog.showModal();
      });
    });
  }

  // Markdown editor: write/preview tabs and unsaved-changes warning.
  var editor = document.querySelector('form[data-editor]');
  if (editor) {
    var textarea = editor.querySelector('textarea[name=content]');
    var preview = editor.querySelector('.preview');
    var csrf = editor.querySelector('input[name=_csrf]').value;
    var dirty = false;
    textarea.addEventListener('input', function () { dirty = true; });
    editor.addEventListener('submit', function () { dirty = false; });
    window.addEventListener('beforeunload', function (ev) {
      if (dirty) { ev.preventDefault(); ev.returnValue = ''; }
    });
    textarea.addEventListener('keydown', function (ev) {
      if (ev.key === 'Tab' && !ev.shiftKey && !ev.ctrlKey && !ev.altKey) {
        ev.preventDefault();
        var s = textarea.selectionStart;
        textarea.setRangeText('  ', s, textarea.selectionEnd, 'end');
        dirty = true;
      }
    });
    editor.querySelectorAll('.edittabs .tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        editor.querySelectorAll('.edittabs .tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        if (tab.getAttribute('data-tab') === 'preview') {
          var body = new URLSearchParams();
          body.set('_csrf', csrf);
          body.set('content', textarea.value);
          preview.innerHTML = '';
          fetch('/preview', { method: 'POST', body: body, credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (j) { preview.innerHTML = j.html; });
          textarea.hidden = true;
          preview.hidden = false;
        } else {
          textarea.hidden = false;
          preview.hidden = true;
        }
      });
    });
  }
})();
