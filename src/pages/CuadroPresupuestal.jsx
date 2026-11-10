import { useState, useEffect, useMemo, useCallback, useRef, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import { dinero } from '../lib/fechas'

// Cuadro presupuestal · módulo Producción (F1 + F2)
// Hoja mensual por finca: la contadora/jefe carga todos los costos del mes y la
// app calcula el costo por hectárea-día TOTAL y REAL. No se cierra: va
// calculando en vivo. Los rubros marcados "App" (balanceado, insumos por
// categoría, diésel) se PRECARGAN con el consumo real del mes y son editables.
const NAVY = '#022847', AZUL = '#0D6CB0', BORDE = '#dce6ef', GRIS = '#7d8fa0', VERDE = '#0F6E56', ROJO = '#8A2F2E'
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
const GRUPOS = [
  ['BALANCEADO_LARVA', 'Balanceado y larva'],
  ['MATERIA_PRIMA', 'Materia prima · insumos'],
  ['MANO_OBRA', 'Mano de obra'],
  ['INDIRECTOS', 'Indirectos'],
  ['OTROS_ADMIN', 'Otros administrativos'],
  ['ACTIVOS', 'Activos fijos'],
  ['MEJORAS', 'Mejoras'],
]
const NO_REAL = new Set(['BALANCEADO_LARVA', 'ACTIVOS', 'MEJORAS'])
const diasDelMes = (y, m) => new Date(y, m, 0).getDate()  // m = 1..12
const num2 = n => (Number(n) || 0).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
// Parser tolerante: "319.210,80" | "319210.8" | "1,234" -> número.
function parseNum(s) {
  if (s == null || s === '') return 0
  let t = String(s).trim().replace(/[^0-9.,-]/g, '')
  if (t.includes('.') && t.includes(',')) t = t.replace(/\./g, '').replace(',', '.')
  else if (t.includes(',')) t = t.replace(',', '.')
  const v = Number(t); return isFinite(v) ? v : 0
}

const inp = { padding: '7px 11px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY, boxSizing: 'border-box' }
const btnAzul = { padding: '8px 15px', fontSize: '12.5px', fontFamily: 'inherit', fontWeight: 500, border: 'none', borderRadius: '8px', background: AZUL, color: 'white', cursor: 'pointer' }

export default function CuadroPresupuestal({ finca, fincas, esJefe }) {
  const [vista, setVista] = useState('finca')   // 'finca' | 'dashboard'
  const hoy = new Date()
  const [anio, setAnio] = useState(hoy.getFullYear())
  const [mes, setMes] = useState(hoy.getMonth() + 1)
  const [rubros, setRubros] = useState([])
  const [catIns, setCatIns] = useState({})      // insumo_id -> categoria_presupuesto
  const [ha, setHa] = useState('')
  const [dias, setDias] = useState(String(diasDelMes(hoy.getFullYear(), hoy.getMonth() + 1)))
  const [dedSueldos, setDedSueldos] = useState('')   // sueldos administrativos (se resta solo del REAL)
  const [dedBenef, setDedBenef] = useState('')       // beneficios sociales de esos sueldos
  const [txt, setTxt] = useState({})            // rubro_id -> string del valor mostrado
  const [appVals, setAppVals] = useState({})    // rubro_id -> valor sugerido por la app
  const [editado, setEditado] = useState(new Set()) // rubros App que el usuario sobrescribió
  const [abierto, setAbierto] = useState({ BALANCEADO_LARVA: true, MATERIA_PRIMA: true })
  const [nuevo, setNuevo] = useState({})
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [aviso, setAviso] = useState(null)
  const [userId, setUserId] = useState(null)
  const [modo, setModo] = useState('mes')        // 'mes' (edición) | 'comparar' (meses en columnas)
  const [cmp, setCmp] = useState(null)           // { porMes, meses } datos comparativos del año
  const [cmpCargando, setCmpCargando] = useState(false)
  const [cmpMeses, setCmpMeses] = useState([])   // meses seleccionados a mostrar en la comparativa

  useEffect(() => { supabase.auth.getUser().then(({ data }) => setUserId(data?.user?.id || null)) }, [])

  const cargarRubros = useCallback(async () => {
    const [{ data: rb }, { data: ins }] = await Promise.all([
      supabase.schema('produccion').from('cuadro_rubro')
        .select('id, grupo, nombre, orden, origen, incluye_real, finca_id').eq('activo', true)
        .or(`finca_id.is.null,finca_id.eq.${finca.id}`).order('grupo').order('orden'),
      supabase.schema('produccion').from('insumo').select('id, categoria_presupuesto').eq('activo', true),
    ])
    setRubros(rb || [])
    const cm = {}; (ins || []).forEach(i => { cm[i.id] = i.categoria_presupuesto }); setCatIns(cm)
  }, [finca.id])
  useEffect(() => { cargarRubros() }, [cargarRubros])

  // Consumo real del mes desde la app, mapeado a los rubros con `origen`.
  const cargarAppVals = useCallback(async (y, m) => {
    const desde = `${y}-${String(m).padStart(2, '0')}-01`
    const hasta = new Date(y, m, 0).toISOString().slice(0, 10)
    const [{ data: cons }, { data: dsl }] = await Promise.all([
      supabase.schema('produccion').rpc('fn_reporte_consumo', { p_finca: finca.id, p_desde: desde, p_hasta: hasta }),
      supabase.schema('produccion').rpc('fn_gasto_diesel_mes', { p_finca: finca.id, p_anio: y, p_mes: m }),
    ])
    let bal = 0; const cat = {}
    for (const f of (cons || [])) {
      if (f.tipo === 'balanceado') bal += Number(f.costo) || 0
      else if (f.tipo === 'insumo') {
        const c = catIns[f.item_id]
        if (c && c !== 'NO_APLICA') cat[c] = (cat[c] || 0) + (Number(f.costo) || 0)
      }
    }
    const out = {}
    for (const r of rubros) {
      if (r.origen === 'balanceado') out[r.id] = bal
      else if (r.origen === 'diesel') out[r.id] = Number(dsl) || 0
      else if (r.origen && r.origen.startsWith('insumo:')) { const k = r.origen.slice(7); out[r.id] = cat[k] || 0 }
    }
    return out
  }, [finca.id, rubros, catIns])

  // Carga la hoja del mes (cabecera + valores guardados + precarga de la app).
  useEffect(() => {
    if (!rubros.length) return
    let vivo = true
    ;(async () => {
      setCargando(true)
      const { data: cm } = await supabase.schema('produccion').from('cuadro_mes')
        .select('id, hectareas, dias, deduccion_sueldos, deduccion_beneficios').eq('finca_id', finca.id).eq('anio', anio).eq('mes', mes).maybeSingle()
      const app = await cargarAppVals(anio, mes)
      if (!vivo) return
      const saved = {}
      if (cm) {
        setHa(cm.hectareas ? String(cm.hectareas) : ''); setDias(String(cm.dias || diasDelMes(anio, mes)))
        setDedSueldos(cm.deduccion_sueldos ? num2(cm.deduccion_sueldos) : '')
        setDedBenef(cm.deduccion_beneficios ? num2(cm.deduccion_beneficios) : '')
        const { data: vs } = await supabase.schema('produccion').from('cuadro_valor')
          .select('rubro_id, valor, editado').eq('cuadro_mes_id', cm.id)
        if (!vivo) return
        ;(vs || []).forEach(v => { saved[v.rubro_id] = { valor: Number(v.valor), editado: v.editado } })
      } else {
        setHa(''); setDias(String(diasDelMes(anio, mes))); setDedSueldos(''); setDedBenef('')
      }
      setAppVals(app)
      const nt = {}; const ed = new Set()
      for (const r of rubros) {
        const s = saved[r.id]
        if (r.origen && s && s.editado) { nt[r.id] = num2(s.valor); ed.add(r.id) }       // override guardado
        else if (r.origen && app[r.id] != null) { if (app[r.id]) nt[r.id] = num2(app[r.id]) } // precarga
        else if (s && Number(s.valor)) { nt[r.id] = num2(s.valor) }                        // manual guardado
      }
      setTxt(nt); setEditado(ed); setCargando(false)
    })()
    return () => { vivo = false }
  }, [finca.id, anio, mes, rubros, cargarAppVals])

  // Comparativa: carga TODOS los meses del año de la finca (solo lectura).
  useEffect(() => {
    if (modo !== 'comparar' || !rubros.length) return
    let vivo = true
    ;(async () => {
      setCmpCargando(true)
      const { data: cms } = await supabase.schema('produccion').from('cuadro_mes')
        .select('id, mes, hectareas, dias, deduccion_sueldos, deduccion_beneficios, hadia_total, hadia_real')
        .eq('finca_id', finca.id).eq('anio', anio).order('mes')
      const ids = (cms || []).map(c => c.id)
      let vs = []
      if (ids.length) {
        for (let from = 0; ; from += 1000) {   // paginar por si pasa de 1000 filas
          const r = await supabase.schema('produccion').from('cuadro_valor')
            .select('cuadro_mes_id, rubro_id, valor').in('cuadro_mes_id', ids).range(from, from + 999)
          const chunk = r.data || []
          vs = vs.concat(chunk)
          if (chunk.length < 1000) break
        }
      }
      if (!vivo) return
      const mesDe = {}; (cms || []).forEach(c => { mesDe[c.id] = c.mes })
      const porMes = {}; (cms || []).forEach(c => { porMes[c.mes] = { ...c, valores: {} } })
      vs.forEach(v => { const m = mesDe[v.cuadro_mes_id]; if (m) porMes[m].valores[v.rubro_id] = Number(v.valor) })
      const meses = (cms || []).map(c => c.mes)
      setCmp({ porMes, meses }); setCmpMeses(meses); setCmpCargando(false)
    })()
    return () => { vivo = false }
  }, [modo, finca.id, anio, rubros])

  const val = id => parseNum(txt[id])
  // Rubros visibles de ESTA finca: por grupo, sus rubros propios (finca_id) si
  // tiene; si no, la plantilla compartida (finca_id null). Así cada finca ve su
  // propio desglose y no los rubros de las demás.
  const rubrosVis = useMemo(() => {
    const byG = {}
    for (const r of rubros) (byG[r.grupo] = byG[r.grupo] || []).push(r)
    const out = []
    for (const [g] of GRUPOS) {
      const arr = byG[g] || []
      const own = arr.filter(r => r.finca_id === finca.id)
      out.push(...(own.length ? own : arr.filter(r => r.finca_id == null)))
    }
    return out
  }, [rubros, finca.id])
  const totalesGrupo = useMemo(() => {
    const t = {}; for (const [g] of GRUPOS) t[g] = 0
    for (const r of rubrosVis) t[r.grupo] = (t[r.grupo] || 0) + val(r.id)
    return t
  }, [rubrosVis, txt])
  const { bruto, totOp, real, haDiaTotal, haDiaReal } = useMemo(() => {
    // bruto = todo. El ha·día TOTAL excluye balanceado+larva (ya se cuentan aparte
    // en Rentabilidad); el REAL excluye además activos y mejoras (incluye_real).
    let b = 0, to = 0, rl = 0
    for (const r of rubrosVis) {
      const v = val(r.id); b += v
      if (r.grupo !== 'BALANCEADO_LARVA') to += v
      if (r.incluye_real) rl += v
    }
    const h = parseNum(ha), d = Number(dias) || 0
    const div = h > 0 && d > 0 ? h * d : 0
    const dedTotal = parseNum(dedSueldos) + parseNum(dedBenef)
    const rlNeto = Math.max(0, rl - dedTotal)        // REAL = operativo − deducción administrativa
    return { bruto: b, totOp: to, real: rlNeto, haDiaTotal: div ? to / div : 0, haDiaReal: div ? rlNeto / div : 0 }
  }, [rubrosVis, txt, ha, dias, dedSueldos, dedBenef])

  const cambiar = (r, v) => { setTxt(t => ({ ...t, [r.id]: v })); if (r.origen) setEditado(s => { const n = new Set(s); n.add(r.id); return n }) }
  const restaurarApp = r => {
    setTxt(t => ({ ...t, [r.id]: appVals[r.id] ? num2(appVals[r.id]) : '' }))
    setEditado(s => { const n = new Set(s); n.delete(r.id); return n })
  }

  async function guardar() {
    if (!esJefe) return
    setGuardando(true)
    const ahora = new Date().toISOString()
    const { data: cm, error } = await supabase.schema('produccion').from('cuadro_mes')
      .upsert({ finca_id: finca.id, anio, mes, hectareas: parseNum(ha), dias: Number(dias) || diasDelMes(anio, mes), deduccion_sueldos: parseNum(dedSueldos), deduccion_beneficios: parseNum(dedBenef), hadia_total: haDiaTotal, hadia_real: haDiaReal, actualizado_por: userId, actualizado_en: ahora }, { onConflict: 'finca_id,anio,mes' })
      .select('id').single()
    if (error) { setGuardando(false); setAviso({ tipo: 'error', texto: 'No se pudo guardar la cabecera. ' + error.message }); return }
    const filas = rubrosVis.map(r => {
      const esApp = !!r.origen && !editado.has(r.id)
      return { cuadro_mes_id: cm.id, rubro_id: r.id, valor: val(r.id), fuente: esApp ? 'app' : 'manual', editado: !!r.origen && editado.has(r.id) }
    })
    const { error: e2 } = await supabase.schema('produccion').from('cuadro_valor').upsert(filas, { onConflict: 'cuadro_mes_id,rubro_id' })
    setGuardando(false)
    setAviso(e2 ? { tipo: 'error', texto: 'No se pudieron guardar los valores. ' + e2.message } : { tipo: 'ok', texto: `Cuadro de ${MESES[mes - 1]} ${anio} guardado.` })
  }

  async function agregarRubro(grupo) {
    const nombre = (nuevo[grupo] || '').trim(); if (!nombre) return
    const maxOrden = Math.max(0, ...rubrosVis.filter(r => r.grupo === grupo).map(r => r.orden))
    const incluye_real = !NO_REAL.has(grupo)
    const { error } = await supabase.schema('produccion').from('cuadro_rubro')
      .insert({ grupo, nombre, orden: maxOrden + 10, incluye_real, finca_id: finca.id })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo agregar el rubro. ' + error.message }); return }
    setNuevo(n => ({ ...n, [grupo]: '' })); cargarRubros()
  }

  const pasoMes = d => {
    let y = anio, m = mes + d
    if (m < 1) { m = 12; y-- } else if (m > 12) { m = 1; y++ }
    setAnio(y); setMes(m)
  }

  if (vista === 'dashboard') return <Dashboard fincas={fincas || []} esJefe={esJefe} setVista={setVista} />

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY, padding: '1.4rem', background: '#eef2f6', minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <div>
          <h1 style={{ fontSize: '21px', fontWeight: 500, margin: '0 0 2px' }}>Cuadro presupuestal</h1>
          <div style={{ fontSize: '12.5px', color: GRIS }}>{finca.nombre} · {MESES[mes - 1]} {anio}</div>
        </div>
        <div style={{ display: 'flex', gap: '9px', alignItems: 'center', flexWrap: 'wrap' }}>
          {esJefe && (fincas || []).length > 1 && (
            <span style={{ display: 'inline-flex', border: '0.5px solid ' + BORDE, borderRadius: '9px', overflow: 'hidden', fontSize: '12.5px' }}>
              <button onClick={() => setVista('finca')} style={{ padding: '7px 13px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500, background: AZUL, color: 'white' }}>Por finca</button>
              <button onClick={() => setVista('dashboard')} style={{ padding: '7px 13px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', background: 'white', color: GRIS }}>Dashboard</button>
            </span>
          )}
          <span style={{ display: 'inline-flex', border: '0.5px solid ' + BORDE, borderRadius: '9px', overflow: 'hidden', fontSize: '12.5px' }}>
            {[['mes', 'Mes'], ['comparar', 'Comparar']].map(([k, l]) => (
              <button key={k} onClick={() => setModo(k)} style={{ padding: '7px 13px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: modo === k ? 500 : 400, background: modo === k ? AZUL : 'white', color: modo === k ? 'white' : GRIS }}>{l}</button>
            ))}
          </span>
          {modo === 'mes' ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '9px', padding: '4px 8px', fontSize: '12.5px' }}>
              <button onClick={() => pasoMes(-1)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: GRIS, fontSize: '16px', fontFamily: 'inherit' }}>‹</button>
              <b style={{ fontWeight: 500, minWidth: '128px', textAlign: 'center' }}>{MESES[mes - 1]} {anio}</b>
              <button onClick={() => pasoMes(1)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: GRIS, fontSize: '16px', fontFamily: 'inherit' }}>›</button>
            </span>
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '9px', padding: '4px 8px', fontSize: '12.5px' }}>
              <button onClick={() => setAnio(a => a - 1)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: GRIS, fontSize: '16px', fontFamily: 'inherit' }}>‹</button>
              <b style={{ fontWeight: 500, minWidth: '48px', textAlign: 'center' }}>{anio}</b>
              <button onClick={() => setAnio(a => a + 1)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: GRIS, fontSize: '16px', fontFamily: 'inherit' }}>›</button>
            </span>
          )}
        </div>
      </div>

      {aviso && <div style={{ borderRadius: '10px', padding: '11px 14px', fontSize: '13px', marginBottom: '12px', background: aviso.tipo === 'ok' ? '#E1F5EE' : '#FBEAEA', color: aviso.tipo === 'ok' ? VERDE : '#8A2F2E' }}>{aviso.texto}</div>}

      {modo === 'comparar' ? (
        <TablaComparativa finca={finca} anio={anio} cargando={cmpCargando} cmp={cmp}
          rubrosVis={rubrosVis} abierto={abierto} setAbierto={setAbierto} cmpMeses={cmpMeses} setCmpMeses={setCmpMeses} />
      ) : (<>
      <div style={{ display: 'flex', gap: '10px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ fontSize: '12.5px', color: GRIS, display: 'inline-flex', alignItems: 'center', gap: '7px' }}>Hectáreas
          <input value={ha} onChange={e => setHa(e.target.value)} disabled={!esJefe} placeholder="108,24" style={{ ...inp, width: '90px' }} /></label>
        <label style={{ fontSize: '12.5px', color: GRIS, display: 'inline-flex', alignItems: 'center', gap: '7px' }}>Días del mes
          <input value={dias} onChange={e => setDias(e.target.value)} disabled={!esJefe} style={{ ...inp, width: '62px' }} /></label>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: '12px', alignItems: 'center', fontSize: '10.5px', color: GRIS }}>
          <span><span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px', background: '#e8f1fb', border: '1px solid #9fc3e8', verticalAlign: '1px' }} /> App (precargado del consumo del mes)</span>
          <span><span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px', background: 'white', border: '1px solid ' + BORDE, verticalAlign: '1px' }} /> Manual</span>
        </span>
      </div>

      {cargando ? (
        <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Cargando…</div>
      ) : (
        <div style={{ border: '0.5px solid ' + BORDE, borderRadius: '12px', background: 'white', overflow: 'hidden' }}>
          {GRUPOS.map(([g, gLabel]) => {
            // Rubros de esta finca para el grupo (propios o plantilla, vía rubrosVis).
            const items = rubrosVis.filter(r => r.grupo === g)
            const open = !!abierto[g]
            const noReal = NO_REAL.has(g)
            return (
              <div key={g}>
                <div onClick={() => setAbierto(a => ({ ...a, [g]: !open }))}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', cursor: 'pointer', background: noReal ? '#FBF8F0' : '#f3f7fb', borderTop: '0.5px solid ' + (noReal ? '#ecd9b4' : '#e6eef5'), borderBottom: '0.5px solid ' + (noReal ? '#ecd9b4' : '#e6eef5') }}>
                  <div style={{ fontSize: '12.5px', fontWeight: 500, color: noReal ? '#854F0B' : NAVY }}>
                    <span style={{ fontSize: '10px', color: GRIS }}>{open ? '▾' : '▸'}</span> &nbsp;{gLabel}
                    {noReal && <span style={{ fontSize: '10px', color: '#a98a4e', fontWeight: 400 }}> · no cuenta en el ha·día real</span>}
                  </div>
                  <div style={{ fontSize: '12.5px', fontWeight: 500, color: noReal ? '#854F0B' : NAVY }}>{dinero(totalesGrupo[g] || 0)}</div>
                </div>
                {open && (<>
                  {items.map(r => {
                    const esApp = !!r.origen
                    const sobre = esApp && editado.has(r.id)
                    return (
                      <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '7px 14px 7px 30px', borderBottom: '0.5px solid #f1f5f9', fontSize: '12.5px' }}>
                        <span>{r.nombre}
                          {esApp && <span style={{ fontSize: '9.5px', color: '#185FA5', background: '#e8f1fb', borderRadius: '10px', padding: '1px 7px', marginLeft: '6px' }}>App</span>}
                          {sobre && <span onClick={() => restaurarApp(r)} style={{ fontSize: '10px', color: GRIS, marginLeft: '8px', cursor: 'pointer' }} title="Volver al valor de la app">↺ app {dinero(appVals[r.id] || 0)}</span>}
                        </span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          <span style={{ fontSize: '12px', color: GRIS }}>$</span>
                          <input value={txt[r.id] || ''} disabled={!esJefe} placeholder="0,00" inputMode="decimal"
                            onChange={e => cambiar(r, e.target.value)}
                            onFocus={e => e.target.select()}
                            onBlur={e => setTxt(t => ({ ...t, [r.id]: e.target.value.trim() === '' ? '' : num2(parseNum(e.target.value)) }))}
                            style={{ ...inp, width: '118px', textAlign: 'right', padding: '5px 9px', background: esApp && !sobre ? '#f3f9ff' : 'white' }} />
                        </span>
                      </div>
                    )
                  })}
                  {esJefe && (
                    <div style={{ display: 'flex', gap: '8px', padding: '8px 14px 10px 30px', alignItems: 'center' }}>
                      <input value={nuevo[g] || ''} onChange={e => setNuevo(n => ({ ...n, [g]: e.target.value }))} placeholder="Agregar rubro…"
                        onKeyDown={e => { if (e.key === 'Enter') agregarRubro(g) }} style={{ ...inp, flex: 1, maxWidth: '260px', padding: '5px 9px', fontSize: '12px' }} />
                      <button onClick={() => agregarRubro(g)} style={{ ...inp, cursor: 'pointer', padding: '5px 11px', fontSize: '12px', color: AZUL, borderColor: AZUL }}>+ Agregar</button>
                    </div>
                  )}
                </>)}
              </div>
            )
          })}
        </div>
      )}

      <div style={{ marginTop: '14px', marginBottom: '10px', background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '11px 15px', display: 'flex', alignItems: 'center', gap: '22px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '11px', color: '#9fb0bf', textTransform: 'uppercase', letterSpacing: '.03em', minWidth: '150px' }}>Deducción administrativa<br /><span style={{ textTransform: 'none', letterSpacing: 0 }}>solo resta del ha·día REAL</span></span>
        {[['Sueldos administrativos', dedSueldos, setDedSueldos], ['Beneficios sociales', dedBenef, setDedBenef]].map(([lbl, v, set]) => (
          <label key={lbl} style={{ fontSize: '12px', color: GRIS, display: 'inline-flex', alignItems: 'center', gap: '7px' }}>{lbl}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}><span style={{ color: GRIS }}>$</span>
              <input value={v} disabled={!esJefe} placeholder="0,00" inputMode="decimal"
                onChange={e => set(e.target.value)} onFocus={e => e.target.select()}
                onBlur={e => set(e.target.value.trim() === '' ? '' : num2(parseNum(e.target.value)))}
                style={{ ...inp, width: '120px', textAlign: 'right', padding: '6px 10px' }} /></span>
          </label>
        ))}
      </div>

      {(() => {
        const h = parseNum(ha), d = Number(dias) || 0, div = h > 0 && d > 0 ? h * d : 0
        const pd = v => div ? '$' + num2(v / div) : '—'
        const bl = totalesGrupo['BALANCEADO_LARVA'] || 0, act = totalesGrupo['ACTIVOS'] || 0, mej = totalesGrupo['MEJORAS'] || 0
        const sue = parseNum(dedSueldos), ben = parseNum(dedBenef), dedV = sue + ben
        const paraResult = bruto - bl - act - mej - dedV
        const C = { th: { padding: '7px 15px', color: '#9fb0bf', fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '.03em' } }
        const fila = (k, monthly, perHa, opt = {}) => (<>
          <div style={{ padding: (opt.sub ? '3px 15px 3px 30px' : '6px 15px') + '', borderTop: opt.sub ? 'none' : '0.5px solid #f1f5f9', fontSize: opt.sub ? '11px' : '12px', fontWeight: opt.fuerte ? 500 : 400, color: opt.col || (opt.sub ? '#9fb0bf' : (opt.fuerte ? NAVY : '#51606c')), background: opt.bg || 'transparent' }}>{k}</div>
          <div style={{ padding: (opt.sub ? '3px 10px' : '6px 10px') + '', borderTop: opt.sub ? 'none' : '0.5px solid #f1f5f9', fontSize: opt.sub ? '11px' : '12px', textAlign: 'right', color: opt.col || (opt.sub ? '#9fb0bf' : NAVY), background: opt.bg || 'transparent' }}>{monthly}</div>
          <div style={{ padding: (opt.sub ? '3px 15px 3px 10px' : '6px 15px 6px 10px') + '', borderTop: opt.sub ? 'none' : '0.5px solid #f1f5f9', fontSize: opt.sub ? '11px' : (opt.fuerte ? '14px' : '12px'), textAlign: 'right', fontWeight: opt.fuerte ? 500 : 400, color: opt.col || (opt.sub ? '#9fb0bf' : NAVY), background: opt.bg || 'transparent' }}>{perHa}</div>
        </>)
        return (
          <div style={{ marginBottom: '12px', background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden' }}>
            <div style={{ padding: '11px 15px', background: '#f3f7fb', borderBottom: '0.5px solid #e6eef5', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
              <div style={{ fontSize: '12.5px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.03em', color: '#51606c' }}>Cuadre del costo por hectárea·día</div>
              <div style={{ fontSize: '11px', color: '#9fb0bf' }}>{div ? `${num2(h)} ha × ${d} días` : 'Falta hectáreas / días'}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto' }}>
              <div style={C.th}>Cómo se forma el ha·día total</div><div style={{ ...C.th, textAlign: 'right' }}>Mensual</div><div style={{ ...C.th, textAlign: 'right' }}>Por ha·día</div>
              {fila('Insumos (materia prima)', dinero(totalesGrupo['MATERIA_PRIMA'] || 0), pd(totalesGrupo['MATERIA_PRIMA'] || 0))}
              {fila('Mano de obra', dinero(totalesGrupo['MANO_OBRA'] || 0), pd(totalesGrupo['MANO_OBRA'] || 0))}
              {fila('Indirectos', dinero(totalesGrupo['INDIRECTOS'] || 0), pd(totalesGrupo['INDIRECTOS'] || 0))}
              {fila('Otros administrativos', dinero(totalesGrupo['OTROS_ADMIN'] || 0), pd(totalesGrupo['OTROS_ADMIN'] || 0))}
              {fila('Mejoras', dinero(mej), pd(mej))}
              {fila('Activos fijos', dinero(act), pd(act))}
              {fila('Costo ha·día TOTAL', dinero(totOp), '$' + num2(haDiaTotal), { fuerte: true, col: '#185FA5', bg: '#eaf2fb' })}
            </div>
            <div style={{ padding: '7px 15px', background: '#fcfdfe', borderTop: '0.5px solid #eef3f7', fontSize: '10.5px', color: '#9fb0bf' }}>Balanceado y larva ({dinero(bl)}) no entran: la Rentabilidad ya los cuenta aparte.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', borderTop: '0.5px solid #e6eef5' }}>
              <div style={C.th}>Del total al real</div><div style={C.th}></div><div style={C.th}></div>
              {fila('Costo ha·día TOTAL', '', '$' + num2(haDiaTotal))}
              {fila('(−) Mejoras', dinero(mej), div ? '−$' + num2(mej / div) : '—', { col: '#854F0B' })}
              {fila('(−) Activos fijos', dinero(act), div ? '−$' + num2(act / div) : '—', { col: '#854F0B' })}
              {fila('(−) Deducción administrativa', dinero(dedV), div ? '−$' + num2(dedV / div) : '—', { col: '#854F0B' })}
              {fila('· Sueldos administrativos', dinero(sue), pd(sue), { sub: true })}
              {fila('· Beneficios sociales', dinero(ben), pd(ben), { sub: true })}
              {fila('Total para resultados', dinero(paraResult), '', { fuerte: true })}
              {fila('Costo ha·día REAL', '', '$' + num2(haDiaReal), { fuerte: true, col: VERDE, bg: '#e7f6ef' })}
            </div>
          </div>
        )
      })()}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
        <div style={{ background: '#f6f9fb', borderRadius: '10px', padding: '12px 14px' }}>
          <div style={{ fontSize: '11px', color: GRIS }}>Total bruto del mes</div>
          <div style={{ fontSize: '19px', fontWeight: 500 }}>{dinero(bruto)}</div>
        </div>
        <div style={{ background: '#eaf2fb', borderRadius: '10px', padding: '12px 14px' }}>
          <div style={{ fontSize: '11px', color: '#185FA5' }}>ha·día TOTAL</div>
          <div style={{ fontSize: '21px', fontWeight: 500, color: AZUL }}>${num2(haDiaTotal)}</div>
          <div style={{ fontSize: '9.5px', color: '#9fb0bf' }}>incluye activos y mejoras</div>
        </div>
        <div style={{ background: '#e7f6ef', borderRadius: '10px', padding: '12px 14px' }}>
          <div style={{ fontSize: '11px', color: VERDE }}>ha·día REAL</div>
          <div style={{ fontSize: '21px', fontWeight: 500, color: VERDE }}>${num2(haDiaReal)}</div>
          <div style={{ fontSize: '9.5px', color: '#9fb0bf' }}>sin activos, mejoras ni admin · → Rentabilidad</div>
        </div>
      </div>

      {esJefe && (
        <div style={{ display: 'flex', gap: '9px', marginTop: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={guardar} disabled={guardando} style={{ ...btnAzul, opacity: guardando ? 0.6 : 1 }}>{guardando ? 'Guardando…' : 'Guardar'}</button>
          <span style={{ fontSize: '11px', color: '#9fb0bf' }}>Los rubros “App” vienen del consumo real del mes y los puedes editar. Se calcula en vivo; no hay que cerrar el mes.</span>
        </div>
      )}
      </>)}
    </div>
  )
}

// ===== Tabla comparativa · meses en columnas (solo lectura) =====
function TablaComparativa({ finca, anio, cargando, cmp, rubrosVis, abierto, setAbierto, cmpMeses, setCmpMeses }) {
  const [trendH, setTrendH] = useState(null)   // índice de mes resaltado en la tendencia
  const twRef = useRef(null)
  const [tcw, setTcw] = useState(680)          // ancho real del gráfico de tendencia
  useEffect(() => {
    const el = twRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(es => { for (const e of es) setTcw(e.contentRect.width) })
    ro.observe(el); setTcw(el.clientWidth || 680)
    return () => ro.disconnect()
  }, [cargando, cmpMeses.length])
  if (cargando) return <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Cargando…</div>
  const meses = cmp?.meses || []
  if (!meses.length) return <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>No hay meses cargados para {finca.nombre} en {anio}.</div>
  const sel = (cmpMeses.length ? cmpMeses : meses).slice().sort((a, b) => a - b)
  const toggleMes = m => setCmpMeses(cur => {
    const base = cur.length ? cur : meses
    const n = base.includes(m) ? base.filter(x => x !== m) : [...base, m]
    return n.length ? n : base   // nunca dejar 0
  })
  const vOf = (m, rid) => cmp.porMes[m]?.valores[rid] || 0
  const grpItems = g => rubrosVis.filter(r => r.grupo === g)
  const grpTot = (m, g) => grpItems(g).reduce((s, r) => s + vOf(m, r.id), 0)
  const hdia = (m, k) => Number(cmp.porMes[m]?.[k]) || 0
  const cab = (m) => cmp.porMes[m] || {}
  const cols = sel.length
  // celda numérica
  const td = (txt, opt = {}) => (
    <td style={{ padding: '6px 12px', textAlign: 'right', fontSize: opt.f ? '12.5px' : '12px', fontWeight: opt.fuerte ? 500 : 400, color: opt.col || NAVY, background: opt.bg || 'transparent', borderBottom: '0.5px solid #f1f5f9', whiteSpace: 'nowrap' }}>{txt}</td>
  )
  const th1 = { position: 'sticky', left: 0, zIndex: 1, background: 'white', borderRight: '0.5px solid ' + BORDE }
  // variación vs el mes anterior (verde = bajó el costo, rojo = subió)
  const deltaTxt = (cur, prev) => {
    if (prev == null || cur == null || !isFinite(prev) || prev === 0) return null
    const d = (cur - prev) / Math.abs(prev)
    if (Math.abs(d) < 0.005) return <span style={{ fontSize: '9.5px', color: '#b8c4ce', marginLeft: '4px' }}>0%</span>
    const up = d > 0
    return <span style={{ fontSize: '9.5px', color: up ? ROJO : VERDE, marginLeft: '4px' }}>{up ? '▲' : '▼'}{Math.abs(Math.round(d * 100))}%</span>
  }
  return (
    <div>
      {/* selector de meses */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px', alignItems: 'center' }}>
        <span style={{ fontSize: '11px', color: GRIS, marginRight: '2px' }}>Meses:</span>
        {meses.map(m => {
          const on = sel.includes(m)
          return <button key={m} onClick={() => toggleMes(m)} style={{ padding: '4px 10px', fontSize: '11.5px', fontFamily: 'inherit', borderRadius: '8px', cursor: 'pointer', border: '0.5px solid ' + (on ? AZUL : BORDE), background: on ? '#eaf2fb' : 'white', color: on ? '#185FA5' : GRIS, fontWeight: on ? 500 : 400 }}>{MESES[m - 1].slice(0, 3)}</button>
        })}
      </div>
      <div style={{ border: '0.5px solid ' + BORDE, borderRadius: '12px', background: 'white', overflow: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: (180 + cols * 96) + 'px' }}>
          <thead>
            <tr>
              <th style={{ ...th1, padding: '9px 14px', textAlign: 'left', fontSize: '11px', color: '#9fb0bf', textTransform: 'uppercase', letterSpacing: '.03em', borderBottom: '0.5px solid ' + BORDE, zIndex: 2 }}>Concepto</th>
              {sel.map(m => <th key={m} style={{ padding: '9px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 500, color: NAVY, borderBottom: '0.5px solid ' + BORDE, borderLeft: '0.5px solid #f1f5f9', whiteSpace: 'nowrap' }}>{MESES[m - 1].slice(0, 3)}</th>)}
            </tr>
          </thead>
          <tbody>
            {/* ha·día destacado */}
            <tr>
              <td style={{ ...th1, padding: '8px 14px', fontSize: '12.5px', fontWeight: 500, color: '#185FA5', background: '#eaf2fb', borderBottom: '0.5px solid #e6eef5' }}>ha·día TOTAL</td>
              {sel.map((m, i) => <td key={m} style={{ padding: '8px 12px', textAlign: 'right', fontSize: '13px', fontWeight: 500, color: '#185FA5', background: '#eaf2fb', borderBottom: '0.5px solid #e6eef5', borderLeft: '0.5px solid #e6eef5', whiteSpace: 'nowrap' }}>${num2(hdia(m, 'hadia_total'))}{i > 0 && deltaTxt(hdia(m, 'hadia_total'), hdia(sel[i - 1], 'hadia_total'))}</td>)}
            </tr>
            <tr>
              <td style={{ ...th1, padding: '8px 14px', fontSize: '12.5px', fontWeight: 500, color: VERDE, background: '#e7f6ef', borderBottom: '0.5px solid ' + BORDE }}>ha·día REAL</td>
              {sel.map((m, i) => <td key={m} style={{ padding: '8px 12px', textAlign: 'right', fontSize: '13px', fontWeight: 500, color: VERDE, background: '#e7f6ef', borderBottom: '0.5px solid ' + BORDE, borderLeft: '0.5px solid #dcefe6', whiteSpace: 'nowrap' }}>${num2(hdia(m, 'hadia_real'))}{i > 0 && deltaTxt(hdia(m, 'hadia_real'), hdia(sel[i - 1], 'hadia_real'))}</td>)}
            </tr>
            {/* hectáreas / días */}
            <tr>
              <td style={{ ...th1, padding: '5px 14px', fontSize: '11px', color: '#9fb0bf' }}>Hectáreas</td>
              {sel.map(m => td(num2(cab(m).hectareas || 0), { col: '#9fb0bf' }))}
            </tr>
            <tr>
              <td style={{ ...th1, padding: '5px 14px', fontSize: '11px', color: '#9fb0bf' }}>Días</td>
              {sel.map(m => td(cab(m).dias || '—', { col: '#9fb0bf' }))}
            </tr>
            {/* grupos */}
            {GRUPOS.map(([g, gLabel]) => {
              const items = grpItems(g)
              const open = !!abierto[g]
              const noReal = NO_REAL.has(g)
              return (
                <Fragment key={g}>
                  <tr onClick={() => setAbierto(a => ({ ...a, [g]: !open }))} style={{ cursor: 'pointer' }}>
                    <td style={{ ...th1, padding: '9px 14px', fontSize: '12.5px', fontWeight: 500, color: noReal ? '#854F0B' : NAVY, background: noReal ? '#FBF8F0' : '#f3f7fb', borderTop: '0.5px solid ' + (noReal ? '#ecd9b4' : '#e6eef5'), borderBottom: '0.5px solid ' + (noReal ? '#ecd9b4' : '#e6eef5') }}>
                      <span style={{ fontSize: '10px', color: GRIS }}>{open ? '▾' : '▸'}</span>&nbsp; {gLabel}
                    </td>
                    {sel.map((m, i) => <td key={m} style={{ padding: '9px 12px', textAlign: 'right', fontSize: '12.5px', fontWeight: 500, color: noReal ? '#854F0B' : NAVY, background: noReal ? '#FBF8F0' : '#f3f7fb', borderTop: '0.5px solid ' + (noReal ? '#ecd9b4' : '#e6eef5'), borderBottom: '0.5px solid ' + (noReal ? '#ecd9b4' : '#e6eef5'), borderLeft: '0.5px solid #eef3f7', whiteSpace: 'nowrap' }}>{dinero(grpTot(m, g))}{i > 0 && deltaTxt(grpTot(m, g), grpTot(sel[i - 1], g))}</td>)}
                  </tr>
                  {open && items.map(r => (
                    <tr key={r.id}>
                      <td style={{ ...th1, padding: '6px 14px 6px 30px', fontSize: '12px', color: '#51606c' }}>{r.nombre}</td>
                      {sel.map((m) => <td key={m} style={{ padding: '6px 12px', textAlign: 'right', fontSize: '12px', color: '#51606c', background: 'transparent', borderBottom: '0.5px solid #f1f5f9', whiteSpace: 'nowrap' }}>{dinero(vOf(m, r.id))}</td>)}
                    </tr>
                  ))}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      {/* mini-gráfico de tendencia del ha·día */}
      {sel.length > 1 && (() => {
        const serie = [['hadia_total', '#0D6CB0', 'TOTAL'], ['hadia_real', VERDE, 'REAL']]
        const vals = sel.flatMap(m => [hdia(m, 'hadia_total'), hdia(m, 'hadia_real')]).filter(v => v > 0)
        if (!vals.length) return null
        const lo = Math.min(...vals) * 0.9, hi = Math.max(...vals) * 1.05
        const W = Math.max(360, Math.round(tcw)), H = 160, L = 42, R = 12, T = 14, B = 26, n = sel.length
        const px = i => L + i * (W - L - R) / (n - 1)
        const py = v => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B)
        const onMove = e => { const rc = e.currentTarget.getBoundingClientRect(); const x = (e.clientX - rc.left) / rc.width * W; let b = 0, bd = 1e9; for (let i = 0; i < n; i++) { const d = Math.abs(px(i) - x); if (d < bd) { bd = d; b = i } } setTrendH(b) }
        return (
          <div style={{ border: '0.5px solid ' + BORDE, borderRadius: '12px', background: 'white', padding: '12px 14px', marginTop: '12px' }}>
            <div style={{ fontSize: '10.5px', color: '#9fb0bf', textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: '6px' }}>Tendencia del ha·día</div>
            <div ref={twRef} style={{ position: 'relative' }}>
              <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block' }} onMouseMove={onMove} onMouseLeave={() => setTrendH(null)}>
                {[0, 0.5, 1].map((t, i) => { const v = lo + t * (hi - lo); return <g key={i}><line x1={L} y1={py(v)} x2={W - R} y2={py(v)} stroke="#f1f5f9" /><text x={L - 6} y={py(v) + 3} textAnchor="end" style={{ fontSize: '9.5px', fill: '#9fb0bf' }}>${num2(v)}</text></g> })}
                {sel.map((m, i) => <text key={m} x={px(i)} y={H - 9} textAnchor="middle" style={{ fontSize: '10px', fill: '#7d8fa0' }}>{MESES[m - 1].slice(0, 3)}</text>)}
                {trendH != null && <line x1={px(trendH)} y1={T} x2={px(trendH)} y2={H - B} stroke="#cdd9e5" strokeDasharray="3 3" />}
                {serie.map(([k, c]) => <polyline key={k} points={sel.map((m, i) => `${px(i)},${py(hdia(m, k))}`).join(' ')} fill="none" stroke={c} strokeWidth="2.5" strokeLinejoin="round" />)}
                {serie.map(([k, c]) => sel.map((m, i) => <circle key={k + i} cx={px(i)} cy={py(hdia(m, k))} r={trendH === i ? 4.5 : 2.5} fill={c} />))}
              </svg>
              {trendH != null && (() => { const left = px(trendH) / W * 100, flip = left > 60, m = sel[trendH]; return (
                <div style={{ position: 'absolute', top: '4px', left: flip ? 'auto' : `calc(${left}% + 8px)`, right: flip ? `calc(${100 - left}% + 8px)` : 'auto', background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '8px', boxShadow: '0 6px 18px rgba(2,40,71,.12)', padding: '6px 9px', fontSize: '11px', pointerEvents: 'none', minWidth: '110px' }}>
                  <div style={{ fontWeight: 500, marginBottom: '3px' }}>{MESES[m - 1]} {anio}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', color: '#185FA5' }}><span>TOTAL</span><b style={{ fontWeight: 500 }}>${num2(hdia(m, 'hadia_total'))}</b></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', color: VERDE }}><span>REAL</span><b style={{ fontWeight: 500 }}>${num2(hdia(m, 'hadia_real'))}</b></div>
                </div>
              ) })()}
            </div>
            <div style={{ display: 'flex', gap: '14px', fontSize: '10.5px', color: '#7d8fa0', marginTop: '4px', paddingLeft: '8px' }}>
              <span><span style={{ display: 'inline-block', width: '14px', height: '3px', background: '#0D6CB0', verticalAlign: '3px' }} /> TOTAL</span>
              <span><span style={{ display: 'inline-block', width: '14px', height: '3px', background: VERDE, verticalAlign: '3px' }} /> REAL</span>
            </div>
          </div>
        )
      })()}
      <div style={{ fontSize: '10.5px', color: '#9fb0bf', marginTop: '8px' }}>Solo lectura. Para editar un mes, vuelve a “Mes”. La columna muestra la variación vs el mes anterior (verde = bajó, rojo = subió).</div>
    </div>
  )
}

// ===== Dashboard · resumen multi-finca del Cuadro presupuestal =====
const GRP = [
  ['BALANCEADO_LARVA', 'Balanceado y larva', '#51606c'],
  ['MATERIA_PRIMA', 'Insumos', '#BA7517'],
  ['MANO_OBRA', 'Mano de obra', '#1D9E75'],
  ['INDIRECTOS', 'Indirectos', '#0D6CB0'],
  ['OTROS_ADMIN', 'Otros administrativos', '#7F77DD'],
  ['ACTIVOS', 'Activos fijos', '#9fb0bf'],
  ['MEJORAS', 'Mejoras', '#D4537E'],
]
const grpInfo = k => GRP.find(g => g[0] === k) || [k, k, '#9fb0bf']
const PERIODOS = [[1, '1 mes'], [2, '2 meses'], [3, '3 meses'], [4, '4 meses']]
const ZONA_LBL = { jambeli: 'Jambelí', 'jambelí': 'Jambelí', puna: 'Puná', 'puná': 'Puná' }
const zlabel = z => ZONA_LBL[String(z || '').toLowerCase()] || (z ? z.charAt(0).toUpperCase() + z.slice(1) : z)

function Dashboard({ fincas, esJefe, setVista }) {
  const activas = useMemo(() => (fincas || []).filter(f => String(f.nombre).toUpperCase() !== 'PRUEBA'), [fincas])
  const zonas = useMemo(() => [...new Set(activas.map(f => f.zona).filter(Boolean))], [activas])
  const [zona, setZona] = useState('')
  const [sel, setSel] = useState(() => new Set(activas.map(f => f.id)))
  const [periodo, setPeriodo] = useState(1)
  const [ancla, setAncla] = useState(() => { const d = new Date(); return { anio: d.getFullYear(), mes: d.getMonth() + 1 } }) // mes de referencia
  const [operativo, setOperativo] = useState(true)
  const [grupoSel, setGrupoSel] = useState(null)
  const [hoverG, setHoverG] = useState(null)
  const [fincasOpen, setFincasOpen] = useState(false)
  const [data, setData] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [modoDash, setModoDash] = useState('resumen')   // 'resumen' | 'comparar'

  const visibles = useMemo(() => activas.filter(f => !zona || f.zona === zona), [activas, zona])
  const idsSel = useMemo(() => visibles.filter(f => sel.has(f.id)).map(f => f.id), [visibles, sel])

  useEffect(() => {
    let vivo = true
    ;(async () => {
      setCargando(true)
      if (!idsSel.length) { if (vivo) { setData({ porFinca: [], grupos: {}, sub: {}, nMeses: 0 }); setCargando(false) } return }
      const { data: cms } = await supabase.schema('produccion').from('cuadro_mes')
        .select('id, finca_id, anio, mes, hadia_total, hadia_real').in('finca_id', idsSel)
        .order('anio', { ascending: false }).order('mes', { ascending: false })
      if (!vivo) return
      const anclaKey = ancla.anio * 12 + ancla.mes
      const porF = {}; (cms || []).forEach(r => { if (r.anio * 12 + r.mes <= anclaKey) (porF[r.finca_id] = porF[r.finca_id] || []).push(r) })
      const mesIds = []
      const porFinca = idsSel.map(fid => {
        const rows = (porF[fid] || []).slice(0, periodo); rows.forEach(r => mesIds.push(r.id))
        const n = rows.length, avg = c => n ? rows.reduce((s, r) => s + Number(r[c] || 0), 0) / n : 0
        const f = visibles.find(x => x.id === fid)
        return { id: fid, nombre: f?.nombre || '', zona: f?.zona, real: avg('hadia_real'), total: avg('hadia_total'), n }
      })
      let grupos = {}, sub = {}
      if (mesIds.length) {
        let vs = []   // paginar: con varias fincas×meses se pasa de 1000 filas
        for (let from = 0; ; from += 1000) {
          const r = await supabase.schema('produccion').from('cuadro_valor')
            .select('valor, rubro:rubro_id(grupo, nombre)').in('cuadro_mes_id', mesIds).range(from, from + 999)
          const chunk = r.data || []
          vs = vs.concat(chunk)
          if (chunk.length < 1000) break
        }
        if (!vivo) return
        vs.forEach(v => {
          const g = v.rubro?.grupo; if (!g) return
          grupos[g] = (grupos[g] || 0) + Number(v.valor || 0)
          ;(sub[g] = sub[g] || {})[v.rubro.nombre] = (sub[g][v.rubro.nombre] || 0) + Number(v.valor || 0)
        })
      }
      setData({ porFinca, grupos, sub, nMeses: Math.max(0, ...porFinca.map(x => x.n)) })
      setCargando(false)
    })()
    return () => { vivo = false }
  }, [JSON.stringify(idsSel), periodo, ancla.anio, ancla.mes])

  const toggleFinca = id => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const conDato = (data?.porFinca || []).filter(f => f.n > 0)
  const promReal = conDato.length ? conDato.reduce((s, f) => s + f.real, 0) / conDato.length : 0
  const promTotal = conDato.length ? conDato.reduce((s, f) => s + f.total, 0) / conDato.length : 0
  const rango = arr => arr.length ? `$${num2(Math.min(...arr))}–${num2(Math.max(...arr))}` : '—'
  const maxBar = Math.max(1, ...conDato.map(f => f.total))

  // Gasto por grupo (dona): excluye balanceado+larva si operativo.
  const grupos = data?.grupos || {}
  const segs = GRP.filter(([k]) => (operativo ? k !== 'BALANCEADO_LARVA' : true)).map(([k, l, c]) => ({ k, l, c, v: grupos[k] || 0 })).filter(s => s.v > 0.005)
  const totGasto = segs.reduce((s, x) => s + x.v, 0)
  const R = 54, C = 2 * Math.PI * R
  let acc = 0
  const arcos = segs.map(s => { const len = totGasto ? (s.v / totGasto) * C : 0; const el = { ...s, len, off: acc, pct: totGasto ? s.v / totGasto : 0 }; acc += len; return el })
  const centroG = hoverG ? arcos.find(a => a.k === hoverG) : null

  const seldrill = grupoSel ? Object.entries(data?.sub?.[grupoSel] || {}).map(([n, v]) => ({ n, v })).sort((a, b) => b.v - a.v) : null

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY, padding: '1.4rem', background: '#eef2f6', minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <div>
          <h1 style={{ fontSize: '21px', fontWeight: 500, margin: '0 0 2px' }}>Cuadro presupuestal · Dashboard</h1>
          <div style={{ fontSize: '12.5px', color: GRIS }}>{conDato.length} de {idsSel.length} fincas con datos{data?.nMeses ? ` · ${PERIODOS.find(p => p[0] === periodo)[1].toLowerCase()}` : ''}</div>
        </div>
        <span style={{ display: 'inline-flex', border: '0.5px solid ' + BORDE, borderRadius: '9px', overflow: 'hidden', fontSize: '12.5px' }}>
          <button onClick={() => setVista('finca')} style={{ padding: '7px 13px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', background: 'white', color: GRIS }}>Por finca</button>
          <button onClick={() => setVista('dashboard')} style={{ padding: '7px 13px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500, background: AZUL, color: 'white' }}>Dashboard</button>
        </span>
      </div>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '14px', fontSize: '12.5px' }}>
        <span style={{ display: 'inline-flex', border: '0.5px solid ' + BORDE, borderRadius: '9px', overflow: 'hidden', fontSize: '12px' }}>
          {[['resumen', 'Resumen'], ['comparar', 'Comparar']].map(([k, l]) => (
            <button key={k} onClick={() => setModoDash(k)} style={{ padding: '7px 13px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: modoDash === k ? 500 : 400, background: modoDash === k ? AZUL : 'white', color: modoDash === k ? 'white' : GRIS }}>{l}</button>
          ))}
        </span>
        {zonas.length > 0 && (
          <Dropdown label="Zona" value={zona ? zlabel(zona) : 'Todas'}>
            {[['', 'Todas'], ...zonas.map(z => [z, zlabel(z)])].map(([v, l]) => <DItem key={v} on={zona === v} onClick={() => setZona(v)}>{l}</DItem>)}
          </Dropdown>
        )}
        <span style={{ position: 'relative' }}>
          <button onClick={() => setFincasOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', border: '0.5px solid ' + (fincasOpen ? AZUL : BORDE), borderRadius: '9px', padding: '7px 12px', background: 'white', cursor: 'pointer', fontFamily: 'inherit', color: fincasOpen ? AZUL : NAVY }}><b style={{ fontWeight: 500 }}>{sel.size} {sel.size === 1 ? 'finca' : 'fincas'}</b> <span style={{ color: '#9fb0bf' }}>▾</span></button>
          {fincasOpen && (<>
            <div onClick={() => setFincasOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
            <div style={{ position: 'absolute', top: 'calc(100% + 5px)', left: 0, zIndex: 41, background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '10px', boxShadow: '0 8px 24px rgba(2,40,71,.12)', padding: '8px', minWidth: '180px', maxHeight: '300px', overflowY: 'auto' }}>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
                <button onClick={() => setSel(new Set(visibles.map(f => f.id)))} style={{ ...inp, cursor: 'pointer', padding: '3px 9px', fontSize: '11px', color: AZUL, borderColor: AZUL }}>Todas</button>
                <button onClick={() => setSel(new Set())} style={{ ...inp, cursor: 'pointer', padding: '3px 9px', fontSize: '11px', color: GRIS }}>Ninguna</button>
              </div>
              {visibles.map(f => { const on = sel.has(f.id); return (
                <label key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 6px', fontSize: '12.5px', cursor: 'pointer', borderRadius: '6px' }} onMouseEnter={e => e.currentTarget.style.background = '#f3f7fb'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                  <input type="checkbox" checked={on} onChange={() => toggleFinca(f.id)} /> {f.nombre}
                </label>
              ) })}
            </div>
          </>)}
        </span>

        <span style={{ width: '1px', height: '24px', background: '#e6edf3' }} />

        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', border: '0.5px solid ' + BORDE, borderRadius: '9px', padding: '4px 7px', background: 'white' }}>
          <button onClick={() => setAncla(a => { let y = a.anio, m = a.mes - 1; if (m < 1) { m = 12; y-- } return { anio: y, mes: m } })} style={{ border: 'none', background: 'none', cursor: 'pointer', color: GRIS, fontSize: '15px', fontFamily: 'inherit' }}>‹</button>
          <b style={{ fontWeight: 500, minWidth: '78px', textAlign: 'center', fontSize: '12px' }}>{MESES[ancla.mes - 1].slice(0, 3)} {ancla.anio}</b>
          <button onClick={() => setAncla(a => { let y = a.anio, m = a.mes + 1; if (m > 12) { m = 1; y++ } return { anio: y, mes: m } })} style={{ border: 'none', background: 'none', cursor: 'pointer', color: GRIS, fontSize: '15px', fontFamily: 'inherit' }}>›</button>
        </span>
        <Dropdown label="Promedio" value={(PERIODOS.find(p => p[0] === periodo) || PERIODOS[0])[1]}>
          {PERIODOS.map(([v, l]) => <DItem key={v} on={periodo === v} onClick={() => setPeriodo(v)}>{l}</DItem>)}
        </Dropdown>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
        <div style={{ background: '#e7f6ef', borderRadius: '12px', padding: '13px 16px' }}>
          <div style={{ fontSize: '11px', color: VERDE }}>Ha·día REAL · Promedio</div>
          <div style={{ fontSize: '24px', fontWeight: 500, color: VERDE }}>${num2(promReal)}</div>
          <div style={{ fontSize: '10.5px', color: '#9fb0bf' }}>Va a la Rentabilidad · rango {rango(conDato.map(f => f.real))}</div>
        </div>
        <div style={{ background: '#eaf2fb', borderRadius: '12px', padding: '13px 16px' }}>
          <div style={{ fontSize: '11px', color: '#185FA5' }}>Ha·día COSTO (TOTAL) · Promedio</div>
          <div style={{ fontSize: '24px', fontWeight: 500, color: AZUL }}>${num2(promTotal)}</div>
          <div style={{ fontSize: '10.5px', color: '#9fb0bf' }}>Costo completo · rango {rango(conDato.map(f => f.total))}</div>
        </div>
      </div>

      {modoDash === 'comparar' ? (
        <ComparaFincas visibles={visibles} idsSel={idsSel} anio={ancla.anio} />
      ) : cargando ? (
        <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Cargando…</div>
      ) : (<>
        <div style={{ border: '0.5px solid ' + BORDE, borderRadius: '12px', background: 'white', padding: '14px 16px', marginBottom: '14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
            <div style={{ fontSize: '11px', color: '#9fb0bf', textTransform: 'uppercase', letterSpacing: '.04em' }}>Ha·día por finca</div>
            <div style={{ fontSize: '10.5px', color: GRIS }}><span style={{ color: VERDE }}>■</span> Real &nbsp;<span style={{ color: AZUL }}>■</span> Total</div>
          </div>
          {conDato.length === 0 ? <div style={{ fontSize: '12.5px', color: GRIS, padding: '10px 0' }}>Ninguna finca seleccionada tiene Cuadro cargado en este periodo.</div> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '11px' }}>
              {[...conDato].sort((a, b) => b.real - a.real).map(f => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ width: '88px', fontSize: '12px', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.nombre}</span>
                  <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <span style={{ height: '11px', borderRadius: '3px', background: VERDE, width: (100 * f.real / maxBar) + '%', minWidth: '2px' }} />
                    <span style={{ height: '11px', borderRadius: '3px', background: AZUL, width: (100 * f.total / maxBar) + '%', minWidth: '2px' }} />
                  </span>
                  <span style={{ fontSize: '11.5px', width: '118px', textAlign: 'right' }}><b style={{ color: VERDE, fontWeight: 500 }}>${num2(f.real)}</b> <span style={{ color: '#9fb0bf' }}>/ ${num2(f.total)}</span></span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ border: '0.5px solid ' + BORDE, borderRadius: '12px', background: 'white', padding: '14px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
            <div style={{ fontSize: '11px', color: '#9fb0bf', textTransform: 'uppercase', letterSpacing: '.04em' }}>En qué se va</div>
            <span style={{ display: 'inline-flex', border: '0.5px solid ' + BORDE, borderRadius: '8px', overflow: 'hidden', fontSize: '11px' }}>
              <button onClick={() => setOperativo(true)} style={{ padding: '4px 10px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', background: operativo ? AZUL : 'white', color: operativo ? 'white' : GRIS }}>Operativo</button>
              <button onClick={() => setOperativo(false)} style={{ padding: '4px 10px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', background: !operativo ? AZUL : 'white', color: !operativo ? 'white' : GRIS }}>Todo el bruto</button>
            </span>
          </div>
          {totGasto <= 0 ? <div style={{ fontSize: '12.5px', color: GRIS }}>Sin datos de gasto en el periodo.</div> : (
            <div style={{ display: 'flex', gap: '20px', alignItems: 'center', flexWrap: 'wrap' }}>
              <svg width="150" height="150" viewBox="0 0 140 140" style={{ flexShrink: 0 }}>
                <circle cx="70" cy="70" r={R} fill="none" stroke="#eef3f7" strokeWidth="22" />
                <g transform="rotate(-90 70 70)" fill="none" strokeWidth="22">
                  {arcos.map(a => <circle key={a.k} cx="70" cy="70" r={R} stroke={a.c} strokeDasharray={`${a.len} ${C - a.len}`} strokeDashoffset={-a.off}
                    style={{ cursor: 'pointer', opacity: hoverG && hoverG !== a.k ? 0.4 : 1 }}
                    onMouseEnter={() => setHoverG(a.k)} onMouseLeave={() => setHoverG(null)} onClick={() => setGrupoSel(a.k)} />)}
                </g>
                <text x="70" y={centroG ? 64 : 68} textAnchor="middle" style={{ fontSize: '15px', fontWeight: 500, fill: NAVY }}>{centroG ? dinero(centroG.v) : dinero(totGasto)}</text>
                <text x="70" y={centroG ? 80 : 84} textAnchor="middle" style={{ fontSize: '9px', fill: '#9fb0bf' }}>{centroG ? `${grpInfo(centroG.k)[1]} · ${Math.round(centroG.pct * 100)}%` : (operativo ? 'operativo' : 'bruto')}</text>
              </svg>
              <div style={{ fontSize: '11.5px', display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: '180px' }}>
                {arcos.map(a => (
                  <div key={a.k} onMouseEnter={() => setHoverG(a.k)} onMouseLeave={() => setHoverG(null)} onClick={() => setGrupoSel(a.k)}
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '3px 6px', borderRadius: '6px', background: hoverG === a.k ? '#f3f7fb' : 'transparent' }}>
                    <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: a.c, flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>{a.l}</span>
                    <b style={{ fontWeight: 500 }}>{Math.round(a.pct * 100)}%</b>
                    <span style={{ color: '#9fb0bf', width: '78px', textAlign: 'right' }}>{dinero(a.v)}</span>
                  </div>
                ))}
                <div style={{ fontSize: '10px', color: '#9fb0bf', marginTop: '2px' }}>Pasa el cursor para resaltar · clic para ver el detalle del grupo.</div>
              </div>
            </div>
          )}

          {seldrill && (
            <div style={{ borderTop: '0.5px solid #eef3f7', marginTop: '14px', paddingTop: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <div style={{ fontSize: '12.5px' }}><b style={{ color: grpInfo(grupoSel)[2], fontWeight: 500 }}>{grpInfo(grupoSel)[1]}</b> <span style={{ color: '#9fb0bf' }}>· detalle</span></div>
                <button onClick={() => setGrupoSel(null)} style={{ ...inp, cursor: 'pointer', padding: '4px 10px', fontSize: '11.5px', color: GRIS }}>Cerrar</button>
              </div>
              {(() => { const mx = Math.max(1, ...seldrill.map(s => s.v)); const tot = seldrill.reduce((a, s) => a + s.v, 0) || 1; const gl = grpInfo(grupoSel)[1]; const clean = n => { const t = String(n).replace(new RegExp('^' + gl + '\\s*·\\s*', 'i'), ''); return t ? t.charAt(0).toUpperCase() + t.slice(1) : t }; return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {seldrill.filter(s => s.v > 0.005).map(s => (
                    <div key={s.n}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '11.5px', marginBottom: '3px' }}>
                        <span>{clean(s.n)}</span><span><b style={{ fontWeight: 500 }}>{Math.round(s.v / tot * 100)}%</b> <span style={{ color: '#9fb0bf' }}>· {dinero(s.v)}</span></span>
                      </div>
                      <div style={{ height: '10px', borderRadius: '3px', background: grpInfo(grupoSel)[2], width: (100 * s.v / mx) + '%', minWidth: '2px' }} />
                    </div>
                  ))}
                </div>
              ) })()}
            </div>
          )}
        </div>
      </>)}
    </div>
  )
}

function Dropdown({ label, value, children }) {
  const [open, setOpen] = useState(false)
  return (
    <span style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', border: '0.5px solid ' + (open ? AZUL : BORDE), borderRadius: '9px', padding: '7px 12px', fontSize: '12.5px', background: 'white', cursor: 'pointer', fontFamily: 'inherit', color: NAVY }}>
        {label && <span style={{ color: '#9fb0bf' }}>{label}</span>} <b style={{ fontWeight: 500 }}>{value}</b> <span style={{ color: '#9fb0bf' }}>▾</span>
      </button>
      {open && (<>
        <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
        <div onClick={() => setOpen(false)} style={{ position: 'absolute', top: 'calc(100% + 5px)', left: 0, zIndex: 41, background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '10px', boxShadow: '0 8px 24px rgba(2,40,71,.12)', padding: '5px', minWidth: '150px' }}>
          {children}
        </div>
      </>)}
    </span>
  )
}
function DItem({ on, onClick, children }) {
  return <button onClick={onClick} style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: on ? '#f1f6fb' : 'none', fontFamily: 'inherit', cursor: 'pointer', borderRadius: '7px', padding: '7px 10px', fontSize: '12.5px', color: on ? AZUL : NAVY, fontWeight: on ? 500 : 400 }}
    onMouseEnter={e => { if (!on) e.currentTarget.style.background = '#f6f9fb' }} onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'none' }}>{children}</button>
}

// ===== Comparar fincas · líneas interactivas por mes =====
const FINCA_COLORS = ['#0D6CB0', '#BA7517', '#1D9E75', '#D4537E', '#7F77DD', '#378ADD', '#993C1D', '#0F6E56', '#854F0B', '#51606c']
// métricas: ha·día TOTAL/REAL + cada grupo "por ha·día" (comparable entre fincas)
const METRICAS = [['hadia_real', 'ha·día REAL'], ['hadia_total', 'ha·día TOTAL'],
  ...GRP.filter(([k]) => k !== 'BALANCEADO_LARVA').map(([k, l]) => ['g:' + k, l])]
// escala del mapa de calor: verde (barato) → rojo (caro)
const HEAT = [['#E1F5EE', '#0F6E56'], ['#C0DD97', '#27500A'], ['#FAC775', '#854F0B'], ['#F09595', '#A32D2D'], ['#E24B4A', '#ffffff']]
const heatColor = (v, min, max) => HEAT[max > min ? Math.min(4, Math.floor((v - min) / (max - min) * 5)) : 0]

function ComparaFincas({ visibles, idsSel, anio }) {
  const [metrica, setMetrica] = useState('hadia_real')
  const [data, setData] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [mesesSel, setMesesSel] = useState([])
  const [hover, setHover] = useState(null)   // índice de mes resaltado
  const wrapRef = useRef(null)
  const [cw, setCw] = useState(680)          // ancho real del gráfico (alto fijo)
  const [base, setBase] = useState('hadia')  // 'hadia' (por ha·día) | 'total' ($ del mes, como el Cuadro)

  // mide el ancho del contenedor para que el SVG tenga alto fijo (no gigante)
  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(es => { for (const e of es) setCw(e.contentRect.width) })
    ro.observe(el); setCw(el.clientWidth || 680)
    return () => ro.disconnect()
  }, [cargando])

  useEffect(() => {
    let vivo = true
    ;(async () => {
      setCargando(true)
      if (!idsSel.length) { if (vivo) { setData({ porFinca: {}, meses: [] }); setCargando(false) } return }
      const { data: cms } = await supabase.schema('produccion').from('cuadro_mes')
        .select('id, finca_id, mes, hectareas, dias, hadia_total, hadia_real').in('finca_id', idsSel).eq('anio', anio)
      const ids = (cms || []).map(c => c.id)
      // paginar: Supabase corta a 1000 filas y cuadro_valor de muchas fincas×meses son miles
      let vs = []
      if (ids.length) {
        for (let from = 0; ; from += 1000) {
          const r = await supabase.schema('produccion').from('cuadro_valor')
            .select('cuadro_mes_id, valor, rubro:rubro_id(grupo)').in('cuadro_mes_id', ids)
            .range(from, from + 999)
          const chunk = r.data || []
          vs = vs.concat(chunk)
          if (chunk.length < 1000) break
        }
      }
      if (!vivo) return
      const byId = {}; (cms || []).forEach(c => { byId[c.id] = c })
      const porFinca = {}
      ;(cms || []).forEach(c => {
        (porFinca[c.finca_id] = porFinca[c.finca_id] || {})[c.mes] = {
          ht: Number(c.hadia_total) || 0, hr: Number(c.hadia_real) || 0,
          div: (Number(c.hectareas) || 0) * (Number(c.dias) || 0), grupos: {},
        }
      })
      vs.forEach(v => {
        const c = byId[v.cuadro_mes_id]; const g = v.rubro?.grupo; if (!c || !g) return
        const node = porFinca[c.finca_id]?.[c.mes]; if (node) node.grupos[g] = (node.grupos[g] || 0) + Number(v.valor || 0)
      })
      const meses = [...new Set((cms || []).map(c => c.mes))].sort((a, b) => a - b)
      setData({ porFinca, meses }); setMesesSel(meses); setCargando(false)
    })()
    return () => { vivo = false }
  }, [JSON.stringify(idsSel), anio])

  if (cargando) return <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Cargando…</div>
  const mesesAll = data?.meses || []
  if (!idsSel.length || !mesesAll.length) return <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Elige fincas con Cuadro cargado para comparar.</div>
  const sel = (mesesSel.length ? mesesSel : mesesAll).slice().sort((a, b) => a - b)
  const toggleMes = m => setMesesSel(cur => { const b = cur.length ? cur : mesesAll; const n = b.includes(m) ? b.filter(x => x !== m) : [...b, m]; return n.length ? n : b })
  const esGrupo = metrica.startsWith('g:')
  const totalM = base === 'total'   // $ del mes (como el Cuadro) vs por ha·día
  const fmtV = v => totalM ? dinero(v) : '$' + num2(v)
  const hcell = v => totalM ? (v >= 1000 ? Math.round(v / 1000) + 'k' : String(Math.round(v))) : String(Math.round(v))  // compacto para celdas
  const valOf = (fid, m) => {
    const n = data.porFinca[fid]?.[m]; if (!n) return null
    if (metrica === 'hadia_total') return totalM ? n.ht * n.div : n.ht
    if (metrica === 'hadia_real') return totalM ? n.hr * n.div : n.hr
    const g = metrica.slice(2); const tot = n.grupos[g] || 0
    return totalM ? tot : (n.div ? tot / n.div : null)
  }
  const series = idsSel.map((fid, i) => {
    const f = visibles.find(x => x.id === fid)
    return { fid, nombre: f?.nombre || '', color: FINCA_COLORS[i % FINCA_COLORS.length], pts: sel.map(m => valOf(fid, m)) }
  }).filter(s => s.pts.some(v => v != null))
  const todos = series.flatMap(s => s.pts).filter(v => v != null)
  const ymin = todos.length ? Math.min(...todos) : 0, ymax = todos.length ? Math.max(...todos) : 1
  const pad = (ymax - ymin) * 0.15 || 1
  const lo = Math.max(0, ymin - pad), hi = ymax + pad
  const W = Math.max(360, Math.round(cw)), H = 230, L = 48, R = 14, T = 16, B = 34
  const n = sel.length
  const px = i => n <= 1 ? (L + (W - L - R) / 2) : L + i * (W - L - R) / (n - 1)
  const py = v => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => lo + t * (hi - lo))
  const onMove = e => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width * W
    let best = 0, bd = Infinity
    for (let i = 0; i < n; i++) { const d = Math.abs(px(i) - x); if (d < bd) { bd = d; best = i } }
    setHover(best)
  }
  const metLabel = (METRICAS.find(m => m[0] === metrica) || [])[1] || ''
  // ranking (promedio del periodo, más barata primero) y variación del periodo (último vs primero)
  const ranking = series.map(s => {
    const def = s.pts.filter(v => v != null)
    const avg = def.length ? def.reduce((a, b) => a + b, 0) / def.length : null
    const first = s.pts.find(v => v != null), last = [...s.pts].reverse().find(v => v != null)
    const chg = (first != null && last != null && first !== 0) ? (last - first) / Math.abs(first) : null
    return { ...s, avg, chg }
  }).filter(r => r.avg != null).sort((a, b) => a.avg - b.avg)
  const maxAvg = Math.max(1, ...ranking.map(r => r.avg))
  const cells = series.flatMap(s => s.pts).filter(v => v != null)
  const cmin = cells.length ? Math.min(...cells) : 0, cmax = cells.length ? Math.max(...cells) : 1
  const card = { border: '0.5px solid ' + BORDE, borderRadius: '12px', background: 'white', padding: '14px 16px' }
  const tit = { fontSize: '11px', color: '#9fb0bf', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: '12px' }
  return (
   <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
    <div style={card}>
      {/* métrica */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <span style={{ fontSize: '10.5px', color: '#9fb0bf', textTransform: 'uppercase', letterSpacing: '.03em' }}>Métrica</span>
        {METRICAS.map(([k, l]) => {
          const on = metrica === k
          // al elegir métrica, ajusta la base: grupos → $ del mes (miles); ha·día/real → por ha·día
          return <button key={k} onClick={() => { setMetrica(k); setBase(k.startsWith('g:') ? 'total' : 'hadia') }} style={{ padding: '4px 10px', fontSize: '11.5px', fontFamily: 'inherit', borderRadius: '8px', cursor: 'pointer', border: '0.5px solid ' + (on ? AZUL : BORDE), background: on ? '#eaf2fb' : 'white', color: on ? '#185FA5' : GRIS, fontWeight: on ? 500 : 400 }}>{l}</button>
        })}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ display: 'inline-flex', border: '0.5px solid ' + BORDE, borderRadius: '8px', overflow: 'hidden', fontSize: '11px' }}>
            {[['hadia', 'Por ha·día'], ['total', '$ del mes']].map(([k, l]) => (
              <button key={k} onClick={() => setBase(k)} style={{ padding: '3px 9px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: base === k ? 500 : 400, background: base === k ? AZUL : 'white', color: base === k ? 'white' : GRIS }}>{l}</button>
            ))}
          </span>
          <span style={{ fontSize: '10.5px', color: '#9fb0bf' }}>{anio}</span>
        </span>
      </div>
      {/* meses */}
      <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <span style={{ fontSize: '11px', color: GRIS, alignSelf: 'center', marginRight: '2px' }}>Meses:</span>
        {mesesAll.map(m => { const on = sel.includes(m); return <button key={m} onClick={() => toggleMes(m)} style={{ padding: '3px 9px', fontSize: '11px', fontFamily: 'inherit', borderRadius: '7px', cursor: 'pointer', border: '0.5px solid ' + (on ? AZUL : BORDE), background: on ? '#eaf2fb' : 'white', color: on ? '#185FA5' : GRIS, fontWeight: on ? 500 : 400 }}>{MESES[m - 1].slice(0, 3)}</button> })}
      </div>
      {series.length === 0 ? (
        <div style={{ fontSize: '12.5px', color: GRIS, padding: '20px 0', textAlign: 'center' }}>Las fincas seleccionadas no tienen datos de “{metLabel}” en estos meses.</div>
      ) : (
        <div ref={wrapRef} style={{ position: 'relative' }}>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={L} y1={py(t)} x2={W - R} y2={py(t)} stroke="#f1f5f9" />
                <text x={L - 6} y={py(t) + 3} textAnchor="end" style={{ fontSize: '10px', fill: '#9fb0bf' }}>{fmtV(t)}</text>
              </g>
            ))}
            {sel.map((m, i) => <text key={m} x={px(i)} y={H - 12} textAnchor="middle" style={{ fontSize: '11px', fill: '#7d8fa0' }}>{MESES[m - 1].slice(0, 3)}</text>)}
            {hover != null && <line x1={px(hover)} y1={T} x2={px(hover)} y2={H - B} stroke="#cdd9e5" strokeDasharray="3 3" />}
            {series.map(s => {
              const pts = s.pts.map((v, i) => v == null ? null : `${px(i)},${py(v)}`).filter(Boolean).join(' ')
              return <polyline key={s.fid} points={pts} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinejoin="round" />
            })}
            {series.map(s => s.pts.map((v, i) => v == null ? null : (
              <circle key={s.fid + '-' + i} cx={px(i)} cy={py(v)} r={hover === i ? 5 : 3} fill={s.color} />
            )))}
          </svg>
          {hover != null && (() => {
            const left = px(hover) / W * 100
            const flip = left > 60
            return (
              <div style={{ position: 'absolute', top: '6px', left: flip ? 'auto' : `calc(${left}% + 10px)`, right: flip ? `calc(${100 - left}% + 10px)` : 'auto', background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '9px', boxShadow: '0 6px 18px rgba(2,40,71,.12)', padding: '8px 10px', fontSize: '11.5px', pointerEvents: 'none', minWidth: '130px' }}>
                <div style={{ fontWeight: 500, marginBottom: '5px' }}>{MESES[sel[hover] - 1]} {anio}</div>
                {[...series].map(s => ({ s, v: s.pts[hover] })).sort((a, b) => (b.v ?? -1) - (a.v ?? -1)).map(({ s, v }) => (
                  <div key={s.fid} style={{ display: 'flex', alignItems: 'center', gap: '7px', padding: '1.5px 0' }}>
                    <span style={{ width: '9px', height: '9px', borderRadius: '2px', background: s.color, flexShrink: 0 }} />
                    <span style={{ flex: 1, color: '#51606c' }}>{s.nombre}</span>
                    <b style={{ fontWeight: 500 }}>{v == null ? '—' : fmtV(v)}</b>
                  </div>
                ))}
              </div>
            )
          })()}
        </div>
      )}
      {/* leyenda */}
      <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '12px' }}>
        {series.map(s => (
          <span key={s.fid} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11.5px', color: '#51606c' }}>
            <span style={{ width: '14px', height: '3px', borderRadius: '2px', background: s.color }} /> {s.nombre}
          </span>
        ))}
      </div>
      <div style={{ fontSize: '10.5px', color: '#9fb0bf', marginTop: '10px' }}>Pasa el cursor para ver el valor de cada finca. {totalM ? '“$ del mes” son los montos tal cual el Cuadro.' : 'Por ha·día (÷ hectáreas ÷ días) para comparar fincas de distinto tamaño; usa “$ del mes” para cuadrar con el Cuadro.'}</div>
    </div>

    {/* RANKING */}
    {ranking.length > 0 && (
      <div style={card}>
        <div style={tit}>Ranking · {metLabel} · promedio del periodo</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '9px', fontSize: '12.5px' }}>
          {ranking.map((r, i) => {
            const c = heatColor(r.avg, cmin, cmax)
            return (
              <div key={r.fid} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ width: '16px', color: '#9fb0bf', textAlign: 'right', fontSize: '11px' }}>{i + 1}</span>
                <span style={{ width: '96px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nombre}</span>
                <span style={{ flex: 1, background: '#eef3f7', borderRadius: '5px', height: '15px', position: 'relative', minWidth: '40px' }}>
                  <span style={{ position: 'absolute', left: 0, top: 0, height: '15px', borderRadius: '5px', background: c[0], width: Math.max(3, 100 * r.avg / maxAvg) + '%' }} />
                </span>
                <span style={{ width: '74px', textAlign: 'right', fontWeight: 500 }}>{fmtV(r.avg)}</span>
                <span style={{ width: '48px', textAlign: 'right', fontSize: '11px', color: r.chg == null ? '#b8c4ce' : r.chg > 0.005 ? ROJO : r.chg < -0.005 ? VERDE : '#b8c4ce' }}>
                  {r.chg == null ? '—' : (Math.abs(r.chg) < 0.005 ? '0%' : (r.chg > 0 ? '▲' : '▼') + Math.abs(Math.round(r.chg * 100)) + '%')}
                </span>
              </div>
            )
          })}
        </div>
        <div style={{ fontSize: '10.5px', color: '#9fb0bf', marginTop: '10px' }}>De más barata (verde) a más cara (roja). La flecha = cambio del periodo (último mes vs primero).</div>
      </div>
    )}

    {/* MAPA DE CALOR */}
    {series.length > 0 && sel.length > 0 && (
      <div style={card}>
        <div style={tit}>Mapa de calor · {metLabel} · finca × mes</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: '11.5px', width: '100%', tableLayout: 'fixed', minWidth: (108 + sel.length * 42) + 'px' }}>
            <thead>
              <tr style={{ color: '#9fb0bf' }}>
                <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500, position: 'sticky', left: 0, background: 'white', width: '108px' }}>Finca</th>
                {sel.map(m => <th key={m} style={{ padding: '4px 6px', fontWeight: 500 }}>{MESES[m - 1].slice(0, 3)}</th>)}
              </tr>
            </thead>
            <tbody>
              {series.map(s => (
                <tr key={s.fid}>
                  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: 'white' }}>{s.nombre}</td>
                  {s.pts.map((v, i) => {
                    if (v == null) return <td key={i} style={{ padding: '7px 6px', textAlign: 'center', color: '#cdd9e5', border: '2px solid #fff' }}>—</td>
                    const c = heatColor(v, cmin, cmax)
                    return <td key={i} title={fmtV(v)} style={{ padding: '7px 6px', textAlign: 'center', background: c[0], color: c[1], border: '2px solid #fff', borderRadius: '4px', fontWeight: 500, whiteSpace: 'nowrap' }}>{hcell(v)}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px', fontSize: '10.5px', color: '#7d8fa0' }}>
          <span>Más barato</span>
          {HEAT.map((c, i) => <span key={i} style={{ width: '18px', height: '12px', background: c[0], borderRadius: '2px' }} />)}
          <span>Más caro</span>
        </div>
      </div>
    )}
   </div>
  )
}
