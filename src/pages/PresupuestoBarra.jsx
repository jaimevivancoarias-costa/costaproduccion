import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, dinero } from '../lib/fechas'

// Barra de presupuesto fija, arriba de cada pagina. Muestra cuanto va
// del presupuesto de insumos del mes de la finca activa. El jefe ve los
// dolares; el bodeguero solo el total y el porcentaje.

const NAVY = '#022847'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const VERDE = '#0F6E56'
const AMBAR = '#BA7517'
const ROJO = '#A32D2D'

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
               'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

export default function PresupuestoBarra({ finca, esJefe, onIr }) {
  const [monto, setMonto] = useState(null)
  const [gasto, setGasto] = useState(0)
  const hoy = hoyISO()
  const anio = Number(hoy.slice(0, 4))
  const mes = Number(hoy.slice(5, 7))

  useEffect(() => {
    let vivo = true
    Promise.all([
      supabase.schema('produccion').from('presupuesto_insumo')
        .select('monto').eq('finca_id', finca.id).eq('anio', anio).eq('mes', mes).maybeSingle(),
      supabase.schema('produccion').rpc('fn_gasto_insumos_mes',
        { p_finca: finca.id, p_anio: anio, p_mes: mes }),
    ]).then(([{ data: p }, { data: g }]) => {
      if (!vivo) return
      setMonto(p ? Number(p.monto) : null)
      setGasto(Number(g) || 0)
    })
    return () => { vivo = false }
  }, [finca.id, anio, mes])

  if (monto === null) {
    // Sin presupuesto fijado: una linea discreta, sin barra.
    return (
      <div style={barra}>
        <span style={{ fontSize: '12px', color: GRIS }}>
          {finca.nombre}: sin presupuesto de insumos para {MESES[mes - 1].toLowerCase()}.
          {esJefe && (
            <button onClick={onIr} style={enlace}>Fijarlo</button>
          )}
        </span>
      </div>
    )
  }

  const pct = Math.min(100, Math.round(gasto / monto * 100))
  const color = pct >= 100 ? ROJO : pct >= 85 ? AMBAR : VERDE

  return (
    <div style={barra}>
      <span style={{ fontSize: '12px', color: NAVY, fontWeight: 500, whiteSpace: 'nowrap' }}>
        Presupuesto {MESES[mes - 1]}: {dinero(monto)}
      </span>
      <div style={{ flex: 1, minWidth: '80px', maxWidth: '360px', height: '8px',
                    background: '#eef3f7', borderRadius: '20px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: pct + '%', background: color, borderRadius: '20px' }} />
      </div>
      <span style={{ fontSize: '13px', fontWeight: 600, color, fontVariantNumeric: 'tabular-nums' }}>
        {pct}%
      </span>
      <span style={{ fontSize: '12px', color: GRIS, whiteSpace: 'nowrap' }}>
        {esJefe
          ? `Queda ${dinero(monto - gasto)}`
          : (pct >= 100 ? 'Presupuesto pasado' : `Queda ${100 - pct}%`)}
      </span>
      <button onClick={onIr} style={enlace}>Ver</button>
    </div>
  )
}

const barra = {
  display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
  padding: '8px 1.4rem', background: 'white',
  borderBottom: '0.5px solid ' + BORDE,
}
const enlace = {
  border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit',
  fontSize: '12px', color: '#0D6CB0', padding: 0, marginLeft: '2px',
}
