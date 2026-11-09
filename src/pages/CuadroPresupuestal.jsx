import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { dinero } from '../lib/fechas'

// Cuadro presupuestal · módulo Producción (F1)
// Hoja mensual por finca: la contadora/jefe carga todos los costos del mes y la
// app calcula el costo por hectárea-día TOTAL y REAL. No se cierra: va
// calculando en vivo. La precarga desde la app (balanceado, insumos, diésel) y
// la conexión a Rentabilidad llegan en fases siguientes.
const NAVY = '#022847', AZUL = '#0D6CB0', BORDE = '#dce6ef', GRIS = '#7d8fa0', VERDE = '#0F6E56', AMBAR = '#BA7517'
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
const GRUPOS = [
  ['BALANCEADO_LARVA', 'Balanceado y larva'],
  ['MATERIA_PRIMA', 'Materia prima · insumos'],
  ['MANO_OBRA', 'Mano de obra'],
  ['INDIRECTOS', 'Indirectos'],
  ['OTROS_ADMIN', 'Otros administrativos'],
  ['ACTIVOS_MEJORAS', 'Activos y mejoras'],
]
const diasDelMes = (y, m) => new Date(y, m, 0).getDate()  // m = 1..12
const num2 = n => (Number(n) || 0).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
// Parser tolerante: "319.210,80" | "319210.8" | "1,234" -> número.
function parseNum(s) {
  if (s == null || s === '') return 0
  let t = String(s).trim().replace(/[^0-9.,-]/g, '')
  if (t.includes('.') && t.includes(',')) t = t.replace(/\./g, '').replace(',', '.')
  else if (t.includes(',')) t = t.replace(',', '.')
  const v = Number(t); return isFinite(v) ? v : 0
}

