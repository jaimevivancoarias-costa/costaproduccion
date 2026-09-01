import { useState, useEffect, useCallback, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, numDec, dinero } from '../lib/fechas'

// Catálogo · maestro de productos + detalle por finca.
//
// Lista todos los insumos/balanceados (compartidos). Cada uno se expande
// y muestra, por finca: cómo entra (presentación), en qué se cuenta
// (unidad) y el precio, con su historial (ícono de reloj).
//
// Jefe global: crea/edita/quita productos y define presentación y unidad
// por finca. Precio: jefe (todas sus fincas) y contadora (las suyas).

const NAVY = '#022847', AZUL = '#0D6CB0', BORDE = '#dce6ef', GRIS = '#7d8fa0', ROJO = '#8A2F2E', VERDE = '#0F6E56'
const UNIDAD = { sacos: 'Sacos', litros: 'Litros', gramos: 'Gramos', libras: 'Libras', kg: 'Kilos', unidad: 'Unidades' }
const UNIDADES = ['sacos', 'litros', 'gramos', 'libras', 'kg', 'unidad']
const k = (a, b) => a + '|' + b
const sumarDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }

export default function Catalogo({ esJefe, esJefeGlobal, fincas, tabInicial }) {
  const [tab, setTab] = useState(tabInicial === 'balanceados' ? 'balanceados' : 'insumos')
  const [insumos, setInsumos] = useState([])
  const [productos, setProductos] = useState([])
  const [over, setOver] = useState({})        // insumo_id|finca_id -> {unidad, unidad_compra, factor}
  const [preIns, setPreIns] = useState({})     // insumo_id|finca_id -> [rows precio]
  const [preInsGen, setPreInsGen] = useState({}) // insumo_id -> precio general vigente (finca nula)
  const [preBal, setPreBal] = useState({})     // producto_id|finca_id -> [rows precio]
  const [solIns, setSolIns] = useState([])
  const [solBal, setSolBal] = useState([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [abierto, setAbierto] = useState(null)     // producto expandido
  const [hist, setHist] = useState(null)           // clave de historial abierto
  const [editP, setEditP] = useState(null)         // clave de precio en edición
  const [editU, setEditU] = useState(null)         // clave de unidad en edición
  const [nuevo, setNuevo] = useState(false)
  const [editProd, setEditProd] = useState(null)   // id de producto en edición (nombre)

  const fincaIds = (fincas || []).map(f => f.id)

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    const [{ data: ins }, { data: prod }, { data: ov }, { data: pi }, { data: pb }, { data: si }, { data: sb }] = await Promise.all([
      supabase.schema('produccion').from('insumo').select('id, nombre, unidad, unidad_compra, factor').eq('activo', true).order('nombre'),
      supabase.schema('produccion').from('producto').select('id, nombre, marca').eq('activo', true).order('nombre'),
      supabase.schema('produccion').from('insumo_finca').select('insumo_id, finca_id, unidad, unidad_compra, factor').in('finca_id', fincaIds.length ? fincaIds : ['00000000-0000-0000-0000-000000000000']),
      supabase.schema('produccion').from('precio_insumo').select('id, insumo_id, finca_id, precio_unitario, vigente_desde, vigente_hasta').in('finca_id', fincaIds.length ? fincaIds : ['00000000-0000-0000-0000-000000000000']),
      supabase.schema('produccion').from('precio_producto').select('id, producto_id, finca_id, precio_saco, vigente_desde, vigente_hasta').in('finca_id', fincaIds.length ? fincaIds : ['00000000-0000-0000-0000-000000000000']),
      esJefeGlobal ? supabase.schema('produccion').from('solicitud_correccion').select('id, valor_propuesto, finca:finca_id (nombre)').eq('tabla', 'nuevo_insumo').eq('estado', 'pendiente') : Promise.resolve({ data: [] }),
      esJefeGlobal ? supabase.schema('produccion').from('solicitud_correccion').select('id, valor_propuesto, finca:finca_id (nombre)').eq('tabla', 'nuevo_producto').eq('estado', 'pendiente') : Promise.resolve({ data: [] }),
    ])
    // Precios generales (finca nula) como respaldo, en consulta aparte.
    const { data: pg } = await supabase.schema('produccion').from('precio_insumo')
      .select('insumo_id, precio_unitario').is('finca_id', null).is('vigente_hasta', null)
    const pig2 = {}; (pg || []).forEach(x => { pig2[x.insumo_id] = Number(x.precio_unitario) })
    setPreInsGen(pig2)
    setInsumos(ins || []); setProductos(prod || [])
    const om = {}; (ov || []).forEach(x => { om[k(x.insumo_id, x.finca_id)] = x }); setOver(om)
    const pim = {}
    ;(pi || []).forEach(x => { if (x.finca_id) { (pim[k(x.insumo_id, x.finca_id)] = pim[k(x.insumo_id, x.finca_id)] || []).push(x) } })
    setPreIns(pim)
    const pbm = {}; (pb || []).forEach(x => { (pbm[k(x.producto_id, x.finca_id)] = pbm[k(x.producto_id, x.finca_id)] || []).push(x) }); setPreBal(pbm)
    setSolIns(si || []); setSolBal(sb || [])
    setCargando(false)
  }, [esJefeGlobal, JSON.stringify(fincaIds)])
  useEffect(() => { cargar() }, [cargar])

  const vigente = (map, prodId, fincaId) => (map[k(prodId, fincaId)] || []).find(x => x.vigente_hasta == null)
  const historial = (map, prodId, fincaId) => (map[k(prodId, fincaId)] || []).slice().sort((a, b) => (a.vigente_desde < b.vigente_desde ? 1 : -1))

  async function resolver(sol, aprobar) {
    const { error } = await supabase.schema('produccion').rpc('fn_resolver_correccion', { p_id: sol.id, p_aprobar: aprobar })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo resolver. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: aprobar ? 'Agregado al catálogo.' : 'Pedido rechazado.' }); await cargar()
  }

  // Guardar precio de un producto para una o varias fincas.
  async function guardarPrecio({ tabla, col, prodCol, prodId, fincaIds, nuevo: v, desde }) {
    for (const fid of fincaIds) {
      await supabase.schema('produccion').from(tabla).delete().eq(prodCol, prodId).eq('finca_id', fid).gte('vigente_desde', desde)
      await supabase.schema('produccion').from(tabla).update({ vigente_hasta: sumarDias(desde, -1) })
        .eq(prodCol, prodId).eq('finca_id', fid).is('vigente_hasta', null).lt('vigente_desde', desde)
      const { error } = await supabase.schema('produccion').from(tabla).insert({ [prodCol]: prodId, finca_id: fid, [col]: v, vigente_desde: desde })
      if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar el precio. ' + error.message }); return }
    }
    setEditP(null); setAviso({ tipo: 'ok', texto: fincaIds.length === 1 ? 'Precio actualizado.' : `Precio aplicado a ${fincaIds.length} fincas.` }); await cargar()
  }

  async function quitar(tabla, id, nombre) {
    if (!window.confirm(`¿Quitar "${nombre}" del catálogo?\n\nDeja de aparecer para cargar; el historial se conserva.`)) return
    const { error } = await supabase.schema('produccion').from(tabla).update({ activo: false }).eq('id', id)
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Quitado.' }); await cargar()
  }

  if (!esJefe) return <div style={{ padding: '2rem', color: GRIS }}>El catálogo lo administran el jefe y las contadoras.</div>

  const solActual = tab === 'insumos' ? solIns : solBal
  const lista = tab === 'insumos' ? insumos : productos

  return (
    <div style={{ padding: '1.4rem 1.5rem', maxWidth: '1040px', color: NAVY, fontFamily: 'Inter, system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '22px', fontWeight: 500, margin: '0 0 4px' }}>Catálogo</h1>
      <p style={{ fontSize: '13px', color: GRIS, margin: '0 0 16px', maxWidth: '660px' }}>
        Todos los productos. Toca uno para ver, por finca, cómo entra, en qué se cuenta y su precio.
        El jefe define productos y presentaciones; el precio lo ponen el jefe y las contadoras.
      </p>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        {[['insumos', 'Insumos'], ['balanceados', 'Balanceados']].map(([id, txt]) => (
          <button key={id} onClick={() => { setTab(id); setAbierto(null); setNuevo(false) }} style={{
            padding: '8px 16px', borderRadius: '20px', fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer',
            border: '0.5px solid ' + (tab === id ? '#9cc4e8' : BORDE), background: tab === id ? '#E6F1FB' : 'white',
            color: tab === id ? AZUL : NAVY, fontWeight: tab === id ? 500 : 400 }}>{txt}</button>
        ))}
        {esJefeGlobal && (
          <button onClick={() => { setNuevo(true); setAviso(null) }} style={{ ...btn, marginLeft: 'auto' }}>
            + Agregar {tab === 'insumos' ? 'Insumo' : 'Balanceado'}
          </button>
        )}
      </div>

      {aviso && (
        <div style={{ borderRadius: '9px', padding: '10px 13px', fontSize: '13px', marginBottom: '12px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE', color: aviso.tipo === 'error' ? ROJO : VERDE }}>{aviso.texto}</div>
      )}

      {esJefeGlobal && solActual.length > 0 && (
        <div style={{ background: '#FBF5E9', border: '0.5px solid #ecd9b3', borderRadius: '10px', padding: '13px 15px', marginBottom: '14px' }}>
          <div style={{ fontWeight: 500, fontSize: '14px', marginBottom: '4px' }}>Pedidos de bodega por aprobar ({solActual.length})</div>
          {solActual.map(s => {
            const vp = s.valor_propuesto || {}
            return (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
                    flexWrap: 'wrap', borderTop: '0.5px solid #ecd9b3', paddingTop: '9px', marginTop: '9px' }}>
                <div style={{ fontSize: '13px' }}>
                  <b style={{ fontWeight: 500 }}>{vp.nombre}</b>
                  {tab === 'insumos'
                    ? <> · {UNIDAD[vp.unidad] || vp.unidad}{vp.unidad_compra && vp.unidad_compra !== vp.unidad ? ` · compra por ${vp.unidad_compra} (${vp.factor})` : ''}</>
                    : <>{vp.marca ? ` · ${vp.marca}` : ''}</>}
                  <div style={{ fontSize: '11px', color: GRIS }}>Pedido por {s.finca?.nombre}</div>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={() => resolver(s, true)} style={btn}>Aprobar</button>
                  <button onClick={() => resolver(s, false)} style={{ ...btn, color: ROJO, borderColor: '#e7cccb' }}>Rechazar</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {nuevo && (tab === 'insumos'
        ? <FormaInsumo onGuardar={async p => { const ok = await crearInsumo(p, setAviso); if (ok) { setNuevo(false); await cargar() } }} onCancelar={() => setNuevo(false)} />
        : <FormaProducto onGuardar={async p => { const ok = await crearProducto(p, setAviso); if (ok) { setNuevo(false); await cargar() } }} onCancelar={() => setNuevo(false)} />)}

      {cargando ? <div style={{ fontSize: '13px', color: GRIS, padding: '14px 0' }}>Cargando...</div> : (
        <div style={{ border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden', background: 'white' }}>
          {lista.map(p => {
            const ab = abierto === p.id
            return (
              <Fragment key={p.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px',
                              padding: '12px 15px', borderBottom: ab ? 'none' : '0.5px solid #f1f6f9', cursor: 'pointer',
                              background: ab ? '#f6f9fb' : 'white' }}
                     onClick={() => { setAbierto(ab ? null : p.id); setHist(null); setEditP(null); setEditU(null) }}>
                  <span style={{ fontSize: '14px', fontWeight: 500 }}>
                    <span style={{ display: 'inline-block', width: '13px', color: GRIS }}>{ab ? '▾' : '▸'}</span>
                    {p.nombre}
                    <span style={{ fontSize: '12px', color: GRIS, fontWeight: 400 }}>
                      {tab === 'insumos' ? ` · Se aplica en ${UNIDAD[p.unidad] || p.unidad}` : (p.marca ? ` · ${p.marca}` : '')}
                    </span>
                  </span>
                  {esJefeGlobal && (
                    <span style={{ display: 'flex', gap: '7px' }} onClick={e => e.stopPropagation()}>
                      <button onClick={() => setEditProd(editProd === p.id ? null : p.id)} style={btn}>{editProd === p.id ? 'Cancelar' : 'Editar'}</button>
                      <button onClick={() => quitar(tab === 'insumos' ? 'insumo' : 'producto', p.id, p.nombre)} style={{ ...btn, color: ROJO, borderColor: '#e7cccb' }}>Quitar</button>
                    </span>
                  )}
                </div>

                {editProd === p.id && (
                  <div style={{ padding: '0 15px 12px', background: ab ? '#f6f9fb' : 'white', borderBottom: '0.5px solid #f1f6f9' }}>
                    {tab === 'insumos'
                      ? <FormaInsumo actual={p} onGuardar={async d => { const ok = await editarInsumo(p, d, setAviso); if (ok) { setEditProd(null); await cargar() } }} onCancelar={() => setEditProd(null)} />
                      : <FormaProducto actual={p} onGuardar={async d => { const ok = await editarProducto(p, d, setAviso); if (ok) { setEditProd(null); await cargar() } }} onCancelar={() => setEditProd(null)} />}
                  </div>
                )}

                {ab && (
                  <div style={{ background: '#f6f9fb', borderBottom: '0.5px solid #f1f6f9', padding: '2px 15px 14px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: tab === 'insumos' ? '1.1fr 1.3fr 0.9fr 130px' : '1.6fr 1fr 130px',
                                  padding: '7px 0', fontSize: '11px', color: GRIS, textTransform: 'uppercase', borderBottom: '0.5px solid ' + BORDE }}>
                      <span>Finca</span>
                      {tab === 'insumos' && <span>Entra En</span>}
                      {tab === 'insumos' && <span>Se Cuenta En</span>}
                      {tab === 'balanceados' && <span>Unidad</span>}
                      <span style={{ textAlign: 'right' }}>Precio</span>
                    </div>
                    {(fincas || []).map(f => {
                      const o = tab === 'insumos' ? over[k(p.id, f.id)] : null
                      const uCons = tab === 'insumos' ? (o?.unidad || p.unidad) : 'sacos'
                      const uCompra = tab === 'insumos' ? (o?.unidad_compra || p.unidad_compra) : 'sacos'
                      const factor = tab === 'insumos' ? Number(o?.factor ?? p.factor) : 1
                      const map = tab === 'insumos' ? preIns : preBal
                      const prodCol = tab === 'insumos' ? 'insumo_id' : 'producto_id'
                      const col = tab === 'insumos' ? 'precio_unitario' : 'precio_saco'
                      const tabla = tab === 'insumos' ? 'precio_insumo' : 'precio_producto'
                      const vig = vigente(map, p.id, f.id)
                      let precio = vig ? Number(vig[col]) : null
                      const heredado = tab === 'insumos' && precio == null && preInsGen[p.id] != null
                      if (heredado) precio = preInsGen[p.id]
                      const claveP = k(p.id, f.id)
                      return (
                        <Fragment key={f.id}>
                          <div style={{ display: 'grid', gridTemplateColumns: tab === 'insumos' ? '1.1fr 1.3fr 0.9fr 130px' : '1.6fr 1fr 130px',
                                        alignItems: 'center', padding: '9px 0', fontSize: '13px', borderBottom: '0.5px solid #eef3f7' }}>
                            <span style={{ fontWeight: 500 }}>{String(f.nombre).toUpperCase()}</span>
                            {tab === 'insumos' && (
                              <span style={{ color: GRIS }}>
                                {uCompra && uCompra !== uCons ? `${cap(uCompra)} · ${factor} ${UNIDAD[uCons] || uCons}` : UNIDAD[uCompra] || cap(uCompra)}
                                {esJefeGlobal && <button onClick={() => setEditU(editU === claveP ? null : claveP)} style={miniLink}>{editU === claveP ? ' cerrar' : ' editar'}</button>}
                              </span>
                            )}
                            {tab === 'insumos' && <span style={{ color: GRIS }}>{UNIDAD[uCons] || uCons}</span>}
                            {tab === 'balanceados' && <span style={{ color: GRIS }}>Sacos</span>}
                            <span style={{ textAlign: 'right', display: 'flex', gap: '7px', justifyContent: 'flex-end', alignItems: 'center' }}>
                              <button onClick={() => { setEditP(editP === claveP ? null : claveP); setHist(null) }}
                                style={{ border: '0.5px solid ' + BORDE, borderRadius: '6px', padding: '4px 9px', background: 'white',
                                         fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer', fontVariantNumeric: 'tabular-nums',
                                         color: precio == null ? '#BA7517' : NAVY }}>
                                {precio == null ? 'Sin precio' : dinero(precio)}
                                {heredado && <span style={{ fontSize: '9px', color: GRIS, display: 'block' }}>general</span>}
                              </button>
                              <button onClick={() => { setHist(hist === claveP ? null : claveP); setEditP(null) }} title="Historial de precios"
                                style={{ border: 'none', background: 'none', cursor: 'pointer', color: AZUL, padding: 0, lineHeight: 1 }}>
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
                              </button>
                            </span>
                          </div>

                          {editP === claveP && (
                            <EditorPrecio actual={precio} fincas={fincas} fincaActual={f}
                              onGuardar={(v, desde, fincaIds) => guardarPrecio({ tabla, col, prodCol, prodId: p.id, fincaIds, nuevo: v, desde })}
                              onCancelar={() => setEditP(null)} />
                          )}
                          {hist === claveP && (
                            <div style={{ padding: '6px 0 10px 10px', fontSize: '12px', color: GRIS, borderBottom: '0.5px solid #eef3f7' }}>
                              {historial(map, p.id, f.id).length === 0 ? 'Sin historial.' : historial(map, p.id, f.id).map((h, i) => (
                                <div key={i}>
                                  {dinero(Number(h[col]))} · desde {corta(h.vigente_desde)}{h.vigente_hasta ? ` hasta ${corta(h.vigente_hasta)}` : ' (vigente)'}
                                </div>
                              ))}
                            </div>
                          )}
                          {editU === claveP && tab === 'insumos' && (
                            <EditorUnidadFinca insumo={p} finca={f} fincas={fincas} actual={{ unidad: uCons, unidad_compra: uCompra, factor }}
                              onHecho={async (msg) => { setEditU(null); await cargar(); setAviso({ tipo: 'ok', texto: msg }) }}
                              onError={t => setAviso({ tipo: 'error', texto: t })} onCancelar={() => setEditU(null)} />
                          )}
                        </Fragment>
                      )
                    })}
                    {tab === 'insumos' && (
                      <div style={{ fontSize: '11px', color: GRIS, marginTop: '8px' }}>
                        Presentación y unidad las define el jefe. El precio lo editan jefe y contadora (sus fincas).
                      </div>
                    )}
                  </div>
                )}
              </Fragment>
            )
          })}
          {lista.length === 0 && <div style={{ padding: '18px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Nada en el catálogo todavía.</div>}
        </div>
      )}
    </div>
  )
}

const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s

async function crearInsumo({ nombre, unidad, unidadCompra, factor }, setAviso) {
  const { error } = await supabase.schema('produccion').from('insumo').insert({ nombre: nombre.trim(), unidad, unidad_compra: (unidadCompra || unidad).trim(), factor: factor || 1 })
  if (error) { setAviso({ tipo: 'error', texto: /duplicate|unique/i.test(error.message) ? 'Ya existe un insumo con ese nombre.' : error.message }); return false }
  setAviso({ tipo: 'ok', texto: 'Insumo agregado.' }); return true
}
async function editarInsumo(actual, { nombre }, setAviso) {
  const { error } = await supabase.schema('produccion').from('insumo').update({ nombre: nombre.trim() }).eq('id', actual.id)
  if (error) { setAviso({ tipo: 'error', texto: /duplicate|unique/i.test(error.message) ? 'Ya existe un insumo con ese nombre.' : error.message }); return false }
  setAviso({ tipo: 'ok', texto: 'Insumo actualizado.' }); return true
}
async function crearProducto({ nombre, marca }, setAviso) {
  const { error } = await supabase.schema('produccion').from('producto').insert({ nombre: nombre.trim(), marca: (marca || '').trim() || null })
  if (error) { setAviso({ tipo: 'error', texto: /duplicate|unique/i.test(error.message) ? 'Ya existe un balanceado con ese nombre.' : error.message }); return false }
  setAviso({ tipo: 'ok', texto: 'Balanceado agregado.' }); return true
}
async function editarProducto(actual, { nombre, marca }, setAviso) {
  const { error } = await supabase.schema('produccion').from('producto').update({ nombre: nombre.trim(), marca: (marca || '').trim() || null }).eq('id', actual.id)
  if (error) { setAviso({ tipo: 'error', texto: error.message }); return false }
  setAviso({ tipo: 'ok', texto: 'Balanceado actualizado.' }); return true
}

function EditorPrecio({ actual, fincas, fincaActual, onGuardar, onCancelar }) {
  const [v, setV] = useState(actual != null ? String(actual) : '')
  const [desde, setDesde] = useState(hoyISO())
  const [enviando, setEnviando] = useState(false)
  const [sel, setSel] = useState([fincaActual.id])
  const val = numDec(v)
  const otras = (fincas || []).filter(f => f.id !== fincaActual.id)
  const toggle = id => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  return (
    <div style={{ background: '#eef3f7', padding: '10px 12px', borderBottom: '0.5px solid #eef3f7' }}>
      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Campo label="Precio nuevo"><input inputMode="decimal" autoFocus value={v} onChange={e => setV(e.target.value)} style={{ ...inp, width: '120px', textAlign: 'right' }} /></Campo>
        <Campo label="Rige desde"><input type="date" value={desde} onChange={e => setDesde(e.target.value)} style={inp} /></Campo>
        <button disabled={!(val > 0) || sel.length === 0 || enviando} onClick={async () => { setEnviando(true); await onGuardar(val, desde, sel); setEnviando(false) }}
          style={{ ...btnPri, opacity: (!(val > 0) || sel.length === 0 || enviando) ? 0.5 : 1 }}>{enviando ? 'Guardando...' : 'Aplicar'}</button>
        <button onClick={onCancelar} style={btn}>Cancelar</button>
      </div>
      {otras.length > 0 && (
        <div style={{ marginTop: '10px' }}>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '6px' }}>Aplicar el mismo precio a:</div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', background: '#dbe6f0', borderRadius: '20px', padding: '5px 11px' }}>{String(fincaActual.nombre).toUpperCase()} (esta)</span>
            {otras.map(f => {
              const on = sel.includes(f.id)
              return (
                <button key={f.id} onClick={() => toggle(f.id)} style={{
                  fontSize: '12px', borderRadius: '20px', padding: '5px 11px', cursor: 'pointer', fontFamily: 'inherit',
                  border: '0.5px solid ' + (on ? '#9cc4e8' : BORDE), background: on ? '#E6F1FB' : 'white', color: on ? AZUL : NAVY, fontWeight: on ? 500 : 400 }}>
                  {on ? '✓ ' : ''}{String(f.nombre).toUpperCase()}
                </button>
              )
            })}
            {otras.length > 1 && (
              <button onClick={() => setSel([fincaActual.id, ...otras.map(f => f.id)])} style={miniLink}>Todas</button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function EditorUnidadFinca({ insumo, finca, fincas, actual, onHecho, onError, onCancelar }) {
  const [unidad, setUnidad] = useState(actual.unidad)
  const dist = actual.unidad_compra && actual.unidad_compra !== actual.unidad
  const [compraDistinta, setCompraDistinta] = useState(!!dist)
  const [unidadCompra, setUnidadCompra] = useState(dist ? actual.unidad_compra : '')
  const [factor, setFactor] = useState(dist ? String(actual.factor) : '')
  const [enviando, setEnviando] = useState(false)
  const [sel, setSel] = useState([finca.id])
  const listo = sel.length > 0 && (!compraDistinta || (unidadCompra.trim() && numDec(factor) > 0))
  const otras = (fincas || []).filter(f => f.id !== finca.id)
  const toggle = id => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])

  // Aplica la unidad/presentación a una finca. `por` = kg por saco/unidad si hace falta conversión.
  async function aplicarUna(fid, por) {
    if (unidad !== actual.unidad) {
      const args = { p_insumo: insumo.id, p_finca: fid, p_nueva: unidad }
      if (por != null) args.p_por = por
      const { error } = await supabase.schema('produccion').rpc('fn_cambiar_unidad_insumo_finca', args)
      return error
    }
    const { error } = await supabase.schema('produccion').from('insumo_finca')
      .upsert({ insumo_id: insumo.id, finca_id: fid, unidad, unidad_compra: (compraDistinta ? unidadCompra : unidad).trim(), factor: compraDistinta ? numDec(factor) : 1 }, { onConflict: 'insumo_id,finca_id' })
    return error
  }

  async function guardar() {
    setEnviando(true)
    let por = null
    // Si cambia la unidad y puede requerir conversión sacos↔masa, preguntamos una vez para todas.
    if (unidad !== actual.unidad) {
      const MASA = ['gramos', 'kg', 'libras']
      const cambiaFamilia = MASA.includes(actual.unidad) !== MASA.includes(unidad)
      if (cambiaFamilia) {
        const um = MASA.includes(actual.unidad) ? actual.unidad : unidad
        const uc = MASA.includes(actual.unidad) ? unidad : actual.unidad
        const sing = { sacos: 'saco', unidad: 'unidad' }[uc] || uc
        const r = window.prompt(`¿Cuántos ${UNIDAD[um] || um} pesa un ${sing} de "${insumo.nombre}"?` + (sel.length > 1 ? ' (se aplica a las fincas elegidas)' : ''))
        if (r === null) { setEnviando(false); return }
        por = numDec(r); if (!(por > 0)) { setEnviando(false); onError('Pon un número mayor que cero.'); return }
      }
    }
    for (const fid of sel) {
      let err = await aplicarUna(fid, por)
      if (err && /FALTA_POR/.test(err.message) && por == null) {
        const MASA = ['gramos', 'kg', 'libras']
        const um = MASA.includes(actual.unidad) ? actual.unidad : unidad
        const uc = MASA.includes(actual.unidad) ? unidad : actual.unidad
        const sing = { sacos: 'saco', unidad: 'unidad' }[uc] || uc
        const r = window.prompt(`¿Cuántos ${UNIDAD[um] || um} pesa un ${sing} de "${insumo.nombre}"?`)
        if (r === null) { setEnviando(false); return }
        por = numDec(r); if (!(por > 0)) { setEnviando(false); onError('Pon un número mayor que cero.'); return }
        err = await aplicarUna(fid, por)
      }
      if (err) { setEnviando(false); onError(err.message.replace(/^.*?:\s*/, '')); return }
    }
    setEnviando(false)
    const n = sel.length
    onHecho((unidad !== actual.unidad ? 'Unidad' : 'Presentación') + (n === 1 ? ' actualizada para ' + String(finca.nombre).toUpperCase() + '.' : ` actualizada en ${n} fincas.`))
  }

  return (
    <div style={{ background: '#eef3f7', padding: '10px 12px', borderBottom: '0.5px solid #eef3f7' }}>
      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Campo label="Se cuenta en"><select value={unidad} onChange={e => setUnidad(e.target.value)} style={{ ...inp, width: '130px' }}>{UNIDADES.map(u => <option key={u} value={u}>{UNIDAD[u]}</option>)}</select></Campo>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer', paddingBottom: '9px' }}>
          <input type="checkbox" checked={compraDistinta} onChange={e => setCompraDistinta(e.target.checked)} /> Se compra en otra presentación
        </label>
      </div>
      {compraDistinta && (
        <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '8px' }}>
          <Campo label="Se compra por"><input value={unidadCompra} onChange={e => setUnidadCompra(e.target.value)} placeholder="ej. saco" style={{ ...inp, width: '130px' }} /></Campo>
          <Campo label={`Cada uno trae (${UNIDAD[unidad]})`}><input inputMode="decimal" value={factor} onChange={e => setFactor(e.target.value)} placeholder="ej. 25" style={{ ...inp, width: '130px', textAlign: 'right' }} /></Campo>
        </div>
      )}
      {otras.length > 0 && (
        <div style={{ marginTop: '10px' }}>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '6px' }}>Aplicar la misma unidad a:</div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', background: '#dbe6f0', borderRadius: '20px', padding: '5px 11px' }}>{String(finca.nombre).toUpperCase()} (esta)</span>
            {otras.map(f => {
              const on = sel.includes(f.id)
              return (
                <button key={f.id} onClick={() => toggle(f.id)} style={{
                  fontSize: '12px', borderRadius: '20px', padding: '5px 11px', cursor: 'pointer', fontFamily: 'inherit',
                  border: '0.5px solid ' + (on ? '#9cc4e8' : BORDE), background: on ? '#E6F1FB' : 'white', color: on ? AZUL : NAVY, fontWeight: on ? 500 : 400 }}>
                  {on ? '✓ ' : ''}{String(f.nombre).toUpperCase()}
                </button>
              )
            })}
            {otras.length > 1 && (
              <button onClick={() => setSel([finca.id, ...otras.map(f => f.id)])} style={miniLink}>Todas</button>
            )}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
        <button disabled={!listo || enviando} onClick={guardar} style={{ ...btnPri, opacity: (!listo || enviando) ? 0.5 : 1 }}>{enviando ? 'Guardando...' : 'Guardar'}</button>
        <button onClick={onCancelar} style={btn}>Cancelar</button>
      </div>
    </div>
  )
}

function FormaInsumo({ actual, onGuardar, onCancelar }) {
  const [nombre, setNombre] = useState(actual?.nombre || '')
  const [unidad, setUnidad] = useState(actual?.unidad || 'kg')
  const dist = actual ? (actual.unidad_compra && actual.unidad_compra !== actual.unidad) : false
  const [compraDistinta, setCompraDistinta] = useState(!!dist)
  const [unidadCompra, setUnidadCompra] = useState(dist ? actual.unidad_compra : '')
  const [factor, setFactor] = useState(dist ? String(actual.factor) : '')
  const [enviando, setEnviando] = useState(false)
  const soloNombre = !!actual   // al editar, aquí solo cambia el nombre; la unidad va por finca
  const listo = nombre.trim() && (soloNombre || !compraDistinta || (unidadCompra.trim() && numDec(factor) > 0))
  return (
    <div style={{ background: '#f7fafc', borderRadius: '10px', padding: '14px', marginTop: '10px' }}>
      <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Campo label="Nombre"><input autoFocus value={nombre} onChange={e => setNombre(e.target.value)} style={{ ...inp, width: '220px' }} placeholder="Ej. Cal agrícola" /></Campo>
        {!soloNombre && <Campo label="Se aplica en (por defecto)"><select value={unidad} onChange={e => setUnidad(e.target.value)} style={{ ...inp, width: '160px' }}>{UNIDADES.map(u => <option key={u} value={u}>{UNIDAD[u]}</option>)}</select></Campo>}
      </div>
      {!soloNombre && (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '12px 0 0', fontSize: '13px', cursor: 'pointer' }}>
            <input type="checkbox" checked={compraDistinta} onChange={e => setCompraDistinta(e.target.checked)} /> Se compra en otra presentación (saco, tambor, botella…)
          </label>
          {compraDistinta && (
            <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '10px' }}>
              <Campo label="Se compra por"><input value={unidadCompra} onChange={e => setUnidadCompra(e.target.value)} placeholder="ej. saco" style={{ ...inp, width: '150px' }} /></Campo>
              <Campo label={`Cada uno trae (${UNIDAD[unidad]})`}><input inputMode="decimal" value={factor} onChange={e => setFactor(e.target.value)} placeholder="ej. 25" style={{ ...inp, width: '150px', textAlign: 'right' }} /></Campo>
            </div>
          )}
          <div style={{ fontSize: '11px', color: GRIS, marginTop: '6px' }}>Esta es la presentación por defecto. Cada finca puede ajustarla en su fila.</div>
        </>
      )}
      <div style={{ display: 'flex', gap: '9px', marginTop: '14px' }}>
        <button disabled={!listo || enviando} onClick={async () => { setEnviando(true); await onGuardar({ nombre, unidad, unidadCompra: compraDistinta ? unidadCompra : unidad, factor: compraDistinta ? numDec(factor) : 1 }); setEnviando(false) }}
          style={{ ...btnPri, opacity: (!listo || enviando) ? 0.5 : 1 }}>{enviando ? 'Guardando...' : 'Guardar'}</button>
        <button onClick={onCancelar} style={btn}>Cancelar</button>
      </div>
    </div>
  )
}

function FormaProducto({ actual, onGuardar, onCancelar }) {
  const [nombre, setNombre] = useState(actual?.nombre || '')
  const [marca, setMarca] = useState(actual?.marca || '')
  const [enviando, setEnviando] = useState(false)
  return (
    <div style={{ background: '#f7fafc', borderRadius: '10px', padding: '14px', marginTop: '10px', display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <Campo label="Nombre del balanceado"><input autoFocus value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Ej. Nicovita 35" style={{ ...inp, width: '220px' }} /></Campo>
      <Campo label="Marca (opcional)"><input value={marca} onChange={e => setMarca(e.target.value)} placeholder="Ej. Nicovita" style={{ ...inp, width: '160px' }} /></Campo>
      <button disabled={!nombre.trim() || enviando} onClick={async () => { setEnviando(true); await onGuardar({ nombre, marca }); setEnviando(false) }}
        style={{ ...btnPri, opacity: (!nombre.trim() || enviando) ? 0.5 : 1 }}>{enviando ? 'Guardando...' : 'Guardar'}</button>
      <button onClick={onCancelar} style={btn}>Cancelar</button>
    </div>
  )
}

function Campo({ label, children }) { return <div><div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>{label}</div>{children}</div> }
const inp = { padding: '8px 11px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '9px', boxSizing: 'border-box', background: 'white' }
const btn = { background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '9px', padding: '7px 13px', fontFamily: 'inherit', fontSize: '13px', color: NAVY, cursor: 'pointer' }
const btnPri = { background: AZUL, color: 'white', border: 'none', borderRadius: '9px', padding: '9px 18px', fontFamily: 'inherit', fontSize: '14px', fontWeight: 500, cursor: 'pointer' }
const miniLink = { background: 'none', border: 'none', padding: '0 0 0 6px', cursor: 'pointer', color: AZUL, fontFamily: 'inherit', fontSize: '11px' }
