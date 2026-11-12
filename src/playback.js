// Tracks only the approved media-part URLs in one managed Plex player.
const number = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
function embeddedTrack(tracks, type, stream) {
  if (!stream || !Number.isInteger(stream.index)) return null;
  return tracks.find(
    (track) => track.type === type && !track.external && Number(track["ff-index"]) === stream.index
  );
}

class PlaybackTracker {
  constructor(api, onState = () => {}) {
    this.api = api;
    this.onState = onState;
    this.media = null;
    this.active = false;
    this.index = -1;
    this.partTime = 0;
    this.partDuration = 0;
    this.lastSent = 0;
    this.state = "playing";
    this.tracking = true;
    this.loaded = false;
    this.resumePending = null;
    this.resumeConsumed = false;
    this.resumeStarted = 0;
    this.resumePaused = null;
    this.announced = false;
    this.ended = false;
    this.closing = false;
    this.externalLoaded = -1;
    this.audioApplied = -1;
    this.subtitleApplied = -1;
    this.failed = false;
    this.loadingAttempt = false;
    this.durations = [];
    this.api.mpv.addHook("on_load", 50, () => this.load());
    this.api.mpv.addHook("on_unload", 50, () => this.unload());
    this.api.mpv.addHook("on_load_fail", 50, () => this.loadFailed());
    this.api.event.on("mpv.file-loaded", () => this.fileLoaded());
    this.api.event.on("mpv.time-pos.changed", (value) => this.positionChanged(value));
    this.api.event.on("mpv.pause.changed", (paused) => this.pauseChanged(paused));
    this.api.event.on("mpv.paused-for-cache.changed", (buffering) => this.bufferingChanged(buffering));
    this.api.event.on("mpv.playback-restart", () => this.playbackRestarted());
    this.api.event.on("mpv.track-list.changed", this.applyTracks.bind(this));
    this.api.event.on("mpv.eof-reached.changed", (value) => this.eofChanged(value));
    this.api.event.on("mpv.end-file", () => this.endFile());
    this.api.event.on("iina.window-will-close", this.close.bind(this));
    this.api.event.on("mpv.shutdown", this.close.bind(this));
    this.timer = setInterval(() => this.tick(), 10000);
  }

  get currentPath() {
    return this.api.mpv.getString("path");
  }

  sample() {
    if (!this.active || !this.media || this.currentPath !== this.media.urls[this.index]) return;
    // getNumber returns 0 for unavailable properties in IINA; getNative preserves null.
    const position = number(this.api.mpv.getNative("time-pos"));
    const duration = number(this.api.mpv.getNative("duration"));
    if (position !== null) this.partTime = position * 1000;
    if (duration !== null && duration > 0) {
      this.partDuration = duration * 1000;
      this.durations[this.index] = this.partDuration;
    }
  }

  confirmResume() {
    if (this.resumePending === null || this.partTime < this.resumePending - 100) return false;
    this.resumePending = null;
    return true;
  }

  report(force, stopped, final) {
    if (this.resumePending !== null) return; // Never replace Plex's saved position with a startup zero.
    if (!this.media || !this.tracking || !this.loaded || this.index < 0) return;
    if (!this.announced) {
      this.announced = true;
      this.api.global.postMessage("playback-started", { sessionID: this.media.sessionID });
    }
    const now = Date.now();
    if (!force && now - this.lastSent < 10000) return;
    const offset = this.offset;
    if (offset === null) return; // Do not guess offsets for skipped, unknown multipart files.
    const duration = this.duration;
    if (!(duration > 0)) return;
    this.lastSent = now;
    this.api.global.postMessage("playback-progress", {
      sessionID: this.media.sessionID,
      state: stopped ? "stopped" : this.state,
      time: Math.min(duration, Math.max(0, Math.round(offset))),
      duration: Math.round(duration),
      final: !!final
    });
  }

  get duration() {
    if (!this.media) return 0;
    return this.media.urls.length === 1
      ? this.partDuration || this.media.duration
      : this.media.duration ||
          (this.durations.length === this.media.urls.length && this.durations.every((d) => d > 0)
            ? this.durations.reduce((a, b) => a + b, 0)
            : 0);
  }

