import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, lunesDe, sumarDias, corta, semanaISO, numDec, miles } from '../lib/fechas'

// Registro de diesel · semanal, separado del registro diario.
// Flujo: el bodeguero pide galones -> el jefe aprueba -> recién ahí suma
// al saldo. El consumo se reporta por semana (total por finca y tipo).

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const VERDE = '#0F6E56'
const AMBAR = '#BA7517'
const ROJO = '#A32D2D'

export default function Diesel({ finca, esJefe, soloLectura, lunes, setLunes }) {
  const domingo = sumarDias(lunes, 6)
  const [tipos, setTipos] = useState([])
  const [saldos, setSaldos] = useState({})       // tipo_id -> {ingresos, consumo, saldo}
  const [pedidos, setPedidos] = useState([])     // pedidos de la semana (todos los estados)
  const [consumos, setConsumos] = useState([])   // consumos de la semana
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [form, setForm] = useState(null)         // { modo:'pedido'|'consumo', tipoId, galones, fecha }

  const puedeRegistrar = !soloLectura

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    const [{ data: tp }, { data: sal }, { data: pe }, { data: co }] = await Promise.all([
      supabase.schema('produccion').from('diesel_tipo').select('id, nombre, codigo').eq('activo', true).order('nombre'),
      supabase.schema('produccion').rpc('fn_saldo_diesel', { p_finca: finca.id, p_hasta: domingo }),
      supabase.schema('produccion').from('diesel_pedido')
        .select('id, tipo_id, galones, fecha, estado, nota').eq('finca_id', finca.id)
        .gte('fecha', lunes).lte('fecha', domingo).order('solicitado_en', { ascending: false }),
      supabase.schema('produccion').from('diesel_consumo')
        .select('id, tipo_id, galones, fecha').eq('finca_id', finca.id)
        .gte('fecha', lunes).lte('fecha', domingo),
    ])
    setTipos(tp || [])
    const s = {}; (sal || []).forEach(r => { s[r.tipo_id] = r }); setSaldos(s)
    setPedidos(pe || [])
    setConsumos(co || [])
    setCargando(false)
  }, [finca.id, lunes, domingo])

  useEffect(() => { cargar() }, [cargar])

  const galSemana = (lista, tipoId, estado) => lista
    .filter(x => x.tipo_id === tipoId && (estado === undefined || x.estado === estado))
    .reduce((t, x) => t + Number(x.galones), 0)

  async function guardarForm() {
    const gal = numDec(form.galones)
    if (!(gal > 0)) { setAviso({ tipo: 'error', texto: 'Pon los galones.' }); return }
    if (!form.tipoId) { setAviso({ tipo: 'error', texto: 'Elige el tipo de diesel.' }); return }
    const fecha = form.fecha || hoyISO()
    if (form.modo === 'pedido') {
      const { error } = await supabase.schema('produccion').from('diesel_pedido')
        .insert({ finca_id: finca.id, tipo_id: form.tipoId, galones: gal, fecha })
      if (error) { setAviso({ tipo: 'error', texto: 'No se pudo pedir. ' + error.message }); return }
      setAviso({ tipo: 'ok', texto: 'Pedido enviado. Espera la aprobación del jefe.' })
    } else {
      const { error } = await supabase.schema('produccion').from('diesel_consumo')
        .insert({ finca_id: finca.id, tipo_id: form.tipoId, galones: gal, fecha })
      if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return }
      setAviso({ tipo: 'ok', texto: 'Consumo registrado.' })
    }
    setForm(null); await cargar()
  }

  async function aprobar(id, ok) {
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.schema('produccion').from('diesel_pedido')
      .update({ estado: ok ? 'aprobado' : 'rechazado', aprobado_por: user?.id || null, aprobado_en: new Date().toISOString() })
      .eq('id', id)
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    setAviso({ tipo: 'ok', texto: ok ? 'Pedido aprobado.' : 'Pedido rechazado.' })
    await cargar()
  }

  const nombreTipo = id => tipos.find(t => t.id === id)?.nombre || '—'
  const pendientes = pedidos.filter(p => p.estado === 'pendiente')

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
              <span style={{ textAlign: 'right' }}>Pedido aprobado (sem)</span>
              <span style={{ textAlign: 'right' }}>Consumo (sem)</span>
              <span style={{ textAlign: 'right' }}>Saldo actual (gal)</span>
            </div>
            {tipos.map(t => {
              const ped = galSemana(pedidos, t.id, 'aprobado')
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
                {form.modo === 'pedido' && (
                  <div style={{ fontSize: '12px', color: GRIS, marginTop: '9px' }}>
                    El pedido queda pendiente hasta que el jefe lo apruebe. Recién ahí suma al saldo.
                  </div>
                )}
              </div>
            </Caja>
          )}

          <div style={{ marginTop: '18px' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 10px' }}>
              Pedidos de la semana {pendientes.length > 0 && <span style={{ fontSize: '12px', color: AMBAR }}>· {pendientes.length} por aprobar</span>}
            </h3>
            {pedidos.length === 0 ? (
              <Caja><div style={{ padding: '20px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Sin pedidos esta semana.</div></Caja>
            ) : (
              <Caja>
                {pedidos.map(p => {
                  const col = p.estado === 'aprobado' ? VERDE : p.estado === 'rechazado' ? ROJO : AMBAR
                  const et = p.estado === 'aprobado' ? 'Aprobado' : p.estado === 'rechazado' ? 'Rechazado' : 'Pendiente'
                  return (
                    <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            gap: '10px', padding: '12px 16px', borderBottom: '0.5px solid #f1f6f9', fontSize: '14px' }}>
                      <span>
                        <span style={{ fontWeight: 500 }}>{nombreTipo(p.tipo_id)}</span>
                        <span style={{ color: GRIS, marginLeft: '8px', fontSize: '13px' }}>{corta(p.fecha)}</span>
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{miles(Number(p.galones))} gal</span>
                        <span style={{ fontSize: '12px', color: col, background: col + '18', borderRadius: '20px', padding: '3px 10px' }}>{et}</span>
                        {esJefe && p.estado === 'pendiente' && (
                          <span style={{ display: 'flex', gap: '6px' }}>
                            <button onClick={() => aprobar(p.id, true)} style={btnOk}>Aprobar</button>
                            <button onClick={() => aprobar(p.id, false)} style={btnNo}>Rechazar</button>
                          </span>
                        )}
                      </span>
                    </div>
                  )
                })}
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
