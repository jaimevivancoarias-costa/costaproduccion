import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { LIBRAS_POR_SACO, hoyISO, lunesDe, sumarDias, miles, dinero } from '../lib/fechas'

// Resumen · las fincas de un vistazo, en un rango de fechas.
//
// Es la vista que no existe en ningun Excel: cada finca vive en su
// archivo y nadie ve las once juntas. Balanceado + insumos, por zona.

const NAVY = '#022847', AZUL = '#0D6CB0', BORDE = '#dce6ef', GRIS = '#7d8fa0', AMBAR = '#9A6A00'
const primeroDelMes = iso => iso.slice(0, 8) + '01'

function semanaActual() {
  const l = lunesDe(hoyISO())
  return [l, sumarDias(l, 6)]
}
function semanaPasada() {
  const l = sumarDias(lunesDe(hoyISO()), -7)
  return [l, sumarDias(l, 6)]
}

export default function Resumen({ fincas, onIrAFinca, esJefe }) {
  const [desde, setDesde] = useState(() => semanaActual()[0])
  const [hasta, setHasta] = useState(() => semanaActual()[1])
  const [zonaFiltro, setZonaFiltro] = useState('todas')
  const [filas, setFilas] = useState([])
  const [reponer, setReponer] = useState([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  // Días de balanceado efectivamente registrados por finca, y cuántos se
  // esperaban en el rango: sirve para distinguir "nadie registró" de "0 real".
  const [diasReg, setDiasReg] = useState({})
  const [diasEsper, setDiasEsper] = useState(0)

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    const [{ data, error }, { data: rep }, { data: dr }] = await Promise.all([
      supabase.schema('produccion').rpc('fn_resumen_fincas', { p_desde: desde, p_hasta: hasta }),
      supabase.schema('produccion').rpc('fn_por_reponer', {}),
      supabase.schema('produccion').from('dia_registro')
        .select('finca_id, fecha')
        .eq('ambito', 'balanceado').in('estado', ['cerrado', 'reabierto'])
        .gte('fecha', desde).lte('fecha', hasta),
    ])
    if (error) setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + error.message })
    setFilas(data || [])
    setReponer(rep || [])
    // Cuántos días distintos registró cada finca (por si un día se guarda dos veces).
    const reg = {}
    ;(dr || []).forEach(r => { (reg[r.finca_id] = reg[r.finca_id] || new Set()).add(r.fecha) })
    const cuenta = {}; Object.keys(reg).forEach(k => { cuenta[k] = reg[k].size })
    setDiasReg(cuenta)
    // Días esperados: del inicio del rango hasta hoy (no se cuenta el futuro).
    const fin = hasta > hoyISO() ? hoyISO() : hasta
    const dEsper = Math.max(0, Math.round((new Date(fin + 'T12:00:00') - new Date(desde + 'T12:00:00')) / 86400000) + 1)
    setDiasEsper(dEsper)
    setCargando(false)
  }, [desde, hasta])

  useEffect(() => { cargar() }, [cargar])

  const vis = useMemo(() => filas
    .filter(f => zonaFiltro === 'todas' || f.zona === zonaFiltro)
    .map(f => ({ ...f,
      costo_bal: Number(f.costo_bal), costo_ins: Number(f.costo_ins),
      total: Number(f.costo_bal) + Number(f.costo_ins),
      sacos: Number(f.libras_bal) / LIBRAS_POR_SACO,
      diasReg: diasReg[f.finca_id] || 0,
      sinLlenar: Math.max(0, diasEsper - (diasReg[f.finca_id] || 0)) })),
    [filas, zonaFiltro, diasReg, diasEsper])

  const tot = useMemo(() => vis.reduce((a, f) => ({
    bal: a.bal + f.costo_bal, ins: a.ins + f.costo_ins, ha: a.ha + Number(f.hectareas),
    lb: a.lb + Number(f.libras_bal),
  }), { bal: 0, ins: 0, ha: 0, lb: 0 }), [vis])

  // Agrupadas por zona para los subtotales.
  const grupos = useMemo(() => {
    const g = {}
    vis.forEach(f => { (g[f.zona || 'jambeli'] = g[f.zona || 'jambeli'] || []).push(f) })
    return g
  }, [vis])
  const zonasVisibles = zonaFiltro === 'todas' ? ['jambeli', 'puna'] : [zonaFiltro]

  return (
    <div style={{ padding: '1.4rem 1.5rem', maxWidth: '1180px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                    gap: '14px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 500, margin: '0 0 4px' }}>Resumen</h1>
          <div style={{ fontSize: '13px', color: GRIS }}>Todas las fincas de un vistazo.</div>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" value={desde} max={hasta} onChange={e => setDesde(e.target.value)} style={inp} />
          <span style={{ color: GRIS, fontSize: '13px' }}>a</span>
          <input type="date" value={hasta} min={desde} max={hoyISO()} onChange={e => setHasta(e.target.value)} style={inp} />
          <Chip pq onClick={() => { const [l, d] = semanaActual(); setDesde(l); setHasta(d) }}>Esta semana</Chip>
          <Chip pq onClick={() => { const [l, d] = semanaPasada(); setDesde(l); setHasta(d) }}>Semana pasada</Chip>
          <Chip pq onClick={() => { setDesde(primeroDelMes(hoyISO())); setHasta(hoyISO()) }}>Este mes</Chip>
        </div>
      </div>

      {[...new Set(fincas.map(f => f.zona))].filter(Boolean).length > 1 && (
        <div style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
          {[['todas', 'Todas'], ['jambeli', 'Jambelí'], ['puna', 'Puná']].map(([z, t]) => (
            <Chip key={z} on={zonaFiltro === z} onClick={() => setZonaFiltro(z)}>{t}</Chip>
          ))}
        </div>
      )}

      {aviso && <div style={{ background: '#FBEAEA', color: '#8A2F2E', borderRadius: '10px',
        padding: '11px 13px', fontSize: '13px', marginBottom: '12px' }}>{aviso.texto}</div>}

      {/* Tarjetas del total */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: '11px', marginBottom: '16px' }}>
        <Tarjeta oscura k="Balanceado" v={esJefe ? dinero(tot.bal) : `${miles(tot.lb)} lb`}
                 sub={esJefe ? `${miles(tot.lb)} lb` : null} />
        {esJefe && <Tarjeta k="Insumos" v={dinero(tot.ins)} />}
        {esJefe && <Tarjeta k="Total del grupo" v={dinero(tot.bal + tot.ins)} />}
        <Tarjeta k="Hectáreas" v={miles(tot.ha)} />
        <Tarjeta k="Fincas" v={String(vis.length)} />
      </div>

      {reponer.length > 0 && (
        <div style={{ background: '#FDF3F3', border: '0.5px solid #f0d4d3', borderRadius: '12px',
                      padding: '13px 16px', marginBottom: '16px' }}>
          <div style={{ fontWeight: 600, fontSize: '14px', color: '#6d2b29', marginBottom: '7px' }}>
            ⚠ Por reponer ({reponer.length})
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: '6px 18px' }}>
            {reponer.map((r, i) => {
              const U = { mg: 'mg', gramos: 'g', kg: 'kg', t: 't', libras: 'lb', ml: 'mL', cl: 'cL', litros: 'L', m3: 'm³', gal: 'gal', floz: 'fl oz', unidad: 'u', sacos: 'sacos' }
              return (
                <div key={i} onClick={() => onIrAFinca && onIrAFinca(r.finca_id)}
                     style={{ fontSize: '12.5px', color: '#6d2b29', cursor: onIrAFinca ? 'pointer' : 'default' }}>
                  <b style={{ fontWeight: 600 }}>{r.finca}</b> · {r.insumo}: {miles(r.saldo_app)} / mín {miles(r.minimo)} {U[r.unidad] || r.unidad}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {cargando ? (
        <Caja><div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Cargando...</div></Caja>
      ) : (
        zonasVisibles.map(z => {
          const gs = grupos[z] || []
          if (!gs.length) return null
          const sb = gs.reduce((a, f) => ({ bal: a.bal + f.costo_bal, ins: a.ins + f.costo_ins, ha: a.ha + Number(f.hectareas) }), { bal: 0, ins: 0, ha: 0 })
          return (
            <div key={z} style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '13px', fontWeight: 500, color: GRIS, margin: '0 0 8px' }}>
                {z === 'puna' ? 'Puná' : 'Jambelí'}
              </div>
              <Caja>
                <Enc cols={esJefe ? ['Finca', 'Hectáreas', 'Balanceado', 'Insumos', 'Total'] : ['Finca', 'Hectáreas', 'Balanceado']} bod={!esJefe} />
                {gs.map(f => (
                  <div key={f.finca_id} onClick={() => onIrAFinca && onIrAFinca(f.finca_id)}
                       style={{ display: 'grid', gridTemplateColumns: esJefe ? GJ : GB, gap: '10px',
                                alignItems: 'center', padding: '11px 15px', fontSize: '13px', cursor: 'pointer',
                                borderBottom: '0.5px solid #f1f6f9' }}>
                    <span style={{ fontWeight: 500 }}>{f.finca}</span>
                    <span style={{ textAlign: 'right', color: GRIS, fontVariantNumeric: 'tabular-nums' }}>{Number(f.hectareas).toFixed(2)}</span>
                    <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {f.diasReg === 0 ? (
                        <span style={{ color: AMBAR, fontStyle: 'italic' }}>Sin registro</span>
                      ) : (
                        <>
                          {esJefe ? dinero(f.costo_bal) : `${miles(f.libras_bal)} lb`}
                          <div style={{ fontSize: '11px', color: GRIS }}>
                            {miles(f.sacos)} sacos
                            {f.sinLlenar > 0 && <span style={{ color: AMBAR }}> · {f.sinLlenar} día{f.sinLlenar > 1 ? 's' : ''} sin llenar</span>}
                          </div>
                        </>
                      )}
                    </span>
                    {esJefe && <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dinero(f.costo_ins)}</span>}
                    {esJefe && <span style={{ textAlign: 'right', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{dinero(f.total)}</span>}
                  </div>
                ))}
                <div style={{ display: 'grid', gridTemplateColumns: esJefe ? GJ : GB, gap: '10px',
                              alignItems: 'center', padding: '11px 15px', fontSize: '13px', fontWeight: 500, background: '#fafcfd' }}>
                  <span>Subtotal {z === 'puna' ? 'Puná' : 'Jambelí'}</span>
                  <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{sb.ha.toFixed(2)}</span>
                  <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{esJefe ? dinero(sb.bal) : ''}</span>
                  {esJefe && <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dinero(sb.ins)}</span>}
                  {esJefe && <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dinero(sb.bal + sb.ins)}</span>}
                </div>
              </Caja>
            </div>
          )
        })
      )}
    </div>
  )
}

