import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, miles } from '../lib/fechas'

// Inventario de diesel · lectura. Tres vistas: cuánto hay, qué se movió
// y la subbodega de ingresos y pedidos. El registro (pedir/consumir) vive
// en el módulo Diesel.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const VERDE = '#0F6E56'
const ROJO = '#A32D2D'

const primerDelMes = () => { const h = hoyISO(); return h.slice(0, 8) + '01' }

export default function InventarioDiesel({ finca, esJefe }) {
  const [vista, setVista] = useState('hay')   // 'hay' | 'movio' | 'ingresos'
  const [desde, setDesde] = useState(primerDelMes())
  const [hasta, setHasta] = useState(hoyISO())
  const [saldos, setSaldos] = useState([])
  const [movs, setMovs] = useState([])
  const [pedidos, setPedidos] = useState([])
  const [tipos, setTipos] = useState({})
  const [cargando, setCargando] = useState(true)

  const cargar = useCallback(async () => {
    setCargando(true)
    const [{ data: tp }, { data: sal }, { data: mv }, { data: pe }] = await Promise.all([
      supabase.schema('produccion').from('diesel_tipo').select('id, nombre'),
      supabase.schema('produccion').rpc('fn_saldo_diesel', { p_finca: finca.id, p_hasta: hasta }),
      supabase.schema('produccion').rpc('fn_movimiento_diesel', { p_finca: finca.id, p_desde: desde, p_hasta: hasta }),
      supabase.schema('produccion').from('diesel_pedido')
        .select('id, tipo_id, galones, fecha, estado').eq('finca_id', finca.id)
        .gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false }),
    ])
    const tm = {}; (tp || []).forEach(t => { tm[t.id] = t.nombre }); setTipos(tm)
    setSaldos(sal || [])
    setMovs(mv || [])
    setPedidos(pe || [])
    setCargando(false)
  }, [finca.id, desde, hasta])

  useEffect(() => { cargar() }, [cargar])

  return (
    <div style={{ padding: '1.2rem 1.5rem', maxWidth: '1080px' }}>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '14px' }}>
        {[['hay', 'Cuánto hay'], ['movio', 'Qué se movió'], ['ingresos', 'Ingresos y pedidos']].map(([id, txt]) => (
          <button key={id} onClick={() => setVista(id)} style={{
            border: '0.5px solid ' + (vista === id ? '#9cc4e8' : BORDE), cursor: 'pointer', fontFamily: 'inherit',
            fontSize: '13px', padding: '7px 13px', borderRadius: '20px',
            background: vista === id ? '#E6F1FB' : 'white', color: vista === id ? AZUL : NAVY,
            fontWeight: vista === id ? 500 : 400 }}>{txt}</button>
        ))}
        {vista !== 'hay' && (
          <span style={{ display: 'flex', gap: '6px', alignItems: 'center', marginLeft: 'auto' }}>
            <input type="date" value={desde} max={hasta} onChange={e => setDesde(e.target.value)} style={inp} />
            <span style={{ color: GRIS, fontSize: '13px' }}>a</span>
            <input type="date" value={hasta} max={hoyISO()} onChange={e => setHasta(e.target.value)} style={inp} />
          </span>
        )}
      </div>

      {cargando ? (
        <Caja><div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Cargando...</div></Caja>
      ) : vista === 'hay' ? (
        <Caja>
          <Fila cabecera cols={['Diesel', 'Saldo actual (gal)']} />
          {saldos.map(s => (
            <Fila key={s.tipo_id} cols={[
              <b style={{ fontWeight: 500 }}>{s.tipo}</b>,
              <span style={{ fontWeight: 500, color: Number(s.saldo) < 0 ? ROJO : NAVY }}>{miles(Number(s.saldo))}</span>,
            ]} der={[false, true]} />
          ))}
        </Caja>
      ) : vista === 'movio' ? (
        <Caja>
          <Fila cabecera cols={['Diesel', 'Saldo ini.', 'Ingresos', 'Consumo', 'Saldo fin.']} der={[false, true, true, true, true]} />
          {movs.map(m => (
            <Fila key={m.tipo_id} der={[false, true, true, true, true]} cols={[
              <b style={{ fontWeight: 500 }}>{m.tipo}</b>,
              miles(Number(m.saldo_inicial)),
              <span style={{ color: Number(m.ingresos) ? VERDE : '#c3d0db' }}>{Number(m.ingresos) ? '+' + miles(Number(m.ingresos)) : '—'}</span>,
              <span style={{ color: Number(m.consumo) ? ROJO : '#c3d0db' }}>{Number(m.consumo) ? '−' + miles(Number(m.consumo)) : '—'}</span>,
              <span style={{ fontWeight: 500, color: Number(m.saldo_final) < 0 ? ROJO : NAVY }}>{miles(Number(m.saldo_final))}</span>,
            ]} />
          ))}
        </Caja>
      ) : (
        <Caja>
          <Fila cabecera cols={['Diesel', 'Fecha', 'Galones']} der={[false, false, true]} />
          {pedidos.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Sin ingresos en el rango.</div>
          ) : pedidos.map(p => (
            <Fila key={p.id} der={[false, false, true]} cols={[
              <b style={{ fontWeight: 500 }}>{tipos[p.tipo_id] || '—'}</b>,
              <span style={{ color: GRIS }}>{corta(p.fecha)}</span>,
              <span style={{ color: VERDE, fontWeight: 500 }}>+{miles(Number(p.galones))} gal</span>,
            ]} />
          ))}
        </Caja>
      )}
    </div>
  )
}

const inp = { padding: '7px 9px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE,
              borderRadius: '8px', background: 'white', color: NAVY }

function Caja({ children }) {
  return <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden' }}>{children}</div>
}
function Fila({ cols, der = [], cabecera }) {
  const gtc = cols.length === 2 ? '1.6fr 1fr' : cols.length === 3 ? '1.4fr 1fr 1fr' : '1.4fr 1fr 1fr 1fr 1fr'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: gtc, gap: '10px', padding: cabecera ? '11px 16px' : '13px 16px',
                  borderBottom: '0.5px solid ' + (cabecera ? BORDE : '#f1f6f9'),
                  background: cabecera ? '#f6f9fb' : 'white',
                  fontSize: cabecera ? '12px' : '14px', color: cabecera ? GRIS : NAVY, alignItems: 'center' }}>
      {cols.map((c, i) => <span key={i} style={{ textAlign: der[i] ? 'right' : 'left' }}>{c}</span>)}
    </div>
  )
}
