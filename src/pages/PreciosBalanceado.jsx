import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, numDec, dinero } from '../lib/fechas'

// Precios de balanceado · modulo Produccion
//
// El precio del saco es POR FINCA (cada finca negocia el suyo). Cambiarlo
// rige desde la fecha que se elija hacia adelante: se cierra la vigencia
// del precio anterior y se abre uno nuevo. Lo ya registrado no se mueve,
// porque el consumo congela su precio al momento de guardarse.
//
// Desde aqui tambien se agrega un balanceado nuevo al catalogo o se
// quita uno que ya no se usa (se desactiva; el historico se conserva).
//
// Solo jefes.

const NAVY = '#022847', AZUL = '#0D6CB0', BORDE = '#dce6ef', GRIS = '#7d8fa0'
const ROJO = '#8A2F2E', VERDE = '#0F6E56'
const G = 'minmax(220px,1fr) 130px 140px 200px'

export default function PreciosBalanceado({ finca, esJefe, esJefeGlobal }) {
  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [editando, setEditando] = useState(null)
  const [agregando, setAgregando] = useState(false)
  const [nombreNuevo, setNombreNuevo] = useState('')
  const [marcaNueva, setMarcaNueva] = useState('')
  const [creando, setCreando] = useState(false)
  const [fincas, setFincas] = useState([])
  const [solNuevos, setSolNuevos] = useState([])

  useEffect(() => {
    supabase.schema('produccion').from('finca').select('id, nombre').eq('activa', true).order('nombre')
      .then(({ data }) => setFincas(data || []))
  }, [])

  const cargarNuevos = useCallback(async () => {
    if (!esJefeGlobal) { setSolNuevos([]); return }
    const { data } = await supabase.schema('produccion').from('solicitud_correccion')
      .select('id, valor_propuesto, finca:finca_id (nombre)')
      .eq('tabla', 'nuevo_producto').eq('estado', 'pendiente').order('solicitado_en')
    setSolNuevos(data || [])
  }, [esJefeGlobal])
  useEffect(() => { cargarNuevos() }, [cargarNuevos])

  async function resolverNuevo(sol, aprobar) {
    const { error } = await supabase.schema('produccion').rpc('fn_resolver_correccion', { p_id: sol.id, p_aprobar: aprobar })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo resolver. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: aprobar ? 'Balanceado agregado al catálogo.' : 'Pedido rechazado.' })
    await cargar(); await cargarNuevos()
  }

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    const [{ data: prod }, { data: pr }] = await Promise.all([
      supabase.schema('produccion').from('producto')
        .select('id, nombre, marca').eq('activo', true).order('nombre'),
      supabase.schema('produccion').from('precio_producto')
        .select('id, producto_id, precio_saco, vigente_desde')
        .eq('finca_id', finca.id).is('vigente_hasta', null),
    ])
    const precioDe = {}
    ;(pr || []).forEach(x => { precioDe[x.producto_id] = x })
    setFilas((prod || []).map(p => ({ ...p, precio: precioDe[p.id] || null })))
    setCargando(false)
  }, [finca.id])

  useEffect(() => { cargar() }, [cargar])

  async function guardarPrecio({ productoId, nuevo, desde, fincaIds }) {
    const ids = (fincaIds && fincaIds.length) ? fincaIds : [finca.id]
    for (const fid of ids) {
      await supabase.schema('produccion').from('precio_producto')
        .delete().eq('producto_id', productoId).eq('finca_id', fid).gte('vigente_desde', desde)
      await supabase.schema('produccion').from('precio_producto')
        .update({ vigente_hasta: sumarDias(desde, -1) })
        .eq('producto_id', productoId).eq('finca_id', fid).is('vigente_hasta', null).lt('vigente_desde', desde)
      const { error } = await supabase.schema('produccion').from('precio_producto')
        .insert({ producto_id: productoId, finca_id: fid, precio_saco: nuevo, vigente_desde: desde })
      if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return }
    }
    setEditando(null)
    setAviso({ tipo: 'ok', texto: ids.length === 1 ? 'Precio actualizado.' : `Precio actualizado en ${ids.length} fincas.` })
    await cargar()
  }

  async function crear() {
    if (!nombreNuevo.trim()) { setAviso({ tipo: 'error', texto: 'Escribe el nombre del balanceado.' }); return }
    setCreando(true)
    const { error } = await supabase.schema('produccion').from('producto')
      .insert({ nombre: nombreNuevo.trim(), marca: marcaNueva.trim() || null })
    setCreando(false)
    if (error) {
      const dup = /duplicate|unique/i.test(error.message)
      setAviso({ tipo: 'error', texto: dup ? 'Ya existe un balanceado con ese nombre.' : 'No se pudo agregar. ' + error.message })
      return
    }
    setAgregando(false); setNombreNuevo(''); setMarcaNueva('')
    setAviso({ tipo: 'ok', texto: 'Balanceado agregado.' })
    await cargar()
  }

  async function quitar(f) {
    if (!window.confirm(`¿Quitar "${f.nombre}" de la lista?\n\nDeja de aparecer para cargar, pero el historial que ya tiene se conserva.`)) return
    const { error } = await supabase.schema('produccion').from('producto')
      .update({ activo: false }).eq('id', f.id)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo quitar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: `${f.nombre} quitado de la lista.` })
    await cargar()
  }

  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '16px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                    gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <div>
          <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 4px' }}>Precios de balanceado</h3>
          <p style={{ fontSize: '13px', color: GRIS, margin: 0, maxWidth: '560px' }}>
            Precio del saco en {String(finca.nombre).toUpperCase()}.
            {esJefe
              ? ' Al cambiarlo, rige desde la fecha que elijas hacia adelante; lo ya registrado no se mueve.'
              : ' Solo un jefe puede cambiarlos.'}
          </p>
        </div>
        {esJefeGlobal && !agregando && (
          <button onClick={() => { setAgregando(true); setAviso(null) }} style={botonSec}>+ Agregar balanceado</button>
        )}
      </div>

      {aviso && (
        <div style={{ borderRadius: '9px', padding: '10px 13px', fontSize: '13px', marginBottom: '11px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE',
                      color: aviso.tipo === 'error' ? ROJO : VERDE }}>{aviso.texto}</div>
      )}

      {esJefeGlobal && solNuevos.length > 0 && (
        <div style={{ background: '#FBF5E9', border: '0.5px solid #ecd9b3', borderRadius: '10px', padding: '13px 15px', marginBottom: '12px' }}>
          <div style={{ fontWeight: 500, fontSize: '14px', marginBottom: '4px' }}>
            Balanceados pedidos por bodega ({solNuevos.length})
          </div>
          {solNuevos.map(s => {
            const vp = s.valor_propuesto || {}
            return (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    gap: '10px', flexWrap: 'wrap', borderTop: '0.5px solid #ecd9b3', paddingTop: '9px', marginTop: '9px' }}>
                <div style={{ fontSize: '13px' }}>
                  <b style={{ fontWeight: 500 }}>{vp.nombre}</b>{vp.marca ? ` · ${vp.marca}` : ''}
                  <div style={{ fontSize: '11px', color: GRIS }}>Pedido por {s.finca?.nombre}</div>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={() => resolverNuevo(s, true)} style={botonSec}>Aprobar</button>
                  <button onClick={() => resolverNuevo(s, false)} style={{ ...botonSec, color: ROJO, borderColor: '#e7cccb' }}>Rechazar</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {agregando && (
        <div style={{ background: '#f7fafc', borderRadius: '10px', padding: '14px', marginBottom: '14px',
                      display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Nombre del balanceado</div>
            <input autoFocus value={nombreNuevo} onChange={e => setNombreNuevo(e.target.value)}
                   placeholder="Ej. Nicovita 35" style={{ ...inp, width: '220px' }} />
          </div>
          <div>
            <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Marca (opcional)</div>
            <input value={marcaNueva} onChange={e => setMarcaNueva(e.target.value)}
                   placeholder="Ej. Nicovita" style={{ ...inp, width: '160px' }} />
          </div>
          <button onClick={crear} disabled={creando || !nombreNuevo.trim()}
                  style={{ ...botonPri, opacity: (creando || !nombreNuevo.trim()) ? 0.5 : 1 }}>
            {creando ? 'Agregando...' : 'Agregar'}
          </button>
          <button onClick={() => { setAgregando(false); setNombreNuevo(''); setMarcaNueva('') }} style={botonSec}>Cancelar</button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: G, gap: '12px', padding: '0 0 8px', fontSize: '11px', color: GRIS }}>
        <div>Balanceado</div>
        <div style={{ textAlign: 'right' }}>Precio saco</div>
        <div>Vigente desde</div>
        <div />
      </div>

      {cargando ? (
        <div style={{ fontSize: '13px', color: GRIS, padding: '14px 0' }}>Cargando...</div>
      ) : !filas.length ? (
        <div style={{ fontSize: '13px', color: GRIS, padding: '14px 0' }}>No hay balanceados en la lista todavía.</div>
      ) : filas.map(f => (
        <div key={f.id} style={{ borderBottom: '0.5px solid #f1f6f9', padding: '9px 0' }}>
          <div style={{ display: 'grid', gridTemplateColumns: G, gap: '12px', alignItems: 'center' }}>
            <span style={{ fontWeight: 500, fontSize: '14px' }}>
              {f.nombre}
              {f.marca && <span style={{ fontSize: '11px', color: GRIS, fontWeight: 400 }}> · {f.marca}</span>}
            </span>
            <span style={{ fontSize: '16px', fontWeight: 500, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {f.precio ? dinero(f.precio.precio_saco) : <span style={{ fontSize: '13px', color: '#BA7517' }}>Sin precio</span>}
            </span>
            <span style={{ fontSize: '13px', color: GRIS }}>
              {f.precio ? corta(f.precio.vigente_desde) : '—'}
            </span>
            {esJefe ? (
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button onClick={() => setEditando(editando === f.id ? null : f.id)} style={botonSec}>
                  {editando === f.id ? 'Cancelar' : 'Cambiar'}
                </button>
                {esJefeGlobal && (
                  <button onClick={() => quitar(f)} style={{ ...botonSec, color: ROJO, borderColor: '#e7cccb' }}>
                    Quitar
                  </button>
                )}
              </div>
            ) : <span />}
          </div>
          {editando === f.id && <Forma actual={f} onGuardar={guardarPrecio} fincas={fincas} fincaActual={finca} />}
        </div>
      ))}
    </div>
  )
}

function Forma({ actual, onGuardar, fincas, fincaActual }) {
  const [nuevo, setNuevo] = useState(actual.precio ? String(actual.precio.precio_saco) : '')
  const [desde, setDesde] = useState(hoyISO())
  const [enviando, setEnviando] = useState(false)
  const [sel, setSel] = useState([fincaActual.id])
  const v = numDec(nuevo)
  const anterior = actual.precio ? Number(actual.precio.precio_saco) : null
  const cambio = v && v !== anterior && sel.length > 0
  const otras = (fincas || []).filter(f => f.id !== fincaActual.id)
  const toggle = id => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])

  return (
    <div style={{ background: '#f7fafc', borderRadius: '10px', padding: '14px', marginTop: '10px' }}>
      <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Precio nuevo por saco</div>
          <input inputMode="decimal" value={nuevo} onChange={e => setNuevo(e.target.value)}
            style={{ ...inp, width: '140px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} />
        </div>
        <div>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Rige desde</div>
          <input type="date" value={desde} onChange={e => setDesde(e.target.value)} style={inp} />
        </div>
        <button disabled={!cambio || enviando}
          onClick={async () => { setEnviando(true); await onGuardar({ productoId: actual.id, nuevo: v, desde, fincaIds: sel }); setEnviando(false) }}
          style={{ ...botonPri, padding: '10px 20px', opacity: (!cambio || enviando) ? 0.45 : 1 }}>
          {enviando ? 'Guardando...' : 'Aplicar'}
        </button>
      </div>

      {otras.length > 0 && (
        <div style={{ marginTop: '12px' }}>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '6px' }}>Aplicar este mismo precio a:</div>
          <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px',
                           background: '#e7eef5', borderRadius: '20px', padding: '5px 11px', color: NAVY }}>
              {String(fincaActual.nombre).toUpperCase()} (esta)
            </span>
            {otras.map(f => {
              const on = sel.includes(f.id)
              return (
                <button key={f.id} onClick={() => toggle(f.id)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px',
                           borderRadius: '20px', padding: '5px 11px', cursor: 'pointer', fontFamily: 'inherit',
                           border: '0.5px solid ' + (on ? '#9cc4e8' : BORDE),
                           background: on ? '#E6F1FB' : 'white', color: on ? AZUL : NAVY, fontWeight: on ? 500 : 400 }}>
                  {on ? '✓ ' : ''}{String(f.nombre).toUpperCase()}
                </button>
              )
            })}
          </div>
          {otras.length > 1 && (
            <button onClick={() => setSel([fincaActual.id, ...otras.map(f => f.id)])}
              style={{ marginTop: '7px', background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                       color: AZUL, fontFamily: 'inherit', fontSize: '11px' }}>Todas las fincas</button>
          )}
        </div>
      )}

      {cambio && anterior !== null && (
        <div style={{ fontSize: '13px', color: GRIS, marginTop: '11px' }}>
          {v > anterior ? 'Sube' : 'Baja'}{' '}
          <b style={{ color: NAVY, fontWeight: 500 }}>{dinero(Math.abs(v - anterior))}</b>.
          Lo registrado antes del {corta(desde)} no cambia.
          {sel.length > 1 && ` Se aplicará a ${sel.length} fincas.`}
        </div>
      )}
    </div>
  )
}

function sumarDias(iso, n) {
  const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

const inp = { padding: '9px 11px', fontSize: '14px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '9px', boxSizing: 'border-box' }
const botonSec = { background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '9px', padding: '7px 13px', fontFamily: 'inherit', fontSize: '13px', color: NAVY, cursor: 'pointer' }
const botonPri = { background: AZUL, color: 'white', border: 'none', borderRadius: '9px', padding: '10px 18px', fontFamily: 'inherit', fontSize: '14px', fontWeight: 500, cursor: 'pointer' }
