export function buildEditedDraftHtml({ intro = '', rows = [], signature = '', settings = {} }) {
  const bodyRows = rows.map((row) => {
    if (row.type === 'section') {
      return `<tr style="background:#FFC000;font-weight:bold;color:#000;"><td colspan="3" style="border:1px solid #000;padding:8px;">${escapeHtml(row.product)}</td></tr>`;
    }
    const rowStyle = row.type === 'gross'
      ? 'background:#FFC000;font-weight:bold;color:#000;font-size:16px;'
      : row.type === 'total'
        ? 'background:#f9f9f9;font-weight:bold;border-top:2px solid #000;'
        : 'background:#fff;color:#000;';
    const offerStyle = 'color:#c00000;font-weight:bold;';
    return `<tr style="${rowStyle}"><td style="border:1px solid #000;padding:8px;">${escapeHtml(row.product)}</td><td style="border:1px solid #000;padding:8px;text-align:right;">${escapeHtml(row.uvp)}</td><td style="border:1px solid #000;padding:8px;text-align:right;${offerStyle}">${escapeHtml(row.offer)}</td></tr>`;
  }).join('');
  return `
    <div style="width:100%;text-align:center;background-color:#ffffff;padding:20px 0;">
      ${textBlockToHtml(intro)}
      <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;color:#000;width:100%;margin:0 auto;">
        <thead>
          <tr style="background:#FFC000;font-weight:bold;color:#000;">
            <th style="border:1px solid #000;padding:8px;text-align:left;">Position</th>
            <th style="border:1px solid #000;padding:8px;text-align:right;">UVP brutto</th>
            <th style="border:1px solid #000;padding:8px;text-align:right;">Angebot brutto</th>
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
