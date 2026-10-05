-- Weinkeller: Datenbank-Schema für Supabase
-- Einmalig im Supabase-Dashboard unter "SQL Editor" ausführen.

-- Alle Datensätze (Weine, Regale, Verkostungen, Einkaufsliste) als JSON-Dokumente pro Benutzer
create table if not exists public.items (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,
  store      text        not null check (store in ('wines', 'racks', 'tastings', 'shopping')),
  data       jsonb       not null,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists items_user_updated_idx on public.items (user_id, updated_at);

-- Zeitstempel immer vom Server setzen (Grundlage für den Abgleich zwischen Geräten)
create or replace function public.items_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists items_touch on public.items;
create trigger items_touch before insert or update on public.items
  for each row execute function public.items_touch();

-- Zugriff über die Data API nur für angemeldete Benutzer
revoke all on public.items from anon;
grant select, insert, update, delete on public.items to authenticated;

-- Row Level Security: jeder Benutzer sieht und ändert nur seine eigenen Daten
alter table public.items enable row level security;

drop policy if exists "items: eigene lesen" on public.items;
create policy "items: eigene lesen" on public.items
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "items: eigene anlegen" on public.items;
create policy "items: eigene anlegen" on public.items
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "items: eigene ändern" on public.items;
create policy "items: eigene ändern" on public.items
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "items: eigene löschen" on public.items;
create policy "items: eigene löschen" on public.items
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Privater Speicher für Etikett-Fotos; Pfad: <user_id>/<foto_id>.jpg
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg'])
on conflict (id) do nothing;

drop policy if exists "photos: eigene lesen" on storage.objects;
create policy "photos: eigene lesen" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "photos: eigene anlegen" on storage.objects;
create policy "photos: eigene anlegen" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "photos: eigene ändern" on storage.objects;
create policy "photos: eigene ändern" on storage.objects
  for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "photos: eigene löschen" on storage.objects;
create policy "photos: eigene löschen" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
