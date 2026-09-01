import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, dinero } from '../lib/fechas'
import Ingresos from './Ingresos'
import PreciosInsumos from './PreciosInsumos'

// Inventario de insumos · modulo Produccion
//
// Contar la bodega no suma ni resta: FIJA el saldo. Y la diferencia
// contra lo que el sistema tenia calculado no se esconde: se muestra
// antes de guardar y queda en la bitacora. Si el sistema decia 40 sacos
// de cal y hay 33, el dato util no es "ahora hay 33", es que faltan 7.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'
const ROJO = '#8A2F2E'
const VERDE = '#0F6E56'
const AMBAR = '#854F0B'

// Sin abreviaturas: el bodeguero no tiene por que descifrar "lt".
// El inventario se muestra en unidad de compra (tambores, botellas,
// sacos), que es lo que devuelven las funciones de saldo.
const UNIDAD = {
  sacos: 'Sacos', litros: 'Litros', gramos: 'Gramos',
  libras: 'Libras', kg: 'Kilos', unidad: 'Unidades',
  tambor: 'Tambores', botella: 'Botellas',
}
const UNIDADES = ['sacos', 'litros', 'gramos', 'libras', 'kg', 'unidad']

// Primer dia del mes de una fecha, para el atajo "este mes".
const primeroDelMes = iso => iso.slice(0, 8) + '01'

const ANCHOS_SALDO      = '1fr 110px 120px 140px 150px'
const ANCHOS_SALDO_JEFE = '1fr 110px 120px 140px 150px 110px'
const ANCHOS_SALDO_BOD  = '1fr 110px 120px'   // bodeguero: sin dolares
const ANCHOS_MOV        = '1fr 100px 110px 100px 100px 100px 100px 110px 120px'
const ANCHOS_MOV_BOD    = '1fr 100px 110px 100px 100px 100px 100px 110px'   // sin Consumo $

