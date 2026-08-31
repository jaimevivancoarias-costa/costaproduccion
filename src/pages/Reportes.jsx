import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, miles, dinero } from '../lib/fechas'

// Reportes · modulo Produccion
//
// Analiza el consumo de balanceado e insumos en un rango de fechas.
// Se puede ver por item (en que se va la plata), por piscina (cual
// gasta de mas) o por finca (comparar las nueve entre si).

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const VERDE = '#0F6E56'
const AMBAR = '#854F0B'

const UNIDAD = {
  sacos: 'sacos', litros: 'litros', gramos: 'g',
  libras: 'lb', kg: 'kg', unidad: 'u',
}

const primeroDelMes = iso => iso.slice(0, 8) + '01'

export default function Reportes({ finca, fincas, esJefe, enfoqueInsumos }) {
  const [filas, setFilas] = useState([])
  const [ciclos, setCiclos] = useState([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)

  const [desde, setDesde] = useState(primeroDelMes(hoyISO()))
  const [hasta, setHasta] = useState(hoyISO())
  const [todasFincas, setTodasFincas] = useState(false)
  // Si se entra desde la barra de presupuesto, arranca en insumos.
  const [tipo, setTipo] = useState(enfoqueInsumos ? 'insumo' : 'todo')
  const [agrupar, setAgrupar] = useState('item') // 'item' | 'piscina' | 'finca'
  const [cicloSel, setCicloSel] = useState('')

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    try {
      const { data, error } = await supabase.schema('produccion')
        .rpc('fn_reporte_consumo', {
          p_finca: todasFincas ? null : finca.id,
          p_desde: desde, p_hasta: hasta,
        })
      if (error) throw error
      setFilas(data || [])
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally {
      setCargando(false)
    }
  }, [finca.id, desde, hasta, todasFincas])

  useEffect(() => { cargar() }, [cargar])

  // Ciclos de la finca, para el atajo "por ciclo".
  useEffect(() => {
    if (todasFincas) { setCiclos([]); return }
    supabase.schema('produccion').from('ciclo')
      .select('id, fecha_siembra, fecha_cierre, piscina:piscina_origen_id (nombre)')
      .eq('finca_id', finca.id).order('fecha_siembra', { ascending: false }).limit(60)
      .then(({ data }) => setCiclos(data || []))
  }, [finca.id, todasFincas])

  function irAlCiclo(id) {
    setCicloSel(id)
    const c = ciclos.find(x => x.id === id)
    if (!c) return
    setDesde(c.fecha_siembra)
    setHasta(c.fecha_cierre || hoyISO())
  }

  // Filtrado por tipo y agregado segun lo elegido.
  const visibles = useMemo(
    () => filas.filter(f => tipo === 'todo' || f.tipo === tipo),
    [filas, tipo])

  const grupos = useMemo(() => {
    const m = {}
    visibles.forEach(f => {
      const clave = agrupar === 'item' ? f.item_id
                  : agrupar === 'piscina' ? f.piscina_id
                  : f.finca_id
      const etiqueta = agrupar === 'item' ? f.item
                     : agrupar === 'piscina' ? f.piscina
                     : f.finca
      if (!m[clave]) m[clave] = {
        clave, etiqueta, costo: 0, cantidad: 0,
        unidad: f.unidad, tipo: f.tipo, hectareas: Number(f.hectareas) || 0,
        mixto: false,
      }
      const g = m[clave]
      g.costo += Number(f.costo)
      // Solo tiene sentido sumar cantidades si comparten unidad.
      if (g.unidad === f.unidad) g.cantidad += Number(f.cantidad)
      else g.mixto = true
      if (g.tipo !== f.tipo) g.tipo = 'mixto'
    })
    return Object.values(m).sort((a, b) => b.costo - a.costo)
  }, [visibles, agrupar])

  const totalCosto = grupos.reduce((t, g) => t + g.costo, 0)
  const maxCosto = Math.max(1, ...grupos.map(g => g.costo))
  // El bodeguero no ve columnas de dolares, asi que la tabla es mas
  // angosta: solo nombre y cantidad.
  const grid = esJefe ? GRID : '1fr 220px'

  return (
    <div style={{ padding: '1.4rem 1.5rem', maxWidth: '1180px' }}>
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ fontSize: '19px', fontWeight: 500, margin: '0 0 4px' }}>Reportes de consumo</h2>
        <p style={{ fontSize: '13px', color: GRIS, margin: 0 }}>
          Balanceado e insumos. En qué se gasta, en qué piscina y comparado entre fincas.
        </p>
      </div>

      {/* Filtros */}
      <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                    padding: '14px 16px', marginBottom: '16px', display: 'flex',
                    gap: '18px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Campo label="Del">
          <input type="date" value={desde} max={hasta}
                 onChange={e => { setDesde(e.target.value); setCicloSel('') }} style={entrada} />
        </Campo>
        <Campo label="Al">
          <input type="date" value={hasta} min={desde} max={hoyISO()}
                 onChange={e => { setHasta(e.target.value); setCicloSel('') }} style={entrada} />
        </Campo>
        <div style={{ display: 'flex', gap: '6px' }}>
          <Chip pequeno onClick={() => { setDesde(primeroDelMes(hoyISO())); setHasta(hoyISO()); setCicloSel('') }}>
            Este mes
          </Chip>
          <Chip pequeno onClick={() => { setDesde(hoyISO().slice(0, 4) + '-01-01'); setHasta(hoyISO()); setCicloSel('') }}>
            Este año
          </Chip>
        </div>
        {!todasFincas && ciclos.length > 0 && (
          <Campo label="O un ciclo">
            <select value={cicloSel} onChange={e => e.target.value && irAlCiclo(e.target.value)} style={entrada}>
              <option value="">Elegir ciclo</option>
              {ciclos.map(c => (
                <option key={c.id} value={c.id}>
                  {c.piscina?.nombre} · {corta(c.fecha_siembra)}{c.fecha_cierre ? ` a ${corta(c.fecha_cierre)}` : ' (abierto)'}
                </option>
              ))}
            </select>
          </Campo>
        )}
        {fincas.length > 1 && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px',
                          cursor: 'pointer', marginLeft: 'auto' }}>
            <input type="checkbox" checked={todasFincas}
                   onChange={e => { setTodasFincas(e.target.checked); if (e.target.checked) setAgrupar('finca') }} />
            Comparar todas las fincas
          </label>
        )}
      </div>

      {/* Ejes */}
      <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <Grupo titulo="Mostrar">
          <Chip on={tipo === 'todo'} onClick={() => setTipo('todo')}>Todo</Chip>
          <Chip on={tipo === 'balanceado'} onClick={() => setTipo('balanceado')}>Balanceado</Chip>
          <Chip on={tipo === 'insumo'} onClick={() => setTipo('insumo')}>Insumos</Chip>
        </Grupo>
        <Grupo titulo="Agrupar por">
          <Chip on={agrupar === 'item'} onClick={() => setAgrupar('item')}>Producto</Chip>
          <Chip on={agrupar === 'piscina'} onClick={() => setAgrupar('piscina')} disabled={todasFincas}>Piscina</Chip>
          <Chip on={agrupar === 'finca'} onClick={() => setAgrupar('finca')}>Finca</Chip>
        </Grupo>
      </div>

      {aviso && (
        <div style={{ borderRadius: '10px', padding: '12px 14px', fontSize: '13px', marginBottom: '12px',
                      background: '#FBEAEA', color: '#8A2F2E' }}>{aviso.texto}</div>
      )}

      {/* Resumen */}
      {!cargando && (
        <div style={{ display: 'flex', gap: '11px', flexWrap: 'wrap', marginBottom: '14px' }}>
          {/* El gasto en dolares es solo del jefe. */}
          {esJefe && <Kpi titulo="Gasto total del rango" valor={dinero(totalCosto)} />}
          <Kpi titulo={agrupar === 'item' ? 'Productos' : agrupar === 'piscina' ? 'Piscinas' : 'Fincas'}
               valor={String(grupos.length)} />
          <Kpi titulo="Días" valor={String(dias(desde, hasta))} />
        </div>
      )}

      {cargando ? (
        <Caja><Centro>Cargando...</Centro></Caja>
      ) : !grupos.length ? (
        <Caja><Centro>No hay consumo registrado en este rango.</Centro></Caja>
      ) : (
        <Caja>
          <div style={{ display: 'grid', gridTemplateColumns: grid, gap: '12px', padding: '11px 16px',
                        fontSize: '11px', color: GRIS, textTransform: 'uppercase', letterSpacing: '0.03em',
                        borderBottom: '0.5px solid ' + BORDE, background: '#f6f9fb' }}>
            <span>{agrupar === 'item' ? 'Producto' : agrupar === 'piscina' ? 'Piscina' : 'Finca'}</span>
            <span style={{ textAlign: 'right' }}>Cantidad</span>
            {esJefe && <span style={{ textAlign: 'right' }}>Costo</span>}
            {esJefe && <span>Peso</span>}
            {esJefe && agrupar === 'piscina' && <span style={{ textAlign: 'right' }}>Costo / ha</span>}
          </div>

          {grupos.map(g => (
            <div key={g.clave} style={{ display: 'grid', gridTemplateColumns: grid, gap: '12px',
                    padding: '10px 16px', alignItems: 'center', fontSize: '13px',
                    borderBottom: '0.5px solid #f1f6f9' }}>
              <span>
                {g.etiqueta}
                {agrupar === 'item' && (
                  <span style={{ fontSize: '11px', color: g.tipo === 'insumo' ? AMBAR : AZUL,
                                 marginLeft: '7px' }}>
                    {g.tipo === 'insumo' ? 'insumo' : 'balanceado'}
                  </span>
                )}
              </span>
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: GRIS }}>
                {g.mixto ? '—' : `${miles(g.cantidad)} ${UNIDAD[g.unidad] || g.unidad || ''}`}
              </span>
              {esJefe && (
                <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                  {dinero(g.costo)}
                </span>
              )}
              {esJefe && (
                <span style={{ display: 'block', height: '8px', background: '#eef3f7', borderRadius: '20px',
                               overflow: 'hidden' }}>
                  <i style={{ display: 'block', height: '100%', borderRadius: '20px',
                              width: (g.costo / maxCosto * 100) + '%',
                              background: g.tipo === 'insumo' ? '#E3B15F' : AZUL }} />
                </span>
              )}
              {esJefe && agrupar === 'piscina' && (
                <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: GRIS }}>
                  {g.hectareas ? dinero(g.costo / g.hectareas) : '—'}
                </span>
              )}
            </div>
          ))}

          {esJefe && (
            <div style={{ display: 'grid', gridTemplateColumns: grid, gap: '12px', padding: '12px 16px',
                          alignItems: 'center', background: '#fafcfd', fontSize: '14px', fontWeight: 500 }}>
              <span>Total</span>
              <span />
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dinero(totalCosto)}</span>
              <span />
              {agrupar === 'piscina' && <span />}
            </div>
          )}
        </Caja>
      )}

      {/* La descarga incluye costos, asi que es solo del jefe. */}
      {esJefe && <button onClick={() => exportarCSV(grupos, agrupar)}
        disabled={!grupos.length}
        style={{ marginTop: '14px', padding: '9px 16px', fontSize: '13px', fontFamily: 'inherit',
                 fontWeight: 500, border: '0.5px solid ' + BORDE, borderRadius: '9px',
                 background: 'white', color: NAVY, cursor: grupos.length ? 'pointer' : 'default',
                 opacity: grupos.length ? 1 : 0.5 }}>
        Descargar en Excel
      </button>}
    </div>
  )
}

