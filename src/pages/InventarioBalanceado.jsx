import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, num, miles, dinero } from '../lib/fechas'
import PreciosBalanceado from './PreciosBalanceado'

// Inventario de balanceado · igual que el de insumos, pero en sacos.
//
// El balanceado se compra en sacos y se aplica en libras. El saldo se
// lleva en sacos: baja con lo aplicado en las piscinas (libras/55) y
// sube con los ingresos. Valorado por lotes (FIFO). Los dolares son
// solo para el jefe.

const NAVY = '#022847', AZUL = '#0D6CB0', BORDE = '#dce6ef', GRIS = '#7d8fa0'
const PLAZO_LBL = { 0: 'Contado', 30: '30 días', 60: '60 días', 90: '90 días', 120: '120 días' }
const ROJO = '#8A2F2E', VERDE = '#0F6E56', AMBAR = '#BA7517'
const primeroDelMes = iso => iso.slice(0, 8) + '01'
const G_CONTEO = '1fr 90px 120px 130px 130px'
const G_SALDO_J = '1fr 150px 130px 140px 110px'
const G_SALDO_B = '1fr 140px'
const G_MOV_J = '1.3fr repeat(7, 1fr)'
const G_MOV_B = '1.3fr repeat(6, 1fr)'
const G_DOS = '150px 1fr'

