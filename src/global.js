const P = require("./plex.js");
const Media = require("./media.js");
const RESOURCES_URL = "https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1";
const { http, standaloneWindow: window, preferences, global: players } = iina;
let clientID = preferences.get("clientID");
if (!clientID) {
  clientID = "iina-plex-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  preferences.set("clientID", clientID);
  preferences.sync();
}
const credentials = require("./storage.js")(iina.utils, preferences);
let restored = false, restoring = null;
let artwork = {}, artworkSerial = 0;
let token = null, servers = [], selected = null, authGeneration = 0, session = 0;
const opening = new Map(), livePlayers = new Map(), retiredPlayers = new Map();
let queue = [], queuePlayer = null, nextTimer = null, queueRevision = 0, queueGeneration = 0, queuePreparation = 0;
let homeUsers = [], profileID = "owner", profileToken = null, accountID = "", needsProfile = false;
let browseGeneration = 0, connectionGeneration = 0, discoveryGeneration = 0, queueBusy = false;
let identifyingAccount = null;
const artworkCache = new Map();
function sessionInfo() { return {signedIn:!!token,serverID:preferences.get("lastServer"),libraryID:preferences.get("lastLibrary"),allowHTTP:preferences.get("allowHTTP")===true,profileID,needsProfile}; }
async function identifyAccount() {
  if (accountID) return;
  const currentSession = session, accessToken = token;
  if (identifyingAccount && identifyingAccount.session === currentSession && identifyingAccount.token === accessToken) {
    return identifyingAccount.promise;
  }
  const pending = {session:currentSession,token:accessToken};
  pending.promise = (async () => {
    const user = await request("https://plex.tv/api/v2/user", accessToken);
    if (currentSession !== session || accessToken !== token) throw new Error("Plex account changed. Try again.");
    if (!user || !/^\d+$/.test(String(user.id))) throw new Error("Plex did not return an account identity. Sign in again.");
    accountID = String(user.id);
    preferences.set("accountID", accountID);
    preferences.sync();
  })();
  identifyingAccount = pending;
  try { await pending.promise; }
  finally { if (identifyingAccount === pending) identifyingAccount = null; }
}
async function resourcesFor(accessToken) {
  const resources = await request(RESOURCES_URL, accessToken);
  if (!Array.isArray(resources)) throw new Error("Plex did not return a valid server list. Try again.");
  return resources;
}
function scope() { return accountID + ":" + profileID; }
function settings() { return { audioLanguage: preferences.get("audioLanguage") || "", subtitleLanguage: preferences.get("subtitleLanguage") || "", subtitleMode: preferences.get("subtitleMode") || "auto", autoNext: preferences.get("autoNext") === true, includeSpecials:preferences.get("includeSpecials")===true }; }
function fromPlayer(entry, sender) {
  return String(sender) === String(entry.playerID) || String(sender) === entry.playerID + "-io.iina.plex-library";
}
function entryFor(data, sender) {
  if (!data || typeof data.sessionID !== "string") return null;
  for (const entry of livePlayers.values()) {
    if (entry.sessionID === data.sessionID && fromPlayer(entry, sender)) return entry;
  }
  return null;
}
function retirePlayer(entry) {
  if (entry.files.length) retiredPlayers.set(entry.sessionID, {playerID:entry.playerID,files:entry.files});
}
function releaseRetired(data, sender) {
  const entry = data && retiredPlayers.get(data.sessionID);
  if (!entry || !fromPlayer(entry, sender)) return;
  retiredPlayers.delete(data.sessionID);
  cleanFiles(entry);
}
function cleanFiles(entry) { for (const path of entry.files || []) { try { if (iina.file.exists(path)) iina.file.delete(path); } catch (_) {} } }
function publishPlayers() { send("players", Array.from(livePlayers.values()).map(entry=>({playerID:entry.playerID,id:entry.id,title:entry.title,serverID:entry.connection.serverID,state:entry.state||"opening",canSkipIntro:!!entry.canSkipIntro,canSkipCredits:!!entry.canSkipCredits}))); }
function publishQueue() { send("queue", { busy:queueBusy, revision: ++queueRevision, items: queue.map((entry,index)=>({ id:entry.id,title:entry.title,index,serverID:entry.connection.serverID })) }); }
function cancelNext() { if (nextTimer !== null) clearTimeout(nextTimer); nextTimer = null; send("up-next", null); }
function invalidateQueue() {
  queueGeneration++;
  queuePreparation++;
  queueBusy = false;
  cancelNext();
}
function resetQueue() {
  invalidateQueue();queue = [];queuePlayer = null;publishQueue();
}
const send = (name, data) => window.postMessage(name, data);
const sync = require("./sync.js")(http, headers, (name, data) => {
  if (name === "item-synced") {
    try { send("item-synced", { serverID: data.serverID, item: P.listing({ Metadata: [data.item] }, 0, 1).items[0] }); } catch (_) {}
  } else send(name, data);
}, {load:()=>preferences.get("progressJournal")||[],save:records=>{preferences.set("progressJournal",records);preferences.sync();}});
players.onMessage("playback-progress", (data, sender) => {
  const entry=entryFor(data,sender);
  if(entry&&entry.completed&&data.state!=="stopped"){entry.completed=false;cancelNext();}
  return sync.report(data,sender);
});
players.onMessage("playback-closed", (data, sender) => {
  sync.close(data, sender);
  releaseRetired(data, sender);
  const entry = entryFor(data,sender);
  if (!entry) return;
  livePlayers.delete(entry.key); cleanFiles(entry);publishPlayers();
  if (queuePlayer === entry.playerID) { queuePlayer = null; cancelNext(); }
});
players.onMessage("playback-started", (data,sender)=>{
  const entry=entryFor(data,sender); if (!entry) return;
  entry.started=true;entry.state="playing";publishPlayers(); send("opening-ended", {id:entry.id,serverID:entry.connection.serverID});
  send("playing", {title:entry.title,id:entry.id,serverID:entry.connection.serverID,playerID:entry.playerID});
  if(entry.hideLibrary){entry.hideLibrary=false;hideBrowser();}
});
players.onMessage("playback-error", (data,sender)=>{
  releaseRetired(data,sender);
  const entry=entryFor(data,sender);if(!entry)return;
  send("opening-ended", {id:entry.id,serverID:entry.connection.serverID});
  send("notice", {message:"IINA could not open “"+entry.title+"”. Check that the media file is available, reconnect, and try again."});
  livePlayers.delete(entry.key);cleanFiles(entry);sync.close(data,sender);cancelNext();publishPlayers();
});
players.onMessage("playback-stopped",(data,sender)=>{
  const entry=entryFor(data,sender);if(!entry)return;
  entry.state="stopped";if(queuePlayer===entry.playerID)cancelNext();
  send("opening-ended",{id:entry.id,serverID:entry.connection.serverID});publishPlayers();
});
players.onMessage("playback-complete", (data,sender)=>{
  const entry=entryFor(data,sender);if(!entry||queuePlayer!==entry.playerID||!queue.length||!settings().autoNext)return;
  entry.completed=true;cancelNext();const revision=queueRevision;
  send("up-next", {title:queue[0].title,seconds:5});
  nextTimer=setTimeout(()=>{nextTimer=null;if(revision===queueRevision&&queuePlayer===entry.playerID)advanceQueue(entry.playerID,0,false).catch(error=>send("notice",{message:error.message}));},5000);
});
players.onMessage("player-state",(data,sender)=>{
  const entry=entryFor(data,sender);if(!entry)return;
  entry.state=data.state;entry.canSkipIntro=data.canSkipIntro===true;entry.canSkipCredits=data.canSkipCredits===true;publishPlayers();
});
players.onMessage("resume-failed", (data,sender) => {
  if(entryFor(data,sender))send("notice", { message: "IINA could not reach the saved Plex position. Playback was paused and your saved position was preserved. Try reopening the video." });
});
setInterval(() => sync.retryClosed(), 10000);
function disableSync() {
  resetQueue();
  for(const entry of livePlayers.values())retirePlayer(entry);
  livePlayers.clear();publishPlayers();opening.clear();sync.clear();
  players.postMessage(null,"disable-sync",{});
}
function headers(accessToken) {
  const h = { Accept: "application/json", "X-Plex-Product": "IINA Plex Library", "X-Plex-Version": "0.7.5", "X-Plex-Client-Identifier": clientID };
  if (accessToken) h["X-Plex-Token"] = accessToken;
  return h;
}
async function request(url, accessToken, method) {
  try {
    const res = await http[method || "get"](url, { headers: headers(accessToken) });
    if (res.statusCode < 200 || res.statusCode >= 300) throw res;
    if (!res.text && res.data == null) return {};
    return res.data || JSON.parse(res.text);
  } catch (error) {
    // Never forward raw networking errors: they can contain credentials and URLs.
    if (error && (error.statusCode === 401 || error.statusCode === 403)) { const denied = new Error("Plex denied access. Sign in again or check this library’s permissions."); denied.denied = true; throw denied; }
    throw new Error("Plex could not complete the request. Check your connection and try again.");
  }
}
function guarded(name, action) {
  window.onMessage(name, async data => {
    const activeSession = session;
    try { await action(data || {}); }
    catch (error) { if (activeSession === session) send("failure", { message: error.message, request: data && data.request, operation:name }); }
  });
}
window.loadFile("ui/browser.html");
window.setProperty({ title: "Plex Library", resizable: true });
window.setFrame(1180, 800);
function openBrowser() { window.open(); }
function hideBrowser() {
  const currentSession=session;
  setTimeout(()=>{if(currentSession===session)window.close();},0);
}
iina.menu.addItem(iina.menu.item("Browse Plex Library…", openBrowser));
async function restoreLogin() {
  if (restored) return;
  if (restoring) return restoring;
  const currentSession = session;
  const pending = (async () => {
    token = credentials.load();
    const previous = String(preferences.get("lastHomeProfile") || "");
    const remembered = /^\d+$/.test(previous) ? previous : "";
    needsProfile = !!remembered;
    if (!token || !remembered) return;
    profileID = remembered;
    try { await identifyAccount(); }
    catch (error) {
      if (currentSession !== session) return;
      if (error.denied) {
        credentials.clear();token=null;accountID="";profileID="owner";needsProfile=false;
      }
    }
    if (currentSession !== session) return;
    const saved = token && accountID ? credentials.loadProfile(accountID, remembered) : null;
    if (!saved) return;
    try {
      await resourcesFor(saved);
      if (currentSession !== session) return;
      profileToken=saved;needsProfile=false;
    } catch (error) {
      if (currentSession !== session) return;
      if (error.denied) credentials.clearProfile();
    }
  })();
  restoring = pending;
  try { await pending; }
  finally {
    if (currentSession === session) restored = true;
    if (restoring === pending) restoring = null;
  }
}
guarded("ready", async () => {
  const currentSession = session;
  send("preferences", settings());
  await restoreLogin();
  if (currentSession !== session) return;
  send("session", sessionInfo());publishQueue();publishPlayers();
});
guarded("sign-in", async () => {
  const generation = ++authGeneration;
  const pin = await request("https://plex.tv/api/v2/pins?strong=true", null, "post");
  if (generation !== authGeneration) return;
  const authURL = "https://app.plex.tv/auth#?" + P.query({ clientID, code: pin.code, "context[device][product]": "IINA Plex Library" });
  if (!iina.utils.open(authURL)) throw new Error("Could not open your browser. Please try signing in again.");
  send("auth-waiting", {});
  const deadline = Date.now() + Math.min(Number(pin.expiresIn || 300), 600) * 1000;
  while (generation === authGeneration && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (generation !== authGeneration) return;
    const result = await request("https://plex.tv/api/v2/pins/" + P.id(pin.id), null);
    if (generation !== authGeneration) return;
    if (result.authToken) {
      disableSync();session++;selected=null;servers=[];homeUsers=[];artwork={};artworkCache.clear();
      restored=true;
      token = result.authToken;profileToken=null;profileID="owner";needsProfile=false;accountID="";
      preferences.set("lastHomeProfile","");
      credentials.clearProfile();
      const saved = credentials.save(token);
      send("session", sessionInfo());
      if (!saved) send("notice", { message: "Signed in, but Keychain could not save your login. Allow IINA access to Keychain and sign in again to remember this account." });
      return;
    }
  }
  if (generation === authGeneration) throw new Error("Plex sign-in expired. Please try again.");
});
guarded("sign-out", async () => {
  restored=true;
  authGeneration++; session++; token = null; profileToken=null;profileID="owner";homeUsers=[];needsProfile=false;accountID="";servers = []; selected = null; artwork = {};artworkCache.clear();
  preferences.set("lastHomeProfile","");preferences.sync();
  disableSync();
  sync.clear(true);
  const cleared = credentials.clear();
  send("session", { signedIn: false });
  if (!cleared) send("notice", { message: "Signed out. Automatic sign-in is disabled, but Keychain could not clear the saved entry. You can remove Plex account in Keychain Access." });
});
guarded("discover", async () => {
  if (!token) throw new Error("Sign in to Plex first.");
  if(needsProfile)throw new Error("Choose your Plex Home profile before browsing.");
  const currentSession = session, generation = ++discoveryGeneration;
  let result;
  try { await identifyAccount();result = await resourcesFor(profileToken||token); }
  catch (error) {
    if(currentSession!==session||generation!==discoveryGeneration)return;
    if(currentSession===session&&error.denied&&profileToken){
      disableSync();credentials.clearProfile();profileToken=null;needsProfile=true;selected=null;servers=[];session++;
      send("session",sessionInfo());send("notice",{message:"Please select your Plex Home profile again."});return;
    }
    if (currentSession === session && error.denied) {
      disableSync(); credentials.clear(); token = null; servers = []; selected = null; artwork = {}; session++;
      send("session", { signedIn: false });
      send("notice", { message: "Your saved Plex login is no longer valid. Please sign in again." });
      return;
    }
    throw error;
  }
  if (currentSession !== session || generation !== discoveryGeneration) return;
  servers = result.filter(s => (s.provides || "").split(",").indexOf("server") !== -1 && s.accessToken);
  send("servers", servers.map(s => ({ id: s.clientIdentifier, name: s.name, owned: P.flag(s.owned) })));
});
guarded("connect", async data => {
  const server = servers.find(s => s.clientIdentifier === data.id);
  if (!server) throw new Error("Choose a discovered server.");
  const currentSession = session, generation=++connectionGeneration;
  selected = null; artwork = {};artworkCache.clear();
  for (const c of P.connections(server, data.allowHTTP === true)) {
    try {
      const base = P.origin(c.uri);
      const result = await request(base + "/library/sections", server.accessToken);
      if (currentSession !== session||generation!==connectionGeneration) return;
      selected = { base, token: server.accessToken, serverID: server.clientIdentifier, scope:scope(), allowHTTP:data.allowHTTP===true };
      preferences.set("lastServer", data.id); preferences.set("allowHTTP", data.allowHTTP === true); preferences.sync();
      await sync.recover(selected);
      if(currentSession!==session||generation!==connectionGeneration)return;
      send("libraries", (result.MediaContainer.Directory || []).filter(s => ["movie", "show"].indexOf(s.type) !== -1).map(s => ({ id: P.id(s.key), title: s.title, type: s.type })));
      return;
    } catch (_) { if (currentSession !== session) return; }
  }
  throw new Error("No reachable server connection. Check the server or enable local HTTP if your server requires it.");
});
async function homeRequest(path,method="get") {
  try{
    const result=await http[method]("https://plex.tv"+path,{headers:headers(token)});
    if(result.statusCode<200||result.statusCode>=300)throw new Error("denied");
    if(result.data&&typeof result.data==="object")return result.data;
    const text=result.text||"";
    if(text.trim().startsWith("<"))return {users:Media.xmlAttributes(text,"User"),user:Media.xmlAttributes(text,"user")[0]};
    return JSON.parse(text);
  }catch(_){throw new Error("Plex Home is unavailable, or the profile PIN was not accepted.");}
}
guarded("home-users",async()=>{
  if(!token)return;
  const currentSession=session;
  try{
    const result=await homeRequest("/api/home/users");
    if(currentSession!==session)return;
    homeUsers=result.users||result.User||(result.MediaContainer&&result.MediaContainer.User)||[];
    homeUsers=homeUsers.filter(user=>/^\d+$/.test(String(user.id))).map(user=>({id:String(user.id),title:user.title||user.username||"Home user",protected:P.flag(user.protected),admin:P.flag(user.admin)}));
    send("home-users",{users:homeUsers,selected:profileID,needsSelection:needsProfile});
  }catch(error){if(currentSession!==session)return;send("home-users",{users:[],selected:profileID,needsSelection:needsProfile});if(needsProfile)throw error;}
});
guarded("switch-profile",async data=>{
  if(!token)throw new Error("Sign in first.");
  const currentSession=session;
  await identifyAccount();if(currentSession!==session)return;
  const user=homeUsers.find(user=>user.id===String(data.id));if(!user)throw new Error("Choose an available Plex Home profile.");
  const pin=String(data.pin||"");if((user.protected&&!/^\d{4}$/.test(pin))||(pin&&!/^\d{4}$/.test(pin)))throw new Error("Enter the profile's four-digit PIN.");
  const result=await homeRequest("/api/home/users/"+P.id(user.id)+"/switch"+(pin?"?"+P.query({pin}):""),"post");
  if(currentSession!==session)return;
  const current=result.user||result.User||result;
  const switched=current.authenticationToken||current.authToken;
  if(typeof switched!=="string"||!switched)throw new Error("Plex did not authorize this profile.");
  await resourcesFor(switched);
  if(currentSession!==session)return;
  disableSync();session++;selected=null;servers=[];artwork={};artworkCache.clear();
  profileToken=switched;profileID=user.id;needsProfile=false;
  preferences.set("lastHomeProfile",profileID);
  const saved=credentials.saveProfile(accountID,profileID,switched);
  send("session",sessionInfo());
  send("home-users",{users:homeUsers,selected:profileID,needsSelection:false});
  if(!saved)send("notice",{message:"Profile selected, but Keychain could not save it. You will need to select it again after restarting IINA."});
});
guarded("reconnect", async () => {
  if (!token) throw new Error("Sign in first.");
  const old = selected;
  if (!old) {
    send("notice", {message:"Refresh servers and choose your server again."});
    return;
  }
  const currentSession = session;
  const isCurrent = () => currentSession === session && selected === old;
  const resources = await resourcesFor(profileToken || token);
  if (!isCurrent()) return;
  const server = resources.find(server => server.clientIdentifier === old.serverID);
  if (!server) throw new Error("This server is no longer shared with the selected profile.");
  for (const connection of P.connections(server, old.allowHTTP)) {
    try {
      const base = P.origin(connection.uri);
      await request(base + "/library/sections", server.accessToken);
      if (!isCurrent()) return;
      old.base = base;
      old.token = server.accessToken;
      await sync.recover(old);
      if (isCurrent()) send("reconnected", {});
      return;
    } catch (_) { if (!isCurrent()) return; }
  }
  throw new Error("Server is unavailable. Check its network connection and try again.");
});
function rememberArtwork(items) {
  artwork={};
  for(const item of items){const thumb=item.thumb||item.composite||item.parentThumb||item.grandparentThumb;
    try{if(thumb&&/^\/(?:library\/(?:metadata|collections)|playlists)\//.test(thumb))artwork[P.id(item.ratingKey)]={path:P.path(thumb),wide:item.type==="episode"};}catch(_){}
  }
}
function uniqueItems(items) {
  const seen=new Set();return items.filter(item=>{const id=String(item.ratingKey||"");if(!/^\d+$/.test(id)||seen.has(id))return false;seen.add(id);return true;});
}
guarded("browse",async data=>{
  if(!selected)throw new Error("Connect to a server first.");
  const connection=selected,generation=++browseGeneration,start=Number(data.start||0);
  if(!Number.isInteger(start)||start<0)throw new Error("Invalid page.");
  const params={"X-Plex-Container-Start":start,"X-Plex-Container-Size":60};
  let container;
  if(["continue","next","recent","search"].includes(data.view)&&!data.parent){
    const searching=data.view==="search";
    const route=searching?"/hubs/search?"+P.query({query:String(data.search||"").slice(0,200),limit:start+60}):"/hubs?"+P.query({count:start+60});
    const result=await request(connection.base+route,connection.token);
    const hubs=result.MediaContainer.Hub||[];
    const picked=searching?hubs:hubs.filter(hub=>{
      const key=String(hub.hubIdentifier||hub.key||"").toLowerCase();
      return data.view==="continue"?key.includes("continue"):data.view==="next"?key.includes("ondeck"):key.includes("recentlyadded");
    });
    let all=uniqueItems(picked.flatMap(hub=>hub.Metadata||[])).filter(item=>["movie","episode","show","season"].includes(item.type));
    if(data.view==="recent")all.sort((a,b)=>Number(b.addedAt||0)-Number(a.addedAt||0));
    const more=picked.some(hub=>hub.more===true||hub.more===1||Number(hub.size)>((hub.Metadata||[]).length));
    container={Metadata:all.slice(start,start+60)};
    if(!more)container.totalSize=all.length;
  }else{
    let route;
    if(data.parent){
      const id=P.id(data.parent);
      route=data.parentType==="playlist"?"/playlists/"+id+"/items":data.parentType==="collection"?"/library/collections/"+id+"/items":"/library/metadata/"+id+"/children";
      if(!["playlist","collection"].includes(data.parentType))params.sort="index:asc";
    }else if(data.view==="playlists"){
      route="/playlists";params.playlistType="video";
    }else{
      const library=P.id(data.library);
      route="/library/sections/"+library+(data.view==="collections"?"/collections":"/all");
      const sorts={title:"titleSort:asc",added:"addedAt:desc",year:"year:desc"};params.sort=sorts[data.sort]||sorts.title;
      preferences.set("lastLibrary",library);preferences.sync();
      if(data.search)params.title=String(data.search).slice(0,200);
      if(data.watch==="unwatched")params.unwatched="1";if(data.watch==="watched")params.unwatched="0";if(data.watch==="progress")params.inProgress="1";
      if(data.genre)params.genre=P.id(data.genre);if(data.year){if(!/^\d{4}$/.test(String(data.year)))throw new Error("Invalid year.");params.year=String(data.year);}
    }
    const result=await request(connection.base+route+"?"+P.query(params),connection.token);container=result.MediaContainer;
  }
  if(selected!==connection||generation!==browseGeneration)return;
  container.Metadata=container.Metadata||[];rememberArtwork(container.Metadata);
  send("listing",Object.assign(P.listing(container,start,60),{request:data.request,serverID:connection.serverID}));
});
guarded("filters",async data=>{
  if(!selected)return;const connection=selected,library=P.id(data.library),result={};
  for(const kind of ["genre","year"]){
    try{const response=await request(connection.base+"/library/sections/"+library+"/"+kind,connection.token);result[kind]=(response.MediaContainer.Directory||[]).filter(entry=>/^\d+$/.test(String(entry.key))).map(entry=>({id:String(entry.key),title:entry.title}));}
    catch(_){result[kind]=[];}
  }
  if(selected===connection)send("filters",Object.assign({library,serverID:connection.serverID},result));
});
guarded("watched", async data => {
  if (!selected) throw new Error("Connect to a server first.");
  const connection = selected, id = P.id(data.id);
  const active = () => Array.from(livePlayers.values()).some(entry =>
    entry.connection.scope === connection.scope && entry.connection.serverID === connection.serverID &&
    entry.id === id && entry.state !== "stopped");
  if (active()) throw new Error("Stop this item's IINA player before changing its watched state.");
  await sync.recover(connection, id);
  if (selected !== connection) return;
  if (active()) throw new Error("Stop this item's IINA player before changing its watched state.");
  if (sync.hasPending(connection, id)) {
    throw new Error("Wait for the playback position to sync, then try changing its watched state again.");
  }
  await request(connection.base + "/:/" + (data.watched === true ? "scrobble" : "unscrobble") + "?" +
    P.query({key:id,identifier:"com.plexapp.plugins.library"}), connection.token, "put");
  if (selected !== connection) return;
  const item = await metadataAt(connection, id);
  send("item-synced", {serverID:connection.serverID,item:P.listing({Metadata:[item]},0,1).items[0]});
});

async function metadataAt(connection, id) {
  const result=await request(connection.base+"/library/metadata/"+P.id(id)+"?includeMarkers=1",connection.token);
  const item=(result.MediaContainer.Metadata||[])[0];
  if(!item||P.id(item.ratingKey)!==P.id(id))throw new Error("Plex returned a different item. Refresh and try again.");
  return item;
}
async function subtitleFile(connection,stream,sessionID,files) {
  const extensions={srt:"srt",ass:"ass",ssa:"ssa",vtt:"vtt",webvtt:"vtt",subrip:"srt",pgs:"sup",hdmv_pgs_subtitle:"sup",dvd_subtitle:"idx",vobsub:"idx"};
  const ext=extensions[stream.codec];
  if(!ext)throw new Error("This external subtitle format is not supported yet. Select another track.");
  const temp="@tmp/sub-"+sessionID.replace(/[^a-zA-Z0-9-]/g,"")+"-"+stream.id+"."+ext;
  const download=async(path,suffix)=>{
    files.push(path);
    try { await http.download(connection.base+"/library/streams/"+P.id(stream.id)+"."+suffix,path,{headers:headers(connection.token)}); }
    catch (_) { throw new Error("The subtitle could not be downloaded. Choose another track or reconnect."); }
    const handle=iina.file.handle(path,"read");
    try{handle.seekToEnd();if(handle.offset()>16*1024*1024)throw new Error("Subtitle is too large to load.");}finally{handle.close();}
  };
  await download(temp,ext);
  if(ext==="idx")await download(temp.replace(/\.idx$/,".sub"),"sub");
  return temp;
}
// HTTP promises may resume on URLSession's worker thread. Player creation and delivery
// must run from IINA's main-thread timer, without holding a worker's JavaScript lock.
function onMainThread(callback) {
  return new Promise((resolve,reject)=>setTimeout(()=>{try{resolve(callback());}catch(error){reject(error);}},0));
}
async function launch(connection, id, options = {}, target = {}) {
  if (connection.scope !== scope()) throw new Error("This selection belongs to a previous profile. Refresh the library.");
  const currentSession = session;
  const isCurrent = () => currentSession === session && connection.scope === scope() &&
    (!target.isCurrent || target.isCurrent());
  if (!isCurrent()) return null;
  let reusePlayer = target.playerID == null ? null : target.playerID;
  const hideLibrary = target.hideLibrary !== false;
  id = P.id(id);
  const key = connection.scope + ":" + connection.serverID + ":" + id;
  const pending = opening.get(key);
  if (pending && pending.isCurrent()) return null;
  const existing = livePlayers.get(key);
  if (existing && existing.playerID !== reusePlayer) {
    if (options.restart || existing.state === "stopped") reusePlayer = existing.playerID;
    else {
      players.postMessage(existing.playerID, "activate-player", {});
      send("playing", {title:existing.title,existing:true,id,serverID:connection.serverID});
      if (hideLibrary && existing.started) hideBrowser();
      return existing;
    }
  }
  const operation = {isCurrent}, files = [];
  let handedOff = false, entry = null;
  opening.set(key, operation);
  send("opening", {id,serverID:connection.serverID});
  try {
    await sync.recover(connection, id);
    if (!isCurrent()) return null;
    const item = await metadataAt(connection, id);
    if (!isCurrent()) return null;
    if (!["movie", "episode"].includes(item.type)) throw new Error("Select a movie or episode to play.");
    const serverBaseline = Number(item.viewOffset) || 0;
    const saved = sync.pendingPosition(connection, id, item);
    if (saved !== null && !options.restart) item.viewOffset = saved;
    const chosen = Media.chooseVersion(item, options.versionId), parts = chosen.media.Part || [];
    const urls = P.parts(item, chosen.choice.index).map(path => connection.base + path);
    const resume = options.restart === true ? {index:0,position:0} : P.resumePoint(item, chosen.choice.index);
    const sessionID = clientID + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    const title = Media.playbackTitle(item);
    const preferred = settings(), initial = Media.selectTracks(parts[resume.index], options, preferred), tracks = [];
    for (let index = 0; index < parts.length; index++) {
      if(index<resume.index){tracks.push(null);continue;}
      const selectedTracks = index === resume.index ? initial : Media.selectTracks(parts[index], {},
        Object.assign({}, preferred, {
          audioLanguage:initial.audio && initial.audio.language || preferred.audioLanguage,
          subtitleLanguage:initial.subtitle && initial.subtitle.language || preferred.subtitleLanguage
        }));
      if (selectedTracks.subtitle && selectedTracks.subtitle.external) {
        selectedTracks.externalFile = await subtitleFile(connection, selectedTracks.subtitle, sessionID, files);
        if (!isCurrent()) return null;
      }
      tracks.push(selectedTracks);
    }
    return await onMainThread(() => {
      if (!isCurrent()) return null;
      const playerID = reusePlayer == null ? players.createPlayerInstance({label:"plex-playback",enablePlugins:false}) : reusePlayer;
      entry = {key,id,connection,playerID,sessionID,title,files,started:false,options,hideLibrary};
      for (const [oldKey, old] of livePlayers) {
        if (old.playerID === playerID) {
          livePlayers.delete(oldKey);
          retirePlayer(old);
        }
      }
      livePlayers.set(key, entry);
      publishPlayers();sync.bind(playerID, sessionID, connection, id, serverBaseline);
      const partDurations = parts.map(part => Number(part.duration) > 0 ? Number(part.duration) : 0);
      players.postMessage(playerID, "play-media", {
        urls,title,token:connection.token,sessionID,duration:chosen.choice.duration,
        partDurations,resume,tracks,markers:Media.markers(item)
      });
      handedOff = true;
      return entry;
    });
  } catch (error) {
    if(isCurrent())throw error;
    return null;
  } finally {
    if (!handedOff) {
      cleanFiles({files});
      if (entry && livePlayers.get(key) === entry) {
        livePlayers.delete(key);
        sync.close({sessionID:entry.sessionID}, entry.playerID);
        publishPlayers();
      }
    }
    if (opening.get(key) === operation) {
      opening.delete(key);
      if (!handedOff && currentSession === session) send("opening-ended", {id,serverID:connection.serverID});
    }
  }
}
guarded("play",async data=>{
  if(!selected)throw new Error("Connect to a server first.");
  const generation=queueGeneration;
  cancelNext();const entry=await launch(selected,data.id,data);
  if(entry&&queue.length&&generation===queueGeneration)queuePlayer=entry.playerID;
});
guarded("details",async data=>{
  if(!selected)throw new Error("Connect to a server first.");
  const connection=selected,item=await metadataAt(connection,data.id);
  if(selected!==connection)return;
  let options={versions:[],streams:[],markers:[]};
  if(["movie","episode"].includes(item.type)){
    const chosen=Media.chooseVersion(item,data.versionId);let partIndex=0;
    try{partIndex=P.resumePoint(item,chosen.choice.index).index;}catch(_){}
    options={versions:Media.versions(item),versionId:chosen.choice.id,streams:Media.streams(chosen.media.Part[partIndex]||{}),markers:Media.markers(item)};
  }
  send("details",Object.assign({id:String(data.id),request:data.request,serverID:connection.serverID,item:P.listing({Metadata:[item]},0,1).items[0]},options));
});
guarded("preferences", async data => {
  const updates = {};
  for (const key of ["audioLanguage", "subtitleLanguage"]) {
    if (data[key] == null) continue;
    const value = String(data[key]).trim().toLowerCase();
    if (value && !/^[a-z]{2,3}(-[a-z]+)?$/.test(value)) throw new Error("Use a language code such as en or eng.");
    updates[key] = value;
  }
  if (data.subtitleMode != null && ["auto", "forced", "off"].includes(data.subtitleMode)) updates.subtitleMode = data.subtitleMode;
  for (const key of ["autoNext", "includeSpecials"]) {
    if (typeof data[key] === "boolean") updates[key] = data[key];
  }
  for (const [key, value] of Object.entries(updates)) preferences.set(key, value);
  preferences.sync();
  if (updates.autoNext === false) cancelNext();
  send("preferences", settings());
});

function defaultQueuePlayer() {
  const entries=Array.from(livePlayers.values()).filter(entry=>entry.connection.scope===scope());
  return entries.length?entries[entries.length-1].playerID:null;
}
async function advanceQueue(playerID = queuePlayer, index = 0, hideLibrary = true) {
  if (queueBusy || !queue[index]) return;
  const record = queue[index], generation = queueGeneration;
  const isCurrent = () => generation === queueGeneration;
  if (record.connection.scope !== scope()) throw new Error("Queue belongs to a different profile.");
  if (playerID != null && !Array.from(livePlayers.values()).some(entry => entry.playerID === playerID)) playerID = null;
  queueBusy = true;cancelNext();publishQueue();
  try {
    const mayOpen = () => isCurrent() && (hideLibrary || settings().autoNext);
    const entry = await launch(record.connection, record.id, record.options, {playerID,hideLibrary,isCurrent:mayOpen});
    if (!entry || !isCurrent()) return;
    if (playerID != null && entry.playerID !== playerID) players.postMessage(playerID, "player-control", {action:"stop"});
    const position = queue.indexOf(record);
    if (position >= 0) queue.splice(position, 1);
    queuePlayer = entry.playerID;
  } finally {
    if (isCurrent()) { queueBusy = false;publishQueue(); }
  }
}
guarded("queue-add",async data=>{
  if(!selected)throw new Error("Connect to a server first.");
  const connection=selected,generation=queueGeneration,item=await metadataAt(connection,data.id);
  if(selected!==connection||generation!==queueGeneration)return;
  if(!["movie","episode"].includes(item.type))throw new Error("Choose a movie or episode.");
  const record={id:P.id(item.ratingKey),title:item.title,connection,options:{versionId:data.versionId,audioId:data.audioId,subtitleId:data.subtitleId}};
  cancelNext();
  if(data.position==="next")queue.unshift(record);else queue.push(record);
  queuePlayer=queuePlayer||defaultQueuePlayer();publishQueue();send("notice",{message:"Added “"+item.title+"” to the queue."});
});
guarded("queue-action",async data=>{
  if(data.revision!=null&&Number(data.revision)!==queueRevision)throw new Error("Queue changed. Try again.");
  if(data.action==="clear"){resetQueue();return;}
  if(data.action==="cancel-next"){cancelNext();return;}
  const index=Number(data.index);if(!Number.isInteger(index)||index<0||index>=queue.length)throw new Error("Queue changed. Try again.");
  if(data.action==="play"){await advanceQueue(queuePlayer,index);return;}
  if(queueBusy)throw new Error("Wait for the queued video to open.");
  cancelNext();
  if(data.action==="remove")queue.splice(index,1);
  else if(data.action==="up"&&index>0)[queue[index-1],queue[index]]=[queue[index],queue[index-1]];
  else if(data.action==="down"&&index<queue.length-1)[queue[index+1],queue[index]]=[queue[index],queue[index+1]];
  publishQueue();
});
async function leaves(connection,id,isCurrent=()=>true) {
  const all=[];
  for(let start=0;start<5000;start+=200){
    const result=await request(connection.base+"/library/metadata/"+P.id(id)+"/allLeaves?"+P.query({"X-Plex-Container-Start":start,"X-Plex-Container-Size":200}),connection.token);
    if(!isCurrent())return [];
    const container=result.MediaContainer,items=container.Metadata||[];all.push(...items);
    if(items.length<200||(container.totalSize!=null&&all.length>=Number(container.totalSize)))return uniqueItems(all);
  }
  throw new Error("This show is too large to queue at once. Choose a season instead.");
}
guarded("queue-series",async data=>{
  if(!selected)throw new Error("Connect to a server first.");
  const connection=selected,generation=queueRevision,preparation=++queuePreparation;
  const isCurrent=()=>selected===connection&&generation===queueRevision&&preparation===queuePreparation;
  const parent=await metadataAt(connection,data.id);
  if(!isCurrent())return;
  if(!["show","season","episode"].includes(parent.type))throw new Error("Choose a show or season.");
  const id=parent.type==="episode"?parent.grandparentRatingKey||parent.parentRatingKey:parent.ratingKey;
  let episodes=(await leaves(connection,id,isCurrent)).filter(item=>item.type==="episode");
  if(parent.type==="show"&&!settings().includeSpecials)episodes=episodes.filter(item=>Number(item.parentIndex)!==0);
  episodes.sort((a,b)=>Number(a.parentIndex||0)-Number(b.parentIndex||0)||Number(a.index||0)-Number(b.index||0));
  if(parent.type==="episode"){const index=episodes.findIndex(item=>String(item.ratingKey)===String(parent.ratingKey));if(index>=0)episodes=episodes.slice(index);}
  if(!isCurrent())return;if(!episodes.length)throw new Error("No playable episodes found.");
  resetQueue();queue=episodes.map(item=>({id:P.id(item.ratingKey),title:(item.grandparentTitle?item.grandparentTitle+" · ":"")+item.title,connection,options:{}}));
  publishQueue();await advanceQueue(null);
});
guarded("player-control",async data=>{
  const playerID=Number(data.playerID),entry=Array.from(livePlayers.values()).find(entry=>entry.playerID===playerID&&entry.connection.scope===scope());
  if(!entry)throw new Error("This player is no longer available.");
  if(data.action==="next"){await advanceQueue(playerID);return;}
  if(["skip-intro","skip-credits","stop","activate"].includes(data.action))players.postMessage(playerID,"player-control",{action:data.action});
  if(data.action==="activate")hideBrowser();
  if(data.action==="stop"){
    if(queuePlayer===playerID){invalidateQueue();publishQueue();}
    entry.state="stopping";
    send("opening-ended",{id:entry.id,serverID:entry.connection.serverID});publishPlayers();
  }
});

// Download authenticated artwork in the plugin; only image bytes reach the webview.
guarded("artwork", async data => {
  const connection = selected, poster = artwork[data.id];
  if (!connection || !poster) { send("artwork-done", { id: data.id, request: data.request }); return; }
  const cacheKey=connection.scope+":"+connection.serverID+":"+poster.path;
  const cached=artworkCache.get(cacheKey);
  if(cached&&Date.now()-cached.time<600000){artworkCache.delete(cacheKey);artworkCache.set(cacheKey,cached);send("artwork",{id:data.id,request:data.request,image:cached.image});send("artwork-done",{id:data.id,request:data.request});return;}
  const temp = "@tmp/poster-" + (++artworkSerial) + ".image";
  let handle;
  try {
    const url = connection.base + "/photo/:/transcode?" + P.query({ url: poster.path, width: "360", height: poster.wide ? "203" : "540", minSize: "1", upscale: "0" });
    await http.download(url, temp, { headers: headers(connection.token) });
    handle = iina.file.handle(temp, "read");
    const bytes = handle.read(2 * 1024 * 1024 + 1);
    if (selected !== connection || !bytes || bytes.length > 2 * 1024 * 1024) return;
    const image = P.imageData(bytes);
    if(image){
      artworkCache.set(cacheKey,{image,time:Date.now()});
      while(artworkCache.size>80||Array.from(artworkCache.values()).reduce((sum,entry)=>sum+entry.image.length,0)>16*1024*1024)artworkCache.delete(artworkCache.keys().next().value);
      send("artwork",{id:data.id,request:data.request,image});
    }
  } catch (_) { /* A missing poster should not interrupt browsing. */ }
  finally {
    try { if (handle) handle.close(); } catch (_) {}
    try { if (iina.file.exists(temp)) iina.file.delete(temp); } catch (_) {}
    send("artwork-done", { id: data.id, request: data.request });
  }
});
