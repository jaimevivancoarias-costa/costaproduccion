import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, dinero, numDec, miles } from '../lib/fechas'

// Presupuesto de diesel · por finca y mes. Un monto en $ por tipo
// (Diesel B, Premium) y uno global. El jefe lo ve dolarizado; el
// bodeguero ve solo el % de avance. Se renueva cada mes.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const VERDE = '#0F6E56'
const AMBAR = '#BA7517'
const ROJO = '#A32D2D'

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
               'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

export default function PresupuestoDiesel({ finca, esJefe }) {
  const hoy = hoyISO()
  const [anio, setAnio] = useState(Number(hoy.slice(0, 4)))
  const [mes, setMes] = useState(Number(hoy.slice(5, 7)))
  const [tipos, setTipos] = useState([])
  const [montos, setMontos] = useState({})   // tipo_id -> monto
  const [gastos, setGastos] = useState({})    // tipo_id (+'global') -> $ gastado
  const [galones, setGalones] = useState({})  // tipo_id -> galones consumidos del mes
  const [cargando, setCargando] = useState(true)
  const [editando, setEditando] = useState(null)  // clave en edición
  const [nuevo, setNuevo] = useState('')
  const [aviso, setAviso] = useState(null)

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    const { data: tp } = await supabase.schema('produccion').from('diesel_tipo')
      .select('id, nombre').eq('activo', true).order('nombre')
    const lista = tp || []
    setTipos(lista)
    // Presupuesto solo POR TIPO. El global es la suma (no se fija aparte).
    const { data: pp } = await supabase.schema('produccion').from('presupuesto_diesel')
      .select('tipo_id, monto').eq('finca_id', finca.id).eq('anio', anio).eq('mes', mes)
      .not('tipo_id', 'is', null)
    const m = {}
    ;(pp || []).forEach(r => { m[r.tipo_id] = Number(r.monto) })
    setMontos(m)
    // Gasto en $ por tipo.
    const res = await Promise.all(lista.map(t =>
      supabase.schema('produccion').rpc('fn_gasto_diesel_mes',
        { p_finca: finca.id, p_anio: anio, p_mes: mes, p_tipo: t.id })))
    const g = {}
    lista.forEach((t, i) => { g[t.id] = Number(res[i].data) || 0 })
    setGastos(g)
    // Galones consumidos del mes por tipo (para el desglose en barras).
    const desde = `${anio}-${String(mes).padStart(2, '0')}-01`
    const hasta = new Date(anio, mes, 0).toISOString().slice(0, 10)
    const { data: co } = await supabase.schema('produccion').from('diesel_consumo')
      .select('tipo_id, galones').eq('finca_id', finca.id).gte('fecha', desde).lte('fecha', hasta)
    const gal = {}
    ;(co || []).forEach(r => { gal[r.tipo_id] = (gal[r.tipo_id] || 0) + Number(r.galones) })
    setGalones(gal)
    setCargando(false)
  }, [finca.id, anio, mes])

  useEffect(() => { cargar() }, [cargar])

  async function guardar(clave) {
    const v = numDec(nuevo)
    if (!(v >= 0)) { setAviso({ tipo: 'error', texto: 'Monto no válido.' }); return }
    const tipoId = clave === 'global' ? null : clave
    let q = supabase.schema('produccion').from('presupuesto_diesel').select('id')
      .eq('finca_id', finca.id).eq('anio', anio).eq('mes', mes)
    q = tipoId ? q.eq('tipo_id', tipoId) : q.is('tipo_id', null)
    const { data: ex } = await q.maybeSingle()
    const fila = { finca_id: finca.id, tipo_id: tipoId, anio, mes, monto: v, actualizado_en: new Date().toISOString() }
    const { error } = ex
      ? await supabase.schema('produccion').from('presupuesto_diesel').update(fila).eq('id', ex.id)
      : await supabase.schema('produccion').from('presupuesto_diesel').insert(fila)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return }
    setEditando(null); setNuevo(''); setAviso({ tipo: 'ok', texto: 'Presupuesto guardado.' }); await cargar()
  }

  async function borrar(clave) {
    if (!window.confirm('¿Borrar este presupuesto del mes?')) return
    const tipoId = clave === 'global' ? null : clave
    let q = supabase.schema('produccion').from('presupuesto_diesel').delete()
      .eq('finca_id', finca.id).eq('anio', anio).eq('mes', mes)
    q = tipoId ? q.eq('tipo_id', tipoId) : q.is('tipo_id', null)
    const { error } = await q
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    setEditando(null); setNuevo(''); setAviso({ tipo: 'ok', texto: 'Presupuesto borrado.' }); await cargar()
  }

  const hayGlobal = tipos.some(t => montos[t.id] != null)
  const montoGlobal = tipos.reduce((s, t) => s + (montos[t.id] || 0), 0)
  const gastoGlobal = tipos.reduce((s, t) => s + (gastos[t.id] || 0), 0)
  const galTotal = tipos.reduce((s, t) => s + (galones[t.id] || 0), 0)

  const tarjetas = [
    ...tipos.map(t => ({ clave: t.id, nombre: t.nombre })),
    { clave: 'global', nombre: 'Global diesel', oscura: true, global: true },
  ]

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <select value={mes} onChange={e => setMes(Number(e.target.value))} style={sel}>
          {MESES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
        </select>
        <select value={anio} onChange={e => setAnio(Number(e.target.value))} style={sel}>
          {[anio - 1, anio, anio + 1].map(a => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>

      {aviso && (
        <div style={{ borderRadius: '10px', padding: '11px 13px', fontSize: '13px', marginBottom: '12px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE',
                      color: aviso.tipo === 'error' ? ROJO : VERDE }}>{aviso.texto}</div>
      )}

      {cargando ? (
        <div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Cargando...</div>
      ) : (
        <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: '12px' }}>
          {tarjetas.map(c => {
            const monto = c.global ? (hayGlobal ? montoGlobal : null) : montos[c.clave]
            const gasto = c.global ? gastoGlobal : (gastos[c.clave] || 0)
            const pct = monto ? Math.min(100, Math.round(gasto / monto * 100)) : 0
            const color = pct >= 100 ? ROJO : pct >= 85 ? AMBAR : VERDE
            const enEdit = editando === c.clave
            return (
              <div key={c.clave} style={{ background: c.oscura ? NAVY : 'white', borderRadius: '12px',
                      border: c.oscura ? 'none' : '0.5px solid ' + BORDE, padding: '16px 18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '10px' }}>
                  <span style={{ fontSize: '14px', fontWeight: 500, color: c.oscura ? 'white' : NAVY }}>{c.nombre}</span>
                  {esJefe && !enEdit && !c.global && (
                    <button onClick={() => { setEditando(c.clave); setNuevo(monto != null ? String(monto) : '') }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                               fontSize: '12px', color: AZUL }}>
                      {monto != null ? 'Cambiar' : 'Fijar'}
                    </button>
                  )}
                  {c.global && <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)' }}>B + Premium</span>}
                </div>

                {enEdit ? (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
                      <span style={{ fontSize: '16px', color: c.oscura ? 'white' : GRIS }}>$</span>
                      <input inputMode="decimal" value={nuevo} placeholder="2500" autoFocus
                        onChange={e => setNuevo(e.target.value)}
                        style={{ padding: '8px 10px', fontSize: '15px', fontFamily: 'inherit', width: '110px',
                                 border: '0.5px solid ' + BORDE, borderRadius: '8px', textAlign: 'right' }} />
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button onClick={() => guardar(c.clave)} style={{ ...boton, background: AZUL, color: 'white', borderColor: AZUL }}>Guardar</button>
                      <button onClick={() => { setEditando(null); setNuevo('') }} style={boton}>Cancelar</button>
                      {monto != null && <button onClick={() => borrar(c.clave)} style={{ ...boton, color: ROJO, borderColor: '#e8c9c9' }}>Borrar</button>}
                    </div>
                  </div>
                ) : monto == null ? (
                  <div style={{ fontSize: '13px', color: c.oscura ? 'rgba(255,255,255,0.65)' : GRIS }}>
                    {c.global ? 'Se calcula de B + Premium.' : esJefe ? 'Sin fijar. Toca “Fijar”.' : 'Aún sin presupuesto.'}
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
                      <span style={{ fontSize: '13px', color: c.oscura ? 'rgba(255,255,255,0.65)' : GRIS }}>{dinero(monto)}</span>
                      <span style={{ fontSize: '20px', fontWeight: 600, color: c.oscura ? 'white' : color }}>{pct}%</span>
                    </div>
                    <div style={{ height: '10px', background: c.oscura ? 'rgba(255,255,255,0.18)' : '#eef3f7', borderRadius: '20px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: pct + '%', background: c.oscura ? '#5DCAA5' : color, borderRadius: '20px' }} />
                    </div>
                    {esJefe ? (
                      <div style={{ fontSize: '12px', color: c.oscura ? 'rgba(255,255,255,0.75)' : GRIS, marginTop: '9px' }}>
                        Gastó {dinero(gasto)} · queda {dinero(monto - gasto)}
                      </div>
                    ) : (
                      <div style={{ fontSize: '12px', color: c.oscura ? 'rgba(255,255,255,0.75)' : GRIS, marginTop: '9px' }}>
                        {pct >= 100 ? 'Ya se pasó el presupuesto.' : `Queda ${100 - pct}% del mes.`}
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>

        {galTotal > 0 && (
          <div style={{ marginTop: '22px' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 4px' }}>En qué se va el mes</h3>
            <p style={{ fontSize: '13px', color: GRIS, margin: '0 0 11px' }}>
              Consumo de {MESES[mes - 1]} por tipo de diesel, en galones.
            </p>
            <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 52px 1fr', gap: '12px', alignItems: 'center',
                            padding: '11px 16px', borderBottom: '0.5px solid ' + BORDE, background: '#f6f9fb', fontSize: '12px', color: GRIS }}>
                <span>Diesel</span><span style={{ textAlign: 'right' }}>Galones</span><span style={{ textAlign: 'right' }}>%</span><span>Consumo</span>
              </div>
              {tipos.map(t => {
                const gl = galones[t.id] || 0
                const pc = galTotal ? Math.round(gl / galTotal * 100) : 0
                return (
                  <div key={t.id} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 52px 1fr', gap: '12px', alignItems: 'center',
                          padding: '11px 16px', borderBottom: '0.5px solid #f1f6f9', fontSize: '14px' }}>
                    <span style={{ fontWeight: 500 }}>{t.nombre}</span>
                    <span style={{ textAlign: 'right', color: GRIS, fontVariantNumeric: 'tabular-nums' }}>{miles(gl)} gal</span>
                    <span style={{ textAlign: 'right', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{pc}%</span>
                    <span style={{ display: 'block', height: '9px', background: '#eef3f7', borderRadius: '20px', overflow: 'hidden' }}>
                      <i style={{ display: 'block', height: '100%', width: pc + '%', background: '#E3B15F', borderRadius: '20px' }} />
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        </>
      )}
    </div>
  )
}

const sel = { padding: '8px 11px', fontSize: '13px', fontFamily: 'inherit',
              border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY }
const boton = { padding: '8px 13px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500,
                border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY, cursor: 'pointer' }