export default function InventarioBalanceado({ finca, esJefe, esJefeGlobal, abrirIngresos, abrirPrecios, onCorreccion }) {
  const [seccion, setSeccion] = useState('bodega')  // 'bodega' | 'ingresos' | 'precios'
  useEffect(() => { if (abrirIngresos) setSeccion('ingresos') }, [abrirIngresos])
  const [vista, setVista] = useState('saldo')       // 'saldo' | 'movimientos'
  const [alDia, setAlDia] = useState(hoyISO())
  const [desde, setDesde] = useState(primeroDelMes(hoyISO()))
  const [hasta, setHasta] = useState(hoyISO())

  const [saldos, setSaldos] = useState([])
  const [valorFifo, setValorFifo] = useState({})
  const [desglose, setDesglose] = useState({})
  const [abierto, setAbierto] = useState(null)
  const [movs, setMovs] = useState([])
  const [precios, setPrecios] = useState({})
  const [tomas, setTomas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)

  const [contando, setContando] = useState(false)
  const [editToma, setEditToma] = useState(null)
  const [fecha, setFecha] = useState(hoyISO())
  const [obs, setObs] = useState('')
  const [contado, setContado] = useState({})
  const [guardando, setGuardando] = useState(false)
  const [nuevos, setNuevos] = useState([])
  const [guardandoNuevos, setGuardandoNuevos] = useState(false)

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    try {
      const [{ data: s, error: e }, { data: vf }, { data: m }, { data: p }, { data: t }, { data: dpz }] = await Promise.all([
        supabase.schema('produccion').rpc('fn_saldo_balanceado', { p_finca: finca.id, p_hasta: alDia }),
        supabase.schema('produccion').rpc('fn_valor_bodega_bal_fifo', { p_finca: finca.id, p_hasta: alDia }),
        supabase.schema('produccion').rpc('fn_movimiento_balanceado', { p_finca: finca.id, p_desde: desde, p_hasta: hasta }),
        supabase.schema('produccion').from('precio_producto')
          .select('producto_id, precio_saco').eq('finca_id', finca.id).is('vigente_hasta', null),
        supabase.schema('produccion').from('toma_balanceado')
          .select('id, fecha, observacion').eq('finca_id', finca.id).order('fecha', { ascending: false }).limit(12),
        supabase.schema('produccion').rpc('fn_saldo_balanceado_plazo', { p_finca: finca.id, p_hasta: alDia }),
      ])
      if (e) throw e
      const pr = {}; (p || []).forEach(x => { pr[x.producto_id] = Number(x.precio_saco) })
      const vfm = {}; (vf || []).forEach(x => { vfm[x.producto_id] = Number(x.valor) })
      const dgm = {}; (dpz || []).forEach(x => { (dgm[x.producto_id] = dgm[x.producto_id] || []).push({ plazo: Number(x.plazo), cantidad: Number(x.cantidad), valor: Number(x.valor) }) })
      setSaldos(s || []); setValorFifo(vfm); setMovs(m || []); setPrecios(pr); setTomas(t || []); setDesglose(dgm)
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally { setCargando(false) }
  }, [finca.id, alDia, desde, hasta])

  useEffect(() => { cargar() }, [cargar])

  const primeraVez = tomas.length === 0
  const valorBodega = useMemo(() => Object.values(valorFifo).reduce((t, v) => t + (Number(v) || 0), 0), [valorFifo])
  const filas = useMemo(() => saldos.map(s => {
    const txt = contado[s.producto_id]; const hay = txt !== undefined && txt !== ''
    const c = hay ? Number(txt) : null
    return { ...s, precio: precios[s.producto_id] || 0, contado: c,
             diferencia: hay ? c - Number(s.saldo) : null }
  }), [saldos, precios, contado])
  const llenadas = filas.filter(f => f.contado !== null).length
  const negativos = saldos.filter(s => Number(s.saldo) < -0.001).length

  const filaNueva = () => ({ nombre: '', marca: '' })
  const setNuevo = (i, campo, val) => setNuevos(ns => ns.map((n, j) => j === i ? { ...n, [campo]: val } : n))

  async function guardarNuevos() {
    const validos = nuevos.filter(n => n.nombre.trim())
    if (!validos.length) { setNuevos([]); return }
    const rows = validos.map(n => ({ nombre: n.nombre.trim(), marca: n.marca.trim() || null }))
    setGuardandoNuevos(true)
    if (esJefeGlobal) {
      const { error } = await supabase.schema('produccion').from('producto').insert(rows)
      setGuardandoNuevos(false)
      if (error) {
        const dup = /duplicate|unique/i.test(error.message)
        setAviso({ tipo: 'error', texto: dup ? 'Alguno ya existe con ese nombre.' : 'No se pudo agregar. ' + error.message })
        return
      }
      setAviso({ tipo: 'ok', texto: `${rows.length} ${rows.length === 1 ? 'balanceado agregado' : 'balanceados agregados'}.` })
    } else {
      const { data: au } = await supabase.auth.getUser()
      const solis = rows.map(r => ({
        finca_id: finca.id, tabla: 'nuevo_producto', registro_id: crypto.randomUUID(),
        valor_propuesto: r, motivo: 'Balanceado que falta en la lista', solicitado_por: au?.user?.id }))
      const { error } = await supabase.schema('produccion').from('solicitud_correccion').insert(solis)
      setGuardandoNuevos(false)
      if (error) { setAviso({ tipo: 'error', texto: 'No se pudo enviar. ' + error.message }); return }
      setAviso({ tipo: 'ok', texto: 'Pedido enviado al jefe. Lo agregará al catálogo.' })
    }
    setNuevos([])
    await cargar()
  }

  async function editarToma(t) {
    const { data } = await supabase.schema('produccion').from('toma_balanceado_linea')
      .select('producto_id, cantidad_contada').eq('toma_id', t.id)
    const mapa = {}; (data || []).forEach(l => { mapa[l.producto_id] = String(l.cantidad_contada) })
    setContado(mapa); setFecha(t.fecha); setObs(t.observacion || '')
    setEditToma(t); setContando(true); setAviso(null)
  }

  async function guardarToma() {
    if (!llenadas) { setAviso({ tipo: 'error', texto: 'No has contado ningún producto.' }); return }
    const desc = filas.filter(f => f.diferencia !== null && Math.abs(f.diferencia) > 0.001)
    const txt = editToma
      ? `Vas a guardar los cambios del conteo del ${corta(editToma.fecha)}. ¿Guardar?`
      : primeraVez
      ? `Vas a cargar el inventario inicial de balanceado con ${llenadas} productos.\n¿Guardar?`
      : desc.length ? `${desc.length} productos no cuadran. Las diferencias quedan registradas. ¿Guardar?`
                    : 'Todo cuadra. ¿Guardar el conteo?'
    if (!window.confirm(txt)) return
    setGuardando(true)
    try {
      let tomaId
      if (editToma) {
        const { error: eU } = await supabase.schema('produccion').from('toma_balanceado')
          .update({ fecha, observacion: obs || null }).eq('id', editToma.id)
        if (eU) throw eU
        await supabase.schema('produccion').from('toma_balanceado_linea').delete().eq('toma_id', editToma.id)
        tomaId = editToma.id
      } else {
        const { data: toma, error } = await supabase.schema('produccion').from('toma_balanceado')
          .insert({ finca_id: finca.id, fecha, observacion: obs || null }).select('id').single()
        if (error) throw error
        tomaId = toma.id
      }
      const lineas = filas.filter(f => f.contado !== null).map(f => ({
        toma_id: tomaId, producto_id: f.producto_id, cantidad_contada: f.contado,
        cantidad_sistema: Number(f.saldo), diferencia: f.diferencia,
      }))
      const { error: e2 } = await supabase.schema('produccion').from('toma_balanceado_linea').insert(lineas)
      if (e2) throw e2
      setAviso({ tipo: 'ok', texto: editToma ? 'Conteo actualizado.' : primeraVez ? 'Inventario inicial cargado.' : `Conteo guardado. ${lineas.length} productos.` })
      setContando(false); setEditToma(null); setContado({}); setObs(''); await cargar()
    } catch (err) { setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + (err.message || '') }) }
    finally { setGuardando(false) }
  }

  async function borrarToma(t) {
    if (!window.confirm(`¿Borrar el conteo del ${corta(t.fecha)}?\n\nEl saldo vuelve a calcularse desde el conteo anterior (o desde cero). No se puede deshacer.`)) return
    const { error } = await supabase.schema('produccion').from('toma_balanceado').delete().eq('id', t.id)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo borrar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Conteo borrado.' }); await cargar()
  }

  async function corregir(f) {
    const escrito = window.prompt(`${f.producto}\n\nEl sistema dice ${limpio(f.saldo)} sacos.\n¿Cuánto debe decir?`, limpio(f.saldo))
    if (escrito === null) return
    const nuevo = Number(String(escrito).replace(',', '.'))
    if (!isFinite(nuevo)) { setAviso({ tipo: 'error', texto: 'No es un número.' }); return }
    const delta = nuevo - Number(f.saldo)
    if (Math.abs(delta) < 0.001) return
    const motivo = window.prompt('¿Por qué? Queda en la bitácora.')
    if (!motivo || !motivo.trim()) { setAviso({ tipo: 'error', texto: 'Falta el motivo.' }); return }
    const { error } = await supabase.schema('produccion').from('ajuste_balanceado')
      .insert({ finca_id: finca.id, fecha: alDia, producto_id: f.producto_id, cantidad: delta, motivo: motivo.trim() })
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    setAviso({ tipo: 'ok', texto: `${f.producto} corregido.` }); await cargar()
  }

  return (
    <div style={{ padding: '1.4rem 1.5rem', maxWidth: '1180px' }}>
      <div style={{ display: 'flex', gap: '9px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <Chip on={seccion === 'bodega'} onClick={() => setSeccion('bodega')}>Bodega</Chip>
        <Chip on={seccion === 'ingresos'} onClick={() => { setSeccion('ingresos'); setContando(false) }}>Ingresos</Chip>
        {seccion === 'bodega' && !contando && !cargando && (
          <button onClick={() => setContando(true)} style={{ ...btn, marginLeft: 'auto',
            background: AZUL, color: 'white', borderColor: AZUL }}>
            {primeraVez ? 'Cargar inventario inicial' : 'Contar la bodega'}
          </button>
        )}
      </div>

      {aviso && (
        <div style={{ borderRadius: '10px', padding: '11px 13px', fontSize: '13px', marginBottom: '12px',
          background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE',
          color: aviso.tipo === 'error' ? ROJO : VERDE }}>{aviso.texto}</div>
      )}

      {seccion === 'ingresos' ? (
        <IngresosBalanceado finca={finca} esJefe={esJefe} onCambio={cargar} onCorreccion={onCorreccion} />
      ) : contando ? (
        <Caja>
          {editToma && (
            <div style={{ padding: '11px 16px', background: '#E6F1FB', color: AZUL, fontSize: '13px', borderBottom: '0.5px solid ' + BORDE }}>
              Editando el conteo del {corta(editToma.fecha)}. Cambia las cantidades y guarda.
            </div>
          )}
          <div style={{ padding: '15px 16px', borderBottom: '0.5px solid ' + BORDE, display: 'flex',
                        gap: '16px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Campo label="Fecha del conteo">
              <input type="date" value={fecha} max={hoyISO()} onChange={e => setFecha(e.target.value)} style={inp} />
            </Campo>
            <div style={{ flex: 1, minWidth: '220px' }}>
              <Campo label="Observación">
                <input value={obs} placeholder="Quién contó" onChange={e => setObs(e.target.value)} style={{ ...inp, width: '100%' }} />
              </Campo>
            </div>
          </div>

          {/* Agregar balanceados que faltan, varios a la vez. */}
          <div style={{ padding: '12px 16px', borderBottom: '0.5px solid ' + BORDE, background: '#fbfdfe' }}>
            {nuevos.length === 0 ? (
              <button onClick={() => setNuevos([filaNueva()])} style={btnLink}>
                + ¿Falta un balanceado? {esJefeGlobal ? 'Agrégalo aquí' : 'Pídelo al jefe'}
              </button>
            ) : (
              <div>
                <div style={{ fontSize: '12px', color: GRIS, marginBottom: '8px' }}>
                  Balanceados nuevos (puedes agregar varios):
                </div>
                {nuevos.map((n, i) => (
                  <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '7px', flexWrap: 'wrap' }}>
                    <input autoFocus={i === nuevos.length - 1} value={n.nombre} placeholder="Nombre del balanceado"
                      onChange={e => setNuevo(i, 'nombre', e.target.value)} style={{ ...inp, flex: 1, minWidth: '200px' }} />
                    <input value={n.marca} placeholder="Marca (opcional)"
                      onChange={e => setNuevo(i, 'marca', e.target.value)} style={{ ...inp, width: '160px' }} />
                    <button onClick={() => setNuevos(ns => ns.filter((_, j) => j !== i))} title="Quitar"
                      style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#c3d0db', fontSize: '18px', lineHeight: 1 }}>×</button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' }}>
                  <button onClick={() => setNuevos(ns => [...ns, filaNueva()])} style={btnLink}>+ Otro balanceado</button>
                  <span style={{ marginLeft: 'auto' }} />
                  <button onClick={() => setNuevos([])} style={btn}>Cancelar</button>
                  <button onClick={guardarNuevos} disabled={guardandoNuevos || !nuevos.some(n => n.nombre.trim())}
                    style={{ ...btn, background: AZUL, color: 'white', borderColor: AZUL,
                             opacity: (guardandoNuevos || !nuevos.some(n => n.nombre.trim())) ? 0.5 : 1 }}>
                    {guardandoNuevos ? (esJefeGlobal ? 'Agregando...' : 'Enviando...') : (esJefeGlobal ? 'Agregar a la lista' : 'Enviar pedido al jefe')}
                  </button>
                </div>
              </div>
            )}
          </div>

          <Encabezado gtc={G_CONTEO} cols={['Balanceado', 'Unidad', (primeraVez || editToma) ? '' : 'El sistema dice', editToma ? 'Contado' : primeraVez ? 'Inventario inicial' : 'Contado', (primeraVez || editToma) ? '' : 'Diferencia']} />
          {filas.map(f => (
            <Fila gtc={G_CONTEO} key={f.producto_id}>
              <Cel>{f.producto}</Cel><Cel gris>Sacos</Cel>
              <Cel der gris>{(primeraVez || editToma) ? '' : limpio(f.saldo)}</Cel>
              <div style={{ padding: '5px 10px' }}>
                <input inputMode="decimal" value={contado[f.producto_id] ?? ''} placeholder="—"
                  onChange={e => setContado(c => ({ ...c, [f.producto_id]: e.target.value }))}
                  style={{ ...inp, width: '100%', textAlign: 'right' }} />
              </div>
              <Cel der color={f.diferencia === null ? '#c3d0db' : f.diferencia < 0 ? ROJO : f.diferencia > 0 ? AMBAR : VERDE}>
                {(primeraVez || editToma) ? '' : f.diferencia === null ? '—' : f.diferencia === 0 ? 'Cuadra'
                  : (f.diferencia < 0 ? 'Faltan ' : 'Sobran ') + limpio(Math.abs(f.diferencia))}
              </Cel>
            </Fila>
          ))}
          <div style={{ padding: '13px 16px', borderTop: '0.5px solid ' + BORDE, background: '#fafcfd',
                        display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button onClick={() => { setContando(false); setContado({}); setEditToma(null) }} style={btn}>Cancelar</button>
            <button onClick={guardarToma} disabled={guardando || !llenadas}
              style={{ ...btn, background: AZUL, color: 'white', borderColor: AZUL,
                       opacity: (guardando || !llenadas) ? 0.5 : 1 }}>
              {guardando ? 'Guardando...' : editToma ? 'Guardar cambios' : primeraVez ? 'Cargar inventario' : 'Guardar conteo'}
            </button>
          </div>
        </Caja>
      ) : cargando ? (
        <Caja><div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Cargando...</div></Caja>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '9px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
            <Chip pequeno on={vista === 'saldo'} onClick={() => setVista('saldo')}>Cuánto hay</Chip>
            <Chip pequeno on={vista === 'movimientos'} onClick={() => setVista('movimientos')}>Qué se movió</Chip>
            {vista === 'saldo' ? (
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '6px', fontSize: '13px', color: GRIS }}>
                al <input type="date" value={alDia} max={hoyISO()} onChange={e => setAlDia(e.target.value)} style={inp} />
              </label>
            ) : (
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '6px', fontSize: '13px', color: GRIS }}>
                del <input type="date" value={desde} max={hasta} onChange={e => setDesde(e.target.value)} style={inp} />
                al <input type="date" value={hasta} min={desde} max={hoyISO()} onChange={e => setHasta(e.target.value)} style={inp} />
              </label>
            )}
          </div>

          {vista === 'saldo' ? (
            <>
              {esJefe && (
                <div style={{ display: 'flex', gap: '11px', marginBottom: '12px', flexWrap: 'wrap' }}>
                  <Kpi k="Valor de la bodega" v={dinero(valorBodega)} />
                  <Kpi k="Con problema" v={negativos ? `${negativos} en negativo` : 'Ninguno'} alerta={negativos > 0} />
                </div>
              )}
              {primeraVez && (
                filas.some(f => Number(f.saldo) !== 0) ? (
                  <Nota color={AMBAR} bg="#FAEEDA">
                    Aún no has hecho un conteo físico de esta finca. El saldo de arriba viene de los ingresos registrados. Cuando cuentes la bodega con “Cargar inventario inicial”, ese conteo fija el punto de partida.
                  </Nota>
                ) : (
                  <Nota color={AMBAR} bg="#FAEEDA">
                    Todavía no se ha contado el balanceado de esta finca. Carga el inventario inicial y de ahí el saldo se lleva solo.
                  </Nota>
                )
              )}
              <Caja>
                <Encabezado gtc={esJefe ? G_SALDO_J : G_SALDO_B} cols={esJefe ? ['Balanceado', 'Saldo', 'Precio saco', 'Valor', ''] : ['Balanceado', 'Saldo']} />
                {filas.map(f => {
                  const dg = desglose[f.producto_id] || []
                  const varios = dg.length > 1 || (dg.length === 1 && dg[0].plazo !== 0)
                  const ab = abierto === f.producto_id
                  return (
                  <div key={f.producto_id}>
                  <Fila gtc={esJefe ? G_SALDO_J : G_SALDO_B}>
                    <Cel>
                      {varios ? (
                        <button onClick={() => setAbierto(ab ? null : f.producto_id)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', color: NAVY, textAlign: 'left' }}>
                          <span style={{ color: GRIS, marginRight: '5px' }}>{ab ? '▾' : '▸'}</span>{f.producto}
                        </button>
                      ) : f.producto}
                    </Cel>
                    <Cel der fuerte color={Number(f.saldo) < 0 ? ROJO : NAVY}>{limpio(f.saldo)} <span style={{ fontSize: '11px', color: GRIS }}>sacos</span></Cel>
                    {esJefe && <Cel der gris>{f.precio ? dinero(f.precio) : 'sin precio'}</Cel>}
                    {esJefe && <Cel der>{dinero(valorFifo[f.producto_id] || 0)}</Cel>}
                    {esJefe && <div style={{ padding: '6px 10px', textAlign: 'right' }}>
                      <button onClick={() => corregir(f)} style={{ ...btn, padding: '5px 11px', fontSize: '12px', color: GRIS }}>Corregir</button>
                    </div>}
                  </Fila>
                  {ab && (
                    <div style={{ padding: '8px 14px 12px', background: '#f6f9fb', borderBottom: '0.5px solid #f1f6f9' }}>
                      <div style={{ fontSize: '11px', color: GRIS, textTransform: 'uppercase', marginBottom: '6px' }}>Por plazo de compra</div>
                      {dg.map((d, i) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '13px', padding: '4px 0', borderTop: i ? '0.5px solid #eef3f7' : 'none' }}>
                          <span>{PLAZO_LBL[d.plazo]}</span>
                          <span style={{ display: 'flex', gap: '18px', fontVariantNumeric: 'tabular-nums' }}>
                            <span>{limpio(d.cantidad)} sacos</span>
                            {esJefe && <span style={{ color: GRIS, minWidth: '80px', textAlign: 'right' }}>{dinero(d.valor)}</span>}
                          </span>
                        </div>
                      ))}
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '13px', fontWeight: 500, padding: '6px 0 0', borderTop: '0.5px solid ' + BORDE, marginTop: '2px' }}>
                        <span>Total</span>
                        <span style={{ display: 'flex', gap: '18px', fontVariantNumeric: 'tabular-nums' }}>
                          <span>{limpio(f.saldo)} sacos</span>
                          {esJefe && <span style={{ minWidth: '80px', textAlign: 'right' }}>{dinero(valorFifo[f.producto_id] || 0)}</span>}
                        </span>
                      </div>
                    </div>
                  )}
                  </div>
                )})}
              </Caja>
            </>
          ) : (
            <Caja>
              <Encabezado gtc={esJefe ? G_MOV_J : G_MOV_B} cols={['Balanceado', 'Saldo Ini.', 'Ingresos', 'Consumo', 'Ajustes', 'Conteo', 'Saldo Fin.', ...(esJefe ? ['Consumo $'] : [])]} />
              {movs.map(m => (
                <Fila gtc={esJefe ? G_MOV_J : G_MOV_B} key={m.producto_id}>
                  <Cel>{m.producto}</Cel>
                  <Cel der gris>{limpio(m.saldo_inicial)}</Cel>
                  <Cel der color={Number(m.ingresos) ? VERDE : '#c3d0db'}>{Number(m.ingresos) ? '+' + limpio(m.ingresos) : '—'}</Cel>
                  <Cel der>{Number(m.consumo) ? '-' + limpio(m.consumo) : '—'}</Cel>
                  <Cel der color={Number(m.ajustes) ? AMBAR : '#c3d0db'}>{Number(m.ajustes) ? (Number(m.ajustes) > 0 ? '+' : '') + limpio(m.ajustes) : '—'}</Cel>
                  <Cel der color={m.conteo === null ? '#c3d0db' : AZUL}>{m.conteo === null ? '—' : limpio(m.conteo)}</Cel>
                  <Cel der fuerte color={Number(m.saldo_final) < 0 ? ROJO : NAVY}>{limpio(m.saldo_final)}</Cel>
                  {esJefe && <Cel der>{dinero(Number(m.consumo_dolares))}</Cel>}
                </Fila>
              ))}
            </Caja>
          )}

          {negativos > 0 && (
            <Nota color={ROJO} bg="#FBEAEA">
              Hay {negativos} {negativos === 1 ? 'producto' : 'productos'} con saldo negativo: se aplicó más de lo que entró. Falta cargar un ingreso o contar la bodega.
            </Nota>
          )}

          {tomas.length > 0 && (
            <div style={{ marginTop: '16px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 8px' }}>Conteos anteriores</h3>
              <Caja>
                {tomas.map(t => (
                  <Fila key={t.id} gtc={esJefe ? '150px 1fr 160px' : G_DOS}>
                    <Cel fuerte>{corta(t.fecha)}</Cel>
                    <Cel gris>{t.observacion || 'Sin observación'}</Cel>
                    {esJefe && (
                      <div style={{ padding: '6px 10px', textAlign: 'right', display: 'flex', gap: '7px', justifyContent: 'flex-end' }}>
                        <button onClick={() => editarToma(t)} style={{ ...btn, padding: '5px 11px', fontSize: '12px' }}>Editar</button>
                        <button onClick={() => borrarToma(t)} style={{ ...btn, padding: '5px 11px',
                          fontSize: '12px', color: ROJO, borderColor: '#e7cccb' }}>Borrar</button>
                      </div>
                    )}
                  </Fila>
                ))}
              </Caja>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Ingresos de balanceado con guía.
function IngresosBalanceado({ finca, esJefe, onCambio, onCorreccion }) {
  const [productos, setProductos] = useState([])
  const [lista, setLista] = useState([])
  const [nuevo, setNuevo] = useState(false)
  const [fecha, setFecha] = useState(hoyISO())
  const [guia, setGuia] = useState(''); const [prov, setProv] = useState('')
  const [lineas, setLineas] = useState([{ productoId: '', cantidad: '' }])
  const [aviso, setAviso] = useState(null)
  const [solicitudes, setSolicitudes] = useState([])
  const [userId, setUserId] = useState(null)
  const [editando, setEditando] = useState(null)

  const cargar = useCallback(async () => {
    const [{ data: pr }, { data: g }, { data: sol }, { data: auth }] = await Promise.all([
      supabase.schema('produccion').from('producto').select('id, nombre').eq('activo', true).order('nombre'),
      supabase.schema('produccion').from('ingreso_balanceado')
        .select('id, fecha, numero_guia, proveedor, ingreso_balanceado_linea(producto_id, cantidad, plazo)')
        .eq('finca_id', finca.id).order('fecha', { ascending: false }).limit(40),
      supabase.schema('produccion').from('solicitud_correccion')
        .select('id, registro_id, valor_propuesto, motivo, estado')
        .eq('finca_id', finca.id).eq('tabla', 'ingreso_balanceado').eq('estado', 'pendiente'),
      supabase.auth.getUser(),
    ])
    setProductos(pr || []); setLista(g || [])
    setSolicitudes(sol || []); setUserId(auth?.user?.id || null)
  }, [finca.id])
  useEffect(() => { cargar() }, [cargar])

  const nombre = id => productos.find(p => p.id === id)?.nombre || ''
  const validas = lineas.filter(l => l.productoId && num(l.cantidad))

  async function borrarJefe(g) {
    if (!window.confirm('¿Borrar este ingreso? Se resta de la bodega.')) return
    const { error } = await supabase.schema('produccion').from('ingreso_balanceado').delete().eq('id', g.id)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo borrar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Ingreso borrado.' }); await cargar(); onCambio && onCambio()
  }
  async function resolver(sol, aprobar) {
    const { error } = await supabase.schema('produccion').rpc('fn_resolver_correccion', { p_id: sol.id, p_aprobar: aprobar })
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo resolver. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: aprobar ? 'Corrección aplicada.' : 'Solicitud rechazada.' })
    await cargar(); onCambio && onCambio(); onCorreccion && onCorreccion()
  }

  async function guardar() {
    if (!validas.length) { setAviso({ tipo: 'error', texto: 'Agrega al menos una línea.' }); return }
    const { data: g, error } = await supabase.schema('produccion').from('ingreso_balanceado')
      .insert({ finca_id: finca.id, fecha, numero_guia: guia || null, proveedor: prov || null }).select('id').single()
    if (error) { setAviso({ tipo: 'error', texto: error.message }); return }
    const { error: e2 } = await supabase.schema('produccion').from('ingreso_balanceado_linea')
      .insert(validas.map(l => ({ ingreso_id: g.id, producto_id: l.productoId, cantidad: num(l.cantidad) })))
    if (e2) { setAviso({ tipo: 'error', texto: e2.message }); return }
    setNuevo(false); setLineas([{ productoId: '', cantidad: '' }]); setGuia(''); setProv('')
    setAviso({ tipo: 'ok', texto: 'Ingreso registrado.' }); await cargar(); onCambio && onCambio()
  }

  return (
    <div>
      {aviso && <div style={{ borderRadius: '10px', padding: '11px 13px', fontSize: '13px', marginBottom: '12px',
        background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE', color: aviso.tipo === 'error' ? ROJO : VERDE }}>{aviso.texto}</div>}

      {solicitudes.length > 0 && (
        <div style={{ background: '#FBF5E9', border: '0.5px solid #ecd9b3', borderRadius: '12px', padding: '14px 16px', marginBottom: '12px' }}>
          <div style={{ fontWeight: 500 }}>{esJefe ? 'Correcciones por autorizar' : 'Correcciones pendientes'} ({solicitudes.length})</div>
          {solicitudes.map(s => {
            const vp = s.valor_propuesto || {}
            return (
              <div key={s.id} style={{ borderTop: '0.5px solid #ecd9b3', paddingTop: '10px', marginTop: '10px' }}>
                <div style={{ fontSize: '13px', fontWeight: 500 }}>{vp.borrar ? 'Pide borrar el ingreso' : 'Propone cambios en el ingreso'}</div>
                {!vp.borrar && (
                  <div style={{ fontSize: '12px', color: GRIS, marginTop: '4px' }}>
                    {corta(vp.fecha)} · {vp.numero_guia ? ('Guía ' + vp.numero_guia) : 'Sin guía'}{vp.proveedor ? (' · ' + vp.proveedor) : ''}
                    <div>{(vp.lineas || []).map((l, i) => <span key={i}>{nombre(l.producto_id)}: {miles(l.cantidad)} sacos{i < vp.lineas.length - 1 ? '  ·  ' : ''}</span>)}</div>
                  </div>
                )}
                <div style={{ fontSize: '12px', color: GRIS, fontStyle: 'italic', marginTop: '4px' }}>Motivo: {s.motivo || '—'}</div>
                {esJefe && (
                  <div style={{ display: 'flex', gap: '8px', marginTop: '9px' }}>
                    <button onClick={() => resolver(s, true)} style={btn}>Aprobar</button>
                    <button onClick={() => resolver(s, false)} style={{ ...btn, color: ROJO, borderColor: '#e7cccb' }}>Rechazar</button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {!nuevo && <button onClick={() => setNuevo(true)} style={{ ...btn, background: AZUL, color: 'white', borderColor: AZUL, marginBottom: '12px' }}>Registrar ingreso</button>}

      {nuevo && (
        <div style={{ ...cajaS, padding: '18px', marginBottom: '14px', border: '0.5px solid ' + AZUL }}>
          <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '14px' }}>
            <Campo label="Fecha"><input type="date" value={fecha} max={hoyISO()} onChange={e => setFecha(e.target.value)} style={inp} /></Campo>
            <Campo label="Número de guía"><input value={guia} placeholder="Opcional" onChange={e => setGuia(e.target.value)} style={inp} /></Campo>
            <Campo label="Proveedor"><input value={prov} placeholder="Opcional" onChange={e => setProv(e.target.value)} style={inp} /></Campo>
          </div>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '7px' }}>Balanceados (en sacos)</div>
          {lineas.map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '7px' }}>
              <select value={l.productoId} onChange={e => setLineas(ls => ls.map((x, j) => j === i ? { ...x, productoId: e.target.value } : x))} style={{ ...inp, flex: 1 }}>
                <option value="">Elegir balanceado</option>
                {productos.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
              </select>
              <input inputMode="decimal" value={l.cantidad} placeholder="Sacos"
                onChange={e => setLineas(ls => ls.map((x, j) => j === i ? { ...x, cantidad: e.target.value } : x))} style={{ ...inp, width: '150px' }} />
              {lineas.length > 1 && <button onClick={() => setLineas(ls => ls.filter((_, j) => j !== i))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#c3d0db', fontSize: '18px' }}>×</button>}
            </div>
          ))}
          <button onClick={() => setLineas(ls => [...ls, { productoId: '', cantidad: '' }])} style={{ border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', color: AZUL }}>+ otra línea</button>
          <div style={{ display: 'flex', gap: '9px', justifyContent: 'flex-end', marginTop: '14px' }}>
            <button onClick={() => setNuevo(false)} style={btn}>Cancelar</button>
            <button onClick={guardar} disabled={!validas.length} style={{ ...btn, background: AZUL, color: 'white', borderColor: AZUL, opacity: validas.length ? 1 : 0.5 }}>Guardar ingreso</button>
          </div>
        </div>
      )}

      {lista.length === 0 ? (
        <Caja><div style={{ padding: '30px', textAlign: 'center', color: GRIS, fontSize: '13px' }}>Todavía no hay ingresos. Cuando llegue balanceado, regístralo con su guía.</div></Caja>
      ) : lista.map(g => {
        const solPend = solicitudes.find(s => s.registro_id === g.id)
        return (
        <div key={g.id} style={{ ...cajaS, padding: '15px 17px', marginBottom: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontWeight: 500 }}>{corta(g.fecha)}</div>
              <div style={{ fontSize: '12px', color: GRIS }}>{g.numero_guia ? `Guía ${g.numero_guia}` : 'Sin guía'}{g.proveedor ? ` · ${g.proveedor}` : ''}</div>
            </div>
            <div style={{ display: 'flex', gap: '7px', alignItems: 'flex-start' }}>
              {solPend ? (
                <span style={{ fontSize: '11px', fontWeight: 500, padding: '4px 11px', borderRadius: '20px', background: '#FAEEDA', color: AMBAR, height: 'fit-content' }}>Corrección pendiente</span>
              ) : editando === g.id ? null : esJefe ? (
                <>
                  <button onClick={() => setEditando(g.id)} style={{ ...btn, padding: '6px 11px', fontSize: '12px' }}>Editar</button>
                  <button onClick={() => borrarJefe(g)} style={{ ...btn, padding: '6px 11px', fontSize: '12px', color: ROJO, borderColor: '#e7cccb' }}>Borrar</button>
                </>
              ) : (
                <button onClick={() => setEditando(g.id)} style={{ ...btn, padding: '6px 11px', fontSize: '12px' }}>Solicitar corrección</button>
              )}
            </div>
          </div>
          <div style={{ marginTop: '9px', borderTop: '0.5px solid #f1f6f9', paddingTop: '8px' }}>
            {(g.ingreso_balanceado_linea || []).map((l, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', padding: '3px 0' }}>
                <span>{nombre(l.producto_id)}</span><span style={{ color: VERDE }}>+{miles(num(l.cantidad))} sacos</span>
              </div>
            ))}
          </div>
          {editando === g.id && (
            <EditorIngBal g={g} productos={productos} esJefe={esJefe} finca={finca} userId={userId}
              onHecho={async (msg) => { setEditando(null); await cargar(); onCambio && onCambio(); setAviso({ tipo: 'ok', texto: msg }) }}
              onCancelar={() => setEditando(null)} setAviso={setAviso} />
          )}
        </div>
        )
      })}
    </div>
  )
}

// Editor de un ingreso de balanceado: el jefe guarda directo, el bodeguero pide.
function EditorIngBal({ g, productos, esJefe, finca, userId, onHecho, onCancelar, setAviso }) {
  const [fecha, setFecha] = useState(g.fecha)
  const [guia, setGuia] = useState(g.numero_guia || '')
  const [prov, setProv] = useState(g.proveedor || '')
  const [lineas, setLineas] = useState((g.ingreso_balanceado_linea || []).map(l => ({ productoId: l.producto_id, cantidad: String(l.cantidad) })))
  const [motivo, setMotivo] = useState('')
  const [enviando, setEnviando] = useState(false)
  const setLinea = (i, c, v) => setLineas(ls => ls.map((l, j) => j === i ? { ...l, [c]: v } : l))
  const validas = lineas.filter(l => l.productoId && num(l.cantidad))

  async function guardarJefe() {
    if (!validas.length) { setAviso({ tipo: 'error', texto: 'Deja al menos una línea.' }); return }
    setEnviando(true)
    const { error } = await supabase.schema('produccion').from('ingreso_balanceado')
      .update({ fecha, numero_guia: guia || null, proveedor: prov || null }).eq('id', g.id)
    if (error) { setEnviando(false); setAviso({ tipo: 'error', texto: error.message }); return }
    await supabase.schema('produccion').from('ingreso_balanceado_linea').delete().eq('ingreso_id', g.id)
    const { error: e2 } = await supabase.schema('produccion').from('ingreso_balanceado_linea')
      .insert(validas.map(l => ({ ingreso_id: g.id, producto_id: l.productoId, cantidad: num(l.cantidad) })))
    setEnviando(false)
    if (e2) { setAviso({ tipo: 'error', texto: e2.message }); return }
    onHecho('Ingreso actualizado.')
  }
  async function enviarSolicitud(borrar) {
    if (!motivo.trim()) { setAviso({ tipo: 'error', texto: 'Escribe el motivo de la corrección.' }); return }
    if (!borrar && !validas.length) { setAviso({ tipo: 'error', texto: 'Deja al menos una línea.' }); return }
    setEnviando(true)
    const anterior = { fecha: g.fecha, numero_guia: g.numero_guia, proveedor: g.proveedor,
      lineas: (g.ingreso_balanceado_linea || []).map(l => ({ producto_id: l.producto_id, cantidad: Number(l.cantidad) })) }
    const propuesto = borrar ? { borrar: true }
      : { borrar: false, fecha, numero_guia: guia || null, proveedor: prov || null,
          lineas: validas.map(l => ({ producto_id: l.productoId, cantidad: num(l.cantidad) })) }
    const { error } = await supabase.schema('produccion').from('solicitud_correccion').insert({
      finca_id: finca.id, tabla: 'ingreso_balanceado', registro_id: g.id,
      valor_anterior: anterior, valor_propuesto: propuesto, motivo: motivo.trim(), solicitado_por: userId })
    setEnviando(false)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo enviar. ' + error.message }); return }
    onHecho(borrar ? 'Solicitud de borrado enviada.' : 'Solicitud enviada. El jefe la revisará.')
  }

  return (
    <div style={{ background: '#f6f9fb', borderRadius: '10px', padding: '14px', marginTop: '11px' }}>
      <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '10px' }}>{esJefe ? 'Editar ingreso' : 'Proponer corrección'}</div>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <Campo label="Fecha"><input type="date" value={fecha} max={hoyISO()} onChange={e => setFecha(e.target.value)} style={inp} /></Campo>
        <Campo label="Número de guía"><input value={guia} placeholder="Opcional" onChange={e => setGuia(e.target.value)} style={inp} /></Campo>
        <Campo label="Proveedor"><input value={prov} placeholder="Opcional" onChange={e => setProv(e.target.value)} style={inp} /></Campo>
      </div>
      <div style={{ fontSize: '12px', color: GRIS, marginBottom: '7px' }}>Balanceados (en sacos)</div>
      {lineas.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '7px' }}>
          <select value={l.productoId} onChange={e => setLinea(i, 'productoId', e.target.value)} style={{ ...inp, flex: 1 }}>
            <option value="">Elegir balanceado</option>
            {productos.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
          <input inputMode="decimal" value={l.cantidad} placeholder="Sacos" onChange={e => setLinea(i, 'cantidad', e.target.value)} style={{ ...inp, width: '150px' }} />
          {lineas.length > 1 && <button onClick={() => setLineas(ls => ls.filter((_, j) => j !== i))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#c3d0db', fontSize: '18px' }}>×</button>}
        </div>
      ))}
      <button onClick={() => setLineas(ls => [...ls, { productoId: '', cantidad: '' }])} style={{ border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px', color: AZUL }}>+ otra línea</button>
      {!esJefe && (
        <div style={{ marginTop: '10px' }}>
          <Campo label="Motivo de la corrección"><input value={motivo} placeholder="Por qué se corrige — lo verá el jefe" onChange={e => setMotivo(e.target.value)} style={{ ...inp, width: '100%' }} /></Campo>
        </div>
      )}
      <div style={{ display: 'flex', gap: '9px', justifyContent: 'flex-end', marginTop: '14px', flexWrap: 'wrap' }}>
        <button onClick={onCancelar} style={btn}>Cancelar</button>
        {esJefe ? (
          <button onClick={guardarJefe} disabled={enviando} style={{ ...btn, background: AZUL, color: 'white', borderColor: AZUL, opacity: enviando ? 0.6 : 1 }}>{enviando ? 'Guardando...' : 'Guardar cambios'}</button>
        ) : (
          <>
            <button onClick={() => enviarSolicitud(true)} style={{ ...btn, color: ROJO, borderColor: '#e7cccb' }}>Solicitar borrado</button>
            <button onClick={() => enviarSolicitud(false)} disabled={enviando} style={{ ...btn, background: AZUL, color: 'white', borderColor: AZUL, opacity: enviando ? 0.6 : 1 }}>{enviando ? 'Enviando...' : 'Enviar solicitud'}</button>
          </>
        )}
      </div>
    </div>
  )
}

function limpio(n) { const v = Number(n); if (!isFinite(v)) return '—'; const s = v.toFixed(2).replace(/\.?0+$/, ''); return s === '' || s === '-' ? '0' : s }
function Chip({ children, on, pequeno, onClick }) {
  return <button onClick={onClick} style={{ padding: pequeno ? '7px 12px' : '8px 15px', borderRadius: '20px',
    fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer', border: '0.5px solid ' + (on ? '#9cc4e8' : BORDE),
    background: on ? '#E6F1FB' : 'white', color: on ? AZUL : NAVY, fontWeight: on ? 500 : 400 }}>{children}</button>
}
function Kpi({ k, v, alerta }) {
  return <div style={{ background: 'white', border: '0.5px solid ' + (alerta ? '#e8d5b0' : BORDE), borderRadius: '12px', padding: '13px 15px', minWidth: '160px' }}>
    <div style={{ fontSize: '12px', color: GRIS, marginBottom: '4px' }}>{k}</div>
    <div style={{ fontSize: '19px', fontWeight: 500, color: alerta ? AMBAR : NAVY }}>{v}</div>
  </div>
}
function Nota({ children, color, bg }) { return <div style={{ background: bg, color, borderRadius: '10px', padding: '12px 14px', fontSize: '13px', marginTop: '12px', lineHeight: 1.6 }}>{children}</div> }
function Caja({ children }) { return <div style={cajaS}>{children}</div> }
const cajaS = { background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden' }
function Campo({ label, children }) { return <div><div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>{label}</div>{children}</div> }
function Encabezado({ cols, gtc }) {
  return <div style={{ display: 'grid', gridTemplateColumns: gtc, gap: '10px', padding: '10px 14px', fontSize: '12px', color: GRIS, background: '#f6f9fb', borderBottom: '0.5px solid ' + BORDE }}>
    {cols.map((c, i) => <span key={i} style={{ textAlign: i === 0 ? 'left' : 'right' }}>{c}</span>)}
  </div>
}
function Fila({ children, gtc }) {
  return <div style={{ display: 'grid', gridTemplateColumns: gtc, gap: '10px', alignItems: 'center', borderBottom: '0.5px solid #f1f6f9' }}>{children}</div>
}
function Cel({ children, der, gris, fuerte, color }) {
  return <div style={{ padding: '10px 12px', fontSize: '13px', textAlign: der ? 'right' : 'left', color: color || (gris ? GRIS : NAVY), fontWeight: fuerte ? 500 : 400, fontVariantNumeric: der ? 'tabular-nums' : 'normal' }}>{children}</div>
}
const inp = { padding: '8px 11px', fontSize: '13px', fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '9px', boxSizing: 'border-box', background: 'white' }
const btn = { padding: '9px 15px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500, border: '0.5px solid ' + BORDE, borderRadius: '9px', background: 'white', color: NAVY, cursor: 'pointer' }
const btnLink = { background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit', fontSize: '13px', color: AZUL, fontWeight: 500 }
