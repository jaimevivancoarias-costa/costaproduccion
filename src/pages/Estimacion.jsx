import { useState, useEffect, useMemo, useCallback, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, lunesDe, sumarDias, miles, dinero } from '../lib/fechas'
import { estimar, cfgFinca, PARAM } from '../lib/estimacion'

const NAVY = '#022847', AZUL = '#0D6CB0', BORDE = '#dce6ef', GRIS = '#7d8fa0'
const VERDE = '#0F6E56', AMBAR = '#854F0B', ROJO = '#8A2F2E'
const num1 = n => Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const num2 = n => Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const num3 = n => Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
const pct0 = n => Math.round(Number(n || 0) * 100) + '%'
const diasEntre = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000)
const domingoDe = iso => sumarDias(lunesDe(iso), 6)

// Nivel de confianza según la diferencia entre biomasa por consumo y densidad.
function nivelBiomasa(difPct) {
  if (difPct <= 0.15) return { nivel: 'consistente', confianza: 'alta', bloquea: false, color: VERDE }
  if (difPct <= 0.25) return { nivel: 'precaución', confianza: 'media', bloquea: false, color: AMBAR }
  if (difPct <= 0.50) return { nivel: 'validación requerida', confianza: 'baja', bloquea: true, color: AMBAR }
  return { nivel: 'conflicto crítico', confianza: 'baja', bloquea: true, color: ROJO }
}

// Ventana de consumo de 14 días. Separa últimos 7 y 7 anteriores, EXCLUYE los
// ayunos del promedio (no son 0 de biomasa) y cuenta los días faltantes (sin
// registro). Devuelve el promedio plano actual (simple) y el ponderado nuevo.
function ventana14(rows, hasta) {
  const desde = sumarDias(hasta, -13)
  // Agrupa por día: suma libras de registros múltiples del mismo ciclo+fecha,
  // y marca conflicto (alimentó + ayuno el mismo día) y posible duplicado (dos
  // cifras idénticas). No deduplica: cada fila es un registro.
  const porDia = {}
  for (const r of (rows || [])) {
    if (r.fecha < desde || r.fecha > hasta) continue
    const d = (porDia[r.fecha] ||= { lb: 0, fed: false, ayuno: false, n: 0, vals: [] })
    d.n++
    if (r.ayuno) d.ayuno = true
    else { d.lb += r.lb; d.fed = true; d.vals.push(r.lb) }
  }
  let sum7 = 0, fed7 = 0, sumP = 0, fedP = 0, alim = 0, ayuno = 0, falt = 0
  let doc7 = 0, docP = 0, conflicto = 0, duplicado = 0, multi = 0
  for (let i = 0; i < 14; i++) {
    const d = porDia[sumarDias(hasta, -i)]
    const rec = i < 7
    if (!d) { falt++; continue }             // sin fila = faltante
    if (d.n > 1) multi++
    if (d.fed && d.ayuno) conflicto++
    if (d.vals.length > 1 && new Set(d.vals).size < d.vals.length) duplicado++
    if (d.fed) { alim++; if (rec) { sum7 += d.lb; fed7++; doc7++ } else { sumP += d.lb; fedP++; docP++ } }
    else if (d.ayuno) { ayuno++; if (rec) doc7++; else docP++ }
  }
  const d7 = fed7 > 0 ? sum7 / fed7 : null
  const dPrev = fedP > 0 ? sumP / fedP : null
  const tend = (d7 != null && dPrev != null && dPrev > 0) ? d7 / dPrev - 1 : null
  const simple = (sum7 + sumP) / 14   // método actual: faltantes y ayunos cuentan como 0
  // Ponderado = suma reciente doble peso sobre suma anterior, dividido por los
  // días ALIMENTADOS ponderados (NO el atajo /3, que falla si las semanas tienen
  // distinto número de días válidos).
  const denom = 2 * fed7 + fedP
  const ponder = denom > 0 ? (2 * sum7 + sumP) / denom : 0
  const documentados = doc7 + docP
  // Dos validaciones separadas: cobertura (días documentados = alim + ayuno) y
  // muestra biológica (días alimentados, el ayuno no es muestra).
  const coberturaOk = doc7 >= 6 && documentados >= 12
  const muestraOk = fed7 >= 4 && alim >= 8
  const valido = coberturaOk && muestraOk
  return { d7, dPrev, tend, simple, ponder, alim, ayuno, falt, documentados, doc7,
    fed7, conflicto, duplicado, multi, coberturaOk, muestraOk, valido }
}
// Estado de confiabilidad a partir de la ventana. Separa la ESTIMACIÓN (si se
// puede calcular biomasa) del PLAN (si esa dosis se puede aplicar): los ayunos
// no bloquean el cálculo, pero sí condicionan aplicar la dosis.
//   0-2 ayunos: aplicable si lo demás pasa · 3-4: confirmar motivo antes de aplicar
//   5+: solo simulación, revisión obligatoria · <4/7 alimentados o 0/7: no estima.
function confiabilidadDe(v) {
  if (!v.coberturaOk) return { txt: `Faltan registros · ${v.documentados}/14 documentados`, color: ROJO, plan: 'bloqueado' }
  if (!v.muestraOk) return { txt: `Pocos días alimentados · ${v.alim}/14 (${v.fed7}/7)`, color: ROJO, plan: 'bloqueado' }
  const avisos = []
  let plan = 'aplicable'
  if (v.ayuno >= 5) { avisos.push(`simulación · revisión obligatoria (${v.ayuno} ayunos)`); plan = 'simulacion' }
  else if (v.ayuno >= 3) { avisos.push(`confirmar motivo de ayunos (${v.ayuno})`); plan = 'confirmar' }
  if (v.tend != null && (v.tend > 0.20 || v.tend < -0.15)) avisos.push(`revisar tendencia ${(v.tend >= 0 ? '+' : '') + Math.round(v.tend * 100)}%`)
  if (v.conflicto) avisos.push('conflicto alimentó+ayuno')
  if (v.duplicado) avisos.push('posible duplicado')
  if (!avisos.length) return { txt: 'Consumo confiable', color: VERDE, plan }
  return { txt: avisos.map(cap).join(' · '), color: plan === 'simulacion' || v.conflicto ? ROJO : AMBAR, plan }
}
const difBio = e => { const mx = Math.max(e.biomasaConsumo, e.biomasaDensidad), mn = Math.min(e.biomasaConsumo, e.biomasaDensidad); return mx > 0 ? (mx - mn) / mx : 0 }

// Vigencia de una validación manual de biomasa. Vence al ocurrir lo PRIMERO de:
// un muestreo nuevo posterior a fecha_ref, 7 días desde fecha_ref, o que la biomasa
// ponderada nueva difiera >10% de la validada. (El cambio de ciclo se maneja solo:
// otra validación tiene otro ciclo_id.)
function vigenciaDe(vald, fila, biomasaPonder, hasta) {
  const ref = vald.fecha_ref || (vald.validada_en ? vald.validada_en.slice(0, 10) : hasta)
  const dias = diasEntre(ref, hasta)
  const difPond = vald.valor_lb > 0 ? Math.abs(biomasaPonder - vald.valor_lb) / vald.valor_lb : 0
  const motivos = []
  if (fila.ultMuestreo && fila.ultMuestreo > ref) motivos.push('hay un muestreo nuevo')
  if (dias >= 7) motivos.push(`pasaron ${dias} días`)
  if (difPond > 0.10) motivos.push(`el consumo cambió ${Math.round(difPond * 100)}%`)
  const vigente = motivos.length === 0
  // Próxima a vencer: a un día de los 7, o diferencia de consumo entre 7% y 10%.
  const porVencer = vigente && (dias >= 6 || difPond > 0.07)
  return { vigente, porVencer, motivos, dias, difPond }
}

// Estado del plan. Precedencia estricta: bloqueado → simulación → confirmar → aplicable.
//   sin cobertura/muestra o biomasa en conflicto (sin validar) → bloqueado
//   5+ ayunos → simulación · 3-4 ayunos / tendencia anormal / validación por vencer → confirmar
function planEstadoDe({ est, v, bm, bloqueado, vig }) {
  if (!est || !v) return { k: 'bloqueado', txt: 'Sin datos', detalle: '', color: ROJO }
  if (bloqueado) {
    const motivo = !v.valido ? (v.coberturaOk ? `pocos días alimentados (${v.alim}/14)` : `faltan registros (${v.documentados}/14)`) : 'biomasa en conflicto'
    return { k: 'bloqueado', txt: 'Bloqueado · valida la biomasa', detalle: cap(motivo), color: ROJO }
  }
  if (v.ayuno >= 5) return { k: 'simulacion', txt: 'Simulación · revisión obligatoria', detalle: `${v.ayuno} ayunos en la ventana`, color: ROJO }
  const motivos = []
  if (v.ayuno >= 3) motivos.push(`${v.ayuno} ayunos`)
  if (v.tend != null && (v.tend > 0.20 || v.tend < -0.15)) motivos.push(`tendencia ${(v.tend >= 0 ? '+' : '') + Math.round(v.tend * 100)}%`)
  if (vig && vig.porVencer) motivos.push('validación por vencer')
  if (motivos.length) return { k: 'confirmar', txt: 'Confirmar antes de aplicar', detalle: motivos.map(cap).join(' · '), color: AMBAR }
  return { k: 'aplicable', txt: 'Aplicable', detalle: '', color: VERDE }
}

