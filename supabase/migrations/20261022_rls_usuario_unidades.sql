-- ============================================================================
-- Cierre de seguridad: public.usuario_unidades (y unidades_negocio)
-- ----------------------------------------------------------------------------
-- Problema (auditoría 2026-10-22): con la anon key pública, sin iniciar sesión,
--   GET   /rest/v1/usuario_unidades  -> 206, 46 filas completas
--   PATCH /rest/v1/usuario_unidades  -> 200 (anon tiene grant de escritura)
-- Es decir: cualquiera puede leer el mapa de usuarios/roles de toda la
-- organización y, con alta probabilidad, modificar roles.
--
-- ⚠️  ESTA TABLA LA USA TAMBIÉN EL HUB. Aplicar primero en un proyecto/branch de
--     prueba, verificar que el Hub siga funcionando, y recién ahí llevar a prod.
--     Ejecutar en el SQL Editor de Supabase o con `supabase db push`.
-- ============================================================================

begin;

-- 1) Diagnóstico: ¿RLS activo? ¿qué GRANTs tiene anon/authenticated hoy?
--    (Sólo informativo; podés correr estos SELECT por separado antes.)
-- select relrowsecurity from pg_class where oid = 'public.usuario_unidades'::regclass;
-- select grantee, privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'usuario_unidades';

-- 2) Quitar TODA escritura por API a los roles del cliente.
--    La gestión de usuarios/roles debe hacerse desde el servidor (service_role)
--    o desde el panel, nunca desde el navegador con la anon key.
revoke insert, update, delete, truncate
  on public.usuario_unidades from anon, authenticated;

-- 3) Activar RLS (sin políticas, por defecto NIEGA todo lo que quede).
alter table public.usuario_unidades enable row level security;
alter table public.usuario_unidades force row level security;

-- 4) Lectura mínima necesaria para el cliente.
--    OPCIÓN A (recomendada): cada usuario sólo ve SUS propias asignaciones.
--    Es lo que necesita el login para calcular permisos del usuario actual.
drop policy if exists "usuario_unidades: ver lo mío" on public.usuario_unidades;
create policy "usuario_unidades: ver lo mío"
  on public.usuario_unidades
  for select
  to authenticated
  using (usuario_id = auth.uid());

--    OPCIÓN B (si el Hub necesita que un jefe vea a los demás de su unidad):
--    descomentar y ajustar. Requiere poder saber el rol del usuario actual
--    SIN volver a consultar esta misma tabla (si no, recursión en la policy).
--    Lo más limpio es guardar el rol en el JWT (app_metadata) y leerlo así:
-- drop policy if exists "usuario_unidades: jefe ve su unidad" on public.usuario_unidades;
-- create policy "usuario_unidades: jefe ve su unidad"
--   on public.usuario_unidades
--   for select
--   to authenticated
--   using (
--     (auth.jwt() -> 'app_metadata' ->> 'rol') = 'jefe'
--     and unidad_id = (auth.jwt() -> 'app_metadata' ->> 'unidad_id')
--   );

--    Si NINGÚN cliente necesita leer esta tabla (todo se resuelve server-side),
--    no crees ninguna policy y además quitá el select a anon:
-- revoke select on public.usuario_unidades from anon;

-- ============================================================================
-- 5) unidades_negocio: también legible por anónimo (6 filas con info interna).
--    Si es un catálogo que el cliente necesita tras login, dejá sólo lectura a
--    usuarios autenticados; si no, revocá también a authenticated.
-- ============================================================================
revoke insert, update, delete, truncate
  on public.unidades_negocio from anon, authenticated;
revoke select on public.unidades_negocio from anon;

alter table public.unidades_negocio enable row level security;
alter table public.unidades_negocio force row level security;

drop policy if exists "unidades_negocio: lectura autenticada" on public.unidades_negocio;
create policy "unidades_negocio: lectura autenticada"
  on public.unidades_negocio
  for select
  to authenticated
  using (true);

commit;

-- ============================================================================
-- VERIFICACIÓN tras aplicar (debe dar 401 o lista vacía, NO filas):
--   curl -s "https://bzknjbxkjqmfebwfjpnk.supabase.co/rest/v1/usuario_unidades?select=*" \
--     -H "apikey: <ANON_KEY>"
--   curl -s -X PATCH \
--     "https://bzknjbxkjqmfebwfjpnk.supabase.co/rest/v1/usuario_unidades?id=eq.<algún-id>" \
--     -H "apikey: <ANON_KEY>" -H "Content-Type: application/json" -d '{"rol":"jefe"}'
--   -> esperado: 401 permission denied / 403, y el GET logueado sólo tus filas.
--
-- Y revisar advisories: deberían desaparecer los avisos de RLS en estas tablas.
-- ============================================================================
