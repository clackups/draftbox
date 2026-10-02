// Minimal HTML templating: tagged template literals with automatic
// escaping. Interpolated values are escaped unless wrapped in Raw.

export class Raw {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export type Html = Raw;
type Value = Raw | string | number | boolean | null | undefined | Value[];

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(v: Value): string {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Value[]): Raw {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Raw(out);
}

export function raw(s: string): Raw {
  return new Raw(s);
}

// Builds a URL path from segments, escaping each one.
export function urlPath(...segments: string[]): string {
  return '/' + segments.flatMap((s) => s.split('/')).filter((s) => s.length > 0).map(encodeURIComponent).join('/');
}
