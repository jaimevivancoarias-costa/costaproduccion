// Controles compartidos del rediseño de inventario: pestañas con subrayado,
// control segmentado, botón discreto y estilo de select. Una sola fuente para
// que los ajustes se propaguen a Balanceado, Insumos, Diesel e Ingresos.
import { useState, useEffect, useRef } from 'react'
const NAVY = '#022847', BORDE = '#dce6ef', GRIS = '#7d8fa0', AZUL = '#0D6CB0'

// Pestaña con subrayado (Bodega / Ingresos).
export function TabU({ children, on, onClick }) {
  return <button onClick={onClick} style={{ fontFamily: 'inherit', fontSize: '14px', background: 'none', cursor: 'pointer',
    color: on ? NAVY : GRIS, padding: '0 0 9px', border: 'none', borderBottom: '2px solid ' + (on ? AZUL : 'transparent'),
    fontWeight: on ? 600 : 400 }}>{children}</button>
}

// Control segmentado (p. ej. Cuánto hay | Qué se movió). opciones = [[valor, texto], ...]
export function Seg({ opciones, valor, onCambio }) {
  return <div style={{ display: 'inline-flex', background: '#f1f5f9', border: '1px solid ' + BORDE, borderRadius: '11px', padding: '3px' }}>
    {opciones.map(([val, txt]) => {
      const on = valor === val
      return <button key={val} onClick={() => onCambio(val)} style={{ fontFamily: 'inherit', fontSize: '13.5px',
        color: on ? NAVY : GRIS, padding: '7px 15px', borderRadius: '8px', border: 'none', cursor: 'pointer',
        background: on ? '#fff' : 'transparent', fontWeight: on ? 600 : 400,
        boxShadow: on ? '0 1px 2px rgba(12,39,66,.08)' : 'none' }}>{txt}</button>
    })}
  </div>
}

// Botón discreto (sin caja), para toggles como "Sin inventario (N)".
export function GhostBtn({ children, on, onClick }) {
  return <button onClick={onClick} style={{ fontFamily: 'inherit', fontSize: '13px', color: on ? AZUL : GRIS,
    background: 'none', border: 'none', cursor: 'pointer', padding: '6px 4px', fontWeight: on ? 600 : 400 }}>{children}</button>
}

// Estilo de select/filtro del toolbar.
export const selChip = { padding: '9px 13px', fontSize: '13.5px', fontFamily: 'inherit', border: '1px solid ' + BORDE,
  borderRadius: '10px', boxSizing: 'border-box', background: 'white', color: NAVY }

// Filtro tipeable con desplegable propio (no el datalist nativo, que se ve
// oscuro y no se puede estilar). Escribes y filtra por coincidencia.
export function BuscadorFiltro({ value, onChange, opciones, placeholder, minWidth = '240px' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const q = (value || '').toLowerCase()
  const lista = opciones.filter(o => !q || String(o).toLowerCase().includes(q)).slice(0, 60)
  return (
    <div ref={ref} style={{ position: 'relative', minWidth, marginLeft: 'auto' }}>
      <input value={value} placeholder={placeholder}
        onChange={e => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        style={{ ...selChip, width: '100%', paddingRight: value ? '30px' : '13px' }} />
      {value
        ? <button onMouseDown={e => { e.preventDefault(); onChange('') }} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: GRIS, fontSize: '15px', lineHeight: 1 }}>×</button>
        : <span style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: '#9fb0bf', fontSize: '10px', pointerEvents: 'none' }}>▾</span>}
      {open && lista.length > 0 && (
        <div style={{ position: 'absolute', top: 'calc(100% + 5px)', left: 0, right: 0, background: '#fff', border: '0.5px solid ' + BORDE, borderRadius: '11px', boxShadow: '0 8px 28px rgba(2,40,71,.16)', maxHeight: '300px', overflow: 'auto', zIndex: 40, padding: '5px' }}>
          {lista.map(o => (
            <button key={o} onMouseDown={e => { e.preventDefault(); onChange(o); setOpen(false) }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 11px', border: 'none', background: value === o ? '#F4F9FF' : 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', color: NAVY, borderRadius: '8px' }}>{o}</button>
          ))}
        </div>
      )}
    </div>
  )
}
