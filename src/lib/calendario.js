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

// Nivel de cambio de dosis según |delta|: ≤10% normal · ≤20% confirmar · >20% fuerte.
export function nivelCambio(delta) {
  if (delta == null) return null
  const a = Math.abs(delta)
  if (a <= 0.10) return 'normal'
  if (a <= 0.20) return 'confirmar'
  return 'fuerte'
}

// Planificado vs ejecutado SOLO sobre días cerrados y desde que el plan rige
// (vigenteDesde). Separa ayuno planificado, ayuno no planificado, día sin registro
// (problema de datos) y alimentó pese a ayuno planificado. Los días abiertos no cuentan.
export function planVsEjecutado({ calDias, planDias, lbDia, vigenteDesde }) {
  let planLb = 0, ejecLb = 0, ayPlan = 0, ayNoPlan = 0, sinReg = 0, fedExtra = 0, dias = 0
  for (const d of (calDias || [])) {
    if (!d.cerrado) continue
    if (vigenteDesde && d.fecha < vigenteDesde) continue
    dias++
    const previsto = planDias ? planDias[d.fecha] : undefined   // true=alimentar, false=ayuno
    if (d.tipo === 'sin') { sinReg++; if (previsto !== false) planLb += lbDia; continue }
    if (previsto === false) {
      if (d.tipo === 'fed') { fedExtra++; ejecLb += d.lb } else ayPlan++
    } else {
      planLb += lbDia
      if (d.tipo === 'fed') ejecLb += d.lb; else ayNoPlan++
    }
  }
  return { planLb, ejecLb, ayPlan, ayNoPlan, sinReg, fedExtra, dias }
}
