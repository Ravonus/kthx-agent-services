export const HTML_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agent Health</title>
<style>
:root{--bg:#f5f7fb;--card:#fff;--ink:#0f172a;--muted:#475569;--line:#dbe3ef;--ok:#15803d;--warn:#a16207;--bad:#b91c1c}
*{box-sizing:border-box}body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:linear-gradient(145deg,#eef3ff,#f8fafc);color:var(--ink)}
.wrap{max-width:1100px;margin:24px auto;padding:0 16px;display:grid;gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;box-shadow:0 8px 22px rgba(15,23,42,.06)}
.top{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.h1{font-size:22px;font-weight:700;margin:2px 0}.muted{color:var(--muted);font-size:13px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 10px;font-size:13px}.k{color:var(--muted)}
.badge{display:inline-block;padding:3px 8px;border-radius:999px;font-weight:600;font-size:12px}
.ok{background:#dcfce7;color:var(--ok)}.warn{background:#fef3c7;color:var(--warn)}.bad{background:#fee2e2;color:var(--bad)}.neutral{background:#e2e8f0;color:#334155}
.list{display:grid;gap:8px}.evt{border:1px solid var(--line);border-radius:10px;padding:8px;font-size:13px}
input,select,button{font:inherit;border:1px solid var(--line);border-radius:8px;padding:8px;background:#fff;color:var(--ink)}
button{cursor:pointer}
button:hover{background:#f1f5f9}
.danger{background:#b91c1c;color:#fff;border-color:#991b1b}
.danger:hover{background:#991b1b}
.danger:disabled{cursor:wait;opacity:.7}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
</style></head><body>
<div class="wrap">
<div class="card top"><div><div class="muted">Agent Host</div><div class="h1">Agent Health</div></div><div class="row"><a href="/pipeline" class="badge neutral" style="text-decoration:none">Pipeline</a><a href="/graphs" class="badge neutral" style="text-decoration:none">Engagement</a><a href="/map" class="badge neutral" style="text-decoration:none">Memory Map</a><a href="/metrics" class="badge neutral" style="text-decoration:none">Runtime Metrics</a><div class="muted" id="ts">refreshing...</div></div></div>
<div class="grid">
<div class="card"><div class="muted">Runtime</div><div id="rt"></div></div>
<div class="card"><div class="muted">Chat Bridge</div><div id="cb"></div></div>
<div class="card"><div class="muted">Agent</div><div id="ag"></div></div>
<div class="card"><div class="muted">Memory</div><div id="mm"></div></div>
<div class="card"><div class="muted">Retention</div><div id="rp"></div></div>
<div class="card"><div class="muted">Activity</div><div id="ac"></div></div>
<div class="card"><div class="muted">App Control</div><div class="row" style="margin-top:8px"><button id="stopApp" type="button" class="danger">Stop app</button></div><div id="ctl" class="muted" style="margin-top:8px">Queues <code>shutdown all</code> on the supervisor.</div></div>
</div>
<div class="card">
<div class="muted">Retrieval Debug</div>
<div class="row" style="margin:8px 0">
<input id="rq" type="text" placeholder="query (e.g. post 751 engagement)" style="min-width:260px;flex:1"/>
<input id="rpost" type="number" min="1" placeholder="postId" style="width:110px"/>
<input id="rcomment" type="number" min="1" placeholder="commentId" style="width:120px"/>
<select id="rintent"><option value="chat">chat</option><option value="directive">directive</option><option value="engagement">engagement</option></select>
<button id="rrun" type="button">Run</button>
</div>
<div id="rdmeta" class="muted">Run retrieval debug queries locally.</div>
<div id="rd" class="list" style="margin-top:8px"></div>
</div>
<div class="card"><div class="muted">Recent Events</div><div id="events" class="list"></div></div>
<div class="card"><div class="muted">State Paths</div><div id="paths" class="kv"></div></div>
</div>
<script>
const esc=v=>String(v??'n/a').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const badge=v=>{const s=(v??'').toString().toLowerCase();if(['open','ok','ready','true'].includes(s))return['ok',v??'ok'];if(['pending','connecting','reconnecting'].includes(s))return['warn',v??'pending'];if(!s||s==='null'||s==='undefined')return['neutral','n/a'];return['bad',v??'down']};
const fmt=iso=>{if(!iso)return'n/a';const ms=Date.parse(iso);return Number.isFinite(ms)?new Date(ms).toLocaleString():'n/a'};
const kv=obj=>Object.entries(obj).map(([k,v])=>'<div class="k">'+esc(k)+'</div><div>'+esc(v??'n/a')+'</div>').join('');
const fmtTopicCounts=v=>{if(!v||typeof v!=='object')return'n/a';const o=v;return ['user','conversation','channel','server'].map(k=>k+':'+String(o[k]??0)).join(' · ')};
const shellCounts=v=>{if(!v||typeof v!=='object')return'n/a';const c=v.counts; if(!c||typeof c!=='object')return'n/a'; return ['dms','agentDms','groups','servers','channels'].map(k=>k+':'+String(c[k]??0)).join(' · ')};
const healthUrl='/api/health/private';
const setControlStatus=text=>{document.getElementById('ctl').textContent=text};
const render=snap=>{if(!snap)return;document.getElementById('ts').textContent='updated '+fmt(snap.generatedAt)+(snap.available===false&&snap.reason?' · '+snap.reason:'');
const[rC,rT]=badge(snap.runtime?.wsState);document.getElementById('rt').innerHTML='<div class="badge '+esc(rC)+'">'+esc(rT)+'</div><div class="kv" style="margin-top:8px">'+kv({auth:snap.runtime?.authEffective,permission:snap.runtime?.permissionState,wsTransport:snap.runtime?.wsTransportState,lastEnvelope:fmt(snap.runtime?.lastEnvelopeAt),lastPublish:fmt(snap.runtime?.lastPublishAt),publishError:snap.runtime?.lastPublishError??'none'})+'</div>';
const[cC,cT]=badge(snap.chatBridge?.connected===true?'ready':(snap.chatBridge?.state??'unknown'));document.getElementById('cb').innerHTML='<div class="badge '+esc(cC)+'">'+esc(cT)+'</div><div class="kv" style="margin-top:8px">'+kv({connected:String(snap.chatBridge?.connected),mode:snap.chatBridge?.subscriptionMode,topics:snap.chatBridge?.subscribedTopics,requested:fmtTopicCounts(snap.chatBridge?.requestedTopicCounts),subscribed:fmtTopicCounts(snap.chatBridge?.subscribedTopicCounts),shell:shellCounts(snap.chatBridge?.lastShellSummary),ticketFailures:snap.chatBridge?.lastTicketFailureCount,lastError:snap.chatBridge?.lastError??'none'})+'</div>';
document.getElementById('ag').innerHTML='<div class="kv">'+kv({userId:snap.agent?.userId,handle:snap.agent?.handle,name:snap.agent?.name,openclawAgent:snap.agent?.openClawAgentName,openclawBinOk:String(snap.agent?.openClawBinaryOk),openclawBinSource:snap.agent?.openClawBinarySource,openclawBinVersion:snap.agent?.openClawBinaryVersion??'n/a',openclawBinError:snap.agent?.openClawBinaryError??'none',identityUpdated:fmt(snap.agent?.identityUpdatedAt),visualSetupReady:String(snap.agent?.visualSetupReady),visualSetupNotification:snap.agent?.visualSetupNotificationState??'unknown',visualSetupUpdated:fmt(snap.agent?.visualSetupUpdatedAt),visualSetupMissing:Array.isArray(snap.agent?.visualSetupMissingItems)?snap.agent.visualSetupMissingItems.join(' | '):'n/a'})+'</div>';
document.getElementById('mm').innerHTML='<div class="kv">'+kv({mood:snap.memory?.moodPrimary,moodScore:snap.memory?.moodScore,tier24h:snap.memory?.tier24hEvents,tier7d:snap.memory?.tier7dEvents,keywordDocs:snap.memory?.keywordIndexDocs,keywordTerms:snap.memory?.keywordIndexKeywords,longTermCapsules:snap.memory?.longTermArchiveCapsules,longTermLatest:fmt(snap.memory?.longTermArchiveLatestCompactedAt),longTermAgent:snap.memory?.longTermArchiveAgentCompressed,longTermAlgorithm:snap.memory?.longTermArchiveAlgorithmCompressed})+'</div>';
document.getElementById('rp').innerHTML='<div class="kv">'+kv({enabled:String(snap.retention?.enabled),intervalMin:snap.retention?.intervalMinutes,postsDays:snap.retention?.postsDays,interactionsDays:snap.retention?.interactionsDays,notificationsDays:snap.retention?.notificationsDays,longTermEnabled:String(snap.retention?.longTermEnabled),longTermMaxCapsules:snap.retention?.longTermMaxCapsules,longTermCompactionsPerRun:snap.retention?.longTermMaxCompactionsPerRun})+'</div>';
document.getElementById('ac').innerHTML='<div class="kv">'+kv({publishOk:snap.activity?.publishSuccess,publishFail:snap.activity?.publishFailed,directives:snap.activity?.directivesExecuted,messages:snap.activity?.chatMessagesReceived,autoReplies:snap.activity?.chatAutoRepliesSent})+'</div>';
const evts=Array.isArray(snap.activity?.recentEvents)?snap.activity.recentEvents:[];document.getElementById('events').innerHTML=evts.length?evts.map(e=>'<div class="evt"><strong>'+esc(e?.type)+'</strong><br/><span class="muted">'+esc(e?.detail??'-')+' · '+esc(fmt(e?.at))+'</span></div>').join(''):'<div class="muted">No recent events.</div>';
const files=snap.files&&typeof snap.files==='object'?snap.files:{};const pathRows=Object.entries(files);document.getElementById('paths').innerHTML=pathRows.length?pathRows.map(([k,v])=>'<div class="k">'+esc(k)+'</div><div><code>'+esc(v)+'</code></div>').join(''):'<div class="muted">No state paths available.</div>'};
const renderRetrieval=(payload)=>{
const meta=document.getElementById('rdmeta');
const box=document.getElementById('rd');
if(!payload||payload.ok!==true){meta.textContent='retrieval unavailable';box.innerHTML='';return;}
meta.textContent='intent '+esc(payload.intent)+' · hits '+esc(payload.hitCount)+' · docs '+esc(payload.totalDocs)+' · keywords '+esc(payload.totalKeywords);
const target=payload.target&&typeof payload.target==='object'?payload.target:{};
const presets=payload.presets&&typeof payload.presets==='object'?payload.presets:{};
const rows=[];
if(target.mainPost){
rows.push('<div class="evt"><strong>Main Post</strong><br/><span class="muted">'+esc(target.mainPost.summary)+' · '+esc(fmt(target.mainPost.receivedAt))+'</span></div>');
}
rows.push('<div class="evt"><strong>Thread</strong><br/><span class="muted">postId='+esc(target.postId??'n/a')+' · commentId='+esc(target.commentId??'n/a')+' · replies='+esc(target.replyCount??0)+' · repliesToAgent='+esc(target.repliesToAgentCount??0)+'</span></div>');
if(presets.mostRecentPost&&typeof presets.mostRecentPost==='object'){
rows.push('<div class="evt"><strong>Preset: Most Recent Post</strong><br/><span class="muted">postId='+esc(presets.mostRecentPost.postId)+' · '+esc(fmt(presets.mostRecentPost.receivedAt))+'</span><br/>'+esc(presets.mostRecentPost.summary??'')+'</div>');
}
if(presets.mostEngaged&&typeof presets.mostEngaged==='object'&&Array.isArray(presets.mostEngaged.posts)){
const cards=presets.mostEngaged.posts.slice(0,3).map(p=>'<div class="muted">post '+esc(p.postId)+' score='+esc(p.score)+' · c='+esc(p.comments)+' l='+esc(p.likes)+' r='+esc(p.reposts)+' v='+esc(p.views)+' · '+esc(fmt(p.lastAt))+'</div>');
rows.push('<div class="evt"><strong>Preset: Most Engaged</strong><br/><span class="muted">range='+esc(presets.mostEngaged.rangeLabel??'n/a')+'</span>'+(cards.join('')||'<div class="muted">none</div>')+'</div>');
}
if(presets.mostEngagedComments&&typeof presets.mostEngagedComments==='object'&&Array.isArray(presets.mostEngagedComments.comments)){
const cards=presets.mostEngagedComments.comments.slice(0,4).map(c=>'<div class="muted">comment '+esc(c.commentId)+' (post '+esc(c.postId??'n/a')+') score='+esc(c.score)+' · c='+esc(c.comments)+' l='+esc(c.likes)+' r='+esc(c.reposts)+' v='+esc(c.views)+' n='+esc(c.notifications)+' · '+esc(fmt(c.lastAt))+'</div>');
rows.push('<div class="evt"><strong>Preset: Most Engaged Comments</strong><br/><span class="muted">range='+esc(presets.mostEngagedComments.rangeLabel??'n/a')+'</span>'+(cards.join('')||'<div class="muted">none</div>')+'</div>');
}
if(presets.topParticipants&&typeof presets.topParticipants==='object'&&Array.isArray(presets.topParticipants.participants)){
const cards=presets.topParticipants.participants.slice(0,8).map(p=>'<div class="muted">'+esc(p.display??p.participant)+' · score='+esc(p.score)+' · presence='+esc(p.presence)+' · c='+esc(p.comments)+' l='+esc(p.likes)+' r='+esc(p.reposts)+' v='+esc(p.views)+' n='+esc(p.notifications)+' · '+esc(fmt(p.lastAt))+'</div>');
rows.push('<div class="evt"><strong>Preset: Top Participants</strong><br/><span class="muted">range='+esc(presets.topParticipants.rangeLabel??'n/a')+' · metric='+esc(presets.topParticipants.metric??'combined')+'</span>'+(cards.join('')||'<div class="muted">none</div>')+'</div>');
}
const renderPresetEvents=(label,key)=>{
const list=Array.isArray(presets[key])?presets[key]:[];
if(!list.length)return;
const body=list.slice(0,4).map(item=>'<div class="muted">'+esc(fmt(item.receivedAt))+' · post '+esc(item.postId??'n/a')+' · '+esc(item.summary??'')+'</div>').join('');
rows.push('<div class="evt"><strong>Preset: '+esc(label)+'</strong>'+body+'</div>');
};
renderPresetEvents('Last Comments','lastComments');
renderPresetEvents('Last Likes','lastLikes');
renderPresetEvents('Last Views','lastViews');
const hits=Array.isArray(payload.hits)?payload.hits:[];
const archiveHits=Array.isArray(payload.archiveHits)?payload.archiveHits:[];
if(archiveHits.length){
rows.push('<div class="evt"><strong>Archive Capsules</strong><br/><span class="muted">hits='+esc(payload.archiveHitCount??archiveHits.length)+'</span></div>');
for(const h of archiveHits.slice(0,8)){
rows.push('<div class="evt"><strong>archive '+esc(h.stream??'unknown')+'</strong> score='+esc(h.score)+'<br/><span class="muted">'+esc(h.summary??'')+' · '+esc(fmt(h.compactedAt))+' · events='+esc(h.eventCount??'n/a')+' · '+esc(h.compressedBy??'algorithm')+'</span></div>');
}
}
for(const h of hits.slice(0,20)){
rows.push('<div class="evt"><strong>'+esc(h.sourceType??'event')+'</strong> score='+esc(h.score)+'<br/><span class="muted">'+esc(h.summary??'')+' · '+esc(fmt(h.receivedAt))+'</span></div>');
}
box.innerHTML=rows.join('')||'<div class="muted">No retrieval hits.</div>';
};
const shutdownApp=async()=>{if(!window.confirm('Stop the agent app? This queues supervisor shutdown and the health page will go offline shortly.'))return;const button=document.getElementById('stopApp');button.disabled=true;setControlStatus('queueing shutdown...');try{const response=await fetch('/api/health/control?action=shutdown&target=all',{method:'POST',cache:'no-store',keepalive:true});const payload=await response.json();if(!response.ok||payload?.ok!==true)throw new Error(payload?.message??payload?.error??('request failed ('+response.status+')'));setControlStatus('shutdown queued. This page will stop responding once the supervisor exits.')}catch(error){button.disabled=false;setControlStatus('shutdown failed: '+String(error instanceof Error?error.message:error))}};
const runRetrieval=async()=>{const q=(document.getElementById('rq').value??'').toString().trim();const post=(document.getElementById('rpost').value??'').toString().trim();const comment=(document.getElementById('rcomment').value??'').toString().trim();const intent=(document.getElementById('rintent').value??'chat').toString();const sp=new URLSearchParams();if(q)sp.set('q',q);if(post)sp.set('postId',post);if(comment)sp.set('commentId',comment);if(intent)sp.set('intent',intent);sp.set('limit','20');document.getElementById('rdmeta').textContent='running retrieval...';try{const r=await fetch('/api/health/retrieval?'+sp.toString(),{cache:'no-store'});renderRetrieval(await r.json())}catch(e){document.getElementById('rdmeta').textContent='retrieval failed: '+e}};
const tick=async()=>{try{const r=await fetch(healthUrl,{cache:'no-store'});render(await r.json())}catch(e){document.getElementById('ts').textContent='refresh failed: '+e}};
void tick();setInterval(tick,3000);
document.getElementById('stopApp').addEventListener('click',()=>{void shutdownApp()});
document.getElementById('rrun').addEventListener('click',()=>{void runRetrieval()});
</script></body></html>`;

export const GRAPH_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agent Memory Graphs</title>
<style>
:root{--bg:#f5f7fb;--card:#fff;--ink:#0f172a;--muted:#475569;--line:#dbe3ef;--accent:#2563eb;--accent2:#0f766e}
*{box-sizing:border-box}body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:linear-gradient(145deg,#eef3ff,#f8fafc);color:var(--ink)}
.wrap{max-width:1200px;margin:24px auto;padding:0 16px;display:grid;gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;box-shadow:0 8px 22px rgba(15,23,42,.06)}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.h1{font-size:22px;font-weight:700;margin:2px 0}.muted{color:var(--muted);font-size:13px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input,select,button{font:inherit;border:1px solid var(--line);border-radius:8px;padding:8px;background:#fff;color:var(--ink)}
button{cursor:pointer}button:hover{background:#f1f5f9}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.bars{display:grid;gap:8px}
.bar{display:grid;grid-template-columns:140px 1fr auto;gap:8px;align-items:center}
.track{height:12px;background:#e2e8f0;border-radius:999px;overflow:hidden}
.fill{height:100%;background:linear-gradient(90deg,var(--accent),#60a5fa)}
.fill2{background:linear-gradient(90deg,var(--accent2),#2dd4bf)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 10px;font-size:13px}.k{color:var(--muted)}
a{color:#2563eb;text-decoration:none}
</style></head><body>
<div class="wrap">
<div class="card top"><div><div class="muted">Agent Host</div><div class="h1">Memory Engagement Graphs</div></div><div class="row"><a href="/" class="muted">Health</a><a href="/pipeline" class="muted">Pipeline</a><a href="/map" class="muted">Memory map</a><a href="/metrics" class="muted">Runtime metrics</a><div class="muted" id="ts">loading...</div></div></div>
<div class="card">
<div class="row">
<select id="range"><option value="24h">24h</option><option value="7d">7d</option><option value="30d" selected>30d</option><option value="90d">90d</option><option value="365d">365d</option></select>
<select id="metric"><option value="combined">combined</option><option value="comments">comments</option><option value="likes">likes</option><option value="reposts">reposts</option><option value="views">views</option><option value="notifications">notifications</option><option value="presence">presence</option></select>
<input id="limit" type="number" min="3" max="20" value="10" style="width:90px"/>
<input id="postId" type="number" min="1" placeholder="postId (optional)" style="width:140px"/>
<input id="commentId" type="number" min="1" placeholder="commentId (optional)" style="width:160px"/>
<button id="run" type="button">Refresh</button>
</div>
<div class="muted" id="meta" style="margin-top:8px">ready</div>
</div>
<div class="grid">
<div class="card"><div class="muted">Totals</div><div id="totals" class="kv"></div></div>
<div class="card"><div class="muted">Top Participants</div><div id="top" class="bars"></div></div>
<div class="card"><div class="muted">Presence Leaders</div><div id="presence" class="bars"></div></div>
</div>
<div class="card"><div class="muted">Timeline (daily)</div><div id="timeline" class="bars"></div></div>
</div>
<script>
const esc=v=>String(v??'n/a').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const fmt=iso=>{if(!iso)return'n/a';const ms=Date.parse(iso);return Number.isFinite(ms)?new Date(ms).toLocaleString():'n/a'};
const kv=obj=>Object.entries(obj).map(([k,v])=>'<div class="k">'+esc(k)+'</div><div>'+esc(v??'n/a')+'</div>').join('');
const barRow=(label,value,max,useAlt)=>{const width=max>0?Math.max(2,Math.round((value/max)*100)):0;return '<div class="bar"><div>'+esc(label)+'</div><div class="track"><div class="fill'+(useAlt?' fill2':'')+'" style="width:'+width+'%"></div></div><div>'+esc(value)+'</div></div>'};
const render=(payload)=>{if(!payload||payload.ok!==true){document.getElementById('meta').textContent='data unavailable';return;}
document.getElementById('ts').textContent='updated '+fmt(payload.generatedAt);
const totals=payload.totals&&typeof payload.totals==='object'?payload.totals:{};
document.getElementById('totals').innerHTML=kv({range:payload.range?.label,metric:payload.metric,docsConsidered:payload.docsConsidered,totalEngagement:totals.totalEngagement,comments:totals.comments,likes:totals.likes,reposts:totals.reposts,views:totals.views,notifications:totals.notifications,presence:totals.presence,from:fmt(payload.range?.from),to:fmt(payload.range?.to)});
const tp=payload.topParticipants&&typeof payload.topParticipants==='object'?payload.topParticipants:null;
const topRows=Array.isArray(tp?.participants)?tp.participants:[];
const topMax=topRows.reduce((m,r)=>Math.max(m,Number(r.score)||0),0);
document.getElementById('top').innerHTML=topRows.length?topRows.map((row)=>barRow((row.display??row.participant??'unknown')+' ('+(row.lastAt?new Date(row.lastAt).toLocaleDateString():'n/a')+')',Number(row.score)||0,topMax,false)).join(''):'<div class="muted">No participant data.</div>';
const pp=Array.isArray(payload.topPresenceParticipants)?payload.topPresenceParticipants:[];
const ppMax=pp.reduce((m,r)=>Math.max(m,Number(r.presence)||0),0);
document.getElementById('presence').innerHTML=pp.length?pp.map((row)=>barRow(row.display??row.participant??'unknown',Number(row.presence)||0,ppMax,true)).join(''):'<div class="muted">No presence data.</div>';
const tl=Array.isArray(payload.timeline)?payload.timeline:[];
const tlRows=tl.slice(-20);
const tlMax=tlRows.reduce((m,row)=>Math.max(m,(Number(row.comments)||0)+(Number(row.likes)||0)+(Number(row.reposts)||0)+(Number(row.views)||0)+(Number(row.notifications)||0)),0);
document.getElementById('timeline').innerHTML=tlRows.length?tlRows.map((row)=>{const total=(Number(row.comments)||0)+(Number(row.likes)||0)+(Number(row.reposts)||0)+(Number(row.views)||0)+(Number(row.notifications)||0);return barRow(row.day+' · c'+(row.comments||0)+' l'+(row.likes||0)+' r'+(row.reposts||0)+' v'+(row.views||0)+' n'+(row.notifications||0),total,tlMax,false)}).join(''):'<div class="muted">No timeline data.</div>';
document.getElementById('meta').textContent='range '+esc(payload.range?.label)+' · metric '+esc(payload.metric)+' · participants '+esc(topRows.length);
};
const run=async()=>{const sp=new URLSearchParams();sp.set('range',String(document.getElementById('range').value||'30d'));sp.set('metric',String(document.getElementById('metric').value||'combined'));sp.set('limit',String(document.getElementById('limit').value||'10'));const postId=String(document.getElementById('postId').value||'').trim();const commentId=String(document.getElementById('commentId').value||'').trim();if(postId)sp.set('postId',postId);if(commentId)sp.set('commentId',commentId);document.getElementById('meta').textContent='loading...';try{const res=await fetch('/api/health/memory-engagement?'+sp.toString(),{cache:'no-store'});render(await res.json())}catch(err){document.getElementById('meta').textContent='failed: '+err}};
document.getElementById('run').addEventListener('click',()=>{void run()});
void run();
</script></body></html>`;

export const MAP_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agent Memory Map</title>
<style>
:root{--bg:#f5f7fb;--card:#fff;--ink:#0f172a;--muted:#475569;--line:#dbe3ef;--accent:#2563eb;--accent2:#0f766e}
*{box-sizing:border-box}body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:linear-gradient(145deg,#eef3ff,#f8fafc);color:var(--ink)}
.wrap{max-width:1280px;margin:24px auto;padding:0 16px;display:grid;gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;box-shadow:0 8px 22px rgba(15,23,42,.06)}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.h1{font-size:22px;font-weight:700;margin:2px 0}.muted{color:var(--muted);font-size:13px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input,select,button{font:inherit;border:1px solid var(--line);border-radius:8px;padding:8px;background:#fff;color:var(--ink)}
button{cursor:pointer}button:hover{background:#f1f5f9}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.bars{display:grid;gap:8px}
.bar{display:grid;grid-template-columns:180px 1fr auto;gap:8px;align-items:center}
.track{height:12px;background:#e2e8f0;border-radius:999px;overflow:hidden}
.fill{height:100%;background:linear-gradient(90deg,var(--accent),#60a5fa)}
.fill2{background:linear-gradient(90deg,var(--accent2),#2dd4bf)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 10px;font-size:13px}.k{color:var(--muted)}
.list{display:grid;gap:8px}
.evt{border:1px solid var(--line);border-radius:10px;padding:8px;font-size:13px}
a{color:#2563eb;text-decoration:none}
</style></head><body>
<div class="wrap">
<div class="card top"><div><div class="muted">Agent Host</div><div class="h1">Memory Map</div></div><div class="row"><a href="/" class="muted">Health</a><a href="/pipeline" class="muted">Pipeline</a><a href="/graphs" class="muted">Engagement</a><a href="/metrics" class="muted">Runtime metrics</a><div class="muted" id="ts">loading...</div></div></div>
<div class="card">
<div class="row">
<input id="query" type="text" placeholder="query (keywords, @handle, post 751)" style="min-width:280px;flex:1"/>
<select id="range"><option value="24h">24h</option><option value="7d">7d</option><option value="30d" selected>30d</option><option value="90d">90d</option><option value="365d">365d</option></select>
<select id="metric"><option value="combined">combined</option><option value="comments">comments</option><option value="likes">likes</option><option value="reposts">reposts</option><option value="views">views</option><option value="notifications">notifications</option><option value="presence">presence</option></select>
<select id="intent"><option value="chat">chat</option><option value="directive">directive</option><option value="engagement">engagement</option></select>
<input id="limit" type="number" min="5" max="100" value="20" style="width:90px"/>
<input id="postId" type="number" min="1" placeholder="postId" style="width:120px"/>
<input id="commentId" type="number" min="1" placeholder="commentId" style="width:140px"/>
<button id="run" type="button">Refresh</button>
</div>
<div id="meta" class="muted" style="margin-top:8px">ready</div>
</div>
<div class="grid">
<div class="card"><div class="muted">Summary</div><div id="summary" class="kv"></div></div>
<div class="card"><div class="muted">Biggest Participant</div><div id="biggest"></div></div>
<div class="card"><div class="muted">Source Distribution</div><div id="sources" class="bars"></div></div>
</div>
<div class="grid">
<div class="card"><div class="muted">Top Participants (biggest → smallest)</div><div id="participants" class="bars"></div></div>
<div class="card"><div class="muted">Top Posts In Memory</div><div id="posts" class="list"></div></div>
<div class="card"><div class="muted">Top Comments In Memory</div><div id="comments" class="list"></div></div>
</div>
<div class="grid">
<div class="card"><div class="muted">Timeline</div><div id="timeline" class="bars"></div></div>
<div class="card"><div class="muted">Memory Network (top edges)</div><div id="network" class="list"></div></div>
<div class="card"><div class="muted">Archive Hits</div><div id="archive" class="list"></div></div>
</div>
</div>
<script>
const esc=v=>String(v??'n/a').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const fmt=iso=>{if(!iso)return'n/a';const ms=Date.parse(iso);return Number.isFinite(ms)?new Date(ms).toLocaleString():'n/a'};
const kv=obj=>Object.entries(obj).map(([k,v])=>'<div class="k">'+esc(k)+'</div><div>'+esc(v??'n/a')+'</div>').join('');
const barRow=(label,value,max,alt)=>{const width=max>0?Math.max(2,Math.round((value/max)*100)):0;return '<div class="bar"><div>'+esc(label)+'</div><div class="track"><div class="fill'+(alt?' fill2':'')+'" style="width:'+width+'%"></div></div><div>'+esc(value)+'</div></div>'};
const renderList=(id,items,render)=>{const el=document.getElementById(id);if(!Array.isArray(items)||!items.length){el.innerHTML='<div class="muted">No data.</div>';return;}el.innerHTML=items.map(render).join('')};
const render=(payload)=>{
if(!payload||payload.ok!==true){document.getElementById('meta').textContent='memory map unavailable';return;}
document.getElementById('ts').textContent='updated '+fmt(payload.generatedAt);
const totals=payload.totals&&typeof payload.totals==='object'?payload.totals:{};
const filters=payload.filters&&typeof payload.filters==='object'?payload.filters:{};
document.getElementById('summary').innerHTML=kv({range:payload.range?.label,bucketMs:payload.range?.bucketMs,query:filters.query??'none',tokens:Array.isArray(filters.tokens)?filters.tokens.join(', '):'none',metric:filters.metric,intent:filters.intent,postId:filters.postId??'n/a',commentId:filters.commentId??'n/a',docsInRange:totals.docsInRange,docsMatched:totals.docsMatched,participants:totals.participants,posts:totals.posts,comments:totals.comments,sources:totals.sources});
const biggest=payload.biggestParticipant&&typeof payload.biggestParticipant==='object'?payload.biggestParticipant:null;
document.getElementById('biggest').innerHTML=biggest?'<div class="kv">'+kv({participant:biggest.display??biggest.participant,metricScore:biggest.metricScore,combined:biggest.combined,presence:biggest.presence,comments:biggest.comments,likes:biggest.likes,reposts:biggest.reposts,views:biggest.views,notifications:biggest.notifications,topPostId:biggest.topPostId??'n/a',topCommentId:biggest.topCommentId??'n/a',lastAt:fmt(biggest.lastAt)})+'</div>':'<div class="muted">No participant data.</div>';
const sources=Array.isArray(payload.sourceDistribution)?payload.sourceDistribution:[];
const sourceMax=sources.reduce((m,s)=>Math.max(m,Number(s.count)||0),0);
document.getElementById('sources').innerHTML=sources.length?sources.map((source)=>barRow(source.sourceType??'unknown',Number(source.count)||0,sourceMax,true)).join(''):'<div class="muted">No source data.</div>';
const participants=Array.isArray(payload.participantLeaders)?payload.participantLeaders:[];
const partMax=participants.reduce((m,p)=>Math.max(m,Number(p.metricScore)||0),0);
document.getElementById('participants').innerHTML=participants.length?participants.map((participant)=>barRow((participant.display??participant.participant)+' · c'+(participant.comments||0)+' l'+(participant.likes||0)+' r'+(participant.reposts||0)+' v'+(participant.views||0)+' n'+(participant.notifications||0),Number(participant.metricScore)||0,partMax,false)).join(''):'<div class="muted">No participants.</div>';
renderList('posts',payload.topPosts,(post)=>'<div class="evt"><strong>post '+esc(post.postId)+'</strong><br/><span class="muted">score '+esc(post.combined)+' · docs '+esc(post.docs)+' · participants '+esc(post.participantCount)+' · '+esc(fmt(post.lastAt))+'</span><br/>'+esc(post.summary??'')+'</div>');
renderList('comments',payload.topComments,(comment)=>'<div class="evt"><strong>comment '+esc(comment.commentId)+'</strong><br/><span class="muted">post '+esc(comment.postId??'n/a')+' · score '+esc(comment.combined)+' · docs '+esc(comment.docs)+' · participants '+esc(comment.participantCount)+' · '+esc(fmt(comment.lastAt))+'</span><br/>'+esc(comment.summary??'')+'</div>');
const timeline=Array.isArray(payload.timeline)?payload.timeline:[];
const timelineRows=timeline.slice(-32);
const timelineMax=timelineRows.reduce((m,row)=>Math.max(m,Number(row.total)||0),0);
document.getElementById('timeline').innerHTML=timelineRows.length?timelineRows.map((row)=>barRow(String(row.bucketAt).replace('T',' ').replace('.000Z','Z')+' · total '+(row.total??0)+' · c'+(row.comments??0)+' l'+(row.likes??0)+' r'+(row.reposts??0)+' v'+(row.views??0)+' n'+(row.notifications??0),Number(row.total)||0,timelineMax,false)).join(''):'<div class="muted">No timeline.</div>';
const network=payload.network&&typeof payload.network==='object'?payload.network:{};
const edges=Array.isArray(network.edges)?network.edges:[];
renderList('network',edges.slice(0,24),(edge)=>'<div class="evt"><strong>'+esc(edge.source)+' ↔ '+esc(edge.target)+'</strong><br/><span class="muted">weight '+esc(edge.weight)+'</span></div>');
const archive=payload.archive&&typeof payload.archive==='object'?payload.archive:{};
const archiveTop=Array.isArray(archive.top)?archive.top:[];
renderList('archive',archiveTop,(item)=>'<div class="evt"><strong>'+esc(item.stream)+' · score '+esc(item.score)+'</strong><br/><span class="muted">'+esc(fmt(item.compactedAt))+' · events '+esc(item.eventCount)+' · '+esc(item.compressedBy)+'</span><br/>'+esc(item.summary??'')+'</div>');
document.getElementById('meta').textContent='docs '+esc(totals.docsMatched??0)+' / '+esc(totals.docsInRange??0)+' · participants '+esc(participants.length)+' · network edges '+esc(edges.length);
};
const run=async()=>{const sp=new URLSearchParams();sp.set('range',String(document.getElementById('range').value||'30d'));sp.set('metric',String(document.getElementById('metric').value||'combined'));sp.set('intent',String(document.getElementById('intent').value||'chat'));sp.set('limit',String(document.getElementById('limit').value||'20'));const q=String(document.getElementById('query').value||'').trim();const postId=String(document.getElementById('postId').value||'').trim();const commentId=String(document.getElementById('commentId').value||'').trim();if(q)sp.set('q',q);if(postId)sp.set('postId',postId);if(commentId)sp.set('commentId',commentId);document.getElementById('meta').textContent='loading...';try{const res=await fetch('/api/health/memory-map?'+sp.toString(),{cache:'no-store'});render(await res.json())}catch(err){document.getElementById('meta').textContent='failed: '+err}};
document.getElementById('run').addEventListener('click',()=>{void run()});
void run();
</script></body></html>`;

export const METRICS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agent Runtime Metrics</title>
<style>
:root{--bg:#f5f7fb;--card:#fff;--ink:#0f172a;--muted:#475569;--line:#dbe3ef;--accent:#2563eb}
*{box-sizing:border-box}body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:linear-gradient(145deg,#eef3ff,#f8fafc);color:var(--ink)}
.wrap{max-width:1240px;margin:24px auto;padding:0 16px;display:grid;gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;box-shadow:0 8px 22px rgba(15,23,42,.06)}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.h1{font-size:22px;font-weight:700;margin:2px 0}.muted{color:var(--muted);font-size:13px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input,select,button{font:inherit;border:1px solid var(--line);border-radius:8px;padding:8px;background:#fff;color:var(--ink)}
button{cursor:pointer}button:hover{background:#f1f5f9}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 10px;font-size:13px}.k{color:var(--muted)}
.bars{display:grid;gap:8px}
.bar{display:grid;grid-template-columns:230px 1fr auto;gap:8px;align-items:center}
.track{height:12px;background:#e2e8f0;border-radius:999px;overflow:hidden}
.fill{height:100%;background:linear-gradient(90deg,var(--accent),#60a5fa)}
a{color:#2563eb;text-decoration:none}
</style></head><body>
<div class="wrap">
<div class="card top"><div><div class="muted">Agent Host</div><div class="h1">Runtime Metrics</div></div><div class="row"><a href="/" class="muted">Health</a><a href="/pipeline" class="muted">Pipeline</a><a href="/graphs" class="muted">Engagement</a><a href="/map" class="muted">Memory map</a><div class="muted" id="ts">loading...</div></div></div>
<div class="card">
<div class="row">
<select id="range"><option value="24h">24h</option><option value="7d">7d</option><option value="30d" selected>30d</option><option value="90d">90d</option><option value="365d">365d</option></select>
<select id="bucket"><option value="auto" selected>auto bucket</option><option value="1h">1h</option><option value="2h">2h</option><option value="6h">6h</option><option value="12h">12h</option><option value="1d">1d</option></select>
<select id="series"><option value="total">total</option><option value="publishOk">publish ok</option><option value="publishFailed">publish failed</option><option value="directivesExecuted">directives executed</option><option value="directivesFailed">directives failed</option><option value="inboundMessages">inbound messages</option><option value="chatAutoReplies">chat auto replies</option><option value="openClawPrompts">openclaw prompts</option></select>
<button id="run" type="button">Refresh</button>
</div>
<div id="meta" class="muted" style="margin-top:8px">ready</div>
</div>
<div class="card"><div class="muted">Totals</div><div id="totals" class="kv"></div></div>
<div class="card"><div class="muted">Timeline</div><div id="timeline" class="bars"></div></div>
</div>
<script>
const esc=v=>String(v??'n/a').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const fmt=iso=>{if(!iso)return'n/a';const ms=Date.parse(iso);return Number.isFinite(ms)?new Date(ms).toLocaleString():'n/a'};
const kv=obj=>Object.entries(obj).map(([k,v])=>'<div class="k">'+esc(k)+'</div><div>'+esc(v??'n/a')+'</div>').join('');
const barRow=(label,value,max)=>{const width=max>0?Math.max(2,Math.round((value/max)*100)):0;return '<div class="bar"><div>'+esc(label)+'</div><div class="track"><div class="fill" style="width:'+width+'%"></div></div><div>'+esc(value)+'</div></div>'};
const render=(payload)=>{
if(!payload||payload.ok!==true){document.getElementById('meta').textContent='metrics unavailable';return;}
document.getElementById('ts').textContent='updated '+fmt(payload.generatedAt);
const totals=payload.totals&&typeof payload.totals==='object'?payload.totals:{};
document.getElementById('totals').innerHTML=kv({range:payload.range?.label,bucketMs:payload.range?.bucketMs,from:fmt(payload.range?.from),to:fmt(payload.range?.to),total:totals.total,perHour:totals.perHour,publishOk:totals.publishOk,publishFailed:totals.publishFailed,directivesStaged:totals.directivesStaged,directivesExecuted:totals.directivesExecuted,directivesFailed:totals.directivesFailed,inboundMessages:totals.inboundMessages,chatAutoReplies:totals.chatAutoReplies,memoryRefreshes:totals.memoryRefreshes,notificationsFlushed:totals.notificationsFlushed,openClawPrompts:totals.openClawPrompts});
const series=String(document.getElementById('series').value||'total');
const rows=Array.isArray(payload.buckets)?payload.buckets:[];
const max=rows.reduce((m,row)=>Math.max(m,Number(row[series])||0),0);
const tail=rows.slice(-48);
document.getElementById('timeline').innerHTML=tail.length?tail.map((row)=>barRow(String(row.bucketAt).replace('T',' ').replace('.000Z','Z')+' · total '+(row.total??0),Number(row[series])||0,max)).join(''):'<div class="muted">No metrics data.</div>';
document.getElementById('meta').textContent='buckets '+esc(rows.length)+' · series '+esc(series)+' · max '+esc(max);
};
const run=async()=>{const sp=new URLSearchParams();sp.set('range',String(document.getElementById('range').value||'30d'));const bucket=String(document.getElementById('bucket').value||'auto');if(bucket!=='auto')sp.set('bucket',bucket);document.getElementById('meta').textContent='loading...';try{const res=await fetch('/api/health/metrics?'+sp.toString(),{cache:'no-store'});render(await res.json())}catch(err){document.getElementById('meta').textContent='failed: '+err}};
document.getElementById('run').addEventListener('click',()=>{void run()});
document.getElementById('series').addEventListener('change',()=>{void run()});
void run();
</script></body></html>`;

export const PIPELINE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agent Pipeline Health</title>
<style>
:root{--bg:#f5f7fb;--card:#fff;--ink:#0f172a;--muted:#475569;--line:#dbe3ef}
*{box-sizing:border-box}body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:linear-gradient(145deg,#eef3ff,#f8fafc);color:var(--ink)}
.wrap{max-width:1280px;margin:24px auto;padding:0 16px;display:grid;gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;box-shadow:0 8px 22px rgba(15,23,42,.06)}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.h1{font-size:22px;font-weight:700;margin:2px 0}.muted{color:var(--muted);font-size:13px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input,select,button{font:inherit;border:1px solid var(--line);border-radius:8px;padding:8px;background:#fff;color:var(--ink)}
button{cursor:pointer}button:hover{background:#f1f5f9}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.stage{border:1px solid var(--line);border-radius:12px;padding:10px}
.badge{display:inline-block;padding:3px 8px;border-radius:999px;font-weight:700;font-size:12px}
.ok{background:#dcfce7;color:#15803d}.warn{background:#fef3c7;color:#a16207}.bad{background:#fee2e2;color:#b91c1c}.neutral{background:#e2e8f0;color:#334155}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 10px;font-size:13px}.k{color:var(--muted)}
.list{display:grid;gap:8px}
.evt{border:1px solid var(--line);border-radius:10px;padding:8px;font-size:13px}
a{color:#2563eb;text-decoration:none}
</style></head><body>
<div class="wrap">
<div class="card top"><div><div class="muted">Agent Host</div><div class="h1">Pipeline Health</div></div><div class="row"><a href="/" class="muted">Health</a><a href="/graphs" class="muted">Engagement</a><a href="/map" class="muted">Memory map</a><a href="/metrics" class="muted">Runtime metrics</a><div class="muted" id="ts">loading...</div></div></div>
<div class="card">
<div class="row">
<select id="range"><option value="1h">1h</option><option value="6h" selected>6h</option><option value="24h">24h</option><option value="7d">7d</option><option value="30d">30d</option></select>
<input id="refreshMs" type="number" min="1000" max="60000" value="3000" style="width:110px"/>
<button id="run" type="button">Refresh now</button>
<button id="apply" type="button">Apply auto-refresh</button>
</div>
<div id="meta" class="muted" style="margin-top:8px">ready</div>
</div>
<div class="grid" id="stages"></div>
<div class="grid">
<div class="card"><div class="muted">Totals</div><div id="totals" class="kv"></div></div>
<div class="card"><div class="muted">Sources</div><div id="sources" class="kv"></div></div>
<div class="card"><div class="muted">Lifecycle</div><div id="lifecycle" class="kv"></div></div>
</div>
<div class="grid">
<div class="card"><div class="muted">Recent Pipeline Events</div><div id="events" class="list"></div></div>
<div class="card"><div class="muted">Recent Lifecycle Rows</div><div id="lifecycleRows" class="list"></div></div>
<div class="card"><div class="muted">Recent Notifications</div><div id="notifications" class="list"></div></div>
</div>
</div>
<script>
const esc=v=>String(v??'n/a').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const fmt=iso=>{if(!iso)return'n/a';const ms=Date.parse(iso);return Number.isFinite(ms)?new Date(ms).toLocaleString():'n/a'};
const kv=obj=>Object.entries(obj).map(([k,v])=>'<div class="k">'+esc(k)+'</div><div>'+esc(v??'n/a')+'</div>').join('');
const renderList=(id,items,render)=>{const el=document.getElementById(id);if(!Array.isArray(items)||!items.length){el.innerHTML='<div class="muted">No data.</div>';return;}el.innerHTML=items.map(render).join('')};
const rangeToMs=(range)=>{if(range==='1h')return 3600000;if(range==='6h')return 21600000;if(range==='24h')return 86400000;if(range==='7d')return 7*86400000;return 30*86400000};
let timer = null;
const renderStages=(stages)=>{
const entries=Object.entries(stages||{});
const labels={notifications:'Notifications → Memory',flush:'Notifications Buffer Flush',context:'Context Seed/Prime',target:'Target Resolution',queue:'Queue + Requeue',lifecycle:'Command Lifecycle'};
const html=entries.map(([key,value])=>{
const label=labels[key]||key;
const badge=value&&value.badge&&typeof value.badge==='object'?value.badge:{label:'IDLE',color:'neutral'};
return '<div class="stage"><div class="row"><strong>'+esc(label)+'</strong><span class="badge '+esc(badge.color||'neutral')+'">'+esc(badge.label||'IDLE')+'</span></div><div class="muted" style="margin-top:6px">'+esc(value?.detail??'n/a')+'</div><div class="kv" style="margin-top:8px">'+kv({count:value?.count??0,latestAt:fmt(value?.latestAt),staleMinutes:value?.staleMinutes??'n/a'})+'</div></div>';
}).join('');
document.getElementById('stages').innerHTML=html||'<div class="muted">No stage diagnostics.</div>';
};
const render=(payload)=>{
if(!payload||payload.ok!==true){document.getElementById('meta').textContent='pipeline unavailable';return;}
document.getElementById('ts').textContent='updated '+fmt(payload.generatedAt);
document.getElementById('meta').textContent='range '+esc(payload.range?.label)+' · events '+esc(payload.totals?.pipelineEvents??0)+' · source '+esc(payload.sources?.pipelineEventsSource??'n/a');
renderStages(payload.stages);
document.getElementById('totals').innerHTML=kv(payload.totals&&typeof payload.totals==='object'?payload.totals:{});
document.getElementById('sources').innerHTML=kv(payload.sources&&typeof payload.sources==='object'?payload.sources:{});
const lifecycle=payload.lifecycle&&typeof payload.lifecycle==='object'?payload.lifecycle:{};
document.getElementById('lifecycle').innerHTML=kv({stuck:lifecycle.stuck??0,latestAt:fmt(lifecycle.latest?.updatedAt),counts:JSON.stringify(lifecycle.counts??{})});
renderList('events',payload.recent?.events,(event)=>'<div class="evt"><strong>'+esc(event.type)+'</strong> <span class="muted">('+esc(event.source)+')</span><br/><span class="muted">'+esc(fmt(event.at))+'</span><br/>'+esc(event.detail??'')+'</div>');
renderList('lifecycleRows',payload.recent?.lifecycle,(row)=>'<div class="evt"><strong>'+esc(row.state)+'</strong><br/><span class="muted">'+esc(fmt(row.updatedAt))+' · attempts '+esc(row.attempts)+' · action '+esc(row.action??'n/a')+'</span><br/>'+esc(row.lastError??'')+'</div>');
renderList('notifications',payload.recent?.notifications,(row)=>'<div class="evt"><strong>'+esc(row.entityType??'notification')+' '+esc(row.entityId??'n/a')+'</strong><br/><span class="muted">'+esc(fmt(row.at))+' · post '+esc(row.postId??'n/a')+' · comment '+esc(row.commentId??'n/a')+'</span><br/>'+esc(row.actor??'')+'</div>');
};
const run=async()=>{
const range=String(document.getElementById('range').value||'6h');
const sp=new URLSearchParams();
sp.set('rangeMs',String(rangeToMs(range)));
try{
const res=await fetch('/api/health/pipeline?'+sp.toString(),{cache:'no-store'});
render(await res.json());
}catch(err){
document.getElementById('meta').textContent='failed: '+err;
}
};
const applyAutoRefresh=()=>{
if(timer){clearInterval(timer);timer=null;}
const refreshMs=Math.max(1000,Math.min(60000,Number(document.getElementById('refreshMs').value||3000)));
timer=setInterval(()=>{void run();},refreshMs);
};
document.getElementById('run').addEventListener('click',()=>{void run()});
document.getElementById('apply').addEventListener('click',()=>{applyAutoRefresh();void run()});
document.getElementById('range').addEventListener('change',()=>{void run()});
applyAutoRefresh();
void run();
</script></body></html>`;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
