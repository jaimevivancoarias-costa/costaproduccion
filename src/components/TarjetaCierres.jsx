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

const num = v => (Math.round(Math.abs(v) * 100) / 100).toLocaleString('es-EC', { maximumFractionDigits: 2 })
const signo = v => (v > 0 ? '+' : v < 0 ? '−' : '')

// Explica en palabras de dónde sale el $ de cada producto.
function explicar(f) {
  const q = Number(f.cantidad) || 0, qr = Number(f.cant_real) || 0, v = Number(f.valor) || 0
  // Menos de 10 centavos, o la cantidad cuadró y solo es diferencia de precio de
  // menos de $1: no se lista (Melany: "si cuadró no debería salir"). Va a la línea gris.
  if (Math.abs(v) < 0.10) return { centavos: true }
  if (Math.abs(qr) < 0.005 && Math.abs(v) < 1 && !/Baja/.test(f.detalle || '')) return { centavos: true }
  if (f.detalle) {
    // Bajas (robo/merma) solas: se muestran tal cual, son explícitas.
    const soloBaja = !/Conteo/.test(f.detalle)
    if (soloBaja) return { txt: f.detalle }
    // Conteos (y bajas junto con conteos): se dice UNA cifra, la real (la misma
    // que da el $ y la que sale en "Qué se movió"), y de dónde sale.
    const cuando = [
      ...(f.detalle.match(/Conteo \d\d\/\d\d/g) || []).map(s => s.replace('Conteo', 'conteo')),
      ...(f.detalle.match(/Baja\/ajuste \d\d\/\d\d: [^·]+/g) || []).map(s => s.replace('Baja/ajuste', 'baja').trim()),
    ].join(', ')
    if (Math.abs(qr) < 0.005) return { txt: `Cuadró · ${cuando}` }
    const txt = `${qr < 0 ? 'Faltó' : 'Sobró'} ${num(qr)} · ${cuando}`
    if (Math.abs(qr - q) < 0.1) return { txt }
    return { txt, nota: `En el acta del conteo figura ${Math.abs(q) < 0.005 ? 'que cuadró' : (q < 0 ? 'faltó ' : 'sobró ') + num(q)} (se calculó distinto ese día); lo que vale es la foto del conteo.` }
  }
  if (Math.abs(v) < 1) return { centavos: true }
  if (Math.abs(qr) >= 0.01) return { txt: `Sin conteo en el mes. Diferencia real ${signo(qr)}${num(qr)}: hay una guía o un consumo cargado después con fecha anterior.`, revisar: true }
  return { txt: 'La cantidad cuadra: es diferencia de precio del saldo (se corrigió el precio de un ingreso o del inventario inicial).' }
}

function DesgloseAjuste({ filas, total, mes }) {
  const caja = { margin: '0 16px 12px', background: '#f8fafc', border: '0.5px solid ' + BORDE, borderRadius: '10px', padding: '10px 14px' }
  if (!filas) return <div style={{ ...caja, fontSize: '12.5px', color: GRIS }}>Cargando de dónde sale…</div>
  if (filas.error) return <div style={{ ...caja, fontSize: '12.5px', color: ROJO }}>No se pudo cargar el detalle. {filas.error}</div>
  const lineas = filas.map(f => ({ ...f, ...explicar(f) }))
  const normales = lineas.filter(l => !l.centavos)
  const cent = lineas.filter(l => l.centavos)
  const sumCent = cent.reduce((s, l) => s + Number(l.valor), 0)
  const colorV = v => (v < 0 ? ROJO : v > 0 ? AMBAR : GRIS)
  const fila = { display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 2fr) 110px', gap: '12px', padding: '6px 0', alignItems: 'baseline', fontSize: '12.5px' }
  return (
    <div style={caja}>
      <div style={{ fontSize: '12px', color: GRIS, marginBottom: '6px' }}>
        Ajuste de {mes}: lo que <span style={{ color: ROJO, fontWeight: 600 }}>faltó (−)</span> o <span style={{ color: AMBAR, fontWeight: 600 }}>sobró (+)</span> al contar la bodega, y las bajas.
      </div>
      {normales.map(l => (
        <div key={l.producto_id} style={{ ...fila, borderTop: '0.5px solid #eef2f6' }}>
          <span style={{ color: NAVY, fontWeight: 600 }}>{l.producto}</span>
          <span style={{ color: l.revisar ? AMBAR : '#3d5266' }}>
            {l.txt}
            {l.nota && <span style={{ display: 'block', color: GRIS, fontSize: '11.5px' }}>{l.nota}</span>}
          </span>
          <span style={{ textAlign: 'right', color: colorV(Number(l.valor)), fontVariantNumeric: 'tabular-nums' }}>{signo(Number(l.valor))}{dinero(Math.abs(Number(l.valor)))}</span>
        </div>
      ))}
      {cent.length > 0 && Math.abs(sumCent) >= 0.005 && (
        <div style={{ ...fila, borderTop: '0.5px solid #eef2f6' }}>
          <span style={{ color: GRIS }}>Centavos</span>
          <span style={{ color: GRIS }}>Redondeo de precio, la cantidad cuadró ({cent.length} {cent.length === 1 ? 'producto' : 'productos'})</span>
          <span style={{ textAlign: 'right', color: GRIS, fontVariantNumeric: 'tabular-nums' }}>{signo(sumCent)}{dinero(Math.abs(sumCent))}</span>
        </div>
      )}
      <div style={{ ...fila, borderTop: '0.5px solid ' + BORDE, fontWeight: 700 }}>
        <span style={{ color: NAVY }}>Total</span><span />
        <span style={{ textAlign: 'right', color: colorV(total), fontVariantNumeric: 'tabular-nums' }}>{signo(total)}{dinero(Math.abs(total))}</span>
      </div>
    </div>
  )
}

