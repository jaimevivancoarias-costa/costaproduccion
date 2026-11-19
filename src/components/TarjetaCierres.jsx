import { Fragment, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { corta, dinero } from '../lib/fechas'

// Tarjeta "Cierres por mes": la cadena de la bodega en $, un mes por fila.
// Cada mes Inicia con lo que Terminó el anterior (decisión Melany, caso Marexport:
// "tal cual como termina el mes debe iniciar el siguiente, debe estar visible").
// Inicia + Ingresos − Devoluciones − Consumo ± Ajustes (conteos y bajas) = Termina.
// Datos: fn_cierres_mes_bal / fn_cierres_mes_insumo (SQL). Colapsable, nace cerrada,
// carga al abrir. Solo jefes/contadoras (muestra precios).
const NAVY = '#022847', GRIS = '#7d8fa0', BORDE = '#dce6ef', AZUL = '#0D6CB0'
const ROJO = '#8A2F2E', VERDE = '#0F6E56', AMBAR = '#854F0B'
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

const finDeMes = iso => { const [y, m] = iso.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) }

export default function TarjetaCierres({ fincaId, fn, esJefe }) {
  const [abierto, setAbierto] = useState(false)
  const [filas, setFilas] = useState(null)
  const [error, setError] = useState(null)

  // Al cambiar de finca se descarta lo cargado (se vuelve a pedir al abrir).
  useEffect(() => { setFilas(null); setError(null) }, [fincaId, fn])

  useEffect(() => {
    if (!abierto || filas || error) return
    let vivo = true
    supabase.schema('produccion').rpc(fn, { p_finca: fincaId }).then(({ data, error: e }) => {
      if (!vivo) return
      if (e) setError(e.message); else setFilas(data || [])
    })
    return () => { vivo = false }
  }, [abierto, filas, error, fincaId, fn])

  if (!esJefe) return null
  const hayDev = (filas || []).some(r => Math.abs(Number(r.devoluciones) || 0) > 0.005)
  const GRID = `1.3fr repeat(${hayDev ? 6 : 5}, minmax(0, 1fr))`
  const cab = { fontSize: '11px', color: GRIS, textTransform: 'uppercase', letterSpacing: '.02em', textAlign: 'right' }
  const cel = { textAlign: 'right', fontSize: '13px', fontVariantNumeric: 'tabular-nums' }
  const enlace = { background: '#eaf2fb', color: AZUL, borderRadius: '6px', padding: '2px 8px', fontWeight: 600 }

  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', marginBottom: '16px', overflow: 'hidden' }}>
      <button onClick={() => setAbierto(a => !a)}
        style={{ width: '100%', display: 'flex', alignItems: 'baseline', gap: '8px', background: 'none', border: 'none',
                 cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', padding: '13px 16px' }}>
        <span style={{ color: GRIS, fontSize: '12px' }}>{abierto ? '▾' : '▸'}</span>
        <span style={{ fontSize: '14px', fontWeight: 600, color: NAVY }}>Cierres por mes</span>
        <span style={{ fontSize: '12px', color: GRIS }}>Cada mes empieza con lo que terminó el anterior · en $</span>
      </button>
      {abierto && (
        <div style={{ borderTop: '0.5px solid ' + BORDE, overflowX: 'auto' }}>
          {error ? (
            <div style={{ padding: '14px 16px', fontSize: '13px', color: ROJO }}>No se pudieron cargar los cierres. {error}</div>
          ) : !filas ? (
            <div style={{ padding: '14px 16px', fontSize: '13px', color: GRIS }}>Cargando cierres…</div>
          ) : !filas.length ? (
            <div style={{ padding: '14px 16px', fontSize: '13px', color: GRIS }}>Esta finca todavía no tiene inventario inicial.</div>
          ) : (
            <div style={{ minWidth: hayDev ? '820px' : '700px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: '14px', padding: '10px 16px', background: '#f6f9fb', borderBottom: '0.5px solid ' + BORDE }}>
                <span style={{ ...cab, textAlign: 'left' }}>Mes</span>
                <span style={cab}>Inicia con</span>
                <span style={cab}>Ingresos</span>
                {hayDev && <span style={cab}>Devoluciones</span>}
                <span style={cab}>Consumo</span>
                <span style={cab}>Ajustes (conteos y bajas)</span>
                <span style={cab}>Termina con</span>
              </div>
              {filas.map((r, i) => {
                const m = Number(String(r.mes).slice(5, 7)) - 1
                const parcialIni = String(r.desde).slice(8, 10) !== '01'
                const parcialFin = r.hasta !== finDeMes(r.desde)
                const aj = Number(r.ajuste) || 0
                return (
                  <Fragment key={r.desde}>
                    <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: '14px', padding: '11px 16px', alignItems: 'baseline',
                                  borderBottom: i < filas.length - 1 ? '0.5px solid #f1f6f9' : 'none' }}>
                      <span style={{ fontSize: '13px', color: NAVY, fontWeight: 600 }}>
                        {MESES[m]} {String(r.mes).slice(0, 4)}
                        {(parcialIni || parcialFin) && (
                          <span style={{ display: 'block', fontSize: '11px', fontWeight: 400, color: GRIS }}>
                            {parcialIni ? `desde ${corta(r.desde).slice(0, 5)}` : ''}{parcialIni && parcialFin ? ' · ' : ''}{parcialFin ? `hasta ${corta(r.hasta).slice(0, 5)}` : ''}
                          </span>
                        )}
                      </span>
                      <span style={cel}><span style={i > 0 ? enlace : undefined}>{dinero(Number(r.inicia))}</span></span>
                      <span style={{ ...cel, color: VERDE }}>{Number(r.ingresos) ? '+' + dinero(Number(r.ingresos)) : '—'}</span>
                      {hayDev && <span style={{ ...cel, color: ROJO }}>{Math.abs(Number(r.devoluciones)) > 0.005 ? '−' + dinero(Number(r.devoluciones)) : '—'}</span>}
                      <span style={{ ...cel, color: ROJO }}>{Number(r.consumo) ? '−' + dinero(Number(r.consumo)) : '—'}</span>
                      <span style={{ ...cel, color: Math.abs(aj) < 0.005 ? '#c3d0db' : (aj < 0 ? ROJO : AMBAR) }}>
                        {Math.abs(aj) < 0.005 ? '—' : (aj > 0 ? '+' : '−') + dinero(Math.abs(aj))}
                      </span>
                      <span style={{ ...cel, fontWeight: 700, color: NAVY }}>
                        <span style={i < filas.length - 1 ? enlace : undefined}>{dinero(Number(r.termina))}</span>
                      </span>
                    </div>
                  </Fragment>
                )
              })}
              <div style={{ padding: '10px 16px', fontSize: '11.5px', color: GRIS, borderTop: '0.5px solid ' + BORDE, background: '#fbfcfd' }}>
                Inicia + Ingresos {hayDev ? '− Devoluciones ' : ''}− Consumo ± Ajustes = Termina. Lo resaltado en azul es el mismo valor que pasa de un mes al siguiente. Valores al costo real (FIFO).
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