  get partOffset() {
    if (this.index < 0) return null;
    let value = 0;
    for (let i = 0; i < this.index; i++) {
      if (!(this.durations[i] > 0)) return null;
      value += this.durations[i];
    }
    return value;
  }

  get offset() {
    const before = this.partOffset;
    return before === null ? null : before + this.partTime;
  }

  set offset(value) {
    if (number(value) === null)
      throw new TypeError("Playback offset must be a nonnegative number of milliseconds.");
    if (
      !this.media ||
      !this.loaded ||
      this.closing ||
      this.index < 0 ||
      this.currentPath !== this.media.urls[this.index]
    ) {
      throw new Error("Wait for this video to load before changing its position.");
    }
    let remaining = this.duration > 0 ? Math.min(value, this.duration) : value;
    if (this.resumePending === null && this.offset === remaining) return;
    let before = 0;
    for (let part = 0; part < this.media.urls.length; part++) {
      const duration =
        this.durations[part] || (part === this.media.urls.length - 1 ? this.duration - before : 0);
      if (!Number.isFinite(duration) || !(duration > 0))
        throw new Error("Plex did not return the part durations needed to change position.");
      if (remaining < duration || part === this.media.urls.length - 1) {
        const position = Math.min(remaining, duration);
        if (part === this.index) {
          if (this.resumePending !== null) {
            this.resumePending = position > 0 ? position : null;
            this.resumeStarted = Date.now();
          }
          this.api.core.seekTo(position / 1000);
        } else {
          this.open(Object.assign({}, this.media, { resume: { index: part, position } }), true);
        }
        return;
      }
      remaining -= duration;
      before += duration;
    }
  }

  get paused() {
    return this.api.mpv.getFlag("pause");
  }

  set paused(value) {
    if (typeof value !== "boolean") throw new TypeError("Paused must be a boolean.");
    if (!this.loaded && this.resumePaused !== null) this.resumePaused = value;
    if (this.paused !== value) this.api.mpv.set("pause", value);
  }

  get audioTrack() {
    return this.api.mpv.getNative("aid");
  }

  set audioTrack(value) {
    if (!Number.isInteger(value) || value < 1) throw new TypeError("Choose an available audio track.");
    if (this.audioTrack !== value) this.api.mpv.set("aid", value);
  }

  get subtitleTrack() {
    return this.api.mpv.getNative("sid");
  }

  set subtitleTrack(value) {
    if (value !== "no" && (!Number.isInteger(value) || value < 1))
      throw new TypeError("Choose an available subtitle track, or no subtitles.");
    if (value === "no" && [false, "no"].includes(this.subtitleTrack)) return;
    if (this.subtitleTrack !== value) this.api.mpv.set("sid", value);
  }

  get introEnd() {
    const marker = this.marker("intro");
    return marker && this.duration > 0 ? Math.min(marker.end, Math.max(0, this.duration - 100)) : null;
  }

  get creditsEnd() {
    const marker = this.marker("credits");
    return marker && this.duration > 0 ? Math.min(marker.end, Math.max(0, this.duration - 100)) : null;
  }

  marker(type) {
    const before = this.partOffset;
    if (!this.active || before === null || this.resumePending !== null) return null;
    return (
      (this.media.markers || []).find(
        (marker) =>
          marker.type === type &&
          before + this.partTime >= marker.start &&
          before + this.partTime < marker.end
      ) || null
    );
  }

