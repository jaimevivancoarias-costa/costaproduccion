import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, num, numDec, dinero, miles } from '../lib/fechas'

// Precios de insumos · modulo Produccion
//
// Por ahora el precio es UNO para las nueve fincas (finca_id nulo).
// Cambiarlo rige desde la fecha que se elija hacia adelante: se cierra
// la vigencia del precio anterior y se abre uno nuevo. Las semanas ya
// registradas conservan el precio con el que se guardaron, porque el
// consumo congela su precio al momento de registrarse.
//
// Solo jefes cambian precios.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'

const ROJO = '#8A2F2E', VERDE = '#0F6E56'
const UNIDAD = {
  sacos: 'sacos', litros: 'litros', gramos: 'gramos',
  libras: 'libras', kg: 'kilos', unidad: 'unidades',
}
const UNIDADES = ['sacos', 'litros', 'gramos', 'libras', 'kg', 'unidad']

export default function PreciosInsumos({ finca, esJefe }) {
  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [editando, setEditando] = useState(null)
  const [editandoInsumo, setEditandoInsumo] = useState(null)
  const [agregando, setAgregando] = useState(false)

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    // Cada finca tiene su propio precio de insumo. Traemos el de la finca
    // y el general; si la finca no tiene el suyo, se muestra el general
    // como "heredado" (es el que rige hasta que se le ponga uno propio).
    const [{ data: ins }, { data: pr }] = await Promise.all([
      supabase.schema('produccion').from('insumo')
        .select('id, nombre, unidad, unidad_compra, factor').eq('activo', true).order('nombre'),
      supabase.schema('produccion').from('precio_insumo')
        .select('id, insumo_id, finca_id, precio_unitario, vigente_desde')
        .or(`finca_id.is.null,finca_id.eq.${finca.id}`).is('vigente_hasta', null),
    ])
    const propio = {}, general = {}
    ;(pr || []).forEach(x => { (x.finca_id ? propio : general)[x.insumo_id] = x })
    setFilas((ins || []).map(i => {
      const p = propio[i.id] || general[i.id] || null
      return { ...i, precio: p, heredado: !propio[i.id] && !!general[i.id] }
    }))
    setCargando(false)
  }, [finca.id])

  useEffect(() => { cargar() }, [cargar])

  async function crear({ nombre, unidad, unidadCompra, factor }) {
    const { error } = await supabase.schema('produccion').from('insumo')
      .insert({ nombre: nombre.trim(), unidad,
                unidad_compra: (unidadCompra || unidad).trim(), factor: factor || 1 })
    if (error) {
      const dup = /duplicate|unique/i.test(error.message)
      setAviso({ tipo: 'error', texto: dup ? 'Ya existe un insumo con ese nombre.' : 'No se pudo agregar. ' + error.message })
      return false
    }
    setAgregando(false)
    setAviso({ tipo: 'ok', texto: 'Insumo agregado. Ponle su precio con "Cambiar".' })
    await cargar()
    return true
  }

  async function guardarInsumo({ id, nombre, unidad, unidadCompra, factor }) {
    const { error } = await supabase.schema('produccion').from('insumo')
      .update({ nombre: nombre.trim(), unidad,
                unidad_compra: (unidadCompra || unidad).trim(), factor: factor || 1 })
      .eq('id', id)
    if (error) {
      const dup = /duplicate|unique/i.test(error.message)
      setAviso({ tipo: 'error', texto: dup ? 'Ya existe un insumo con ese nombre.' : 'No se pudo guardar. ' + error.message })
      return
    }
    setEditandoInsumo(null)
    setAviso({ tipo: 'ok', texto: 'Insumo actualizado. Cambia en todas las fincas.' })
    await cargar()
  }

  async function quitar(f) {
    if (!window.confirm(`¿Quitar "${f.nombre}" de la lista?\n\nDeja de aparecer para cargar, pero el historial que ya tiene se conserva.`)) return
    const { error } = await supabase.schema('produccion').from('insumo')
      .update({ activo: false }).eq('id', f.id)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo quitar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: `${f.nombre} quitado de la lista.` })
    await cargar()
  }

  async function guardarPrecio({ insumoId, nuevo, desde }) {
    // Precio propio de ESTA finca. El precio general no se toca.
    // 1) Borra cualquier precio de esta finca que arranque en o después
    //    de `desde` (evita el choque de rangos si ya se puso hoy).
    await supabase.schema('produccion').from('precio_insumo')
      .delete().eq('insumo_id', insumoId).eq('finca_id', finca.id).gte('vigente_desde', desde)
    // 2) Cierra el que estaba vigente antes de `desde`.
    await supabase.schema('produccion').from('precio_insumo')
      .update({ vigente_hasta: sumarDias(desde, -1) })
      .eq('insumo_id', insumoId).eq('finca_id', finca.id).is('vigente_hasta', null).lt('vigente_desde', desde)
    // 3) Abre el nuevo.
    const { error } = await supabase.schema('produccion').from('precio_insumo')
      .insert({ insumo_id: insumoId, finca_id: finca.id, precio_unitario: nuevo, vigente_desde: desde })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return }
    setEditando(null)
    setAviso({ tipo: 'ok', texto: 'Precio actualizado para ' + String(finca.nombre) + '.' })
    await cargar()
  }

  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                  padding: '16px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                    gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <div>
          <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 4px' }}>
            Precios de insumos · {String(finca.nombre).toUpperCase()}
          </h3>
          <p style={{ fontSize: '13px', color: GRIS, margin: 0, maxWidth: '560px' }}>
            Cada finca tiene su propio precio. Cambiar el de esta finca no toca al de las demás.
            {esJefe
              ? ' Rige desde la fecha que elijas hacia adelante; lo ya registrado no se mueve.'
              : ' Solo un jefe puede cambiarlos.'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {esJefe && !agregando && (
            <button onClick={() => { setAgregando(true); setAviso(null) }}
              style={{ padding: '8px 14px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500,
                       border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white',
                       color: NAVY, cursor: 'pointer' }}>
              + Agregar insumo
            </button>
          )}
          <button onClick={() => exportar(filas)} disabled={!filas.length}
            style={{ padding: '8px 14px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500,
                     border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white',
                     color: NAVY, cursor: filas.length ? 'pointer' : 'default',
                     opacity: filas.length ? 1 : 0.5 }}>
            Exportar
          </button>
        </div>
      </div>

      {agregando && <AltaInsumo onCrear={crear} onCancelar={() => setAgregando(false)} />}

      {aviso && (
        <div style={{ borderRadius: '9px', padding: '10px 13px', fontSize: '13px', marginBottom: '11px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE',
                      color: aviso.tipo === 'error' ? '#8A2F2E' : '#0F6E56' }}>{aviso.texto}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px,1fr) 110px 120px 250px',
                    gap: '12px', padding: '0 0 8px', fontSize: '11px', color: GRIS }}>
        <div>Insumo</div>
        <div style={{ textAlign: 'right' }}>Precio</div>
        <div>Vigente desde</div>
        <div />
      </div>

      {cargando ? (
        <div style={{ fontSize: '13px', color: GRIS, padding: '14px 0' }}>Cargando...</div>
      ) : filas.map(f => (
        <div key={f.id} style={{ borderBottom: '0.5px solid #f1f6f9', padding: '9px 0' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px,1fr) 110px 120px 250px',
                        gap: '12px', alignItems: 'center' }}>
            <span style={{ fontWeight: 500, fontSize: '14px' }}>
              {f.nombre}
              <span style={{ fontSize: '11px', color: GRIS, fontWeight: 400 }}> · por {UNIDAD[f.unidad] || f.unidad}</span>
              {f.unidad_compra && f.unidad_compra !== f.unidad && Number(f.factor) !== 1 && (
                <div style={{ fontSize: '11px', color: GRIS, fontWeight: 400 }}>
                  se compra por {f.unidad_compra} · {miles(f.factor)} {UNIDAD[f.unidad] || f.unidad} c/u
                </div>
              )}
            </span>
            <span style={{ fontSize: '16px', fontWeight: 500, textAlign: 'right',
                           fontVariantNumeric: 'tabular-nums' }}>
              {f.precio
                ? <>
                    {dinero(f.precio.precio_unitario)}
                    {f.heredado && <div style={{ fontSize: '10px', color: GRIS, fontWeight: 400 }}>general (heredado)</div>}
                  </>
                : <span style={{ fontSize: '13px', color: '#BA7517' }}>sin precio</span>}
            </span>
            <span style={{ fontSize: '13px', color: GRIS }}>
              {f.precio ? corta(f.precio.vigente_desde) : '—'}
            </span>
            {esJefe ? (
              <div style={{ display: 'flex', gap: '7px', justifyContent: 'flex-end' }}>
                <button onClick={() => { setEditando(editando === f.id ? null : f.id); setEditandoInsumo(null) }}
                  style={accion}>{editando === f.id ? 'Cancelar' : 'Precio'}</button>
                <button onClick={() => { setEditandoInsumo(editandoInsumo === f.id ? null : f.id); setEditando(null) }}
                  style={accion}>{editandoInsumo === f.id ? 'Cancelar' : 'Editar'}</button>
                <button onClick={() => quitar(f)}
                  style={{ ...accion, borderColor: '#e7cccb', color: ROJO }}>Quitar</button>
              </div>
            ) : <span />}
          </div>
          {editando === f.id && (
            <Forma actual={f} onGuardar={guardarPrecio} />
          )}
          {editandoInsumo === f.id && (
            <EditarInsumo actual={f} onGuardar={guardarInsumo} onCancelar={() => setEditandoInsumo(null)} />
          )}
        </div>
      ))}
    </div>
  )
}

