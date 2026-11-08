import type { Page } from '../http/app.ts';
import { PDF_DATE_FORMATS, PDF_FONT_SIZES, PDF_PAPERS, normalizePdfPrefs, type PdfPrefs } from '../db/models.ts';
import { html, type Html } from './html.ts';

// Page setup fields shared by the "Save as PDF" dialog and the settings
// page. `title` adds the editable header text (dialog only).
export function pdfFields(page: Page, p: PdfPrefs, title?: string): Html {
  const { t } = page;
  const checked = (on: boolean) => (on ? 'checked' : '');
  return html`<div class="row">
    <label>${t('pdf.paper')}<select name="paper">
      ${PDF_PAPERS.map((v) => html`<option value="${v}" ${v === p.paper ? 'selected' : ''}>${t('pdf.paper_' + v)}</option>`)}
    </select></label>
    <label>${t('pdf.orientation')}<select name="orientation">
      <option value="portrait" ${p.landscape ? '' : 'selected'}>${t('pdf.portrait')}</option>
      <option value="landscape" ${p.landscape ? 'selected' : ''}>${t('pdf.landscape')}</option>
    </select></label>
    <label>${t('pdf.font_size')}<select name="fontSize">
      ${PDF_FONT_SIZES.map((n) => html`<option value="${n}" ${n === p.fontSize ? 'selected' : ''}>${t('pdf.points', { n })}</option>`)}
    </select></label>
  </div>
  <fieldset><legend>${t('pdf.header')}</legend>
    <label class="check"><input type="checkbox" name="header" value="1" ${checked(p.header)}> ${t('pdf.header_show')}</label>
    ${title !== undefined ? html`<label>${t('pdf.header_text')}<input type="text" name="headerText" value="${title}" maxlength="200"></label>` : ''}
  </fieldset>
  <fieldset><legend>${t('pdf.footer')}</legend>
    <label class="check"><input type="checkbox" name="footerFilename" value="1" ${checked(p.footerFilename)}> ${t('pdf.footer_filename')}</label>
    <label class="check"><input type="checkbox" name="footerDate" value="1" ${checked(p.footerDate)}> ${t('pdf.footer_date')}</label>
    <label>${t('pdf.date_format')}<select name="dateFormat">
      ${PDF_DATE_FORMATS.map((v) => html`<option value="${v}" ${v === p.dateFormat ? 'selected' : ''}>${t('pdf.date_' + v)}</option>`)}
    </select></label>
    <label class="check"><input type="checkbox" name="footerPageNumbers" value="1" ${checked(p.footerPageNumbers)}> ${t('pdf.footer_pages')}</label>
  </fieldset>`;
}

// Reads the fields above from a submitted form. Checkboxes missing from
// the form are off; invalid values take the default.
export function pdfPrefsFromForm(f: Record<string, string>): PdfPrefs {
  return normalizePdfPrefs({
    paper: f.paper,
    landscape: f.orientation === 'landscape',
    fontSize: Number(f.fontSize),
    header: f.header === '1',
    footerFilename: f.footerFilename === '1',
    footerDate: f.footerDate === '1',
    dateFormat: f.dateFormat,
    footerPageNumbers: f.footerPageNumbers === '1',
  });
}
