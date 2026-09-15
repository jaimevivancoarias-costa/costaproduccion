import { useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { LIBRAS_POR_SACO, hoyISO, corta, nombreDia, miles } from '../lib/fechas'

// Buscador "¿dónde se aplicó?" para el Registro diario. Elige un producto
// (balanceado o insumo) y muestra en qué días y piscinas de ESTA finca se
// aplicó, con la cantidad. Tocar una fila lleva a esa semana en la grilla.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'

const primerDelMes = () => { const h = hoyISO(); return h.slice(0, 8) + '01' }
const UNIDAD = { mg: 'mg', gramos: 'g', kg: 'kg', t: 't', libras: 'lb', ml: 'mL', cl: 'cL',
                 litros: 'L', m3: 'm³', gal: 'gal', floz: 'fl oz', unidad: 'u', sacos: 'sacos' }

export default function BuscadorAplicacion({ finca, ambito, opciones, onIrFecha }) {
  const [abierto, setAbierto] = useState(false)
  const [prodId, setProdId] = useState('')
  const [desde, setDesde] = useState(primerDelMes())
  const [hasta, setHasta] = useState(hoyISO())
  const [filas, setFilas] = useState([])
  const [busco, setBusco] = useState(false)
  const [cargando, setCargando] = useState(false)

  const opcion = opciones.find(o => o.id === prodId)

  const buscar = useCallback(async () => {
    if (!prodId) return
    setCargando(true); setBusco(true)
    const { data: pisc } = await supabase.schema('produccion').from('piscina')
      .select('id, nombre').eq('finca_id', finca.id)
    const nom = {}; (pisc || []).forEach(p => { nom[p.id] = p.nombre })
    const ids = (pisc || []).map(p => p.id)
    let rows = []
    if (ids.length) {
      if (ambito === 'balanceado') {
        const { data } = await supabase.schema('produccion').from('alimentacion')
          .select('fecha, libras, piscina_id').in('piscina_id', ids).eq('producto_id', prodId)
          .gte('fecha', desde).lte('fecha', hasta).order('fecha')
        rows = (data || []).map(r => ({ fecha: r.fecha, piscina: nom[r.piscina_id] || '—',
          cant: Number(r.libras) / LIBRAS_POR_SACO, unidad: 'sacos', libras: Number(r.libras) }))
      } else {
        const { data } = await supabase.schema('produccion').from('consumo_insumo')
          .select('fecha, cantidad, piscina_id').in('piscina_id', ids).eq('insumo_id', prodId)
          .gte('fecha', desde).lte('fecha', hasta).order('fecha')
        rows = (data || []).map(r => ({ fecha: r.fecha, piscina: nom[r.piscina_id] || '—',
          cant: Number(r.cantidad), unidad: opcion?.unidad || '' }))
      }
    }
    setFilas(rows); setCargando(false)
  }, [prodId, finca.id, ambito, desde, hasta, opcion])

  const total = filas.reduce((t, f) => t + f.cant, 0)
  const uni = ambito === 'balanceado' ? 'sacos' : (UNIDAD[opcion?.unidad] || opcion?.unidad || '')

  return (
    <div style={{ margin: '0 0 12px' }}>
      {!abierto ? (
        <button onClick={() => setAbierto(true)} style={{ background: 'white', border: '0.5px solid ' + BORDE,
          borderRadius: '9px', padding: '8px 14px', fontFamily: 'inherit', fontSize: '13px', color: NAVY, cursor: 'pointer' }}>
          Buscar dónde se aplicó un {ambito === 'balanceado' ? 'balanceado' : 'insumo'}
        </button>
      ) : (
        <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ padding: '13px 16px', display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: '11px', color: GRIS, marginBottom: '5px' }}>¿Dónde se aplicó?</div>
              <select value={prodId} onChange={e => setProdId(e.target.value)} style={{ ...inp, minWidth: '230px' }}>
                <option value="">Elegir {ambito === 'balanceado' ? 'balanceado' : 'insumo'}</option>
                {opciones.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: GRIS, marginBottom: '5px' }}>Desde</div>
              <input type="date" value={desde} max={hasta} onChange={e => setDesde(e.target.value)} style={inp} />
            </div>
            <div>
              <div style={{ fontSize: '11px', color: GRIS, marginBottom: '5px' }}>Hasta</div>
              <input type="date" value={hasta} max={hoyISO()} onChange={e => setHasta(e.target.value)} style={inp} />
            </div>
            <button onClick={buscar} disabled={!prodId || cargando}
              style={{ background: AZUL, color: 'white', border: '0.5px solid ' + AZUL, borderRadius: '9px',
                       padding: '9px 16px', fontFamily: 'inherit', fontSize: '13px', fontWeight: 500,
                       cursor: prodId ? 'pointer' : 'default', opacity: prodId && !cargando ? 1 : 0.5 }}>
              {cargando ? 'Buscando...' : 'Buscar'}
            </button>
            <button onClick={() => { setAbierto(false); setFilas([]); setBusco(false); setProdId('') }}
              style={{ background: 'none', border: 'none', color: GRIS, fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer' }}>Cerrar</button>
            {busco && !cargando && (
              <span style={{ marginLeft: 'auto', fontSize: '13px', color: GRIS }}>
                Total: <b style={{ color: NAVY }}>{miles(total)} {uni}</b>
              </span>
            )}
          </div>

          {busco && !cargando && (
            filas.length === 0 ? (
              <div style={{ padding: '16px', textAlign: 'center', color: GRIS, fontSize: '13px', borderTop: '0.5px solid ' + BORDE }}>
                No se aplicó en este rango.
              </div>
            ) : (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1fr', gap: '10px', padding: '10px 16px',
                              borderTop: '0.5px solid ' + BORDE, background: '#f6f9fb', fontSize: '12px', color: GRIS }}>
                  <span>Día</span><span>Piscina</span><span style={{ textAlign: 'right' }}>Cantidad</span>
                </div>
                {filas.map((f, i) => (
                  <div key={i} onClick={() => onIrFecha && onIrFecha(f.fecha)}
                    style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1fr', gap: '10px', padding: '11px 16px',
                             borderBottom: '0.5px solid #f1f6f9', fontSize: '14px', alignItems: 'center',
                             cursor: onIrFecha ? 'pointer' : 'default' }}>
                    <span>{nombreDia(f.fecha).slice(0, 3)} {corta(f.fecha)}</span>
                    <span style={{ fontWeight: 500 }}>{f.piscina}</span>
                    <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {miles(f.cant)} {ambito === 'balanceado' ? 'sacos' : (UNIDAD[f.unidad] || f.unidad || '')}
                    </span>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}

const inp = { padding: '9px 11px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE,
              borderRadius: '9px', background: 'white', color: NAVY }
