import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, dineroExacto, numDec } from '../lib/fechas'

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
  const activas = (fincas || []).filter(f => String(f.nombre).toUpperCase() !== 'PRUEBA')
  const [tipos, setTipos] = useState([])
  const [precios, setPrecios] = useState({})   // fincaId|tipoId -> { precio, desde }
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [edit, setEdit] = useState(null)        // { fincaId, valores, desde }
  const [bulk, setBulk] = useState(null)        // { valores, desde }
  const [hist, setHist] = useState(null)        // fincaId con historial abierto
  const [histRows, setHistRows] = useState([])

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

  // Aplica los valores a una finca: cierra el vigente y abre el nuevo.
  async function aplicar(fincaId, valores, desde) {
    for (const t of tipos) {
      const raw = numDec(valores[t.id] || '')
      if (!(raw > 0)) continue
      const actual = precios[fincaId + '|' + t.id]
      if (actual && Math.abs(actual.precio - raw) < 0.00001) continue
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
    setBulk(null); setHist(null); setEdit({ fincaId, valores, desde: hoyISO() })
  }

  async function guardar() {
    try { await aplicar(edit.fincaId, edit.valores, edit.desde || hoyISO()) }
    catch (e) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + e.message }); return }
    setEdit(null); setAviso({ tipo: 'ok', texto: 'Precios guardados.' }); await cargar()
  }

  async function guardarBulk() {
    const desde = bulk.desde || hoyISO()
    if (!tipos.some(t => numDec(bulk.valores[t.id] || '') > 0)) {
      setAviso({ tipo: 'error', texto: 'Pon al menos un precio.' }); return
    }
    try { for (const f of activas) await aplicar(f.id, bulk.valores, desde) }
    catch (e) { setAviso({ tipo: 'error', texto: 'No se pudo aplicar. ' + e.message }); return }
    setBulk(null); setAviso({ tipo: 'ok', texto: `Precios aplicados a ${activas.length} fincas.` }); await cargar()
  }

  async function abrirHist(fincaId) {
    if (hist === fincaId) { setHist(null); return }
    const { data } = await supabase.schema('produccion').from('diesel_precio')
      .select('tipo_id, precio_galon, vigente_desde, vigente_hasta').eq('finca_id', fincaId)
      .order('vigente_desde', { ascending: false })
    setHistRows(data || []); setHist(fincaId); setEdit(null)
  }

  const gtc = `1.4fr repeat(${tipos.length}, 1fr) auto`
  const nombreTipo = id => tipos.find(t => t.id === id)?.nombre || '—'

  return (
    <div>
      {aviso && (
        <div style={{ borderRadius: '10px', padding: '11px 13px', fontSize: '13px', marginBottom: '12px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE',
                      color: aviso.tipo === 'error' ? ROJO : VERDE }}>{aviso.texto}</div>
      )}

      {!cargando && !bulk && (
        <div style={{ marginBottom: '12px' }}>
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
                <input inputMode="decimal" value={bulk.valores[t.id] || ''} placeholder="ej. 1.80"
                  onChange={e => setBulk(x => ({ ...x, valores: { ...x.valores, [t.id]: e.target.value } }))}
                  style={{ ...inp, width: '100px', textAlign: 'right' }} />
              </Campo>
            ))}
            <Campo label="Rige desde">
              <input type="date" value={bulk.desde} max={hoyISO()}
                onChange={e => setBulk(x => ({ ...x, desde: e.target.value }))} style={inp} />
            </Campo>
            <button onClick={guardarBulk} style={{ ...boton, background: AZUL, color: 'white', borderColor: AZUL }}>
              Aplicar a {activas.length} fincas
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
            {tipos.map(t => <span key={t.id} style={{ textAlign: 'right' }}>{t.nombre} · $/gal</span>)}
            <span></span>
          </div>
          {activas.map(f => {
            const enEdit = edit && edit.fincaId === f.id
            const enHist = hist === f.id
            return (
              <div key={f.id}>
                <div style={{ display: 'grid', gridTemplateColumns: gtc, gap: '10px', padding: '13px 16px',
                        borderBottom: '0.5px solid #f1f6f9', alignItems: 'center', fontSize: '14px' }}>
                  <span style={{ fontWeight: 500 }}>{String(f.nombre).toUpperCase()}</span>
                  {tipos.map(t => {
                    const p = precios[f.id + '|' + t.id]
                    return <span key={t.id} style={{ textAlign: 'right', color: p ? NAVY : '#c3d0db' }}>{p ? dineroExacto(p.precio) : '—'}</span>
                  })}
                  <span style={{ textAlign: 'right', display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                    <button onClick={() => abrirHist(f.id)} style={btnLink}>{enHist ? 'Ocultar' : 'Historial'}</button>
                    <button onClick={() => enEdit ? setEdit(null) : abrirEdit(f.id)} style={btnLink}>{enEdit ? 'Cerrar' : 'Editar'}</button>
                  </span>
                </div>

                {enEdit && (
                  <div style={{ padding: '12px 16px', background: '#f6f9fb', borderBottom: '0.5px solid #f1f6f9' }}>
                    <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      {tipos.map(t => (
                        <Campo key={t.id} label={`${t.nombre} · $/gal`}>
                          <input inputMode="decimal" value={edit.valores[t.id] || ''} placeholder="ej. 1.80"
                            onChange={e => setEdit(x => ({ ...x, valores: { ...x.valores, [t.id]: e.target.value } }))}
                            style={{ ...inp, width: '100px', textAlign: 'right' }} />
                        </Campo>
                      ))}
                      <Campo label="Rige desde">
                        <input type="date" value={edit.desde} max={hoyISO()}
                          onChange={e => setEdit(x => ({ ...x, desde: e.target.value }))} style={inp} />
                      </Campo>
                      <button onClick={guardar} style={{ ...boton, background: AZUL, color: 'white', borderColor: AZUL }}>Guardar</button>
                      <button onClick={() => setEdit(null)} style={boton}>Cancelar</button>
                    </div>
                    <div style={{ fontSize: '11px', color: GRIS, marginTop: '8px' }}>
                      Al guardar se cierra el precio anterior y rige el nuevo desde la fecha elegida.
                    </div>
                  </div>
                )}

                {enHist && (
                  <div style={{ padding: '12px 16px', background: '#fafcfd', borderBottom: '0.5px solid #f1f6f9' }}>
                    <div style={{ fontSize: '12px', color: GRIS, marginBottom: '8px' }}>Historial de precios</div>
                    {histRows.length === 0 ? (
                      <div style={{ fontSize: '13px', color: GRIS }}>Sin precios registrados.</div>
                    ) : histRows.map((r, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', padding: '5px 0', borderBottom: '0.5px solid #f1f6f9' }}>
                        <span>{nombreTipo(r.tipo_id)}</span>
                        <span style={{ color: GRIS }}>
                          {dineroExacto(Number(r.precio_galon))} / gal · desde {corta(r.vigente_desde)}
                          {r.vigente_hasta ? ` hasta ${corta(r.vigente_hasta)}` : ' · vigente'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const inp = { padding: '8px 10px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE,
              borderRadius: '8px', background: 'white', color: NAVY }
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
