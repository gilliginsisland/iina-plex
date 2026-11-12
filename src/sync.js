// Serialized timelines plus a credential-free journal of unacknowledged updates.
const { query } = require("./plex.js");
const MAX_RECORDS = 100;
const MAX_AGE = 7 * 86400000;
const MAX_RETRIES = 3;
const PLAYBACK_STATES = new Set(["playing", "paused", "buffering", "stopped"]);

function valid(record) {
  return (
    record &&
    typeof record.scope === "string" &&
    typeof record.serverID === "string" &&
    /^\d+$/.test(String(record.ratingKey)) &&
    Number.isFinite(record.time) &&
    record.time >= 0 &&
    Number.isFinite(record.duration) &&
    record.duration > 0 &&
    record.time <= record.duration &&
    Number.isFinite(record.baseline) &&
    record.baseline >= 0 &&
    Number.isFinite(record.updatedAt) &&
    record.updatedAt > 0 &&
    record.updatedAt <= Date.now() + 1000 &&
    Date.now() - record.updatedAt < MAX_AGE
  );
}
const position = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
const key = (entry) => entry.api.scope + ":" + entry.api.serverID + ":" + entry.ratingKey;
const matches = (entry, sender) =>
  String(sender) === String(entry.playerID) || String(sender) === entry.playerID + "-io.iina.plex-library";

class TimelineSync {
  constructor(notify, store = {}) {
    this.notify = notify;
    this.store = store;
    this.sessions = {};
    this.recovering = new Map();
    this.generation = 0;
    this.journal = [];
    try {
      this.journal = this.store.load ? this.store.load() : [];
    } catch (_) {}
    this.journal = Array.isArray(this.journal)
      ? this.journal
          .filter(valid)
          .slice(-MAX_RECORDS)
          .map((record) => ({
            key: record.scope + ":" + record.serverID + ":" + String(record.ratingKey),
            scope: record.scope,
            serverID: record.serverID,
            ratingKey: String(record.ratingKey),
            time: record.time,
            duration: record.duration,
            updatedAt: record.updatedAt,
            baseline: record.baseline
          }))
      : [];
    this.journal = Array.from(new Map(this.journal.map((record) => [record.key, record])).values());
  }

  activeFor(record) {
    return Object.values(this.sessions).some(
      (entry) =>
        key(entry) === record.key && (entry.sending || entry.pending || entry.lastState !== "stopped")
    );
  }

  persist() {
    try {
      if (this.store.save) this.store.save(this.journal);
    } catch (_) {
      this.notify("sync-storage-failed", {});
    }
  }

  prune() {
    const retained = this.journal.filter(valid);
    if (retained.length === this.journal.length) return;
    this.journal = retained;
    this.persist();
  }

  remove(record) {
    // Remove the exact acknowledgement, never a newer update with the same timestamp.
    const index = this.journal.indexOf(record);
    if (index < 0) return;
    this.journal.splice(index, 1);
    this.persist();
  }

  save(entry, update) {
    const itemKey = key(entry);
    this.journal = this.journal.filter((record) => record.key !== itemKey && valid(record));
    const record = {
      key: itemKey,
      scope: entry.api.scope || "",
      serverID: entry.api.serverID,
      ratingKey: entry.ratingKey,
      time: update.time,
      duration: update.duration,
      updatedAt: update.updatedAt,
      baseline: entry.lastAck
    };
    this.journal.push(record);
    this.journal = this.journal.slice(-MAX_RECORDS);
    this.persist();
    return record;
  }

  bind(playerID, sessionID, api, ratingKey, baseline = 0) {
    const entry = {
      playerID,
      api,
      ratingKey: String(ratingKey),
      pending: null,
      sending: false,
      warned: false,
      closing: false,
      retries: 0,
      lastAck: position(baseline),
      lastState: "stopped",
      waiters: []
    };
    for (const old of Object.keys(this.sessions)) {
      if (key(this.sessions[old]) === key(entry)) delete this.sessions[old];
    }
    this.sessions[sessionID] = entry;
  }

  idle(entry) {
    entry.sending = false;
    for (const resolve of entry.waiters.splice(0)) resolve();
  }

  async refreshItem(sessionID, entry) {
    try {
      const item = await entry.api.media(entry.ratingKey).load();
      if (this.sessions[sessionID] !== entry) return;
      this.notify("item-synced", { serverID: entry.api.serverID, item: item.snapshot });
    } catch (_) {
      /* A metadata refresh must not turn an acknowledged update into a retry. */
    }
  }

  async drain(sessionID, entry) {
    if (entry.sending) return;
    entry.sending = true;
    while (entry.pending && this.sessions[sessionID] === entry) {
      const update = entry.pending;
      entry.pending = null;
      const params = {
        ratingKey: entry.ratingKey,
        key: "/library/metadata/" + entry.ratingKey,
        state: update.state,
        time: update.time,
        duration: update.duration
      };
      try {
        await entry.api.request("/:/timeline?" + query(params), {
          method: "post",
          format: "none",
          headers: { "X-Plex-Session-Identifier": sessionID }
        });
        if (this.sessions[sessionID] !== entry) break;
        entry.lastAck = update.time;
        this.remove(update.record);
        if (entry.pending) entry.pending.record = this.save(entry, entry.pending);
        if (entry.warned) this.notify("sync-recovered", {});
        entry.warned = false;
        this.notify("progress-synced", {
          id: entry.ratingKey,
          serverID: entry.api.serverID,
          time: update.time,
          duration: update.duration
        });
        if (update.state === "stopped") await this.refreshItem(sessionID, entry);
      } catch (_) {
        if (this.sessions[sessionID] !== entry) break;
        if (!entry.warned) this.notify("sync-failed", {});
        entry.warned = true;
        if (!entry.pending) entry.pending = update;
        this.idle(entry);
        return;
      }
    }
    this.idle(entry);
    if (entry.closing && !entry.pending) delete this.sessions[sessionID];
  }

