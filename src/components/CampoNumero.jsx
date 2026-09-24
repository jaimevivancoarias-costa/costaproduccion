import { useState, useEffect } from 'react'

// Campo numérico con formato automático (estilo Ecuador).
// - Los MILES se ponen solos con punto: escribes "1650" y se ve "1.650".
// - La COMA es el decimal; el PUNTO son miles. Así al borrar no se confunde.
//   "1.111" = 1111 · "1,5" = 1,5 · maxDec configurable (precios con 5–6).
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

// Lo que el usuario escribe -> normalizado ("1650.5"). La COMA es el decimal;
// el PUNTO son miles (se quitan). Un punto al final se toma como decimal en
// progreso (se vuelve coma), para poder escribir "1." y seguir con decimales.
export function aNormal(texto, maxDec = 2) {
  let s = String(texto).replace(/\.$/, ',').replace(/[^\d.,-]/g, '')
  const neg = s.startsWith('-')
  s = s.replace(/-/g, '')
  const ci = s.indexOf(',')
  let ent, dec = null
  if (ci >= 0) {
    ent = s.slice(0, ci).replace(/\./g, '')
    dec = s.slice(ci + 1).replace(/[.,]/g, '').slice(0, maxDec)
  } else {
    ent = s.replace(/\./g, '')
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
