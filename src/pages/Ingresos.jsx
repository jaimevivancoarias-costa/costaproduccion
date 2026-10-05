import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, num, numDec, miles, dinero, dineroExacto, sumarDias } from '../lib/fechas'
import CampoNumero from '../components/CampoNumero'
import { reporteBodegaPDF, reporteBodegaExcel } from '../lib/exportar'
import BotonDescargar from '../components/BotonDescargar'
import { Seg, GhostBtn } from '../components/controles'

const cap1 = s => { const t = String(s || ''); return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : t }

const PLAZOS = [0, 30, 60, 90, 120]
const PLAZO_LBL = { 0: 'Contado', 30: '30 días', 60: '60 días', 90: '90 días', 120: '120 días' }

// Ingresos y pedidos de insumos · modulo Produccion
//
// Ingreso: producto que entro a bodega. Suma al saldo.
// Pedido: lo que se solicito. NO suma al saldo, solo se sigue.
//
// Los dos comparten la forma: una cabecera y varias lineas, porque una
// guia o un pedido traen varios insumos.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const VERDE = '#0F6E56'
const AMBAR = '#854F0B'

const UNIDAD = {
  sacos: 'sacos', litros: 'litros', ml: 'mL', gramos: 'gramos',
  libras: 'libras', kg: 'kilos', unidad: 'unidades',
  tambor: 'tambores', botella: 'botellas',
}

const primerDelMes = () => { const h = hoyISO(); return h.slice(0, 8) + '01' }

