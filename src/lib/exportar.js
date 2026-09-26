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

// ───────────────────────────────────────────────────────────────────────────
// Reporte de bodega (Balanceado / Insumos / Gasolina)
//
// Un mismo reporte junta "Cuánto hay" y "Qué se movió": encabezado con finca y
// rango, cards de resumen, la tabla con inicial/ingresos/devuelto/consumo, el
// precio con su vigencia, los lotes (cada precio con su fecha de compra), el
// contado y el descuadre. Sirve para las tres categorías; cada página arma sus
// datos y llama a reporteBodegaPDF / reporteBodegaExcel.
//
// opts = {
//   titulo,                       // "Reporte de Bodega — Balanceado"
//   finca,                        // "Langisa"
//   categoria,                    // "Balanceado" | "Insumos" | "Gasolina"
//   meta: [{ k, v }],             // Rango, Impreso, Contó...
//   cards: [{ k, v, alerta? }],   // resumen de arriba
//   columnas: [{
//     titulo, der?,               // encabezado y alineación
//     campo,                      // clave del valor principal en la fila
//     sub?,                       // clave de una segunda línea pequeña (gris)
//     lotes?,                     // si true, fila[campo] es [{ t, sm? }] (varias líneas)
//   }],
//   filas: [ objeto con las claves usadas por columnas ],
//   total: objeto igual (o null) para la fila de Total,
// }

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Celda: valor principal + (segunda línea pequeña | lista de lotes).
function celda(col, fila, chico) {
  if (col.lotes) {
    const arr = fila[col.campo] || []
    if (!arr.length) return '<span class="m">—</span>'
    return arr.map(l => l.sm
      ? `<span class="sm">${esc(l.t)}</span>`
      : esc(l.t)).join('<br>')
  }
  const v = esc(fila[col.campo])
  const sub = col.sub ? fila[col.sub] : null
  return v + (sub ? `<br><span class="${chico}">${esc(sub)}</span>` : '')
}

