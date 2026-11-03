// Construcción del calendario semanal de alimentación de una piscina.
// Los días CERRADOS (ya ejecutados, aunque sea hoy, o anteriores a hoy) salen de la
// ejecución real (fila.alsRaw) y son solo lectura: la ejecución manda sobre el patrón.
// Los días futuros se proponen desde overrides → plan confirmado → patrón de piscina
// → patrón de finca → todos. dia 1=lunes … 7=domingo (por posición en semFechas).
export function construirDias(fila, semFechas, hoy, patFinca, patPisc, plan, overrides) {
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
