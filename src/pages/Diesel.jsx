import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, sumarDias, corta, semanaISO, numDec, miles } from '../lib/fechas'

// Registro de diesel · semanal, separado del registro diario.
// Flujo: el bodeguero pide galones -> el jefe aprueba -> recién ahí suma
// al saldo. El consumo se reporta por semana (total por finca y tipo).
// Corregir/borrar: el jefe lo hace directo; el bodeguero pide permiso y
// le llega al jefe a la campana (solicitud_correccion).

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const VERDE = '#0F6E56'
const AMBAR = '#BA7517'
const ROJO = '#A32D2D'

export default function Diesel({ finca, esJefe, soloLectura, lunes, setLunes, onCambio }) {
  const domingo = sumarDias(lunes, 6)
  const [tipos, setTipos] = useState([])
  const [saldos, setSaldos] = useState({})
  const [pedidos, setPedidos] = useState([])
  const [consumos, setConsumos] = useState([])
  const [solis, setSolis] = useState([])        // correcciones pendientes de esta finca (diesel)
  const [userId, setUserId] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [form, setForm] = useState(null)

  const puedeRegistrar = !soloLectura

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    const [{ data: u }, { data: tp }, { data: sal }, { data: pe }, { data: co }, { data: sc }] = await Promise.all([
      supabase.auth.getUser(),
      supabase.schema('produccion').from('diesel_tipo').select('id, nombre, codigo').eq('activo', true).order('nombre'),
      // "Saldo actual" = hoy (o el fin de la semana vista si es futura), no
      // el domingo de una semana pasada.
      supabase.schema('produccion').rpc('fn_saldo_diesel', { p_finca: finca.id, p_hasta: (domingo > hoyISO() ? domingo : hoyISO()) }),
      supabase.schema('produccion').from('diesel_pedido')
        .select('id, tipo_id, galones, fecha, estado').eq('finca_id', finca.id)
        .gte('fecha', lunes).lte('fecha', domingo).order('solicitado_en', { ascending: false }),
      supabase.schema('produccion').from('diesel_consumo')
        .select('id, tipo_id, galones, fecha').eq('finca_id', finca.id)
        .gte('fecha', lunes).lte('fecha', domingo).order('fecha', { ascending: false }),
      supabase.schema('produccion').from('solicitud_correccion')
        .select('id, tabla, registro_id, valor_propuesto').eq('finca_id', finca.id)
        .in('tabla', ['diesel_pedido', 'diesel_consumo']).eq('estado', 'pendiente'),
    ])
    setUserId(u?.user?.id || null)
    setTipos(tp || [])
    const s = {}; (sal || []).forEach(r => { s[r.tipo_id] = r }); setSaldos(s)
    setPedidos(pe || [])
    setConsumos(co || [])
    setSolis(sc || [])
    setCargando(false)
  }, [finca.id, lunes, domingo])

  useEffect(() => { cargar() }, [cargar])

  const galSemana = (lista, tipoId, estado) => lista
    .filter(x => x.tipo_id === tipoId && (estado === undefined || x.estado === estado))
    .reduce((t, x) => t + Number(x.galones), 0)

  const nombreTipo = id => tipos.find(t => t.id === id)?.nombre || '—'
  const solDe = (tabla, id) => solis.find(x => x.tabla === tabla && x.registro_id === id)

  async function refrescar() { await cargar(); onCambio && onCambio() }

  async function guardarForm() {
    const gal = numDec(form.galones)
    if (!(gal > 0)) { setAviso({ tipo: 'error', texto: 'Pon los galones.' }); return }
    if (!form.tipoId) { setAviso({ tipo: 'error', texto: 'Elige el tipo de diesel.' }); return }
    const fecha = form.fecha || hoyISO()
    if (form.modo === 'pedido') {
      // El bodeguero registra libre: el pedido cuenta al saldo de una vez.
      const { error } = await supabase.schema('produccion').from('diesel_pedido')
        .insert({ finca_id: finca.id, tipo_id: form.tipoId, galones: gal, fecha,
                  estado: 'aprobado', aprobado_por: userId, aprobado_en: new Date().toISOString() })
      if (error) { setAviso({ tipo: 'error', texto: 'No se pudo registrar. ' + error.message }); return }
      setAviso({ tipo: 'ok', texto: 'Pedido registrado.' })
    } else {
      const { error } = await supabase.schema('produccion').from('diesel_consumo')
        .insert({ finca_id: finca.id, tipo_id: form.tipoId, galones: gal, fecha })
      if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return }
      setAviso({ tipo: 'ok', texto: 'Consumo registrado.' })
    }
    setForm(null); await refrescar()
  }

  // --- Jefe: edita/borra directo ---
  async function jefeEditar(tabla, row) {
    const txt = window.prompt('Nuevos galones:', String(row.galones))
    if (txt == null) return
    const gal = numDec(txt)
    if (!(gal > 0)) { setAviso({ tipo: 'error', texto: 'Galones no válidos.' }); return }
    const { data, error } = await supabase.schema('produccion').from(tabla).update({ galones: gal }).eq('id', row.id).select('id')
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    if (!data || data.length === 0) {
      setAviso({ tipo: 'error', texto: 'No se corrigió: no tienes permiso sobre este registro (revisar RLS de diesel).' }); return
    }
    setAviso({ tipo: 'ok', texto: 'Corregido.' }); await refrescar()
  }
  async function jefeBorrar(tabla, row) {
    if (!window.confirm(`¿Borrar este registro de ${miles(Number(row.galones))} gal?`)) return
    const { data, error } = await supabase.schema('produccion').from(tabla).delete().eq('id', row.id).select('id')
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    if (!data || data.length === 0) {
      setAviso({ tipo: 'error', texto: 'No se borró: no tienes permiso sobre este registro (revisar RLS de diesel).' }); return
    }
    setAviso({ tipo: 'ok', texto: 'Borrado.' }); await refrescar()
  }

  // --- Bodeguero: pide permiso (solicitud_correccion) ---
  async function pedirCorregir(tabla, row) {
    const txt = window.prompt('¿A cuántos galones debería corregirse?', String(row.galones))
    if (txt == null) return
    const gal = numDec(txt)
    if (!(gal > 0)) { setAviso({ tipo: 'error', texto: 'Galones no válidos.' }); return }
    const { error } = await supabase.schema('produccion').from('solicitud_correccion').insert({
      finca_id: finca.id, tabla, registro_id: row.id,
      valor_anterior: { galones: Number(row.galones) }, valor_propuesto: { galones: gal },
      motivo: 'Corrección de diesel', solicitado_por: userId })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo enviar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Pedido de cambio enviado. El jefe lo revisará.' }); await refrescar()
  }
  async function pedirBorrar(tabla, row) {
    if (!window.confirm('¿Pedir al jefe que borre este registro?')) return
    const { error } = await supabase.schema('produccion').from('solicitud_correccion').insert({
      finca_id: finca.id, tabla, registro_id: row.id,
      valor_anterior: { galones: Number(row.galones) }, valor_propuesto: { borrar: true },
      motivo: 'Borrar diesel', solicitado_por: userId })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo enviar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Pedido de borrado enviado. El jefe lo revisará.' }); await refrescar()
  }

  async function resolver(sol, aprobar) {
    const { error } = await supabase.schema('produccion').rpc('fn_resolver_correccion', { p_id: sol.id, p_aprobar: aprobar })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo resolver. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: aprobar ? 'Corrección aplicada.' : 'Corrección rechazada.' }); await refrescar()
  }

  // Acciones por fila según rol (jefe edita/borra; bodeguero pide permiso).
  function Acciones({ tabla, row }) {
    if (!puedeRegistrar) return null
    const yaPidio = solDe(tabla, row.id)
    if (yaPidio) return <span style={{ fontSize: '12px', padding: '3px 10px', borderRadius: '20px', background: '#FAEEDA', color: '#854F0B' }}>Cambio enviado</span>
    if (esJefe) return (
      <span style={{ display: 'flex', gap: '6px' }}>
        <button onClick={() => jefeEditar(tabla, row)} style={btnGhost}>Editar</button>
        <button onClick={() => jefeBorrar(tabla, row)} style={btnDel}>Borrar</button>
      </span>
    )
    return (
      <span style={{ display: 'flex', gap: '10px' }}>
        <button onClick={() => pedirCorregir(tabla, row)} style={btnLink}>Pedir corregir</button>
        <button onClick={() => pedirBorrar(tabla, row)} style={btnLink}>Pedir borrar</button>
      </span>
    )
  }

  return (
    <div style={{ padding: '1.4rem 1.5rem', maxWidth: '1080px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <h2 style={{ fontSize: '19px', fontWeight: 500, margin: 0 }}>Diesel</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }}>
          <BtnMini onClick={() => setLunes(sumarDias(lunes, -7))}>‹</BtnMini>
          <span style={{ fontSize: '13px', color: GRIS, minWidth: '210px', textAlign: 'center' }}>
            Semana {semanaISO(lunes).semana} · del {corta(lunes)} al {corta(domingo)}
          </span>
          <BtnMini onClick={() => setLunes(sumarDias(lunes, 7))}>›</BtnMini>
        </div>
      </div>

      {aviso && (
        <div style={{ borderRadius: '10px', padding: '11px 13px', fontSize: '13px', marginBottom: '12px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE',
                      color: aviso.tipo === 'error' ? ROJO : VERDE }}>{aviso.texto}</div>
      )}

      {cargando ? (
        <Caja><div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Cargando...</div></Caja>
      ) : (
        <>
          <Caja>
            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr', gap: '10px',
                          padding: '11px 16px', borderBottom: '0.5px solid ' + BORDE, background: '#f6f9fb',
                          fontSize: '12px', color: GRIS }}>
              <span>Diesel</span>
              <span style={{ textAlign: 'right' }}>Pedidos (sem)</span>
              <span style={{ textAlign: 'right' }}>Consumo (sem)</span>
              <span style={{ textAlign: 'right' }}>Saldo actual (gal)</span>
            </div>
            {tipos.map(t => {
              const ped = galSemana(pedidos, t.id)
              const con = galSemana(consumos, t.id)
              const saldo = Number(saldos[t.id]?.saldo || 0)
              return (
                <div key={t.id} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr', gap: '10px',
                        padding: '13px 16px', borderBottom: '0.5px solid #f1f6f9', alignItems: 'center', fontSize: '14px' }}>
                  <span style={{ fontWeight: 500 }}>{t.nombre}
                    <span style={{ fontSize: '11px', color: AMBAR, marginLeft: '7px' }}>diesel</span></span>
                  <span style={{ textAlign: 'right', color: ped ? VERDE : '#c3d0db' }}>{ped ? '+' + miles(ped) : '—'}</span>
                  <span style={{ textAlign: 'right', color: con ? ROJO : '#c3d0db' }}>{con ? '−' + miles(con) : '—'}</span>
                  <span style={{ textAlign: 'right', fontWeight: 500, color: saldo < 0 ? ROJO : NAVY }}>{miles(saldo)}</span>
                </div>
              )
            })}
            {puedeRegistrar && (
              <div style={{ display: 'flex', gap: '9px', padding: '13px 16px', flexWrap: 'wrap' }}>
                <Btn onClick={() => setForm({ modo: 'pedido', tipoId: tipos[0]?.id || '', galones: '', fecha: hoyISO() })}>Registrar pedido</Btn>
                <Btn onClick={() => setForm({ modo: 'consumo', tipoId: tipos[0]?.id || '', galones: '', fecha: hoyISO() })}>Registrar consumo</Btn>
              </div>
            )}
          </Caja>

          {form && (
            <Caja estilo={{ marginTop: '12px' }}>
              <div style={{ padding: '14px 16px' }}>
                <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '11px' }}>
                  {form.modo === 'pedido' ? 'Nuevo pedido de diesel' : 'Registrar consumo de la semana'}
                </div>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Campo label="Tipo">
                    <select value={form.tipoId} onChange={e => setForm(f => ({ ...f, tipoId: e.target.value }))} style={{ ...inp, width: '170px' }}>
                      {tipos.map(t => <option key={t.id} value={t.id}>{t.nombre}</option>)}
                    </select>
                  </Campo>
                  <Campo label="Galones">
                    <input inputMode="decimal" value={form.galones} placeholder="ej. 200"
                      onChange={e => setForm(f => ({ ...f, galones: e.target.value }))}
                      style={{ ...inp, width: '110px', textAlign: 'right' }} />
                  </Campo>
                  <Campo label="Fecha">
                    <input type="date" value={form.fecha} max={hoyISO()}
                      onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} style={{ ...inp, width: '160px' }} />
                  </Campo>
                  <Btn primario onClick={guardarForm}>{form.modo === 'pedido' ? 'Enviar pedido' : 'Guardar consumo'}</Btn>
                  <Btn onClick={() => setForm(null)}>Cancelar</Btn>
                </div>
              </div>
            </Caja>
          )}

          {/* Correcciones pendientes · solo jefe */}
          {esJefe && solis.length > 0 && (
            <div style={{ marginTop: '18px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 10px' }}>Correcciones por aprobar</h3>
              <Caja>
                {solis.map(sc => {
                  const borrar = !!sc.valor_propuesto?.borrar
                  return (
                    <div key={sc.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            gap: '10px', padding: '12px 16px', borderBottom: '0.5px solid #f1f6f9', fontSize: '14px' }}>
                      <span>
                        <span style={{ fontWeight: 500 }}>{sc.tabla === 'diesel_pedido' ? 'Pedido' : 'Consumo'}</span>
                        <span style={{ color: GRIS, marginLeft: '8px', fontSize: '13px' }}>
                          {borrar ? 'Borrar' : `Corregir a ${miles(Number(sc.valor_propuesto?.galones))} gal`}
                        </span>
                      </span>
                      <span style={{ display: 'flex', gap: '6px' }}>
                        <button onClick={() => resolver(sc, true)} style={btnOk}>Aprobar</button>
                        <button onClick={() => resolver(sc, false)} style={btnNo}>Rechazar</button>
                      </span>
                    </div>
                  )
                })}
              </Caja>
            </div>
          )}

          <div style={{ marginTop: '18px' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 10px' }}>Pedidos de la semana</h3>
            {pedidos.length === 0 ? (
              <Caja><div style={{ padding: '20px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Sin pedidos esta semana.</div></Caja>
            ) : (
              <Caja>
                {pedidos.map(p => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          gap: '10px', padding: '12px 16px', borderBottom: '0.5px solid #f1f6f9', fontSize: '14px' }}>
                    <span>
                      <span style={{ fontWeight: 500 }}>{nombreTipo(p.tipo_id)}</span>
                      <span style={{ color: GRIS, marginLeft: '8px', fontSize: '13px' }}>{corta(p.fecha)}</span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <span style={{ color: VERDE, fontVariantNumeric: 'tabular-nums' }}>+{miles(Number(p.galones))} gal</span>
                      <Acciones tabla="diesel_pedido" row={p} />
                    </span>
                  </div>
                ))}
              </Caja>
            )}
          </div>

          <div style={{ marginTop: '18px' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 10px' }}>Consumo de la semana</h3>
            {consumos.length === 0 ? (
              <Caja><div style={{ padding: '20px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Sin consumo registrado esta semana.</div></Caja>
            ) : (
              <Caja>
                {consumos.map(c => (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          gap: '10px', padding: '12px 16px', borderBottom: '0.5px solid #f1f6f9', fontSize: '14px' }}>
                    <span>
                      <span style={{ fontWeight: 500 }}>{nombreTipo(c.tipo_id)}</span>
                      <span style={{ color: GRIS, marginLeft: '8px', fontSize: '13px' }}>{corta(c.fecha)}</span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <span style={{ color: ROJO, fontVariantNumeric: 'tabular-nums' }}>{miles(Number(c.galones))} gal</span>
                      <Acciones tabla="diesel_consumo" row={c} />
                    </span>
                  </div>
                ))}
              </Caja>
            )}
          </div>
        </>
      )}
    </div>
  )
}

