export function buildEditedDraftHtml({ intro = '', rows = [], signature = '', settings = {} }) {
  const colors = presentation(settings);
  const bodyRows = rows.map((row) => {
    if (row.type === 'section') {
      return `<tr><td colspan="3" style="padding:10px 8px;border-bottom:1px solid ${colors.borderColor};background:${colors.headerBackground};font-weight:bold;">${escapeHtml(row.product)}</td></tr>`;
    }
    const totalStyle = row.type === 'gross' || row.type === 'total' ? 'font-weight:bold;' : '';
    return `<tr><td style="padding:8px;border-bottom:1px solid ${colors.borderColor};${totalStyle}">${escapeHtml(row.product)}</td><td style="padding:8px;border-bottom:1px solid ${colors.borderColor};text-align:right;${totalStyle}">${escapeHtml(row.uvp)}</td><td style="padding:8px;border-bottom:1px solid ${colors.borderColor};text-align:right;${totalStyle}${row.type === 'gross' || row.type === 'total' ? `color:${colors.accentColor};` : ''}">${escapeHtml(row.offer)}</td></tr>`;
  }).join('');
  return `
    <div style="width:100%;text-align:center;background-color:#ffffff;padding:20px 0;">
      ${textBlockToHtml(intro)}
      <table style="max-width:800px;width:100%;margin:0 auto;border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;color:${colors.textColor};">
        <thead>
          <tr style="background:${colors.headerBackground};">
            <th style="padding:8px;text-align:left;">Position</th>
            <th style="padding:8px;text-align:right;">UVP brutto</th>
            <th style="padding:8px;text-align:right;">Angebot brutto</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
      ${textBlockToHtml(signature)}
    </div>
  `;
}

function textBlockToHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((part) => `<p style="font-family:Arial,sans-serif;font-size:14px;color:#000000;max-width:800px;margin:0 auto 25px auto;text-align:left;line-height:1.5;">${escapeHtml(part).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function presentation(settings = {}) {
  return {
    headerBackground: settings.table?.headerBackground || '#f2f2f2',
    borderColor: settings.table?.borderColor || '#dddddd',
    accentColor: settings.table?.accentColor || '#c00000',
    textColor: settings.table?.textColor || '#000000'
  };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
