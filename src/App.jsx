import { useState, useEffect } from 'react'
import { useAuth } from './context/AuthContext'
import RegistroDiario from './pages/RegistroDiario'

const NAVY = '#022847'
const AZUL = '#0D6CB0'
const BORDE = '#d4e0eb'

export default function App() {
  const { user, fincas, cargando, login, logout } = useAuth()
  const [fincaId, setFincaId] = useState(null)

  useEffect(() => {
    if (fincas.length && !fincaId) setFincaId(fincas[0].id)
  }, [fincas, fincaId])

  if (cargando) return <Centro>Cargando...</Centro>
  if (!user) return <Login onLogin={login} />

  if (!fincas.length) {
    return (
      <Centro>
        <div style={{ fontSize: '16px', marginBottom: '6px' }}>Todavia no tienes fincas asignadas</div>
        <div style={{ fontSize: '14px', color: '#7d8fa0' }}>Pide a tu jefe que te de acceso.</div>
      </Centro>
    )
  }

  const finca = fincas.find(f => f.id === fincaId) || fincas[0]
  const unaSola = fincas.length === 1

  return (
    <div style={{ minHeight: '100vh' }}>
      <div style={{ background: NAVY, height: '56px', padding: '0 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ color: 'white', fontSize: '15px', fontWeight: 500 }}>Produccion</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>{user.email}</span>
          <button onClick={logout} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.5)', fontSize: '12px', fontFamily: 'inherit' }}>Salir</button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        {!unaSola && (
          <div style={{ width: '190px', flexShrink: 0, borderRight: '0.5px solid ' + BORDE, minHeight: 'calc(100vh - 56px)', padding: '1rem 0.75rem', background: 'white' }}>
            <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: '#7d8fa0', padding: '0 8px 8px' }}>Fincas</div>
            {fincas.map(f => (
              <button
                key={f.id}
                onClick={() => setFincaId(f.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: '14px', padding: '9px 10px', borderRadius: '8px',
                  marginBottom: '2px',
                  background: f.id === finca.id ? '#E6F1FB' : 'transparent',
                  color: f.id === finca.id ? AZUL : NAVY,
                  fontWeight: f.id === finca.id ? 500 : 400,
                }}
              >{f.nombre}</button>
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

function Login({ onLogin }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [enviando, setEnviando] = useState(false)

  async function enviar(e) {
    e.preventDefault()
    setEnviando(true)
    setError(null)
    const { error } = await onLogin(email, password)
    if (error) setError('Correo o contrasena incorrectos')
    setEnviando(false)
  }

  const campo = {
    width: '100%', padding: '11px 12px', fontSize: '15px', fontFamily: 'inherit',
    border: '0.5px solid ' + BORDE, borderRadius: '8px', marginBottom: '10px',
    boxSizing: 'border-box', outline: 'none',
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
      <form onSubmit={enviar} style={{ width: '100%', maxWidth: '340px', background: 'white', border: '0.5px solid ' + BORDE, borderRadius: '14px', padding: '2rem 1.75rem' }}>
        <div style={{ fontSize: '11px', letterSpacing: '0.1em', textTransform: 'uppercase', color: AZUL, marginBottom: '4px' }}>CostaMarket</div>
        <h1 style={{ fontSize: '20px', fontWeight: 500, color: NAVY, margin: '0 0 1.5rem' }}>Produccion</h1>

        <input style={campo} type="email" placeholder="Correo" value={email} onChange={e => setEmail(e.target.value)} required />
        <input style={campo} type="password" placeholder="Contrasena" value={password} onChange={e => setPassword(e.target.value)} required />

        {error && <div style={{ fontSize: '13px', color: '#A32D2D', marginBottom: '10px' }}>{error}</div>}

        <button type="submit" disabled={enviando} style={{
          width: '100%', padding: '11px', fontSize: '15px', fontWeight: 500, fontFamily: 'inherit',
          background: AZUL, color: 'white', border: 'none', borderRadius: '8px',
          cursor: enviando ? 'default' : 'pointer', opacity: enviando ? 0.6 : 1,
        }}>{enviando ? 'Entrando...' : 'Entrar'}</button>
      </form>
    </div>
  )
}
