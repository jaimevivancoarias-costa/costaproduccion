import { useState, useEffect } from 'react'
import { useAuth } from './context/AuthContext'
import RegistroDiario from './pages/RegistroDiario'
import Eventos from './pages/Eventos'
import EnConstruccion from './pages/EnConstruccion'

// Navegacion de dos niveles (regla 9): la finca vive arriba como
// selector, el lateral queda para los modulos.

const HUB_URL = import.meta.env.VITE_HUB_URL || 'https://costamarket-hub.vercel.app'

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#dce6ef'
const GRIS = '#7d8fa0'

const MODULOS = [
  { id: 'resumen',    nombre: 'Resumen',        icono: 'grid' },
  { id: 'registro',   nombre: 'Registro diario', icono: 'calendario' },
  { id: 'eventos',    nombre: 'Ciclos y eventos', icono: 'ciclo' },
  { id: 'gramaje',    nombre: 'Gramaje',        icono: 'barras' },
  { id: 'inventario', nombre: 'Inventario',     icono: 'caja' },
  { id: 'costos',     nombre: 'Costos',         icono: 'moneda' },
  { id: 'historial',  nombre: 'Historial',      icono: 'reloj' },
]

function Icono({ tipo }) {
  const p = { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none',
              stroke: 'currentColor', strokeWidth: 1.5 }
  if (tipo === 'grid') return <svg {...p}><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>
  if (tipo === 'calendario') return <svg {...p}><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>
  if (tipo === 'ciclo') return <svg {...p}><path d="M13.5 8a5.5 5.5 0 1 1-1.8-4.1"/><path d="M13.8 1.5v3h-3"/></svg>
  if (tipo === 'barras') return <svg {...p}><path d="M3 13V7M8 13V3M13 13v-4"/></svg>
  if (tipo === 'caja') return <svg {...p}><path d="M2 5l6-3 6 3v6l-6 3-6-3z"/><path d="M2 5l6 3 6-3M8 8v6"/></svg>
  if (tipo === 'moneda') return <svg {...p}><circle cx="8" cy="8" r="6"/><path d="M8 4.5v7M6 6.5h3M6 9.5h3"/></svg>
  return <svg {...p}><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>
}

export default function App() {
  const { user, nombre, fincas, esJefe, cargando, logout } = useAuth()
  const [fincaId, setFincaId] = useState(null)
  const [modulo, setModulo] = useState('registro')

  useEffect(() => {
    if (fincas.length && !fincaId) setFincaId(fincas[0].id)
  }, [fincas, fincaId])

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
          <span style={{ color: 'rgba(255,255,255,0.9)', fontSize: '14px', fontWeight: 500, letterSpacing: '0.08em' }}>
            PRODUCCIÓN
          </span>
          {fincas.length > 1 ? (
            <select
              value={finca.id}
              onChange={e => setFincaId(e.target.value)}
              style={{ background: 'rgba(255,255,255,0.1)', border: '0.5px solid rgba(255,255,255,0.18)',
                       color: 'white', borderRadius: '9px', padding: '7px 12px', fontFamily: 'inherit',
                       fontSize: '13px', fontWeight: 600, letterSpacing: '0.05em' }}
            >
              {fincas.map(f => (
                <option key={f.id} value={f.id} style={{ color: NAVY }}>
                  {String(f.nombre).toUpperCase()}
                </option>
              ))}
            </select>
          ) : (
            <span style={{ background: 'rgba(255,255,255,0.1)', borderRadius: '9px', padding: '7px 12px',
                           fontSize: '13px', fontWeight: 600, letterSpacing: '0.05em', color: 'white' }}>
              {String(finca.nombre).toUpperCase()}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <a href={HUB_URL} style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', textDecoration: 'none' }}>Portal</a>
          <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.75)' }}>{nombre || user.email}</span>
          <button onClick={logout} style={{ background: 'none', border: 'none', cursor: 'pointer',
                    color: 'rgba(255,255,255,0.5)', fontSize: '12px', fontFamily: 'inherit' }}>Salir</button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        <nav style={{ width: '178px', flexShrink: 0, background: 'white',
                      borderRight: '0.5px solid ' + BORDE, minHeight: 'calc(100vh - 56px)',
                      padding: '1.1rem 0.7rem' }}>
          {MODULOS.map(m => {
            const activo = m.id === modulo
            return (
              <button
                key={m.id}
                onClick={() => setModulo(m.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '9px', width: '100%',
                  border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px',
                  padding: '10px', borderRadius: '8px', marginBottom: '2px', textAlign: 'left',
                  background: activo ? '#E6F1FB' : 'transparent',
                  color: activo ? AZUL : NAVY,
                  fontWeight: activo ? 500 : 400,
                  opacity: activo ? 1 : 0.85,
                }}
              >
                <Icono tipo={m.icono} />
                {m.nombre}
              </button>
            )
          })}
        </nav>

        <div style={{ flex: 1, minWidth: 0 }}>
          {modulo === 'registro' ? (
            <RegistroDiario
              key={finca.id}
              finca={finca}
              esJefe={esJefe}
              soloLectura={soloLectura}
            />
          ) : modulo === 'eventos' ? (
            <Eventos
              key={finca.id}
              finca={finca}
              esJefe={esJefe}
              soloLectura={soloLectura}
            />
          ) : (
            <EnConstruccion modulo={MODULOS.find(m => m.id === modulo)} />
          )}
        </div>
      </div>
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
