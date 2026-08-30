import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, dinero } from '../lib/fechas'

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

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
               'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']

export default function Presupuesto({ finca, esJefe }) {
  const hoy = hoyISO()
  const [anio, setAnio] = useState(Number(hoy.slice(0, 4)))
  const [mes, setMes] = useState(Number(hoy.slice(5, 7)))
  const [monto, setMonto] = useState(null)
  const [gasto, setGasto] = useState(0)
  const [cargando, setCargando] = useState(true)
  const [editando, setEditando] = useState(false)
  const [nuevo, setNuevo] = useState('')
  const [aviso, setAviso] = useState(null)

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    const [{ data: p }, { data: g }] = await Promise.all([
      supabase.schema('produccion').from('presupuesto_insumo')
        .select('monto').eq('finca_id', finca.id).eq('anio', anio).eq('mes', mes).maybeSingle(),
      supabase.schema('produccion').rpc('fn_gasto_insumos_mes',
        { p_finca: finca.id, p_anio: anio, p_mes: mes }),
    ])
    setMonto(p ? Number(p.monto) : null)
    setGasto(Number(g) || 0)
    setNuevo(p ? String(p.monto) : '')
    setCargando(false)
  }, [finca.id, anio, mes])

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
