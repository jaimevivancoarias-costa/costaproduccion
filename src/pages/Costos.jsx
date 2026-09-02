import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import {
  LIBRAS_POR_SACO, hoyISO, lunesDe, sumarDias, semanaDe, semanaISO, corta, miles, dinero,
} from '../lib/fechas'

// Costos · analisis del gasto de la semana (balanceado + insumos).
//
// Todo es calculo: el balanceado usa el precio congelado de cada dia
// (vw_alimentacion_costeada) y los insumos el precio de cada consumo.
// El inventario y los precios vivos viven en el modulo Inventario; aqui
// solo se mira en que se va la plata.

const NAVY = '#022847', AZUL = '#0D6CB0', VERDE = '#1D9E75'
const BORDE = '#dce6ef', GRIS = '#7d8fa0'

export default function Costos({ finca, esJefe, lunes, setLunes }) {
  const [bal, setBal] = useState([])       // { piscinaId, nombre, hectareas, tipo, costo, sacos, libras, prod:{id:costo} }
  const [ins, setIns] = useState([])       // { piscinaId, costo, item:{id:costo} }
  const [productos, setProductos] = useState({})   // id -> nombre balanceado
  const [insumos, setInsumos] = useState({})       // id -> nombre insumo
  const [anual, setAnual] = useState({ bal: 0, ins: 0, sacos: 0 })
  const [tendencia, setTendencia] = useState([])   // [{ semana, bal, ins }]
  const [porPlazo, setPorPlazo] = useState([])     // [{ ambito, plazo, monto }] de la semana
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)

  const [tipo, setTipo] = useState('ambos')        // 'bal' | 'ins' | 'ambos'
  const [nPisc, setNPisc] = useState(10)           // cuántas piscinas mostrar (0 = todas)
  const [abierta, setAbierta] = useState(null)     // piscinaId expandida

  const fechas = useMemo(() => semanaDe(lunes), [lunes])
  const hoy = hoyISO()

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    try {
      const domingo = fechas[6]
      const { data: piscinas } = await supabase.schema('produccion').from('piscina')
        .select('id, codigo, nombre, hectareas, tipo').eq('finca_id', finca.id).eq('activa', true)
      const ids = (piscinas || []).map(p => p.id)
      const pInfo = {}; (piscinas || []).forEach(p => { pInfo[p.id] = p })
      if (!ids.length) { setBal([]); setIns([]); setCargando(false); return }

      const rango8 = sumarDias(lunes, -49)   // 8 semanas atrás
      const [{ data: prods }, { data: insu }, { data: semBal }, { data: semIns },
             { data: anioBal }, { data: anioIns }, { data: tBal }, { data: tIns }, { data: cpz }] = await Promise.all([
        supabase.schema('produccion').from('producto').select('id, nombre, nombre_corto'),
        supabase.schema('produccion').from('insumo').select('id, nombre'),
        supabase.schema('produccion').from('vw_alimentacion_costeada')
          .select('piscina_id, producto_id, libras, costo, sacos').in('piscina_id', ids)
          .gte('fecha', lunes).lte('fecha', domingo),
        supabase.schema('produccion').from('consumo_insumo')
          .select('piscina_id, insumo_id, cantidad, precio_unitario').in('piscina_id', ids)
          .gte('fecha', lunes).lte('fecha', domingo),
        supabase.schema('produccion').from('vw_alimentacion_costeada')
          .select('costo, sacos').in('piscina_id', ids)
          .gte('fecha', lunes.slice(0, 4) + '-01-01').lte('fecha', domingo),
        supabase.schema('produccion').from('consumo_insumo')
          .select('cantidad, precio_unitario').in('piscina_id', ids)
          .gte('fecha', lunes.slice(0, 4) + '-01-01').lte('fecha', domingo),
        supabase.schema('produccion').from('vw_alimentacion_costeada')
          .select('costo, fecha').in('piscina_id', ids).gte('fecha', rango8).lte('fecha', domingo),
        supabase.schema('produccion').from('consumo_insumo')
          .select('cantidad, precio_unitario, fecha').in('piscina_id', ids).gte('fecha', rango8).lte('fecha', domingo),
        supabase.schema('produccion').rpc('fn_costo_plazo_periodo',
          { p_finca: finca.id, p_desde: lunes, p_hasta: domingo }),
      ])

      const pm = {}; (prods || []).forEach(p => { pm[p.id] = p.nombre_corto || p.nombre }); setProductos(pm)
      const im = {}; (insu || []).forEach(i => { im[i.id] = i.nombre }); setInsumos(im)

      // Balanceado por piscina
      const balMap = {}
      ;(semBal || []).forEach(r => {
        const f = balMap[r.piscina_id] || (balMap[r.piscina_id] = { costo: 0, sacos: 0, libras: 0, prod: {} })
        f.costo += Number(r.costo); f.sacos += Number(r.sacos); f.libras += Number(r.libras)
        f.prod[r.producto_id] = (f.prod[r.producto_id] || 0) + Number(r.costo)
      })
      setBal(ids.filter(id => balMap[id] || insMapHas(semIns, id)).map(id => ({
        piscinaId: id, nombre: pInfo[id].nombre, hectareas: Number(pInfo[id].hectareas),
        codigo: pInfo[id].codigo, tipo: pInfo[id].tipo, ...(balMap[id] || { costo: 0, sacos: 0, libras: 0, prod: {} }),
      })).sort(ordenar))

      // Insumos por piscina
      const insMap = {}
      ;(semIns || []).forEach(r => {
        const c = Number(r.cantidad) * Number(r.precio_unitario || 0)
        const f = insMap[r.piscina_id] || (insMap[r.piscina_id] = { costo: 0, item: {} })
        f.costo += c; f.item[r.insumo_id] = (f.item[r.insumo_id] || 0) + c
      })
      setIns(insMap)

      setAnual({
        bal: (anioBal || []).reduce((s, r) => s + Number(r.costo), 0),
        ins: (anioIns || []).reduce((s, r) => s + Number(r.cantidad) * Number(r.precio_unitario || 0), 0),
        sacos: (anioBal || []).reduce((s, r) => s + Number(r.sacos), 0),
      })

      // Tendencia por semana (últimas 8)
      const semanas = Array.from({ length: 8 }, (_, k) => sumarDias(lunes, -7 * (7 - k)))
      const tw = {}; semanas.forEach(s => { tw[s] = { semana: s, bal: 0, ins: 0 } })
      const lunOf = f => lunesDe(f)
      ;(tBal || []).forEach(r => { const k = lunOf(r.fecha); if (tw[k]) tw[k].bal += Number(r.costo) })
      ;(tIns || []).forEach(r => { const k = lunOf(r.fecha); if (tw[k]) tw[k].ins += Number(r.cantidad) * Number(r.precio_unitario || 0) })
      setTendencia(semanas.map(s => tw[s]))
      setPorPlazo(cpz || [])
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally {
      setCargando(false)
    }
  }, [finca.id, lunes, fechas])

  useEffect(() => { cargar() }, [cargar])

  // ---- derivados según el filtro ----
  const costoBalPisc = p => p.costo || 0
  const costoInsPisc = p => (ins[p.piscinaId]?.costo) || 0
  const costoPisc = p => (tipo === 'bal' ? costoBalPisc(p) : tipo === 'ins' ? costoInsPisc(p) : costoBalPisc(p) + costoInsPisc(p))

  const totBal = bal.reduce((s, p) => s + costoBalPisc(p), 0)
  const totIns = bal.reduce((s, p) => s + costoInsPisc(p), 0)
  const totLibras = bal.reduce((s, p) => s + (p.libras || 0), 0)
  const totSacos = bal.reduce((s, p) => s + (p.sacos || 0), 0)
  const totFiltro = tipo === 'bal' ? totBal : tipo === 'ins' ? totIns : totBal + totIns

  // Ranking de items (productos y/o insumos)
  const ranking = useMemo(() => {
    const items = []
    if (tipo !== 'ins') {
      const byProd = {}
      bal.forEach(p => Object.entries(p.prod).forEach(([id, c]) => { byProd[id] = (byProd[id] || 0) + c }))
      Object.entries(byProd).forEach(([id, c]) => items.push({ nombre: productos[id] || id, costo: c, es: 'bal' }))
    }
    if (tipo !== 'bal') {
      const byIns = {}
      Object.values(ins).forEach(f => Object.entries(f.item).forEach(([id, c]) => { byIns[id] = (byIns[id] || 0) + c }))
      Object.entries(byIns).forEach(([id, c]) => items.push({ nombre: insumos[id] || id, costo: c, es: 'ins' }))
    }
    return items.sort((a, b) => b.costo - a.costo).slice(0, 7)
  }, [bal, ins, productos, insumos, tipo])
  const maxRank = ranking.length ? ranking[0].costo : 1

  const piscOrden = useMemo(() =>
    [...bal].sort((a, b) => costoPisc(b) - costoPisc(a)).filter(p => costoPisc(p) > 0),
    [bal, ins, tipo])
  const piscVis = nPisc ? piscOrden.slice(0, nPisc) : piscOrden

  const maxTend = Math.max(1, ...tendencia.map(t => (tipo === 'bal' ? t.bal : tipo === 'ins' ? t.ins : t.bal + t.ins)))

  // Gasto de la semana por plazo de compra, según el filtro.
  const plazoData = useMemo(() => {
    const acc = {}
    porPlazo.forEach(r => {
      if (tipo === 'bal' && r.ambito !== 'balanceado') return
      if (tipo === 'ins' && r.ambito !== 'insumos') return
      acc[r.plazo] = (acc[r.plazo] || 0) + Number(r.monto)
    })
    return [0, 30, 60, 90, 120].map(pz => ({ plazo: pz, monto: acc[pz] || 0 })).filter(x => x.monto > 0)
  }, [porPlazo, tipo])
  const totPlazo = plazoData.reduce((s, x) => s + x.monto, 0)
  const maxPlazo = plazoData.length ? Math.max(...plazoData.map(x => x.monto)) : 1
  const PLAZO_LBL = { 0: 'Contado', 30: '30 días', 60: '60 días', 90: '90 días', 120: '120 días' }

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY, padding: '1.4rem 1.4rem 4rem' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '18px', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 500, margin: '0 0 5px' }}>Costos</h1>
          <div style={{ fontSize: '13px', color: GRIS }}>
            Semana del {corta(lunes)} al {corta(fechas[6])} · en qué se va la plata
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <Btn onClick={() => setLunes(sumarDias(lunes, -7))}>‹</Btn>
          <Btn onClick={() => setLunes(lunesDe(hoy))}>Esta semana</Btn>
          <Btn onClick={() => setLunes(sumarDias(lunes, 7))} disabled={lunes >= lunesDe(hoy)}>›</Btn>
          <input type="date" value={lunes} max={hoy} onChange={e => e.target.value && setLunes(lunesDe(e.target.value))}
            style={{ padding: '8px 10px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '9px', color: NAVY }} />
        </div>
      </div>

      {aviso && (
        <div style={{ padding: '10px 14px', borderRadius: '9px', marginBottom: '10px', fontSize: '13px',
          background: aviso.tipo === 'error' ? '#FCEBEB' : '#EAF3DE', color: aviso.tipo === 'error' ? '#A32D2D' : '#3B6D11' }}>{aviso.texto}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '11px', marginBottom: '14px' }}>
        <Kpi oscura k="Costo total semana" v={dinero(totBal + totIns)} s={totLibras ? dinero((totBal + totIns) / totLibras) + ' por libra' : null} />
        <Kpi k="Balanceado" v={dinero(totBal)} s={`${miles(totSacos)} sacos`} />
        <Kpi k="Insumos" v={dinero(totIns)} s={(totBal + totIns) ? `${Math.round(totIns / (totBal + totIns) * 100)}% del total` : null} />
        <Kpi k="Acumulado del año" v={dinero(anual.bal + anual.ins)} s={`${miles(anual.sacos)} sacos`} />
      </div>

      {/* Filtro */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '14px' }}>
        <div style={{ display: 'inline-flex', background: '#e7eef5', borderRadius: '10px', padding: '3px', gap: '3px' }}>
          {[['ambos', 'Juntos'], ['bal', 'Balanceado'], ['ins', 'Insumos']].map(([id, txt]) => (
            <button key={id} onClick={() => setTipo(id)} style={{
              border: 0, background: tipo === id ? 'white' : 'transparent', borderRadius: '8px',
              padding: '7px 15px', fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer',
              fontWeight: tipo === id ? 500 : 400, color: tipo === id ? NAVY : GRIS }}>{txt}</button>
          ))}
        </div>
        <span style={{ marginLeft: 'auto', fontSize: '13px', color: GRIS }}>Mostrar</span>
        <select value={nPisc} onChange={e => setNPisc(Number(e.target.value))}
          style={{ padding: '7px 10px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '9px', color: NAVY }}>
          <option value={5}>5 piscinas</option>
          <option value={10}>10 piscinas</option>
          <option value={20}>20 piscinas</option>
          <option value={0}>Todas</option>
        </select>
      </div>

      {cargando ? (
        <Vacio>Cargando...</Vacio>
      ) : (totBal + totIns) === 0 ? (
        <Vacio>No hay consumo registrado en esta semana.</Vacio>
      ) : (
        <>
          {/* Gráficos */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px', marginBottom: '14px' }}>
            <Caja>
              <Titulo>En qué se va el costo · semana</Titulo>
              {ranking.length === 0 ? <VacioChico>Sin datos con este filtro.</VacioChico> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
                  {ranking.map((r, i) => (
                    <div key={i}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '3px' }}>
                        <span>{r.nombre}</span>
                        <span style={{ color: GRIS, fontVariantNumeric: 'tabular-nums' }}>
                          {dinero(r.costo)} · {Math.round(r.costo / (totFiltro || 1) * 100)}%
                        </span>
                      </div>
                      <div style={{ height: '8px', background: '#eef3f7', borderRadius: '20px' }}>
                        <i style={{ display: 'block', height: '100%', width: (r.costo / maxRank * 100) + '%',
                          background: r.es === 'ins' ? VERDE : AZUL, borderRadius: '20px' }} />
                      </div>
                    </div>
                  ))}
                  {tipo === 'ambos' && (
                    <div style={{ fontSize: '11px', color: '#a7b4c0', marginTop: '4px' }}>
                      <span style={{ color: AZUL }}>■</span> balanceado &nbsp; <span style={{ color: VERDE }}>■</span> insumos
                    </div>
                  )}
                </div>
              )}
            </Caja>

            <Caja>
              <Titulo>Costo por semana · últimas 8</Titulo>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: '7px', height: '130px' }}>
                {tendencia.map((t, i) => {
                  const val = tipo === 'bal' ? t.bal : tipo === 'ins' ? t.ins : t.bal + t.ins
                  const esActual = t.semana === lunes
                  return (
                    <div key={i} title={dinero(val)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                      <div style={{ width: '100%', minHeight: '2px', height: (val / maxTend * 108) + 'px',
                        background: esActual ? NAVY : AZUL, borderRadius: '4px 4px 0 0' }} />
                      <span style={{ fontSize: '10px', color: esActual ? NAVY : '#a7b4c0', fontWeight: esActual ? 500 : 400 }}>
                        {semanaISO(t.semana).semana}
                      </span>
                    </div>
                  )
                })}
              </div>
            </Caja>

            {esJefe && (
              <Caja>
                <Titulo>Por plazo de compra · semana</Titulo>
                {plazoData.length === 0 ? <VacioChico>Sin datos con este filtro.</VacioChico> : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
                    {plazoData.map((r, i) => (
                      <div key={i}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '3px' }}>
                          <span>{PLAZO_LBL[r.plazo]}</span>
                          <span style={{ color: GRIS, fontVariantNumeric: 'tabular-nums' }}>
                            {dinero(r.monto)} · {Math.round(r.monto / (totPlazo || 1) * 100)}%
                          </span>
                        </div>
                        <div style={{ height: '8px', background: '#eef3f7', borderRadius: '20px' }}>
                          <i style={{ display: 'block', height: '100%', width: (r.monto / maxPlazo * 100) + '%',
                            background: r.plazo === 0 ? VERDE : AZUL, borderRadius: '20px' }} />
                        </div>
                      </div>
                    ))}
                    <div style={{ fontSize: '11px', color: '#a7b4c0', marginTop: '4px' }}>
                      Cuánto del gasto vino de compras a cada plazo (costeo real por lote).
                    </div>
                  </div>
                )}
              </Caja>
            )}
          </div>

          {/* Tabla por piscina (expandible) */}
          <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: cols(tipo), padding: '10px 15px', background: '#fafcfd',
              fontSize: '11px', color: GRIS, textTransform: 'uppercase', borderBottom: '0.5px solid ' + BORDE }}>
              <span>Piscina</span>
              {tipo !== 'ins' && <span style={{ textAlign: 'right' }}>Balanceado</span>}
              {tipo !== 'bal' && <span style={{ textAlign: 'right' }}>Insumos</span>}
              <span style={{ textAlign: 'right' }}>Total</span>
            </div>

            {piscVis.map(p => {
              const abiertoAqui = abierta === p.piscinaId
              const items = []
              if (tipo !== 'ins') Object.entries(p.prod).forEach(([id, c]) => items.push({ nombre: productos[id] || id, costo: c, es: 'bal' }))
              if (tipo !== 'bal') Object.entries(ins[p.piscinaId]?.item || {}).forEach(([id, c]) => items.push({ nombre: insumos[id] || id, costo: c, es: 'ins' }))
              items.sort((a, b) => b.costo - a.costo)
              return (
                <Fragment key={p.piscinaId}>
                  <div onClick={() => setAbierta(abiertoAqui ? null : p.piscinaId)}
                    style={{ display: 'grid', gridTemplateColumns: cols(tipo), padding: '11px 15px', fontSize: '13px',
                      alignItems: 'center', cursor: 'pointer', borderBottom: '0.5px solid #f1f6f9',
                      background: abiertoAqui ? '#f6f9fb' : 'white' }}>
                    <span style={{ fontWeight: 500 }}>
                      <span style={{ display: 'inline-block', width: '12px', color: GRIS }}>{abiertoAqui ? '▾' : '▸'}</span>
                      {p.nombre}
                      {p.tipo === 'precria' && <span style={{ fontSize: '11px', color: GRIS, fontWeight: 400 }}> · precría</span>}
                    </span>
                    {tipo !== 'ins' && <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{costoBalPisc(p) ? dinero(costoBalPisc(p)) : '—'}</span>}
                    {tipo !== 'bal' && <span style={{ textAlign: 'right', color: GRIS, fontVariantNumeric: 'tabular-nums' }}>{costoInsPisc(p) ? dinero(costoInsPisc(p)) : '—'}</span>}
                    <span style={{ textAlign: 'right', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{dinero(costoPisc(p))}</span>
                  </div>
                  {abiertoAqui && (
                    <div style={{ padding: '4px 15px 12px 30px', background: '#f6f9fb', borderBottom: '0.5px solid #f1f6f9' }}>
                      {items.length === 0 ? <span style={{ fontSize: '12px', color: GRIS }}>Sin desglose.</span> : items.map((it, i) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', padding: '4px 0', fontSize: '12px' }}>
                          <span>
                            <span style={{ display: 'inline-block', width: '7px', height: '7px', borderRadius: '2px', marginRight: '7px',
                              background: it.es === 'ins' ? VERDE : AZUL }} />
                            {it.nombre}
                          </span>
                          <span style={{ color: GRIS, fontVariantNumeric: 'tabular-nums' }}>{dinero(it.costo)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Fragment>
              )
            })}

            <div style={{ display: 'grid', gridTemplateColumns: cols(tipo), padding: '11px 15px', background: '#fafcfd',
              fontSize: '13px', fontWeight: 500, alignItems: 'center', borderTop: '0.5px solid ' + BORDE }}>
              <span>Total{nPisc && piscOrden.length > nPisc ? ` (top ${nPisc} de ${piscOrden.length})` : ''}</span>
              {tipo !== 'ins' && <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dinero(piscVis.reduce((s, p) => s + costoBalPisc(p), 0))}</span>}
              {tipo !== 'bal' && <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dinero(piscVis.reduce((s, p) => s + costoInsPisc(p), 0))}</span>}
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dinero(piscVis.reduce((s, p) => s + costoPisc(p), 0))}</span>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function insMapHas(semIns, id) { return (semIns || []).some(r => r.piscina_id === id) }
function cols(tipo) { return tipo === 'ambos' ? '1fr 120px 120px 130px' : '1fr 130px 130px' }

function Kpi({ k, v, s, oscura }) {
  return (
    <div style={{ background: oscura ? NAVY : 'white', border: oscura ? 'none' : '0.5px solid ' + BORDE, borderRadius: '12px', padding: '14px 16px' }}>
      <div style={{ fontSize: '11px', color: oscura ? 'rgba(255,255,255,0.65)' : GRIS, marginBottom: '4px' }}>{k}</div>
      <div style={{ fontSize: '23px', fontWeight: 500, color: oscura ? 'white' : NAVY }}>{v}</div>
      {s && <div style={{ fontSize: '12px', color: oscura ? 'rgba(255,255,255,0.5)' : GRIS, marginTop: '2px' }}>{s}</div>}
    </div>
  )
}
function Caja({ children }) {
  return <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '15px 17px' }}>{children}</div>
}
function Titulo({ children }) {
  return <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '12px' }}>{children}</div>
}
function Btn({ children, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: 'white', color: NAVY, border: '0.5px solid ' + BORDE, borderRadius: '9px',
      padding: '9px 14px', fontFamily: 'inherit', fontSize: '13px',
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1 }}>{children}</button>
  )
}
function Vacio({ children }) {
  return <div style={{ padding: '3rem 1rem', textAlign: 'center', border: '0.5px dashed ' + BORDE, borderRadius: '12px', color: GRIS, fontSize: '14px', background: 'white' }}>{children}</div>
}
function VacioChico({ children }) {
  return <div style={{ padding: '18px 0', textAlign: 'center', color: GRIS, fontSize: '13px' }}>{children}</div>
}
function ordenar(a, b) {
  if (a.tipo !== b.tipo) return a.tipo === 'precria' ? 1 : -1
  return (parseInt(String(a.codigo).replace(/\D/g, ''), 10) || 0) - (parseInt(String(b.codigo).replace(/\D/g, ''), 10) || 0)
}