export default function Inventario({ finca, esJefe, esJefeGlobal, abrirIngresos, abrirPrecios, onCorreccion }) {
  // Dos secciones: la bodega (saldo y conteos) y el movimiento de
  // producto (ingresos y pedidos).
  const [seccion, setSeccion] = useState('bodega')

  // Cuando el jefe entra desde el aviso de "correcciones por aprobar",
  // abrimos directo la seccion de ingresos.
  useEffect(() => {
    if (abrirIngresos) setSeccion('movimiento')
  }, [abrirIngresos])
  const [saldos, setSaldos] = useState([])
  const [movs, setMovs] = useState([])
  const [precios, setPrecios] = useState({})
  const [valorFifo, setValorFifo] = useState({})   // insumoId -> valor FIFO
  const [conteos, setConteos] = useState([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)

  // Dos formas de mirar: cuanto hay a una fecha, o que paso entre dos.
  const [vista, setVista] = useState('saldo')     // 'saldo' | 'movimientos'
  const [alDia, setAlDia] = useState(hoyISO())
  const [desde, setDesde] = useState(primeroDelMes(hoyISO()))
  const [hasta, setHasta] = useState(hoyISO())

  const [contando, setContando] = useState(false)
  const [editToma, setEditToma] = useState(null)   // conteo que se está editando
  const [fecha, setFecha] = useState(hoyISO())
  const [obs, setObs] = useState('')
  const [contado, setContado] = useState({})
  const [guardando, setGuardando] = useState(false)

  // Agregar insumos que faltan, varios a la vez, sin salir del conteo.
  const [nuevos, setNuevos] = useState([])
  const [guardandoNuevos, setGuardandoNuevos] = useState(false)

  // Correccion en linea del jefe: que insumo se esta editando, el saldo
  // nuevo y el motivo. Todo dentro de la fila, sin ventanas.
  const [editando, setEditando] = useState(null)
  const [nuevoSaldo, setNuevoSaldo] = useState('')
  const [motivo, setMotivo] = useState('')
  const [guardandoAj, setGuardandoAj] = useState(false)

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    try {
      const [{ data: s, error: eS }, { data: m }, { data: p }, { data: t }, { data: ins }, { data: vf }, { data: ovFactor }] = await Promise.all([
        supabase.schema('produccion').rpc('fn_saldo_insumo',
          { p_finca: finca.id, p_hasta: alDia }),
        supabase.schema('produccion').rpc('fn_movimiento_insumo',
          { p_finca: finca.id, p_desde: desde, p_hasta: hasta }),
        supabase.schema('produccion').from('precio_insumo')
          .select('insumo_id, finca_id, precio_unitario')
          .is('vigente_hasta', null)
          .or(`finca_id.is.null,finca_id.eq.${finca.id}`),
        supabase.schema('produccion').from('toma_inventario')
          .select('id, fecha, observacion')
          .eq('finca_id', finca.id).order('fecha', { ascending: false }).limit(12),
        supabase.schema('produccion').from('insumo').select('id, factor').eq('activo', true),
        supabase.schema('produccion').rpc('fn_valor_bodega_fifo',
          { p_finca: finca.id, p_hasta: alDia }),
        supabase.schema('produccion').from('insumo_finca')
          .select('insumo_id, factor').eq('finca_id', finca.id),
      ])
      if (eS) throw eS

      // El factor convierte el precio (por unidad de consumo) a precio
      // por unidad de compra. Se resuelve por finca (override o catálogo).
      const factor = {}
      ;(ins || []).forEach(x => { factor[x.id] = Number(x.factor) || 1 })
      ;(ovFactor || []).forEach(x => { factor[x.insumo_id] = Number(x.factor) || 1 })

      // El precio de la finca le gana al general. Se guarda ya por
      // unidad de compra: precio del catalogo por el factor.
      const pr = {}
      ;(p || []).forEach(x => {
        if (pr[x.insumo_id] && !x.finca_id) return
        pr[x.insumo_id] = Number(x.precio_unitario) * (factor[x.insumo_id] || 1)
      })

      const vfMap = {}
      ;(vf || []).forEach(x => { vfMap[x.insumo_id] = Number(x.valor) })
      setValorFifo(vfMap)

      setSaldos(s || []); setMovs(m || []); setPrecios(pr); setConteos(t || [])
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally {
      setCargando(false)
    }
  }, [finca.id, alDia, desde, hasta])

  useEffect(() => { cargar() }, [cargar])

  const primeraVez = conteos.length === 0
  const ultimo = conteos[0]

  // El valor total viene del calculo FIFO, no de saldo x precio actual.
  const valorBodega = useMemo(
    () => Object.values(valorFifo).reduce((t, v) => t + (Number(v) || 0), 0),
    [valorFifo])
  const conSaldo = saldos.filter(s => Number(s.saldo) > 0).length
  const negativos = saldos.filter(s => Number(s.saldo) < 0).length
  const sinPrecio = saldos.filter(s => !precios[s.insumo_id]).length

  const filas = useMemo(() => saldos.map(s => {
    const txt = contado[s.insumo_id]
    const hay = txt !== undefined && txt !== ''
    const c = hay ? Number(txt) : null
    return { ...s, precio: precios[s.insumo_id] || 0,
             contado: c, diferencia: hay ? c - Number(s.saldo) : null }
  }), [saldos, precios, contado])

  const descuadres = filas.filter(f => f.diferencia !== null && Math.abs(f.diferencia) > 0.0001)
  const llenadas = filas.filter(f => f.contado !== null).length

  function abrirCorregir(f) {
    setEditando(f.insumo_id)
    setNuevoSaldo(limpio(f.saldo))
    setMotivo('')
    setAviso(null)
  }

  // Corregir el saldo de un insumo suelto. Solo jefes y con motivo: un
  // ajuste es donde se tapa un descuadre, y sin el porque no sirve.
  async function guardarCorreccion(f) {
    const nuevo = Number(String(nuevoSaldo).replace(',', '.'))
    if (!isFinite(nuevo)) {
      setAviso({ tipo: 'error', texto: 'El saldo nuevo no es un número.' }); return
    }
    const delta = nuevo - Number(f.saldo)
    if (Math.abs(delta) < 0.0001) { setEditando(null); return }
    if (!motivo.trim()) {
      setAviso({ tipo: 'error', texto: 'La corrección necesita un motivo.' }); return
    }

    setGuardandoAj(true)
    const { error } = await supabase.schema('produccion').from('ajuste_insumo')
      .insert({ finca_id: finca.id, fecha: alDia, insumo_id: f.insumo_id,
                cantidad: delta, motivo: motivo.trim() })
    setGuardandoAj(false)
    if (error) {
      setAviso({ tipo: 'error', texto: 'No se pudo corregir. ' + error.message }); return
    }
    setEditando(null)
    setAviso({ tipo: 'ok', texto: `${f.insumo} corregido a ${limpio(nuevo)}.` })
    await cargar()
  }

  const filaNueva = () => ({ nombre: '', unidad: 'kg', compraDistinta: false, unidadCompra: '', factor: '' })
  const setNuevo = (i, campo, val) => setNuevos(ns => ns.map((n, j) => j === i ? { ...n, [campo]: val } : n))

  async function guardarNuevos() {
    const validos = nuevos.filter(n => n.nombre.trim())
    if (!validos.length) { setNuevos([]); return }
    const rows = validos.map(n => ({
      nombre: n.nombre.trim(),
      unidad: n.unidad,
      unidad_compra: (n.compraDistinta ? n.unidadCompra.trim() : n.unidad) || n.unidad,
      factor: n.compraDistinta ? (Number(String(n.factor).replace(',', '.')) || 1) : 1,
    }))
    setGuardandoNuevos(true)
    if (esJefeGlobal) {
      const { error } = await supabase.schema('produccion').from('insumo').insert(rows)
      setGuardandoNuevos(false)
      if (error) {
        const dup = /duplicate|unique/i.test(error.message)
        setAviso({ tipo: 'error', texto: dup ? 'Alguno ya existe con ese nombre.' : 'No se pudo agregar. ' + error.message })
        return
      }
      setAviso({ tipo: 'ok', texto: `${rows.length} ${rows.length === 1 ? 'insumo agregado' : 'insumos agregados'}. Ya puedes contarlos abajo.` })
    } else {
      // Bodeguero/contadora: no crea, PIDE al jefe.
      const { data: au } = await supabase.auth.getUser()
      const solis = rows.map(r => ({
        finca_id: finca.id, tabla: 'nuevo_insumo', registro_id: crypto.randomUUID(),
        valor_propuesto: r, motivo: 'Insumo que falta en la lista', solicitado_por: au?.user?.id }))
      const { error } = await supabase.schema('produccion').from('solicitud_correccion').insert(solis)
      setGuardandoNuevos(false)
      if (error) { setAviso({ tipo: 'error', texto: 'No se pudo enviar. ' + error.message }); return }
      setAviso({ tipo: 'ok', texto: 'Pedido enviado al jefe. Lo agregará al catálogo.' })
    }
    setNuevos([])
    await cargar()
  }

  async function editarConteo(c) {
    const { data } = await supabase.schema('produccion').from('toma_inventario_linea')
      .select('insumo_id, cantidad_contada').eq('toma_id', c.id)
    const mapa = {}
    ;(data || []).forEach(l => { mapa[l.insumo_id] = String(l.cantidad_contada) })
    setContado(mapa); setFecha(c.fecha); setObs(c.observacion || '')
    setEditToma(c); setContando(true); setAviso(null)
  }

  async function borrarConteo(c) {
    if (!window.confirm(`¿Borrar el conteo del ${corta(c.fecha)}?\n\nEl saldo vuelve a calcularse desde el conteo anterior (o desde cero si no hay otro). No se puede deshacer.`)) return
    const { error } = await supabase.schema('produccion').from('toma_inventario').delete().eq('id', c.id)
    if (error) { setAviso({ tipo: 'error', texto: 'No se pudo borrar. ' + error.message }); return }
    setAviso({ tipo: 'ok', texto: 'Conteo borrado.' })
    await cargar()
  }

  async function guardar() {
    if (!llenadas) {
      setAviso({ tipo: 'error', texto: 'No has contado ningún insumo todavía.' })
      return
    }

    const texto = editToma
      ? `Vas a guardar los cambios del conteo del ${corta(editToma.fecha)}.\n\n¿Guardar?`
      : primeraVez
      ? `Vas a cargar el inventario inicial con ${llenadas} insumos contados.\n\n` +
        `De aquí en adelante el saldo se lleva solo: baja con lo que se aplica en las piscinas y sube con lo que entra a bodega.\n\n¿Guardar?`
      : descuadres.length
        ? `${descuadres.length} insumos no cuadran con lo que el sistema tenía calculado.\n\n` +
          descuadres.slice(0, 5).map(d =>
            `${d.insumo}: el sistema decía ${limpio(d.saldo)}, contaste ${limpio(d.contado)} (${d.diferencia > 0 ? 'sobran ' : 'faltan '}${limpio(Math.abs(d.diferencia))})`
          ).join('\n') +
          (descuadres.length > 5 ? `\n...y ${descuadres.length - 5} más` : '') +
          `\n\nLas diferencias quedan registradas con tu nombre y la fecha. ¿Guardar?`
        : `Todo cuadra con lo que el sistema tenía calculado. ¿Guardar el conteo?`

    if (!window.confirm(texto)) return

    setGuardando(true); setAviso(null)
    try {
      let tomaId
      if (editToma) {
        // Editar un conteo existente: actualiza cabecera y reemplaza líneas.
        const { error: eU } = await supabase.schema('produccion').from('toma_inventario')
          .update({ fecha, observacion: obs || null }).eq('id', editToma.id)
        if (eU) throw eU
        await supabase.schema('produccion').from('toma_inventario_linea').delete().eq('toma_id', editToma.id)
        tomaId = editToma.id
      } else {
        const { data: toma, error } = await supabase.schema('produccion')
          .from('toma_inventario')
          .insert({ finca_id: finca.id, fecha, observacion: obs || null })
          .select('id').single()
        if (error) throw error
        tomaId = toma.id
      }

      const lineas = filas.filter(f => f.contado !== null).map(f => ({
        toma_id: tomaId, insumo_id: f.insumo_id,
        cantidad_contada: f.contado,
        cantidad_sistema: Number(f.saldo),
        diferencia: f.diferencia,
      }))
      const { error: e2 } = await supabase.schema('produccion')
        .from('toma_inventario_linea').insert(lineas)
      if (e2) throw e2

      setAviso({ tipo: 'ok',
        texto: editToma ? 'Conteo actualizado.' : primeraVez ? 'Inventario inicial cargado.' : `Conteo guardado. ${lineas.length} insumos.` })
      setContando(false); setEditToma(null); setContado({}); setObs('')
      await cargar()
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + (err.message || '') })
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div style={{ padding: '1.4rem 1.5rem', maxWidth: '1180px' }}>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                    gap: '14px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <div>
          <h2 style={{ fontSize: '19px', fontWeight: 500, margin: '0 0 4px' }}>Inventario de insumos</h2>
          <p style={{ fontSize: '13px', color: GRIS, margin: 0 }}>
            Bodega de {String(finca.nombre).toUpperCase()}.
          </p>
        </div>
        {seccion === 'bodega' && !contando && !cargando && (
          <Btn primario onClick={() => setContando(true)}>
            {primeraVez ? 'Cargar inventario inicial' : 'Contar la bodega'}
          </Btn>
        )}
      </div>

      <div style={{ display: 'flex', gap: '9px', marginBottom: '16px' }}>
        <Chip on={seccion === 'bodega'} onClick={() => setSeccion('bodega')}>Bodega</Chip>
        <Chip on={seccion === 'movimiento'} onClick={() => { setSeccion('movimiento'); setContando(false) }}>
          Ingresos y pedidos
        </Chip>
      </div>

      {seccion === 'movimiento' ? (
        <Ingresos finca={finca} esJefe={esJefe} onCorreccion={onCorreccion} />
      ) : (
      <>
      {/* --- seccion bodega --- */}

      {aviso && (
        <div style={{ borderRadius: '10px', padding: '12px 14px', fontSize: '13px', marginBottom: '12px',
                      background: aviso.tipo === 'error' ? '#FBEAEA' : '#E1F5EE',
                      color: aviso.tipo === 'error' ? ROJO : VERDE }}>
          {aviso.texto}
        </div>
      )}

      {!contando && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap',
                      marginBottom: '14px' }}>
          <Chip on={vista === 'saldo'} onClick={() => setVista('saldo')}>Cuánto hay</Chip>
          <Chip on={vista === 'movimientos'} onClick={() => setVista('movimientos')}>Qué se movió</Chip>

          {vista === 'saldo' ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '6px' }}>
              <span style={{ fontSize: '13px', color: GRIS }}>al</span>
              <input type="date" value={alDia} max={hoyISO()}
                     onChange={e => setAlDia(e.target.value)} style={entrada} />
              {alDia !== hoyISO() && (
                <button onClick={() => setAlDia(hoyISO())}
                        style={{ background: 'none', border: 'none', cursor: 'pointer',
                                 fontFamily: 'inherit', fontSize: '12px', color: AZUL }}>
                  volver a hoy
                </button>
              )}
            </label>
          ) : (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '6px' }}>
                <span style={{ fontSize: '13px', color: GRIS }}>del</span>
                <input type="date" value={desde} max={hasta}
                       onChange={e => setDesde(e.target.value)} style={entrada} />
                <span style={{ fontSize: '13px', color: GRIS }}>al</span>
                <input type="date" value={hasta} min={desde} max={hoyISO()}
                       onChange={e => setHasta(e.target.value)} style={entrada} />
              </label>
              <Chip pequeno onClick={() => { setDesde(primeroDelMes(hoyISO())); setHasta(hoyISO()) }}>
                Este mes
              </Chip>
              <Chip pequeno onClick={() => { setDesde(hoyISO().slice(0, 4) + '-01-01'); setHasta(hoyISO()) }}>
                Este año
              </Chip>
            </>
          )}
        </div>
      )}

      {!contando && !cargando && vista === 'saldo' && (
        <>
          {/* Resumen */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                        gap: '11px', marginBottom: '14px' }}>
            {/* El valor en dolares es solo para el jefe. */}
            {esJefe && <Kpi titulo="Valor de la bodega" valor={dinero(valorBodega)} />}
            <Kpi titulo="Insumos con saldo" valor={`${conSaldo} de ${saldos.length}`} />
            <Kpi titulo="Último conteo"
                 valor={ultimo ? corta(ultimo.fecha) : 'Nunca'}
                 nota={ultimo ? null : 'todo arranca en cero'}
                 alerta={!ultimo} />
            <Kpi titulo="Con problema"
                 valor={negativos + sinPrecio === 0 ? 'Ninguno' : String(negativos + sinPrecio)}
                 nota={negativos ? `${negativos} en negativo` : sinPrecio ? `${sinPrecio} sin precio` : null}
                 alerta={negativos + sinPrecio > 0} />
          </div>

          {primeraVez && (
            filas.some(f => Number(f.saldo) !== 0) ? (
              <Nota color={AMBAR} fondo="#FAEEDA">
                Aún no has hecho un conteo físico de esta finca. El saldo de arriba viene de los
                ingresos registrados. Cuando cuentes la bodega con <b>Cargar inventario inicial</b>,
                ese conteo fija el punto de partida.
              </Nota>
            ) : (
              <Nota color={AMBAR} fondo="#FAEEDA">
                Todavía no se ha contado la bodega de esta finca, así que todo está en cero.
                Cuenta lo que hay y guárdalo con <b>Cargar inventario inicial</b>. De ahí en adelante
                el saldo se lleva solo: baja con lo que se aplica en las piscinas y sube con lo que entra.
              </Nota>
            )
          )}

          {negativos > 0 && (
            <Nota color={ROJO} fondo="#FBEAEA">
              Hay {negativos} {negativos === 1 ? 'insumo' : 'insumos'} con saldo negativo. Eso significa
              que se registró más consumo del que entró a bodega: falta cargar un ingreso, o hay que
              volver a contar.
            </Nota>
          )}
        </>
      )}

      {cargando ? (
        <Caja><div style={{ padding: '34px', textAlign: 'center', fontSize: '13px', color: GRIS }}>
          Cargando...
        </div></Caja>

      ) : contando ? (
        <Caja>
          {editToma && (
            <div style={{ padding: '11px 16px', background: '#E6F1FB', color: AZUL, fontSize: '13px',
                          borderBottom: '0.5px solid ' + BORDE }}>
              Editando el conteo del {corta(editToma.fecha)}. Cambia las cantidades y guarda.
            </div>
          )}
          <div style={{ padding: '15px 16px', borderBottom: '0.5px solid ' + BORDE,
                        display: 'flex', gap: '16px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <Etiqueta>Fecha del conteo</Etiqueta>
              <input type="date" value={fecha} max={hoyISO()}
                     onChange={e => setFecha(e.target.value)} style={entrada} />
            </div>
            <div style={{ flex: 1, minWidth: '240px' }}>
              <Etiqueta>Observación</Etiqueta>
              <input value={obs} placeholder="Quién contó, qué se encontró"
                     onChange={e => setObs(e.target.value)} style={{ ...entrada, width: '100%' }} />
            </div>
          </div>

          {/* Agregar insumos que faltan, varios a la vez. */}
          <div style={{ padding: '12px 16px', borderBottom: '0.5px solid ' + BORDE, background: '#fbfdfe' }}>
            {nuevos.length === 0 ? (
              <button onClick={() => setNuevos([filaNueva()])} style={{ ...btnLink }}>
                + ¿Falta un insumo? {esJefeGlobal ? 'Agrégalo aquí' : 'Pídelo al jefe'}
              </button>
            ) : (
              <div>
                <div style={{ fontSize: '12px', color: GRIS, marginBottom: '8px' }}>
                  Insumos nuevos para esta bodega (puedes agregar varios):
                </div>
                {nuevos.map((n, i) => (
                  <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center',
                                        marginBottom: '7px', flexWrap: 'wrap' }}>
                    <input autoFocus={i === nuevos.length - 1} value={n.nombre}
                      placeholder="Nombre del insumo"
                      onChange={e => setNuevo(i, 'nombre', e.target.value)}
                      style={{ ...entrada, flex: 1, minWidth: '180px' }} />
                    <select value={n.unidad} onChange={e => setNuevo(i, 'unidad', e.target.value)}
                      style={{ ...entrada, width: '130px' }}>
                      {UNIDADES.map(u => <option key={u} value={u}>{UNIDAD[u]}</option>)}
                    </select>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: GRIS, cursor: 'pointer' }}>
                      <input type="checkbox" checked={n.compraDistinta}
                        onChange={e => setNuevo(i, 'compraDistinta', e.target.checked)} />
                      se compra en otra presentación
                    </label>
                    {n.compraDistinta && (
                      <>
                        <input value={n.unidadCompra} placeholder="ej. tambor"
                          onChange={e => setNuevo(i, 'unidadCompra', e.target.value)}
                          style={{ ...entrada, width: '110px' }} />
                        <input inputMode="decimal" value={n.factor} placeholder={`${UNIDAD[n.unidad]} por unidad`}
                          onChange={e => setNuevo(i, 'factor', e.target.value)}
                          style={{ ...entrada, width: '140px' }} />
                      </>
                    )}
                    <button onClick={() => setNuevos(ns => ns.filter((_, j) => j !== i))}
                      title="Quitar" style={{ border: 'none', background: 'none', cursor: 'pointer',
                        color: '#c3d0db', fontSize: '18px', lineHeight: 1 }}>×</button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' }}>
                  <button onClick={() => setNuevos(ns => [...ns, filaNueva()])} style={btnLink}>
                    + Otro insumo
                  </button>
                  <span style={{ marginLeft: 'auto' }} />
                  <Btn onClick={() => setNuevos([])}>Cancelar</Btn>
                  <Btn primario onClick={guardarNuevos}
                       disabled={guardandoNuevos || !nuevos.some(n => n.nombre.trim())}>
                    {guardandoNuevos ? (esJefeGlobal ? 'Agregando...' : 'Enviando...') : (esJefeGlobal ? 'Agregar a la lista' : 'Enviar pedido al jefe')}
                  </Btn>
                </div>
              </div>
            )}
          </div>

          <Tabla
            columnas={(primeraVez || editToma)
              ? ['Insumo', 'Unidad', '', editToma ? 'Contado' : 'Inventario inicial', '']
              : ['Insumo', 'Unidad', 'El sistema dice', 'Contado', 'Diferencia']}
            anchos="1fr 110px 130px 130px 150px"
          >
            {filas.map(f => (
              <Fila key={f.insumo_id} anchos="1fr 110px 130px 130px 150px">
                <Celda>{f.insumo}</Celda>
                <Celda gris>{UNIDAD[f.unidad] || f.unidad}</Celda>
                <Celda derecha gris>{(primeraVez || editToma) ? '' : limpio(f.saldo)}</Celda>
                <div style={{ padding: '5px 10px', borderLeft: '0.5px solid #f1f6f9' }}>
                  <input
                    inputMode="decimal" value={contado[f.insumo_id] ?? ''} placeholder="—"
                    onChange={e => setContado(c => ({ ...c, [f.insumo_id]: e.target.value }))}
                    style={{ ...entrada, width: '100%', textAlign: 'right',
                             fontVariantNumeric: 'tabular-nums' }}
                  />
                </div>
                {/* La primera vez no hay contra que comparar: es la carga
                    inicial. La diferencia aparece de la segunda en adelante. */}
                <Celda derecha color={
                  f.diferencia === null ? '#c3d0db'
                  : f.diferencia < 0 ? ROJO
                  : f.diferencia > 0 ? AMBAR : VERDE
                }>
                  {(primeraVez || editToma) ? ''
                    : f.diferencia === null ? '—'
                    : f.diferencia === 0 ? 'cuadra'
                    : (f.diferencia < 0 ? 'faltan ' : 'sobran ') + limpio(Math.abs(f.diferencia))}
                </Celda>
              </Fila>
            ))}
          </Tabla>

          <div style={{ padding: '13px 16px', borderTop: '0.5px solid ' + BORDE, background: '#fafcfd',
                        display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: GRIS, marginRight: 'auto' }}>
              {llenadas} de {saldos.length} contados
              {!primeraVez && descuadres.length > 0 && ` · ${descuadres.length} no cuadran`}
            </span>
            <Btn onClick={() => { setContando(false); setContado({}); setEditToma(null) }}>Cancelar</Btn>
            <Btn primario onClick={guardar} disabled={guardando || !llenadas}>
              {guardando ? 'Guardando...' : editToma ? 'Guardar cambios' : primeraVez ? 'Cargar inventario' : 'Guardar conteo'}
            </Btn>
          </div>
        </Caja>

      ) : vista === 'movimientos' ? (
        <>
          <Tabla
            caja min={esJefe ? '940px' : '820px'}
            columnas={['Insumo', 'Unidad', 'Inicial', 'Ingresos', 'Consumo',
                       'Ajustes', 'Conteo', 'Final', ...(esJefe ? ['Costo $'] : [])]}
            anchos={esJefe ? ANCHOS_MOV : ANCHOS_MOV_BOD}
          >
            {movs.map(m => (
              <Fila key={m.insumo_id} anchos={esJefe ? ANCHOS_MOV : ANCHOS_MOV_BOD}>
                <Celda>{m.insumo}</Celda>
                <Celda gris>{UNIDAD[m.unidad] || m.unidad}</Celda>
                <Celda derecha gris>{limpio(m.saldo_inicial)}</Celda>
                <Celda derecha color={Number(m.ingresos) ? VERDE : '#c3d0db'}>
                  {Number(m.ingresos) ? '+' + limpio(m.ingresos) : '—'}
                </Celda>
                <Celda derecha color={Number(m.consumo) ? NAVY : '#c3d0db'}>
                  {Number(m.consumo) ? '-' + limpio(m.consumo) : '—'}
                </Celda>
                <Celda derecha color={Number(m.ajustes) ? AMBAR : '#c3d0db'}>
                  {Number(m.ajustes) ? (Number(m.ajustes) > 0 ? '+' : '') + limpio(m.ajustes) : '—'}
                </Celda>
                {/* Si hubo conteo en el rango, el saldo final no es la
                    suma de los movimientos: el conteo lo fija. */}
                <Celda derecha color={m.conteo === null ? '#c3d0db' : AZUL}>
                  {m.conteo === null ? '—' : limpio(m.conteo)}
                </Celda>
                <Celda derecha fuerte color={Number(m.saldo_final) < 0 ? ROJO : NAVY}>
                  {limpio(m.saldo_final)}
                </Celda>
                {esJefe && <Celda derecha>{dinero(Number(m.consumo_dolares))}</Celda>}
              </Fila>
            ))}
            {esJefe && (
              <Fila anchos={ANCHOS_MOV} total>
                <Celda fuerte>Total</Celda>
                <Celda /><Celda /><Celda /><Celda /><Celda /><Celda /><Celda />
                <Celda derecha fuerte>
                  {dinero(movs.reduce((t, m) => t + Number(m.consumo_dolares || 0), 0))}
                </Celda>
              </Fila>
            )}
          </Tabla>

          {movs.some(m => m.conteo !== null) && (
            <Nota color={AZUL} fondo="#E6F1FB">
              En este rango se contó la bodega. Cuando eso pasa, el saldo final no es
              saldo inicial más ingresos menos consumo: el conteo lo fija. Por eso la
              columna Conteo se muestra aparte, para que la diferencia se vea en vez de
              parecer un error de cuentas.
            </Nota>
          )}
        </>

      ) : (
        <>
          <Tabla
            caja min={esJefe ? '760px' : '420px'}
            columnas={esJefe
              ? ['Insumo', 'Unidad', 'Saldo', 'Precio', 'Valor', '']
              : ['Insumo', 'Unidad', 'Saldo']}
            anchos={esJefe ? ANCHOS_SALDO_JEFE : ANCHOS_SALDO_BOD}
          >
            {filas.map(f => {
              const edit = editando === f.insumo_id
              return (
              <div key={f.insumo_id}>
                <Fila anchos={esJefe ? ANCHOS_SALDO_JEFE : ANCHOS_SALDO_BOD}>
                  <Celda>{f.insumo}</Celda>
                  <Celda gris>{UNIDAD[f.unidad] || f.unidad}</Celda>
                  {edit ? (
                    <div style={{ padding: '5px 10px', borderLeft: '0.5px solid #f6f9fb' }}>
                      <input autoFocus inputMode="decimal" value={nuevoSaldo}
                        onChange={e => setNuevoSaldo(e.target.value)}
                        style={{ ...entrada, width: '100%', textAlign: 'right',
                                 fontVariantNumeric: 'tabular-nums',
                                 borderColor: '#9cc4e8' }} />
                    </div>
                  ) : (
                    <Celda derecha fuerte color={Number(f.saldo) < 0 ? ROJO : NAVY}>
                      {limpio(f.saldo)}
                    </Celda>
                  )}
                  {/* Precio y valor en dolares: solo el jefe. */}
                  {esJefe && <Celda derecha gris>{f.precio ? dinero(f.precio) : 'sin precio'}</Celda>}
                  {esJefe && <Celda derecha>{dinero(valorFifo[f.insumo_id] || 0)}</Celda>}
                  {esJefe && (
                    <div style={{ padding: '6px 10px', borderLeft: '0.5px solid #f6f9fb',
                                  textAlign: 'right' }}>
                      {!edit && (
                        <button onClick={() => abrirCorregir(f)} style={{
                          background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '8px',
                          padding: '5px 11px', fontFamily: 'inherit', fontSize: '12px',
                          color: GRIS, cursor: 'pointer' }}>
                          Corregir
                        </button>
                      )}
                    </div>
                  )}
                </Fila>

                {edit && (
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center',
                                padding: '10px 14px', background: '#f6f9fb', flexWrap: 'wrap',
                                borderBottom: '0.5px solid #f1f6f9' }}>
                    <span style={{ fontSize: '12px', color: GRIS }}>
                      De {limpio(f.saldo)} a {limpio(Number(String(nuevoSaldo).replace(',', '.')) || 0)}.
                      Motivo:
                    </span>
                    <input value={motivo} autoFocus={false}
                      placeholder="Por qué se corrige — queda en la bitácora"
                      onChange={e => setMotivo(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && guardarCorreccion(f)}
                      style={{ ...entrada, flex: 1, minWidth: '240px' }} />
                    <Btn onClick={() => setEditando(null)}>Cancelar</Btn>
                    <Btn primario onClick={() => guardarCorreccion(f)} disabled={guardandoAj}>
                      {guardandoAj ? 'Guardando...' : 'Guardar corrección'}
                    </Btn>
                  </div>
                )}
              </div>
            )})}
            {esJefe && (
              <Fila anchos={ANCHOS_SALDO_JEFE} total>
                <Celda fuerte>Total</Celda>
                <Celda /><Celda /><Celda />
                <Celda derecha fuerte>{dinero(valorBodega)}</Celda>
                <Celda />
              </Fila>
            )}
          </Tabla>

          {conteos.length > 0 && (
            <div style={{ marginTop: '18px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 4px' }}>Conteos anteriores</h3>
              <p style={{ fontSize: '13px', color: GRIS, margin: '0 0 11px' }}>
                El saldo de arriba se calcula desde el más reciente.
              </p>
              <Tabla caja columnas={esJefe ? ['Fecha', 'Observación', ''] : ['Fecha', 'Observación']}
                     anchos={esJefe ? '150px 1fr 160px' : '150px 1fr'}>
                {conteos.map(c => (
                  <Fila key={c.id} anchos={esJefe ? '150px 1fr 160px' : '150px 1fr'}>
                    <Celda fuerte>{corta(c.fecha)}</Celda>
                    <Celda gris>{c.observacion || 'Sin observación'}</Celda>
                    {esJefe && (
                      <div style={{ padding: '6px 10px', textAlign: 'right', display: 'flex', gap: '7px', justifyContent: 'flex-end' }}>
                        <button onClick={() => editarConteo(c)}
                          style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '8px',
                                   padding: '5px 11px', fontFamily: 'inherit', fontSize: '12px',
                                   color: NAVY, cursor: 'pointer' }}>Editar</button>
                        <button onClick={() => borrarConteo(c)}
                          style={{ background: 'white', border: '0.5px solid #e7cccb', borderRadius: '8px',
                                   padding: '5px 11px', fontFamily: 'inherit', fontSize: '12px',
                                   color: ROJO, cursor: 'pointer' }}>Borrar</button>
                      </div>
                    )}
                  </Fila>
                ))}
              </Tabla>
            </div>
          )}
        </>
      )}
      </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Piezas de tabla
