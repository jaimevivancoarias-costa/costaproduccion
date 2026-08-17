import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { hoyISO, num, miles } from '../lib/fechas'

// Los cuatro eventos, en un dialogo que se abre desde la fila de la
// piscina en el registro diario. No es una pantalla aparte: en el Excel
// el estado de la piscina es una columna mas de la tabla semanal.

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'

export const TIPOS = {
  siembra:       { nombre: 'Siembra',       color: '#0F6E56', fondo: '#E1F5EE' },
  raleo:         { nombre: 'Raleo',         color: '#854F0B', fondo: '#FAEEDA' },
  transferencia: { nombre: 'Transferencia', color: '#3C3489', fondo: '#EEEDFE' },
  cosecha:       { nombre: 'Cosecha',       color: '#0C447C', fondo: '#E6F1FB' },
}

export async function guardarEvento({ tipo, fincaId, ciclo, piscina, datos }) {
  const { fecha, laboratorioId, larva, gramaje, libras, destinos, observacion } = datos

  if (tipo === 'siembra') {
    const { data: c, error } = await supabase.schema('produccion').from('ciclo')
      .insert({ finca_id: fincaId, piscina_origen_id: piscina.id, fecha_siembra: fecha,
                laboratorio_id: laboratorioId || null, cantidad_larva: larva || null,
                gramaje_precria: gramaje || null })
      .select('id').single()
    if (error) throw error
    await supabase.schema('produccion').from('ciclo_piscina')
      .insert({ ciclo_id: c.id, piscina_id: piscina.id, fecha_desde: fecha })
    await supabase.schema('produccion').from('evento')
      .insert({ ciclo_id: c.id, tipo: 'siembra', fecha, piscina_origen_id: piscina.id,
                observacion: observacion || null })
    return
  }

  const base = { ciclo_id: ciclo.cicloId, fecha, piscina_origen_id: ciclo.piscinaId,
                 observacion: observacion || null }

  if (tipo === 'raleo') {
    const { error } = await supabase.schema('produccion').from('evento')
      .insert({ ...base, tipo: 'raleo', libras })
    if (error) throw error
    return
  }

  if (tipo === 'cosecha') {
    const { error } = await supabase.schema('produccion').from('evento')
      .insert({ ...base, tipo: 'cosecha', libras })
    if (error) throw error
    const { error: e2 } = await supabase.schema('produccion').from('ciclo')
      .update({ estado: 'cerrado', fecha_cierre: fecha, libras_cosechadas: libras })
      .eq('id', ciclo.cicloId)
    if (e2) throw e2
    await supabase.schema('produccion').from('ciclo_piscina')
      .update({ fecha_hasta: fecha }).eq('ciclo_id', ciclo.cicloId).is('fecha_hasta', null)
    return
  }

  // Transferencia: el ciclo se arrastra a las piscinas destino.
  const { data: ev, error } = await supabase.schema('produccion').from('evento')
    .insert({ ...base, tipo: 'transferencia', libras: libras || null })
    .select('id').single()
  if (error) throw error
  await supabase.schema('produccion').from('evento_destino')
    .insert(destinos.map(id => ({ evento_id: ev.id, piscina_id: id })))
  await supabase.schema('produccion').from('ciclo_piscina')
    .update({ fecha_hasta: fecha }).eq('ciclo_id', ciclo.cicloId).is('fecha_hasta', null)
  await supabase.schema('produccion').from('ciclo_piscina')
    .insert(destinos.map(id => ({ ciclo_id: ciclo.cicloId, piscina_id: id, fecha_desde: fecha })))
}

export default function DialogoEvento({ tipo, ciclo, piscina, laboratorios, destinosPosibles,
                                        minima, onCancelar, onGuardar }) {
  const t = TIPOS[tipo]
  const objetivo = piscina || ciclo
  const [fecha, setFecha] = useState(hoyISO())
  const [libras, setLibras] = useState('')
  const [larva, setLarva] = useState('')
  const [gramaje, setGramaje] = useState('')
  const [lab, setLab] = useState('')
  const [destinos, setDestinos] = useState([])
  const [obs, setObs] = useState('')
  const [enviando, setEnviando] = useState(false)

  const exigeLibras = tipo === 'raleo' || tipo === 'cosecha'
  const listo = fecha && (!exigeLibras || num(libras) > 0) &&
                (tipo !== 'transferencia' || destinos.length > 0)

  async function enviar() {
    setEnviando(true)
    await onGuardar({
      fecha, laboratorioId: lab || null, larva: num(larva), gramaje: num(gramaje),
      libras: num(libras), destinos, observacion: obs,
    })
    setEnviando(false)
  }

  const ha = Number(objetivo?.hectareas || 0)
  const densidad = num(larva) && ha ? num(larva) / ha : null

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,40,71,.4)', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 60 }}>
      <div style={{ background: 'white', borderRadius: '14px', padding: '22px', width: '100%',
                    maxWidth: '440px', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
          <span style={{ fontSize: '11px', fontWeight: 500, padding: '3px 10px', borderRadius: '20px',
                         background: t.fondo, color: t.color }}>{t.nombre}</span>
          <span style={{ fontSize: '17px', fontWeight: 500 }}>{objetivo?.nombre}</span>
        </div>
        <p style={{ margin: '0 0 16px', fontSize: '13px', color: GRIS }}>{ayuda(tipo)}</p>

        <Campo label="Fecha">
          <input type="date" value={fecha} max={hoyISO()} min={minima || undefined}
                 onChange={e => setFecha(e.target.value)} style={entrada} />
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
              Obligatorio. Sin este dato no hay costo por libra del ciclo.
            </div>
          </Campo>
        )}

        {tipo === 'transferencia' && (
          <>
            <Campo label="Transferido a">
              {!destinosPosibles?.length ? (
                <div style={{ fontSize: '13px', color: GRIS }}>No hay piscinas vacías disponibles.</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {destinosPosibles.map(p => {
                    const on = destinos.includes(p.id)
                    return (
                      <button key={p.id}
                        onClick={() => setDestinos(d => on ? d.filter(x => x !== p.id) : [...d, p.id])}
                        style={{ padding: '7px 13px', borderRadius: '20px', fontFamily: 'inherit',
                                 fontSize: '13px', cursor: 'pointer',
                                 border: '0.5px solid ' + (on ? '#9cc4e8' : BORDE),
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
            {enviando ? 'Guardando...' : 'Registrar'}
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
