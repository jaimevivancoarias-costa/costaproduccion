import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, sumarDias, corta, semanaISO, numDec, miles } from '../lib/fechas'
import CampoNumero from '../components/CampoNumero'

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
// Precio del galón con hasta 6 decimales (como el Catálogo de diesel).
const precio6 = n => '$' + (Number(n) || 0).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 6 })

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
  const [precios, setPrecios] = useState({})    // tipo_id -> { precio, desde } (catálogo vigente)
  const [revPrecio, setRevPrecio] = useState(null)  // pop-up verificar precio al registrar el pedido

  const puedeRegistrar = !soloLectura

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    const [{ data: u }, { data: tp }, { data: sal }, { data: pe }, { data: co }, { data: sc }, { data: pr }] = await Promise.all([
      supabase.auth.getUser(),
      supabase.schema('produccion').from('diesel_tipo').select('id, nombre, codigo').eq('activo', true).order('nombre'),
      // "Saldo actual" = hoy (o el fin de la semana vista si es futura), no
      // el domingo de una semana pasada.
      supabase.schema('produccion').rpc('fn_saldo_diesel', { p_finca: finca.id, p_hasta: (domingo < hoyISO() ? domingo : hoyISO()) }),
      supabase.schema('produccion').from('diesel_pedido')
        .select('id, tipo_id, galones, fecha, estado').eq('finca_id', finca.id)
        .gte('fecha', lunes).lte('fecha', domingo).order('solicitado_en', { ascending: false }),
      supabase.schema('produccion').from('diesel_consumo')
        .select('id, tipo_id, galones, fecha').eq('finca_id', finca.id)
        .gte('fecha', lunes).lte('fecha', domingo).order('fecha', { ascending: false }),
      supabase.schema('produccion').from('solicitud_correccion')
        .select('id, tabla, registro_id, valor_propuesto').eq('finca_id', finca.id)
        .in('tabla', ['diesel_pedido', 'diesel_consumo']).eq('estado', 'pendiente'),
      supabase.schema('produccion').from('diesel_precio')
        .select('tipo_id, finca_id, precio_galon, vigente_desde').is('vigente_hasta', null)
        .or(`finca_id.is.null,finca_id.eq.${finca.id}`),
    ])
    setUserId(u?.user?.id || null)
    setTipos(tp || [])
    const s = {}; (sal || []).forEach(r => { s[r.tipo_id] = r }); setSaldos(s)
    setPedidos(pe || [])
    setConsumos(co || [])
    setSolis(sc || [])
    // Precio del catálogo que rige por tipo (la de la finca gana a la general).
    const pm = {}
    ;(pr || []).forEach(r => {
      const esFinca = !!r.finca_id
      if (pm[r.tipo_id] == null || esFinca) pm[r.tipo_id] = { precio: Number(r.precio_galon), desde: r.vigente_desde }
    })
    setPrecios(pm)
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
      // Antes de registrar el ingreso, abrir el pop-up para verificar el precio
      // del catálogo (cambia mensualmente). Se guarda desde ahí.
      const p = precios[form.tipoId]
      setRevPrecio({ tipoId: form.tipoId, galones: gal, fecha,
                     precioActual: p ? p.precio : null,
                     precio: p ? String(p.precio) : '' })
      return
    }
    const { error } = await supabase.schema('produccion').from('diesel_consumo')
      .insert({ finca_id: finca.id, tipo_id: form.tipoId, galones: gal, fecha })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Consumo registrado.' })
    setForm(null); await refrescar()
  }

  // Confirmar el ingreso de diesel: si el precio del catálogo cambió, lo
  // actualiza (rige desde la fecha del ingreso) y recién ahí registra el pedido.
  async function guardarPedido() {
    const r = revPrecio
    const nuevo = numDec(r.precio)
    if (!(nuevo > 0)) { setAviso({ tipo: 'error', texto: 'Pon el precio del galón.' }); return }
    const cambio = r.precioActual == null || Math.abs(nuevo - r.precioActual) > 1e-9
    if (cambio) {
      // Catálogo: una sola fila vigente. Borra las del mismo día/posterior,
      // cierra la anterior y mete la nueva (mismo patrón que CatalogoDiesel).
      await supabase.schema('produccion').from('diesel_precio')
        .delete().eq('tipo_id', r.tipoId).eq('finca_id', finca.id).is('vigente_hasta', null).gte('vigente_desde', r.fecha)
      await supabase.schema('produccion').from('diesel_precio')
        .update({ vigente_hasta: sumarDias(r.fecha, -1) })
        .eq('tipo_id', r.tipoId).eq('finca_id', finca.id).is('vigente_hasta', null).lt('vigente_desde', r.fecha)
      const { error: ep } = await supabase.schema('produccion').from('diesel_precio')
        .insert({ tipo_id: r.tipoId, finca_id: finca.id, precio_galon: nuevo, vigente_desde: r.fecha })
      if (ep) { setAviso({ tipo: 'error', texto: 'No se pudo actualizar el precio. ' + ep.message }); return }
    }
    const { error } = await supabase.schema('produccion').from('diesel_pedido')
      .insert({ finca_id: finca.id, tipo_id: r.tipoId, galones: r.galones, fecha: r.fecha,
                estado: 'aprobado', aprobado_por: userId, aprobado_en: new Date().toISOString() })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo registrar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: cambio ? 'Pedido registrado y precio actualizado en el catálogo.' : 'Pedido registrado.' })
    setRevPrecio(null); setForm(null); await refrescar()
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
      {revPrecio && (() => {
        const nuevo = numDec(revPrecio.precio)
        const cambio = revPrecio.precioActual != null && Math.abs(nuevo - revPrecio.precioActual) > 1e-9
        return (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,40,71,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 60 }}>
          <div style={{ background: 'white', borderRadius: '14px', padding: '22px 24px', width: '100%', maxWidth: '440px', boxShadow: '0 12px 40px rgba(2,40,71,.18)' }}>
            <div style={{ fontWeight: 600, fontSize: '16px', marginBottom: '3px' }}>Verifica el precio del diesel</div>
            <div style={{ fontSize: '12.5px', color: GRIS, marginBottom: '16px', lineHeight: 1.5 }}>
              {nombreTipo(revPrecio.tipoId)} · {miles(revPrecio.galones)} gal. El precio del catálogo cambia cada mes — confírmalo o actualízalo.
            </div>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>Precio por galón</div>
                <CampoNumero maxDec={6} autoFocus value={revPrecio.precio} onChange={v => setRevPrecio(x => ({ ...x, precio: v }))}
                  style={{ ...inp, width: '150px', textAlign: 'right' }} />
              </div>
              <div style={{ fontSize: '12px', color: GRIS, paddingBottom: '9px' }}>
                {revPrecio.precioActual != null ? <>catálogo {precio6(revPrecio.precioActual)}</> : 'sin precio en catálogo'}
              </div>
            </div>
            <div style={{ fontSize: '11.5px', color: cambio ? AMBAR : GRIS, margin: '10px 0 14px', lineHeight: 1.5 }}>
              {cambio ? `Cambiaste el precio → se actualizará en el catálogo y regirá desde ${corta(revPrecio.fecha)}.` : 'Si el precio sigue igual, solo confirma.'}
            </div>
            <div style={{ display: 'flex', gap: '9px' }}>
              <Btn primario onClick={guardarPedido}>Guardar ingreso</Btn>
              <Btn onClick={() => setRevPrecio(null)}>Volver</Btn>
            </div>
          </div>
        </div>
        )
      })()}
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
            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr 1fr', gap: '10px',
                          padding: '11px 16px', borderBottom: '0.5px solid ' + BORDE, background: '#f6f9fb',
                          fontSize: '12px', color: GRIS }}>
              <span>Diesel</span>
              <span style={{ textAlign: 'right' }}>Saldo al inicio</span>
              <span style={{ textAlign: 'right' }}>Pedidos (sem)</span>
              <span style={{ textAlign: 'right' }}>Consumo (sem)</span>
              <span style={{ textAlign: 'right' }}>Saldo (gal)</span>
            </div>
            {tipos.map(t => {
              const ped = galSemana(pedidos, t.id)
              const con = galSemana(consumos, t.id)
              const saldo = Number(saldos[t.id]?.saldo || 0)
              // Saldo al inicio = saldo del fin de la semana menos lo que entró y más
              // lo que salió. Así incluye un inventario inicial que caiga dentro de
              // la semana y la fila SIEMPRE cuadra (inicio + pedidos − consumo = saldo).
              const ini = saldo - ped + con
              return (
                <div key={t.id} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr 1fr', gap: '10px',
                        padding: '13px 16px', borderBottom: '0.5px solid #f1f6f9', alignItems: 'center', fontSize: '14px' }}>
                  <span style={{ fontWeight: 500 }}>{t.nombre}
                    <span style={{ fontSize: '11px', color: AMBAR, marginLeft: '7px' }}>diesel</span></span>
                  <span style={{ textAlign: 'right', color: GRIS }}>{miles(ini)}</span>
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
                    <CampoNumero value={form.galones} placeholder="ej. 200"
                      onChange={v => setForm(f => ({ ...f, galones: v }))}
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
