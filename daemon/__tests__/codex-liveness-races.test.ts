// Adversarial-review probes for Codex liveness steps 2-3 (races, boot matrix, discard
// counts, heartbeat timers), kept as regression tests.
import { test, expect } from 'bun:test'
import { EventEmitter } from 'events'
import { CodexEngine } from '../codex-engine.js'
import { classifyPersisted } from '../engines/boot.js'
import { CodexEngineAdapter } from '../engines/codex-engine-adapter.js'
import { registry } from '../sessions.js'
import { reconnectCodexSessions, codexEngine } from '../engines/codex-runtime.js'
const tick = () => new Promise(r => setTimeout(r, 0))
function setup(id='review') {
 const engine:any = new CodexEngine(); const sent:any[]=[]; let terminated=0
 const ws:any=Object.assign(new EventEmitter(), {send(raw:string){sent.push(JSON.parse(raw))}, close(){ws.emit('close')}, terminate(){terminated++;ws.emit('close')}})
 const conn:any={sessionId:id,ws,threadId:'t',currentTurnId:null,turnPending:false,turnWatchdog:null,nextRequestId:0,pendingRequests:new Map(),messageBuffer:[],deferredTurnQueue:[],lastUsageWarning:0,retryTimers:new Set(),generation:1}
 engine.connections.set(id,conn); engine.attachWsHandlers(ws,conn,id)
 return {engine,ws,conn,sent,terminated:()=>terminated}
}
function timers(fn:(intervals:any[],timeouts:any[],advance:(n:number)=>void,cleared:Set<any>)=>void) {
 const originals=[globalThis.setInterval,globalThis.clearInterval,globalThis.setTimeout,Date.now]; let now=1000; const intervals:any[]=[];const timeouts:any[]=[];const cleared=new Set<any>()
 globalThis.setInterval=((f:any,ms:any)=>{const t={f,ms};intervals.push(t);return t}) as any
 globalThis.clearInterval=((t:any)=>{cleared.add(t)}) as any
 globalThis.setTimeout=((f:any,ms:any)=>{const t={f,ms};timeouts.push(t);return t}) as any
 Date.now=()=>now
 try {fn(intervals,timeouts,n=>{now+=n},cleared)} finally {[globalThis.setInterval,globalThis.clearInterval,globalThis.setTimeout,Date.now]=originals as any}
}
test('heartbeat: replaced connection, nonoverlapping probes, unmanaged frame stamp, close cleanup',()=>{
 const a=setup();a.engine.request=async()=>({})
 timers((intervals,timeouts,advance,cleared)=>{
  a.engine.startHeartbeat(a.conn);advance(30000);intervals[0].f();expect(timeouts).toHaveLength(1);expect(timeouts[0].ms).toBe(10000)
  a.engine.connections.set('review',{...a.conn});advance(10000);timeouts[0].f();expect(a.terminated()).toBe(0)
  intervals[0].f();expect(cleared.has(intervals[0])).toBe(true)
 })
 const b=setup('unmanaged'); b.engine.attachWsHandlers(b.ws,b.conn,'unmanaged',false);b.ws.emit('message','{}');expect(b.conn.lastFrameAt).toBeNumber();expect(b.conn.heartbeat).toBeUndefined();b.engine.disconnect('unmanaged')
 const c=setup('close'); c.engine.request=async()=>({})
 timers((intervals,timeouts,advance,cleared)=>{c.engine.startHeartbeat(c.conn);c.ws.emit('close');expect(cleared.has(intervals[0])).toBe(true)})
 const d=setup('overlap');d.engine.request=async()=>({})
 timers((intervals,timeouts,advance)=>{d.engine.startHeartbeat(d.conn);advance(30000);intervals[0].f();expect(timeouts).toHaveLength(1);advance(10000);timeouts[0].f();expect(d.terminated()).toBe(1);advance(20000);intervals[0].f();expect(timeouts).toHaveLength(1)})
})
test('heartbeat during turn/start retains uncertain text; discard catch cannot reclaim',async()=>{
 const a=setup();a.engine.queueTurn('review','inflight');await tick();expect(a.sent[0].method).toBe('turn/start')
 a.engine.request=((original:any)=>(conn:any,method:string,params:any)=>method==='model/list'?Promise.resolve({}):original.call(a.engine,conn,method,params))(a.engine.request)
 timers((intervals,timeouts,advance)=>{a.engine.startHeartbeat(a.conn);advance(30000);intervals[0].f();advance(10000);timeouts[0].f()})
 await tick();expect(a.engine.getScheduling('review').uncertainDeferredText).toBe('inflight');expect(a.engine.discardSession('review')).toEqual({queued:0,unknown:1})
 const b=setup('fence');b.engine.queueTurn('fence','late');expect(b.engine.discardSession('fence')).toEqual({queued:0,unknown:1});b.engine.disconnect('fence');await tick();expect(b.engine.getScheduling('fence').uncertainDeferredText).toBeNull()
})
test('a rejected retry awaiting its timer counts as queued, not unknown',async()=>{
 const a=setup('count');a.engine.startTurn=async()=>{throw new Error('rejected (code -1)')};a.engine.queueTurn('count','one message');await tick()
 expect(a.engine.getScheduling('count').retryingDeferred.text).toBe('one message')
 const counts=a.engine.discardSession('count');expect(counts).toEqual({queued:1,unknown:0});a.engine.disconnect('count')
})
test('boot matrix: thread/no thread x dead/live x tmux absent/present',()=>{
 let count=0;for(const thread of [false,true])for(const dead of [false,true])for(const tmux of [false,true]){expect(classifyPersisted({engine:'codex',codexThreadId:thread?'t':undefined,deadAt:dead?1:undefined},tmux)).toBe(thread?(dead?'dead':'live'):(tmux?'live':'dead'));count++}expect(count).toBe(8)
})
test('boot sweep cannot finalise replaced record, including a new ID in same thread',async()=>{
 for(const sameId of [true,false]){
  let finish:any;const old:any={sessionId:'old',threadId:'same-thread',engine:'codex',ephemeral:true,adapter:{reconnect:()=>new Promise(r=>{finish=r})}};registry.set('old',old)
  const sweep=reconnectCodexSessions([old]);registry.delete('old');const replacement:any={...old,sessionId:sameId?'old':'new'};registry.set(replacement.sessionId,replacement);finish(false);await sweep
  expect(old.deadAt).toBeUndefined();expect(replacement.deadAt).toBeUndefined();expect((codexEngine as any).getScheduling('old').fenced).toBe(false);registry.delete(replacement.sessionId)
 }
})
test('fresh-connect verdict checks actual socket',async()=>{
 const adapter=new CodexEngineAdapter({isSocketLive:async()=>true,connect:async()=>({threadId:'t'}),isConnected:()=>false} as any)
 const info:any={sessionId:'fresh',tmuxName:'fresh',adapter};registry.set('fresh',info);try{expect(await adapter.reconnect(info)).toBe(false)}finally{registry.delete('fresh')}
})
test('boot sweep for all eight persisted states',async()=>{
 let n=0
 for(const thread of [false,true])for(const dead of [false,true])for(const tmux of [false,true]){
  let probes=0;const info:any={sessionId:'matrix-'+n++,threadId:'matrix-thread',engine:'codex',ephemeral:true,codexThreadId:thread?'t':undefined,deadAt:dead?1:undefined,adapter:{reconnect:async()=>{probes++;return false}}}
  if(classifyPersisted(info,tmux)==='live')delete info.deadAt;else info.deadAt ??= 2
  const expected=info.deadAt?0:1;registry.set(info.sessionId,info);await reconnectCodexSessions([info]);expect(probes).toBe(expected);expect(info.deadAt).toBeNumber();registry.delete(info.sessionId)
 }
})
test('reply guard drops pending input when runtime finalises Codex death',async()=>{
 const {finaliseCodexDeath}=await import('../engines/codex-runtime.js');const {notePendingReply,handleSilenceEvent,_pendingForTesting}=await import('../reply-guard.js')
 const info:any={sessionId:'reply-death',tmuxName:'reply-death',threadId:'reply-thread',engine:'codex',ephemeral:true};registry.set(info.sessionId,info)
 notePendingReply(info.sessionId,{chat_id:'reply-thread',message_id:'m'});expect(_pendingForTesting().size).toBe(1);finaliseCodexDeath(info);handleSilenceEvent(info.tmuxName);expect(_pendingForTesting().size).toBe(0);registry.delete(info.sessionId)
})
