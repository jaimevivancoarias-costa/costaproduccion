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
  sacos: 'sacos', litros: 'litros', ml: 'mL', gramos: 'g',
  libras: 'lb', kg: 'kg', unidad: 'u',
}

const cap1 = s => { const t = String(s || ''); return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : t }

const primeroDelMes = iso => iso.slice(0, 8) + '01'

// Lunes y domingo de la semana pasada, para el reporte de los lunes.
function semanaPasada() {
  const d = new Date(hoyISO() + 'T12:00:00')
  const dia = (d.getDay() + 6) % 7          // 0 = lunes
  const lunEsta = new Date(d); lunEsta.setDate(d.getDate() - dia)
  const lun = new Date(lunEsta); lun.setDate(lunEsta.getDate() - 7)
  const dom = new Date(lun); dom.setDate(lun.getDate() + 6)
  return [lun.toISOString().slice(0, 10), dom.toISOString().slice(0, 10)]
}

export default function Reportes({ finca, fincas, esJefe, enfoqueInsumos }) {
  const [filas, setFilas] = useState([])
  const [cosechas, setCosechas] = useState([])
  const [proceso, setProceso] = useState([])
  const [valor, setValor] = useState([])   // valorización de bodega
  const [valFinca, setValFinca] = useState(finca.id)   // finca del reporte de valorización ('todas' = todas)
  const [valFincas, setValFincas] = useState([])       // total por finca (gráfica, modo Todas)
  const [valTipo, setValTipo] = useState('insumo')     // 'insumo' | 'balanceado' | 'diesel'
  const [dslVal, setDslVal] = useState([])             // valorización de diesel [{tipo, saldo, precio, valor}]
  const [estado, setEstado] = useState([])             // estado / reponer
  const [estFinca, setEstFinca] = useState(finca.id)   // finca del reporte de estado ('todas' = todas)
  const [estTipo, setEstTipo] = useState('insumo')     // 'insumo' | 'balanceado'
  const [descs, setDescs] = useState([])               // descuadres (control de conteos)
  const [descTipo, setDescTipo] = useState('insumo')
  const [ciclos, setCiclos] = useState([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  // Que reporte: consumo del rango, o cierre de ciclos cosechados.
  const [kind, setKind] = useState('consumo')

  const [desde, setDesde] = useState(primeroDelMes(hoyISO()))
  const [hasta, setHasta] = useState(hoyISO())
  const [todasFincas, setTodasFincas] = useState(false)
  const [dslR, setDslR] = useState({ total: 0, tipos: [] })  // diesel del rango (finca individual)
  const [verTodoR, setVerTodoR] = useState(false)            // incluir diesel en el total
  // Si se entra desde la barra de presupuesto, arranca en insumos.
  const [tipo, setTipo] = useState(enfoqueInsumos ? 'insumo' : 'todo')
  const [agrupar, setAgrupar] = useState('item') // 'item' | 'piscina' | 'finca'
  const [cicloSel, setCicloSel] = useState('')

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    try {
      const p = { p_finca: todasFincas ? null : finca.id, p_desde: desde, p_hasta: hasta }
      const [{ data: cons, error: e1 }, { data: cos, error: e2 }, { data: proc, error: e3 }] = await Promise.all([
        supabase.schema('produccion').rpc('fn_reporte_consumo', p),
        supabase.schema('produccion').rpc('fn_reporte_cosechas', p),
        supabase.schema('produccion').rpc('fn_reporte_en_proceso',
          { p_finca: todasFincas ? null : finca.id, p_hasta: hasta }),
      ])
      if (e1) throw e1
      if (e2) throw e2
      if (e3) throw e3
      setFilas(cons || [])
      setCosechas(cos || [])
      setProceso(proc || [])
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally {
      setCargando(false)
    }
  }, [finca.id, desde, hasta, todasFincas])

  useEffect(() => { cargar() }, [cargar])

  // Diesel del rango (finca individual). En modo Todas se omite.
  useEffect(() => {
    let vivo = true
    ;(async () => {
      if (todasFincas) { setDslR({ total: 0, tipos: [] }); return }
      const [{ data: tp }, { data: co }, { data: tot }] = await Promise.all([
        supabase.schema('produccion').from('diesel_tipo').select('id, nombre').eq('activo', true).order('nombre'),
        supabase.schema('produccion').from('diesel_consumo').select('tipo_id, galones').eq('finca_id', finca.id).gte('fecha', desde).lte('fecha', hasta),
        supabase.schema('produccion').rpc('fn_gasto_diesel_periodo', { p_finca: finca.id, p_desde: desde, p_hasta: hasta }),
      ])
      const gal = {}; (co || []).forEach(r => { gal[r.tipo_id] = (gal[r.tipo_id] || 0) + Number(r.galones) })
      const per = await Promise.all((tp || []).map(t =>
        supabase.schema('produccion').rpc('fn_gasto_diesel_periodo', { p_finca: finca.id, p_desde: desde, p_hasta: hasta, p_tipo: t.id })))
      if (!vivo) return
      setDslR({ total: Number(tot) || 0, tipos: (tp || []).map((t, i) => ({ nombre: t.nombre, galones: gal[t.id] || 0, gasto: Number(per[i].data) || 0 })) })
    })()
    return () => { vivo = false }
  }, [finca.id, todasFincas, desde, hasta])

  // Al cambiar la finca global, los reportes "ahora" la siguen.
  useEffect(() => { setValFinca(finca.id); setEstFinca(finca.id) }, [finca.id])

  // Valorización de diesel (saldo × precio). Por finca, o sumada por tipo.
  useEffect(() => {
    let vivo = true
    if (valTipo !== 'diesel') { setDslVal([]); return }
    ;(async () => {
      const ids = valFinca === 'todas' ? (fincas || []).map(f => f.id) : [valFinca]
      const res = await Promise.all(ids.map(id =>
        supabase.schema('produccion').rpc('fn_reporte_valorizacion_diesel', { p_finca: id })))
      const acc = {}
      res.forEach(r => (r.data || []).forEach(x => {
        const k = x.tipo
        if (!acc[k]) acc[k] = { tipo: x.tipo, saldo: 0, valor: 0, precio: null, nPrecio: 0 }
        acc[k].saldo += Number(x.saldo) || 0
        acc[k].valor += Number(x.valor) || 0
        if (x.precio != null) { acc[k].precio = Number(x.precio); acc[k].nPrecio++ }
      }))
      if (!vivo) return
      // Con una sola finca el precio es único; en "todas" se oculta.
      setDslVal(Object.values(acc).map(a => ({ ...a, precio: valFinca === 'todas' ? null : a.precio })))
    })()
    return () => { vivo = false }
  }, [valFinca, valTipo, fincas])

  // Valorización: es "ahora". Por finca o sumada; insumos o balanceados.
  useEffect(() => {
    let vivo = true
    if (valTipo === 'diesel') return
    const bal = valTipo === 'balanceado'
    if (valFinca === 'todas') {
      Promise.all([
        supabase.schema('produccion').rpc(bal ? 'fn_reporte_valorizacion_bal_todas' : 'fn_reporte_valorizacion_todas'),
        supabase.schema('produccion').rpc(bal ? 'fn_valorizacion_bal_por_finca' : 'fn_valorizacion_por_finca'),
      ]).then(([a, b]) => { if (!vivo) return; if (a.error) setAviso({ tipo: 'error', texto: a.error.message }); setValor(a.data || []); setValFincas(b.data || []) })
    } else {
      supabase.schema('produccion').rpc(bal ? 'fn_reporte_valorizacion_bal' : 'fn_reporte_valorizacion', { p_finca: valFinca })
        .then(({ data, error }) => { if (!vivo) return; if (error) setAviso({ tipo: 'error', texto: error.message }); setValor(data || []); setValFincas([]) })
    }
    return () => { vivo = false }
  }, [valFinca, valTipo])

  // Estado / reponer: es "ahora". Por finca o todas; insumos o balanceados.
  useEffect(() => {
    let vivo = true
    supabase.schema('produccion').rpc(estTipo === 'balanceado' ? 'fn_reporte_estado_bal' : 'fn_reporte_estado',
      { p_finca: estFinca === 'todas' ? null : estFinca })
      .then(({ data, error }) => { if (!vivo) return; if (error) setAviso({ tipo: 'error', texto: error.message }); setEstado(data || []) })
    return () => { vivo = false }
  }, [estFinca, estTipo])

  // Descuadres (control de conteos): usa el rango de fechas y la finca.
  useEffect(() => {
    let vivo = true
    supabase.schema('produccion').rpc(descTipo === 'balanceado' ? 'fn_reporte_descuadres_bal' : 'fn_reporte_descuadres',
      { p_finca: todasFincas ? null : finca.id, p_desde: desde, p_hasta: hasta })
      .then(({ data, error }) => { if (!vivo) return; if (error) setAviso({ tipo: 'error', texto: error.message }); setDescs(data || []) })
    return () => { vivo = false }
  }, [finca.id, desde, hasta, todasFincas, descTipo])

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
      <div style={{ marginBottom: '14px' }}>
        <h2 style={{ fontSize: '19px', fontWeight: 500, margin: '0 0 10px' }}>Reportes</h2>
        <div style={{ display: 'flex', gap: '7px' }}>
          <Chip on={kind === 'consumo'} onClick={() => setKind('consumo')}>Consumo</Chip>
          {esJefe && <Chip on={kind === 'valorizacion'} onClick={() => setKind('valorizacion')}>Valorización de bodega total</Chip>}
          <Chip on={kind === 'estado'} onClick={() => setKind('estado')}>Estado / Reponer</Chip>
          <Chip on={kind === 'descuadres'} onClick={() => setKind('descuadres')}>Descuadres</Chip>
          <Chip on={kind === 'proceso'} onClick={() => setKind('proceso')}>En proceso</Chip>
          <Chip on={kind === 'cosechas'} onClick={() => setKind('cosechas')}>Cosechas</Chip>
        </div>
      </div>

      {/* Filtros (valorización y estado son "ahora", no usan rango de fechas) */}
      {kind !== 'valorizacion' && kind !== 'estado' && (
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
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <Chip pequeno onClick={() => { const [l, d] = semanaPasada(); setDesde(l); setHasta(d); setCicloSel('') }}>
            Semana pasada
          </Chip>
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
      )}

      {aviso && (
        <div style={{ borderRadius: '10px', padding: '12px 14px', fontSize: '13px', marginBottom: '12px',
                      background: '#FBEAEA', color: '#8A2F2E' }}>{aviso.texto}</div>
      )}

      {kind === 'cosechas' && (
        <ReporteCosechas cosechas={cosechas} cargando={cargando} esJefe={esJefe}
                         todasFincas={todasFincas} />
      )}

      {kind === 'proceso' && (
        <ReporteEnProceso proceso={proceso} cargando={cargando} esJefe={esJefe}
                          todasFincas={todasFincas} />
      )}

      {kind === 'valorizacion' && (
        <ReporteValorizacion valor={valor} valFincas={valFincas} fincas={fincas}
                             fincaSel={valFinca} onFinca={setValFinca}
                             tipo={valTipo} onTipo={setValTipo} diesel={dslVal} esJefe={esJefe} />
      )}

      {kind === 'estado' && (
        <ReporteEstado estado={estado} fincas={fincas}
                       fincaSel={estFinca} onFinca={setEstFinca}
                       tipo={estTipo} onTipo={setEstTipo} />
      )}

      {kind === 'descuadres' && (
        <ReporteDescuadres descs={descs} tipo={descTipo} onTipo={setDescTipo} todasFincas={todasFincas} />
      )}

      {kind === 'consumo' && <>
      {/* Ejes */}
      <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <Grupo titulo="Mostrar">
          <Chip on={tipo === 'todo'} onClick={() => setTipo('todo')}>Todo</Chip>
          <Chip on={tipo === 'balanceado'} onClick={() => setTipo('balanceado')}>Balanceado</Chip>
          <Chip on={tipo === 'insumo'} onClick={() => setTipo('insumo')}>Insumos</Chip>
          {!todasFincas && <Chip on={tipo === 'diesel'} onClick={() => setTipo('diesel')}>Diesel</Chip>}
        </Grupo>
        <Grupo titulo="Agrupar por">
          <Chip on={agrupar === 'item'} onClick={() => setAgrupar('item')}>Producto</Chip>
          <Chip on={agrupar === 'piscina'} onClick={() => setAgrupar('piscina')} disabled={todasFincas}>Piscina</Chip>
          <Chip on={agrupar === 'finca'} onClick={() => setAgrupar('finca')}>Finca</Chip>
        </Grupo>
      </div>

      {/* Resumen */}
      {!cargando && (
        <div style={{ display: 'flex', gap: '11px', flexWrap: 'wrap', marginBottom: '14px' }}>
          {/* El gasto en dolares es solo del jefe. */}
          {esJefe && <Kpi titulo={verTodoR ? 'Gasto del rango (con diesel)' : 'Gasto total del rango'}
                          valor={dinero(totalCosto + (verTodoR ? dslR.total : 0))} />}
          {esJefe && !todasFincas && <Kpi titulo="Diesel del rango" valor={dinero(dslR.total)} />}
          <Kpi titulo={agrupar === 'item' ? 'Productos' : agrupar === 'piscina' ? 'Piscinas' : 'Fincas'}
               valor={String(grupos.length)} />
          <Kpi titulo="Días" valor={String(dias(desde, hasta))} />
        </div>
      )}

      {!cargando && esJefe && !todasFincas && (
        <div style={{ marginBottom: '14px' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: GRIS, cursor: 'pointer' }}>
            <input type="checkbox" checked={verTodoR} onChange={e => setVerTodoR(e.target.checked)} />
            Ver todo junto (incluir diesel en el gasto total)
          </label>
        </div>
      )}

      {!cargando && esJefe && tipo !== 'diesel' && (() => {
        const bal = filas.filter(f => f.tipo === 'balanceado').reduce((t, f) => t + Number(f.costo || 0), 0)
        const ins = filas.filter(f => f.tipo === 'insumo').reduce((t, f) => t + Number(f.costo || 0), 0)
        const dsl = todasFincas ? 0 : Number(dslR.total || 0)
        const tot = bal + ins + dsl
        if (tot <= 0) return null
        const segs = [
          { label: 'Balanceado', valor: bal, color: '#0D6CB0' },
          { label: 'Insumos', valor: ins, color: '#E3B15F' },
          { label: 'Diesel', valor: dsl, color: '#5F5E5A' },
        ].filter(s => s.valor > 0)
        return (
          <div style={{ marginBottom: '14px', maxWidth: '420px' }}>
            <CajaGrafica titulo="En qué se va la plata · por categoría">
              <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
                <Donut segmentos={segs} centro="" sub="" />
                <div style={{ fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '9px' }}>
                  {segs.map(s => (
                    <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
                      <span style={{ width: '11px', height: '11px', borderRadius: '3px', background: s.color, display: 'inline-block' }} />
                      <span style={{ minWidth: '86px' }}>{s.label}</span>
                      <span style={{ color: NAVY, fontVariantNumeric: 'tabular-nums' }}>{dinero(s.valor)}</span>
                      <span style={{ color: GRIS }}>{Math.round(s.valor / tot * 100)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </CajaGrafica>
          </div>
        )
      })()}

      {tipo === 'diesel' ? (
        dslR.tipos.every(t => (t.galones || 0) === 0) ? (
          <Caja><Centro>No hay consumo de diesel en este rango.</Centro></Caja>
        ) : (
          <Caja>
            <div style={{ display: 'grid', gridTemplateColumns: esJefe ? '1.4fr 1fr 1fr' : '1.6fr 1fr', gap: '12px',
                          padding: '11px 16px', fontSize: '12px', color: GRIS,
                          borderBottom: '0.5px solid ' + BORDE, background: '#f6f9fb' }}>
              <span>Diesel</span>
              <span style={{ textAlign: 'right' }}>Galones</span>
              {esJefe && <span style={{ textAlign: 'right' }}>Costo</span>}
            </div>
            {dslR.tipos.map(t => (
              <div key={t.nombre} style={{ display: 'grid', gridTemplateColumns: esJefe ? '1.4fr 1fr 1fr' : '1.6fr 1fr', gap: '12px',
                      padding: '10px 16px', alignItems: 'center', fontSize: '13px', borderBottom: '0.5px solid #f1f6f9' }}>
                <span>{t.nombre} <span style={{ fontSize: '11px', color: AMBAR, marginLeft: '6px' }}>diesel</span></span>
                <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: GRIS }}>{miles(t.galones)} gal</span>
                {esJefe && <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{dinero(t.gasto)}</span>}
              </div>
            ))}
          </Caja>
        )
      ) : cargando ? (
        <Caja><Centro>Cargando...</Centro></Caja>
      ) : !grupos.length ? (
        <Caja><Centro>No hay consumo registrado en este rango.</Centro></Caja>
      ) : (
        <Caja>
          <div style={{ display: 'grid', gridTemplateColumns: grid, gap: '12px', padding: '11px 16px',
                        fontSize: '12px', color: GRIS,
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
      </>}
    </div>
  )
}

// ---------------------------------------------------------------------
// Reporte de cierre de ciclo (cosechas): una fila por ciclo cosechado,
// que se abre para ver el detalle de balanceado e insumos.
// ---------------------------------------------------------------------
function ReporteCosechas({ cosechas, cargando, esJefe, todasFincas }) {
  const [abierto, setAbierto] = useState(null)
  const [detalle, setDetalle] = useState({})   // cicloId -> { lineas, eventos }

  const grid = esJefe
    ? '150px 100px 56px 100px 100px 100px 110px 100px'
    : '1fr 110px 70px 130px'

  async function abrir(c) {
    if (abierto === c.ciclo_id) { setAbierto(null); return }
    setAbierto(c.ciclo_id)
    if (!detalle[c.ciclo_id]) {
      const [{ data: ln }, { data: ev }, { data: det }] = await Promise.all([
        supabase.schema('produccion').rpc('fn_ciclo_lineas', { p_ciclo: c.ciclo_id }),
        supabase.schema('produccion').from('evento')
          .select('tipo, fecha, libras').eq('ciclo_id', c.ciclo_id).order('fecha'),
        supabase.schema('produccion').rpc('fn_ciclo_detalle', { p_ciclo: c.ciclo_id }),
      ])
      setDetalle(d => ({ ...d, [c.ciclo_id]: { lineas: ln || [], eventos: ev || [], det: (det && det[0]) || null } }))
    }
  }

  if (cargando) return <Caja><Centro>Cargando...</Centro></Caja>
  if (!cosechas.length) return <Caja><Centro>No hay cosechas en este rango.</Centro></Caja>

  const totalLibras = cosechas.reduce((t, c) => t + Number(c.libras || 0), 0)
  const totalCosto = cosechas.reduce((t, c) => t + Number(c.costo_total || 0), 0)

  return (
    <div id="reporte-cosechas">
      <div style={{ display: 'flex', gap: '11px', flexWrap: 'wrap', marginBottom: '14px',
                    alignItems: 'center' }}>
        <Kpi titulo="Cosechas" valor={String(cosechas.length)} />
        <Kpi titulo="Libras Producidas" valor={miles(totalLibras)} />
        {esJefe && <Kpi titulo="Costo Total" valor={dinero(totalCosto)} />}
        {esJefe && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }} className="ocultar-impresion">
            <button onClick={() => exportarCosechasCSV(cosechas)} style={btnExp}>Excel</button>
            <button onClick={() => window.print()} style={btnExp}>PDF</button>
          </div>
        )}
      </div>

      {esJefe && (() => {
        const conCpl = cosechas.filter(c => Number(c.costo_por_libra) > 0)
        if (conCpl.length < 2) return null
        const items = conCpl
          .map(c => ({ label: c.piscina, valor: Number(c.costo_por_libra), finca: c.finca }))
          .sort((a, b) => a.valor - b.valor)
        const prom = items.reduce((t, i) => t + i.valor, 0) / items.length
        const colDe = v => v <= prom ? VERDE : v <= prom * 1.25 ? AMBAR : '#A32D2D'
        return (
          <div style={{ marginBottom: '14px' }}>
            <CajaGrafica titulo="Costo por libra · cuál salió más caro">
              <BarrasRank items={items} money promedio={prom} colorDe={colDe} />
            </CajaGrafica>
          </div>
        )
      })()}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {cosechas.map(c => {
          const ab = abierto === c.ciclo_id
          const d = detalle[c.ciclo_id]
          return (
            <div key={c.ciclo_id} style={tarjeta}>
              <div onClick={() => abrir(c)} style={{ cursor: 'pointer' }}>
                <div style={cabezaTarjeta}>
                  <div>
                    <span style={{ fontWeight: 500, fontSize: '15px' }}>
                      {ab ? '▾ ' : '▸ '}{c.piscina}
                    </span>
                    {todasFincas && <span style={{ fontSize: '12px', color: GRIS, marginLeft: '8px' }}>{c.finca}</span>}
                    <div style={{ fontSize: '13px', color: GRIS, marginTop: '7px' }}>
                      Preparación desde {corta(c.prep_desde)}
                    </div>
                    <FasesLinea c={c} />
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '14px', fontWeight: 500 }}>Cosecha {corta(c.fecha_cosecha)}</div>
                    <div style={{ fontSize: '12px', color: GRIS }}>{c.dias} días de engorde</div>
                  </div>
                </div>
                <div style={metricas}>
                  <Metrica k="Libras" v={Number(c.libras) ? miles(c.libras) : 'Pendiente'}
                           alerta={!Number(c.libras)} />
                  {esJefe && <Metrica k="Balanceado" v={dinero(c.costo_balanceado)} />}
                  {esJefe && <Metrica k="Insumos" v={dinero(c.costo_insumos)} />}
                  {esJefe && <Metrica k="Costo Total" v={dinero(c.costo_total)} fuerte />}
                  {esJefe && <Metrica k="Costo Por Libra"
                             v={c.costo_por_libra ? dinero(c.costo_por_libra) : '—'}
                             alerta={!c.costo_por_libra} destacado={!!c.costo_por_libra} />}
                </div>
              </div>
              {ab && (
                <div style={{ marginTop: '18px', paddingTop: '18px', borderTop: '0.5px solid #eef2f6' }}>
                  {!d ? <div style={{ fontSize: '13px', color: GRIS }}>Cargando detalle...</div>
                      : <DetalleCiclo d={d} esJefe={esJefe} />}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {cosechas.some(c => !c.costo_por_libra) && (
        <div style={{ fontSize: '12px', color: '#BA7517', marginTop: '10px' }}>
          Las cosechas sin costo por libra todavía no tienen las libras cargadas (llegan de la empacadora).
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Piscinas en proceso: una fila por ciclo abierto, expandible.
// ---------------------------------------------------------------------
function ReporteEnProceso({ proceso, cargando, esJefe, todasFincas }) {
  const [abierto, setAbierto] = useState(null)
  const [detalle, setDetalle] = useState({})
  const grid = esJefe ? '1.5fr 56px 96px 96px 106px 96px' : '1fr 70px'

  async function abrir(c) {
    if (abierto === c.ciclo_id) { setAbierto(null); return }
    setAbierto(c.ciclo_id)
    if (!detalle[c.ciclo_id]) {
      const [{ data: ln }, { data: ev }, { data: det }] = await Promise.all([
        supabase.schema('produccion').rpc('fn_ciclo_lineas', { p_ciclo: c.ciclo_id }),
        supabase.schema('produccion').from('evento')
          .select('tipo, fecha, libras').eq('ciclo_id', c.ciclo_id).order('fecha'),
        supabase.schema('produccion').rpc('fn_ciclo_detalle', { p_ciclo: c.ciclo_id }),
      ])
      setDetalle(d => ({ ...d, [c.ciclo_id]: { lineas: ln || [], eventos: ev || [], det: (det && det[0]) || null } }))
    }
  }

  if (cargando) return <Caja><Centro>Cargando...</Centro></Caja>
  if (!proceso.length) return <Caja><Centro>No hay piscinas en proceso.</Centro></Caja>

  const totalHa = proceso.reduce((t, c) => t + Number(c.hectareas || 0), 0)
  const totalCosto = proceso.reduce((t, c) => t + Number(c.costo_total || 0), 0)

  return (
    <div id="reporte-proceso">
      <div style={{ display: 'flex', gap: '11px', flexWrap: 'wrap', marginBottom: '14px', alignItems: 'center' }}>
        <Kpi titulo="Piscinas Activas" valor={String(proceso.length)} />
        <Kpi titulo="Hectáreas" valor={miles(totalHa)} />
        {esJefe && <Kpi titulo="Costo Acumulado" valor={dinero(totalCosto)} />}
        {esJefe && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
            <button onClick={() => exportarProcesoCSV(proceso)} style={btnExp}>Excel</button>
            <button onClick={() => window.print()} style={btnExp}>PDF</button>
          </div>
        )}
      </div>

      {esJefe && (() => {
        const items = proceso
          .filter(c => Number(c.costo_por_ha) > 0)
          .map(c => ({ label: c.piscina, valor: Number(c.costo_por_ha) }))
          .sort((a, b) => b.valor - a.valor)
          .slice(0, 12)
        if (items.length < 2) return null
        const max = Math.max(...items.map(i => i.valor))
        // Azul más oscuro = más caro por hectárea.
        const colDe = v => {
          const t = v / max
          return t > 0.75 ? '#0C447C' : t > 0.5 ? '#185FA5' : t > 0.28 ? '#378ADD' : '#7bb0dd'
        }
        return (
          <div style={{ marginBottom: '14px' }}>
            <CajaGrafica titulo="Costo por hectárea · quién va gastando de más">
              <BarrasRank items={items} money colorDe={colDe} />
            </CajaGrafica>
          </div>
        )
      })()}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {proceso.map(c => {
          const ab = abierto === c.ciclo_id
          const d = detalle[c.ciclo_id]
          return (
            <div key={c.ciclo_id} style={tarjeta}>
              <div onClick={() => abrir(c)} style={{ cursor: 'pointer' }}>
                <div style={cabezaTarjeta}>
                  <div>
                    <span style={{ fontWeight: 500, fontSize: '15px' }}>
                      {ab ? '▾ ' : '▸ '}{c.piscina}
                    </span>
                    {c.origen && <span style={{ background: '#E6F1FB', color: AZUL, fontSize: '11px',
                      padding: '3px 10px', borderRadius: '20px', marginLeft: '8px' }}>
                      Viene de {c.origen}{c.origen_pct ? ` · ${c.origen_pct}%` : ''}</span>}
                    {todasFincas && <span style={{ fontSize: '12px', color: GRIS, marginLeft: '8px' }}>{c.finca}</span>}
                    <div style={{ fontSize: '13px', color: GRIS, marginTop: '7px' }}>
                      Siembra {corta(c.fecha_siembra)} · {Number(c.hectareas).toFixed(2)} Ha
                    </div>
                    <FasesLinea c={c} />
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '22px', fontWeight: 500 }}>{c.dias}</div>
                    <div style={{ fontSize: '12px', color: GRIS }}>días de engorde</div>
                  </div>
                </div>
                <div style={metricas}>
                  {esJefe && <Metrica k="Balanceado" v={dinero(c.costo_balanceado)} />}
                  {esJefe && <Metrica k="Insumos" v={dinero(c.costo_insumos)} />}
                  {esJefe && <Metrica k="Costo Total" v={dinero(c.costo_total)} fuerte />}
                  {esJefe && <Metrica k="Costo Por Ha" v={dinero(c.costo_por_ha)} destacado />}
                </div>
              </div>
              {ab && (
                <div style={{ marginTop: '18px', paddingTop: '18px', borderTop: '0.5px solid #eef2f6' }}>
                  {!d ? <div style={{ fontSize: '13px', color: GRIS }}>Cargando detalle...</div>
                      : <DetalleCiclo d={d} esJefe={esJefe} />}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Valorización de bodega: cuánto vale hoy el inventario, por insumo.
// ---------------------------------------------------------------------
function ReporteValorizacion({ valor, valFincas, fincas, fincaSel, onFinca, tipo, onTipo, diesel = [], esJefe }) {
  const esTodas = fincaSel === 'todas'
  const dslTotal = diesel.reduce((t, d) => t + (Number(d.valor) || 0), 0)
  const DGRID = esTodas ? '1.4fr 1fr 1fr' : '1.4fr 1fr 1fr 1fr'
  const etq = tipo === 'balanceado' ? 'Balanceado' : 'Insumo'
  const VGRID = esTodas ? '1fr 190px 150px' : '1fr 150px 120px 130px'
  const conValor = valor.filter(v => Number(v.valor) > 0 || Number(v.saldo) > 0)
  const total = valor.reduce((t, v) => t + (Number(v.valor) || 0), 0)
  const sinPrecio = conValor.filter(v => !Number(v.precio)).length
  const top = [...conValor].sort((a, b) => Number(b.valor) - Number(a.valor)).slice(0, 6)
    .map(v => ({ label: v.insumo, valor: Number(v.valor) || 0 }))
  const fincasBar = (valFincas || []).filter(f => Number(f.valor) > 0)
    .map(f => ({ label: f.finca, valor: Number(f.valor) || 0 }))
  return (
    <>
      <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '14px' }}>
        <div>
          <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Mostrar</div>
          <div style={{ display: 'flex', gap: '7px' }}>
            <Chip on={tipo === 'insumo'} onClick={() => onTipo('insumo')}>Insumos</Chip>
            <Chip on={tipo === 'balanceado'} onClick={() => onTipo('balanceado')}>Balanceados</Chip>
            <Chip on={tipo === 'diesel'} onClick={() => onTipo('diesel')}>Diesel</Chip>
          </div>
        </div>
        {fincas && fincas.length > 1 && (
          <div>
            <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Finca</div>
            <select value={fincaSel} onChange={e => onFinca(e.target.value)} style={{ ...entrada, minWidth: '220px' }}>
              <option value="todas">Todas las fincas</option>
              {fincas.map(f => <option key={f.id} value={f.id}>{f.nombre}</option>)}
            </select>
          </div>
        )}
      </div>
      {tipo === 'diesel' ? (
        diesel.every(d => (Number(d.saldo) || 0) === 0 && (Number(d.valor) || 0) === 0) ? (
          <Caja><Centro>No hay diesel en bodega para valorizar.</Centro></Caja>
        ) : (
          <>
          <div style={{ display: 'flex', gap: '11px', flexWrap: 'wrap', marginBottom: '14px' }}>
            <Kpi titulo="Valor del diesel" valor={dinero(dslTotal)} />
            <Kpi titulo="Tipos con saldo" valor={String(diesel.filter(d => Number(d.saldo) > 0).length)} />
          </div>
          <Caja>
            <div style={{ display: 'grid', gridTemplateColumns: DGRID, gap: '12px', padding: '11px 16px',
                          fontSize: '12px', color: GRIS, borderBottom: '0.5px solid ' + BORDE, background: '#f6f9fb' }}>
              <span>Diesel</span>
              <span style={{ textAlign: 'right' }}>Saldo (gal)</span>
              {!esTodas && <span style={{ textAlign: 'right' }}>Precio</span>}
              <span style={{ textAlign: 'right' }}>Valor</span>
            </div>
            {diesel.map(d => (
              <div key={d.tipo} style={{ display: 'grid', gridTemplateColumns: DGRID, gap: '12px', padding: '10px 16px',
                      alignItems: 'center', fontSize: '13px', borderBottom: '0.5px solid #f1f6f9' }}>
                <span>{d.tipo}</span>
                <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: GRIS }}>{miles(d.saldo)}</span>
                {!esTodas && <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: GRIS }}>{d.precio != null ? '$' + Number(d.precio).toLocaleString('es-EC', { minimumFractionDigits: 6, maximumFractionDigits: 6 }) : '—'}</span>}
                <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{dinero(d.valor)}</span>
              </div>
            ))}
          </Caja>
          </>
        )
      ) : !conValor.length ? (
        <Caja><Centro>No hay saldo en bodega para valorizar.</Centro></Caja>
      ) : (
      <>
      <div style={{ display: 'flex', gap: '11px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <Kpi titulo="Valor de la bodega" valor={dinero(total)} />
        <Kpi titulo="Insumos con saldo" valor={String(conValor.length)} />
        {!esTodas && sinPrecio > 0 && <Kpi titulo="Sin precio" valor={String(sinPrecio)} />}
      </div>

      {/* Gráficas */}
      <div style={{ display: 'grid', gridTemplateColumns: esTodas ? '1fr 1fr' : '1fr',
                    gap: '14px', marginBottom: '14px' }}>
        {esTodas && fincasBar.length > 0 && (
          <CajaGrafica titulo="Valor por finca"><BarrasH items={fincasBar} money /></CajaGrafica>
        )}
        <CajaGrafica titulo="Dónde está la plata (top insumos)"><BarrasH items={top} money /></CajaGrafica>
      </div>

      <Caja>
        <div style={{ display: 'grid', gridTemplateColumns: VGRID, gap: '12px', padding: '11px 16px',
                      fontSize: '12px', color: GRIS, borderBottom: '0.5px solid ' + BORDE, background: '#f6f9fb' }}>
          <span>{etq}</span>
          <span style={{ textAlign: 'right' }}>{esTodas ? 'Saldo (todas las fincas)' : 'Saldo'}</span>
          {!esTodas && <span style={{ textAlign: 'right' }}>Precio</span>}
          <span style={{ textAlign: 'right' }}>Valor</span>
        </div>
        {conValor.map(v => {
          const conv = Number(v.factor) && Number(v.factor) !== 1
          return (
          <div key={v.insumo_id} style={{ display: 'grid', gridTemplateColumns: VGRID, gap: '12px',
                  padding: '10px 16px', alignItems: 'center', fontSize: '13px', borderBottom: '0.5px solid #f1f6f9' }}>
            <span>{v.insumo}</span>
            <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: GRIS }}>
              {miles(v.saldo)} {cap1(v.unidad)}
              {conv && (
                <div style={{ fontSize: '10.5px', color: '#a7b4c1' }}>
                  {miles(Number(v.saldo) * Number(v.factor))} {cap1(v.unidad_app)}
                </div>
              )}
            </span>
            {!esTodas && (
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                             color: Number(v.precio) ? NAVY : AMBAR }}>
                {Number(v.precio) ? <>{dinero(v.precio)}{valTipo === 'balanceado' && <span style={{ display: 'block', fontSize: '10px', color: '#a7b4c1', fontWeight: 400 }}>catálogo</span>}</> : 'sin precio'}
              </span>
            )}
            <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
              {dinero(v.valor)}
            </span>
          </div>
          )
        })}
        <div style={{ display: 'grid', gridTemplateColumns: VGRID, gap: '12px', padding: '12px 16px',
                      alignItems: 'center', background: '#fafcfd', fontSize: '14px', fontWeight: 500 }}>
          <span>Total</span><span />{!esTodas && <span />}
          <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dinero(total)}</span>
        </div>
      </Caja>
      </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------
// Estado / Reponer: nivel de cada insumo vs. mínimo y objetivo.
// ---------------------------------------------------------------------
const EST_COLOR = { bajo: '#c0504d', medio: '#c98a1e', suficiente: '#0F6E56', sin_minimo: '#c3d0db' }
const EST_LBL = { bajo: 'Bajo', medio: 'Medio', suficiente: 'Suficiente', sin_minimo: 'Sin mínimo' }
const EST_BG = { bajo: '#FBEAEA', medio: '#FAEEDA', suficiente: '#E1F5EE', sin_minimo: '#eef3f7' }

function ReporteEstado({ estado, fincas, fincaSel, onFinca, tipo, onTipo }) {
  const esTodas = fincaSel === 'todas'
  const etq = tipo === 'balanceado' ? 'Balanceado' : 'Insumo'
  const EGRID = esTodas
    ? '1.1fr 120px 150px 100px 100px 120px'
    : '1.2fr 160px 150px 100px 100px 120px'
  const bajos = estado.filter(e => e.estado === 'bajo')
  const medios = estado.filter(e => e.estado === 'medio')
  const sufic = estado.filter(e => e.estado === 'suficiente')
  const conMin = estado.filter(e => e.estado !== 'sin_minimo')
  // Barras: qué tan lleno está cada insumo (saldo_app / objetivo). Primero los que faltan.
  const barras = [...conMin].sort((a, b) => nivelPct(a) - nivelPct(b)).slice(0, 8)
  return (
    <>
      <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '14px' }}>
        <div>
          <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Mostrar</div>
          <div style={{ display: 'flex', gap: '7px' }}>
            <Chip on={tipo === 'insumo'} onClick={() => onTipo('insumo')}>Insumos</Chip>
            <Chip on={tipo === 'balanceado'} onClick={() => onTipo('balanceado')}>Balanceados</Chip>
          </div>
        </div>
        {fincas && fincas.length > 1 && (
          <div>
            <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Finca</div>
            <select value={fincaSel} onChange={e => onFinca(e.target.value)} style={{ ...entrada, minWidth: '220px' }}>
              {fincas.map(f => <option key={f.id} value={f.id}>{f.nombre}</option>)}
              <option value="todas">Todas las fincas</option>
            </select>
          </div>
        )}
      </div>
      {!estado.length ? (
        <Caja><Centro>No hay insumos para mostrar.</Centro></Caja>
      ) : (
      <>
      {/* Resumen: donut + barras de nivel */}
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: '14px', marginBottom: '14px' }}>
        <CajaGrafica titulo="Cómo está la bodega">
          <Donut segmentos={[
            { valor: sufic.length, color: EST_COLOR.suficiente },
            { valor: medios.length, color: EST_COLOR.medio },
            { valor: bajos.length, color: EST_COLOR.bajo },
          ]} centro={String(conMin.length)} sub="insumos" />
          <div style={{ fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '10px' }}>
            <Leyenda color={EST_COLOR.bajo} txt={`Bajos · ${bajos.length}`} />
            <Leyenda color={EST_COLOR.medio} txt={`Medios · ${medios.length}`} />
            <Leyenda color={EST_COLOR.suficiente} txt={`Suficientes · ${sufic.length}`} />
          </div>
        </CajaGrafica>
        <CajaGrafica titulo="Qué tan lleno está cada insumo (saldo vs. objetivo)">
          {barras.map((e, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 92px', gap: '12px',
                    alignItems: 'center', marginBottom: '11px', fontSize: '12px' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.insumo}{esTodas && <span style={{ color: GRIS }}> · {e.finca}</span>}
              </span>
              <div style={{ position: 'relative', height: '16px', background: '#eef3f7', borderRadius: '20px', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', borderRadius: '20px',
                              width: Math.min(100, nivelPct(e)) + '%', background: EST_COLOR[e.estado] }} />
              </div>
              <span style={{ textAlign: 'right' }}><Badge estado={e.estado} /></span>
            </div>
          ))}
          {!barras.length && <div style={{ fontSize: '12px', color: GRIS }}>Carga mínimo y objetivo en el Catálogo para ver los niveles.</div>}
          <div style={{ fontSize: '10.5px', color: GRIS, marginTop: '4px' }}>La barra llena hasta el objetivo. Rojo = bajo el mínimo.</div>
        </CajaGrafica>
      </div>

      <Caja>
        <div style={{ display: 'grid', gridTemplateColumns: EGRID, gap: '12px', padding: '11px 16px',
                      fontSize: '12px', color: GRIS, borderBottom: '0.5px solid ' + BORDE, background: '#f6f9fb' }}>
          <span>{etq}</span>
          {esTodas ? <span>Finca</span> : <span>Llega / se aplica</span>}
          <span style={{ textAlign: 'right' }}>Saldo</span>
          <span style={{ textAlign: 'right' }}>Mínimo</span>
          <span style={{ textAlign: 'right' }}>Objetivo</span>
          <span style={{ textAlign: 'right' }}>Estado</span>
        </div>
        {estado.map((e, i) => {
          const conv = Number(e.factor) && Number(e.factor) !== 1
          const uApp = cap1(e.unidad_app)
          return (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: EGRID, gap: '12px',
                  padding: '10px 16px', alignItems: 'center', fontSize: '13px', borderBottom: '0.5px solid #f1f6f9' }}>
            <span>{e.insumo}</span>
            {esTodas
              ? <span style={{ color: GRIS }}>{e.finca}</span>
              : <span style={{ color: GRIS }}>{cap1(e.unidad)}{conv && <> → {uApp}</>}</span>}
            <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: GRIS }}>
              {miles(e.saldo)} {cap1(e.unidad)}
              {conv && <div style={{ fontSize: '10.5px', color: '#a7b4c1' }}>{miles(e.saldo_app)} {uApp}</div>}
            </span>
            <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: GRIS }}>
              {e.minimo != null ? `${miles(e.minimo)} ${uApp}` : '—'}
            </span>
            <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: GRIS }}>
              {e.objetivo != null ? `${miles(e.objetivo)} ${uApp}` : '—'}
            </span>
            <span style={{ textAlign: 'right' }}><Badge estado={e.estado} /></span>
          </div>
          )
        })}
      </Caja>
      <p style={{ fontSize: '12px', color: GRIS, marginTop: '12px', maxWidth: '760px' }}>
        Los niveles salen del <b>Catálogo</b> (Mínimo + Objetivo por insumo/finca). Es solo alerta;
        el pedido se hace en Ingresos &gt; Pedidos.
      </p>
      </>
      )}
    </>
  )
}

