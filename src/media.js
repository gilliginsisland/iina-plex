// Metadata selection stays in the plugin; only display fields cross the webview bridge.
const P = require("./plex.js");
function playbackTitle(item) {
  const clean = value => String(value || "").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim();
  const title = clean(item.title);
  if (item.type === "episode") {
    const number = value => value != null && String(value).trim() !== "" && Number.isInteger(Number(value)) && Number(value) >= 0 ? String(Number(value)).padStart(2,"0") : "";
    const season = number(item.parentIndex), episode = number(item.index);
    const code = episode ? (season ? "S" + season : "") + "E" + episode : "";
    return [clean(item.grandparentTitle),code,title].filter(Boolean).join(" — ") || "Plex episode";
  }
  const year = /^\d{4}$/.test(String(item.year)) ? " (" + item.year + ")" : "";
  return (title || "Plex video") + year;
}
function versions(item) {
  return (item.Media || []).map((media, index) => ({ id: String(media.id == null ? index : media.id), index,
    title: [item.editionTitle, media.videoResolution ? String(media.videoResolution).toLowerCase()==="4k"?"4K":media.videoResolution+"p" : "", media.videoCodec, media.audioCodec, media.bitrate ? Math.round(media.bitrate / 1000) + " Mbps" : ""].filter(Boolean).join(" · ") || "Original file " + (index + 1),
    duration: Number(media.duration || item.duration) || 0 }));
}
function chooseVersion(item, id) {
  const choices = versions(item);
  const choice = id == null || id === "" ? choices[0] : choices.find(choice => choice.id === String(id));
  if (!choice) throw new Error("This media version is no longer available. Reopen its details.");
  return { choice, media: item.Media[choice.index] };
}
function streams(part) {
  return (part.Stream || []).filter(stream => [2,3].includes(Number(stream.streamType))&&/^\d+$/.test(String(stream.id))).map(stream => ({
    id: P.id(stream.id), type: Number(stream.streamType), index: Number.isInteger(Number(stream.index)) ? Number(stream.index) : null,
    title: stream.displayTitle || stream.extendedDisplayTitle || [stream.language || "Unknown language", stream.codec, stream.forced ? "Forced" : "", stream.default ? "Default" : ""].filter(Boolean).join(" · "),
    language: stream.languageCode || stream.languageTag || "", codec: String(stream.codec || "").toLowerCase(),
    selected: !!stream.selected, forced: !!stream.forced, external: !!stream.key
  }));
}
const languages = { en:"eng",es:"spa",fr:"fra",de:"deu",it:"ita",pt:"por",ja:"jpn",ko:"kor",zh:"zho",ru:"rus" };
function matches(stream, preferred) {
  const a = String(stream.language || "").toLowerCase(), b = String(preferred || "").toLowerCase();
  return !!b && (a === b || a === languages[b] || languages[a] === b);
}
function selectTracks(part, options, preferences) {
  const all = streams(part), audio = all.filter(s=>s.type===2), subs = all.filter(s=>s.type===3);
  const pick = (list, id, language) => list.find(s=>s.id===String(id)) || list.find(s=>matches(s,language)) || list.find(s=>s.selected) || list[0];
  if (options.audioId && !audio.some(s=>s.id===options.audioId)) throw new Error("The selected audio track is no longer available.");
  if (options.subtitleId && options.subtitleId !== "none" && !subs.some(s=>s.id===options.subtitleId)) throw new Error("The selected subtitle is no longer available.");
  const selectedAudio = pick(audio, options.audioId, preferences.audioLanguage);
  let selectedSub;
  if (options.subtitleId === "none" || (!options.subtitleId && preferences.subtitleMode === "off")) selectedSub = null;
  else if (options.subtitleId) selectedSub = subs.find(s=>s.id===options.subtitleId);
  else if (preferences.subtitleMode === "forced") selectedSub = pick(subs.filter(s=>s.forced), "", preferences.subtitleLanguage);
  else selectedSub = subs.find(s=>matches(s,preferences.subtitleLanguage)) || subs.find(s=>s.selected) || subs.find(s=>s.forced);
  return { audio: selectedAudio || null, subtitle: selectedSub || null, subtitleOff: selectedSub === null };
}
function markers(item) {
  return (item.Marker || []).filter(marker=>["intro","credits"].includes(marker.type) && Number(marker.endTimeOffset)>Number(marker.startTimeOffset)).map(marker=>({ type:marker.type,start:Number(marker.startTimeOffset),end:Number(marker.endTimeOffset) }));
}
function xmlAttributes(text, name) {
  // This only reads attributes from Plex's legacy Home responses; DTDs/entities are never evaluated.
  const result = [], tag = new RegExp("<" + name + "\\b([^>]*)>", "gi");
  let match;
  while ((match = tag.exec(text))) {
    const item = {};
    match[1].replace(/([\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g, (_,key,quote,value)=> {
      item[key] = value.replace(/&(?:amp|lt|gt|quot|apos);/g,entity=>({"&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&apos;":"'"})[entity]); return "";
    });
    result.push(item);
  }
  return result;
}
module.exports = { playbackTitle, versions, chooseVersion, streams, selectTracks, markers, xmlAttributes };
