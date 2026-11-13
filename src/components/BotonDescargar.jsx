import { useState, useRef, useEffect } from 'react'

// Botón "Descargar" con menú: PDF o Excel. El reporte usa AUTOMÁTICAMENTE el
// filtro de fecha que esté en pantalla (la fecha "al" en Cuánto hay, o el rango
// en Qué se movió). Ya no hay selector de fechas acá dentro.
//
// props: onPDF, onExcel → qué hacer al elegir cada formato.
// (Se aceptan props viejas desde/hasta/conRango por compatibilidad; se ignoran.)
const NAVY = '#022847', BORDE = '#dce6ef', FAINT = '#9fb0bf'

export default function BotonDescargar({ onPDF, onExcel, cargando = false }) {
  const [abierto, setAbierto] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!abierto) return
    const fuera = e => { if (ref.current && !ref.current.contains(e.target)) setAbierto(false) }
    document.addEventListener('mousedown', fuera)
    return () => document.removeEventListener('mousedown', fuera)
  }, [abierto])

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button onClick={() => !cargando && setAbierto(a => !a)} disabled={cargando}
              style={{ ...btn, opacity: cargando ? 0.55 : 1, cursor: cargando ? 'default' : 'pointer' }}>
        {cargando ? 'Preparando…' : 'Descargar'} <span style={{ fontSize: '11px', color: FAINT }}>▾</span>
      </button>
      {abierto && (
        <div style={menu}>
          <button style={item} onClick={() => { setAbierto(false); onPDF() }}
                  onMouseEnter={e => e.currentTarget.style.background = '#f4f8fc'}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}>
            Descargar PDF <span style={tagItem}>IMPRIMIR</span>
          </button>
          <button style={item} onClick={() => { setAbierto(false); onExcel() }}
                  onMouseEnter={e => e.currentTarget.style.background = '#f4f8fc'}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}>
            Descargar Excel <span style={tagItem}>EDITAR</span>
          </button>
        </div>
      )}
    </div>
  )
}

const btn = { fontFamily: 'inherit', fontSize: '13.5px', borderRadius: '10px', padding: '9px 15px', cursor: 'pointer',
              border: '1px solid ' + BORDE, background: '#fff', color: NAVY, display: 'inline-flex', alignItems: 'center', gap: '7px' }
const menu = { position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: '220px', background: '#fff',
               border: '1px solid ' + BORDE, borderRadius: '14px', boxShadow: '0 12px 34px rgba(12,39,66,.15)', padding: '8px', zIndex: 20 }
const item = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', border: 'none',
               background: 'none', padding: '11px 10px', borderRadius: '9px', fontSize: '14px', color: NAVY, cursor: 'pointer', fontFamily: 'inherit' }
const tagItem = { color: FAINT, fontSize: '11px', fontWeight: 600, letterSpacing: '.03em' }