export default function Ingresos({ finca, esJefe, onCorreccion, onCambio }) {
  const [modo, setModo] = useState('ingresos')   // 'ingresos' | 'pedidos'
  const [insumos, setInsumos] = useState([])
  const [ingresos, setIngresos] = useState([])
  const [pedidos, setPedidos] = useState([])
  const [devoluciones, setDevoluciones] = useState([])
  const [pendientes, setPendientes] = useState({})   // pedidoId -> lineas pendientes
  const [solicitudes, setSolicitudes] = useState([]) // correcciones de ingresos
  const [userId, setUserId] = useState(null)
  const [usuarios, setUsuarios] = useState({})   // id -> nombre
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [nuevo, setNuevo] = useState(null)   // 'ingreso' | 'pedido' | null
  const [editando, setEditando] = useState(null)   // id del ingreso en edición/solicitud
  const [editandoDev, setEditandoDev] = useState(null)   // id de la devolución en edición
  const [desde, setDesde] = useState(primerDelMes())
  const [hasta, setHasta] = useState(hoyISO())
  const [filtroIns, setFiltroIns] = useState('')   // filtro por insumo (nombre)

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    try {
      const [{ data: ins }, { data: g }, { data: pd }, { data: pend }, { data: sol }, { data: auth }] = await Promise.all([
        supabase.schema('produccion').from('insumo')
          .select('id, nombre, unidad, unidad_compra, factor').eq('activo', true).order('nombre')
          .then(async r => {
            const { data: ov } = await supabase.schema('produccion').from('insumo_finca')
              .select('insumo_id, unidad, unidad_compra, factor').eq('finca_id', finca.id)
            const o = {}; (ov || []).forEach(x => { o[x.insumo_id] = x })
            return { data: (r.data || []).map(i => o[i.id]
              ? { ...i, unidad: o[i.id].unidad, unidad_compra: o[i.id].unidad_compra, factor: Number(o[i.id].factor) }
              : i) }
          }),
        supabase.schema('produccion').from('ingreso_insumo')
          .select('id, fecha, numero_guia, proveedor, observacion, creado_por, creado_en, ingreso_insumo_linea(insumo_id, cantidad, plazo, costo_unitario)')
          .eq('finca_id', finca.id).gte('fecha', desde).lte('fecha', hasta)
          .order('fecha', { ascending: false }).limit(200),
        supabase.schema('produccion').from('pedido_insumo')
          .select('id, fecha, fecha_esperada, proveedor, estado, creado_por, creado_en, pedido_insumo_linea(insumo_id, cantidad)')
          .eq('finca_id', finca.id).order('fecha', { ascending: false }).limit(40),
        supabase.schema('produccion').from('vw_pedido_pendiente')
          .select('pedido_id, insumo_id, insumo, unidad, pedida, recibida, pendiente')
          .eq('finca_id', finca.id),
        supabase.schema('produccion').from('solicitud_correccion')
          .select('id, registro_id, valor_anterior, valor_propuesto, motivo, estado, solicitado_por, solicitado_en')
          .eq('finca_id', finca.id).eq('tabla', 'ingreso_insumo')
          .order('solicitado_en', { ascending: false }).limit(50),
        supabase.auth.getUser(),
      ])
      setInsumos(ins || [])
      setIngresos(g || [])
      setPedidos(pd || [])
      const { data: dev } = await supabase.schema('produccion').from('devolucion_insumo')
        .select('id, fecha, insumo_id, cantidad, motivo, creado_por, creado_en')
        .eq('finca_id', finca.id).gte('fecha', desde).lte('fecha', hasta)
        .order('fecha', { ascending: false }).limit(200)
      setDevoluciones(dev || [])
      // Mapa id -> nombre para mostrar "quién" registró cada cosa.
      const { data: us } = await supabase.schema('produccion').from('vw_usuario').select('id, nombre')
      const um = {}; (us || []).forEach(u => { um[u.id] = u.nombre })
      setUsuarios(um)
      setSolicitudes(sol || [])
      setUserId(auth?.user?.id || null)
      const pp = {}
      ;(pend || []).forEach(r => { (pp[r.pedido_id] = pp[r.pedido_id] || []).push(r) })
      setPendientes(pp)
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally {
      setCargando(false)
    }
  }, [finca.id, desde, hasta])

  useEffect(() => { cargar() }, [cargar])

  const nombreInsumo = id => insumos.find(x => x.id === id)?.nombre || ''
  // "Registrado por Nombre · dd/mm/aa hh:mm" — quién y cuándo.
  const autoria = row => {
    const n = row?.creado_por ? usuarios[row.creado_por] : null
    const cuando = row?.creado_en
      ? new Date(row.creado_en).toLocaleString('es-EC', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
      : ''
    if (!n && !cuando) return null
    return (n ? 'Registrado por ' + n : 'Registrado') + (cuando ? ' · ' + cuando : '')
  }
  // Los ingresos y pedidos se llevan en unidad de COMPRA (tambor,
  // botella, saco), que es como llega el producto a bodega.
  const unidadInsumo = id => {
    const i = insumos.find(x => x.id === id)
    return i ? (UNIDAD[i.unidad_compra] || cap1(i.unidad_compra)) : ''
  }

  // Filtro por insumo (por nombre). Afecta la lista y el reporte.
  const ingresosF = ingresos.filter(g => !filtroIns || (g.ingreso_insumo_linea || []).some(l => nombreInsumo(l.insumo_id) === filtroIns))
  const devolucionesF = devoluciones.filter(d => !filtroIns || nombreInsumo(d.insumo_id) === filtroIns)

  // Reporte de Ingresos + Devoluciones (del rango). Dos secciones, cantidades
  // en unidad de compra. Un mismo botón para Excel y PDF.
  function construirReporte() {
    const quien = id => (id ? usuarios[id] : '') || ''
    // Ingresos: una fila por insumo de cada guía; los datos de la guía salen
    // una sola vez (las filas de continuación los dejan en blanco).
    const filasIng = []
    let nItems = 0
    const provs = new Set()
    ;[...ingresosF].sort((a, b) => (a.fecha < b.fecha ? -1 : 1)).forEach(g => {
      if (g.proveedor) provs.add(g.proveedor)
      const lineas = g.ingreso_insumo_linea || []
      lineas.forEach((l, i) => {
        nItems++
        filasIng.push({
          fecha: i === 0 ? corta(g.fecha) : '',
          guia: i === 0 ? (g.numero_guia || 'Sin guía') : '',
          proveedor: i === 0 ? (g.proveedor || '') : '',
          insumo: nombreInsumo(l.insumo_id),
          cantidad: `${miles(numDec(l.cantidad))} ${unidadInsumo(l.insumo_id)}`,
          plazo: l.plazo != null ? (PLAZO_LBL[l.plazo] || '') : '',
          registro: i === 0 ? quien(g.creado_por) : '',
        })
      })
    })
    const filasDev = [...devolucionesF].sort((a, b) => (a.fecha < b.fecha ? -1 : 1)).map(d => ({
      fecha: corta(d.fecha), insumo: nombreInsumo(d.insumo_id),
      cantidad: `${miles(numDec(d.cantidad))} ${unidadInsumo(d.insumo_id)}`,
      motivo: d.motivo || '', registro: quien(d.creado_por),
    }))

    const bloques = [
      {
        titulo: 'Ingresos a bodega',
        columnas: [
          { titulo: 'Fecha', campo: 'fecha' },
          { titulo: 'Guía', campo: 'guia' },
          { titulo: 'Proveedor', campo: 'proveedor' },
          { titulo: 'Insumo', campo: 'insumo' },
          { titulo: 'Cantidad', der: true, campo: 'cantidad' },
          { titulo: 'Plazo', campo: 'plazo' },
          { titulo: 'Registró', campo: 'registro' },
        ],
        filas: filasIng,
        total: { fecha: '', guia: '', proveedor: '', insumo: 'Total ingresos', cantidad: `${nItems} ítems`, plazo: '', registro: '' },
      },
      {
        titulo: 'Devoluciones',
        columnas: [
          { titulo: 'Fecha', campo: 'fecha' },
          { titulo: 'Insumo', campo: 'insumo' },
          { titulo: 'Cantidad', der: true, campo: 'cantidad' },
          { titulo: 'Motivo', campo: 'motivo' },
          { titulo: 'Registró', campo: 'registro' },
        ],
        filas: filasDev,
        total: { fecha: '', insumo: 'Total devoluciones', cantidad: `${filasDev.length}`, motivo: '', registro: '' },
      },
    ]
    const cards = [
      { k: 'Ingresos (guías)', v: '' + ingresosF.length },
      { k: 'Ítems ingresados', v: '' + nItems },
      { k: 'Devoluciones', v: '' + devolucionesF.length },
      { k: 'Proveedores', v: '' + provs.size },
    ]
    return {
      titulo: 'Ingresos y Devoluciones — Insumos', finca: finca.nombre, subtitulo: '',
      meta: [
        { k: 'Rango', v: `${corta(desde)} – ${corta(hasta)}` },
        { k: 'Impreso', v: corta(hoyISO()) },
      ],
      cards, bloques,
      pie: 'Los ingresos se listan una fila por insumo de cada guía. Las cantidades están en unidad de compra (Funda, Envase, Saco).',
    }
  }
  function exportarExcel() { reporteBodegaExcel(construirReporte()) }
  function exportarPDF() {
    if (!reporteBodegaPDF(construirReporte())) setAviso({ tipo: 'error', texto: 'El navegador bloqueó la ventana. Permite las ventanas emergentes para exportar a PDF.' })
  }

  return (
    <div style={{ padding: '1.4rem 1.5rem', maxWidth: '1180px' }}>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <Seg valor={modo} onCambio={m => { setModo(m); setNuevo(null) }}
             opciones={[['ingresos', 'Ingresos a bodega'], ['devoluciones', 'Devoluciones']]} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '9px', alignItems: 'center' }}>
          {!cargando && (ingresos.length > 0 || devoluciones.length > 0) && (
            <BotonDescargar desde={desde} hasta={hasta} setDesde={setDesde} setHasta={setHasta} onPDF={exportarPDF} onExcel={exportarExcel} conRango={false} />
          )}
          {!nuevo && (
            <Btn primario onClick={() => setNuevo(modo === 'ingresos' ? 'ingreso' : 'devolucion')}>
              {modo === 'ingresos' ? 'Registrar ingreso' : 'Registrar devolución'}
            </Btn>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <span style={{ color: GRIS, fontSize: '13px' }}>Del</span>
        <input type="date" value={desde} max={hasta} onChange={e => setDesde(e.target.value)} style={{ ...entrada, padding: '7px 10px' }} />
        <span style={{ color: GRIS, fontSize: '13px' }}>a</span>
        <input type="date" value={hasta} min={desde} max={hoyISO()} onChange={e => setHasta(e.target.value)} style={{ ...entrada, padding: '7px 10px' }} />
        <GhostBtn on={desde === hoyISO() && hasta === hoyISO()} onClick={() => { setDesde(hoyISO()); setHasta(hoyISO()) }}>Hoy</GhostBtn>
        <GhostBtn on={desde === primerDelMes() && hasta === hoyISO()} onClick={() => { setDesde(primerDelMes()); setHasta(hoyISO()) }}>Este mes</GhostBtn>
        <select value={filtroIns} onChange={e => setFiltroIns(e.target.value)}
                style={{ ...entrada, marginLeft: 'auto', minWidth: '210px', padding: '9px 12px' }}>
          <option value="">Todos los insumos</option>
          {[...insumos].map(i => i.nombre).sort().map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      {aviso && (
        <div style={{ borderRadius: '10px', padding: '12px 14px', fontSize: '13px', marginBottom: '12px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE',
                      color: aviso.tipo === 'error' ? '#8A2F2E' : VERDE }}>{aviso.texto}</div>
      )}

      {nuevo && (
        <Formulario
          tipo={nuevo} finca={finca} insumos={insumos} esJefe={esJefe}
          pedidosAbiertos={pedidos.filter(p => p.estado === 'abierto')}
          pendientes={pendientes}
          onCancelar={() => setNuevo(null)}
          onDevolucion={rows => setDevoluciones(d => [...rows, ...d])}
          onGuardado={async () => {
            const t = nuevo
            setNuevo(null)
            // La devolución ya se agregó de forma optimista a la lista; no
            // recargamos para evitar pisarla si el servidor tiene lag.
            if (t !== 'devolucion') await cargar()
            if (onCambio && t !== 'pedido') onCambio()   // ingresos y devoluciones mueven el saldo
            setAviso({ tipo: 'ok', texto: t === 'ingreso' ? 'Ingreso registrado.' : t === 'pedido' ? 'Pedido registrado.' : 'Devolución registrada.' }) }}
          setAviso={setAviso}
        />
      )}

      {modo === 'ingresos' && !cargando && solicitudes.some(s => s.estado === 'pendiente') && (
        <PanelSolicitudes
          solicitudes={solicitudes.filter(s => s.estado === 'pendiente')}
          esJefe={esJefe} nombreInsumo={nombreInsumo} unidadInsumo={unidadInsumo}
          onResolver={resolver} />
      )}

      {cargando ? (
        <Vacio>Cargando...</Vacio>

      ) : modo === 'ingresos' ? (
        !ingresosF.length ? (
          <Vacio>{filtroIns ? 'No hay ingresos de ese insumo en el rango.' : 'Todavía no hay ingresos registrados. Cuando llegue producto a bodega, regístralo aquí con su guía.'}</Vacio>
        ) : (<>{ingresosF.map(g => {
          const solPend = solicitudes.find(s => s.registro_id === g.id && s.estado === 'pendiente')
          return (
          <Tarjeta key={g.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 500 }}>{corta(g.fecha)}</div>
                <div style={{ fontSize: '12px', color: GRIS }}>
                  {g.numero_guia ? `Guía ${g.numero_guia}` : 'Sin guía'}
                  {g.proveedor ? ` · ${g.proveedor}` : ''}
                </div>
                {autoria(g) && <div style={{ fontSize: '11px', color: '#9fb0bf', marginTop: '2px' }}>{autoria(g)}</div>}
              </div>
              <div style={{ display: 'flex', gap: '7px', alignItems: 'flex-start' }}>
                {solPend ? (
                  <span style={{ fontSize: '11px', fontWeight: 500, padding: '4px 11px', borderRadius: '20px',
                                 background: '#FAEEDA', color: AMBAR, height: 'fit-content' }}>
                    Corrección pendiente
                  </span>
                ) : editando === g.id ? null : esJefe ? (
                  <>
                    <MiniBtn onClick={() => setEditando(g.id)}>Editar</MiniBtn>
                    <MiniBtn rojo onClick={() => borrarIngresoJefe(g)}>Borrar</MiniBtn>
                  </>
                ) : (
                  <MiniBtn onClick={() => setEditando(g.id)}>Solicitar corrección</MiniBtn>
                )}
              </div>
            </div>
            <Lineas>
              {(g.ingreso_insumo_linea || []).map((l, i) => {
                const uc = unidadInsumo(l.insumo_id)
                const q = numDec(l.cantidad)
                const pu = Number(l.costo_unitario) || 0
                return (
                <Linea key={i} nombre={nombreInsumo(l.insumo_id)}
                       cantidad={`+${miles(q)} ${uc}`}
                       sub={esJefe && pu > 0 ? `${dinero(pu)}/${uc}${l.plazo != null ? ` · ${PLAZO_LBL[l.plazo]}` : ''}` : (l.plazo != null ? PLAZO_LBL[l.plazo] : null)} />
              )})}
            </Lineas>
            {g.observacion && <Obs>{g.observacion}</Obs>}
            {editando === g.id && (
              <EditorIngreso
                g={g} insumos={insumos} esJefe={esJefe} finca={finca} userId={userId}
                onHecho={async (msg) => { setEditando(null); await cargar(); setAviso({ tipo: 'ok', texto: msg }) }}
                onCancelar={() => setEditando(null)} setAviso={setAviso} />
            )}
          </Tarjeta>
          )
        })}
        {(() => {
          // Resumen por insumo: cuántos ingresos, cuánta cantidad y cuánto valor.
          const porIns = {}
          ingresosF.forEach(g => (g.ingreso_insumo_linea || []).forEach(l => {
            const k = l.insumo_id
            if (!porIns[k]) porIns[k] = { n: 0, qty: 0, valor: 0 }
            porIns[k].n += 1
            porIns[k].qty += numDec(l.cantidad)
            porIns[k].valor += numDec(l.cantidad) * (Number(l.costo_unitario) || 0)
          }))
          const filas = Object.entries(porIns).sort((a, b) => b[1].n - a[1].n)
          if (!filas.length) return null
          const totalVal = filas.reduce((s, [, v]) => s + v.valor, 0)
          const gtc = esJefe ? '1fr 100px 120px 120px' : '1fr 110px 120px'
          const cab = { fontSize: '10px', color: '#9fb0bf', textTransform: 'uppercase', letterSpacing: '.02em', textAlign: 'center' }
          return (
            <div style={{ marginTop: '14px', background: '#fff', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '14px 16px' }}>
              <div style={{ fontSize: '12px', color: GRIS, textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: '10px' }}>Resumen por insumo</div>
              <div style={{ display: 'grid', gridTemplateColumns: gtc, gap: '12px', paddingBottom: '6px', borderBottom: '0.5px solid ' + BORDE }}>
                <span style={{ ...cab, textAlign: 'left' }}>Insumo</span>
                <span style={cab}>Ingresos</span>
                <span style={{ ...cab, textAlign: 'right' }}>Cantidad</span>
                {esJefe && <span style={{ ...cab, textAlign: 'right' }}>Valor</span>}
              </div>
              {filas.map(([k, v]) => (
                <div key={k} style={{ display: 'grid', gridTemplateColumns: gtc, gap: '12px', padding: '7px 0', borderBottom: '0.5px solid #f1f6f9', fontSize: '13px', alignItems: 'baseline' }}>
                  <span>{nombreInsumo(k)}</span>
                  <span style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}><b>{v.n}</b></span>
                  <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: GRIS }}>{miles(Math.round(v.qty * 100) / 100)} {unidadInsumo(k)}</span>
                  {esJefe && <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dinero(v.valor)}</span>}
                </div>
              ))}
              {esJefe && (
                <div style={{ display: 'grid', gridTemplateColumns: gtc, gap: '12px', padding: '9px 0 0', fontSize: '13px', fontWeight: 700 }}>
                  <span>Total</span><span /><span />
                  <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dinero(totalVal)}</span>
                </div>
              )}
            </div>
          )
        })()}
        </>)

      ) : modo === 'pedidos' ? (
        !pedidos.length ? (
          <Vacio>Todavía no hay pedidos. Un pedido no suma al saldo: solo sirve para seguir lo que pediste y ver cuánto ha llegado.</Vacio>
        ) : pedidos.map(p => {
          const pend = pendientes[p.id] || []
          const todoLlego = pend.every(x => Number(x.pendiente) <= 0.0001)
          return (
            <Tarjeta key={p.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 500 }}>{corta(p.fecha)}</div>
                  <div style={{ fontSize: '12px', color: GRIS }}>
                    {p.proveedor || 'Sin proveedor'}
                    {p.fecha_esperada ? ` · esperado ${corta(p.fecha_esperada)}` : ''}
                  </div>
                  {autoria(p) && <div style={{ fontSize: '11px', color: '#9fb0bf', marginTop: '2px' }}>{autoria(p)}</div>}
                </div>
                <Estado estado={p.estado} completo={todoLlego} />
              </div>
              <Lineas>
                {(p.pedido_insumo_linea || []).map((l, i) => {
                  const seg = pend.find(x => x.insumo_id === l.insumo_id)
                  const falta = seg ? Number(seg.pendiente) : Number(l.cantidad)
                  return (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto',
                          gap: '12px', alignItems: 'center', padding: '5px 0', fontSize: '13px' }}>
                      <span>{nombreInsumo(l.insumo_id)}</span>
                      <span style={{ color: GRIS, fontVariantNumeric: 'tabular-nums' }}>
                        {miles(numDec(l.cantidad))} {unidadInsumo(l.insumo_id)}
                      </span>
                      <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: '120px',
                                     textAlign: 'right', color: falta <= 0.0001 ? VERDE : AMBAR }}>
                        {falta <= 0.0001 ? 'llegó todo' : `faltan ${miles(falta)}`}
                      </span>
                    </div>
                  )
                })}
              </Lineas>
              {p.estado === 'abierto' && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
                  <button onClick={() => cerrarPedido(p.id)} style={{
                    background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                    fontSize: '12px', color: GRIS }}>
                    Marcar como cerrado
                  </button>
                </div>
              )}
            </Tarjeta>
          )
        })
      ) : (
        !devolucionesF.length ? (
          <Vacio>{filtroIns ? 'No hay devoluciones de ese insumo en el rango.' : 'Todavía no hay devoluciones. Una devolución a CostaMarket resta del saldo de la bodega.'}</Vacio>
        ) : devolucionesF.map(d => (
          <Tarjeta key={d.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 500 }}>{corta(d.fecha)}</div>
                <div style={{ fontSize: '13px', color: NAVY, marginTop: '3px' }}>
                  {nombreInsumo(d.insumo_id)}: <b style={{ fontWeight: 600 }}>−{miles(numDec(d.cantidad))}</b> {unidadInsumo(d.insumo_id)}
                </div>
                {d.motivo && <div style={{ fontSize: '12px', color: GRIS, fontStyle: 'italic', marginTop: '2px' }}>{d.motivo}</div>}
                {autoria(d) && <div style={{ fontSize: '11px', color: '#9fb0bf', marginTop: '2px' }}>{autoria(d)}</div>}
              </div>
              {esJefe && editandoDev !== d.id && (
                <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap' }}>
                  <MiniBtn onClick={() => setEditandoDev(d.id)}>Editar</MiniBtn>
                  <MiniBtn rojo onClick={() => borrarDevolucion(d)}>Borrar</MiniBtn>
                </div>
              )}
            </div>
            {esJefe && editandoDev === d.id && (
              <EditorDevolucion
                d={d} unidad={unidadInsumo(d.insumo_id)}
                onGuardado={(nueva) => {
                  setDevoluciones(prev => prev.map(x => x.id === d.id ? { ...x, ...nueva } : x))
                  setEditandoDev(null)
                  if (onCambio) onCambio()
                  setAviso({ tipo: 'ok', texto: 'Devolución actualizada.' })
                }}
                onCancelar={() => setEditandoDev(null)} setAviso={setAviso} />
            )}
          </Tarjeta>
        ))
      )}
    </div>
  )

  async function borrarDevolucion(d) {
    if (!window.confirm('¿Borrar esta devolución? Vuelve a sumar al saldo de la bodega.')) return
    const { error } = await supabase.schema('produccion').from('devolucion_insumo').delete().eq('id', d.id)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo borrar. ' + error.message }); return }
    // Se quita de la lista al instante (no recargamos para evitar el lag de
    // lectura del servidor, que la volvería a mostrar).
    setDevoluciones(prev => prev.filter(x => x.id !== d.id))
    if (onCambio) onCambio()
    setAviso({ tipo: 'ok', texto: 'Devolución borrada.' })
  }

  async function borrarIngresoJefe(g) {
    if (!window.confirm('¿Borrar este ingreso? Se resta de la bodega.')) return
    const { error } = await supabase.schema('produccion').from('ingreso_insumo').delete().eq('id', g.id)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo borrar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Ingreso borrado.' }); await cargar()
    if (onCambio) onCambio()
  }

  async function resolver(sol, aprobar) {
    const { error } = await supabase.schema('produccion')
      .rpc('fn_resolver_correccion', { p_id: sol.id, p_aprobar: aprobar })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo resolver. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: aprobar ? 'Corrección aplicada.' : 'Solicitud rechazada.' })
    await cargar()
    if (onCorreccion) onCorreccion()
  }

  async function cerrarPedido(id) {
    if (!window.confirm('¿Dar el pedido por cerrado? Se deja de seguir aunque no haya llegado todo.')) return
    const { error } = await supabase.schema('produccion').from('pedido_insumo')
      .update({ estado: 'recibido' }).eq('id', id)
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    await cargar()
  }
}

