import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, corta, diasCultivo, num, miles } from '../lib/fechas'

// Ciclos y eventos · modulo Produccion
//
// Los cuatro eventos del glosario:
//   Siembra        abre el ciclo
//   Raleo          cosecha parcial, el ciclo sigue vivo
//   Transferencia  el camaron pasa a otras piscinas, el ciclo se arrastra
//   Cosecha        cierra el ciclo
//
// Sin esta pantalla una piscina cosechada seguiria pidiendo comida para
// siempre y una piscina resembrada no volveria a aparecer nunca.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'

const TIPOS = {
  siembra:       { nombre: 'Siembra',       color: '#1D9E75', fondo: '#E1F5EE' },
  raleo:         { nombre: 'Raleo',         color: '#BA7517', fondo: '#FAEEDA' },
  transferencia: { nombre: 'Transferencia', color: '#534AB7', fondo: '#EEEDFE' },
  cosecha:       { nombre: 'Cosecha',       color: '#185FA5', fondo: '#E6F1FB' },
}

export default function Eventos({ finca, esJefe, soloLectura }) {
  const [ciclos, setCiclos] = useState([])
  const [vacias, setVacias] = useState([])
  const [laboratorios, setLaboratorios] = useState([])
  const [historial, setHistorial] = useState([])
  const [cargando, setCargando] = useState(true)
  const [aviso, setAviso] = useState(null)
  const [dialogo, setDialogo] = useState(null)   // { tipo, ciclo, piscina }

  const cargar = useCallback(async () => {
    setCargando(true); setAviso(null)
    try {
      const { data: cs, error } = await supabase
        .schema('produccion').from('ciclo')
        .select('id, fecha_siembra, cantidad_larva, gramaje_precria, laboratorio_id, piscina:piscina_origen_id (id, codigo, nombre, hectareas, tipo)')
        .eq('finca_id', finca.id).eq('estado', 'abierto')
      if (error) throw error
      const abiertos = (cs || []).filter(c => c.piscina).sort((a, b) => ordenar(a.piscina, b.piscina))
      setCiclos(abiertos)

      const { data: ps } = await supabase
        .schema('produccion').from('piscina')
        .select('id, codigo, nombre, hectareas, tipo')
        .eq('finca_id', finca.id).eq('activa', true)
      const ocupadas = new Set(abiertos.map(c => c.piscina.id))
      setVacias((ps || []).filter(p => !ocupadas.has(p.id)).sort(ordenar))

      const { data: labs } = await supabase
        .schema('produccion').from('laboratorio')
        .select('id, nombre').eq('activo', true).order('nombre')
      setLaboratorios(labs || [])

      const { data: evs } = await supabase
        .schema('produccion').from('evento')
        .select('id, tipo, fecha, libras, observacion, piscina:piscina_origen_id (codigo, nombre), ciclo:ciclo_id (finca_id)')
        .order('fecha', { ascending: false }).limit(60)
      setHistorial((evs || []).filter(e => e.ciclo?.finca_id === finca.id).slice(0, 30))
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo cargar. ' + (err.message || '') })
    } finally {
      setCargando(false)
    }
  }, [finca.id])

  useEffect(() => { cargar() }, [cargar])

  async function sembrar({ piscinaId, fecha, laboratorioId, larva, gramaje }) {
    const { data: c, error } = await supabase.schema('produccion').from('ciclo')
      .insert({ finca_id: finca.id, piscina_origen_id: piscinaId, fecha_siembra: fecha,
                laboratorio_id: laboratorioId || null, cantidad_larva: larva || null,
                gramaje_precria: gramaje || null })
      .select('id').single()
    if (error) throw error
    await supabase.schema('produccion').from('ciclo_piscina')
      .insert({ ciclo_id: c.id, piscina_id: piscinaId, fecha_desde: fecha })
    await supabase.schema('produccion').from('evento')
      .insert({ ciclo_id: c.id, tipo: 'siembra', fecha, piscina_origen_id: piscinaId })
  }

  async function ralear({ ciclo, fecha, libras, observacion }) {
    const { error } = await supabase.schema('produccion').from('evento')
      .insert({ ciclo_id: ciclo.id, tipo: 'raleo', fecha, libras,
                piscina_origen_id: ciclo.piscina.id, observacion: observacion || null })
    if (error) throw error
  }

  async function cosechar({ ciclo, fecha, libras, observacion }) {
    const { error } = await supabase.schema('produccion').from('evento')
      .insert({ ciclo_id: ciclo.id, tipo: 'cosecha', fecha, libras,
                piscina_origen_id: ciclo.piscina.id, observacion: observacion || null })
    if (error) throw error
    const { error: e2 } = await supabase.schema('produccion').from('ciclo')
      .update({ estado: 'cerrado', fecha_cierre: fecha, libras_cosechadas: libras })
      .eq('id', ciclo.id)
    if (e2) throw e2
    await supabase.schema('produccion').from('ciclo_piscina')
      .update({ fecha_hasta: fecha }).eq('ciclo_id', ciclo.id).is('fecha_hasta', null)
  }

  async function transferir({ ciclo, fecha, destinos, libras, observacion }) {
    const { data: ev, error } = await supabase.schema('produccion').from('evento')
      .insert({ ciclo_id: ciclo.id, tipo: 'transferencia', fecha, libras: libras || null,
                piscina_origen_id: ciclo.piscina.id, observacion: observacion || null })
      .select('id').single()
    if (error) throw error
    await supabase.schema('produccion').from('evento_destino')
      .insert(destinos.map(id => ({ evento_id: ev.id, piscina_id: id })))
    // El ciclo se arrastra: ocupa las piscinas nuevas desde ese dia.
    await supabase.schema('produccion').from('ciclo_piscina')
      .update({ fecha_hasta: fecha }).eq('ciclo_id', ciclo.id).is('fecha_hasta', null)
    await supabase.schema('produccion').from('ciclo_piscina')
      .insert(destinos.map(id => ({ ciclo_id: ciclo.id, piscina_id: id, fecha_desde: fecha })))
  }

  async function ejecutar(datos) {
    try {
      if (dialogo.tipo === 'siembra') await sembrar(datos)
      if (dialogo.tipo === 'raleo') await ralear(datos)
      if (dialogo.tipo === 'cosecha') await cosechar(datos)
      if (dialogo.tipo === 'transferencia') await transferir(datos)
      setDialogo(null)
      setAviso({ tipo: 'ok', texto: TIPOS[dialogo.tipo].nombre + ' registrada' })
      await cargar()
    } catch (err) {
      setAviso({ tipo: 'error', texto: 'No se pudo guardar. ' + (err.message || '') })
    }
  }

  const puede = !soloLectura

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: NAVY, padding: '1.4rem 1.4rem 4rem' }}>

      <div style={{ marginBottom: '1rem' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 500, margin: '0 0 5px' }}>Ciclos y eventos</h1>
        <div style={{ fontSize: '13px', color: GRIS }}>
          Sembrar abre el ciclo, cosechar lo cierra. El raleo y la transferencia no lo cierran.
        </div>
      </div>

      {aviso && (
        <div style={{ padding: '10px 14px', borderRadius: '9px', marginBottom: '10px', fontSize: '13px',
          background: aviso.tipo === 'error' ? '#FCEBEB' : '#EAF3DE',
          color: aviso.tipo === 'error' ? '#A32D2D' : '#3B6D11' }}>{aviso.texto}</div>
      )}

      {cargando ? <Nota>Cargando...</Nota> : (
        <>
          <Seccion titulo="Piscinas sembradas" nota={`${ciclos.length} con ciclo abierto`}>
            {!ciclos.length ? <Nota>Ninguna piscina tiene ciclo abierto.</Nota> : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(310px, 1fr))', gap: '10px' }}>
                {ciclos.map(c => (
                  <div key={c.id} style={tarjeta}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <div>
                        <div style={{ fontSize: '16px', fontWeight: 500 }}>{c.piscina.nombre}</div>
                        <div style={{ fontSize: '11px', color: GRIS }}>
                          {Number(c.piscina.hectareas).toFixed(2)} ha
                          {c.piscina.tipo === 'precria' && ' · precría'}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '20px', fontWeight: 500 }}>{diasCultivo(c.fecha_siembra, hoyISO())}</div>
                        <div style={{ fontSize: '11px', color: GRIS }}>días</div>
                      </div>
                    </div>
                    <div style={{ fontSize: '12px', color: GRIS, marginBottom: '12px', lineHeight: 1.6 }}>
                      Sembrada el {corta(c.fecha_siembra)}<br />
                      {c.cantidad_larva
                        ? `${miles(c.cantidad_larva)} larvas · ${miles(c.cantidad_larva / c.piscina.hectareas)} por ha`
                        : 'Sin cantidad de larva registrada'}
                    </div>
                    {puede && (
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <Chip color={TIPOS.raleo} onClick={() => setDialogo({ tipo: 'raleo', ciclo: c })}>Ralear</Chip>
                        <Chip color={TIPOS.transferencia} onClick={() => setDialogo({ tipo: 'transferencia', ciclo: c })}>Transferir</Chip>
                        <Chip color={TIPOS.cosecha} onClick={() => setDialogo({ tipo: 'cosecha', ciclo: c })}>Cosechar</Chip>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Seccion>

          <Seccion titulo="Piscinas vacías" nota={`${vacias.length} listas para sembrar`}>
            {!vacias.length ? <Nota>Todas las piscinas están sembradas.</Nota> : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {vacias.map(p => (
                  <button key={p.id} disabled={!puede}
                    onClick={() => setDialogo({ tipo: 'siembra', piscina: p })}
                    style={{ ...tarjeta, cursor: puede ? 'pointer' : 'default', padding: '12px 16px',
                             textAlign: 'left', fontFamily: 'inherit', minWidth: '150px' }}>
                    <div style={{ fontSize: '15px', fontWeight: 500 }}>{p.nombre}</div>
                    <div style={{ fontSize: '11px', color: GRIS, marginBottom: '8px' }}>
                      {Number(p.hectareas).toFixed(2)} ha{p.tipo === 'precria' && ' · precría'}
                    </div>
                    {puede && <span style={{ fontSize: '12px', color: '#1D9E75', fontWeight: 500 }}>Sembrar</span>}
                  </button>
                ))}
              </div>
            )}
          </Seccion>

          <Seccion titulo="Últimos eventos" nota={`${historial.length} registrados`}>
            {!historial.length ? <Nota>Todavía no hay eventos.</Nota> : (
              <div style={{ ...tarjeta, padding: '4px 18px' }}>
                {historial.map(e => {
                  const t = TIPOS[e.tipo] || TIPOS.siembra
                  return (
                    <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: '12px',
                            padding: '11px 0', borderBottom: '0.5px solid #f1f6f9', fontSize: '13px' }}>
                      <span style={{ fontSize: '11px', fontWeight: 500, padding: '3px 10px',
                              borderRadius: '20px', background: t.fondo, color: t.color, minWidth: '96px', textAlign: 'center' }}>
                        {t.nombre}
                      </span>
                      <span style={{ color: GRIS, minWidth: '86px' }}>{corta(e.fecha)}</span>
                      <span style={{ fontWeight: 500, minWidth: '110px' }}>{e.piscina?.nombre}</span>
                      <span style={{ color: GRIS }}>
                        {e.libras ? `${miles(e.libras)} lb` : ''}
                        {e.observacion ? ` · ${e.observacion}` : ''}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </Seccion>
        </>
      )}

      {dialogo && (
        <Dialogo
          dialogo={dialogo}
          laboratorios={laboratorios}
          piscinasDestino={vacias}
          onCancelar={() => setDialogo(null)}
          onGuardar={ejecutar}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
function Dialogo({ dialogo, laboratorios, piscinasDestino, onCancelar, onGuardar }) {
  const { tipo, ciclo, piscina } = dialogo
  const t = TIPOS[tipo]
  const [fecha, setFecha] = useState(hoyISO())
  const [libras, setLibras] = useState('')
  const [larva, setLarva] = useState('')
  const [gramaje, setGramaje] = useState('')
  const [lab, setLab] = useState('')
  const [destinos, setDestinos] = useState([])
  const [obs, setObs] = useState('')
  const [enviando, setEnviando] = useState(false)

  const objetivo = piscina || ciclo?.piscina
  const exigeLibras = tipo === 'raleo' || tipo === 'cosecha'
  const listo = fecha && (!exigeLibras || num(libras) > 0) &&
                (tipo !== 'transferencia' || destinos.length > 0)

  async function enviar() {
    setEnviando(true)
    await onGuardar({
      piscinaId: piscina?.id, ciclo, fecha,
      laboratorioId: lab || null,
      larva: num(larva), gramaje: num(gramaje),
      libras: num(libras), destinos, observacion: obs,
    })
    setEnviando(false)
  }

  const densidad = num(larva) && objetivo ? num(larva) / Number(objetivo.hectareas) : null

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,40,71,.4)', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 50 }}>
      <div style={{ background: 'white', borderRadius: '14px', padding: '22px', width: '100%', maxWidth: '440px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
          <span style={{ fontSize: '11px', fontWeight: 500, padding: '3px 10px', borderRadius: '20px',
                         background: t.fondo, color: t.color }}>{t.nombre}</span>
          <span style={{ fontSize: '17px', fontWeight: 500 }}>{objetivo?.nombre}</span>
        </div>
        <p style={{ margin: '0 0 16px', fontSize: '13px', color: GRIS }}>{ayuda(tipo)}</p>

        <Campo label="Fecha">
          <input type="date" value={fecha} max={hoyISO()} onChange={e => setFecha(e.target.value)} style={entrada} />
        </Campo>

        {tipo === 'siembra' && (
          <>
            <Campo label="Laboratorio">
              <select value={lab} onChange={e => setLab(e.target.value)} style={entrada}>
                <option value="">Sin especificar</option>
                {laboratorios.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
              </select>
            </Campo>
            <Campo label="Cantidad de larva">
              <input inputMode="numeric" value={larva} placeholder="Por ejemplo 2500000"
                     onChange={e => setLarva(e.target.value)} style={entrada} />
            </Campo>
            {densidad && (
              <div style={{ fontSize: '12px', color: GRIS, margin: '-6px 0 12px' }}>
                Densidad: <b style={{ color: NAVY, fontWeight: 500 }}>{miles(densidad)}</b> larvas por hectárea
              </div>
            )}
            <Campo label="Gramaje de precría">
              <input inputMode="decimal" value={gramaje} placeholder="Opcional"
                     onChange={e => setGramaje(e.target.value)} style={entrada} />
            </Campo>
          </>
        )}

        {exigeLibras && (
          <Campo label={tipo === 'raleo' ? 'Libras raleadas' : 'Libras cosechadas'}>
            <input inputMode="numeric" value={libras} placeholder="0"
                   onChange={e => setLibras(e.target.value)} style={entrada} />
            <div style={{ fontSize: '12px', color: GRIS, marginTop: '5px' }}>
              Obligatorio. Sin este dato no se puede calcular el costo por libra del ciclo.
            </div>
          </Campo>
        )}

        {tipo === 'transferencia' && (
          <>
            <Campo label="Piscinas destino">
              {!piscinasDestino.length ? (
                <div style={{ fontSize: '13px', color: GRIS }}>No hay piscinas vacías disponibles.</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {piscinasDestino.map(p => {
                    const on = destinos.includes(p.id)
                    return (
                      <button key={p.id} onClick={() => setDestinos(d => on ? d.filter(x => x !== p.id) : [...d, p.id])}
                        style={{ padding: '7px 13px', borderRadius: '20px', fontFamily: 'inherit', fontSize: '13px',
                                 cursor: 'pointer', border: '0.5px solid ' + (on ? '#9cc4e8' : BORDE),
                                 background: on ? '#E6F1FB' : 'white', color: on ? AZUL : NAVY,
                                 fontWeight: on ? 500 : 400 }}>
                        {p.nombre}
                      </button>
                    )
                  })}
                </div>
              )}
              <div style={{ fontSize: '12px', color: GRIS, marginTop: '7px' }}>
                Puedes elegir varias. El ciclo se arrastra: conserva sus días de cultivo y su consumo.
              </div>
            </Campo>
            <Campo label="Libras transferidas">
              <input inputMode="numeric" value={libras} placeholder="Opcional"
                     onChange={e => setLibras(e.target.value)} style={entrada} />
            </Campo>
          </>
        )}

        <Campo label="Observación">
          <input value={obs} placeholder="Opcional" onChange={e => setObs(e.target.value)} style={entrada} />
        </Campo>

        <div style={{ display: 'flex', gap: '9px', justifyContent: 'flex-end', marginTop: '16px' }}>
          <button onClick={onCancelar} style={{ ...boton, background: 'white', color: NAVY }}>Cancelar</button>
          <button onClick={enviar} disabled={!listo || enviando}
                  style={{ ...boton, background: AZUL, color: 'white', borderColor: AZUL,
                           opacity: (!listo || enviando) ? 0.45 : 1,
                           cursor: (!listo || enviando) ? 'default' : 'pointer' }}>
            {enviando ? 'Guardando...' : 'Registrar ' + t.nombre.toLowerCase()}
          </button>
        </div>
      </div>
    </div>
  )
}

function ayuda(tipo) {
  if (tipo === 'siembra') return 'Entra la larva y arranca el ciclo. Los días de cultivo se cuentan desde esta fecha.'
  if (tipo === 'raleo') return 'Cosecha parcial. El ciclo sigue vivo y la piscina sigue comiendo.'
  if (tipo === 'transferencia') return 'El camarón pasa a otras piscinas. El ciclo continúa, no nace uno nuevo.'
  return 'Se saca todo. El ciclo se cierra y la piscina queda libre para sembrar de nuevo.'
}

// ---------------------------------------------------------------------
const tarjeta = { background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '12px', padding: '16px 18px' }
const entrada = { width: '100%', padding: '10px 12px', fontSize: '14px', fontFamily: 'inherit',
                  border: '0.5px solid ' + BORDE, borderRadius: '9px', boxSizing: 'border-box', background: 'white' }
const boton = { padding: '10px 18px', fontSize: '14px', fontFamily: 'inherit', fontWeight: 500,
                border: '0.5px solid ' + BORDE, borderRadius: '9px', cursor: 'pointer' }

function Campo({ label, children }) {
  return (
    <div style={{ marginBottom: '12px' }}>
      <div style={{ fontSize: '12px', color: GRIS, marginBottom: '5px' }}>{label}</div>
      {children}
    </div>
  )
}

function Seccion({ titulo, nota, children }) {
  return (
    <div style={{ marginBottom: '1.6rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '10px' }}>
        <h2 style={{ fontSize: '15px', fontWeight: 500, margin: 0 }}>{titulo}</h2>
        <span style={{ fontSize: '12px', color: GRIS }}>{nota}</span>
      </div>
      {children}
    </div>
  )
}

function Chip({ children, onClick, color }) {
  return (
    <button onClick={onClick} style={{ padding: '7px 14px', borderRadius: '20px', fontFamily: 'inherit',
              fontSize: '13px', cursor: 'pointer', border: '0.5px solid ' + BORDE,
              background: color.fondo, color: color.color, fontWeight: 500 }}>
      {children}
    </button>
  )
}

function Nota({ children }) {
  return (
    <div style={{ padding: '2rem 1rem', textAlign: 'center', border: '0.5px dashed ' + BORDE,
                  borderRadius: '12px', color: GRIS, fontSize: '14px', background: 'white' }}>
      {children}
    </div>
  )
}

function ordenar(a, b) {
  if (a.tipo !== b.tipo) return a.tipo === 'precria' ? 1 : -1
  return (parseInt(a.codigo.replace(/\D/g, ''), 10) || 0) - (parseInt(b.codigo.replace(/\D/g, ''), 10) || 0)
}
