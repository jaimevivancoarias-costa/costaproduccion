import { useState, useEffect, forwardRef } from 'react'

// Campo numérico estilo Ecuador, versión amable:
// - Acepta COMA o PUNTO como decimal ("1680,5" y "1680.5" valen igual).
// - Mientras escribes NO mete miles (no salta). Al salir del campo se ve
//   bonito: "1.680,5". Al entrar, muestra la forma editable "1680,5".
// - value / onChange usan un texto NORMALIZADO ("1680.5"): decimal con punto
//   y sin miles, para que numDec()/Number() lo parseen sin ambigüedad.
// - maxDec = decimales permitidos (2 para libras, hasta 6 para precios; 0 = enteros).
// - pista = muestra una ayuda pequeña debajo.

// Texto escrito -> normalizado ("1680.5"). El ÚLTIMO separador es el decimal;
// los anteriores son miles y se quitan (así "1.680,5" y "1,680.5" dan igual).
export function aNormal(texto, maxDec = 2) {
  let s = String(texto ?? '').replace(/[^\d.,-]/g, '')
  const neg = s.trim().startsWith('-')
  s = s.replace(/-/g, '')
  const last = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'))
  let ent, dec = null
  if (maxDec <= 0) {
    ent = s.replace(/[.,]/g, '')                 // enteros
  } else if (last === -1) {
    ent = s
  } else {
    ent = s.slice(0, last).replace(/[.,]/g, '')
    dec = s.slice(last + 1).replace(/[.,]/g, '').slice(0, maxDec)
  }
  ent = ent.replace(/^0+(?=\d)/, '')
  if (!ent && dec == null) return neg ? '-' : ''
  return (neg ? '-' : '') + (ent || '0') + (dec != null ? '.' + dec : '')
}

// Normalizado -> formato bonito para mostrar en reposo: "1.680,5".
export function aTexto(norm) {
  if (norm === '' || norm === null || norm === undefined) return ''
  const s = String(norm)
  const neg = s.startsWith('-')
  const [ent0, dec] = s.replace('-', '').split('.')
  const ent = (ent0 || '0').replace(/^0+(?=\d)/, '') || '0'
  const entFmt = ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return (neg ? '-' : '') + entFmt + (dec != null ? ',' + dec : '')
}

// Normalizado -> forma editable (decimal con coma, sin miles): "1680,5".
function aEditable(norm) {
  if (norm === '' || norm === null || norm === undefined) return ''
  return String(norm).replace('.', ',')
}

const CampoNumero = forwardRef(function CampoNumero(
  { value, onChange, maxDec = 2, pista, style, onBlur, onFocus, ...props }, ref) {
  const [texto, setTexto] = useState(() => aTexto(value))
  const [foco, setFoco] = useState(false)
  // Sincroniza con el value externo solo cuando NO se está escribiendo, para
  // no pisar lo que la persona teclea.
  useEffect(() => {
    if (!foco) setTexto(aTexto(value))
  }, [value, foco])

  const input = (
    <input
      {...props}
      ref={ref}
      inputMode={maxDec > 0 ? 'decimal' : 'numeric'}
      value={texto}
      onFocus={e => { setFoco(true); setTexto(aEditable(aNormal(texto, maxDec))); onFocus?.(e) }}
      onChange={e => {
        const raw = e.target.value.replace(/[^\d.,-]/g, '')   // sin letras, sin saltar
        setTexto(raw)
        onChange(aNormal(raw, maxDec))
      }}
      onBlur={e => { setFoco(false); setTexto(aTexto(aNormal(texto, maxDec))); onBlur?.(e) }}
      style={style}
    />
  )
  if (!pista) return input
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column' }}>
      {input}
      <span style={{ fontSize: '10px', color: '#a7b4c1', marginTop: '2px', whiteSpace: 'nowrap' }}>
        Coma o punto para decimales
      </span>
    </span>
  )
})

export default CampoNumero