// Estimación por piscina. Toma gramaje (muestreo), consumo de balanceado y los
// datos del ciclo, corre el motor y aplica el control de calidad de biomasa.
export default function Estimacion({ finca, esJefe, nombre }) {
  const [hasta, setHasta] = useState(() => { const d = domingoDe(hoyISO()); return d > hoyISO() ? hoyISO() : d })
  const cfg = useMemo(() => cfgFinca(finca.nombre), [finca.nombre])
  const [meta, setMeta] = useState(() => { try { return Number(localStorage.getItem('metaEst|' + finca.id)) || cfg.meta } catch { return cfg.meta } })
  const [ciclos, setCiclos] = useState([])
  const [sel, setSel] = useState('')
  const [valida, setValida] = useState({})     // cicloId -> { fuente, valor_lb }
  const [aplicado, setAplicado] = useState({}) // cicloId -> registro de escenario_aplicado (activo, de esta semana)
  const [fincaRac, setFincaRac] = useState(null) // raciones/día configuradas en la finca (null = sin confirmar)
  const [patFinca, setPatFinca] = useState({}) // dia(1-7) -> alimenta (patrón de la finca)
  const [patPisc, setPatPisc] = useState({})   // piscinaId -> { dia -> alimenta } (override)
  const [planSemana, setPlanSemana] = useState({}) // cicloId -> { confirmada, dias:{fecha:alimenta}, ... }
  const [cal, setCal] = useState(null)         // overrides de días futuros: { fecha -> alimenta } (null = propuesta)
  const [editPat, setEditPat] = useState(false) // editor del patrón de finca
  const [patTmp, setPatTmp] = useState({})      // patrón en edición { dia -> alimenta }
  const [masivo, setMasivo] = useState(false)   // panel de preparación masiva
  const [masSel, setMasSel] = useState(null)    // Set de cicloId seleccionados en el panel masivo
  const [celda, setCelda] = useState(null)     // vista previa: { fila, inten } (null = usa la recomendada/aplicada)
  const [motivoTxt, setMotivoTxt] = useState('')
  const [motivoCod, setMotivoCod] = useState('')
  const [confirmaCambio, setConfirmaCambio] = useState(false)
  const [pidiendoMotivo, setPidiendoMotivo] = useState(false)
  const [cargando, setCargando] = useState(true)
  const [userId, setUserId] = useState(null)
  const [aviso, setAviso] = useState(null)
  // Selector de biomasa (edición)
  const [fuenteSel, setFuenteSel] = useState('consumo')
  const [aprobTxt, setAprobTxt] = useState('')
  // Tolvas
  const [editTolvas, setEditTolvas] = useState(false)
  const [tolvasTxt, setTolvasTxt] = useState('')
  const [editRac, setEditRac] = useState(false)
  const [racTxt, setRacTxt] = useState('')
  // Modo diagnóstico de la ventana de consumo (solo lectura)
  const [diag, setDiag] = useState(false)

  useEffect(() => { try { localStorage.setItem('metaEst|' + finca.id, String(meta)) } catch (e) { /* sin storage */ } }, [meta, finca.id])
  useEffect(() => { supabase.auth.getUser().then(({ data }) => setUserId(data?.user?.id || null)) }, [])

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    const { data: cic } = await supabase.schema('produccion').from('ciclo')
      .select('id, fecha_siembra, fecha_ocupacion, fecha_cierre, cantidad_larva, gramaje_precria, piscina:piscina_origen_id (id, nombre, hectareas, tolvas, raciones)')
      .eq('finca_id', finca.id).is('fecha_cierre', null).lte('fecha_siembra', hasta)
    const lista = (cic || []).filter(c => c.piscina)
    const ids = lista.map(c => c.id)
    const piscIds = lista.map(c => c.piscina.id)
    if (!ids.length) { setCiclos([]); setSel(''); setCargando(false); return }
    const [{ data: mu }, { data: al }, { data: bv }, { data: ap }, { data: fr }, { data: pf }, { data: pp }, { data: sp }] = await Promise.all([
      supabase.schema('produccion').from('muestreo').select('ciclo_id, fecha, peso_gramos').in('ciclo_id', ids).lte('fecha', hasta).order('fecha'),
      supabase.schema('produccion').from('alimentacion').select('ciclo_id, fecha, libras, sin_alimentacion').in('ciclo_id', ids).lte('fecha', hasta),
      supabase.schema('produccion').from('biomasa_validada').select('ciclo_id, fuente, valor_lb, fecha_ref, validada_por, validada_en').in('ciclo_id', ids).lte('fecha_ref', hasta).order('validada_en', { ascending: false }),
      supabase.schema('produccion').from('escenario_aplicado').select('*').in('ciclo_id', ids).eq('semana_ref', hasta).eq('estado', 'activo'),
      supabase.schema('produccion').from('finca').select('raciones').eq('id', finca.id).maybeSingle(),
      supabase.schema('produccion').from('finca_patron_dia').select('dia, alimenta').eq('finca_id', finca.id),
      supabase.schema('produccion').from('piscina_patron_dia').select('piscina_id, dia, alimenta').in('piscina_id', piscIds),
      supabase.schema('produccion').from('semana_plan').select('ciclo_id, confirmada, confirmada_en, confirmada_por, dias:semana_plan_dia(fecha, alimenta)').in('ciclo_id', ids).eq('semana_ref', hasta),
    ])
    const muDe = {}; (mu || []).forEach(m => { (muDe[m.ciclo_id] ||= []).push({ fecha: m.fecha, peso: Number(m.peso_gramos) }) })
    const alDe = {}; (al || []).forEach(r => { if (!r.sin_alimentacion) (alDe[r.ciclo_id] ||= []).push({ fecha: r.fecha, lb: Number(r.libras) || 0 }) })
    const alRawDe = {}; (al || []).forEach(r => { (alRawDe[r.ciclo_id] ||= []).push({ fecha: r.fecha, lb: Number(r.libras) || 0, ayuno: !!r.sin_alimentacion }) })
    const bvDe = {}; (bv || []).forEach(r => { if (!bvDe[r.ciclo_id]) bvDe[r.ciclo_id] = { fuente: r.fuente, valor_lb: Number(r.valor_lb), fecha_ref: r.fecha_ref, validada_en: r.validada_en } })
    const apDe = {}; (ap || []).forEach(r => { apDe[r.ciclo_id] = r })
    // Nombre de quién aplicó cada escenario (vive en public.usuarios).
    const quienes = [...new Set((ap || []).map(r => r.aplicado_por).filter(Boolean))]
    if (quienes.length) {
      const { data: us } = await supabase.from('usuarios').select('id, nombre').in('id', quienes)
      const nomDe = {}; (us || []).forEach(u => { nomDe[u.id] = u.nombre })
      Object.values(apDe).forEach(r => { r.aplicado_nombre = nomDe[r.aplicado_por] || null })
    }
    // Patrones de alimentación (finca y override por piscina) y plan semanal confirmado.
    const patF = {}; (pf || []).forEach(r => { patF[r.dia] = r.alimenta })
    const patP = {}; (pp || []).forEach(r => { (patP[r.piscina_id] ||= {})[r.dia] = r.alimenta })
    const planDe = {}; (sp || []).forEach(r => {
      const dias = {}; (r.dias || []).forEach(d => { dias[d.fecha] = d.alimenta })
      planDe[r.ciclo_id] = { confirmada: r.confirmada, confirmada_en: r.confirmada_en, confirmada_por: r.confirmada_por, dias }
    })
    setValida(bvDe); setAplicado(apDe); setFincaRac(fr && fr.raciones != null ? Number(fr.raciones) : null)
    setPatFinca(patF); setPatPisc(patP); setPlanSemana(planDe)
    const ini14 = sumarDias(hasta, -14)
    const filas = lista.map(c => {
      const ms = muDe[c.id] || []
      const gramaje = ms.length ? ms[ms.length - 1].peso : 0
      const prev = [...ms].reverse().find(m => m.fecha <= ini14)
      const siembra = c.fecha_ocupacion || c.fecha_siembra
      const als = alDe[c.id] || []
      const v = ventana14(alRawDe[c.id] || [], hasta)
      return {
        cicloId: c.id, piscinaId: c.piscina.id, nombre: c.piscina.nombre,
        area: Number(c.piscina.hectareas) || 0, tolvas: c.piscina.tolvas != null ? Number(c.piscina.tolvas) : null,
        raciones: c.piscina.raciones != null ? Number(c.piscina.raciones) : null,
        larva: Number(c.cantidad_larva) || 0, pl: Number(c.gramaje_precria) || 0.5, siembra,
        gramaje, ultMuestreo: ms.length ? ms[ms.length - 1].fecha : null,
        gIni: prev ? prev.peso : 0, diasIni: prev ? diasEntre(siembra, prev.fecha) : 0,
        consumoAcum: als.reduce((t, r) => t + r.lb, 0),
        // Ventana ponderada (lb/semana): fuente de consumo del motor. Si no cumple
        // cobertura+muestra, el plan queda bloqueado (obliga validar a mano).
        consumoVentana: v.ponder * 7,
        ventana: v,
        alsRaw: alRawDe[c.id] || [],
        dias: diasEntre(siembra, hasta),
      }
    }).filter(f => f.gramaje > 0).sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es', { numeric: true }))
    setCiclos(filas)
    setSel(s => (s && filas.some(f => f.cicloId === s)) ? s : (filas[0]?.cicloId || ''))
    setCargando(false)
  }, [finca.id, hasta])

  useEffect(() => { cargar() }, [cargar])
  // Al cambiar de piscina o semana, la vista previa vuelve a la recomendada/aplicada.
  useEffect(() => { setCelda(null); setPidiendoMotivo(false); setMotivoTxt(''); setMotivoCod(''); setConfirmaCambio(false); setCal(null) }, [sel, hasta])

  const fila = ciclos.find(c => c.cicloId === sel)
  const est = useMemo(() => fila ? estimar({
    area: fila.area, dias: fila.dias, pl: fila.pl, gramajeHoy: fila.gramaje,
    consumoAcum: fila.consumoAcum, larva: fila.larva, gInicio: fila.gIni,
    diasInicio: fila.diasIni, consumoVentana: fila.consumoVentana, meta, finca: cfg,
  }) : null, [fila, meta, cfg])

  // Diferencia entre métodos y nivel de confianza.
  const bm = useMemo(() => {
    if (!est) return null
    const bc = est.biomasaConsumo, bd = est.biomasaDensidad
    const mayor = Math.max(bc, bd), menor = Math.min(bc, bd)
    const difPct = mayor > 0 ? (mayor - menor) / mayor : 0
    return { bc, bd, difPct, menorQue: bc < bd, relacion: menor > 0 ? mayor / menor : 0, ...nivelBiomasa(difPct) }
  }, [est])

  // Diagnóstico de la ventana de consumo: compara el promedio plano actual con
  // el ponderado nuevo para cada piscina, y el efecto en la biomasa. Solo lectura.
  const diagnostico = useMemo(() => {
    if (!diag) return []
    return ciclos.map(f => {
      const v = ventana14(f.alsRaw, hasta)
      const base = {
        area: f.area, dias: f.dias, pl: f.pl, gramajeHoy: f.gramaje, consumoAcum: f.consumoAcum,
        larva: f.larva, gInicio: f.gIni, diasInicio: f.diasIni, meta, finca: cfg,
      }
      const eA = estimar({ ...base, consumoVentana: v.simple * 7 })
      const eB = estimar({ ...base, consumoVentana: v.ponder * 7 })
      const difA = difBio(eA), difB = difBio(eB)
      const nb = nivelBiomasa(difB)
      const conf = confiabilidadDe(v)
      return { f, v, bA: eA.biomasaConsumo, bB: eB.biomasaConsumo, difA, difB, nb, conf }
    })
  }, [diag, ciclos, hasta, meta, cfg])

  // Biomasa seleccionada: la validada (si existe y sigue VIGENTE), si no la de consumo.
  const vald = valida[sel]
  const v = fila ? fila.ventana : null
  const vig = (vald && est && fila) ? vigenciaDe(vald, fila, est.biomasaConsumo, hasta) : null
  const valdOk = !!(vald && (!vig || vig.vigente))     // validación vigente
  const biomasaSel = valdOk ? vald.valor_lb : (est ? est.biomasaConsumo : 0)
  const fuenteUsada = valdOk ? 'validada manualmente' : 'por consumo'
  // Etiqueta de procedencia: validada (usuario + fecha) o el nivel de confianza por consumo.
  const notaBio = valdOk
    ? `Validada manualmente · ${vald.fecha_ref ? corta(vald.fecha_ref) : (vald.validada_en ? corta(vald.validada_en) : '—')}`
    : `Por consumo · confianza ${bm ? bm.confianza : 'alta'}`
  const confianza = valdOk ? 'alta' : (bm ? bm.confianza : 'alta')
  // Consumo insuficiente: la ventana no cumple cobertura/muestra → no hay biomasa
  // oficial, obliga validar a mano.
  const consumoInsuf = v ? !v.valido : false
  const bloqueado = !!(est && ((bm && bm.bloquea) || consumoInsuf) && !valdOk)
  // Aunque esté validada, si consumo y densidad siguen difiriendo >25% hay que avisar
  // (una validación no vuelve "consistente" una diferencia grande).
  const difGrande = bm && bm.difPct > 0.25

  async function validarBiomasa() {
    let valor = fuenteSel === 'consumo' ? est.biomasaConsumo : fuenteSel === 'densidad' ? est.biomasaDensidad : Number(String(aprobTxt).replace(',', '.'))
    if (!(valor > 0)) { setAviso({ tipo: 'error', texto: 'Pon un valor de biomasa válido.' }); return }
    const { error } = await supabase.schema('produccion').from('biomasa_validada')
      .insert({ ciclo_id: sel, fecha_ref: hasta, fuente: fuenteSel, valor_lb: valor, validada_por: userId })
    if (error) { setAviso({ tipo: 'error', texto: msgError(error, 'validar la biomasa') }); return }
    setValida(v => ({ ...v, [sel]: { fuente: fuenteSel, valor_lb: valor, fecha_ref: hasta, validada_en: new Date().toISOString() } }))
    setAviso({ tipo: 'ok', texto: 'Biomasa validada.' })
  }
  async function quitarValidacion() {
    await supabase.schema('produccion').from('biomasa_validada').delete().eq('ciclo_id', sel)
    setValida(v => { const n = { ...v }; delete n[sel]; return n })
  }
  async function guardarTolvas() {
    const n = parseInt(tolvasTxt, 10)
    if (!isFinite(n) || n < 0) { setEditTolvas(false); return }
    const { error } = await supabase.schema('produccion').from('piscina').update({ tolvas: n }).eq('id', fila.piscinaId)
    if (error) { setAviso({ tipo: 'error', texto: msgError(error, 'guardar las tolvas') }); return }
    setCiclos(cs => cs.map(c => c.cicloId === sel ? { ...c, tolvas: n } : c))
    setEditTolvas(false)
  }
  async function guardarRaciones() {
    const n = parseInt(racTxt, 10)
    if (!isFinite(n) || n < 1) { setEditRac(false); return }
    const { error } = await supabase.schema('produccion').from('piscina').update({ raciones: n }).eq('id', fila.piscinaId)
    if (error) { setAviso({ tipo: 'error', texto: msgError(error, 'guardar las raciones') }); return }
    setCiclos(cs => cs.map(c => c.cicloId === sel ? { ...c, raciones: n } : c))
    setEditRac(false)
  }
  // Aplica la celda activa vía la función aplicar_escenario (una sola transacción:
  // valida rol+finca+motivo, marca el activo como reemplazado e inserta el nuevo).
  async function aplicarEscenario() {
    if (!est || !fila || !aplicarOk) return
    if (faltaMotivo) { setPidiendoMotivo(true); return }
    if (faltaConfirmCambio) { setAviso({ tipo: 'error', texto: 'Marca la confirmación del cambio de dosis para continuar.' }); return }
    const datos = {
      gramaje: fila.gramaje, dias: fila.dias, biomasaOficial: biomasaSel, fuente: fuenteUsada,
      escenarioMotor: est.escenario, tasaProx: est.planReco.tasaProx, factorProx: est.factorProx,
      usdSaco: est.alimento.usdSaco, alimento: est.alimento.nombre, pesoSaco: PARAM.pesoSaco,
      tolvas: fila.tolvas, sacosProxPedir, diasAlim, costoCompra,
      dosisAnterior, deltaDosis, cambioFuerte: nivelCambio === 'fuerte',
      calendario: calDias.map(d => ({ fecha: d.fecha, alimenta: d.alimenta, cerrado: d.cerrado, tipo: d.tipo })),
      ventana: fila.ventana ? { ponder: fila.ventana.ponder, ayuno: fila.ventana.ayuno, falt: fila.ventana.falt, valido: fila.ventana.valido } : null,
    }
    const { data, error } = await supabase.schema('produccion').rpc('aplicar_escenario', {
      p_ciclo_id: sel, p_semana_ref: hasta, p_fila_pct: celdaAct.fila, p_intensidad: celdaAct.inten,
      p_biomasa_lb: biomasaAsumida, p_tasa_pct: tasaApl, p_lb_dia: lbDiaSel,
      p_sacos_calc: sacosSemCalc, p_sacos_operativos: pedir, p_costo_usd: usdSemSel,
      p_raciones: racSinConfirmar ? null : racValor, p_es_recomendada: esReco,
      p_motivo: requiereMotivo ? (motivoTxt.trim() || null) : null, p_motivo_codigo: requiereMotivo ? motivoCod : null, p_datos: datos,
    })
    if (error) { setAviso({ tipo: 'error', texto: msgError(error, 'aplicar el escenario') }); return }
    const reg = Array.isArray(data) ? data[0] : data
    setAplicado(a => ({ ...a, [sel]: { ...reg, aplicado_nombre: nombre || null } }))
    setPidiendoMotivo(false); setMotivoTxt(''); setMotivoCod(''); setConfirmaCambio(false); setCelda(null)
    setAviso({ tipo: 'ok', texto: esReco ? 'Escenario recomendado aplicado.' : 'Escenario aplicado con motivo.' })
  }
  // Fecha y hora legible de la aplicación.
  const fechaHora = iso => { try { return new Date(iso).toLocaleString('es-EC', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch { return corta(iso) } }
  // Marca/desmarca un día FUTURO del calendario (vista previa local). Los días
  // cerrados no se tocan (reflejan la ejecución real).
  function toggleDia(fecha, actual) {
    if (!calEditable) return
    setCal({ ...(cal || {}), [fecha]: !actual })
  }
  // Confirma la semana: congela las 7 fechas vía la función confirmar_semana.
  // Los días transcurridos van con su ejecución real; solo se planifica el futuro.
  async function confirmarSemana() {
    if (!calEditable || haySinRegistro) return
    const dias = calDias.map(d => ({ fecha: d.fecha, alimenta: d.alimenta }))
    const { data, error } = await supabase.schema('produccion').rpc('confirmar_semana', { p_ciclo_id: sel, p_semana_ref: hasta, p_dias: dias })
    if (error) { setAviso({ tipo: 'error', texto: msgError(error, 'confirmar la semana') }); return }
    const diasMap = {}; dias.forEach(d => { diasMap[d.fecha] = d.alimenta })
    setPlanSemana(p => ({ ...p, [sel]: { confirmada: true, confirmada_en: (data && data.confirmada_en) || new Date().toISOString(), confirmada_por: userId, dias: diasMap } }))
    setCal(null)
    setAviso({ tipo: 'ok', texto: 'Semana confirmada.' })
  }
  // Guarda el patrón de alimentación de la finca (7 días).
  async function guardarPatron() {
    const filasPat = [1, 2, 3, 4, 5, 6, 7].map(d => ({ finca_id: finca.id, dia: d, alimenta: patTmp[d] !== false }))
    const { error } = await supabase.schema('produccion').from('finca_patron_dia').upsert(filasPat, { onConflict: 'finca_id,dia' })
    if (error) { setAviso({ tipo: 'error', texto: msgError(error, 'guardar el patrón') }); return }
    const nuevo = {}; filasPat.forEach(r => { nuevo[r.dia] = r.alimenta })
    setPatFinca(nuevo); setEditPat(false)
    const ayunoDias = [1, 2, 3, 4, 5, 6, 7].filter(d => patTmp[d] === false).map(d => DIA_LBL[d - 1])
    setAviso({ tipo: 'ok', texto: `Patrón guardado por ${nombre || 'ti'} · ${ayunoDias.length ? 'ayuno ' + ayunoDias.join(', ') : 'todos los días'} · vigente desde ${corta(hoyISO())}` })
  }
  // Abre el panel masivo preseleccionando las piscinas confirmables (sin días sin registro).
  function abrirMasivo() {
    const sel0 = new Set(ciclos.filter(f => !construirDias(f, semFechas, hoy, patFinca, patPisc, planSemana[f.cicloId], null).some(d => d.tipo === 'sin')).map(f => f.cicloId))
    setMasSel(sel0); setMasivo(true)
  }
  // Confirma la semana para las piscinas seleccionadas (bucle sobre confirmar_semana).
  async function confirmarMasivo() {
    const seleccion = masSel || new Set()
    let ok = 0, err = 0
    for (const f of ciclos.filter(c => seleccion.has(c.cicloId))) {
      const dias = construirDias(f, semFechas, hoy, patFinca, patPisc, planSemana[f.cicloId], null)
      if (dias.some(d => d.tipo === 'sin')) { err++; continue }
      const payload = dias.map(d => ({ fecha: d.fecha, alimenta: d.alimenta }))
      const { error } = await supabase.schema('produccion').rpc('confirmar_semana', { p_ciclo_id: f.cicloId, p_semana_ref: hasta, p_dias: payload })
      if (error) { err++; continue }
      const dm = {}; payload.forEach(d => { dm[d.fecha] = d.alimenta })
      setPlanSemana(p => ({ ...p, [f.cicloId]: { confirmada: true, confirmada_en: new Date().toISOString(), confirmada_por: userId, dias: dm } }))
      ok++
    }
    setMasivo(false); setMasSel(null)
    setAviso({ tipo: err ? 'error' : 'ok', texto: `Confirmadas ${ok} piscina(s)${err ? ` · ${err} con días sin registro` : ''}.` })
  }

  const diasRest = est ? Math.max(0, est.diasProyectados - fila.dias) : 0
  const estadoPlan = planEstadoDe({ est, v, bm, bloqueado, vig })
  // Matriz de escenarios: filas = supuesto de biomasa (% de la oficial), columnas
  // = intensidad. La recomendada es siempre 100% × escenario del motor (no baja
  // sola); bajar a 90/80/70 exige motivo. La celda activa es la vista previa, o la
  // aplicada de esta semana, o la recomendada.
  const recoInten = est ? est.escenario : 'MEDIO'
  const recoFila = 100
  const hayReco = !bloqueado
  const apRec = aplicado[sel] || null
  const celdaAct = celda || (apRec ? { fila: apRec.fila_pct, inten: apRec.intensidad } : { fila: recoFila, inten: recoInten })
  const esReco = hayReco && celdaAct.fila === recoFila && celdaAct.inten === recoInten
  // Calendario de la semana (L–D). Los días CERRADOS (anteriores a hoy) son solo
  // lectura y reflejan la ejecución real (alimentó / ayuno / sin registro); solo
  // los días de hoy en adelante se planifican. La propuesta futura sale del plan
  // confirmado → override de piscina → patrón de finca → todos.
  const hoy = hoyISO()
  const semFechas = Array.from({ length: 7 }, (_, i) => sumarDias(lunesDe(hasta), i))
  const planSel = planSemana[sel] || null
  const calDias = fila ? construirDias(fila, semFechas, hoy, patFinca, patPisc, planSel, cal) : []
  const diasAlim = calDias.filter(d => d.alimenta).length
  const haySinRegistro = calDias.some(d => d.tipo === 'sin')
  const hayEdit = !!(cal && Object.keys(cal).length)
  const semanaPasada = domingoDe(hasta) < domingoDe(hoy)
  const semanaConfirmada = !!(planSel && planSel.confirmada) && !hayEdit
  const calEditable = !semanaPasada && finca.rol === 'jefe'
  // Días de alimentación del PATRÓN efectivo (para la proyección de próxima semana).
  let patDiasAlim = 0
  for (let d = 1; d <= 7; d++) {
    const a = (fila && patPisc[fila.piscinaId] && patPisc[fila.piscinaId][d] !== undefined) ? patPisc[fila.piscinaId][d] : (patFinca[d] !== undefined ? patFinca[d] : true)
    if (a) patDiasAlim++
  }

  // RACIÓN de la celda activa: una sola biomasa fuente × tasa a la talla de HOY.
  // biomasaAsumida = oficial × supuesto%. lbDía = biomasaAsumida × tasa (cierre exacto).
  const biomasaAsumida = biomasaSel * celdaAct.fila / 100
  const tasaApl = est ? est.plan[celdaAct.inten].tasaDia : 0
  const tasaBase = est ? est.plan.MEDIO.tasaDia : 0           // base = Medio a talla de hoy
  const ajusteInt = tasaBase > 0 ? tasaApl / tasaBase - 1 : 0
  const lbDiaSel = biomasaAsumida * tasaApl / 100
  const sacosDiaSel = lbDiaSel / PARAM.pesoSaco
  // La semana = dosis por día alimentado × días ALIMENTADOS (no ×7: el ponderado
  // ya excluye ayunos). Redondeo solo al comprar.
  const sacosSemCalc = lbDiaSel * diasAlim / PARAM.pesoSaco   // consumo estimado (sin redondear)
  const pedir = Math.ceil(sacosSemCalc)                       // requerimiento operativo (hacia arriba)
  const costoConsumo = sacosSemCalc * (est ? est.alimento.usdSaco : 0)  // consumo estimado × precio
  const costoCompra = pedir * (est ? est.alimento.usdSaco : 0)          // desembolso de compra
  const usdSemSel = costoConsumo
  // PEDIDO para la próxima semana: proyección aparte, sobre la biomasa oficial,
  // con los días de alimentación del patrón (estimación, no pedido operativo).
  const lbDiaProx = est ? biomasaSel * est.factorProx * est.planReco.tasaProx / 100 : 0
  const sacosProxPedir = Math.ceil(lbDiaProx * patDiasAlim / PARAM.pesoSaco)
  // Reparto por tolva: solo operativo si hay tolvas Y raciones confirmadas.
  const racConf = (fila && fila.raciones != null) ? fila.raciones : fincaRac
  const racSinConfirmar = racConf == null
  const racValor = racConf != null ? racConf : 2
  const repartoOk = !bloqueado && fila && fila.tolvas > 0 && !racSinConfirmar
  const lbTolvaRacion = (fila && fila.tolvas > 0) ? lbDiaSel / fila.tolvas / racValor : null
  // Aplicar: solo jefe; deshabilitado en simulación/bloqueado; motivo obligatorio si no es la recomendada.
  const puedeAplicar = finca.rol === 'jefe'
  const aplicarOk = !!(puedeAplicar && semanaConfirmada && estadoPlan && (estadoPlan.k === 'aplicable' || estadoPlan.k === 'confirmar'))
  const requiereMotivo = !esReco
  const yaAplicada = !!(apRec && apRec.fila_pct === celdaAct.fila && apRec.intensidad === celdaAct.inten)
  // Alerta de cambio de dosis vs el escenario activo: ≤10% normal · 10–20% confirmar
  // · >20% confirmación fuerte. El delta queda en el snapshot.
  const dosisAnterior = apRec ? Number(apRec.lb_dia) : null
  const deltaDosis = (dosisAnterior && dosisAnterior > 0) ? (lbDiaSel - dosisAnterior) / dosisAnterior : null
  const nivelCambio = deltaDosis == null ? null : Math.abs(deltaDosis) <= 0.10 ? 'normal' : Math.abs(deltaDosis) <= 0.20 ? 'confirmar' : 'fuerte'
  const faltaMotivo = requiereMotivo && (!motivoCod || (motivoCod === 'otro' && !motivoTxt.trim()))
  const faltaConfirmCambio = nivelCambio === 'fuerte' && !confirmaCambio
  const muestreoDias = (fila && fila.ultMuestreo) ? diasEntre(fila.ultMuestreo, hasta) : null
  const bioTxt = bm ? (bm.difPct <= 0.15 ? `la biomasa es consistente (dif. ${Math.round(bm.difPct * 100)}%)` : `la biomasa difiere ${Math.round(bm.difPct * 100)}% entre consumo y densidad`) : ''
  const porQueTxt = est ? `Está ${est.atrasoProyectado <= 0 ? num1(Math.abs(est.atrasoProyectado)) + ' días adelantada' : num1(est.atrasoProyectado) + ' días atrasada'}, ${bioTxt}, y el FCR ${num2(est.fcrParcial)} ${est.fcrParcial <= est.fcrMax ? 'está por debajo del' : 'supera el'} máximo ${num2(est.fcrMax)}.` : ''

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY, padding: '1.4rem', background: '#eef2f6', minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <div>
          <h1 style={{ fontSize: '21px', fontWeight: 500, margin: '0 0 2px' }}>Estimación · Por piscina</h1>
          <div style={{ fontSize: '12.5px', color: GRIS }}>{finca.nombre} · Calculado con datos registrados hasta el {corta(hasta)}</div>
        </div>
        <div style={{ display: 'flex', gap: '9px', alignItems: 'center', flexWrap: 'wrap' }}>
          {ciclos.length > 0 && (
            <select value={sel} onChange={e => setSel(e.target.value)} style={inp}>
              {ciclos.map(c => <option key={c.cicloId} value={c.cicloId}>{c.nombre}</option>)}
            </select>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', color: GRIS }}>
            Meta <input type="number" min="1" value={meta} onChange={e => setMeta(Number(e.target.value) || 1)} style={{ ...inp, width: '58px' }} /> g
          </label>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '9px', padding: '4px 6px', fontSize: '12.5px' }}>
            <button onClick={() => setHasta(h => sumarDias(h, -7))} style={flecha} title="Semana anterior">‹</button>
            <input type="date" value={hasta} max={hoyISO()} title="Elige cualquier día; se aplica a su semana"
              onChange={e => { if (!e.target.value) return; const d = domingoDe(e.target.value); setHasta(d > hoyISO() ? hoyISO() : d) }}
              style={{ border: 'none', background: 'none', fontFamily: 'inherit', fontSize: '12px', color: GRIS, width: '112px' }} />
            <span style={{ color: NAVY, minWidth: '118px', textAlign: 'center' }}>{corta(lunesDe(hasta))} – {corta(domingoDe(hasta))}</span>
            <button onClick={() => setHasta(h => { const n = sumarDias(h, 7); return n > hoyISO() ? h : n })} style={{ ...flecha, opacity: domingoDe(hasta) >= hoyISO() ? 0.35 : 1 }} title="Semana siguiente">›</button>
          </span>
          {finca.rol === 'jefe' && ciclos.length > 0 && (<>
            <button onClick={() => { setPatTmp(Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map(d => [d, patFinca[d] !== false]))); setEditPat(true) }} style={{ ...inp, cursor: 'pointer', fontWeight: 500, color: GRIS }} title="Define qué días alimenta la finca por defecto">Patrón de finca</button>
            <button onClick={abrirMasivo} style={{ ...inp, cursor: 'pointer', fontWeight: 500, color: GRIS }} title="Prepara y confirma la semana para varias piscinas">Preparar semana</button>
          </>)}
          {esJefe && ciclos.length > 0 && (
            <button onClick={() => setDiag(d => !d)} style={{ ...inp, cursor: 'pointer', fontWeight: 500, color: diag ? AZUL : GRIS, borderColor: diag ? AZUL : BORDE }} title="Compara la ventana de consumo actual con la ponderada">
              {diag ? 'Ocultar diagnóstico' : 'Diagnóstico'}
            </button>
          )}
        </div>
      </div>

      {aviso && <div style={{ borderRadius: '10px', padding: '11px 14px', fontSize: '13px', marginBottom: '12px', background: aviso.tipo === 'ok' ? '#E1F5EE' : '#FBEAEA', color: aviso.tipo === 'ok' ? '#0F6E56' : '#8A2F2E' }}>{aviso.texto}</div>}

      {editPat && (
        <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '14px 16px', marginBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <div style={{ fontSize: '14px', fontWeight: 500 }}>Patrón de alimentación · {finca.nombre}</div>
            <span onClick={() => setEditPat(false)} style={{ color: GRIS, cursor: 'pointer', fontSize: '12px' }}>Cerrar</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: '6px' }}>
            {[1, 2, 3, 4, 5, 6, 7].map(d => {
              const on = patTmp[d] !== false
              return (
                <button key={d} type="button" aria-pressed={on} onClick={() => setPatTmp(p => ({ ...p, [d]: !on }))}
                  style={{ textAlign: 'center', padding: '8px 2px', borderRadius: '8px', fontFamily: 'inherit', cursor: 'pointer', background: on ? '#e7f6ef' : '#FBF5E9', border: '1px solid ' + (on ? '#bfe6d2' : '#ecd9b4') }}>
                  <div style={{ fontSize: '11px', color: NAVY, fontWeight: 500 }}>{DIA_LBL[d - 1]}</div>
                  <div style={{ fontSize: '9.5px', color: on ? '#0F6E56' : '#854F0B' }}>{on ? 'Alimenta' : 'Ayuno'}</div>
                </button>
              )
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '12px', flexWrap: 'wrap' }}>
            <button onClick={guardarPatron} style={btnAzul}>Guardar patrón</button>
            <span style={{ fontSize: '11.5px', color: '#9fb0bf' }}>Es solo la sugerencia por defecto; cada semana se confirma y cada piscina puede cambiar días.</span>
          </div>
        </div>
      )}

      {masivo && (() => {
        const datos = ciclos.map(f => {
          const dias = construirDias(f, semFechas, hoy, patFinca, patPisc, planSemana[f.cicloId], null)
          return { f, dias, da: dias.filter(d => d.alimenta).length, sinReg: dias.some(d => d.tipo === 'sin'), conf: !!(planSemana[f.cicloId] && planSemana[f.cicloId].confirmada) }
        })
        const confirmables = datos.filter(m => !m.sinReg).map(m => m.f.cicloId)
        const bloqueadas = datos.filter(m => m.sinReg)
        const nSel = masSel ? masSel.size : 0
        const diasSel = datos.filter(m => masSel && masSel.has(m.f.cicloId)).reduce((t, m) => t + m.da, 0)
        return (
        <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '14px 16px', marginBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
            <div style={{ fontSize: '14px', fontWeight: 500 }}>Preparar semana · {corta(lunesDe(hasta))} – {corta(domingoDe(hasta))}</div>
            <button onClick={() => { setMasivo(false); setMasSel(null) }} style={{ ...inp, cursor: 'pointer', padding: '5px 10px', color: GRIS }}>Cerrar</button>
          </div>
          <div style={{ fontSize: '11.5px', color: GRIS, marginBottom: '8px' }}>Revisa o ajusta el borrador y luego confirma. Días cerrados = ejecución real (borde sólido); futuros = patrón (borde punteado).</div>
          <div style={{ display: 'flex', gap: '12px', marginBottom: '8px', fontSize: '11.5px' }}>
            <span onClick={() => setMasSel(new Set(confirmables))} style={{ color: AZUL, cursor: 'pointer' }}>Seleccionar confirmables</span>
            <span onClick={() => setMasSel(new Set())} style={{ color: AZUL, cursor: 'pointer' }}>Ninguna</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '340px', overflowY: 'auto' }}>
            {datos.map(({ f, dias, da, sinReg, conf }) => {
              const checked = !!(masSel && masSel.has(f.cicloId))
              return (
                <div key={f.cicloId} style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '7px 9px', borderRadius: '8px', background: '#f6f9fb', fontSize: '12.5px', opacity: sinReg ? 0.7 : 1 }}>
                  <input type="checkbox" disabled={sinReg} checked={checked} onChange={e => setMasSel(s => { const n = new Set(s); if (e.target.checked) n.add(f.cicloId); else n.delete(f.cicloId); return n })} />
                  <span style={{ width: '78px', color: NAVY, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.nombre}</span>
                  <span style={{ display: 'flex', gap: '3px', flex: 1 }}>
                    {dias.map((d, i) => {
                      const col = d.tipo === 'sin' ? ROJO : d.alimenta ? '#0F6E56' : '#854F0B'
                      const bg = d.tipo === 'sin' ? '#FBEAEA' : d.alimenta ? '#e7f6ef' : '#FBF5E9'
                      return <span key={i} title={`${DIA_LBL[d.i]} · ${d.cerrado ? (d.tipo === 'sin' ? 'sin registro' : 'ejecutado') : 'patrón'} · ${d.alimenta ? 'alimenta' : 'ayuno'}`}
                        style={{ fontSize: '9px', width: '17px', textAlign: 'center', padding: '2px 0', borderRadius: '3px', background: bg, color: col, border: (d.cerrado ? '1px solid ' : '1px dashed ') + col }}>{DIA_LBL[d.i][0]}</span>
                    })}
                  </span>
                  <span style={{ color: GRIS, width: '52px', textAlign: 'right' }}>{da}/7</span>
                  {sinReg ? <span style={{ color: ROJO, width: '70px', textAlign: 'right', fontSize: '11px' }}>sin registro</span>
                    : conf ? <span style={{ color: VERDE, width: '70px', textAlign: 'right', fontSize: '10.5px' }}>✓ confirmada</span>
                    : <span style={{ width: '70px' }} />}
                  <button onClick={() => { setSel(f.cicloId); setMasivo(false); setMasSel(null) }} style={{ ...btnLink, fontSize: '11.5px' }}>Revisar</button>
                </div>
              )
            })}
          </div>
          <div style={{ fontSize: '12px', color: NAVY, margin: '11px 0 9px' }}>
            Confirmar <b style={{ fontWeight: 500 }}>{nSel}</b> piscina(s) · <b style={{ fontWeight: 500 }}>{diasSel}</b> días alimentados{bloqueadas.length > 0 && <span style={{ color: ROJO }}> · {bloqueadas.length} requieren registros pendientes</span>}
          </div>
          {bloqueadas.length > 0 && <div style={{ fontSize: '11px', color: '#9a7636', marginBottom: '9px' }}>Pendientes: {bloqueadas.map(m => m.f.nombre).join(', ')}</div>}
          <button onClick={confirmarMasivo} disabled={nSel === 0} style={{ ...btnAzul, opacity: nSel === 0 ? 0.5 : 1, cursor: nSel === 0 ? 'default' : 'pointer' }}>Confirmar seleccionadas ({nSel})</button>
        </div>
        )
      })()}

      {cargando ? (
        <Caja><Centro>Cargando…</Centro></Caja>
      ) : !fila ? (
        <Caja><Centro>No hay piscinas con muestreo de gramaje en esta finca a la fecha.<br />
          <span style={{ fontSize: '12px' }}>Registra el gramaje en el módulo Gramaje para que salga la estimación.</span>
        </Centro></Caja>
      ) : (
      <>
        {vald && !valdOk && vig && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '9px', background: '#FBF5E9', border: '0.5px solid #ecd9b4', borderRadius: '10px', padding: '10px 14px', marginBottom: '10px', fontSize: '12.5px', color: AMBAR }}>
            <span>⏱</span><span>La validación manual venció: <b>{vig.motivos.join(' · ')}</b>. Se usa la biomasa por consumo; vuelve a validar si corresponde.</span>
          </div>
        )}
        {/* Veredicto: verde si datos consistentes; ámbar/rojo si hay que validar la biomasa */}
        {bloqueado ? (
          (bm && bm.bloquea) ? (
          <div style={{ background: bm.color === ROJO ? '#FBEAEA' : '#FBF5E9', border: '0.5px solid ' + (bm.color === ROJO ? '#e7cccb' : '#ecd9b4'), borderRadius: '12px', padding: '14px 16px', marginBottom: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '11px' }}>
              <span style={{ fontSize: '21px', color: bm.color, lineHeight: 1 }}>⚠</span>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '14.5px', fontWeight: 500, color: bm.color }}>{cap(bm.nivel)}</span>
                  <span style={{ fontSize: '10.5px', fontWeight: 500, color: bm.color, background: bm.color + '22', padding: '2px 8px', borderRadius: '20px' }}>Diferencia {Math.round(bm.difPct * 100)}%</span>
                </div>
                <div style={{ fontSize: '12.5px', color: '#9a7636', marginTop: '3px' }}>
                  Por consumo <b>{miles(bm.bc)} lb</b> · por densidad <b>{miles(bm.bd)} lb</b> — consumo <b>{Math.round(bm.difPct * 100)}% {bm.menorQue ? 'menor' : 'mayor'}</b> que densidad · relación <b>1 : {num1(bm.relacion)}</b>
                </div>
                <div style={{ background: 'white', border: '0.5px solid #ecd9b4', borderRadius: '9px', padding: '11px 13px', marginTop: '10px', fontSize: '12px', color: '#6b5a3a', lineHeight: 1.6 }}>
                  <b style={{ color: '#8a5410' }}>¿Por qué no recomiendo todavía?</b> Hay dos cifras incompatibles y no sé cuál es la real. Si alimento con la baja y la real es la alta → <b>subalimentación</b>; si al revés → <b>sobrealimentación y FCR alto</b>.
                  <div style={{ marginTop: '6px', color: '#9a7636' }}>Revisa: último muestreo · siembra y área · sobrevivencia usada · mortalidades/raleos/transferencias · consumo real (no solo enviado) · fechas o registros duplicados. Luego valida la biomasa abajo.</div>
                </div>
              </div>
            </div>
          </div>
          ) : (
          <div style={{ background: '#FBF5E9', border: '0.5px solid #ecd9b4', borderRadius: '12px', padding: '14px 16px', marginBottom: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '11px' }}>
              <span style={{ fontSize: '21px', color: AMBAR, lineHeight: 1 }}>⚠</span>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: '14.5px', fontWeight: 500, color: AMBAR }}>Datos de consumo insuficientes</span>
                <div style={{ fontSize: '12.5px', color: '#9a7636', marginTop: '3px' }}>
                  {v && (v.coberturaOk
                    ? <>Solo <b>{v.alim}/14</b> días alimentados ({v.fed7}/7 en la última semana).</>
                    : <>Solo <b>{v.documentados}/14</b> días con registro{v.falt > 0 ? <> (faltan {v.falt})</> : ''}.</>)}
                </div>
                <div style={{ background: 'white', border: '0.5px solid #ecd9b4', borderRadius: '9px', padding: '11px 13px', marginTop: '10px', fontSize: '12px', color: '#6b5a3a', lineHeight: 1.6 }}>
                  No puedo estimar una biomasa confiable con tan pocos registros. Completa el balanceado de la ventana o <b>valida la biomasa a mano</b> abajo. Mientras tanto, los sacos de abajo son solo <b>simulación</b>.
                </div>
              </div>
            </div>
          </div>
          )
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', background: '#e7f6ef', border: '0.5px solid #bfe6d2', borderRadius: '12px', padding: '13px 16px', marginBottom: '14px' }}>
            <span style={{ width: '26px', height: '26px', borderRadius: '50%', background: VERDE, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flex: '0 0 auto' }}>✓</span>
            <div>
              <div style={{ fontSize: '14.5px', fontWeight: 500, color: VERDE }}>{est.lectura.txt}</div>
              <div style={{ fontSize: '12.5px', color: '#3d7a63' }}>
                Llegaría a {num1(est.metaUsa)} g en <b>{num1(diasRest)} días</b> (día {num1(est.diasProyectados)} de cultivo)
                {!valdOk && bm && bm.nivel === 'precaución' && <span style={{ color: AMBAR }}> · ojo: biomasa con {Math.round(bm.difPct * 100)}% de diferencia</span>}
              </div>
              {valdOk && <div style={{ fontSize: '12px', color: difGrande ? AMBAR : '#3d7a63', marginTop: '3px' }}>
                Biomasa validada manualmente{difGrande && <> · <b>ojo:</b> consumo y densidad aún difieren {Math.round(bm.difPct * 100)}% — revisa si la validación sigue vigente</>}
              </div>}
            </div>
          </div>
        )}
        {bloqueado && <div style={{ display: 'flex', alignItems: 'center', gap: '9px', fontSize: '12.5px', color: '#3d7a63', margin: '0 2px 14px' }}>
          <span style={{ color: VERDE }}>✓</span>El crecimiento va {est.atrasoProyectado <= 0 ? 'adelantado ' + num1(Math.abs(est.atrasoProyectado)) + ' días' : 'atrasado ' + num1(est.atrasoProyectado) + ' días'} — pero no cambies la dosis hasta confirmar la biomasa.
        </div>}

        {/* KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '11px', marginBottom: '14px' }}>
          <Kpi k="Gramaje hoy" v={num1(fila.gramaje)} u="g" />
          <Kpi k="Días de cultivo" v={String(fila.dias)} />
          <Kpi k="Días restantes" v={num1(diasRest)} color={AZUL} nota={`llegaría en el día ${num1(est.diasProyectados)}`} />
          <Kpi k="Biomasa seleccionada" v={miles(biomasaSel)} u="lb" nota={notaBio} notaColor={valdOk ? (difGrande ? AMBAR : AZUL) : (confianza === 'alta' ? VERDE : AMBAR)} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: '14px', marginBottom: '14px' }}>
          <Caja>
            <Titulo>Velocidad de crecimiento</Titulo>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '13px' }}>
              <Linea k="Crecimiento observado (g/día)" v={num2(est.gDiaObs)} fuerte />
              <Linea k="Crecimiento objetivo (g/día)" v={num2(est.gDiaObjetivo)} />
              <Linea k="Desempeño" v={pct0(est.desempeno)} color={est.desempeno >= 1 ? VERDE : AMBAR} fuerte />
              <div style={{ borderTop: '0.5px solid #eef3f7', paddingTop: '14px' }}>
                <Linea k="Atraso / adelanto" fuerte color={est.atrasoProyectado <= 0 ? VERDE : AMBAR}
                  v={est.atrasoProyectado <= 0 ? `${num1(Math.abs(est.atrasoProyectado))} días (adelantado)` : `${num1(est.atrasoProyectado)} días (atrasado)`} />
              </div>
            </div>
          </Caja>
          <Caja>
            <Titulo>Biomasa y sobrevivencia</Titulo>
            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 0.8fr', gap: '12px 10px', fontSize: '12.5px', alignItems: 'center' }}>
              <span style={{ color: '#9fb0bf', fontSize: '11px' }}>Indicador</span>
              <span style={{ color: GRIS, textAlign: 'right', fontSize: '11px' }}>Consumo</span>
              <span style={{ color: GRIS, textAlign: 'right', fontSize: '11px' }}>Densidad</span>
              <span style={{ color: GRIS, textAlign: 'right', fontSize: '11px' }}>Dif.</span>
              <FilaBio k="Biomasa (lb)" a={miles(est.biomasaConsumo)} b={miles(est.biomasaDensidad)} dif={`${Math.round(bm.difPct * 100) * (bm.menorQue ? -1 : 1)}%`} col={bm.color} />
              <FilaBio k="Sobrevivencia" a={pct0(est.sobrevConsumo)} b={pct0(est.sobrevDensidad)} dif={`${Math.round((est.sobrevConsumo - est.sobrevDensidad) * 100)}pp`} col={bm.color} />
              <FilaBio k="Biomasa por hectárea" a={miles(est.lbHa)} b={miles(fila.area > 0 ? est.biomasaDensidad / fila.area : 0)} dif="—" col={GRIS} />
              <FilaBio k="FCR parcial" a={est.fcrParcial > 0 ? num2(est.fcrParcial) : '—'} b={est.biomasaDensidad > 0 ? num2(est.consumoAcum / est.biomasaDensidad) : '—'} dif="—" col={GRIS} />
            </div>
            <div style={{ borderTop: '0.5px solid #eef3f7', marginTop: '12px', paddingTop: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
              <span style={{ fontSize: '12px', color: GRIS }}>FCR máximo para {num1(fila.gramaje)} g: <b style={{ color: NAVY, fontWeight: 500 }}>{num2(est.fcrMax)}</b></span>
              <span style={{ fontSize: '12px', color: GRIS }}>Usando: <b style={{ color: NAVY, fontWeight: 500 }}>{cap(fuenteUsada)}</b>{valdOk && esJefe && <span onClick={quitarValidacion} style={{ color: AZUL, cursor: 'pointer' }}> · cambiar</span>}</span>
            </div>
            {!bloqueado && bm && (
              <div style={{ fontSize: '11.5px', color: bm.color, marginTop: '8px' }}>
                Confianza {confianza}: diferencia {Math.round(bm.difPct * 100)}%{muestreoDias != null && ` · muestreo de hace ${muestreoDias} día${muestreoDias === 1 ? '' : 's'}`}
              </div>
            )}

            {/* Selector de biomasa (jefe) cuando hay que validar o no está validada */}
            {esJefe && !valdOk && (
              <div style={{ borderTop: '0.5px solid #eef3f7', marginTop: '13px', paddingTop: '13px' }}>
                <div style={{ fontSize: '12.5px', fontWeight: 500, marginBottom: '9px' }}>¿Cuál biomasa usamos para el plan?</div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
                  <Opc on={fuenteSel === 'consumo'} onClick={() => setFuenteSel('consumo')}>Por consumo · {miles(est.biomasaConsumo)} lb</Opc>
                  <Opc on={fuenteSel === 'densidad'} onClick={() => setFuenteSel('densidad')}>Por densidad · {miles(est.biomasaDensidad)} lb</Opc>
                  <Opc on={fuenteSel === 'aprobada'} onClick={() => setFuenteSel('aprobada')}>Aprobar otra: <input value={aprobTxt} onChange={e => setAprobTxt(e.target.value)} onClick={e => e.stopPropagation()} placeholder="___" style={{ width: '60px', border: 'none', background: 'transparent', fontFamily: 'inherit', fontSize: '13px', color: NAVY, borderBottom: '1px solid ' + BORDE }} /> lb</Opc>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  <button onClick={validarBiomasa} style={btnAzul}>Validar y usar</button>
                  <span style={{ fontSize: '11.5px', color: '#9fb0bf' }}>Se guarda quién la validó y cuándo. Desde ahí se recalculan sacos, FCR, costos y tolvas.</span>
                </div>
              </div>
            )}
          </Caja>
        </div>

        {/* Plan de alimentación + matriz de escenarios */}
        <Caja>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', marginBottom: '14px' }}>
            <Titulo sinMargen>Plan de alimentación · esta semana</Titulo>
            <div style={{ display: 'flex', gap: '7px', alignItems: 'center', flexWrap: 'wrap' }}>
              {apRec && <span style={{ fontSize: '11px', color: AZUL, background: '#e8f1fb', padding: '3px 10px', borderRadius: '20px' }}>Aplicado: {apRec.fila_pct}% · {cap(intenLbl(apRec.intensidad))}</span>}
              {!bloqueado && est && <span style={{ fontSize: '11.5px', fontWeight: 500, color: estadoPlan.color, background: estadoPlan.color + '18', padding: '3px 10px', borderRadius: '20px' }}>{estadoPlan.k === 'aplicable' ? '✓' : estadoPlan.k === 'simulacion' ? '◐' : '⚠'} Plan: {cap(estadoPlan.k === 'simulacion' ? 'simulación' : estadoPlan.k)}</span>}
            </div>
          </div>
          {bloqueado ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '11px', background: '#f6f9fb', borderRadius: '9px', padding: '13px 15px', marginBottom: '13px' }}>
              <span style={{ fontSize: '18px' }}>🔒</span>
              <div style={{ fontSize: '12.5px', color: GRIS }}>Valida la biomasa arriba para desbloquear el plan. La matriz de abajo es solo <b>simulación</b> hasta validar.</div>
            </div>
          ) : estadoPlan.k !== 'aplicable' ? (
            <div style={{ background: estadoPlan.color + '14', border: '0.5px solid ' + estadoPlan.color + '44', borderRadius: '9px', padding: '10px 13px', marginBottom: '12px', fontSize: '12px', color: estadoPlan.color, lineHeight: 1.5 }}>
              <b>{estadoPlan.txt}.</b> {estadoPlan.detalle}{estadoPlan.k === 'simulacion' ? ' — los sacos son referenciales.' : ''}
            </div>
          ) : (
            <div style={{ background: '#f6f9fb', borderRadius: '9px', padding: '11px 13px', marginBottom: '13px', fontSize: '12px', color: '#4a5a67', lineHeight: 1.6 }}>
              <b style={{ color: NAVY, fontWeight: 500 }}>¿Por qué {cap(est.escenario)}?</b> {porQueTxt}
            </div>
          )}

          {/* Calendario de la semana: define los días alimentados (el pedido usa esos días, no 7) */}
          <div style={{ background: '#f6f9fb', borderRadius: '9px', padding: '12px 14px', marginBottom: '13px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '9px' }}>
              <div style={{ ...titMini, marginBottom: 0 }}>Calendario · {diasAlim} de 7 días de alimentación</div>
              <span style={{ fontSize: '10.5px', fontWeight: 500, color: semanaConfirmada ? VERDE : AMBAR, background: (semanaConfirmada ? VERDE : AMBAR) + '18', borderRadius: '20px', padding: '2px 9px' }}>{semanaConfirmada ? '✓ Confirmada' : 'Pendiente de confirmar'}</span>
            </div>
            {!semanaConfirmada && <div style={{ fontSize: '11.5px', color: GRIS, marginBottom: '9px' }}>Patrón sugerido de {finca.nombre}{calEditable ? ' — los días pasados se toman de lo ejecutado; toca un día futuro para cambiarlo.' : '.'}</div>}
            <Calendario dias={calDias} editable={calEditable} onToggle={toggleDia} />
            {fila.ventana && fila.ventana.ayuno >= 3 && (
              <div style={{ fontSize: '11px', color: GRIS, marginTop: '8px' }}>{fila.ventana.ayuno} ayunos detectados en la ventana histórica; el calendario futuro aún no tiene ayunos confirmados.</div>
            )}
            {haySinRegistro && <div style={{ fontSize: '11.5px', color: ROJO, marginTop: '8px', background: '#FBEAEA', borderRadius: '8px', padding: '7px 10px' }}>Hay días pasados sin registro — resuélvelos en Registro diario antes de confirmar la semana.</div>}
            {calEditable && !semanaConfirmada && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
                <button onClick={confirmarSemana} disabled={haySinRegistro} style={{ ...btnAzul, opacity: haySinRegistro ? 0.5 : 1, cursor: haySinRegistro ? 'default' : 'pointer' }}>Confirmar semana</button>
              </div>
            )}
            {semanaPasada && <div style={{ fontSize: '11px', color: '#9fb0bf', marginTop: '8px' }}>Semana pasada · solo lectura.</div>}
          </div>

          <Matriz oficial={biomasaSel} plan={est.plan} pesoSaco={PARAM.pesoSaco} dias={diasAlim} recoFila={recoFila} recoInten={recoInten} hayReco={hayReco} sel={celdaAct} onSel={(f, k) => setCelda({ fila: f, inten: k })} />
          <div style={{ fontSize: '11px', color: '#9fb0bf', margin: '9px 2px 14px', lineHeight: 1.5 }}>
            ✓ Recomendada {hayReco ? `(100% · ${intenLbl(recoInten)})` : '— sin recomendación hasta validar'} · ● tu elección · 100% = biomasa oficial, 90/80/70 = supuesto conservador
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: '14px' }}>
            {/* Detalle de la celda activa (cierra exacto: biomasa × tasa = lb/día) */}
            <div style={{ background: '#f6f9fb', borderRadius: '9px', padding: '13px 15px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <div style={{ ...titMini, marginBottom: 0 }}>Detalle · {celdaAct.fila}% × {intenLbl(celdaAct.inten)}</div>
                {esReco && <span style={{ fontSize: '10px', color: VERDE, background: '#e7f6ef', borderRadius: '20px', padding: '2px 9px' }}>✓ Recomendada</span>}
              </div>
              <Row k={`Tasa base (${num1(fila.gramaje)} g · Medio)`} v={num3(tasaBase) + '%'} />
              <Row k={`Ajuste intensidad ${intenLbl(celdaAct.inten)}`} v={(ajusteInt >= 0 ? '+' : '') + Math.round(ajusteInt * 100) + '%'} />
              <Row k="Tasa aplicada" v={num3(tasaApl) + '%'} fuerte top />
              <Row k={`${miles(biomasaAsumida)} lb × ${num3(tasaApl)}%`} v={miles(lbDiaSel) + ' lb/día'} fuerte />
              <div style={{ borderTop: '0.5px solid #e3ecf2', marginTop: '7px', paddingTop: '6px' }}>
                <Row k={`Consumo estimado (${diasAlim} días)`} v={num1(sacosSemCalc) + ' sacos'} />
                <Row k="Requerimiento operativo" v={pedir + ' sacos'} fuerte azul />
                <Row k="Costo de consumo" v={dinero(costoConsumo)} />
                <Row k={`Desembolso de compra (${pedir})`} v={dinero(costoCompra)} />
              </div>
              {!semanaConfirmada && (
                <div style={{ fontSize: '11px', color: AMBAR, marginTop: '9px', background: '#FBF5E9', borderRadius: '8px', padding: '7px 10px' }}>
                  Estimación preliminar con {diasAlim} días · <b>calendario sin confirmar</b>. Confirma la semana para poder aplicar.
                </div>
              )}
              <div style={{ fontSize: '11px', color: GRIS, marginTop: '9px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <span style={{ background: '#eef2f6', borderRadius: '6px', padding: '2px 8px' }}>Próxima semana</span> requerimiento estimado {sacosProxPedir} sacos · patrón de {patDiasAlim} días sin confirmar.
              </div>
            </div>

            {/* Reparto por tolva: operativo solo con tolvas Y raciones confirmadas */}
            <div style={{ background: '#f6f9fb', borderRadius: '9px', padding: '13px 15px' }}>
              <div style={titMini}>Reparto por tolva</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12.5px', padding: '3px 0' }}>
                <span style={{ color: GRIS }}>Tolvas</span>
                {editTolvas ? (
                  <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                    <input autoFocus type="number" min="0" value={tolvasTxt} onChange={e => setTolvasTxt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') guardarTolvas() }} style={{ ...inp, width: '56px' }} />
                    <button onClick={guardarTolvas} style={btnAzul}>Ok</button>
                  </span>
                ) : (
                  <span style={{ display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
                    <b style={{ fontWeight: 500 }}>{fila.tolvas != null ? fila.tolvas : '—'}</b>
                    {esJefe && <span onClick={() => { setTolvasTxt(fila.tolvas != null ? String(fila.tolvas) : ''); setEditTolvas(true) }} style={{ color: AZUL, cursor: 'pointer', fontSize: '11.5px' }}>{fila.tolvas != null ? 'editar' : 'configurar'}</span>}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12.5px', padding: '3px 0' }}>
                <span style={{ color: GRIS }}>Raciones por día</span>
                {editRac ? (
                  <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                    <input autoFocus type="number" min="1" value={racTxt} onChange={e => setRacTxt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') guardarRaciones() }} style={{ ...inp, width: '56px' }} />
                    <button onClick={guardarRaciones} style={btnAzul}>Ok</button>
                  </span>
                ) : (
                  <span style={{ display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
                    <b style={{ fontWeight: 500, color: racSinConfirmar ? AMBAR : NAVY }}>{racSinConfirmar ? '2 · sin confirmar' : racConf}</b>
                    {esJefe && <span onClick={() => { setRacTxt(racConf != null ? String(racConf) : '2'); setEditRac(true) }} style={{ color: AZUL, cursor: 'pointer', fontSize: '11.5px' }}>{racSinConfirmar ? 'confirmar' : 'editar'}</span>}
                  </span>
                )}
              </div>
              {repartoOk ? (
                <div style={{ background: '#e8f1fb', borderRadius: '9px', padding: '11px 13px', textAlign: 'center', marginTop: '8px' }}>
                  <div style={{ fontSize: '11px', color: '#185FA5' }}>Balanceado por tolva y ración</div>
                  <div style={{ fontSize: '24px', fontWeight: 500, color: NAVY }}>{miles(lbTolvaRacion)} <span style={{ fontSize: '12px', color: GRIS }}>lb</span></div>
                </div>
              ) : (
                <div style={{ background: '#FBF5E9', borderRadius: '9px', padding: '11px 13px', marginTop: '8px' }}>
                  <div style={{ fontSize: '12px', color: '#854F0B', fontWeight: 500 }}>Reparto no disponible</div>
                  <div style={{ fontSize: '11.5px', color: '#9a7636', marginTop: '2px' }}>{bloqueado ? 'Valida la biomasa' : !fila.tolvas ? 'Configura el número de tolvas' : 'Confirma las raciones por día'} para el reparto operativo.</div>
                  {fila.tolvas > 0 && lbTolvaRacion != null && <div style={{ fontSize: '11px', color: GRIS, marginTop: '6px' }}>Estimación preliminar ({racValor} raciones sugeridas): {miles(lbTolvaRacion)} lb por tolva.</div>}
                </div>
              )}
            </div>
          </div>

          {/* Escenario aplicado (trazabilidad) o controles para aplicar/reemplazar */}
          {!bloqueado && (yaAplicada && apRec ? (
            <div style={{ borderTop: '0.5px solid #eef3f7', marginTop: '14px', paddingTop: '13px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '9px', background: '#e7f6ef', border: '0.5px solid #bfe6d2', borderRadius: '9px', padding: '11px 13px' }}>
                <span style={{ color: VERDE, fontSize: '15px', lineHeight: 1.3 }}>✓</span>
                <div style={{ fontSize: '12px', color: '#2f6b55', lineHeight: 1.55 }}>
                  <b style={{ fontWeight: 500 }}>Aplicado{apRec.aplicado_nombre ? ' por ' + apRec.aplicado_nombre : ''}</b> · {fechaHora(apRec.aplicado_en)} · {apRec.fila_pct}% × {cap(intenLbl(apRec.intensidad))}
                  <div style={{ color: GRIS }}>Motivo: {apRec.motivo_codigo ? cap((MOTIVOS.find(m => m[0] === apRec.motivo_codigo) || [])[1] || apRec.motivo_codigo) + (apRec.motivo_eleccion ? ' · ' + apRec.motivo_eleccion : '') : (apRec.motivo_eleccion || 'combinación recomendada')}</div>
                  {puedeAplicar && <div style={{ color: '#9fb0bf', marginTop: '2px' }}>Elige otra celda para reemplazarlo.</div>}
                </div>
              </div>
            </div>
          ) : puedeAplicar ? (
            <div style={{ borderTop: '0.5px solid #eef3f7', marginTop: '14px', paddingTop: '13px' }}>
              {nivelCambio && nivelCambio !== 'normal' && (
                <div style={{ marginBottom: '10px', background: (nivelCambio === 'fuerte' ? ROJO : AMBAR) + '14', border: '0.5px solid ' + (nivelCambio === 'fuerte' ? ROJO : AMBAR) + '44', borderRadius: '9px', padding: '10px 13px', fontSize: '12px', color: nivelCambio === 'fuerte' ? ROJO : AMBAR }}>
                  <b>Cambio de dosis {deltaDosis >= 0 ? '+' : ''}{Math.round(deltaDosis * 100)}%.</b> Nueva {miles(lbDiaSel)} lb/día vs plan anterior {miles(dosisAnterior)} lb/día.
                  {nivelCambio === 'fuerte' && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: '7px', marginTop: '7px', color: ROJO, cursor: 'pointer' }}>
                      <input type="checkbox" checked={confirmaCambio} onChange={e => setConfirmaCambio(e.target.checked)} />
                      Confirmo un cambio de dosis mayor al 20%.
                    </label>
                  )}
                </div>
              )}
              {requiereMotivo && (
                <div style={{ marginBottom: '10px' }}>
                  <div style={{ fontSize: '11.5px', color: AMBAR, marginBottom: '6px' }}>Elegiste un escenario distinto al recomendado{pidiendoMotivo && faltaMotivo ? ' — elige el motivo para continuar' : ''}. Queda en el historial:</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                    {MOTIVOS.map(([cod, lbl]) => (
                      <button key={cod} type="button" aria-pressed={motivoCod === cod} onClick={() => setMotivoCod(cod)}
                        style={{ fontFamily: 'inherit', fontSize: '11.5px', padding: '5px 10px', borderRadius: '20px', cursor: 'pointer', border: '1px solid ' + (motivoCod === cod ? AZUL : BORDE), background: motivoCod === cod ? '#e8f1fb' : 'white', color: motivoCod === cod ? AZUL : NAVY, fontWeight: motivoCod === cod ? 500 : 400 }}>{lbl}</button>
                    ))}
                  </div>
                  <input value={motivoTxt} onChange={e => setMotivoTxt(e.target.value)} placeholder={motivoCod === 'otro' ? 'Describe el motivo (obligatorio)' : 'Comentario o evidencia (opcional)'} style={{ ...inp, width: '100%', borderColor: pidiendoMotivo && faltaMotivo ? AMBAR : BORDE }} />
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                <button onClick={aplicarEscenario} disabled={!aplicarOk || faltaMotivo || faltaConfirmCambio} style={{ ...btnAzul, opacity: (!aplicarOk || faltaMotivo || faltaConfirmCambio) ? 0.5 : 1, cursor: (!aplicarOk || faltaMotivo || faltaConfirmCambio) ? 'default' : 'pointer' }}>
                  {apRec ? 'Reemplazar escenario aplicado' : 'Aplicar este escenario'}
                </button>
                <span style={{ fontSize: '11.5px', color: '#9fb0bf' }}>
                  {!semanaConfirmada ? 'Confirma el calendario de la semana para poder aplicar.' : !aplicarOk ? 'No se puede aplicar en simulación o bloqueado.' : faltaConfirmCambio ? 'Marca la confirmación del cambio de dosis.' : faltaMotivo ? 'Elige el motivo del cambio.' : esReco ? 'Es la combinación recomendada por el sistema.' : 'Se guarda la decisión, el motivo y quién la aplicó.'}
                </span>
              </div>
            </div>
          ) : null)}

          <div style={{ fontSize: '12.5px', color: GRIS, marginTop: '13px' }}>Alimento: <b style={{ color: NAVY, fontWeight: 500 }}>{est.alimento.nombre}</b> · {dinero(est.alimento.usdSaco)} el saco</div>
        </Caja>
      </>
      )}

      {diag && !cargando && ciclos.length > 0 && <TablaDiagnostico filas={diagnostico} hasta={hasta} />}
    </div>
  )
}

// Tabla de diagnóstico de la ventana de consumo (solo lectura, no guarda nada).
function TablaDiagnostico({ filas, hasta }) {
  const d7 = v => v.d7 != null ? miles(v.d7) : '—'
  const dp = v => v.dPrev != null ? miles(v.dPrev) : '—'
  const tnd = v => v.tend == null ? '—' : (v.tend >= 0 ? '+' : '') + Math.round(v.tend * 100) + '%'
  const tndCol = v => v.tend == null ? GRIS : (v.tend > 0.20 || v.tend < -0.15) ? (v.tend < -0.15 ? ROJO : AMBAR) : VERDE
  const th = { padding: '9px 7px', fontWeight: 500, textAlign: 'right', whiteSpace: 'nowrap' }
  const td = { padding: '9px 7px', textAlign: 'right', whiteSpace: 'nowrap' }
  return (
    <div style={{ marginTop: '18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', margin: '0 2px 6px' }}>
        <span style={{ fontSize: '11px', letterSpacing: '0.04em', textTransform: 'uppercase', color: '#9fb0bf' }}>Diagnóstico · ventana de consumo</span>
        <span style={{ background: '#FAEEDA', color: AMBAR, fontSize: '11px', padding: '3px 9px', borderRadius: '6px' }}>Solo lectura · no guarda nada</span>
      </div>
      <div style={{ fontSize: '12px', color: GRIS, margin: '0 2px 10px' }}>
        Ventana analizada: <b style={{ color: NAVY, fontWeight: 500 }}>{corta(sumarDias(hasta, -13))} – {corta(hasta)}</b> · Datos registrados hasta: <b style={{ color: NAVY, fontWeight: 500 }}>{corta(hasta)}</b>
      </div>
      <div style={{ overflowX: 'auto', border: '0.5px solid ' + BORDE, borderRadius: '12px', background: 'white' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11.5px', minWidth: '940px' }}>
          <thead>
            <tr style={{ color: GRIS }}>
              <th style={{ ...th, textAlign: 'left', paddingLeft: '12px' }}>Piscina</th>
              <th style={th}>7d</th>
              <th style={th}>Sem. ant.</th>
              <th style={th}>Tend.</th>
              <th style={th}>14d simple</th>
              <th style={th}>14d ponder.</th>
              <th style={th}>Alim / ayuno / falt.</th>
              <th style={th}>Biomasa (antes→desp.)</th>
              <th style={th}>Dif. vs dens.</th>
              <th style={{ ...th, textAlign: 'left' }}>Biomasa</th>
              <th style={{ ...th, textAlign: 'left', paddingRight: '12px' }}>Confiabilidad</th>
            </tr>
          </thead>
          <tbody>
            {filas.map(({ f, v, bA, bB, difA, difB, nb, conf }) => (
              <tr key={f.cicloId} style={{ borderTop: '0.5px solid ' + BORDE }}>
                <td style={{ ...td, textAlign: 'left', paddingLeft: '12px', color: NAVY }}>{f.nombre}</td>
                <td style={td}>{d7(v)}</td>
                <td style={td}>{dp(v)}</td>
                <td style={{ ...td, color: tndCol(v) }}>{tnd(v)}</td>
                <td style={{ ...td, color: GRIS }}>{miles(v.simple)}</td>
                <td style={{ ...td, color: v.valido ? NAVY : GRIS }} title={v.valido ? '' : 'Simulación — no cumple cobertura (12/14 documentados) o muestra (8/14 alimentados)'}>{miles(v.ponder)}{!v.valido && <span style={{ fontSize: '10px', color: GRIS }}> simul.</span>}</td>
                <td style={{ ...td, color: GRIS }} title={v.multi > 0 ? `${v.multi} día(s) con 2+ registros (se suman)` : ''}>{v.alim} / {v.ayuno} / <span style={{ color: v.falt > 0 ? AMBAR : GRIS }}>{v.falt}</span>{v.multi > 0 && <span style={{ fontSize: '10px', color: AMBAR }}> · {v.multi}×2+</span>}</td>
                <td style={td}>{v.valido ? <><span style={{ color: GRIS }}>{miles(bA)}</span> → {miles(bB)}</> : <span style={{ color: GRIS }}>—</span>}</td>
                <td style={td}>{v.valido ? <><span style={{ color: GRIS }}>{Math.round(difA * 100)}%</span> → {Math.round(difB * 100)}%</> : <span style={{ color: GRIS }}>—</span>}</td>
                <td style={{ ...td, textAlign: 'left', color: v.valido ? nb.color : GRIS }}>{v.valido ? cap(nb.nivel) : '—'}</td>
                <td style={{ ...td, textAlign: 'left', paddingRight: '12px', color: conf.color }}>{conf.txt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', margin: '12px 2px 0', fontSize: '11.5px', color: GRIS, lineHeight: 1.5 }}>
        <span><b style={{ fontWeight: 500, color: NAVY }}>Ponderado</b> = (2·Σreciente + Σanterior) ÷ (2·n reciente + n anterior) — con sumas y días alimentados, sin proyección por tendencia</span>
        <span><b style={{ fontWeight: 500, color: NAVY }}>Ayuno</b> se excluye del promedio (no cuenta como 0)</span>
        <span><b style={{ fontWeight: 500, color: NAVY }}>Cobertura</b>: ≥6/7 y ≥12/14 días documentados (alimentado o ayuno; faltante = día sin fila)</span>
        <span><b style={{ fontWeight: 500, color: NAVY }}>Muestra biológica</b>: ≥4/7 y ≥8/14 días alimentados</span>
      </div>
    </div>
  )
}

const inp = { padding: '7px 11px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY, boxSizing: 'border-box' }
const flecha = { border: 'none', background: 'none', cursor: 'pointer', color: GRIS, fontSize: '16px', padding: '0 4px', fontFamily: 'inherit', lineHeight: 1 }
const btnAzul = { padding: '7px 14px', fontSize: '12.5px', fontFamily: 'inherit', fontWeight: 500, border: 'none', borderRadius: '8px', background: AZUL, color: 'white', cursor: 'pointer' }
const btnLink = { background: 'none', border: 'none', color: AZUL, fontFamily: 'inherit', fontSize: '12.5px', cursor: 'pointer', padding: 0, fontWeight: 500 }
const cap = s => { const t = String(s || '').toLowerCase(); return t ? t.charAt(0).toUpperCase() + t.slice(1) : t }
// Mensaje de error amable: esconde el detalle técnico de permisos.
function msgError(error, accion) {
  const m = String(error?.message || '')
  if (/row-level security|permission|not authorized|policy/i.test(m)) return `No tienes permiso para ${accion}. Avisa al administrador.`
  return `No se pudo ${accion}. Intenta de nuevo.`
}

function Opc({ on, onClick, children }) {
  return <span onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', cursor: 'pointer', border: (on ? '1.5px' : '0.5px') + ' solid ' + (on ? AZUL : BORDE), background: on ? '#e8f1fb' : 'white', color: on ? AZUL : NAVY, borderRadius: '9px', padding: '8px 13px', fontSize: '13px', fontWeight: on ? 500 : 400 }}>{children}</span>
}
function FilaBio({ k, a, b, dif, col }) {
  return (<>
    <span style={{ color: GRIS }}>{k}</span>
    <b style={{ textAlign: 'right', fontWeight: 500 }}>{a}</b>
    <span style={{ textAlign: 'right', color: GRIS }}>{b}</span>
    <span style={{ textAlign: 'right', color: col }}>{dif}</span>
  </>)
}
function Caja({ children }) {
  return <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '16px 18px' }}>{children}</div>
}
function Centro({ children }) {
  return <div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px', lineHeight: 1.6 }}>{children}</div>
}
function Titulo({ children, sinMargen }) {
  return <div style={{ fontSize: '11px', color: GRIS, textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: sinMargen ? 0 : '14px' }}>{children}</div>
}
function Kpi({ k, v, u, color, nota, notaColor }) {
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '10px', padding: '13px 15px' }}>
      <div style={{ fontSize: '11.5px', color: GRIS }}>{k}</div>
      <div style={{ fontSize: '22px', fontWeight: 500, color: color || NAVY }}>{v}{u && <span style={{ fontSize: '12px', color: GRIS }}> {u}</span>}</div>
      {nota && <div style={{ fontSize: '10px', color: notaColor || '#9fb0bf' }}>{nota}</div>}
    </div>
  )
}
function Mini({ k, v }) {
  return <div style={{ background: '#f6f9fb', borderRadius: '9px', padding: '11px 13px' }}><div style={{ fontSize: '11px', color: GRIS }}>{k}</div><div style={{ fontSize: '19px', fontWeight: 500, color: NAVY }}>{v}</div></div>
}
const titMini = { fontSize: '11px', color: '#9fb0bf', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.04em' }
const intenLbl = k => k === 'BAJO' ? 'baja' : k === 'ALTO' ? 'alta' : 'media'
// Motivos estructurados para apartarse de la recomendación (código + etiqueta).
const MOTIVOS = [
  ['mortalidad', 'Mortalidad'], ['raleo', 'Raleo'], ['transferencia', 'Transferencia'],
  ['muestreo', 'Muestreo'], ['consumo', 'Consumo observado'], ['agua', 'Calidad de agua'],
  ['ayuno', 'Ayuno programado'], ['comercial', 'Decisión comercial'], ['otro', 'Otro'],
]
const DIA_LBL = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']
// Construye los 7 días de la semana de una piscina: pasados desde la ejecución real
// (alsRaw), futuros desde overrides → plan confirmado → patrón de piscina → patrón de
// finca → todos. Reutilizado por la piscina seleccionada y por la acción masiva.
function construirDias(fila, semFechas, hoy, patFinca, patPisc, plan, overrides) {
  const ejec = {}
  for (const r of (fila.alsRaw || [])) {
    if (!semFechas.length || r.fecha < semFechas[0] || r.fecha > semFechas[6]) continue
    const e = (ejec[r.fecha] ||= { lb: 0, fed: false, ayuno: false, rec: false })
    e.rec = true
    if (r.ayuno) e.ayuno = true; else { e.lb += r.lb; e.fed = true }
  }
  const planDias = plan ? plan.dias : null
  const ov = patPisc[fila.piscinaId] || null
  return semFechas.map((f, i) => {
    const dia = i + 1
    const e = ejec[f]
    const ejecutado = !!(e && e.rec)
    // Cerrado = ya ejecutado (aunque sea HOY) o día pasado. La ejecución real manda.
    if (ejecutado || f < hoy) {
      if (!ejecutado) return { fecha: f, i, cerrado: true, tipo: 'sin', alimenta: false, lb: 0 }
      if (e.fed) return { fecha: f, i, cerrado: true, tipo: 'fed', alimenta: true, lb: e.lb }
      return { fecha: f, i, cerrado: true, tipo: 'ayuno', alimenta: false, lb: 0 }
    }
    let a
    if (overrides && overrides[f] !== undefined) a = overrides[f]
    else if (planDias && planDias[f] !== undefined) a = planDias[f]
    else if (ov && ov[dia] !== undefined) a = ov[dia]
    else if (patFinca[dia] !== undefined) a = patFinca[dia]
    else a = true
    return { fecha: f, i, cerrado: false, tipo: 'plan', alimenta: a, lb: 0 }
  })
}
// Calendario semanal: 7 celdas L–D. Días cerrados = ejecución real (solo lectura);
// días futuros = planificables (botón con aria-pressed). Verde alimenta, ámbar ayuno,
// rojo sin registro.
function Calendario({ dias, editable, onToggle }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: '6px' }}>
      {dias.map((d, i) => {
        const interactivo = editable && !d.cerrado
        const col = d.tipo === 'sin' ? ROJO : d.alimenta ? '#0F6E56' : '#854F0B'
        const bg = d.tipo === 'sin' ? '#FBEAEA' : d.alimenta ? '#e7f6ef' : '#FBF5E9'
        const bd = d.tipo === 'sin' ? '#e7cccb' : d.alimenta ? '#bfe6d2' : '#ecd9b4'
        const txt = d.cerrado ? (d.tipo === 'fed' ? 'Alimentó' : d.tipo === 'ayuno' ? 'Ayuno' : 'Sin registro') : (d.alimenta ? 'Alimenta' : 'Ayuno')
        const sub = d.tipo === 'fed' ? miles(d.lb) + ' lb' : d.tipo === 'ayuno' ? 'Registrado' : d.tipo === 'sin' ? 'Resolver' : null
        const base = { textAlign: 'center', padding: '6px 2px', borderRadius: '8px', background: bg, border: '1px solid ' + bd, width: '100%', fontFamily: 'inherit', boxSizing: 'border-box' }
        const inner = (<>
          <div style={{ fontSize: '10.5px', color: GRIS }}>{DIA_LBL[d.i ?? i]}</div>
          <div style={{ fontSize: '12px', fontWeight: 500, color: NAVY }}>{Number(d.fecha.slice(8, 10))}</div>
          <div style={{ fontSize: '9.5px', color: col }}>{txt}</div>
          {sub && <div style={{ fontSize: '9px', color: GRIS }}>{sub}</div>}
        </>)
        return interactivo
          ? <button key={d.fecha} type="button" aria-pressed={d.alimenta} aria-label={`${DIA_LBL[d.i ?? i]} ${Number(d.fecha.slice(8, 10))}: ${d.alimenta ? 'alimenta' : 'ayuno'}`} onClick={() => onToggle(d.fecha, d.alimenta)} style={{ ...base, cursor: 'pointer' }}>{inner}</button>
          : <div key={d.fecha} style={{ ...base, opacity: d.cerrado ? 0.92 : 1 }}>{inner}</div>
      })}
    </div>
  )
}
// Matriz de escenarios: filas = supuesto de biomasa (% de la oficial), columnas =
// intensidad. Marca la recomendada (verde ✓) y la elegida (azul ●). Clic = vista previa.
function Matriz({ oficial, plan, pesoSaco, dias, recoFila, recoInten, hayReco, sel, onSel }) {
  const FILAS = [100, 90, 80, 70]
  const COLS = [['BAJO', 'Baja'], ['MEDIO', 'Media'], ['ALTO', 'Alta']]
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '128px repeat(3,1fr)', minWidth: '440px', alignItems: 'center' }}>
        <div style={{ fontSize: '10.5px', color: '#9fb0bf', padding: '10px 0 8px' }}>Supuesto de biomasa</div>
        {COLS.map(([k, lbl]) => (
          <div key={k} style={{ textAlign: 'center', padding: '10px 0 8px' }}><div style={{ fontSize: '12.5px', fontWeight: 500, color: NAVY }}>{lbl}</div><div style={{ fontSize: '10.5px', color: GRIS }}>{num3(plan[k].tasaDia)}%</div></div>
        ))}
        <div style={{ gridColumn: '1 / -1', borderTop: '0.5px solid #e3ecf2' }} />
        {FILAS.map(f => {
          const esOf = f === 100
          return (
            <Fragment key={f}>
              <div style={{ padding: '8px 0' }}>
                <div style={{ fontSize: esOf ? '13px' : '12.5px', fontWeight: esOf ? 500 : 400, color: esOf ? NAVY : '#51606c' }}>{f}% · {esOf ? 'oficial' : 'conservador'}</div>
                <div style={{ fontSize: '10px', color: '#9fb0bf' }}>{miles(oficial * f / 100)} lb</div>
              </div>
              {COLS.map(([k]) => {
                const lb = oficial * f / 100 * plan[k].tasaDia / 100
                const sacos = Math.ceil(lb * dias / pesoSaco)
                const esR = hayReco && f === recoFila && k === recoInten
                const esS = sel.fila === f && sel.inten === k
                const borde = esR ? '2px solid ' + VERDE : esS ? '2px solid ' + AZUL : '0.5px solid transparent'
                const bg = esR ? '#e7f6ef' : esS ? '#e8f1fb' : 'transparent'
                const activa = esOf || esS || esR
                return (
                  <div key={k} onClick={() => onSel(f, k)} style={{ cursor: 'pointer', textAlign: 'center', margin: '3px', padding: '7px 4px', border: borde, borderRadius: '9px', background: bg }}>
                    {(esR || esS) && <div style={{ fontSize: '9px', fontWeight: 500, color: esR ? VERDE : AZUL }}>{esR ? '✓ Recomendada' : '● Tu elección'}</div>}
                    <div style={{ fontSize: esOf ? '16px' : '14px', fontWeight: 500, color: activa ? NAVY : GRIS }}>{miles(lb)}</div>
                    <div style={{ fontSize: '10px', color: activa ? '#3d7a63' : '#9fb0bf' }}>{sacos} sacos</div>
                  </div>
                )
              })}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}
function Row({ k, v, fuerte, top, azul }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', padding: '3px 0', ...(top ? { borderTop: '0.5px solid #e3ecf2', marginTop: '5px', paddingTop: '7px' } : {}) }}>
      <span style={{ color: GRIS, fontSize: '11.5px' }}>{k}</span>
      <b style={{ fontWeight: fuerte ? 500 : 400, color: azul ? AZUL : NAVY, whiteSpace: 'nowrap' }}>{v}</b>
    </div>
  )
}
function Linea({ k, v, fuerte, color }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: GRIS }}>{k}</span><span style={{ fontWeight: fuerte ? 500 : 400, color: color || NAVY }}>{v}</span></div>
}