// Descarga un CSV que Excel abre directo. No es para volver a trabajar
// ahi, es para mandarle un cuadro a quien no entra al sistema.
function exportarCSV(grupos, agrupar) {
  const cab = [agrupar === 'item' ? 'Producto' : agrupar === 'piscina' ? 'Piscina' : 'Finca',
               'Tipo', 'Cantidad', 'Unidad', 'Costo']
  const filas = grupos.map(g => [
    g.etiqueta, g.tipo, g.mixto ? '' : g.cantidad, g.unidad || '', g.costo.toFixed(2),
  ])
  const csv = [cab, ...filas].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = 'reporte_consumo.csv'; a.click()
  URL.revokeObjectURL(url)
}

const GRID = '1fr 150px 120px 160px'

function dias(a, b) {
  return Math.max(1, Math.floor((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000) + 1)
}

function Campo({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>{label}</div>
      {children}
    </div>
  )
}
function Grupo({ titulo, children }) {
  return (
    <div>
      <div style={{ fontSize: '12px', color: GRIS, marginBottom: '6px' }}>{titulo}</div>
      <div style={{ display: 'flex', gap: '6px' }}>{children}</div>
    </div>
  )
}
function Chip({ children, on, pequeno, disabled, onClick }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: pequeno ? '7px 12px' : '8px 14px', borderRadius: '20px', fontFamily: 'inherit',
      fontSize: pequeno ? '12px' : '13px', cursor: disabled ? 'default' : 'pointer',
      border: '0.5px solid ' + (on ? '#9cc4e8' : BORDE),
      background: on ? '#E6F1FB' : 'white', color: disabled ? '#c3d0db' : on ? AZUL : NAVY,
      fontWeight: on ? 500 : 400, opacity: disabled ? 0.6 : 1,
    }}>{children}</button>
  )
}
function Kpi({ titulo, valor }) {
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                  padding: '13px 16px', minWidth: '150px' }}>
      <div style={{ fontSize: '11px', color: GRIS, marginBottom: '5px',
                    letterSpacing: '0.03em', textTransform: 'uppercase' }}>{titulo}</div>
      <div style={{ fontSize: '20px', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{valor}</div>
    </div>
  )
}
function Caja({ children }) {
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                  overflow: 'hidden' }}>{children}</div>
  )
}
function Centro({ children }) {
  return <div style={{ padding: '34px', textAlign: 'center', fontSize: '13px', color: GRIS }}>{children}</div>
}
const entrada = { padding: '8px 11px', fontSize: '13px', fontFamily: 'inherit',
                  border: '0.5px solid ' + BORDE, borderRadius: '9px',
                  boxSizing: 'border-box', background: 'white' }
