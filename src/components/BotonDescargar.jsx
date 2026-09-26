import { useState, useRef, useEffect } from 'react'
import { hoyISO } from '../lib/fechas'

// Botón "Descargar" con menú desplegable: elige el rango de fechas y baja el
// reporte en PDF o Excel. Mismo control para las cuatro bodegas / ingresos.
//
// props:
//   desde, hasta, setDesde, setHasta  → estado del rango (controlado por la página)
//   onPDF, onExcel                    → qué hacer al elegir cada formato
//   conRango (default true)           → mostrar el selector de fechas dentro del menú
//                                       (en Ingresos el rango ya está afuera → false)
const NAVY = '#022847', BORDE = '#dce6ef', GRIS = '#7d8fa0', AZUL = '#0D6CB0', FAINT = '#9fb0bf'
const primerDelMes = () => { const h = hoyISO(); return h.slice(0, 8) + '01' }
const primerDelAno = () => hoyISO().slice(0, 4) + '-01-01'

export default function BotonDescargar({ desde, hasta, setDesde, setHasta, onPDF, onExcel, conRango = true }) {
  const [abierto, setAbierto] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!abierto) return
    const fuera = e => { if (ref.current && !ref.current.contains(e.target)) setAbierto(false) }
    document.addEventListener('mousedown', fuera)
    return () => document.removeEventListener('mousedown', fuera)
  }, [abierto])

  const esMes = desde === primerDelMes() && hasta === hoyISO()
  const esHoy = desde === hoyISO() && hasta === hoyISO()
  const esAno = desde === primerDelAno() && hasta === hoyISO()

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button onClick={() => setAbierto(a => !a)} style={btn}>
        Descargar <span style={{ fontSize: '11px', color: FAINT }}>▾</span>
      </button>
      {abierto && (
        <div style={menu}>
          {conRango && (
            <>
              <div style={head}>Rango del reporte</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 10px 8px' }}>
                <input type="date" value={desde} max={hasta} onChange={e => setDesde(e.target.value)} style={{ ...date, flex: 1 }} />
                <span style={{ fontSize: '13px', color: GRIS }}>a</span>
                <input type="date" value={hasta} min={desde} max={hoyISO()} onChange={e => setHasta(e.target.value)} style={{ ...date, flex: 1 }} />
              </div>
              <div style={{ display: 'flex', gap: '6px', padding: '0 10px 8px' }}>
                <Rapido on={esMes} onClick={() => { setDesde(primerDelMes()); setHasta(hoyISO()) }}>Este mes</Rapido>
                <Rapido on={esHoy} onClick={() => { setDesde(hoyISO()); setHasta(hoyISO()) }}>Hoy</Rapido>
                <Rapido on={esAno} onClick={() => { setDesde(primerDelAno()); setHasta(hoyISO()) }}>Este año</Rapido>
              </div>
              <div style={divisor} />
            </>
          )}
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

function Rapido({ children, on, onClick }) {
  return (
    <button onClick={onClick} style={{
      fontSize: '12px', color: on ? AZUL : GRIS, border: '1px solid ' + (on ? '#bcd8f2' : BORDE),
      background: on ? '#e8f1fb' : '#fff', borderRadius: '8px', padding: '4px 10px', cursor: 'pointer',
      fontFamily: 'inherit', fontWeight: on ? 600 : 400 }}>{children}</button>
  )
}

const btn = { fontFamily: 'inherit', fontSize: '13.5px', borderRadius: '10px', padding: '9px 15px', cursor: 'pointer',
              border: '1px solid ' + BORDE, background: '#fff', color: NAVY, display: 'inline-flex', alignItems: 'center', gap: '7px' }
const menu = { position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: '250px', background: '#fff',
               border: '1px solid ' + BORDE, borderRadius: '14px', boxShadow: '0 12px 34px rgba(12,39,66,.15)', padding: '8px', zIndex: 20 }
const head = { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.04em', color: FAINT, fontWeight: 600, padding: '8px 10px 6px' }
const date = { border: '1px solid ' + BORDE, background: '#fff', borderRadius: '8px', padding: '6px 8px', fontSize: '12.5px',
               color: NAVY, fontFamily: 'inherit', boxSizing: 'border-box', minWidth: 0 }
const divisor = { height: '1px', background: '#eef3f8', margin: '4px 6px 6px' }
const item = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', border: 'none',
               background: 'none', padding: '11px 10px', borderRadius: '9px', fontSize: '14px', color: NAVY, cursor: 'pointer', fontFamily: 'inherit' }
const tagItem = { color: FAINT, fontSize: '11px', fontWeight: 600, letterSpacing: '.03em' }
