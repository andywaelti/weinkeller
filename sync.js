// Cloud-Synchronisation und Anmeldung über Supabase.
//
// Prinzip "offline first": Die App liest und schreibt immer lokal (IndexedDB).
// Jede lokale Änderung landet zusätzlich in der Outbox und wird im Hintergrund
// hochgeladen. Beim Abgleich werden Änderungen anderer Geräte geholt; bei
// Konflikten gewinnt der jüngere Stand (Feld `updatedAt`).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { db, uid } from './db.js';

const LIB_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const TABLE = 'items';
const BUCKET = 'photos';
export const SYNC_STORES = ['wines', 'racks', 'tastings', 'shopping'];

let sb = null;
let hooks = {};
let flushTimer = null;
let syncing = null;

export const cloud = {
  enabled: !!(SUPABASE_URL && SUPABASE_ANON_KEY),
  user: null,
  status: { lastSync: null, pending: 0, error: null, busy: false },

  async init(h) {
    hooks = h;
    const { createClient } = await import(LIB_URL);
    sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    const meta = await getMeta();
    cloud.status.lastSync = meta.lastSync || null;
    cloud.status.pending = (await db.all('outbox')).length;
    sb.auth.onAuthStateChange((event, session) => {
      cloud.user = session?.user || null;
      // Supabase empfiehlt, im Callback keine weiteren Supabase-Aufrufe direkt abzuwarten
      setTimeout(() => hooks.onAuth?.(event, cloud.user), 0);
    });
    const { data } = await sb.auth.getSession();
    cloud.user = data.session?.user || null;
    return cloud.user;
  },

  async signIn(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw translate(error);
  },

  async signUp(email, password) {
    const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: appUrl() } });
    if (error) throw translate(error);
    return { needsConfirmation: !data.session };
  },

  async resetPassword(email) {
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
    if (error) throw translate(error);
  },

  async updatePassword(password) {
    const { error } = await sb.auth.updateUser({ password });
    if (error) throw translate(error);
  },

  async signOut() {
    await sb.auth.signOut({ scope: 'local' });
  },

  // Lokale Änderung zum Hochladen vormerken
  async enqueue(store, id, deleted = false) {
    if (!cloud.enabled || !SYNC_STORES.includes(store)) return;
    await db.put('outbox', { id: `${store}:${id}`, store, itemId: id, deleted, time: new Date().toISOString(), rev: uid() });
    cloud.status.pending = (await db.all('outbox')).length;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => cloud.sync({ pull: false }).catch(() => {}), 800);
  },

  // Alle lokalen Daten (z.B. nach dem ersten Anmelden) zum Hochladen vormerken
  async enqueueAll() {
    const time = new Date().toISOString();
    for (const store of SYNC_STORES) {
      for (const item of await db.all(store)) {
        await db.put('outbox', { id: `${store}:${item.id}`, store, itemId: item.id, deleted: false, time, rev: uid() });
      }
    }
    cloud.status.pending = (await db.all('outbox')).length;
  },

  // Hochladen und (optional) Änderungen anderer Geräte holen. Liefert die Zahl geänderter Datensätze.
  sync({ pull = true } = {}) {
    if (!sb || !cloud.user) return Promise.resolve(0);
    if (syncing) return syncing.then(() => (pull ? cloud.sync({ pull }) : 0));
    cloud.status.busy = true;
    hooks.onStatus?.();
    syncing = (async () => {
      try {
        await flush();
        const changed = pull ? await pullChanges() : 0;
        cloud.status.error = null;
        cloud.status.lastSync = new Date().toISOString();
        await setMeta({ lastSync: cloud.status.lastSync });
        return changed;
      } catch (err) {
        cloud.status.error = navigator.onLine ? (err.message || String(err)) : 'Offline – wird später synchronisiert.';
        throw err;
      } finally {
        cloud.status.pending = (await db.all('outbox')).length;
        cloud.status.busy = false;
        syncing = null;
        hooks.onStatus?.();
      }
    })();
    return syncing;
  },

  async downloadPhoto(photoId) {
    const { data, error } = await sb.storage.from(BUCKET).download(`${cloud.user.id}/${photoId}.jpg`);
    if (error) throw error;
    return blobToDataUrl(data);
  },

  deletePhoto(photoId) {
    if (!sb || !cloud.user || !photoId) return;
    sb.storage.from(BUCKET).remove([`${cloud.user.id}/${photoId}.jpg`]).catch(() => {});
  },

  getMeta,
  setMeta,

  // Lokale Kopie leeren (z.B. beim Abmelden oder Benutzerwechsel)
  async clearLocal() {
    for (const store of [...SYNC_STORES, 'outbox']) await db.clear(store);
    await db.put('meta', { id: 'sync' });
    cloud.status.pending = 0;
    cloud.status.lastSync = null;
  },
};

// ---------- intern ----------

async function getMeta() {
  return (await db.get('meta', 'sync')) || { id: 'sync' };
}

async function setMeta(patch) {
  const meta = { ...(await getMeta()), ...patch, id: 'sync' };
  await db.put('meta', meta);
  return meta;
}

