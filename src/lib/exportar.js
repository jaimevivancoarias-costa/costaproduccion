// Exportar a Excel (CSV) y a PDF (vista de impresión), sin librerías.
//
// columnas = [{ titulo, valor: fila => texto, der?: bool }]
// filas    = array de objetos.

function nombreArchivo(nombre) {
  return String(nombre || 'export').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_')
}

// Descarga un .csv que Excel abre bien: BOM para acentos y separador ";"
// (el que usa Excel en Ecuador, porque la coma es decimal).
export function descargarCSV(nombre, columnas, filas) {
  const esc = v => {
    const s = v == null ? '' : String(v)
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const head = columnas.map(c => esc(c.titulo)).join(';')
  const cuerpo = (filas || []).map(f => columnas.map(c => esc(c.valor(f))).join(';')).join('\r\n')
  const csv = '﻿' + head + '\r\n' + cuerpo
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = nombreArchivo(nombre) + '.csv'
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

// Abre una ventana con la tabla lista para imprimir. El usuario elige
// "Guardar como PDF" en el diálogo de impresión.
export function imprimirPDF(titulo, columnas, filas, subtitulo) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const th = columnas.map(c => `<th style="text-align:${c.der ? 'right' : 'left'}">${esc(c.titulo)}</th>`).join('')
  const tr = (filas || []).map(f =>
    '<tr>' + columnas.map(c => `<td style="text-align:${c.der ? 'right' : 'left'}">${esc(c.valor(f))}</td>`).join('') + '</tr>'
  ).join('')
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(titulo)}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;color:#022847;margin:24px}
  h1{font-size:18px;font-weight:600;margin:0 0 2px}
  .sub{color:#7d8fa0;font-size:12px;margin:0 0 16px}
  table{border-collapse:collapse;width:100%;font-size:12px}
  th,td{border-bottom:0.5px solid #dce6ef;padding:6px 9px}
  th{background:#f4f7fa;text-transform:uppercase;font-size:10px;letter-spacing:.03em;color:#5f7284}
  tbody tr:nth-child(even){background:#fafcfd}
  @media print{body{margin:0}}
</style></head>
<body onload="setTimeout(function(){window.print()},300)">
  <h1>${esc(titulo)}</h1>
  ${subtitulo ? `<p class="sub">${esc(subtitulo)}</p>` : ''}
  <table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>
</body></html>`
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.write(html)
  w.document.close()
  return true
}
