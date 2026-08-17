import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import {
  LIBRAS_POR_SACO, hoyISO, lunesDe, sumarDias, semanaDe, semanaISO, corta, num, miles, dinero,
} from '../lib/fechas'

// Costos · banda 3 del Excel
//
// Todo aqui es calculo. El unico dato almacenado es el precio del saco
// que se congelo al registrar cada dia (regla P3), asi que cambiar un
// precio hoy no mueve estos numeros.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'

export default function Costos({ finca, esJefe, lunes, setLunes }) {
  const [filas, setFilas] = useState([])
  const [productos, setProductos] = useState([])
  const [acumulado, setAcumulado] = useState({})
  const [anual, setAnual] = useState(0)
  const [sacosAnual, setSacosAnual] = useState(0)
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [precios, setPrecios] = useState([])
  const [editando, setEditando] = useState(null)   // { producto, precioActual }
  const [sacos, setSacos] = useState({})           // productoId -> consumo en sacos
  const [sacosPre, setSacosPre] = useState({})     // productoId -> consumo de precrias
  const [inv, setInv] = useState({})               // productoId -> fila de inventario
  const [arrastre, setArrastre] = useState(null)   // productoId -> saldo final de la semana anterior
  const [guardandoInv, setGuardandoInv] = useState(false)

  const fechas = useMemo(() => semanaDe(lunes), [lunes])
  const hoy = hoyISO()

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    try {
      const domingo = fechas[6]

      const { data: piscinas } = await supabase
        .schema('produccion').from('piscina')
        .select('id, codigo, nombre, hectareas, tipo')
        .eq('finca_id', finca.id).eq('activa', true)

      const ids = (piscinas || []).map(p => p.id)
      if (!ids.length) { setFilas([]); return }

      // La vista ya trae el costo calculado con el precio congelado.
      const { data: sem, error } = await supabase
        .schema('produccion').from('vw_alimentacion_costeada')
        .select('piscina_id, ciclo_id, producto_id, libras, costo, sacos')
        .in('piscina_id', ids).gte('fecha', lunes).lte('fecha', domingo)
      if (error) throw error

      const { data: prods } = await supabase
        .schema('produccion').from('producto')
        .select('id, nombre, nombre_corto').order('nombre_corto')

      // Solo los productos que esta finca uso esta semana.
      const usados = new Set((sem || []).map(r => r.producto_id))
      setProductos((prods || []).filter(p => usados.has(p.id)))

      const esPrecria = {}
      ;(piscinas || []).forEach(p => { esPrecria[p.id] = p.tipo === 'precria' })
      const sc = {}, scp = {}
      ;(sem || []).forEach(r => {
        sc[r.producto_id] = (sc[r.producto_id] || 0) + Number(r.sacos)
        if (esPrecria[r.piscina_id]) scp[r.producto_id] = (scp[r.producto_id] || 0) + Number(r.sacos)
      })
      setSacos(sc); setSacosPre(scp)

      const porPiscina = {}
      ;(sem || []).forEach(r => {
        const f = porPiscina[r.piscina_id] || (porPiscina[r.piscina_id] = { libras: 0, costo: 0, sacos: 0, prod: {} })
        f.libras += Number(r.libras); f.costo += Number(r.costo); f.sacos += Number(r.sacos)
        f.prod[r.producto_id] = (f.prod[r.producto_id] || 0) + Number(r.costo)
      })

      const lista = (piscinas || [])
        .filter(p => porPiscina[p.id])
        .map(p => ({ ...p, ...porPiscina[p.id] }))
        .sort(ordenar)
      setFilas(lista)

      // Acumulado del ciclo de cada piscina.
      const ciclos = [...new Set((sem || []).map(r => r.ciclo_id))]
      const acum = {}
      if (ciclos.length) {
        const { data: hist } = await supabase
          .schema('produccion').from('vw_alimentacion_costeada')
          .select('piscina_id, costo').in('ciclo_id', ciclos).lte('fecha', domingo)
        ;(hist || []).forEach(r => { acum[r.piscina_id] = (acum[r.piscina_id] || 0) + Number(r.costo) })
      }
      setAcumulado(acum)

      const { anio: an, semana: se } = semanaISO(lunes)
      const { data: invRows } = await supabase
        .schema('produccion').from('inventario_saco')
        .select('*').eq('finca_id', finca.id).eq('anio', an).eq('semana', se)
      const mi = {}
      ;(invRows || []).forEach(r => { mi[r.producto_id] = r })
      setInv(mi)

      // El saldo inicial no se teclea: es el saldo final de la semana
      // anterior. Si al contar no cuadra, la diferencia va como ajuste.
      const lunesPrevio = sumarDias(lunes, -7)
      const { anio: anP, semana: seP } = semanaISO(lunesPrevio)
      const { data: invPrev } = await supabase
        .schema('produccion').from('inventario_saco')
        .select('*').eq('finca_id', finca.id).eq('anio', anP).eq('semana', seP)

      if (!invPrev || !invPrev.length) {
        setArrastre(null)     // primera semana: hay que contar la bodega
      } else {
        const { data: consPrev } = await supabase
          .schema('produccion').from('vw_alimentacion_costeada')
          .select('producto_id, sacos').in('piscina_id', ids)
          .gte('fecha', lunesPrevio).lte('fecha', sumarDias(lunesPrevio, 6))
        const cp = {}
        ;(consPrev || []).forEach(r => { cp[r.producto_id] = (cp[r.producto_id] || 0) + Number(r.sacos) })

        const arr = {}
        invPrev.forEach(r => {
          arr[r.producto_id] = Number(r.saldo_inicial || 0) + Number(r.entradas_recibidas || 0)
                             + Number(r.ajustes || 0) - (cp[r.producto_id] || 0)
        })
        setArrastre(arr)
      }

      // Precios vigentes de esta finca, para el panel de abajo.
      const { data: pr } = await supabase
        .schema('produccion').from('precio_producto')
        .select('id, precio_saco, vigente_desde, producto:producto_id (id, nombre, nombre_corto, activo)')
        .eq('finca_id', finca.id).is('vigente_hasta', null)
      setPrecios((pr || [])
        .filter(x => x.producto?.activo)
        .sort((a, b) => a.producto.nombre_corto.localeCompare(b.producto.nombre_corto)))

      const { data: anio } = await supabase
        .schema('produccion').from('vw_alimentacion_costeada')
        .select('costo, sacos').in('piscina_id', ids)
        .gte('fecha', lunes.slice(0, 4) + '-01-01').lte('fecha', domingo)
      setAnual((anio || []).reduce((s, r) => s + Number(r.costo), 0))
      setSacosAnual((anio || []).reduce((s, r) => s + Number(r.sacos), 0))
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally {
      setCargando(false)
    }
  }, [finca.id, lunes, fechas])

  useEffect(() => { cargar() }, [cargar])

  const totalCosto = filas.reduce((s, f) => s + f.costo, 0)
  const totalLibras = filas.reduce((s, f) => s + f.libras, 0)
  const totalSacos = filas.reduce((s, f) => s + f.sacos, 0)
  const porProducto = {}
  filas.forEach(f => Object.entries(f.prod).forEach(([id, c]) => {
    porProducto[id] = (porProducto[id] || 0) + c
  }))
  const masUsado = Object.entries(porProducto).sort((a, b) => b[1] - a[1])[0]

  // Regla P3: el precio nuevo rige desde su fecha hacia adelante. El
  // anterior se cierra el dia previo, asi no se pisan y las semanas ya
  // registradas conservan el costo con el que se guardaron.
  async function cambiarPrecio(productoId, nuevo, desde) {
    const { error: e1 } = await supabase.schema('produccion').from('precio_producto')
      .update({ vigente_hasta: sumarDias(desde, -1) })
      .eq('finca_id', finca.id).eq('producto_id', productoId).is('vigente_hasta', null)
    if (e1) throw e1
    const { error: e2 } = await supabase.schema('produccion').from('precio_producto')
      .insert({ finca_id: finca.id, producto_id: productoId,
                precio_saco: nuevo, vigente_desde: desde })
    if (e2) throw e2
  }

  async function guardarPrecio({ productoId, nuevo, desde }) {
    try {
      await cambiarPrecio(productoId, nuevo, desde)
      setEditando(null)
      setAviso({ tipo: 'ok', texto: 'Precio actualizado. Rige desde el ' + corta(desde) + '.' })
      await cargar()
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cambiar el precio. ' + (err.message || '') })
    }
  }

  function setInvCampo(productoId, campo, valor) {
    setInv(x => ({ ...x, [productoId]: { ...(x[productoId] || {}), [campo]: valor } }))
  }

  // Si hay semana anterior, el saldo inicial viene de ella y no se toca.
  const saldoInicial = pid =>
    arrastre ? (arrastre[pid] || 0) : (num(inv[pid]?.saldo_inicial) || 0)

  const saldoFinal = pid =>
    saldoInicial(pid) + (num(inv[pid]?.entradas_recibidas) || 0)
    + (num(inv[pid]?.ajustes) || 0) - (sacos[pid] || 0)

  async function guardarInventario() {
    setGuardandoInv(true); setAviso(null)
    try {
      const { anio, semana } = semanaISO(lunes)
      const filasInv = productos.map(p => {
        const r = inv[p.id] || {}
        return {
          finca_id: finca.id, producto_id: p.id, anio, semana,
          saldo_inicial: saldoInicial(p.id),
          entradas_recibidas: num(r.entradas_recibidas) || 0,
          ajustes: num(r.ajustes) || 0,
          motivo_ajuste: r.motivo_ajuste || null,
        }
      })
      const { error } = await supabase.schema('produccion').from('inventario_saco')
        .upsert(filasInv, { onConflict: 'finca_id,producto_id,anio,semana' })
      if (error) throw error
      setAviso({ tipo: 'ok', texto: 'Inventario guardado' })
      await cargar()
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo guardar el inventario. ' + (err.message || '') })
    } finally {
      setGuardandoInv(false)
    }
  }

  const precioDe = {}
  precios.forEach(x => { precioDe[x.producto.id] = Number(x.precio_saco) })

  const COLS = `170px ${productos.map(() => '132px').join(' ')} 116px 124px`
  const COLS_SACOS = `210px ${productos.map(() => '132px').join(' ')} 116px`

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY, padding: '1.4rem 1.4rem 4rem' }}>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                    gap: '18px', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 500, margin: '0 0 5px' }}>Costos</h1>
          <div style={{ fontSize: '13px', color: GRIS }}>
            Semana del {corta(lunes)} al {corta(fechas[6])} · con el precio vigente cada día
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <Btn onClick={() => setLunes(sumarDias(lunes, -7))}>‹</Btn>
          <Btn onClick={() => setLunes(lunesDe(hoy))}>Esta semana</Btn>
          <Btn onClick={() => setLunes(sumarDias(lunes, 7))} disabled={lunes >= lunesDe(hoy)}>›</Btn>
          <input type="date" value={lunes} max={hoy}
                 onChange={e => e.target.value && setLunes(lunesDe(e.target.value))}
                 style={{ padding: '8px 10px', fontSize: '13px', fontFamily: 'inherit',
                          border: '0.5px solid ' + BORDE, borderRadius: '9px', color: NAVY }} />
        </div>
      </div>

      {aviso && (
        <div style={{ padding: '10px 14px', borderRadius: '9px', marginBottom: '10px', fontSize: '13px',
          background: aviso.tipo === 'error' ? '#FCEBEB' : '#EAF3DE',
          color: aviso.tipo === 'error' ? '#A32D2D' : '#3B6D11' }}>{aviso.texto}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: '11px', marginBottom: '12px' }}>
        <Kpi k="Costo de la semana" v={dinero(totalCosto)} />
        <Kpi k="Costo por libra aplicada" v={totalLibras ? dinero(totalCosto / totalLibras) : '—'} />
        <Kpi k="Sacos de la semana" v={miles(totalSacos)} s={`${miles(totalLibras)} lb`} />
        <Kpi k="Acumulado del año" v={dinero(anual)} s={`${miles(sacosAnual)} sacos`} />
      </div>

      {cargando ? (
        <Vacio>Cargando...</Vacio>
      ) : !filas.length ? (
        <Vacio>No hay alimentación registrada en esta semana.</Vacio>
      ) : (
        <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 170 + productos.length * 112 + 344 + 'px' }}>

              <div style={{ display: 'grid', gridTemplateColumns: COLS, background: '#fafcfd',
                            borderBottom: '0.5px solid ' + BORDE }}>
                <Th pegado>Piscina</Th>
                {productos.map(p => (
                  <Th key={p.id} titulo={p.nombre}>
                    <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end',
                                  justifyContent: 'center', paddingBottom: '6px' }}>
                      {p.nombre}
                    </div>
                    <div style={{ borderTop: '0.5px solid #e8eef4', paddingTop: '5px' }}>
                      {precioDe[p.id] ? (
                        <>
                          <div style={{ color: AZUL, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                            {dinero(precioDe[p.id])}
                          </div>
                          <div style={{ color: GRIS, fontWeight: 400, fontVariantNumeric: 'tabular-nums' }}>
                            {dinero(precioDe[p.id] / LIBRAS_POR_SACO)} lb
                          </div>
                        </>
                      ) : <div style={{ color: '#c3d0db' }}>sin precio</div>}
                    </div>
                  </Th>
                ))}
                <Th>Costo semana</Th>
                <Th>Acumulado del ciclo</Th>
              </div>

              {filas.map(f => (
                <div key={f.id} style={{ display: 'grid', gridTemplateColumns: COLS,
                      borderBottom: '0.5px solid #f1f6f9', alignItems: 'center' }}>
                  <Td pegado alineado="left">
                    <span style={{ fontWeight: 500, fontSize: '14px' }}>{f.nombre}</span>
                    <div style={{ fontSize: '11px', color: GRIS }}>
                      {Number(f.hectareas).toFixed(2)} ha{f.tipo === 'precria' && ' · precría'}
                    </div>
                  </Td>
                  {productos.map(p => (
                    <Td key={p.id}>
                      <span style={{ color: f.prod[p.id] ? NAVY : '#c3d0db' }}>
                        {f.prod[p.id] ? dinero(f.prod[p.id]) : '—'}
                      </span>
                    </Td>
                  ))}
                  <Td><span style={{ fontWeight: 500 }}>{dinero(f.costo)}</span></Td>
                  <Td><span style={{ color: GRIS }}>{dinero(acumulado[f.id] || 0)}</span></Td>
                </div>
              ))}

              <div style={{ display: 'grid', gridTemplateColumns: COLS, background: '#fafcfd',
                            borderTop: '0.5px solid ' + BORDE, alignItems: 'center' }}>
                <Td pegado alineado="left" fondo="#fafcfd">
                  <span style={{ fontWeight: 500, fontSize: '14px' }}>Total</span>
                  <div style={{ fontSize: '11px', color: GRIS }}>{filas.length} piscinas</div>
                </Td>
                {productos.map(p => (
                  <Td key={p.id} fondo="#fafcfd">
                    <span style={{ fontWeight: 500 }}>{porProducto[p.id] ? dinero(porProducto[p.id]) : '—'}</span>
                  </Td>
                ))}
                <Td fondo="#fafcfd"><span style={{ fontWeight: 500, fontSize: '15px' }}>{dinero(totalCosto)}</span></Td>
                <Td fondo="#fafcfd" />
              </div>
            </div>
          </div>

          <div style={{ padding: '13px 16px', borderTop: '0.5px solid ' + BORDE,
                        background: '#fafcfd', fontSize: '13px', color: GRIS }}>
            La suma de los costos por producto tiene que dar el costo total. Es la
            validación V2, la que en el Excel no cuadraba.
            {masUsado && productos.find(p => p.id === masUsado[0]) && (
              <> El producto de mayor peso esta semana es{' '}
                <b style={{ color: NAVY, fontWeight: 500 }}>
                  {productos.find(p => p.id === masUsado[0]).nombre_corto}
                </b>, con {Math.round(masUsado[1] / totalCosto * 100)}% del costo.</>
            )}
          </div>
        </div>
      )}

      {!!productos.length && (
        <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                      marginTop: '12px', overflow: 'hidden' }}>
          <div style={{ padding: '16px 18px 12px' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 4px' }}>Control de sacos</h3>
            <p style={{ fontSize: '13px', color: GRIS, margin: 0 }}>
              Saldo final = saldo inicial + pedido semanal + ajustes − consumo.
              El saldo inicial es el saldo final de la semana anterior: no se teclea.
              Si al contar la bodega no cuadra, la diferencia va como ajuste.
            </p>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 210 + productos.length * 132 + 116 + 'px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: COLS_SACOS, background: '#fafcfd',
                            borderBottom: '0.5px solid ' + BORDE }}>
                <Th pegado>Concepto</Th>
                {productos.map(p => <Th key={p.id} titulo={p.nombre}>{p.nombre}</Th>)}
                <Th>Total</Th>
              </div>

              {arrastre ? (
                <FilaSacos etiqueta="Saldo inicial" productos={productos}
                  nota="viene de la semana anterior"
                  calculado={p => saldoInicial(p.id)} />
              ) : (
                <FilaSacos etiqueta="Saldo inicial" productos={productos} editable={esJefe}
                  nota="primera semana: cuenta la bodega"
                  valor={p => inv[p.id]?.saldo_inicial ?? ''}
                  onChange={(p, v) => setInvCampo(p.id, 'saldo_inicial', v)} />
              )}

              <FilaSacos etiqueta="Pedido semanal" productos={productos} editable={esJefe}
                valor={p => inv[p.id]?.entradas_recibidas ?? ''}
                onChange={(p, v) => setInvCampo(p.id, 'entradas_recibidas', v)} />

              <FilaSacos etiqueta="Consumo de la semana" productos={productos}
                calculado={p => sacos[p.id] || 0} />

              <FilaSacos etiqueta="Consumo de precrías" productos={productos}
                calculado={p => sacosPre[p.id] || 0} />

              <FilaSacos etiqueta="Ajustes" productos={productos} editable={esJefe}
                valor={p => inv[p.id]?.ajustes ?? ''}
                onChange={(p, v) => setInvCampo(p.id, 'ajustes', v)} />

              <FilaSacos etiqueta="Saldo final" resaltado productos={productos}
                calculado={p => saldoFinal(p.id)} />

            </div>
          </div>

          {esJefe && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '13px 18px',
                          borderTop: '0.5px solid ' + BORDE, background: '#fafcfd' }}>
              <Btn primario onClick={guardarInventario} disabled={guardandoInv}>
                {guardandoInv ? 'Guardando...' : 'Guardar inventario'}
              </Btn>
            </div>
          )}
        </div>
      )}

      <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px',
                    padding: '16px 18px', marginTop: '12px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 500, margin: '0 0 4px' }}>Precios vigentes</h3>
        <p style={{ fontSize: '13px', color: GRIS, margin: '0 0 14px' }}>
          Precio por saco de 55 libras en {String(finca.nombre).toUpperCase()}.
          {esJefe
            ? ' Al cambiarlo, rige desde la fecha que elijas hacia adelante: las semanas ya registradas conservan el precio con el que se guardaron.'
            : ' Solo un jefe puede cambiarlos.'}
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px,1fr) 100px 96px 132px 130px',
                      gap: '12px', padding: '0 0 8px', fontSize: '11px', color: GRIS }}>
          <div>Producto</div>
          <div style={{ textAlign: 'right' }}>Por saco</div>
          <div style={{ textAlign: 'right' }}>Por libra</div>
          <div>Vigente desde</div>
          <div />
        </div>

        {precios.map(p => (
          <div key={p.id} style={{ borderBottom: '0.5px solid #f1f6f9', padding: '9px 0' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px,1fr) 100px 96px 132px 130px',
                          gap: '12px', alignItems: 'center' }}>
              <span style={{ fontWeight: 500, fontSize: '14px' }}>{p.producto.nombre}</span>
              <span style={{ fontSize: '16px', fontWeight: 500, textAlign: 'right',
                             fontVariantNumeric: 'tabular-nums' }}>
                {dinero(p.precio_saco)}
              </span>
              <span style={{ fontSize: '13px', color: GRIS, textAlign: 'right',
                             fontVariantNumeric: 'tabular-nums' }}>
                {dinero(p.precio_saco / LIBRAS_POR_SACO)}
              </span>
              <span style={{ fontSize: '13px', color: GRIS }}>{corta(p.vigente_desde)}</span>
              {esJefe ? (
                <button
                  onClick={() => setEditando(editando?.id === p.id ? null : p)}
                  style={{ background: 'white', border: '0.5px solid ' + BORDE,
                           borderRadius: '9px', padding: '7px 13px', fontFamily: 'inherit',
                           fontSize: '13px', color: NAVY, cursor: 'pointer' }}>
                  {editando?.id === p.id ? 'Cancelar' : 'Cambiar precio'}
                </button>
              ) : <span />}
            </div>
            {editando?.id === p.id && (
              <FormaPrecio actual={p} onGuardar={guardarPrecio} />
            )}
          </div>
        ))}

        {!precios.length && (
          <div style={{ fontSize: '13px', color: GRIS }}>
            Esta finca no tiene precios cargados.
          </div>
        )}
      </div>
    </div>
  )
}

