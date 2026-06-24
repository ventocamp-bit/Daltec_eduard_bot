export function buildEditedDraftHtml({ intro = '', rows = [], tables = null, notes = '', signature = '', settings = {} }) {
  const draftTables = normalizeDraftTables(tables, rows);
  const theme = normalizeOfferTheme(settings.theme || {});
  const hasInventoryAlternative = draftTables.some((table) => table.role === 'inventory_alternative');
  const tablesHtml = draftTables.map((table) => draftTableHtml(table, theme)).join('');
  const entrepreneurHintHtml = hasInventoryAlternative ? '' : entrepreneurHintToHtml(settings);
  const notesHtml = notesBlockToHtml(notes, { hasInventoryAlternative });
  return `
    <div style="width:100%;box-sizing:border-box;text-align:center;background-color:#ffffff;padding:20px 0;">
      <div style="max-width:680px;width:100%;box-sizing:border-box;margin:0 auto;text-align:left;overflow-wrap:break-word;">
        ${textBlockToHtml(intro)}
        ${tablesHtml}
        ${entrepreneurHintHtml}
        ${notesHtml}
        ${textBlockToHtml(signature)}
      </div>
    </div>
  `;
}

function normalizeDraftTables(tables, rows) {
  if (Array.isArray(tables) && tables.length) {
    return tables.map((table) => ({
      role: table.role || '',
      title: table.title || '',
      intro: table.intro || '',
      stockNoticeHtml: table.stockNoticeHtml || '',
      rows: Array.isArray(table.rows) ? table.rows : []
    }));
  }
  return [{ title: '', intro: '', rows }];
}

function draftTableHtml(table, theme) {
  const bodyRows = table.rows.map((row) => {
    if (row.type === 'section') {
      return `<tr style="background:${theme.offerTableHeaderBg};font-weight:bold;color:#000;"><td colspan="4" style="border:1px solid ${theme.borderColor};padding:8px 10px;box-sizing:border-box;">${escapeHtml(row.product)}</td></tr>`;
    }
    const rowStyle = row.type === 'gross'
      ? `background:${theme.offerTableHeaderBg};font-weight:bold;color:#000;font-size:16px;`
      : row.type === 'total'
        ? 'background:#ffffff;color:#000;'
        : 'background:#fff;color:#000;';
    const discountStyle = 'color:#c00000;font-weight:bold;';
    return `<tr style="${rowStyle}"><td style="border:1px solid ${theme.borderColor};padding:8px 10px;box-sizing:border-box;text-align:left;vertical-align:top;word-break:break-word;">${escapeHtml(displayRowProduct(row))}</td><td style="border:1px solid ${theme.borderColor};padding:8px 10px;box-sizing:border-box;text-align:right;white-space:nowrap;">${moneyCellToHtml(row.uvp)}</td><td style="border:1px solid ${theme.borderColor};padding:8px 10px;box-sizing:border-box;text-align:right;white-space:nowrap;${discountStyle}">${moneyCellToHtml(row.discount)}</td><td style="border:1px solid ${theme.borderColor};padding:8px 10px;box-sizing:border-box;text-align:right;white-space:nowrap;">${moneyCellToHtml(row.offer)}</td></tr>`;
  }).join('');
  const tableTitle = table.title || 'Position';
  const headingHtml = table.role === 'inventory_alternative' && table.title
    ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:28px;line-height:1.2;font-weight:bold;text-align:center;color:#111;margin:28px auto 14px auto;">${escapeHtml(table.title)}</div>`
    : '';
  const stockNoticeHtml = table.role === 'inventory_alternative' && table.stockNoticeHtml
    ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111;margin:0 auto 14px auto;text-align:center;line-height:1.55;max-width:680px;">${sanitizeInlineHtml(table.stockNoticeHtml)}</p>`
    : '';
  const introHtml = table.intro
    ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111;margin:0 auto 16px auto;text-align:center;line-height:1.55;max-width:680px;${table.role === 'inventory_alternative' ? 'font-weight:bold;text-transform:uppercase;' : ''}">${escapeHtml(displayTableIntro(table))}</p>`
    : '';
  return `
      ${headingHtml}
      ${stockNoticeHtml}
      ${introHtml}
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.35;color:#000;width:100%;max-width:680px;box-sizing:border-box;margin:0 auto 22px auto;table-layout:fixed;">
        <thead>
          <tr style="background:${theme.offerTableHeaderBg};font-weight:bold;color:#000;">
            <th style="border:1px solid ${theme.borderColor};padding:8px 10px;box-sizing:border-box;text-align:left;width:40%;">${escapeHtml(tableTitle)}</th>
            <th style="border:1px solid ${theme.borderColor};padding:8px 10px;box-sizing:border-box;text-align:center;width:20%;">UVP Netto</th>
            <th style="border:1px solid ${theme.borderColor};padding:8px 10px;box-sizing:border-box;text-align:center;width:18%;">Rabatt</th>
            <th style="border:1px solid ${theme.borderColor};padding:8px 10px;box-sizing:border-box;text-align:center;width:22%;">Angebot Netto</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
  `;
}

function textBlockToHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((part) => `<p style="font-family:Arial,sans-serif;font-size:13px;color:#000000;margin:0 auto 25px auto;text-align:left;line-height:1.55;box-sizing:border-box;">${inlineTextToHtml(part).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function notesBlockToHtml(text, options = {}) {
  if (!String(text || '').trim()) return '';
  if (options.hasInventoryAlternative && isGenericQuestionNote(text)) return '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#000000;margin:12px auto 25px auto;text-align:left;line-height:1.5;border:1px solid #d3d3d3;background:#fafafa;padding:18px 20px;box-sizing:border-box;">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
}

function normalizeOfferTheme(theme = {}) {
  const candidate = theme.offerTableHeaderBg || '#F2B400';
  const color = /^#[0-9a-f]{6}$/i.test(String(candidate || '')) ? String(candidate) : '#F2B400';
  const borderCandidate = theme.offerTableBorderColor || theme.borderColor || '#222222';
  const borderColor = /^#[0-9a-f]{6}$/i.test(String(borderCandidate || '')) ? String(borderCandidate) : '#222222';
  return {
    offerTableHeaderBg: color.toUpperCase(),
    borderColor: borderColor.toUpperCase()
  };
}

function displayRowProduct(row = {}) {
  if (row.type === 'vat') return '20% Mehrwertsteuer';
  return row.product || '';
}

function displayTableIntro(table = {}) {
  if (table.role !== 'inventory_alternative') return table.intro || '';
  return String(table.intro || '').replace(/^Passendes Lagerfahrzeug:\s*/i, '').trim();
}

function entrepreneurHintToHtml(settings = {}) {
  const configured = settings.mail?.entrepreneurHint ?? settings.mail_defaults?.entrepreneurHint;
  if (configured === false) return '';
  const text = typeof configured === 'string' && configured.trim()
    ? configured.trim()
    : 'Hinweis fuer Unternehmer: Bei Vorsteuerabzug reduziert sich Ihre Nettobelastung um die ausgewiesene Mehrwertsteuer.';
  return `<p style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#555;max-width:680px;margin:12px auto 0 auto;line-height:1.6;text-align:left;">${escapeHtml(text)}</p>`;
}

function inlineTextToHtml(value) {
  return escapeHtml(value).replace(
    /(Rabatt:\s*)(&euro;|€)?\s*([0-9][0-9.\s]*,[0-9]{2})/g,
    '$1<strong style="color:#c00000;font-weight:bold;">&euro; $3</strong>'
  );
}

function moneyCellToHtml(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const withoutEuro = text.replace(/^€\s*/, '').replace(/^&euro;\s*/i, '');
  return `&euro;&nbsp;${escapeHtml(withoutEuro)}`;
}

function sanitizeInlineHtml(value) {
  return escapeHtml(value)
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
    .replace(/&lt;strong&gt;/gi, '<strong>')
    .replace(/&lt;\/strong&gt;/gi, '</strong>')
    .replace(/&amp;amp;/g, '&amp;');
}

function isGenericQuestionNote(value) {
  return /^bei fragen stehe ich ihnen jederzeit zur verf(ü|ue)gung\.?$/i.test(String(value || '').trim());
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
