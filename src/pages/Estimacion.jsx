import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, lunesDe, sumarDias, miles, dinero } from '../lib/fechas'
import { estimar, cfgFinca } from '../lib/estimacion'

const NAVY = '#022847', AZUL = '#0D6CB0', BORDE = '#dce6ef', GRIS = '#7d8fa0'
const VERDE = '#0F6E56', AMBAR = '#854F0B', ROJO = '#8A2F2E'
const num1 = n => Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const num2 = n => Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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

// Estimación por piscina. Toma gramaje (muestreo), consumo de balanceado y los
// datos del ciclo, corre el motor y aplica el control de calidad de biomasa.
export default function Estimacion({ finca, esJefe }) {
  const [hasta, setHasta] = useState(() => { const d = domingoDe(hoyISO()); return d > hoyISO() ? hoyISO() : d })
  const cfg = useMemo(() => cfgFinca(finca.nombre), [finca.nombre])
  const [meta, setMeta] = useState(() => { try { return Number(localStorage.getItem('metaEst|' + finca.id)) || cfg.meta } catch { return cfg.meta } })
  const [ciclos, setCiclos] = useState([])
  const [sel, setSel] = useState('')
  const [valida, setValida] = useState({})     // cicloId -> { fuente, valor_lb }
  const [cargando, setCargando] = useState(true)
  const [userId, setUserId] = useState(null)
  const [aviso, setAviso] = useState(null)
  // Selector de biomasa (edición)
  const [fuenteSel, setFuenteSel] = useState('consumo')
  const [aprobTxt, setAprobTxt] = useState('')
  // Tolvas
  const [editTolvas, setEditTolvas] = useState(false)
  const [tolvasTxt, setTolvasTxt] = useState('')

  useEffect(() => { try { localStorage.setItem('metaEst|' + finca.id, String(meta)) } catch (e) { /* sin storage */ } }, [meta, finca.id])
  useEffect(() => { supabase.auth.getUser().then(({ data }) => setUserId(data?.user?.id || null)) }, [])

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    const { data: cic } = await supabase.schema('produccion').from('ciclo')
      .select('id, fecha_siembra, fecha_ocupacion, fecha_cierre, cantidad_larva, gramaje_precria, piscina:piscina_origen_id (id, nombre, hectareas, tolvas)')
      .eq('finca_id', finca.id).is('fecha_cierre', null).lte('fecha_siembra', hasta)
    const lista = (cic || []).filter(c => c.piscina)
    const ids = lista.map(c => c.id)
    if (!ids.length) { setCiclos([]); setSel(''); setCargando(false); return }
    const [{ data: mu }, { data: al }, { data: bv }] = await Promise.all([
      supabase.schema('produccion').from('muestreo').select('ciclo_id, fecha, peso_gramos').in('ciclo_id', ids).lte('fecha', hasta).order('fecha'),
      supabase.schema('produccion').from('alimentacion').select('ciclo_id, fecha, libras, sin_alimentacion').in('ciclo_id', ids).lte('fecha', hasta),
      supabase.schema('produccion').from('biomasa_validada').select('ciclo_id, fuente, valor_lb, fecha_ref').in('ciclo_id', ids).lte('fecha_ref', hasta).order('validada_en', { ascending: false }),
    ])
    const muDe = {}; (mu || []).forEach(m => { (muDe[m.ciclo_id] ||= []).push({ fecha: m.fecha, peso: Number(m.peso_gramos) }) })
    const alDe = {}; (al || []).forEach(r => { if (!r.sin_alimentacion) (alDe[r.ciclo_id] ||= []).push({ fecha: r.fecha, lb: Number(r.libras) || 0 }) })
    const bvDe = {}; (bv || []).forEach(r => { if (!bvDe[r.ciclo_id]) bvDe[r.ciclo_id] = { fuente: r.fuente, valor_lb: Number(r.valor_lb) } })
    setValida(bvDe)
    const ini14 = sumarDias(hasta, -14)
    const filas = lista.map(c => {
      const ms = muDe[c.id] || []
      const gramaje = ms.length ? ms[ms.length - 1].peso : 0
      const prev = [...ms].reverse().find(m => m.fecha <= ini14)
      const siembra = c.fecha_ocupacion || c.fecha_siembra
      const als = alDe[c.id] || []
      return {
        cicloId: c.id, piscinaId: c.piscina.id, nombre: c.piscina.nombre,
        area: Number(c.piscina.hectareas) || 0, tolvas: c.piscina.tolvas != null ? Number(c.piscina.tolvas) : null,
        larva: Number(c.cantidad_larva) || 0, pl: Number(c.gramaje_precria) || 0.5, siembra,
        gramaje, ultMuestreo: ms.length ? ms[ms.length - 1].fecha : null,
        gIni: prev ? prev.peso : 0, diasIni: prev ? diasEntre(siembra, prev.fecha) : 0,
        consumoAcum: als.reduce((t, r) => t + r.lb, 0),
        consumoVentana: als.filter(r => r.fecha > ini14).reduce((t, r) => t + r.lb, 0) / 2,
        dias: diasEntre(siembra, hasta),
      }
    }).filter(f => f.gramaje > 0).sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es', { numeric: true }))
    setCiclos(filas)
    setSel(s => (s && filas.some(f => f.cicloId === s)) ? s : (filas[0]?.cicloId || ''))
    setCargando(false)
  }, [finca.id, hasta])

  useEffect(() => { cargar() }, [cargar])

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

  // Biomasa seleccionada: la validada si existe, si no la de consumo.
  const vald = valida[sel]
  const biomasaSel = vald ? vald.valor_lb : (est ? est.biomasaConsumo : 0)
  const fuenteUsada = vald ? vald.fuente : 'consumo'
  const confianza = vald ? 'alta' : (bm ? bm.confianza : 'alta')
  const bloqueado = bm && bm.bloquea && !vald
  const factorBio = (est && est.biomasaConsumo > 0) ? biomasaSel / est.biomasaConsumo : 1

  async function validarBiomasa() {
    let valor = fuenteSel === 'consumo' ? est.biomasaConsumo : fuenteSel === 'densidad' ? est.biomasaDensidad : Number(String(aprobTxt).replace(',', '.'))
    if (!(valor > 0)) { setAviso({ tipo: 'error', texto: 'Pon un valor de biomasa válido.' }); return }
    const { error } = await supabase.schema('produccion').from('biomasa_validada')
      .insert({ ciclo_id: sel, fecha_ref: hasta, fuente: fuenteSel, valor_lb: valor, validada_por: userId })
    if (error) { setAviso({ tipo: 'error', texto: msgError(error, 'validar la biomasa') }); return }
    setValida(v => ({ ...v, [sel]: { fuente: fuenteSel, valor_lb: valor } }))
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

  const diasRest = est ? Math.max(0, est.diasProyectados - fila.dias) : 0
  const lbPorTolva = (!bloqueado && fila && fila.tolvas > 0 && est) ? biomasaSel * (est.planReco.pctDia / 100) / fila.tolvas : null
  const sacosSemSel = est ? est.planReco.sacosSem * factorBio : 0
  const usdSemSel = est ? est.planReco.usdSem * factorBio : 0
  // Tasa auditable y redondeo de sacos del plan recomendado.
  const escFactor = est ? (est.escenario === 'BAJO' ? 0.9 : est.escenario === 'ALTO' ? 1.1 : 1.0) : 1
  const tasaApl = est ? est.planReco.pctDia : 0
  const tasaBase = escFactor ? tasaApl / escFactor : tasaApl
  const lbDiaSel = est ? est.planReco.lbDia * factorBio : 0
  const sacosDiaSel = lbDiaSel / 55
  const pedir = Math.round(sacosSemSel)
  const muestreoDias = (fila && fila.ultMuestreo) ? diasEntre(fila.ultMuestreo, hasta) : null
  const porQueTxt = est ? `Está ${est.atrasoProyectado <= 0 ? num1(Math.abs(est.atrasoProyectado)) + ' días adelantada' : num1(est.atrasoProyectado) + ' días atrasada'}, la biomasa es consistente (dif. ${bm ? Math.round(bm.difPct * 100) : 0}%), y el FCR ${num2(est.fcrParcial)} ${est.fcrParcial <= est.fcrMax ? 'está por debajo del' : 'supera el'} máximo ${num2(est.fcrMax)}.` : ''

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
        </div>
      </div>

      {aviso && <div style={{ borderRadius: '10px', padding: '11px 14px', fontSize: '13px', marginBottom: '12px', background: aviso.tipo === 'ok' ? '#E1F5EE' : '#FBEAEA', color: aviso.tipo === 'ok' ? '#0F6E56' : '#8A2F2E' }}>{aviso.texto}</div>}

      {cargando ? (
        <Caja><Centro>Cargando…</Centro></Caja>
      ) : !fila ? (
        <Caja><Centro>No hay piscinas con muestreo de gramaje en esta finca a la fecha.<br />
          <span style={{ fontSize: '12px' }}>Registra el gramaje en el módulo Gramaje para que salga la estimación.</span>
        </Centro></Caja>
      ) : (
      <>
        {/* Veredicto: verde si datos consistentes; ámbar/rojo si hay que validar la biomasa */}
        {bloqueado ? (
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', background: '#e7f6ef', border: '0.5px solid #bfe6d2', borderRadius: '12px', padding: '13px 16px', marginBottom: '14px' }}>
            <span style={{ width: '26px', height: '26px', borderRadius: '50%', background: VERDE, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flex: '0 0 auto' }}>✓</span>
            <div>
              <div style={{ fontSize: '14.5px', fontWeight: 500, color: VERDE }}>{est.lectura.txt}</div>
              <div style={{ fontSize: '12.5px', color: '#3d7a63' }}>
                Llegaría a {num1(est.metaUsa)} g en <b>{num1(diasRest)} días</b> (día {num1(est.diasProyectados)} de cultivo)
                {bm && bm.nivel === 'precaución' && <span style={{ color: AMBAR }}> · ojo: biomasa con {Math.round(bm.difPct * 100)}% de diferencia</span>}
              </div>
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
          <Kpi k="Biomasa seleccionada" v={miles(biomasaSel)} u="lb" nota={`${cap(fuenteUsada)} · confianza ${confianza}`} notaColor={confianza === 'alta' ? VERDE : confianza === 'media' ? AMBAR : AMBAR} />
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
              <FilaBio k="FCR parcial" a={num2(est.fcrParcial)} b={num2(est.fcrParcial > 0 ? est.consumoAcum / est.biomasaDensidad : 0)} dif="—" col={GRIS} />
            </div>
            <div style={{ borderTop: '0.5px solid #eef3f7', marginTop: '12px', paddingTop: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
              <span style={{ fontSize: '12px', color: GRIS }}>FCR máximo para {num1(fila.gramaje)} g: <b style={{ color: NAVY, fontWeight: 500 }}>{num2(est.fcrMax)}</b></span>
              <span style={{ fontSize: '12px', color: GRIS }}>Usando: <b style={{ color: NAVY, fontWeight: 500 }}>{cap(fuenteUsada)}</b>{vald && esJefe && <span onClick={quitarValidacion} style={{ color: AZUL, cursor: 'pointer' }}> · cambiar</span>}</span>
            </div>
            {!bloqueado && bm && (
              <div style={{ fontSize: '11.5px', color: bm.color, marginTop: '8px' }}>
                Confianza {confianza}: diferencia {Math.round(bm.difPct * 100)}%{muestreoDias != null && ` · muestreo de hace ${muestreoDias} día${muestreoDias === 1 ? '' : 's'}`}
              </div>
            )}

            {/* Selector de biomasa (jefe) cuando hay que validar o no está validada */}
            {esJefe && !vald && (
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

        {/* Plan + tolvas */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: '14px' }}>
          <Caja>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', marginBottom: '14px' }}>
              <Titulo sinMargen>Plan de alimentación · esta semana</Titulo>
              {!bloqueado && <span style={{ fontSize: '11.5px', fontWeight: 500, color: VERDE, background: VERDE + '18', padding: '3px 10px', borderRadius: '20px' }}>✓ Plan sugerido: {cap(est.escenario)}</span>}
            </div>
            {bloqueado ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '11px', background: '#f6f9fb', borderRadius: '9px', padding: '13px 15px' }}>
                <span style={{ fontSize: '18px' }}>🔒</span>
                <div style={{ fontSize: '12.5px', color: GRIS }}>Elige y <b>valida la biomasa</b> arriba para desbloquear el plan. Mientras tanto, los sacos de abajo son solo <b>simulación</b>.</div>
              </div>
            ) : (<>
              <div style={{ background: '#f6f9fb', borderRadius: '9px', padding: '11px 13px', marginBottom: '13px', fontSize: '12px', color: '#4a5a67', lineHeight: 1.6 }}>
                <b style={{ color: NAVY, fontWeight: 500 }}>¿Por qué {cap(est.escenario)}?</b> {porQueTxt}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '13px', marginBottom: '13px' }}>
                <div style={{ background: '#f6f9fb', borderRadius: '9px', padding: '12px 14px', fontSize: '12.5px' }}>
                  <div style={titMini}>Cómo sale la dosis</div>
                  <Row k={`Tasa base (${num1(fila.gramaje)} g)`} v={num2(tasaBase) + '%'} />
                  <Row k={`Ajuste intensidad ${cap(est.escenario)}`} v={(escFactor >= 1 ? '+' : '') + Math.round((escFactor - 1) * 100) + '%'} />
                  <Row k="Tasa aplicada" v={num2(tasaApl) + '%'} fuerte top />
                  <Row k={`${miles(biomasaSel)} lb × ${num2(tasaApl)}%`} v={miles(lbDiaSel) + ' lb/día'} fuerte />
                </div>
                <div style={{ background: '#f6f9fb', borderRadius: '9px', padding: '12px 14px', fontSize: '12.5px' }}>
                  <div style={titMini}>Sacos a pedir</div>
                  <Row k="Por día" v={num1(sacosDiaSel) + ' sacos'} fuerte />
                  <Row k="Semana calculada" v={num1(sacosSemSel) + ' sacos'} />
                  <Row k="Pedir (redondeado)" v={pedir + ' sacos'} fuerte top azul />
                  <Row k="Costo semana" v={dinero(usdSemSel)} />
                </div>
              </div>
            </>)}
            <div style={{ fontSize: '12.5px', color: GRIS, margin: bloqueado ? '12px 0 0' : '0 0 12px' }}>Alimento: <b style={{ color: NAVY, fontWeight: 500 }}>{est.alimento.nombre}</b> · {dinero(est.alimento.usdSaco)} el saco</div>
            <div style={{ borderTop: '0.5px solid #eef3f7', paddingTop: '12px', display: 'grid', gridTemplateColumns: 'auto 1fr 1fr 1fr', gap: '9px 12px', fontSize: '12.5px', alignItems: 'center' }}>
              <span style={{ color: '#9fb0bf', fontSize: '11px' }}>Intensidad</span>
              {['BAJO', 'MEDIO', 'ALTO'].map(e => <span key={e} style={{ textAlign: 'right', color: (!bloqueado && est.escenario === e) ? VERDE : GRIS, fontWeight: (!bloqueado && est.escenario === e) ? 500 : 400 }}>{cap(e)}</span>)}
              <span style={{ color: GRIS }}>Tasa aplicada</span>
              {['BAJO', 'MEDIO', 'ALTO'].map(e => <b key={e} style={{ textAlign: 'right', fontWeight: (!bloqueado && est.escenario === e) ? 500 : 400, color: NAVY }}>{num2(est.plan[e].pctDia)}%</b>)}
              <span style={{ color: GRIS }}>Pedir sacos/semana</span>
              {['BAJO', 'MEDIO', 'ALTO'].map(e => <span key={e} style={{ textAlign: 'right', color: GRIS }}>{Math.round(est.plan[e].sacosSem * factorBio)}</span>)}
            </div>
          </Caja>

          <Caja>
            <Titulo>Reparto por tolva</Titulo>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <span style={{ fontSize: '13px', color: GRIS }}>Número de tolvas</span>
              {editTolvas ? (
                <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                  <input autoFocus type="number" min="0" value={tolvasTxt} onChange={e => setTolvasTxt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') guardarTolvas() }} style={{ ...inp, width: '62px' }} />
                  <button onClick={guardarTolvas} style={btnAzul}>Guardar</button>
                </span>
              ) : (
                <span style={{ display: 'inline-flex', gap: '9px', alignItems: 'center' }}>
                  <span style={{ background: '#f6f9fb', border: '0.5px solid ' + BORDE, borderRadius: '8px', padding: '6px 12px', fontSize: '14px', fontWeight: 500 }}>{fila.tolvas != null ? fila.tolvas : '—'}</span>
                  {esJefe && <button onClick={() => { setTolvasTxt(fila.tolvas != null ? String(fila.tolvas) : ''); setEditTolvas(true) }} style={btnLink}>{fila.tolvas != null ? 'Editar' : 'Configurar'}</button>}
                </span>
              )}
            </div>
            {lbPorTolva != null ? (
              <div style={{ background: '#e8f1fb', borderRadius: '9px', padding: '13px 14px', textAlign: 'center' }}>
                <div style={{ fontSize: '11.5px', color: '#185FA5' }}>Lbs de camarón por tolva</div>
                <div style={{ fontSize: '26px', fontWeight: 500, color: NAVY }}>{miles(biomasaSel / fila.tolvas)} <span style={{ fontSize: '13px', color: GRIS }}>lb</span></div>
              </div>
            ) : (
              <div style={{ background: '#f6f9fb', borderRadius: '9px', padding: '13px 14px', fontSize: '12.5px', color: GRIS, textAlign: 'center' }}>{bloqueado ? 'Valida la biomasa para ver el reparto.' : 'Configura el número de tolvas.'}</div>
            )}
            <div style={{ fontSize: '11.5px', color: '#9fb0bf', marginTop: '10px', lineHeight: 1.5 }}>Revisa la carga por tolva cada semana. Si supera la capacidad o el rango operativo, ajusta tolvas, raciones u horarios.</div>
          </Caja>
        </div>
      </>
      )}
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