function appUrl() {
  return location.origin + location.pathname;
}

function translate(error) {
  const msg = error?.message || String(error);
  const map = [
    [/invalid login credentials/i, 'E-Mail oder Passwort ist falsch.'],
    [/email not confirmed/i, 'Bitte bestätige zuerst deine E-Mail-Adresse (Link in der Bestätigungsmail).'],
    [/already registered|already exists/i, 'Für diese E-Mail-Adresse gibt es bereits ein Konto.'],
    [/password should be at least (\d+)/i, m => `Das Passwort muss mindestens ${m[1]} Zeichen lang sein.`],
    [/rate limit|too many/i, 'Zu viele Versuche. Bitte warte kurz und versuche es erneut.'],
    [/unable to validate email|invalid email/i, 'Bitte gib eine gültige E-Mail-Adresse ein.'],
    [/same password|different from the old/i, 'Das neue Passwort muss sich vom alten unterscheiden.'],
    [/failed to fetch|network/i, 'Keine Verbindung zum Server.'],
  ];
  for (const [re, text] of map) {
    const m = msg.match(re);
    if (m) return new Error(typeof text === 'function' ? text(m) : text);
  }
  return new Error(msg);
}

// Fotos werden separat im Speicher abgelegt; in der Datenbank steht nur die Foto-ID.
function forCloud(store, item) {
  if (store !== 'wines') return item;
  const { photo, photoUploaded, ...rest } = item;
  return rest;
}

async function uploadPhoto(wine) {
  if (!wine.photo || wine.photoUploaded) return;
  if (!wine.photoId) {
    // Foto stammt noch aus der Zeit vor der Synchronisation
    wine.photoId = uid();
    await db.put('wines', wine);
    hooks.onPatched?.('wines', wine);
  }
  const blob = await (await fetch(wine.photo)).blob();
  const { error } = await sb.storage.from(BUCKET)
    .upload(`${cloud.user.id}/${wine.photoId}.jpg`, blob, { upsert: true, contentType: 'image/jpeg' });
  if (error) throw error;
  const current = await db.get('wines', wine.id);
  if (current && current.photoId === wine.photoId) {
    current.photoUploaded = true;
    await db.put('wines', current);
    hooks.onPatched?.('wines', current);
  }
}

async function flush() {
  const entries = await db.all('outbox');
  if (!entries.length) return;
  const rows = [];
  for (const e of entries) {
    const item = e.deleted ? null : await db.get(e.store, e.itemId);
    if (!item) {
      rows.push({ user_id: cloud.user.id, id: e.itemId, store: e.store, deleted: true, data: { id: e.itemId, updatedAt: e.time } });
      continue;
    }
    if (e.store === 'wines') await uploadPhoto(item);
    rows.push({ user_id: cloud.user.id, id: item.id, store: e.store, deleted: false, data: forCloud(e.store, item) });
  }
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb.from(TABLE).upsert(rows.slice(i, i + 200), { onConflict: 'user_id,id' });
    if (error) throw error;
  }
  // Nur Einträge entfernen, die sich während des Hochladens nicht erneut geändert haben
  for (const e of entries) {
    const cur = await db.get('outbox', e.id);
    if (cur && cur.rev === e.rev) await db.delete('outbox', e.id);
  }
}

async function pullChanges() {
  const meta = await getMeta();
  // Kleiner Sicherheitsabstand gegen Zeitüberschneidungen; doppeltes Anwenden ist unschädlich.
  const since = meta.lastPulled ? new Date(new Date(meta.lastPulled).getTime() - 5000).toISOString() : null;
  let newest = meta.lastPulled || null;
  let changed = 0;
  for (let from = 0; ; from += 1000) {
    let q = sb.from(TABLE).select('id,store,data,deleted,updated_at').order('updated_at').range(from, from + 999);
    if (since) q = q.gt('updated_at', since);
    const { data, error } = await q;
    if (error) throw error;
    for (const row of data) {
      if (await applyRemote(row)) changed++;
      if (!newest || new Date(row.updated_at) > new Date(newest)) newest = row.updated_at;
    }
    if (data.length < 1000) break;
  }
  await setMeta({ lastPulled: newest });
  return changed;
}

async function applyRemote(row) {
  if (!SYNC_STORES.includes(row.store)) return false;
  const remoteTime = row.data?.updatedAt || '';
  const pending = await db.get('outbox', `${row.store}:${row.id}`);
  if (pending) {
    if (pending.time >= remoteTime) return false; // lokale Änderung ist neuer und wird hochgeladen
    await db.delete('outbox', pending.id);
  }
  const local = await db.get(row.store, row.id);
  if (row.deleted) {
    if (!local) return false;
    await db.delete(row.store, row.id);
    return true;
  }
  if (local && (local.updatedAt || '') >= remoteTime) return false;
  const item = { ...row.data };
  if (row.store === 'wines' && local?.photo && local.photoId === item.photoId) {
    item.photo = local.photo;
    item.photoUploaded = local.photoUploaded;
  }
  await db.put(row.store, item);
  return true;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
