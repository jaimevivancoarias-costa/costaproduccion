import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [perfil, setPerfil] = useState(null)
  const [unidades, setUnidades] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setUser(session.user)
        cargarPerfil(session.user.id)
      } else {
        setLoading(false)
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setUser(session.user)
        cargarPerfil(session.user.id)
      } else {
        setUser(null)
        setPerfil(null)
        setUnidades([])
        setLoading(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function cargarPerfil(authId) {
    try {
      const { data: usuarioData } = await supabase
        .from('usuarios')
        .select('*')
        .eq('id', authId)
        .single()

      if (!usuarioData) { setLoading(false); return }

      setPerfil(usuarioData)

      if (usuarioData.super_admin) {
        const { data: todasUnidades } = await supabase
          .from('unidades_negocio')
          .select('*')
          .order('orden')
        setUnidades((todasUnidades || []).map(u => ({ ...u, unidad_id: u.id })))
      } else {
        const { data: misPermisos } = await supabase
          .from('usuario_unidades')
          .select('unidad_id, rol')
          .eq('usuario_id', authId)
          .eq('activo', true)

        const ids = (misPermisos || []).map(p => p.unidad_id)

        if (ids.length === 0) { setUnidades([]); return }

        const { data: misUnidades } = await supabase
          .from('unidades_negocio')
          .select('*')
          .in('id', ids)
          .order('orden')

        const lista = (misUnidades || []).map(u => ({
          ...u,
          unidad_id: u.id,
          rol: misPermisos.find(p => p.unidad_id === u.id)?.rol
        }))

        setUnidades(lista)
      }

    } catch (err) {
      console.error('Error:', err)
    } finally {
      setLoading(false)
    }
  }

  async function login(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    return data
  }

  async function logout() {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ user, perfil, unidades, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