  applyTracks() {
    if (!this.media || this.index < 0 || !this.active) return;
    const config = (this.media.tracks || [])[this.index];
    if (!config || (this.audioApplied === this.index && this.subtitleApplied === this.index)) return;
    const tracks = this.api.mpv.getNative("track-list") || [];
    if (this.audioApplied !== this.index) {
      const audio = embeddedTrack(tracks, "audio", config.audio);
      if (audio) {
        this.audioTrack = audio.id;
        this.audioApplied = this.index;
      } else if (!config.audio) this.audioApplied = this.index;
    }
    if (this.subtitleApplied === this.index) return;
    if (config.subtitleOff) {
      this.subtitleTrack = "no";
      this.subtitleApplied = this.index;
      return;
    }
    let subtitle;
    if (config.externalFile) {
      if (this.externalLoaded !== this.index) {
        this.externalLoaded = this.index;
        this.api.core.subtitle.loadTrack(config.externalFile);
      }
      const name = config.externalFile.split("/").pop();
      subtitle = tracks.find(
        (track) =>
          track.type === "sub" &&
          track.external &&
          String(track["external-filename"] || "").endsWith("/" + name)
      );
    } else if (config.subtitle) {
      subtitle = embeddedTrack(tracks, "sub", config.subtitle);
    } else {
      this.subtitleApplied = this.index;
      return;
    }
    if (subtitle) {
      this.subtitleTrack = subtitle.id;
      this.subtitleApplied = this.index;
    }
  }

  complete() {
    if (
      !this.media ||
      !this.active ||
      this.ended ||
      this.closing ||
      this.index !== this.media.urls.length - 1 ||
      this.resumePending !== null
    )
      return;
    this.sample();
    if (
      !this.api.mpv.getFlag("eof-reached") ||
      !(this.partDuration > 0) ||
      this.partTime < this.partDuration - 1500
    )
      return;
    this.report(true, true, false);
    this.ended = true;
    this.active = false;
    this.api.global.postMessage("playback-complete", { sessionID: this.media.sessionID });
    this.onState();
  }

  stop(final, takeSample) {
    if (!this.active && !final) return;
    if (takeSample) this.sample();
    this.report(true, true, final);
    this.active = false;
    this.state = "stopped";
    this.onState();
    if (final) this.tracking = false;
  }

  tick() {
    if (!this.active || !this.tracking || !this.media) return;
    if (this.currentPath !== this.media.urls[this.index]) {
      this.stop(true, false);
      return;
    }
    this.sample();
    const resumed = this.confirmResume();
    if (this.resumePending !== null && Date.now() - this.resumeStarted >= 30000) {
      this.tracking = false;
      this.paused = true;
      this.api.global.postMessage("resume-failed", { sessionID: this.media.sessionID });
      return;
    }
    this.report(resumed, false, false);
    this.onState();
  }

  close() {
    if (this.closing) return;
    this.closing = true;
    this.stop(true, this.active);
    clearInterval(this.timer);
    if (this.media) this.api.global.postMessage("playback-closed", { sessionID: this.media.sessionID });
  }

  open(data, preserveSession = false) {
    const paused = preserveSession ? this.paused : null;
    if (this.media && !preserveSession) {
      this.stop(true, this.active);
      this.api.global.postMessage("playback-closed", { sessionID: this.media.sessionID });
    }
    this.media = data;
    this.tracking = true;
    this.announced = false;
    this.ended = false;
    this.closing = false;
    this.externalLoaded = -1;
    this.audioApplied = -1;
    this.subtitleApplied = -1;
    this.failed = false;
    this.loadingAttempt = false;
    this.active = false;
    this.loaded = false;
    this.index = -1;
    this.resumePending = null;
    this.resumePaused = paused;
    this.resumeConsumed = false;
    this.lastSent = 0;
    this.durations.length = 0;
    (data.partDurations || []).forEach((duration, i) => (this.durations[i] = duration));
    const startIndex = data.resume ? data.resume.index : 0;
    this.api.core.open(data.urls[startIndex]);
    data.urls.slice(startIndex + 1).forEach((url) => this.api.playlist.add(url));
  }

  get sessionID() {
    return this.media && this.media.sessionID;
  }

  get status() {
    const introEnd = this.introEnd,
      creditsEnd = this.creditsEnd;
    return {
      sessionID: this.sessionID,
      state: this.failed ? "error" : !this.loaded ? "opening" : !this.active ? "stopped" : this.state,
      paused: this.paused,
      canSkipIntro: introEnd !== null,
      canSkipCredits: creditsEnd !== null,
      introEnd,
      creditsEnd
    };
  }