// ---------------------------------------------------------------------
function Tabla({ columnas, anchos, children, caja, min }) {
  const cuerpo = (
    <div style={{ minWidth: min || 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: anchos,
                    background: '#f6f9fb', borderBottom: '0.5px solid ' + BORDE }}>
        {columnas.map((c, i) => (
          <div key={c} style={{ padding: '10px 12px', fontSize: '11px', fontWeight: 500,
                  color: GRIS, letterSpacing: '0.02em', textTransform: 'uppercase',
                  textAlign: i >= 2 ? 'right' : 'left',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {c}
          </div>
        ))}
      </div>
      {children}
    </div>
  )
  if (!caja) return cuerpo
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                  overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>{cuerpo}</div>
    </div>
  )
}

function Fila({ anchos, children, total }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: anchos, alignItems: 'center',
                  borderBottom: total ? 'none' : '0.5px solid #f1f6f9',
                  borderTop: total ? '0.5px solid ' + BORDE : 'none',
                  background: total ? '#fafcfd' : 'white' }}>
      {children}
    </div>
  )
}

function Celda({ children, derecha, gris, fuerte, color }) {
  return (
    <div style={{ padding: '10px 12px', fontSize: '13px',
                  textAlign: derecha ? 'right' : 'left',
                  color: color || (gris ? GRIS : NAVY),
                  fontWeight: fuerte ? 500 : 400,
                  fontVariantNumeric: derecha ? 'tabular-nums' : 'normal' }}>
      {children}
    </div>
  )
}

