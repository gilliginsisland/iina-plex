const P = require("./plex.js");
const Media = require("./media.js");
function fromPlayer(entry, sender) {
  return (
    String(sender) === String(entry.playerID) || String(sender) === entry.playerID + "-io.iina.plex-library"
  );
}
function onMainThread(callback) {
  // HTTP callbacks run on a worker. Return before entering IINA's player/UI APIs.
  return new Promise((resolve, reject) =>
    setTimeout(() => {
      try {
        resolve(callback());
      } catch (error) {
        reject(error);
      }
    }, 0)
  );
}

// Owns managed player sessions, launch handoffs and temporary subtitle cleanup.
class PlexPlayers {
  constructor(app) {
    this.app = app;
    this.opening = new Map();
    this.live = new Map();
    this.retired = new Map();
  }

  registerEvents() {
    this.app.guarded("play", (data) => this.play(data));
    this.app.guarded("player-control", (data) => this.control(data));
    this.app.api.global.onMessage("playback-progress", (data, sender) => this.progress(data, sender));
    this.app.api.global.onMessage("playback-closed", (data, sender) => this.closed(data, sender));
    this.app.api.global.onMessage("playback-started", (data, sender) => this.started(data, sender));
    this.app.api.global.onMessage("playback-error", (data, sender) => this.failed(data, sender));
    this.app.api.global.onMessage("playback-stopped", (data, sender) => this.stopped(data, sender));
    this.app.api.global.onMessage("playback-complete", (data, sender) => this.completed(data, sender));
    this.app.api.global.onMessage("player-state", (data, sender) => this.stateChanged(data, sender));
    this.app.api.global.onMessage("resume-failed", (data, sender) => this.resumeFailed(data, sender));
  }

  entryFor(data, sender) {
    if (!data || typeof data.sessionID !== "string") return null;
    for (const entry of this.live.values()) {
      if (entry.sessionID === data.sessionID && fromPlayer(entry, sender)) return entry;
    }
    return null;
  }

  retirePlayer(entry) {
    if (entry.files.length)
      this.retired.set(entry.sessionID, { playerID: entry.playerID, files: entry.files });
  }

  releaseRetired(data, sender) {
    const entry = data && this.retired.get(data.sessionID);
    if (!entry || !fromPlayer(entry, sender)) return;
    this.retired.delete(data.sessionID);
    this.cleanFiles(entry);
  }

  cleanFiles(entry) {
    for (const path of entry.files || []) {
      try {
        if (this.app.api.file.exists(path)) this.app.api.file.delete(path);
      } catch (_) {}
    }
  }

  get snapshot() {
    return Array.from(this.live.values()).map((entry) => ({
      playerID: entry.playerID,
      id: entry.id,
      title: entry.title,
      serverID: entry.connection.serverID,
      state: entry.state || "opening",
      canSkipIntro: !!entry.canSkipIntro,
      canSkipCredits: !!entry.canSkipCredits
    }));
  }

  publish() {
    this.app.send("players", this.snapshot);
  }

  async subtitleFile(connection, stream, sessionID, files) {
    const extensions = {
      srt: "srt",
      ass: "ass",
      ssa: "ssa",
      vtt: "vtt",
      webvtt: "vtt",
      subrip: "srt",
      pgs: "sup",
      hdmv_pgs_subtitle: "sup",
      dvd_subtitle: "idx",
      vobsub: "idx"
    };
    const ext = extensions[stream.codec];
    if (!ext) throw new Error("This external subtitle format is not supported yet. Select another track.");
    const temp = "@tmp/sub-" + sessionID.replace(/[^a-zA-Z0-9-]/g, "") + "-" + stream.id + "." + ext;
    const download = async (path, suffix) => {
      files.push(path);
      try {
        await this.app.api.http.download(
          connection.base + "/library/streams/" + P.id(stream.id) + "." + suffix,
          path,
          { headers: this.app.headers(connection.token) }
        );
      } catch (_) {
        throw new Error("The subtitle could not be downloaded. Choose another track or reconnect.");
      }
      const handle = this.app.api.file.handle(path, "read");
      try {
        handle.seekToEnd();
        if (handle.offset() > 16 * 1024 * 1024) throw new Error("Subtitle is too large to load.");
      } finally {
        handle.close();
      }
    };
    await download(temp, ext);
    if (ext === "idx") await download(temp.replace(/\.idx$/, ".sub"), "sub");
    return temp;
  }