const inp = { padding: '9px 11px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE,
              borderRadius: '9px', background: 'white', color: NAVY }
const btnOk = { fontSize: '12px', padding: '6px 12px', borderRadius: '8px', border: '0.5px solid #3B6D11',
                background: '#EAF3DE', color: '#27500A', fontFamily: 'inherit', cursor: 'pointer' }
const btnNo = { fontSize: '12px', padding: '6px 12px', borderRadius: '8px', border: '0.5px solid ' + BORDE,
                background: 'white', color: GRIS, fontFamily: 'inherit', cursor: 'pointer' }
const btnGhost = { fontSize: '12px', padding: '5px 10px', borderRadius: '8px', border: '0.5px solid ' + BORDE,
                   background: 'white', color: GRIS, fontFamily: 'inherit', cursor: 'pointer' }
const btnDel = { fontSize: '12px', padding: '5px 10px', borderRadius: '8px', border: '0.5px solid #e8c9c9',
                 background: 'white', color: ROJO, fontFamily: 'inherit', cursor: 'pointer' }
const btnLink = { fontSize: '12px', border: 'none', background: 'none', color: AZUL, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }

function Caja({ children, estilo }) {
  return <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden', ...estilo }}>{children}</div>
}
function Campo({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: '11px', color: GRIS, margin: '0 0 5px' }}>{label}</label>
      {children}
    </div>
  )
}
function Btn({ children, onClick, primario }) {
  return (
    <button onClick={onClick} style={{ background: primario ? AZUL : 'white', color: primario ? 'white' : NAVY,
      border: '0.5px solid ' + (primario ? AZUL : BORDE), borderRadius: '9px', padding: '9px 15px',
      fontFamily: 'inherit', fontSize: '13px', fontWeight: primario ? 500 : 400, cursor: 'pointer' }}>{children}</button>
  )
}
function BtnMini({ children, onClick }) {
  return (
    <button onClick={onClick} style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '8px',
      width: '30px', height: '30px', cursor: 'pointer', color: NAVY, fontSize: '15px', fontFamily: 'inherit' }}>{children}</button>
  )
}