function Forma({ actual, onGuardar }) {
  const [nuevo, setNuevo] = useState(actual.precio ? String(actual.precio.precio_unitario) : '')
  const [desde, setDesde] = useState(hoyISO())
  const [enviando, setEnviando] = useState(false)
  const v = numDec(nuevo)
  const anterior = actual.precio ? Number(actual.precio.precio_unitario) : null
  const cambio = v && v !== anterior

  return (
    <div style={{ background: '#f7fafc', borderRadius: '10px', padding: '14px', marginTop: '10px' }}>
      <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>
            Precio nuevo por {UNIDAD[actual.unidad] || actual.unidad}
          </div>
          <input inputMode="decimal" value={nuevo} onChange={e => setNuevo(e.target.value)}
            style={{ padding: '9px 11px', fontSize: '15px', fontFamily: 'inherit', width: '140px',
                     border: '0.5px solid ' + BORDE, borderRadius: '9px', textAlign: 'right',
                     fontVariantNumeric: 'tabular-nums' }} />
        </div>
        <div>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Rige desde</div>
          <input type="date" value={desde} onChange={e => setDesde(e.target.value)}
            style={{ padding: '9px 11px', fontSize: '14px', fontFamily: 'inherit',
                     border: '0.5px solid ' + BORDE, borderRadius: '9px' }} />
        </div>
        <button disabled={!cambio || enviando}
          onClick={async () => { setEnviando(true)
            await onGuardar({ insumoId: actual.id, nuevo: v, desde }); setEnviando(false) }}
          style={{ background: AZUL, color: 'white', border: 'none', borderRadius: '9px',
                   padding: '10px 20px', fontFamily: 'inherit', fontSize: '14px', fontWeight: 500,
                   cursor: (!cambio || enviando) ? 'default' : 'pointer',
                   opacity: (!cambio || enviando) ? 0.45 : 1 }}>
          {enviando ? 'Guardando...' : 'Aplicar'}
        </button>
      </div>
      {cambio && anterior !== null && (
        <div style={{ fontSize: '13px', color: GRIS, marginTop: '11px' }}>
          {v > anterior ? 'Sube' : 'Baja'}{' '}
          <b style={{ color: NAVY, fontWeight: 500 }}>{dinero(Math.abs(v - anterior))}</b>.
          Lo registrado antes del {corta(desde)} no cambia.
        </div>
      )}
    </div>
  )
}

