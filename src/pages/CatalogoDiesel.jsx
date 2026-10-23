import { useState, useEffect, useCallback, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, numDec } from '../lib/fechas'
import CampoNumero from '../components/CampoNumero'

// Precio del galón con 6 decimales (así lo pidió el negocio).
const precio6 = n => '$' + (Number(n) || 0).toLocaleString('es-EC', { minimumFractionDigits: 6, maximumFractionDigits: 6 })

// Catálogo de diesel · precio por galón de cada tipo (B, Premium) por
// finca, con fecha de vigencia. Se puede fijar para todas las fincas de
// una vez, y alguna finca puede cambiar por separado. Cada cambio guarda
// el historial: al guardar se cierra el anterior y rige el nuevo.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const VERDE = '#0F6E56'
const ROJO = '#A32D2D'

const sumarDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }

export default function CatalogoDiesel({ fincas }) {
  // PRUEBA habilitada: entra como una finca más para ponerle precio de diesel.
  const activas = fincas || []
  const [tipos, setTipos] = useState([])
  const [precios, setPrecios] = useState({})   // fincaId|tipoId -> { precio, desde }
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [edit, setEdit] = useState(null)        // { fincaId, valores, desde }
  const [bulk, setBulk] = useState(null)        // { valores, desde }
  const [hist, setHist] = useState(null)        // fincaId con historial abierto
  const [histRows, setHistRows] = useState([])
  const [histNombres, setHistNombres] = useState({})
  const [guardando, setGuardando] = useState(false)
  const [recostear, setRecostear] = useState(null)   // { desde, items:[{fincaId,fincaNombre,tipoId,tipoNombre,precio,ids,n}] }

  const nombreFinca = id => activas.find(f => f.id === id)?.nombre || '—'

  // Al cambiar un precio a una fecha PASADA, detecta las compras ya registradas
  // de ese rango cuyo precio difiere del nuevo (candidatas a recostear).
  // desdes = mapa tipo_id -> fecha (cada tipo con la suya).
  async function detectarRecosteo(fincaIds, valores, desdes) {
    const items = []
    for (const fid of fincaIds) {
      for (const t of tipos) {
        const raw = numDec(valores[t.id] || '')
        if (!(raw > 0)) continue
        const desde = (desdes && desdes[t.id]) || hoyISO()
        if (!desde || desde >= hoyISO()) continue   // solo fecha pasada
        const { data } = await supabase.schema('produccion').from('diesel_pedido')
          .select('id, precio_galon').eq('finca_id', fid).eq('tipo_id', t.id).eq('estado', 'aprobado')
          .gte('fecha', desde).lte('fecha', hoyISO())
        const afectadas = (data || []).filter(dp => dp.precio_galon == null || Math.abs(Number(dp.precio_galon) - raw) > 1e-9)
        if (afectadas.length) items.push({ fincaId: fid, fincaNombre: nombreFinca(fid), tipoId: t.id, tipoNombre: t.nombre, precio: raw, desde, ids: afectadas.map(a => a.id), n: afectadas.length })
      }
    }
    return items
  }

  async function aplicarRecosteo() {
    setGuardando(true)
    try {
      for (const it of recostear.items) {
        const { error } = await supabase.schema('produccion').from('diesel_pedido')
          .update({ precio_galon: it.precio }).in('id', it.ids)
        if (error) throw error
      }
    } catch (e) { setGuardando(false); setAviso({ tipo: 'error', texto: 'No se pudo recostear. ' + e.message }); return }
    setGuardando(false); setRecostear(null); setAviso({ tipo: 'ok', texto: 'Compras recosteadas al precio nuevo.' }); await cargar()
  }

  const cargar = useCallback(async () => {
    setCargando(true)
    const [{ data: tp }, { data: pr }] = await Promise.all([
      supabase.schema('produccion').from('diesel_tipo').select('id, nombre').eq('activo', true).order('nombre'),
      supabase.schema('produccion').from('diesel_precio')
        .select('tipo_id, finca_id, precio_galon, vigente_desde').is('vigente_hasta', null),
    ])
    setTipos(tp || [])
    const m = {}
    ;(pr || []).forEach(r => { if (r.finca_id) m[r.finca_id + '|' + r.tipo_id] = { precio: Number(r.precio_galon), desde: r.vigente_desde } })
    setPrecios(m)
    setCargando(false)
  }, [])

  useEffect(() => { cargar() }, [cargar])

  // Aplica los valores a una finca. Deja SIEMPRE una sola fila vigente:
  // 1) si el precio no cambió, no hace nada;
  // 2) borra cualquier vigente del mismo día o posterior (reemplazo);
  // 3) cierra el anterior (fecha < desde) para guardar historial;
  // 4) inserta el nuevo.
  // desdes = mapa tipo_id -> fecha "rige desde" (cada tipo puede tener la suya).
  async function aplicar(fincaId, valores, desdes) {
    for (const t of tipos) {
      const raw = numDec(valores[t.id] || '')
      if (!(raw > 0)) continue
      const actual = precios[fincaId + '|' + t.id]
      if (actual && Math.abs(actual.precio - raw) < 1e-9) continue
      const desde = (desdes && desdes[t.id]) || hoyISO()
      await supabase.schema('produccion').from('diesel_precio')
        .delete().eq('tipo_id', t.id).eq('finca_id', fincaId).is('vigente_hasta', null).gte('vigente_desde', desde)
      await supabase.schema('produccion').from('diesel_precio')
        .update({ vigente_hasta: sumarDias(desde, -1) })
        .eq('tipo_id', t.id).eq('finca_id', fincaId).is('vigente_hasta', null).lt('vigente_desde', desde)
      const { error } = await supabase.schema('produccion').from('diesel_precio')
        .insert({ tipo_id: t.id, finca_id: fincaId, precio_galon: raw, vigente_desde: desde })
      if (error) throw error
    }
  }

  function abrirEdit(fincaId) {
    const valores = {}
    tipos.forEach(t => { const p = precios[fincaId + '|' + t.id]; valores[t.id] = p ? String(p.precio) : '' })
    setBulk(null); setHist(null); setEdit({ fincaId, valores, desdes: Object.fromEntries(tipos.map(t => [t.id, hoyISO()])) })
  }

  async function guardar() {
    if (guardando) return
    setGuardando(true)
    try { await aplicar(edit.fincaId, edit.valores, edit.desdes) }
    catch (e) { setGuardando(false); setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + e.message }); return }
    const items = await detectarRecosteo([edit.fincaId], edit.valores, edit.desdes)
    setGuardando(false); setEdit(null); setAviso({ tipo: 'ok', texto: 'Precios guardados.' }); await cargar()
    if (items.length) setRecostear({ items })
  }

  async function guardarBulk() {
    if (guardando) return
    const desde = bulk.desde || hoyISO()
    if (!tipos.some(t => numDec(bulk.valores[t.id] || '') > 0)) {
      setAviso({ tipo: 'error', texto: 'Pon al menos un precio.' }); return
    }
    const desdes = Object.fromEntries(tipos.map(t => [t.id, desde]))
    setGuardando(true)
    try { for (const f of activas) await aplicar(f.id, bulk.valores, desdes) }
    catch (e) { setGuardando(false); setAviso({ tipo: 'error', texto: 'No se pudo aplicar. ' + e.message }); return }
    const items = await detectarRecosteo(activas.map(f => f.id), bulk.valores, desdes)
    setGuardando(false); setBulk(null); setAviso({ tipo: 'ok', texto: `Precios aplicados a ${activas.length} fincas.` }); await cargar()
    if (items.length) setRecostear({ items })
  }

  async function abrirHist(fincaId) {
    if (hist === fincaId) { setHist(null); return }
    const { data } = await supabase.schema('produccion').from('diesel_precio')
      .select('tipo_id, precio_galon, vigente_desde, vigente_hasta, creado_por, creado_en').eq('finca_id', fincaId)
      .order('vigente_desde', { ascending: false })
    const ids = [...new Set((data || []).map(r => r.creado_por).filter(Boolean))]
    const nombres = {}
    if (ids.length) {
      const { data: us } = await supabase.schema('produccion').from('vw_usuario').select('id, nombre').in('id', ids)
      ;(us || []).forEach(u => { nombres[u.id] = u.nombre })
    }
    setHistRows(data || []); setHistNombres(nombres); setHist(fincaId); setEdit(null)
  }

  // Última columna FIJA (no 'auto'): así el header y las filas comparten el
  // mismo ancho de columnas y los precios quedan centrados bajo su título.
  const gtc = `1.4fr repeat(${tipos.length}, 1fr) 150px`
  const nombreTipo = id => tipos.find(t => t.id === id)?.nombre || '—'

  return (
    <div>
      {aviso && (
        <div style={{ borderRadius: '10px', padding: '11px 13px', fontSize: '13px', marginBottom: '12px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE',
                      color: aviso.tipo === 'error' ? ROJO : VERDE }}>{aviso.texto}</div>
      )}

      {recostear && (() => {
        const total = recostear.items.reduce((s, it) => s + it.n, 0)
        return (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,40,71,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 60 }}>
          <div style={{ background: 'white', borderRadius: '14px', padding: '22px 24px', width: '100%', maxWidth: '460px', maxHeight: '80vh', overflow: 'auto', boxShadow: '0 12px 40px rgba(2,40,71,.18)' }}>
            <div style={{ fontWeight: 600, fontSize: '16px', marginBottom: '3px' }}>¿Recostear las compras?</div>
            <div style={{ fontSize: '12.5px', color: GRIS, marginBottom: '14px', lineHeight: 1.5 }}>
              Pusiste precios con fecha pasada. Hay <b style={{ fontWeight: 600 }}>{total}</b> {total === 1 ? 'compra ya registrada' : 'compras ya registradas'} con otro precio. ¿Les aplico el precio nuevo?
            </div>
            <div style={{ border: '0.5px solid ' + BORDE, borderRadius: '10px', overflow: 'hidden', marginBottom: '14px' }}>
              {recostear.items.map((it, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '9px 12px', fontSize: '13px', borderBottom: i < recostear.items.length - 1 ? '0.5px solid #f1f6f9' : 'none' }}>
                  <span>{it.fincaNombre} · {it.tipoNombre} <span style={{ color: GRIS }}>· desde {corta(it.desde)}</span></span>
                  <span style={{ color: GRIS }}>{it.n} {it.n === 1 ? 'compra' : 'compras'} → {precio6(it.precio)}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '9px' }}>
              <button onClick={aplicarRecosteo} disabled={guardando}
                style={{ ...boton, background: AZUL, color: 'white', borderColor: AZUL, opacity: guardando ? 0.6 : 1 }}>
                {guardando ? 'Aplicando…' : 'Sí, recostear'}
              </button>
              <button onClick={() => setRecostear(null)} style={boton}>No, dejar cada una con su precio</button>
            </div>
          </div>
        </div>
        )
      })()}

      {!cargando && !bulk && (
        <div style={{ marginBottom: '12px', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={() => { setEdit(null); setHist(null); setBulk({ valores: {}, desde: hoyISO() }) }}
            style={{ ...boton, background: NAVY, color: 'white', borderColor: NAVY }}>Fijar precio para todas las fincas</button>
        </div>
      )}

      {bulk && (
        <div style={{ background: '#f6f9fb', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '14px 16px', marginBottom: '14px' }}>
          <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '11px' }}>Precio para todas las fincas</div>
          <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            {tipos.map(t => (
              <Campo key={t.id} label={`${t.nombre} · $/gal`}>
                <CampoNumero maxDec={6} value={bulk.valores[t.id] || ''} placeholder="ej. 1.80"
                  onChange={v => setBulk(x => ({ ...x, valores: { ...x.valores, [t.id]: v } }))}
                  style={{ ...inp, width: '100px', textAlign: 'right' }} />
              </Campo>
            ))}
            <Campo label="Rige desde">
              <input type="date" value={bulk.desde} max={hoyISO()}
                onChange={e => setBulk(x => ({ ...x, desde: e.target.value }))} style={inp} />
            </Campo>
            <button onClick={guardarBulk} disabled={guardando}
              style={{ ...boton, background: AZUL, color: 'white', borderColor: AZUL, opacity: guardando ? 0.6 : 1 }}>
              {guardando ? 'Aplicando...' : `Aplicar a ${activas.length} fincas`}
            </button>
            <button onClick={() => setBulk(null)} style={boton}>Cancelar</button>
          </div>
          <div style={{ fontSize: '11px', color: GRIS, marginTop: '9px' }}>
            Se aplica a todas. Después puedes cambiar alguna finca por separado con “Editar”.
          </div>
        </div>
      )}

      {cargando ? (
        <div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Cargando...</div>
      ) : (
        <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: gtc, gap: '10px', padding: '11px 16px',
                        borderBottom: '0.5px solid ' + BORDE, background: '#f6f9fb', fontSize: '12px', color: GRIS, alignItems: 'center' }}>
            <span>Finca</span>
            {tipos.map(t => <span key={t.id} style={{ textAlign: 'center' }}>{t.nombre} · $/gal</span>)}
            <span></span>
          </div>
          {(() => {
          const fila = f => {
            const enEdit = edit && edit.fincaId === f.id
            const enHist = hist === f.id
            return (
              <div key={f.id}>
                <div style={{ display: 'grid', gridTemplateColumns: gtc, gap: '10px', padding: '13px 16px',
                        borderBottom: '0.5px solid #f1f6f9', alignItems: 'center', fontSize: '14px' }}>
                  <span style={{ fontWeight: 500 }}>{String(f.nombre).toUpperCase()}</span>
                  {tipos.map(t => {
                    const p = precios[f.id + '|' + t.id]
                    return <span key={t.id} style={{ textAlign: 'center', color: p ? NAVY : '#c3d0db' }}>{p ? precio6(p.precio) : '—'}</span>
                  })}
                  <span style={{ textAlign: 'right', display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                    <button onClick={() => abrirHist(f.id)} style={btnLink}>{enHist ? 'Ocultar' : 'Historial'}</button>
                    <button onClick={() => enEdit ? setEdit(null) : abrirEdit(f.id)} style={btnLink}>{enEdit ? 'Cerrar' : 'Editar'}</button>
                  </span>
                </div>

                {enEdit && (
                  <div style={{ padding: '14px 16px 16px', background: '#f6f9fb', borderBottom: '0.5px solid #f1f6f9' }}>
                    <div style={{ fontSize: '11.5px', color: GRIS, marginBottom: '12px' }}>
                      Cada tipo tiene su propia fecha. Cambia solo el que necesites.
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '110px 100px 120px 160px', gap: '9px 18px', alignItems: 'center', maxWidth: '560px' }}>
                      <span style={headCell}>Tipo</span>
                      <span style={headCell}>Precio actual</span>
                      <span style={headCell}>Precio nuevo</span>
                      <span style={headCell}>Rige desde</span>
                      {tipos.map(t => {
                        const act = precios[f.id + '|' + t.id]
                        return (
                          <Fragment key={t.id}>
                            <span style={{ fontSize: '14px', fontWeight: 500, color: NAVY }}>{t.nombre}</span>
                            <span style={{ fontSize: '13px', color: GRIS }}>{act ? precio6(act.precio) : '—'}</span>
                            <CampoNumero maxDec={6} value={edit.valores[t.id] || ''} placeholder="ej. 1.80"
                              onChange={v => setEdit(x => ({ ...x, valores: { ...x.valores, [t.id]: v } }))}
                              style={{ ...inp, width: '110px', textAlign: 'right' }} />
                            <input type="date" value={edit.desdes[t.id] || hoyISO()} max={hoyISO()}
                              onChange={e => setEdit(x => ({ ...x, desdes: { ...x.desdes, [t.id]: e.target.value } }))} style={{ ...inp, width: '150px' }} />
                          </Fragment>
                        )
                      })}
                    </div>
                    <div style={{ display: 'flex', gap: '9px', marginTop: '16px' }}>
                      <button onClick={guardar} disabled={guardando}
                        style={{ ...boton, background: AZUL, color: 'white', borderColor: AZUL, opacity: guardando ? 0.6 : 1 }}>{guardando ? 'Guardando...' : 'Guardar'}</button>
                      <button onClick={() => setEdit(null)} style={boton}>Cancelar</button>
                    </div>
                    <div style={{ fontSize: '11px', color: GRIS, marginTop: '10px' }}>
                      Fecha pasada → te preguntamos si recostear las compras de ese rango.
                    </div>
                  </div>
                )}

                {enHist && (
                  <div style={{ padding: '12px 16px', background: '#fafcfd', borderBottom: '0.5px solid #f1f6f9' }}>
                    <div style={{ fontSize: '12px', color: GRIS, marginBottom: '10px' }}>Historial de precios</div>
                    {histRows.length === 0 ? (
                      <div style={{ fontSize: '13px', color: GRIS }}>Sin precios registrados.</div>
                    ) : (
                      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${tipos.length}, 1fr)`, gap: '20px' }}>
                        {tipos.map(t => {
                          const rows = histRows.filter(r => r.tipo_id === t.id)
                          return (
                            <div key={t.id}>
                              <div style={{ fontSize: '13px', fontWeight: 600, color: NAVY, marginBottom: '8px' }}>{t.nombre}</div>
                              {rows.length === 0 ? <div style={{ fontSize: '12px', color: GRIS }}>—</div> : rows.map((r, i) => (
                                <div key={i} style={{ padding: '7px 0', borderBottom: i < rows.length - 1 ? '0.5px solid #f1f6f9' : 'none' }}>
                                  <div style={{ fontSize: '14px', fontWeight: i === 0 ? 600 : 400 }}>
                                    {precio6(Number(r.precio_galon))}
                                    {i === 0 && !r.vigente_hasta && <span style={{ fontSize: '11px', color: AZUL, fontWeight: 400, marginLeft: '6px' }}>vigente</span>}
                                  </div>
                                  <div style={{ fontSize: '12px', color: GRIS }}>
                                    desde {corta(r.vigente_desde)}{r.vigente_hasta ? ` – ${corta(r.vigente_hasta)}` : ''}
                                  </div>
                                  {(histNombres[r.creado_por] || r.creado_en) && (
                                    <div style={{ fontSize: '11px', color: GRIS }}>
                                      {histNombres[r.creado_por] || ''}{r.creado_en ? `${histNombres[r.creado_por] ? ' · ' : ''}${corta(r.creado_en.slice(0, 10))}` : ''}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          }
          const banda = label => (
            <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: GRIS, padding: '16px 16px 6px' }}>{label}</div>
          )
          const jam = activas.filter(f => f.zona === 'jambeli')
          const pun = activas.filter(f => f.zona === 'puna')
          const otras = activas.filter(f => f.zona !== 'jambeli' && f.zona !== 'puna')
          return (<>
            {jam.length > 0 && <Fragment key="z-jambeli">{banda('Jambelí')}{jam.map(fila)}</Fragment>}
            {pun.length > 0 && <Fragment key="z-puna">{banda('Puná')}{pun.map(fila)}</Fragment>}
            {otras.map(fila)}
          </>)
          })()}
        </div>
      )}
    </div>
  )
}

const inp = { padding: '8px 10px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE,
              borderRadius: '8px', background: 'white', color: NAVY }
const headCell = { fontSize: '10.5px', color: GRIS, textTransform: 'uppercase', letterSpacing: '.03em' }
const boton = { padding: '9px 14px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500,
                border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY, cursor: 'pointer' }
const btnLink = { fontSize: '12px', border: 'none', background: 'none', color: AZUL, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }

function Campo({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: '11px', color: GRIS, margin: '0 0 5px' }}>{label}</label>
      {children}
    </div>
  )
}
