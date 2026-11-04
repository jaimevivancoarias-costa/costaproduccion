import { useState, useEffect, useMemo, useCallback, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, lunesDe, sumarDias, miles, dinero } from '../lib/fechas'
import { estimar, cfgFinca, PARAM, sobrevDe, proyectarAMeta } from '../lib/estimacion'
import { construirDias, nivelCambio as nivelCambioDe, planVsEjecutado } from '../lib/calendario'
import { precioPorGramaje, ENT_TALLAS, COLA_TALLAS, ENT_LISTA_DEF, COLA_LISTA_DEF, REND_ENTERO_DEF, REND_COLA_DEF, CV_DEF } from '../lib/precios'

const NAVY = '#022847', AZUL = '#0D6CB0', BORDE = '#dce6ef', GRIS = '#7d8fa0'
const VERDE = '#0F6E56', AMBAR = '#854F0B', ROJO = '#8A2F2E'
const num1 = n => Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const num2 = n => Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const num3 = n => Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
// Semáforo de cumplimiento: 90–110% verde · 80–90 o 110–120 ámbar · <80 o >120 rojo.
const cumColor = r => r == null ? GRIS : (r >= 0.90 && r <= 1.10) ? VERDE : (r >= 0.80 && r <= 1.20) ? AMBAR : ROJO
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

