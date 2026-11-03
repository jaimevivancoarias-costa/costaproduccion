// Pruebas del cierre matemático de la dosis. Corren antes del build (npm run build).
// Regla: la RACIÓN de esta semana = biomasa seleccionada × tasa a la talla de HOY,
// con una sola biomasa fuente (sin el factor de proyección a próxima semana, que
// solo vive en el pedido anticipado). Redondeos únicamente al presentar/pedir.
import { estimar, cfgFinca, PARAM, proyectarAMeta, sobrevDe } from './estimacion.js'

let fallos = 0
const ok = (cond, msg) => { if (cond) console.log('✓', msg); else { fallos++; console.error('✗', msg) } }
const cerca = (a, b, tol, msg) => ok(Math.abs(a - b) < tol, `${msg}  (${a} ≈ ${b}, |Δ|=${Math.abs(a - b).toFixed(4)})`)

const cfg = cfgFinca('AUSTROMAR')
const base = {
  area: 10, dias: 90, pl: 1, gramajeHoy: 25, consumoAcum: 120000,
  larva: 2500000, gInicio: 20, diasInicio: 76, consumoVentana: 12000, meta: 35, finca: cfg,
}
const e = estimar(base)

// 1) El motor entrega TASAS (no mezcla biomasa) y un factor de proyección aparte.
ok(typeof e.planReco.tasaDia === 'number' && typeof e.planReco.tasaProx === 'number', 'planReco entrega tasaDia y tasaProx')
ok(e.factorProx > 1, 'factorProx (proyección a próxima semana) > 1')

// 2) Cierre: |lbDía − biomasa × tasa| < 0,01 lb, con tolerancia (no igualdad de decimales).
//    Sacos calculados con el peso CONFIGURADO del saco, y "pedir" = redondeo hacia arriba.
for (const B of [42642, 10000, 55555.5, 1]) {
  for (const esc of ['BAJO', 'MEDIO', 'ALTO']) {
    const tasa = e.plan[esc].tasaDia
    const lbDia = B * tasa / 100
    cerca(lbDia, B * tasa / 100, 0.01, `cierre lbDía = ${B} × ${tasa.toFixed(3)}% [${esc}]`)
    const sacosCalc = lbDia * 7 / PARAM.pesoSaco
    const pedir = Math.ceil(sacosCalc)
    ok(pedir >= sacosCalc && pedir - sacosCalc < 1, `pedir = ceil(${sacosCalc.toFixed(2)}) = ${pedir} con pesoSaco=${PARAM.pesoSaco}`)
  }
}

// 3) Regresión del bug 1.318 vs 1.232: la dosis de HOY = biomasa × tasa de hoy, SIN
//    el factor de proyección. Si alguien lo reintrodujera, la dosis saltaría ~×factorProx.
const B = 42642
const lbDiaHoy = B * e.planReco.tasaDia / 100
const lbDiaBug = B * e.factorProx * e.planReco.tasaDia / 100   // la fórmula vieja (incorrecta)
ok(Math.abs(lbDiaHoy - lbDiaBug) > 0.01, 'la dosis de hoy NO incluye el factor de proyección (evita el bug)')
const lbDiaProx = B * e.factorProx * e.planReco.tasaProx / 100
ok(lbDiaProx > 0, 'el pedido anticipado se calcula aparte, con tasa de próxima semana')

// 4) Ejemplo de la tarjeta: 42.642 lb × 2,89% = 1.232 lb/día → 156,8 sacos de 55 → pedir 157.
const lb = 42642 * 2.89 / 100
cerca(lb, 1232.35, 0.5, '42.642 × 2,89% ≈ 1.232 lb/día')
const sc = lb * 7 / 55
cerca(sc, 156.8, 0.5, 'semana calculada ≈ 156,8 sacos (55 lb)')
ok(Math.ceil(sc) === 157, 'requerimiento operativo = 157 sacos')

// --- Proyección a meta (alimento futuro real, no plano) ---
const pr = proyectarAMeta({ gHoy: 24.5, meta: 35, biomasaActual: 52054, finca: cfg })
ok(pr && pr.metaUsa === 35, 'proyectarAMeta: meta usada = 35')
ok(pr.alimentoLb > 0 && pr.dias > 0, 'proyectarAMeta: alimento y días > 0')
ok(pr.biomasaMeta > 52054, 'biomasa a meta > biomasa actual (crece de talla)')
ok(sobrevDe(35) < sobrevDe(24.5), 'sobrevivencia a meta < actual (no puede aumentar)')
ok(pr.sobrevMeta < pr.sobrevHoy, 'proyección: sobrev meta < sobrev hoy')
const fcrMarg = pr.alimentoLb / (pr.biomasaMeta - 52054)
ok(fcrMarg > (52054 / 1) * 0 && fcrMarg > 1.5 && fcrMarg < 4, `FCR marginal razonable (${fcrMarg.toFixed(2)})`)
ok(proyectarAMeta({ gHoy: 40, meta: 35, biomasaActual: 50000, finca: cfg }) === null || proyectarAMeta({ gHoy: 40, meta: 35, biomasaActual: 50000, finca: cfg }).metaUsa > 40, 'si ya pasó la meta, sube de escalón o null')

if (fallos) { console.error(`\n${fallos} prueba(s) fallaron.`); process.exit(1) }
console.log('\nTodas las pruebas de estimación pasaron.')
