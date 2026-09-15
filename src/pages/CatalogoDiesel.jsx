import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, dineroExacto, numDec } from '../lib/fechas'

// Catálogo de diesel · precio por galón de cada tipo (B, Premium) por
// finca, con fecha de vigencia. Lo gestiona el jefe. Mismo modelo que
// los precios de insumos: al guardar se cierra el anterior y se abre el
// nuevo desde la fecha elegida.

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
  const [edit, setEdit] = useState(null)        // { fincaId, valores:{tipoId:precio}, desde }

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

  function abrirEdit(fincaId) {
    const valores = {}
    tipos.forEach(t => { const p = precios[fincaId + '|' + t.id]; valores[t.id] = p ? String(p.precio) : '' })
    setEdit({ fincaId, valores, desde: hoyISO() })
  }

  async function guardar() {
    const desde = edit.desde || hoyISO()
    for (const t of tipos) {
      const raw = numDec(edit.valores[t.id] || '')
      const actual = precios[edit.fincaId + '|' + t.id]
      if (!(raw > 0)) continue
      if (actual && Math.abs(actual.precio - raw) < 0.00001) continue   // sin cambio
      // Cierra el vigente y abre el nuevo desde la fecha elegida.
      await supabase.schema('produccion').from('diesel_precio')
        .update({ vigente_hasta: sumarDias(desde, -1) })
        .eq('tipo_id', t.id).eq('finca_id', edit.fincaId).is('vigente_hasta', null).lt('vigente_desde', desde)
      const { error } = await supabase.schema('produccion').from('diesel_precio')
        .insert({ tipo_id: t.id, finca_id: edit.fincaId, precio_galon: raw, vigente_desde: desde })
      if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return }
    }
    setEdit(null); setAviso({ tipo: 'ok', texto: 'Precios guardados.' }); await cargar()
  }

  return (
    <div>
      {aviso && (
        <div style={{ borderRadius: '10px', padding: '11px 13px', fontSize: '13px', marginBottom: '12px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE',
                      color: aviso.tipo === 'error' ? ROJO : VERDE }}>{aviso.texto}</div>
      )}

      {cargando ? (
        <div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Cargando...</div>
      ) : (
        <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: `1.4fr repeat(${tipos.length}, 1fr) auto`, gap: '10px',
                        padding: '11px 16px', borderBottom: '0.5px solid ' + BORDE, background: '#f6f9fb', fontSize: '12px', color: GRIS, alignItems: 'center' }}>
            <span>Finca</span>
            {tipos.map(t => <span key={t.id} style={{ textAlign: 'right' }}>{t.nombre} · $/gal</span>)}
            <span></span>
          </div>
          {activas.map(f => {
            const enEdit = edit && edit.fincaId === f.id
            return (
              <div key={f.id}>
                <div style={{ display: 'grid', gridTemplateColumns: `1.4fr repeat(${tipos.length}, 1fr) auto`, gap: '10px',
                        padding: '13px 16px', borderBottom: '0.5px solid #f1f6f9', alignItems: 'center', fontSize: '14px' }}>
                  <span style={{ fontWeight: 500 }}>{String(f.nombre).toUpperCase()}</span>
                  {tipos.map(t => {
                    const p = precios[f.id + '|' + t.id]
                    return <span key={t.id} style={{ textAlign: 'right', color: p ? NAVY : '#c3d0db' }}>
                      {p ? dineroExacto(p.precio) : '—'}
                    </span>
                  })}
                  <span style={{ textAlign: 'right' }}>
                    <button onClick={() => enEdit ? setEdit(null) : abrirEdit(f.id)} style={btnLink}>
                      {enEdit ? 'Cerrar' : 'Editar'}
                    </button>
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
                    {tipos.some(t => precios[f.id + '|' + t.id]) && (
                      <div style={{ fontSize: '11px', color: GRIS, marginTop: '8px' }}>
                        Al guardar se cierra el precio anterior y rige el nuevo desde la fecha elegida.
                      </div>
                    )}
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
