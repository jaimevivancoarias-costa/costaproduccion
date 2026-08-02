import { useState, useEffect } from 'react'
import { useAuth } from './context/AuthContext'
import RegistroDiario from './pages/RegistroDiario'

// Este modulo no tiene login propio. Se entra siempre desde el Hub,
// que pasa la sesion por la URL. Si alguien llega directo sin sesion,
// se lo manda al portal.

const HUB_URL = import.meta.env.VITE_HUB_URL || 'https://costamarket-hub.vercel.app'

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#d4e0eb'

export default function App() {
  const { user, fincas, cargando, logout } = useAuth()
  const [fincaId, setFincaId] = useState(null)
  const [menuAbierto, setMenuAbierto] = useState(true)

  useEffect(() => {
    if (fincas.length && !fincaId) setFincaId(fincas[0].id)
  }, [fincas, fincaId])

  if (cargando) return <Centro><Puntos /></Centro>

  if (!user) return <IrAlPortal />

  if (!fincas.length) {
    return (
      <Centro>
        <div style={{ fontSize: '15px', marginBottom: '6px', letterSpacing: '0.05em' }}>TODAVIA NO TIENES FINCAS ASIGNADAS</div>
        <div style={{ fontSize: '13px', color: '#7d8fa0' }}>Pide a tu jefe que te de acceso.</div>
      </Centro>
    )
  }

  const finca = fincas.find(f => f.id === fincaId) || fincas[0]
  const unaSola = fincas.length === 1

  return (
    <div style={{ minHeight: '100vh' }}>
      <div style={{ background: NAVY, height: '56px', padding: '0 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {!unaSola && (
            <button
              onClick={() => setMenuAbierto(v => !v)}
              aria-label={menuAbierto ? 'Ocultar fincas' : 'Ver fincas'}
              style={{
                background: 'rgba(255,255,255,0.08)', border: 'none', cursor: 'pointer',
                color: 'rgba(255,255,255,0.85)', borderRadius: '7px', padding: '7px 9px',
                lineHeight: 0, fontFamily: 'inherit',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M2 4h12M2 8h12M2 12h12" />
              </svg>
            </button>
          )}
          <a href={HUB_URL} style={{ display: 'flex', alignItems: 'center' }}>
            <img src="/logo.png" alt="CostaMarket" style={{ height: '30px', width: 'auto' }} />
          </a>
          <span style={{ color: 'rgba(255,255,255,0.9)', fontSize: '14px', fontWeight: 500, letterSpacing: '0.08em' }}>PRODUCCION</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <a href={HUB_URL} style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', textDecoration: 'none' }}>Portal</a>
          <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>{user.email}</span>
          <button onClick={logout} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.5)', fontSize: '12px', fontFamily: 'inherit' }}>Salir</button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        {!unaSola && menuAbierto && (
          <div style={{ width: '186px', flexShrink: 0, borderRight: '0.5px solid ' + BORDE, minHeight: 'calc(100vh - 56px)', padding: '1rem 0.75rem', background: 'white' }}>
            <div style={{ fontSize: '10px', letterSpacing: '0.1em', color: '#7d8fa0', padding: '0 8px 8px' }}>FINCAS</div>
            {fincas.map(f => (
              <button
                key={f.id}
                onClick={() => setFincaId(f.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: '13px', letterSpacing: '0.04em',
                  padding: '9px 10px', borderRadius: '8px', marginBottom: '2px',
                  background: f.id === finca.id ? '#E6F1FB' : 'transparent',
                  color: f.id === finca.id ? AZUL : NAVY,
                  fontWeight: f.id === finca.id ? 500 : 400,
                }}
              >{String(f.nombre).toUpperCase()}</button>
            ))}
          </div>
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          <RegistroDiario
            key={finca.id}
            fincaId={finca.id}
            fincaNombre={finca.nombre}
            soloLectura={finca.rol === 'visor'}
          />
        </div>
      </div>
    </div>
  )
}

function Centro({ children }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', color: NAVY, textAlign: 'center', padding: '1rem' }}>
      {children}
    </div>
  )
}

function Puntos() {
  return <div style={{ color: '#7d8fa0', fontSize: '15px' }}>Cargando...</div>
}

function IrAlPortal() {
  // Se manda solo. El boton queda por si el navegador bloquea el salto.
  useEffect(() => {
    const t = setTimeout(() => { window.location.href = HUB_URL }, 1200)
    return () => clearTimeout(t)
  }, [])

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(160deg, #043a68 0%, #022847 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ background: 'white', borderRadius: '14px', padding: '1rem 1.5rem', display: 'inline-block', marginBottom: '1.5rem' }}>
          <img src="/logo.png" alt="CostaMarket" style={{ height: '46px', width: 'auto', display: 'block' }} />
        </div>
        <div style={{ color: 'white', fontSize: '17px', fontWeight: 500, marginBottom: '6px' }}>Produccion</div>
        <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: '14px', marginBottom: '1.5rem' }}>
          Llevandote al portal para iniciar sesion...
        </div>
        <a href={HUB_URL} style={{
          display: 'inline-block', padding: '11px 26px', fontSize: '15px', fontWeight: 500,
          background: 'white', color: NAVY, borderRadius: '8px', textDecoration: 'none',
        }}>Ir al portal</a>
      </div>
    </div>
  )
}
