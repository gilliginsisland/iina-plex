// Tracks only the approved media-part URLs in one managed Plex player.
const Media = require("./media.js");
module.exports = function playbackTracker(api, onState = () => {}) {
  let media = null, active = false, index = -1, partTime = 0, partDuration = 0;
  let lastSent = 0, state = "playing", tracking = true, loaded = false;
  let resumePending = null, resumeConsumed = false, resumeStarted = 0;
  let announced = false, ended = false, closing = false, externalLoaded = -1, tracksApplied = -1, failed = false, loadingAttempt = false;
  const durations = [];
  const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  function currentPath() { return api.mpv.getString("path"); }
  function sample() {
    if (!active || !media || currentPath() !== media.urls[index]) return;
    // getNumber returns 0 for unavailable properties in IINA; getNative preserves null.
    const position = number(api.mpv.getNative("time-pos"));
    const duration = number(api.mpv.getNative("duration"));
    if (position !== null) partTime = position * 1000;
    if (duration !== null && duration > 0) { partDuration = duration * 1000; durations[index] = partDuration; }
  }
  function confirmResume() {
    if (resumePending === null || partTime < resumePending - 100) return false;
    resumePending = null;
    return true;
  }
  function report(force, stopped, final) {
    if (resumePending !== null) return; // Never replace Plex's saved position with a startup zero.
    if (!media || !tracking || !loaded || index < 0) return;
    if (!announced) { announced = true; api.global.postMessage("playback-started", { sessionID: media.sessionID }); }
    const now = Date.now();
    if (!force && now - lastSent < 10000) return;
    let offset = 0;
    for (let i = 0; i < index; i++) {
      if (!(durations[i] > 0)) return; // Do not guess an offset for skipped, unknown multipart files.
      offset += durations[i];
    }
    const duration = media.urls.length === 1 ? partDuration || media.duration : media.duration || (durations.length === media.urls.length && durations.every(d => d > 0) ? durations.reduce((a,b) => a+b,0) : 0);
    if (!(duration > 0)) return;
    lastSent = now;
    api.global.postMessage("playback-progress", { sessionID: media.sessionID, state: stopped ? "stopped" : state,
      time: Math.min(duration, Math.max(0, Math.round(offset + partTime))), duration: Math.round(duration), final: !!final });
  }
  function offset() {
    let value=0;for(let i=0;i<index;i++){if(!(durations[i]>0))return null;value+=durations[i];}return value;
  }
  function marker(type) {
    const before=offset();if(!active||before===null||resumePending!==null)return null;
    return (media.markers||[]).find(marker=>marker.type===type&&before+partTime>=marker.start&&before+partTime<marker.end)||null;
  }
  function applyTracks() {
    if(!media||index<0||!active||tracksApplied===index)return;
    const config=(media.tracks||[])[index];if(!config)return;
    const tracks=api.mpv.getNative("track-list")||[];
    const audio=config.audio&&tracks.find(track=>track.type==="audio"&&!track.external&&Number(track["ff-index"])===config.audio.index);
    if(audio&&api.mpv.getNative("aid")!==audio.id)api.mpv.set("aid",audio.id);
    if(config.subtitleOff){if(![false,"no",null].includes(api.mpv.getNative("sid")))api.mpv.set("sid","no");if(!config.audio||audio)tracksApplied=index;return;}
    let subtitleReady=!config.subtitle;
    if(config.externalFile){
      if(externalLoaded!==index){externalLoaded=index;api.core.subtitle.loadTrack(config.externalFile);}
      const name=config.externalFile.split("/").pop();
      const sub=tracks.find(track=>track.type==="sub"&&track.external&&String(track["external-filename"]||"").endsWith("/"+name));
      if(sub&&api.mpv.getNative("sid")!==sub.id)api.mpv.set("sid",sub.id);
      subtitleReady=!!sub;
    } else if(config.subtitle){
      const sub=tracks.find(track=>track.type==="sub"&&!track.external&&Number(track["ff-index"])===config.subtitle.index);
      if(sub&&api.mpv.getNative("sid")!==sub.id)api.mpv.set("sid",sub.id);
      subtitleReady=!!sub;
    }
    if((!config.audio||audio)&&subtitleReady)tracksApplied=index;
  }
  function complete() {
    if(!media||!active||ended||closing||index!==media.urls.length-1||resumePending!==null)return;
    sample();
    if(!api.mpv.getFlag("eof-reached")||!(partDuration>0)||partTime<partDuration-1500)return;
    report(true,true,false);ended=true;active=false;
    api.global.postMessage("playback-complete",{sessionID:media.sessionID});onState();
  }
  function stop(final, takeSample) {
    if (!active && !final) return;
    if (takeSample) sample();
    report(true, true, final); active = false;state="stopped";onState();
    if (final) tracking = false;
  }
  function tick() {
    if (!active || !tracking || !media) return;
    if (currentPath() !== media.urls[index]) { stop(true, false); return; }
    sample();
    const resumed = confirmResume();
    if (resumePending !== null && Date.now() - resumeStarted >= 30000) {
      tracking = false; api.core.pause(); api.global.postMessage("resume-failed", {}); return;
    }
    report(resumed, false, false);onState();
  }
  api.mpv.addHook("on_load", 50, () => {
    const path = currentPath();
    const allowed = media && media.urls.indexOf(path) !== -1;
    api.mpv.set("http-header-fields", allowed ? "X-Plex-Token: " + media.token : "");
    // Opening a local M3U gives mpv the Plex titles without requiring force-media-title.
    // The playlist is only a container; tracking begins when an approved media URL loads.
    if (media && media.playlistFile && path && path.split("/").pop() === media.playlistFile.split("/").pop()) {
      api.mpv.set("start", "0");return;
    }
    // Reset for every later part or unrelated file so the initial offset cannot carry over.
    const resume = allowed && !resumeConsumed && media.resume && media.urls.indexOf(path) === media.resume.index ? media.resume.position : 0;
    api.mpv.set("start", String(Math.max(0, resume || 0) / 1000));
    if(allowed){loadingAttempt=true;api.mpv.set("keep-open","yes");}
    if (!allowed && media) stop(true, false);
  });
  // on_unload runs while the old file's properties are still available.
  api.mpv.addHook("on_unload", 50, () => {
    if(loadingAttempt){stop(false,true);if(media)api.global.postMessage("playback-stopped",{sessionID:media.sessionID});}
    loadingAttempt=false;
  });
  api.mpv.addHook("on_load_fail", 50, () => { if(media&&!failed){failed=true;tracking=false;api.global.postMessage("playback-error",{sessionID:media.sessionID});} });
  api.event.on("mpv.file-loaded", () => {
    if (!media || !tracking) return;
    index = media.urls.indexOf(currentPath());
    if (index < 0) return;
    active = true; loaded = true; ended=false;tracksApplied=-1; partTime = 0; partDuration = durations[index] || 0;
    state = api.mpv.getFlag("pause") ? "paused" : "playing";
    resumePending = !resumeConsumed && media.resume && index === media.resume.index && media.resume.position > 0 ? media.resume.position : null;
    resumeConsumed = true; resumeStarted = Date.now();
    sample(); confirmResume();
    if (resumePending !== null) {
      // Some streams expose a zero position at file-loaded; request an exact seek and await it.
      api.mpv.command("seek", [String(resumePending / 1000), "absolute+exact"]);
    }
    applyTracks();report(true, false, false);onState();
  });
  api.event.on("mpv.time-pos.changed", value => {
    if (!active || !media || currentPath() !== media.urls[index]) return;
    const position = number(value);
    if (position !== null) { partTime = position * 1000; report(confirmResume(), false, false);onState(); }
  });
  api.event.on("mpv.pause.changed", paused => {
    if (!active) return;
    state = paused ? "paused" : "playing"; sample(); report(true, false, false);
  });
  api.event.on("mpv.paused-for-cache.changed", buffering => {
    if (!active) return;
    state = buffering ? "buffering" : api.mpv.getFlag("pause") ? "paused" : "playing";
    sample(); report(true, false, false);
  });
  api.event.on("mpv.playback-restart", () => {
    if(ended&&!closing&&media&&currentPath()===media.urls[index]){active=true;ended=false;}
    if(active){sample();confirmResume();applyTracks();report(true,false,false);onState();}
  });
  api.event.on("mpv.track-list.changed",applyTracks);
  api.event.on("mpv.eof-reached.changed",value=>{if(value)complete();});
  api.event.on("mpv.end-file", () => stop(false, false));
  const timer = setInterval(tick, 10000);
  function close() {
    closing=true;stop(true, active); clearInterval(timer);
    if (media) api.global.postMessage("playback-closed", { sessionID: media.sessionID });
  }
  api.event.on("iina.window-will-close", close);
  api.event.on("mpv.shutdown", close);
  return {
    open(data, preserveSession = false) {
      if(media&&!preserveSession){stop(true,active);api.global.postMessage("playback-closed",{sessionID:media.sessionID});}
      media = data; tracking = true; announced=false;ended=false;closing=false;externalLoaded=-1;tracksApplied=-1;failed=false;loadingAttempt=false; active = false; loaded = false; index = -1;
      resumePending = null; resumeConsumed = false; lastSent = 0; durations.length = 0;
      (data.partDurations || []).forEach((duration,i) => durations[i] = duration);
      const startIndex = data.resume ? data.resume.index : 0;
      if (data.playlistFile) {
        api.file.write(data.playlistFile, Media.playbackPlaylist(data.urls, data.title, startIndex));
        api.core.open(data.playlistFile);
      } else {
        api.core.open(data.urls[startIndex]);data.urls.slice(startIndex + 1).forEach(url => api.playlist.add(url));
      }
    },
    disable() { tracking = false; },
    sessionID() { return media&&media.sessionID; },
    status() { return {sessionID:media&&media.sessionID,state:failed?"error":!loaded?"opening":!active?"stopped":state,canSkipIntro:!!marker("intro"),canSkipCredits:!!marker("credits")}; },
    available(type) { return !!marker(type); },
    skip(type) {
      const target=marker(type);if(!target)return;
      let remaining=target.end;
      for(let part=0;part<media.urls.length;part++){
        if(!(durations[part]>0))return;
        if(remaining<durations[part]){
          if(part===index)api.core.seekTo(remaining/1000);
          else { const data=Object.assign({},media,{resume:{index:part,position:remaining}});this.open(data,true); }
          return;
        }
        remaining-=durations[part];
      }
      if(index===media.urls.length-1)api.core.seekTo(Math.max(0,partDuration-100)/1000);
    }
  };
};
