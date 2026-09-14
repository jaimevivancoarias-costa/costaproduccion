import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, dinero, miles } from '../lib/fechas'

// Etiqueta corta de cada unidad, para el desglose del bodeguero.
const UNIDAD = { sacos: 'sacos', litros: 'litros', ml: 'mL', gramos: 'g',
                 libras: 'lb', kg: 'kg', unidad: 'u' }

// Presupuesto mensual de insumos · modulo Produccion
//
// Un solo numero por finca y por mes, que fija el jefe. Se renueva cada
// mes: arranca de cero el dia 1.
//
// El jefe lo ve dolarizado (gasto y cuanto queda). El bodeguero ve el
// numero total y el porcentaje del mes, para saber cuanto le queda,
// pero NO el costo de cada material.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const VERDE = '#0F6E56'
const AMBAR = '#BA7517'
const ROJO = '#A32D2D'

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
               'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

export default function Presupuesto({ finca, esJefe, onIrReporte }) {
  const hoy = hoyISO()
  const [anio, setAnio] = useState(Number(hoy.slice(0, 4)))
  const [mes, setMes] = useState(Number(hoy.slice(5, 7)))
  const [monto, setMonto] = useState(null)
  const [gasto, setGasto] = useState(0)
  const [historico, setHistorico] = useState([])
  const [resumen, setResumen] = useState([])
  const [consumo, setConsumo] = useState([])   // desglose por insumo del mes (sin precios, para bodeguero)
  const [cargando, setCargando] = useState(true)
  const [editando, setEditando] = useState(false)
  const [nuevo, setNuevo] = useState('')
  const [aviso, setAviso] = useState(null)
  const [zonaFiltro, setZonaFiltro] = useState('todas')

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    // Primer y ultimo dia del mes elegido, para el desglose por insumo.
    const desde = `${anio}-${String(mes).padStart(2, '0')}-01`
    const hasta = new Date(anio, mes, 0).toISOString().slice(0, 10)
    const [{ data: p }, { data: g }, { data: h }, { data: r }, { data: cons }] = await Promise.all([
      supabase.schema('produccion').from('presupuesto_insumo')
        .select('monto').eq('finca_id', finca.id).eq('anio', anio).eq('mes', mes).maybeSingle(),
      supabase.schema('produccion').rpc('fn_gasto_insumos_mes',
        { p_finca: finca.id, p_anio: anio, p_mes: mes }),
      supabase.schema('produccion').rpc('fn_presupuesto_historico', { p_finca: finca.id }),
      esJefe ? supabase.schema('produccion').rpc('fn_presupuesto_resumen', { p_anio: anio, p_mes: mes })
             : Promise.resolve({ data: [] }),
      // El bodeguero ve en qué insumo se va el mes (cantidad y %, sin $).
      esJefe ? Promise.resolve({ data: [] })
             : supabase.schema('produccion').rpc('fn_reporte_consumo',
                 { p_finca: finca.id, p_desde: desde, p_hasta: hasta }),
    ])
    setMonto(p ? Number(p.monto) : null)
    setGasto(Number(g) || 0)
    setHistorico((h || []).filter(x => !(x.anio === anio && x.mes === mes)))
    setResumen(r || [])
    // Agrupar por insumo: suma de costo (para el %) y de cantidad por unidad.
    const m = {}
    ;(cons || []).forEach(f => {
      if (f.tipo !== 'insumo') return
      const k = f.item_id
      if (!m[k]) m[k] = { id: k, nombre: f.item, costo: 0, cantidad: 0, unidad: f.unidad, mixto: false }
      const it = m[k]
      it.costo += Number(f.costo) || 0
      if (it.unidad === f.unidad) it.cantidad += Number(f.cantidad) || 0
      else it.mixto = true
    })
    setConsumo(Object.values(m).sort((a, b) => b.costo - a.costo))
    setNuevo(p ? String(p.monto) : '')
    setCargando(false)
  }, [finca.id, anio, mes, esJefe])

  useEffect(() => { cargar() }, [cargar])

  async function guardar() {
    const v = Number(String(nuevo).replace(',', '.'))
    if (!isFinite(v) || v < 0) { setAviso({ tipo: 'error', texto: 'Monto no válido.' }); return }
    const { error } = await supabase.schema('produccion').from('presupuesto_insumo')
      .upsert({ finca_id: finca.id, anio, mes, monto: v, actualizado_en: new Date().toISOString() },
              { onConflict: 'finca_id,anio,mes' })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return }
    setEditando(false)
    setAviso({ tipo: 'ok', texto: 'Presupuesto guardado.' })
    await cargar()
  }

  async function borrar() {
    if (!window.confirm(`¿Borrar el presupuesto de ${MESES[mes - 1]} ${anio}?`)) return
    const { error } = await supabase.schema('produccion').from('presupuesto_insumo')
      .delete().eq('finca_id', finca.id).eq('anio', anio).eq('mes', mes)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo borrar. ' + error.message }); return }
    setEditando(false); setNuevo('')
    setAviso({ tipo: 'ok', texto: 'Presupuesto borrado.' })
    await cargar()
  }

  const pct = monto ? Math.min(100, Math.round(gasto / monto * 100)) : 0
  const queda = monto ? monto - gasto : 0
  const color = pct >= 100 ? ROJO : pct >= 85 ? AMBAR : VERDE

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px',
                    flexWrap: 'wrap' }}>
        <select value={mes} onChange={e => setMes(Number(e.target.value))} style={sel}>
          {MESES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
        </select>
        <select value={anio} onChange={e => setAnio(Number(e.target.value))} style={sel}>
          {[anio - 1, anio, anio + 1].map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        {esJefe && !editando && (
          <button onClick={() => setEditando(true)} style={boton}>
            {monto ? 'Cambiar presupuesto' : 'Fijar presupuesto'}
          </button>
        )}
      </div>

      {aviso && (
        <div style={{ borderRadius: '10px', padding: '11px 13px', fontSize: '13px', marginBottom: '12px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE',
                      color: aviso.tipo === 'error' ? ROJO : VERDE }}>{aviso.texto}</div>
      )}

      {cargando ? (
        <Caja><div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Cargando...</div></Caja>
      ) : editando ? (
        <Caja>
          <div style={{ padding: '18px', display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>
                Presupuesto de insumos · {MESES[mes - 1]} {anio}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '18px', color: GRIS }}>$</span>
                <input inputMode="decimal" value={nuevo} placeholder="25000" autoFocus
                  onChange={e => setNuevo(e.target.value)}
                  style={{ padding: '10px 12px', fontSize: '17px', fontFamily: 'inherit', width: '170px',
                           border: '0.5px solid ' + BORDE, borderRadius: '9px', textAlign: 'right',
                           fontVariantNumeric: 'tabular-nums' }} />
              </div>
            </div>
            <button onClick={guardar} style={{ ...boton, background: AZUL, color: 'white', borderColor: AZUL }}>
              Guardar
            </button>
            <button onClick={() => { setEditando(false); setNuevo(monto ? String(monto) : '') }}
              style={boton}>Cancelar</button>
            {monto !== null && (
              <button onClick={borrar} style={{ ...boton, color: ROJO, borderColor: '#e8c9c9' }}>
                Borrar
              </button>
            )}
          </div>
        </Caja>
      ) : monto === null ? (
        <Caja>
          <div style={{ padding: '30px 24px', textAlign: 'center', fontSize: '13px', color: GRIS,
                        maxWidth: '460px', margin: '0 auto', lineHeight: 1.6 }}>
            No hay presupuesto fijado para {MESES[mes - 1]} de {anio}.
            {esJefe ? ' Fíjalo con el botón de arriba.' : ' Pídele a tu jefe que lo fije.'}
          </div>
        </Caja>
      ) : (
        <Caja>
          <div style={{ padding: '20px 22px' }}>
            {/* Barra de avance: la ve todo el mundo. */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                          marginBottom: '10px' }}>
              <span style={{ fontSize: '14px', fontWeight: 500 }}>
                Presupuesto de {MESES[mes - 1]}: {dinero(monto)}
              </span>
              <span style={{ fontSize: '22px', fontWeight: 600, color, fontVariantNumeric: 'tabular-nums' }}>
                {pct}%
              </span>
            </div>
            <div style={{ height: '12px', background: '#eef3f7', borderRadius: '20px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: pct + '%', background: color, borderRadius: '20px' }} />
            </div>

            {/* El detalle en dolares, solo el jefe. */}
            {esJefe ? (
              <div style={{ display: 'flex', gap: '30px', marginTop: '16px', flexWrap: 'wrap' }}>
                <Dato k="Gastado" v={dinero(gasto)} />
                <Dato k="Queda" v={dinero(queda)} color={queda < 0 ? ROJO : NAVY} />
              </div>
            ) : (
              <div style={{ fontSize: '13px', color: GRIS, marginTop: '14px' }}>
                {pct >= 100 ? 'Ya se pasó el presupuesto del mes.'
                  : `Queda ${100 - pct}% del presupuesto del mes.`}
              </div>
            )}
          </div>
        </Caja>
      )}

      {/* Desglose por insumo del mes · SOLO bodeguero, SIN precios.
          Muestra en qué se está yendo el consumo: cantidad y % del mes. */}
      {!esJefe && !cargando && consumo.length > 0 && (() => {
        const total = consumo.reduce((t, c) => t + c.costo, 0)
        return (
          <div style={{ marginTop: '22px' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 4px' }}>
              En qué se va el mes
            </h3>
            <p style={{ fontSize: '13px', color: GRIS, margin: '0 0 11px' }}>
              Consumo de {MESES[mes - 1]} por insumo. El % es cuánto pesa cada uno en el mes.
            </p>
            <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 52px 1fr',
                            gap: '12px', alignItems: 'center', padding: '11px 16px',
                            borderBottom: '0.5px solid ' + BORDE, background: '#f6f9fb',
                            fontSize: '12px', color: GRIS }}>
                <span>Insumo</span>
                <span style={{ textAlign: 'right' }}>Cantidad</span>
                <span style={{ textAlign: 'right' }}>%</span>
                <span>Peso</span>
              </div>
              {consumo.map(c => {
                const pc = total ? Math.round(c.costo / total * 100) : 0
                return (
                  <div key={c.id} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 52px 1fr',
                          gap: '12px', alignItems: 'center', padding: '11px 16px',
                          borderBottom: '0.5px solid #f1f6f9', fontSize: '14px' }}>
                    <span style={{ fontWeight: 500 }}>
                      {c.nombre}
                      <span style={{ fontSize: '11px', color: AMBAR, marginLeft: '7px' }}>insumo</span>
                    </span>
                    <span style={{ textAlign: 'right', color: GRIS, fontVariantNumeric: 'tabular-nums' }}>
                      {c.mixto ? '—' : `${miles(c.cantidad)} ${UNIDAD[c.unidad] || c.unidad || ''}`}
                    </span>
                    <span style={{ textAlign: 'right', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                      {pc}%
                    </span>
                    <span style={{ display: 'block', height: '9px', background: '#eef3f7',
                                   borderRadius: '20px', overflow: 'hidden' }}>
                      <i style={{ display: 'block', height: '100%', width: pc + '%',
                                  background: '#E3B15F', borderRadius: '20px' }} />
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      {/* Tablero del mes de todas las fincas: solo el jefe. */}
      {esJefe && resumen.length > 0 && (() => {
        const vis = resumen
          .filter(r => zonaFiltro === 'todas' || r.zona === zonaFiltro)
          .map(r => ({ ...r, pctReal: r.monto ? Math.round(Number(r.gasto) / Number(r.monto) * 100) : null }))
          .map(r => ({ ...r, pct: r.pctReal === null ? null : Math.min(100, r.pctReal) }))
          .sort((a, b) => (b.pctReal ?? -1) - (a.pctReal ?? -1))
        const tMonto = vis.reduce((t, r) => t + Number(r.monto || 0), 0)
        const tGasto = vis.reduce((t, r) => t + Number(r.gasto || 0), 0)
        const tPct = tMonto ? Math.min(100, Math.round(tGasto / tMonto * 100)) : 0
        const enRojo = vis.filter(r => r.pctReal !== null && r.pctReal >= 100).length
        const LEN = Math.PI * 60
        const colDe = p => p === null ? GRIS : p >= 100 ? ROJO : p >= 85 ? AMBAR : VERDE
        return (
        <div style={{ marginTop: '22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 500, margin: 0 }}>Todas las fincas en {MESES[mes - 1]}</h3>
            <div style={{ display: 'flex', gap: '6px', marginLeft: 'auto' }}>
              {[['todas', 'Todas'], ['jambeli', 'Jambelí'], ['puna', 'Puná']].map(([z, t]) => (
                <button key={z} onClick={() => setZonaFiltro(z)} style={{
                  padding: '6px 12px', borderRadius: '20px', fontFamily: 'inherit', fontSize: '12px',
                  cursor: 'pointer', border: '0.5px solid ' + (zonaFiltro === z ? '#9cc4e8' : BORDE),
                  background: zonaFiltro === z ? '#E6F1FB' : 'white',
                  color: zonaFiltro === z ? AZUL : NAVY, fontWeight: zonaFiltro === z ? 500 : 400 }}>{t}</button>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: '11px', marginBottom: '14px' }}>
            <TarjetaPpto oscura k="Presupuesto del grupo" v={dinero(tMonto)} />
            <TarjetaPpto k="Gastado" v={dinero(tGasto)} />
            <TarjetaPpto k="Queda" v={dinero(tMonto - tGasto)} />
            <TarjetaPpto k="Fincas en rojo" v={String(enRojo)} rojo={enRojo > 0} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '210px 1fr', gap: '14px', alignItems: 'stretch' }}>
            <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '16px',
                          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="150" height="92" viewBox="0 0 150 92">
                <path d="M15 85 A60 60 0 0 1 135 85" fill="none" stroke="#eef3f7" strokeWidth="14" strokeLinecap="round" />
                <path d="M15 85 A60 60 0 0 1 135 85" fill="none" stroke={colDe(tPct)} strokeWidth="14" strokeLinecap="round"
                      strokeDasharray={`${LEN * tPct / 100} ${LEN}`} />
              </svg>
              <div style={{ fontSize: '26px', fontWeight: 500, marginTop: '-6px' }}>{tPct}%</div>
              <div style={{ fontSize: '12px', color: GRIS }}>del grupo</div>
            </div>

            <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '14px 18px' }}>
              <div style={{ fontSize: '13px', color: GRIS, marginBottom: '12px' }}>Cómo va cada finca · toca para ver su consumo</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {vis.map(r => (
                  <div key={r.finca_id} onClick={() => onIrReporte && onIrReporte(r.finca_id)}
                       style={{ display: 'grid', gridTemplateColumns: '150px 1fr 46px', gap: '10px',
                                alignItems: 'center', fontSize: '13px', cursor: 'pointer' }}>
                    <span>
                      {r.finca}
                      <div style={{ fontSize: '11px', color: GRIS, marginTop: '1px', fontVariantNumeric: 'tabular-nums' }}>
                        {Number(r.monto)
                          ? `Ppto ${dinero(r.monto)} · gastó ${dinero(r.gasto)}`
                          : 'Sin presupuesto'}
                      </div>
                    </span>
                    <span style={{ height: '9px', background: '#eef3f7', borderRadius: '20px', overflow: 'hidden' }}>
                      {r.pct !== null && <i style={{ display: 'block', height: '100%', width: r.pct + '%',
                        background: colDe(r.pctReal), borderRadius: '20px' }} />}
                    </span>
                    <span style={{ textAlign: 'right', fontWeight: 500, color: colDe(r.pctReal), fontVariantNumeric: 'tabular-nums' }}>
                      {r.pctReal === null ? '—' : r.pctReal + '%'}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        )
      })()}

      {/* Meses anteriores de esta finca. */}
      {historico.length > 0 && (
        <div style={{ marginTop: '22px' }}>
          <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 11px' }}>Meses anteriores</h3>
          <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden' }}>
            {historico.map(x => {
              const p = x.monto ? Math.min(100, Math.round(Number(x.gasto) / Number(x.monto) * 100)) : null
              const col = p === null ? GRIS : p >= 100 ? ROJO : p >= 85 ? AMBAR : VERDE
              return (
                <div key={`${x.anio}-${x.mes}`} style={{ display: 'flex', justifyContent: 'space-between',
                        alignItems: 'center', padding: '10px 15px', fontSize: '13px',
                        borderBottom: '0.5px solid #f1f6f9' }}>
                  <span style={{ minWidth: '130px' }}>{MESES[x.mes - 1]} {x.anio}</span>
                  {esJefe && <span style={{ color: GRIS }}>Presupuesto {dinero(x.monto)} · Gastado {dinero(x.gasto)}</span>}
                  <span style={{ fontWeight: 500, color: col, fontVariantNumeric: 'tabular-nums' }}>
                    {p === null ? '—' : p + '%'}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function TarjetaPpto({ k, v, oscura, rojo }) {
  return (
    <div style={{ background: oscura ? NAVY : '#f6f9fb', borderRadius: '12px', padding: '14px 16px' }}>
      <div style={{ fontSize: '12px', color: oscura ? 'rgba(255,255,255,0.65)' : GRIS }}>{k}</div>
      <div style={{ fontSize: '22px', fontWeight: 500,
                    color: oscura ? 'white' : rojo ? ROJO : NAVY }}>{v}</div>
    </div>
  )
}
function Caja({ children }) {
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                  overflow: 'hidden' }}>{children}</div>
  )
}
function Dato({ k, v, color }) {
  return (
    <div>
      <div style={{ fontSize: '11px', color: GRIS, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{k}</div>
      <div style={{ fontSize: '19px', fontWeight: 500, color: color || NAVY, fontVariantNumeric: 'tabular-nums' }}>{v}</div>
    </div>
  )
}
const sel = { padding: '8px 11px', fontSize: '13px', fontFamily: 'inherit',
              border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY }
const boton = { padding: '9px 15px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500,
                border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY,
                cursor: 'pointer' }
