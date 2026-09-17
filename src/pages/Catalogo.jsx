import { useState, useEffect, useCallback, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, numDec, dinero, dineroExacto } from '../lib/fechas'
import CatalogoDiesel from './CatalogoDiesel'

// Catálogo · maestro de productos + detalle por finca.
//
// Lista todos los insumos/balanceados (compartidos). Cada uno se expande
// y muestra, por finca: cómo entra (presentación), en qué se cuenta
// (unidad) y el precio, con su historial (ícono de reloj).
//
// Jefe global: crea/edita/quita productos y define presentación y unidad
// por finca. Precio: jefe (todas sus fincas) y contadora (las suyas).

const NAVY = '#022847', AZUL = '#0D6CB0', BORDE = '#dce6ef', GRIS = '#7d8fa0', ROJO = '#8A2F2E', VERDE = '#0F6E56', AMBAR = '#9a6a12'
const UNIDAD = { sacos: 'Sacos', litros: 'L', ml: 'mL', cl: 'cL', m3: 'm³', gal: 'gal', floz: 'fl oz',
                 gramos: 'g', mg: 'mg', kg: 'kg', t: 't', libras: 'lb', unidad: 'unidad' }
const UNIDADES = ['sacos', 'litros', 'ml', 'gramos', 'libras', 'kg', 'unidad']
// Unidades de aplicación (se cuenta/consume), por familia. Sacos NO va aquí: eso es presentación.
const UNIDADES_APP = ['mg', 'gramos', 'kg', 't', 'libras', 'ml', 'cl', 'litros', 'm3', 'gal', 'floz', 'unidad']
const U_POR = { mg: 0.001, gramos: 1, kg: 1000, t: 1000000, libras: 453.592,
                ml: 1, cl: 10, litros: 1000, m3: 1000000, gal: 3785.41, floz: 29.5735, unidad: 1, sacos: 1 }
const U_FAMILIA = u => ['mg', 'gramos', 'kg', 't', 'libras'].includes(u) ? 'masa'
                     : ['ml', 'cl', 'litros', 'm3', 'gal', 'floz'].includes(u) ? 'liquido' : 'conteo'
const U_LABEL = { mg: 'Miligramos (mg)', gramos: 'Gramos (g)', kg: 'Kilos (kg)', t: 'Toneladas (t)', libras: 'Libras (lb)',
                  ml: 'Mililitros (mL)', cl: 'Centilitros (cL)', litros: 'Litros (L)', m3: 'Metros cúbicos (m³)',
                  gal: 'Galones (gal)', floz: 'Onzas líquidas (fl oz)', unidad: 'Unidades' }
// ¿El par contenido/aplicación cruza masa<->líquido? (necesita densidad)
const cruzaFamilia = (uCont, uApp) => {
  const a = U_FAMILIA(uCont), b = U_FAMILIA(uApp)
  return a !== b && a !== 'conteo' && b !== 'conteo'
}
// Densidad interna (kg/L = g/mL) a partir del ratio que escribe el jefe:
// r = cuántas uApp hay en 1 uCont. Sirve para cualquier par masa/líquido.
const densInterna = (r, uCont, uApp) => {
  if (!(r > 0)) return null
  return U_FAMILIA(uCont) === 'masa'
    ? U_POR[uCont] / (r * U_POR[uApp])       // 1 uCont(g) = r·uApp(mL)  -> g/mL
    : (r * U_POR[uApp]) / U_POR[uCont]       // 1 uCont(mL) = r·uApp(g)  -> g/mL
}
// Ratio para mostrar (uApp por 1 uCont) desde la densidad guardada.
const rDesdeDens = (d, uCont, uApp) => {
  if (!(d > 0)) return null
  return U_FAMILIA(uCont) === 'masa'
    ? U_POR[uCont] / (d * U_POR[uApp])
    : (d * U_POR[uCont]) / U_POR[uApp]
}
// Factor: cuánto trae 1 presentación, expresado en la unidad de aplicación.
// densidad (kg/L) solo se usa cuando el par cruza masa<->líquido.
const factorDe = (contenido, uCont, uApp, densidad) => {
  const c = numDec(String(contenido))
  if (!(c > 0)) return null
  const fc = U_FAMILIA(uCont), fa = U_FAMILIA(uApp)
  if (fc === fa) return c * (U_POR[uCont] / U_POR[uApp])
  if (fc === 'conteo' || fa === 'conteo') return null
  const d = Number(densidad)
  if (!(d > 0)) return null
  let base = c * U_POR[uCont]                 // g si masa, mL si líquido
  base = fc === 'masa' ? base / d : base * d  // -> mL o -> g
  return base / U_POR[uApp]
}
const PLAZOS = [0, 30, 60, 90, 120]
const PLAZO_LBL = { 0: 'Contado', 30: '30 días', 60: '60 días', 90: '90 días', 120: '120 días' }
const k = (a, b) => a + '|' + b
const sumarDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }

