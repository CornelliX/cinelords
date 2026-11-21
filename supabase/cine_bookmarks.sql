-- CineLords: gemerkte Vorstellungen je Nutzer (gleiches Supabase-Projekt wie LiveLords, eigene Tabelle)
-- screening_id = id aus films.json (stableId, bleibt über Scraper-Läufe gleich)
create table if not exists public.cine_bookmarks (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  screening_id text not null,
  status text not null check (status in ('bookmarked', 'going')),
  created_at timestamptz not null default now(),
  unique (user_id, screening_id, status)
);

alter table public.cine_bookmarks enable row level security;

create policy "cine_bookmarks: eigene lesen" on public.cine_bookmarks
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "cine_bookmarks: eigene anlegen" on public.cine_bookmarks
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "cine_bookmarks: eigene ändern" on public.cine_bookmarks
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "cine_bookmarks: eigene löschen" on public.cine_bookmarks
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.cine_bookmarks from anon;
grant select, insert, update, delete on public.cine_bookmarks to authenticated;
