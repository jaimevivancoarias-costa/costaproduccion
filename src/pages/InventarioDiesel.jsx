import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, miles, numDec } from '../lib/fechas'
import CampoNumero from '../components/CampoNumero'
import { reporteBodegaPDF, reporteBodegaExcel } from '../lib/exportar'

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
  const [conteoRango, setConteoRango] = useState({})  // tipo_id -> {galones, fecha, esInicial} del conteo en el rango (para el reporte)

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

    // Conteos del rango (para el reporte): el último por tipo con su fecha.
    const { data: cts } = await supabase.schema('produccion').from('diesel_conteo')
      .select('fecha, es_inicial, diesel_conteo_linea(tipo_id, galones)')
      .eq('finca_id', finca.id).gte('fecha', desde).lte('fecha', hasta)
      .order('fecha', { ascending: true })
    const cr = {}
    ;(cts || []).forEach(c => (c.diesel_conteo_linea || []).forEach(l => {
      cr[l.tipo_id] = { galones: Number(l.galones), fecha: c.fecha, esInicial: !!c.es_inicial }
    }))
    setConteoRango(cr)
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

  // Reporte de bodega de gasolina (galones). Junta el saldo actual y los
  // movimientos del rango, con el conteo físico si lo hay. Un mismo botón
  // para Excel y PDF.
  function construirReporte() {
    const gal = v => miles(Number(v) || 0)
    const mas = v => { const x = Number(v) || 0; return x > 0.001 ? '+' + gal(x) : '—' }
    const menos = v => { const x = Number(v) || 0; return x > 0.001 ? '−' + gal(x) : '—' }
    const conSigno = v => { const x = Number(v) || 0; if (Math.abs(x) < 0.001) return '0'; return (x > 0 ? '+' : '−') + gal(Math.abs(x)) }
    const movById = {}; (movs || []).forEach(m => { movById[m.tipo_id] = m })
    const sById = {}; (saldos || []).forEach(s => { sById[s.tipo_id] = s })
    const ids = [...new Set([...(saldos || []).map(s => s.tipo_id), ...(movs || []).map(m => m.tipo_id)])]

    let totIni = 0, totIng = 0, totCon = 0, totSaldo = 0, totDif = 0, nDesc = 0
    const filasRep = []
    ids.forEach(id => {
      const s = sById[id]; const m = movById[id]
      const nombre = (s && s.tipo) || (m && m.tipo) || ''
      const saldoHoy = s ? Number(s.saldo) : (m ? Number(m.saldo_final) : 0)
      const ct = conteoRango[id]
      const contado = ct ? Number(ct.galones) : null
      const teorico = m ? Number(m.saldo_final) : saldoHoy
      const dif = contado != null ? contado - teorico : null
      totIni += Number(m?.saldo_inicial) || 0; totIng += Number(m?.ingresos) || 0
      totCon += Number(m?.consumo) || 0; totSaldo += saldoHoy
      if (dif != null) { totDif += dif; if (Math.abs(dif) > 0.001) nDesc++ }
      filasRep.push({
        nombre, inicial: gal(m?.saldo_inicial || 0), ingresos: mas(m?.ingresos), consumo: menos(m?.consumo),
        saldoHoy: gal(saldoHoy),
        contado: contado != null ? gal(contado) : '',
        contadoInfo: ct?.fecha ? corta(ct.fecha) + (ct.esInicial ? ' (inicial)' : '') : '',
        dif: dif != null ? conSigno(dif) : '',
      })
    })
    filasRep.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
    const hayConteo = filasRep.some(f => f.contado !== '')

    const columnas = [
      { titulo: 'Diesel', campo: 'nombre' },
      { titulo: 'Inicial', der: true, campo: 'inicial' },
      { titulo: 'Ingresos', der: true, campo: 'ingresos' },
      { titulo: 'Consumo', der: true, campo: 'consumo' },
      { titulo: 'Saldo hoy (gal)', der: true, campo: 'saldoHoy' },
      ...(hayConteo ? [
        { titulo: 'Contado', der: true, campo: 'contado', sub: 'contadoInfo' },
        { titulo: 'Dif.', der: true, campo: 'dif' },
      ] : []),
    ]
    const total = {
      nombre: 'Total', inicial: gal(totIni), ingresos: '+' + gal(totIng), consumo: totCon ? '−' + gal(totCon) : '—',
      saldoHoy: gal(totSaldo), contado: '', contadoInfo: '',
      dif: Math.abs(totDif) < 0.001 ? '0' : (totDif > 0 ? '+' : '−') + gal(Math.abs(totDif)),
    }
    const cards = [
      { k: 'Saldo hoy (gal)', v: gal(totSaldo) },
      { k: 'Ingresos del rango', v: gal(totIng) },
      { k: 'Consumo del rango', v: gal(totCon) },
      hayConteo
        ? { k: 'Con descuadre', v: '' + nDesc, alerta: nDesc > 0 }
        : { k: 'Tipos de diesel', v: '' + filasRep.length },
    ]
    return {
      titulo: 'Reporte de Bodega — Gasolina', finca: finca.nombre, categoria: 'Gasolina',
      meta: [
        { k: 'Rango', v: `${corta(desde)} – ${corta(hasta)}` },
        { k: 'Impreso', v: corta(hoyISO()) },
      ],
      cards, columnas, filas: filasRep, total,
    }
  }
  function exportarExcel() { reporteBodegaExcel(construirReporte()) }
  function exportarPDF() {
    if (!reporteBodegaPDF(construirReporte())) setAviso({ tipo: 'error', texto: 'El navegador bloqueó la ventana. Permite las ventanas emergentes para exportar a PDF.' })
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
        {vista !== 'hay' ? (
          <span style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <input type="date" value={desde} max={hasta} onChange={e => setDesde(e.target.value)} style={inp} />
            <span style={{ color: GRIS, fontSize: '13px' }}>a</span>
            <input type="date" value={hasta} max={hoyISO()} onChange={e => setHasta(e.target.value)} style={inp} />
          </span>
        ) : esJefe && (
          <span title="Rango de fechas que usa el reporte" style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <span style={{ color: GRIS, fontSize: '13px' }}>reporte:</span>
            <input type="date" value={desde} max={hasta} onChange={e => setDesde(e.target.value)} style={inp} />
            <span style={{ color: GRIS, fontSize: '13px' }}>a</span>
            <input type="date" value={hasta} max={hoyISO()} onChange={e => setHasta(e.target.value)} style={inp} />
          </span>
        )}
        {vista === 'hay' && esJefe && (
          <span style={{ display: 'flex', gap: '6px' }}>
            <button onClick={exportarExcel} title="Reporte completo de bodega en Excel" style={expBtn}>Excel</button>
            <button onClick={exportarPDF} title="Reporte completo de bodega en PDF" style={expBtn}>PDF</button>
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
const expBtn = { background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '9px', padding: '6px 11px',
                 fontSize: '12px', fontFamily: 'inherit', color: NAVY, cursor: 'pointer' }

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
