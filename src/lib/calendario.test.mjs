// Pruebas de construirDias: días cerrados desde ejecución real, "sin registro" en
// días pasados sin fila, futuros desde el patrón/override, y ejecución > patrón.
import assert from 'node:assert/strict'
import { construirDias, nivelCambio, planVsEjecutado } from './calendario.js'

let fallos = 0
const ok = (cond, msg) => { if (cond) console.log('✓', msg); else { fallos++; console.error('✗', msg) } }

// Semana lun..dom (7 fechas ascendentes). hoy = sem[3] → sem[0..2] pasados.
const sem = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']
const hoy = sem[3]
const fila = {
  piscinaId: 'p1',
  alsRaw: [
    { fecha: sem[0], lb: 2000, ayuno: false },  // lun: alimentó
    { fecha: sem[1], lb: 2475, ayuno: false },  // mar: alimentó (patrón dice ayuno)
    // mié (sem[2]) pasado SIN registro
  ],
}
// patrón: martes(2) y viernes(5) ayuno; resto alimenta.
const patFinca = { 1: true, 2: false, 3: true, 4: true, 5: false, 6: true, 7: true }
const dias = construirDias(fila, sem, hoy, patFinca, {}, null, null)

ok(dias[0].tipo === 'fed' && dias[0].cerrado && dias[0].alimenta, 'lun ejecutado: fed, cerrado')
ok(dias[1].tipo === 'fed' && dias[1].alimenta === true, 'mar ejecutado gana al patrón ayuno: fed')
ok(dias[2].tipo === 'sin' && dias[2].cerrado && dias[2].alimenta === false, 'mié pasado sin registro: tipo "sin"')
ok(dias[3].cerrado === false && dias[3].tipo === 'plan' && dias[3].alimenta === true, 'hoy sin ejecución: planificable (patrón jue=alimenta)')
ok(dias[4].tipo === 'plan' && dias[4].alimenta === false, 'vie futuro: ayuno por patrón')
ok(dias.filter(d => d.alimenta).length === 5, 'días alimentados = 5 (lun, mar, jue, sáb, dom)')

// Override futuro gana al patrón.
const dias2 = construirDias(fila, sem, hoy, patFinca, {}, null, { [sem[4]]: true })
ok(dias2[4].alimenta === true, 'override futuro gana al patrón (vie pasa a alimentar)')

// Override de piscina gana al patrón de finca en el futuro.
const dias3 = construirDias(fila, sem, hoy, patFinca, { p1: { 4: false } }, null, null)
ok(dias3[3].alimenta === false, 'override de piscina (jue=ayuno) gana al patrón de finca')

// --- Nivel de cambio de dosis: límites exactos ---
ok(nivelCambio(0.10) === 'normal', '+10,00% → normal')
ok(nivelCambio(0.1001) === 'confirmar', '+10,01% → confirmar (ámbar)')
ok(nivelCambio(0.20) === 'confirmar', '+20,00% → confirmar (ámbar)')
ok(nivelCambio(0.2001) === 'fuerte', '+20,01% → fuerte (rojo)')
ok(nivelCambio(-0.10) === 'normal', '−10,00% → normal')
ok(nivelCambio(-0.1001) === 'confirmar', '−10,01% → confirmar (ámbar)')
ok(nivelCambio(-0.2001) === 'fuerte', '−20,01% → fuerte (rojo)')
ok(nivelCambio(null) === null, 'sin dosis anterior → null')

// --- Planificado vs ejecutado: aplicación a mitad de semana, ayuno, sin registro, extra ---
// Semana lun..dom; plan rige desde el miércoles (vigenteDesde = sem[2]).
// Días cerrados: lun..jue (sem[0..3]); vie..dom abiertos.
const pDias = { [sem[0]]: true, [sem[1]]: true, [sem[2]]: false, [sem[3]]: true, [sem[4]]: true, [sem[5]]: true, [sem[6]]: false }
const cal = [
  { fecha: sem[0], cerrado: true, tipo: 'fed', lb: 1000 },   // lun fed (antes de vigencia → NO cuenta)
  { fecha: sem[1], cerrado: true, tipo: 'ayuno', lb: 0 },    // mar ayuno (antes de vigencia → NO cuenta)
  { fecha: sem[2], cerrado: true, tipo: 'fed', lb: 1200 },   // mié: plan ayuno, alimentó → fedExtra
  { fecha: sem[3], cerrado: true, tipo: 'sin', lb: 0 },      // jue: plan alimentar, sin registro → sinReg
  { fecha: sem[4], cerrado: false, tipo: 'plan', alimenta: true, lb: 0 }, // vie abierto → no cuenta
  { fecha: sem[5], cerrado: false, tipo: 'plan', alimenta: true, lb: 0 },
  { fecha: sem[6], cerrado: false, tipo: 'plan', alimenta: false, lb: 0 },
]
const pv = planVsEjecutado({ calDias: cal, planDias: pDias, lbDia: 1000, vigenteDesde: sem[2] })
ok(pv.dias === 2, 'solo cuenta días cerrados desde vigencia (mié, jue)')
ok(pv.fedExtra === 1, 'mié: alimentó pese a ayuno planificado → fedExtra=1')
ok(pv.sinReg === 1, 'jue: día cerrado sin registro → sinReg=1')
ok(pv.ayNoPlan === 0, 'no hay ayuno no planificado (jue es sin registro, no ayuno)')
ok(pv.planLb === 1000, 'planificado = solo jue (mié era ayuno planificado) = 1×1000')
ok(pv.ejecLb === 1200, 'ejecutado = mié 1200 (jue sin registro aporta 0)')

// Costo ejecutado respeta el precio por registro (cambio de producto entre días).
const calC = [
  { fecha: sem[0], cerrado: true, tipo: 'fed', lb: 1100, costoBase: 1100 * 30 }, // producto A $30/saco
  { fecha: sem[1], cerrado: true, tipo: 'fed', lb: 1100, costoBase: 1100 * 50 }, // producto B $50/saco
]
const pvC = planVsEjecutado({ calDias: calC, planDias: { [sem[0]]: true, [sem[1]]: true }, lbDia: 1100, vigenteDesde: sem[0] })
ok(pvC.ejecCostBase === 1100 * 30 + 1100 * 50, 'costo ejecutado suma el precio de cada registro (cambio de producto)')

if (fallos) { console.error(`\n${fallos} prueba(s) de calendario fallaron.`); process.exit(1) }
console.log('\nTodas las pruebas de calendario pasaron.')
