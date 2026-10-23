-- ============================================================================
-- CORRECCIÓN v2 — restaura el panel de administración del Hub
-- ----------------------------------------------------------------------------
-- La v1 (20261022_rls_usuario_unidades.sql) cerró bien la fuga, pero fue
-- demasiado estricta: el Hub administra roles desde el cliente con
-- insert/update/delete sobre usuario_unidades y lista a TODOS los usuarios con
-- select('*'). La v1 revocó la escritura y la policy "ver lo mío" dejó al
-- super_admin viendo solo sus propias filas.
--
-- Esta v2 mantiene la seguridad (anónimo = 0 acceso; usuario normal = solo lo
-- suyo) y le devuelve acceso COMPLETO al super_admin, identificándolo por la
-- columna public.usuarios.super_admin (que es como ya lo hace el Hub).
--
-- Ejecutar DESPUÉS de la v1, en el SQL Editor de Supabase.
-- ⚠️ Probar en entorno de prueba y confirmar login + panel de usuarios del Hub.
-- ============================================================================

begin;

-- 1) Helper SECURITY DEFINER: ¿el usuario actual es super_admin?
--    Va en SECURITY DEFINER para poder leer usuarios sin depender del RLS de
--    esa tabla y sin riesgo de recursión dentro de las policies.
create or replace function public.es_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select super_admin from public.usuarios where id = auth.uid()),
    false
  );
$$;

revoke all on function public.es_super_admin() from public;
grant execute on function public.es_super_admin() to authenticated;

-- 2) Volver a conceder los privilegios de tabla a authenticated.
--    OJO: esto NO reabre la fuga: RLS sigue activo y filtra fila por fila.
grant select, insert, update, delete on public.usuario_unidades to authenticated;

-- 3) Políticas de usuario_unidades.
--    LECTURA: cada quien ve lo suyo; el super_admin ve todo.
drop policy if exists "usuario_unidades: ver lo mío" on public.usuario_unidades;
drop policy if exists "usuario_unidades: select" on public.usuario_unidades;
create policy "usuario_unidades: select"
  on public.usuario_unidades
  for select
  to authenticated
  using (usuario_id = auth.uid() or public.es_super_admin());

--    ESCRITURA: solo el super_admin (agregar, cambiar o quitar roles).
drop policy if exists "usuario_unidades: insert admin" on public.usuario_unidades;
create policy "usuario_unidades: insert admin"
  on public.usuario_unidades
  for insert
  to authenticated
  with check (public.es_super_admin());

drop policy if exists "usuario_unidades: update admin" on public.usuario_unidades;
create policy "usuario_unidades: update admin"
  on public.usuario_unidades
  for update
  to authenticated
  using (public.es_super_admin())
  with check (public.es_super_admin());

drop policy if exists "usuario_unidades: delete admin" on public.usuario_unidades;
create policy "usuario_unidades: delete admin"
  on public.usuario_unidades
  for delete
  to authenticated
  using (public.es_super_admin());

-- 4) unidades_negocio: el Hub SOLO la lee (no la edita), así que la policy de
--    lectura autenticada de la v1 ya alcanza. No se toca aquí.

commit;

-- ============================================================================
-- VERIFICACIÓN
--  a) Anónimo (sigue bloqueado):
--     GET  /rest/v1/usuario_unidades            -> [] o 401
--     PATCH/POST/DELETE                          -> 401
--  b) Usuario normal logueado: GET usuario_unidades -> SOLO sus filas.
--  c) super_admin logueado: GET usuario_unidades -> TODAS; e insert/update/delete OK.
--  d) En el Hub: login de un usuario normal y del super_admin + panel de usuarios.
-- ============================================================================
