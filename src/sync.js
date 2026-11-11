// Serialized timelines plus a credential-free journal of unacknowledged updates.
module.exports = function timelineSync(http, headers, notify, store = {}) {
  const sessions = {}, recovering = new Map();let generation = 0;
  let journal=[];
  try{journal=store.load?store.load():[];}catch(_){}
  const valid=record=>record&&typeof record.scope==="string"&&typeof record.serverID==="string"&&/^\d+$/.test(String(record.ratingKey))&&Number.isFinite(record.time)&&record.time>=0&&Number.isFinite(record.duration)&&record.duration>0&&Number.isFinite(record.updatedAt)&&Date.now()-record.updatedAt<7*86400000;
  journal=Array.isArray(journal)?journal.filter(valid).slice(-100):[];
  const key=entry=>entry.connection.scope+":"+entry.connection.serverID+":"+entry.ratingKey;
  function persist(){try{if(store.save)store.save(journal);}catch(_){notify("sync-storage-failed",{});}}
  function remove(k,through=Infinity){journal=journal.filter(record=>record.key!==k||record.updatedAt>through);persist();}
  function save(entry,update){
    const k=key(entry);journal=journal.filter(record=>record.key!==k);
    journal.push({key:k,scope:entry.connection.scope||"",serverID:entry.connection.serverID,ratingKey:entry.ratingKey,time:update.time,duration:update.duration,updatedAt:update.updatedAt,baseline:entry.lastAck});
    journal=journal.slice(-100);persist();
  }
  function bind(playerID,sessionID,connection,ratingKey,baseline=0){
    const entry={playerID,connection,ratingKey:String(ratingKey),pending:null,sending:false,warned:false,closing:false,retries:0,lastAck:Number(baseline)||0,lastState:"stopped",waiters:[]};
    for(const old of Object.keys(sessions))if(key(sessions[old])===key(entry))delete sessions[old];
    sessions[sessionID]=entry;
  }
  function query(params){return Object.keys(params).map(k=>encodeURIComponent(k)+"="+encodeURIComponent(params[k])).join("&");}
  function idle(entry){entry.sending=false;for(const resolve of entry.waiters.splice(0))resolve();}
  async function drain(sessionID,entry){
    if(entry.sending)return;entry.sending=true;
    while(entry.pending&&sessions[sessionID]===entry){
      const update=entry.pending;entry.pending=null;save(entry,update);
      const params={ratingKey:entry.ratingKey,key:"/library/metadata/"+entry.ratingKey,state:update.state,time:update.time,duration:update.duration};
      try{
        const h=headers(entry.connection.token);h["X-Plex-Session-Identifier"]=sessionID;
        const result=await http.post(entry.connection.base+"/:/timeline?"+query(params),{headers:h});
        if(!result||result.statusCode<200||result.statusCode>=300)throw new Error("Timeline rejected");
        if(sessions[sessionID]!==entry)break;
        entry.lastAck=update.time;remove(key(entry),update.updatedAt);
        if(entry.warned)notify("sync-recovered",{});entry.warned=false;
        notify("progress-synced",{id:entry.ratingKey,serverID:entry.connection.serverID,time:update.time,duration:update.duration});
        if(update.state==="stopped"){
          try{
            const res=await http.get(entry.connection.base+"/library/metadata/"+entry.ratingKey,{headers:headers(entry.connection.token)});
            if(res.statusCode>=200&&res.statusCode<300&&sessions[sessionID]===entry){
              const data=res.data||JSON.parse(res.text),item=(data.MediaContainer.Metadata||[])[0];
              if(item&&String(item.ratingKey)===entry.ratingKey)notify("item-synced",{serverID:entry.connection.serverID,item});
            }
          }catch(_){}
        }
      }catch(_){
        if(sessions[sessionID]!==entry)break;
        if(!entry.warned)notify("sync-failed",{});entry.warned=true;
        if(!entry.pending)entry.pending=update;idle(entry);return;
      }
    }
    idle(entry);if(entry.closing&&!entry.pending)delete sessions[sessionID];
  }
  const matches=(entry,sender)=>String(sender)===String(entry.playerID)||String(sender)===entry.playerID+"-io.iina.plex-library";
  function report(data,sender){
    const entry=data&&sessions[data.sessionID];if(!entry||entry.closing||!matches(entry,sender))return;
    if(!["playing","paused","buffering","stopped"].includes(data.state)||!Number.isFinite(data.time)||!Number.isFinite(data.duration)||data.time<0||data.duration<=0)return;
    entry.lastState=data.state;
    entry.pending={state:data.state,time:Math.min(Math.round(data.time),Math.round(data.duration)),duration:Math.round(data.duration),updatedAt:Date.now()};
    entry.closing=data.final===true;entry.retries=0;return drain(data.sessionID,entry);
  }
  function retryClosed(){for(const id of Object.keys(sessions)){
    const entry=sessions[id];if(entry.sending||!entry.pending||(!entry.closing&&entry.pending.state!=="stopped"))continue;
    if(++entry.retries>3){notify("sync-abandoned",{});if(entry.closing)delete sessions[id];else entry.pending=null;continue;}
    drain(id,entry);
  }}
  function close(data,sender){const entry=data&&sessions[data.sessionID];if(!entry||!matches(entry,sender))return;entry.closing=true;if(!entry.pending&&!entry.sending)delete sessions[data.sessionID];}
  function clear(forget=false){generation++;for(const id of Object.keys(sessions))delete sessions[id];if(forget){journal=[];persist();}}
  async function recover(connection,onlyID){
    const recoveryKey=connection.scope+":"+connection.serverID;
    if(recovering.has(recoveryKey))return recovering.get(recoveryKey);
    const run=(async()=>{
      const current=generation;
      for(const [id,entry]of Object.entries(sessions)){
        if(entry.connection.scope!==connection.scope||entry.connection.serverID!==connection.serverID||(onlyID&&entry.ratingKey!==String(onlyID)))continue;
        if(entry.sending)await new Promise(resolve=>entry.waiters.push(resolve));
        if(generation!==current)return;
        if(entry.pending&&sessions[id]===entry)await drain(id,entry);
      }
      for(const record of journal.slice()){
        if(record.scope!==connection.scope||record.serverID!==connection.serverID||(onlyID&&record.ratingKey!==String(onlyID)))continue;
        if(Object.values(sessions).some(entry=>key(entry)===record.key&&(entry.sending||entry.pending||entry.lastState!=="stopped")))continue;
        try{
          const res=await http.get(connection.base+"/library/metadata/"+record.ratingKey,{headers:headers(connection.token)});
          if(res.statusCode<200||res.statusCode>=300)continue;
          const data=res.data||JSON.parse(res.text),item=(data.MediaContainer.Metadata||[])[0];if(!item||String(item.ratingKey)!==record.ratingKey)continue;
          if(generation!==current)return;
          const serverTime=Number(item.viewOffset)||0;
          // Do not rewind another client's activity or repeat a request already acknowledged before a crash.
          if(serverTime===record.time||Number(item.lastViewedAt||0)*1000>record.updatedAt+1000||(serverTime!==record.baseline&&serverTime!==record.time)){
            remove(record.key,record.updatedAt);continue;
          }
          const params={ratingKey:record.ratingKey,key:"/library/metadata/"+record.ratingKey,state:"stopped",time:record.time,duration:record.duration,offline:1,updated:Math.floor(record.updatedAt/1000)};
          const result=await http.post(connection.base+"/:/timeline?"+query(params),{headers:headers(connection.token)});
          if(generation!==current)return;
          if(result.statusCode>=200&&result.statusCode<300){remove(record.key,record.updatedAt);notify("sync-recovered",{});}
        }catch(_){/* Keep the record for the next authenticated reconnect. */}
      }
    })();recovering.set(recoveryKey,run);
    try{return await run;}finally{recovering.delete(recoveryKey);}
  }
  function pendingPosition(connection,id,item){
    const record=journal.find(record=>record.scope===connection.scope&&record.serverID===connection.serverID&&record.ratingKey===String(id));
    if(!record||Number(item.lastViewedAt||0)*1000>record.updatedAt+1000)return null;
    const current=Number(item.viewOffset)||0;return current===record.baseline||current===record.time?record.time:null;
  }
  return {bind,report,close,retryClosed,clear,recover,pendingPosition};
};
