import { useState, useEffect, useCallback } from 'react'
import { useAuth } from './context/AuthContext'
import { supabase } from './lib/supabase'
import { hoyISO, lunesDe, sumarDias, cortita, semanaISO } from './lib/fechas'
import RegistroDiario from './pages/RegistroDiario'
import RegistroInsumos from './pages/RegistroInsumos'
import Gramaje from './pages/Gramaje'
import Costos from './pages/Costos'
import Resumen from './pages/Resumen'
import Inventario from './pages/Inventario'
import InventarioBalanceado from './pages/InventarioBalanceado'
import Reportes from './pages/Reportes'
import PresupuestoBarra from './pages/PresupuestoBarra'
import Presupuesto from './pages/Presupuesto'
import PresupuestoDiesel from './pages/PresupuestoDiesel'
import Diesel from './pages/Diesel'
import Historial from './pages/Historial'
import Catalogo from './pages/Catalogo'
import EnConstruccion from './pages/EnConstruccion'

// Navegacion de dos niveles (regla 9): la finca vive arriba como
// selector, el lateral queda para los modulos.

const HUB_URL = import.meta.env.VITE_HUB_URL || 'https://costamarket-hub.vercel.app'

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'

const MODULOS = [
  { id: 'presupuesto', nombre: 'Presupuesto',    icono: 'moneda' },
  { id: 'resumen',    nombre: 'Resumen',        icono: 'grid', soloJefe: true },
  { id: 'registro',   nombre: 'Registro diario', icono: 'calendario' },
  { id: 'diesel',     nombre: 'Diesel',         icono: 'bidon' },
  { id: 'gramaje',    nombre: 'Gramaje',        icono: 'barras' },
  { id: 'inventario', nombre: 'Inventario',     icono: 'caja' },
  { id: 'catalogo',   nombre: 'Catálogo',       icono: 'etiqueta', soloJefe: true },
  { id: 'costos',     nombre: 'Costos',         icono: 'moneda', soloJefe: true },
  { id: 'reportes',   nombre: 'Reportes',       icono: 'barras', soloJefe: true },
  // El historial es la bitacora de cambios: herramienta de supervision.
  { id: 'historial',  nombre: 'Historial',      icono: 'reloj', soloJefe: true },
]

// Recordar lo último entre recargas (si el navegador no deja, no pasa nada).
const lsGet = (k, d) => { try { return localStorage.getItem(k) || d } catch { return d } }
const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch { /* sin storage */ } }

function Icono({ tipo }) {
  const p = { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none',
              stroke: 'currentColor', strokeWidth: 1.5 }
  if (tipo === 'grid') return <svg {...p}><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>
  if (tipo === 'calendario') return <svg {...p}><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>
  if (tipo === 'barras') return <svg {...p}><path d="M3 13V7M8 13V3M13 13v-4"/></svg>
  if (tipo === 'caja') return <svg {...p}><path d="M2 5l6-3 6 3v6l-6 3-6-3z"/><path d="M2 5l6 3 6-3M8 8v6"/></svg>
  if (tipo === 'moneda') return <svg {...p}><circle cx="8" cy="8" r="6"/><path d="M8 4.5v7M6 6.5h3M6 9.5h3"/></svg>
  if (tipo === 'gota') return <svg {...p}><path d="M8 2s4 4.5 4 7.5A4 4 0 0 1 4 9.5C4 6.5 8 2 8 2z"/></svg>
  if (tipo === 'bidon') return <svg {...p}><path d="M5 6h6a1.3 1.3 0 0 1 1.3 1.3v5.1A1.3 1.3 0 0 1 11 13.7H5A1.3 1.3 0 0 1 3.7 12.4V7.3z"/><path d="M4 6.3 2.4 4.7M7 4.6h3.2"/><path d="M8 8.4c0 0-1.2 1.4-1.2 2.3a1.2 1.2 0 0 0 2.4 0c0-.9-1.2-2.3-1.2-2.3z"/></svg>
  if (tipo === 'etiqueta') return <svg {...p}><path d="M7.7 2.2H3.2v4.5l6.1 6.1 4.5-4.5z"/><circle cx="5.4" cy="5.4" r="0.8"/></svg>
  return <svg {...p}><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>
}

