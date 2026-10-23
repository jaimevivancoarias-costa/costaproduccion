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
  const [esJefeGlobal, setEsJefeGlobal] = useState(false)
  const [cargando, setCargando] = useState(true)

  useEffect(() => {
    iniciar()
    // Si la sesión se pierde en uso (token vencido y el refresh falla, o cierre
    // de sesión), limpiar el usuario para que la app mande a iniciar sesión de
    // nuevo en vez de quedar con todo dando 403.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        setUser(null); setNombre(null); setFincas([]); setEsJefe(false); setEsJefeGlobal(false); setCargando(false)
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        setUser(session.user)
      }
    })
    return () => { sub?.subscription?.unsubscribe?.() }
  }, [])

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

      // Validar que el token siga siendo válido. Si venció y no se puede
      // refrescar (refresh token inválido), getUser da 403 → cerrar sesión y
      // mandar a login, en vez de dejar todo dando 403 con la pantalla cargada.
      const { data: { user: u }, error: eU } = await supabase.auth.getUser()
      if (eU || !u) { try { await supabase.auth.signOut() } catch { /* sin sesión */ } setUser(null); setCargando(false); return }

      setUser(u)
      await Promise.all([cargarNombre(u.id), cargarPermisos()])
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
    // El jefe GLOBAL (rol 'jefe', finca_id nulo) ve las 11 fincas.
    const jefe = filas.some(f => f.rol === 'jefe')
    // La contadora se comporta como jefe (ve todo, dolares, precios,
    // reportes) pero SOLO en las fincas que tiene asignadas. Por eso
    // "verTodo" prende los mismos permisos de pantalla que el jefe, pero
    // la lista de fincas se queda acotada (rama de abajo).
    const contadora = filas.some(f => f.rol === 'contador')
    setEsJefe(jefe || contadora)
    setEsJefeGlobal(jefe)   // solo el jefe global gestiona el catálogo

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
      setFincas((todas || [])
        .map(f => ({ ...f, rol: 'jefe' })))
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
    // Mientras cargan nombre y permisos, mostrar "Cargando" en vez de parpadear
    // la pantalla de "sin fincas" (cargando ya venía en false desde el arranque).
    setCargando(true)
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
    setEsJefeGlobal(false)
  }

  return (
    <AuthContext.Provider value={{ user, nombre, fincas, esJefe, esJefeGlobal, cargando, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
