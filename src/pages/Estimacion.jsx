import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, lunesDe, sumarDias, miles, dinero } from '../lib/fechas'
import { estimar } from '../lib/estimacion'

const NAVY = '#022847', AZUL = '#0D6CB0', BORDE = '#dce6ef', GRIS = '#7d8fa0'
const VERDE = '#0F6E56', AMBAR = '#854F0B', ROJO = '#8A2F2E'
const num1 = n => Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const num2 = n => Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct0 = n => Math.round(Number(n || 0) * 100) + '%'
const diasEntre = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000)

// Estimación por piscina. Toma el gramaje (muestreo), el consumo de balanceado
// y los datos del ciclo, y corre el motor (lib/estimacion) para proyectar.
export default function Estimacion({ finca, esJefe }) {
  const [hasta, setHasta] = useState(hoyISO())
  const [meta, setMeta] = useState(() => { try { return Number(localStorage.getItem('metaEst|' + finca.id)) || 35 } catch { return 35 } })
  const [ciclos, setCiclos] = useState([])     // [{ cicloId, piscinaId, nombre, area, larva, pl, siembra, tolvas, gramaje, gIni, diasIni, consumoAcum, consumoVentana, dias }]
  const [sel, setSel] = useState('')           // cicloId elegido
  const [cargando, setCargando] = useState(true)
  const [editTolvas, setEditTolvas] = useState(false)
  const [tolvasTxt, setTolvasTxt] = useState('')
  const [aviso, setAviso] = useState(null)

  useEffect(() => { try { localStorage.setItem('metaEst|' + finca.id, String(meta)) } catch (e) { /* sin storage */ } }, [meta, finca.id])

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    // Ciclos activos (sembrados, sin cerrar) a la fecha.
    const { data: cic } = await supabase.schema('produccion').from('ciclo')
      .select('id, fecha_siembra, fecha_ocupacion, fecha_cierre, cantidad_larva, gramaje_precria, piscina:piscina_origen_id (id, nombre, hectareas, tolvas)')
      .eq('finca_id', finca.id).is('fecha_cierre', null).lte('fecha_siembra', hasta)
    const lista = (cic || []).filter(c => c.piscina)
    const ids = lista.map(c => c.id)
    if (!ids.length) { setCiclos([]); setSel(''); setCargando(false); return }
    const [{ data: mu }, { data: al }] = await Promise.all([
      supabase.schema('produccion').from('muestreo').select('ciclo_id, fecha, peso_gramos').in('ciclo_id', ids).lte('fecha', hasta).order('fecha'),
      supabase.schema('produccion').from('alimentacion').select('ciclo_id, fecha, libras, sin_alimentacion').in('ciclo_id', ids).lte('fecha', hasta),
    ])
    const muDe = {}; (mu || []).forEach(m => { (muDe[m.ciclo_id] ||= []).push({ fecha: m.fecha, peso: Number(m.peso_gramos) }) })
    const alDe = {}; (al || []).forEach(r => { if (!r.sin_alimentacion) (alDe[r.ciclo_id] ||= []).push({ fecha: r.fecha, lb: Number(r.libras) || 0 }) })
    const ini14 = sumarDias(hasta, -14)
    const filas = lista.map(c => {
      const ms = muDe[c.id] || []
      const gramaje = ms.length ? ms[ms.length - 1].peso : 0
      // gramaje de la ventana: último muestreo con fecha <= hasta-14.
      const prev = [...ms].reverse().find(m => m.fecha <= ini14)
      const siembra = c.fecha_ocupacion || c.fecha_siembra
      const dias = diasEntre(siembra, hasta)
      const gIni = prev ? prev.peso : 0
      const diasIni = prev ? diasEntre(siembra, prev.fecha) : 0
      const als = alDe[c.id] || []
      const consumoAcum = als.reduce((t, r) => t + r.lb, 0)
      const ventana = als.filter(r => r.fecha > ini14).reduce((t, r) => t + r.lb, 0)
      const consumoVentana = ventana / 2   // 2 semanas
      return {
        cicloId: c.id, piscinaId: c.piscina.id, nombre: c.piscina.nombre,
        area: Number(c.piscina.hectareas) || 0, tolvas: c.piscina.tolvas != null ? Number(c.piscina.tolvas) : null,
        larva: Number(c.cantidad_larva) || 0, pl: Number(c.gramaje_precria) || 0.5, siembra,
        gramaje, gIni, diasIni, consumoAcum, consumoVentana, dias,
      }
    }).filter(f => f.gramaje > 0)   // solo las que ya tienen muestreo
      .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es', { numeric: true }))
    setCiclos(filas)
    setSel(s => (s && filas.some(f => f.cicloId === s)) ? s : (filas[0]?.cicloId || ''))
    setCargando(false)
  }, [finca.id, hasta])

  useEffect(() => { cargar() }, [cargar])

  const fila = ciclos.find(c => c.cicloId === sel)
  const est = useMemo(() => fila ? estimar({
    area: fila.area, dias: fila.dias, pl: fila.pl, gramajeHoy: fila.gramaje,
    consumoAcum: fila.consumoAcum, larva: fila.larva, gInicio: fila.gIni,
    diasInicio: fila.diasIni, consumoVentana: fila.consumoVentana, meta,
  }) : null, [fila, meta])

  async function guardarTolvas() {
    const n = parseInt(tolvasTxt, 10)
    if (!isFinite(n) || n < 0) { setEditTolvas(false); return }
    const { error } = await supabase.schema('produccion').from('piscina').update({ tolvas: n }).eq('id', fila.piscinaId)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar las tolvas. ' + error.message }); return }
    setCiclos(cs => cs.map(c => c.cicloId === sel ? { ...c, tolvas: n } : c))
    setEditTolvas(false)
  }

  const lbPorTolva = (est && fila && fila.tolvas > 0) ? est.biomasaConsumo / fila.tolvas : null
  const tono = est ? est.lectura.tono : 'ok'
  const colTono = tono === 'ok' ? VERDE : tono === 'alerta' ? AMBAR : ROJO
  const bgTono = tono === 'ok' ? '#e7f6ef' : tono === 'alerta' ? '#FBF5E9' : '#FBEAEA'
  const bdTono = tono === 'ok' ? '#bfe6d2' : tono === 'alerta' ? '#ecd9b4' : '#e7cccb'
  const sem = { desde: lunesDe(hasta), hasta: sumarDias(lunesDe(hasta), 6) }

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY, padding: '1.4rem', background: '#eef2f6', minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <div>
          <h1 style={{ fontSize: '21px', fontWeight: 500, margin: '0 0 2px' }}>Estimación · Por piscina</h1>
          <div style={{ fontSize: '12.5px', color: GRIS }}>{finca.nombre} · Todo sale solo del sistema</div>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          {ciclos.length > 0 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12.5px', color: GRIS }}>
              Piscina
              <select value={sel} onChange={e => setSel(e.target.value)} style={inp}>
                {ciclos.map(c => <option key={c.cicloId} value={c.cicloId}>{c.nombre}</option>)}
              </select>
            </label>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12.5px', color: GRIS }}>
            Meta
            <input type="number" min="1" value={meta} onChange={e => setMeta(Number(e.target.value) || 1)} style={{ ...inp, width: '62px' }} /> g
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12.5px', color: GRIS }}>
            <input type="date" value={hasta} max={hoyISO()} onChange={e => setHasta(e.target.value)} style={inp} />
          </label>
        </div>
      </div>

      {aviso && <div style={{ borderRadius: '10px', padding: '11px 14px', fontSize: '13px', marginBottom: '12px', background: '#FBEAEA', color: '#8A2F2E' }}>{aviso.texto}</div>}

      {cargando ? (
        <Caja><Centro>Cargando…</Centro></Caja>
      ) : !fila ? (
        <Caja><Centro>No hay piscinas con muestreo de gramaje en esta finca a la fecha.<br />
          <span style={{ fontSize: '12px' }}>Registra el gramaje en el módulo Gramaje para que salga la estimación.</span>
        </Centro></Caja>
      ) : (
      <>
        {/* Veredicto */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', background: bgTono, border: '0.5px solid ' + bdTono, borderRadius: '12px', padding: '13px 16px', marginBottom: '14px' }}>
          <span style={{ width: '26px', height: '26px', borderRadius: '50%', background: colTono, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flex: '0 0 auto' }}>{tono === 'ok' ? '✓' : '!'}</span>
          <div>
            <div style={{ fontSize: '14.5px', fontWeight: 500, color: colTono }}>{est.lectura.txt}</div>
            <div style={{ fontSize: '12.5px', color: GRIS }}>
              Llega a los {num1(est.metaUsa)} g en ~<b style={{ color: NAVY }}>{num1(est.diasProyectados)} días</b> de cultivo ·{' '}
              {est.atrasoProyectado <= -0.5 ? <b style={{ color: VERDE }}>{num1(Math.abs(est.atrasoProyectado))} días antes</b>
                : est.atrasoProyectado >= 0.5 ? <b style={{ color: AMBAR }}>{num1(est.atrasoProyectado)} días después</b>
                : <b>en el tiempo esperado</b>}
            </div>
          </div>
        </div>

        {/* KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '11px', marginBottom: '14px' }}>
          <Kpi k="Gramaje hoy" v={num1(fila.gramaje)} u="g" />
          <Kpi k="Días de cultivo" v={String(fila.dias)} />
          <Kpi k="Días a la meta" v={num1(est.diasProyectados)} color={AZUL} />
          <Kpi k="Biomasa estimada" v={miles(est.biomasaConsumo)} u="lb" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', marginBottom: '14px' }}>
          <Caja>
            <Titulo>Velocidad de crecimiento</Titulo>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '13px' }}>
              <Linea k="G/día observado" v={num1(est.gDiaObs) + ' g'} fuerte />
              <Linea k="G/día objetivo" v={num1(est.gDiaObjetivo) + ' g'} />
              <Linea k="Desempeño" v={pct0(est.desempeno)} color={est.desempeno >= 1 ? VERDE : AMBAR} fuerte />
              <div style={{ borderTop: '0.5px solid #eef3f7', paddingTop: '14px' }}>
                <Linea k="Atraso / adelanto" fuerte color={est.atrasoProyectado <= 0 ? VERDE : AMBAR}
                  v={est.atrasoProyectado <= 0 ? `${num1(Math.abs(est.atrasoProyectado))} días (adelantado)` : `${num1(est.atrasoProyectado)} días (atrasado)`} />
              </div>
            </div>
          </Caja>
          <Caja>
            <Titulo>Biomasa y sobrevivencia</Titulo>
            <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1fr', gap: '14px 10px', fontSize: '12.5px', alignItems: 'center' }}>
              <span /><span style={{ color: GRIS, textAlign: 'right', fontSize: '11px' }}>Por consumo</span><span style={{ color: GRIS, textAlign: 'right', fontSize: '11px' }}>Por densidad</span>
              <span style={{ color: GRIS }}>Biomasa (lb)</span><b style={{ textAlign: 'right', fontWeight: 500 }}>{miles(est.biomasaConsumo)}</b><span style={{ textAlign: 'right', color: GRIS }}>{miles(est.biomasaDensidad)}</span>
              <span style={{ color: GRIS }}>Sobrevivencia</span><b style={{ textAlign: 'right', fontWeight: 500 }}>{pct0(est.sobrevConsumo)}</b><span style={{ textAlign: 'right', color: GRIS }}>{pct0(est.sobrevDensidad)}</span>
              <span style={{ color: GRIS }}>Lb por hectárea</span><span style={{ textAlign: 'right' }}>{miles(est.lbHa)}</span><span />
              <span style={{ color: GRIS, borderTop: '0.5px solid #eef3f7', paddingTop: '12px' }}>FCR parcial</span>
              <b style={{ textAlign: 'right', fontWeight: 500, borderTop: '0.5px solid #eef3f7', paddingTop: '12px', color: (est.fcrParcial > 0 && est.fcrParcial > est.fcrMax) ? ROJO : NAVY }}>{num2(est.fcrParcial)}</b>
              <span style={{ textAlign: 'right', color: GRIS, borderTop: '0.5px solid #eef3f7', paddingTop: '12px' }}>máx {num2(est.fcrMax)}</span>
            </div>
          </Caja>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: '14px' }}>
          <Caja>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', marginBottom: '14px' }}>
              <Titulo sinMargen>Plan de alimento · esta semana</Titulo>
              <span style={{ fontSize: '11.5px', fontWeight: 500, color: AMBAR, background: AMBAR + '18', padding: '3px 10px', borderRadius: '20px' }}>Recomendado: {cap(est.escenario)}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '11px', marginBottom: '14px' }}>
              <Mini k="Sacos por semana" v={miles(est.planReco.sacosSem)} />
              <Mini k="US$ por semana" v={dinero(est.planReco.usdSem)} />
            </div>
            <div style={{ fontSize: '12.5px', color: GRIS, marginBottom: '12px' }}>Alimento que toca: <b style={{ color: NAVY, fontWeight: 500 }}>{est.alimento.nombre}</b> · {dinero(est.alimento.usdSaco)} el saco</div>
            <div style={{ borderTop: '0.5px solid #eef3f7', paddingTop: '12px', display: 'grid', gridTemplateColumns: 'auto 1fr 1fr 1fr', gap: '10px 12px', fontSize: '12.5px', alignItems: 'center' }}>
              <span style={{ color: GRIS, fontSize: '11px' }}>Si eligieras</span>
              <span style={{ textAlign: 'right', color: GRIS }}>Bajo</span><span style={{ textAlign: 'right', color: GRIS }}>Medio</span><span style={{ textAlign: 'right', color: GRIS }}>Alto</span>
              <span style={{ color: GRIS }}>Sacos por semana</span>
              <b style={{ textAlign: 'right', color: est.escenario === 'BAJO' ? AMBAR : NAVY }}>{miles(est.plan.BAJO.sacosSem)}</b>
              <b style={{ textAlign: 'right', color: est.escenario === 'MEDIO' ? AMBAR : NAVY, fontWeight: est.escenario === 'MEDIO' ? 500 : 400 }}>{miles(est.plan.MEDIO.sacosSem)}</b>
              <b style={{ textAlign: 'right', color: est.escenario === 'ALTO' ? AMBAR : NAVY, fontWeight: est.escenario === 'ALTO' ? 500 : 400 }}>{miles(est.plan.ALTO.sacosSem)}</b>
            </div>
          </Caja>

          <Caja>
            <Titulo>Tolvas · esta semana</Titulo>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
              <span style={{ fontSize: '13px', color: GRIS }}>Número de tolvas</span>
              {editTolvas ? (
                <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                  <input autoFocus type="number" min="0" value={tolvasTxt} onChange={e => setTolvasTxt(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') guardarTolvas() }} style={{ ...inp, width: '64px' }} />
                  <button onClick={guardarTolvas} style={btnAzul}>Guardar</button>
                </span>
              ) : (
                <span style={{ display: 'inline-flex', gap: '9px', alignItems: 'center' }}>
                  <span style={{ background: '#f6f9fb', border: '0.5px solid ' + BORDE, borderRadius: '8px', padding: '6px 12px', fontSize: '14px', fontWeight: 500 }}>{fila.tolvas != null ? fila.tolvas : '—'}</span>
                  {esJefe && <button onClick={() => { setTolvasTxt(fila.tolvas != null ? String(fila.tolvas) : ''); setEditTolvas(true) }} style={btnLink}>Editar</button>}
                </span>
              )}
            </div>
            {lbPorTolva != null ? (
              <div style={{ background: '#e8f1fb', borderRadius: '9px', padding: '13px 14px', textAlign: 'center' }}>
                <div style={{ fontSize: '11.5px', color: '#185FA5' }}>Lbs de camarón por tolva</div>
                <div style={{ fontSize: '26px', fontWeight: 500, color: NAVY }}>{miles(lbPorTolva)} <span style={{ fontSize: '13px', color: GRIS }}>lb</span></div>
              </div>
            ) : (
              <div style={{ background: '#f6f9fb', borderRadius: '9px', padding: '13px 14px', fontSize: '12.5px', color: GRIS, textAlign: 'center' }}>Pon el número de tolvas para ver las lbs por tolva.</div>
            )}
            <div style={{ fontSize: '11.5px', color: '#9fb0bf', marginTop: '10px', lineHeight: 1.5 }}>Míralo cada semana: si sube mucho, <b style={{ color: '#185FA5', fontWeight: 500 }}>Agrega tolvas</b>; si queda bajo, puedes <b style={{ color: '#185FA5', fontWeight: 500 }}>Quitar</b>.</div>
          </Caja>
        </div>
      </>
      )}
    </div>
  )
}

const inp = { padding: '7px 11px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY, boxSizing: 'border-box' }
const btnAzul = { padding: '7px 13px', fontSize: '12.5px', fontFamily: 'inherit', fontWeight: 500, border: 'none', borderRadius: '8px', background: AZUL, color: 'white', cursor: 'pointer' }
const btnLink = { background: 'none', border: 'none', color: AZUL, fontFamily: 'inherit', fontSize: '12.5px', cursor: 'pointer', padding: 0, fontWeight: 500 }
const cap = s => { const t = String(s || '').toLowerCase(); return t ? t.charAt(0).toUpperCase() + t.slice(1) : t }

function Caja({ children }) {
  return <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '16px 18px' }}>{children}</div>
}
function Centro({ children }) {
  return <div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px', lineHeight: 1.6 }}>{children}</div>
}
function Titulo({ children, sinMargen }) {
  return <div style={{ fontSize: '11px', color: GRIS, textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: sinMargen ? 0 : '14px' }}>{children}</div>
}
function Kpi({ k, v, u, color }) {
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '10px', padding: '13px 15px' }}>
      <div style={{ fontSize: '11.5px', color: GRIS }}>{k}</div>
      <div style={{ fontSize: '23px', fontWeight: 500, color: color || NAVY }}>{v}{u && <span style={{ fontSize: '13px', color: GRIS }}> {u}</span>}</div>
    </div>
  )
}
function Mini({ k, v }) {
  return <div style={{ background: '#f6f9fb', borderRadius: '9px', padding: '12px 14px' }}><div style={{ fontSize: '11.5px', color: GRIS }}>{k}</div><div style={{ fontSize: '22px', fontWeight: 500, color: NAVY }}>{v}</div></div>
}
function Linea({ k, v, fuerte, color }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: GRIS }}>{k}</span><span style={{ fontWeight: fuerte ? 500 : 400, color: color || NAVY }}>{v}</span></div>
}