function Kpi({ titulo, valor, nota, alerta }) {
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + (alerta ? '#e8d5b0' : BORDE),
                  borderRadius: '12px', padding: '13px 15px' }}>
      <div style={{ fontSize: '11px', color: GRIS, marginBottom: '5px',
                    letterSpacing: '0.03em', textTransform: 'uppercase' }}>{titulo}</div>
      <div style={{ fontSize: '20px', fontWeight: 500, fontVariantNumeric: 'tabular-nums',
                    color: alerta ? AMBAR : NAVY }}>{valor}</div>
      {nota && <div style={{ fontSize: '11px', color: GRIS, marginTop: '3px' }}>{nota}</div>}
    </div>
  )
}

function Chip({ children, on, pequeno, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: pequeno ? '6px 12px' : '8px 15px', borderRadius: '20px',
      fontFamily: 'inherit', fontSize: pequeno ? '12px' : '13px', cursor: 'pointer',
      border: '0.5px solid ' + (on ? '#9cc4e8' : BORDE),
      background: on ? '#E6F1FB' : 'white',
      color: on ? AZUL : NAVY, fontWeight: on ? 500 : 400,
    }}>{children}</button>
  )
}

function Nota({ children, color, fondo }) {
  return (
    <div style={{ background: fondo, color, borderRadius: '10px', padding: '13px 15px',
                  fontSize: '13px', marginBottom: '12px', lineHeight: 1.6 }}>
      {children}
    </div>
  )
}

