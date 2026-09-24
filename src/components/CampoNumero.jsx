import { useState, useEffect, forwardRef } from 'react'

// Campo numérico con formato automático (estilo Ecuador).
// - Los MILES se ponen solos con punto: "1680" -> "1.680".
// - La COMA es el decimal; el PUNTO son miles. Así al borrar no se confunde.
//   maxDec = decimales permitidos (0 = sin decimales, enteros; 6 para precios).
// - value / onChange usan un texto NORMALIZADO ("1650.5"): decimal con punto y
//   sin miles, para que numDec()/Number() lo parseen sin ambigüedad.
// - pista = muestra una ayuda pequeña ". Miles · , Decimales".

export function aTexto(norm) {
  if (norm === '' || norm === null || norm === undefined) return ''
  const s = String(norm)
  const neg = s.startsWith('-')
  const [ent0, dec] = s.replace('-', '').split('.')
  const ent = (ent0 || '').replace(/^0+(?=\d)/, '') || '0'
  const entFmt = ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return (neg ? '-' : '') + entFmt + (dec != null ? ',' + dec : '')
}

export function aNormal(texto, maxDec = 2) {
  let s = String(texto).replace(/\.$/, ',').replace(/[^\d.,-]/g, '')
  const neg = s.startsWith('-')
  s = s.replace(/-/g, '')
  const ci = s.indexOf(',')
  let ent, dec = null
  if (maxDec <= 0) {
    ent = s.split(',')[0].replace(/\./g, '')      // enteros: sin decimales
  } else if (ci >= 0) {
    ent = s.slice(0, ci).replace(/\./g, '')
    dec = s.slice(ci + 1).replace(/[.,]/g, '').slice(0, maxDec)
  } else {
    ent = s.replace(/\./g, '')
  }
  ent = ent.replace(/^0+(?=\d)/, '')
  if (!ent && dec == null) return neg ? '-' : ''
  return (neg ? '-' : '') + (ent || '0') + (dec != null ? '.' + dec : '')
}

const CampoNumero = forwardRef(function CampoNumero(
  { value, onChange, maxDec = 2, pista, style, ...props }, ref) {
  const [texto, setTexto] = useState(() => aTexto(value))
  useEffect(() => {
    setTexto(t => (aNormal(t, maxDec) === String(value ?? '') ? t : aTexto(value)))
  }, [value, maxDec])
  const input = (
    <input
      {...props}
      ref={ref}
      inputMode={maxDec > 0 ? 'decimal' : 'numeric'}
      value={texto}
      onChange={e => {
        const norm = aNormal(e.target.value, maxDec)
        setTexto(aTexto(norm))
        onChange(norm)
      }}
      style={style}
    />
  )
  if (!pista) return input
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column' }}>
      {input}
      <span style={{ fontSize: '10px', color: '#a7b4c1', marginTop: '2px', whiteSpace: 'nowrap' }}>
        . Miles · , Decimales
      </span>
    </span>
  )
})

export default CampoNumero