function FormaPrecio({ actual, onGuardar }) {
  const [nuevo, setNuevo] = useState(String(actual.precio_saco))
  const [desde, setDesde] = useState(hoyISO())
  const [enviando, setEnviando] = useState(false)
  const v = num(nuevo)
  const cambio = v && v !== Number(actual.precio_saco)
  const diferencia = v ? v - Number(actual.precio_saco) : 0

  return (
    <div style={{ background: '#f7fafc', borderRadius: '10px', padding: '14px', marginTop: '10px' }}>
      <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Precio nuevo por saco</div>
          <input inputMode="decimal" value={nuevo} onChange={e => setNuevo(e.target.value)}
            style={{ padding: '9px 11px', fontSize: '15px', fontFamily: 'inherit', width: '130px',
                     border: '0.5px solid ' + BORDE, borderRadius: '9px', textAlign: 'right',
                     fontVariantNumeric: 'tabular-nums' }} />
        </div>
        <div>
          <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>Rige desde</div>
          <input type="date" value={desde} onChange={e => setDesde(e.target.value)}
            style={{ padding: '9px 11px', fontSize: '14px', fontFamily: 'inherit',
                     border: '0.5px solid ' + BORDE, borderRadius: '9px' }} />
        </div>
        <button
          disabled={!cambio || enviando}
          onClick={async () => {
            setEnviando(true)
            await onGuardar({ productoId: actual.producto.id, nuevo: v, desde })
            setEnviando(false)
          }}
          style={{ background: AZUL, color: 'white', border: 'none', borderRadius: '9px',
                   padding: '10px 20px', fontFamily: 'inherit', fontSize: '14px', fontWeight: 500,
                   cursor: (!cambio || enviando) ? 'default' : 'pointer',
                   opacity: (!cambio || enviando) ? 0.45 : 1 }}>
          {enviando ? 'Guardando...' : 'Aplicar'}
        </button>
      </div>
      {cambio && (
        <div style={{ fontSize: '13px', color: GRIS, marginTop: '11px' }}>
          {diferencia > 0 ? 'Sube' : 'Baja'}{' '}
          <b style={{ color: NAVY, fontWeight: 500 }}>{dinero(Math.abs(diferencia))}</b> por saco,
          de {dinero(actual.precio_saco / LIBRAS_POR_SACO)} a {dinero(v / LIBRAS_POR_SACO)} por libra.
          Los días anteriores al {corta(desde)} no cambian.
        </div>
      )}
    </div>
  )
}