  async launch(connection, id, options = {}, target = {}) {
    if (connection.scope !== this.app.account.scope)
      throw new Error("This selection belongs to a previous profile. Refresh the library.");
    const currentSession = this.app.account.revision;
    const isCurrent = () =>
      currentSession === this.app.account.revision &&
      connection.scope === this.app.account.scope &&
      (!target.isCurrent || target.isCurrent());
    if (!isCurrent()) return null;
    let reusePlayer = target.playerID == null ? null : target.playerID;
    const hideLibrary = target.hideLibrary !== false;
    id = P.id(id);
    const key = connection.scope + ":" + connection.serverID + ":" + id;
    const pending = this.opening.get(key);
    if (pending && pending.isCurrent()) return null;
    const existing = this.live.get(key);
    if (existing && existing.playerID !== reusePlayer) {
      if (options.restart || existing.state === "stopped") reusePlayer = existing.playerID;
      else {
        this.app.api.global.postMessage(existing.playerID, "activate-player", {});
        this.app.send("playing", {
          title: existing.title,
          existing: true,
          id,
          serverID: connection.serverID
        });
        if (hideLibrary && existing.started) this.app.hideBrowser();
        return existing;
      }
    }
    const operation = { isCurrent },
      files = [];
    let handedOff = false,
      entry = null;
    this.opening.set(key, operation);
    this.app.send("opening", { id, serverID: connection.serverID });
    try {
      await this.app.sync.recover(connection, id);
      if (!isCurrent()) return null;
      const item = await this.app.library.metadataAt(connection, id);
      if (!isCurrent()) return null;
      if (!["movie", "episode"].includes(item.type)) throw new Error("Select a movie or episode to play.");
      const serverBaseline = Number(item.viewOffset) || 0;
      const saved = this.app.sync.pendingPosition(connection, id, item);
      if (saved !== null && !options.restart) item.viewOffset = saved;
      const chosen = Media.chooseVersion(item, options.versionId),
        parts = chosen.media.Part || [];
      const urls = P.parts(item, chosen.choice.index).map((path) => connection.base + path);
      const resume =
        options.restart === true ? { index: 0, position: 0 } : P.resumePoint(item, chosen.choice.index);
      const sessionID =
        this.app.clientID + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
      const title = Media.playbackTitle(item);
      const preferred = this.app.settings,
        initial = Media.selectTracks(parts[resume.index], options, preferred),
        tracks = [];
      for (let index = 0; index < parts.length; index++) {
        if (index < resume.index) {
          tracks.push(null);
          continue;
        }
        const selectedTracks =
          index === resume.index
            ? initial
            : Media.selectTracks(
                parts[index],
                {},
                Object.assign({}, preferred, {
                  audioLanguage: (initial.audio && initial.audio.language) || preferred.audioLanguage,
                  subtitleLanguage:
                    (initial.subtitle && initial.subtitle.language) || preferred.subtitleLanguage,
                  subtitleMode:
                    options.subtitleId === "none"
                      ? "off"
                      : options.subtitleId
                        ? "auto"
                        : preferred.subtitleMode
                })
              );
        if (selectedTracks.subtitle && selectedTracks.subtitle.external) {
          selectedTracks.externalFile = await this.subtitleFile(
            connection,
            selectedTracks.subtitle,
            sessionID,
            files
          );
          if (!isCurrent()) return null;
        }
        tracks.push(selectedTracks);
      }
      return await onMainThread(() => {
        if (!isCurrent()) return null;
        const playerID =
          reusePlayer == null
            ? this.app.api.global.createPlayerInstance({ label: "plex-playback", enablePlugins: false })
            : reusePlayer;
        entry = {
          key,
          id,
          connection,
          playerID,
          sessionID,
          title,
          files,
          started: false,
          options,
          hideLibrary
        };
        for (const [oldKey, old] of this.live) {
          if (old.playerID === playerID) {
            this.live.delete(oldKey);
            this.retirePlayer(old);
          }
        }
        this.live.set(key, entry);
        this.publish();
        this.app.sync.bind(playerID, sessionID, connection, id, serverBaseline);
        const partDurations = parts.map((part) => (Number(part.duration) > 0 ? Number(part.duration) : 0));
        this.app.api.global.postMessage(playerID, "play-media", {
          urls,
          title,
          token: connection.token,
          sessionID,
          duration: chosen.choice.duration,
          partDurations,
          resume,
          tracks,
          markers: Media.markers(item)
        });
        handedOff = true;
        return entry;
      });
    } catch (error) {
      if (isCurrent()) throw error;
      return null;
    } finally {
      if (!handedOff) {
        this.cleanFiles({ files });
        if (entry && this.live.get(key) === entry) {
          this.live.delete(key);
          this.app.sync.close({ sessionID: entry.sessionID }, entry.playerID);
          this.publish();
        }
      }
      if (this.opening.get(key) === operation) {
        this.opening.delete(key);
        if (!handedOff && currentSession === this.app.account.revision)
          this.app.send("opening-ended", { id, serverID: connection.serverID });
      }
    }
  }