export default function Catalogo({ esJefe, esJefeGlobal, fincas, tabInicial }) {
  const [tab, setTab] = useState(tabInicial === 'balanceados' ? 'balanceados' : 'insumos')
  const [insumos, setInsumos] = useState([])
  const [productos, setProductos] = useState([])
  const [over, setOver] = useState({})        // insumo_id|finca_id -> {unidad, unidad_compra, factor}
  const [overB, setOverB] = useState({})      // producto_id|finca_id -> {stock_minimo, stock_objetivo}
  const [editMinB, setEditMinB] = useState(null)  // clave en edición de mínimo/objetivo (balanceado)
  const [preIns, setPreIns] = useState({})     // insumo_id|finca_id -> [rows precio]
  const [preInsGen, setPreInsGen] = useState({}) // insumo_id -> {plazo: precio general vigente}
  const [preBal, setPreBal] = useState({})     // producto_id|finca_id -> [rows precio]
  const [preBalGen, setPreBalGen] = useState({}) // producto_id -> {plazo: precio general vigente}
  const [plz, setPlz] = useState({})           // prod|finca -> {plazo, vigente_desde} vigente
  const [editPz, setEditPz] = useState(null)   // clave de plazo en edición
  const [solIns, setSolIns] = useState([])
  const [solBal, setSolBal] = useState([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [abierto, setAbierto] = useState(null)     // producto expandido
  const [hist, setHist] = useState(null)           // clave de historial abierto
  const [histRows, setHistRows] = useState([])     // filas del historial (se traen al abrir)

  // Trae el historial completo de precios de un producto/finca solo cuando
  // se abre el reloj (para no cargar miles de filas viejas al inicio).
  async function abrirHist(prodId, fincaId, claveP) {
    if (hist === claveP) { setHist(null); return }
    setEditP(null); setHist(claveP); setHistRows([])
    const tabla = tab === 'insumos' ? 'precio_insumo' : 'precio_producto'
    const colId = tab === 'insumos' ? 'insumo_id' : 'producto_id'
    const { data } = await supabase.schema('produccion').from(tabla)
      .select('*').eq(colId, prodId).eq('finca_id', fincaId)
    setHistRows(data || [])
  }
  const [editP, setEditP] = useState(null)         // clave de precio en edición
  const [editU, setEditU] = useState(null)         // clave de unidad en edición
  const [nuevo, setNuevo] = useState(false)
  const [editProd, setEditProd] = useState(null)   // id de producto en edición (nombre)
  const [editConfig, setEditConfig] = useState(null)  // id de insumo en "Configurar todo de una"
  const [presentaciones, setPresentaciones] = useState([])
  const [busqCat, setBusqCat] = useState('')   // filtro por nombre en el catálogo

  const fincaIds = (fincas || []).map(f => f.id)

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    const fIds = fincaIds.length ? fincaIds : ['00000000-0000-0000-0000-000000000000']
    // Trae TODOS los precios vigentes por tandas de 1000 (PostgREST corta en
    // 1000 por consulta; sin esto, insumos con muchas fincas no cargaban).
    const allVigente = async (tabla, cols) => {
      const out = []; const size = 1000
      for (let from = 0; ; from += size) {
        const { data, error } = await supabase.schema('produccion').from(tabla)
          .select(cols).is('vigente_hasta', null).in('finca_id', fIds).range(from, from + size - 1)
        if (error || !data) break
        out.push(...data)
        if (data.length < size) break
      }
      return { data: out }
    }
    const [{ data: ins }, { data: prod }, { data: ov }, { data: pi }, { data: pb }, { data: si }, { data: sb }, { data: pres }] = await Promise.all([
      supabase.schema('produccion').from('insumo').select('id, nombre, unidad, unidad_compra, factor, proveedor, densidad').eq('activo', true).order('nombre'),
      supabase.schema('produccion').from('producto').select('id, nombre, marca, proveedor').eq('activo', true).order('nombre'),
      supabase.schema('produccion').from('insumo_finca').select('insumo_id, finca_id, unidad, unidad_compra, factor, contenido, unidad_contenido, stock_minimo, stock_objetivo').in('finca_id', fincaIds.length ? fincaIds : ['00000000-0000-0000-0000-000000000000']),
      allVigente('precio_insumo', 'id, insumo_id, finca_id, precio_unitario, plazo, vigente_desde, vigente_hasta'),
      allVigente('precio_producto', 'id, producto_id, finca_id, precio_saco, plazo, vigente_desde, vigente_hasta'),
      esJefeGlobal ? supabase.schema('produccion').from('solicitud_correccion').select('id, valor_propuesto, finca:finca_id (nombre)').eq('tabla', 'nuevo_insumo').eq('estado', 'pendiente') : Promise.resolve({ data: [] }),
      esJefeGlobal ? supabase.schema('produccion').from('solicitud_correccion').select('id, valor_propuesto, finca:finca_id (nombre)').eq('tabla', 'nuevo_producto').eq('estado', 'pendiente') : Promise.resolve({ data: [] }),
      supabase.schema('produccion').from('presentacion').select('nombre').eq('activo', true).order('nombre'),
    ])
    setPresentaciones((pres || []).map(x => x.nombre))
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
    // Plazo de compra vigente por producto y finca.
    const tablaPz = tab === 'insumos' ? 'plazo_insumo' : 'plazo_producto'
    const colPz = tab === 'insumos' ? 'insumo_id' : 'producto_id'
    const { data: pz } = await supabase.schema('produccion').from(tablaPz)
      .select(`${colPz}, finca_id, plazo, vigente_desde`).is('vigente_hasta', null)
      .in('finca_id', fincaIds.length ? fincaIds : ['00000000-0000-0000-0000-000000000000'])
    const pzm = {}; (pz || []).forEach(x => { pzm[k(x[colPz], x.finca_id)] = { plazo: Number(x.plazo), vigente_desde: x.vigente_desde } })
    setPlz(pzm)
    setInsumos(ins || []); setProductos(prod || [])
    const om = {}; (ov || []).forEach(x => { om[k(x.insumo_id, x.finca_id)] = x }); setOver(om)
    const pim = {}
    ;(pi || []).forEach(x => { if (x.finca_id) { (pim[k(x.insumo_id, x.finca_id)] = pim[k(x.insumo_id, x.finca_id)] || []).push(x) } })
    setPreIns(pim)
    const pbm = {}; (pb || []).forEach(x => { (pbm[k(x.producto_id, x.finca_id)] = pbm[k(x.producto_id, x.finca_id)] || []).push(x) }); setPreBal(pbm)
    setSolIns(si || []); setSolBal(sb || [])
    // Mínimo/objetivo por producto/finca (balanceado). Si la tabla aún no
    // existe (falta correr su SQL), no rompemos el catálogo.
    try {
      const { data: ovb, error: eovb } = await supabase.schema('produccion').from('producto_finca')
        .select('producto_id, finca_id, stock_minimo, stock_objetivo')
        .in('finca_id', fincaIds.length ? fincaIds : ['00000000-0000-0000-0000-000000000000'])
      if (!eovb) { const obm = {}; (ovb || []).forEach(x => { obm[k(x.producto_id, x.finca_id)] = x }); setOverB(obm) }
    } catch { /* tabla producto_finca aún no creada */ }
    setCargando(false)
  }, [esJefeGlobal, tab, JSON.stringify(fincaIds)])
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

  // Guardar el plazo de compra vigente para una o varias fincas, desde una fecha.
  async function guardarPlazo({ prodId, fincaIds, plazo, desde }) {
    const tablaPz = tab === 'insumos' ? 'plazo_insumo' : 'plazo_producto'
    const colPz = tab === 'insumos' ? 'insumo_id' : 'producto_id'
    for (const fid of fincaIds) {
      await supabase.schema('produccion').from(tablaPz).delete().eq(colPz, prodId).eq('finca_id', fid).gte('vigente_desde', desde)
      await supabase.schema('produccion').from(tablaPz).update({ vigente_hasta: sumarDias(desde, -1) })
        .eq(colPz, prodId).eq('finca_id', fid).is('vigente_hasta', null).lt('vigente_desde', desde)
      const { error } = await supabase.schema('produccion').from(tablaPz).insert({ [colPz]: prodId, finca_id: fid, plazo, vigente_desde: desde })
      if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar el plazo. ' + error.message }); return }
    }
    setEditPz(null); setAviso({ tipo: 'ok', texto: fincaIds.length === 1 ? 'Plazo actualizado.' : `Plazo aplicado a ${fincaIds.length} fincas.` }); await cargar()
  }

  async function quitar(tabla, id, nombre) {
    if (!window.confirm(`¿Quitar "${nombre}" del catálogo?\n\nDeja de aparecer para cargar; el historial se conserva.`)) return
    const { error } = await supabase.schema('produccion').from(tabla).update({ activo: false }).eq('id', id)
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Quitado.' }); await cargar()
  }

  if (!esJefe) return <div style={{ padding: '2rem', color: GRIS }}>El catálogo lo administran el jefe y las contadoras.</div>

  const solActual = tab === 'insumos' ? solIns : solBal
  const lista = (tab === 'insumos' ? insumos : productos)
    .filter(p => !busqCat || p.nombre === busqCat)

  return (
    <div style={{ padding: '1.4rem 1.5rem', maxWidth: '1040px', color: NAVY, fontFamily: 'Inter, system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '22px', fontWeight: 500, margin: '0 0 4px' }}>Catálogo</h1>
      <p style={{ fontSize: '13px', color: GRIS, margin: '0 0 16px', maxWidth: '660px' }}>
        Todos los productos. Toca uno para ver, por finca, cómo entra, en qué se cuenta y su precio.
        El jefe define productos y presentaciones; el precio lo ponen el jefe y las contadoras.
      </p>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        {[['insumos', 'Insumos'], ['balanceados', 'Balanceados'], ['diesel', 'Diesel']].map(([id, txt]) => (
          <button key={id} onClick={() => { setTab(id); setAbierto(null); setNuevo(false); setBusqCat('') }} style={{
            padding: '8px 16px', borderRadius: '20px', fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer',
            border: '0.5px solid ' + (tab === id ? '#9cc4e8' : BORDE), background: tab === id ? '#E6F1FB' : 'white',
            color: tab === id ? AZUL : NAVY, fontWeight: tab === id ? 500 : 400 }}>{txt}</button>
        ))}
        {tab !== 'diesel' && (
          <select value={busqCat} onChange={e => setBusqCat(e.target.value)}
                  style={{ padding: '8px 12px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE,
                           borderRadius: '9px', background: 'white', minWidth: '220px', marginLeft: esJefeGlobal ? '0' : 'auto' }}>
            <option value="">Todos los {tab === 'insumos' ? 'insumos' : 'balanceados'}</option>
            {(tab === 'insumos' ? insumos : productos).map(p => <option key={p.id} value={p.nombre}>{p.nombre}</option>)}
          </select>
        )}
        {esJefeGlobal && tab !== 'diesel' && (
          <button onClick={() => { setNuevo(true); setAviso(null) }} style={{ ...btn, marginLeft: 'auto' }}>
            + Agregar {tab === 'insumos' ? 'Insumo' : 'Balanceado'}
          </button>
        )}
      </div>

      {tab === 'diesel' ? (
        <CatalogoDiesel fincas={fincas} />
      ) : (<>

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

      {/* Insumos sin precio: su consumo y su saldo valen $0 hasta cargarlo. */}
      {!cargando && tab === 'insumos' && (() => {
        const sp = insumos.filter(p => {
          const gen = preInsGen[p.id]
          const tieneGen = gen && Object.values(gen).some(v => Number(v) > 0)
          if (tieneGen) return false
          return !fincas.some(f => (preIns[k(p.id, f.id)] || []).length > 0)
        })
        if (!sp.length) return null
        return (
          <div style={{ background: '#FBF5E9', border: '0.5px solid #ecd9b3', borderRadius: '10px',
                        padding: '13px 15px', marginBottom: '14px' }}>
            <div style={{ fontWeight: 500, fontSize: '14px', marginBottom: '2px' }}>
              {sp.length} {sp.length === 1 ? 'insumo sin precio' : 'insumos sin precio'}
            </div>
            <div style={{ fontSize: '12px', color: GRIS, marginBottom: '9px' }}>
              Sin precio, su consumo y su saldo valen $0 en los reportes. Toca uno para cargarlo.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px' }}>
              {sp.map(p => (
                <button key={p.id}
                  onClick={() => { setAbierto(p.id); setHist(null); setEditP(null); setEditU(null) }}
                  style={{ fontSize: '12px', background: 'white', border: '0.5px solid #ecd9b3',
                           borderRadius: '8px', padding: '4px 10px', cursor: 'pointer',
                           fontFamily: 'inherit', color: NAVY }}>
                  {p.nombre}
                </button>
              ))}
            </div>
          </div>
        )
      })()}

      {nuevo && (tab === 'insumos'
        ? <FormaInsumo onGuardar={async p => { const ok = await crearInsumo(p, setAviso); if (ok) { setNuevo(false); await cargar() } }} onCancelar={() => setNuevo(false)} />
        : <FormaProducto onGuardar={async p => { const ok = await crearProducto(p, setAviso); if (ok) { setNuevo(false); await cargar() } }} onCancelar={() => setNuevo(false)} />)}

      {cargando ? <div style={{ fontSize: '13px', color: GRIS, padding: '14px 0' }}>Cargando...</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {lista.map(p => {
            const ab = abierto === p.id
            // Badges de "pendiente" (solo insumos).
            const tienePrecio = tab === 'insumos'
              ? ((preInsGen[p.id] && Object.values(preInsGen[p.id]).some(v => Number(v) > 0)) ||
                 (fincas || []).some(f => (preIns[k(p.id, f.id)] || []).length > 0))
              : true
            const tieneMin = tab === 'insumos'
              ? (fincas || []).some(f => over[k(p.id, f.id)]?.stock_minimo != null)
              : true
            return (
              <div key={p.id} style={{ background: 'white', border: '1px solid #e6edf3', borderRadius: '14px',
                                       boxShadow: '0 1px 2px rgba(16,40,71,0.04)', overflow: 'hidden' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px',
                              padding: '15px 20px', borderBottom: ab ? '1px solid #f0f4f8' : 'none', cursor: 'pointer' }}
                     onClick={() => { setAbierto(ab ? null : p.id); setHist(null); setEditP(null); setEditU(null) }}>
                  <span style={{ fontSize: '15px', fontWeight: 600 }}>
                    <span style={{ display: 'inline-block', width: '14px', color: GRIS, fontSize: '12px' }}>{ab ? '▾' : '▸'}</span>
                    {p.nombre}
                    <span style={{ fontSize: '12px', color: GRIS, fontWeight: 400 }}>
                      {tab === 'insumos' ? ` · Se aplica en ${UNIDAD[p.unidad] || p.unidad}` : (p.marca ? ` · ${p.marca}` : '')}
                      {p.proveedor ? ` · Proveedor ${p.proveedor}` : ''}
                    </span>
                    {tab === 'insumos' && !tienePrecio && <Insignia color="#A23A38" bg="#FBEAEA">Sin precio</Insignia>}
                    {tab === 'insumos' && tienePrecio && !tieneMin && <Insignia color="#9a6a12" bg="#FAEEDA">Sin mínimo</Insignia>}
                  </span>
                  {esJefeGlobal && (
                    <span style={{ display: 'flex', gap: '14px' }} onClick={e => e.stopPropagation()}>
                      <button onClick={() => { setAbierto(p.id); setEditConfig(editConfig === p.id ? null : p.id) }} style={linkAccion(VERDE)}>{editConfig === p.id ? 'Cerrar' : 'Configurar'}</button>
                      <button onClick={() => setEditProd(editProd === p.id ? null : p.id)} style={linkAccion(AZUL)}>{editProd === p.id ? 'Cancelar' : 'Editar'}</button>
                      <button onClick={() => quitar(tab === 'insumos' ? 'insumo' : 'producto', p.id, p.nombre)} style={linkAccion(ROJO)}>Quitar</button>
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

                {editConfig === p.id && tab === 'insumos' && (() => {
                  // Precarga: config y precios actuales de una finca representativa.
                  const f0 = (fincas || []).find(f => String(f.nombre).toUpperCase() !== 'PRUEBA')?.id || (fincas || [])[0]?.id
                  const o = over[k(p.id, f0)]
                  const preciosAct = {}
                  let desdeAct = null
                  PLAZOS.forEach(pz => {
                    const vg = vigente(preIns, p.id, f0, pz)
                    preciosAct[pz] = vg ? Number(vg.precio_unitario) : (preInsGen[p.id]?.[pz] ?? null)
                    if (vg && !desdeAct) desdeAct = vg.vigente_desde
                  })
                  const pzAct = plz[k(p.id, f0)]?.plazo ?? 0
                  const vgAct = vigente(preIns, p.id, f0, pzAct)
                  if (vgAct?.vigente_desde) desdeAct = vgAct.vigente_desde
                  // Historial de excepciones ya guardadas: qué finca aplica
                  // distinto (unidad y/o precios por plazo) frente al estándar (f0).
                  const stdU = o?.unidad || p.unidad
                  const excIni = []
                  ;(fincas || []).forEach(f => {
                    if (f.id === f0 || String(f.nombre).toUpperCase() === 'PRUEBA') return
                    const of = over[k(p.id, f.id)]
                    let unidadExc = ''
                    if (of?.unidad && of.unidad !== stdU) {
                      const isComp = of.unidad === 'unidad' && of.unidad_contenido && of.unidad_contenido !== 'unidad'
                      unidadExc = isComp ? '__completo' : of.unidad
                    }
                    // Precios propios por plazo (los que difieren del estándar).
                    const facF = Number(of?.factor) || 1
                    const precios = {}
                    let hayPrecio = false, desdeExc = ''
                    PLAZOS.forEach(pz => {
                      const vgF = vigente(preIns, p.id, f.id, pz)
                      const vg0 = vigente(preIns, p.id, f0, pz)
                      if (vgF && (!vg0 || Number(vgF.precio_unitario) !== Number(vg0.precio_unitario))) {
                        precios[pz] = String(Math.round(Number(vgF.precio_unitario) * facF * 10000) / 10000)
                        hayPrecio = true
                        if (!desdeExc) desdeExc = vgF.vigente_desde || ''
                      }
                    })
                    const pzF = plz[k(p.id, f.id)]?.plazo ?? null
                    const plazoRige = (hayPrecio || (pzF != null && pzF !== pzAct)) ? (pzF ?? 0) : null
                    if (unidadExc || hayPrecio) excIni.push({ fincaId: f.id, unidad: unidadExc, desde: desdeExc, precios, plazoRige, abierto: hayPrecio })
                  })
                  return (
                    <EditorConfigTodo insumo={p} fincas={fincas} presentaciones={presentaciones} excIni={excIni}
                      actual={{ ...(o || {}), precios: preciosAct, plazoActivo: pzAct, desde: desdeAct }}
                      onHecho={async (msg) => { setEditConfig(null); await cargar(); setAviso({ tipo: 'ok', texto: msg }) }}
                      onError={t => setAviso({ tipo: 'error', texto: t })}
                      onCancelar={() => setEditConfig(null)} />
                  )
                })()}

                {editConfig === p.id && tab === 'balanceados' && (() => {
                  const f0 = (fincas || []).find(f => String(f.nombre).toUpperCase() !== 'PRUEBA')?.id || (fincas || [])[0]?.id
                  const preciosAct = {}
                  let desdeAct = null
                  PLAZOS.forEach(pz => {
                    const vg = vigente(preBal, p.id, f0, pz)
                    preciosAct[pz] = vg ? Number(vg.precio_saco) : (preBalGen[p.id]?.[pz] ?? null)
                    if (vg && !desdeAct) desdeAct = vg.vigente_desde
                  })
                  const pzAct = plz[k(p.id, f0)]?.plazo ?? 0
                  const vgAct = vigente(preBal, p.id, f0, pzAct)
                  if (vgAct?.vigente_desde) desdeAct = vgAct.vigente_desde
                  return (
                    <EditorConfigBal producto={p} fincas={fincas}
                      actual={{ ...(overB[k(p.id, f0)] || {}), precios: preciosAct, plazoActivo: pzAct, desde: desdeAct }}
                      onHecho={async (msg) => { setEditConfig(null); await cargar(); setAviso({ tipo: 'ok', texto: msg }) }}
                      onError={t => setAviso({ tipo: 'error', texto: t })}
                      onCancelar={() => setEditConfig(null)} />
                  )
                })()}

                {ab && (
                  <div style={{ background: 'white', padding: '0 20px 8px' }}>
                    {esJefe && (
                      <div style={{ fontSize: '11.5px', color: GRIS, padding: '8px 0 2px' }}>
                        Vista de solo lectura. Para cambiar {tab === 'insumos' ? 'unidades, precios' : 'precios'}, mínimo o cantidad deseable, usa <b style={{ color: VERDE }}>Configurar</b> (arriba). El reloj muestra el historial de precios.
                      </div>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: tab === 'insumos' ? '1fr 1.4fr 0.8fr 0.8fr 0.8fr 0.8fr 150px' : '1.3fr 0.7fr 0.8fr 0.8fr 0.9fr 150px',
                                  padding: '10px 0', fontSize: '10.5px', color: GRIS, textTransform: 'uppercase', letterSpacing: '.05em', borderBottom: '1px solid #f0f4f8' }}>
                      <span>Finca</span>
                      {tab === 'insumos' && <span>Llega En</span>}
                      {tab === 'insumos' && <span style={{ textAlign: 'center' }}>Se Aplica En</span>}
                      {tab === 'insumos' && <span>Mínimo Alerta</span>}
                      {tab === 'insumos' && <span>Objetivo</span>}
                      {tab === 'balanceados' && <span>Unidad</span>}
                      {tab === 'balanceados' && <span>Mínimo</span>}
                      {tab === 'balanceados' && <span>Objetivo</span>}
                      <span>Plazo Activo</span>
                      <span style={{ textAlign: 'right' }}>Precio</span>
                    </div>
                    {(fincas || []).map(f => {
                      const o = tab === 'insumos' ? over[k(p.id, f.id)] : null
                      const uCons = tab === 'insumos' ? (o?.unidad || p.unidad) : 'sacos'
                      const uCompra = tab === 'insumos' ? (o?.unidad_compra || p.unidad_compra) : 'sacos'
                      const factor = tab === 'insumos' ? Number(o?.factor ?? p.factor) : 1
                      const contenido = o?.contenido != null ? Number(o.contenido) : factor
                      const uCont = o?.unidad_contenido || uCons
                      const minimo = o?.stock_minimo != null ? Number(o.stock_minimo) : null
                      const objetivo = o?.stock_objetivo != null ? Number(o.stock_objetivo) : null
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
                      // Plazo a mostrar: el que rige; si ese no tiene precio,
                      // el primer plazo que sí tenga (para no decir "Sin precio"
                      // cuando en realidad hay precio en otro plazo).
                      const pzRige = plz[claveP]?.plazo ?? 0
                      const pzMostrar = precioPlazo(pzRige).val != null ? pzRige : (PLAZOS.find(pz => precioPlazo(pz).val != null) ?? pzRige)
                      return (
                        <Fragment key={f.id}>
                          <div style={{ display: 'grid', gridTemplateColumns: tab === 'insumos' ? '1fr 1.4fr 0.8fr 0.8fr 0.8fr 0.8fr 150px' : '1.3fr 0.7fr 0.8fr 0.8fr 0.9fr 150px',
                                        alignItems: 'center', padding: '10px 0', fontSize: '13px', borderBottom: '0.5px solid #eef3f7' }}>
                            <span style={{ fontWeight: 500 }}>{String(f.nombre).toUpperCase()}</span>
                            {tab === 'insumos' && (
                              <span style={{ color: NAVY }}>
                                {cap1(uCompra)} <span style={{ color: GRIS, fontSize: '11.5px' }}>(1 = {contenido} {UNIDAD[uCont] || uCont})</span>
                              </span>
                            )}
                            {tab === 'insumos' && (
                              <span style={{ color: GRIS, textAlign: 'center', fontWeight: 500 }}>{(uCons === 'unidad' ? cap1(uCompra) : (UNIDAD[uCons] || uCons)).toUpperCase()}</span>
                            )}
                            {tab === 'insumos' && (
                              <span style={{ color: minimo != null ? '#BA7517' : '#c3d0db' }}>{minimo != null ? `${minimo} ${UNIDAD[uCons] || uCons}` : '—'}</span>
                            )}
                            {tab === 'insumos' && (
                              <span style={{ color: objetivo != null ? VERDE : '#c3d0db' }}>{objetivo != null ? `${objetivo} ${UNIDAD[uCons] || uCons}` : '—'}</span>
                            )}
                            {tab === 'balanceados' && <span style={{ color: GRIS }}>Sacos</span>}
                            {tab === 'balanceados' && (() => {
                              const ob = overB[claveP]
                              const mn = ob?.stock_minimo != null ? Number(ob.stock_minimo) : null
                              const oj = ob?.stock_objetivo != null ? Number(ob.stock_objetivo) : null
                              return <>
                                <span style={{ color: mn != null ? '#BA7517' : '#c3d0db' }}>
                                  {mn != null ? `${mn} sacos` : '—'}
                                </span>
                                <span style={{ color: oj != null ? VERDE : '#c3d0db' }}>{oj != null ? `${oj} sacos` : '—'}</span>
                              </>
                            })()}
                            <span style={{ color: GRIS }}>
                              <span style={{ fontSize: '11px', background: '#E6F1FB', color: AZUL, borderRadius: '7px', padding: '3px 9px' }}>{PLAZO_LBL[pzMostrar]}</span>
                            </span>
                            <span style={{ textAlign: 'right', display: 'flex', gap: '7px', justifyContent: 'flex-end', alignItems: 'center' }}>
                              {(() => {
                                const activo = precioPlazo(pzMostrar)   // precio del plazo que rige (o el que tenga precio)
                                const conv2 = tab === 'insumos' && factor && factor !== 1 && uCons !== uCompra
                                const contenidoP = activo.val == null
                                  ? 'Sin precio'
                                  : <>{dineroExacto(aCompra(activo.val))}
                                      <span style={{ display: 'block', fontSize: '10px', color: GRIS, fontWeight: 400 }}>/{cap1(uCompra)}{activo.heredado ? ' · general' : ''}</span>
                                      {conv2 && <span style={{ display: 'block', fontSize: '10px', color: '#a7b4c1', fontWeight: 400 }}>= {dineroPrec(activo.val)} /{UNIDAD[uCons] || uCons}</span>}
                                    </>
                                const estilo = { border: '0.5px solid ' + BORDE, borderRadius: '6px', padding: '5px 11px', background: 'white', fontFamily: 'inherit', fontSize: '14px', fontWeight: 500, fontVariantNumeric: 'tabular-nums', textAlign: 'right', color: activo.val == null ? '#BA7517' : NAVY, minWidth: '96px' }
                                // Solo lectura (se edita en Configurar) para insumos y balanceados.
                                return <span style={{ ...estilo, display: 'inline-block' }}>{contenidoP}</span>
                              })()}
                              <button onClick={() => abrirHist(p.id, f.id, claveP)} title="Historial de precios"
                                style={{ border: 'none', background: 'none', cursor: 'pointer', color: AZUL, padding: 0, lineHeight: 1 }}>
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
                              </button>
                            </span>
                          </div>

                          {editP === claveP && (
                            <EditorPrecioPlazo tab={tab} fincas={fincas} fincaActual={f} uCons={uCons} uCompra={uCompra} factor={factor}
                              plazoActivo={plz[claveP]?.plazo ?? 0}
                              actuales={Object.fromEntries(PLAZOS.map(pz => [pz, precioPlazo(pz).val]))}
                              aCompra={aCompra}
                              onGuardarPlazo={(plazo, desde, fincaIds) => guardarPlazo({ prodId: p.id, fincaIds, plazo, desde })}
                              onGuardarPrecio={(valores, entrada, desde, fincaIds) => guardarPrecio({ tabla, col, prodCol, prodId: p.id, fincaIds, valores, entrada, desde, factorBase: Number(p.factor) })}
                              onCancelar={() => setEditP(null)} />
                          )}
                          {hist === claveP && (
                            <div style={{ padding: '6px 0 10px 10px', fontSize: '12px', color: GRIS, borderBottom: '0.5px solid #eef3f7' }}>
                              {PLAZOS.map(pz => {
                                const h = histRows.filter(x => Number(x.plazo) === pz).slice().sort((a, b) => (a.vigente_desde < b.vigente_desde ? 1 : -1))
                                if (!h.length) return null
                                return (
                                  <div key={pz} style={{ marginBottom: '4px' }}>
                                    <b style={{ fontWeight: 500, color: NAVY }}>{PLAZO_LBL[pz]}:</b>{' '}
                                    {h.map((x, i) => `${dinero(aCompra(Number(x[col])))} desde ${corta(x.vigente_desde)}${x.vigente_hasta ? ` a ${corta(x.vigente_hasta)}` : ' (hoy)'}`).join(' · ')}
                                  </div>
                                )
                              })}
                              {histRows.length === 0 && 'Sin historial.'}
                            </div>
                          )}
                          {editU === claveP && tab === 'insumos' && (
                            <EditorUnidadFinca insumo={p} finca={f} fincas={fincas} presentaciones={presentaciones}
                              actual={{ unidad: uCons, unidad_compra: uCompra, factor, contenido, unidad_contenido: uCont, stock_minimo: minimo, stock_objetivo: objetivo }}
                              onNuevaPresentacion={async (nom) => { await supabase.schema('produccion').from('presentacion').insert({ nombre: nom }); setPresentaciones(ps => [...new Set([...ps, nom])].sort()) }}
                              onHecho={async (msg) => { setEditU(null); await cargar(); setAviso({ tipo: 'ok', texto: msg }) }}
                              onError={t => setAviso({ tipo: 'error', texto: t })} onCancelar={() => setEditU(null)} />
                          )}
                          {editMinB === claveP && tab === 'balanceados' && (
                            <EditorMinBal producto={p} finca={f} fincas={fincas} actual={overB[claveP]}
                              onHecho={async (msg) => { setEditMinB(null); await cargar(); setAviso({ tipo: 'ok', texto: msg }) }}
                              onError={t => setAviso({ tipo: 'error', texto: t })} onCancelar={() => setEditMinB(null)} />
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
              </div>
            )
          })}
          {lista.length === 0 && <div style={{ padding: '18px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Nada en el catálogo todavía.</div>}
        </div>
      )}
      </>)}
    </div>
  )
}

const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s
const cap1 = s => s ? String(s).charAt(0).toUpperCase() + String(s).slice(1).toLowerCase() : s
// Dinero con precisión para valores chicos (ej. $0,0050 por mL).
const dineroPrec = v => {
  const n = Number(v) || 0
  const dec = Math.abs(n) > 0 && Math.abs(n) < 1 ? 4 : 2
  return '$' + n.toLocaleString('es-EC', { minimumFractionDigits: dec, maximumFractionDigits: 4 })
}

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
  const [plazoSel, setPlazoSel] = useState(0)
  const [v, setV] = useState(() => prefill(0))
  const [desde, setDesde] = useState(hoyISO())
  const [enviando, setEnviando] = useState(false)
  const [sel, setSel] = useState([fincaActual.id])
  const otras = (fincas || []).filter(f => f.id !== fincaActual.id)
  const toggle = id => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  // Al cambiar de plazo, precargar el precio vigente de ese plazo.
  const cambiarPlazo = (pz) => { setPlazoSel(pz); setV(prefillCon(actuales[pz], entrada)) }
  // Al cambiar la unidad de entrada, reconvertir lo escrito.
  const cambiarEntrada = (nueva) => {
    if (nueva === entrada) return
    const n = numDec(v)
    if (n > 0) setV(String(Math.round((nueva === 'compra' ? n * factor : n / factor) * 10000) / 10000))
    setEntrada(nueva)
  }
  function prefillCon(a, ent) {
    if (a == null) return ''
    const enUnidad = esInsumo && ent === 'compra' ? a * factor : a
    return String(Math.round(enUnidad * 10000) / 10000)
  }
  const unidadTxt = entrada === 'compra' ? (UNIDAD[uCompra] || cap(uCompra)) : (UNIDAD[uCons] || cap(uCons))
  const val = numDec(v)
  const equiv = esInsumo && val > 0 ? (entrada === 'compra' ? val / factor : val * factor) : null
  const guardar = async () => {
    setEnviando(true)
    await onGuardar({ [plazoSel]: val }, entrada, desde, sel)
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
      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Campo label="Este precio es de">
          <select value={plazoSel} onChange={e => cambiarPlazo(Number(e.target.value))} style={{ ...inp, width: '130px' }}>
            {PLAZOS.map(pz => <option key={pz} value={pz}>{PLAZO_LBL[pz]}</option>)}
          </select>
        </Campo>
        <Campo label={`Precio por ${unidadTxt}`}>
          <input inputMode="decimal" autoFocus value={v} onChange={e => setV(e.target.value)}
            placeholder="—" style={{ ...inp, width: '120px', textAlign: 'right' }} />
          {equiv != null && <div style={{ fontSize: '10px', color: GRIS, marginTop: '3px', textAlign: 'right' }}>
            = {dinero(equiv)}/{entrada === 'compra' ? (UNIDAD[uCons] || uCons) : (UNIDAD[uCompra] || uCompra)}</div>}
        </Campo>
        <Campo label="Rige desde"><input type="date" value={desde} onChange={e => setDesde(e.target.value)} style={inp} /></Campo>
        <button disabled={!(val > 0) || sel.length === 0 || enviando} onClick={guardar}
          style={{ ...btnPri, opacity: (!(val > 0) || sel.length === 0 || enviando) ? 0.5 : 1 }}>{enviando ? 'Guardando...' : 'Aplicar'}</button>
        <button onClick={onCancelar} style={btn}>Cancelar</button>
      </div>
      {otras.length > 0 && (
        <div style={{ marginTop: '10px' }}>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '6px' }}>Aplicar este precio a:</div>
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

// Editor unificado: plazo activo arriba, precios guardados + edición abajo.
function EditorPrecioPlazo({ tab, fincas, fincaActual, uCons, uCompra, factor, plazoActivo, actuales, aCompra, onGuardarPlazo, onGuardarPrecio, onCancelar }) {
  const esInsumo = tab === 'insumos'
  const hayCompra = esInsumo && uCompra && uCompra !== uCons
  const otras = (fincas || []).filter(f => f.id !== fincaActual.id)
  // --- Plazo activo ---
  const [plazoSel, setPlazoSel] = useState(plazoActivo ?? 0)
  const [desdePz, setDesdePz] = useState(hoyISO())
  const [selPz, setSelPz] = useState([fincaActual.id])
  const [envPz, setEnvPz] = useState(false)
  // --- Precios ---
  const [editar, setEditar] = useState(false)
  const [plazoP, setPlazoP] = useState(plazoActivo ?? 0)
  const [entrada, setEntrada] = useState(hayCompra ? 'compra' : 'conteo')
  const prefill = (pz, ent) => { const a = actuales[pz]; if (a == null) return ''; const v = esInsumo && ent === 'compra' ? a * factor : a; return String(Math.round(v * 10000) / 10000) }
  const [v, setV] = useState(prefill(plazoActivo ?? 0, hayCompra ? 'compra' : 'conteo'))
  const [desdeP, setDesdeP] = useState(hoyISO())
  const [selP, setSelP] = useState([fincaActual.id])
  const [envP, setEnvP] = useState(false)
  const val = numDec(v)
  const equiv = esInsumo && val > 0 ? (entrada === 'compra' ? val / factor : val * factor) : null
  const cambiarPlazoP = pz => { setPlazoP(pz); setV(prefill(pz, entrada)) }
  const cambiarEntrada = ne => { if (ne === entrada) return; const n = numDec(v); if (n > 0) setV(String(Math.round((ne === 'compra' ? n * factor : n / factor) * 10000) / 10000)); setEntrada(ne) }
  const toggle = (setF) => id => setF(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  const chips = (sel, setF) => otras.length > 0 && (
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
      <span style={{ fontSize: '12px', background: '#dbe6f0', borderRadius: '20px', padding: '5px 11px' }}>{String(fincaActual.nombre).toUpperCase()} (esta)</span>
      {otras.map(f => { const on = sel.includes(f.id); return (
        <button key={f.id} onClick={() => toggle(setF)(f.id)} style={{ fontSize: '12px', borderRadius: '20px', padding: '5px 11px', cursor: 'pointer', fontFamily: 'inherit', border: '0.5px solid ' + (on ? '#9cc4e8' : BORDE), background: on ? '#E6F1FB' : 'white', color: on ? AZUL : NAVY, fontWeight: on ? 500 : 400 }}>{on ? '✓ ' : ''}{String(f.nombre).toUpperCase()}</button>
      )})}
      {otras.length > 1 && <button onClick={() => setF([fincaActual.id, ...otras.map(f => f.id)])} style={miniLink}>Todas</button>}
    </div>
  )
  return (
    <div style={{ background: '#eef3f7', padding: '14px 16px', borderBottom: '0.5px solid #eef3f7' }}>
      {/* Precios guardados */}
      <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: AZUL, marginBottom: '8px' }}>Precios guardados (por {cap(uCompra)})</div>
      <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap', alignItems: 'center' }}>
        {PLAZOS.map(pz => {
          const val0 = actuales[pz]; const act = pz === (plazoActivo ?? 0)
          return (
            <span key={pz} style={{ fontSize: '12px', borderRadius: '7px', padding: '4px 10px',
              background: act ? '#E6F1FB' : '#eef2f6', color: act ? AZUL : NAVY, fontWeight: act ? 500 : 400 }}>
              {PLAZO_LBL[pz].replace(' días', 'd')} {val0 == null ? '—' : dinero(aCompra(val0))}{act ? ' · activo' : ''}
            </span>
          )
        })}
        <button onClick={() => setEditar(e => !e)} style={miniLink}>{editar ? 'cerrar' : 'editar precios'}</button>
      </div>

      {editar && (
        <div style={{ marginTop: '12px', background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '10px', padding: '12px' }}>
          {hayCompra && (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
              <span style={{ fontSize: '12px', color: GRIS }}>Ingresar precio por:</span>
              {[['compra', UNIDAD[uCompra] || cap(uCompra)], ['conteo', UNIDAD[uCons] || cap(uCons)]].map(([id, txt]) => (
                <button key={id} onClick={() => cambiarEntrada(id)} style={{ fontSize: '12px', borderRadius: '20px', padding: '5px 12px', cursor: 'pointer', fontFamily: 'inherit', border: '0.5px solid ' + (entrada === id ? '#9cc4e8' : BORDE), background: entrada === id ? '#E6F1FB' : 'white', color: entrada === id ? AZUL : NAVY, fontWeight: entrada === id ? 500 : 400 }}>{txt}</button>
              ))}
              <span style={{ fontSize: '11px', color: GRIS, marginLeft: 'auto' }}>1 {cap(uCompra)} = {factor} {UNIDAD[uCons] || uCons}</span>
            </div>
          )}
          <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Campo label="Este precio es de"><select value={plazoP} onChange={e => cambiarPlazoP(Number(e.target.value))} style={{ ...inp, width: '130px' }}>{PLAZOS.map(pz => <option key={pz} value={pz}>{PLAZO_LBL[pz]}</option>)}</select></Campo>
            <Campo label={`Precio por ${entrada === 'compra' ? (UNIDAD[uCompra] || cap(uCompra)) : (UNIDAD[uCons] || cap(uCons))}`}>
              <input inputMode="decimal" autoFocus value={v} onChange={e => setV(e.target.value)} placeholder="—" style={{ ...inp, width: '120px', textAlign: 'right' }} />
              {equiv != null && <div style={{ fontSize: '10px', color: GRIS, marginTop: '3px', textAlign: 'right' }}>= {dinero(equiv)}/{entrada === 'compra' ? (UNIDAD[uCons] || uCons) : (UNIDAD[uCompra] || uCompra)}</div>}
            </Campo>
            <Campo label="Rige desde"><input type="date" value={desdeP} onChange={e => setDesdeP(e.target.value)} style={inp} /></Campo>
            <button disabled={!(val > 0) || selP.length === 0 || envP} onClick={async () => { setEnvP(true); await onGuardarPrecio({ [plazoP]: val }, entrada, desdeP, selP); setEnvP(false) }} style={{ ...btnPri, opacity: (!(val > 0) || selP.length === 0 || envP) ? 0.5 : 1 }}>{envP ? 'Guardando...' : 'Aplicar precio'}</button>
          </div>
          {chips(selP, setSelP)}
        </div>
      )}

      <div style={{ marginTop: '12px' }}><button onClick={onCancelar} style={btn}>Cerrar</button></div>
    </div>
  )
}

function EditorPlazo({ fincas, fincaActual, actual, onGuardar, onCancelar }) {
  const [plazo, setPlazo] = useState(actual ?? 0)
  const [desde, setDesde] = useState(hoyISO())
  const [enviando, setEnviando] = useState(false)
  const [sel, setSel] = useState([fincaActual.id])
  const otras = (fincas || []).filter(f => f.id !== fincaActual.id)
  const toggle = id => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  return (
    <div style={{ background: '#eef3f7', padding: '12px', borderBottom: '0.5px solid #eef3f7' }}>
      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Campo label="Se compra a">
          <select value={plazo} onChange={e => setPlazo(Number(e.target.value))} style={{ ...inp, width: '130px' }}>
            {PLAZOS.map(pz => <option key={pz} value={pz}>{PLAZO_LBL[pz]}</option>)}
          </select>
        </Campo>
        <Campo label="Rige desde"><input type="date" value={desde} onChange={e => setDesde(e.target.value)} style={inp} /></Campo>
        <button disabled={sel.length === 0 || enviando} onClick={async () => { setEnviando(true); await onGuardar(plazo, desde, sel); setEnviando(false) }}
          style={{ ...btnPri, opacity: (sel.length === 0 || enviando) ? 0.5 : 1 }}>{enviando ? 'Guardando...' : 'Aplicar'}</button>
        <button onClick={onCancelar} style={btn}>Cancelar</button>
      </div>
      <div style={{ fontSize: '11px', color: GRIS, marginTop: '6px' }}>Desde esa fecha, todo lo que ingrese de este producto en la finca se costea a ese plazo. El bodeguero no lo ve.</div>
      {otras.length > 0 && (
        <div style={{ marginTop: '10px' }}>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '6px' }}>Aplicar este plazo a:</div>
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

function EditorUnidadFinca({ insumo, finca, fincas, presentaciones, actual, onNuevaPresentacion, onHecho, onError, onCancelar }) {
  const [presentacion, setPresentacion] = useState(actual.unidad_compra || 'Saco')
  const [contenido, setContenido] = useState(actual.contenido != null ? String(actual.contenido) : (actual.factor != null ? String(actual.factor) : ''))
  const [unidad, setUnidad] = useState(actual.unidad)           // se aplica en
  const [uCont, setUCont] = useState(actual.unidad_contenido || actual.unidad)  // unidad del contenido
  const [minimo, setMinimo] = useState(actual.stock_minimo != null ? String(actual.stock_minimo) : '')
  const [objetivo, setObjetivo] = useState(actual.stock_objetivo != null ? String(actual.stock_objetivo) : '')
  // Densidad: ratio "uApp por 1 uCont" que escribe el jefe. Solo se usa al cruzar familias.
  const uc0 = actual.unidad_contenido || actual.unidad
  const dInit = (insumo?.densidad != null && cruzaFamilia(uc0, actual.unidad))
    ? rDesdeDens(Number(insumo.densidad), uc0, actual.unidad) : null
  const [dens, setDens] = useState(dInit != null ? String(Math.round(dInit * 10000) / 10000) : '')
  const [enviando, setEnviando] = useState(false)
  const [sel, setSel] = useState([finca.id])
  const otras = (fincas || []).filter(f => f.id !== finca.id)
  const toggle = id => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])

  // Conteo no cruza; masa<->líquido sí (con densidad). Solo se realinea
  // cuando uno de los dos lados es conteo.
  const cambiarUnidad = (u) => {
    setUnidad(u)
    const fu = U_FAMILIA(u), fc = U_FAMILIA(uCont)
    if (fu !== fc && (fu === 'conteo' || fc === 'conteo')) setUCont(u)
  }
  const cambiarUCont = (u) => {
    setUCont(u)
    const fu = U_FAMILIA(unidad), fc = U_FAMILIA(u)
    if (fu !== fc && (fu === 'conteo' || fc === 'conteo')) setUnidad(u)
  }
  // "Completo": aplicar por envase entero (1 = 1). Se cuenta en unidades.
  const cambiarAplica = (v) => {
    if (v === '__completo') { setUnidad('unidad'); setContenido('1'); setUCont('unidad') }
    else cambiarUnidad(v)
  }
  // ¿Está en modo "completo"? (se aplica en unidad, 1 por envase)
  const esCompleto = unidad === 'unidad' && numDec(contenido) === 1 && uCont === 'unidad'
  const cruza = cruzaFamilia(uCont, unidad)
  // densidad interna (kg/L = g/mL) desde el ratio escrito.
  const densD = cruza ? densInterna(numDec(dens), uCont, unidad) : null
  const factor = factorDe(contenido, uCont, unidad, densD)
  const listo = sel.length > 0 && presentacion.trim() && factor != null && factor > 0
                && (!cruza || (densD != null && densD > 0))

  async function aplicarUna(fid) {
    // 1) Si cambió la unidad de aplicación, convierte el histórico de esa finca.
    //    Cuando cruza masa<->líquido, p_por lleva la densidad (kg/L).
    if (unidad !== actual.unidad) {
      const { error } = await supabase.schema('produccion').rpc('fn_cambiar_unidad_insumo_finca',
        { p_insumo: insumo.id, p_finca: fid, p_nueva: unidad, ...(cruza && densD ? { p_por: densD } : {}) })
      if (error) return error
    }
    // 2) Guarda presentación, contenido, unidad y mínimo (factor calculado).
    const { error } = await supabase.schema('produccion').from('insumo_finca')
      .upsert({ insumo_id: insumo.id, finca_id: fid, unidad, unidad_compra: presentacion.trim(),
                contenido: numDec(contenido), unidad_contenido: uCont, factor,
                stock_minimo: numDec(minimo) > 0 ? numDec(minimo) : null,
                stock_objetivo: numDec(objetivo) > 0 ? numDec(objetivo) : null }, { onConflict: 'insumo_id,finca_id' })
    return error
  }

  async function guardar() {
    if (!listo) return
    setEnviando(true)
    for (const fid of sel) {
      const err = await aplicarUna(fid)
      if (err) { setEnviando(false); onError(err.message.replace(/^.*?:\s*/, '')); return }
    }
    setEnviando(false)
    const n = sel.length
    onHecho(n === 1 ? 'Actualizado para ' + String(finca.nombre).toUpperCase() + '.' : `Actualizado en ${n} fincas.`)
  }

  async function crearPresentacion() {
    const nom = window.prompt('Nueva presentación (ej. Galonera):')
    if (!nom || !nom.trim()) return
    const limpio = nom.trim().charAt(0).toUpperCase() + nom.trim().slice(1)
    await onNuevaPresentacion(limpio)
    setPresentacion(limpio)
  }

  return (
    <div style={{ background: '#eef3f7', padding: '12px', borderBottom: '0.5px solid #eef3f7' }}>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Campo label="Llega en">
          <select value={presentacion} onChange={e => e.target.value === '__nueva' ? crearPresentacion() : setPresentacion(e.target.value)} style={{ ...inp, width: '150px' }}>
            {[...new Set([presentacion, ...(presentaciones || [])])].filter(Boolean).map(pn => <option key={pn} value={pn}>{pn}</option>)}
            <option value="__nueva">+ crear presentación…</option>
          </select>
        </Campo>
        <Campo label="Cada una trae">
          <input inputMode="decimal" value={contenido} onChange={e => setContenido(e.target.value)} placeholder="ej. 25" style={{ ...inp, width: '90px', textAlign: 'right' }} />
        </Campo>
        <Campo label="Unidad del contenido">
          <select value={uCont} onChange={e => cambiarUCont(e.target.value)} style={{ ...inp, width: '190px' }}>
            <optgroup label="Masa">{UNIDADES_APP.filter(u => U_FAMILIA(u) === 'masa').map(u => <option key={u} value={u}>{U_LABEL[u]}</option>)}</optgroup>
            <optgroup label="Líquido">{UNIDADES_APP.filter(u => U_FAMILIA(u) === 'liquido').map(u => <option key={u} value={u}>{U_LABEL[u]}</option>)}</optgroup>
            <optgroup label="Conteo">{UNIDADES_APP.filter(u => U_FAMILIA(u) === 'conteo').map(u => <option key={u} value={u}>{U_LABEL[u]}</option>)}</optgroup>
          </select>
        </Campo>
        <Campo label="Se aplica en">
          <select value={esCompleto ? '__completo' : unidad} onChange={e => cambiarAplica(e.target.value)} style={{ ...inp, width: '190px' }}>
            <optgroup label="Completo (envase entero)"><option value="__completo">{cap(presentacion || 'Envase')} completo</option></optgroup>
            <optgroup label="Masa">{UNIDADES_APP.filter(u => U_FAMILIA(u) === 'masa').map(u => <option key={u} value={u}>{U_LABEL[u]}</option>)}</optgroup>
            <optgroup label="Líquido">{UNIDADES_APP.filter(u => U_FAMILIA(u) === 'liquido').map(u => <option key={u} value={u}>{U_LABEL[u]}</option>)}</optgroup>
            <optgroup label="Conteo">{UNIDADES_APP.filter(u => U_FAMILIA(u) === 'conteo').map(u => <option key={u} value={u}>{U_LABEL[u]}</option>)}</optgroup>
          </select>
        </Campo>
      </div>

      {/* Densidad: aparece SOLO cuando cruza masa<->líquido. La etiqueta
          sigue la dirección elegida: "1 kg = ___ litros" o al revés. */}
      {cruza && (
        <div style={{ marginTop: '10px', background: '#FFF7E8', border: '0.5px solid #f0dcae',
                      borderRadius: '9px', padding: '10px 12px' }}>
          <div style={{ fontSize: '12px', color: '#8a5a12', marginBottom: '7px' }}>
            Este producto pasa de {U_FAMILIA(uCont) === 'masa' ? 'peso' : 'volumen'} a {U_FAMILIA(unidad) === 'masa' ? 'peso' : 'volumen'}.
            Dinos cuánto rinde para poder convertir:
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
            <span>1 {UNIDAD[uCont] || uCont} =</span>
            <input inputMode="decimal" value={dens} onChange={e => setDens(e.target.value)}
              placeholder="ej. 0.71" style={{ ...inp, width: '90px', textAlign: 'right' }} />
            <span>{UNIDAD[unidad] || unidad}</span>
          </div>
        </div>
      )}

      {factor != null && contenido && (
        <div style={{ fontSize: '12.5px', color: VERDE, background: '#E1F5EE', border: '0.5px solid #cfe9df', borderRadius: '9px', padding: '8px 11px', marginTop: '10px', display: 'inline-block' }}>
          {cruza ? 'Conversión' : 'Conversión automática'}: 1 {cap(presentacion)} = {contenido} {UNIDAD[uCont] || uCont} = <b>{Math.round(factor * 10000) / 10000} {UNIDAD[unidad] || unidad}</b>
        </div>
      )}

      <div style={{ marginTop: '10px', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <Campo label={`Mínimo para alerta (${UNIDAD[unidad] || unidad})`}>
          <input inputMode="decimal" value={minimo} onChange={e => setMinimo(e.target.value)} placeholder="opcional" style={{ ...inp, width: '150px', textAlign: 'right' }} />
        </Campo>
        <Campo label={`Objetivo / inventario ideal (${UNIDAD[unidad] || unidad})`}>
          <input inputMode="decimal" value={objetivo} onChange={e => setObjetivo(e.target.value)} placeholder="opcional" style={{ ...inp, width: '150px', textAlign: 'right' }} />
        </Campo>
      </div>
      {numDec(minimo) > 0 && numDec(objetivo) > 0 && numDec(objetivo) < numDec(minimo) && (
        <div style={{ fontSize: '11px', color: ROJO, marginTop: '6px' }}>El objetivo debería ser mayor o igual que el mínimo.</div>
      )}

      {otras.length > 0 && (
        <div style={{ marginTop: '10px' }}>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '6px' }}>Aplicar lo mismo a:</div>
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
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button disabled={!listo || enviando} onClick={guardar} style={{ ...btnPri, opacity: (!listo || enviando) ? 0.5 : 1 }}>{enviando ? 'Guardando...' : 'Guardar'}</button>
        <button onClick={onCancelar} style={btn}>Cancelar</button>
      </div>
      {contenido && factor == null && <div style={{ fontSize: '11px', color: ROJO, marginTop: '6px' }}>El contenido debe estar en la misma familia que la unidad de aplicación.</div>}
    </div>
  )
}

// Editor de mínimo/objetivo por producto/finca (balanceado), en sacos.
function EditorMinBal({ producto, finca, fincas, actual, onHecho, onError, onCancelar }) {
  const [minimo, setMinimo] = useState(actual?.stock_minimo != null ? String(actual.stock_minimo) : '')
  const [objetivo, setObjetivo] = useState(actual?.stock_objetivo != null ? String(actual.stock_objetivo) : '')
  const [sel, setSel] = useState([finca.id])
  const [enviando, setEnviando] = useState(false)
  const otras = (fincas || []).filter(f => f.id !== finca.id)
  const toggle = id => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])

  async function guardar() {
    setEnviando(true)
    const rows = sel.map(fid => ({
      producto_id: producto.id, finca_id: fid,
      stock_minimo: numDec(minimo) > 0 ? numDec(minimo) : null,
      stock_objetivo: numDec(objetivo) > 0 ? numDec(objetivo) : null,
    }))
    const { error } = await supabase.schema('produccion').from('producto_finca')
      .upsert(rows, { onConflict: 'producto_id,finca_id' })
    setEnviando(false)
    if (error) { onError(error.message); return }
    onHecho(sel.length === 1 ? 'Mínimo/objetivo guardado.' : `Aplicado a ${sel.length} fincas.`)
  }

  return (
    <div style={{ background: '#eef3f7', padding: '12px', borderBottom: '0.5px solid #eef3f7' }}>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Campo label="Mínimo para alerta (sacos)">
          <input inputMode="decimal" value={minimo} onChange={e => setMinimo(e.target.value)} placeholder="opcional" style={{ ...inp, width: '150px', textAlign: 'right' }} />
        </Campo>
        <Campo label="Objetivo / inventario ideal (sacos)">
          <input inputMode="decimal" value={objetivo} onChange={e => setObjetivo(e.target.value)} placeholder="opcional" style={{ ...inp, width: '150px', textAlign: 'right' }} />
        </Campo>
      </div>
      {numDec(minimo) > 0 && numDec(objetivo) > 0 && numDec(objetivo) < numDec(minimo) && (
        <div style={{ fontSize: '11px', color: ROJO, marginTop: '6px' }}>El objetivo debería ser mayor o igual que el mínimo.</div>
      )}
      {otras.length > 0 && (
        <div style={{ marginTop: '10px' }}>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '6px' }}>Aplicar lo mismo a:</div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', background: '#dbe6f0', borderRadius: '20px', padding: '5px 11px' }}>{String(finca.nombre).toUpperCase()} (esta)</span>
            {otras.map(f => {
              const on = sel.includes(f.id)
              return <button key={f.id} onClick={() => toggle(f.id)} style={{ fontSize: '12px', borderRadius: '20px', padding: '5px 11px', cursor: 'pointer', fontFamily: 'inherit', border: '0.5px solid ' + (on ? '#9cc4e8' : BORDE), background: on ? '#E6F1FB' : 'white', color: on ? AZUL : NAVY, fontWeight: on ? 500 : 400 }}>{on ? '✓ ' : ''}{String(f.nombre).toUpperCase()}</button>
            })}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button disabled={enviando} onClick={guardar} style={{ ...btnPri, opacity: enviando ? 0.5 : 1 }}>{enviando ? 'Guardando...' : 'Guardar'}</button>
        <button onClick={onCancelar} style={btn}>Cancelar</button>
      </div>
    </div>
  )
}

// Configurar TODO de una: presentación, unidad, factor, mínimo, cantidad
// deseable y precio. Se aplica a TODAS las fincas activas; las excepciones
// ajustan la unidad de las que difieren (el factor se calcula solo).
const APP_UNIDADES = ['masa','liquido','conteo']
const famLbl = fam => fam === 'masa' ? 'Masa' : fam === 'liquido' ? 'Líquido' : 'Conteo'

// Popover "Copiar a otras fincas" — sirve para unidad y para precio.
function PopCopia({ tipo, origen, valor, otras, copia, setCopia, onAplicar, yaTiene }) {
  const esU = tipo === 'unidad'
  const acento = esU ? '#9a6a1b' : '#3f7d4e'
  const fondoTag = esU ? '#f6eddb' : '#eaf3ee'
  const bordeTag = esU ? '#e6d5ac' : '#cfe6d6'
  const sel = copia.sel || {}
  const marcadas = otras.filter(f => sel[f.id])
  const chocan = marcadas.filter(f => yaTiene(f.id))
  const toggle = fid => setCopia(c => ({ ...c, sel: { ...c.sel, [fid]: !c.sel[fid] } }))
  return (
    <div style={{ position: 'absolute', zIndex: 20, top: esU ? '66px' : '40px', [esU ? 'left' : 'right']: 0,
      minWidth: '240px', background: 'white', border: '0.5px solid #dfe7ee', borderRadius: '12px',
      boxShadow: '0 12px 32px rgba(20,50,75,.15)', padding: '13px 14px' }}>
      <span style={{ display: 'inline-block', fontSize: '10.5px', fontWeight: 700, color: acento,
        background: fondoTag, border: '0.5px solid ' + bordeTag, borderRadius: '6px', padding: '2px 7px', marginBottom: '9px' }}>
        {esU ? '◆ Unidad' : '● Precio'}
      </span>
      <div style={{ fontSize: '11.5px', color: '#7c8a97', margin: '0 0 9px' }}>
        Copiar {esU ? <>la unidad <b>{valor}</b></> : <>los precios de <b>{origen}</b></>} a:
      </div>
      <div style={{ maxHeight: '190px', overflowY: 'auto' }}>
        {otras.filter(f => f.id).map(f => (
          <label key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '9px', fontSize: '13.5px', padding: '5px 2px', cursor: 'pointer', color: '#173a55' }}>
            <input type="checkbox" checked={!!sel[f.id]} onChange={() => toggle(f.id)} /> {f.nombre}
          </label>
        ))}
      </div>
      {chocan.length > 0 && (
        <div style={{ fontSize: '11.5px', color: '#b5462f', marginTop: '6px' }}>
          {chocan.length === 1
            ? `${chocan[0].nombre} ya tiene ${esU ? 'unidad' : 'precio'}, ¿Reemplazar?`
            : `${chocan.map(f => f.nombre).join(', ')} ya tienen ${esU ? 'unidad' : 'precio'}, ¿Reemplazar?`}
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '11px', borderTop: '0.5px solid #eef3f7', paddingTop: '11px' }}>
        <button disabled={marcadas.length === 0} onClick={onAplicar}
          style={{ background: marcadas.length ? '#173a55' : '#c3d0db', color: 'white', border: 'none', borderRadius: '8px', padding: '7px 14px', fontSize: '12.5px', fontFamily: 'inherit', cursor: marcadas.length ? 'pointer' : 'default' }}>
          Copiar {esU ? 'unidad' : 'precio'} a {marcadas.length}
        </button>
        <button onClick={() => setCopia(null)} style={{ background: 'none', border: 'none', color: '#7c8a97', fontSize: '12.5px', fontFamily: 'inherit', cursor: 'pointer' }}>Cancelar</button>
      </div>
    </div>
  )
}

function EditorConfigTodo({ insumo, fincas, presentaciones, actual, excIni, onHecho, onError, onCancelar }) {
  const a = actual || {}
  const activas = (fincas || []).filter(f => String(f.nombre).toUpperCase() !== 'PRUEBA')
  const [presentacion, setPresentacion] = useState(cap1(a.unidad_compra || insumo.unidad_compra) || 'Saco')
  const [presLista, setPresLista] = useState([...new Set((presentaciones || []).map(cap1))])
  const [contenido, setContenido] = useState(
    a.contenido != null ? String(a.contenido) : (a.factor != null ? String(a.factor) : (insumo.factor != null ? String(insumo.factor) : '')))
  // Solo aceptamos unidades de aplicación válidas; si la guardada es una
  // presentación (ej. "sacos"), dejamos en blanco para que elija bien.
  const uIni = a.unidad || insumo.unidad
  const uContIni = a.unidad_contenido || a.unidad || insumo.unidad
  const [uCont, setUCont] = useState(UNIDADES_APP.includes(uContIni) ? uContIni : 'kg')
  // "Envase entero" si la unidad no es de aplicación, o si es 'unidad' pero
  // con un peso de referencia en otra unidad (ej. 1 saco = 45 kg).
  const compIni = !UNIDADES_APP.includes(uIni) || (uIni === 'unidad' && uContIni && uContIni !== 'unidad')
  const [unidad, setUnidad] = useState(compIni ? '__completo' : uIni)   // '__completo' = envase entero
  // Precarga las excepciones ya guardadas (qué finca aplica distinto), para
  // que al abrir Configurar veas lo que pusiste antes.
  const [exc, setExc] = useState(() => (excIni || []).map(e => ({
    fincaId: e.fincaId, unidad: e.unidad || '', desde: e.desde || '',
    precios: e.precios || {}, plazoRige: e.plazoRige ?? null, abierto: !!e.abierto })))
  // Popover de copiar: { tipo:'unidad'|'precio', idx, sel:{fincaId:true} }
  const [copia, setCopia] = useState(null)
  // Panel "Aplicar a varias fincas" a la vez.
  const bulkVacio = { open: false, fincas: {}, usarUnidad: false, unidad: '', usarPrecio: false, precios: {}, plazoRige: null, desde: '' }
  const [bulk, setBulk] = useState(bulkVacio)
  const [minimo, setMinimo] = useState(a.stock_minimo != null ? String(a.stock_minimo) : '')
  const [deseable, setDeseable] = useState(a.stock_objetivo != null ? String(a.stock_objetivo) : '')
  // Los precios guardados están por unidad de aplicación. Los precargamos
  // POR ENVASE (× factor), que es como los ingresaste, para que veas el
  // mismo número que pusiste.
  const facPre = Number(a.factor) || factorDe(
    a.contenido != null ? a.contenido : (a.factor != null ? a.factor : insumo.factor),
    a.unidad_contenido || a.unidad || insumo.unidad, a.unidad || insumo.unidad) || 1
  const [precios, setPrecios] = useState(() => {
    const p = {}; PLAZOS.forEach(pz => { const v = a.precios?.[pz]; if (v != null) p[pz] = String(Math.round(v * facPre * 10000) / 10000) }); return p
  })
  const [precioPor, setPrecioPor] = useState('presentacion')
  const [plazoActivo, setPlazoActivo] = useState(a.plazoActivo ?? 0)   // qué plazo rige ahora
  const [desde, setDesde] = useState(a.desde || hoyISO())   // precarga la fecha del precio actual
  const [enviando, setEnviando] = useState(false)

  // Densidad del producto (kg/L). Se usa cuando alguna finca aplica en una
  // familia distinta (peso<->volumen). Global al producto.
  const [densD, setDensD] = useState(insumo?.densidad != null ? Number(insumo.densidad) : null)
  const [densTxt, setDensTxt] = useState('')  // texto que se está escribiendo

  const esComp = unidad === '__completo'
  // En "envase entero" se cuenta por la presentación. Se guarda como
  // 'unidad' (enum válido) y factor 1; la presentación se muestra aparte.
  const uStd = esComp ? 'unidad' : unidad
  const factor = esComp ? 1 : factorDe(contenido, uCont, unidad, densD)
  const listo = presentacion.trim() && factor != null && factor > 0
  const factorFinca = u => u === '__completo' ? 1 : factorDe(contenido, uCont, u, densD)

  // --- helpers de la sección "aplica distinto" ---
  const setRow = (i, campo, valor) => setExc(x => x.map((r, j) => j === i ? { ...r, [campo]: valor } : r))
  const setRowPrecio = (i, pz, valor) => setExc(x => x.map((r, j) => {
    if (j !== i) return r
    // El primer precio que escribe marca ese plazo como "el que rige".
    const plazoRige = (r.plazoRige == null && numDec(valor) > 0) ? pz : r.plazoRige
    return { ...r, precios: { ...r.precios, [pz]: valor }, plazoRige }
  }))
  const addExc = () => setExc(x => [...x, { fincaId: '', unidad: '', desde: '', precios: {}, plazoRige: null, abierto: false }])
  const rmExc = i => setExc(x => x.filter((_, j) => j !== i))
  const fincaNom = id => (activas.find(f => f.id === id)?.nombre) || 'esa finca'
  const rowTienePrecio = r => PLAZOS.some(pz => numDec(r.precios?.[pz] || '') > 0)
  // Abre el popover de copiar (unidad o precio) preseleccionando ninguna.
  const abrirCopia = (tipo, idx) => setCopia({ tipo, idx, sel: {} })
  // Aplica la copia: pega la unidad o los precios de la fila origen a las
  // fincas destino, creando su fila si no existe.
  const aplicarCopia = () => {
    if (!copia) return
    const origen = exc[copia.idx]; if (!origen) return
    const destinos = Object.keys(copia.sel).filter(fid => copia.sel[fid])
    setExc(x => {
      const arr = [...x]
      destinos.forEach(fid => {
        let j = arr.findIndex(r => r.fincaId === fid)
        if (j === -1) { arr.push({ fincaId: fid, unidad: '', desde: '', precios: {}, plazoRige: null, abierto: false }); j = arr.length - 1 }
        if (copia.tipo === 'unidad') arr[j] = { ...arr[j], unidad: origen.unidad }
        else arr[j] = { ...arr[j], precios: { ...origen.precios }, plazoRige: origen.plazoRige, desde: origen.desde || arr[j].desde, abierto: true }
      })
      return arr
    })
    setCopia(null)
  }

  // Aplica el cambio a TODAS las fincas marcadas de una sola vez.
  const bulkFincas = () => Object.keys(bulk.fincas).filter(id => bulk.fincas[id])
  const bulkPuede = bulkFincas().length > 0 && (bulk.usarUnidad || bulk.usarPrecio)
  function aplicarBulk() {
    const destinos = bulkFincas()
    if (!destinos.length) return
    setExc(x => {
      const arr = [...x]
      destinos.forEach(fid => {
        let j = arr.findIndex(r => r.fincaId === fid)
        if (j === -1) { arr.push({ fincaId: fid, unidad: '', desde: '', precios: {}, plazoRige: null, abierto: false }); j = arr.length - 1 }
        const upd = { ...arr[j] }
        if (bulk.usarUnidad) upd.unidad = bulk.unidad
        if (bulk.usarPrecio) { upd.precios = { ...bulk.precios }; upd.plazoRige = bulk.plazoRige; upd.abierto = true }
        if (bulk.desde) upd.desde = bulk.desde
        arr[j] = upd
      })
      return arr
    })
    setBulk(bulkVacio)
  }

  async function crearPresentacion() {
    const nom = window.prompt('Nueva presentación (ej. Galonera):')
    if (!nom || !nom.trim()) return
    const limpio = cap1(nom.trim())
    await supabase.schema('produccion').from('presentacion').insert({ nombre: limpio })
    setPresLista(ps => [...new Set([...ps, limpio])].sort())
    setPresentacion(limpio)
  }

  // Precio por aplicación para un plazo dado y el factor de la finca.
  function precioAppDe(pz, fac) {
    const raw = numDec(precios[pz] || '')
    if (!(raw > 0) || !fac) return null
    return precioPor === 'presentacion' ? raw / fac : raw
  }
  const hayAlgunPrecio = PLAZOS.some(pz => numDec(precios[pz] || '') > 0)

  async function guardar() {
    if (!listo) { onError('Revisa la presentación y el contenido (factor).'); return }
    setEnviando(true)
    try {
      const excUnit = {}; exc.forEach(e => { if (e.fincaId && e.unidad) excUnit[e.fincaId] = e.unidad })
      const facMap = {}; const ids = []; const filas = []
      for (const f of activas) {
        // '__completo' es "envase entero": se guarda como 'unidad' (enum
        // válido) con factor 1, igual que el estándar.
        const uFinca = excUnit[f.id] ? (excUnit[f.id] === '__completo' ? 'unidad' : excUnit[f.id]) : uStd
        const facFinca = excUnit[f.id] ? factorFinca(excUnit[f.id]) : factor
        if (facFinca == null || facFinca <= 0) { onError(`Conversión inválida para ${f.nombre} (unidad de otra familia).`); setEnviando(false); return }
        facMap[f.id] = facFinca; ids.push(f.id)
        filas.push({ insumo_id: insumo.id, finca_id: f.id, unidad: uFinca, unidad_compra: presentacion.trim(),
          contenido: numDec(contenido) > 0 ? numDec(contenido) : 1, unidad_contenido: uCont, factor: facFinca,
          stock_minimo: numDec(minimo) > 0 ? numDec(minimo) : null,
          stock_objetivo: numDec(deseable) > 0 ? numDec(deseable) : null })
      }
      // 0) Si cambió la unidad de aplicación de una finca, convertir el
      //    histórico ANTES de guardar (igual que "Ajustar unidad"). Así el
      //    consumo viejo se pasa de gramos a kilos, etc., y no se descuadra.
      const { data: ufAct } = await supabase.schema('produccion').from('insumo_finca')
        .select('finca_id, unidad').eq('insumo_id', insumo.id)
      const uActual = {}; (ufAct || []).forEach(r => { uActual[r.finca_id] = r.unidad })
      // Toda finca a la que le cambió la unidad se convierte AQUÍ mismo con la
      // misma función que usa "Ajustar unidad". Si hace falta la equivalencia
      // (cuánto trae un saco/envase), se pregunta una sola vez por tipo de
      // cambio y se reutiliza en las demás fincas. Sin rebotar a otra pantalla.
      const convertidas = new Set()
      const porCache = {}
      for (const fila of filas) {
        const antes = uActual[fila.finca_id] || insumo.unidad
        if (fila.unidad === antes) continue
        const nom = activas.find(f => f.id === fila.finca_id)?.nombre || 'esa finca'
        let { error: eU } = await supabase.schema('produccion').rpc('fn_cambiar_unidad_insumo_finca',
          { p_insumo: insumo.id, p_finca: fila.finca_id, p_nueva: fila.unidad })
        if (eU && /FALTA_POR/.test(eU.message)) {
          const clave = antes + '->' + fila.unidad
          let por = porCache[clave]
          if (por == null) {
            const MASA = ['gramos', 'kg', 'libras', 'ml', 'litros']
            const um = MASA.includes(antes) ? antes : fila.unidad
            const uc = MASA.includes(antes) ? fila.unidad : antes
            const singular = { sacos: 'saco', unidad: 'envase' }[uc] || uc
            const resp = window.prompt(`¿Cuántos ${UNIDAD[um] || um} trae un ${singular} de "${insumo.nombre}"?\n(para convertir el histórico que ya tiene)`)
            if (resp === null) { setEnviando(false); return }
            por = numDec(resp)
            if (!(por > 0)) { onError('Pon un número mayor que cero para la equivalencia.'); setEnviando(false); return }
            porCache[clave] = por
          }
          ;({ error: eU } = await supabase.schema('produccion').rpc('fn_cambiar_unidad_insumo_finca',
            { p_insumo: insumo.id, p_finca: fila.finca_id, p_nueva: fila.unidad, p_por: por }))
        }
        if (eU) { onError('No se pudo convertir ' + nom + '. ' + eU.message.replace(/^.*?:\s*/, '').replace('FALTA_POR', 'Falta la equivalencia.')); setEnviando(false); return }
        convertidas.add(fila.finca_id)
      }

      // 1) Unidades/mínimos: un solo upsert en bloque. Las fincas que se
      //    acaban de convertir arriba ya tienen su unidad/factor correctos por
      //    la función; a esas solo se les toca el mínimo/objetivo para no pisar
      //    la conversión.
      const filasUpsert = filas.map(fl => convertidas.has(fl.finca_id)
        ? { insumo_id: fl.insumo_id, finca_id: fl.finca_id, stock_minimo: fl.stock_minimo, stock_objetivo: fl.stock_objetivo }
        : fl)
      const { error: e1 } = await supabase.schema('produccion').from('insumo_finca').upsert(filasUpsert, { onConflict: 'insumo_id,finca_id' })
      if (e1) throw e1

      // 1b) Densidad del producto (para el puente peso<->volumen). Global.
      if (densD != null && densD > 0 && densD !== Number(insumo.densidad)) {
        const { error: eD } = await supabase.schema('produccion').from('insumo').update({ densidad: densD }).eq('id', insumo.id)
        if (eD) throw eD
      }

      // Cierra el precio anterior y abre el nuevo (con su fecha de vigencia).
      const cerrarYAbrir = async (fincaIds, pz, rows, dfecha) => {
        if (!fincaIds.length) return
        await supabase.schema('produccion').from('precio_insumo').delete()
          .eq('insumo_id', insumo.id).eq('plazo', pz).in('finca_id', fincaIds).gte('vigente_desde', dfecha)
        await supabase.schema('produccion').from('precio_insumo').update({ vigente_hasta: sumarDias(dfecha, -1) })
          .eq('insumo_id', insumo.id).eq('plazo', pz).in('finca_id', fincaIds).is('vigente_hasta', null).lt('vigente_desde', dfecha)
        const { error } = await supabase.schema('produccion').from('precio_insumo').insert(rows)
        if (error) throw error
      }

      // 2) Precios estándar por plazo. Si el plazo tiene precio, se abre;
      //    si quedó vacío/0, se BORRA el precio vigente de ese plazo.
      for (const pz of PLAZOS) {
        const raw = numDec(precios[pz] || '')
        if (raw > 0) {
          const rows = ids.map(fid => ({ insumo_id: insumo.id, finca_id: fid, plazo: pz,
            precio_unitario: precioPor === 'presentacion' ? raw / facMap[fid] : raw, vigente_desde: desde }))
          await cerrarYAbrir(ids, pz, rows, desde)
        } else {
          const { error: eDel } = await supabase.schema('produccion').from('precio_insumo').delete()
            .eq('insumo_id', insumo.id).eq('plazo', pz).in('finca_id', ids).is('vigente_hasta', null)
          if (eDel) throw eDel
        }
      }

      // 3) Excepciones de precio por finca (pisan el estándar). Cada finca
      //    puede tener precio propio en varios plazos, con su fecha.
      for (const e of exc) {
        if (!e.fincaId) continue
        const fac = facMap[e.fincaId]; if (!fac) continue
        const dfe = e.desde || desde
        for (const pz of PLAZOS) {
          const raw = numDec(e.precios?.[pz] || ''); if (!(raw > 0)) continue
          const precioApp = precioPor === 'presentacion' ? raw / fac : raw
          await cerrarYAbrir([e.fincaId], pz, [{ insumo_id: insumo.id, finca_id: e.fincaId, plazo: pz, precio_unitario: precioApp, vigente_desde: dfe }], dfe)
        }
      }

      // 4) Plazo que rige ahora. Estándar para todas; luego cada excepción
      //    con su propio "rige" pisa a su finca.
      // Si el plazo elegido para regir no tiene precio pero otro sí, se apunta
      // al primero con precio (así el catálogo muestra precio y el costeo funciona).
      let rigeStd = plazoActivo
      if (rigeStd != null && !(numDec(precios[rigeStd] || '') > 0)) {
        const conP = PLAZOS.find(pz => numDec(precios[pz] || '') > 0)
        if (conP != null) rigeStd = conP
      }
      const plazoRigeFinca = {}   // fincaId -> plazo, con su fecha
      exc.forEach(e => { if (e.fincaId && e.plazoRige != null) plazoRigeFinca[e.fincaId] = { pz: e.plazoRige, dfe: e.desde || desde } })
      if (rigeStd != null) {
        const stdIds = ids.filter(fid => !(fid in plazoRigeFinca))
        if (stdIds.length) {
          await supabase.schema('produccion').from('plazo_insumo').delete()
            .eq('insumo_id', insumo.id).in('finca_id', stdIds).gte('vigente_desde', desde)
          await supabase.schema('produccion').from('plazo_insumo').update({ vigente_hasta: sumarDias(desde, -1) })
            .eq('insumo_id', insumo.id).in('finca_id', stdIds).is('vigente_hasta', null).lt('vigente_desde', desde)
          const { error: e4 } = await supabase.schema('produccion').from('plazo_insumo')
            .insert(stdIds.map(fid => ({ insumo_id: insumo.id, finca_id: fid, plazo: rigeStd, vigente_desde: desde })))
          if (e4) throw e4
        }
      }
      for (const [fid, { pz, dfe }] of Object.entries(plazoRigeFinca)) {
        await supabase.schema('produccion').from('plazo_insumo').delete()
          .eq('insumo_id', insumo.id).eq('finca_id', fid).gte('vigente_desde', dfe)
        await supabase.schema('produccion').from('plazo_insumo').update({ vigente_hasta: sumarDias(dfe, -1) })
          .eq('insumo_id', insumo.id).eq('finca_id', fid).is('vigente_hasta', null).lt('vigente_desde', dfe)
        const { error: e5 } = await supabase.schema('produccion').from('plazo_insumo')
          .insert([{ insumo_id: insumo.id, finca_id: fid, plazo: pz, vigente_desde: dfe }])
        if (e5) throw e5
      }
      onHecho(`Configurado en ${activas.length} fincas.`)
    } catch (err) { onError(err.message || 'No se pudo guardar.') }
    finally { setEnviando(false) }
  }

  const seccion = { background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '15px 16px', marginBottom: '12px' }
  const tit = { fontSize: '11px', letterSpacing: '.05em', textTransform: 'uppercase', color: GRIS, margin: '0 0 13px', fontWeight: 600 }
  const usados = [...new Set([presentacion, ...presLista])].filter(Boolean)

  return (
    <div style={{ background: '#f0f6f2', padding: '16px 18px', borderBottom: '0.5px solid #e6edf3' }}>
      <div style={{ fontSize: '14px', fontWeight: 600, color: VERDE, marginBottom: '14px' }}>Configurar {insumo.nombre}</div>

      {/* 1. Unidades */}
      <div style={seccion}>
        <div style={tit}>1 · Unidades y conversión</div>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Campo label="Llega en (envase)">
            <select value={presentacion} onChange={e => e.target.value === '__nueva' ? crearPresentacion() : setPresentacion(e.target.value)} style={{ ...inp, width: '160px' }}>
              {usados.map(pn => <option key={pn} value={pn}>{pn}</option>)}
              <option value="__nueva">＋ Agregar presentación…</option>
            </select>
          </Campo>
          <Campo label={esComp ? 'Peso del envase (ref.)' : 'Cada envase trae'}>
            <input inputMode="decimal" value={contenido} onChange={e => setContenido(e.target.value)} placeholder="ej. 45" style={{ ...inp, width: '90px', textAlign: 'right' }} />
          </Campo>
          <Campo label={esComp ? 'Unidad del peso' : 'Unidad del contenido'}>
            <select value={uCont} onChange={e => { setUCont(e.target.value); if (!esComp && U_FAMILIA(e.target.value) !== U_FAMILIA(unidad)) setUnidad(e.target.value) }} style={{ ...inp, width: '175px' }}>
              {APP_UNIDADES.map(fam => <optgroup key={fam} label={famLbl(fam)}>{UNIDADES_APP.filter(u => U_FAMILIA(u) === fam).map(u => <option key={u} value={u}>{U_LABEL[u]}</option>)}</optgroup>)}
            </select>
          </Campo>
          <Campo label="Se aplica en (estándar)">
            <select value={unidad} onChange={e => { const v = e.target.value; setUnidad(v); if (v && v !== '__completo' && U_FAMILIA(uCont) !== U_FAMILIA(v)) setUCont(v) }} style={{ ...inp, width: '190px', borderColor: unidad ? BORDE : '#e0b64a' }}>
              <option value="">Elige la unidad…</option>
              <optgroup label="Por envase entero"><option value="__completo">Envase completo ({cap1(presentacion)})</option></optgroup>
              {APP_UNIDADES.map(fam => <optgroup key={fam} label={famLbl(fam)}>{UNIDADES_APP.filter(u => U_FAMILIA(u) === fam).map(u => <option key={u} value={u}>{U_LABEL[u]}</option>)}</optgroup>)}
            </select>
          </Campo>
        </div>
        {esComp ? (
          <div style={{ fontSize: '12.5px', color: VERDE, background: '#E1F5EE', border: '0.5px solid #cfe9df', borderRadius: '9px', padding: '8px 12px', marginTop: '12px', display: 'inline-block' }}>
            Se cuenta y consume por <b>{cap1(presentacion)}</b> entero{numDec(contenido) > 0 ? <> · 1 {cap1(presentacion)} = {contenido} {UNIDAD[uCont] || uCont} (referencia)</> : null}
          </div>
        ) : factor != null && contenido ? (
          <div style={{ fontSize: '12.5px', color: VERDE, background: '#E1F5EE', border: '0.5px solid #cfe9df', borderRadius: '9px', padding: '8px 12px', marginTop: '12px', display: 'inline-block' }}>
            1 {cap1(presentacion)} = {contenido} {UNIDAD[uCont] || uCont} = <b>{Math.round(factor * 10000) / 10000} {UNIDAD[uStd] || uStd}</b>
          </div>
        ) : null}
        {contenido && !esComp && factor == null && <div style={{ fontSize: '11px', color: ROJO, marginTop: '6px' }}>El contenido debe estar en la misma familia que la unidad de aplicación.</div>}
      </div>

      {/* 2. Excepciones */}
      <div style={{ ...seccion, borderColor: '#e8d9b8', background: '#FBF7EE' }}>
        <div style={{ ...tit, color: AMBAR }}>2 · ¿Alguna finca aplica distinto?</div>
        <div style={{ fontSize: '11.5px', color: GRIS, marginBottom: '13px' }}>
          Aplica el mismo cambio a varias fincas de una vez, o agrégalas una por una abajo. Lo que dejes vacío usa el estándar.
        </div>

        {/* Aplicar a varias fincas a la vez */}
        {!bulk.open ? (
          <button onClick={() => setBulk({ ...bulkVacio, open: true })}
            style={{ border: '0.5px solid #d8c48f', background: '#fdf8ec', color: '#8a5a12', borderRadius: '9px',
                     padding: '9px 14px', fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer', marginBottom: '13px' }}>
            ＋ Aplicar a varias fincas
          </button>
        ) : (
          <div style={{ border: '0.5px solid #d8c48f', background: '#fffdf7', borderRadius: '12px', padding: '15px 16px', marginBottom: '14px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: AMBAR, marginBottom: '10px' }}>Aplicar el mismo cambio a varias fincas</div>

            <label style={{ display: 'block', fontSize: '10px', letterSpacing: '.05em', color: GRIS, margin: '0 0 6px' }}>Fincas</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px', marginBottom: '14px' }}>
              {activas.map(f => {
                const on = !!bulk.fincas[f.id]
                return (
                  <button key={f.id} onClick={() => setBulk(b => ({ ...b, fincas: { ...b.fincas, [f.id]: !b.fincas[f.id] } }))}
                    style={{ border: '0.5px solid ' + (on ? NAVY : BORDE), background: on ? NAVY : 'white', color: on ? 'white' : NAVY,
                             borderRadius: '999px', padding: '6px 13px', fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer' }}>
                    {f.nombre}{on ? ' ✓' : ''}
                  </button>
                )
              })}
            </div>

            {/* Unidad */}
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13.5px', cursor: 'pointer', marginBottom: bulk.usarUnidad ? '8px' : '12px' }}>
              <input type="checkbox" checked={bulk.usarUnidad} onChange={e => setBulk(b => ({ ...b, usarUnidad: e.target.checked }))} />
              Cambiar la unidad
            </label>
            {bulk.usarUnidad && (
              <select value={bulk.unidad} onChange={e => setBulk(b => ({ ...b, unidad: e.target.value }))} style={{ ...inp, width: '260px', marginBottom: '14px' }}>
                <option value="">(igual al estándar)</option>
                <optgroup label="Por envase entero"><option value="__completo">Envase entero ({cap1(presentacion)})</option></optgroup>
                {APP_UNIDADES.map(fam => <optgroup key={fam} label={famLbl(fam)}>{UNIDADES_APP.filter(u => U_FAMILIA(u) === fam).map(u => <option key={u} value={u}>{U_LABEL[u]}</option>)}</optgroup>)}
              </select>
            )}

            {/* Precios */}
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13.5px', cursor: 'pointer', marginBottom: bulk.usarPrecio ? '10px' : '12px' }}>
              <input type="checkbox" checked={bulk.usarPrecio} onChange={e => setBulk(b => ({ ...b, usarPrecio: e.target.checked }))} />
              Cambiar el precio
            </label>
            {bulk.usarPrecio && (
              <div style={{ marginBottom: '14px' }}>
                <div style={{ fontSize: '11px', color: GRIS, marginBottom: '7px' }}>Precio por envase ({cap1(presentacion)}) — llena los que apliquen y marca cuál rige</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '8px' }}>
                  {PLAZOS.map(pz => {
                    const on = bulk.plazoRige === pz
                    return (
                      <div key={pz} style={{ textAlign: 'center', border: '0.5px solid ' + (on ? '#e0cd9a' : 'transparent'), background: on ? '#fdf9ee' : 'transparent', borderRadius: '9px', padding: '6px 5px' }}>
                        <div style={{ fontSize: '10.5px', color: on ? AMBAR : GRIS, fontWeight: on ? 700 : 400, marginBottom: '4px' }}>{PLAZO_LBL[pz]}</div>
                        <input inputMode="decimal" value={bulk.precios[pz] ?? ''} placeholder="—"
                          onChange={e => setBulk(b => ({ ...b, precios: { ...b.precios, [pz]: e.target.value }, plazoRige: b.plazoRige == null && numDec(e.target.value) > 0 ? pz : b.plazoRige }))}
                          style={{ ...inp, textAlign: 'right', padding: '6px' }} />
                        <label style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center', fontSize: '10.5px', color: GRIS, marginTop: '5px', cursor: 'pointer' }}>
                          <input type="radio" name="bulk-rige" checked={on} onChange={() => setBulk(b => ({ ...b, plazoRige: pz }))} /> Rige
                        </label>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'end', gap: '16px', flexWrap: 'wrap' }}>
              <div>
                <label style={{ display: 'block', fontSize: '10px', letterSpacing: '.05em', color: GRIS, margin: '0 0 5px' }}>Rige desde</label>
                <input type="date" value={bulk.desde || ''} max={hoyISO()} onChange={e => setBulk(b => ({ ...b, desde: e.target.value }))} style={{ ...inp, width: '170px' }} />
              </div>
              <div style={{ display: 'flex', gap: '9px', marginLeft: 'auto' }}>
                <button onClick={() => setBulk(bulkVacio)} style={{ background: 'none', border: 'none', color: GRIS, fontSize: '13px', fontFamily: 'inherit', cursor: 'pointer' }}>Cancelar</button>
                <button onClick={aplicarBulk} disabled={!bulkPuede}
                  style={{ background: bulkPuede ? NAVY : '#c3d0db', color: 'white', border: 'none', borderRadius: '9px', padding: '9px 16px', fontSize: '13px', fontFamily: 'inherit', cursor: bulkPuede ? 'pointer' : 'default' }}>
                  Aplicar a {bulkFincas().length} finca{bulkFincas().length === 1 ? '' : 's'}
                </button>
              </div>
            </div>
            <div style={{ fontSize: '11px', color: GRIS, marginTop: '9px' }}>Se crea/actualiza la fila de cada finca marcada. Luego puedes ajustar alguna por separado abajo.</div>
          </div>
        )}

        {exc.map((e, i) => {
          const facF = e.unidad && e.unidad !== '__completo' ? factorFinca(e.unidad) : null
          const enlace = { background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: '#8a5a12', fontSize: '11.5px', padding: 0 }
          const otras = activas.filter(f => f.id !== e.fincaId)
          return (
          <div key={i} style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '11px', padding: '13px 14px', marginBottom: '11px', position: 'relative' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.2fr 150px auto', gap: '11px', alignItems: 'start' }}>
              <Campo label="Finca">
                <select value={e.fincaId} onChange={ev => setRow(i, 'fincaId', ev.target.value)} style={inp}>
                  <option value="">Elegir finca</option>
                  {activas.map(f => <option key={f.id} value={f.id}>{f.nombre}</option>)}
                </select>
              </Campo>
              <div style={{ position: 'relative' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <label style={{ fontSize: '11.5px', color: GRIS }}>Se aplica en</label>
                  {e.fincaId && e.unidad && <button style={enlace} onClick={() => abrirCopia('unidad', i)}>Copiar unidad a…</button>}
                </div>
                <select value={e.unidad} onChange={ev => setRow(i, 'unidad', ev.target.value)} style={{ ...inp, marginTop: '5px' }}>
                  <option value="">(igual al estándar)</option>
                  <optgroup label="Por envase entero"><option value="__completo">Envase entero ({cap1(presentacion)})</option></optgroup>
                  {APP_UNIDADES.map(fam => <optgroup key={fam} label={famLbl(fam)}>{UNIDADES_APP.filter(u => U_FAMILIA(u) === fam).map(u => <option key={u} value={u}>{U_LABEL[u]}</option>)}</optgroup>)}
                </select>
                {copia && copia.tipo === 'unidad' && copia.idx === i && (
                  <PopCopia tipo="unidad" origen={fincaNom(e.fincaId)} valor={e.unidad === '__completo' ? `Envase entero (${cap1(presentacion)})` : (UNIDAD[e.unidad] || e.unidad)}
                    otras={otras} copia={copia} setCopia={setCopia} onAplicar={aplicarCopia}
                    yaTiene={fid => { const r = exc.find(x => x.fincaId === fid); return !!(r && r.unidad) }} />
                )}
              </div>
              <Campo label="Rige desde">
                <input type="date" value={e.desde || ''} max={hoyISO()} onChange={ev => setRow(i, 'desde', ev.target.value)} style={inp} />
              </Campo>
              <button onClick={() => rmExc(i)} title="Quitar" style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#c7ccd2', fontSize: '17px', marginTop: '22px' }}>✕</button>
            </div>

            {e.unidad && (e.unidad === '__completo' ? (
              <div style={{ fontSize: '11.5px', color: AMBAR, marginTop: '7px' }}>Se cuenta por <b>{cap1(presentacion)}</b> entero (envase completo).</div>
            ) : facF ? (
              <div style={{ fontSize: '11.5px', color: AMBAR, marginTop: '7px' }}>1 {cap1(presentacion)} = <b>{Math.round(facF * 100) / 100} {UNIDAD[e.unidad] || e.unidad}</b> (misma cantidad, otra unidad)</div>
            ) : cruzaFamilia(uCont, e.unidad) ? (
              <div style={{ marginTop: '7px', background: '#FFF7E8', border: '0.5px solid #f0dcae', borderRadius: '9px', padding: '9px 11px' }}>
                <div style={{ fontSize: '11.5px', color: '#8a5a12', marginBottom: '6px' }}>
                  Pasa de {U_FAMILIA(uCont) === 'masa' ? 'peso' : 'volumen'} a {U_FAMILIA(e.unidad) === 'masa' ? 'peso' : 'volumen'}. Dinos cuánto rinde:
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12.5px' }}>
                  <span>1 {UNIDAD[uCont] || uCont} =</span>
                  <input inputMode="decimal" value={densTxt}
                    onChange={ev => { setDensTxt(ev.target.value); setDensD(densInterna(numDec(ev.target.value), uCont, e.unidad)) }}
                    placeholder="ej. 0.71" style={{ ...inp, width: '80px', textAlign: 'right' }} />
                  <span>{UNIDAD[e.unidad] || e.unidad}</span>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: '11.5px', color: ROJO, marginTop: '7px' }}>Esa unidad es de otra familia — no se puede convertir.</div>
            ))}

            {/* Precio propio por plazo */}
            {!e.abierto ? (
              <div style={{ marginTop: '9px' }}>
                <button style={enlace} onClick={() => setRow(i, 'abierto', true)}>＋ Precio propio</button>
                <span style={{ color: '#c3d0db', fontSize: '11.5px', marginLeft: '8px' }}>— usa el precio estándar</span>
              </div>
            ) : (
              <div style={{ border: '0.5px solid ' + BORDE, borderRadius: '10px', padding: '11px 12px', marginTop: '9px', position: 'relative' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '9px' }}>
                  <span style={{ fontSize: '11.5px', color: GRIS }}>Precio propio · por {precioPor === 'presentacion' ? `envase (${cap1(presentacion)})` : `${UNIDAD[uStd] || uStd}`}</span>
                  {e.fincaId && rowTienePrecio(e) && <button style={enlace} onClick={() => abrirCopia('precio', i)}>Copiar precio a…</button>}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '8px' }}>
                  {PLAZOS.map(pz => {
                    const on = e.plazoRige === pz
                    return (
                    <div key={pz} style={{ textAlign: 'center', border: '0.5px solid ' + (on ? '#e0cd9a' : 'transparent'), background: on ? '#fdf9ee' : 'transparent', borderRadius: '9px', padding: '6px 5px' }}>
                      <div style={{ fontSize: '10.5px', color: on ? AMBAR : GRIS, fontWeight: on ? 700 : 400, marginBottom: '4px' }}>{PLAZO_LBL[pz]}</div>
                      <input inputMode="decimal" value={e.precios?.[pz] ?? ''} placeholder="—" onChange={ev => setRowPrecio(i, pz, ev.target.value)} style={{ ...inp, textAlign: 'right', padding: '6px' }} />
                      <label style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center', fontSize: '10.5px', color: GRIS, marginTop: '5px', cursor: 'pointer' }}>
                        <input type="radio" name={`rige-${i}`} checked={on} onChange={() => setRow(i, 'plazoRige', pz)} /> Rige
                      </label>
                    </div>
                    )
                  })}
                </div>
                <div style={{ fontSize: '11px', color: AMBAR, marginTop: '8px' }}>Marca cuál plazo se cobra hoy en {e.fincaId ? fincaNom(e.fincaId) : 'esta finca'}. Los demás quedan guardados.</div>
                {copia && copia.tipo === 'precio' && copia.idx === i && (
                  <PopCopia tipo="precio" origen={fincaNom(e.fincaId)}
                    otras={otras} copia={copia} setCopia={setCopia} onAplicar={aplicarCopia}
                    yaTiene={fid => { const r = exc.find(x => x.fincaId === fid); return !!(r && rowTienePrecio(r)) }} />
                )}
              </div>
            )}
          </div>
          )
        })}
        <button onClick={addExc} style={miniLink}>＋ Agregar finca distinta</button>
      </div>

      {/* 3. Precio */}
      <div style={seccion}>
        <div style={tit}>3 · Precio</div>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '12px' }}>
          <Campo label="¿El precio es por…?">
            <select value={precioPor} onChange={e => setPrecioPor(e.target.value)} style={{ ...inp, width: '210px' }}>
              <option value="presentacion">Envase entero ({cap1(presentacion)})</option>
              <option value="aplicacion">Unidad menor ({UNIDAD[uStd] || uStd})</option>
            </select>
          </Campo>
          <Campo label="Plazo que rige ahora">
            <select value={plazoActivo} onChange={e => setPlazoActivo(Number(e.target.value))} style={{ ...inp, width: '140px' }}>
              {PLAZOS.map(pz => <option key={pz} value={pz}>{PLAZO_LBL[pz]}</option>)}
            </select>
          </Campo>
          <Campo label="Desde cuándo rige">
            <input type="date" value={desde} max={hoyISO()} onChange={e => setDesde(e.target.value)} style={inp} />
          </Campo>
        </div>
        <div style={{ fontSize: '11px', color: GRIS, marginBottom: '6px' }}>Precio por plazo (llena solo los que apliquen):</div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          {PLAZOS.map(pz => (
            <Campo key={pz} label={PLAZO_LBL[pz]}>
              <input inputMode="decimal" value={precios[pz] ?? ''} placeholder="—"
                onChange={e => setPrecios(p => ({ ...p, [pz]: e.target.value }))}
                style={{ ...inp, width: '95px', textAlign: 'right' }} />
            </Campo>
          ))}
        </div>
        {hayAlgunPrecio && factor && (
          <div style={{ fontSize: '11.5px', color: GRIS, marginTop: '8px' }}>
            Se guarda convertido a precio por unidad menor. El precio anterior de cada plazo queda en el histórico; el nuevo rige desde la fecha (puede ser pasada).
          </div>
        )}
      </div>

      {/* 4. Alertas */}
      <div style={seccion}>
        <div style={tit}>4 · Alertas de inventario</div>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Campo label={`Mínimo (${UNIDAD[uStd] || uStd})`}>
            <input inputMode="decimal" value={minimo} onChange={e => setMinimo(e.target.value)} placeholder="opcional" style={{ ...inp, width: '130px', textAlign: 'right' }} />
          </Campo>
          <Campo label={`Cantidad deseable (${UNIDAD[uStd] || uStd})`}>
            <input inputMode="decimal" value={deseable} onChange={e => setDeseable(e.target.value)} placeholder="opcional" style={{ ...inp, width: '150px', textAlign: 'right' }} />
          </Campo>
        </div>
        <div style={{ fontSize: '11.5px', color: GRIS, marginTop: '8px' }}>Bajo el mínimo = “Bajo”. En o sobre la cantidad deseable = “Suficiente”. En medio = “Medio”.</div>
      </div>

      <div style={{ display: 'flex', gap: '8px', marginTop: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
        <button disabled={!listo || enviando} onClick={guardar} style={{ ...btnPri, opacity: (!listo || enviando) ? 0.5 : 1 }}>{enviando ? 'Guardando...' : 'Guardar'}</button>
        <button onClick={onCancelar} style={btn}>Cancelar</button>
        <span style={{ fontSize: '12px', color: GRIS, marginLeft: 'auto' }}>Se guardará en las {activas.length} fincas activas</span>
      </div>
    </div>
  )
}

// Configurar balanceado: precio por plazo (por saco), plazo activo,
// mínimo y objetivo. A todas las fincas de un golpe (con excepciones).
function EditorConfigBal({ producto, fincas, actual, onHecho, onError, onCancelar }) {
  const a = actual || {}
  const activas = (fincas || []).filter(f => String(f.nombre).toUpperCase() !== 'PRUEBA')
  const [precios, setPrecios] = useState(() => {
    const p = {}; PLAZOS.forEach(pz => { const v = a.precios?.[pz]; if (v != null) p[pz] = String(Math.round(v * 10000) / 10000) }); return p
  })
  const [plazoActivo, setPlazoActivo] = useState(a.plazoActivo ?? 0)
  const [desde, setDesde] = useState(a.desde || hoyISO())
  const [minimo, setMinimo] = useState(a.stock_minimo != null ? String(a.stock_minimo) : '')
  const [deseable, setDeseable] = useState(a.stock_objetivo != null ? String(a.stock_objetivo) : '')
  const [exc, setExc] = useState([])   // [{fincaId, precio, plazo, desde}]
  const [enviando, setEnviando] = useState(false)
  // Panel "Aplicar a varias fincas" (precio por saco a las fincas elegidas).
  const bulkVacio = { open: false, fincas: {}, precios: {}, plazoRige: 0, desde: '' }
  const [bulk, setBulk] = useState(bulkVacio)
  const bulkFincas = () => Object.keys(bulk.fincas).filter(id => bulk.fincas[id])
  const bulkPuede = bulkFincas().length > 0 && PLAZOS.some(pz => numDec(bulk.precios[pz] || '') > 0)

  async function cerrarYAbrirBal(fincaIds, pz, rows, dfe) {
    if (!fincaIds.length) return
    await supabase.schema('produccion').from('precio_producto').delete()
      .eq('producto_id', producto.id).eq('plazo', pz).in('finca_id', fincaIds).gte('vigente_desde', dfe)
    await supabase.schema('produccion').from('precio_producto').update({ vigente_hasta: sumarDias(dfe, -1) })
      .eq('producto_id', producto.id).eq('plazo', pz).in('finca_id', fincaIds).is('vigente_hasta', null).lt('vigente_desde', dfe)
    const { error } = await supabase.schema('produccion').from('precio_producto').insert(rows)
    if (error) throw error
  }

  async function aplicarBulk() {
    const destinos = bulkFincas()
    if (!destinos.length) return
    setEnviando(true)
    try {
      const dfe = bulk.desde || hoyISO()
      for (const pz of PLAZOS) {
        const raw = numDec(bulk.precios[pz] || '')
        if (raw > 0) await cerrarYAbrirBal(destinos, pz,
          destinos.map(fid => ({ producto_id: producto.id, finca_id: fid, plazo: pz, precio_saco: raw, vigente_desde: dfe })), dfe)
      }
      let rige = bulk.plazoRige
      if (rige != null && !(numDec(bulk.precios[rige] || '') > 0)) {
        const c = PLAZOS.find(pz => numDec(bulk.precios[pz] || '') > 0); if (c != null) rige = c
      }
      if (rige != null) {
        await supabase.schema('produccion').from('plazo_producto').delete()
          .eq('producto_id', producto.id).in('finca_id', destinos).gte('vigente_desde', dfe)
        await supabase.schema('produccion').from('plazo_producto').update({ vigente_hasta: sumarDias(dfe, -1) })
          .eq('producto_id', producto.id).in('finca_id', destinos).is('vigente_hasta', null).lt('vigente_desde', dfe)
        const { error } = await supabase.schema('produccion').from('plazo_producto')
          .insert(destinos.map(fid => ({ producto_id: producto.id, finca_id: fid, plazo: rige, vigente_desde: dfe })))
        if (error) throw error
      }
      setBulk(bulkVacio)
      onHecho(`Precio aplicado a ${destinos.length} finca${destinos.length === 1 ? '' : 's'}.`)
    } catch (err) { onError(err.message || 'No se pudo aplicar.') }
    finally { setEnviando(false) }
  }

  async function guardar() {
    setEnviando(true)
    try {
      const ids = activas.map(f => f.id)
      // 1) Mínimo/objetivo (si la tabla existe; si no, no rompe).
      try {
        await supabase.schema('produccion').from('producto_finca').upsert(
          ids.map(fid => ({ producto_id: producto.id, finca_id: fid,
            stock_minimo: numDec(minimo) > 0 ? numDec(minimo) : null,
            stock_objetivo: numDec(deseable) > 0 ? numDec(deseable) : null })), { onConflict: 'producto_id,finca_id' })
      } catch { /* falta correr el SQL de producto_finca */ }

      const cerrarYAbrir = async (fincaIds, pz, rows, dfe) => {
        if (!fincaIds.length) return
        await supabase.schema('produccion').from('precio_producto').delete()
          .eq('producto_id', producto.id).eq('plazo', pz).in('finca_id', fincaIds).gte('vigente_desde', dfe)
        await supabase.schema('produccion').from('precio_producto').update({ vigente_hasta: sumarDias(dfe, -1) })
          .eq('producto_id', producto.id).eq('plazo', pz).in('finca_id', fincaIds).is('vigente_hasta', null).lt('vigente_desde', dfe)
        const { error } = await supabase.schema('produccion').from('precio_producto').insert(rows)
        if (error) throw error
      }
      // 2) Precios estándar (por saco) por plazo. Vacío/0 => borra el vigente.
      for (const pz of PLAZOS) {
        const raw = numDec(precios[pz] || '')
        if (raw > 0) {
          await cerrarYAbrir(ids, pz, ids.map(fid => ({ producto_id: producto.id, finca_id: fid, plazo: pz, precio_saco: raw, vigente_desde: desde })), desde)
        } else {
          const { error: eDel } = await supabase.schema('produccion').from('precio_producto').delete()
            .eq('producto_id', producto.id).eq('plazo', pz).in('finca_id', ids).is('vigente_hasta', null)
          if (eDel) throw eDel
        }
      }
      // 3) Excepciones por finca.
      for (const e of exc) {
        if (!e.fincaId || !(numDec(e.precio || '') > 0)) continue
        const pz = Number(e.plazo) || 0, dfe = e.desde || desde
        await cerrarYAbrir([e.fincaId], pz, [{ producto_id: producto.id, finca_id: e.fincaId, plazo: pz, precio_saco: numDec(e.precio), vigente_desde: dfe }], dfe)
      }
      // 4) Plazo que rige ahora. Si el elegido no tiene precio pero otro sí,
      //    se apunta al primero con precio (para que el catálogo lo muestre).
      let rigeStd = plazoActivo
      if (rigeStd != null && !(numDec(precios[rigeStd] || '') > 0)) {
        const conP = PLAZOS.find(pz => numDec(precios[pz] || '') > 0)
        if (conP != null) rigeStd = conP
      }
      await supabase.schema('produccion').from('plazo_producto').delete()
        .eq('producto_id', producto.id).in('finca_id', ids).gte('vigente_desde', desde)
      await supabase.schema('produccion').from('plazo_producto').update({ vigente_hasta: sumarDias(desde, -1) })
        .eq('producto_id', producto.id).in('finca_id', ids).is('vigente_hasta', null).lt('vigente_desde', desde)
      const { error: e4 } = await supabase.schema('produccion').from('plazo_producto')
        .insert(ids.map(fid => ({ producto_id: producto.id, finca_id: fid, plazo: rigeStd, vigente_desde: desde })))
      if (e4) throw e4

      onHecho(`Configurado en ${activas.length} fincas.`)
    } catch (err) { onError(err.message || 'No se pudo guardar.') }
    finally { setEnviando(false) }
  }

  const seccion = { background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '15px 16px', marginBottom: '12px' }
  const tit = { fontSize: '11px', letterSpacing: '.05em', textTransform: 'uppercase', color: GRIS, margin: '0 0 13px', fontWeight: 600 }

  return (
    <div style={{ background: '#f0f6f2', padding: '16px 18px', borderBottom: '0.5px solid #e6edf3' }}>
      <div style={{ fontSize: '14px', fontWeight: 600, color: VERDE, marginBottom: '14px' }}>Configurar {producto.nombre} <span style={{ fontWeight: 400, color: GRIS, fontSize: '12px' }}>· se compra y consume en sacos</span></div>

      {/* Precio */}
      <div style={seccion}>
        <div style={tit}>1 · Precio (por saco)</div>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '12px' }}>
          <Campo label="Plazo que rige ahora">
            <select value={plazoActivo} onChange={e => setPlazoActivo(Number(e.target.value))} style={{ ...inp, width: '140px' }}>
              {PLAZOS.map(pz => <option key={pz} value={pz}>{PLAZO_LBL[pz]}</option>)}
            </select>
          </Campo>
          <Campo label="Desde cuándo rige">
            <input type="date" value={desde} max={hoyISO()} onChange={e => setDesde(e.target.value)} style={inp} />
          </Campo>
        </div>
        <div style={{ fontSize: '11px', color: GRIS, marginBottom: '6px' }}>Precio por saco, por plazo (llena solo los que apliquen):</div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          {PLAZOS.map(pz => (
            <Campo key={pz} label={PLAZO_LBL[pz]}>
              <input inputMode="decimal" value={precios[pz] ?? ''} placeholder="—"
                onChange={e => setPrecios(p => ({ ...p, [pz]: e.target.value }))} style={{ ...inp, width: '95px', textAlign: 'right' }} />
            </Campo>
          ))}
        </div>
      </div>

      {/* Excepciones */}
      <div style={{ ...seccion, borderColor: '#e8d9b8', background: '#FBF7EE' }}>
        <div style={{ ...tit, color: AMBAR }}>2 · ¿Alguna finca con precio distinto?</div>
        <div style={{ fontSize: '11.5px', color: GRIS, marginBottom: '13px' }}>Aplica el mismo precio a varias fincas de una vez, o agrégalas una por una abajo. Lo que dejes vacío usa el estándar.</div>

        {/* Aplicar a varias fincas a la vez */}
        {!bulk.open ? (
          <button onClick={() => setBulk({ ...bulkVacio, open: true })}
            style={{ border: '0.5px solid #d8c48f', background: '#fdf8ec', color: '#8a5a12', borderRadius: '9px',
                     padding: '9px 14px', fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer', marginBottom: '14px' }}>
            ＋ Aplicar a varias fincas
          </button>
        ) : (
          <div style={{ border: '0.5px solid #d8c48f', background: '#fffdf7', borderRadius: '12px', padding: '15px 16px', marginBottom: '14px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: AMBAR, marginBottom: '10px' }}>Aplicar el mismo precio a varias fincas</div>
            <label style={{ display: 'block', fontSize: '10px', letterSpacing: '.05em', color: GRIS, margin: '0 0 6px' }}>Fincas</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px', marginBottom: '14px' }}>
              {activas.map(f => {
                const on = !!bulk.fincas[f.id]
                return (
                  <button key={f.id} onClick={() => setBulk(b => ({ ...b, fincas: { ...b.fincas, [f.id]: !b.fincas[f.id] } }))}
                    style={{ border: '0.5px solid ' + (on ? NAVY : BORDE), background: on ? NAVY : 'white', color: on ? 'white' : NAVY,
                             borderRadius: '999px', padding: '6px 13px', fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer' }}>
                    {f.nombre}{on ? ' ✓' : ''}
                  </button>
                )
              })}
            </div>
            <div style={{ fontSize: '11px', color: GRIS, marginBottom: '7px' }}>Precio por saco, por plazo — llena los que apliquen y marca cuál rige</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '8px', marginBottom: '14px' }}>
              {PLAZOS.map(pz => {
                const on = bulk.plazoRige === pz
                return (
                  <div key={pz} style={{ textAlign: 'center', border: '0.5px solid ' + (on ? '#e0cd9a' : 'transparent'), background: on ? '#fdf9ee' : 'transparent', borderRadius: '9px', padding: '6px 5px' }}>
                    <div style={{ fontSize: '10.5px', color: on ? AMBAR : GRIS, fontWeight: on ? 700 : 400, marginBottom: '4px' }}>{PLAZO_LBL[pz]}</div>
                    <input inputMode="decimal" value={bulk.precios[pz] ?? ''} placeholder="—"
                      onChange={e => setBulk(b => ({ ...b, precios: { ...b.precios, [pz]: e.target.value }, plazoRige: b.plazoRige == null && numDec(e.target.value) > 0 ? pz : b.plazoRige }))}
                      style={{ ...inp, textAlign: 'right', padding: '6px' }} />
                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center', fontSize: '10.5px', color: GRIS, marginTop: '5px', cursor: 'pointer' }}>
                      <input type="radio" name="bulkbal-rige" checked={on} onChange={() => setBulk(b => ({ ...b, plazoRige: pz }))} /> Rige
                    </label>
                  </div>
                )
              })}
            </div>
            <div style={{ display: 'flex', alignItems: 'end', gap: '16px', flexWrap: 'wrap' }}>
              <div>
                <label style={{ display: 'block', fontSize: '10px', letterSpacing: '.05em', color: GRIS, margin: '0 0 5px' }}>Rige desde</label>
                <input type="date" value={bulk.desde || ''} max={hoyISO()} onChange={e => setBulk(b => ({ ...b, desde: e.target.value }))} style={{ ...inp, width: '170px' }} />
              </div>
              <div style={{ display: 'flex', gap: '9px', marginLeft: 'auto' }}>
                <button onClick={() => setBulk(bulkVacio)} style={{ background: 'none', border: 'none', color: GRIS, fontSize: '13px', fontFamily: 'inherit', cursor: 'pointer' }}>Cancelar</button>
                <button onClick={aplicarBulk} disabled={!bulkPuede || enviando}
                  style={{ background: bulkPuede ? NAVY : '#c3d0db', color: 'white', border: 'none', borderRadius: '9px', padding: '9px 16px', fontSize: '13px', fontFamily: 'inherit', cursor: bulkPuede ? 'pointer' : 'default' }}>
                  Aplicar a {bulkFincas().length} finca{bulkFincas().length === 1 ? '' : 's'}
                </button>
              </div>
            </div>
            <div style={{ fontSize: '11px', color: GRIS, marginTop: '9px' }}>Se crea/actualiza el precio de cada finca marcada. Luego puedes ajustar alguna por separado abajo.</div>
          </div>
        )}

        {exc.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 0.9fr 1fr 1.1fr auto', gap: '9px', fontSize: '10.5px', color: GRIS, padding: '0 2px 4px', textTransform: 'uppercase' }}>
            <span>Finca</span><span style={{ textAlign: 'right' }}>Precio/saco</span><span>Plazo</span><span>Rige desde</span><span></span>
          </div>
        )}
        {exc.map((e, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.3fr 0.9fr 1fr 1.1fr auto', gap: '9px', alignItems: 'center', marginBottom: '8px' }}>
            <select value={e.fincaId} onChange={ev => setExc(x => x.map((r, j) => j === i ? { ...r, fincaId: ev.target.value } : r))} style={inp}>
              <option value="">Elegir finca</option>
              {activas.map(f => <option key={f.id} value={f.id}>{f.nombre}</option>)}
            </select>
            <input inputMode="decimal" value={e.precio ?? ''} placeholder="—" onChange={ev => setExc(x => x.map((r, j) => j === i ? { ...r, precio: ev.target.value } : r))} style={{ ...inp, textAlign: 'right' }} />
            <select value={e.plazo ?? 0} onChange={ev => setExc(x => x.map((r, j) => j === i ? { ...r, plazo: Number(ev.target.value) } : r))} style={inp}>
              {PLAZOS.map(pz => <option key={pz} value={pz}>{PLAZO_LBL[pz]}</option>)}
            </select>
            <input type="date" value={e.desde || ''} max={hoyISO()} onChange={ev => setExc(x => x.map((r, j) => j === i ? { ...r, desde: ev.target.value } : r))} style={inp} />
            <button onClick={() => setExc(x => x.filter((_, j) => j !== i))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: ROJO, fontSize: '16px' }}>✕</button>
          </div>
        ))}
        <button onClick={() => setExc(x => [...x, { fincaId: '', precio: '', plazo: 0, desde: '' }])} style={miniLink}>＋ Agregar finca distinta</button>
      </div>

      {/* Alertas */}
      <div style={seccion}>
        <div style={tit}>3 · Alertas de inventario (sacos)</div>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Campo label="Mínimo (sacos)"><input inputMode="decimal" value={minimo} onChange={e => setMinimo(e.target.value)} placeholder="opcional" style={{ ...inp, width: '130px', textAlign: 'right' }} /></Campo>
          <Campo label="Cantidad deseable (sacos)"><input inputMode="decimal" value={deseable} onChange={e => setDeseable(e.target.value)} placeholder="opcional" style={{ ...inp, width: '160px', textAlign: 'right' }} /></Campo>
        </div>
        <div style={{ fontSize: '11px', color: GRIS, marginTop: '7px' }}>Requiere haber corrido el SQL de balanceado (producto_finca). Si no, el mínimo/objetivo no se guarda (el precio sí).</div>
      </div>

      <div style={{ display: 'flex', gap: '8px', marginTop: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
        <button disabled={enviando} onClick={guardar} style={{ ...btnPri, opacity: enviando ? 0.5 : 1 }}>{enviando ? 'Guardando...' : 'Guardar'}</button>
        <button onClick={onCancelar} style={btn}>Cancelar</button>
        <span style={{ fontSize: '12px', color: GRIS, marginLeft: 'auto' }}>Se guardará en las {activas.length} fincas activas</span>
      </div>
    </div>
  )
}

function Insignia({ children, color, bg }) {
  return <span style={{ fontSize: '10.5px', fontWeight: 600, background: bg, color, borderRadius: '6px', padding: '2px 8px', marginLeft: '8px' }}>{children}</span>
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
const linkAccion = color => ({ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color, fontFamily: 'inherit', fontSize: '13px' })
