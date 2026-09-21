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

export default function PresupuestoDiesel({ finca, fincas, esJefe }) {
  const hoy = hoyISO()
  const activas = (fincas || [finca]).filter(f => String(f.nombre).toUpperCase() !== 'PRUEBA')
  const [anio, setAnio] = useState(Number(hoy.slice(0, 4)))
  const [mes, setMes] = useState(Number(hoy.slice(5, 7)))
  const [tipos, setTipos] = useState([])
  const [montos, setMontos] = useState({})   // tipo_id -> monto $ efectivo (puede ser null si falta precio)
  const [pptoGal, setPptoGal] = useState({}) // tipo_id -> presupuesto en galones
  const [gastos, setGastos] = useState({})    // tipo_id (+'global') -> $ gastado
  const [galones, setGalones] = useState({})  // tipo_id -> galones consumidos del mes
  const [precios, setPrecios] = useState({})  // tipo_id -> precio actual del galón (o null)
  const [historial, setHistorial] = useState([])  // [{mes, monto, gasto}] del año
  const [cargando, setCargando] = useState(true)
  const [bulk, setBulk] = useState(null)          // { modo, valores:{tipo_id: string} }
  const [guardandoBulk, setGuardandoBulk] = useState(false)
  const [editando, setEditando] = useState(null)  // clave en edición
  const [editModo, setEditModo] = useState('gal') // 'gal' | 'usd'
  const [editGal, setEditGal] = useState('')      // galones en modo galones
  const [nuevo, setNuevo] = useState('')          // monto $ en modo dólares
  const [aviso, setAviso] = useState(null)
  const [resumen, setResumen] = useState([])      // [{finca_id, finca, zona, monto, gasto}] del grupo (jefe)
  const [zonaFiltro, setZonaFiltro] = useState('todas')

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    const { data: tp } = await supabase.schema('produccion').from('diesel_tipo')
      .select('id, nombre').eq('activo', true).order('nombre')
    const lista = tp || []
    setTipos(lista)
    // Presupuesto solo POR TIPO. El global es la suma (no se fija aparte).
    // Se puede fijar en $ (monto) o en galones. Guardamos el crudo y luego
    // calculamos el equivalente con el precio del mes.
    const { data: pp } = await supabase.schema('produccion').from('presupuesto_diesel')
      .select('tipo_id, monto, galones').eq('finca_id', finca.id).eq('anio', anio).eq('mes', mes)
      .not('tipo_id', 'is', null)
    const ppRaw = {}
    ;(pp || []).forEach(r => { ppRaw[r.tipo_id] = { monto: r.monto, galones: r.galones } })
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
    // Precio actual del galón por tipo (para fijar el presupuesto en galones).
    const pr = await Promise.all(lista.map(t =>
      supabase.schema('produccion').rpc('fn_precio_diesel', { p_tipo: t.id, p_finca: finca.id, p_fecha: hoyISO() })))
    const pm = {}
    lista.forEach((t, i) => { pm[t.id] = pr[i].data != null ? Number(pr[i].data) : null })
    setPrecios(pm)
    // Presupuesto efectivo por tipo: $ y galones. Si se fijó en galones,
    // el $ se calcula con el precio del mes (null si falta precio) y
    // viceversa. Los galones siempre se conocen cuando se fijó en galones.
    const m$ = {}, mGal = {}
    lista.forEach(t => {
      const raw = ppRaw[t.id]
      if (!raw) return
      const p = pm[t.id]
      if (raw.galones != null) {
        mGal[t.id] = Number(raw.galones)
        m$[t.id] = p != null ? Math.round(Number(raw.galones) * p * 100) / 100 : null
      } else if (raw.monto != null) {
        m$[t.id] = Number(raw.monto)
        mGal[t.id] = p != null ? Math.round(Number(raw.monto) / p * 100) / 100 : null
      }
    })
    setMontos(m$); setPptoGal(mGal)
    // Historial del año: presupuesto (global = suma de tipos) y gasto por mes.
    // Los presupuestos fijados en galones se valoran con el precio actual del
    // tipo en esta finca (pm) para poder compararlos en $.
    const { data: pAll } = await supabase.schema('produccion').from('presupuesto_diesel')
      .select('mes, tipo_id, monto, galones').eq('finca_id', finca.id).eq('anio', anio).not('tipo_id', 'is', null)
    const porMes = {}
    ;(pAll || []).forEach(r => {
      const val = r.monto != null ? Number(r.monto)
        : (r.galones != null && pm[r.tipo_id] != null ? Number(r.galones) * pm[r.tipo_id] : 0)
      porMes[r.mes] = (porMes[r.mes] || 0) + val
    })
    const mesesSet = Object.keys(porMes).map(Number).sort((a, b) => a - b)
    const gm = await Promise.all(mesesSet.map(mm =>
      supabase.schema('produccion').rpc('fn_gasto_diesel_mes', { p_finca: finca.id, p_anio: anio, p_mes: mm })))
    setHistorial(mesesSet.map((mm, i) => ({ mes: mm, monto: porMes[mm], gasto: Number(gm[i].data) || 0 })))

    // Tablero del grupo (solo jefe): presupuesto y gasto de diesel de cada
    // finca en el mes, igual que en insumos.
    if (esJefe && activas.length) {
      // Precio vigente por finca+tipo (y general) para valorar los presupuestos
      // fijados en galones.
      const { data: prG } = await supabase.schema('produccion').from('diesel_precio')
        .select('tipo_id, finca_id, precio_galon').is('vigente_hasta', null)
      const pfg = {}, pgg = {}
      ;(prG || []).forEach(r => {
        if (r.finca_id) pfg[r.finca_id + '|' + r.tipo_id] = Number(r.precio_galon)
        else pgg[r.tipo_id] = Number(r.precio_galon)
      })
      const precioFT = (fid, tid) => (pfg[fid + '|' + tid] ?? pgg[tid] ?? null)
      const { data: ppAll } = await supabase.schema('produccion').from('presupuesto_diesel')
        .select('finca_id, tipo_id, monto, galones').eq('anio', anio).eq('mes', mes).not('tipo_id', 'is', null)
      const mFinca = {}
      ;(ppAll || []).forEach(r => {
        const p = precioFT(r.finca_id, r.tipo_id)
        const val = r.monto != null ? Number(r.monto)
          : (r.galones != null && p != null ? Number(r.galones) * p : 0)
        mFinca[r.finca_id] = (mFinca[r.finca_id] || 0) + val
      })
      const gFinca = await Promise.all(activas.map(f =>
        supabase.schema('produccion').rpc('fn_gasto_diesel_mes', { p_finca: f.id, p_anio: anio, p_mes: mes })))
      setResumen(activas.map((f, i) => ({
        finca_id: f.id, finca: f.nombre, zona: f.zona,
        monto: mFinca[f.id] || 0, gasto: Number(gFinca[i].data) || 0 })))
    } else {
      setResumen([])
    }
    setCargando(false)
  }, [finca.id, anio, mes, esJefe])

  useEffect(() => { cargar() }, [cargar])

  async function guardar(clave) {
    // Se guarda tal cual: en galones (monto null, el $ sale del precio del
    // mes) o en dólares (galones null). No se convierte al guardar, así el
    // presupuesto en galones se puede fijar aunque hoy no haya precio.
    let campos
    if (editModo === 'gal') {
      const g = numDec(editGal)
      if (!(g >= 0)) { setAviso({ tipo: 'error', texto: 'Galones no válidos.' }); return }
      campos = { galones: g, monto: null }
    } else {
      const v = numDec(nuevo)
      if (!(v >= 0)) { setAviso({ tipo: 'error', texto: 'Monto no válido.' }); return }
      campos = { monto: v, galones: null }
    }
    const tipoId = clave === 'global' ? null : clave
    let q = supabase.schema('produccion').from('presupuesto_diesel').select('id')
      .eq('finca_id', finca.id).eq('anio', anio).eq('mes', mes)
    q = tipoId ? q.eq('tipo_id', tipoId) : q.is('tipo_id', null)
    const { data: ex } = await q.maybeSingle()
    const fila = { finca_id: finca.id, tipo_id: tipoId, anio, mes, ...campos, actualizado_en: new Date().toISOString() }
    const { error } = ex
      ? await supabase.schema('produccion').from('presupuesto_diesel').update(fila).eq('id', ex.id)
      : await supabase.schema('produccion').from('presupuesto_diesel').insert(fila)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + error.message }); return }
    setEditando(null); setNuevo(''); setEditGal(''); setAviso({ tipo: 'ok', texto: 'Presupuesto guardado.' }); await cargar()
  }

  // Upsert de un presupuesto (finca + tipo + mes). campos = {monto} o {galones}.
  async function upsertUno(fincaId, tipoId, campos, m) {
    let q = supabase.schema('produccion').from('presupuesto_diesel').select('id')
      .eq('finca_id', fincaId).eq('anio', anio).eq('mes', m).eq('tipo_id', tipoId)
    const { data: ex } = await q.maybeSingle()
    const fila = { finca_id: fincaId, tipo_id: tipoId, anio, mes: m, monto: null, galones: null, ...campos, actualizado_en: new Date().toISOString() }
    return ex
      ? supabase.schema('produccion').from('presupuesto_diesel').update(fila).eq('id', ex.id)
      : supabase.schema('produccion').from('presupuesto_diesel').insert(fila)
  }

  // Fijar el presupuesto para varias fincas y varios meses de una vez.
  async function guardarBulk() {
    if (guardandoBulk) return
    const fincasSel = bulk.fincas || []
    const mesesSel = (bulk.meses && bulk.meses.length) ? bulk.meses : [mes]
    if (!fincasSel.length) { setAviso({ tipo: 'error', texto: 'Elige al menos una finca.' }); return }
    if (!tipos.some(t => numDec(bulk.valores[t.id] || '') > 0)) { setAviso({ tipo: 'error', texto: 'Pon al menos un valor.' }); return }
    setGuardandoBulk(true)
    // En galones se guarda el número de galones tal cual (el $ sale del
    // precio de cada mes); en dólares se guarda el monto. Ya no se salta
    // ninguna finca por falta de precio.
    for (const fid of fincasSel) {
      for (const m of mesesSel) {
        for (const t of tipos) {
          const raw = numDec(bulk.valores[t.id] || '')
          if (!(raw > 0)) continue
          const campos = bulk.modo === 'gal' ? { galones: raw } : { monto: raw }
          const { error } = await upsertUno(fid, t.id, campos, m)
          if (error) { setGuardandoBulk(false); setAviso({ tipo: 'error', texto: 'No se pudo aplicar. ' + error.message }); return }
        }
      }
    }
    setGuardandoBulk(false); setBulk(null)
    setAviso({ tipo: 'ok', texto: `Aplicado a ${fincasSel.length} finca(s) × ${mesesSel.length} mes(es).` })
    await cargar()
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

  const hayGlobal = tipos.some(t => montos[t.id] != null || pptoGal[t.id] != null)
  const montoGlobal = tipos.reduce((s, t) => s + (montos[t.id] || 0), 0)
  const gastoGlobal = tipos.reduce((s, t) => s + (gastos[t.id] || 0), 0)
  const galTotal = tipos.reduce((s, t) => s + (galones[t.id] || 0), 0)
  const pptoGalGlobal = tipos.reduce((s, t) => s + (pptoGal[t.id] || 0), 0)

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
        {esJefe && !bulk && (
          <button onClick={() => setBulk({ modo: 'gal', valores: {}, fincas: activas.map(f => f.id), meses: [mes] })}
            style={{ ...boton, background: NAVY, color: 'white', borderColor: NAVY, marginLeft: 'auto' }}>
            Fijar fincas y meses
          </button>
        )}
      </div>

      {bulk && (
        <div style={{ background: '#f6f9fb', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '14px 16px', marginBottom: '14px' }}>
          <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '10px' }}>Fijar presupuesto de diesel · varias fincas y meses</div>
          <div style={{ display: 'inline-flex', background: '#eef3f7', borderRadius: '8px', padding: '3px', gap: '3px', marginBottom: '12px' }}>
            {[['gal', 'En galones'], ['usd', 'En dólares']].map(([id, txt]) => (
              <button key={id} onClick={() => setBulk(b => ({ ...b, modo: id }))} style={{ border: 0, cursor: 'pointer', fontFamily: 'inherit',
                fontSize: '12px', padding: '5px 12px', borderRadius: '6px',
                background: bulk.modo === id ? 'white' : 'transparent', color: bulk.modo === id ? AZUL : GRIS,
                fontWeight: bulk.modo === id ? 500 : 400 }}>{txt}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '12px' }}>
            {tipos.map(t => (
              <div key={t.id}>
                <div style={{ fontSize: '11px', color: GRIS, marginBottom: '5px' }}>{t.nombre} · {bulk.modo === 'gal' ? 'galones' : '$'}</div>
                <input inputMode="decimal" value={bulk.valores[t.id] || ''} placeholder={bulk.modo === 'gal' ? '450' : '2500'}
                  onChange={e => setBulk(b => ({ ...b, valores: { ...b.valores, [t.id]: e.target.value } }))}
                  style={{ ...sel, width: '120px', textAlign: 'right' }} />
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' }}>
            <span style={{ fontSize: '11px', color: GRIS }}>Fincas</span>
            <button onClick={() => setBulk(b => ({ ...b, fincas: activas.map(f => f.id) }))} style={miniLink}>Todas</button>
            <button onClick={() => setBulk(b => ({ ...b, fincas: [] }))} style={miniLink}>Ninguna</button>
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '12px' }}>
            {activas.map(f => {
              const on = (bulk.fincas || []).includes(f.id)
              return (
                <button key={f.id} onClick={() => setBulk(b => ({ ...b, fincas: on ? b.fincas.filter(x => x !== f.id) : [...b.fincas, f.id] }))}
                  style={{ ...chipBulk, ...(on ? chipOn : {}) }}>{String(f.nombre).toUpperCase()}</button>
              )
            })}
          </div>

          <div style={{ fontSize: '11px', color: GRIS, marginBottom: '6px' }}>Meses de {anio}</div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '12px' }}>
            {MESES.map((m, i) => {
              const on = (bulk.meses || []).includes(i + 1)
              return (
                <button key={i} onClick={() => setBulk(b => ({ ...b, meses: on ? b.meses.filter(x => x !== i + 1) : [...b.meses, i + 1] }))}
                  style={{ ...chipBulk, ...(on ? chipOn : {}) }}>{m.slice(0, 3)}</button>
              )
            })}
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={guardarBulk} disabled={guardandoBulk}
              style={{ ...boton, background: AZUL, color: 'white', borderColor: AZUL, opacity: guardandoBulk ? 0.6 : 1 }}>
              {guardandoBulk ? 'Aplicando...' : `Aplicar a ${(bulk.fincas || []).length} finca(s) × ${(bulk.meses || []).length} mes(es)`}
            </button>
            <button onClick={() => setBulk(null)} style={boton}>Cancelar</button>
          </div>
          <div style={{ fontSize: '11px', color: GRIS, marginTop: '9px' }}>
            {bulk.modo === 'gal'
              ? 'Se guardan los galones tal cual. El monto en $ de cada mes se calcula con el precio del galón vigente de ese mes.'
              : 'El mismo monto en $ para cada finca y mes elegido.'}
          </div>
        </div>
      )}

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
            // Presupuesto en $ (puede faltar si se fijó en galones sin precio)
            // y en galones (puede faltar si se fijó en $ sin precio).
            const monto = c.global ? montoGlobal : (montos[c.clave] ?? null)
            const gBudget = c.global ? pptoGalGlobal : (pptoGal[c.clave] ?? null)
            const gasto = c.global ? gastoGlobal : (gastos[c.clave] || 0)
            const galGasto = c.global ? galTotal : (galones[c.clave] || 0)
            const hayPpto = c.global ? hayGlobal : (monto != null || gBudget != null)
            // % preferimos por galones (siempre se conocen); si no, por $.
            const pctRaw = gBudget ? galGasto / gBudget : (monto ? gasto / monto : 0)
            const pct = Math.min(100, Math.round(pctRaw * 100))
            const color = pct >= 100 ? ROJO : pct >= 85 ? AMBAR : VERDE
            const enEdit = editando === c.clave
            return (
              <div key={c.clave} style={{ background: c.oscura ? NAVY : 'white', borderRadius: '12px',
                      border: c.oscura ? 'none' : '0.5px solid ' + BORDE, padding: '16px 18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '10px' }}>
                  <span style={{ fontSize: '14px', fontWeight: 500, color: c.oscura ? 'white' : NAVY }}>{c.nombre}</span>
                  {esJefe && !enEdit && !c.global && (
                    <button onClick={() => {
                      const pr = precios[c.clave]
                      const gb = pptoGal[c.clave]
                      setEditando(c.clave)
                      // Por defecto en galones (así lo maneja Mel); en $ solo si
                      // se había fijado en $ y no hay galones que mostrar.
                      setEditModo(gb != null ? 'gal' : (monto != null ? 'usd' : 'gal'))
                      setEditGal(gb != null ? String(gb)
                        : (pr != null && monto != null ? String(Math.round(monto / pr * 100) / 100) : ''))
                      setNuevo(monto != null ? String(monto) : '')
                    }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                               fontSize: '12px', color: AZUL }}>
                      {hayPpto ? 'Cambiar' : 'Fijar'}
                    </button>
                  )}
                  {c.global && <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)' }}>B + Premium</span>}
                </div>

                {enEdit ? (
                  <div>
                    <div style={{ display: 'inline-flex', background: '#eef3f7', borderRadius: '8px', padding: '3px', gap: '3px', marginBottom: '10px' }}>
                      {[['gal', 'En galones'], ['usd', 'En dólares']].map(([id, txt]) => (
                        <button key={id} onClick={() => setEditModo(id)} style={{ border: 0, cursor: 'pointer', fontFamily: 'inherit',
                          fontSize: '12px', padding: '5px 12px', borderRadius: '6px',
                          background: editModo === id ? 'white' : 'transparent', color: editModo === id ? AZUL : GRIS,
                          fontWeight: editModo === id ? 500 : 400 }}>{txt}</button>
                      ))}
                    </div>

                    {editModo === 'gal' ? (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                          <input inputMode="decimal" value={editGal} placeholder="450" autoFocus
                            onChange={e => setEditGal(e.target.value)}
                            style={{ padding: '8px 10px', fontSize: '15px', fontFamily: 'inherit', width: '110px',
                                     border: '0.5px solid ' + BORDE, borderRadius: '8px', textAlign: 'right' }} />
                          {precios[c.clave] != null
                            ? <span style={{ fontSize: '13px', color: GRIS }}>gal → <b style={{ color: NAVY }}>{dinero((numDec(editGal) || 0) * precios[c.clave])}</b></span>
                            : <span style={{ fontSize: '13px', color: GRIS }}>galones</span>}
                        </div>
                        {precios[c.clave] != null ? (
                          <div style={{ fontSize: '11px', color: GRIS, marginBottom: '10px' }}>
                            Precio actual: ${Number(precios[c.clave]).toLocaleString('es-EC', { minimumFractionDigits: 6, maximumFractionDigits: 6 })} / gal
                          </div>
                        ) : (
                          <div style={{ fontSize: '11px', color: '#854F0B', background: '#FAEEDA', borderRadius: '9px', padding: '8px 10px', marginBottom: '10px' }}>
                            Aún no hay precio del galón. Se guarda en galones; el $ aparecerá cuando registres el precio en <b>Catálogo → Diesel</b>.
                          </div>
                        )}
                      </>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
                        <span style={{ fontSize: '16px', color: GRIS }}>$</span>
                        <input inputMode="decimal" value={nuevo} placeholder="2500" autoFocus
                          onChange={e => setNuevo(e.target.value)}
                          style={{ padding: '8px 10px', fontSize: '15px', fontFamily: 'inherit', width: '110px',
                                   border: '0.5px solid ' + BORDE, borderRadius: '8px', textAlign: 'right' }} />
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button onClick={() => guardar(c.clave)} style={{ ...boton, background: AZUL, color: 'white', borderColor: AZUL }}>Guardar</button>
                      <button onClick={() => { setEditando(null); setNuevo(''); setEditGal('') }} style={boton}>Cancelar</button>
                      {hayPpto && !c.global && <button onClick={() => borrar(c.clave)} style={{ ...boton, color: ROJO, borderColor: '#e8c9c9' }}>Borrar</button>}
                    </div>
                  </div>
                ) : !hayPpto ? (
                  <div style={{ fontSize: '13px', color: c.oscura ? 'rgba(255,255,255,0.65)' : GRIS }}>
                    {c.global ? 'Se calcula de B + Premium.' : esJefe ? 'Sin fijar. Toca “Fijar”.' : 'Aún sin presupuesto.'}
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
                      <div style={{ lineHeight: 1.3 }}>
                        <span style={{ fontSize: '13px', color: c.oscura ? 'white' : NAVY, fontWeight: 500 }}>
                          {gBudget != null ? `${miles(gBudget)} gal` : dinero(monto)}
                        </span>
                        {esJefe && gBudget != null && (
                          <div style={{ fontSize: '12px', color: c.oscura ? 'rgba(255,255,255,0.65)' : GRIS }}>
                            {monto != null ? dinero(monto) : '$ — falta precio'}
                          </div>
                        )}
                      </div>
                      <span style={{ fontSize: '20px', fontWeight: 600, color: c.oscura ? 'white' : color }}>{pct}%</span>
                    </div>
                    <div style={{ height: '10px', background: c.oscura ? 'rgba(255,255,255,0.18)' : '#eef3f7', borderRadius: '20px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: pct + '%', background: c.oscura ? '#5DCAA5' : color, borderRadius: '20px' }} />
                    </div>
                    {esJefe ? (
                      <div style={{ fontSize: '12px', color: c.oscura ? 'rgba(255,255,255,0.75)' : GRIS, marginTop: '9px' }}>
                        Gastó {miles(galGasto)} gal{monto != null ? ` · ${dinero(gasto)}` : ''}
                        {gBudget != null ? ` · queda ${miles(Math.max(gBudget - galGasto, 0))} gal` : ''}
                      </div>
                    ) : (
                      <div style={{ fontSize: '12px', color: c.oscura ? 'rgba(255,255,255,0.75)' : GRIS, marginTop: '9px' }}>
                        {gBudget != null
                          ? `Gastó ${miles(galGasto)} gal · queda ${miles(Math.max(gBudget - galGasto, 0))} gal`
                          : (pct >= 100 ? 'Ya se pasó el presupuesto.' : `Queda ${100 - pct}% del mes.`)}
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

        {/* Tablero de diesel del mes de todas las fincas: solo el jefe. */}
        {esJefe && resumen.length > 0 && (() => {
          const vis = resumen
            .filter(r => zonaFiltro === 'todas' || r.zona === zonaFiltro)
            .map(r => ({ ...r, pctReal: r.monto ? Math.round(Number(r.gasto) / Number(r.monto) * 100) : null }))
            .map(r => ({ ...r, pct: r.pctReal === null ? null : Math.min(100, r.pctReal) }))
            .sort((a, b) => (b.pctReal ?? -1) - (a.pctReal ?? -1))
          const tMonto = vis.reduce((t, r) => t + Number(r.monto || 0), 0)
          const tGasto = vis.reduce((t, r) => t + Number(r.gasto || 0), 0)
          const tPct = tMonto ? Math.min(100, Math.round(tGasto / tMonto * 100)) : 0
          const enRojo = vis.filter(r => r.pctReal !== null && r.pctReal >= 100).length
          const LEN = Math.PI * 60
          const colDe = p => p === null ? GRIS : p >= 100 ? ROJO : p >= 85 ? AMBAR : VERDE
          return (
          <div style={{ marginTop: '22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: 500, margin: 0 }}>Todas las fincas en {MESES[mes - 1]}</h3>
              <div style={{ display: 'flex', gap: '6px', marginLeft: 'auto' }}>
                {[['todas', 'Todas'], ['jambeli', 'Jambelí'], ['puna', 'Puná']].map(([z, t]) => (
                  <button key={z} onClick={() => setZonaFiltro(z)} style={{
                    padding: '6px 12px', borderRadius: '20px', fontFamily: 'inherit', fontSize: '12px',
                    cursor: 'pointer', border: '0.5px solid ' + (zonaFiltro === z ? '#9cc4e8' : BORDE),
                    background: zonaFiltro === z ? '#E6F1FB' : 'white',
                    color: zonaFiltro === z ? AZUL : NAVY, fontWeight: zonaFiltro === z ? 500 : 400 }}>{t}</button>
                ))}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: '11px', marginBottom: '14px' }}>
              <TarjetaPpto oscura k="Presupuesto del grupo" v={dinero(tMonto)} />
              <TarjetaPpto k="Gastado" v={dinero(tGasto)} />
              <TarjetaPpto k="Queda" v={dinero(tMonto - tGasto)} />
              <TarjetaPpto k="Fincas en rojo" v={String(enRojo)} rojo={enRojo > 0} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '210px 1fr', gap: '14px', alignItems: 'stretch' }}>
              <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '16px',
                            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="150" height="92" viewBox="0 0 150 92">
                  <path d="M15 85 A60 60 0 0 1 135 85" fill="none" stroke="#eef3f7" strokeWidth="14" strokeLinecap="round" />
                  <path d="M15 85 A60 60 0 0 1 135 85" fill="none" stroke={colDe(tPct)} strokeWidth="14" strokeLinecap="round"
                        strokeDasharray={`${LEN * tPct / 100} ${LEN}`} />
                </svg>
                <div style={{ fontSize: '26px', fontWeight: 500, marginTop: '-6px' }}>{tPct}%</div>
                <div style={{ fontSize: '12px', color: GRIS }}>del grupo</div>
              </div>
              <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '14px 18px' }}>
                <div style={{ fontSize: '13px', color: GRIS, marginBottom: '12px' }}>Cómo va cada finca en diesel</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {vis.map(r => (
                    <div key={r.finca_id} style={{ display: 'grid', gridTemplateColumns: '150px 1fr 46px', gap: '10px', alignItems: 'center', fontSize: '13px' }}>
                      <span>
                        {r.finca}
                        <div style={{ fontSize: '11px', color: GRIS, marginTop: '1px', fontVariantNumeric: 'tabular-nums' }}>
                          {Number(r.monto) ? `Ppto ${dinero(r.monto)} · gastó ${dinero(r.gasto)}` : 'Sin presupuesto'}
                        </div>
                      </span>
                      <span style={{ height: '9px', background: '#eef3f7', borderRadius: '20px', overflow: 'hidden' }}>
                        {r.pct !== null && <i style={{ display: 'block', height: '100%', width: r.pct + '%', background: colDe(r.pctReal), borderRadius: '20px' }} />}
                      </span>
                      <span style={{ textAlign: 'right', fontWeight: 500, color: colDe(r.pctReal), fontVariantNumeric: 'tabular-nums' }}>
                        {r.pctReal === null ? '—' : r.pctReal + '%'}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          )
        })()}

        {historial.length > 0 && (
          <div style={{ marginTop: '22px' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 11px' }}>Historial de {anio}</h3>
            <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 60px', gap: '10px', padding: '10px 16px',
                            background: '#f6f9fb', borderBottom: '0.5px solid ' + BORDE, fontSize: '12px', color: GRIS }}>
                <span>Mes</span><span style={{ textAlign: 'right' }}>Presupuesto</span><span style={{ textAlign: 'right' }}>Gastado</span><span style={{ textAlign: 'right' }}>%</span>
              </div>
              {historial.map(h => {
                const p = h.monto ? Math.min(100, Math.round(h.gasto / h.monto * 100)) : 0
                const col = p >= 100 ? ROJO : p >= 85 ? AMBAR : VERDE
                return (
                  <div key={h.mes} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 60px', gap: '10px',
                          padding: '11px 16px', borderBottom: '0.5px solid #f1f6f9', fontSize: '14px', alignItems: 'center' }}>
                    <span style={{ fontWeight: 500 }}>{MESES[h.mes - 1]}</span>
                    <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dinero(h.monto)}</span>
                    <span style={{ textAlign: 'right', color: GRIS, fontVariantNumeric: 'tabular-nums' }}>{dinero(h.gasto)}</span>
                    <span style={{ textAlign: 'right', fontWeight: 500, color: col, fontVariantNumeric: 'tabular-nums' }}>{p}%</span>
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

function TarjetaPpto({ k, v, oscura, rojo }) {
  return (
    <div style={{ background: oscura ? NAVY : '#f6f9fb', borderRadius: '12px', padding: '14px 16px' }}>
      <div style={{ fontSize: '12px', color: oscura ? 'rgba(255,255,255,0.65)' : GRIS }}>{k}</div>
      <div style={{ fontSize: '22px', fontWeight: 500, color: oscura ? 'white' : rojo ? ROJO : NAVY }}>{v}</div>
    </div>
  )
}

const sel = { padding: '8px 11px', fontSize: '13px', fontFamily: 'inherit',
              border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY }
const boton = { padding: '8px 13px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500,
                border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY, cursor: 'pointer' }
const chipBulk = { padding: '6px 12px', borderRadius: '20px', fontFamily: 'inherit', fontSize: '12px',
                   cursor: 'pointer', border: '0.5px solid ' + BORDE, background: 'white', color: GRIS }
const chipOn = { border: '2px solid ' + AZUL, background: '#E6F1FB', color: AZUL, fontWeight: 500 }
const miniLink = { border: 'none', background: 'none', color: AZUL, fontFamily: 'inherit', fontSize: '12px', cursor: 'pointer', padding: 0 }
