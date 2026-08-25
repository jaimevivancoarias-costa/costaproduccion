import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import {
  hoyISO, lunesDe, sumarDias, semanaDe, corta, cortita,
  nombreDia, semanaISO, situacionDia, num, miles,
} from '../lib/fechas'

// Registro diario de insumos · modulo Produccion
//
// Se parece al de balanceado, pero con una diferencia que manda en el
// diseno: una piscina puede recibir VARIOS insumos el mismo dia. Por
// eso la celda de un dia no es un dato, es una lista de lineas.
//
// Vacio significa vacio: que una piscina no reciba insumos un dia es
// lo normal, no un olvido. No hay "no aplico" ni bloquea el cierre.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const HOYB = '#F3F8FD'

const UNIDAD = {
  sacos: 'sacos', litros: 'litros', gramos: 'g',
  libras: 'lb', kg: 'kg', unidad: 'u',
}

const ordenar = (a, b) => {
  const na = parseInt(String(a.codigo).replace(/\D/g, '')) || 0
  const nb = parseInt(String(b.codigo).replace(/\D/g, '')) || 0
  if (a.tipo !== b.tipo) return a.tipo === 'precria' ? 1 : -1
  return na - nb
}

export default function RegistroInsumos({ finca, esJefe, soloLectura, lunes, setLunes }) {
  const [piscinas, setPiscinas] = useState([])
  const [insumos, setInsumos] = useState([])
  const [lineas, setLineas] = useState({})   // `${piscinaId}|${fecha}` -> [{id, insumoId, cantidad}]
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [abierta, setAbierta] = useState(null)  // celda con el agregador abierto

  const fechas = useMemo(() => semanaDe(lunes), [lunes])
  const hoy = hoyISO()
  const semanaDeHoy = lunesDe(hoy) === lunes
  const domingo = fechas[6]

  const puedeEditar = f =>
    !soloLectura && situacionDia(f, hoy) !== 'futuro' && (esJefe || semanaDeHoy)

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    try {
      const [{ data: ps, error: eP }, { data: ins }, { data: cs }] = await Promise.all([
        supabase.schema('produccion').from('piscina')
          .select('id, codigo, nombre, hectareas, tipo')
          .eq('finca_id', finca.id).eq('activa', true),
        supabase.schema('produccion').from('insumo')
          .select('id, nombre, unidad').eq('activo', true).order('nombre'),
        supabase.schema('produccion').from('ciclo')
          .select('id, piscina_origen_id, fecha_siembra, fecha_cierre')
          .eq('finca_id', finca.id),
      ])
      if (eP) throw eP

      const lista = (ps || []).map(p => ({
        piscinaId: p.id, codigo: p.codigo, nombre: p.nombre,
        hectareas: Number(p.hectareas), tipo: p.tipo,
        // El ciclo que cubre la semana, para colgarle el consumo. Si no
        // hay (piscina en preparacion), va null y el trigger lo pega a
        // la siembra siguiente.
        cicloId: (cs || []).find(c => c.piscina_origen_id === p.id
          && c.fecha_siembra <= domingo
          && (!c.fecha_cierre || c.fecha_cierre >= lunes))?.id || null,
      })).sort(ordenar)
      setPiscinas(lista)
      setInsumos(ins || [])

      const ids = lista.map(p => p.piscinaId)
      const mapa = {}
      if (ids.length) {
        const { data: co, error: eC } = await supabase.schema('produccion')
          .from('consumo_insumo')
          .select('id, piscina_id, fecha, insumo_id, cantidad')
          .in('piscina_id', ids).gte('fecha', lunes).lte('fecha', domingo)
        if (eC) throw eC
        ;(co || []).forEach(r => {
          const k = `${r.piscina_id}|${r.fecha}`
          ;(mapa[k] = mapa[k] || []).push(
            { id: r.id, insumoId: r.insumo_id, cantidad: r.cantidad })
        })
      }
      setLineas(mapa)
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally {
      setCargando(false)
    }
  }, [finca.id, lunes, domingo])

  useEffect(() => { cargar() }, [cargar])

  const nombreInsumo = id => insumos.find(x => x.id === id)?.nombre || ''
  const unidadInsumo = id => UNIDAD[insumos.find(x => x.id === id)?.unidad] || ''
  const cel = (p, f) => lineas[`${p.piscinaId}|${f}`] || []

  // Se guarda linea por linea: son pocas por celda y evita el baile de
  // diffing de todo el grid. Optimista: se pinta y si falla se revierte.
  async function agregar(p, f, insumoId, cantidad) {
    const cant = num(cantidad)
    if (!insumoId || !cant) return
    const k = `${p.piscinaId}|${f}`
    const yaHay = (lineas[k] || []).find(l => l.insumoId === insumoId)
    if (yaHay) {
      setAviso({ tipo: 'error', texto: 'Ese insumo ya está en ese día. Edita la cantidad.' })
      return
    }
    const fila = { piscina_id: p.piscinaId, fecha: f, insumo_id: insumoId,
                   ciclo_id: p.cicloId, cantidad: cant }
    const { data, error } = await supabase.schema('produccion').from('consumo_insumo')
      .insert(fila).select('id').single()
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return }
    setLineas(m => ({ ...m, [k]: [...(m[k] || []), { id: data.id, insumoId, cantidad: cant }] }))
    setAbierta(null)
  }

  async function cambiarCantidad(k, id, valor) {
    const cant = num(valor)
    setLineas(m => ({ ...m, [k]: m[k].map(l => l.id === id ? { ...l, cantidad: valor } : l) }))
    if (!cant) return
    await supabase.schema('produccion').from('consumo_insumo')
      .update({ cantidad: cant, actualizado_en: new Date().toISOString() }).eq('id', id)
  }

  async function quitar(k, id) {
    const antes = lineas[k]
    setLineas(m => ({ ...m, [k]: m[k].filter(l => l.id !== id) }))
    const { error } = await supabase.schema('produccion').from('consumo_insumo').delete().eq('id', id)
    if (error) { setLineas(m => ({ ...m, [k]: antes })); setAviso({ tipo: 'error', texto: error.message }) }
  }

  const COLS = `150px 84px repeat(7, minmax(150px, 1fr))`

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY, padding: '1.4rem 1.4rem 4rem' }}>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                    gap: '18px', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 500, margin: '0 0 5px' }}>Insumos de la semana</h1>
          <div style={{ fontSize: '13px', color: GRIS }}>
            Semana {semanaISO(lunes).semana} · del {corta(lunes)} al {corta(domingo)}
            {semanaDeHoy && ` · hoy es ${nombreDia(hoy).toLowerCase()}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <Btn onClick={() => setLunes(sumarDias(lunes, -7))}>‹</Btn>
          <Btn onClick={() => setLunes(lunesDe(hoy))}>Esta semana</Btn>
          <Btn onClick={() => setLunes(sumarDias(lunes, 7))} disabled={lunes >= lunesDe(hoy)}>›</Btn>
          <input type="date" value={lunes} max={hoy}
                 onChange={e => e.target.value && setLunes(lunesDe(e.target.value))}
                 style={{ padding: '8px 10px', fontSize: '13px', fontFamily: 'inherit',
                          border: '0.5px solid ' + BORDE, borderRadius: '9px', color: NAVY }} />
        </div>
      </div>

      {aviso && (
        <div style={{ padding: '10px 14px', borderRadius: '9px', marginBottom: '10px', fontSize: '13px',
          background: aviso.tipo === 'error' ? '#FCEBEB' : '#EAF3DE',
          color: aviso.tipo === 'error' ? '#A32D2D' : '#3B6D11' }}>{aviso.texto}</div>
      )}

      <div style={{ fontSize: '12px', color: GRIS, marginBottom: '10px' }}>
        Una piscina puede recibir varios insumos el mismo día. Que un día quede vacío es normal.
      </div>

      {cargando ? (
        <div style={{ padding: '40px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>
          Cargando la semana...
        </div>
      ) : (
        <div style={{ overflowX: 'auto', border: '0.5px solid ' + BORDE, borderRadius: '12px', background: 'white' }}>
          <div style={{ minWidth: '1240px' }}>
            {/* Encabezado */}
            <div style={{ display: 'grid', gridTemplateColumns: COLS, borderBottom: '0.5px solid ' + BORDE,
                          background: '#f6f9fb', position: 'sticky', top: 0 }}>
              <Th pegado>Piscina</Th>
              <Th>Hectáreas</Th>
              {fechas.map(f => (
                <Th key={f} hoy={situacionDia(f, hoy) === 'hoy'}>
                  <div style={{ textTransform: 'capitalize' }}>{nombreDia(f)}</div>
                  <div style={{ fontSize: '11px', color: GRIS, fontWeight: 400 }}>{cortita(f)}</div>
                </Th>
              ))}
            </div>

            {piscinas.map(p => (
              <div key={p.piscinaId} style={{ display: 'grid', gridTemplateColumns: COLS,
                    borderBottom: '0.5px solid #f1f6f9', alignItems: 'stretch' }}>
                <div style={{ padding: '10px 12px', position: 'sticky', left: 0, background: 'white',
                              borderRight: '0.5px solid #f1f6f9' }}>
                  <div style={{ fontWeight: 500, fontSize: '14px' }}>{p.nombre}</div>
                  <div style={{ fontSize: '11px', color: GRIS }}>
                    {p.tipo === 'precria' ? 'precría' : (p.cicloId ? 'con ciclo' : 'vacía · preparación')}
                  </div>
                </div>
                <div style={{ padding: '10px 12px', fontSize: '13px', color: GRIS }}>
                  {p.hectareas.toFixed(2)}
                </div>
                {fechas.map(f => {
                  const k = `${p.piscinaId}|${f}`
                  const ls = cel(p, f)
                  const edit = puedeEditar(f)
                  const abriendo = abierta === k
                  return (
                    <div key={f} style={{ padding: '7px 8px',
                          background: situacionDia(f, hoy) === 'hoy' ? HOYB
                                    : situacionDia(f, hoy) === 'futuro' ? '#fbfcfd' : 'white',
                          borderLeft: '0.5px solid #f6f9fb' }}>
                      {ls.map(l => (
                        <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: '5px',
                              marginBottom: '4px' }}>
                          <span style={{ flex: 1, fontSize: '11px', color: NAVY, overflow: 'hidden',
                                         textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                title={nombreInsumo(l.insumoId)}>
                            {nombreInsumo(l.insumoId)}
                          </span>
                          {edit ? (
                            <>
                              <input inputMode="decimal" value={l.cantidad}
                                onChange={e => cambiarCantidad(k, l.id, e.target.value)}
                                style={{ width: '52px', fontFamily: 'inherit', fontSize: '12px',
                                         padding: '3px 5px', textAlign: 'right', border: '0.5px solid ' + BORDE,
                                         borderRadius: '6px', fontVariantNumeric: 'tabular-nums' }} />
                              <span style={{ fontSize: '10px', color: GRIS, width: '30px' }}>
                                {unidadInsumo(l.insumoId)}
                              </span>
                              <button onClick={() => quitar(k, l.id)} title="Quitar"
                                style={{ border: 'none', background: 'none', cursor: 'pointer',
                                         color: '#c3d0db', fontSize: '14px', lineHeight: 1, padding: 0 }}>×</button>
                            </>
                          ) : (
                            <span style={{ fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}>
                              {miles(num(l.cantidad))} {unidadInsumo(l.insumoId)}
                            </span>
                          )}
                        </div>
                      ))}

                      {edit && (abriendo ? (
                        <Agregar
                          insumos={insumos}
                          usados={ls.map(l => l.insumoId)}
                          onGuardar={(insumoId, cant) => agregar(p, f, insumoId, cant)}
                          onCerrar={() => setAbierta(null)}
                        />
                      ) : (
                        <button onClick={() => setAbierta(k)} style={{
                          border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit',
                          fontSize: '11px', color: AZUL, padding: '2px 0' }}>
                          + agregar
                        </button>
                      ))}

                      {!ls.length && !edit && (
                        <span style={{ fontSize: '11px', color: '#c3d0db' }}>—</span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// El agregador de una celda: elegir insumo y poner cantidad.
function Agregar({ insumos, usados, onGuardar, onCerrar }) {
  const [insumoId, setInsumoId] = useState('')
  const [cant, setCant] = useState('')
  const libres = insumos.filter(i => !usados.includes(i.id))
  return (
    <div style={{ marginTop: '4px', padding: '6px', background: '#f6f9fb', borderRadius: '7px' }}>
      <select value={insumoId} onChange={e => setInsumoId(e.target.value)}
        style={{ width: '100%', fontFamily: 'inherit', fontSize: '11px', padding: '4px',
                 border: '0.5px solid ' + BORDE, borderRadius: '6px', marginBottom: '4px' }}>
        <option value="">Elegir insumo</option>
        {libres.map(i => <option key={i.id} value={i.id}>{i.nombre}</option>)}
      </select>
      <div style={{ display: 'flex', gap: '4px' }}>
        <input inputMode="decimal" value={cant} placeholder="Cantidad" autoFocus
          onChange={e => setCant(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && (onGuardar(insumoId, cant))}
          style={{ flex: 1, fontFamily: 'inherit', fontSize: '11px', padding: '4px',
                   border: '0.5px solid ' + BORDE, borderRadius: '6px', minWidth: 0 }} />
        <button onClick={() => onGuardar(insumoId, cant)} disabled={!insumoId || !num(cant)}
          style={{ border: 'none', background: AZUL, color: 'white', borderRadius: '6px',
                   fontFamily: 'inherit', fontSize: '11px', padding: '4px 8px',
                   cursor: 'pointer', opacity: (!insumoId || !num(cant)) ? 0.4 : 1 }}>ok</button>
        <button onClick={onCerrar}
          style={{ border: '0.5px solid ' + BORDE, background: 'white', borderRadius: '6px',
                   fontFamily: 'inherit', fontSize: '11px', padding: '4px 7px', cursor: 'pointer',
                   color: GRIS }}>×</button>
      </div>
    </div>
  )
}

function Th({ children, pegado, hoy }) {
  return (
    <div style={{ padding: '9px 12px', fontSize: '11px', fontWeight: 500, color: GRIS,
                  textTransform: 'uppercase', letterSpacing: '0.03em',
                  position: pegado ? 'sticky' : 'static', left: pegado ? 0 : undefined,
                  background: hoy ? '#E6F1FB' : '#f6f9fb',
                  borderRight: pegado ? '0.5px solid ' + BORDE : 'none' }}>
      {children}
    </div>
  )
}

function Btn({ children, disabled, onClick }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: '8px 13px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500,
      border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY,
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1,
    }}>{children}</button>
  )
}