  report(data, sender) {
    const entry = data && this.sessions[data.sessionID];
    if (!entry || entry.closing || !matches(entry, sender)) return;
    if (
      !PLAYBACK_STATES.has(data.state) ||
      !Number.isFinite(data.time) ||
      !Number.isFinite(data.duration) ||
      data.time < 0 ||
      Math.round(data.duration) <= 0
    )
      return;
    entry.lastState = data.state;
    entry.pending = {
      state: data.state,
      time: Math.min(Math.round(data.time), Math.round(data.duration)),
      duration: Math.round(data.duration),
      updatedAt: Date.now()
    };
    // Save immediately, even while an older HTTP request is still outstanding.
    entry.pending.record = this.save(entry, entry.pending);
    entry.closing = data.final === true;
    entry.retries = 0;
    return this.drain(data.sessionID, entry);
  }

  retryClosed() {
    for (const id of Object.keys(this.sessions)) {
      const entry = this.sessions[id];
      if (entry.sending || !entry.pending || (!entry.closing && entry.pending.state !== "stopped")) continue;
      if (++entry.retries > MAX_RETRIES) {
        this.notify("sync-abandoned", {});
        if (entry.closing) delete this.sessions[id];
        else entry.pending = null;
        continue;
      }
      this.drain(id, entry);
    }
  }

  close(data, sender) {
    const entry = data && this.sessions[data.sessionID];
    if (!entry || !matches(entry, sender)) return;
    entry.closing = true;
    if (!entry.pending && !entry.sending) delete this.sessions[data.sessionID];
  }

  clear(forget = false) {
    this.generation++;
    this.recovering.clear();
    for (const id of Object.keys(this.sessions)) delete this.sessions[id];
    if (forget) {
      this.journal = [];
      this.persist();
    }
  }

  async recover(api, onlyID) {
    this.prune();
    const recoveryKey = api.scope + ":" + api.serverID;
    // Queue requests so a caller's item filter isn't lost behind another recovery.
    const previous = this.recovering.get(recoveryKey),
      current = this.generation;
    const run = (async () => {
      if (previous) await previous;
      if (this.generation !== current) return;
      for (const [id, entry] of Object.entries(this.sessions)) {
        if (
          entry.api.scope !== api.scope ||
          entry.api.serverID !== api.serverID ||
          (onlyID && entry.ratingKey !== String(onlyID))
        )
          continue;
        if (entry.sending) await new Promise((resolve) => entry.waiters.push(resolve));
        if (this.generation !== current) return;
        if (entry.pending && this.sessions[id] === entry) await this.drain(id, entry);
      }
      for (const record of this.journal.slice()) {
        if (
          record.scope !== api.scope ||
          record.serverID !== api.serverID ||
          (onlyID && record.ratingKey !== String(onlyID)) ||
          this.activeFor(record)
        )
          continue;
        try {
          const item = await api.media(record.ratingKey).load();
          if (this.generation !== current) return;
          if (!this.journal.includes(record) || this.activeFor(record)) continue;
          const serverTime = position(item.offset);
          // Preserve another client's activity, and don't repeat an already applied update.
          if (
            serverTime === record.time ||
            item.lastViewedAt * 1000 > record.updatedAt + 1000 ||
            (serverTime !== record.baseline && serverTime !== record.time)
          ) {
            this.remove(record);
            continue;
          }
          const params = {
            ratingKey: record.ratingKey,
            key: "/library/metadata/" + record.ratingKey,
            state: "stopped",
            time: record.time,
            duration: record.duration,
            offline: 1,
            updated: Math.floor(record.updatedAt / 1000)
          };
          await api.request("/:/timeline?" + query(params), { method: "post", format: "none" });
          if (this.generation !== current) return;
          this.remove(record);
          this.notify("sync-recovered", {});
        } catch (_) {
          /* Keep the record for the next authenticated reconnect. */
        }
      }
    })();
    this.recovering.set(recoveryKey, run);
    try {
      return await run;
    } finally {
      if (this.recovering.get(recoveryKey) === run) this.recovering.delete(recoveryKey);
    }
  }

  pendingPosition(api, id, item) {
    this.prune();
    const record = this.journal.find(
      (record) =>
        record.scope === api.scope && record.serverID === api.serverID && record.ratingKey === String(id)
    );
    if (!record || item.lastViewedAt * 1000 > record.updatedAt + 1000) return null;
    const current = position(item.offset);
    return current === record.baseline || current === record.time ? record.time : null;
  }

  hasPending(api, id) {
    this.prune();
    return this.journal.some(
      (record) =>
        record.scope === api.scope && record.serverID === api.serverID && record.ratingKey === String(id)
    );
  }
}

module.exports = TimelineSync;
