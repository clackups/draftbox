// Progressive enhancements; every page also works without JavaScript.
(function () {
  'use strict';

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