// % de llenado saldo vs objetivo (o vs mínimo si no hay objetivo).
function nivelPct(e) {
  const meta = Number(e.objetivo) || Number(e.minimo) || 0
  if (!meta) return 100
  return (Number(e.saldo_app) / meta) * 100
}

function Badge({ estado }) {
  return (
    <span style={{ fontSize: '11px', fontWeight: 600, borderRadius: '20px', padding: '3px 11px',
                   background: EST_BG[estado], color: estado === 'sin_minimo' ? GRIS : EST_COLOR[estado] }}>
      {EST_LBL[estado]}
    </span>
  )
}

function Leyenda({ color, txt }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
      <span style={{ width: '10px', height: '10px', borderRadius: '3px', background: color, display: 'inline-block' }} />
      {txt}
    </div>
  )
}

function CajaGrafica({ titulo, children }) {
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '16px' }}>
      <div style={{ fontSize: '12px', color: GRIS, margin: '0 0 12px', letterSpacing: '.03em', textTransform: 'uppercase' }}>{titulo}</div>
      {children}
    </div>
  )
}

// Barras horizontales simples (CSS), escaladas al máximo.
function BarrasH({ items, money }) {
  const max = Math.max(1, ...items.map(i => i.valor))
  const cols = ['#0D6CB0', '#3f8fce', '#7bb0dd', '#0D6CB0', '#3f8fce', '#7bb0dd']
  if (!items.length) return <div style={{ fontSize: '12px', color: GRIS }}>Sin datos.</div>
  return (
    <div>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 110px', gap: '12px',
                alignItems: 'center', marginBottom: '9px', fontSize: '12px' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
          <div style={{ height: '14px', background: '#eef3f7', borderRadius: '20px', overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: '20px', width: (it.valor / max * 100) + '%', background: cols[i % cols.length] }} />
          </div>
          <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money ? dinero(it.valor) : miles(it.valor)}</span>
        </div>
      ))}
    </div>
  )
}

