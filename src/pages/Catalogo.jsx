import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { numDec } from '../lib/fechas'

// Catálogo · el maestro de productos (solo el jefe global).
//
// Aquí se registran y estandarizan los insumos y balanceados: nombre,
// presentación y medida. Es la única fuente: los inventarios solo usan
// lo que está aquí. También se aprueban los pedidos de la bodega.
// Los precios NO viven aquí: son por finca, en Inventario → Precios.

const NAVY = '#022847', AZUL = '#0D6CB0', BORDE = '#dce6ef', GRIS = '#7d8fa0', ROJO = '#8A2F2E'
const UNIDAD = { sacos: 'Sacos', litros: 'Litros', gramos: 'Gramos', libras: 'Libras', kg: 'Kilos', unidad: 'Unidades' }
const UNIDADES = ['sacos', 'litros', 'gramos', 'libras', 'kg', 'unidad']

export default function Catalogo({ esJefeGlobal, tabInicial }) {
  const [tab, setTab] = useState(tabInicial === 'balanceados' ? 'balanceados' : 'insumos')
  const [insumos, setInsumos] = useState([])
  const [productos, setProductos] = useState([])
  const [solIns, setSolIns] = useState([])
  const [solBal, setSolBal] = useState([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [nuevo, setNuevo] = useState(false)
  const [editando, setEditando] = useState(null)   // id

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    const [{ data: ins }, { data: prod }, { data: si }, { data: sb }] = await Promise.all([
      supabase.schema('produccion').from('insumo').select('id, nombre, unidad, unidad_compra, factor').eq('activo', true).order('nombre'),
      supabase.schema('produccion').from('producto').select('id, nombre, marca').eq('activo', true).order('nombre'),
      supabase.schema('produccion').from('solicitud_correccion').select('id, valor_propuesto, finca:finca_id (nombre)').eq('tabla', 'nuevo_insumo').eq('estado', 'pendiente'),
      supabase.schema('produccion').from('solicitud_correccion').select('id, valor_propuesto, finca:finca_id (nombre)').eq('tabla', 'nuevo_producto').eq('estado', 'pendiente'),
    ])
    setInsumos(ins || []); setProductos(prod || []); setSolIns(si || []); setSolBal(sb || [])
    setCargando(false)
  }, [])
  useEffect(() => { cargar() }, [cargar])

  async function resolver(sol, aprobar) {
    const { error } = await supabase.schema('produccion').rpc('fn_resolver_correccion', { p_id: sol.id, p_aprobar: aprobar })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo resolver. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: aprobar ? 'Agregado al catálogo.' : 'Pedido rechazado.' }); await cargar()
  }
  async function quitarIns(f) {
    if (!window.confirm(`¿Quitar "${f.nombre}" del catálogo?\n\nDeja de aparecer para cargar; el historial se conserva.`)) return
    const { error } = await supabase.schema('produccion').from('insumo').update({ activo: false }).eq('id', f.id)
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Quitado.' }); await cargar()
  }
  async function quitarProd(f) {
    if (!window.confirm(`¿Quitar "${f.nombre}" del catálogo?`)) return
    const { error } = await supabase.schema('produccion').from('producto').update({ activo: false }).eq('id', f.id)
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Quitado.' }); await cargar()
  }

  if (!esJefeGlobal) {
    return <div style={{ padding: '2rem', color: GRIS }}>El catálogo lo administra el jefe.</div>
  }

  const solActual = tab === 'insumos' ? solIns : solBal

  return (
    <div style={{ padding: '1.4rem 1.5rem', maxWidth: '1000px', color: NAVY, fontFamily: 'Inter, system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '22px', fontWeight: 500, margin: '0 0 4px' }}>Catálogo</h1>
      <p style={{ fontSize: '13px', color: GRIS, margin: '0 0 16px', maxWidth: '640px' }}>
        El maestro de productos. Aquí se estandarizan insumos y balanceados (nombre, presentación y medida)
        y se aprueban los pedidos de la bodega. Los precios se ponen por finca en Inventario → Precios.
      </p>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        {[['insumos', 'Insumos'], ['balanceados', 'Balanceados']].map(([id, txt]) => (
          <button key={id} onClick={() => { setTab(id); setNuevo(false); setEditando(null) }} style={{
            padding: '8px 16px', borderRadius: '20px', fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer',
            border: '0.5px solid ' + (tab === id ? '#9cc4e8' : BORDE), background: tab === id ? '#E6F1FB' : 'white',
            color: tab === id ? AZUL : NAVY, fontWeight: tab === id ? 500 : 400 }}>{txt}</button>
        ))}
        <button onClick={() => { setNuevo(true); setEditando(null); setAviso(null) }} style={{ ...btn, marginLeft: 'auto' }}>
          + Agregar {tab === 'insumos' ? 'insumo' : 'balanceado'}
        </button>
      </div>

      {aviso && (
        <div style={{ borderRadius: '9px', padding: '10px 13px', fontSize: '13px', marginBottom: '12px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE', color: aviso.tipo === 'error' ? ROJO : '#0F6E56' }}>{aviso.texto}</div>
      )}

      {solActual.length > 0 && (
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
        ? <FormaInsumo onGuardar={async (p) => { const ok = await crearInsumo(p, setAviso); if (ok) { setNuevo(false); await cargar() } }} onCancelar={() => setNuevo(false)} />
        : <FormaProducto onGuardar={async (p) => { const ok = await crearProducto(p, setAviso); if (ok) { setNuevo(false); await cargar() } }} onCancelar={() => setNuevo(false)} />)}

      {cargando ? (
        <div style={{ fontSize: '13px', color: GRIS, padding: '14px 0' }}>Cargando...</div>
      ) : tab === 'insumos' ? (
        insumos.map(f => (
          <div key={f.id} style={{ borderBottom: '0.5px solid #f1f6f9', padding: '11px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
              <div>
                <span style={{ fontWeight: 500, fontSize: '14px' }}>{f.nombre}</span>
                <div style={{ fontSize: '11px', color: GRIS }}>
                  {UNIDAD[f.unidad] || f.unidad}
                  {f.unidad_compra && f.unidad_compra !== f.unidad ? ` · se compra por ${f.unidad_compra} (${f.factor})` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '7px' }}>
                <button onClick={() => setEditando(editando === f.id ? null : f.id)} style={btn}>{editando === f.id ? 'Cancelar' : 'Editar'}</button>
                <button onClick={() => quitarIns(f)} style={{ ...btn, color: ROJO, borderColor: '#e7cccb' }}>Quitar</button>
              </div>
            </div>
            {editando === f.id && (
              <FormaInsumo actual={f} onGuardar={async (p) => { const ok = await editarInsumo(f, p, setAviso); if (ok) { setEditando(null); await cargar() } }} onCancelar={() => setEditando(null)} />
            )}
          </div>
        ))
      ) : (
        productos.map(f => (
          <div key={f.id} style={{ borderBottom: '0.5px solid #f1f6f9', padding: '11px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
              <div>
                <span style={{ fontWeight: 500, fontSize: '14px' }}>{f.nombre}</span>
                {f.marca && <div style={{ fontSize: '11px', color: GRIS }}>{f.marca}</div>}
              </div>
              <div style={{ display: 'flex', gap: '7px' }}>
                <button onClick={() => setEditando(editando === f.id ? null : f.id)} style={btn}>{editando === f.id ? 'Cancelar' : 'Editar'}</button>
                <button onClick={() => quitarProd(f)} style={{ ...btn, color: ROJO, borderColor: '#e7cccb' }}>Quitar</button>
              </div>
            </div>
            {editando === f.id && (
              <FormaProducto actual={f} onGuardar={async (p) => { const ok = await editarProducto(f, p, setAviso); if (ok) { setEditando(null); await cargar() } }} onCancelar={() => setEditando(null)} />
            )}
          </div>
        ))
      )}
    </div>
  )
}

async function crearInsumo({ nombre, unidad, unidadCompra, factor }, setAviso) {
  const { error } = await supabase.schema('produccion').from('insumo')
    .insert({ nombre: nombre.trim(), unidad, unidad_compra: (unidadCompra || unidad).trim(), factor: factor || 1 })
  if (error) { setAviso({ tipo: 'error', texto: /duplicate|unique/i.test(error.message) ? 'Ya existe un insumo con ese nombre.' : error.message }); return false }
  setAviso({ tipo: 'ok', texto: 'Insumo agregado al catálogo.' }); return true
}
async function editarInsumo(actual, { nombre, unidad, unidadCompra, factor }, setAviso) {
  if (nombre.trim() !== actual.nombre) {
    const { error } = await supabase.schema('produccion').from('insumo').update({ nombre: nombre.trim() }).eq('id', actual.id)
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return false }
  }
  if (unidad !== actual.unidad) {
    let { error } = await supabase.schema('produccion').rpc('fn_cambiar_unidad_insumo', { p_insumo: actual.id, p_nueva: unidad })
    if (error && /FALTA_POR/.test(error.message)) {
      const MASA = ['gramos', 'kg', 'libras']
      const um = MASA.includes(actual.unidad) ? actual.unidad : unidad
      const uc = MASA.includes(actual.unidad) ? unidad : actual.unidad
      const sing = { sacos: 'saco', unidad: 'unidad' }[uc] || uc
      const r = window.prompt(`¿Cuántos ${UNIDAD[um] || um} pesa un ${sing} de "${actual.nombre}"?`)
      if (r === null) return false
      const por = numDec(r); if (!(por > 0)) { setAviso({ tipo: 'error', texto: 'Pon un número mayor que cero.' }); return false }
      ;({ error } = await supabase.schema('produccion').rpc('fn_cambiar_unidad_insumo', { p_insumo: actual.id, p_nueva: unidad, p_por: por }))
    }
    if (error) { setAviso({ tipo: 'error', texto: error.message.replace(/^.*?:\s*/, '') }); return false }
  } else if ((unidadCompra || unidad).trim() !== actual.unidad_compra || (factor || 1) !== Number(actual.factor)) {
    const { error } = await supabase.schema('produccion').from('insumo')
      .update({ unidad_compra: (unidadCompra || unidad).trim(), factor: factor || 1 }).eq('id', actual.id)
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return false }
  }
  setAviso({ tipo: 'ok', texto: 'Insumo actualizado.' }); return true
}
async function crearProducto({ nombre, marca }, setAviso) {
  const { error } = await supabase.schema('produccion').from('producto').insert({ nombre: nombre.trim(), marca: marca.trim() || null })
  if (error) { setAviso({ tipo: 'error', texto: /duplicate|unique/i.test(error.message) ? 'Ya existe un balanceado con ese nombre.' : error.message }); return false }
  setAviso({ tipo: 'ok', texto: 'Balanceado agregado al catálogo.' }); return true
}
async function editarProducto(actual, { nombre, marca }, setAviso) {
  const { error } = await supabase.schema('produccion').from('producto').update({ nombre: nombre.trim(), marca: marca.trim() || null }).eq('id', actual.id)
  if (error) { setAviso({ tipo: 'error', texto: /duplicate|unique/i.test(error.message) ? 'Ya existe un balanceado con ese nombre.' : error.message }); return false }
  setAviso({ tipo: 'ok', texto: 'Balanceado actualizado.' }); return true
}

function FormaInsumo({ actual, onGuardar, onCancelar }) {
  const [nombre, setNombre] = useState(actual?.nombre || '')
  const [unidad, setUnidad] = useState(actual?.unidad || 'kg')
  const dist = actual ? (actual.unidad_compra && actual.unidad_compra !== actual.unidad) : false
  const [compraDistinta, setCompraDistinta] = useState(!!dist)
  const [unidadCompra, setUnidadCompra] = useState(dist ? actual.unidad_compra : '')
  const [factor, setFactor] = useState(dist ? String(actual.factor) : '')
  const [enviando, setEnviando] = useState(false)
  const listo = nombre.trim() && (!compraDistinta || (unidadCompra.trim() && numDec(factor) > 0))
  return (
    <div style={{ background: '#f7fafc', borderRadius: '10px', padding: '14px', marginTop: '10px' }}>
      <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Campo label="Nombre"><input autoFocus value={nombre} onChange={e => setNombre(e.target.value)} style={{ ...inp, width: '220px' }} placeholder="Ej. Cal agrícola" /></Campo>
        <Campo label="Cómo se aplica"><select value={unidad} onChange={e => setUnidad(e.target.value)} style={{ ...inp, width: '150px' }}>{UNIDADES.map(u => <option key={u} value={u}>{UNIDAD[u]}</option>)}</select></Campo>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '12px 0 0', fontSize: '13px', cursor: 'pointer' }}>
        <input type="checkbox" checked={compraDistinta} onChange={e => setCompraDistinta(e.target.checked)} />
        Se compra en otra presentación (saco, tambor, botella…)
      </label>
      {compraDistinta && (
        <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '10px' }}>
          <Campo label="Se compra por"><input value={unidadCompra} onChange={e => setUnidadCompra(e.target.value)} placeholder="ej. saco" style={{ ...inp, width: '150px' }} /></Campo>
          <Campo label={`Cada uno trae (${UNIDAD[unidad]})`}><input inputMode="decimal" value={factor} onChange={e => setFactor(e.target.value)} placeholder="ej. 25" style={{ ...inp, width: '150px', textAlign: 'right' }} /></Campo>
        </div>
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
const inp = { padding: '9px 11px', fontSize: '14px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '9px', boxSizing: 'border-box', background: 'white' }
const btn = { background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '9px', padding: '7px 13px', fontFamily: 'inherit', fontSize: '13px', color: NAVY, cursor: 'pointer' }
const btnPri = { background: AZUL, color: 'white', border: 'none', borderRadius: '9px', padding: '10px 20px', fontFamily: 'inherit', fontSize: '14px', fontWeight: 500, cursor: 'pointer' }