const inp = { padding: '7px 11px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY, boxSizing: 'border-box' }
const btnAzul = { padding: '8px 15px', fontSize: '12.5px', fontFamily: 'inherit', fontWeight: 500, border: 'none', borderRadius: '8px', background: AZUL, color: 'white', cursor: 'pointer' }

export default function CuadroPresupuestal({ finca, esJefe }) {
  const hoy = new Date()
  const [anio, setAnio] = useState(hoy.getFullYear())
  const [mes, setMes] = useState(hoy.getMonth() + 1)
  const [rubros, setRubros] = useState([])
  const [mesId, setMesId] = useState(null)
  const [ha, setHa] = useState('')
  const [dias, setDias] = useState(String(diasDelMes(hoy.getFullYear(), hoy.getMonth() + 1)))
  const [txt, setTxt] = useState({})            // rubro_id -> string del valor
  const [abierto, setAbierto] = useState({ BALANCEADO_LARVA: true, MATERIA_PRIMA: true })
  const [nuevo, setNuevo] = useState({})        // grupo -> nombre en edición
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [aviso, setAviso] = useState(null)
  const [userId, setUserId] = useState(null)

  useEffect(() => { supabase.auth.getUser().then(({ data }) => setUserId(data?.user?.id || null)) }, [])

  const cargarRubros = useCallback(async () => {
    const { data } = await supabase.schema('produccion').from('cuadro_rubro')
      .select('id, grupo, nombre, orden, origen, incluye_real').eq('activo', true).order('grupo').order('orden')
    setRubros(data || [])
  }, [])
  useEffect(() => { cargarRubros() }, [cargarRubros])

  // Carga la hoja del mes (cabecera + valores) al cambiar finca/mes.
  useEffect(() => {
    let vivo = true
    ;(async () => {
      setCargando(true)
      const { data: cm } = await supabase.schema('produccion').from('cuadro_mes')
        .select('id, hectareas, dias').eq('finca_id', finca.id).eq('anio', anio).eq('mes', mes).maybeSingle()
      if (!vivo) return
      if (cm) {
        setMesId(cm.id); setHa(cm.hectareas ? String(cm.hectareas) : ''); setDias(String(cm.dias || diasDelMes(anio, mes)))
        const { data: vs } = await supabase.schema('produccion').from('cuadro_valor')
          .select('rubro_id, valor').eq('cuadro_mes_id', cm.id)
        if (!vivo) return
        const m = {}; (vs || []).forEach(v => { if (Number(v.valor)) m[v.rubro_id] = String(v.valor) })
        setTxt(m)
      } else {
        setMesId(null); setHa(''); setDias(String(diasDelMes(anio, mes))); setTxt({})
      }
      setCargando(false)
    })()
    return () => { vivo = false }
  }, [finca.id, anio, mes])

  const val = id => parseNum(txt[id])
  const totalesGrupo = useMemo(() => {
    const t = {}; for (const [g] of GRUPOS) t[g] = 0
    for (const r of rubros) t[r.grupo] = (t[r.grupo] || 0) + val(r.id)
    return t
  }, [rubros, txt])
  const { bruto, real, haDiaTotal, haDiaReal } = useMemo(() => {
    let b = 0, rl = 0
    for (const r of rubros) { const v = val(r.id); b += v; if (r.incluye_real) rl += v }
    const h = parseNum(ha), d = Number(dias) || 0
    const div = h > 0 && d > 0 ? h * d : 0
    return { bruto: b, real: rl, haDiaTotal: div ? b / div : 0, haDiaReal: div ? rl / div : 0 }
  }, [rubros, txt, ha, dias])

  async function guardar() {
    if (!esJefe) return
    setGuardando(true)
    const ahora = new Date().toISOString()
    const { data: cm, error } = await supabase.schema('produccion').from('cuadro_mes')
      .upsert({ finca_id: finca.id, anio, mes, hectareas: parseNum(ha), dias: Number(dias) || diasDelMes(anio, mes), actualizado_por: userId, actualizado_en: ahora }, { onConflict: 'finca_id,anio,mes' })
      .select('id').single()
    if (error) { setGuardando(false); setAviso({ tipo: 'error', texto: 'No se pudo guardar la cabecera. ' + error.message }); return }
    setMesId(cm.id)
    const filas = rubros.map(r => ({ cuadro_mes_id: cm.id, rubro_id: r.id, valor: val(r.id), fuente: 'manual' }))
    const { error: e2 } = await supabase.schema('produccion').from('cuadro_valor').upsert(filas, { onConflict: 'cuadro_mes_id,rubro_id' })
    setGuardando(false)
    setAviso(e2 ? { tipo: 'error', texto: 'No se pudieron guardar los valores. ' + e2.message } : { tipo: 'ok', texto: `Cuadro de ${MESES[mes - 1]} ${anio} guardado.` })
  }

  async function agregarRubro(grupo) {
    const nombre = (nuevo[grupo] || '').trim(); if (!nombre) return
    const maxOrden = Math.max(0, ...rubros.filter(r => r.grupo === grupo).map(r => r.orden))
    const incluye_real = !(grupo === 'BALANCEADO_LARVA' || grupo === 'ACTIVOS_MEJORAS')
    const { error } = await supabase.schema('produccion').from('cuadro_rubro')
      .insert({ grupo, nombre, orden: maxOrden + 10, incluye_real })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo agregar el rubro. ' + error.message }); return }
    setNuevo(n => ({ ...n, [grupo]: '' })); cargarRubros()
  }

  const pasoMes = d => {
    let y = anio, m = mes + d
    if (m < 1) { m = 12; y-- } else if (m > 12) { m = 1; y++ }
    setAnio(y); setMes(m)
  }

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY, padding: '1.4rem', background: '#eef2f6', minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <div>
          <h1 style={{ fontSize: '21px', fontWeight: 500, margin: '0 0 2px' }}>Cuadro presupuestal</h1>
          <div style={{ fontSize: '12.5px', color: GRIS }}>{finca.nombre} · {MESES[mes - 1]} {anio}</div>
        </div>
        <div style={{ display: 'flex', gap: '9px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '9px', padding: '4px 8px', fontSize: '12.5px' }}>
            <button onClick={() => pasoMes(-1)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: GRIS, fontSize: '16px', fontFamily: 'inherit' }}>‹</button>
            <b style={{ fontWeight: 500, minWidth: '128px', textAlign: 'center' }}>{MESES[mes - 1]} {anio}</b>
            <button onClick={() => pasoMes(1)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: GRIS, fontSize: '16px', fontFamily: 'inherit' }}>›</button>
          </span>
        </div>
      </div>

      {aviso && <div style={{ borderRadius: '10px', padding: '11px 14px', fontSize: '13px', marginBottom: '12px', background: aviso.tipo === 'ok' ? '#E1F5EE' : '#FBEAEA', color: aviso.tipo === 'ok' ? VERDE : '#8A2F2E' }}>{aviso.texto}</div>}

      <div style={{ display: 'flex', gap: '10px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ fontSize: '12.5px', color: GRIS, display: 'inline-flex', alignItems: 'center', gap: '7px' }}>Hectáreas
          <input value={ha} onChange={e => setHa(e.target.value)} disabled={!esJefe} placeholder="108,24" style={{ ...inp, width: '90px' }} /></label>
        <label style={{ fontSize: '12.5px', color: GRIS, display: 'inline-flex', alignItems: 'center', gap: '7px' }}>Días del mes
          <input value={dias} onChange={e => setDias(e.target.value)} disabled={!esJefe} style={{ ...inp, width: '62px' }} /></label>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: '12px', alignItems: 'center', fontSize: '10.5px', color: GRIS }}>
          <span><span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px', background: '#e8f1fb', border: '1px solid #9fc3e8', verticalAlign: '1px' }} /> App</span>
          <span><span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px', background: 'white', border: '1px solid ' + BORDE, verticalAlign: '1px' }} /> Manual</span>
        </span>
      </div>

      {cargando ? (
        <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Cargando…</div>
      ) : (
        <div style={{ border: '0.5px solid ' + BORDE, borderRadius: '12px', background: 'white', overflow: 'hidden' }}>
          {GRUPOS.map(([g, gLabel]) => {
            const items = rubros.filter(r => r.grupo === g)
            const open = !!abierto[g]
            const noReal = g === 'BALANCEADO_LARVA' || g === 'ACTIVOS_MEJORAS'
            return (
              <div key={g}>
                <div onClick={() => setAbierto(a => ({ ...a, [g]: !open }))}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', cursor: 'pointer', background: noReal ? '#FBF8F0' : '#f3f7fb', borderTop: '0.5px solid ' + (noReal ? '#ecd9b4' : '#e6eef5'), borderBottom: '0.5px solid ' + (noReal ? '#ecd9b4' : '#e6eef5') }}>
                  <div style={{ fontSize: '12.5px', fontWeight: 500, color: noReal ? '#854F0B' : NAVY }}>
                    <span style={{ fontSize: '10px', color: GRIS }}>{open ? '▾' : '▸'}</span> &nbsp;{gLabel}
                    {noReal && <span style={{ fontSize: '10px', color: '#a98a4e', fontWeight: 400 }}> · no cuenta en el ha·día real</span>}
                  </div>
                  <div style={{ fontSize: '12.5px', fontWeight: 500, color: noReal ? '#854F0B' : NAVY }}>{dinero(totalesGrupo[g] || 0)}</div>
                </div>
                {open && (<>
                  {items.map(r => (
                    <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '7px 14px 7px 30px', borderBottom: '0.5px solid #f1f5f9', fontSize: '12.5px' }}>
                      <span>{r.nombre}{r.origen && <span style={{ fontSize: '9.5px', color: '#185FA5', background: '#e8f1fb', borderRadius: '10px', padding: '1px 7px', marginLeft: '6px' }}>App</span>}</span>
                      <input value={txt[r.id] || ''} onChange={e => setTxt(t => ({ ...t, [r.id]: e.target.value }))} disabled={!esJefe} placeholder="0,00"
                        style={{ ...inp, width: '120px', textAlign: 'right', padding: '5px 9px', background: r.origen ? '#f3f9ff' : 'white' }} />
                    </div>
                  ))}
                  {esJefe && (
                    <div style={{ display: 'flex', gap: '8px', padding: '8px 14px 10px 30px', alignItems: 'center' }}>
                      <input value={nuevo[g] || ''} onChange={e => setNuevo(n => ({ ...n, [g]: e.target.value }))} placeholder="Agregar rubro…"
                        onKeyDown={e => { if (e.key === 'Enter') agregarRubro(g) }} style={{ ...inp, flex: 1, maxWidth: '260px', padding: '5px 9px', fontSize: '12px' }} />
                      <button onClick={() => agregarRubro(g)} style={{ ...inp, cursor: 'pointer', padding: '5px 11px', fontSize: '12px', color: AZUL, borderColor: AZUL }}>+ Agregar</button>
                    </div>
                  )}
                </>)}
              </div>
            )
          })}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginTop: '14px' }}>
        <div style={{ background: '#f6f9fb', borderRadius: '10px', padding: '12px 14px' }}>
          <div style={{ fontSize: '11px', color: GRIS }}>Total bruto del mes</div>
          <div style={{ fontSize: '19px', fontWeight: 500 }}>{dinero(bruto)}</div>
        </div>
        <div style={{ background: '#eaf2fb', borderRadius: '10px', padding: '12px 14px' }}>
          <div style={{ fontSize: '11px', color: '#185FA5' }}>ha·día TOTAL</div>
          <div style={{ fontSize: '21px', fontWeight: 500, color: AZUL }}>${num2(haDiaTotal)}</div>
          <div style={{ fontSize: '9.5px', color: '#9fb0bf' }}>incluye balanceado y larva</div>
        </div>
        <div style={{ background: '#e7f6ef', borderRadius: '10px', padding: '12px 14px' }}>
          <div style={{ fontSize: '11px', color: VERDE }}>ha·día REAL</div>
          <div style={{ fontSize: '21px', fontWeight: 500, color: VERDE }}>${num2(haDiaReal)}</div>
          <div style={{ fontSize: '9.5px', color: '#9fb0bf' }}>→ va a Rentabilidad</div>
        </div>
      </div>

      {esJefe && (
        <div style={{ display: 'flex', gap: '9px', marginTop: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={guardar} disabled={guardando} style={{ ...btnAzul, opacity: guardando ? 0.6 : 1 }}>{guardando ? 'Guardando…' : 'Guardar'}</button>
          <span style={{ fontSize: '11px', color: '#9fb0bf' }}>Se calcula en vivo; no hay que cerrar el mes. El ha·día queda disponible para la Rentabilidad.</span>
        </div>
      )}
    </div>
  )
}