const finDeMes =iso => { const [y, m] = iso.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) }

export default function TarjetaCierres({ fincaId, fn, esJefe }) {
  const [abierto, setAbierto] = useState(false)
  const [filas, setFilas] = useState(null)
  const [error, setError] = useState(null)

  // Al cambiar de finca se descarta lo cargado (se vuelve a pedir al abrir).
  useEffect(() => { setFilas(null); setError(null) }, [fincaId, fn])

  // Se precarga en segundo plano apenas entra la pantalla (1,5 s después, para no
  // competir con la carga principal). Así al abrir la tarjeta ya está lista.
  useEffect(() => {
    if (!esJefe || filas || error) return
    let vivo = true
    const t = setTimeout(() => {
      supabase.schema('produccion').rpc(fn, { p_finca: fincaId }).then(({ data, error: e }) => {
        if (!vivo) return
        if (e) setError(e.message); else setFilas(data || [])
      })
    }, abierto ? 0 : 1500)
    return () => { vivo = false; clearTimeout(t) }
  }, [abierto, esJefe, filas, error, fincaId, fn])

  // Flechita en "Ajustes": desglose por producto (de qué conteo/baja sale cada $).
  // fn_cierres_mes_bal → fn_cierre_ajuste_detalle_bal; fn_cierres_mes_insumo → ..._insumo.
  const [abiertoAj, setAbiertoAj] = useState(null)   // r.desde del mes abierto
  const [detalles, setDetalles] = useState({})      // desde → filas | {error}
  useEffect(() => { setAbiertoAj(null); setDetalles({}) }, [fincaId, fn])
  const pedirDetalle = r => supabase.schema('produccion').rpc(fn.replace('fn_cierres_mes_', 'fn_cierre_ajuste_detalle_'),
      { p_finca: fincaId, p_desde: r.desde, p_hasta: r.hasta })
      .then(({ data, error: e }) => setDetalles(d => ({ ...d, [r.desde]: e ? { error: e.message } : (data || []) })))
  // Al abrir la tarjeta se precargan los desgloses de todos los meses (de a uno).
  useEffect(() => {
    if (!abierto || !filas) return
    let vivo = true
    ;(async () => { for (const r of filas) { if (!vivo) return; if (Math.abs(Number(r.ajuste)) >= 0.005 && !detalles[r.desde]) await pedirDetalle(r) } })()
    return () => { vivo = false }
  }, [abierto, filas])  // eslint-disable-line react-hooks/exhaustive-deps
  const verAjuste = r => {
    if (abiertoAj === r.desde) { setAbiertoAj(null); return }
    setAbiertoAj(r.desde)
    if (!detalles[r.desde]) pedirDetalle(r)
  }

  if (!esJefe) return null
  const hayDev = (filas || []).some(r => Math.abs(Number(r.devoluciones) || 0) > 0.005)
  const GRID = `1.3fr repeat(${hayDev ? 6 : 5}, minmax(0, 1fr))`
  const cab = { fontSize: '11px', color: GRIS, textTransform: 'uppercase', letterSpacing: '.02em', textAlign: 'center' }
  const cel = { textAlign: 'center', fontSize: '13px', fontVariantNumeric: 'tabular-nums' }
  const enlace = { background: '#eaf2fb', color: AZUL, borderRadius: '6px', padding: '2px 8px', fontWeight: 600 }

  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', marginTop: '28px', marginBottom: '16px', overflow: 'hidden' }}>
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
                        {Math.abs(aj) < 0.005 ? '—' : (
                          <button onClick={() => verAjuste(r)} title="Ver de dónde sale"
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
                                     fontSize: '13px', color: 'inherit', fontVariantNumeric: 'tabular-nums' }}>
                            {(aj > 0 ? '+' : '−') + dinero(Math.abs(aj))}
                            <span style={{ color: GRIS, fontSize: '11px', marginLeft: '4px' }}>{abiertoAj === r.desde ? '▾' : '▸'}</span>
                          </button>
                        )}
                      </span>
                      <span style={{ ...cel, fontWeight: 700, color: NAVY }}>
                        <span style={i < filas.length - 1 ? enlace : undefined}>{dinero(Number(r.termina))}</span>
                      </span>
                    </div>
                    {abiertoAj === r.desde && <DesgloseAjuste filas={detalles[r.desde]} total={aj} mes={`${MESES[m].toLowerCase()}`} />}
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