// Barras de ranking: color por valor (colorDe) y promedio opcional.
function BarrasRank({ items, money = true, promedio = null, colorDe }) {
  if (!items.length) return <div style={{ fontSize: '12px', color: GRIS }}>Sin datos.</div>
  const max = Math.max(1, ...items.map(i => i.valor))
  const fmt = v => money ? dinero(v) : miles(v)
  const col = colorDe || (() => AZUL)
  return (
    <div>
      {promedio != null && (
        <div style={{ fontSize: '11px', color: GRIS, marginBottom: '11px' }}>
          Promedio: <b style={{ color: NAVY, fontWeight: 500 }}>{fmt(promedio)}</b>
        </div>
      )}
      {items.map((it, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '92px 1fr 80px', gap: '10px',
                alignItems: 'center', marginBottom: '9px', fontSize: '12px' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
          <div style={{ height: '14px', background: '#eef3f7', borderRadius: '20px', overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: '20px', width: (it.valor / max * 100) + '%', background: col(it.valor) }} />
          </div>
          <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: col(it.valor), fontWeight: 500 }}>{fmt(it.valor)}</span>
        </div>
      ))}
    </div>
  )
}

// Donut de segmentos (SVG). segmentos = [{valor, color}], centro/sub textos.
function Donut({ segmentos, centro, sub }) {
  const total = segmentos.reduce((t, s) => t + s.valor, 0) || 1
  let off = 25   // arranca arriba
  const arcos = segmentos.map((s, i) => {
    const len = (s.valor / total) * 100
    const el = <circle key={i} cx="21" cy="21" r="15.9" fill="none" stroke={s.color} strokeWidth="6"
                       strokeDasharray={`${len} ${100 - len}`} strokeDashoffset={off} />
    off -= len
    return el
  })
  return (
    <svg width="120" height="120" viewBox="0 0 42 42">
      <circle cx="21" cy="21" r="15.9" fill="none" stroke="#eef3f7" strokeWidth="6" />
      {arcos}
      <text x="21" y="20.5" textAnchor="middle" fontSize="7" fontWeight="600" fill={NAVY}>{centro}</text>
      <text x="21" y="26" textAnchor="middle" fontSize="3.2" fill={GRIS}>{sub}</text>
    </svg>
  )
}