export default function App() {
  const { user, nombre, fincas, esJefe, esJefeGlobal, cargando, logout } = useAuth()
  const [fincaId, setFincaId] = useState(null)
  const [zona, setZona] = useState('jambeli')
  const [modulo, setModulo] = useState(() => lsGet('modulo', 'registro'))
  // Dentro de Registro diario: balanceado o insumos. Comparten semana.
  const [panelReg, setPanelReg] = useState(() => lsGet('panelReg', 'balanceado'))
  // Cuando se entra a Reportes desde la barra de presupuesto, arranca
  // enfocado en insumos.
  const [verInsumos, setVerInsumos] = useState(false)
  // Inventario: insumos o balanceado.
  const [panelInv, setPanelInv] = useState(() => lsGet('panelInv', 'insumos'))
  // Presupuesto: insumos o diesel.
  const [pptoTab, setPptoTab] = useState(() => lsGet('pptoTab', 'insumos'))
  // Menu lateral colapsado a solo iconos. Se recuerda entre recargas.
  const [navColapsado, setNavColapsado] = useState(() => {
    try { return localStorage.getItem('nav') === 'colapsado' } catch { return false }
  })
  function alternarNav() {
    setNavColapsado(v => {
      const n = !v
      try { localStorage.setItem('nav', n ? 'colapsado' : 'abierto') } catch (e) { /* sin storage */ }
      return n
    })
  }
  // La semana es una sola para todo el modulo: si la cambias en una
  // pantalla, las demas se mueven con ella.
  const [lunes, setLunes] = useState(() => lunesDe(hoyISO()))

  useEffect(() => {
    if (fincas.length && !fincaId) {
      let guardada = null
      try { guardada = localStorage.getItem('finca') } catch { /* sin storage */ }
      const elegida = fincas.find(f => f.id === guardada) || fincas[0]
      setFincaId(elegida.id)
      if (elegida.zona) setZona(elegida.zona)
    }
  }, [fincas, fincaId])

  // Recordar la última finca elegida, para volver a ella al recargar.
  useEffect(() => {
    if (fincaId) { try { localStorage.setItem('finca', fincaId) } catch { /* sin storage */ } }
  }, [fincaId])

  // Recordar la última página y pestañas, para volver a ellas al recargar.
  useEffect(() => { lsSet('modulo', modulo) }, [modulo])
  useEffect(() => { lsSet('panelReg', panelReg) }, [panelReg])
  useEffect(() => { lsSet('panelInv', panelInv) }, [panelInv])
  // El diesel ya no es sub-tab de Inventario; si quedó guardado, cae a insumos.
  useEffect(() => { if (panelInv === 'diesel') setPanelInv('insumos') }, [panelInv])
  useEffect(() => { lsSet('pptoTab', pptoTab) }, [pptoTab])

  // Si la página recordada es solo para jefe y el usuario no lo es, se
  // vuelve al Registro diario. Se espera a que el usuario termine de cargar:
  // si no, mientras carga aún no se sabe el rol y patearía al jefe sin razón.
  useEffect(() => {
    if (cargando) return
    const m = MODULOS.find(x => x.id === modulo)
    if (m && ((m.soloJefe && !esJefe) || (m.soloJefeGlobal && !esJefeGlobal))) setModulo('registro')
  }, [modulo, esJefe, esJefeGlobal, cargando])

  // Mantener la zona sincronizada con la finca elegida.
  useEffect(() => {
    const f = fincas.find(x => x.id === fincaId)
    if (f && f.zona && f.zona !== zona) setZona(f.zona)
  }, [fincaId, fincas]) // eslint-disable-line

  // Correcciones pendientes por finca (para el jefe/contadora). Se
  // recarga al cambiar de modulo o de finca, asi que despues de aprobar
  // una y volver a navegar, el aviso se actualiza.
  const [corrPend, setCorrPend] = useState([])
  const [reponer, setReponer] = useState([])
  const [dieselPend, setDieselPend] = useState([])
  const [pedirIngresos, setPedirIngresos] = useState(0)
  const [pedirPrecios, setPedirPrecios] = useState(0)
  const [catTab, setCatTab] = useState('insumos')
  const [catNonce, setCatNonce] = useState(0)
  const cargarCorr = useCallback(async () => {
    if (!esJefe) { setCorrPend([]); return }
    const { data } = await supabase.schema('produccion').from('solicitud_correccion')
      .select('finca_id, tabla, valor_propuesto, finca:finca_id (nombre, zona)').eq('estado', 'pendiente')
    // Agrupar por finca + destino exacto (dónde se aprueba).
    const g = {}
    ;(data || []).forEach(r => {
      let destino, etiqueta
      if (r.tabla === 'ingreso_insumo') { destino = 'inv-ins'; etiqueta = 'Corrección de insumos' }
      else if (r.tabla === 'ingreso_balanceado') { destino = 'inv-bal'; etiqueta = 'Corrección de balanceado' }
      else if (r.tabla === 'dia_registro') {
        if (r.valor_propuesto?.ambito === 'insumos') { destino = 'reg-ins'; etiqueta = 'Reapertura de insumos' }
        else { destino = 'reg-bal'; etiqueta = 'Reapertura de balanceado' }
      }
      else if (r.tabla === 'nuevo_insumo') { destino = 'cat-ins'; etiqueta = 'Insumo pedido por bodega' }
      else if (r.tabla === 'nuevo_producto') { destino = 'cat-bal'; etiqueta = 'Balanceado pedido por bodega' }
      else return
      const k = r.finca_id + '|' + destino
      g[k] = g[k] || { finca_id: r.finca_id, nombre: r.finca?.nombre || '', zona: r.finca?.zona, destino, etiqueta, n: 0 }
      g[k].n++
    })
    setCorrPend(Object.values(g))
  }, [esJefe])
  useEffect(() => { cargarCorr() }, [cargarCorr, modulo, fincaId])

  // "Por reponer" recorre todas las fincas: es pesado, así que se calcula
  // aparte y NO en cada cambio de menú. Solo al entrar (y si cambia el rol).
  const cargarReponer = useCallback(async () => {
    if (!esJefe) { setReponer([]); return }
    const { data: rep } = await supabase.schema('produccion').rpc('fn_por_reponer', {})
    setReponer(rep || [])
  }, [esJefe])
  useEffect(() => { cargarReponer() }, [cargarReponer])

  // Pedidos de diesel pendientes de aprobación (para la campana del jefe).
  const cargarDiesel = useCallback(async () => {
    if (!esJefe) { setDieselPend([]); return }
    // El bodeguero registra libre; solo las correcciones (editar/borrar) piden permiso.
    const { data: corr } = await supabase.schema('produccion').from('solicitud_correccion')
      .select('finca_id, finca:finca_id (nombre, zona)')
      .in('tabla', ['diesel_pedido', 'diesel_consumo']).eq('estado', 'pendiente')
    const g = {}
    ;(corr || []).forEach(r => {
      const k = r.finca_id
      g[k] = g[k] || { finca_id: r.finca_id, nombre: r.finca?.nombre || '', zona: r.finca?.zona, n: 0 }
      g[k].n++
    })
    setDieselPend(Object.values(g))
  }, [esJefe])
  useEffect(() => { cargarDiesel() }, [cargarDiesel, modulo, fincaId])

  function irACorreccion(c) {
    setFincaId(c.finca_id)
    if (c.zona) setZona(c.zona)
    if (c.destino === 'reg-bal') { setModulo('registro'); setPanelReg('balanceado') }
    else if (c.destino === 'reg-ins') { setModulo('registro'); setPanelReg('insumos') }
    else if (c.destino === 'inv-bal') { setModulo('inventario'); setPanelInv('balanceado'); setPedirIngresos(n => n + 1) }
    else if (c.destino === 'cat-ins') { setCatTab('insumos'); setCatNonce(n => n + 1); setModulo('catalogo') }
    else if (c.destino === 'cat-bal') { setCatTab('balanceados'); setCatNonce(n => n + 1); setModulo('catalogo') }
    else { setModulo('inventario'); setPanelInv('insumos'); setPedirIngresos(n => n + 1) }
  }

  // Red de seguridad: si por alguna navegacion interna un bodeguero
  // termina en un modulo que no le toca (Resumen, Costos, Reportes),
  // lo devolvemos a Registro diario.
  useEffect(() => {
    const m = MODULOS.find(x => x.id === modulo)
    if (m && ((m.soloJefe && !esJefe) || (m.soloJefeGlobal && !esJefeGlobal))) setModulo('registro')
  }, [modulo, esJefe, esJefeGlobal])

  if (cargando) return <Centro>Cargando...</Centro>
  if (!user) return <IrAlPortal />

  if (!fincas.length) {
    return (
      <Centro>
        <div style={{ fontSize: '16px', marginBottom: '6px' }}>Todavía no tienes fincas asignadas</div>
        <div style={{ fontSize: '13px', color: GRIS }}>Pide a tu jefe que te dé acceso.</div>
      </Centro>
    )
  }

  const finca = fincas.find(f => f.id === fincaId) || fincas[0]
  const soloLectura = finca.rol === 'visor'

  return (
    <div style={{ minHeight: '100vh' }}>

      <div style={{ background: NAVY, height: '56px', padding: '0 1.25rem', display: 'flex',
                    alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <a href={HUB_URL} style={{ display: 'flex', alignItems: 'center' }}>
            <img src="/logo.png" alt="CostaMarket" style={{ height: '30px', width: 'auto' }} />
          </a>
          {fincas.length > 1 ? (
            <>
              {/* Selector de zona: divide las fincas en Jambelí y Puna.
                  Solo aparece si el usuario tiene fincas en las dos. */}
              {[...new Set(fincas.map(f => f.zona))].filter(Boolean).length > 1 && (
                <div style={{ display: 'inline-flex', background: 'rgba(255,255,255,0.1)',
                              borderRadius: '9px', padding: '3px' }}>
                  {['jambeli', 'puna'].map(z => (
                    <button key={z} onClick={() => {
                      setZona(z)
                      const prim = fincas.find(f => f.zona === z)
                      if (prim) setFincaId(prim.id)
                    }} style={{
                      border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '12px',
                      fontWeight: 500, letterSpacing: '0.03em', padding: '5px 12px', borderRadius: '7px',
                      background: zona === z ? 'white' : 'transparent',
                      color: zona === z ? NAVY : 'rgba(255,255,255,0.7)' }}>
                      {z === 'jambeli' ? 'Jambelí' : 'Puná'}
                    </button>
                  ))}
                </div>
              )}
              {/* Finca como una pildora con flecha (opcion 1, sin pin). */}
              <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                <select
                  value={finca.id}
                  onChange={e => setFincaId(e.target.value)}
                  style={{ appearance: 'none', WebkitAppearance: 'none',
                           background: 'rgba(255,255,255,0.12)', border: 'none',
                           color: 'white', borderRadius: '20px', padding: '7px 34px 7px 15px',
                           fontFamily: 'inherit', fontSize: '13px', fontWeight: 500, cursor: 'pointer' }}
                >
                  {fincas.filter(f => !f.zona || f.zona === zona).map(f => (
                    <option key={f.id} value={f.id} style={{ color: NAVY }}>{String(f.nombre).toUpperCase()}</option>
                  ))}
                </select>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="rgba(255,255,255,0.6)"
                     strokeWidth="1.6" style={{ position: 'absolute', right: '13px', pointerEvents: 'none' }}>
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </div>
            </>
          ) : (
            <span style={{ background: 'rgba(255,255,255,0.1)', borderRadius: '9px', padding: '7px 12px',
                           fontSize: '13px', fontWeight: 600, letterSpacing: '0.05em', color: 'white' }}>
              {String(finca.nombre).toUpperCase()}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {esJefe && <Campana corrPend={corrPend} reponer={reponer} dieselPend={dieselPend} onIr={irACorreccion}
                       onIrReponer={id => { setFincaId(id); setModulo('inventario') }}
                       onIrDiesel={d => { setFincaId(d.finca_id); if (d.zona) setZona(d.zona); setModulo('diesel') }} />}
          <a href={HUB_URL} style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', textDecoration: 'none' }}>Portal</a>
          <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.75)' }}>{nombre || user.email}</span>
          <button onClick={logout} style={{ background: 'none', border: 'none', cursor: 'pointer',
                    color: 'rgba(255,255,255,0.5)', fontSize: '12px', fontFamily: 'inherit' }}>Salir</button>
        </div>
      </div>

      {/* Barra de presupuesto: una sola franja de ancho completo, debajo
          de la barra azul. Aqui no se puede duplicar. No en Resumen ni
          en la propia pagina de Presupuesto. */}
      {modulo !== 'resumen' && modulo !== 'presupuesto' && (
        <PresupuestoBarra
          key={finca.id}
          finca={finca}
          esJefe={esJefe}
          onIr={esJefe ? () => { setVerInsumos(true); setModulo('reportes') } : undefined}
          onIrDiesel={() => { setPptoTab('diesel'); setModulo('presupuesto') }}
        />
      )}

      <AvisoCierres
        fincas={fincas}
        esJefe={esJefe}
        onCerrar={(fid, z, amb, dia) => {
          setFincaId(fid); if (z) setZona(z)
          if (amb === 'diesel') { setModulo('diesel') }
          else { setModulo('registro'); setPanelReg(amb); setLunes(lunesDe(dia)) }
        }}
      />

      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        <nav style={{ width: navColapsado ? '58px' : '178px', flexShrink: 0, background: 'white',
                      borderRight: '0.5px solid ' + BORDE, minHeight: 'calc(100vh - 56px)',
                      padding: '1.1rem 0.7rem', transition: 'width .12s',
                      display: 'flex', flexDirection: 'column' }}>
          {MODULOS.filter(m => (!m.soloJefe || esJefe) && (!m.soloJefeGlobal || esJefeGlobal)).map(m => {
            const activo = m.id === modulo
            return (
              <button
                key={m.id}
                onClick={() => { setModulo(m.id); setVerInsumos(false) }}
                title={m.nombre}
                style={{
                  display: 'flex', alignItems: 'center', gap: '9px', width: '100%',
                  justifyContent: navColapsado ? 'center' : 'flex-start',
                  border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px',
                  padding: '10px', borderRadius: '8px', marginBottom: '2px', textAlign: 'left',
                  background: activo ? '#E6F1FB' : 'transparent',
                  color: activo ? AZUL : NAVY,
                  fontWeight: activo ? 500 : 400,
                  opacity: activo ? 1 : 0.85,
                }}
              >
                <Icono tipo={m.icono} />
                {!navColapsado && m.nombre}
              </button>
            )
          })}
          {/* Colapsar el menu: al fondo. */}
          <button
            onClick={alternarNav}
            title={navColapsado ? 'Expandir menú' : 'Colapsar menú'}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
                     width: '100%', border: 'none', background: 'transparent', cursor: 'pointer',
                     color: GRIS, padding: '10px', marginTop: 'auto', fontSize: '15px' }}>
            {navColapsado ? '»' : '«'}
          </button>
        </nav>

        <div style={{ flex: 1, minWidth: 0 }}>
          {modulo === 'presupuesto' ? (
            <div style={{ padding: '1.4rem 1.5rem', maxWidth: '1180px' }}>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
                {[['insumos', 'Insumos'], ['diesel', 'Diesel']].map(([id, txt]) => (
                  <button key={id} onClick={() => setPptoTab(id)} style={{
                    border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '14px', fontWeight: 500,
                    padding: '8px 16px', borderRadius: '9px',
                    background: pptoTab === id ? '#E6F1FB' : 'transparent',
                    color: pptoTab === id ? AZUL : GRIS }}>{txt}</button>
                ))}
              </div>
              <h2 style={{ fontSize: '19px', fontWeight: 500, margin: '0 0 4px' }}>
                {pptoTab === 'diesel' ? 'Presupuesto de diesel' : 'Presupuesto de insumos'}
              </h2>
              <p style={{ fontSize: '13px', color: GRIS, margin: '0 0 16px' }}>
                {String(finca.nombre).toUpperCase()}. Se renueva cada mes: arranca de cero el día 1.
              </p>
              {pptoTab === 'diesel' ? (
                <PresupuestoDiesel key={finca.id} finca={finca} fincas={fincas} esJefe={esJefe} />
              ) : (
                <Presupuesto key={finca.id} finca={finca} fincas={fincas} esJefe={esJefe}
                  onIrReporte={id => {
                    setFincaId(id); setVerInsumos(true); setModulo('reportes')
                    const f = fincas.find(x => x.id === id); if (f && f.zona) setZona(f.zona)
                  }} />
              )}
            </div>
          ) : modulo === 'resumen' ? (
            <Resumen
              fincas={fincas}
              esJefe={esJefe}
              onIrAFinca={id => {
                setFincaId(id); setModulo('registro')
                const f = fincas.find(x => x.id === id); if (f && f.zona) setZona(f.zona)
              }}
            />
          ) : modulo === 'registro' ? (
            <div>
              <div style={{ display: 'flex', gap: '4px', padding: '14px 1.4rem 0' }}>
                {[['balanceado', 'Balanceado'], ['insumos', 'Insumos']].map(([id, txt]) => (
                  <button key={id} onClick={() => setPanelReg(id)} style={{
                    border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '14px',
                    fontWeight: 500, padding: '9px 18px', borderRadius: '9px 9px 0 0',
                    background: panelReg === id ? 'white' : 'transparent',
                    color: panelReg === id ? AZUL : GRIS,
                    borderBottom: panelReg === id ? '2px solid ' + AZUL : '2px solid transparent',
                  }}>{txt}</button>
                ))}
              </div>
              {panelReg === 'balanceado' ? (
                <RegistroDiario
                  key={finca.id}
                  finca={finca}
                  esJefe={esJefe}
                  soloLectura={soloLectura}
                  lunes={lunes}
                  setLunes={setLunes}
                />
              ) : (
                <RegistroInsumos
                  key={finca.id}
                  finca={finca}
                  esJefe={esJefe}
                  soloLectura={soloLectura}
                  lunes={lunes}
                  setLunes={setLunes}
                />
              )}
            </div>
          ) : modulo === 'gramaje' ? (
            <Gramaje key={finca.id} finca={finca} esJefe={esJefe} soloLectura={soloLectura} lunes={lunes} setLunes={setLunes} />
          ) : modulo === 'costos' ? (
            <Costos key={finca.id} finca={finca} esJefe={esJefe} lunes={lunes} setLunes={setLunes} />
          ) : modulo === 'inventario' ? (
            <div>
              <div style={{ display: 'flex', gap: '4px', padding: '14px 1.5rem 0' }}>
                {[['insumos', 'Insumos'], ['balanceado', 'Balanceado']].map(([id, txt]) => (
                  <button key={id} onClick={() => setPanelInv(id)} style={{
                    border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '14px',
                    fontWeight: 500, padding: '9px 18px', borderRadius: '9px 9px 0 0',
                    background: panelInv === id ? 'white' : 'transparent',
                    color: panelInv === id ? AZUL : GRIS,
                    borderBottom: panelInv === id ? '2px solid ' + AZUL : '2px solid transparent',
                  }}>{txt}</button>
                ))}
              </div>
              {panelInv === 'balanceado'
                ? <InventarioBalanceado key={finca.id} finca={finca} esJefe={esJefe} esJefeGlobal={esJefeGlobal} abrirIngresos={pedirIngresos} abrirPrecios={pedirPrecios} onCorreccion={cargarCorr} />
                : <Inventario key={finca.id} finca={finca} esJefe={esJefe} esJefeGlobal={esJefeGlobal} abrirIngresos={pedirIngresos} abrirPrecios={pedirPrecios} onCorreccion={cargarCorr} />}
            </div>
          ) : modulo === 'diesel' ? (
            <Diesel key={finca.id} finca={finca} esJefe={esJefe} esJefeGlobal={esJefeGlobal} soloLectura={soloLectura} onCambio={cargarDiesel} />
          ) : modulo === 'catalogo' ? (
            <Catalogo key={catNonce} esJefe={esJefe} esJefeGlobal={esJefeGlobal} fincas={fincas} tabInicial={catTab} />
          ) : modulo === 'reportes' ? (
            <Reportes key={finca.id} finca={finca} fincas={fincas} esJefe={esJefe} enfoqueInsumos={verInsumos} />
          ) : modulo === 'historial' ? (
            <Historial key={finca.id} finca={finca} esJefe={esJefe} todasLasFincas={fincas.length} />
          ) : (
            <EnConstruccion modulo={MODULOS.find(m => m.id === modulo)} />
          )}
        </div>
      </div>
    </div>
  )
}

// Aviso de pendientes: días sin cerrar (balanceado/insumos) desde el inventario
// inicial de cada finca hasta ayer, y semanas TERMINADAS sin consumo de diesel.
// Franja gris, colapsable, signo en ámbar. "Cerrar" lleva al registro; "Registrar"
// (diesel) lleva al módulo de diesel.
const AZULBG = '#E6F1FB'
const AMBITOS_CIERRE = [
  { id: 'balanceado', txt: 'Balanceado', bg: '#efe7fb', col: '#6b43c7' },
  { id: 'insumos',    txt: 'Insumos',    bg: AZULBG,    col: AZUL },
]
const AMBAR = '#BA7517'
const CHIP_DIESEL = { id: 'diesel', txt: 'Diesel', bg: '#fdecd6', col: '#b5651d' }
// Cota inferior para acotar las consultas (todos los inventarios iniciales del
// ciclo actual son de finales de agosto 2026 en adelante).
const PISO_AVISO = '2026-08-01'

function AvisoCierres({ fincas, esJefe, onCerrar }) {
  const [abierto, setAbierto] = useState(false)
  const [fincasPend, setFincasPend] = useState([])
  const [listo, setListo] = useState(false)

  useEffect(() => {
    let vivo = true
    async function cargar() {
      setListo(false)
      // La finca "Prueba" no cuenta para este aviso.
      const reales = fincas.filter(f => !String(f.nombre || '').toLowerCase().includes('prueba'))
      if (!reales.length) { if (vivo) { setFincasPend([]); setListo(true) } return }
      const hoy = hoyISO()
      const ayer = sumarDias(hoy, -1)
      const ids = reales.map(f => f.id)
      const [{ data: cerrD }, { data: tiIni }, { data: tbIni }, { data: dcIni }, { data: dCons }, { data: semC }] = await Promise.all([
        supabase.schema('produccion').from('dia_registro')
          .select('finca_id, fecha, ambito, estado')
          .gte('fecha', PISO_AVISO).lte('fecha', ayer).in('finca_id', ids).limit(100000),
        supabase.schema('produccion').from('toma_inventario')
          .select('finca_id, fecha').eq('es_inicial', true).in('finca_id', ids),
        supabase.schema('produccion').from('toma_balanceado')
          .select('finca_id, fecha').eq('es_inicial', true).in('finca_id', ids),
        supabase.schema('produccion').from('diesel_conteo')
          .select('finca_id, fecha').eq('es_inicial', true).in('finca_id', ids),
        supabase.schema('produccion').from('diesel_consumo')
          .select('finca_id, fecha').gte('fecha', PISO_AVISO).lte('fecha', ayer).in('finca_id', ids).limit(100000),
        supabase.schema('produccion').from('semana_cerrada')
          .select('finca_id, anio, semana, ambito')
          .gte('anio', Number(PISO_AVISO.slice(0, 4))).in('finca_id', ids).limit(100000),
      ])
      if (!vivo) return
      // Inventario inicial (el más antiguo) por finca y ámbito = desde dónde contar.
      const minPorFinca = rows => { const m = {}; (rows || []).forEach(r => { if (!m[r.finca_id] || r.fecha < m[r.finca_id]) m[r.finca_id] = r.fecha }); return m }
      const iniIns = minPorFinca(tiIni), iniBal = minPorFinca(tbIni), iniDie = minPorFinca(dcIni)
      const cerr = new Set()
      ;(cerrD || []).forEach(r => {
        if (r.estado === 'cerrado') cerr.add(`${r.finca_id}|${r.ambito}|${r.fecha}`)
      })
      // Una semana en semana_cerrada cierra TODOS sus días (igual que el registro:
      // semana cerrada ⇒ todos cerrados, sin importar reaperturas sueltas por día,
      // y aunque no haya fila por día). Clave por anio-semana ISO.
      const semCerr = new Set((semC || []).map(r => `${r.finca_id}|${r.ambito}|${r.anio}-${r.semana}`))
      // Semanas (lunes) con consumo de diesel por finca.
      const dieselSem = {}
      ;(dCons || []).forEach(r => { const lun = lunesDe(r.fecha); (dieselSem[r.finca_id] = dieselSem[r.finca_id] || new Set()).add(lun) })

      // Días sin cerrar (insumos/balanceado): desde el inicial de la finca hasta ayer.
      const diasPend = (iniF, amb, fid) => {
        if (!iniF || iniF > ayer) return []
        const out = []
        for (let d = iniF; d <= ayer; d = sumarDias(d, 1)) {
          // Solo semanas ya TERMINADAS (la semana en curso aún no vence, no se avisa).
          if (sumarDias(lunesDe(d), 6) >= hoy) continue
          const k = `${fid}|${amb}|${d}`
          if (cerr.has(k)) continue                 // día cerrado por su fila
          const { anio, semana } = semanaISO(d)
          if (semCerr.has(`${fid}|${amb}|${anio}-${semana}`)) continue  // semana cerrada
          out.push(d)
        }
        return out
      }
      // Semanas TERMINADAS sin consumo de diesel: desde el inicial de diesel.
      const semDieselPend = (iniF, fid) => {
        if (!iniF) return []
        const out = []
        for (let lun = lunesDe(iniF); ; lun = sumarDias(lun, 7)) {
          const dom = sumarDias(lun, 6)
          if (dom >= hoy) break               // semana no terminada → parar
          if (!(dieselSem[fid] && dieselSem[fid].has(lun))) out.push({ lun, dom })
        }
        return out
      }

      const out = []
      reales.forEach(f => {
        const ambitos = []
        const diasBal = diasPend(iniBal[f.id], 'balanceado', f.id)
        if (diasBal.length) ambitos.push({ ...AMBITOS_CIERRE[0], tipo: 'dias', dias: diasBal })
        const diasIns = diasPend(iniIns[f.id], 'insumos', f.id)
        if (diasIns.length) ambitos.push({ ...AMBITOS_CIERRE[1], tipo: 'dias', dias: diasIns })
        const semDie = semDieselPend(iniDie[f.id], f.id)
        if (semDie.length) ambitos.push({ ...CHIP_DIESEL, tipo: 'semanas', semanas: semDie })
        if (!ambitos.length) return
        const diasTot = new Set([...diasBal, ...diasIns]).size
        const semTot = semDie.length
        out.push({ fincaId: f.id, nombre: f.nombre, zona: f.zona, ambitos, diasTot, semTot, peso: diasTot + semTot })
      })
      out.sort((a, b) => (a.zona || '').localeCompare(b.zona || '') || b.peso - a.peso)
      setFincasPend(out); setListo(true)
    }
    cargar()
    return () => { vivo = false }
  }, [fincas])

  if (!listo || !fincasPend.length) return null

  const n = fincasPend.length
  const titulo = esJefe
    ? `${n} ${n === 1 ? 'finca' : 'fincas'} con pendientes`
    : 'Tienes registros pendientes'

  const Signo = () => (
    <span style={{ width: '22px', height: '22px', borderRadius: '50%', background: AMBAR, color: 'white',
                   display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800,
                   fontSize: '13px', flex: '0 0 auto' }}>!</span>
  )

  const fechasTexto = ds => {
    const top = ds.slice(0, 6).map(cortita).join(', ')
    return ds.length > 6 ? `${top} +${ds.length - 6} más` : top
  }
  const semanasTexto = ss => {
    const top = ss.slice(0, 4).map(s => `${cortita(s.lun)}–${cortita(s.dom)}`).join(', ')
    return ss.length > 4 ? `${top} +${ss.length - 4} más` : top
  }

  // Agrupar por zona solo para el jefe (ve varias zonas).
  const zonas = esJefe ? [...new Set(fincasPend.map(f => f.zona).filter(Boolean))] : []
  const etZona = z => (z === 'puna' ? 'Puná' : z === 'jambeli' ? 'Jambelí' : z)

  const resumenFinca = f => {
    const partes = []
    if (f.diasTot) partes.push(`${f.diasTot} ${f.diasTot === 1 ? 'día' : 'días'} sin cerrar`)
    if (f.semTot) partes.push(`${f.semTot} ${f.semTot === 1 ? 'semana' : 'semanas'} de diesel`)
    return partes.join(' · ')
  }

  const Tarjeta = f => (
    <div key={f.fincaId} style={{ background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '10px',
                                  padding: '9px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
        <span style={{ fontWeight: 600, fontSize: '13.5px' }}>{String(f.nombre).toUpperCase()}</span>
        <span style={{ fontSize: '11px', color: '#c0453f', fontWeight: 700 }}>{resumenFinca(f)}</span>
      </div>
      {f.ambitos.map(a => (
        <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '9px', marginTop: '7px' }}>
          <span style={{ fontSize: '9.5px', fontWeight: 700, borderRadius: '20px', padding: '2px 8px',
                         background: a.bg, color: a.col, whiteSpace: 'nowrap' }}>{a.txt}</span>
          <span style={{ fontSize: '11.5px', color: GRIS, flex: 1, minWidth: 0 }}>
            {a.tipo === 'semanas' ? semanasTexto(a.semanas) : fechasTexto(a.dias)}
          </span>
          <button onClick={() => a.tipo === 'semanas'
                    ? onCerrar(f.fincaId, f.zona, 'diesel', a.semanas[0].lun)
                    : onCerrar(f.fincaId, f.zona, a.id, a.dias[0])}
            style={{ background: AZUL, color: 'white', border: 'none', borderRadius: '8px', fontSize: '11.5px',
                     fontWeight: 700, padding: '6px 13px', cursor: 'pointer', whiteSpace: 'nowrap',
                     fontFamily: 'inherit' }}>{a.tipo === 'semanas' ? 'Registrar ›' : 'Cerrar ›'}</button>
        </div>
      ))}
    </div>
  )

  return (
    <div style={{ background: '#f3f6f9', borderBottom: '0.5px solid ' + BORDE }}>
      {!abierto ? (
        <div onClick={() => setAbierto(true)}
          style={{ display: 'flex', alignItems: 'center', gap: '11px', padding: '9px 1.25rem', cursor: 'pointer' }}>
          <Signo />
          <span style={{ fontSize: '13px', fontWeight: 700, color: NAVY }}>{titulo}</span>
          {!esJefe && (
            <span style={{ background: 'white', border: '0.5px solid ' + BORDE, color: GRIS, borderRadius: '20px',
                           fontSize: '11px', fontWeight: 700, padding: '1px 9px' }}>
              {n} {n === 1 ? 'finca' : 'fincas'}
            </span>
          )}
          <span style={{ marginLeft: 'auto', color: GRIS, fontSize: '12px', fontWeight: 600 }}>▾ Ver</span>
        </div>
      ) : (
        <div>
          <div onClick={() => setAbierto(false)}
            style={{ display: 'flex', alignItems: 'center', gap: '11px', padding: '9px 1.25rem 7px', cursor: 'pointer' }}>
            <Signo />
            <span style={{ fontSize: '13px', fontWeight: 700, color: NAVY }}>{titulo}</span>
            <span style={{ marginLeft: 'auto', color: GRIS, fontSize: '12px', fontWeight: 600 }}>▴ Ocultar</span>
          </div>
          <div style={{ padding: '2px 1.25rem 11px', display: 'flex', flexDirection: 'column', gap: '7px',
                        maxHeight: '340px', overflowY: 'auto' }}>
            {zonas.length > 1 ? zonas.map(z => (
              <div key={z} style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                <div style={{ fontSize: '9.5px', fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase',
                              color: '#a98634', padding: '3px 2px 0' }}>{etZona(z)}</div>
                {fincasPend.filter(f => f.zona === z).map(Tarjeta)}
              </div>
            )) : fincasPend.map(Tarjeta)}
          </div>
        </div>
      )}
    </div>
  )
}

// Campana de correcciones por aprobar (estilo notificaciones).
function Campana({ corrPend, reponer = [], dieselPend = [], onIr, onIrReponer, onIrDiesel }) {
  const [abierto, setAbierto] = useState(false)
  const totalDiesel = dieselPend.reduce((t, d) => t + d.n, 0)
  const total = corrPend.reduce((t, c) => t + c.n, 0) + reponer.length + totalDiesel
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setAbierto(a => !a)} title="Correcciones por aprobar"
        style={{ position: 'relative', background: total ? '#E24B4A' : 'rgba(255,255,255,0.12)',
                 border: 'none', borderRadius: '9px', width: '34px', height: '30px', cursor: 'pointer',
                 display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white' }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {total > 0 && (
          <span style={{ position: 'absolute', top: '-6px', right: '-6px', background: 'white',
                         color: '#E24B4A', borderRadius: '20px', fontSize: '10px', fontWeight: 600,
                         minWidth: '17px', height: '17px', display: 'flex', alignItems: 'center',
                         justifyContent: 'center', padding: '0 4px' }}>{total}</span>
        )}
      </button>
      {abierto && (
        <>
          <div onClick={() => setAbierto(false)}
               style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', right: 0, top: '38px', width: '300px', background: 'white',
                        border: '0.5px solid #dce6ef', borderRadius: '12px', zIndex: 41,
                        boxShadow: '0 8px 24px rgba(2,40,71,0.14)', overflow: 'hidden' }}>
            <div style={{ padding: '12px 15px', borderBottom: '0.5px solid #eef3f7', fontWeight: 500,
                          fontSize: '14px', color: NAVY }}>
              Correcciones por aprobar
            </div>
            {total === 0 ? (
              <div style={{ padding: '18px 15px', fontSize: '13px', color: '#7d8fa0', textAlign: 'center' }}>
                Nada pendiente.
              </div>
            ) : corrPend.map((c, i) => (
              <button key={i} onClick={() => { setAbierto(false); onIr(c) }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                         gap: '10px', padding: '11px 15px', background: 'white', border: 'none',
                         borderBottom: '0.5px solid #f1f6f9', cursor: 'pointer', fontFamily: 'inherit',
                         textAlign: 'left' }}>
                <span>
                  <span style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: NAVY }}>
                    {String(c.nombre).toUpperCase()}
                  </span>
                  <span style={{ display: 'block', fontSize: '11px', color: '#7d8fa0' }}>{c.etiqueta}</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ background: '#FAEEDA', color: '#854F0B', borderRadius: '20px',
                                 fontSize: '11px', fontWeight: 500, padding: '2px 9px' }}>{c.n}</span>
                  <span style={{ fontSize: '12px', color: '#0D6CB0', fontWeight: 500 }}>Ver</span>
                </span>
              </button>
            ))}
            {reponer.length > 0 && (
              <>
                <div style={{ padding: '10px 15px 6px', fontSize: '11px', fontWeight: 600, letterSpacing: '.04em',
                              textTransform: 'uppercase', color: '#a23a38', background: '#FDF3F3',
                              borderTop: '0.5px solid #eef3f7' }}>Por reponer ({reponer.length})</div>
                {reponer.map((r, i) => {
                  const U = { mg: 'mg', gramos: 'g', kg: 'kg', t: 't', libras: 'lb', ml: 'mL', cl: 'cL', litros: 'L', m3: 'm³', gal: 'gal', floz: 'fl oz', unidad: 'u', sacos: 'sacos' }
                  return (
                    <button key={'r' + i} onClick={() => { setAbierto(false); onIrReponer && onIrReponer(r.finca_id) }}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                               gap: '10px', padding: '10px 15px', background: 'white', border: 'none',
                               borderBottom: '0.5px solid #f1f6f9', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                      <span>
                        <span style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: NAVY }}>{String(r.finca).toUpperCase()}</span>
                        <span style={{ display: 'block', fontSize: '11px', color: '#7d8fa0' }}>{r.insumo}: {Math.round(r.saldo_app * 100) / 100} / mín {r.minimo} {U[r.unidad] || r.unidad}</span>
                      </span>
                      <span style={{ fontSize: '12px', color: '#0D6CB0', fontWeight: 500 }}>Ver</span>
                    </button>
                  )
                })}
              </>
            )}
            {dieselPend.length > 0 && (
              <>
                <div style={{ padding: '10px 15px 6px', fontSize: '11px', fontWeight: 600, letterSpacing: '.04em',
                              textTransform: 'uppercase', color: '#854F0B', background: '#FDF7EC',
                              borderTop: '0.5px solid #eef3f7' }}>Diesel · correcciones ({totalDiesel})</div>
                {dieselPend.map((d, i) => (
                  <button key={'d' + i} onClick={() => { setAbierto(false); onIrDiesel && onIrDiesel(d) }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                             gap: '10px', padding: '11px 15px', background: 'white', border: 'none',
                             borderBottom: '0.5px solid #f1f6f9', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                    <span>
                      <span style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: NAVY }}>{String(d.nombre).toUpperCase()}</span>
                      <span style={{ display: 'block', fontSize: '11px', color: '#7d8fa0' }}>Diesel: corrección por aprobar</span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ background: '#FAEEDA', color: '#854F0B', borderRadius: '20px',
                                     fontSize: '11px', fontWeight: 500, padding: '2px 9px' }}>{d.n}</span>
                      <span style={{ fontSize: '12px', color: '#0D6CB0', fontWeight: 500 }}>Ver</span>
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Centro({ children }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexDirection: 'column', color: NAVY, textAlign: 'center', padding: '1rem',
                  fontFamily: 'Inter, system-ui, sans-serif' }}>
      {children}
    </div>
  )
}

function IrAlPortal() {
  useEffect(() => {
    const t = setTimeout(() => { window.location.href = HUB_URL }, 1200)
    return () => clearTimeout(t)
  }, [])

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(160deg, #043a68 0%, #022847 100%)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
                  fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ background: 'white', borderRadius: '14px', padding: '1rem 1.5rem',
                      display: 'inline-block', marginBottom: '1.5rem' }}>
          <img src="/logo.png" alt="CostaMarket" style={{ height: '46px', width: 'auto', display: 'block' }} />
        </div>
        <div style={{ color: 'white', fontSize: '17px', fontWeight: 500, marginBottom: '6px' }}>Producción</div>
        <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: '14px', marginBottom: '1.5rem' }}>
          Llevándote al portal para iniciar sesión...
        </div>
        <a href={HUB_URL} style={{ display: 'inline-block', padding: '11px 26px', fontSize: '15px',
                  fontWeight: 500, background: 'white', color: NAVY, borderRadius: '8px', textDecoration: 'none' }}>
          Ir al portal
        </a>
      </div>
    </div>
  )
}
