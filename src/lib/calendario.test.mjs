// Pruebas de construirDias: días cerrados desde ejecución real, "sin registro" en
// días pasados sin fila, futuros desde el patrón/override, y ejecución > patrón.
import assert from 'node:assert/strict'
import { construirDias } from './calendario.js'

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

if (fallos) { console.error(`\n${fallos} prueba(s) de calendario fallaron.`); process.exit(1) }
console.log('\nTodas las pruebas de calendario pasaron.')
