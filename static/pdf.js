// PDF documents built in the browser with pdfmake. Loaded on demand by
// app.js together with pdfmake and html-to-pdfmake; defines
// window.DraftboxPdf.build(), which returns a pdfmake document definition.
(function () {
  'use strict';

  // Page sizes in points (portrait).
  var PAPER = {
    A3: [841.89, 1190.55],
    A4: [595.28, 841.89],
    A5: [419.53, 595.28],
    letter: [612, 792],
    legal: [612, 1008],
  };
  // Left/right and top/bottom page margins in points.
  var MARGIN_X = 50;
  var MARGIN_Y = 60;
  var BOX_COLOR = '#555555';
  var MUTED = '#666666';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // A date in the chosen format, in the viewer's timezone.
  function formatDate(d, fmt, locale) {
    var y = d.getFullYear(), m = pad2(d.getMonth() + 1), day = pad2(d.getDate());
    if (fmt === 'dmy') return day + '.' + m + '.' + y;
    if (fmt === 'mdy') return m + '/' + day + '/' + y;
    if (fmt === 'iso_time') return y + '-' + m + '-' + day + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (fmt === 'long') {
      try { return d.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' }); } catch (e) { /* ISO below */ }
    }
    return y + '-' + m + '-' + day;
  }

  // Calls fn(node) for every object of a pdfmake content tree; a non-
  // undefined result replaces the node.
  function walk(node, fn) {
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) {
        var r = walk(node[i], fn);
        if (r !== undefined) node[i] = r;
      }
      return undefined;
    }
    if (!node || typeof node !== 'object') return undefined;
    var replaced = fn(node);
    if (replaced !== undefined) return replaced;
    ['text', 'stack', 'ul', 'ol', 'columns'].forEach(function (k) {
      if (node[k] && typeof node[k] === 'object') walk(node[k], fn);
    });
    if (node.table && node.table.body) walk(node.table.body, fn);
    return undefined;
  }

  // Images: the copies already shown on the page are embedded as data,
  // so that the PDF never fails on an image that cannot be fetched and
  // formats pdfmake cannot read (GIF, SVG, WebP) still work. Images that
  // are not loaded or cannot be read are replaced with their alt text.
  function embedImages(clone, live, maxW, maxH) {
    var shown = live.querySelectorAll('img');
    Array.prototype.forEach.call(clone.querySelectorAll('img'), function (img, i) {
      var src = shown[i];
      var data = null, width = 0;
      if (src && src.complete && src.naturalWidth > 0) {
        try {
          var scale = Math.min(1, 2000 / Math.max(src.naturalWidth, src.naturalHeight));
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(src.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(src.naturalHeight * scale));
          canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
          var jpeg = /\.jpe?g($|[?#])/i.test(src.getAttribute('src') || '');
          data = jpeg ? canvas.toDataURL('image/jpeg', 0.92) : canvas.toDataURL('image/png');
          // CSS pixels are 0.75 pt; never wider or taller than the page.
          width = Math.min(src.naturalWidth * 0.75, maxW, maxH * src.naturalWidth / src.naturalHeight);
        } catch (e) {
          data = null;
        }
      }
      if (data) {
        img.setAttribute('src', data);
        img.removeAttribute('width');
        img.removeAttribute('height');
        img.setAttribute('style', 'width:' + width.toFixed(1) + 'pt');
      } else {
        var alt = img.getAttribute('alt');
        img.parentNode.replaceChild(document.createTextNode(alt ? '[' + alt + ']' : ''), img);
      }
    });
  }

  // Rendered Markdown: a copy of the page content prepared for
  // html-to-pdfmake.
  function prepare(live, cw, ch) {
    var clone = live.cloneNode(true);
    embedImages(clone, live, cw, ch);
    Array.prototype.forEach.call(clone.querySelectorAll('a[href]'), function (a) {
      a.setAttribute('href', a.href);
    });
    Array.prototype.forEach.call(clone.querySelectorAll('input[type=checkbox]'), function (box) {
      box.parentNode.replaceChild(document.createTextNode(box.checked ? '[x] ' : '[ ] '), box);
    });
    return clone;
  }

  function markdownStyles(b) {
    return {
      h1: { fontSize: b * 1.8, bold: true, margin: [0, b * 0.6, 0, b * 0.5] },
      h2: { fontSize: b * 1.5, bold: true, margin: [0, b * 0.6, 0, b * 0.4] },
      h3: { fontSize: b * 1.25, bold: true, margin: [0, b * 0.5, 0, b * 0.3] },
      h4: { fontSize: b * 1.1, bold: true, margin: [0, b * 0.4, 0, b * 0.3] },
      h5: { fontSize: b, bold: true, margin: [0, b * 0.4, 0, b * 0.3] },
      h6: { fontSize: b * 0.9, bold: true, margin: [0, b * 0.4, 0, b * 0.3] },
      p: { margin: [0, 0, 0, b * 0.6] },
      ul: { margin: [0, 0, 0, b * 0.6] },
      ol: { margin: [0, 0, 0, b * 0.6] },
      a: { color: '#1f5fa8', decoration: null },
      pre: { font: 'Mono', fontSize: b * 0.85, margin: [0, 0, 0, b * 0.6] },
      code: { font: 'Mono', fontSize: b * 0.88 },
      table: { margin: [0, 0, 0, b * 0.6] },
      th: { bold: true, fillColor: '#eeeeee' },
    };
  }

  // Full-width rules and quotes, which html-to-pdfmake cannot express.
  // (It copies every ancestor's class onto each leaf, so the styling of
  // containers is set on the container nodes here.)
  function fixMarkdown(content, b, cw) {
    walk(content, function (node) {
      if (node.nodeName === 'HR') {
        return { canvas: [{ type: 'line', x1: 0, y1: 0, x2: cw, y2: 0, lineWidth: 0.5, lineColor: '#999999' }], margin: [0, b * 0.5, 0, b * 0.8] };
      }
      if (node.nodeName === 'BLOCKQUOTE') {
        node.margin = [b * 1.2, 0, 0, b * 0.6];
        node.color = MUTED;
      }
      return undefined;
    });
    return content;
  }

  // ---- Fountain screenplays ------------------------------------------
  // The screenplay HTML of src/util/fountain.ts converted directly,
  // laid out like app.css: cues, parentheticals and dialogue indented by
  // a share of the line width.

  function hasClass(el, name) { return el.classList && el.classList.contains(name); }

  // Inline content as pdfmake text runs.
  function runs(el, upper, fmt) {
    var out = [];
    Array.prototype.forEach.call(el.childNodes, function (n) {
      if (n.nodeType === 3) {
        var t = upper ? n.nodeValue.toLocaleUpperCase() : n.nodeValue;
        if (t) {
          var r = { text: t };
          for (var k in fmt) r[k] = fmt[k];
          out.push(r);
        }
        return;
      }
      if (n.nodeType !== 1) return;
      var tag = n.nodeName;
      if (tag === 'BR') { out.push({ text: '\n' }); return; }
      var f = {};
      for (var k2 in fmt) f[k2] = fmt[k2];
      if (tag === 'STRONG' || tag === 'B') f.bold = true;
      if (tag === 'EM' || tag === 'I') f.italics = true;
      if (tag === 'U') f.decoration = 'underline';
      if (hasClass(n, 'fn-note')) { f.color = MUTED; f.background = '#eeeeee'; }
      if (hasClass(n, 'fn-scene-number')) {
        f.color = MUTED;
        out.push.apply(out, runs(n, upper, f));
        out.push({ text: ' ' });
        return;
      }
      out.push.apply(out, runs(n, upper, f));
    });
    return out;
  }

  function line(el, props, upper) {
    var node = { text: runs(el, upper, {}) };
    for (var k in props) node[k] = props[k];
    return node;
  }

  // A speech: character cue, parentheticals and dialogue. `w` is the
  // width of its column; dual dialogue uses narrower indents.
  function speech(el, w, b, dual) {
    var stack = [];
    Array.prototype.forEach.call(el.children, function (c) {
      if (hasClass(c, 'fn-character')) stack.push(line(c, { margin: [w * (dual ? 0.25 : 0.35), 0, 0, 0] }, true));
      else if (hasClass(c, 'fn-parenthetical')) stack.push(line(c, { margin: dual ? [w * 0.12, 0, 0, 0] : [w * 0.25, 0, w * 0.35, 0] }));
      else if (hasClass(c, 'fn-dialogue')) stack.push(line(c, { margin: dual ? [0, 0, 0, 0] : [w * 0.17, 0, w * 0.25, 0] }));
    });
    // Keep a short speech together with its character cue; a long one
    // (which may not fit on a page) flows across pages.
    return { stack: stack, margin: [0, 0, 0, b * 1.1], unbreakable: el.textContent.length < 400 };
  }

  function screenplay(root, b, cw) {
    var gap = b * 1.1;
    var content = [];
    var blocks = root.querySelector('.screenplay') || root;
    Array.prototype.forEach.call(blocks.children, function (el) {
      if (hasClass(el, 'fn-title-page')) {
        var center = el.querySelector('.fn-title-center');
        var meta = el.querySelector('.fn-title-meta');
        var stack = [];
        if (center) {
          Array.prototype.forEach.call(center.children, function (c, i) {
            var title = hasClass(c, 'fn-title');
            stack.push(line(c, { alignment: 'center', bold: title, margin: [0, i ? 0 : gap * 12, 0, title ? gap * 2 : gap] }, title));
          });
        }
        if (meta) {
          Array.prototype.forEach.call(meta.children, function (c, i) {
            stack.push(line(c, { margin: [0, i ? 0 : gap * 8, 0, gap] }));
          });
        }
        content.push({ stack: stack, pageBreak: 'after' });
      } else if (el.nodeName === 'HR') {
        content.push({ text: '', pageBreak: 'after' });
      } else if (hasClass(el, 'fn-scene')) {
        content.push(line(el, { bold: true, margin: [0, gap * 0.5, 0, gap] }, true));
      } else if (hasClass(el, 'fn-speech')) {
        content.push(speech(el, cw, b, false));
      } else if (hasClass(el, 'fn-dual')) {
        var colW = (cw - b) / 2;
        content.push({
          columns: Array.prototype.map.call(el.children, function (c) { return speech(c, colW, b, true); }),
          columnGap: b,
        });
      } else if (hasClass(el, 'fn-transition')) {
        content.push(line(el, { alignment: 'right', margin: [0, 0, 0, gap] }, true));
      } else if (hasClass(el, 'fn-centered')) {
        content.push(line(el, { alignment: 'center', margin: [0, 0, 0, gap] }));
      } else if (hasClass(el, 'fn-lyrics')) {
        content.push(line(el, { italics: true, margin: [0, 0, 0, gap] }));
      } else if (hasClass(el, 'fn-section')) {
        content.push(line(el, { bold: true, color: MUTED, margin: [0, 0, 0, gap] }));
      } else if (hasClass(el, 'fn-synopsis')) {
        content.push(line(el, { italics: true, color: MUTED, margin: [0, 0, 0, gap] }));
      } else {
        content.push(line(el, { margin: [0, 0, 0, gap] }));
      }
    });
    return content;
  }

  // opts: mode ('markdown', 'fountain' or 'text'); element (rendered
  // content) or text; paper, landscape, fontSize, header, headerText,
  // filename, footerFilename, date (Date or null), footerDate,
  // dateFormat, footerPageNumbers, pageOf ("Page {page} of {pages}"),
  // locale.
  function build(opts) {
    var size = PAPER[opts.paper] || PAPER.A4;
    var pageW = opts.landscape ? size[1] : size[0];
    var pageH = opts.landscape ? size[0] : size[1];
    var cw = pageW - 2 * MARGIN_X;
    var ch = pageH - 2 * MARGIN_Y;
    var b = opts.fontSize || 11;
    var content;
    var font = 'Roboto';

    if (opts.mode === 'text') {
      content = [{ text: opts.text.replace(/\t/g, '    '), font: 'Mono', fontSize: b * 0.9, lineHeight: 1.15, preserveLeadingSpaces: true }];
    } else if (opts.mode === 'fountain') {
      // Screenplays are set in a typewriter face, as in print.
      font = 'Mono';
      content = screenplay(opts.element, b, cw);
    } else {
      var clone = prepare(opts.element, cw, ch);
      content = fixMarkdown(window.htmlToPdfmake(clone.innerHTML, {
        defaultStyles: markdownStyles(b),
        removeExtraBlanks: true,
      }), b, cw);
    }

    var box = { fontSize: Math.max(7, b * 0.75), color: BOX_COLOR, font: 'Roboto' };
    var title = (opts.headerText || '').trim() || opts.filename;
    var dateText = opts.footerDate && opts.date ? formatDate(opts.date, opts.dateFormat, opts.locale) : '';
    var withFooter = opts.footerFilename || dateText || opts.footerPageNumbers;

    return {
      pageSize: { width: pageW, height: pageH },
      pageMargins: [MARGIN_X, MARGIN_Y, MARGIN_X, MARGIN_Y],
      info: { title: title },
      defaultStyle: { font: font, fontSize: b, lineHeight: font === 'Mono' ? 1.05 : 1.2 },
      content: content,
      header: opts.header ? function () {
        return { text: title, alignment: 'center', margin: [MARGIN_X, MARGIN_Y * 0.45, MARGIN_X, 0], fontSize: box.fontSize, color: box.color, font: box.font };
      } : undefined,
      footer: withFooter ? function (page, pages) {
        var pageText = opts.footerPageNumbers ? opts.pageOf.replace('{pages}', String(pages)).replace('{page}', String(page)) : '';
        return {
          columns: [
            { text: opts.footerFilename ? opts.filename : '', alignment: 'left' },
            { text: dateText, alignment: 'center' },
            { text: pageText, alignment: 'right' },
          ],
          margin: [MARGIN_X, MARGIN_Y * 0.35, MARGIN_X, 0],
          fontSize: box.fontSize, color: box.color, font: box.font,
        };
      } : undefined,
    };
  }

  window.DraftboxPdf = { build: build, formatDate: formatDate };
})();