const GJ = '1.4fr 100px 130px 120px 120px'
const GB = '1.4fr 100px 1fr'

function Enc({ cols, bod }) {
  return <div style={{ display: 'grid', gridTemplateColumns: bod ? GB : GJ, gap: '10px', padding: '10px 15px',
    fontSize: '12px', color: GRIS, background: '#f6f9fb', borderBottom: '0.5px solid ' + BORDE }}>
    {cols.map((c, i) => <span key={i} style={{ textAlign: i === 0 ? 'left' : 'right' }}>{c}</span>)}
  </div>
}
function Tarjeta({ k, v, sub, oscura }) {
  return <div style={{ background: oscura ? NAVY : '#f6f9fb', borderRadius: '12px', padding: '14px 16px' }}>
    <div style={{ fontSize: '12px', color: oscura ? 'rgba(255,255,255,0.65)' : GRIS }}>{k}</div>
    <div style={{ fontSize: '22px', fontWeight: 500, color: oscura ? 'white' : NAVY }}>{v}</div>
    {sub && <div style={{ fontSize: '11px', color: oscura ? 'rgba(255,255,255,0.5)' : GRIS, marginTop: '1px' }}>{sub}</div>}
  </div>
}
function Chip({ children, on, pq, onClick }) {
  return <button onClick={onClick} style={{ padding: pq ? '7px 12px' : '8px 14px', borderRadius: '20px',
    fontFamily: 'inherit', fontSize: pq ? '12px' : '13px', cursor: 'pointer',
    border: '0.5px solid ' + (on ? '#9cc4e8' : BORDE), background: on ? '#E6F1FB' : 'white',
    color: on ? AZUL : NAVY, fontWeight: on ? 500 : 400 }}>{children}</button>
}
function Caja({ children }) {
  return <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden' }}>{children}</div>
}
const inp = { padding: '8px 10px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '9px', color: NAVY }