function Caja({ children }) {
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                  overflow: 'hidden' }}>{children}</div>
  )
}

function Etiqueta({ children }) {
  return <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>{children}</div>
}

function Btn({ children, primario, ...props }) {
  return (
    <button {...props} style={{
      padding: '9px 17px', fontSize: '13px', fontFamily: 'inherit', fontWeight: 500,
      borderRadius: '9px', cursor: props.disabled ? 'default' : 'pointer',
      border: '0.5px solid ' + (primario ? AZUL : BORDE),
      background: primario ? AZUL : 'white',
      color: primario ? 'white' : NAVY,
      opacity: props.disabled ? 0.45 : 1,
    }}>{children}</button>
  )
}

// Los insumos vienen en unidades muy distintas: 40 sacos y 0,0265
// gramos. Mostrar siempre cuatro decimales llenaria la tabla de ceros.
function limpio(n) {
  const v = Number(n)
  if (!isFinite(v)) return '—'
  const s = v.toFixed(4).replace(/\.?0+$/, '')
  return s === '' || s === '-' ? '0' : s
}

const entrada = { padding: '8px 11px', fontSize: '13px', fontFamily: 'inherit',
                  border: '0.5px solid ' + BORDE, borderRadius: '9px',
                  boxSizing: 'border-box', background: 'white' }
const btnLink = { background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  fontFamily: 'inherit', fontSize: '13px', color: AZUL, fontWeight: 500 }
