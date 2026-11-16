import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, numDec } from '../lib/fechas'
import CampoNumero from '../components/CampoNumero'

// Precio del galón con 6 decimales (así lo pidió el negocio).
const precio6 = n => '$' + (Number(n) || 0).toLocaleString('es-EC', { minimumFractionDigits: 6, maximumFractionDigits: 6 })

// Catálogo de diesel · proveedores. El diesel viene de VARIOS proveedores;
// cada proveedor vende uno o dos tipos (B / Premium) a una o varias fincas,
// y cada combinación proveedor·finca·tipo tiene su precio con vigencia.
// "Sin proveedor" (SIN) es un proveedor más: los precios del catálogo anterior
// (proveedor_id null) se muestran y editan bajo ese seudo-proveedor.
// Dos sub-menús: Fincas (qué paga cada finca) y Proveedores (cada proveedor,
// a qué fincas y a qué precio). Fijar precios por grupos de fincas (Todas /
// Jambelí / Puná / selección). El precio del ingreso se congela desde aquí.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const VERDE = '#0F6E56'
const ROJO = '#A32D2D'
const SIN = 'SIN'   // seudo-proveedor "Sin proveedor" (proveedor_id null en la base)

const sumarDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }

export default function CatalogoDiesel({ fincas }) {
  const activas = fincas || []
  const [tab, setTab] = useState('fincas')
  const [tipos, setTipos] = useState([])
  const [provsBase, setProvsBase] = useState([])
  const [precios, setPrecios] = useState([])        // [{ proveedor_id ('SIN' o uuid), finca_id, tipo_id, precio, desde }]
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [guardando, setGuardando] = useState(false)

  const [fincaSel, setFincaSel] = useState('todas')
  const [edit, setEdit] = useState(null)            // { proveedorId, fincaId, tipoId, precio, desde }
  const [hist, setHist] = useState(null)            // `${proveedorId}|${fincaId}|${tipoId}`
  const [histRows, setHistRows] = useState([])
  const [histNombres, setHistNombres] = useState({})
  const [expandir, setExpandir] = useState(null)
  const [alta, setAlta] = useState(null)
  const [editProv, setEditProv] = useState(null)
  const [fijar, setFijar] = useState(null)          // panel de fijar precios por grupos
  const [recostear, setRecostear] = useState(null)

  // Lista de proveedores para la UI: "Sin proveedor" primero.
  const proveedores = [{ id: SIN, nombre: 'Sin proveedor', esSin: true }, ...provsBase]
  const nombreFinca = id => activas.find(f => f.id === id)?.nombre || '—'
  const nombreTipo = id => tipos.find(t => t.id === id)?.nombre || '—'
  const nombreProv = id => proveedores.find(p => p.id === id)?.nombre || '—'
  const precioDe = (prov, finca, tipo) => precios.find(p => p.proveedor_id === prov && p.finca_id === finca && p.tipo_id === tipo)
  const idReal = prov => (prov === SIN ? null : prov)

  const cargar = useCallback(async () => {
    setCargando(true)
    const [{ data: tp }, { data: prov }, { data: pr }, { data: lg }] = await Promise.all([
      supabase.schema('produccion').from('diesel_tipo').select('id, nombre').eq('activo', true).order('nombre'),
      supabase.schema('produccion').from('diesel_proveedor').select('id, nombre').eq('activo', true).order('nombre'),
      supabase.schema('produccion').from('diesel_precio')
        .select('proveedor_id, finca_id, tipo_id, precio_galon, vigente_desde')
        .not('proveedor_id', 'is', null).is('vigente_hasta', null),
      supabase.schema('produccion').from('diesel_precio')
        .select('finca_id, tipo_id, precio_galon, vigente_desde')
        .is('proveedor_id', null).is('vigente_hasta', null),
    ])
    setTipos(tp || [])
    setProvsBase(prov || [])
    const conProv = (pr || []).filter(r => r.finca_id).map(r => ({ proveedor_id: r.proveedor_id, finca_id: r.finca_id, tipo_id: r.tipo_id, precio: Number(r.precio_galon), desde: r.vigente_desde }))
    const sin = (lg || []).filter(r => r.finca_id).map(r => ({ proveedor_id: SIN, finca_id: r.finca_id, tipo_id: r.tipo_id, precio: Number(r.precio_galon), desde: r.vigente_desde }))
    setPrecios([...conProv, ...sin])
    setCargando(false)
  }, [])

  useEffect(() => { cargar() }, [cargar])

  // Deja UNA sola fila vigente para proveedor·finca·tipo. prov puede ser null (Sin proveedor).
  async function aplicarPrecio(prov, fincaId, tipoId, precio, desde) {
    const eqProv = q => (prov == null ? q.is('proveedor_id', null) : q.eq('proveedor_id', prov))
    await eqProv(supabase.schema('produccion').from('diesel_precio').delete().eq('tipo_id', tipoId).eq('finca_id', fincaId).is('vigente_hasta', null).gte('vigente_desde', desde))
    await eqProv(supabase.schema('produccion').from('diesel_precio').update({ vigente_hasta: sumarDias(desde, -1) }).eq('tipo_id', tipoId).eq('finca_id', fincaId).is('vigente_hasta', null).lt('vigente_desde', desde))
    const { error } = await supabase.schema('produccion').from('diesel_precio')
      .insert({ proveedor_id: prov, tipo_id: tipoId, finca_id: fincaId, precio_galon: precio, vigente_desde: desde })
    if (error) throw error
  }

  async function detectarRecosteo(prov, combos, desde) {
    if (!desde || desde >= hoyISO()) return []
    const items = []
    for (const c of combos) {
      let q = supabase.schema('produccion').from('diesel_pedido')
        .select('id, precio_galon').eq('finca_id', c.fincaId).eq('tipo_id', c.tipoId)
        .eq('estado', 'aprobado').gte('fecha', desde).lte('fecha', hoyISO())
      q = prov == null ? q.is('proveedor_id', null) : q.eq('proveedor_id', prov)
      const { data } = await q
      const afectadas = (data || []).filter(dp => dp.precio_galon == null || Math.abs(Number(dp.precio_galon) - c.precio) > 1e-9)
      if (afectadas.length) items.push({ fincaNombre: nombreFinca(c.fincaId), tipoNombre: nombreTipo(c.tipoId), precio: c.precio, desde, ids: afectadas.map(a => a.id), n: afectadas.length })
    }
    return items
  }

  async function aplicarRecosteo() {
    setGuardando(true)
    try {
      for (const it of recostear.items) {
        const { error } = await supabase.schema('produccion').from('diesel_pedido').update({ precio_galon: it.precio }).in('id', it.ids)
        if (error) throw error
      }
    } catch (e) { setGuardando(false); setAviso({ tipo: 'error', texto: 'No se pudo recostear. ' + e.message }); return }
    setGuardando(false); setRecostear(null); setAviso({ tipo: 'ok', texto: 'Compras recosteadas al precio nuevo.' }); await cargar()
  }

  // ---- Editar un precio puntual (Fincas) ----
  function abrirEdit(proveedorId, fincaId, tipoId, precioActual) {
    const p = precioDe(proveedorId, fincaId, tipoId)
    setHist(null); setFijar(null)
    setEdit({ proveedorId, fincaId, tipoId, precio: precioActual != null ? String(precioActual) : '', desde: hoyISO(), desdeVigente: p?.desde || null, modo: 'cambio' })
  }
  async function guardarEdit() {
    if (guardando) return
    const raw = numDec(edit.precio || '')
    if (!(raw > 0)) { setAviso({ tipo: 'error', texto: 'Pon un precio.' }); return }
    const prov = idReal(edit.proveedorId)
    const corregir = edit.modo === 'corregir'
    setGuardando(true)
    try {
      if (corregir) {
        // Sobrescribe el precio vigente EN SU LUGAR (no crea tramo nuevo).
        let q = supabase.schema('produccion').from('diesel_precio').update({ precio_galon: raw })
          .eq('tipo_id', edit.tipoId).eq('finca_id', edit.fincaId).is('vigente_hasta', null)
        q = prov == null ? q.is('proveedor_id', null) : q.eq('proveedor_id', prov)
        const { error } = await q
        if (error) throw error
      } else {
        await aplicarPrecio(prov, edit.fincaId, edit.tipoId, raw, edit.desde || hoyISO())
      }
    } catch (e) { setGuardando(false); setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + e.message }); return }
    // Recosteo: para corregir desde el inicio del vigente; para cambio, desde la fecha nueva.
    const desdeRec = corregir ? (edit.desdeVigente || hoyISO()) : (edit.desde || hoyISO())
    const items = await detectarRecosteo(prov, [{ fincaId: edit.fincaId, tipoId: edit.tipoId, precio: raw }], desdeRec)
    setGuardando(false); setEdit(null); setAviso({ tipo: 'ok', texto: corregir ? 'Precio corregido.' : 'Precio guardado.' }); await cargar()
    if (items.length) setRecostear({ items })
  }

  async function abrirHist(proveedorId, fincaId, tipoId) {
    const clave = `${proveedorId}|${fincaId}|${tipoId}`
    if (hist === clave) { setHist(null); return }
    const prov = idReal(proveedorId)
    let q = supabase.schema('produccion').from('diesel_precio')
      .select('precio_galon, vigente_desde, vigente_hasta, creado_por, creado_en')
      .eq('finca_id', fincaId).eq('tipo_id', tipoId).order('vigente_desde', { ascending: false })
    q = prov == null ? q.is('proveedor_id', null) : q.eq('proveedor_id', prov)
    const { data } = await q
    const ids = [...new Set((data || []).map(r => r.creado_por).filter(Boolean))]
    const nombres = {}
    if (ids.length) {
      const { data: us } = await supabase.schema('produccion').from('vw_usuario').select('id, nombre').in('id', ids)
      ;(us || []).forEach(u => { nombres[u.id] = u.nombre })
    }
    setHistRows(data || []); setHistNombres(nombres); setHist(clave); setEdit(null)
  }

  // ---- Alta de proveedor ----
  function abrirAlta() { setFijar(null); setAlta({ nombre: '', fincas: {}, desde: hoyISO() }) }
  async function guardarAlta() {
    if (guardando) return
    const nombre = (alta.nombre || '').trim()
    if (!nombre) { setAviso({ tipo: 'error', texto: 'Pon el nombre del proveedor.' }); return }
    const filas = []
    for (const [fincaId, porTipo] of Object.entries(alta.fincas)) {
      for (const t of tipos) { const raw = numDec(porTipo[t.id] || ''); if (raw > 0) filas.push({ fincaId, tipoId: t.id, precio: raw }) }
    }
    if (!filas.length) { setAviso({ tipo: 'error', texto: 'Asigna al menos una finca con su precio.' }); return }
    setGuardando(true)
    let provId
    try {
      const { data, error } = await supabase.schema('produccion').from('diesel_proveedor').insert({ nombre }).select('id').single()
      if (error) throw error
      provId = data.id
      for (const f of filas) await aplicarPrecio(provId, f.fincaId, f.tipoId, f.precio, alta.desde || hoyISO())
    } catch (e) { setGuardando(false); setAviso({ tipo: 'error', texto: 'No se pudo crear. ' + e.message }); return }
    setGuardando(false); setAlta(null); setAviso({ tipo: 'ok', texto: `Proveedor ${nombre} creado.` }); await cargar(); setTab('proveedores'); setExpandir(provId)
  }

  // ---- Editar proveedor ----
  async function guardarEditProv() {
    if (guardando) return
    const nombre = (editProv.nombre || '').trim()
    if (!nombre) { setAviso({ tipo: 'error', texto: 'Pon el nombre.' }); return }
    setGuardando(true)
    const { error } = await supabase.schema('produccion').from('diesel_proveedor').update({ nombre }).eq('id', editProv.id)
    setGuardando(false)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return }
    setEditProv(null); setAviso({ tipo: 'ok', texto: 'Proveedor actualizado.' }); await cargar()
  }
  async function desactivarProv(id, nombre) {
    if (!window.confirm(`¿Eliminar el proveedor "${nombre}"? Sus precios dejan de verse, pero los ingresos viejos no se tocan.`)) return
    setGuardando(true)
    const { error } = await supabase.schema('produccion').from('diesel_proveedor').update({ activo: false }).eq('id', id)
    setGuardando(false)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo quitar. ' + error.message }); return }
    setEditProv(null); setExpandir(null); setAviso({ tipo: 'ok', texto: `${nombre} quitado.` }); await cargar()
  }

  // ---- Fijar precios por grupos (global o desde un proveedor) ----
  function abrirFijar({ proveedorId = '', tipoId = '', provFijo = false, tipoFijo = false, lugar }) {
    setEdit(null); setAlta(null)
    setFijar({ proveedorId, tipoId, provFijo, tipoFijo, grupos: [{ precio: '', fincaIds: [] }], desde: hoyISO(), lugar })
  }
  async function guardarFijar() {
    if (guardando) return
    if (!fijar.proveedorId) { setAviso({ tipo: 'error', texto: 'Elegí el proveedor.' }); return }
    const esNuevo = fijar.proveedorId === '__nuevo'
    if (esNuevo && !(fijar.nuevoNombre || '').trim()) { setAviso({ tipo: 'error', texto: 'Pon el nombre del proveedor nuevo.' }); return }
    if (!fijar.tipoId) { setAviso({ tipo: 'error', texto: 'Elegí el tipo.' }); return }
    const combos = []
    for (const g of fijar.grupos) {
      const raw = numDec(g.precio || '')
      if (!(raw > 0) || !g.fincaIds.length) continue
      for (const fincaId of g.fincaIds) combos.push({ fincaId, tipoId: fijar.tipoId, precio: raw })
    }
    if (!combos.length) { setAviso({ tipo: 'error', texto: 'Pon un precio y marca al menos una finca.' }); return }
    const desde = fijar.desde || hoyISO()
    setGuardando(true)
    let prov
    try {
      if (esNuevo) {
        const { data, error } = await supabase.schema('produccion').from('diesel_proveedor').insert({ nombre: fijar.nuevoNombre.trim() }).select('id').single()
        if (error) throw error
        prov = data.id
      } else prov = idReal(fijar.proveedorId)
      for (const c of combos) await aplicarPrecio(prov, c.fincaId, c.tipoId, c.precio, desde)
    } catch (e) { setGuardando(false); setAviso({ tipo: 'error', texto: 'No se pudo aplicar. ' + e.message }); return }
    const items = await detectarRecosteo(prov, combos, desde)
    setGuardando(false); setFijar(null); setAviso({ tipo: 'ok', texto: 'Precios aplicados.' }); await cargar()
    if (items.length) setRecostear({ items })
  }

  const fincasDeProv = provId => [...new Set(precios.filter(p => p.proveedor_id === provId).map(p => p.finca_id))]
  const tiposDeProv = provId => [...new Set(precios.filter(p => p.proveedor_id === provId).map(p => p.tipo_id))]

  const panelFijar = (lugar) => (fijar && fijar.lugar === lugar) ? (
    <PanelFijar {...{ activas, tipos, proveedores, fijar, setFijar, guardarFijar, guardando, nombreTipo }} />
  ) : null

  return (
    <div>
      {aviso && (
        <div style={{ borderRadius: '10px', padding: '11px 13px', fontSize: '13px', marginBottom: '12px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE', color: aviso.tipo === 'error' ? ROJO : VERDE }}>{aviso.texto}</div>
      )}

      {recostear && (() => {
        const total = recostear.items.reduce((s, it) => s + it.n, 0)
        return (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,40,71,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 60 }}>
          <div style={{ background: 'white', borderRadius: '14px', padding: '22px 24px', width: '100%', maxWidth: '460px', maxHeight: '80vh', overflow: 'auto', boxShadow: '0 12px 40px rgba(2,40,71,.18)' }}>
            <div style={{ fontWeight: 600, fontSize: '16px', marginBottom: '3px' }}>¿Recostear las compras?</div>
            <div style={{ fontSize: '12.5px', color: GRIS, marginBottom: '14px', lineHeight: 1.5 }}>
              Pusiste un precio con fecha pasada. Hay <b style={{ fontWeight: 600 }}>{total}</b> {total === 1 ? 'compra ya registrada' : 'compras ya registradas'} con otro precio. ¿Les aplico el precio nuevo?
            </div>
            <div style={{ border: '0.5px solid ' + BORDE, borderRadius: '10px', overflow: 'hidden', marginBottom: '14px' }}>
              {recostear.items.map((it, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '9px 12px', fontSize: '13px', borderBottom: i < recostear.items.length - 1 ? '0.5px solid #f1f6f9' : 'none' }}>
                  <span>{it.fincaNombre} · {it.tipoNombre} <span style={{ color: GRIS }}>· desde {corta(it.desde)}</span></span>
                  <span style={{ color: GRIS }}>{it.n} {it.n === 1 ? 'compra' : 'compras'} → {precio6(it.precio)}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '9px' }}>
              <button onClick={aplicarRecosteo} disabled={guardando} style={{ ...boton, background: AZUL, color: 'white', borderColor: AZUL, opacity: guardando ? 0.6 : 1 }}>{guardando ? 'Aplicando…' : 'Sí, recostear'}</button>
              <button onClick={() => setRecostear(null)} style={boton}>No, dejar cada una con su precio</button>
            </div>
          </div>
        </div>
        )
      })()}

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '6px' }}>
          {[['fincas', 'Fincas'], ['proveedores', 'Proveedores']].map(([k, l]) => (
            <button key={k} onClick={() => { setTab(k); setEdit(null); setHist(null); setAlta(null); setFijar(null); setEditProv(null) }}
              style={{ ...boton, background: tab === k ? NAVY : 'white', color: tab === k ? 'white' : NAVY, borderColor: tab === k ? NAVY : BORDE }}>{l}</button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
          {tab === 'fincas' && !cargando && (<>
            <select value={fincaSel} onChange={e => setFincaSel(e.target.value)} style={{ ...inp }}>
              <option value="todas">Todas las fincas</option>
              {activas.map(f => <option key={f.id} value={f.id}>{f.nombre}</option>)}
            </select>
            <button onClick={() => abrirFijar({ lugar: 'fincas' })} style={{ ...boton, background: NAVY, color: 'white', borderColor: NAVY }}>Fijar precios</button>
          </>)}
          {tab === 'proveedores' && !cargando && !alta && (<>
            <button onClick={() => abrirFijar({ lugar: 'proveedores' })} style={{ ...boton, background: NAVY, color: 'white', borderColor: NAVY }}>Fijar precios</button>
            <button onClick={abrirAlta} style={{ ...boton, background: NAVY, color: 'white', borderColor: NAVY }}>+ Agregar proveedor</button>
          </>)}
        </div>
      </div>

      {cargando ? (
        <div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Cargando...</div>
      ) : tab === 'fincas' ? (
        <>
          {panelFijar('fincas')}
          <VistaFincas {...{ activas, tipos, proveedores, precios, fincaSel, edit, setEdit, abrirEdit, guardarEdit, guardando, hist, abrirHist, histRows, histNombres, nombreTipo }} />
        </>
      ) : (
        <VistaProveedores {...{ activas, tipos, proveedores, precioDe, fincasDeProv, tiposDeProv, nombreFinca, nombreTipo,
          alta, setAlta, guardarAlta, guardando, editProv, setEditProv, guardarEditProv, desactivarProv,
          expandir, setExpandir, abrirFijar, panelFijar, setFijar }} />
      )}
    </div>
  )
}

// ========================= SUB-MENÚ: FINCAS =========================
function VistaFincas({ activas, tipos, proveedores, precios, fincaSel, edit, setEdit, abrirEdit, guardarEdit, guardando, hist, abrirHist, histRows, histNombres, nombreTipo }) {
  const provsDe = (fincaId, tipoId) => precios.filter(p => p.finca_id === fincaId && p.tipo_id === tipoId)
    .map(p => ({ ...p, nombre: proveedores.find(x => x.id === p.proveedor_id)?.nombre || '—', esSin: p.proveedor_id === SIN }))
    .sort((a, b) => (a.esSin ? 1 : 0) - (b.esSin ? 1 : 0) || a.nombre.localeCompare(b.nombre))
  const fincaConAlgo = f => precios.some(p => p.finca_id === f.id)
  const conAlgo = activas.filter(fincaConAlgo)
  const lista = fincaSel === 'todas' ? conAlgo : conAlgo.filter(f => f.id === fincaSel)

  if (!conAlgo.length) return <div style={{ padding: '24px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Todavía no hay precios. Usa “Fijar precios” o ve a “Proveedores”.</div>

  const linea = (f, t, p) => {
    const clave = `${p.proveedor_id}|${f.id}|${t.id}`
    const enEdit = edit && edit.proveedorId === p.proveedor_id && edit.fincaId === f.id && edit.tipoId === t.id
    const enHist = hist === clave
    return (
      <div key={p.proveedor_id} style={{ marginBottom: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '14px' }}>
          <span style={{ color: p.esSin ? GRIS : NAVY }}>{p.nombre}</span>
          <span style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <b style={{ fontWeight: 500, color: NAVY }}>{precio6(p.precio)}</b>
            <button onClick={() => abrirHist(p.proveedor_id, f.id, t.id)} style={btnLink}>{enHist ? 'Ocultar' : 'Historial'}</button>
            <button onClick={() => enEdit ? setEdit(null) : abrirEdit(p.proveedor_id, f.id, t.id, p.precio)} style={btnLink}>{enEdit ? 'Cerrar' : 'Editar'}</button>
          </span>
        </div>
        {enEdit && (
          <div style={{ marginTop: '8px', padding: '10px 12px', background: '#f6f9fb', borderRadius: '8px' }}>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
              {[['cambio', 'Cambio de precio'], ['corregir', 'Corregir (estaba mal)']].map(([k, l]) => (
                <button key={k} onClick={() => setEdit(x => ({ ...x, modo: k }))}
                  style={{ fontSize: '12px', padding: '5px 11px', borderRadius: '7px', fontFamily: 'inherit', cursor: 'pointer',
                    border: '0.5px solid ' + (edit.modo === k ? AZUL : BORDE), background: edit.modo === k ? '#E6F1FB' : 'white', color: edit.modo === k ? '#0C447C' : GRIS }}>{l}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div><label style={lbl}>{edit.modo === 'corregir' ? 'Precio correcto' : 'Precio nuevo'}</label>
                <CampoNumero maxDec={6} value={edit.precio} placeholder="ej. 1.80" onChange={v => setEdit(x => ({ ...x, precio: v }))} style={{ ...inp, width: '110px', textAlign: 'right' }} /></div>
              {edit.modo !== 'corregir' && (
                <div><label style={lbl}>Rige desde</label>
                  <input type="date" value={edit.desde} max={hoyISO()} onChange={e => setEdit(x => ({ ...x, desde: e.target.value }))} style={inp} /></div>
              )}
              <button onClick={guardarEdit} disabled={guardando} style={{ ...boton, background: AZUL, color: 'white', borderColor: AZUL, opacity: guardando ? 0.6 : 1 }}>{guardando ? 'Guardando…' : (edit.modo === 'corregir' ? 'Corregir' : 'Guardar')}</button>
            </div>
            <div style={{ fontSize: '11px', color: GRIS, marginTop: '8px', lineHeight: 1.4 }}>
              {edit.modo === 'corregir'
                ? 'Sobrescribe el precio actual sin crear historial (como si nunca hubiera estado el malo). Te preguntamos si recostear las compras que lo usaron.'
                : 'Crea un precio nuevo que rige desde la fecha; el anterior queda en el historial.'}
            </div>
          </div>
        )}
        {enHist && (
          <div style={{ marginTop: '8px', padding: '10px 12px', background: '#fafcfd', borderRadius: '8px' }}>
            <div style={{ fontSize: '11px', color: GRIS, marginBottom: '7px' }}>Historial · {p.nombre} · {nombreTipo(t.id)}</div>
            {histRows.length === 0 ? <div style={{ fontSize: '12px', color: GRIS }}>—</div> : histRows.map((r, i) => (
              <div key={i} style={{ padding: '5px 0', borderBottom: i < histRows.length - 1 ? '0.5px solid #f1f6f9' : 'none' }}>
                <div style={{ fontSize: '14px', fontWeight: i === 0 && !r.vigente_hasta ? 600 : 400 }}>
                  {precio6(Number(r.precio_galon))}{i === 0 && !r.vigente_hasta && <span style={{ fontSize: '11px', color: AZUL, fontWeight: 400, marginLeft: '6px' }}>vigente</span>}
                </div>
                <div style={{ fontSize: '12px', color: GRIS }}>desde {corta(r.vigente_desde)}{r.vigente_hasta ? ` – ${corta(r.vigente_hasta)}` : ''}{histNombres[r.creado_por] ? ` · ${histNombres[r.creado_por]}` : ''}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {lista.map(f => (
        <div key={f.id} style={{ border: '0.5px solid ' + BORDE, borderRadius: '12px', background: 'white', overflow: 'hidden' }}>
          <div style={{ padding: '11px 16px', fontSize: '15px', fontWeight: 500, color: NAVY, borderBottom: '0.5px solid #f1f6f9' }}>{String(f.nombre).toUpperCase()}</div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${tipos.length}, 1fr)` }}>
            {tipos.map((t, ti) => {
              const provs = provsDe(f.id, t.id)
              return (
                <div key={t.id} style={{ padding: '12px 16px', borderRight: ti < tipos.length - 1 ? '0.5px solid #f1f6f9' : 'none' }}>
                  <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.03em', color: AZUL, fontWeight: 600, marginBottom: '9px' }}>{t.nombre}</div>
                  {provs.length === 0 ? <div style={{ fontSize: '13px', color: '#c3d0db' }}>—</div> : provs.map(p => linea(f, t, p))}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ========================= SUB-MENÚ: PROVEEDORES =========================
function VistaProveedores({ activas, tipos, proveedores, precioDe, fincasDeProv, tiposDeProv, nombreFinca, nombreTipo,
  alta, setAlta, guardarAlta, guardando, editProv, setEditProv, guardarEditProv, desactivarProv, expandir, setExpandir, abrirFijar, panelFijar, setFijar }) {
  return (
    <div>
      {alta && <PanelAlta {...{ activas, tipos, alta, setAlta, guardarAlta, guardando }} />}
      {panelFijar('proveedores')}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {proveedores.map(prov => {
          const ab = expandir === prov.id
          const sus = fincasDeProv(prov.id)
          const tp = tiposDeProv(prov.id)
          const renom = editProv && editProv.id === prov.id
          return (
            <div key={prov.id} style={{ border: '0.5px solid ' + (ab ? BORDE : '#eef3f7'), borderRadius: '12px', background: 'white', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px' }}>
                <span onClick={() => { setExpandir(ab ? null : prov.id); setFijar(null); setEditProv(null) }} style={{ color: GRIS, fontSize: '12px', cursor: 'pointer' }}>{ab ? '▾' : '▸'}</span>
                {renom ? (
                  <input value={editProv.nombre} onChange={e => setEditProv(x => ({ ...x, nombre: e.target.value }))} style={{ ...inp, width: '220px' }} autoFocus />
                ) : (
                  <span onClick={() => { setExpandir(ab ? null : prov.id); setFijar(null) }} style={{ fontSize: '14px', fontWeight: 500, color: prov.esSin ? GRIS : NAVY, cursor: 'pointer' }}>{prov.nombre}</span>
                )}
                {!renom && tipos.filter(t => tp.includes(t.id)).map(t => (
                  <span key={t.id} style={{ fontSize: '11px', background: '#E6F1FB', color: '#0C447C', padding: '2px 8px', borderRadius: '20px' }}>{t.nombre}</span>
                ))}
                <span style={{ display: 'flex', gap: '12px', alignItems: 'center', marginLeft: 'auto' }}>
                  {renom ? (<>
                    <button onClick={guardarEditProv} disabled={guardando} style={btnLink}>Guardar</button>
                    <button onClick={() => desactivarProv(prov.id, prov.nombre)} style={{ ...btnLink, color: ROJO }}>Eliminar</button>
                    <button onClick={() => setEditProv(null)} style={{ ...btnLink, color: GRIS }}>Cancelar</button>
                  </>) : (<>
                    <span style={{ fontSize: '12px', color: GRIS }}>{sus.length} {sus.length === 1 ? 'finca' : 'fincas'}</span>
                    {!prov.esSin && <button onClick={() => { setEditProv({ id: prov.id, nombre: prov.nombre }); setExpandir(prov.id) }} style={btnLink}>Editar</button>}
                  </>)}
                </span>
              </div>

              {ab && (
                <div style={{ borderTop: '0.5px solid #f1f6f9', background: '#fafcfd' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: `1.6fr repeat(${tipos.length}, 1fr)`, gap: '8px', padding: '8px 16px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.03em', color: GRIS }}>
                    <span>Finca</span>{tipos.map(t => <span key={t.id} style={{ textAlign: 'right' }}>{t.nombre}</span>)}
                  </div>
                  {sus.length === 0 && <div style={{ padding: '8px 16px', fontSize: '13px', color: GRIS, borderTop: '0.5px solid #f1f6f9' }}>Sin fincas todavía. Usa “Agregar finca”.</div>}
                  {sus.map(fincaId => (
                    <div key={fincaId} style={{ display: 'grid', gridTemplateColumns: `1.6fr repeat(${tipos.length}, 1fr)`, gap: '8px', padding: '7px 16px', fontSize: '14px', alignItems: 'center', borderTop: '0.5px solid #f1f6f9' }}>
                      <span>{nombreFinca(fincaId)}</span>
                      {tipos.map(t => { const p = precioDe(prov.id, fincaId, t.id); return <span key={t.id} style={{ textAlign: 'right', color: p ? NAVY : '#c3d0db' }}>{p ? precio6(p.precio) : '—'}</span> })}
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '10px 16px', borderTop: '0.5px solid #f1f6f9', flexWrap: 'wrap' }}>
                    <button onClick={() => abrirFijar({ proveedorId: prov.id, provFijo: true, lugar: prov.id })} style={{ ...boton, fontSize: '12px', padding: '6px 11px' }}>+ Agregar finca</button>
                    {tipos.map(t => (
                      <button key={t.id} onClick={() => abrirFijar({ proveedorId: prov.id, tipoId: t.id, provFijo: true, tipoFijo: true, lugar: prov.id })} style={{ ...boton, fontSize: '12px', padding: '6px 11px' }}>Cambiar precio {t.nombre}</button>
                    ))}
                  </div>
                  {panelFijar(prov.id)}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PanelAlta({ activas, tipos, alta, setAlta, guardarAlta, guardando }) {
  const toggleFinca = fId => setAlta(x => { const fincas = { ...x.fincas }; if (fincas[fId]) delete fincas[fId]; else fincas[fId] = {}; return { ...x, fincas } })
  const setPrecio = (fId, tId, v) => setAlta(x => ({ ...x, fincas: { ...x.fincas, [fId]: { ...x.fincas[fId], [tId]: v } } }))
  return (
    <div style={{ background: '#f6f9fb', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '14px 16px', marginBottom: '14px' }}>
      <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '12px' }}>Agregar proveedor</div>
      <div style={{ marginBottom: '14px', maxWidth: '280px' }}>
        <label style={lbl}>Nombre</label>
        <input value={alta.nombre} placeholder="ej. ALPATRANS" onChange={e => setAlta(x => ({ ...x, nombre: e.target.value }))} style={{ ...inp, width: '100%' }} />
      </div>
      <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.03em', color: GRIS, marginBottom: '8px' }}>¿A qué fincas vende? · marca y pon su precio</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }}>
        {activas.map(f => {
          const marcada = !!alta.fincas[f.id]
          return (
            <div key={f.id} style={{ display: 'grid', gridTemplateColumns: `1.4fr repeat(${tipos.length}, 1fr)`, gap: '8px', alignItems: 'center', background: 'white', border: '0.5px solid ' + (marcada ? BORDE : '#eef3f7'), borderRadius: '8px', padding: '8px 12px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', cursor: 'pointer' }}>
                <input type="checkbox" checked={marcada} onChange={() => toggleFinca(f.id)} />{f.nombre}
              </label>
              {tipos.map(t => (
                <CampoNumero key={t.id} maxDec={6} value={(alta.fincas[f.id] || {})[t.id] || ''} placeholder={marcada ? t.nombre : '—'}
                  onChange={v => setPrecio(f.id, t.id, v)} disabled={!marcada} style={{ ...inp, width: '100%', textAlign: 'right', opacity: marcada ? 1 : 0.4 }} />
              ))}
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
        <div><label style={lbl}>Rige desde</label>
          <input type="date" value={alta.desde} max={hoyISO()} onChange={e => setAlta(x => ({ ...x, desde: e.target.value }))} style={inp} /></div>
        <button onClick={guardarAlta} disabled={guardando} style={{ ...boton, background: AZUL, color: 'white', borderColor: AZUL, opacity: guardando ? 0.6 : 1 }}>{guardando ? 'Creando…' : 'Crear proveedor'}</button>
        <button onClick={() => setAlta(null)} style={boton}>Cancelar</button>
      </div>
    </div>
  )
}

function PanelFijar({ activas, tipos, proveedores, fijar, setFijar, guardarFijar, guardando, nombreTipo }) {
  const usadas = new Set(fijar.grupos.flatMap(g => g.fincaIds))
  const toggle = (gi, fId) => setFijar(x => {
    const grupos = x.grupos.map((g, i) => {
      if (i !== gi) return { ...g, fincaIds: g.fincaIds.filter(id => id !== fId) }
      const has = g.fincaIds.includes(fId)
      return { ...g, fincaIds: has ? g.fincaIds.filter(id => id !== fId) : [...g.fincaIds, fId] }
    })
    return { ...x, grupos }
  })
  const setGrupo = (gi, ids) => setFijar(x => ({ ...x, grupos: x.grupos.map((g, i) => i === gi ? { ...g, fincaIds: ids } : { ...g, fincaIds: g.fincaIds.filter(id => !ids.includes(id)) }) }))
  const zonas = [...new Set(activas.map(f => f.zona).filter(Boolean))]
  const zonaLabel = z => z === 'jambeli' ? 'Jambelí' : z === 'puna' ? 'Puná' : z
  return (
    <div style={{ background: '#f6f9fb', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '14px 16px', marginBottom: '14px' }}>
      <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '12px' }}>Fijar precios</div>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <div>
          <label style={lbl}>Proveedor</label>
          <select value={fijar.proveedorId} disabled={fijar.provFijo} onChange={e => setFijar(x => ({ ...x, proveedorId: e.target.value }))} style={{ ...inp, opacity: fijar.provFijo ? 0.7 : 1 }}>
            <option value="">Elegir…</option>
            {proveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            <option value="__nuevo">+ Nuevo proveedor</option>
          </select>
        </div>
        {fijar.proveedorId === '__nuevo' && (
          <div>
            <label style={lbl}>Nombre del nuevo</label>
            <input value={fijar.nuevoNombre || ''} placeholder="ej. Primax" onChange={e => setFijar(x => ({ ...x, nuevoNombre: e.target.value }))} style={inp} autoFocus />
          </div>
        )}
        <div>
          <label style={lbl}>Tipo</label>
          <select value={fijar.tipoId} disabled={fijar.tipoFijo} onChange={e => setFijar(x => ({ ...x, tipoId: e.target.value }))} style={{ ...inp, opacity: fijar.tipoFijo ? 0.7 : 1 }}>
            <option value="">Elegir…</option>
            {tipos.map(t => <option key={t.id} value={t.id}>{t.nombre}</option>)}
          </select>
        </div>
      </div>
      <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.03em', color: GRIS, marginBottom: '8px' }}>¿A qué fincas y a qué precio?</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {fijar.grupos.map((g, gi) => (
          <div key={gi} style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '8px', padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '12px', color: GRIS }}>Precio</span>
              <CampoNumero maxDec={6} value={g.precio} placeholder="ej. 4.09"
                onChange={v => setFijar(x => ({ ...x, grupos: x.grupos.map((gg, i) => i === gi ? { ...gg, precio: v } : gg) }))} style={{ ...inp, width: '100px', textAlign: 'right' }} />
              <button onClick={() => setGrupo(gi, activas.map(f => f.id))} style={{ ...chipQuick, marginLeft: '4px' }}>Todas</button>
              {zonas.map(z => <button key={z} onClick={() => setGrupo(gi, activas.filter(f => f.zona === z).map(f => f.id))} style={chipQuick}>{zonaLabel(z)}</button>)}
              <button onClick={() => setGrupo(gi, [])} style={{ ...chipQuick, color: GRIS }}>Ninguna</button>
              {fijar.grupos.length > 1 && <button onClick={() => setFijar(x => ({ ...x, grupos: x.grupos.filter((_, i) => i !== gi) }))} style={{ ...btnLink, color: ROJO, marginLeft: 'auto' }}>Quitar grupo</button>}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {activas.map(f => {
                const marcada = g.fincaIds.includes(f.id)
                const ocupada = usadas.has(f.id) && !marcada
                return (
                  <button key={f.id} onClick={() => toggle(gi, f.id)} disabled={ocupada}
                    style={{ fontSize: '12px', padding: '4px 10px', borderRadius: '20px', cursor: ocupada ? 'default' : 'pointer', fontFamily: 'inherit',
                      border: '0.5px solid ' + (marcada ? AZUL : BORDE), background: marcada ? '#E6F1FB' : 'white', color: marcada ? '#0C447C' : (ocupada ? '#c3d0db' : NAVY) }}>{f.nombre}</button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', marginTop: '12px', flexWrap: 'wrap' }}>
        <button onClick={() => setFijar(x => ({ ...x, grupos: [...x.grupos, { precio: '', fincaIds: [] }] }))} style={btnLink}>+ Otro precio</button>
        <div style={{ marginLeft: 'auto' }}><label style={lbl}>Rige desde</label>
          <input type="date" value={fijar.desde} max={hoyISO()} onChange={e => setFijar(x => ({ ...x, desde: e.target.value }))} style={inp} /></div>
        <button onClick={guardarFijar} disabled={guardando} style={{ ...boton, background: AZUL, color: 'white', borderColor: AZUL, opacity: guardando ? 0.6 : 1 }}>{guardando ? 'Aplicando…' : 'Guardar precios'}</button>
        <button onClick={() => setFijar(null)} style={boton}>Cancelar</button>
      </div>
    </div>
  )
}

const inp = { padding: '8px 10px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '8px', background: 'white', color: NAVY }
const lbl = { display: 'block', fontSize: '11px', color: GRIS, margin: '0 0 5px' }
const boton = { padding: '9px 14px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500, border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY, cursor: 'pointer' }
const btnLink = { fontSize: '12px', border: 'none', background: 'none', color: AZUL, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }
const chipQuick = { fontSize: '11px', padding: '3px 9px', borderRadius: '20px', border: '0.5px solid ' + BORDE, background: 'white', color: AZUL, cursor: 'pointer', fontFamily: 'inherit' }
