// Motor de estimación (calculadora AQ1), portado del Excel de Melany.
// La curva calibrada vive en estimacionTabla.js; aquí van los parámetros y
// las fórmulas (proyección, biomasa, FCR, escenario y plan de alimento).
import { TABLA_CRECIMIENTO as TABLA } from './estimacionTabla'

// Parámetros generales del motor (AQ1 PARAMETROS).
export const PARAM = {
  pesoSaco: 55,
  factorBajo: 0.9, factorMedio: 1.0, factorAlto: 1.1,
  sobrevEsperada: 0.6,
  densidadRef: 250000,
  semanasDefecto: 2,
  escalonMeta: [35, 45, 50],   // F5, F6, F7
  fcrMetaA: 1.25, fcrMetaB: 1.4,
  // Alimento por rango de gramaje (próxima semana).
  alimentos: [
    { nombre: 'Aquaxcel 1.2', desde: 0, hasta: 3, usdSaco: 37.93, lbSaco: 55 },
    { nombre: 'Aquaxcel 2.0', desde: 3, hasta: 15, usdSaco: 30.68, lbSaco: 55 },
    { nombre: 'Medicado', desde: 15, hasta: 18, usdSaco: 33.80, lbSaco: 55 },
    { nombre: 'Aquaxcel 2.0', desde: 18, hasta: 60, usdSaco: 30.68, lbSaco: 55 },
  ],
}

// Config por finca (editable a futuro). Por ahora, los valores del Excel.
export const FINCA_DEFECTO = { meta: 35, metaLbHa: 14000, costoHaDia: 33, larvaMillar: 3, tabla: 'B' }

const G_POR_LB = 453.592

// MATCH(MIN(MAX(g,0.5),50)+0.25, tablaG, 1) del Excel: la fila cuyo gramaje es
// el mayor <= g+0.25 → en la práctica redondea al escalón de 0.5 más cercano.
function filaDe(g) {
  const key = Math.min(Math.max(Number(g) || 0, 0.5), 50) + 0.25
  let row = TABLA[0]
  for (const r of TABLA) { if (r.g <= key) row = r; else break }
  return row
}
const diaEq = g => filaDe(g).diaEq
const gDiaObj = g => filaDe(g).gDia
const gSemObj = g => filaDe(g).gSem
const sobrevTabla = g => filaDe(g).sobrev
const fcrMaxTabla = g => filaDe(g).fcrMax || 0
const fcrEspTabla = g => filaDe(g).fcrEsp || 0
const pct = (g, esc) => { const r = filaDe(g); return esc === 'BAJO' ? r.pBajo : esc === 'ALTO' ? r.pAlto : r.pMedio }

// Meta efectiva (D7): si ya pasó la meta, sube al siguiente escalón.
function metaEfectiva(gramajeHoy, meta) {
  const [e2, e3, e4] = PARAM.escalonMeta
  if (gramajeHoy < meta) return meta
  if (gramajeHoy < e2) return e2
  if (gramajeHoy < e3) return e3
  return e4
}

function alimentoDe(g) {
  const a = PARAM.alimentos
  for (const x of a) if (g >= x.desde && g < x.hasta) return x
  return a[a.length - 1]
}