// ---------------------------------------------------------------------
// Descuadres: control de conteos. Qué no cuadró en cada conteo físico.
// ---------------------------------------------------------------------
function ReporteDescuadres({ descs, tipo, onTipo, todasFincas }) {
  const etq = tipo === 'balanceado' ? 'Balanceado' : 'Insumo'
  const DGRID = todasFincas
    ? '120px 90px 1.2fr 90px 90px 100px 1fr 130px'
    : '90px 1.3fr 90px 90px 100px 1fr 130px'
  const faltan = descs.filter(d => Number(d.diferencia) < 0).length
  const sobran = descs.filter(d => Number(d.diferencia) > 0).length
  return (
    <>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Mostrar</div>
        <div style={{ display: 'flex', gap: '7px' }}>
          <Chip on={tipo === 'insumo'} onClick={() => onTipo('insumo')}>Insumos</Chip>
          <Chip on={tipo === 'balanceado'} onClick={() => onTipo('balanceado')}>Balanceados</Chip>
        </div>
      </div>
      {!descs.length ? (
        <Caja><Centro>Sin descuadres en este rango. Todo cuadró (o aún no hay conteos).</Centro></Caja>
      ) : (
      <>
      <div style={{ display: 'flex', gap: '11px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <Kpi titulo="Descuadres" valor={String(descs.length)} />
        <Kpi titulo="Faltaron" valor={String(faltan)} />
        <Kpi titulo="Sobraron" valor={String(sobran)} />
      </div>
      <Caja>
        <div style={{ display: 'grid', gridTemplateColumns: DGRID, gap: '12px', padding: '11px 16px',
                      fontSize: '12px', color: GRIS, borderBottom: '0.5px solid ' + BORDE, background: '#f6f9fb' }}>
          {todasFincas && <span>Finca</span>}
          <span>Fecha</span>
          <span>{etq}</span>
          <span style={{ textAlign: 'right' }}>Sistema</span>
          <span style={{ textAlign: 'right' }}>Contado</span>
          <span style={{ textAlign: 'right' }}>Diferencia</span>
          <span>Motivo</span>
          <span>Contó</span>
        </div>
        {descs.map((d, i) => {
          const dif = Number(d.diferencia)
          return (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: DGRID, gap: '12px',
                  padding: '10px 16px', alignItems: 'center', fontSize: '13px', borderBottom: '0.5px solid #f1f6f9' }}>
            {todasFincas && <span style={{ color: GRIS }}>{d.finca}</span>}
            <span style={{ color: GRIS, fontVariantNumeric: 'tabular-nums' }}>{corta(d.fecha)}</span>
            <span>{d.insumo}</span>
            <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: GRIS }}>{miles(d.sistema)} {cap1(d.unidad)}</span>
            <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{miles(d.contado)} {cap1(d.unidad)}</span>
            <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: dif < 0 ? '#c0504d' : '#9a6a12' }}>
              {(dif < 0 ? 'Faltó ' : 'Sobró ') + miles(Math.abs(dif))}
            </span>
            <span style={{ color: d.motivo ? NAVY : '#c3d0db' }}>{d.motivo || 'sin motivo'}</span>
            <span style={{ color: GRIS, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.autor || '—'}</span>
          </div>
          )
        })}
      </Caja>
      </>
      )}
    </>
  )
}

