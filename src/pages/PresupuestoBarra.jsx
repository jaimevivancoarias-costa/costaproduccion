import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, dinero, miles } from '../lib/fechas'

// Barra de presupuesto fija, arriba de cada pagina. Muestra cuanto va del
// presupuesto de INSUMOS y del de DIESEL del mes de la finca activa, uno al
// lado del otro. El jefe ve dolares (y en diesel tambien galones); el
// bodeguero ve el avance (en diesel, en galones).

const NAVY = '#022847'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const VERDE = '#0F6E56'
const AMBAR = '#BA7517'
const ROJO = '#A32D2D'

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
               'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

export default function PresupuestoBarra({ finca, esJefe, onIr, onIrDiesel }) {
  const [monto, setMonto] = useState(null)   // insumos $
  const [gasto, setGasto] = useState(0)      // insumos $ gastado
  // Diesel (global = B + Premium): presupuesto en $ y galones, y gasto.
  const [dz, setDz] = useState(null)  // { monto, gBudget, gasto, galGasto } o null si no hay ppto
  // Colapsada o no. Se recuerda entre paginas y recargas.
  const [colapsada, setColapsada] = useState(() => {
    try { return localStorage.getItem('ppto_barra') === 'colapsada' } catch { return false }
  })
  const hoy = hoyISO()
  const anio = Number(hoy.slice(0, 4))
  const mes = Number(hoy.slice(5, 7))

  useEffect(() => {
    let vivo = true
    const desde = `${anio}-${String(mes).padStart(2, '0')}-01`
    const hasta = new Date(anio, mes, 0).toISOString().slice(0, 10)
    Promise.all([
      supabase.schema('produccion').from('presupuesto_insumo')
        .select('monto').eq('finca_id', finca.id).eq('anio', anio).eq('mes', mes).maybeSingle(),
      supabase.schema('produccion').rpc('fn_gasto_insumos_mes',
        { p_finca: finca.id, p_anio: anio, p_mes: mes }),
      // Diesel: presupuesto por tipo (global = suma), gasto $ y galones del mes.
      supabase.schema('produccion').from('presupuesto_diesel')
        .select('tipo_id, monto, galones').eq('finca_id', finca.id).eq('anio', anio).eq('mes', mes).not('tipo_id', 'is', null),
      supabase.schema('produccion').rpc('fn_gasto_diesel_mes', { p_finca: finca.id, p_anio: anio, p_mes: mes }),
      supabase.schema('produccion').from('diesel_consumo')
        .select('galones').eq('finca_id', finca.id).gte('fecha', desde).lte('fecha', hasta),
      supabase.schema('produccion').from('diesel_precio')
        .select('tipo_id, finca_id, precio_galon').is('vigente_hasta', null),
    ]).then(([{ data: p }, { data: g }, { data: pd }, { data: gd }, { data: cons }, { data: pr }]) => {
      if (!vivo) return
      setMonto(p ? Number(p.monto) : null)
      setGasto(Number(g) || 0)
      // Precio vigente por tipo (finca gana a general).
      const pf = {}, pg = {}
      ;(pr || []).forEach(r => {
        if (r.finca_id === finca.id) pf[r.tipo_id] = Number(r.precio_galon)
        else if (!r.finca_id) pg[r.tipo_id] = Number(r.precio_galon)
      })
      const precioDe = tid => (pf[tid] ?? pg[tid] ?? null)
      if (pd && pd.length) {
        let m$ = 0, gB = 0, m$Completo = true, gBCompleto = true
        pd.forEach(r => {
          const price = precioDe(r.tipo_id)
          if (r.galones != null) {
            gB += Number(r.galones)
            if (price != null) m$ += Number(r.galones) * price; else m$Completo = false
          } else if (r.monto != null) {
            m$ += Number(r.monto)
            if (price != null) gB += Number(r.monto) / price; else gBCompleto = false
          }
        })
        const galGasto = (cons || []).reduce((s, r) => s + Number(r.galones || 0), 0)
        setDz({
          monto: m$Completo ? Math.round(m$ * 100) / 100 : null,
          gBudget: gBCompleto ? Math.round(gB * 100) / 100 : null,
          gasto: Number(gd) || 0, galGasto,
        })
      } else setDz(null)
    })
    return () => { vivo = false }
  }, [finca.id, anio, mes])

  function alternar() {
    const v = !colapsada
    setColapsada(v)
    try { localStorage.setItem('ppto_barra', v ? 'colapsada' : 'abierta') } catch (e) { /* sin storage */ }
  }

  // Colapsada: solo una pestañita para volver a abrirla.
  if (colapsada) {
    return (
      <div style={{ ...barra, padding: '4px 1.4rem', justifyContent: 'flex-end' }}>
        <button onClick={alternar} style={{ ...enlace, color: GRIS }}>
          Mostrar presupuesto ▾
        </button>
      </div>
    )
  }

  // Segmento de insumos.
  const insumos = monto === null ? (
    <span style={{ fontSize: '12px', color: GRIS }}>
      Sin presupuesto de insumos para {MESES[mes - 1].toLowerCase()}.
      {esJefe && <button onClick={onIr} style={enlace}>Fijarlo</button>}
    </span>
  ) : (() => {
    const pct = Math.min(100, Math.round(gasto / monto * 100))
    const color = pct >= 100 ? ROJO : pct >= 85 ? AMBAR : VERDE
    return (
      <div style={seg}>
        <span style={{ fontSize: '12px', color: NAVY, fontWeight: 500, whiteSpace: 'nowrap' }}>
          Insumos: {esJefe ? dinero(monto) : ''}
        </span>
        <div style={miniBar}><div style={{ height: '100%', width: pct + '%', background: color, borderRadius: '20px' }} /></div>
        <span style={{ fontSize: '13px', fontWeight: 600, color, fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>
        <span style={{ fontSize: '12px', color: GRIS, whiteSpace: 'nowrap' }}>
          {esJefe ? `queda ${dinero(monto - gasto)}` : (pct >= 100 ? 'pasado' : `queda ${100 - pct}%`)}
        </span>
        {onIr && <button onClick={onIr} style={enlace}>Ver</button>}
      </div>
    )
  })()

  // Segmento de diesel (global B + Premium).
  const diesel = dz === null ? (
    <span style={{ fontSize: '12px', color: GRIS }}>
      Sin presupuesto de diesel.
      {esJefe && <button onClick={onIrDiesel || onIr} style={enlace}>Fijarlo</button>}
    </span>
  ) : (() => {
    const pctRaw = dz.gBudget ? dz.galGasto / dz.gBudget : (dz.monto ? dz.gasto / dz.monto : 0)
    const pct = Math.min(100, Math.round(pctRaw * 100))
    const color = pct >= 100 ? ROJO : pct >= 85 ? AMBAR : VERDE
    const etiqueta = dz.gBudget != null ? `${miles(dz.gBudget)} gal` : (dz.monto != null ? dinero(dz.monto) : '—')
    const queda = dz.gBudget != null
      ? `queda ${miles(Math.max(dz.gBudget - dz.galGasto, 0))} gal`
      : (esJefe && dz.monto != null ? `queda ${dinero(dz.monto - dz.gasto)}` : (pct >= 100 ? 'pasado' : `queda ${100 - pct}%`))
    return (
      <div style={seg}>
        <span style={{ fontSize: '12px', color: NAVY, fontWeight: 500, whiteSpace: 'nowrap' }}>
          Diesel: {etiqueta}{esJefe && dz.gBudget != null ? ` · ${dz.monto != null ? dinero(dz.monto) : '$ —'}` : ''}
        </span>
        <div style={miniBar}><div style={{ height: '100%', width: pct + '%', background: color, borderRadius: '20px' }} /></div>
        <span style={{ fontSize: '13px', fontWeight: 600, color, fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>
        <span style={{ fontSize: '12px', color: GRIS, whiteSpace: 'nowrap' }}>{queda}</span>
        {(onIrDiesel || onIr) && <button onClick={onIrDiesel || onIr} style={enlace}>Ver</button>}
      </div>
    )
  })()

  return (
    <div style={barra}>
      {insumos}
      <span style={{ width: '1px', alignSelf: 'stretch', background: BORDE, margin: '0 2px' }} />
      {diesel}
      <button onClick={alternar} title="Ocultar" style={{ ...enlace, marginLeft: 'auto', color: GRIS }}>▴</button>
    </div>
  )
}

const barra = {
  display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap',
  padding: '8px 1.4rem', background: 'white',
  borderBottom: '0.5px solid ' + BORDE,
}
const seg = { display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap' }
const miniBar = {
  flex: '0 1 auto', width: '120px', minWidth: '60px', height: '8px',
  background: '#eef3f7', borderRadius: '20px', overflow: 'hidden',
}
const enlace = {
  border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit',
  fontSize: '12px', color: '#0D6CB0', padding: 0, marginLeft: '2px',
}
