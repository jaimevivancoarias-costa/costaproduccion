import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, num, numDec, miles } from '../lib/fechas'

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
          .select('id, fecha, numero_guia, proveedor, observacion, creado_por, creado_en, ingreso_insumo_linea(insumo_id, cantidad, plazo)')
          .eq('finca_id', finca.id).order('fecha', { ascending: false }).limit(40),
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
        .eq('finca_id', finca.id).order('fecha', { ascending: false }).limit(40)
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
  }, [finca.id])

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

  return (
    <div style={{ padding: '1.4rem 1.5rem', maxWidth: '1180px' }}>

      <div style={{ display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap',
                    marginBottom: '16px' }}>
        <Chip on={modo === 'ingresos'} onClick={() => { setModo('ingresos'); setNuevo(null) }}>
          Ingresos a bodega
        </Chip>
        <Chip on={modo === 'pedidos'} onClick={() => { setModo('pedidos'); setNuevo(null) }}>
          Pedidos
        </Chip>
        <Chip on={modo === 'devoluciones'} onClick={() => { setModo('devoluciones'); setNuevo(null) }}>
          Devoluciones
        </Chip>
        <div style={{ marginLeft: 'auto' }}>
          {!nuevo && (
            <Btn primario onClick={() => setNuevo(modo === 'ingresos' ? 'ingreso' : modo === 'pedidos' ? 'pedido' : 'devolucion')}>
              {modo === 'ingresos' ? 'Registrar ingreso' : modo === 'pedidos' ? 'Registrar pedido' : 'Registrar devolución'}
            </Btn>
          )}
        </div>
      </div>

      {aviso && (
        <div style={{ borderRadius: '10px', padding: '12px 14px', fontSize: '13px', marginBottom: '12px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE',
                      color: aviso.tipo === 'error' ? '#8A2F2E' : VERDE }}>{aviso.texto}</div>
      )}

      {nuevo && (
        <Formulario
          tipo={nuevo} finca={finca} insumos={insumos}
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
        !ingresos.length ? (
          <Vacio>Todavía no hay ingresos registrados. Cuando llegue producto a bodega, regístralo aquí con su guía.</Vacio>
        ) : ingresos.map(g => {
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
              {(g.ingreso_insumo_linea || []).map((l, i) => (
                <Linea key={i} nombre={nombreInsumo(l.insumo_id)}
                       cantidad={`+${miles(num(l.cantidad))} ${unidadInsumo(l.insumo_id)}${l.plazo ? ` · ${PLAZO_LBL[l.plazo]}` : ''}`}
                       color={VERDE} />
              ))}
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
        })

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
                        {miles(num(l.cantidad))} {unidadInsumo(l.insumo_id)}
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
        !devoluciones.length ? (
          <Vacio>Todavía no hay devoluciones. Una devolución a CostaMarket resta del saldo de la bodega.</Vacio>
        ) : devoluciones.map(d => (
          <Tarjeta key={d.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 500 }}>{corta(d.fecha)}</div>
                <div style={{ fontSize: '13px', color: NAVY, marginTop: '3px' }}>
                  {nombreInsumo(d.insumo_id)}: <b style={{ fontWeight: 600 }}>−{miles(num(d.cantidad))}</b> {unidadInsumo(d.insumo_id)}
                </div>
                {d.motivo && <div style={{ fontSize: '12px', color: GRIS, fontStyle: 'italic', marginTop: '2px' }}>{d.motivo}</div>}
                {autoria(d) && <div style={{ fontSize: '11px', color: '#9fb0bf', marginTop: '2px' }}>{autoria(d)}</div>}
              </div>
              {esJefe && (
                <MiniBtn rojo onClick={() => borrarDevolucion(d)}>Borrar</MiniBtn>
              )}
            </div>
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
function Formulario({ tipo, finca, insumos, pedidosAbiertos, pendientes, onCancelar, onGuardado, onDevolucion, setAviso }) {
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

  const UNI = { sacos: 'sacos', litros: 'litros', ml: 'mL', gramos: 'gramos',
                libras: 'libras', kg: 'kilos', unidad: 'unidades',
                tambor: 'tambores', botella: 'botellas' }

  function setLinea(i, campo, valor) {
    setLineas(ls => ls.map((l, j) => j === i ? { ...l, [campo]: valor } : l))
  }
  const agregarLinea = () => setLineas(ls => [...ls, { insumoId: '', cantidad: '', unidad: '' }])
  const quitarLinea = i => setLineas(ls => ls.filter((_, j) => j !== i))

  const validas = lineas.filter(l => l.insumoId && (num(l.cantidad) || num(l.sobrante)))

  // Convierte la cantidad digitada a la unidad de compra (como se guarda).
  // Suma el sobrante (en unidad de aplicación) dividido por el factor.
  function cantidadEnCompra(l) {
    const ins = insumos.find(x => x.id === l.insumoId)
    const factor = Number(ins?.factor) || 1
    const uCompra = ins?.unidad_compra || ins?.unidad
    const uElegida = l.unidad || uCompra
    const q = numDec(l.cantidad || '')
    const principal = uElegida === uCompra ? q : q / factor
    const sob = numDec(l.sobrante || '')
    return principal + (sob > 0 ? sob / factor : 0)
  }

  async function guardar() {
    if (!validas.length) { setAviso({ tipo: 'error', texto: 'Agrega al menos una línea.' }); return }
    setGuardando(true)
    try {
      if (esIngreso) {
        const { data: g, error } = await supabase.schema('produccion').from('ingreso_insumo')
          .insert({ finca_id: finca.id, fecha, numero_guia: guia || null,
                    proveedor: proveedor || null, pedido_id: pedidoId || null,
                    observacion: obs || null })
          .select('id').single()
        if (error) throw error
        const { error: e2 } = await supabase.schema('produccion').from('ingreso_insumo_linea')
          .insert(validas.map(l => ({ ingreso_id: g.id, insumo_id: l.insumoId, cantidad: cantidadEnCompra(l) })))
        if (e2) throw e2
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
          <>
            <Campo label="Número de guía">
              <input value={guia} placeholder="Opcional" onChange={e => setGuia(e.target.value)} style={entrada} />
            </Campo>
            {pedidosAbiertos.length > 0 && (
              <Campo label="¿Es de un pedido?">
                <select value={pedidoId} onChange={e => setPedidoId(e.target.value)} style={entrada}>
                  <option value="">No</option>
                  {pedidosAbiertos.map(p => (
                    <option key={p.id} value={p.id}>{corta(p.fecha)} · {p.proveedor || 'sin proveedor'}</option>
                  ))}
                </select>
              </Campo>
            )}
          </>
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
        const enCompra = ins && num(l.cantidad) ? cantidadEnCompra(l) : null
        const mostrarEquiv = ins && uElegida !== uCompra && enCompra != null
        return (
          <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '7px', flexWrap: 'wrap' }}>
            <select value={l.insumoId} onChange={e => { setLinea(i, 'insumoId', e.target.value); setLinea(i, 'unidad', ''); setLinea(i, 'sobrante', ''); setLinea(i, 'sobranteOn', false) }}
              style={{ ...entrada, flex: 1, minWidth: '180px' }}>
              <option value="">Elegir insumo</option>
              {insumos.map(x => <option key={x.id} value={x.id}>{x.nombre}</option>)}
            </select>
            <input inputMode="decimal" value={l.cantidad}
              placeholder="Cantidad"
              onChange={e => setLinea(i, 'cantidad', e.target.value)}
              style={{ ...entrada, width: '110px' }} />
            {unidades.length > 1 ? (
              <select value={uElegida} onChange={e => setLinea(i, 'unidad', e.target.value)} style={{ ...entrada, width: '110px' }}>
                {unidades.map(u => <option key={u} value={u}>{UNI[u] || cap1(u)}</option>)}
              </select>
            ) : ins ? (
              <span style={{ fontSize: '13px', color: GRIS, width: '110px' }}>{UNI[uCompra] || cap1(uCompra)}</span>
            ) : null}
            {mostrarEquiv && (
              <span style={{ fontSize: '11px', color: GRIS }}>= {miles(Math.round(enCompra * 100) / 100)} {UNI[uCompra] || cap1(uCompra)}</span>
            )}
            {lineas.length > 1 && (
              <button onClick={() => quitarLinea(i)} style={{ border: 'none', background: 'none',
                cursor: 'pointer', color: '#c3d0db', fontSize: '18px', lineHeight: 1 }}>×</button>
            )}
            {/* + sobrante: solo si hay conversión y el principal está en la presentación */}
            {ins && uCompra !== uCons && uElegida === uCompra && (
              <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '8px', paddingLeft: '2px' }}>
                {l.sobranteOn ? (
                  <>
                    <input inputMode="decimal" value={l.sobrante ?? ''} placeholder={'+ sobrante en ' + (UNI[uCons] || cap1(uCons))}
                      onChange={e => setLinea(i, 'sobrante', e.target.value)} style={{ ...entrada, width: '150px' }} />
                    <span style={{ fontSize: '11px', color: GRIS }}>= {miles(Math.round(cantidadEnCompra(l) * 100) / 100)} {UNI[uCompra] || cap1(uCompra)}</span>
                    <button onClick={() => { setLinea(i, 'sobranteOn', false); setLinea(i, 'sobrante', '') }}
                      style={{ border: 'none', background: 'none', cursor: 'pointer', color: GRIS, fontFamily: 'inherit', fontSize: '11px' }}>quitar sobrante</button>
                  </>
                ) : (
                  <button onClick={() => setLinea(i, 'sobranteOn', true)}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: AZUL, fontFamily: 'inherit', fontSize: '11px', padding: 0 }}>+ sobrante ({UNI[uCons] || cap1(uCons)})</button>
                )}
              </div>
            )}
          </div>
        )
      })}
      <button onClick={agregarLinea} style={{ border: 'none', background: 'none', cursor: 'pointer',
        fontFamily: 'inherit', fontSize: '13px', color: AZUL, padding: '4px 0' }}>
        + otra línea
      </button>

      <div style={{ display: 'flex', gap: '9px', justifyContent: 'flex-end', marginTop: '14px' }}>
        <Btn onClick={onCancelar}>Cancelar</Btn>
        <Btn primario onClick={guardar} disabled={guardando || !validas.length}>
          {guardando ? 'Guardando...'
            : esIngreso ? 'Guardar ingreso'
            : esDevolucion ? 'Guardar devolución'
            : 'Guardar pedido'}
        </Btn>
      </div>
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
  const [lineas, setLineas] = useState((g.ingreso_insumo_linea || []).map(l => ({ insumoId: l.insumo_id, cantidad: String(l.cantidad) })))
  const [motivo, setMotivo] = useState('')
  const [enviando, setEnviando] = useState(false)
  const UNI = { sacos: 'sacos', litros: 'litros', ml: 'mL', gramos: 'gramos', libras: 'libras', kg: 'kilos',
                unidad: 'unidades', tambor: 'tambores', botella: 'botellas' }
  const setLinea = (i, c, v) => setLineas(ls => ls.map((l, j) => j === i ? { ...l, [c]: v } : l))
  const validas = lineas.filter(l => l.insumoId && num(l.cantidad))

  async function guardarJefe() {
    if (!validas.length) { setAviso({ tipo: 'error', texto: 'Deja al menos una línea.' }); return }
    setEnviando(true)
    const { error } = await supabase.schema('produccion').from('ingreso_insumo')
      .update({ fecha, numero_guia: guia || null, proveedor: proveedor || null }).eq('id', g.id)
    if (error) { setEnviando(false); setAviso({ tipo: 'error', texto: error.message }); return }
    await supabase.schema('produccion').from('ingreso_insumo_linea').delete().eq('ingreso_id', g.id)
    const { error: e2 } = await supabase.schema('produccion').from('ingreso_insumo_linea')
      .insert(validas.map(l => ({ ingreso_id: g.id, insumo_id: l.insumoId, cantidad: num(l.cantidad) })))
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
          lineas: validas.map(l => ({ insumo_id: l.insumoId, cantidad: num(l.cantidad) })) }
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
      <div style={{ fontSize: '12px', color: GRIS, marginBottom: '7px' }}>Insumos</div>
      {lineas.map((l, i) => {
        const ins = insumos.find(x => x.id === l.insumoId)
        const uni = ins ? (UNI[ins.unidad_compra] || ins.unidad_compra) : null
        return (
          <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '7px' }}>
            <select value={l.insumoId} onChange={e => setLinea(i, 'insumoId', e.target.value)} style={{ ...entrada, flex: 1 }}>
              <option value="">Elegir insumo</option>
              {insumos.map(x => <option key={x.id} value={x.id}>{x.nombre}</option>)}
            </select>
            <input inputMode="decimal" value={l.cantidad} placeholder={uni ? `Cantidad en ${uni}` : 'Cantidad'}
              onChange={e => setLinea(i, 'cantidad', e.target.value)} style={{ ...entrada, width: '170px' }} />
            {lineas.length > 1 && <button onClick={() => setLineas(ls => ls.filter((_, j) => j !== i))}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#c3d0db', fontSize: '18px', lineHeight: 1 }}>×</button>}
          </div>
        )
      })}
      <button onClick={() => setLineas(ls => [...ls, { insumoId: '', cantidad: '' }])}
        style={{ border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', color: AZUL, padding: '4px 0' }}>+ otra línea</button>

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
function Linea({ nombre, cantidad, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '13px' }}>
      <span>{nombre}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums', color: color || NAVY }}>{cantidad}</span>
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
