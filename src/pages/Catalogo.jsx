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
const PLAZOS = [0, 30, 60, 90, 120]
const PLAZO_LBL = { 0: 'Contado', 30: '30 días', 60: '60 días', 90: '90 días', 120: '120 días' }
const k = (a, b) => a + '|' + b
const sumarDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }

export default function Catalogo({ esJefe, esJefeGlobal, fincas, tabInicial }) {
  const [tab, setTab] = useState(tabInicial === 'balanceados' ? 'balanceados' : 'insumos')
  const [insumos, setInsumos] = useState([])
  const [productos, setProductos] = useState([])
  const [over, setOver] = useState({})        // insumo_id|finca_id -> {unidad, unidad_compra, factor}
  const [preIns, setPreIns] = useState({})     // insumo_id|finca_id -> [rows precio]
  const [preInsGen, setPreInsGen] = useState({}) // insumo_id -> {plazo: precio general vigente}
  const [preBal, setPreBal] = useState({})     // producto_id|finca_id -> [rows precio]
  const [preBalGen, setPreBalGen] = useState({}) // producto_id -> {plazo: precio general vigente}
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
      supabase.schema('produccion').from('insumo').select('id, nombre, unidad, unidad_compra, factor, proveedor').eq('activo', true).order('nombre'),
      supabase.schema('produccion').from('producto').select('id, nombre, marca, proveedor').eq('activo', true).order('nombre'),
      supabase.schema('produccion').from('insumo_finca').select('insumo_id, finca_id, unidad, unidad_compra, factor').in('finca_id', fincaIds.length ? fincaIds : ['00000000-0000-0000-0000-000000000000']),
      supabase.schema('produccion').from('precio_insumo').select('id, insumo_id, finca_id, precio_unitario, plazo, vigente_desde, vigente_hasta').in('finca_id', fincaIds.length ? fincaIds : ['00000000-0000-0000-0000-000000000000']),
      supabase.schema('produccion').from('precio_producto').select('id, producto_id, finca_id, precio_saco, plazo, vigente_desde, vigente_hasta').in('finca_id', fincaIds.length ? fincaIds : ['00000000-0000-0000-0000-000000000000']),
      esJefeGlobal ? supabase.schema('produccion').from('solicitud_correccion').select('id, valor_propuesto, finca:finca_id (nombre)').eq('tabla', 'nuevo_insumo').eq('estado', 'pendiente') : Promise.resolve({ data: [] }),
      esJefeGlobal ? supabase.schema('produccion').from('solicitud_correccion').select('id, valor_propuesto, finca:finca_id (nombre)').eq('tabla', 'nuevo_producto').eq('estado', 'pendiente') : Promise.resolve({ data: [] }),
    ])
    // Precios generales (finca nula) vigentes, por plazo, como respaldo.
    const [{ data: pg }, { data: pgb }] = await Promise.all([
      supabase.schema('produccion').from('precio_insumo')
        .select('insumo_id, precio_unitario, plazo').is('finca_id', null).is('vigente_hasta', null),
      supabase.schema('produccion').from('precio_producto')
        .select('producto_id, precio_saco, plazo').is('finca_id', null).is('vigente_hasta', null),
    ])
    const pig2 = {}; (pg || []).forEach(x => { (pig2[x.insumo_id] = pig2[x.insumo_id] || {})[x.plazo] = Number(x.precio_unitario) })
    setPreInsGen(pig2)
    const pbg2 = {}; (pgb || []).forEach(x => { (pbg2[x.producto_id] = pbg2[x.producto_id] || {})[x.plazo] = Number(x.precio_saco) })
    setPreBalGen(pbg2)
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

  // Vigente para un plazo dado (uno por plazo puede estar abierto).
  const vigente = (map, prodId, fincaId, plazo = 0) => (map[k(prodId, fincaId)] || []).find(x => x.vigente_hasta == null && Number(x.plazo) === plazo)
  const historial = (map, prodId, fincaId, plazo = 0) => (map[k(prodId, fincaId)] || []).filter(x => Number(x.plazo) === plazo).slice().sort((a, b) => (a.vigente_desde < b.vigente_desde ? 1 : -1))

  async function resolver(sol, aprobar) {
    const { error } = await supabase.schema('produccion').rpc('fn_resolver_correccion', { p_id: sol.id, p_aprobar: aprobar })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo resolver. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: aprobar ? 'Agregado al catálogo.' : 'Pedido rechazado.' }); await cargar()
  }

  // Guardar precios por plazo para una o varias fincas.
  // valores: { plazo: numeroDigitado } en la unidad `entrada` ('conteo'|'compra').
  // Para insumos, si entrada='compra' se convierte a precio por unidad de conteo (÷ factor de la finca).
  async function guardarPrecio({ tabla, col, prodCol, prodId, fincaIds, valores, entrada, desde, factorBase }) {
    const plazosConValor = PLAZOS.filter(pz => valores[pz] != null && valores[pz] > 0)
    if (!plazosConValor.length) { setAviso({ tipo: 'error', texto: 'Pon al menos un precio.' }); return }
    for (const fid of fincaIds) {
      const factor = tabla === 'precio_insumo' ? (Number(over[k(prodId, fid)]?.factor) || factorBase || 1) : 1
      for (const pz of plazosConValor) {
        const bruto = valores[pz]
        const guardado = (tabla === 'precio_insumo' && entrada === 'compra') ? bruto / factor : bruto
        await supabase.schema('produccion').from(tabla).delete().eq(prodCol, prodId).eq('finca_id', fid).eq('plazo', pz).gte('vigente_desde', desde)
        await supabase.schema('produccion').from(tabla).update({ vigente_hasta: sumarDias(desde, -1) })
          .eq(prodCol, prodId).eq('finca_id', fid).eq('plazo', pz).is('vigente_hasta', null).lt('vigente_desde', desde)
        const { error } = await supabase.schema('produccion').from(tabla).insert({ [prodCol]: prodId, finca_id: fid, plazo: pz, [col]: guardado, vigente_desde: desde })
        if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar el precio. ' + error.message }); return }
      }
    }
    setEditP(null); setAviso({ tipo: 'ok', texto: fincaIds.length === 1 ? 'Precios actualizados.' : `Precios aplicados a ${fincaIds.length} fincas.` }); await cargar()
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
                      {p.proveedor ? ` · Proveedor: ${p.proveedor}` : ''}
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
                      const genMap = tab === 'insumos' ? preInsGen[p.id] : preBalGen[p.id]  // {plazo: num} en unidad de conteo (insumo) o saco (bal)
                      // Precio por plazo, con respaldo al general. Devuelve el valor en unidad de conteo (insumo) o saco (bal).
                      const precioPlazo = (pz) => {
                        const vg = vigente(map, p.id, f.id, pz)
                        if (vg) return { val: Number(vg[col]), heredado: false }
                        const g = genMap && genMap[pz] != null ? genMap[pz] : null
                        return { val: g, heredado: g != null }
                      }
                      // Para mostrar, el insumo se ve por unidad de compra (saco): valor × factor.
                      const aCompra = (v) => v == null ? null : (tab === 'insumos' ? v * factor : v)
                      const contado = precioPlazo(0)
                      const otros = PLAZOS.filter(pz => pz !== 0).map(pz => ({ pz, ...precioPlazo(pz) })).filter(x => x.val != null)
                      const claveP = k(p.id, f.id)
                      return (
                        <Fragment key={f.id}>
                          <div style={{ display: 'grid', gridTemplateColumns: tab === 'insumos' ? '1.1fr 1.3fr 0.9fr 160px' : '1.6fr 1fr 160px',
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
                                         fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer', fontVariantNumeric: 'tabular-nums', textAlign: 'right',
                                         color: contado.val == null ? '#BA7517' : NAVY, minWidth: '120px' }}>
                                {contado.val == null ? 'Sin precio' : <>{dinero(aCompra(contado.val))} <span style={{ fontSize: '10px', color: GRIS }}>contado/{cap(uCompra)}</span></>}
                                {contado.heredado && <span style={{ fontSize: '9px', color: GRIS, display: 'block' }}>general</span>}
                                {otros.length > 0 && <span style={{ fontSize: '10px', color: GRIS, display: 'block' }}>{otros.map(x => `${x.pz}d ${dinero(aCompra(x.val))}`).join(' · ')}</span>}
                              </button>
                              <button onClick={() => { setHist(hist === claveP ? null : claveP); setEditP(null) }} title="Historial de precios"
                                style={{ border: 'none', background: 'none', cursor: 'pointer', color: AZUL, padding: 0, lineHeight: 1 }}>
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
                              </button>
                            </span>
                          </div>

                          {editP === claveP && (
                            <EditorPrecio tab={tab} fincas={fincas} fincaActual={f} uCons={uCons} uCompra={uCompra} factor={factor}
                              actuales={Object.fromEntries(PLAZOS.map(pz => [pz, precioPlazo(pz).val]))}
                              onGuardar={(valores, entrada, desde, fincaIds) => guardarPrecio({ tabla, col, prodCol, prodId: p.id, fincaIds, valores, entrada, desde, factorBase: Number(p.factor) })}
                              onCancelar={() => setEditP(null)} />
                          )}
                          {hist === claveP && (
                            <div style={{ padding: '6px 0 10px 10px', fontSize: '12px', color: GRIS, borderBottom: '0.5px solid #eef3f7' }}>
                              {PLAZOS.map(pz => {
                                const h = historial(map, p.id, f.id, pz)
                                if (!h.length) return null
                                return (
                                  <div key={pz} style={{ marginBottom: '4px' }}>
                                    <b style={{ fontWeight: 500, color: NAVY }}>{PLAZO_LBL[pz]}:</b>{' '}
                                    {h.map((x, i) => `${dinero(aCompra(Number(x[col])))} desde ${corta(x.vigente_desde)}${x.vigente_hasta ? ` a ${corta(x.vigente_hasta)}` : ' (hoy)'}`).join(' · ')}
                                  </div>
                                )
                              })}
                              {PLAZOS.every(pz => historial(map, p.id, f.id, pz).length === 0) && 'Sin historial.'}
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

async function crearInsumo({ nombre, unidad, unidadCompra, factor, proveedor }, setAviso) {
  const { error } = await supabase.schema('produccion').from('insumo').insert({ nombre: nombre.trim(), unidad, unidad_compra: (unidadCompra || unidad).trim(), factor: factor || 1, proveedor: (proveedor || '').trim() || null })
  if (error) { setAviso({ tipo: 'error', texto: /duplicate|unique/i.test(error.message) ? 'Ya existe un insumo con ese nombre.' : error.message }); return false }
  setAviso({ tipo: 'ok', texto: 'Insumo agregado.' }); return true
}
async function editarInsumo(actual, { nombre, proveedor }, setAviso) {
  const { error } = await supabase.schema('produccion').from('insumo').update({ nombre: nombre.trim(), proveedor: (proveedor || '').trim() || null }).eq('id', actual.id)
  if (error) { setAviso({ tipo: 'error', texto: /duplicate|unique/i.test(error.message) ? 'Ya existe un insumo con ese nombre.' : error.message }); return false }
  setAviso({ tipo: 'ok', texto: 'Insumo actualizado.' }); return true
}
async function crearProducto({ nombre, marca, proveedor }, setAviso) {
  const { error } = await supabase.schema('produccion').from('producto').insert({ nombre: nombre.trim(), marca: (marca || '').trim() || null, proveedor: (proveedor || '').trim() || null })
  if (error) { setAviso({ tipo: 'error', texto: /duplicate|unique/i.test(error.message) ? 'Ya existe un balanceado con ese nombre.' : error.message }); return false }
  setAviso({ tipo: 'ok', texto: 'Balanceado agregado.' }); return true
}
async function editarProducto(actual, { nombre, marca, proveedor }, setAviso) {
  const { error } = await supabase.schema('produccion').from('producto').update({ nombre: nombre.trim(), marca: (marca || '').trim() || null, proveedor: (proveedor || '').trim() || null }).eq('id', actual.id)
  if (error) { setAviso({ tipo: 'error', texto: error.message }); return false }
  setAviso({ tipo: 'ok', texto: 'Balanceado actualizado.' }); return true
}

function EditorPrecio({ tab, fincas, fincaActual, uCons, uCompra, factor, actuales, onGuardar, onCancelar }) {
  const esInsumo = tab === 'insumos'
  const hayCompra = esInsumo && uCompra && uCompra !== uCons   // ¿se compra en presentación distinta? (saco)
  // entrada: 'compra' (saco) o 'conteo' (kilo/unidad de cuenta). Balanceado siempre por saco.
  const [entrada, setEntrada] = useState(hayCompra ? 'compra' : 'conteo')
  // Prefill: actuales vienen en unidad de conteo (insumo) o saco (bal). Mostrar en la unidad de entrada.
  const prefill = (pz) => {
    const a = actuales[pz]
    if (a == null) return ''
    const enCompra = esInsumo && entrada === 'compra' ? a * factor : a
    return String(Math.round(enCompra * 10000) / 10000)
  }
  const [vals, setVals] = useState(() => Object.fromEntries(PLAZOS.map(pz => [pz, prefill(pz)])))
  const [desde, setDesde] = useState(hoyISO())
  const [enviando, setEnviando] = useState(false)
  const [sel, setSel] = useState([fincaActual.id])
  const otras = (fincas || []).filter(f => f.id !== fincaActual.id)
  const toggle = id => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  const setVal = (pz, v) => setVals(o => ({ ...o, [pz]: v }))
  // Al cambiar la unidad de entrada, reconvertir lo que ya está escrito.
  const cambiarEntrada = (nueva) => {
    if (nueva === entrada) return
    setVals(o => Object.fromEntries(PLAZOS.map(pz => {
      const n = numDec(o[pz]); if (!(n > 0)) return [pz, o[pz]]
      const conv = nueva === 'compra' ? n * factor : n / factor
      return [pz, String(Math.round(conv * 10000) / 10000)]
    })))
    setEntrada(nueva)
  }
  const unidadTxt = entrada === 'compra' ? (UNIDAD[uCompra] || cap(uCompra)) : (UNIDAD[uCons] || cap(uCons))
  const hayAlgo = PLAZOS.some(pz => numDec(vals[pz]) > 0)
  const guardar = async () => {
    setEnviando(true)
    const valores = {}
    PLAZOS.forEach(pz => { const n = numDec(vals[pz]); if (n > 0) valores[pz] = n })
    await onGuardar(valores, entrada, desde, sel)
    setEnviando(false)
  }
  return (
    <div style={{ background: '#eef3f7', padding: '12px', borderBottom: '0.5px solid #eef3f7' }}>
      {hayCompra && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
          <span style={{ fontSize: '12px', color: GRIS }}>Ingresar precio por:</span>
          {[['compra', UNIDAD[uCompra] || cap(uCompra)], ['conteo', UNIDAD[uCons] || cap(uCons)]].map(([id, txt]) => (
            <button key={id} onClick={() => cambiarEntrada(id)} style={{
              fontSize: '12px', borderRadius: '20px', padding: '5px 12px', cursor: 'pointer', fontFamily: 'inherit',
              border: '0.5px solid ' + (entrada === id ? '#9cc4e8' : BORDE), background: entrada === id ? '#E6F1FB' : 'white',
              color: entrada === id ? AZUL : NAVY, fontWeight: entrada === id ? 500 : 400 }}>{txt}</button>
          ))}
          <span style={{ fontSize: '11px', color: GRIS, marginLeft: 'auto' }}>1 {cap(uCompra)} = {factor} {UNIDAD[uCons] || uCons}</span>
        </div>
      )}
      <div style={{ fontSize: '11px', color: GRIS, marginBottom: '6px', textTransform: 'uppercase' }}>Precio por {unidadTxt} · por plazo</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '8px' }}>
        {PLAZOS.map(pz => {
          const n = numDec(vals[pz])
          const equiv = esInsumo && n > 0 ? (entrada === 'compra' ? n / factor : n * factor) : null
          return (
            <div key={pz}>
              <div style={{ fontSize: '12px', color: GRIS, marginBottom: '4px' }}>{PLAZO_LBL[pz]}</div>
              <input inputMode="decimal" value={vals[pz]} onChange={e => setVal(pz, e.target.value)}
                placeholder="—" style={{ ...inp, width: '100%', textAlign: 'right' }} />
              {equiv != null && <div style={{ fontSize: '10px', color: GRIS, marginTop: '2px', textAlign: 'right' }}>
                {dinero(equiv)}/{entrada === 'compra' ? (UNIDAD[uCons] || uCons) : (UNIDAD[uCompra] || uCompra)}</div>}
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '12px' }}>
        <Campo label="Rige desde"><input type="date" value={desde} onChange={e => setDesde(e.target.value)} style={inp} /></Campo>
        <button disabled={!hayAlgo || sel.length === 0 || enviando} onClick={guardar}
          style={{ ...btnPri, opacity: (!hayAlgo || sel.length === 0 || enviando) ? 0.5 : 1 }}>{enviando ? 'Guardando...' : 'Aplicar'}</button>
        <button onClick={onCancelar} style={btn}>Cancelar</button>
      </div>
      {otras.length > 0 && (
        <div style={{ marginTop: '10px' }}>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '6px' }}>Aplicar los mismos precios a:</div>
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
          {esInsumo && hayCompra && <div style={{ fontSize: '11px', color: GRIS, marginTop: '6px' }}>Si otra finca tiene distinto peso por {cap(uCompra)}, el precio por {UNIDAD[uCons] || uCons} se ajusta a su factor.</div>}
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
  const [proveedor, setProveedor] = useState(actual?.proveedor || '')
  const dist = actual ? (actual.unidad_compra && actual.unidad_compra !== actual.unidad) : false
  const [compraDistinta, setCompraDistinta] = useState(!!dist)
  const [unidadCompra, setUnidadCompra] = useState(dist ? actual.unidad_compra : '')
  const [factor, setFactor] = useState(dist ? String(actual.factor) : '')
  const [enviando, setEnviando] = useState(false)
  const soloNombre = !!actual   // al editar, aquí solo cambia el nombre y el proveedor; la unidad va por finca
  const listo = nombre.trim() && (soloNombre || !compraDistinta || (unidadCompra.trim() && numDec(factor) > 0))
  return (
    <div style={{ background: '#f7fafc', borderRadius: '10px', padding: '14px', marginTop: '10px' }}>
      <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Campo label="Nombre"><input autoFocus value={nombre} onChange={e => setNombre(e.target.value)} style={{ ...inp, width: '220px' }} placeholder="Ej. Cal agrícola" /></Campo>
        {!soloNombre && <Campo label="Se aplica en (por defecto)"><select value={unidad} onChange={e => setUnidad(e.target.value)} style={{ ...inp, width: '160px' }}>{UNIDADES.map(u => <option key={u} value={u}>{UNIDAD[u]}</option>)}</select></Campo>}
        <Campo label="Proveedor (opcional)"><input value={proveedor} onChange={e => setProveedor(e.target.value)} style={{ ...inp, width: '200px' }} placeholder="Ej. Agripac" /></Campo>
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
        <button disabled={!listo || enviando} onClick={async () => { setEnviando(true); await onGuardar({ nombre, unidad, unidadCompra: compraDistinta ? unidadCompra : unidad, factor: compraDistinta ? numDec(factor) : 1, proveedor }); setEnviando(false) }}
          style={{ ...btnPri, opacity: (!listo || enviando) ? 0.5 : 1 }}>{enviando ? 'Guardando...' : 'Guardar'}</button>
        <button onClick={onCancelar} style={btn}>Cancelar</button>
      </div>
    </div>
  )
}

function FormaProducto({ actual, onGuardar, onCancelar }) {
  const [nombre, setNombre] = useState(actual?.nombre || '')
  const [marca, setMarca] = useState(actual?.marca || '')
  const [proveedor, setProveedor] = useState(actual?.proveedor || '')
  const [enviando, setEnviando] = useState(false)
  return (
    <div style={{ background: '#f7fafc', borderRadius: '10px', padding: '14px', marginTop: '10px', display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <Campo label="Nombre del balanceado"><input autoFocus value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Ej. Nicovita 35" style={{ ...inp, width: '220px' }} /></Campo>
      <Campo label="Marca (opcional)"><input value={marca} onChange={e => setMarca(e.target.value)} placeholder="Ej. Nicovita" style={{ ...inp, width: '150px' }} /></Campo>
      <Campo label="Proveedor (opcional)"><input value={proveedor} onChange={e => setProveedor(e.target.value)} placeholder="Ej. Vitapro" style={{ ...inp, width: '150px' }} /></Campo>
      <button disabled={!nombre.trim() || enviando} onClick={async () => { setEnviando(true); await onGuardar({ nombre, marca, proveedor }); setEnviando(false) }}
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