  load() {
    const path = this.currentPath;
    const allowed = this.media && this.media.urls.indexOf(path) !== -1;
    this.api.mpv.set("http-header-fields", allowed ? "X-Plex-Token: " + this.media.token : "");
    const part = allowed ? this.media.urls.indexOf(path) : -1;
    const title = allowed ? String(this.media.title || "") : "";
    this.api.mpv.set(
      "force-media-title",
      title && this.media.urls.length > 1
        ? title + " · Part " + (part + 1) + " of " + this.media.urls.length
        : title
    );
    // Reset for every later part or unrelated file so the initial offset cannot carry over.
    const resume =
      allowed &&
      !this.resumeConsumed &&
      this.media.resume &&
      this.media.urls.indexOf(path) === this.media.resume.index
        ? this.media.resume.position
        : 0;
    this.api.mpv.set("start", String(Math.max(0, resume || 0) / 1000));
    if (allowed) {
      this.loadingAttempt = true;
      this.api.mpv.set("keep-open", "yes");
    }
    if (!allowed && this.media) this.stop(true, false);
  }

  unload() {
    if (this.loadingAttempt) {
      this.stop(false, true);
      if (this.media) this.api.global.postMessage("playback-stopped", { sessionID: this.media.sessionID });
    }
    this.loadingAttempt = false;
  }

  loadFailed() {
    if (!this.media || !this.tracking || this.failed || this.media.urls.indexOf(this.currentPath) < 0) return;
    this.failed = true;
    this.tracking = false;
    this.active = false;
    this.api.global.postMessage("playback-error", { sessionID: this.media.sessionID });
    this.onState();
  }

  fileLoaded() {
    if (!this.media || !this.tracking) return;
    this.index = this.media.urls.indexOf(this.currentPath);
    if (this.index < 0) return;
    this.active = true;
    this.loaded = true;
    this.ended = false;
    this.audioApplied = -1;
    this.subtitleApplied = -1;
    this.partTime = 0;
    this.partDuration = this.durations[this.index] || 0;
    if (this.resumePaused !== null) {
      this.paused = this.resumePaused;
      this.resumePaused = null;
    }
    this.state = this.api.mpv.getFlag("paused-for-cache")
      ? "buffering"
      : this.api.mpv.getFlag("pause")
        ? "paused"
        : "playing";
    this.resumePending =
      !this.resumeConsumed &&
      this.media.resume &&
      this.index === this.media.resume.index &&
      this.media.resume.position > 0
        ? this.media.resume.position
        : null;
    this.resumeConsumed = true;
    this.resumeStarted = Date.now();
    this.sample();
    this.confirmResume();
    if (this.resumePending !== null) {
      // Some streams expose a zero position at file-loaded; request an exact seek and await it.
      this.api.mpv.command("seek", [String(this.resumePending / 1000), "absolute+exact"]);
    }
    this.applyTracks();
    this.report(true, false, false);
    this.onState();
  }

  positionChanged(value) {
    if (!this.active || !this.media || this.currentPath !== this.media.urls[this.index]) return;
    const position = number(value);
    if (position !== null) {
      this.partTime = position * 1000;
      this.report(this.confirmResume(), false, false);
      this.onState();
    }
  }

  pauseChanged(paused) {
    if (!this.active) return;
    this.state = this.api.mpv.getFlag("paused-for-cache") ? "buffering" : paused ? "paused" : "playing";
    this.sample();
    this.report(true, false, false);
    this.onState();
  }

  bufferingChanged(buffering) {
    if (!this.active) return;
    this.state = buffering ? "buffering" : this.api.mpv.getFlag("pause") ? "paused" : "playing";
    this.sample();
    this.report(true, false, false);
    this.onState();
  }

  playbackRestarted() {
    if (this.ended && !this.closing && this.media && this.currentPath === this.media.urls[this.index]) {
      this.active = true;
      this.ended = false;
    }
    if (this.active) {
      this.sample();
      this.confirmResume();
      this.applyTracks();
      this.report(true, false, false);
      this.onState();
    }
  }

  eofChanged(value) {
    if (value) this.complete();
  }

  endFile() {
    return this.stop(false, false);
  }
}

module.exports = PlaybackTracker;
