// Serialized timelines plus a credential-free journal of unacknowledged updates.
const { query } = require("./plex.js");
const MAX_RECORDS = 100;
const MAX_AGE = 7 * 86400000;
const MAX_RETRIES = 3;
const PLAYBACK_STATES = new Set(["playing", "paused", "buffering", "stopped"]);

module.exports = function timelineSync(http, headers, notify, store = {}) {
  const sessions = {};
  const recovering = new Map();
  let generation = 0;
  let journal = [];

  function valid(record) {
    return record && typeof record.scope === "string" && typeof record.serverID === "string" &&
      /^\d+$/.test(String(record.ratingKey)) && Number.isFinite(record.time) && record.time >= 0 &&
      Number.isFinite(record.duration) && record.duration > 0 && Number.isFinite(record.updatedAt) &&
      Date.now() - record.updatedAt < MAX_AGE;
  }
  try { journal = store.load ? store.load() : []; } catch (_) {}
  journal = Array.isArray(journal) ? journal.filter(valid).slice(-MAX_RECORDS) : [];

  const key = entry => entry.connection.scope + ":" + entry.connection.serverID + ":" + entry.ratingKey;
  const matches = (entry, sender) => String(sender) === String(entry.playerID) ||
    String(sender) === entry.playerID + "-io.iina.plex-library";
  const activeFor = record => Object.values(sessions).some(entry =>
    key(entry) === record.key && (entry.sending || entry.pending || entry.lastState !== "stopped"));

  function persist() {
    try { if (store.save) store.save(journal); }
    catch (_) { notify("sync-storage-failed", {}); }
  }
  function remove(record) {
    // Remove the exact acknowledgement, never a newer update with the same timestamp.
    const index = journal.indexOf(record);
    if (index < 0) return;
    journal.splice(index, 1);
    persist();
  }
  function save(entry, update) {
    const itemKey = key(entry);
    journal = journal.filter(record => record.key !== itemKey);
    const record = {
      key: itemKey, scope: entry.connection.scope || "", serverID: entry.connection.serverID,
      ratingKey: entry.ratingKey, time: update.time, duration: update.duration,
      updatedAt: update.updatedAt, baseline: entry.lastAck
    };
    journal.push(record);
    journal = journal.slice(-MAX_RECORDS);
    persist();
    return record;
  }
  function bind(playerID, sessionID, connection, ratingKey, baseline = 0) {
    const entry = {
      playerID, connection, ratingKey: String(ratingKey), pending: null, sending: false,
      warned: false, closing: false, retries: 0, lastAck: Number(baseline) || 0,
      lastState: "stopped", waiters: []
    };
    for (const old of Object.keys(sessions)) {
      if (key(sessions[old]) === key(entry)) delete sessions[old];
    }
    sessions[sessionID] = entry;
  }
  function idle(entry) {
    entry.sending = false;
    for (const resolve of entry.waiters.splice(0)) resolve();
  }
  async function refreshItem(sessionID, entry) {
    try {
      const response = await http.get(entry.connection.base + "/library/metadata/" + entry.ratingKey,
        {headers: headers(entry.connection.token)});
      if (response.statusCode < 200 || response.statusCode >= 300 || sessions[sessionID] !== entry) return;
      const data = response.data || JSON.parse(response.text);
      const item = (data.MediaContainer.Metadata || [])[0];
      if (item && String(item.ratingKey) === entry.ratingKey) {
        notify("item-synced", {serverID: entry.connection.serverID, item});
      }
    } catch (_) { /* A metadata refresh must not turn an acknowledged update into a retry. */ }
  }
  async function drain(sessionID, entry) {
    if (entry.sending) return;
    entry.sending = true;
    while (entry.pending && sessions[sessionID] === entry) {
      const update = entry.pending;
      entry.pending = null;
      const params = {
        ratingKey: entry.ratingKey, key: "/library/metadata/" + entry.ratingKey,
        state: update.state, time: update.time, duration: update.duration
      };
      try {
        const requestHeaders = headers(entry.connection.token);
        requestHeaders["X-Plex-Session-Identifier"] = sessionID;
        const response = await http.post(entry.connection.base + "/:/timeline?" + query(params),
          {headers: requestHeaders});
        if (!response || response.statusCode < 200 || response.statusCode >= 300) throw new Error("Timeline rejected");
        if (sessions[sessionID] !== entry) break;
        entry.lastAck = update.time;
        remove(update.record);
        if (entry.pending) entry.pending.record = save(entry, entry.pending);
        if (entry.warned) notify("sync-recovered", {});
        entry.warned = false;
        notify("progress-synced", {
          id: entry.ratingKey, serverID: entry.connection.serverID, time: update.time, duration: update.duration
        });
        if (update.state === "stopped") await refreshItem(sessionID, entry);
      } catch (_) {
        if (sessions[sessionID] !== entry) break;
        if (!entry.warned) notify("sync-failed", {});
        entry.warned = true;
        if (!entry.pending) entry.pending = update;
        idle(entry);
        return;
      }
    }
    idle(entry);
    if (entry.closing && !entry.pending) delete sessions[sessionID];
  }
  function report(data, sender) {
    const entry = data && sessions[data.sessionID];
    if (!entry || entry.closing || !matches(entry, sender)) return;
    if (!PLAYBACK_STATES.has(data.state) || !Number.isFinite(data.time) || !Number.isFinite(data.duration) ||
        data.time < 0 || data.duration <= 0) return;
    entry.lastState = data.state;
    entry.pending = {
      state: data.state, time: Math.min(Math.round(data.time), Math.round(data.duration)),
      duration: Math.round(data.duration), updatedAt: Date.now()
    };
    // Save immediately, even while an older HTTP request is still outstanding.
    entry.pending.record = save(entry, entry.pending);
    entry.closing = data.final === true;
    entry.retries = 0;
    return drain(data.sessionID, entry);
  }
  function retryClosed() {
    for (const id of Object.keys(sessions)) {
      const entry = sessions[id];
      if (entry.sending || !entry.pending || (!entry.closing && entry.pending.state !== "stopped")) continue;
      if (++entry.retries > MAX_RETRIES) {
        notify("sync-abandoned", {});
        if (entry.closing) delete sessions[id];
        else entry.pending = null;
        continue;
      }
      drain(id, entry);
    }
  }
  function close(data, sender) {
    const entry = data && sessions[data.sessionID];
    if (!entry || !matches(entry, sender)) return;
    entry.closing = true;
    if (!entry.pending && !entry.sending) delete sessions[data.sessionID];
  }
  function clear(forget = false) {
    generation++;
    recovering.clear();
    for (const id of Object.keys(sessions)) delete sessions[id];
    if (forget) { journal = []; persist(); }
  }
  async function recover(connection, onlyID) {
    const recoveryKey = connection.scope + ":" + connection.serverID;
    // Queue requests so a caller's item filter isn't lost behind another recovery.
    const previous = recovering.get(recoveryKey), current = generation;
    const run = (async () => {
      if (previous) await previous;
      if (generation !== current) return;
      for (const [id, entry] of Object.entries(sessions)) {
        if (entry.connection.scope !== connection.scope || entry.connection.serverID !== connection.serverID ||
            (onlyID && entry.ratingKey !== String(onlyID))) continue;
        if (entry.sending) await new Promise(resolve => entry.waiters.push(resolve));
        if (generation !== current) return;
        if (entry.pending && sessions[id] === entry) await drain(id, entry);
      }
      for (const record of journal.slice()) {
        if (record.scope !== connection.scope || record.serverID !== connection.serverID ||
            (onlyID && record.ratingKey !== String(onlyID)) || activeFor(record)) continue;
        try {
          const response = await http.get(connection.base + "/library/metadata/" + record.ratingKey,
            {headers: headers(connection.token)});
          if (response.statusCode < 200 || response.statusCode >= 300) continue;
          const data = response.data || JSON.parse(response.text);
          const item = (data.MediaContainer.Metadata || [])[0];
          if (!item || String(item.ratingKey) !== record.ratingKey) continue;
          if (generation !== current) return;
          if (!journal.includes(record) || activeFor(record)) continue;
          const serverTime = Number(item.viewOffset) || 0;
          // Preserve another client's activity, and don't repeat an already applied update.
          if (serverTime === record.time || Number(item.lastViewedAt || 0) * 1000 > record.updatedAt + 1000 ||
              (serverTime !== record.baseline && serverTime !== record.time)) {
            remove(record);
            continue;
          }
          const params = {
            ratingKey: record.ratingKey, key: "/library/metadata/" + record.ratingKey,
            state: "stopped", time: record.time, duration: record.duration,
            offline: 1, updated: Math.floor(record.updatedAt / 1000)
          };
          const result = await http.post(connection.base + "/:/timeline?" + query(params),
            {headers: headers(connection.token)});
          if (generation !== current) return;
          if (result.statusCode >= 200 && result.statusCode < 300) {
            remove(record);
            notify("sync-recovered", {});
          }
        } catch (_) { /* Keep the record for the next authenticated reconnect. */ }
      }
    })();
    recovering.set(recoveryKey, run);
    try { return await run; }
    finally { if (recovering.get(recoveryKey) === run) recovering.delete(recoveryKey); }
  }
  function pendingPosition(connection, id, item) {
    const record = journal.find(record => record.scope === connection.scope &&
      record.serverID === connection.serverID && record.ratingKey === String(id));
    if (!record || Number(item.lastViewedAt || 0) * 1000 > record.updatedAt + 1000) return null;
    const current = Number(item.viewOffset) || 0;
    return current === record.baseline || current === record.time ? record.time : null;
  }
  function hasPending(connection, id) {
    return journal.some(record => record.scope === connection.scope &&
      record.serverID === connection.serverID && record.ratingKey === String(id));
  }
  return {bind, report, close, retryClosed, clear, recover, pendingPosition, hasPending};
};