// Calcula todo para una piscina. `inp` trae los datos que salen del sistema.
// inp: { area, dias, pl, gramajeHoy, consumoAcum, larva,
//        gInicio, diasInicio, consumoVentana, meta, finca }
export function estimar(inp) {
  const f = { ...FINCA_DEFECTO, ...(inp.finca || {}) }
  const meta = Number(inp.meta ?? f.meta)
  const g = Number(inp.gramajeHoy) || 0
  const area = Number(inp.area) || 0
  const dias = Number(inp.dias) || 0
  const pl = Number(inp.pl) || 0.5
  const larva = Number(inp.larva) || 0
  const consumoAcum = Number(inp.consumoAcum) || 0
  const gIni = Number(inp.gInicio) || 0
  const diasIni = Number(inp.diasInicio) || 0
  const consVent = Number(inp.consumoVentana) || 0   // lb/semana promedio de la ventana
  const ajusteB = f.tabla === 'B' ? PARAM.fcrMetaB / PARAM.fcrMetaA : 1

  const metaUsa = metaEfectiva(g, meta)
  const gProm = (g + gIni) / 2 || g

  // Velocidad / proyección
  const creditoPL = diaEq(pl)
  const diasObjetivo = diaEq(metaUsa) - creditoPL
  const diaCorresponde = diaEq(g) - creditoPL
  const atrasoHoy = dias - diaCorresponde
  const gDiaObs = (gIni > 0 && gIni < g && dias > diasIni) ? (g - gIni) / (dias - diasIni) : 0
  const gDiaObjetivo = gDiaObj(g)
  const desempeno = gDiaObjetivo > 0 ? gDiaObs / gDiaObjetivo : 0
  const diasProyectados = dias + (diaEq(metaUsa) - diaEq(g)) / Math.max(desempeno, 0.3)
  const atrasoProyectado = diasProyectados - diasObjetivo
  const fcrProyectado = diaEq(metaUsa) > 0 ? fcrEspTabla(metaUsa) * (diasProyectados + creditoPL) / diaEq(metaUsa) : 0

  // Biomasa
  const term1 = gProm > 0 ? (consVent / 7) / (pct(gProm, 'MEDIO') / 100) * g / gProm : 0
  const term2 = f.metaLbHa * area * Math.pow(metaUsa > 0 ? g / metaUsa : 0, 0.7)
  const biomasaConsumo = Math.min(term1, term2) / ajusteB
  const biomasaDensidad = larva * sobrevTabla(g) * g / G_POR_LB
  const sobrevConsumo = (g > 0 && larva > 0) ? biomasaConsumo * G_POR_LB / (g * larva) : 0
  const sobrevDensidad = sobrevTabla(g)
  const fcrParcial = biomasaConsumo > 0 ? consumoAcum / biomasaConsumo : 0
  const fcrMax = fcrMaxTabla(g) * ajusteB

  // Escenario recomendado (según FCR y atraso proyectado)
  let escenario
  if (fcrParcial > 0 && fcrParcial > fcrMax) escenario = 'BAJO'
  else if (atrasoProyectado <= -2) escenario = 'BAJO'
  else if (atrasoProyectado <= 3) escenario = 'MEDIO'
  else if (atrasoProyectado <= 7) escenario = 'ALTO'
  else escenario = 'MEDIO'

  const gProxSem = g + gSemObj(g) / 2
  const alimento = alimentoDe(gProxSem)

  // Plan de alimento de la próxima semana, por escenario (según consumo). El %
  // se toma al gramaje de la próxima semana (×ajuste B), y la biomasa se escala
  // a esa talla (×gProx/g ×0,985), igual que el Excel.
  const planDe = esc => {
    const pctDia = pct(gProxSem, esc) * ajusteB
    const lbDia = (g > 0) ? biomasaConsumo * gProxSem / g * 0.985 * pctDia / 100 : 0
    const sacosSem = lbDia * 7 / PARAM.pesoSaco
    return { pctDia, lbDia, sacosDia: lbDia / PARAM.pesoSaco, sacosSem, usdSem: sacosSem * alimento.usdSaco }
  }

  return {
    meta, metaUsa, gProm,
    creditoPL, diasObjetivo, diaCorresponde, atrasoHoy,
    gDiaObs, gDiaObjetivo, desempeno, diasProyectados, atrasoProyectado, fcrProyectado,
    lectura: lecturaDe(atrasoProyectado),
    biomasaConsumo, biomasaDensidad, lbHa: area > 0 ? biomasaConsumo / area : 0,
    sobrevConsumo, sobrevDensidad, fcrParcial, fcrMax, difBiomasa: biomasaDensidad > 0 ? biomasaConsumo / biomasaDensidad - 1 : 0,
    escenario, gProxSem, alimento,
    plan: { BAJO: planDe('BAJO'), MEDIO: planDe('MEDIO'), ALTO: planDe('ALTO') },
    planReco: planDe(escenario),
  }
}

function lecturaDe(atraso) {
  if (atraso <= -2) return { txt: 'Va adelantado — puede bajar y ahorrar', tono: 'ok' }
  if (atraso <= 3) return { txt: 'En ritmo — siga como va', tono: 'ok' }
  if (atraso <= 7) return { txt: 'Atrasado — empuje ahora', tono: 'alerta' }
  return { txt: 'Muy atrasado — NO empuje. Revise oxígeno, muda y comederos', tono: 'malo' }
}