// Capacidad de biomasa por tolva (fija): cada tolva soporta 10.000 lb de biomasa.
const CAP_TOLVA_LB = 10000
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
// Promedio PLANO de consumo, como el Excel: suma de libras de los últimos n días
// dividida entre n. Los ayunos y los días sin registro cuentan como 0 (diluyen el
// promedio, igual que el "consumo semanal" del Excel). Devuelve lb/día por cada
// ventana (7, 14 y 21 días) para poder comparar escenarios lado a lado. Es la
// fuente de consumo oficial del motor (la ventana elegida; por defecto 14).
function ventanaFlat(rows, hasta) {
  const porDia = {}
  for (const r of (rows || [])) {
    const d = (porDia[r.fecha] ||= { lb: 0, fed: false, ayuno: false })
    if (r.ayuno) d.ayuno = true
    else { d.lb += r.lb; d.fed = true }
  }
  const quiere = new Set([7, 14, 21])
  const out = {}
  let sum = 0, alim = 0, ayuno = 0, doc = 0, falt = 0
  for (let i = 0; i < 21; i++) {
    const d = porDia[sumarDias(hasta, -i)]
    if (d) { if (d.fed) { sum += d.lb; alim++; doc++ } else if (d.ayuno) { ayuno++; doc++ } }
    else falt++
    const n = i + 1
    if (quiere.has(n)) out[n] = { n, dia: sum / n, sum, alim, ayuno, doc, falt }
  }
  return out
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

// Resumen de una piscina para el tablero: corre el motor, estado, recomendado,
// aplicado, Δ vs semana anterior (aplicado-vs-aplicado), plan vs ejecutado y alertas.
function resumenPiscina(f, ctx) {
  const { meta, cfg, valida, aplicado, aplicadoPrev, planSemana, patFinca, patPisc, hasta, hoy, semFechas, precioOpts } = ctx
  const est = estimar({ area: f.area, dias: f.dias, pl: f.pl, gramajeHoy: f.gramaje, consumoAcum: f.consumoAcum, larva: f.larva, gInicio: f.gIni, diasInicio: f.diasIni, consumoVentana: f.consumoVentana, meta, finca: cfg })
  const bc = est.biomasaConsumo, bd = est.biomasaDensidad
  const mayor = Math.max(bc, bd), menor = Math.min(bc, bd)
  const difPct = mayor > 0 ? (mayor - menor) / mayor : 0
  const nb = nivelBiomasa(difPct)
  const vald = valida[f.cicloId]
  const vig = vald ? vigenciaDe(vald, f, bc, hasta) : null
  const valdOk = !!(vald && (!vig || vig.vigente))
  const biomasaSel = valdOk ? vald.valor_lb : bc
  const v = f.ventana
  const consumoInsuf = v ? !v.valido : false
  const bloqueado = !!((nb.bloquea || consumoInsuf) && !valdOk)
  const estadoPlan = planEstadoDe({ est, v, bm: null, bloqueado, vig })
  const recoInten = est.escenario
  const ap = aplicado[f.cicloId] || null
  const prev = aplicadoPrev[f.cicloId] || null
  const confirmado = !!(planSemana[f.cicloId] && planSemana[f.cicloId].confirmada)
  const dias = construirDias(f, semFechas, hoy, patFinca, patPisc, planSemana[f.cicloId], null)
  const diasAlim = dias.filter(d => d.alimenta).length
  const recoSacosCalc = biomasaSel * est.plan[recoInten].tasaDia / 100 * diasAlim / PARAM.pesoSaco
  const recoSacos = Math.ceil(recoSacosCalc)
  let deltaEstado, delta = null
  if (!ap) deltaEstado = 'pendiente'
  else if (!prev) deltaEstado = 'sin-comparable'
  else { delta = Number(prev.lb_dia) > 0 ? (Number(ap.lb_dia) - Number(prev.lb_dia)) / Number(prev.lb_dia) : null; deltaEstado = 'ok' }
  const vigenteDesde = ap ? String(ap.aplicado_en).slice(0, 10) : null
  const pve = (ap && confirmado) ? planVsEjecutado({ calDias: dias, planDias: planSemana[f.cicloId].dias, lbDia: Number(ap.lb_dia), vigenteDesde }) : null
  const cumplimiento = (pve && pve.planLb > 0) ? pve.ejecLb / pve.planLb : null
  const muDias = f.ultMuestreo ? Math.round((new Date(hasta) - new Date(f.ultMuestreo)) / 86400000) : null
  const alertas = []
  if (bloqueado) alertas.push(nb.bloquea && !consumoInsuf ? `Validar biomasa ${Math.round(difPct * 100)}%` : 'Datos insuficientes · validar')
  if (pve && pve.sinReg > 0) alertas.push(`${pve.sinReg} día(s) sin registro`)
  if (estadoPlan.k === 'simulacion') alertas.push(estadoPlan.detalle || 'Simulación')
  if (delta != null && Math.abs(delta) > 0.20) alertas.push(`Cambio ${delta >= 0 ? '+' : ''}${Math.round(delta * 100)}%`)
  if (estadoPlan.k === 'confirmar' && estadoPlan.detalle) alertas.push(estadoPlan.detalle)
  if (delta != null && Math.abs(delta) > 0.10 && Math.abs(delta) <= 0.20) alertas.push(`Cambio ${delta >= 0 ? '+' : ''}${Math.round(delta * 100)}%`)
  if (muDias != null && muDias > 14) alertas.push(`Muestreo hace ${muDias} d`)
  const precioAplicado = ap && Number(ap.sacos_calc) > 0 ? Number(ap.costo_usd) / Number(ap.sacos_calc) : est.alimento.usdSaco
  // Rentabilidad: valor de continuar (cosechar hoy vs esperar a meta).
  let rent = null
  if (!bloqueado && biomasaSel > 0 && f.gramaje < G_MIN_COMERCIAL) {
    rent = { noComercial: true, gHoy: f.gramaje }
  } else if (!bloqueado && biomasaSel > 0) {
    const pHoy = precioPorGramaje(f.gramaje, precioOpts)
    const ingresoHoy = biomasaSel * pHoy.mejor
    const pr = proyectarAMeta({ gHoy: f.gramaje, meta, biomasaActual: biomasaSel, finca: cfg, desempeno: est.desempeno })
    if (!pr) rent = { listo: true, ingresoHoy, conviene: pHoy.conviene, valor: 0 }
    else {
      const pMeta = precioPorGramaje(pr.metaUsa, precioOpts)
      const costoAlim = pr.alimentoLb / PARAM.pesoSaco * est.alimento.usdSaco
      const costoOper = (cfg.costoHaDia || 0) * f.area * pr.dias
      const netoMeta = pr.biomasaMeta * pMeta.mejor - costoAlim - costoOper
      const valor = netoMeta - ingresoHoy
      rent = { listo: false, ingresoHoy, netoMeta, valor, valorDia: pr.dias > 0 ? valor / pr.dias : 0, conviene: pMeta.conviene, diasRest: pr.dias }
    }
  }
  return { f, est, biomasaSel, bloqueado, estadoPlan, recoInten, ap, confirmado, diasAlim, recoSacos, sacosShow: ap ? Number(ap.sacos_operativos) : (bloqueado ? null : recoSacos), sugerido: !ap, delta, deltaEstado, pve, cumplimiento, muDias, alertas, difPct, precioAplicado, usdSaco: est.alimento.usdSaco, rent }
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
  const [patronAudit, setPatronAudit] = useState(null) // { nombre, en } de la última edición del patrón
  const [aplicadoPrev, setAplicadoPrev] = useState({}) // cicloId -> aplicado de la semana anterior (para Δ)
  const [productos, setProductos] = useState({})       // producto_id -> nombre
  const [inventario, setInventario] = useState({})     // producto_id -> saldo_final (sacos)
  const [transito, setTransito] = useState({})         // producto_id -> pendiente (sacos)
  const [precioProd, setPrecioProd] = useState({})     // producto_id -> { precio, fecha } (precio vigente)
  const [invCorte, setInvCorte] = useState(null)       // fecha/hora del corte de inventario
  const [reservaDias, setReservaDias] = useState(2)    // parámetro: días alimentados de reserva
  const [precioOpts, setPrecioOpts] = useState({})     // lista de precios + rendimientos + cv (desde la base)
  const [editPrecio, setEditPrecio] = useState(false)  // editor de precios de venta
  const [precioTmp, setPrecioTmp] = useState(null)     // edición en curso del editor de precios
  const [vista, setVista] = useState('piscina')        // 'piscina' | 'tablero'
  const [filtro, setFiltro] = useState('todas')
  const [desdeTablero, setDesdeTablero] = useState(false)
  const [cal, setCal] = useState(null)         // overrides de días futuros: { fecha -> alimenta } (null = propuesta)
  const [editPat, setEditPat] = useState(false) // editor del patrón de finca
  const [patTmp, setPatTmp] = useState({})      // patrón en edición { dia -> alimenta }
  const [masivo, setMasivo] = useState(false)   // panel de preparación masiva
  const [masSel, setMasSel] = useState(null)    // Set de cicloId seleccionados en el panel masivo
  const [celda, setCelda] = useState(null)     // vista previa: { fila, inten } (null = usa la recomendada/aplicada)
  const [motivoTxt, setMotivoTxt] = useState('')
  const [motivoCod, setMotivoCod] = useState('')
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
  // Modo diagnóstico de la ventana de consumo (solo lectura)
  const [diag, setDiag] = useState(false)
  const [ventanaDias, setVentanaDias] = useState(14) // ventana de consumo oficial: 7 | 14 | 21 (plano, incluye ayunos)
  const [pendiente, setPendiente] = useState({}) // cicloId -> solicitud pendiente de aprobación (esta semana)
  const [bandeja, setBandeja] = useState(false)   // panel de aprobaciones pendientes
  const [rechazando, setRechazando] = useState(null) // id de solicitud en rechazo
  const [rechCod, setRechCod] = useState(''); const [rechTxt, setRechTxt] = useState('')

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
    const [{ data: mu }, { data: al }, { data: bv }, { data: ap }, { data: fr }, { data: pf }, { data: pp }, { data: sp }, { data: apPrev }, { data: prod }, { data: inv }, { data: tran }, { data: par }, { data: pc }] = await Promise.all([
      supabase.schema('produccion').from('muestreo').select('ciclo_id, fecha, peso_gramos').in('ciclo_id', ids).lte('fecha', hasta).order('fecha'),
      supabase.schema('produccion').from('alimentacion').select('ciclo_id, fecha, libras, sin_alimentacion, precio_saco, producto_id').in('ciclo_id', ids).lte('fecha', hasta),
      supabase.schema('produccion').from('biomasa_validada').select('ciclo_id, fuente, valor_lb, fecha_ref, validada_por, validada_en').in('ciclo_id', ids).lte('fecha_ref', hasta).order('validada_en', { ascending: false }),
      supabase.schema('produccion').from('escenario_aplicado').select('*').in('ciclo_id', ids).eq('semana_ref', hasta).in('estado', ['activo', 'pendiente']),
      supabase.schema('produccion').from('finca').select('raciones').eq('id', finca.id).maybeSingle(),
      supabase.schema('produccion').from('finca_patron_dia').select('dia, alimenta, actualizado_por, actualizado_en').eq('finca_id', finca.id),
      supabase.schema('produccion').from('piscina_patron_dia').select('piscina_id, dia, alimenta').in('piscina_id', piscIds),
      supabase.schema('produccion').from('semana_plan').select('ciclo_id, confirmada, confirmada_en, confirmada_por, dias:semana_plan_dia(fecha, alimenta)').in('ciclo_id', ids).eq('semana_ref', hasta),
      supabase.schema('produccion').from('escenario_aplicado').select('ciclo_id, lb_dia, fila_pct, intensidad').in('ciclo_id', ids).eq('semana_ref', sumarDias(hasta, -7)).eq('estado', 'activo'),
      supabase.schema('produccion').from('producto').select('id, nombre, nombre_corto'),
      supabase.schema('produccion').from('vw_inventario').select('producto_id, anio, semana, saldo_final, actualizado_en').eq('finca_id', finca.id),
      supabase.schema('produccion').from('vw_pedido_balanceado_pendiente').select('producto_id, pendiente').eq('finca_id', finca.id),
      supabase.schema('produccion').from('parametro').select('clave, valor'),
      supabase.schema('produccion').from('precio_camaron').select('tipo, orden, etiqueta, precio').order('orden'),
    ])
    const muDe = {}; (mu || []).forEach(m => { (muDe[m.ciclo_id] ||= []).push({ fecha: m.fecha, peso: Number(m.peso_gramos) }) })
    const alDe = {}; (al || []).forEach(r => { if (!r.sin_alimentacion) (alDe[r.ciclo_id] ||= []).push({ fecha: r.fecha, lb: Number(r.libras) || 0 }) })
    const alRawDe = {}; (al || []).forEach(r => { (alRawDe[r.ciclo_id] ||= []).push({ fecha: r.fecha, lb: Number(r.libras) || 0, ayuno: !!r.sin_alimentacion, precio: Number(r.precio_saco) || 0 }) })
    const bvDe = {}; (bv || []).forEach(r => { if (!bvDe[r.ciclo_id]) bvDe[r.ciclo_id] = { fuente: r.fuente, valor_lb: Number(r.valor_lb), fecha_ref: r.fecha_ref, validada_en: r.validada_en } })
    const apDe = {}, pendDe = {}; (ap || []).forEach(r => { if (r.estado === 'pendiente') pendDe[r.ciclo_id] = r; else apDe[r.ciclo_id] = r })
    // Patrón de finca + su auditoría (quién lo editó por última vez y cuándo).
    const patF = {}; let patPor = null, patEn = null
    ;(pf || []).forEach(r => { patF[r.dia] = r.alimenta; if (r.actualizado_en && (!patEn || r.actualizado_en > patEn)) { patEn = r.actualizado_en; patPor = r.actualizado_por } })
    // Nombres (quién aplicó escenarios + quién editó el patrón), de public.usuarios.
    const quienes = [...new Set([...(ap || []).map(r => r.aplicado_por), patPor].filter(Boolean))]
    const nomDe = {}
    if (quienes.length) {
      const { data: us } = await supabase.from('usuarios').select('id, nombre').in('id', quienes)
      ;(us || []).forEach(u => { nomDe[u.id] = u.nombre })
      Object.values(apDe).forEach(r => { r.aplicado_nombre = nomDe[r.aplicado_por] || null })
      Object.values(pendDe).forEach(r => { r.aplicado_nombre = nomDe[r.aplicado_por] || null })
    }
    const patP = {}; (pp || []).forEach(r => { (patP[r.piscina_id] ||= {})[r.dia] = r.alimenta })
    const planDe = {}; (sp || []).forEach(r => {
      const dias = {}; (r.dias || []).forEach(d => { dias[d.fecha] = d.alimenta })
      planDe[r.ciclo_id] = { confirmada: r.confirmada, confirmada_en: r.confirmada_en, confirmada_por: r.confirmada_por, dias }
    })
    setValida(bvDe); setAplicado(apDe); setPendiente(pendDe); setFincaRac(fr && fr.raciones != null ? Number(fr.raciones) : null)
    setPatFinca(patF); setPatPisc(patP); setPlanSemana(planDe)
    setPatronAudit(patEn ? { nombre: nomDe[patPor] || null, en: patEn } : null)
    const apPrevDe = {}; (apPrev || []).forEach(r => { apPrevDe[r.ciclo_id] = r })
    setAplicadoPrev(apPrevDe)
    // Producto por piscina (el de la alimentación más reciente), inventario y tránsito.
    const prodNom = {}; (prod || []).forEach(p => { prodNom[p.id] = p.nombre_corto || p.nombre })
    const prodCic = {}; (al || []).forEach(r => { if (r.sin_alimentacion || !r.producto_id) return; const c = prodCic[r.ciclo_id]; if (!c || r.fecha > c.fecha) prodCic[r.ciclo_id] = { fecha: r.fecha, pid: r.producto_id } })
    const invMap = {}, invSeen = {}
    ;(inv || []).slice().sort((a, b) => (b.anio - a.anio) || (b.semana - a.semana)).forEach(r => { if (invSeen[r.producto_id]) return; invSeen[r.producto_id] = 1; invMap[r.producto_id] = Number(r.saldo_final) || 0 })
    const tranMap = {}; (tran || []).forEach(r => { tranMap[r.producto_id] = (tranMap[r.producto_id] || 0) + (Number(r.pendiente) || 0) })
    // Corte del inventario (máx actualizado_en) y precio vigente por producto (último precio_saco registrado).
    let corte = null; (inv || []).forEach(r => { if (r.actualizado_en && (!corte || r.actualizado_en > corte)) corte = r.actualizado_en })
    const precioMap = {}; (al || []).forEach(r => { if (!r.producto_id || !(Number(r.precio_saco) > 0)) return; const c = precioMap[r.producto_id]; if (!c || r.fecha > c.fecha) precioMap[r.producto_id] = { precio: Number(r.precio_saco), fecha: r.fecha } })
    const paramMap = {}; (par || []).forEach(p => { paramMap[p.clave] = Number(p.valor) })
    setProductos(prodNom); setInventario(invMap); setTransito(tranMap)
    setPrecioProd(precioMap); setInvCorte(corte); setReservaDias(paramMap.reserva_dias_balanceado != null ? paramMap.reserva_dias_balanceado : 2)
    // Lista de precios de venta (editable) + rendimientos/dispersión; si falta, usa los del motor.
    const entL = [], colL = [], etq = { entero: [], cola: [] }
    ;(pc || []).forEach(r => { (r.tipo === 'entero' ? entL : colL)[r.orden] = Number(r.precio); etq[r.tipo][r.orden] = r.etiqueta })
    const po = {}
    if (entL.length) po.enteroLista = entL
    if (colL.length) po.colaLista = colL
    if (paramMap.rend_entero != null) po.rendEntero = paramMap.rend_entero
    if (paramMap.rend_cola != null) po.rendCola = paramMap.rend_cola
    if (paramMap.cv_talla != null) po.cv = paramMap.cv_talla
    setPrecioOpts(po)
    const ini14 = sumarDias(hasta, -14)
    const filas = lista.map(c => {
      const ms = muDe[c.id] || []
      const gramaje = ms.length ? ms[ms.length - 1].peso : 0
      const prev = [...ms].reverse().find(m => m.fecha <= ini14)
      const siembra = c.fecha_ocupacion || c.fecha_siembra
      const als = alDe[c.id] || []
      const v = ventana14(alRawDe[c.id] || [], hasta)
      const fl = ventanaFlat(alRawDe[c.id] || [], hasta)
      return {
        cicloId: c.id, piscinaId: c.piscina.id, nombre: c.piscina.nombre,
        area: Number(c.piscina.hectareas) || 0, tolvas: c.piscina.tolvas != null ? Number(c.piscina.tolvas) : null,
        raciones: c.piscina.raciones != null ? Number(c.piscina.raciones) : null,
        productoId: (prodCic[c.id] || {}).pid || null,
        larva: Number(c.cantidad_larva) || 0, pl: Number(c.gramaje_precria) || 0.5, siembra,
        gramaje, ultMuestreo: ms.length ? ms[ms.length - 1].fecha : null,
        gIni: prev ? prev.peso : 0, diasIni: prev ? diasEntre(siembra, prev.fecha) : 0,
        consumoAcum: als.reduce((t, r) => t + r.lb, 0),
        // Consumo oficial (lb/semana) = promedio PLANO de la ventana elegida (14 por
        // defecto), incluyendo ayunos como el Excel. consVentDe() lo recalcula según
        // la ventana seleccionada. Si la ventana no cumple cobertura+muestra, el plan
        // queda bloqueado (obliga validar a mano).
        consumoVentana: (fl[14] ? fl[14].dia : 0) * 7,
        ventana: v, fl,
        alsRaw: alRawDe[c.id] || [],
        dias: diasEntre(siembra, hasta),
      }
    }).filter(f => f.gramaje > 0).sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es', { numeric: true }))
    setCiclos(filas)
    setSel(s => (s && filas.some(f => f.cicloId === s)) ? s : (filas[0]?.cicloId || ''))
    setCargando(false)
  }, [finca.id, hasta])

  useEffect(() => { cargar() }, [cargar])
  // Al cambiar de piscina o semana: restaura la selección guardada de esa piscina/semana
  // (persiste en recargas y al salir/entrar); si no hay, usa recomendada/aplicada.
  useEffect(() => {
    setPidiendoMotivo(false); setMotivoTxt(''); setMotivoCod(''); setCal(null)
    let saved = null
    try { const r = localStorage.getItem(`escSel|${sel}|${hasta}`); if (r) saved = JSON.parse(r) } catch { /* sin storage */ }
    setCelda(saved && typeof saved.fila === 'number' && saved.inten ? saved : null)
  }, [sel, hasta])

  const fila = ciclos.find(c => c.cicloId === sel)
  // Consumo oficial (lb/semana) de la ventana elegida: plano, incluye ayunos.
  const consVentDe = f => ((f && f.fl && f.fl[ventanaDias]) ? f.fl[ventanaDias].dia : 0) * 7
  const est = useMemo(() => fila ? estimar({
    area: fila.area, dias: fila.dias, pl: fila.pl, gramajeHoy: fila.gramaje,
    consumoAcum: fila.consumoAcum, larva: fila.larva, gInicio: fila.gIni,
    diasInicio: fila.diasIni, consumoVentana: consVentDe(fila), meta, finca: cfg,
  }) : null, [fila, meta, cfg, ventanaDias])

  // Diferencia entre métodos y nivel de confianza.
  const bm = useMemo(() => {
    if (!est) return null
    const bc = est.biomasaConsumo, bd = est.biomasaDensidad
    const mayor = Math.max(bc, bd), menor = Math.min(bc, bd)
    const difPct = mayor > 0 ? (mayor - menor) / mayor : 0
    return { bc, bd, difPct, menorQue: bc < bd, relacion: menor > 0 ? mayor / menor : 0, ...nivelBiomasa(difPct) }
  }, [est])

  // Biomasa por consumo a 7 / 14 / 21 días (plano, incluye ayunos), para comparar
  // escenarios lado a lado. La columna elegida (ventanaDias) es la oficial.
  const ventanas = useMemo(() => {
    if (!fila || !fila.fl) return []
    return [7, 14, 21].map(n => {
      const w = fila.fl[n] || { dia: 0, ayuno: 0, falt: 0 }
      const e = estimar({
        area: fila.area, dias: fila.dias, pl: fila.pl, gramajeHoy: fila.gramaje,
        consumoAcum: fila.consumoAcum, larva: fila.larva, gInicio: fila.gIni,
        diasInicio: fila.diasIni, consumoVentana: w.dia * 7, meta, finca: cfg,
      })
      return { n, dia: w.dia, ayuno: w.ayuno, falt: w.falt, bio: e.biomasaConsumo, sobrev: e.sobrevConsumo }
    })
  }, [fila, meta, cfg])

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

  // Tablero: resumen de todas las piscinas de la finca para la semana.
  const tablero = useMemo(() => {
    if (vista !== 'tablero' || !ciclos.length) return []
    const hoy = hoyISO()
    const semFechas = Array.from({ length: 7 }, (_, i) => sumarDias(lunesDe(hasta), i))
    const ctx = { meta, cfg, valida, aplicado, aplicadoPrev, planSemana, patFinca, patPisc, hasta, hoy, semFechas, precioOpts }
    return ciclos.map(f => resumenPiscina({ ...f, consumoVentana: consVentDe(f) }, ctx))
  }, [vista, ciclos, hasta, meta, cfg, valida, aplicado, aplicadoPrev, planSemana, patFinca, patPisc, precioOpts, ventanaDias])

  // Totales en dos niveles: plan confirmado (aplicado + calendario confirmado) y
  // proyección completa (+ recomendaciones pendientes).
  const totales = useMemo(() => {
    let bioConf = 0, sacCalc = 0, sacOper = 0, costoCons = 0, desembolso = 0, cob = 0, nConf = 0
    let extraSacos = 0, extraCosto = 0, bloq = 0, sinEsc = 0, desv = 0, valorCont = 0, esperarN = 0, cosecharN = 0, sinCalc = 0
    for (const r of tablero) {
      if (r.rent && !r.rent.listo && !r.rent.noComercial) { valorCont += r.rent.valor; if (r.rent.valor >= 0) esperarN++; else cosecharN++ } else sinCalc++
      if (r.ap) cob++
      if (r.ap && r.confirmado) {
        nConf++
        bioConf += Number(r.ap.biomasa_lb) || 0
        sacCalc += Number(r.ap.sacos_calc) || 0
        sacOper += Number(r.ap.sacos_operativos) || 0
        costoCons += Number(r.ap.costo_usd) || 0
        desembolso += (Number(r.ap.sacos_operativos) || 0) * r.precioAplicado
      } else if (!r.bloqueado) {
        extraSacos += r.recoSacos
        extraCosto += r.recoSacos * r.usdSaco
      }
      if (r.bloqueado) bloq++
      if (!r.ap) sinEsc++
      if (r.delta != null && Math.abs(r.delta) > 0.10) desv++
    }
    return { bioConf, sacCalc, sacOper, costoCons, desembolso, cob, nConf, total: tablero.length, extraSacos, extraCosto, bloq, sinEsc, desv, valorCont, esperarN, cosecharN, sinCalc }
  }, [tablero])

  // Pedido neto por producto = requerimiento (sacos operativos del plan confirmado)
  // − inventario − en tránsito + reserva. Agrupa las piscinas por su producto reciente.
  const pedidoNeto = useMemo(() => {
    if (vista !== 'tablero') return []
    // 1) Sumar el requerimiento de TODAS las piscinas por producto (y el consumo
    //    diario, para la reserva). 2) Descontar inventario/tránsito una sola vez.
    const porProd = {}
    for (const r of tablero) {
      if (!(r.ap && r.confirmado)) continue
      const pid = r.f.productoId || 'sin'
      const o = (porProd[pid] ||= { req: 0, dia: 0, piscinas: [] })
      const sac = Number(r.ap.sacos_operativos) || 0
      o.req += sac
      if (r.diasAlim > 0) o.dia += sac / r.diasAlim          // consumo diario del producto
      o.piscinas.push({ nombre: r.f.nombre, sacos: sac })
    }
    return Object.entries(porProd).map(([pid, o]) => {
      const inv = inventario[pid]                            // undefined = sin dato de stock
      const invN = inv || 0
      const tr = transito[pid] || 0                          // "a tiempo": hoy sin fecha de llegada → 0
      const reserva = o.dia * reservaDias                    // 2 días alimentados por defecto
      const neto = Math.max(0, Math.ceil(o.req - invN - tr + reserva))
      const pv = precioProd[pid]
      const faltaDato = pid === 'sin' || inv === undefined || !pv
      const estado = faltaDato ? 'falta' : neto > 0 ? 'pedir' : 'cubierto'
      return { pid, nombre: pid === 'sin' ? 'Sin producto reciente' : (productos[pid] || 'Producto'), req: o.req, inv: invN, invFalta: inv === undefined, tr, reserva, neto, estado, precio: pv, desembolso: pv ? neto * pv.precio : 0, piscinas: o.piscinas.sort((a, b) => b.sacos - a.sacos) }
    }).sort((a, b) => b.neto - a.neto)
  }, [vista, tablero, inventario, transito, productos, precioProd, reservaDias])

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
  // Supuestos de biomasa (100/90/80/70 % de la oficial, que en el caso normal es la
  // de consumo). Por cada supuesto, los indicadores biológicos resultantes. El 100%
  // es la oficial; los demás son recortes conservadores. Enlaza con la matriz de dosis.
  const G_LB = 453.592
  const supuestos = (est && fila) ? [100, 90, 80, 70].map(p => {
    const bio = biomasaSel * p / 100
    const sob = (fila.gramaje > 0 && fila.larva > 0) ? bio * G_LB / (fila.gramaje * fila.larva) : 0
    return { p, bio, sob, ha: fila.area > 0 ? bio / fila.area : 0, fcr: bio > 0 ? est.consumoAcum / bio : 0 }
  }) : []
  // Densidad como referencia: dónde cae la biomasa teórica de tabla frente a la de consumo.
  const densRef = (est && fila) ? {
    bio: est.biomasaDensidad, sob: est.sobrevDensidad,
    ha: fila.area > 0 ? est.biomasaDensidad / fila.area : 0,
    fcr: est.biomasaDensidad > 0 ? est.consumoAcum / est.biomasaDensidad : 0,
    pctDeConsumo: est.biomasaConsumo > 0 ? est.biomasaDensidad / est.biomasaConsumo : 0,
  } : null

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
  // Aplica la celda activa vía la función aplicar_escenario (una sola transacción:
  // valida rol+finca+motivo, marca el activo como reemplazado e inserta el nuevo).
  async function aplicarEscenario() {
    if (!est || !fila || !aplicarOk) return
    if (faltaMotivo) { setPidiendoMotivo(true); return }
    const datos = {
      gramaje: fila.gramaje, dias: fila.dias, biomasaOficial: biomasaSel, fuente: fuenteUsada,
      escenarioMotor: est.escenario, tasaProx: est.planReco.tasaProx, factorProx: est.factorProx,
      usdSaco: est.alimento.usdSaco, alimento: est.alimento.nombre, pesoSaco: PARAM.pesoSaco,
      tolvas: fila.tolvas, sacosProxPedir, diasAlim, costoCompra,
      dosisAnterior, sacosAnterior, deltaDia, deltaSem, cambioFuerte: nivelCambio === 'fuerte',
      calendario: calDias.map(d => ({ fecha: d.fecha, alimenta: d.alimenta, cerrado: d.cerrado, tipo: d.tipo })),
      ventana: fila.ventana ? { ponder: fila.ventana.ponder, ayuno: fila.ventana.ayuno, falt: fila.ventana.falt, valido: fila.ventana.valido, ventanaDias, consDia: consVentDe(fila) / 7 } : null,
    }
    datos.deltaDia = deltaDia; datos.deltaSem = deltaSem; datos.baseTipo = baseTipo
    const { data, error } = await supabase.schema('produccion').rpc('aplicar_escenario', {
      p_ciclo_id: sel, p_semana_ref: hasta, p_fila_pct: celdaAct.fila, p_intensidad: celdaAct.inten,
      p_biomasa_lb: biomasaAsumida, p_tasa_pct: tasaApl, p_lb_dia: lbDiaSel,
      p_sacos_calc: sacosSemCalc, p_sacos_operativos: pedir, p_costo_usd: usdSemSel,
      p_raciones: null, p_es_recomendada: esReco,
      p_motivo: requiereMotivo ? (motivoTxt.trim() || null) : null, p_motivo_codigo: requiereMotivo ? motivoCod : null, p_datos: datos,
      p_requiere_aprobacion: requiereAprobacion, p_base_activo_id: apRec ? apRec.id : null, p_base_cal_en: planSel ? planSel.confirmada_en : null,
      p_base_mu_fecha: fila.ultMuestreo || null, p_base_bio_lb: biomasaSel,
    })
    if (error) { setAviso({ tipo: 'error', texto: msgError(error, 'aplicar el escenario') }); return }
    const reg = Array.isArray(data) ? data[0] : data
    reg.aplicado_nombre = nombre || null
    // Guarda el calendario como plan de la semana (acta plan vs ejecutado), sin paso
    // manual aparte. No bloquea el aplicar si falla o si hay días sin registro.
    if (!haySinRegistro && !semanaConfirmada) {
      try {
        const ds = calDias.map(d => ({ fecha: d.fecha, alimenta: d.alimenta }))
        const { data: cs } = await supabase.schema('produccion').rpc('confirmar_semana', { p_ciclo_id: sel, p_semana_ref: hasta, p_dias: ds })
        const dm = {}; ds.forEach(d => { dm[d.fecha] = d.alimenta })
        setPlanSemana(p => ({ ...p, [sel]: { confirmada: true, confirmada_en: (cs && cs.confirmada_en) || new Date().toISOString(), confirmada_por: userId, dias: dm } }))
        setCal(null)
      } catch { /* el acta es secundaria: no interrumpe el aplicar */ }
    }
    setPidiendoMotivo(false); setMotivoTxt(''); setMotivoCod(''); setCelda(null)
    try { localStorage.removeItem(`escSel|${sel}|${hasta}`) } catch { /* sin storage */ }
    if (requiereAprobacion) {
      setPendiente(p => ({ ...p, [sel]: reg }))
      setAviso({ tipo: 'ok', texto: 'Enviado a aprobación de un segundo jefe. El plan anterior sigue vigente.' })
    } else {
      setAplicado(a => ({ ...a, [sel]: reg }))
      setAviso({ tipo: 'ok', texto: esReco ? 'Escenario recomendado aplicado.' : 'Escenario aplicado con motivo.' })
    }
  }
  // Aprobar / rechazar una solicitud pendiente (segundo jefe).
  async function aprobarPendiente(reg) {
    const { data, error } = await supabase.schema('produccion').rpc('aprobar_escenario', { p_id: reg.id })
    if (error) { setAviso({ tipo: 'error', texto: msgError(error, 'aprobar la solicitud') }); return }
    const row = Array.isArray(data) ? data[0] : data
    setAplicado(a => ({ ...a, [reg.ciclo_id]: { ...row, aplicado_nombre: reg.aplicado_nombre } }))
    setPendiente(p => { const n = { ...p }; delete n[reg.ciclo_id]; return n })
    setAviso({ tipo: 'ok', texto: 'Escenario aprobado y activado.' })
  }
  async function rechazarPendiente(reg) {
    if (!rechCod) { setAviso({ tipo: 'error', texto: 'Elige el motivo del rechazo.' }); return }
    const { error } = await supabase.schema('produccion').rpc('rechazar_escenario', { p_id: reg.id, p_codigo: rechCod, p_motivo: rechTxt.trim() || null })
    if (error) { setAviso({ tipo: 'error', texto: msgError(error, 'rechazar la solicitud') }); return }
    setPendiente(p => { const n = { ...p }; delete n[reg.ciclo_id]; return n })
    setRechazando(null); setRechCod(''); setRechTxt('')
    setAviso({ tipo: 'ok', texto: 'Solicitud rechazada.' })
  }
  // Fecha y hora legible de la aplicación.
  const fechaHora = iso => { try { return new Date(iso).toLocaleString('es-EC', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch { return corta(iso) } }
  // Selecciona una celda del escenario y la guarda (persiste en recargas / salir).
  function elegirCelda(fila, inten) {
    const c = { fila, inten }
    setCelda(c)
    try { localStorage.setItem(`escSel|${sel}|${hasta}`, JSON.stringify(c)) } catch { /* sin storage */ }
  }
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
    const ahora = new Date().toISOString()
    const filasPat = [1, 2, 3, 4, 5, 6, 7].map(d => ({ finca_id: finca.id, dia: d, alimenta: patTmp[d] !== false, actualizado_por: userId, actualizado_en: ahora }))
    const { error } = await supabase.schema('produccion').from('finca_patron_dia').upsert(filasPat, { onConflict: 'finca_id,dia' })
    if (error) { setAviso({ tipo: 'error', texto: msgError(error, 'guardar el patrón') }); return }
    const nuevo = {}; filasPat.forEach(r => { nuevo[r.dia] = r.alimenta })
    setPatFinca(nuevo); setPatronAudit({ nombre: nombre || null, en: ahora }); setEditPat(false)
    const ayunoDias = [1, 2, 3, 4, 5, 6, 7].filter(d => patTmp[d] === false).map(d => DIA_LBL[d - 1])
    setAviso({ tipo: 'ok', texto: `Patrón guardado por ${nombre || 'ti'} · ${ayunoDias.length ? 'ayuno ' + ayunoDias.join(', ') : 'todos los días'} · vigente desde ${corta(hoyISO())}` })
  }
  // Editor de precios de venta (lista entero/cola + rendimientos + dispersión).
  function abrirPrecios() {
    setPrecioTmp({
      enteroLista: ENT_TALLAS.map((_, i) => precioOpts.enteroLista?.[i] ?? ENT_LISTA_DEF[i]),
      colaLista: COLA_TALLAS.map((_, i) => precioOpts.colaLista?.[i] ?? COLA_LISTA_DEF[i]),
      rendEntero: precioOpts.rendEntero ?? REND_ENTERO_DEF,
      rendCola: precioOpts.rendCola ?? REND_COLA_DEF,
      cv: precioOpts.cv ?? CV_DEF,
    })
    setEditPrecio(true)
  }
  async function guardarPrecios() {
    const t = precioTmp, ahora = new Date().toISOString()
    const filas = [
      ...ENT_TALLAS.map((et, i) => ({ tipo: 'entero', orden: i, etiqueta: et, precio: Number(t.enteroLista[i]) || 0, actualizado_por: userId, actualizado_en: ahora })),
      ...COLA_TALLAS.map((et, i) => ({ tipo: 'cola', orden: i, etiqueta: et, precio: Number(t.colaLista[i]) || 0, actualizado_por: userId, actualizado_en: ahora })),
    ]
    const { error } = await supabase.schema('produccion').from('precio_camaron').upsert(filas, { onConflict: 'tipo,orden' })
    if (error) { setAviso({ tipo: 'error', texto: msgError(error, 'guardar los precios') }); return }
    for (const [clave, valor] of [['rend_entero', t.rendEntero], ['rend_cola', t.rendCola], ['cv_talla', t.cv]]) {
      await supabase.schema('produccion').from('parametro').update({ valor: Number(valor), actualizado_en: ahora }).eq('clave', clave)
    }
    setPrecioOpts({ enteroLista: t.enteroLista.map(Number), colaLista: t.colaLista.map(Number), rendEntero: Number(t.rendEntero), rendCola: Number(t.rendCola), cv: Number(t.cv) })
    setEditPrecio(false); setAviso({ tipo: 'ok', texto: 'Precios de venta actualizados.' })
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
  const sacosSemCalc = lbDiaSel * diasAlim / PARAM.pesoSaco   // consumo estimado de la semana (sin redondear)
  // Ajuste a media semana: lo ya alimentado (días cerrados) no se vuelve a pedir;
  // "por pedir" cuenta solo los días que faltan a la dosis elegida.
  const diasAlimPend = calDias.filter(d => !d.cerrado && d.alimenta).length
  const diasDados = calDias.filter(d => d.cerrado && d.tipo === 'fed').length
  const lbYaAlim = calDias.reduce((t, d) => t + (d.cerrado && d.tipo === 'fed' ? d.lb : 0), 0)
  const lbFaltan = lbDiaSel * diasAlimPend
  const pedir = Math.ceil(lbFaltan / PARAM.pesoSaco)          // requerimiento operativo = solo los días que faltan
  const costoConsumo = sacosSemCalc * (est ? est.alimento.usdSaco : 0)  // consumo estimado × precio (semana)
  const costoCompra = pedir * (est ? est.alimento.usdSaco : 0)          // desembolso de compra (lo que falta)
  const usdSemSel = costoConsumo
  // PEDIDO para la próxima semana: proyección aparte, sobre la biomasa oficial,
  // con los días de alimentación del patrón (estimación, no pedido operativo).
  const lbDiaProx = est ? biomasaSel * est.factorProx * est.planReco.tasaProx / 100 : 0
  const sacosProxPedir = Math.ceil(lbDiaProx * patDiasAlim / PARAM.pesoSaco)
  // Tolvas · capacidad: la biomasa escogida ÷ 10.000 lb por tolva dice cuántas tolvas
  // se necesitan (para agregar o quitar). Cada tolva soporta 10.000 lb de biomasa.
  const tolvasNec = biomasaAsumida > 0 ? Math.ceil(biomasaAsumida / CAP_TOLVA_LB) : 0
  const tolvasAct = (fila && fila.tolvas != null) ? fila.tolvas : null
  const bioPorTolva = (tolvasAct > 0) ? biomasaAsumida / tolvasAct : null
  const faltanTolvas = tolvasAct != null ? tolvasNec - tolvasAct : null
  // Aplicar: solo jefe; deshabilitado en simulación/bloqueado; motivo obligatorio si no es la recomendada.
  const puedeAplicar = finca.rol === 'jefe'
  const aplicarOk = !!(puedeAplicar && estadoPlan && (estadoPlan.k === 'aplicable' || estadoPlan.k === 'confirmar'))
  const requiereMotivo = !esReco
  const yaAplicada = !!(apRec && apRec.fila_pct === celdaAct.fila && apRec.intensidad === celdaAct.inten)
  // Alerta de cambio vs el escenario activo: por DÍA (dosis) y por SEMANA (sacos, que
  // captura también cambios de calendario). El nivel sale del cambio mayor. ≤10% normal
  // · 10–20% confirmar · >20% fuerte. Los deltas quedan en el snapshot.
  // Base de comparación: el plan ACTIVO si existe; si no, la recomendación oficial del motor.
  const recoLbDia = est ? biomasaSel * est.planReco.tasaDia / 100 : 0
  const recoSacosCalc = est ? recoLbDia * diasAlim / PARAM.pesoSaco : 0
  const baseTipo = apRec ? 'plan anterior' : 'recomendación'
  const dosisAnterior = apRec ? Number(apRec.lb_dia) : recoLbDia
  const sacosAnterior = apRec ? Number(apRec.sacos_calc) : recoSacosCalc
  const deltaDia = (dosisAnterior > 0) ? (lbDiaSel - dosisAnterior) / dosisAnterior : null
  const deltaSem = (sacosAnterior > 0) ? (sacosSemCalc - sacosAnterior) / sacosAnterior : null
  const deltaDosis = [deltaDia, deltaSem].filter(d => d != null).reduce((a, b) => (a == null || Math.abs(b) > Math.abs(a) ? b : a), null)
  const nivelCambio = nivelCambioDe(deltaDosis)
  const requiereAprobacion = nivelCambio === 'fuerte'     // >20% → doble aprobación (5.6)
  const faltaMotivo = requiereMotivo && (!motivoCod || (motivoCod === 'otro' && !motivoTxt.trim()))
  const pendSel = pendiente[sel] || null                  // solicitud pendiente de esta piscina/semana
  const soyRemitente = pendSel && pendSel.aplicado_por === userId
  // Planificado vs ejecutado: solo días cerrados y desde que el plan rige (vigenteDesde
  // = fecha de aplicación). Separa ayuno planificado / no planificado / sin registro.
  const planConfirmado = !!(planSel && planSel.confirmada)
  const vigenteDesde = apRec ? String(apRec.aplicado_en).slice(0, 10) : null
  const pve = (apRec && planConfirmado) ? planVsEjecutado({ calDias, planDias: planSel.dias, lbDia: Number(apRec.lb_dia), vigenteDesde }) : null
  const cumplimiento = (pve && pve.planLb > 0) ? pve.ejecLb / pve.planLb : null
  const difSacosPvE = pve ? (pve.ejecLb - pve.planLb) / PARAM.pesoSaco : null
  // Costo REAL ejecutado = Σ(libras × precio_saco de cada registro) / peso — respeta
  // cambios de producto. Planificado = sacos planificados × precio del plan aplicado.
  const plannedPrice = apRec ? (Number(apRec.sacos_calc) > 0 ? Number(apRec.costo_usd) / Number(apRec.sacos_calc) : (est ? est.alimento.usdSaco : 0)) : 0
  const ejecCostPvE = pve ? pve.ejecCostBase / PARAM.pesoSaco : 0
  const difCostPvE = pve ? ejecCostPvE - (pve.planLb / PARAM.pesoSaco) * plannedPrice : null
  const semanaCompleta = semFechas.length === 7 && semFechas[6] < hoy
  const mostrarPvE = !!(pve && pve.dias > 0)
  // 5.4 Rentabilidad: cosechar hoy vs esperar a meta (valor de continuar). Larva = costo hundido.
  const rent = (() => {
    if (!est || !fila || bloqueado || !(biomasaSel > 0)) return null
    const gHoy = fila.gramaje
    const alertaDatos = est.sobrevConsumo > 1.05 ? Math.round(est.sobrevConsumo * 100) : null
    if (gHoy < G_MIN_COMERCIAL) {
      const eC = proyectarAMeta({ gHoy, meta, biomasaActual: biomasaSel, finca: cfg, desempeno: 1 })
      const eO = proyectarAMeta({ gHoy, meta, biomasaActual: biomasaSel, finca: cfg, desempeno: est.desempeno })
      return { noComercial: true, gHoy, metaUsa: eC ? eC.metaUsa : est.metaUsa, diasCurva: eC ? eC.dias : null, diasObs: eO ? eO.dias : null, alertaDatos }
    }
    const pHoy = precioPorGramaje(gHoy, precioOpts)
    const ingresoHoy = biomasaSel * pHoy.mejor
    const prC = proyectarAMeta({ gHoy, meta, biomasaActual: biomasaSel, finca: cfg, desempeno: 1 })
    if (!prC) return { listo: true, gHoy, pHoy, ingresoHoy }
    const prO = proyectarAMeta({ gHoy, meta, biomasaActual: biomasaSel, finca: cfg, desempeno: est.desempeno }) || prC
    const pMeta = precioPorGramaje(prC.metaUsa, precioOpts)
    const brutoMeta = prC.biomasaMeta * pMeta.mejor
    const escen = pr => {
      const costoAlim = pr.alimentoLb / PARAM.pesoSaco * est.alimento.usdSaco
      const costoOper = (cfg.costoHaDia || 0) * fila.area * pr.dias
      const netoMeta = brutoMeta - costoAlim - costoOper
      const valor = netoMeta - ingresoHoy
      return { dias: pr.dias, alimentoSacos: Math.ceil(pr.alimentoLb / PARAM.pesoSaco), costoAlim, costoOper, netoMeta, valor, valorDia: pr.dias > 0 ? valor / pr.dias : 0, fcrMarg: (pr.biomasaMeta - biomasaSel) > 0 ? pr.alimentoLb / (pr.biomasaMeta - biomasaSel) : 0 }
    }
    const curva = escen(prC), obs = escen(prO)
    return {
      listo: false, gHoy, metaUsa: prC.metaUsa, subeEscalon: prC.metaUsa !== Number(meta),
      pHoy, pMeta, ingresoHoy, biomasaMeta: prC.biomasaMeta, brutoMeta,
      curva, obs, mismaDir: (curva.valor >= 0) === (obs.valor >= 0),
      sMetaRef: prC.sobrevMeta, sHoyRef: prC.sobrevHoy, fcrAcum: est.fcrProyectado,
      alertaDatos: est.sobrevConsumo > 1.05 ? Math.round(est.sobrevConsumo * 100) : null,
    }
  })()
  const muestreoDias = (fila && fila.ultMuestreo) ? diasEntre(fila.ultMuestreo, hasta) : null
  const bioTxt = bm ? (bm.difPct <= 0.15 ? `la biomasa es consistente (dif. ${Math.round(bm.difPct * 100)}%)` : `la biomasa difiere ${Math.round(bm.difPct * 100)}% entre consumo y densidad`) : ''
  const porQueTxt = est ? `Está ${est.atrasoProyectado <= 0 ? num1(Math.abs(est.atrasoProyectado)) + ' días adelantada' : num1(est.atrasoProyectado) + ' días atrasada'}, ${bioTxt}, y el FCR ${num2(est.fcrParcial)} ${est.fcrParcial <= est.fcrMax ? 'está por debajo del' : 'supera el'} máximo ${num2(est.fcrMax)}.` : ''

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY, padding: '1.4rem', background: '#eef2f6', minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <div>
          <h1 style={{ fontSize: '21px', fontWeight: 500, margin: '0 0 2px' }}>Estimación · {vista === 'tablero' ? 'Tablero' : 'Por piscina'}</h1>
          <div style={{ fontSize: '12.5px', color: GRIS }}>{finca.nombre} · {vista === 'tablero' ? `${totales.cob} de ${totales.total} con escenario aplicado` : `datos registrados hasta el ${corta(hasta)}`}</div>
        </div>
        <div style={{ display: 'flex', gap: '9px', alignItems: 'center', flexWrap: 'wrap' }}>
          {ciclos.length > 0 && (
            <span role="tablist" aria-label="Vista" style={{ display: 'inline-flex', border: '0.5px solid ' + BORDE, borderRadius: '9px', overflow: 'hidden' }}>
              {['piscina', 'tablero'].map(x => (
                <button key={x} type="button" role="tab" aria-selected={vista === x} onClick={() => setVista(x)} style={{ padding: '7px 13px', fontSize: '12.5px', fontFamily: 'inherit', border: 'none', cursor: 'pointer', fontWeight: vista === x ? 500 : 400, background: vista === x ? AZUL : 'white', color: vista === x ? 'white' : GRIS }}>{x === 'piscina' ? 'Por piscina' : 'Tablero'}</button>
              ))}
            </span>
          )}
          {vista !== 'tablero' && ciclos.length > 0 && (
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
            <button onClick={abrirPrecios} style={{ ...inp, cursor: 'pointer', fontWeight: 500, color: GRIS }} title="Edita la lista de precios de venta (entero/cola)">Precios</button>
            {Object.keys(pendiente).length > 0 && <button onClick={() => setBandeja(b => !b)} style={{ ...inp, cursor: 'pointer', fontWeight: 500, color: bandeja ? AZUL : AMBAR, borderColor: bandeja ? AZUL : '#ecd9b4' }} title="Solicitudes de cambio >20% pendientes de aprobar">Aprobaciones ({Object.keys(pendiente).length})</button>}
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
            <button onClick={() => setEditPat(false)} style={{ ...inp, cursor: 'pointer', padding: '5px 10px', color: GRIS }}>Cerrar</button>
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
          {patronAudit && <div style={{ fontSize: '11px', color: '#9fb0bf', marginTop: '8px' }}>Última edición{patronAudit.nombre ? ' por ' + patronAudit.nombre : ''} · {fechaHora(patronAudit.en)}</div>}
        </div>
      )}

      {editPrecio && precioTmp && (() => {
        const setArr = (campo, i, v) => setPrecioTmp(p => { const a = p[campo].slice(); a[i] = v; return { ...p, [campo]: a } })
        const gPrev = (fila && fila.gramaje) || 28
        const pv = precioPorGramaje(gPrev, { enteroLista: precioTmp.enteroLista.map(Number), colaLista: precioTmp.colaLista.map(Number), rendEntero: Number(precioTmp.rendEntero), rendCola: Number(precioTmp.rendCola), cv: Number(precioTmp.cv) })
        const miniInp = { ...inp, width: '72px', padding: '5px 8px', fontSize: '12px' }
        return (
        <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '14px 16px', marginBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <div style={{ fontSize: '14px', fontWeight: 500 }}>Precios de venta</div>
            <button onClick={() => setEditPrecio(false)} style={{ ...inp, cursor: 'pointer', padding: '5px 10px', color: GRIS }}>Cerrar</button>
          </div>
          <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '12px' }}>
            {[['rendEntero', 'Rend. entero'], ['rendCola', 'Rend. cola'], ['cv', 'Dispersión (CV)']].map(([k, l]) => (
              <label key={k} style={{ fontSize: '12px', color: GRIS, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>{l} <input type="number" step="0.01" value={precioTmp[k]} onChange={e => setPrecioTmp(p => ({ ...p, [k]: e.target.value }))} style={miniInp} /></label>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div>
              <div style={titMini}>Entero · $/kg por pz/kg</div>
              {ENT_TALLAS.map((et, i) => (
                <div key={et} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0', fontSize: '12px' }}><span style={{ color: GRIS }}>{et}</span><input type="number" step="0.01" aria-label={`Precio entero ${et} en dólares por kg`} value={precioTmp.enteroLista[i]} onChange={e => setArr('enteroLista', i, e.target.value)} style={miniInp} /></div>
              ))}
            </div>
            <div>
              <div style={titMini}>Cola · $/lb por pz/lb</div>
              {COLA_TALLAS.map((et, i) => (
                <div key={et} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0', fontSize: '12px' }}><span style={{ color: GRIS }}>{et}</span><input type="number" step="0.01" aria-label={`Precio cola ${et} en dólares por libra`} value={precioTmp.colaLista[i]} onChange={e => setArr('colaLista', i, e.target.value)} style={miniInp} /></div>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '12px', flexWrap: 'wrap' }}>
            <button onClick={guardarPrecios} style={btnAzul}>Guardar precios</button>
            <span style={{ fontSize: '11.5px', color: '#9fb0bf' }}>A {num1(gPrev)} g: entero <b style={{ color: NAVY, fontWeight: 500 }}>{dinero(pv.entero)}/lb</b> · cola <b style={{ color: NAVY, fontWeight: 500 }}>{dinero(pv.cola)}/lb</b> · conviene <b style={{ color: NAVY, fontWeight: 500 }}>{pv.conviene}</b></span>
          </div>
        </div>
        )
      })()}

      {bandeja && Object.keys(pendiente).length > 0 && (
        <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '14px 16px', marginBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div style={{ fontSize: '14px', fontWeight: 500 }}>Aprobaciones pendientes · {corta(lunesDe(hasta))} – {corta(domingoDe(hasta))}</div>
            <button onClick={() => setBandeja(false)} style={{ ...inp, cursor: 'pointer', padding: '5px 10px', color: GRIS }}>Cerrar</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {ciclos.filter(c => pendiente[c.cicloId]).map(c => {
              const r = pendiente[c.cicloId]; const mio = r.aplicado_por === userId
              return (
                <div key={c.cicloId} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', borderRadius: '8px', background: '#f6f9fb', fontSize: '12px' }}>
                  <span style={{ width: '70px', color: NAVY, fontWeight: 500 }}>{c.nombre}</span>
                  <span style={{ flex: 1, color: GRIS }}>{r.fila_pct}% × {cap(intenLbl(r.intensidad))} · {r.sacos_operativos} sacos{r.datos && r.datos.deltaSem != null ? ` · ${r.datos.deltaSem >= 0 ? '+' : ''}${Math.round(r.datos.deltaSem * 100)}% sem` : ''} · {r.aplicado_nombre || '—'}</span>
                  {mio ? <span style={{ color: '#9fb0bf', fontSize: '11px' }}>enviada por ti</span>
                    : <button onClick={() => aprobarPendiente(r)} style={{ ...btnAzul, background: VERDE, padding: '5px 12px' }}>Aprobar</button>}
                  <button onClick={() => { setSel(c.cicloId); setBandeja(false) }} style={{ ...btnLink, fontSize: '11.5px' }}>Ver</button>
                </div>
              )
            })}
          </div>
          <div style={{ fontSize: '11px', color: '#9fb0bf', marginTop: '9px' }}>Para rechazar con motivo, abre la piscina ("Ver"). No puedes aprobar una solicitud que enviaste tú.</div>
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
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <button onClick={() => setMasSel(new Set(confirmables))} style={{ ...inp, cursor: 'pointer', padding: '4px 10px', fontSize: '11.5px', color: AZUL, borderColor: AZUL }}>Seleccionar confirmables</button>
            <button onClick={() => setMasSel(new Set())} style={{ ...inp, cursor: 'pointer', padding: '4px 10px', fontSize: '11.5px', color: GRIS }}>Ninguna</button>
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
                      return <span key={i} role="img" aria-label={diaDescripcion(d)} title={diaDescripcion(d)}
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
            Confirmar <b style={{ fontWeight: 500 }}>{nSel}</b> {nSel === 1 ? 'piscina' : 'piscinas'} · <b style={{ fontWeight: 500 }}>{diasSel}</b> días alimentados{bloqueadas.length > 0 && <span style={{ color: ROJO }}> · {bloqueadas.length} {bloqueadas.length === 1 ? 'requiere registro pendiente' : 'requieren registros pendientes'}</span>}
          </div>
          {bloqueadas.length > 0 && <div style={{ fontSize: '11px', color: '#9a7636', marginBottom: '9px' }}>Pendientes: {bloqueadas.map(m => m.f.nombre).join(', ')}</div>}
          <button onClick={confirmarMasivo} disabled={nSel === 0} style={{ ...btnAzul, opacity: nSel === 0 ? 0.5 : 1, cursor: nSel === 0 ? 'default' : 'pointer' }}>{nSel === 1 ? 'Confirmar 1 piscina' : `Confirmar ${nSel} piscinas`}</button>
        </div>
        )
      })()}

      {cargando ? (
        <Caja><Centro>Cargando…</Centro></Caja>
      ) : vista === 'tablero' ? (
        <TableroView tablero={tablero} totales={totales} pedidoNeto={pedidoNeto} invCorte={invCorte} reservaDias={reservaDias} filtro={filtro} setFiltro={setFiltro} hasta={hasta} finca={finca} pendientes={Object.keys(pendiente).length}
          onVer={id => { setSel(id); setVista('piscina'); setDesdeTablero(true) }} />
      ) : !fila ? (
        <Caja><Centro>No hay piscinas con muestreo de gramaje en esta finca a la fecha.<br />
          <span style={{ fontSize: '12px' }}>Registra el gramaje en el módulo Gramaje para que salga la estimación.</span>
        </Centro></Caja>
      ) : (
      <>
        {desdeTablero && (
          <button onClick={() => setVista('tablero')} style={{ ...inp, cursor: 'pointer', color: AZUL, borderColor: BORDE, marginBottom: '12px' }}>‹ Volver al tablero</button>
        )}
        {vald && !valdOk && vig && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '9px', background: '#FBF5E9', border: '0.5px solid #ecd9b4', borderRadius: '10px', padding: '10px 14px', marginBottom: '10px', fontSize: '12.5px', color: AMBAR }}>
            <span>⏱</span><span>La validación manual venció: <b>{vig.motivos.join(' · ')}</b>. Se usa la biomasa por consumo; vuelve a validar si corresponde.</span>
          </div>
        )}
        {pendSel && (
          <div style={{ background: '#FBF5E9', border: '0.5px solid #ecd9b4', borderRadius: '10px', padding: '11px 14px', marginBottom: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '9px' }}>
              <span style={{ color: AMBAR, fontSize: '15px', lineHeight: 1.3 }}>⏳</span>
              <div style={{ flex: 1, fontSize: '12.5px', color: '#854F0B', lineHeight: 1.55 }}>
                <b style={{ fontWeight: 500 }}>Solicitud pendiente de aprobación</b> · {pendSel.fila_pct}% × {cap(intenLbl(pendSel.intensidad))} · {miles(Number(pendSel.lb_dia))} lb/día · {pendSel.sacos_operativos} sacos · enviada por {pendSel.aplicado_nombre || '—'} {fechaHora(pendSel.aplicado_en)}.
                {pendSel.datos && (pendSel.datos.deltaDia != null || pendSel.datos.deltaSem != null) && <span> Cambio {pendSel.datos.deltaDia != null ? (pendSel.datos.deltaDia >= 0 ? '+' : '') + Math.round(pendSel.datos.deltaDia * 100) + '% dosis' : ''}{pendSel.datos.deltaSem != null ? ' · ' + (pendSel.datos.deltaSem >= 0 ? '+' : '') + Math.round(pendSel.datos.deltaSem * 100) + '% semana' : ''}.</span>}
                {pendSel.motivo_codigo && <div style={{ color: '#9a7636' }}>Motivo: {cap((MOTIVOS.find(m => m[0] === pendSel.motivo_codigo) || [])[1] || pendSel.motivo_codigo)}{pendSel.motivo_eleccion ? ' · ' + pendSel.motivo_eleccion : ''}</div>}
                {soyRemitente ? (
                  <div style={{ color: '#9fb0bf', marginTop: '4px' }}>Enviada por ti · esperando a un segundo jefe. El plan anterior sigue vigente; los botones de decisión están bloqueados para quien la envió.</div>
                ) : puedeAplicar ? (
                  rechazando === pendSel.id ? (
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '6px' }} role="radiogroup" aria-label="Motivo del rechazo">
                        {MOTIVOS_RECHAZO.map(([c, l]) => <button key={c} type="button" role="radio" aria-checked={rechCod === c} onClick={() => setRechCod(c)} style={{ fontFamily: 'inherit', fontSize: '11px', padding: '4px 9px', borderRadius: '20px', cursor: 'pointer', border: '1px solid ' + (rechCod === c ? ROJO : BORDE), background: rechCod === c ? '#FBEAEA' : 'white', color: rechCod === c ? ROJO : NAVY }}>{l}</button>)}
                      </div>
                      <input value={rechTxt} onChange={e => setRechTxt(e.target.value)} placeholder="Comentario (opcional)" style={{ ...inp, width: '100%', marginBottom: '6px' }} />
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button onClick={() => rechazarPendiente(pendSel)} style={{ ...btnAzul, background: ROJO }}>Confirmar rechazo</button>
                        <button onClick={() => { setRechazando(null); setRechCod('') }} style={{ ...inp, cursor: 'pointer', color: GRIS }}>Cancelar</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                      <button onClick={() => aprobarPendiente(pendSel)} style={{ ...btnAzul, background: VERDE }}>Aprobar</button>
                      <button onClick={() => { setRechazando(pendSel.id); setRechCod(''); setRechTxt('') }} style={{ ...inp, cursor: 'pointer', color: ROJO, borderColor: '#e7cccb' }}>Rechazar</button>
                    </div>
                  )
                ) : null}
              </div>
            </div>
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
              <Linea k="Crecimiento observado · reciente (g/día)" v={num2(est.gDiaObs)} fuerte />
              <Linea k="Crecimiento lineal · desde siembra (g/día)" v={num2(fila.dias > 0 ? fila.gramaje / fila.dias : 0)} />
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

            {/* Comparador de ventana de consumo: 7 / 14 / 21 días, plano (incluye ayunos),
                como el Excel. La columna elegida es la oficial que alimenta dosis y sacos. */}
            {ventanas.length > 0 && (
              <div style={{ borderTop: '0.5px solid #eef3f7', marginTop: '13px', paddingTop: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '9px', flexWrap: 'wrap', gap: '6px' }}>
                  <span style={{ fontSize: '12.5px', fontWeight: 500, color: NAVY }}>Ventana de consumo</span>
                  <span style={{ fontSize: '11px', color: '#9fb0bf' }}>Promedio plano, incluye ayunos · elige la oficial</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1.2fr repeat(3, 1fr)', gap: '0', fontSize: '12px', border: '0.5px solid ' + BORDE, borderRadius: '9px', overflow: 'hidden' }}>
                  <span style={{ ...celComp, color: '#9fb0bf', fontSize: '11px', background: '#f6f9fb' }}>Días</span>
                  {ventanas.map(w => {
                    const on = w.n === ventanaDias
                    return (
                      <button key={w.n} onClick={() => { if (!celda) elegirCelda(celdaAct.fila, celdaAct.inten); setVentanaDias(w.n) }} title={`Usar la ventana de ${w.n} días como oficial`}
                        style={{ ...celComp, textAlign: 'center', cursor: 'pointer', fontWeight: on ? 600 : 500, color: on ? AZUL : NAVY, background: on ? '#e8f1fb' : '#f6f9fb', border: 'none', borderLeft: '0.5px solid ' + BORDE, fontFamily: 'inherit', fontSize: '12.5px' }}>
                        {w.n}d{on && ' ✓'}
                      </button>
                    )
                  })}
                  <span style={{ ...celComp, color: GRIS }}>Consumo (lb/día)</span>
                  {ventanas.map(w => <span key={w.n} style={{ ...celComp, textAlign: 'center', borderLeft: '0.5px solid #eef3f7', fontWeight: w.n === ventanaDias ? 600 : 400, color: w.n === ventanaDias ? NAVY : GRIS }}>{miles(w.dia)}</span>)}
                  <span style={{ ...celComp, color: GRIS }}>Biomasa por consumo</span>
                  {ventanas.map(w => <span key={w.n} style={{ ...celComp, textAlign: 'center', borderLeft: '0.5px solid #eef3f7', fontWeight: w.n === ventanaDias ? 600 : 400, color: w.n === ventanaDias ? AZUL : GRIS }}>{miles(w.bio)}</span>)}
                  <span style={{ ...celComp, color: GRIS }}>Sobrevivencia</span>
                  {ventanas.map(w => <span key={w.n} style={{ ...celComp, textAlign: 'center', borderLeft: '0.5px solid #eef3f7', fontWeight: w.n === ventanaDias ? 600 : 400, color: w.n === ventanaDias ? NAVY : GRIS }}>{pct0(w.sobrev)}</span>)}
                  <span style={{ ...celComp, color: '#9fb0bf', fontSize: '10.5px' }}>Ayunos / sin dato</span>
                  {ventanas.map(w => <span key={w.n} style={{ ...celComp, textAlign: 'center', borderLeft: '0.5px solid #eef3f7', fontSize: '10.5px', color: '#9fb0bf' }}>{w.ayuno} / {w.falt}</span>)}
                </div>
              </div>
            )}
            {/* Supuesto de biomasa 100/90/80/70: indicadores por supuesto. La columna
                elegida enlaza con la fila de la matriz de dosis (misma vista previa). */}
            {supuestos.length > 0 && (
              <div style={{ borderTop: '0.5px solid #eef3f7', marginTop: '13px', paddingTop: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '9px', flexWrap: 'wrap', gap: '6px' }}>
                  <span style={{ fontSize: '12.5px', fontWeight: 500, color: NAVY }}>Supuesto de biomasa</span>
                  <span style={{ fontSize: '11px', color: '#9fb0bf' }}>% de la oficial · la columna elegida manda en la dosis</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1.35fr repeat(4, 1fr)', border: '0.5px solid ' + BORDE, borderRadius: '9px', overflow: 'hidden', fontSize: '12px' }}>
                  <span style={{ ...celComp, background: '#f6f9fb', color: '#9fb0bf', fontSize: '10.5px' }}>Indicador</span>
                  {supuestos.map(s => {
                    const on = s.p === celdaAct.fila
                    return (
                      <button key={s.p} onClick={() => elegirCelda(s.p, celdaAct.inten)} title={`Usar el supuesto de ${s.p}% en la dosis`}
                        style={{ ...celComp, textAlign: 'center', cursor: 'pointer', border: 'none', borderLeft: '0.5px solid ' + BORDE, background: on ? '#e8f1fb' : '#f6f9fb', fontFamily: 'inherit' }}>
                        <span style={{ fontWeight: on ? 600 : 500, fontSize: '12.5px', color: on ? AZUL : NAVY }}>{s.p}%</span>
                        <span style={{ display: 'block', fontSize: '10px', color: on ? AZUL : '#9fb0bf' }}>{s.p === 100 ? 'oficial' : 'conservador'}</span>
                      </button>
                    )
                  })}
                  {[['Biomasa (lb)', s => miles(s.bio)], ['Sobrevivencia', s => pct0(s.sob)], ['Biomasa por hectárea', s => miles(s.ha)], ['FCR parcial', s => s.fcr > 0 ? num2(s.fcr) : '—']].map(([lbl, fn]) => (
                    <Fragment key={lbl}>
                      <span style={{ ...celComp, color: GRIS, borderTop: '0.5px solid #eef3f7' }}>{lbl}</span>
                      {supuestos.map(s => {
                        const on = s.p === celdaAct.fila
                        return <span key={s.p} style={{ ...celComp, textAlign: 'center', borderTop: '0.5px solid #eef3f7', borderLeft: '0.5px solid #eef3f7', fontWeight: on ? 600 : 400, color: on ? NAVY : GRIS }}>{fn(s)}</span>
                      })}
                    </Fragment>
                  ))}
                </div>
                {densRef && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', padding: '9px 11px', background: '#fff8ec', borderRadius: '9px', fontSize: '11.5px', color: '#8a6d2f', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 500 }}>Densidad (tabla):</span>
                    <span>{miles(densRef.bio)} lb · {miles(densRef.ha)} lb/ha · sobrev. {pct0(densRef.sob)} · FCR {densRef.fcr > 0 ? num2(densRef.fcr) : '—'} — {Math.round(densRef.pctDeConsumo * 100)}% de la de consumo</span>
                  </div>
                )}
              </div>
            )}

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

          <div style={{ fontSize: '10.5px', color: '#9fb0bf', margin: '0 2px 7px' }}>1 · Elige el escenario — fila: supuesto de biomasa · columna: intensidad</div>
          <Matriz oficial={biomasaSel} plan={est.plan} pesoSaco={PARAM.pesoSaco} dias={diasAlim} recoFila={recoFila} recoInten={recoInten} hayReco={hayReco} sel={celdaAct} onSel={(f, k) => elegirCelda(f, k)} />
          <div style={{ fontSize: '11px', color: '#9fb0bf', margin: '9px 2px 14px', lineHeight: 1.5 }}>
            Recomendada {hayReco ? `(100% · ${cap(intenLbl(recoInten))})` : '— sin recomendación hasta validar'} · ● Tu elección · 100% = biomasa oficial, 90/80/70 = supuesto conservador
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
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', borderTop: '0.5px solid #e3ecf2', marginTop: '7px', paddingTop: '8px' }}>
                <div style={{ background: '#eef2f6', borderRadius: '9px', padding: '9px 11px' }}>
                  <div style={{ fontSize: '10.5px', color: GRIS }}>Por día</div>
                  <div style={{ fontSize: '18px', fontWeight: 500, color: NAVY }}>{num1(lbDiaSel / PARAM.pesoSaco)} <span style={{ fontSize: '11px', color: GRIS }}>sacos</span></div>
                  <div style={{ fontSize: '10.5px', color: '#9fb0bf' }}>{miles(lbDiaSel)} lb</div>
                </div>
                <div style={{ background: '#eef2f6', borderRadius: '9px', padding: '9px 11px' }}>
                  <div style={{ fontSize: '10.5px', color: GRIS }}>Semana · {diasAlim} días</div>
                  <div style={{ fontSize: '18px', fontWeight: 500, color: NAVY }}>{num1(sacosSemCalc)} <span style={{ fontSize: '11px', color: GRIS }}>sacos</span></div>
                  <div style={{ fontSize: '10.5px', color: '#9fb0bf' }}>{miles(lbDiaSel * diasAlim)} lb</div>
                </div>
              </div>
              <div style={{ borderTop: '0.5px solid #e3ecf2', marginTop: '8px', paddingTop: '6px' }}>
                <Row k="Por pedir (lo que falta)" v={pedir + ' sacos'} fuerte azul />
                <Row k="Costo de consumo" v={dinero(costoConsumo)} />
                <Row k={`Desembolso de compra (${pedir})`} v={dinero(costoCompra)} />
              </div>
              <div style={{ fontSize: '11px', color: GRIS, marginTop: '9px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <span style={{ background: '#eef2f6', borderRadius: '6px', padding: '2px 8px' }}>Próxima semana</span> requerimiento estimado {sacosProxPedir} sacos · patrón de {patDiasAlim} días sin confirmar.
              </div>
            </div>

            {/* Tolvas · capacidad: biomasa escogida ÷ 10.000 lb por tolva → cuántas tolvas */}
            <div style={{ background: '#f6f9fb', borderRadius: '9px', padding: '13px 15px' }}>
              <div style={titMini}>Tolvas · capacidad</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12.5px', padding: '3px 0' }}>
                <span style={{ color: GRIS }}>Biomasa escogida ({celdaAct.fila}%)</span>
                <b style={{ fontWeight: 500 }}>{miles(biomasaAsumida)} lb</b>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12.5px', padding: '3px 0' }}>
                <span style={{ color: GRIS }}>Capacidad por tolva</span>
                <span>{miles(CAP_TOLVA_LB)} lb</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12.5px', padding: '3px 0' }}>
                <span style={{ color: GRIS }}>Tolvas actuales</span>
                {editTolvas ? (
                  <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                    <input autoFocus type="number" min="0" value={tolvasTxt} onChange={e => setTolvasTxt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') guardarTolvas() }} style={{ ...inp, width: '56px' }} />
                    <button onClick={guardarTolvas} style={btnAzul}>Ok</button>
                  </span>
                ) : (
                  <span style={{ display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
                    <b style={{ fontWeight: 500 }}>{tolvasAct != null ? tolvasAct : '—'}</b>
                    {esJefe && <span onClick={() => { setTolvasTxt(tolvasAct != null ? String(tolvasAct) : ''); setEditTolvas(true) }} style={{ color: AZUL, cursor: 'pointer', fontSize: '11.5px' }}>{tolvasAct != null ? 'editar' : 'configurar'}</span>}
                  </span>
                )}
              </div>
              {bloqueado ? (
                <div style={{ background: '#FBF5E9', borderRadius: '9px', padding: '11px 13px', marginTop: '8px', fontSize: '11.5px', color: '#9a7636' }}>Valida la biomasa para ver la capacidad.</div>
              ) : (() => {
                const falta = faltanTolvas != null && faltanTolvas > 0
                const bgc = tolvasAct == null ? '#eef2f6' : falta ? '#FBF5E9' : '#e7f6ef'
                const txtc = tolvasAct == null ? GRIS : falta ? '#854F0B' : '#2f6b55'
                const estado = tolvasAct == null ? 'Configura las tolvas actuales'
                  : falta ? `Agrega ${faltanTolvas} tolva${faltanTolvas > 1 ? 's' : ''}`
                  : faltanTolvas < 0 ? `OK · te sobran ${-faltanTolvas}` : `OK · tienes ${tolvasAct}`
                return (
                  <div style={{ background: bgc, borderRadius: '9px', padding: '11px 13px', textAlign: 'center', marginTop: '8px' }}>
                    <div style={{ fontSize: '11px', color: txtc }}>Necesitas</div>
                    <div style={{ fontSize: '24px', fontWeight: 500, color: NAVY }}>{tolvasNec} <span style={{ fontSize: '12px', color: GRIS }}>tolvas</span></div>
                    <div style={{ fontSize: '11.5px', color: txtc, fontWeight: 500 }}>{estado}</div>
                    {bioPorTolva != null && <div style={{ fontSize: '10.5px', color: '#9fb0bf', marginTop: '2px' }}>hoy: {miles(bioPorTolva)} lb por tolva ({bioPorTolva > CAP_TOLVA_LB ? 'sobre' : 'bajo'} {miles(CAP_TOLVA_LB)})</div>}
                  </div>
                )
              })()}
            </div>
          </div>

          {/* 2 · Así se alimentaría la semana (libras por día). Lo pasado = ejecución real
              (candado); lo futuro, la dosis elegida. El pedido cuenta solo lo que falta. */}
          <div style={{ background: '#f6f9fb', borderRadius: '9px', padding: '12px 14px', margin: '14px 0 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
              <div style={{ ...titMini, marginBottom: 0 }}>2 · Así se alimentaría la semana</div>
              <span style={{ fontSize: '11px', color: GRIS }}>{diasAlim} de 7 días · {miles(lbDiaSel)} lb/día{calEditable ? ' · toca un día futuro para ponerlo en ayuno' : ''}</span>
            </div>
            <Calendario dias={calDias} editable={calEditable} onToggle={toggleDia} lbDia={lbDiaSel} hoy={hoy} />
            {haySinRegistro && <div style={{ fontSize: '11.5px', color: ROJO, marginTop: '8px', background: '#FBEAEA', borderRadius: '8px', padding: '7px 10px' }}>Hay días pasados sin registro — resuélvelos en Registro diario.</div>}
            {diasDados > 0 && (
              <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '11px', fontSize: '11.5px', color: GRIS }}>
                <span>Ya alimentado: <b style={{ fontWeight: 500, color: NAVY }}>{miles(lbYaAlim)} lb</b> ({diasDados} día{diasDados === 1 ? '' : 's'})</span>
                <span>Falta: <b style={{ fontWeight: 500, color: NAVY }}>{miles(lbFaltan)} lb</b> ({diasAlimPend} día{diasAlimPend === 1 ? '' : 's'})</span>
                <span>Por pedir: <b style={{ fontWeight: 500, color: AZUL }}>{pedir} sacos</b></span>
              </div>
            )}
            {semanaPasada && <div style={{ fontSize: '11px', color: '#9fb0bf', marginTop: '8px' }}>Semana pasada · solo lectura.</div>}
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
                  <b>Cambio vs la {baseTipo}.</b>
                  {deltaDia != null && <> Dosis {deltaDia >= 0 ? '+' : ''}{Math.round(deltaDia * 100)}% ({miles(lbDiaSel)} vs {miles(dosisAnterior)} lb/día).</>}
                  {deltaSem != null && <> Semana {deltaSem >= 0 ? '+' : ''}{Math.round(deltaSem * 100)}% ({num1(sacosSemCalc)} vs {num1(sacosAnterior)} sacos).</>}
                  {nivelCambio === 'fuerte' && <div style={{ marginTop: '5px' }}>Mayor al 20%: requiere <b>aprobación de un segundo jefe</b> antes de activarse.</div>}
                </div>
              )}
              {requiereMotivo && (() => {
                const otroVacio = motivoCod === 'otro' && !motivoTxt.trim()
                return (
                <div style={{ marginBottom: '10px' }}>
                  <div style={{ fontSize: '11.5px', color: AMBAR, marginBottom: '6px' }}>Elegiste un escenario distinto al recomendado{pidiendoMotivo && faltaMotivo ? ' — elige el motivo para continuar' : ''}. Queda en el historial:</div>
                  <div role="radiogroup" aria-label="Motivo del cambio" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                    {MOTIVOS.map(([cod, lbl]) => (
                      <button key={cod} type="button" role="radio" aria-checked={motivoCod === cod} onClick={() => setMotivoCod(cod)}
                        style={{ fontFamily: 'inherit', fontSize: '11.5px', padding: '5px 10px', borderRadius: '20px', cursor: 'pointer', border: '1px solid ' + (motivoCod === cod ? AZUL : BORDE), background: motivoCod === cod ? '#e8f1fb' : 'white', color: motivoCod === cod ? AZUL : NAVY, fontWeight: motivoCod === cod ? 500 : 400 }}>{lbl}</button>
                    ))}
                  </div>
                  <div style={{ fontSize: '11px', color: motivoCod === 'otro' ? (otroVacio ? ROJO : NAVY) : GRIS, marginBottom: '3px' }}>{motivoCod === 'otro' ? 'Comentario obligatorio' : 'Comentario opcional'}</div>
                  <input value={motivoTxt} onChange={e => setMotivoTxt(e.target.value)} placeholder={motivoCod === 'otro' ? 'Describe el motivo' : 'Comentario o evidencia'} style={{ ...inp, width: '100%', borderColor: otroVacio && pidiendoMotivo ? ROJO : BORDE }} />
                  {otroVacio && pidiendoMotivo && <div style={{ fontSize: '11px', color: ROJO, marginTop: '4px' }}>Escribe el motivo para "Otro".</div>}
                </div>
                )
              })()}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                <button onClick={aplicarEscenario} disabled={!aplicarOk || faltaMotivo} style={{ ...btnAzul, opacity: (!aplicarOk || faltaMotivo) ? 0.5 : 1, cursor: (!aplicarOk || faltaMotivo) ? 'default' : 'pointer' }}>
                  {requiereAprobacion ? 'Enviar a aprobación' : apRec ? 'Reemplazar escenario aplicado' : 'Aplicar este escenario'}
                </button>
                <span style={{ fontSize: '11.5px', color: '#9fb0bf' }}>
                  {!aplicarOk ? 'No se puede aplicar en simulación o bloqueado.' : faltaMotivo ? 'Elige el motivo del cambio.' : requiereAprobacion ? 'Cambio >20%: lo revisa y aprueba un segundo jefe.' : esReco ? 'Es la combinación recomendada por el sistema.' : 'Al aplicar se guarda la decisión, el motivo, quién la aplicó y el calendario de la semana.'}
                </span>
              </div>
            </div>
          ) : null)}

          <div style={{ fontSize: '12.5px', color: GRIS, marginTop: '13px' }}>Alimento: <b style={{ color: NAVY, fontWeight: 500 }}>{est.alimento.nombre}</b> · {dinero(est.alimento.usdSaco)} el saco</div>
        </Caja>

        {mostrarPvE && (
          <div style={{ marginTop: '14px' }}><Caja>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
              <Titulo sinMargen>Planificado vs ejecutado{semanaCompleta ? '' : ' · a la fecha'}</Titulo>
              {cumplimiento != null && <span style={{ fontSize: '11.5px', fontWeight: 500, color: cumColor(cumplimiento), background: cumColor(cumplimiento) + '18', borderRadius: '20px', padding: '3px 10px' }}>Cumplimiento {Math.round(cumplimiento * 100)}% · {cumplimiento >= 1 ? 'exceso' : 'déficit'}</span>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '11px' }}>
              <Mini k="Planificado a la fecha" v={`${miles(pve.planLb)} lb`} />
              <Mini k="Alimentado a la fecha" v={`${miles(pve.ejecLb)} lb`} />
              <Mini k="Diferencia" v={`${difSacosPvE >= 0 ? '+' : ''}${num1(difSacosPvE)} sacos`} />
              <Mini k="Diferencia costo" v={`${difCostPvE >= 0 ? '+' : ''}${dinero(difCostPvE)}`} />
            </div>
            <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '12px', fontSize: '12px', color: GRIS }}>
              <span>Ayunos no planificados: <b style={{ color: pve.ayNoPlan > 0 ? AMBAR : NAVY, fontWeight: 500 }}>{pve.ayNoPlan}</b></span>
              <span>Días sin registro: <b style={{ color: pve.sinReg > 0 ? ROJO : NAVY, fontWeight: 500 }}>{pve.sinReg}</b></span>
              <span>Alimentó pese a ayuno planificado: <b style={{ color: pve.fedExtra > 0 ? AMBAR : NAVY, fontWeight: 500 }}>{pve.fedExtra}</b></span>
              <span>Ayunos planificados: <b style={{ color: NAVY, fontWeight: 500 }}>{pve.ayPlan}</b></span>
            </div>
            <div style={{ fontSize: '11px', color: '#9fb0bf', marginTop: '10px', lineHeight: 1.5 }}>
              Plan vigente desde {corta(vigenteDesde)}{apRec.aplicado_nombre ? ', aplicado por ' + apRec.aplicado_nombre : ''} · {pve.dias} día(s) comparados. Costo ejecutado real (precio de cada registro, respeta cambios de producto): {dinero(ejecCostPvE)}.
            </div>
          </Caja></div>
        )}

        {rent && (
          <div style={{ marginTop: '14px' }}><Caja>
            <Titulo>Rentabilidad · cosechar hoy vs esperar a meta</Titulo>
            {rent.noComercial ? (<>
              {rent.alertaDatos && <div style={{ fontSize: '11.5px', color: ROJO, background: '#FBEAEA', borderRadius: '8px', padding: '8px 11px', marginBottom: '10px' }}>Sobrevivencia por consumo {rent.alertaDatos}% ({'>'}100%): la biomasa por consumo parece alta. Revisa los datos.</div>}
              <div style={{ fontSize: '12.5px', color: '#4a5a67' }}>Aún no es cosechable ({num1(rent.gHoy)} g · mínimo comercial {G_MIN_COMERCIAL} g). Sigue en engorde; todavía no tiene sentido comparar contra cosechar hoy.</div>
              <div style={{ fontSize: '12px', color: GRIS, marginTop: '8px' }}>Proyección referencial de engorde a {num1(rent.metaUsa)} g: <b style={{ color: NAVY, fontWeight: 500 }}>{rent.diasCurva != null ? rent.diasCurva + ' días' : '—'}</b> según curva · <b style={{ color: NAVY, fontWeight: 500 }}>{rent.diasObs != null ? rent.diasObs + ' días' : '—'}</b> según ritmo observado.</div>
              <div style={{ fontSize: '11px', color: '#9fb0bf', marginTop: '7px' }}>Sin comparación económica y fuera del "valor de continuar" de la finca hasta alcanzar talla comercial.</div>
            </>) : rent.listo ? (
              <div style={{ fontSize: '12.5px', color: '#4a5a67' }}>Ya está en talla de cosecha ({num1(rent.gHoy)} g). Ingreso estimado hoy: <b style={{ color: NAVY, fontWeight: 500 }}>{dinero(rent.ingresoHoy)}</b> ({cap(rent.pHoy.conviene)} a {dinero(rent.pHoy.mejor)}/lb).</div>
            ) : (<>
              {rent.alertaDatos && <div style={{ fontSize: '11.5px', color: ROJO, background: '#FBEAEA', borderRadius: '8px', padding: '8px 11px', marginBottom: '10px' }}>Sobrevivencia por consumo {rent.alertaDatos}% ({'>'}100%): la biomasa por consumo parece alta. Revisa los datos antes de decidir; esta rentabilidad es referencial.</div>}
              {rent.subeEscalon && <div style={{ fontSize: '11.5px', color: AMBAR, margin: '0 0 10px' }}>Meta de {num1(meta)} g ya alcanzada ({num1(rent.gHoy)} g); se evalúa el siguiente escalón de {num1(rent.metaUsa)} g.</div>}
              <div style={{ background: '#f6f9fb', borderRadius: '9px', padding: '12px 14px', fontSize: '12.5px', marginBottom: '12px' }}>
                <div style={titMini}>Cosechar hoy · {num1(rent.gHoy)} g</div>
                <Row k="Biomasa oficial" v={miles(biomasaSel) + ' lb (' + cap(fuenteUsada) + ')'} />
                <Row k={`Precio ${rent.pHoy.conviene} · ingreso hoy`} v={dinero(rent.ingresoHoy)} fuerte />
                <Row k={`Esperar a meta ${num1(rent.metaUsa)} g · biomasa proyectada`} v={miles(rent.biomasaMeta) + ' lb'} top />
                <Row k={`Bruto a meta (${rent.pMeta.conviene} ${dinero(rent.pMeta.mejor)}/lb)`} v={dinero(rent.brutoMeta)} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '10px' }}>
                {[['Según curva biológica', rent.curva], ['Ritmo observado (curva diaria)', rent.obs]].map(([lbl, e]) => (
                  <div key={lbl} style={{ background: e.valor >= 0 ? '#e7f6ef' : '#FBF5E9', border: '0.5px solid ' + (e.valor >= 0 ? '#bfe6d2' : '#ecd9b4'), borderRadius: '9px', padding: '11px 13px' }}>
                    <div style={{ fontSize: '11px', color: '#9fb0bf', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: '5px' }}>{lbl} · {e.dias} días</div>
                    <div style={{ fontSize: '14px', fontWeight: 500, color: e.valor >= 0 ? VERDE : AMBAR }}>{e.valor >= 0 ? 'Esperar · +' : 'Cosechar · '}{dinero(e.valor)}</div>
                    <div style={{ fontSize: '11.5px', color: GRIS }}>{dinero(e.valorDia)}/día · alimento {e.alimentoSacos} sacos · FCR marg. {num2(e.fcrMarg)}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: '12px', color: rent.mismaDir ? (rent.curva.valor >= 0 ? VERDE : AMBAR) : AMBAR, marginBottom: '8px' }}>
                {rent.mismaDir
                  ? `En ambos escenarios ${rent.curva.valor >= 0 ? 'conviene esperar' : 'conviene cosechar'}.`
                  : 'Depende del ritmo: la curva biológica favorece esperar, pero al ritmo observado conviene cosechar. Decidir según qué tan real sea el crecimiento reciente.'}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: '9px', marginTop: '6px', fontSize: '12px', color: GRIS }}>
                <span>FCR acumulado a meta: <b style={{ color: NAVY, fontWeight: 500 }}>{num2(rent.fcrAcum)}</b></span>
                <span>Mortalidad de referencia (densidad): <b style={{ color: NAVY, fontWeight: 500 }}>{pct0(rent.sHoyRef)} → {pct0(rent.sMetaRef)}</b></span>
              </div>
              <div style={{ fontSize: '11px', color: '#9fb0bf', marginTop: '9px', lineHeight: 1.5 }}>Alimento futuro proyectado día a día con la curva del motor. Dos horizontes: "curva biológica" (ritmo objetivo) y "ritmo observado" (tu desempeño reciente aplicado a la curva diaria). Puede diferir unos días del "días restantes" de arriba, que es un estimado lineal; aquí se acumula día a día. La biomasa parte de la <b>oficial</b> ({cap(fuenteUsada)}); la mortalidad a futuro es una <b>curva de referencia por densidad</b>, no la sobrevivencia por consumo. Larva = costo hundido. Precios: lista AQUAGOLD · CV {Math.round((precioOpts.cv ?? CV_DEF) * 100)}% · rend. entero {Math.round((precioOpts.rendEntero ?? REND_ENTERO_DEF) * 100)}% · cola {Math.round((precioOpts.rendCola ?? REND_COLA_DEF) * 100)}%. No incluye variación de precio, mortalidad extraordinaria ni costos de cosecha/transporte.</div>
            </>)}
          </Caja></div>
        )}
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

