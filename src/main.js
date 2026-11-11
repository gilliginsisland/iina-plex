// Only managed Plex windows receive credentials or report progress.
if(iina.global.getLabel()==="plex-playback"){
  let tracker,lastState="";
  const intro=iina.menu.item("Skip intro",()=>tracker.skip("intro"),{enabled:false});
  const credits=iina.menu.item("Skip credits",()=>tracker.skip("credits"),{enabled:false});
  const update=()=>{
    if(!tracker)return;intro.enabled=tracker.available("intro");credits.enabled=tracker.available("credits");
    const state=tracker.status(),serialized=JSON.stringify(state);
    if(state.sessionID&&serialized!==lastState){lastState=serialized;iina.global.postMessage("player-state",state);}
  };
  tracker=require("./playback.js")(iina,update);
  // Global messages run synchronously on their sender's thread, including HTTP callbacks.
  // IINA timers run on the main thread; return to the sender before touching player/UI APIs.
  const onMessage=(name,callback)=>iina.global.onMessage(name,data=>{setTimeout(()=>callback(data),0);});
  onMessage("play-media",data=>{
    iina.menu.removeAllItems();
    if((data.markers||[]).some(marker=>marker.type==="intro"))iina.menu.addItem(intro);
    if((data.markers||[]).some(marker=>marker.type==="credits"))iina.menu.addItem(credits);
    tracker.open(data);
  });
  onMessage("disable-sync",()=>tracker.disable());
  onMessage("activate-player",()=>{iina.core.window.miniaturized=false;});
  onMessage("player-control",data=>{
    if(data.action==="skip-intro")tracker.skip("intro");
    if(data.action==="skip-credits")tracker.skip("credits");
    if(data.action==="stop")iina.core.stop();
    if(data.action==="activate")iina.core.window.miniaturized=false;
  });
}
