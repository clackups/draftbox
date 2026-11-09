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

  // ---- Hebrew and right-to-left text ---------------------------------
  // pdfmake sets every line from left to right and has no fallback fonts.
  // fontkit (inside pdfmake) shapes a run of Hebrew letters right to
  // left by itself. The rest is done here, and only for text nodes that
  // contain Hebrew (other documents are not changed):
  // - Hebrew gets the font family 'Hebrew' (DejaVu Sans: Roboto and
  //   DejaVu Sans Mono have no Hebrew letters);
  // - every line of text is reordered for display with a compact version
  //   of the Unicode Bidirectional Algorithm (paragraph direction from
  //   the first letter, neutrals resolved between their neighbours,
  //   embedding levels, reversal by level);
  // - a right-to-left paragraph is broken into lines here (pdfmake would
  //   fill lines from the left), using opts.measure; each line is set
  //   right-aligned, and margins, alignment, table columns, side-by-side
  //   columns and list markers are mirrored;
  // - code (preformatted text in Markdown and screenplays) stays left to
  //   right.

  var HEBREW = /[\u0590-\u05ff\ufb1d-\ufb4f]/;
  var HEBREW_LETTER = /[\u05d0-\u05ea\u05ef-\u05f2\ufb1d\ufb1f-\ufb28\ufb2a-\ufb4f]/;
  var LETTER = /\p{L}/u;
  var DIGIT = /\p{Nd}/u;
  var MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };
  // Properties of a text run that its parts do not inherit.
  var NOT_INHERITED = { text: 1, nodeName: 1, margin: 1, alignment: 1, id: 1, preserveLeadingSpaces: 1 };

  // Class of a character: R (Hebrew), L (another letter), EN (digit),
  // WS (whitespace) or ON (anything else).
  function charClass(ch) {
    if (HEBREW.test(ch)) return 'R';
    if (LETTER.test(ch)) return 'L';
    if (DIGIT.test(ch)) return 'EN';
    if (/\s/.test(ch)) return 'WS';
    return 'ON';
  }

  // 'R' or 'L' for the first letter of `s`, or null.
  function firstStrong(s) {
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (HEBREW_LETTER.test(ch)) return 'R';
      if (LETTER.test(ch)) return 'L';
    }
    return null;
  }

  // The plain text of a content node.
  function plainText(node) {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(plainText).join(' ');
    if (!node || typeof node !== 'object') return '';
    if (node.text !== undefined) return plainText(node.text);
    return ['stack', 'ul', 'ol', 'columns'].map(function (k) { return node[k] ? plainText(node[k]) : ''; }).join(' ')
      + (node.table && node.table.body ? plainText(node.table.body) : '');
  }

  function hasHebrew(source) {
    return HEBREW.test(typeof source === 'string' ? source : (source && source.textContent) || '');
  }

  function copyProps(from, into) {
    var out = {};
    var k;
    for (k in into) out[k] = into[k];
    for (k in from) if (!NOT_INHERITED[k]) out[k] = from[k];
    return out;
  }

  // The runs of a text node as [{text, props}], props merged from the
  // enclosing runs.
  function flatten(text, props, out) {
    if (typeof text === 'string') {
      if (text) out.push({ text: text, props: props });
    } else if (Array.isArray(text)) {
      text.forEach(function (t) { flatten(t, props, out); });
    } else if (text && typeof text === 'object') {
      flatten(text.text, copyProps(text, props), out);
    }
    return out;
  }

  // Runs split into units of one character class (and one style).
  function units(runs) {
    var out = [];
    runs.forEach(function (run) {
      var cur = null;
      for (var i = 0; i < run.text.length; i++) {
        var ch = run.text.charAt(i);
        var cls = charClass(ch);
        // Hebrew points and other marks stay with their letter.
        if (cur && cls === 'ON' && /\p{M}/u.test(ch)) cls = cur.cls;
        if (cur && cur.cls === cls) cur.text += ch;
        else out.push(cur = { text: ch, cls: cls, props: run.props });
      }
    });
    return out;
  }

  // Embedding levels of the units of one line (W7, N1/N2 and I1/I2 of
  // the algorithm, for text without explicit direction marks).
  function resolveLevels(us, rtl) {
    var base = rtl ? 'R' : 'L';
    // Numbers after a left-to-right letter count as left to right.
    var prev = base;
    us.forEach(function (u) {
      if (u.cls === 'R' || u.cls === 'L') prev = u.cls;
      u.dir = u.cls === 'EN' ? (prev === 'L' ? 'L' : 'EN') : u.cls === 'R' || u.cls === 'L' ? u.cls : null;
    });
    // Neutrals between letters of one direction take it; others take the
    // paragraph's. Numbers count as right to left here.
    for (var i = 0; i < us.length; i++) {
      if (us[i].dir) continue;
      var j = i;
      while (j < us.length && !us[j].dir) j++;
      var before = i > 0 ? (us[i - 1].dir === 'EN' ? 'R' : us[i - 1].dir) : base;
      var after = j < us.length ? (us[j].dir === 'EN' ? 'R' : us[j].dir) : base;
      var d = before === after ? before : base;
      for (var k = i; k < j; k++) us[k].dir = d;
      i = j - 1;
    }
    us.forEach(function (u) {
      if (rtl) u.level = u.dir === 'R' ? 1 : 2;
      else u.level = u.dir === 'L' ? 0 : u.dir === 'R' ? 1 : 2;
    });
    return us;
  }

  // Display order: from the highest level down to 1, every stretch at
  // that level or higher is reversed.
  function reorder(us) {
    var max = 0;
    us.forEach(function (u) { if (u.level > max) max = u.level; });
    var out = us.slice();
    for (var lv = max; lv >= 1; lv--) {
      for (var i = 0; i < out.length; i++) {
        if (out[i].level < lv) continue;
        var j = i;
        while (j < out.length && out[j].level >= lv) j++;
        var part = out.slice(i, j).reverse();
        for (var k = 0; k < part.length; k++) out[i + k] = part[k];
        i = j;
      }
    }
    return out;
  }

  // A unit as pdfmake text. Hebrew, and the spaces and punctuation in
  // Hebrew text, get the Hebrew font; fontkit sets a Hebrew unit right to
  // left itself. Neutrals set right to left are reversed here, with
  // brackets mirrored.
  function piece(u) {
    var out = copyProps(u.props, {});
    var text = u.text;
    var neutral = u.cls === 'WS' || u.cls === 'ON';
    if (u.level % 2 === 1 && u.cls !== 'R') {
      text = text.split('').reverse().map(function (ch) { return MIRROR[ch] || ch; }).join('');
    }
    out.text = text;
    if (u.cls === 'R' || (neutral && u.dir === 'R')) out.font = 'Hebrew';
    return out;
  }

  function visualLine(us, rtl) {
    return reorder(resolveLevels(us, rtl)).map(piece);
  }

  // Greedy line breaking of words (lists of units) into `width`.
  function breakLines(words, width, measureUnit) {
    var lines = [];
    var line = [];
    var used = 0;
    words.forEach(function (w) {
      // Punctuation and spaces next to Hebrew are set in the Hebrew font.
      var hebrew = w.some(function (u) { return u.cls === 'R'; });
      var ww = w.reduce(function (sum, u) { return sum + measureUnit(u.text, u.props, hebrew && (u.cls === 'WS' || u.cls === 'ON')); }, 0);
      var gap = line.length ? measureUnit(' ', w[0].props, hebrew) : 0;
      if (line.length && used + gap + ww > width) {
        lines.push(line);
        line = [];
        used = 0;
        gap = 0;
      }
      line.push(w);
      used += gap + ww;
    });
    if (line.length) lines.push(line);
    return lines;
  }

  function normMargin(m) {
    if (typeof m === 'number') return [m, m, m, m];
    if (Array.isArray(m) && m.length === 2) return [m[0], m[1], m[0], m[1]];
    if (Array.isArray(m) && m.length === 4) return m.slice();
    return [0, 0, 0, 0];
  }

  function mirrorMargin(node) {
    if (node.margin === undefined) return;
    var m = normMargin(node.margin);
    node.margin = [m[2], m[1], m[0], m[3]];
  }

  function mirrorAlign(a) {
    return a === 'center' ? 'center' : a === 'right' ? 'left' : 'right';
  }

  // Lays out the text of `node` that contains Hebrew. `width` is the
  // width available to it; `inh` holds what it inherits: font, fontSize,
  // bold, italics, and the flags keepLayout (header and footer: words
  // reordered, alignment and margins kept) and textFile (every line of a
  // plain text file takes its own direction; elsewhere preformatted text
  // is code and stays left to right).
  function bidi(node, width, inh, measure) {
    if (Array.isArray(node)) return node.map(function (n) { return bidi(n, width, inh, measure); });
    if (typeof node === 'string') return HEBREW.test(node) ? bidi({ text: node }, width, inh, measure) : node;
    if (!node || typeof node !== 'object' || !HEBREW.test(plainText(node))) return node;
    var m = normMargin(node.margin);
    var inner = width - m[0] - m[2];
    var here = {
      font: node.font || inh.font,
      fontSize: node.fontSize || inh.fontSize,
      bold: node.bold !== undefined ? node.bold : inh.bold,
      italics: node.italics !== undefined ? node.italics : inh.italics,
      keepLayout: inh.keepLayout,
      textFile: inh.textFile,
    };
    if (node.text !== undefined) return bidiText(node, inner, here, measure);
    var rtl = !here.keepLayout && firstStrong(plainText(node)) === 'R';
    if (rtl) mirrorMargin(node);
    if (node.stack) node.stack = bidi(node.stack, inner, here, measure);
    if ((node.ul || node.ol) && rtl) return bidiList(node, inner, here, measure);
    if (node.ul) node.ul = bidi(node.ul, inner - here.fontSize * 1.5, here, measure);
    if (node.ol) node.ol = bidi(node.ol, inner - here.fontSize * 2.5, here, measure);
    if (node.columns) {
      var n = node.columns.length;
      var colW = (inner - (node.columnGap || 0) * (n - 1)) / n;
      node.columns = node.columns.map(function (c) { return bidi(c, colW, here, measure); });
      if (rtl) node.columns.reverse();
    }
    if (node.table && node.table.body) {
      var cols = (node.table.body[0] || []).length || 1;
      // Cell padding and borders: a little less than an equal share.
      var cellW = inner / cols - 10;
      node.table.body = node.table.body.map(function (row) {
        var cells = row.map(function (cell) { return bidi(cell, cellW, here, measure); });
        return rtl ? cells.reverse() : cells;
      });
      if (rtl && Array.isArray(node.table.widths)) node.table.widths = node.table.widths.slice().reverse();
    }
    return node;
  }

  // A right-to-left list, which pdfmake would lay out from the left: its
  // items become a stack with the marker before the text (on the right).
  function bidiList(node, width, inh, measure) {
    var ordered = !!node.ol;
    var items = node.ol || node.ul;
    var start = typeof node.start === 'number' ? node.start : 1;
    var indent = inh.fontSize * (ordered ? 2 : 1.5);
    var out = {};
    for (var k in node) if (k !== 'ul' && k !== 'ol' && k !== 'start' && k !== 'type') out[k] = node[k];
    out.stack = items.map(function (item, i) {
      var marker = ordered ? (start + i) + '. ' : '\u2022 ';
      if (typeof item === 'string' || (item && item.text !== undefined)) {
        var withMarker = typeof item === 'string' ? { text: [marker, item] } : copyProps(item, { text: [marker, item.text] });
        if (item.margin !== undefined) withMarker.margin = item.margin;
        return bidi(withMarker, width, inh, measure);
      }
      var nested = bidi(item, width - indent, inh, measure);
      return { stack: [nested], margin: [0, 0, indent, 0] };
    });
    return out;
  }

  // Splits runs at line breaks.
  function splitLines(runs) {
    var lines = [[]];
    runs.forEach(function (r) {
      r.text.split('\n').forEach(function (part, i) {
        if (i > 0) lines.push([]);
        if (part) lines[lines.length - 1].push({ text: part, props: r.props });
      });
    });
    return lines;
  }

  function bidiText(node, width, inh, measure) {
    var code = !!node.preserveLeadingSpaces && !inh.textFile;
    // The node's own text properties go into every piece: pdfmake does not
    // pass them from the stack that may replace the node to its lines.
    var lines = splitLines(flatten(node.text, copyProps(node, {}), []));
    var measureUnit = function (text, props, hebrewFont) {
      var font = hebrewFont || HEBREW.test(text) ? 'Hebrew' : props.font || inh.font;
      var bold = props.bold !== undefined ? props.bold : inh.bold;
      var italics = props.italics !== undefined ? props.italics : inh.italics;
      return measure(text, font, !!bold, !!italics, props.fontSize || inh.fontSize);
    };
    var anyRtl = false;
    // Each line: its pieces when set as one line (left to right, or kept
    // layout), or a stack of right-aligned lines.
    var out = lines.map(function (runs) {
      var text = runs.map(function (r) { return r.text; }).join('');
      var rtl = !code && firstStrong(text) === 'R';
      anyRtl = anyRtl || rtl;
      var us = units(runs);
      if (!rtl || inh.keepLayout) return { pieces: visualLine(us, rtl) };
      // Indentation of preformatted text is kept, on the right.
      var indent = 0;
      if (node.preserveLeadingSpaces && us.length && us[0].cls === 'WS') indent = measureUnit(us.shift().text, us.length ? us[0].props : {}, false);
      // Words in logical order, for breaking into lines.
      var words = [];
      var word = null;
      us.forEach(function (u) {
        if (u.cls === 'WS') {
          word = null;
        } else {
          if (!word) words.push(word = []);
          word.push(u);
        }
      });
      // A small reserve, so that pdfmake never wraps a line again.
      return {
        indent: indent,
        rows: breakLines(words, (width - indent) * 0.97, measureUnit).map(function (ws) {
          var lineUnits = [];
          ws.forEach(function (w, i) {
            if (i) lineUnits.push({ text: ' ', cls: 'WS', props: w[0].props });
            lineUnits.push.apply(lineUnits, w);
          });
          return visualLine(lineUnits, true);
        }),
      };
    });
    if (lines.length === 1 && out[0].pieces) {
      node.text = out[0].pieces;
      return node;
    }
    var result = {};
    for (var k in node) if (k !== 'text') result[k] = node[k];
    var rowAlign = mirrorAlign(node.alignment);
    if (anyRtl && !inh.keepLayout) {
      mirrorMargin(result);
      if (lines.length === 1 || lines.every(function (_, i) { return out[i].rows; })) result.alignment = rowAlign;
    }
    var stack = [];
    out.forEach(function (o) {
      if (o.pieces) stack.push({ text: o.pieces.length ? o.pieces : ' ', alignment: node.alignment, preserveLeadingSpaces: node.preserveLeadingSpaces });
      else o.rows.forEach(function (row) { stack.push({ text: row, alignment: rowAlign, margin: [0, 0, o.indent, 0] }); });
    });
    delete result.preserveLeadingSpaces;
    result.stack = stack;
    return result;
  }

  // opts: mode ('markdown', 'fountain' or 'text'); element (rendered
  // content) or text; paper, landscape, fontSize, header, headerText,
  // filename, footerFilename, date (Date or null), footerDate,
  // dateFormat, footerPageNumbers, pageOf ("Page {page} of {pages}"),
  // locale; measure(text, family, bold, italics, size), the width of a
  // text in points, needed (and used) only for Hebrew.
  function build(opts) {
    var size = PAPER[opts.paper] || PAPER.A4;
    var pageW = opts.landscape ? size[1] : size[0];
    var pageH = opts.landscape ? size[0] : size[1];
    var cw = pageW - 2 * MARGIN_X;
    var ch = pageH - 2 * MARGIN_Y;
    var b = opts.fontSize || 11;
    var content;
    var font = 'Roboto';

    var hebrew = opts.measure && (hasHebrew(opts.mode === 'text' ? opts.text : opts.element) || hasHebrew(opts.headerText || '') || hasHebrew(opts.filename));
    if (opts.mode === 'text') {
      var text = opts.text.replace(/\t/g, '    ');
      content = [{ text: text, font: 'Mono', fontSize: b * 0.9, lineHeight: 1.15, preserveLeadingSpaces: true }];
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

    var lay = function (node, width, inh) { return hebrew ? bidi(node, width, inh, opts.measure) : node; };
    content = lay(content, cw, { font: font, fontSize: b, bold: false, italics: false, textFile: opts.mode === 'text' });

    var box = { fontSize: Math.max(7, b * 0.75), color: BOX_COLOR, font: 'Roboto' };
    var boxInh = { font: box.font, fontSize: box.fontSize, bold: false, italics: false, keepLayout: true };
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
        return lay({ text: title, alignment: 'center', margin: [MARGIN_X, MARGIN_Y * 0.45, MARGIN_X, 0], fontSize: box.fontSize, color: box.color, font: box.font }, pageW, boxInh);
      } : undefined,
      footer: withFooter ? function (page, pages) {
        var pageText = opts.footerPageNumbers ? opts.pageOf.replace('{pages}', String(pages)).replace('{page}', String(page)) : '';
        return lay({
          columns: [
            { text: opts.footerFilename ? opts.filename : '', alignment: 'left' },
            { text: dateText, alignment: 'center' },
            { text: pageText, alignment: 'right' },
          ],
          margin: [MARGIN_X, MARGIN_Y * 0.35, MARGIN_X, 0],
          fontSize: box.fontSize, color: box.color, font: box.font,
        }, pageW, boxInh);
      } : undefined,
    };
  }

  window.DraftboxPdf = { build: build, formatDate: formatDate, hasHebrew: hasHebrew };
})();
