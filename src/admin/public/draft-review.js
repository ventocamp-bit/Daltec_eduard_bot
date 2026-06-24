export function buildEditedDraftHtml({ intro = '', rows = [], tables = null, notes = '', signature = '', settings = {} }) {
  const draftTables = normalizeDraftTables(tables, rows);
  const tablesHtml = draftTables.map((table) => draftTableHtml(table)).join('');
  return `
    <div style="width:100%;box-sizing:border-box;text-align:center;background-color:#ffffff;padding:20px 12px;">
      <div style="max-width:800px;width:100%;box-sizing:border-box;margin:0 auto;text-align:left;overflow-wrap:break-word;">
        ${textBlockToHtml(intro)}
        ${tablesHtml}
        ${notesBlockToHtml(notes)}
        ${textBlockToHtml(signature)}
      </div>
    </div>
  `;
}

function normalizeDraftTables(tables, rows) {
  if (Array.isArray(tables) && tables.length) {
    return tables.map((table) => ({
      title: table.title || '',
      intro: table.intro || '',
      rows: Array.isArray(table.rows) ? table.rows : []
    }));
  }
  return [{ title: '', intro: '', rows }];
}

function draftTableHtml(table) {
  const bodyRows = table.rows.map((row) => {
    if (row.type === 'section') {
      return `<tr style="background:#FFC000;font-weight:bold;color:#000;"><td colspan="4" style="border:1px solid #000;padding:4px;box-sizing:border-box;">${escapeHtml(row.product)}</td></tr>`;
    }
    const rowStyle = row.type === 'gross'
      ? 'background:#FFC000;font-weight:bold;color:#000;font-size:16px;'
      : row.type === 'total'
        ? 'background:#f9f9f9;font-weight:bold;border-top:2px solid #000;'
        : 'background:#fff;color:#000;';
    const discountStyle = 'color:#c00000;font-weight:bold;';
    return `<tr style="${rowStyle}"><td style="border:1px solid #000;padding:4px;box-sizing:border-box;word-break:break-word;">${escapeHtml(row.product)}</td><td style="border:1px solid #000;padding:4px;box-sizing:border-box;text-align:right;">${escapeHtml(row.uvp)}</td><td style="border:1px solid #000;padding:4px;box-sizing:border-box;text-align:right;${discountStyle}">${escapeHtml(row.discount)}</td><td style="border:1px solid #000;padding:4px;box-sizing:border-box;text-align:right;">${escapeHtml(row.offer)}</td></tr>`;
  }).join('');
  return `
      ${table.title ? `<h3 style="font-family:Arial,sans-serif;font-size:18px;line-height:1.2;text-align:center;color:#000;text-transform:uppercase;margin:20px auto 10px auto;">${escapeHtml(table.title)}</h3>` : ''}
      ${table.intro ? `<p style="font-family:Arial,sans-serif;font-size:14px;color:#000;margin:0 auto 15px auto;text-align:center;line-height:1.5;">${escapeHtml(table.intro)}</p>` : ''}
      <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;line-height:1.4;color:#000;width:100%;max-width:680px;box-sizing:border-box;margin:0 auto 24px auto;table-layout:fixed;">
        <thead>
          <tr style="background:#FFC000;font-weight:bold;color:#000;">
            <th style="border:1px solid #000;padding:4px;box-sizing:border-box;text-align:left;width:37%;">Position</th>
            <th style="border:1px solid #000;padding:4px;box-sizing:border-box;text-align:right;width:21%;">UVP Netto</th>
            <th style="border:1px solid #000;padding:4px;box-sizing:border-box;text-align:right;width:20%;">Rabatt</th>
            <th style="border:1px solid #000;padding:4px;box-sizing:border-box;text-align:right;width:22%;">Angebot Netto</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
  `;
}

function textBlockToHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((part) => `<p style="font-family:Arial,sans-serif;font-size:14px;color:#000000;margin:0 auto 25px auto;text-align:left;line-height:1.5;box-sizing:border-box;">${escapeHtml(part).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function notesBlockToHtml(text) {
  if (!String(text || '').trim()) return '';
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#000000;margin:0 auto 25px auto;text-align:left;line-height:1.5;border:1px solid #ccc;background:#f9f9f9;padding:20px;box-sizing:border-box;">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
