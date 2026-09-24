import { useState, useEffect } from 'react'

// Campo numérico con formato automático (estilo Ecuador).
// - Los MILES se ponen solos con punto: escribes "1650" y se ve "1.650".
// - Un separador cuenta como DECIMAL solo si le siguen 1–2 cifras (o es coma);
//   si le siguen 3, son miles. Así "1.5" y "1,5" = 1,5, pero "1.111" = 1111.
// - value / onChange usan un texto NORMALIZADO ("1650.5"): decimal con punto y
//   sin miles, así numDec()/Number() lo parsean sin ambigüedad.

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
export function aNormal(texto, maxDec = 2) {
  let s = String(texto).replace(/[^\d.,-]/g, '')
  const neg = s.startsWith('-')
  s = s.replace(/-/g, '')
  const lastSep = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'))
  let ent, dec = null
  if (lastSep >= 0) {
    const sepChar = s[lastSep]
    const after = s.slice(lastSep + 1).replace(/[.,]/g, '')
    // Es decimal si es coma, o si al punto le siguen pocas cifras (no miles).
    const esDecimal = sepChar === ',' || after.length <= maxDec
    if (esDecimal) {
      ent = s.slice(0, lastSep).replace(/[.,]/g, '')
      dec = after.slice(0, maxDec)
    } else {
      ent = s.replace(/[.,]/g, '')
    }
  } else {
    ent = s.replace(/[.,]/g, '')
  }
  ent = ent.replace(/^0+(?=\d)/, '')
  if (!ent && dec == null) return neg ? '-' : ''
  return (neg ? '-' : '') + (ent || '0') + (dec != null ? '.' + dec : '')
}

export default function CampoNumero({ value, onChange, maxDec = 2, style, ...props }) {
  const [texto, setTexto] = useState(() => aTexto(value))
  // Sincroniza si el valor cambia por fuera (reset, precarga), sin pisar lo que
  // se está escribiendo (si el texto actual ya representa ese valor, se deja).
  useEffect(() => {
    setTexto(t => (aNormal(t, maxDec) === String(value ?? '') ? t : aTexto(value)))
  }, [value, maxDec])
  return (
    <input
      {...props}
      inputMode="decimal"
      value={texto}
      onChange={e => {
        const norm = aNormal(e.target.value, maxDec)
        setTexto(aTexto(norm))
        onChange(norm)
      }}
      style={style}
    />
  )
}