// Alta de un insumo nuevo. La unidad de consumo es como se aplica en las
// piscinas. Si se compra distinto (un tambor que trae 25000 gramos, una
// botella de 5 litros), se marca la casilla y se dice cuanto trae cada uno.
function AltaInsumo({ onCrear, onCancelar }) {
  const [nombre, setNombre] = useState('')
  const [unidad, setUnidad] = useState('kg')
  const [compraDistinta, setCompraDistinta] = useState(false)
  const [unidadCompra, setUnidadCompra] = useState('')
  const [factor, setFactor] = useState('')
  const [enviando, setEnviando] = useState(false)

  const listo = nombre.trim() && (!compraDistinta || (unidadCompra.trim() && numDec(factor) > 0))

  return (
    <div style={{ background: '#f7fafc', borderRadius: '10px', padding: '15px', marginBottom: '14px' }}>
      <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Nombre del insumo</div>
          <input autoFocus value={nombre} onChange={e => setNombre(e.target.value)}
            placeholder="Ej. Cal agrícola" style={{ ...campo, width: '220px' }} />
        </div>
        <div>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Cómo se aplica</div>
          <select value={unidad} onChange={e => setUnidad(e.target.value)} style={{ ...campo, width: '150px' }}>
            {UNIDADES.map(u => <option key={u} value={u}>{UNIDAD[u]}</option>)}
          </select>
        </div>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '14px 0 0', fontSize: '13px', cursor: 'pointer' }}>
        <input type="checkbox" checked={compraDistinta} onChange={e => setCompraDistinta(e.target.checked)} />
        Se compra en otra presentación (tambor, botella, bidón…)
      </label>

      {compraDistinta && (
        <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '10px' }}>
          <div>
            <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Se compra por</div>
            <input value={unidadCompra} onChange={e => setUnidadCompra(e.target.value)}
              placeholder="Ej. tambor" style={{ ...campo, width: '150px' }} />
          </div>
          <div>
            <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Cada uno trae ({UNIDAD[unidad]})</div>
            <input inputMode="decimal" value={factor} onChange={e => setFactor(e.target.value)}
              placeholder="Ej. 25000" style={{ ...campo, width: '150px', textAlign: 'right' }} />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '9px', marginTop: '15px' }}>
        <button disabled={!listo || enviando}
          onClick={async () => { setEnviando(true)
            await onCrear({ nombre, unidad, unidadCompra: compraDistinta ? unidadCompra : unidad, factor: compraDistinta ? numDec(factor) : 1 })
            setEnviando(false) }}
          style={{ background: AZUL, color: 'white', border: 'none', borderRadius: '9px',
                   padding: '10px 20px', fontFamily: 'inherit', fontSize: '14px', fontWeight: 500,
                   cursor: (!listo || enviando) ? 'default' : 'pointer', opacity: (!listo || enviando) ? 0.45 : 1 }}>
          {enviando ? 'Agregando...' : 'Agregar'}
        </button>
        <button onClick={onCancelar}
          style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '9px',
                   padding: '10px 18px', fontFamily: 'inherit', fontSize: '14px', color: NAVY, cursor: 'pointer' }}>
          Cancelar
        </button>
      </div>
    </div>
  )
}

