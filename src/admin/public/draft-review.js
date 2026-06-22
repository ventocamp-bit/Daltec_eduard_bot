export function buildEditedDraftHtml({ intro = '', rows = [], notes = '', signature = '' }) {
  const bodyRows = rows.map((row) => {
    const style = row.type === 'gross'
      ? 'background:#FFC000;font-weight:bold;'
      : row.type === 'total' ? 'background:#f9f9f9;' : '';
    return `<tr style="${style}"><td style="border:1px solid #000;padding:6px;">${escapeHtml(row.product)}</td><td style="border:1px solid #000;padding:6px;text-align:right;">${escapeHtml(row.uvp)}</td><td style="border:1px solid #000;padding:6px;text-align:right;color:#c00000;font-weight:bold;">${escapeHtml(row.discount)}</td><td style="border:1px solid #000;padding:6px;text-align:right;">${escapeHtml(row.offer)}</td></tr>`;
  }).join('');
  return `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#000;line-height:1.45;">
      ${textBlockToHtml(intro)}
      <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;width:100%;margin:16px 0;">
        <thead>
          <tr style="background:#FFC000;font-weight:bold;color:#000;">
            <th style="border:1px solid #000;padding:6px;text-align:left;">Produkt</th>
            <th style="border:1px solid #000;padding:6px;text-align:right;">UVP</th>
            <th style="border:1px solid #000;padding:6px;text-align:right;color:#c00000;font-weight:bold;">Rabatt</th>
            <th style="border:1px solid #000;padding:6px;text-align:right;">Angebot</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
      ${notes.trim() ? textBlockToHtml(notes) : ''}
      ${textBlockToHtml(signature)}
    </div>
  `;
}

function textBlockToHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
