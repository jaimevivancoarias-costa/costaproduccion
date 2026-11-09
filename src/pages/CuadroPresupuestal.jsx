import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { dinero } from '../lib/fechas'

// Cuadro presupuestal · módulo Producción (F1 + F2)
// Hoja mensual por finca: la contadora/jefe carga todos los costos del mes y la
// app calcula el costo por hectárea-día TOTAL y REAL. No se cierra: va
// calculando en vivo. Los rubros marcados "App" (balanceado, insumos por
// categoría, diésel) se PRECARGAN con el consumo real del mes y son editables.
const NAVY = '#022847', AZUL = '#0D6CB0', BORDE = '#dce6ef', GRIS = '#7d8fa0', VERDE = '#0F6E56'
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

  useEffect(() => { supabase.auth.getUser().then(({ data }) => setUserId(data?.user?.id || null)) }, [])

  const cargarRubros = useCallback(async () => {
    const [{ data: rb }, { data: ins }] = await Promise.all([
      supabase.schema('produccion').from('cuadro_rubro')
        .select('id, grupo, nombre, orden, origen, incluye_real').eq('activo', true).order('grupo').order('orden'),
      supabase.schema('produccion').from('insumo').select('id, categoria_presupuesto').eq('activo', true),
    ])
    setRubros(rb || [])
    const cm = {}; (ins || []).forEach(i => { cm[i.id] = i.categoria_presupuesto }); setCatIns(cm)
  }, [])
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

  const val = id => parseNum(txt[id])
  const totalesGrupo = useMemo(() => {
    const t = {}; for (const [g] of GRUPOS) t[g] = 0
    for (const r of rubros) t[r.grupo] = (t[r.grupo] || 0) + val(r.id)
    return t
  }, [rubros, txt])
  const { bruto, totOp, real, haDiaTotal, haDiaReal } = useMemo(() => {
    // bruto = todo. El ha·día TOTAL excluye balanceado+larva (ya se cuentan aparte
    // en Rentabilidad); el REAL excluye además activos y mejoras (incluye_real).
    let b = 0, to = 0, rl = 0
    for (const r of rubros) {
      const v = val(r.id); b += v
      if (r.grupo !== 'BALANCEADO_LARVA') to += v
      if (r.incluye_real) rl += v
    }
    const h = parseNum(ha), d = Number(dias) || 0
    const div = h > 0 && d > 0 ? h * d : 0
    const dedTotal = parseNum(dedSueldos) + parseNum(dedBenef)
    const rlNeto = Math.max(0, rl - dedTotal)        // REAL = operativo − deducción administrativa
    return { bruto: b, totOp: to, real: rlNeto, haDiaTotal: div ? to / div : 0, haDiaReal: div ? rlNeto / div : 0 }
  }, [rubros, txt, ha, dias, dedSueldos, dedBenef])

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
    const filas = rubros.map(r => {
      const esApp = !!r.origen && !editado.has(r.id)
      return { cuadro_mes_id: cm.id, rubro_id: r.id, valor: val(r.id), fuente: esApp ? 'app' : 'manual', editado: !!r.origen && editado.has(r.id) }
    })
    const { error: e2 } = await supabase.schema('produccion').from('cuadro_valor').upsert(filas, { onConflict: 'cuadro_mes_id,rubro_id' })
    setGuardando(false)
    setAviso(e2 ? { tipo: 'error', texto: 'No se pudieron guardar los valores. ' + e2.message } : { tipo: 'ok', texto: `Cuadro de ${MESES[mes - 1]} ${anio} guardado.` })
  }

  async function agregarRubro(grupo) {
    const nombre = (nuevo[grupo] || '').trim(); if (!nombre) return
    const maxOrden = Math.max(0, ...rubros.filter(r => r.grupo === grupo).map(r => r.orden))
    const incluye_real = !NO_REAL.has(grupo)
    const { error } = await supabase.schema('produccion').from('cuadro_rubro')
      .insert({ grupo, nombre, orden: maxOrden + 10, incluye_real })
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
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '9px', padding: '4px 8px', fontSize: '12.5px' }}>
            <button onClick={() => pasoMes(-1)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: GRIS, fontSize: '16px', fontFamily: 'inherit' }}>‹</button>
            <b style={{ fontWeight: 500, minWidth: '128px', textAlign: 'center' }}>{MESES[mes - 1]} {anio}</b>
            <button onClick={() => pasoMes(1)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: GRIS, fontSize: '16px', fontFamily: 'inherit' }}>›</button>
          </span>
        </div>
      </div>

      {aviso && <div style={{ borderRadius: '10px', padding: '11px 14px', fontSize: '13px', marginBottom: '12px', background: aviso.tipo === 'ok' ? '#E1F5EE' : '#FBEAEA', color: aviso.tipo === 'ok' ? VERDE : '#8A2F2E' }}>{aviso.texto}</div>}

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
            const items = rubros.filter(r => r.grupo === g)
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
const PERIODOS = [[1, 'Último mes'], [2, '2 meses'], [3, '3 meses'], [4, '4 meses']]
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
        const { data: vs } = await supabase.schema('produccion').from('cuadro_valor')
          .select('valor, rubro:rubro_id(grupo, nombre)').in('cuadro_mes_id', mesIds)
        if (!vivo) return
        ;(vs || []).forEach(v => {
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

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '14px', fontSize: '12px' }}>
        {zonas.length > 0 && <span style={{ display: 'inline-flex', border: '0.5px solid ' + BORDE, borderRadius: '8px', overflow: 'hidden' }}>
          {[['', 'Todas'], ...zonas.map(z => [z, zlabel(z)])].map(([v, l]) => <button key={v} onClick={() => setZona(v)} style={{ padding: '5px 11px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', background: zona === v ? AZUL : 'white', color: zona === v ? 'white' : GRIS, fontWeight: zona === v ? 500 : 400 }}>{l}</button>)}
        </span>}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', border: '0.5px solid ' + BORDE, borderRadius: '8px', padding: '2px 5px', background: 'white' }}>
          <button onClick={() => setAncla(a => { let y = a.anio, m = a.mes - 1; if (m < 1) { m = 12; y-- } return { anio: y, mes: m } })} style={{ border: 'none', background: 'none', cursor: 'pointer', color: GRIS, fontSize: '15px', fontFamily: 'inherit' }}>‹</button>
          <b style={{ fontWeight: 500, minWidth: '96px', textAlign: 'center', fontSize: '11.5px' }}>{MESES[ancla.mes - 1]} {ancla.anio}</b>
          <button onClick={() => setAncla(a => { let y = a.anio, m = a.mes + 1; if (m > 12) { m = 1; y++ } return { anio: y, mes: m } })} style={{ border: 'none', background: 'none', cursor: 'pointer', color: GRIS, fontSize: '15px', fontFamily: 'inherit' }}>›</button>
        </span>
        <span style={{ display: 'inline-flex', border: '0.5px solid ' + BORDE, borderRadius: '8px', overflow: 'hidden' }}>
          {PERIODOS.map(([v, l]) => <button key={v} onClick={() => setPeriodo(v)} style={{ padding: '5px 11px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', background: periodo === v ? AZUL : 'white', color: periodo === v ? 'white' : GRIS, fontWeight: periodo === v ? 500 : 400 }}>{l}</button>)}
        </span>
        <span style={{ position: 'relative' }}>
          <button onClick={() => setFincasOpen(o => !o)} style={{ padding: '5px 11px', border: '0.5px solid ' + (fincasOpen ? AZUL : BORDE), borderRadius: '8px', background: 'white', cursor: 'pointer', fontFamily: 'inherit', color: fincasOpen ? AZUL : NAVY, fontWeight: 500 }}>Fincas · {sel.size}/{visibles.length} ▾</button>
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

      {cargando ? (
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
                <div style={{ fontSize: '12.5px' }}><b style={{ color: grpInfo(grupoSel)[2], fontWeight: 500 }}>{grpInfo(grupoSel)[1]}</b> <span style={{ color: '#9fb0bf' }}>· en qué se va</span></div>
                <button onClick={() => setGrupoSel(null)} style={{ ...inp, cursor: 'pointer', padding: '4px 10px', fontSize: '11.5px', color: GRIS }}>Cerrar</button>
              </div>
              {(() => { const mx = Math.max(1, ...seldrill.map(s => s.v)); return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {seldrill.filter(s => s.v > 0.005).map(s => (
                    <div key={s.n} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11.5px' }}>
                      <span style={{ width: '150px', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.n}</span>
                      <span style={{ height: '13px', borderRadius: '3px', background: grpInfo(grupoSel)[2], width: (100 * s.v / mx) + '%', minWidth: '2px' }} />
                      <span style={{ fontWeight: 500 }}>{dinero(s.v)}</span>
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
