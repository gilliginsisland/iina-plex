/* Plex URL and metadata helpers. */
function query(values) {
  return Object.keys(values).map(key => encodeURIComponent(key) + "=" + encodeURIComponent(values[key])).join("&");
}
function origin(value) {
  const match = /^(https?):\/\/(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+)(:\d+)?\/?$/.exec(String(value));
  if (!match) throw new Error("Invalid server address.");
  return match[1] + "://" + match[2] + (match[3] || "");
}
function path(value) {
  // Never follow an absolute or protocol-relative key with a server credential.
  if (typeof value !== "string" || !/^\/(?!\/)/.test(value) || /[\\\u0000-\u001f\u007f#?]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|2e|2f|5c)/i.test(value) || value.split("/").some(x => x === "." || x === "..")) {
    throw new Error("Invalid Plex media path.");
  }
  return value;
}
function id(value) {
  if (!/^\d+$/.test(String(value))) throw new Error("Invalid Plex item identifier.");
  return String(value);
}
function flag(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}
function connections(server, allowHTTP) {
  return (Array.isArray(server.connections) ? server.connections : []).filter(c => {
    if(!c || typeof c.uri !== "string")return false;
    try { origin(c.uri); } catch (_) { return false; }
    return c.uri.indexOf("https://") === 0 || (allowHTTP && flag(c.local) && c.uri.indexOf("http://") === 0);
  }).sort((a, b) => score(a) - score(b));
}
function score(c) { return (flag(c.relay) ? 10 : 0) + (c.uri.indexOf("https://") === 0 ? 0 : 4) + (flag(c.local) ? 0 : 2); }
function listing(container, start, pageSize) {
  const items = container.Metadata || [];
  const reportedTotal = container.totalSize == null || String(container.totalSize).trim() === "" ? NaN : Number(container.totalSize);
  const total = Number.isInteger(reportedTotal) && reportedTotal >= 0 ? reportedTotal : null;
  return {
    items: items.map(item => ({
      id: id(item.ratingKey), title: item.title || "Untitled", type: item.type,
      year: item.year || "", edition:item.editionTitle||"", summary: item.summary || "", duration: item.duration || 0,
      index: item.index, parentIndex: item.parentIndex, showId: item.grandparentRatingKey || "", libraryId: item.librarySectionID || "", rating: item.contentRating || "", score: item.rating || item.audienceRating || "",
      watched: Number(item.viewCount || 0) > 0,
      progress: item.duration ? Math.min(1, Math.max(0, Number(item.viewOffset || 0) / item.duration)) : 0,
      episodes: item.leafCount || 0, parentTitle: item.grandparentTitle || item.parentTitle || "",
      playable: ["movie", "episode"].indexOf(item.type) !== -1
    })),
    start, total, next: items.length > 0 && (total === null ? items.length >= pageSize : start + items.length < total) ? start + items.length : null
  };
}
function parts(metadata, mediaIndex = 0) {
  const media = (metadata.Media || [])[mediaIndex];
  if (!media || !media.Part || !media.Part.length) throw new Error("No playable media file was returned by Plex.");
  return media.Part.map(part => path(part.key));
}
function resumePoint(metadata, mediaIndex = 0) {
  const offset = Number(metadata.viewOffset), total = Number(((metadata.Media || [])[mediaIndex] || {}).duration || metadata.duration);
  const beginning = { index: 0, position: 0 };
  if (!Number.isFinite(offset) || offset <= 0 || (total > 0 && offset >= total)) return beginning;
  const media = (metadata.Media || [])[mediaIndex], parts = media && media.Part || [];
  if (parts.length <= 1) return { index: 0, position: offset };
  let remaining = offset;
  for (let index = 0; index < parts.length; index++) {
    const duration = Number(parts[index].duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      if (index === parts.length - 1) return { index, position: remaining };
      throw new Error("Plex did not return the part durations needed to resume this multipart video. Your saved position has been preserved.");
    }
    if (remaining < duration) return { index, position: remaining };
    remaining -= duration;
  }
  return beginning;
}
function imageData(bytes) {
  const mime = bytes[0] === 255 && bytes[1] === 216 ? "image/jpeg" :
    bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 ? "image/png" :
    bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80 ? "image/webp" : null;
  if (!mime) return null;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";
  for (let n = 0; n < bytes.length; n += 3) {
    const v = (bytes[n] << 16) | ((bytes[n + 1] || 0) << 8) | (bytes[n + 2] || 0);
    encoded += alphabet[(v >>> 18) & 63] + alphabet[(v >>> 12) & 63] +
      (n + 1 < bytes.length ? alphabet[(v >>> 6) & 63] : "=") + (n + 2 < bytes.length ? alphabet[v & 63] : "=");
  }
  return "data:" + mime + ";base64," + encoded;
}
function uniqueItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const id = String(item.ratingKey || "");
    if (!/^\d+$/.test(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

module.exports = { query, origin, path, id, flag, connections, listing, parts, resumePoint, imageData, uniqueItems };