function reporteBodegaHTML(opts, paraExcel) {
  // Uno o varios bloques (secciones). Cada bloque tiene sus propias columnas.
  const bloques = opts.bloques || [{ columnas: opts.columnas, filas: opts.filas, total: opts.total }]
  const meta = (opts.meta || []).map(m => `${esc(m.k)}: <b>${esc(m.v)}</b>`).join('<br>')
  const cards = (opts.cards || []).map(c =>
    `<div class="rcard${c.alerta ? ' alerta' : ''}"><div class="k">${esc(c.k)}</div><div class="v">${esc(c.v)}</div></div>`
  ).join('')
  const subtitulo = opts.subtitulo != null ? opts.subtitulo : 'Inventario que hay y que se movió'
  const pie = opts.pie != null ? opts.pie : '<b>Cómo se lee:</b> Inicial + Ingresos − Devuelto − Consumo = <b>Saldo hoy</b> (lo que debería haber). &nbsp; <b>Diferencia</b> = Contado − Saldo hoy. &nbsp; En <b>Lotes</b> ves cada precio con su fecha de compra.'

  // El Excel abre HTML como hoja de cálculo con columnas separadas.
  if (paraExcel) {
    const celX = (c, f) => {
      if (c.lotes) return (f[c.campo] || []).map(l => l.t).join(' · ')
      const sub = c.sub ? f[c.sub] : null
      return (f[c.campo] == null ? '' : f[c.campo]) + (sub ? ' (' + sub + ')' : '')
    }
    const ancho = Math.max(2, ...bloques.map(b => (b.columnas || []).length))
    const secciones = bloques.map(b => {
      const cols = b.columnas || []
      const filasX = [...(b.filas || []), ...(b.total ? [b.total] : [])]
      return (b.titulo ? `<tr><td colspan="${cols.length}" style="border:none;font-weight:bold;font-size:12px">${esc(b.titulo)}</td></tr>` : '')
        + `<tr>${cols.map(c => `<th>${esc(c.titulo)}</th>`).join('')}</tr>`
        + filasX.map(f => '<tr>' + cols.map(c => `<td>${esc(celX(c, f))}</td>`).join('') + '</tr>').join('')
        + `<tr><td colspan="${cols.length}" style="border:none">&nbsp;</td></tr>`
    }).join('')
    return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8">
<style>td,th{border:0.5px solid #cccccc;padding:4px 6px;font-family:Arial;font-size:11px;mso-number-format:"\\@"}th{background:#e6edf3;font-weight:bold}</style></head><body>
<table>
<tr><td colspan="${ancho}" style="border:none;font-size:14px;font-weight:bold">${esc(opts.titulo)}</td></tr>
${(opts.meta || []).map(m => `<tr><td colspan="${ancho}" style="border:none;color:#5f7284">${esc(m.k)}: ${esc(m.v)}</td></tr>`).join('')}
<tr><td colspan="${ancho}" style="border:none">&nbsp;</td></tr>
${(opts.cards || []).map(c => `<tr><td colspan="2" style="border:none;font-weight:bold">${esc(c.k)}: ${esc(c.v)}</td></tr>`).join('')}
<tr><td colspan="${ancho}" style="border:none">&nbsp;</td></tr>
${secciones}
</table></body></html>`
  }

  const filaHTML = (cols, f, clase) => '<tr' + (clase ? ` class="${clase}"` : '') + '>' +
    cols.map(c => `<td class="${c.der ? 'r' : ''}">${celda(c, f, 'sm')}</td>`).join('') + '</tr>'
  const tabla = b => {
    const cols = b.columnas || []
    const th = cols.map(c => `<th class="${c.der ? 'r' : ''}">${esc(c.titulo)}</th>`).join('')
    const cuerpo = (b.filas || []).map(f => filaHTML(cols, f)).join('')
    const total = b.total ? filaHTML(cols, b.total, 'total') : ''
    return (b.titulo ? `<h2>${esc(b.titulo)}</h2>` : '') +
      `<table><thead><tr>${th}</tr></thead><tbody>${cuerpo}${total}</tbody></table>`
  }

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(opts.titulo)}</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  body { font-family: Arial, Helvetica, sans-serif; color:#022847; margin:24px; }
  .cab { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #022847; padding-bottom:12px; margin-bottom:16px; }
  .cab h1 { font-size:19px; font-weight:bold; margin:0; }
  .cab .sub { color:#5f7284; font-size:12px; margin-top:3px; }
  .cab .meta { color:#5f7284; font-size:11px; text-align:right; line-height:1.6; }
  .cab .meta b { color:#022847; }
  .resumen { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:22px; }
  .rcard { border:1px solid #e2e9f0; border-radius:8px; padding:12px 14px; }
  .rcard .k { font-size:9px; text-transform:uppercase; letter-spacing:.03em; color:#a7b4c1; }
  .rcard .v { font-size:20px; font-weight:bold; margin-top:3px; }
  .rcard.alerta { background:#fdf3f3; border-color:#f2d4d4; }
  .rcard.alerta .v { color:#a32d2d; }
  table { border-collapse:collapse; width:100%; font-size:10.5px; }
  th, td { border-bottom:0.5px solid #dce6ef; padding:6px 7px; vertical-align:top; }
  th { background:#f4f7fa; text-transform:uppercase; font-size:8.5px; letter-spacing:.02em; color:#5f7284; }
  .r { text-align:right; }
  .m { color:#a7b4c1; }
  .sm { font-size:8.5px; color:#a7b4c1; }
  tr.total td { border-top:1.5px solid #022847; border-bottom:none; font-weight:bold; background:#f9fbfc; padding-top:8px; }
  h2 { font-size:13px; font-weight:bold; margin:22px 0 8px; padding-left:8px; border-left:3px solid #1f7a8c; }
  .pie { font-size:10px; color:#7d8fa0; margin-top:18px; border-top:1px solid #e2e9f0; padding-top:10px; }
  @media print { body { margin:0; } }
</style></head>
<body onload="setTimeout(function(){window.print()},350)">
  <div class="cab">
    <div><h1>${esc(opts.titulo)}</h1>${subtitulo ? `<div class="sub">Finca ${esc(opts.finca)} · ${esc(subtitulo)}</div>` : `<div class="sub">Finca ${esc(opts.finca)}</div>`}</div>
    <div class="meta">${meta}</div>
  </div>
  ${cards ? `<div class="resumen">${cards}</div>` : ''}
  ${bloques.map(tabla).join('')}
  ${pie ? `<div class="pie">${pie}</div>` : ''}
</body></html>`
}

// Abre la ventana de impresión con el reporte. false si el navegador la bloquea.
export function reporteBodegaPDF(opts) {
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.write(reporteBodegaHTML(opts, false))
  w.document.close()
  return true
}

// Descarga el reporte como .xls (Excel lo abre con las columnas separadas).
export function reporteBodegaExcel(opts) {
  const blob = new Blob(['\ufeff' + reporteBodegaHTML(opts, true)], { type: 'application/vnd.ms-excel;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = nombreArchivo(opts.titulo) + '.xls'
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}