function FilaSacos({ etiqueta, productos, editable, valor, onChange, calculado, resaltado, nota }) {
  const COLS = `210px ${productos.map(() => '132px').join(' ')} 116px`
  const total = calculado
    ? productos.reduce((s, p) => s + (calculado(p) || 0), 0)
    : productos.reduce((s, p) => s + (num(valor(p)) || 0), 0)
  const fondo = resaltado ? '#fafcfd' : 'white'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center',
                  borderBottom: '0.5px solid #f1f6f9', background: fondo }}>
      <Td pegado alineado="left" fondo={fondo}>
        <span style={{ fontSize: '13px', fontWeight: resaltado ? 500 : 400 }}>{etiqueta}</span>
        {nota && <div style={{ fontSize: '11px', color: GRIS, marginTop: '2px' }}>{nota}</div>}
      </Td>
      {productos.map(p => (
        <Td key={p.id} fondo={fondo}>
          {calculado ? (
            <span style={{ fontWeight: resaltado ? 500 : 400,
                           color: calculado(p) < 0 ? '#A32D2D' : (calculado(p) ? NAVY : '#c3d0db') }}>
              {calculado(p) ? Math.round(calculado(p) * 10) / 10 : '—'}
            </span>
          ) : editable ? (
            <input inputMode="decimal" value={valor(p)} placeholder="0"
              onChange={e => onChange(p, e.target.value)}
              style={{ width: '100%', padding: '6px', fontSize: '14px', textAlign: 'center',
                       fontFamily: 'inherit', border: '0.5px solid ' + BORDE, borderRadius: '7px',
                       fontVariantNumeric: 'tabular-nums' }} />
          ) : (
            <span style={{ color: valor(p) ? NAVY : '#c3d0db' }}>{valor(p) || '—'}</span>
          )}
        </Td>
      ))}
      <Td fondo={fondo}>
        <span style={{ fontWeight: 500, color: total < 0 ? '#A32D2D' : NAVY }}>
          {Math.round(total * 10) / 10}
        </span>
      </Td>
    </div>
  )
}

