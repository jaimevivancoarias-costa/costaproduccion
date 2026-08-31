import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// AuthContext propio del modulo Produccion.
// No reutiliza el del Hub porque aqui los permisos salen de
// produccion.usuario_finca, no de public.usuario_unidades.

const AuthContext = createContext({})
export const useAuth = () => useContext(AuthContext)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [nombre, setNombre] = useState(null)
  const [fincas, setFincas] = useState([])
  const [esJefe, setEsJefe] = useState(false)
  const [cargando, setCargando] = useState(true)

  useEffect(() => { iniciar() }, [])

  async function iniciar() {
    try {
      // El Hub entra pasando los tokens por la URL.
      const params = new URLSearchParams(window.location.search)
      const access_token = params.get('access_token')
      const refresh_token = params.get('refresh_token')

      if (access_token && refresh_token) {
        await supabase.auth.setSession({ access_token, refresh_token })
        window.history.replaceState({}, '', window.location.pathname)
      }

      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { setCargando(false); return }

      setUser(session.user)
      await Promise.all([cargarNombre(session.user.id), cargarPermisos()])
    } catch {
      setCargando(false)
    }
  }

  // El nombre visible vive en public.usuarios, la misma tabla que usa el Hub.
  async function cargarNombre(id) {
    const { data } = await supabase
      .from('usuarios')
      .select('nombre')
      .eq('id', id)
      .maybeSingle()
    if (data?.nombre) setNombre(data.nombre)
  }

  async function cargarPermisos() {
    const { data } = await supabase
      .schema('produccion')
      .from('usuario_finca')
      .select('rol, finca_id, finca:finca_id (id, codigo, nombre, activa, zona)')

    const filas = data || []
    const jefe = filas.some(f => f.rol === 'jefe')
    setEsJefe(jefe)

    // El jefe se registra con una sola fila de finca_id nulo, que
    // significa "todas". Sus fincas se leen del catalogo, asi una finca
    // nueva le aparece sola sin tener que darle permiso otra vez.
    if (jefe) {
      const { data: todas } = await supabase
        .schema('produccion')
        .from('finca')
        .select('id, codigo, nombre, activa, zona')
        .eq('activa', true)
        .order('nombre')
      setFincas((todas || []).map(f => ({ ...f, rol: 'jefe' })))
      setCargando(false)
      return
    }

    setFincas(
      filas
        .filter(f => f.finca && f.finca.activa)
        .map(f => ({ ...f.finca, rol: f.rol }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre))
    )
    setCargando(false)
  }

  async function login(email, password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return { error }
    const { data: { session } } = await supabase.auth.getSession()
    setUser(session?.user ?? null)
    if (session?.user) await cargarNombre(session.user.id)
    await cargarPermisos()
    return {}
  }

  async function logout() {
    await supabase.auth.signOut()
    setUser(null)
    setNombre(null)
    setFincas([])
    setEsJefe(false)
  }

  return (
    <AuthContext.Provider value={{ user, nombre, fincas, esJefe, cargando, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
