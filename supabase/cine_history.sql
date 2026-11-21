-- CineLords: gesehene Filme je Nutzer. Snapshot (Titel/Kino/Datum), keine Referenz auf films.json:
-- der Scraper entfernt vergangene Vorstellungen. screening_id nur, um "Bin dabei" -> History nicht doppelt anzulegen
-- und den Snapshot beim Entmarkieren vor der Vorstellung wieder zu löschen (null bei Einträgen ohne Vorstellung).
create table if not exists public.cine_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  screening_id text,
  title text not null check (char_length(title) between 1 and 300),
  cinema_name text check (char_length(cinema_name) <= 200),
  cinema_city text check (char_length(cinema_city) <= 100),
  date date not null,
  time text check (time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  version text check (char_length(version) <= 10),
  rating smallint check (rating between 1 and 5),
  created_at timestamptz not null default now(),
  unique (user_id, screening_id)
);

alter table public.cine_history enable row level security;

create policy "cine_history: eigene lesen" on public.cine_history
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "cine_history: eigene anlegen" on public.cine_history
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "cine_history: eigene ändern" on public.cine_history
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "cine_history: eigene löschen" on public.cine_history
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.cine_history from anon;
grant select, insert, update, delete on public.cine_history to authenticated;