function Kpi({ k, v, s }) {
  return (
    <div style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '14px 16px' }}>
      <div style={{ fontSize: '11px', color: GRIS, marginBottom: '4px' }}>{k}</div>
      <div style={{ fontSize: '23px', fontWeight: 500 }}>{v}</div>
      {s && <div style={{ fontSize: '12px', color: GRIS, marginTop: '2px' }}>{s}</div>}
    </div>
  )
}

function Th({ children, pegado, titulo }) {
  return (
    <div title={titulo} style={{
      padding: '10px 9px', fontSize: '11px', color: GRIS, fontWeight: 500, textAlign: 'center',
      background: '#fafcfd', lineHeight: 1.3,
      display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
      ...(pegado ? { position: 'sticky', left: 0, zIndex: 3, textAlign: 'left',
                     paddingLeft: '16px', borderRight: '0.5px solid ' + BORDE } : {}),
    }}>{children}</div>
  )
}

function Td({ children, pegado, fondo, alineado }) {
  return (
    <div style={{
      padding: '9px', textAlign: alineado || 'center', fontSize: '13px',
      fontVariantNumeric: 'tabular-nums', background: fondo || 'white',
      ...(pegado ? { position: 'sticky', left: 0, zIndex: 2, paddingLeft: '16px',
                     borderRight: '0.5px solid ' + BORDE } : {}),
    }}>{children}</div>
  )
}

function Btn({ children, onClick, primario, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: primario ? AZUL : 'white', color: primario ? 'white' : NAVY,
      border: '0.5px solid ' + (primario ? AZUL : BORDE), borderRadius: '9px',
      padding: '9px 14px', fontFamily: 'inherit', fontSize: '13px',
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
    }}>{children}</button>
  )
}

function Vacio({ children }) {
  return (
    <div style={{ padding: '3rem 1rem', textAlign: 'center', border: '0.5px dashed ' + BORDE,
                  borderRadius: '12px', color: GRIS, fontSize: '14px', background: 'white' }}>
      {children}
    </div>
  )
}

function ordenar(a, b) {
  if (a.tipo !== b.tipo) return a.tipo === 'precria' ? 1 : -1
  return (parseInt(a.codigo.replace(/\D/g, ''), 10) || 0) - (parseInt(b.codigo.replace(/\D/g, ''), 10) || 0)
}