// Tarjeta de reporte y su metrica: reemplazan la tabla ancha que se
// cortaba. Las metricas se acomodan solas y nunca se salen del ancho.
const tarjeta = { background: '#fff', border: '0.5px solid #dce6ef', borderRadius: '14px',
                  padding: '20px 22px' }
const cabezaTarjeta = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                        gap: '14px', flexWrap: 'wrap' }
const metricas = { display: 'flex', gap: '32px', flexWrap: 'wrap', marginTop: '18px' }

function Metrica({ k, v, fuerte, destacado, alerta }) {
  return (
    <div>
      <div style={{ fontSize: '11px', color: '#7d8fa0', marginBottom: '2px' }}>{k}</div>
      <div style={{ fontSize: fuerte || destacado ? '16px' : '14px',
                    fontWeight: fuerte || destacado ? 500 : 400,
                    fontVariantNumeric: 'tabular-nums',
                    color: alerta ? '#BA7517' : destacado ? '#0D6CB0' : '#022847' }}>{v}</div>
    </div>
  )
}

function exportarProcesoCSV(proceso) {
  const cab = ['Piscina', 'Finca', 'Viene de', 'Siembra', 'Hectáreas', 'Días',
               'Costo balanceado', 'Costo insumos', 'Costo total', 'Costo por ha']
  const filas = proceso.map(c => [
    c.piscina, c.finca, c.origen || '', c.fecha_siembra, c.hectareas, c.dias,
    Number(c.costo_balanceado).toFixed(2), Number(c.costo_insumos).toFixed(2),
    Number(c.costo_total).toFixed(2), Number(c.costo_por_ha).toFixed(2),
  ])
  const csv = [cab, ...filas].map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = 'piscinas_en_proceso.csv'; a.click()
  URL.revokeObjectURL(url)
}