const cardMini = { background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '10px', padding: '10px 12px' }
// Vista Tablero: todas las piscinas + totales en dos niveles + filtros. Solo lectura
// (las acciones se hacen al abrir la piscina).
function TableroView({ tablero, totales, pedidoNeto, invCorte, reservaDias, filtro, setFiltro, hasta, finca, pendientes, onVer }) {
  const [exp, setExp] = useState(null)
  const [expP, setExpP] = useState(null)
  const netoTotal = pedidoNeto.reduce((t, p) => t + p.neto, 0)
  const desembolsoNeto = pedidoNeto.reduce((t, p) => t + p.desembolso, 0)
  // Asistente (5.7): resumen en lenguaje natural a partir de las reglas (no decide).
  const nombres = (arr, n = 4) => arr.length <= n ? arr.join(', ') : arr.slice(0, n).join(', ') + ` y ${arr.length - n} más`
  const bloqNom = tablero.filter(r => r.bloqueado).map(r => r.f.nombre)
  const sinEscNom = tablero.filter(r => !r.ap && !r.bloqueado).map(r => r.f.nombre)
  const cosecharNom = tablero.filter(r => r.rent && !r.rent.listo && !r.rent.noComercial && r.rent.valor < 0).map(r => r.f.nombre)
  const resumen = []
  resumen.push(`${totales.nConf} de ${totales.total} piscinas con plan confirmado${totales.sinEsc ? ` · ${totales.sinEsc} sin escenario aplicado` : ''}.`)
  if (netoTotal > 0) resumen.push(`Pedido neto de la semana: ${netoTotal} sacos (desembolso ${dinero(desembolsoNeto)}).`)
  else resumen.push('Pedido neto cubierto con inventario esta semana.')
  resumen.push(`Rentabilidad: ${totales.esperarN} conviene esperar, ${totales.cosecharN} conviene cosechar · valor de continuar ${totales.valorCont >= 0 ? '+' : ''}${dinero(totales.valorCont)}.`)
  if (totales.bloq || totales.desv) resumen.push(`Atención: ${totales.bloq} bloqueada(s)${totales.desv ? ` · ${totales.desv} con desviación >10%` : ''}.`)
  if (pendientes) resumen.push(`${pendientes} solicitud(es) de cambio >20% pendiente(s) de aprobación.`)
  const acciones = []
  if (bloqNom.length) acciones.push(`Validar biomasa: ${nombres(bloqNom)}.`)
  if (cosecharNom.length) acciones.push(`Evaluar cosecha: ${nombres(cosecharNom)}.`)
  if (sinEscNom.length) acciones.push(`Aplicar escenario: ${nombres(sinEscNom)}.`)
  const fechaHoraCorta = iso => { try { return new Date(iso).toLocaleString('es-EC', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) } catch { return corta(iso) } }
  const estProd = { pedir: ['Pedir', AZUL], cubierto: ['Cubierto', VERDE], falta: ['Dato faltante', AMBAR] }
  const FILTROS = [['todas', 'Todas'], ['pendientes', 'Pendientes'], ['confirmar', 'Confirmar'], ['simbloq', 'Simulación / bloqueadas'], ['desv', 'Con desviación']]
  const pasa = r => filtro === 'todas' ? true : filtro === 'pendientes' ? !r.ap : filtro === 'confirmar' ? r.estadoPlan.k === 'confirmar' : filtro === 'simbloq' ? (r.estadoPlan.k === 'simulacion' || r.bloqueado) : filtro === 'desv' ? (r.delta != null && Math.abs(r.delta) > 0.10) : true
  const filas = tablero.filter(pasa)
  const estPill = k => k === 'aplicable' ? ['Aplicable', VERDE] : k === 'confirmar' ? ['Confirmar', AMBAR] : k === 'simulacion' ? ['Simulación', ROJO] : ['Bloqueado', ROJO]
  const th = { padding: '9px 6px', fontWeight: 500, textAlign: 'right', color: GRIS }
  return (<>
    <div style={{ background: '#f3f7fb', border: '0.5px solid #d8e6f2', borderRadius: '12px', padding: '13px 15px', marginBottom: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '7px' }}>
        <span style={{ fontSize: '13px', color: AZUL }}>✦</span>
        <div style={{ fontSize: '12.5px', fontWeight: 500, color: NAVY }}>Resumen de la semana · {finca.nombre}</div>
      </div>
      <div style={{ fontSize: '12.5px', color: '#4a5a67', lineHeight: 1.6 }}>{resumen.join(' ')}</div>
      {acciones.length > 0 && <ul style={{ margin: '8px 0 0', paddingLeft: '18px', fontSize: '12px', color: '#4a5a67', lineHeight: 1.55 }}>{acciones.map((a, i) => <li key={i}>{a}</li>)}</ul>}
      <div style={{ fontSize: '10.5px', color: '#9fb0bf', marginTop: '8px' }}>Resumen automático a partir de las reglas; orienta, no decide por ti.</div>
    </div>
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '13px 15px', marginBottom: '10px' }}>
      <div style={{ ...titMini, marginBottom: '9px' }}>Total del plan semanal confirmado · {totales.nConf} piscinas</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: '11px' }}>
        <Mini k="Biomasa en planes confirmados" v={miles(totales.bioConf) + ' lb'} />
        <Mini k="Sacos calculados" v={num1(totales.sacCalc)} />
        <Mini k="Sacos operativos (Σ ceil)" v={String(totales.sacOper)} />
        <Mini k="Costo de consumo" v={dinero(totales.costoCons)} />
        <Mini k="Desembolso operativo" v={dinero(totales.desembolso)} />
      </div>
      {(totales.sinEsc - totales.bloq) > 0 && <div style={{ borderTop: '0.5px solid #eef3f7', marginTop: '11px', paddingTop: '9px', fontSize: '12px', color: '#4a5a67' }}>
        <b style={{ fontWeight: 500, color: AZUL }}>Proyección completa:</b> si se aceptan las {totales.sinEsc - totales.bloq} recomendaciones pendientes → +{totales.extraSacos} sacos · desembolso +{dinero(totales.extraCosto)}.
      </div>}
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: '9px', marginBottom: '12px' }}>
      <div style={cardMini}><div style={{ fontSize: '10.5px', color: '#185FA5' }}>Pedido neto</div><div style={{ fontSize: '18px', fontWeight: 500, color: AZUL }}>{netoTotal} <span style={{ fontSize: '11px', color: GRIS }}>sacos</span></div></div>
      <div style={cardMini}><div style={{ fontSize: '10.5px', color: GRIS }}>Bloqueadas</div><div style={{ fontSize: '18px', fontWeight: 500, color: totales.bloq ? ROJO : NAVY }}>{totales.bloq}</div></div>
      <div style={cardMini}><div style={{ fontSize: '10.5px', color: GRIS }}>Sin escenario</div><div style={{ fontSize: '18px', fontWeight: 500, color: totales.sinEsc ? AMBAR : NAVY }}>{totales.sinEsc}</div></div>
      <div style={cardMini}><div style={{ fontSize: '10.5px', color: GRIS }}>Con desviación</div><div style={{ fontSize: '18px', fontWeight: 500, color: totales.desv ? AMBAR : NAVY }}>{totales.desv}</div></div>
      <div style={cardMini}><div style={{ fontSize: '10.5px', color: GRIS }}>Valor de continuar</div><div style={{ fontSize: '18px', fontWeight: 500, color: totales.valorCont >= 0 ? VERDE : AMBAR }}>{totales.valorCont >= 0 ? '+' : ''}{dinero(totales.valorCont)}</div></div>
    </div>
    <div style={{ fontSize: '11.5px', color: GRIS, margin: '0 2px 12px' }}><b style={{ color: VERDE, fontWeight: 500 }}>{totales.esperarN}</b> conviene esperar · <b style={{ color: AMBAR, fontWeight: 500 }}>{totales.cosecharN}</b> conviene cosechar · <b style={{ fontWeight: 500 }}>{totales.sinCalc}</b> sin cálculo</div>
    {pedidoNeto.length > 0 && (
      <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '13px 15px', marginBottom: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px', marginBottom: '4px' }}>
          <div style={{ ...titMini, marginBottom: 0 }}>Pedido neto por producto</div>
          <span style={{ fontSize: '10.5px', color: '#9fb0bf' }}>= requerimiento − inventario − tránsito + reserva ({reservaDias} días)</span>
        </div>
        <div style={{ fontSize: '10.5px', color: '#9fb0bf', marginBottom: '8px' }}>Inventario al corte: {invCorte ? fechaHoraCorta(invCorte) : '—'}</div>
        <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11.5px', minWidth: '560px' }}>
          <thead><tr style={{ color: GRIS }}>
            <th style={{ textAlign: 'left', padding: '6px 6px', fontWeight: 500 }}>Producto</th>
            <th style={{ textAlign: 'right', padding: '6px 6px', fontWeight: 500 }}>Requerim.</th>
            <th style={{ textAlign: 'right', padding: '6px 6px', fontWeight: 500 }}>Inventario</th>
            <th style={{ textAlign: 'right', padding: '6px 6px', fontWeight: 500 }}>Tránsito a tiempo</th>
            <th style={{ textAlign: 'right', padding: '6px 6px', fontWeight: 500 }}>Reserva</th>
            <th style={{ textAlign: 'right', padding: '6px 6px', fontWeight: 500 }}>Neto</th>
            <th style={{ textAlign: 'left', padding: '6px 6px', fontWeight: 500 }}>Estado</th>
            <th style={{ padding: '6px 6px' }}></th>
          </tr></thead>
          <tbody>
            {pedidoNeto.map(p => {
              const [et, ec] = estProd[p.estado]
              const abierto = expP === p.pid
              return (<Fragment key={p.pid}>
                <tr style={{ borderTop: '0.5px solid #eef3f7' }}>
                  <td style={{ padding: '7px 6px', color: NAVY }}>{p.nombre}</td>
                  <td style={{ padding: '7px 6px', textAlign: 'right' }}>{p.req}</td>
                  <td style={{ padding: '7px 6px', textAlign: 'right', color: p.invFalta ? AMBAR : GRIS }}>{p.invFalta ? 'sin dato' : '−' + miles(p.inv)}</td>
                  <td style={{ padding: '7px 6px', textAlign: 'right', color: GRIS }}>−{miles(p.tr)}</td>
                  <td style={{ padding: '7px 6px', textAlign: 'right', color: GRIS }}>+{num1(p.reserva)}</td>
                  <td style={{ padding: '7px 6px', textAlign: 'right', fontWeight: 500, color: p.neto > 0 ? AZUL : VERDE }}>{p.neto > 0 ? p.neto : '0'}</td>
                  <td style={{ padding: '7px 6px' }}><span style={{ fontSize: '10px', fontWeight: 500, color: ec, background: ec + '18', padding: '2px 8px', borderRadius: '20px' }}>{et}</span></td>
                  <td style={{ padding: '7px 6px', textAlign: 'right' }}><button type="button" aria-expanded={abierto} onClick={() => setExpP(abierto ? null : p.pid)} style={{ background: 'none', border: 'none', fontFamily: 'inherit', fontSize: '11px', color: AZUL, cursor: 'pointer', fontWeight: 500 }}>{abierto ? 'Ocultar' : 'Ver'}</button></td>
                </tr>
                {abierto && <tr style={{ background: '#f6f9fb' }}><td colSpan={8} style={{ padding: '9px 10px', fontSize: '11px', color: GRIS }}>
                  {p.precio ? <span>Precio vigente: <b style={{ color: NAVY, fontWeight: 500 }}>{dinero(p.precio.precio)}/saco</b> · actualizado {corta(p.precio.fecha)}. </span> : <span style={{ color: AMBAR }}>Sin precio registrado. </span>}
                  Piscinas: {p.piscinas.map(x => `${x.nombre} (${x.sacos})`).join(' · ')}
                </td></tr>}
              </Fragment>)
            })}
          </tbody>
        </table>
        </div>
        <div style={{ fontSize: '11px', color: '#9fb0bf', marginTop: '9px', lineHeight: 1.5 }}>Reserva = consumo diario del producto × {reservaDias} días alimentados. Inventario y tránsito se descuentan una sola vez; el neto se redondea hacia arriba. Desembolso estimado del neto: <b style={{ color: '#51606c', fontWeight: 500 }}>{dinero(desembolsoNeto)}</b>.</div>
      </div>
    )}
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '9px' }}>
      {FILTROS.map(([k, l]) => <button key={k} type="button" aria-pressed={filtro === k} onClick={() => setFiltro(k)} style={{ fontFamily: 'inherit', fontSize: '11.5px', padding: '5px 11px', borderRadius: '20px', cursor: 'pointer', border: '1px solid ' + (filtro === k ? AZUL : BORDE), background: filtro === k ? '#e8f1fb' : 'white', color: filtro === k ? AZUL : NAVY, fontWeight: filtro === k ? 500 : 400 }}>{l}</button>)}
    </div>
    <div style={{ border: '0.5px solid ' + BORDE, borderRadius: '12px', background: 'white', overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11.5px' }}>
        <thead><tr style={{ color: GRIS }}>
          <th style={{ ...th, textAlign: 'left', paddingLeft: '12px' }}>Piscina</th>
          <th style={{ ...th, textAlign: 'left' }}>Estado</th>
          <th style={th}>Gramaje</th>
          <th style={th}>Biomasa</th>
          <th style={th}>Aplicado</th>
          <th style={th}>Sacos</th>
          <th style={{ ...th, textAlign: 'left' }}>Alerta</th>
          <th style={{ ...th, paddingRight: '12px' }}></th>
        </tr></thead>
        <tbody>
          {filas.map(r => {
            const [et, ec] = estPill(r.estadoPlan.k)
            const abierto = exp === r.f.cicloId
            return (<Fragment key={r.f.cicloId}>
              <tr style={{ borderTop: '0.5px solid ' + BORDE }}>
                <td style={{ padding: '9px 6px 9px 12px', color: NAVY, fontWeight: 500 }}>{r.f.nombre}</td>
                <td style={{ padding: '9px 6px' }}><span style={{ fontSize: '10px', fontWeight: 500, color: ec, background: ec + '18', padding: '2px 8px', borderRadius: '20px', whiteSpace: 'nowrap' }}>{et}</span></td>
                <td style={{ padding: '9px 6px', textAlign: 'right', color: GRIS }}>{num1(r.f.gramaje)} g</td>
                <td style={{ padding: '9px 6px', textAlign: 'right' }}>{r.bloqueado && !r.ap ? <span style={{ color: '#c9d3dc' }}>—</span> : miles(r.biomasaSel) + ' lb'}</td>
                <td style={{ padding: '9px 6px', textAlign: 'right' }}>{r.ap ? <b style={{ fontWeight: 500 }}>{r.ap.fila_pct}% · {cap(intenLbl(r.ap.intensidad))}</b> : <span style={{ color: '#c9d3dc' }}>—</span>}</td>
                <td style={{ padding: '9px 6px', textAlign: 'right' }}>{r.sacosShow == null ? <span style={{ color: '#c9d3dc' }}>sim.</span> : r.sugerido ? <span style={{ color: GRIS }}>{r.sacosShow} <span style={{ fontSize: '9px' }}>sug.</span></span> : <b style={{ fontWeight: 500 }}>{r.sacosShow}</b>}</td>
                <td style={{ padding: '9px 6px', textAlign: 'left', color: r.alertas.length ? ((r.bloqueado || r.estadoPlan.k === 'simulacion') ? ROJO : AMBAR) : '#c9d3dc' }}>{r.alertas[0] || '—'}{r.alertas.length > 1 && <span style={{ color: GRIS, fontSize: '10px' }}> +{r.alertas.length - 1}</span>}</td>
                <td style={{ padding: '9px 12px 9px 6px', textAlign: 'right' }}><button type="button" aria-expanded={abierto} onClick={() => setExp(abierto ? null : r.f.cicloId)} style={{ background: 'none', border: 'none', fontFamily: 'inherit', fontSize: '11.5px', color: AZUL, cursor: 'pointer', padding: '2px 4px', fontWeight: 500 }}>{abierto ? 'Ocultar' : 'Ver'} ›</button></td>
              </tr>
              {abierto && <tr style={{ background: '#f6f9fb' }}><td colSpan={8} style={{ padding: '10px 12px' }}>
                <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', fontSize: '12px', color: GRIS }}>
                  <span>Recomendado: <b style={{ color: NAVY, fontWeight: 500 }}>100% · {cap(intenLbl(r.recoInten))}</b></span>
                  <span>Δ vs semana anterior: <b style={{ color: NAVY, fontWeight: 500 }}>{r.deltaEstado === 'pendiente' ? 'Pendiente' : r.deltaEstado === 'sin-comparable' ? 'Sin semana comparable' : `${r.delta >= 0 ? '+' : ''}${Math.round(r.delta * 100)}%`}</b></span>
                  <span>Plan / ejecutado: <b style={{ color: NAVY, fontWeight: 500 }}>{r.cumplimiento != null ? Math.round(r.cumplimiento * 100) + '%' : '—'}</b></span>
                  <span>Muestreo: <b style={{ color: NAVY, fontWeight: 500 }}>{r.muDias != null ? `hace ${r.muDias} d` : '—'}</b></span>
                  {r.rent && <span>Rentabilidad: <b style={{ color: (r.rent.listo || r.rent.noComercial) ? NAVY : (r.rent.valor >= 0 ? VERDE : AMBAR), fontWeight: 500 }}>{r.rent.noComercial ? 'aún no cosechable' : r.rent.listo ? 'listo para cosechar' : `${r.rent.valor >= 0 ? 'esperar' : 'cosechar'} · ${r.rent.valor >= 0 ? '+' : ''}${dinero(r.rent.valor)} (${dinero(r.rent.valorDia)}/día)`}</b></span>}
                </div>
                {r.alertas.length > 0 && <div style={{ fontSize: '11.5px', color: AMBAR, marginTop: '7px' }}>Alertas: {r.alertas.join(' · ')}</div>}
                <button onClick={() => onVer(r.f.cicloId)} style={{ ...btnAzul, marginTop: '10px' }}>Abrir piscina ›</button>
              </td></tr>}
            </Fragment>)
          })}
        </tbody>
      </table>
    </div>
    <div style={{ fontSize: '11px', color: '#9fb0bf', marginTop: '9px', lineHeight: 1.5 }}>Totales del plan semanal (sumas). El confirmado suma solo escenarios aplicados con calendario confirmado; la proyección agrega las recomendaciones pendientes.</div>
  </>)
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
const celComp = { padding: '7px 10px' }
const intenLbl = k => k === 'BAJO' ? 'baja' : k === 'ALTO' ? 'alta' : 'media'
const G_MIN_COMERCIAL = 10   // gramaje comercial mínimo; por debajo no se evalúa cosechar
const MOTIVOS_RECHAZO = [['riesgo', 'Riesgo biológico'], ['biomasa', 'Biomasa no confiable'], ['excesivo', 'Cambio excesivo'], ['presupuesto', 'Presupuesto/inventario'], ['calendario', 'Calendario incorrecto'], ['otro', 'Otro']]
// Motivos estructurados para apartarse de la recomendación (código + etiqueta).
const MOTIVOS = [
  ['mortalidad', 'Mortalidad'], ['raleo', 'Raleo'], ['transferencia', 'Transferencia'],
  ['muestreo', 'Muestreo'], ['consumo', 'Consumo observado'], ['agua', 'Calidad de agua'],
  ['ayuno', 'Ayuno programado'], ['comercial', 'Decisión comercial'], ['otro', 'Otro'],
]
const DIA_LBL = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']
const DIA_LARGO = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']
// Descripción accesible de un día del calendario (para lectores de pantalla).
function diaDescripcion(d) {
  const quien = d.cerrado ? (d.tipo === 'sin' ? 'sin registro' : 'ejecutado') : 'propuesto por patrón'
  const qué = d.tipo === 'fed' ? `alimentó ${miles(d.lb)} lb` : d.tipo === 'sin' ? 'resolver antes de confirmar' : d.alimenta ? 'alimentar' : 'ayuno'
  return `${DIA_LARGO[d.i]} ${Number(d.fecha.slice(8, 10))} · ${quien} · ${qué}`
}
// Calendario semanal: 7 celdas L–D. Días cerrados = ejecución real (solo lectura);
// días futuros = planificables (botón con aria-pressed). Verde alimenta, ámbar ayuno,
// rojo sin registro.
function Calendario({ dias, editable, onToggle, lbDia = 0, hoy = null }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: '6px' }}>
      {dias.map((d, i) => {
        const interactivo = editable && !d.cerrado
        const esHoy = hoy && d.fecha === hoy
        // Libras del día: lo cerrado = ejecución real; lo futuro alimentado = dosis elegida.
        const lbMostrar = d.tipo === 'fed' ? d.lb : (!d.cerrado && d.alimenta ? lbDia : null)
        // Estado con mayúscula inicial: Dado (ya alimentó) · Hoy · Plan · Ayuno · Sin registro.
        const estado = d.tipo === 'sin' ? 'Sin registro'
          : d.cerrado ? (d.tipo === 'fed' ? 'Dado' : 'Ayuno')
          : !d.alimenta ? 'Ayuno' : esHoy ? 'Hoy' : 'Plan'
        const col = d.tipo === 'sin' ? ROJO : (d.alimenta || d.tipo === 'fed') ? '#0F6E56' : '#854F0B'
        const bg = d.tipo === 'sin' ? '#FBEAEA' : (d.alimenta || d.tipo === 'fed') ? '#e7f6ef' : '#FBF5E9'
        const bd = esHoy ? AZUL : d.tipo === 'sin' ? '#e7cccb' : (d.alimenta || d.tipo === 'fed') ? '#bfe6d2' : '#ecd9b4'
        const base = { textAlign: 'center', padding: '7px 2px', borderRadius: '8px', background: bg, border: (esHoy ? '2px' : '1px') + ' solid ' + bd, width: '100%', fontFamily: 'inherit', boxSizing: 'border-box' }
        const inner = (<>
          <div style={{ fontSize: '10.5px', color: GRIS }}>{DIA_LBL[d.i ?? i]}</div>
          <div style={{ fontSize: '12.5px', fontWeight: 500, color: lbMostrar != null ? NAVY : col }}>{lbMostrar != null ? miles(lbMostrar) : (d.tipo === 'sin' ? '—' : 'Ayuno')}</div>
          {lbMostrar != null && <div style={{ fontSize: '9px', color: '#9fb0bf' }}>{num1(lbMostrar / PARAM.pesoSaco)} sacos</div>}
          <div style={{ fontSize: '9.5px', color: d.cerrado && d.tipo === 'fed' ? GRIS : col }}>{estado}</div>
        </>)
        return interactivo
          ? <button key={d.fecha} type="button" aria-pressed={d.alimenta} aria-label={diaDescripcion(d)} onClick={() => onToggle(d.fecha, d.alimenta)} style={{ ...base, cursor: 'pointer' }}>{inner}</button>
          : <div key={d.fecha} role="img" aria-label={diaDescripcion(d)} style={{ ...base, opacity: d.cerrado ? 0.92 : 1 }}>{inner}</div>
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
                const esR = hayReco && f === recoFila && k === recoInten
                const esS = sel.fila === f && sel.inten === k
                // Solo la elección (azul) se resalta; la recomendada va como texto, sin relleno.
                const borde = esS ? '2px solid ' + AZUL : '0.5px solid transparent'
                const bg = esS ? '#e8f1fb' : 'transparent'
                const activa = esOf || esS || esR
                return (
                  <div key={k} onClick={() => onSel(f, k)} style={{ cursor: 'pointer', textAlign: 'center', margin: '3px', padding: '7px 4px', border: borde, borderRadius: '9px', background: bg }}>
                    {(esR || esS) && <div style={{ fontSize: '9px', fontWeight: 500, color: esS ? AZUL : VERDE }}>{esS ? '● Tu elección' : 'Recomendada'}</div>}
                    <div style={{ fontSize: esOf ? '16px' : '14px', fontWeight: 500, color: activa ? NAVY : GRIS }}>{miles(lb)}</div>
                    <div style={{ fontSize: '10px', color: activa ? GRIS : '#9fb0bf' }}>lb/día · {num1(lb / pesoSaco)} sac</div>
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