const campo = { padding: '9px 11px', fontSize: '14px', fontFamily: 'inherit',
                border: '0.5px solid ' + BORDE, borderRadius: '9px', boxSizing: 'border-box', background: 'white' }
const accion = { background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '9px',
                 padding: '7px 12px', fontFamily: 'inherit', fontSize: '13px', color: NAVY, cursor: 'pointer' }

// Editar un insumo del catalogo (nombre y unidades). Es global: el cambio
// vale para las 11 fincas, porque el catalogo de insumos es uno solo.
function EditarInsumo({ actual, onGuardar, onCancelar }) {
  const [nombre, setNombre] = useState(actual.nombre)
  const [unidad, setUnidad] = useState(actual.unidad)
  const distintaInicial = actual.unidad_compra && actual.unidad_compra !== actual.unidad
  const [compraDistinta, setCompraDistinta] = useState(!!distintaInicial)
  const [unidadCompra, setUnidadCompra] = useState(distintaInicial ? actual.unidad_compra : '')
  const [factor, setFactor] = useState(distintaInicial ? String(actual.factor) : '')
  const [enviando, setEnviando] = useState(false)
  const listo = nombre.trim() && (!compraDistinta || (unidadCompra.trim() && numDec(factor) > 0))

  return (
    <div style={{ background: '#f7fafc', borderRadius: '10px', padding: '14px', marginTop: '10px' }}>
      <div style={{ fontSize: '12px', color: GRIS, marginBottom: '10px' }}>
        Editar insumo · el cambio vale para todas las fincas
      </div>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Nombre</div>
          <input autoFocus value={nombre} onChange={e => setNombre(e.target.value)} style={{ ...campo, width: '220px' }} />
        </div>
        <div>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Cómo se aplica</div>
          <select value={unidad} onChange={e => setUnidad(e.target.value)} style={{ ...campo, width: '150px' }}>
            {UNIDADES.map(u => <option key={u} value={u}>{UNIDAD[u]}</option>)}
          </select>
        </div>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '12px 0 0', fontSize: '13px', cursor: 'pointer' }}>
        <input type="checkbox" checked={compraDistinta} onChange={e => setCompraDistinta(e.target.checked)} />
        Se compra en otra presentación (tambor, botella, bidón…)
      </label>
      {compraDistinta && (
        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '10px' }}>
          <div>
            <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Se compra por</div>
            <input value={unidadCompra} onChange={e => setUnidadCompra(e.target.value)} placeholder="ej. tambor" style={{ ...campo, width: '150px' }} />
          </div>
          <div>
            <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Cada uno trae ({UNIDAD[unidad]})</div>
            <input inputMode="decimal" value={factor} onChange={e => setFactor(e.target.value)} placeholder="ej. 25000" style={{ ...campo, width: '150px', textAlign: 'right' }} />
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: '9px', marginTop: '14px' }}>
        <button disabled={!listo || enviando}
          onClick={async () => { setEnviando(true)
            await onGuardar({ id: actual.id, nombre, unidad,
              unidadCompra: compraDistinta ? unidadCompra : unidad, factor: compraDistinta ? numDec(factor) : 1 })
            setEnviando(false) }}
          style={{ background: AZUL, color: 'white', border: 'none', borderRadius: '9px', padding: '10px 20px',
                   fontFamily: 'inherit', fontSize: '14px', fontWeight: 500,
                   cursor: (!listo || enviando) ? 'default' : 'pointer', opacity: (!listo || enviando) ? 0.45 : 1 }}>
          {enviando ? 'Guardando...' : 'Guardar cambios'}
        </button>
        <button onClick={onCancelar} style={{ ...accion, padding: '10px 18px', fontSize: '14px' }}>Cancelar</button>
      </div>
    </div>
  )
}

function exportar(filas) {
  const cab = ['Insumo', 'Unidad', 'Precio', 'Vigente desde']
  const rows = filas.map(f => [
    f.nombre, UNIDAD[f.unidad] || f.unidad,
    f.precio ? f.precio.precio_unitario : '',
    f.precio ? f.precio.vigente_desde : '',
  ])
  const csv = [cab, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = 'precios_insumos.csv'; a.click()
  URL.revokeObjectURL(url)
}

function sumarDias(iso, n) {
  const d = new Date(iso + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}