  get defaultPlayerID() {
    const entries = Array.from(this.live.values()).filter(
      (entry) => entry.connection.scope === this.app.account.scope
    );
    return entries.length ? entries[entries.length - 1].playerID : null;
  }

  async play(data) {
    if (!this.app.library.selected) throw new Error("Connect to a server first.");
    const generation = this.app.queue.generation;
    this.app.queue.cancelNext();
    const entry = await this.launch(this.app.library.selected, data.id, data);
    if (entry && this.app.queue.items.length && generation === this.app.queue.generation)
      this.app.queue.playerID = entry.playerID;
  }

  async control(data) {
    const playerID = Number(data.playerID),
      entry = Array.from(this.live.values()).find(
        (entry) => entry.playerID === playerID && entry.connection.scope === this.app.account.scope
      );
    if (!entry) throw new Error("This player is no longer available.");
    if (data.action === "next") {
      await this.app.queue.advance(playerID);
      return;
    }
    if (["skip-intro", "skip-credits", "stop", "activate"].includes(data.action))
      this.app.api.global.postMessage(playerID, "player-control", { action: data.action });
    if (data.action === "activate") this.app.hideBrowser();
    if (data.action === "stop") {
      if (this.app.queue.playerID === playerID) {
        this.app.queue.invalidate();
        this.app.queue.publish();
      }
      entry.state = "stopping";
      this.app.send("opening-ended", { id: entry.id, serverID: entry.connection.serverID });
      this.publish();
    }
  }

  retireAll() {
    for (const entry of this.live.values()) this.retirePlayer(entry);
    this.live.clear();
    this.opening.clear();
    this.publish();
  }

  progress(data, sender) {
    const entry = this.entryFor(data, sender);
    if (entry && entry.completed && data.state !== "stopped") {
      entry.completed = false;
      this.app.queue.cancelNext();
    }
    return this.app.sync.report(data, sender);
  }

  closed(data, sender) {
    this.app.sync.close(data, sender);
    this.releaseRetired(data, sender);
    const entry = this.entryFor(data, sender);
    if (!entry) return;
    this.live.delete(entry.key);
    this.cleanFiles(entry);
    this.publish();
    this.app.queue.playerClosed(entry.playerID);
  }

  started(data, sender) {
    const entry = this.entryFor(data, sender);
    if (!entry) return;
    entry.started = true;
    entry.state = "playing";
    this.publish();
    this.app.send("opening-ended", { id: entry.id, serverID: entry.connection.serverID });
    this.app.send("playing", {
      title: entry.title,
      id: entry.id,
      serverID: entry.connection.serverID,
      playerID: entry.playerID
    });
    if (entry.hideLibrary) {
      entry.hideLibrary = false;
      this.app.hideBrowser();
    }
  }

  failed(data, sender) {
    this.releaseRetired(data, sender);
    const entry = this.entryFor(data, sender);
    if (!entry) return;
    this.app.send("opening-ended", { id: entry.id, serverID: entry.connection.serverID });
    this.app.send("notice", {
      message:
        "IINA could not open “" +
        entry.title +
        "”. Check that the media file is available, reconnect, and try again."
    });
    this.live.delete(entry.key);
    this.cleanFiles(entry);
    this.app.sync.close(data, sender);
    this.app.queue.playerClosed(entry.playerID);
    this.publish();
  }

  stopped(data, sender) {
    const entry = this.entryFor(data, sender);
    if (!entry) return;
    entry.state = "stopped";
    this.app.queue.playerStopped(entry.playerID);
    this.app.send("opening-ended", { id: entry.id, serverID: entry.connection.serverID });
    this.publish();
  }

  completed(data, sender) {
    const entry = this.entryFor(data, sender);
    if (entry && this.app.queue.scheduleNext(entry.playerID)) entry.completed = true;
  }

  stateChanged(data, sender) {
    const entry = this.entryFor(data, sender);
    if (!entry) return;
    entry.state = data.state;
    entry.canSkipIntro = data.canSkipIntro === true;
    entry.canSkipCredits = data.canSkipCredits === true;
    this.publish();
  }

  resumeFailed(data, sender) {
    if (this.entryFor(data, sender))
      this.app.send("notice", {
        message:
          "IINA could not reach the saved Plex position. Playback was paused and your saved position was preserved. Try reopening the video."
      });
  }
}

module.exports = PlexPlayers;
