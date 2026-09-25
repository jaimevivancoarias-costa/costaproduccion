import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, miles, numDec } from '../lib/fechas'
import CampoNumero from '../components/CampoNumero'

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

export default function InventarioDiesel({ finca, esJefe, soloLectura }) {
  const [vista, setVista] = useState('hay')   // 'hay' | 'movio' | 'ingresos'
  const [desde, setDesde] = useState(primerDelMes())
  const [hasta, setHasta] = useState(hoyISO())
  const [saldos, setSaldos] = useState([])
  const [movs, setMovs] = useState([])
  const [tiposArr, setTiposArr] = useState([])
  const [primeraVez, setPrimeraVez] = useState(false)
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [conteo, setConteo] = useState(null)   // { fecha, valores:{tipo_id:gal}, inicialId? } al contar/editar
  const [inicial, setInicial] = useState(null) // inventario inicial existente { id, fecha, valores }
  const [guardando, setGuardando] = useState(false)

  const cargar = useCallback(async () => {
    setCargando(true)
    const [{ data: tp }, { data: sal }, { data: mv }, { count }] = await Promise.all([
      supabase.schema('produccion').from('diesel_tipo').select('id, nombre').eq('activo', true).order('nombre'),
      supabase.schema('produccion').rpc('fn_saldo_diesel', { p_finca: finca.id, p_hasta: hasta }),
      supabase.schema('produccion').rpc('fn_movimiento_diesel', { p_finca: finca.id, p_desde: desde, p_hasta: hasta }),
      supabase.schema('produccion').from('diesel_conteo')
        .select('id', { count: 'exact', head: true }).eq('finca_id', finca.id),
    ])
    setTiposArr(tp || [])
    setSaldos(sal || [])
    setMovs(mv || [])
    setPrimeraVez((count || 0) === 0)
    // Inventario inicial existente (para poder editarlo).
    const { data: iniC } = await supabase.schema('produccion').from('diesel_conteo')
      .select('id, fecha').eq('finca_id', finca.id).eq('es_inicial', true)
      .order('fecha', { ascending: true }).limit(1).maybeSingle()
    if (iniC) {
      const { data: lin } = await supabase.schema('produccion').from('diesel_conteo_linea')
        .select('tipo_id, galones').eq('conteo_id', iniC.id)
      const vals = {}; (lin || []).forEach(l => { vals[l.tipo_id] = String(Number(l.galones)) })
      setInicial({ id: iniC.id, fecha: iniC.fecha, valores: vals })
    } else setInicial(null)
    setCargando(false)
  }, [finca.id, desde, hasta])

  useEffect(() => { cargar() }, [cargar])

  async function guardarConteo() {
    setGuardando(true); setAviso(null)
    // Editar el inventario inicial: actualiza fecha y reemplaza sus líneas.
    if (conteo.inicialId) {
      const { error: eF } = await supabase.schema('produccion').from('diesel_conteo')
        .update({ fecha: conteo.fecha }).eq('id', conteo.inicialId)
      if (eF) { setGuardando(false); setAviso({ tipo: 'error', texto: 'No se pudo. ' + eF.message }); return }
      await supabase.schema('produccion').from('diesel_conteo_linea').delete().eq('conteo_id', conteo.inicialId)
      const lin = tiposArr.map(t => ({ conteo_id: conteo.inicialId, tipo_id: t.id, galones: numDec(conteo.valores[t.id] || '') || 0 }))
      const { error: eL } = await supabase.schema('produccion').from('diesel_conteo_linea').insert(lin)
      if (eL) { setGuardando(false); setAviso({ tipo: 'error', texto: 'No se pudieron guardar las líneas. ' + eL.message }); return }
      setGuardando(false); setConteo(null); setAviso({ tipo: 'ok', texto: 'Inventario inicial actualizado.' }); await cargar(); return
    }
    const { data: cab, error: e1 } = await supabase.schema('produccion').from('diesel_conteo')
      .insert({ finca_id: finca.id, fecha: conteo.fecha, es_inicial: primeraVez }).select('id').single()
    if (e1) { setGuardando(false); setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + e1.message }); return }
    const lineas = tiposArr.map(t => ({ conteo_id: cab.id, tipo_id: t.id, galones: numDec(conteo.valores[t.id] || '') || 0 }))
    const { error: e2 } = await supabase.schema('produccion').from('diesel_conteo_linea').insert(lineas)
    if (e2) { setGuardando(false); setAviso({ tipo: 'error', texto: 'No se pudieron guardar las líneas. ' + e2.message }); return }
    setGuardando(false); setConteo(null)
    setAviso({ tipo: 'ok', texto: primeraVez ? 'Inventario inicial cargado.' : 'Conteo guardado.' })
    await cargar()
  }

  return (
    <div style={{ padding: '1.2rem 1.5rem', maxWidth: '1080px' }}>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '14px' }}>
        {[['hay', 'Cuánto hay'], ['movio', 'Qué se movió']].map(([id, txt]) => (
          <button key={id} onClick={() => setVista(id)} style={{
            border: '0.5px solid ' + (vista === id ? '#9cc4e8' : BORDE), cursor: 'pointer', fontFamily: 'inherit',
            fontSize: '13px', padding: '7px 13px', borderRadius: '20px',
            background: vista === id ? '#E6F1FB' : 'white', color: vista === id ? AZUL : NAVY,
            fontWeight: vista === id ? 500 : 400 }}>{txt}</button>
        ))}
        {vista !== 'hay' && (
          <span style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <input type="date" value={desde} max={hasta} onChange={e => setDesde(e.target.value)} style={inp} />
            <span style={{ color: GRIS, fontSize: '13px' }}>a</span>
            <input type="date" value={hasta} max={hoyISO()} onChange={e => setHasta(e.target.value)} style={inp} />
          </span>
        )}
        {!soloLectura && !conteo && (
          <button onClick={() => setConteo({ fecha: hoyISO(), valores: {} })}
            style={{ marginLeft: 'auto', background: AZUL, color: 'white', border: '0.5px solid ' + AZUL,
                     borderRadius: '9px', padding: '8px 15px', fontFamily: 'inherit', fontSize: '13px', fontWeight: 500, cursor: 'pointer' }}>
            {primeraVez ? 'Cargar inventario inicial' : 'Contar la bodega'}
          </button>
        )}
        {!soloLectura && !conteo && inicial && (
          <button onClick={() => setConteo({ fecha: inicial.fecha, valores: { ...inicial.valores }, inicialId: inicial.id })}
            style={{ background: 'white', color: NAVY, border: '0.5px solid ' + BORDE, borderRadius: '9px',
                     padding: '8px 15px', fontFamily: 'inherit', fontSize: '13px', fontWeight: 500, cursor: 'pointer' }}>
            Editar inventario inicial
          </button>
        )}
      </div>

      {aviso && (
        <div style={{ borderRadius: '10px', padding: '11px 13px', fontSize: '13px', marginBottom: '12px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE',
                      color: aviso.tipo === 'error' ? ROJO : VERDE }}>{aviso.texto}</div>
      )}

      {conteo && (
        <div style={{ marginBottom: '14px' }}>
          <Caja>
            <div style={{ padding: '14px 16px' }}>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
                <span style={{ fontSize: '14px', fontWeight: 500 }}>{conteo.inicialId ? 'Editar inventario inicial' : primeraVez ? 'Inventario inicial de diesel' : 'Contar la bodega'}</span>
                <span style={{ fontSize: '12px', color: GRIS }}>Fecha</span>
                <input type="date" value={conteo.fecha} max={hoyISO()}
                  onChange={e => setConteo(c => ({ ...c, fecha: e.target.value }))} style={inp} />
              </div>
              {tiposArr.map(t => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        gap: '10px', padding: '9px 0', borderBottom: '0.5px solid #f1f6f9', fontSize: '14px' }}>
                  <span style={{ fontWeight: 500 }}>{t.nombre}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <CampoNumero maxDec={2} placeholder="0" value={conteo.valores[t.id] || ''}
                      onChange={v => setConteo(c => ({ ...c, valores: { ...c.valores, [t.id]: v } }))}
                      style={{ ...inp, width: '100px', textAlign: 'right' }} />
                    <span style={{ color: GRIS, fontSize: '13px' }}>gal</span>
                  </span>
                </div>
              ))}
              <div style={{ display: 'flex', gap: '9px', marginTop: '12px' }}>
                <button onClick={guardarConteo} disabled={guardando}
                  style={{ background: AZUL, color: 'white', border: '0.5px solid ' + AZUL, borderRadius: '9px',
                           padding: '9px 15px', fontFamily: 'inherit', fontSize: '13px', fontWeight: 500,
                           cursor: guardando ? 'default' : 'pointer', opacity: guardando ? 0.6 : 1 }}>
                  {guardando ? 'Guardando...' : conteo.inicialId ? 'Guardar cambios' : primeraVez ? 'Cargar inventario' : 'Guardar conteo'}
                </button>
                <button onClick={() => setConteo(null)}
                  style={{ background: 'white', color: NAVY, border: '0.5px solid ' + BORDE, borderRadius: '9px',
                           padding: '9px 15px', fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer' }}>Cancelar</button>
              </div>
            </div>
          </Caja>
        </div>
      )}

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
      ) : (
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
