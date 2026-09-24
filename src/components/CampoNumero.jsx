import { useState, useEffect } from 'react'

// Campo numérico con formato automático (estilo Ecuador).
// - Los MILES se ponen solos con punto: escribes "1650" y se ve "1.650".
// - Cualquier separador que escribas (. o ,) cuenta como DECIMAL: no hace
//   falta escribir los miles. "1.5" y "1,5" son ambos 1,5.
// - value / onChange usan un texto NORMALIZADO ("1650.5"): decimal con punto
//   y sin miles, así numDec()/Number() lo parsean sin ambigüedad.

// Normalizado ("1650.5") -> texto visible ("1.650,5").
export function aTexto(norm) {
  if (norm === '' || norm === null || norm === undefined) return ''
  const s = String(norm)
  const neg = s.startsWith('-')
  const [ent0, dec] = s.replace('-', '').split('.')
  const ent = (ent0 || '').replace(/^0+(?=\d)/, '') || '0'
  const entFmt = ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return (neg ? '-' : '') + entFmt + (dec != null ? ',' + dec : '')
}

// Lo que el usuario escribe -> normalizado ("1650.5").
export function aNormal(texto, maxDec) {
  let s = String(texto).replace(/[^\d.,-]/g, '')
  const neg = s.startsWith('-')
  s = s.replace(/-/g, '')
  const i = s.search(/[.,]/)
  let ent, dec = null
  if (i >= 0) {
    ent = s.slice(0, i).replace(/[.,]/g, '')
    dec = s.slice(i + 1).replace(/[.,]/g, '')
  } else {
    ent = s.replace(/[.,]/g, '')
  }
  if (maxDec != null && dec != null) dec = dec.slice(0, maxDec)
  ent = ent.replace(/^0+(?=\d)/, '')
  if (!ent && dec == null) return neg ? '-' : ''
  const norm = (ent || '0') + (dec != null ? '.' + dec : '')
  return (neg ? '-' : '') + norm
}

export default function CampoNumero({ value, onChange, maxDec = 2, style, ...props }) {
  const [texto, setTexto] = useState(() => aTexto(value))
  useEffect(() => { setTexto(t => (aNormal(t, maxDec) === String(value ?? '') ? t : aTexto(value))) }, [value, maxDec])
  return (
    <input
      {...props}
      inputMode="decimal"
      value={texto}
      onChange={e => {
        const raw = e.target.value
        const norm = aNormal(raw, maxDec)
        // Mantener la coma final mientras escribe el decimal (ej. "1,")
        const sep = /[.,]$/.test(raw.replace(/[^\d.,]/g, '')) && !norm.includes('.')
        setTexto(aTexto(norm) + (sep ? ',' : ''))
        onChange(norm)
      }}
      style={style}
    />
  )
}