// El detalle de un ciclo: que paso (origen + eventos), que se consumio y
// de donde sale el costo total.
function DetalleCiclo({ d, esJefe }) {
  const bal = d.lineas.filter(l => l.tipo === 'balanceado')
  const ins = d.lineas.filter(l => l.tipo === 'insumo')
  const det = d.det
  // La siembra ya se explica en el origen; se saca de la lista de eventos.
  const otros = d.eventos.filter(e => e.tipo !== 'siembra')
  return (
    <>
    <div style={{ display: 'flex', gap: '38px', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 280px' }}>
        <Sub>Qué pasó</Sub>
        <OrigenResumen det={det} />
        {otros.map((e, i) => (
          <Rengl key={i} a={cap(e.tipo)} b={corta(e.fecha) + (e.libras ? ` · ${miles(e.libras)} lb` : '')} />
        ))}
        {!det && otros.length === 0 && <Vac>Sin eventos</Vac>}
      </div>
      <div style={{ flex: '1 1 260px' }}>
        <Sub>Balanceado</Sub>
        {bal.length === 0 ? <Vac>Sin balanceado</Vac> : bal.map((l, i) => (
          <Rengl key={i} a={l.item}
            b={`${miles(l.cantidad)} lb${esJefe ? ' · ' + dinero(l.costo) : ''}`}
            nota={`${corta(l.desde)} a ${corta(l.hasta)}`} />
        ))}
      </div>
      <div style={{ flex: '1 1 200px' }}>
        <Sub>Insumos</Sub>
        {ins.length === 0 ? <Vac>Sin insumos</Vac> : ins.map((l, i) => (
          <Rengl key={i} a={l.item}
            b={`${miles(l.cantidad)} ${l.unidad}${esJefe ? ' · ' + dinero(l.costo) : ''}`}
            nota={`${corta(l.desde)} a ${corta(l.hasta)}`} />
        ))}
      </div>
    </div>
    {esJefe && det && <DesgloseCosto det={det} />}
    </>
  )
}

// Días por fase, en una línea de texto (sin chips).
function FasesLinea({ c }) {
  const prep = Number(c.dias_prep) || 0
  const prec = Number(c.dias_precria) || 0
  const eng = Number(c.dias) || 0
  const items = []
  if (prep > 0) items.push(['Preparación', prep])
  if (prec > 0) items.push(['Precría', prec])
  items.push(['Engorde', eng])
  const total = prep + prec + eng
  return (
    <div style={{ fontSize: '12px', color: '#8b98a5', marginTop: '8px' }}>
      {items.map(([lbl, n], i) => (
        <span key={lbl}>{i > 0 && <span style={{ color: '#c3d0db' }}>{'  ·  '}</span>}
          {lbl} <b style={{ color: NAVY, fontWeight: 500 }}>{n} d</b></span>
      ))}
      {(prep > 0 || prec > 0) && <span style={{ color: '#a7b4c1' }}>{'  ·  '}{total} d en total</span>}
    </div>
  )
}

function Pill({ bg, fg, children }) {
  return <span style={{ background: bg, color: fg, fontSize: '11px', padding: '3px 10px', borderRadius: '20px' }}>{children}</span>
}

// Resumen del origen del lote: transferencia (con sobrevivencia y gramaje)
// o siembra directa (larvas, PLs/g y laboratorio).
function OrigenResumen({ det }) {
  if (!det) return null
  if (det.es_transferencia) {
    return (
      <>
        <div style={{ marginBottom: '16px', fontSize: '14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
            <span>Transferencia</span>
            <span style={{ color: NAVY, whiteSpace: 'nowrap' }}>{corta(det.transfer_fecha)}</span>
          </div>
          <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap', marginTop: '8px' }}>
            {det.sobrevivencia != null && <Pill bg="#E1F5EE" fg="#0F6E56">Sobrevivencia {miles(det.sobrevivencia)}%</Pill>}
            {det.transfer_gramaje != null && <Pill bg="#E6F1FB" fg="#0D6CB0">Gramaje {det.transfer_gramaje} g</Pill>}
          </div>
          {(det.animales || det.origen_piscina) && (
            <div style={{ fontSize: '12px', color: '#8b98a5', marginTop: '8px' }}>
              {det.animales ? `${miles(det.animales)} animales` : ''}
              {det.origen_piscina ? ` · desde ${det.origen_piscina}` : ''}
              {det.origen_pct ? ` (${miles(det.origen_pct)}%)` : ''}
            </div>
          )}
        </div>
        {det.precria_siembra && (
          <div style={{ marginBottom: '9px', fontSize: '14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
              <span>Siembra de la precría</span>
              <span style={{ color: NAVY, whiteSpace: 'nowrap' }}>{corta(det.precria_siembra)}</span>
            </div>
            <div style={{ fontSize: '12px', color: '#8b98a5', marginTop: '5px' }}>
              {det.precria_larvas ? `${miles(det.precria_larvas)} larvas` : ''}
              {det.precria_plsg != null ? ` · ${det.precria_plsg} PLs/g` : ''}
            </div>
          </div>
        )}
      </>
    )
  }
  return (
    <div style={{ marginBottom: '9px', fontSize: '14px' }}>
      <div style={{ color: NAVY }}>Siembra directa</div>
      <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap', marginTop: '8px' }}>
        {det.larvas_directas != null && <Pill bg="#E6F1FB" fg="#0D6CB0">{miles(det.larvas_directas)} larvas</Pill>}
        {det.plsg_directa != null && <Pill bg="#F1EFE8" fg="#5F5E5A">{det.plsg_directa} PLs/g</Pill>}
      </div>
      {det.laboratorio && <div style={{ fontSize: '12px', color: '#8b98a5', marginTop: '8px' }}>Laboratorio: {det.laboratorio}</div>}
    </div>
  )
}

// De dónde sale el Costo Total: preparación + balanceado + insumos +
// heredado de la precría. Solo el jefe (lleva dólares).
function DesgloseCosto({ det }) {
  const rows = [
    ['Preparación', det.costo_preparacion, 'insumos antes de sembrar'],
    ['Balanceado del cultivo', det.costo_bal_cultivo, null],
    ['Insumos del cultivo', det.costo_ins_cultivo, null],
  ]
  if (Number(det.costo_heredado) > 0) {
    rows.push(['Heredado de la precría', det.costo_heredado,
      `${det.origen_piscina || ''}${det.origen_pct ? ` · ${miles(det.origen_pct)}%` : ''}`])
  }
  return (
    <div style={{ marginTop: '20px', padding: '16px 18px', background: '#f7fafc', borderRadius: '12px' }}>
      <div style={{ fontSize: '11px', color: '#8b98a5', fontWeight: 500, letterSpacing: '.04em', textTransform: 'uppercase', marginBottom: '13px' }}>De dónde sale el Costo Total</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {rows.map(([lbl, val, nota]) => (
        <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: '14px' }}>
          <span>{lbl}{nota ? <span style={{ fontSize: '11px', color: '#a7b4c1' }}> · {nota}</span> : ''}</span>
          <span style={{ color: NAVY, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{dinero(val)}</span>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '15px', fontWeight: 500,
                    borderTop: '0.5px solid ' + BORDE, paddingTop: '11px', marginTop: '3px' }}>
        <span>Costo Total</span>
        <span style={{ color: NAVY, fontVariantNumeric: 'tabular-nums' }}>{dinero(det.costo_total)}</span>
      </div>
      </div>
    </div>
  )
}
function Sub({ children }) {
  return <div style={{ fontSize: '11px', color: '#8b98a5', letterSpacing: '.04em',
                       textTransform: 'uppercase', marginBottom: '13px', fontWeight: 500 }}>{children}</div>
}
function Vac({ children }) { return <div style={{ fontSize: '12px', color: '#c3d0db' }}>{children}</div> }
function Rengl({ a, b, nota }) {
  return (
    <div style={{ marginBottom: '6px', fontSize: '13px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
        <span>{a}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums', color: NAVY, whiteSpace: 'nowrap' }}>{b}</span>
      </div>
      {nota && <div style={{ fontSize: '11px', color: GRIS }}>{nota}</div>}
    </div>
  )
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s }

function exportarCosechasCSV(cosechas) {
  const cab = ['Piscina', 'Finca', 'Cosecha', 'Preparación desde', 'Días', 'Libras',
               'Costo balanceado', 'Costo insumos', 'Costo total', 'Costo por libra']
  const filas = cosechas.map(c => [
    c.piscina, c.finca, c.fecha_cosecha, c.prep_desde, c.dias, c.libras || '',
    Number(c.costo_balanceado).toFixed(2), Number(c.costo_insumos).toFixed(2),
    Number(c.costo_total).toFixed(2), c.costo_por_libra ? Number(c.costo_por_libra).toFixed(4) : '',
  ])
  const csv = [cab, ...filas].map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = 'reporte_cosechas.csv'; a.click()
  URL.revokeObjectURL(url)
}

const btnExp = { padding: '8px 14px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500,
                 border: '0.5px solid #dce6ef', borderRadius: '9px', background: 'white',
                 color: '#022847', cursor: 'pointer' }

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
      <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>{titulo}</div>
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