// ---------------------------------------------------------------------
// Formulario de ingreso o de pedido: cabecera + lineas
// ---------------------------------------------------------------------
function Formulario({ tipo, finca, insumos, esJefe, pedidosAbiertos, pendientes, onCancelar, onGuardado, onDevolucion, setAviso }) {
  const esIngreso = tipo === 'ingreso'
  const esDevolucion = tipo === 'devolucion'
  const esPedido = tipo === 'pedido'
  const [fecha, setFecha] = useState(hoyISO())
  const [guia, setGuia] = useState('')
  const [proveedor, setProveedor] = useState('')
  const [esperada, setEsperada] = useState('')
  const [pedidoId, setPedidoId] = useState('')
  const [obs, setObs] = useState('')
  const [lineas, setLineas] = useState([{ insumoId: '', cantidad: '', unidad: '' }])
  const [guardando, setGuardando] = useState(false)
  // Precio del catálogo (solo jefe, solo ingreso) + revisión al guardar.
  const [precioCat, setPrecioCat] = useState({})   // insumoId -> {plazo: precio por conteo}
  const [plazoAct, setPlazoAct] = useState({})      // insumoId -> plazo que rige en catálogo
  const [revisando, setRevisando] = useState(false) // pop-up de revisión de precios
  const [rev, setRev] = useState([])                 // [{insumoId, qCompra, plazo, precio, scope}]
  const verPrecio = esJefe && esIngreso
  const setRevLinea = (i, campo) => setRev(rs => rs.map((r, j) => j === i ? { ...r, ...campo } : r))
  // Al pulsar "Revisar y guardar": arma la revisión con el plazo que rige y el
  // precio del catálogo de cada insumo.
  function abrirRevision() {
    setRev(validas.map(l => {
      const pa = plazoAct[l.insumoId] != null ? plazoAct[l.insumoId] : 0
      return { insumoId: l.insumoId, qCompra: cantidadEnCompra(l), plazo: pa, precio: fmtPre(precioCompraCat(l.insumoId, pa)), scope: 'solo' }
    }))
    setRevisando(true)
  }

  // Precio por unidad de COMPRA del catálogo, para un insumo y plazo.
  function precioCompraCat(insumoId, pz) {
    const ins = insumos.find(x => x.id === insumoId)
    const factor = Number(ins?.factor) || 1
    const m = precioCat[insumoId]
    if (!m) return null
    const p = m[pz] != null ? m[pz] : m[0]
    return p != null ? p * factor : null
  }
  const fmtPre = n => (n != null ? String(n) : '')

  useEffect(() => {
    if (!esIngreso) return
    let vivo = true
    ;(async () => {
      const [{ data: pr }, { data: pz }] = await Promise.all([
        esJefe
          ? supabase.schema('produccion').from('precio_insumo')
              .select('insumo_id, finca_id, plazo, precio_unitario')
              .or(`finca_id.is.null,finca_id.eq.${finca.id}`).is('vigente_hasta', null)
          : Promise.resolve({ data: [] }),
        supabase.schema('produccion').from('plazo_insumo')
          .select('insumo_id, plazo').eq('finca_id', finca.id).is('vigente_hasta', null),
      ])
      if (!vivo) return
      const prop = {}, gen = {}
      ;(pr || []).forEach(x => { const mm = x.finca_id ? prop : gen; (mm[x.insumo_id] = mm[x.insumo_id] || {})[Number(x.plazo)] = Number(x.precio_unitario) })
      const cat = {}
      ;[...new Set([...Object.keys(prop), ...Object.keys(gen)])].forEach(id => { cat[id] = { ...(gen[id] || {}), ...(prop[id] || {}) } })
      setPrecioCat(cat)
      const pa = {}; (pz || []).forEach(x => { pa[x.insumo_id] = Number(x.plazo) })
      setPlazoAct(pa)
    })()
    return () => { vivo = false }
  }, [finca.id, esIngreso, esJefe])

  const UNI = { sacos: 'sacos', litros: 'litros', ml: 'mL', gramos: 'gramos',
                libras: 'libras', kg: 'kilos', unidad: 'unidades',
                tambor: 'tambores', botella: 'botellas' }

  function setLinea(i, campo, valor) {
    setLineas(ls => ls.map((l, j) => j === i ? { ...l, [campo]: valor } : l))
  }
  const agregarLinea = () => setLineas(ls => [...ls, { insumoId: '', cantidad: '', unidad: '' }])
  const quitarLinea = i => setLineas(ls => ls.filter((_, j) => j !== i))

  const validas = lineas.filter(l => l.insumoId && numDec(l.cantidad))

  // Convierte la cantidad digitada a la unidad de compra (como se guarda).
  function cantidadEnCompra(l) {
    const ins = insumos.find(x => x.id === l.insumoId)
    const factor = Number(ins?.factor) || 1
    const uCompra = ins?.unidad_compra || ins?.unidad
    const uElegida = l.unidad || uCompra
    const q = numDec(l.cantidad || '')
    return uElegida === uCompra ? q : q / factor
  }

  async function guardar() {
    if (!validas.length) { setAviso({ tipo: 'error', texto: 'Agrega al menos una línea.' }); return }
    setGuardando(true)
    try {
      if (esIngreso) {
        const { data: g, error } = await supabase.schema('produccion').from('ingreso_insumo')
          .insert({ finca_id: finca.id, fecha, numero_guia: guia || null,
                    proveedor: proveedor || null, observacion: obs || null })
          .select('id').single()
        if (error) throw error
        const lineasIns = esJefe
          ? rev.map(r => {
              // Jefe/contadora: plazo + precio desde la revisión.
              const fila = { ingreso_id: g.id, insumo_id: r.insumoId, cantidad: r.qCompra, plazo: r.plazo }
              const pu = numDec(r.precio)
              if (pu > 0) fila.costo_unitario = pu
              return fila
            })
          : validas.map(l => {
              // Bodeguero: el plazo y el precio que rigen en el catálogo.
              const fila = { ingreso_id: g.id, insumo_id: l.insumoId, cantidad: cantidadEnCompra(l) }
              const pa = plazoAct[l.insumoId]
              if (pa != null) fila.plazo = pa
              const pc = precioCompraCat(l.insumoId, pa != null ? pa : 0)
              if (pc != null) fila.costo_unitario = pc
              return fila
            })
        const { error: e2 } = await supabase.schema('produccion').from('ingreso_insumo_linea')
          .insert(lineasIns)
        if (e2) throw e2
        // Alcance "De ahora en adelante": actualiza el catálogo por finca y plazo.
        if (esJefe) {
          for (const r of rev) {
            const pu = numDec(r.precio)
            if (r.scope !== 'adelante' || !(pu > 0)) continue
            const ins = insumos.find(x => x.id === r.insumoId)
            const factor = Number(ins?.factor) || 1
            const stored = pu / factor  // el catálogo guarda por unidad de conteo
            await supabase.schema('produccion').from('precio_insumo')
              .delete().eq('insumo_id', r.insumoId).eq('finca_id', finca.id).eq('plazo', r.plazo).gte('vigente_desde', fecha)
            await supabase.schema('produccion').from('precio_insumo')
              .update({ vigente_hasta: sumarDias(fecha, -1) })
              .eq('insumo_id', r.insumoId).eq('finca_id', finca.id).eq('plazo', r.plazo).is('vigente_hasta', null).lt('vigente_desde', fecha)
            const { error: e3 } = await supabase.schema('produccion').from('precio_insumo')
              .insert({ insumo_id: r.insumoId, finca_id: finca.id, plazo: r.plazo, precio_unitario: stored, vigente_desde: fecha })
            if (e3) throw e3
          }
        }
        setRevisando(false)
      } else if (esDevolucion) {
        const { data: nuevas, error } = await supabase.schema('produccion').from('devolucion_insumo')
          .insert(validas.map(l => ({ finca_id: finca.id, fecha, insumo_id: l.insumoId,
                                      cantidad: cantidadEnCompra(l), motivo: obs || null })))
          .select('id, fecha, insumo_id, cantidad, motivo, creado_por, creado_en')
        if (error) throw error
        if (onDevolucion && nuevas) onDevolucion(nuevas)
      } else {
        const { data: p, error } = await supabase.schema('produccion').from('pedido_insumo')
          .insert({ finca_id: finca.id, fecha, fecha_esperada: esperada || null,
                    proveedor: proveedor || null })
          .select('id').single()
        if (error) throw error
        const { error: e2 } = await supabase.schema('produccion').from('pedido_insumo_linea')
          .insert(validas.map(l => ({ pedido_id: p.id, insumo_id: l.insumoId, cantidad: cantidadEnCompra(l) })))
        if (e2) throw e2
      }
      await onGuardado()
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + (err.message || '') })
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div style={{ background: 'white', border: '0.5px solid ' + AZUL, borderRadius: '12px',
                  padding: '18px', marginBottom: '14px' }}>
      <h3 style={{ fontSize: '16px', fontWeight: 500, margin: '0 0 14px' }}>
        {esIngreso ? 'Registrar ingreso a bodega'
          : esDevolucion ? 'Registrar devolución a CostaMarket'
          : 'Registrar pedido'}
      </h3>

      <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <Campo label="Fecha">
          <input type="date" value={fecha} max={hoyISO()}
                 onChange={e => setFecha(e.target.value)} style={entrada} />
        </Campo>
        {esIngreso ? (
          <Campo label="Número de guía">
            <input value={guia} placeholder="Opcional" onChange={e => setGuia(e.target.value)} style={entrada} />
          </Campo>
        ) : esDevolucion ? (
          <Campo label="Motivo / observación">
            <input value={obs} placeholder="Por qué se devuelve"
                   onChange={e => setObs(e.target.value)} style={{ ...entrada, width: '260px' }} />
          </Campo>
        ) : (
          <Campo label="Fecha esperada">
            <input type="date" value={esperada} min={fecha}
                   onChange={e => setEsperada(e.target.value)} style={entrada} />
          </Campo>
        )}
        {!esDevolucion && (
          <Campo label="Proveedor">
            <input value={proveedor} placeholder="Opcional"
                   onChange={e => setProveedor(e.target.value)} style={entrada} />
          </Campo>
        )}
      </div>

      <div style={{ fontSize: '12px', color: GRIS, marginBottom: '7px' }}>Insumos</div>
      {lineas.map((l, i) => {
        const ins = insumos.find(x => x.id === l.insumoId)
        const uCompra = ins?.unidad_compra || ins?.unidad
        const uCons = ins?.unidad
        const factor = Number(ins?.factor) || 1
        // Unidades en que puede cargar: la de compra (saco) y la de conteo (kg), si difieren.
        const unidades = ins ? [...new Set([uCompra, uCons])] : []
        const uElegida = l.unidad || uCompra
        const enCompra = ins && numDec(l.cantidad) ? cantidadEnCompra(l) : null
        const mostrarEquiv = ins && uElegida !== uCompra && enCompra != null
        return (
          <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '7px', flexWrap: 'wrap' }}>
            <select value={l.insumoId} onChange={e => { setLinea(i, 'insumoId', e.target.value); setLinea(i, 'unidad', '') }}
              style={{ ...entrada, flex: 1, minWidth: '180px' }}>
              <option value="">Elegir insumo</option>
              {insumos.map(x => <option key={x.id} value={x.id}>{x.nombre}</option>)}
            </select>
            <CampoNumero maxDec={2} value={l.cantidad}
              placeholder="Cantidad"
              onChange={v => setLinea(i, 'cantidad', v)}
              style={{ ...entrada, width: '110px' }} />
            {unidades.length > 1 ? (
              <select value={uElegida} onChange={e => setLinea(i, 'unidad', e.target.value)} style={{ ...entrada, width: '120px' }}>
                {unidades.map(u => <option key={u} value={u}>{UNI[u] || cap1(u)}</option>)}
              </select>
            ) : ins ? (
              <span style={{ fontSize: '13px', color: GRIS, width: '120px' }}>{UNI[uCompra] || cap1(uCompra)}</span>
            ) : null}
            {mostrarEquiv && (
              <span style={{ fontSize: '11px', color: GRIS }}>= {miles(Math.round(enCompra * 100) / 100)} {UNI[uCompra] || cap1(uCompra)}</span>
            )}
            {lineas.length > 1 && (
              <button onClick={() => quitarLinea(i)} style={{ border: 'none', background: 'none',
                cursor: 'pointer', color: '#c3d0db', fontSize: '18px', lineHeight: 1 }}>×</button>
            )}
          </div>
        )
      })}
      <button onClick={agregarLinea} style={{ border: 'none', background: 'none', cursor: 'pointer',
        fontFamily: 'inherit', fontSize: '13px', color: AZUL, padding: '4px 0' }}>
        + Otra línea
      </button>

      <div style={{ display: 'flex', gap: '9px', justifyContent: 'flex-end', marginTop: '14px' }}>
        <Btn onClick={onCancelar}>Cancelar</Btn>
        <Btn primario onClick={() => { if (verPrecio) abrirRevision(); else guardar() }} disabled={guardando || !validas.length}>
          {guardando ? 'Guardando...'
            : esIngreso ? (verPrecio ? 'Revisar y guardar' : 'Guardar ingreso')
            : esDevolucion ? 'Guardar devolución'
            : 'Guardar pedido'}
        </Btn>
      </div>

      {revisando && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,40,71,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '18px', zIndex: 50 }}
             onClick={e => { if (e.target === e.currentTarget) setRevisando(false) }}>
          <div style={{ background: '#fff', borderRadius: '14px', padding: '18px 20px', maxWidth: '680px', width: '100%', maxHeight: '88vh', overflow: 'auto', boxShadow: '0 10px 40px rgba(2,40,71,.25)' }}>
            <div style={{ fontSize: '15px', fontWeight: 600 }}>Revisa los precios antes de guardar</div>
            <div style={{ fontSize: '12px', color: GRIS, marginBottom: '14px' }}>Cada insumo trae el precio del catálogo. Cambia el plazo o el precio si hace falta.</div>
            {rev.map((r, i) => {
              const ins = insumos.find(x => x.id === r.insumoId)
              const uc = ins?.unidad_compra || ins?.unidad
              const catP = precioCompraCat(r.insumoId, r.plazo)
              const cambiado = catP == null || Math.abs(numDec(r.precio) - catP) > 0.0001
              return (
                <div key={i} style={{ padding: '11px 0', borderTop: i ? '0.5px solid #eef3f7' : 'none' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1.1fr', gap: '10px', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600, fontSize: '13px' }}>{ins?.nombre} <span style={{ color: GRIS, fontWeight: 400 }}>· {miles(Math.round(r.qCompra * 100) / 100)} {UNI[uc] || cap1(uc)}</span></span>
                    <select value={r.plazo} onChange={e => setRevLinea(i, { plazo: Number(e.target.value), precio: fmtPre(precioCompraCat(r.insumoId, Number(e.target.value))) })}
                      style={{ ...entrada, padding: '6px 8px', fontSize: '12.5px' }}>
                      {[0, 30, 60, 90].map(p => <option key={p} value={p}>{PLAZO_LBL[p]}</option>)}
                    </select>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'flex-end' }}>
                      <span style={{ fontSize: '12px', color: GRIS }}>$</span>
                      <CampoNumero maxDec={6} value={r.precio ?? ''} placeholder="precio" onChange={v => setRevLinea(i, { precio: v })}
                        style={{ ...entrada, width: '96px', borderColor: '#9cc4e8' }} />
                      <span style={{ fontSize: '11px', color: GRIS }}>/{UNI[uc] || cap1(uc)}</span>
                    </div>
                  </div>
                  <div style={{ fontSize: '11.5px', marginTop: '5px', textAlign: 'right' }}>
                    {catP == null ? <span style={{ color: '#BA7517' }}>sin precio en catálogo</span>
                      : !cambiado ? <span style={{ color: '#0f6e56' }}>= catálogo</span>
                      : <span style={{ color: '#9A6A00' }}>catálogo {dineroExacto(catP)}</span>}
                  </div>
                  {cambiado && catP != null && (
                    <div style={{ marginTop: '7px', background: '#FFF8EC', border: '0.5px solid #ecd9b3', borderRadius: '9px', padding: '8px 11px', fontSize: '12px' }}>
                      Cambiaste el precio. ¿Cómo lo aplico?
                      <span style={{ display: 'inline-flex', gap: '14px', marginLeft: '8px' }}>
                        <label style={{ cursor: 'pointer' }}><input type="radio" checked={r.scope === 'solo'} onChange={() => setRevLinea(i, { scope: 'solo' })} /> Solo este ingreso</label>
                        <label style={{ cursor: 'pointer' }}><input type="radio" checked={r.scope === 'adelante'} onChange={() => setRevLinea(i, { scope: 'adelante' })} /> De ahora en adelante en {String(finca.nombre)}</label>
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
            <div style={{ display: 'flex', gap: '9px', justifyContent: 'flex-end', marginTop: '16px' }}>
              <Btn onClick={() => setRevisando(false)}>Volver</Btn>
              <Btn primario onClick={guardar} disabled={guardando}>{guardando ? 'Guardando...' : 'Guardar ingreso'}</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Panel de solicitudes de correccion (pendientes)
function PanelSolicitudes({ solicitudes, esJefe, nombreInsumo, unidadInsumo, onResolver }) {
  return (
    <div style={{ background: '#FBF5E9', border: '0.5px solid #ecd9b3', borderRadius: '12px',
                  padding: '14px 16px', marginBottom: '14px' }}>
      <div style={{ fontWeight: 500 }}>
        {esJefe ? 'Correcciones por autorizar' : 'Correcciones pendientes'} ({solicitudes.length})
      </div>
      {solicitudes.map(s => {
        const vp = s.valor_propuesto || {}
        return (
          <div key={s.id} style={{ borderTop: '0.5px solid #ecd9b3', paddingTop: '10px', marginTop: '10px' }}>
            <div style={{ fontSize: '13px', fontWeight: 500 }}>
              {vp.borrar ? 'Pide borrar el ingreso' : 'Propone cambios en el ingreso'}
            </div>
            {!vp.borrar && (
              <div style={{ fontSize: '12px', color: GRIS, marginTop: '4px' }}>
                {corta(vp.fecha)} · {vp.numero_guia ? ('Guía ' + vp.numero_guia) : 'Sin guía'}
                {vp.proveedor ? (' · ' + vp.proveedor) : ''}
                <div style={{ marginTop: '2px' }}>
                  {(vp.lineas || []).map((l, i) => (
                    <span key={i}>{nombreInsumo(l.insumo_id)}: {miles(l.cantidad)} {unidadInsumo(l.insumo_id)}
                      {i < vp.lineas.length - 1 ? '  ·  ' : ''}</span>
                  ))}
                </div>
              </div>
            )}
            <div style={{ fontSize: '12px', color: GRIS, fontStyle: 'italic', marginTop: '4px' }}>
              Motivo: {s.motivo || '—'}
            </div>
            {esJefe && (
              <div style={{ display: 'flex', gap: '8px', marginTop: '9px' }}>
                <MiniBtn onClick={() => onResolver(s, true)}>Aprobar</MiniBtn>
                <MiniBtn rojo onClick={() => onResolver(s, false)}>Rechazar</MiniBtn>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// Editor de un ingreso: el jefe guarda directo, el bodeguero envía solicitud.
function EditorIngreso({ g, insumos, esJefe, finca, userId, onHecho, onCancelar, setAviso }) {
  const [fecha, setFecha] = useState(g.fecha)
  const [guia, setGuia] = useState(g.numero_guia || '')
  const [proveedor, setProveedor] = useState(g.proveedor || '')
  const [lineas, setLineas] = useState((g.ingreso_insumo_linea || []).map(l => ({ insumoId: l.insumo_id, cantidad: String(l.cantidad), precio: l.costo_unitario != null ? String(l.costo_unitario) : '' })))
  const [motivo, setMotivo] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [plazo, setPlazo] = useState(() => { const p = (g.ingreso_insumo_linea || [])[0]?.plazo; return p != null ? Number(p) : 0 })
  const [precioCat, setPrecioCat] = useState({})
  const [plazoAct, setPlazoAct] = useState({})
  const UNI = { sacos: 'sacos', litros: 'litros', ml: 'mL', gramos: 'gramos', libras: 'libras', kg: 'kilos',
                unidad: 'unidades', tambor: 'tambores', botella: 'botellas' }
  const setLinea = (i, c, v) => setLineas(ls => ls.map((l, j) => j === i ? { ...l, [c]: v } : l))
  const validas = lineas.filter(l => l.insumoId && numDec(l.cantidad))

  function precioCompraCat(insumoId, pz) {
    const ins = insumos.find(x => x.id === insumoId)
    const factor = Number(ins?.factor) || 1
    const m = precioCat[insumoId]
    if (!m) return null
    const p = m[pz] != null ? m[pz] : m[0]
    return p != null ? p * factor : null
  }
  const fmtPre = n => (n != null ? String(n) : '')

  useEffect(() => {
    if (!esJefe) return
    let vivo = true
    ;(async () => {
      const [{ data: pr }, { data: pz }] = await Promise.all([
        supabase.schema('produccion').from('precio_insumo')
          .select('insumo_id, finca_id, plazo, precio_unitario')
          .or(`finca_id.is.null,finca_id.eq.${finca.id}`).is('vigente_hasta', null),
        supabase.schema('produccion').from('plazo_insumo')
          .select('insumo_id, plazo').eq('finca_id', finca.id).is('vigente_hasta', null),
      ])
      if (!vivo) return
      const prop = {}, gen = {}
      ;(pr || []).forEach(x => { const mm = x.finca_id ? prop : gen; (mm[x.insumo_id] = mm[x.insumo_id] || {})[Number(x.plazo)] = Number(x.precio_unitario) })
      const cat = {}
      ;[...new Set([...Object.keys(prop), ...Object.keys(gen)])].forEach(id => { cat[id] = { ...(gen[id] || {}), ...(prop[id] || {}) } })
      setPrecioCat(cat)
      const pa = {}; (pz || []).forEach(x => { pa[x.insumo_id] = Number(x.plazo) })
      setPlazoAct(pa)
    })()
    return () => { vivo = false }
  }, [finca.id, esJefe])

  async function guardarJefe() {
    if (!validas.length) { setAviso({ tipo: 'error', texto: 'Deja al menos una línea.' }); return }
    setEnviando(true)
    const { error } = await supabase.schema('produccion').from('ingreso_insumo')
      .update({ fecha, numero_guia: guia || null, proveedor: proveedor || null }).eq('id', g.id)
    if (error) { setEnviando(false); setAviso({ tipo: 'error', texto: error.message }); return }
    await supabase.schema('produccion').from('ingreso_insumo_linea').delete().eq('ingreso_id', g.id)
    const { error: e2 } = await supabase.schema('produccion').from('ingreso_insumo_linea')
      .insert(validas.map(l => {
        const fila = { ingreso_id: g.id, insumo_id: l.insumoId, cantidad: numDec(l.cantidad), plazo }
        const pu = numDec(l.precio)
        if (pu > 0) fila.costo_unitario = pu
        return fila
      }))
    setEnviando(false)
    if (e2) { setAviso({ tipo: 'error', texto: e2.message }); return }
    onHecho('Ingreso actualizado.')
  }

  async function enviarSolicitud(borrar) {
    if (!motivo.trim()) { setAviso({ tipo: 'error', texto: 'Escribe el motivo de la corrección.' }); return }
    if (!borrar && !validas.length) { setAviso({ tipo: 'error', texto: 'Deja al menos una línea.' }); return }
    setEnviando(true)
    const anterior = { fecha: g.fecha, numero_guia: g.numero_guia, proveedor: g.proveedor,
      lineas: (g.ingreso_insumo_linea || []).map(l => ({ insumo_id: l.insumo_id, cantidad: Number(l.cantidad) })) }
    const propuesto = borrar ? { borrar: true }
      : { borrar: false, fecha, numero_guia: guia || null, proveedor: proveedor || null,
          lineas: validas.map(l => ({ insumo_id: l.insumoId, cantidad: numDec(l.cantidad) })) }
    const { error } = await supabase.schema('produccion').from('solicitud_correccion').insert({
      finca_id: finca.id, tabla: 'ingreso_insumo', registro_id: g.id,
      valor_anterior: anterior, valor_propuesto: propuesto, motivo: motivo.trim(), solicitado_por: userId })
    setEnviando(false)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo enviar. ' + error.message }); return }
    onHecho(borrar ? 'Solicitud de borrado enviada. El jefe la revisará.' : 'Solicitud enviada. El jefe la revisará.')
  }

  return (
    <div style={{ background: '#f6f9fb', borderRadius: '10px', padding: '14px', marginTop: '11px' }}>
      <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '10px' }}>
        {esJefe ? 'Editar ingreso' : 'Proponer corrección'}
      </div>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <Campo label="Fecha"><input type="date" value={fecha} max={hoyISO()} onChange={e => setFecha(e.target.value)} style={entrada} /></Campo>
        <Campo label="Número de guía"><input value={guia} placeholder="Opcional" onChange={e => setGuia(e.target.value)} style={entrada} /></Campo>
        <Campo label="Proveedor"><input value={proveedor} placeholder="Opcional" onChange={e => setProveedor(e.target.value)} style={entrada} /></Campo>
      </div>
      {esJefe && (
        <div style={{ marginBottom: '12px' }}>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '6px' }}>Plazo de pago</div>
          <Seg valor={plazo}
               onCambio={pz => { setPlazo(pz); setLineas(ls => ls.map(l => l.insumoId ? { ...l, precio: fmtPre(precioCompraCat(l.insumoId, pz)) } : l)) }}
               opciones={[0, 30, 60, 90].map(p => [p, PLAZO_LBL[p]])} />
        </div>
      )}
      <div style={{ fontSize: '12px', color: GRIS, marginBottom: '7px' }}>Insumos</div>
      {lineas.map((l, i) => {
        const ins = insumos.find(x => x.id === l.insumoId)
        const uni = ins ? (UNI[ins.unidad_compra] || ins.unidad_compra) : null
        return (
          <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '7px' }}>
            <select value={l.insumoId} onChange={e => { setLinea(i, 'insumoId', e.target.value); if (esJefe) setLinea(i, 'precio', fmtPre(precioCompraCat(e.target.value, plazo))) }} style={{ ...entrada, flex: 1 }}>
              <option value="">Elegir insumo</option>
              {insumos.map(x => <option key={x.id} value={x.id}>{x.nombre}</option>)}
            </select>
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
              <CampoNumero maxDec={2} value={l.cantidad} placeholder="Cantidad"
                onChange={v => setLinea(i, 'cantidad', v)} style={{ ...entrada, width: '110px' }} />
              <span style={{ fontSize: '13px', color: GRIS, minWidth: '50px' }}>{uni || ''}</span>
            </div>
            {esJefe && ins && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }} title="Precio del catálogo según el plazo. Puedes cambiarlo solo para este ingreso.">
                <span style={{ fontSize: '12px', color: GRIS }}>$</span>
                <CampoNumero maxDec={6} value={l.precio ?? ''} placeholder="precio"
                  onChange={v => setLinea(i, 'precio', v)} style={{ ...entrada, width: '90px', borderColor: '#9cc4e8' }} />
                <span style={{ fontSize: '11px', color: GRIS }}>/{uni || ''}</span>
              </div>
            )}
            {lineas.length > 1 && <button onClick={() => setLineas(ls => ls.filter((_, j) => j !== i))}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#c3d0db', fontSize: '18px', lineHeight: 1 }}>×</button>}
          </div>
        )
      })}
      <button onClick={() => setLineas(ls => [...ls, { insumoId: '', cantidad: '' }])}
        style={{ border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', color: AZUL, padding: '4px 0' }}>+ Otra línea</button>

      {!esJefe && (
        <div style={{ marginTop: '10px' }}>
          <Campo label="Motivo de la corrección">
            <input value={motivo} placeholder="Por qué se corrige — lo verá el jefe"
              onChange={e => setMotivo(e.target.value)} style={{ ...entrada, width: '100%' }} />
          </Campo>
        </div>
      )}

      <div style={{ display: 'flex', gap: '9px', justifyContent: 'flex-end', marginTop: '14px', flexWrap: 'wrap' }}>
        <Btn onClick={onCancelar}>Cancelar</Btn>
        {esJefe ? (
          <Btn primario onClick={guardarJefe} disabled={enviando}>{enviando ? 'Guardando...' : 'Guardar cambios'}</Btn>
        ) : (
          <>
            <MiniBtn rojo onClick={() => enviarSolicitud(true)}>Solicitar borrado</MiniBtn>
            <Btn primario onClick={() => enviarSolicitud(false)} disabled={enviando}>{enviando ? 'Enviando...' : 'Enviar solicitud'}</Btn>
          </>
        )}
      </div>
    </div>
  )
}

function EditorDevolucion({ d, unidad, onGuardado, onCancelar, setAviso }) {
  const [fecha, setFecha] = useState(d.fecha)
  const [cantidad, setCantidad] = useState(String(d.cantidad))
  const [motivo, setMotivo] = useState(d.motivo || '')
  const [enviando, setEnviando] = useState(false)

  async function guardar() {
    if (!numDec(cantidad)) { setAviso({ tipo: 'error', texto: 'Pon una cantidad.' }); return }
    setEnviando(true)
    const { error } = await supabase.schema('produccion').from('devolucion_insumo')
      .update({ fecha, cantidad: numDec(cantidad), motivo: motivo.trim() || null }).eq('id', d.id)
    setEnviando(false)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return }
    onGuardado({ fecha, cantidad: numDec(cantidad), motivo: motivo.trim() || null })
  }

  return (
    <div style={{ background: '#f6f9fb', borderRadius: '10px', padding: '14px', marginTop: '11px' }}>
      <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '10px' }}>Editar devolución</div>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '10px', alignItems: 'flex-end' }}>
        <Campo label="Fecha"><input type="date" value={fecha} max={hoyISO()} onChange={e => setFecha(e.target.value)} style={entrada} /></Campo>
        <Campo label="Cantidad">
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <CampoNumero maxDec={2} value={cantidad} placeholder="Cantidad"
              onChange={setCantidad} style={{ ...entrada, width: '130px' }} />
            <span style={{ fontSize: '13px', color: GRIS, minWidth: '58px' }}>{unidad || ''}</span>
          </div>
        </Campo>
      </div>
      <Campo label="Motivo">
        <input value={motivo} placeholder="Opcional" onChange={e => setMotivo(e.target.value)} style={{ ...entrada, width: '100%' }} />
      </Campo>
      <div style={{ display: 'flex', gap: '9px', justifyContent: 'flex-end', marginTop: '14px', flexWrap: 'wrap' }}>
        <Btn onClick={onCancelar}>Cancelar</Btn>
        <Btn primario onClick={guardar} disabled={enviando}>{enviando ? 'Guardando...' : 'Guardar cambios'}</Btn>
      </div>
    </div>
  )
}

function MiniBtn({ children, rojo, onClick }) {
  return (
    <button onClick={onClick} style={{
      background: 'white', border: '0.5px solid ' + (rojo ? '#e7cccb' : BORDE), borderRadius: '8px',
      padding: '6px 11px', fontFamily: 'inherit', fontSize: '12px',
      color: rojo ? '#8A2F2E' : NAVY, cursor: 'pointer' }}>{children}</button>
  )
}

// ---------------------------------------------------------------------
function Chip({ children, on, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: '8px 15px', borderRadius: '20px', fontFamily: 'inherit', fontSize: '13px',
      cursor: 'pointer', border: '0.5px solid ' + (on ? '#9cc4e8' : BORDE),
      background: on ? '#E6F1FB' : 'white', color: on ? AZUL : NAVY, fontWeight: on ? 500 : 400,
    }}>{children}</button>
  )
}

function Estado({ estado, completo }) {
  const m = estado === 'recibido' ? { t: 'Cerrado', c: GRIS, f: '#eef2f5' }
          : completo ? { t: 'Llegó todo', c: VERDE, f: '#E1F5EE' }
          : { t: 'Abierto', c: AMBAR, f: '#FAEEDA' }
  return (
    <span style={{ fontSize: '11px', fontWeight: 500, padding: '4px 11px', borderRadius: '20px',
                   background: m.f, color: m.c, height: 'fit-content' }}>{m.t}</span>
  )
}

function Tarjeta({ children }) {
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                  padding: '15px 17px', marginBottom: '10px' }}>{children}</div>
  )
}
function Lineas({ children }) {
  return <div style={{ marginTop: '11px', borderTop: '0.5px solid #f1f6f9', paddingTop: '9px' }}>{children}</div>
}
function Linea({ nombre, cantidad, sub, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '13px', alignItems: 'baseline', gap: '12px' }}>
      <span>{nombre}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums', color: color || NAVY, textAlign: 'right' }}>
        {cantidad}
        {sub && <span style={{ display: 'block', fontSize: '11px', color: GRIS, fontWeight: 400 }}>{sub}</span>}
      </span>
    </div>
  )
}
function Obs({ children }) {
  return <div style={{ fontSize: '12px', color: GRIS, marginTop: '9px', fontStyle: 'italic' }}>{children}</div>
}
function Vacio({ children }) {
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                  padding: '32px 24px', textAlign: 'center', fontSize: '13px', color: GRIS,
                  maxWidth: '520px', margin: '0 auto', lineHeight: 1.6 }}>{children}</div>
  )
}
function Campo({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>{label}</div>
      {children}
    </div>
  )
}
function Btn({ children, primario, ...props }) {
  return (
    <button {...props} style={{
      padding: '9px 17px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500,
      borderRadius: '9px', cursor: props.disabled ? 'default' : 'pointer',
      border: '0.5px solid ' + (primario ? AZUL : BORDE),
      background: primario ? AZUL : 'white', color: primario ? 'white' : NAVY,
      opacity: props.disabled ? 0.45 : 1,
    }}>{children}</button>
  )
}
const entrada = { padding: '8px 11px', fontSize: '13px', fontFamily: 'inherit',
                  border: '0.5px solid ' + BORDE, borderRadius: '9px',
                  boxSizing: 'border-box', background: 'white' }
