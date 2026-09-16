#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const cp=require('node:child_process');
const crypto=require('node:crypto');
const ROOT=__dirname;
const read=f=>JSON.parse(fs.readFileSync(path.join(ROOT,f),'utf8'));
const save=(f,data)=>{fs.mkdirSync(path.dirname(path.join(ROOT,f)),{recursive:true});fs.writeFileSync(path.join(ROOT,f),JSON.stringify(data,null,2)+'\n');};
const source=fs.readFileSync(path.join(ROOT,'engine.js'),'utf8');
const config=read('config.json');
const {bookingEngine,approvalGuard}=require('./engine.js');
const normalise=(body,channel)=>({...body,actor:{customer:'customer',staff:'staff',adapter:'adapter',timer:'timer'}[channel]});
const phone='+12025550101';
const at=n=>new Date(Date.UTC(2025,8,15,10,n)).toISOString();
const details={name:'Test Customer 01',issue:'Synthetic leaking fixture',address:'123 Example Road',postal:'K1A 0B1',preference:'visit'};
const ev=(type,n,extra={},channel='customer')=>({channel,body:{id:type+'-'+n,at:at(n),phone,type,...extra}});
const missed=ev('missed_call',0);
const initial=ev('approve_message',1,{messageId:'msg-1',approved:true},'staff');
const intake=ev('details',2,{details});
const approve=ev('approve_booking',3,{approved:true,revision:1,start:'2025-09-16T10:00:00Z',end:'2025-09-16T11:00:00Z'},'staff');
const bookingKey='booking-12025550101-r1';
const success=ev('calendar_result',4,{bookingKey,success:true,providerEventId:'synthetic-event-01'},'adapter');
const confirm=ev('approve_message',5,{messageId:'msg-2',approved:true},'staff');
const tick=n=>ev('tick',n,{},'timer');
const stop=n=>ev('message',n,{text:' STOP '});
function fixtures(){
  const f=(name,events,status,sms=0,whatsapp=0,calendar=0,extra={})=>({name,events,expected:{status,actions:{sms,whatsapp,calendar},...extra}});
  return [
    f('normal_visit',[missed,initial,intake,approve,success,confirm],'booked',1,1,1),
    f('normal_callback',[missed,initial,ev('details',2,{details:{...details,preference:'callback'}}),approve,success,confirm],'booked',1,1,1),
    f('duplicate_missed_calls',[missed,ev('missed_call',1),initial,ev('missed_call',2)],'waiting_customer',1,0,0,{drafts:1}),
    f('open_conversation_after_duplicate_window',[missed,initial,ev('missed_call',6)],'waiting_customer',1,0,0,{drafts:1,contains:'Existing conversation retained'}),
    f('plain_text_requires_structured_intake',[missed,initial,ev('message',2,{text:'Please book a visit tomorrow for the leaking fixture at 123 Example Road.'})],'waiting_customer',1,0,0,{drafts:1,revision:0,contains:'no free-text inference.'}),
    f('no_response_one_reminder',[missed,initial,tick(32),ev('approve_message',33,{messageId:'msg-2',approved:true},'staff'),tick(60),tick(100),tick(200)],'closed_no_reply',1,1,0,{drafts:2}),
    f('stop_before_send',[missed,stop(1),initial,ev('missed_call',20),tick(100)],'opted_out',0,0,0),
    f('stop_cancels_reminder',[missed,initial,tick(32),stop(33),ev('approve_message',34,{messageId:'msg-2',approved:true},'staff')],'opted_out',1,0,0),
    f('outside_business_hours',[ev('missed_call',0,{at:'2025-09-15T02:00:00Z'})],'waiting_customer',0,0,0,{contains:'outside business hours'}),
    f('staff_escalation',[missed,initial,intake,tick(48),tick(90)],'awaiting_staff',1,0,0,{escalated:true,escalations:1}),
    f('invalid_postal',[missed,initial,ev('details',2,{details:{...details,postal:'000'}}),approve],'needs_details',1,0,0,{contains:'invalid postal'}),
    f('invalid_address',[missed,initial,ev('details',2,{details:{...details,address:''}}),approve],'needs_details',1,0,0,{contains:'invalid address'}),
    f('outside_service_area',[missed,initial,ev('details',2,{details:{...details,postal:'H0H 0H0'}}),approve],'needs_details',1,0,0,{contains:'outside service area'}),
    f('stale_approval_after_edit',[missed,initial,intake,ev('details',3,{details:{...details,issue:'Updated synthetic issue'}}),ev('approve_booking',4,{...approve.body,id:'stale',at:at(4)},'staff')],'awaiting_staff',1,0,0),
    f('replayed_staff_approval',[missed,initial,intake,approve,approve,ev('approve_booking',4,{...approve.body,id:'different-delivery',at:at(4)},'staff')],'calendar_pending',1,0,1),
    f('forged_customer_approval',[missed,initial,intake,ev('approve_booking',3,{...approve.body,actor:'staff'})],'awaiting_staff',1,0,0),
    f('negative_staff_approval',[missed,initial,intake,ev('approve_booking',3,{...approve.body,approved:false},'staff')],'awaiting_staff',1,0,0),
    f('calendar_failure',[missed,initial,intake,approve,ev('calendar_result',4,{bookingKey,success:false},'adapter')],'calendar_failed',1,0,1,{drafts:1}),
    f('stop_before_booking_approval',[missed,initial,intake,stop(3),ev('approve_booking',4,{...approve.body,at:at(4)},'staff')],'opted_out',1,0,0),
    f('late_reminder_approval',[missed,initial,tick(32),ev('approve_message',100,{messageId:'msg-2',approved:true},'staff')],'closed_no_reply',1,0,0),
    f('stale_stop_still_wins',[missed,initial,intake,stop(0)],'opted_out',1,0,0),
    f('unapproved_drafts_do_not_send',[missed,tick(40),tick(100)],'waiting_customer',0,0,0,{drafts:1}),
  ];
}
const stateCode=source+`\nconst input=$input.first().json;\nconst store=$getWorkflowStaticData('global');\nif(input.demo){\n let state={};const effects=[];\n for(const entry of input.events){const event={...entry.body,actor:entry.channel};const result=bookingEngine(state,event,input.config);state=result.state;for(const a of result.actions){approvalGuard(a,state,a.kind==='calendar'?'calendar':'message');effects.push(a);}}\n return [{json:{state,actions:[],simulatedActions:effects,config:input.config}}];\n}\nconst result=bookingEngine(store.bookingState||{},input.event,input.config);\nstore.bookingState=result.state;\nreturn [{json:{...result,config:input.config}}];`;
const bookingGuardCode=source+`\nreturn $input.all().map(item=>{approvalGuard(item.json.action,item.json.state,'calendar');return item;});`;
const messageGuardCode=source+`\nreturn $input.all().map(item=>{approvalGuard(item.json.action,item.json.state,'message');return item;});`;
function makeWorkflow(){
  const nodes=[];const connections={};
  const node=(name,type,parameters={},version=1)=>{nodes.push({id:crypto.createHash('sha256').update(name).digest('hex').slice(0,24),name,type:'n8n-nodes-base.'+type,typeVersion:version,position:[(nodes.length%6)*260,Math.floor(nodes.length/6)*220],parameters});return nodes.at(-1);};
  const code=(name,js)=>node(name,'code',{mode:'runOnceForAllItems',jsCode:js},2);
  const edge=(a,b,port=0)=>{connections[a]||={main:[]};while(connections[a].main.length<=port)connections[a].main.push([]);connections[a].main[port].push({node:b,type:'main',index:0});};
  node('Manual demo','manualTrigger');
  code('Sample conversation',`return [{json:{demo:true,events:${JSON.stringify(fixtures()[0].events)}}}];`);
  edge('Manual demo','Sample conversation');edge('Sample conversation','Business configuration');
  for(const [name,actor,types] of [['Customer intake','customer',['missed_call','message','details']],['Staff decisions','staff',['approve_message','approve_booking']],['Calendar receipts','adapter',['calendar_result']]]){
    const n=node(name,'webhook',{httpMethod:'POST',path:'demo-booking-'+actor,authentication:'headerAuth',responseMode:'onReceived',options:{}},2);
    n.webhookId='demo-booking-'+actor;n.credentials={httpHeaderAuth:{id:'REPLACE_'+actor.toUpperCase()+'_CREDENTIAL_ID',name:'REPLACE_'+actor.toUpperCase()+'_HEADER_AUTH'}};
    code('Normalise '+actor,`const body=$input.first().json.body;\nif(!body||!${JSON.stringify(types)}.includes(body.type))throw new Error('unsupported event type for this authenticated route');\nreturn [{json:{event:{...body,actor:'${actor}',at:new Date().toISOString()}}}];`);
    edge(name,'Normalise '+actor);edge('Normalise '+actor,'Business configuration');
  }
  node('Reminder clock','scheduleTrigger',{rule:{interval:[{field:'minutes',minutesInterval:1}]}},1.2);
  code('Normalise timer',"const at=new Date().toISOString();return [{json:{event:{id:'tick-'+at,at,type:'tick',actor:'timer'}}}];");
  edge('Reminder clock','Normalise timer');edge('Normalise timer','Business configuration');
  code('Business configuration',`const config=${JSON.stringify(config)};\n// This node is the single editable business-variable block. Keep dryRun true for this template.\nreturn $input.all().map(item=>({json:{...item.json,config}}));`);
  code('State machine',stateCode);edge('Business configuration','State machine');
  code('Review queue','return $input.all().map(item=>({json:{contacts:item.json.state.contacts,log:item.json.state.log,simulatedActions:item.json.simulatedActions||[]}}));');
  edge('State machine','Review queue');
  code('Expand actions','const data=$input.first().json;return data.actions.map(action=>({json:{action,state:data.state,config:data.config}}));');
  edge('State machine','Expand actions');
  function iff(name,left,right){node(name,'if',{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{id:name.replaceAll(' ','-'),leftValue:left,rightValue:right,operator:{type:'string',operation:'equals'}}],combinator:'and'},options:{}},2.2);}
  iff('Calendar action?',"={{ $json.action.kind }}",'calendar');edge('Expand actions','Calendar action?');
  code('Staff booking guard',bookingGuardCode);code('Staff message guard',messageGuardCode);
  edge('Calendar action?','Staff booking guard');edge('Calendar action?','Staff message guard',1);
  for(const kind of ['Calendar','Message']){
    const low=kind.toLowerCase();const guard=kind==='Calendar'?'Staff booking guard':'Staff message guard';
    iff(kind+' dry run?',"={{ String($json.config.dryRun) }}",'true');edge(guard,kind+' dry run?');
    code(kind+' simulated','return $input.all().map(item=>({json:{simulated:true,action:item.json.action,nextStep:"Read the review queue; submit an authenticated receipt for calendar outcomes."}}));');
    edge(kind+' dry run?',kind+' simulated');
    const n=node(kind==='Calendar'?'Write calendar':'Send message','httpRequest',{method:'POST',url:`={{ $json.config.gatewayBaseUrl + '/${low}' }}`,authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',sendBody:true,specifyBody:'json',jsonBody:'={{ JSON.stringify($json.action) }}',options:{timeout:10000}},4.2);
    n.credentials={httpHeaderAuth:{id:'REPLACE_GATEWAY_CREDENTIAL_ID',name:'REPLACE_GATEWAY_HEADER_AUTH'}};
    n.onError='continueErrorOutput';n.retryOnFail=false;
    edge(kind+' dry run?',n.name,1);
    code(kind+' delivery failure',`return [{json:{requiresStaff:true,reason:'${kind} delivery failed or outcome unknown. Reconcile with the provider using the action id; do not blindly retry.',result:$input.first().json}}];`);
    edge(n.name,kind+' delivery failure',1);
  }
  node('Read before connecting','stickyNote',{content:'## Synthetic demo only\nAll sends require staff approval. Default dryRun=true.\nCalendar success needs an authenticated receipt before a confirmation draft exists.\nUse a WhatsApp intake form/adapter to collect structured fields.\nStatic data is a prototype store: do not enable real traffic without transactional persistence and idempotent adapters.\nSee README for configuration and limitations.',height:330,width:510},1);
  return {name:'Missed call booking - synthetic approval demo',active:false,nodes,connections,settings:{executionOrder:'v1',timezone:config.timezone},pinData:{},tags:[]};
}
function execute(code,input,store={}){
  const sandbox={$input:{first:()=>({json:input}),all:()=>Array.isArray(input)?input:[{json:input}]},$getWorkflowStaticData:()=>store};
  return vm.runInNewContext('(function(){'+code+'\n})()',sandbox,{timeout:1000});
}
function runScenario(s,workflow,print=false){
  let state={};const actions=[];const store={};const engine=workflow.nodes.find(n=>n.name==='State machine').parameters.jsCode;
  for(const input of s.events){
    const event=normalise(input.body,input.channel);
    const result=execute(engine,{event,config},store)[0].json;state=result.state;
    for(const action of result.actions){
      const name=action.kind==='calendar'?'Staff booking guard':'Staff message guard';
      const code=workflow.nodes.find(n=>n.name===name).parameters.jsCode;
      execute(code,{action,state,config});actions.push(action);
    }
  }
  const c=state.contacts[phone];const counts={sms:0,whatsapp:0,calendar:0};actions.forEach(a=>counts[a.kind]++);
  assert.equal(c.status,s.expected.status,s.name+' status');
  assert.deepEqual(counts,s.expected.actions,s.name+' action counts');
  if('drafts' in s.expected)assert.equal(c.messages.length,s.expected.drafts,s.name+' drafts');
  if('revision' in s.expected)assert.equal(c.revision,s.expected.revision,s.name+' request revision');
  if('escalated' in s.expected)assert.equal(c.escalated,s.expected.escalated);
  if('escalations' in s.expected)assert.equal(state.log.filter(l=>l.text.startsWith('STAFF ESCALATION')).length,s.expected.escalations);
  if(s.expected.contains)assert.ok(state.log.some(l=>l.text.includes(s.expected.contains)),s.name+' expected log');
  if(print){console.log('\nSCENARIO '+s.name);state.log.forEach(l=>console.log(l.at+' '+l.phone+' '+l.text));console.log('FINAL '+JSON.stringify({status:c.status,actions:counts}));}
  return {name:s.name,state,actions};
}
function graphCheck(w){
  const names=new Set(w.nodes.map(n=>n.name));assert.equal(names.size,w.nodes.length,'unique node names');
  const roots=w.nodes.filter(n=>/\.(manualTrigger|webhook|scheduleTrigger)$/.test(n.type)).map(n=>n.name);
  const adj={};let edges=0;
  for(const [src,groups]of Object.entries(w.connections)){
    assert.ok(names.has(src),'missing connection source '+src);adj[src]=[];
    for(const outputs of Object.values(groups))for(const port of outputs)for(const target of port){
      assert.ok(names.has(target.node),'missing connection target '+target.node);assert.equal(target.type,'main');assert.equal(target.index,0);adj[src].push(target.node);edges++;
    }
  }
  const reach=removed=>{const visited=new Set();const todo=[...roots];while(todo.length){const v=todo.pop();if(v===removed||visited.has(v))continue;visited.add(v);todo.push(...(adj[v]||[]));}return visited;};
  const sinks=[['Write calendar','Staff booking guard'],['Calendar simulated','Staff booking guard'],['Send message','Staff message guard'],['Message simulated','Staff message guard']];
  for(const [sink,guard]of sinks){
    assert.ok(reach(null).has(sink),'sink unreachable '+sink);
    assert.ok(!reach(guard).has(sink),'approval bypass reaches '+sink);
  }
  console.log('PASS graph: '+names.size+' nodes, '+edges+' edges, '+roots.length+' roots; approval dominates '+sinks.length+' calendar and message sinks');
}
function safetyCheck(w){
  assert.equal(w.active,false,'template must be inactive');
  const canonical=makeWorkflow();
  for(const n of w.nodes){
    const original=canonical.nodes.find(x=>x.name===n.name);assert.ok(original,'unrecognised executable node');
    assert.deepEqual(n,original,'node contract changed: '+n.name);
    if(n.credentials)for(const c of Object.values(n.credentials)){assert.match(c.id,/^REPLACE_/);assert.match(c.name,/^REPLACE_/);}
  }
  assert.equal(w.nodes.length,canonical.nodes.length,'missing nodes');
  assert.deepEqual(w.connections,canonical.connections,'unexpected connection edits');
  const text=JSON.stringify(w);
  for(const match of text.matchAll(/\+\d{10,15}/g))assert.match(match[0],/^\+1[2-9]\d{2}55501\d{2}$/,'non-test phone');
  assert.equal(config.dryRun,true);assert.match(config.whatsappPhone,/^\+1[2-9]\d{2}55501\d{2}$/);
  assert.equal(config.gatewayBaseUrl,'https://adapter.invalid');
  assert.ok(!/(?:ghp_|sk_live_|-----BEGIN .*PRIVATE KEY)/.test(text),'credential-like content');
  console.log('PASS node contracts, separate authenticated actor routes, placeholder credentials, test phones and dry-run defaults');
}
function check(w=read('workflow.json')){
  graphCheck(w);safetyCheck(w);
  const scenarios=read('scenarios.json');assert.deepEqual(scenarios,fixtures(),'scenario expectations changed');
  const results=[];
  for(const s of scenarios){results.push(runScenario(s,w));console.log('PASS scenario '+s.name);}
  const plain=results.find(r=>r.name==='plain_text_requires_structured_intake');
  const body=fixtures().find(s=>s.name===plain.name).events.at(-1).body.text;
  const logged=plain.state.log.map(entry=>entry.text.toLowerCase());
  const normalisedBody=body.toLowerCase();
  for(let start=0;start<=normalisedBody.length-20;start++){
    const fragment=normalisedBody.slice(start,start+20);
    assert.ok(logged.every(text=>!text.includes(fragment)),'plain-text message body fragment copied into receipt log');
  }
  console.log('PASS plain-text receipt log omits every case-insensitive 20-character customer-body fragment');
  assert.equal(JSON.stringify(results),JSON.stringify(read('output/transcripts.json')),'saved transcripts differ from fresh replay');
  // Invoke the actual embedded guard on a forged action, not just graph topology.
  assert.throws(()=>execute(w.nodes.find(n=>n.name==='Staff booking guard').parameters.jsCode,{action:{kind:'calendar',phone,approved:true,revision:1},state:{contacts:{[phone]:{status:'awaiting_staff'}}},config}),/booking approval does not match current request/,'Staff booking guard accepted forged calendar action');
  console.log('PASS runtime Staff booking guard rejects forged calendar action');
  assert.throws(()=>execute(w.nodes.find(n=>n.name==='Normalise customer').parameters.jsCode,{body:{...approve.body,actor:'staff'}}),/unsupported event type for this authenticated route/,'Customer intake route accepted approve_booking event');
  console.log('PASS runtime Customer intake route rejects approve_booking event');
  const n=execute(w.nodes.find(n=>n.name==='Normalise customer').parameters.jsCode,{body:{...missed.body,actor:'staff'}})[0].json.event;
  assert.equal(n.actor,'customer');
  const contactState={};bookingEngine(contactState,normalise(missed.body,'customer'),config);
  bookingEngine(contactState,normalise({...missed.body,id:'other',phone:'+12025550102'},'customer'),config);
  bookingEngine(contactState,normalise(stop(2).body,'customer'),config);
  assert.equal(contactState.contacts['+12025550102'].status,'waiting_customer');
  const demo=execute(w.nodes.find(n=>n.name==='Sample conversation').parameters.jsCode,{})[0].json;
  const replay=execute(stateCode,{...demo,config},{})[0].json;
  assert.equal(replay.state.contacts[phone].status,'booked');assert.equal(replay.actions.length,0);assert.equal(replay.simulatedActions.length,3);
  console.log('PASS forged runtime approval rejected; contact isolation; manual replay executes exact embedded engine without outbound actions');
  assert.equal(JSON.stringify(makeWorkflow()),JSON.stringify(makeWorkflow()));
  console.log('CHECK PASS '+scenarios.length+'/'+scenarios.length+' scenarios');
}
function breakDemo(){
  const originals=new Map(['demo.js','engine.js','config.json','workflow.json','scenarios.json','output/transcripts.json'].map(name=>[name,fs.readFileSync(path.join(ROOT,name))]));
  const w=read('workflow.json');w.connections['Customer intake'].main[0].push({node:'Write calendar',type:'main',index:0});
  const file=path.join(ROOT,'.broken-workflow.json');fs.writeFileSync(file,JSON.stringify(w));
  try{
    console.log('MUTATION added Customer intake -> Write calendar, bypassing staff approval');
    const r=cp.spawnSync(process.execPath,[__filename,'check','--workflow',file],{encoding:'utf8'});if(r.error)throw r.error;process.stdout.write(r.stdout||'');process.stdout.write(r.stderr||'');
    console.log('CHILD_EXIT_CODE='+r.status);assert.equal(r.status,1);assert.match(r.stdout,/approval bypass reaches Write calendar/);
    console.log('EXPECTED FAILURE OBSERVED; original workflow unchanged');
  }finally{fs.unlinkSync(file);}
  // Rebuild isolated source mutations so node-contract equality cannot hide
  // which runtime rejection assertion detected each broken protection layer.
  const mutations=[
    {name:'Staff booking guard changed to a no-op',file:'engine.js',before:'function approvalGuard(action,state,kind){',after:'function approvalGuard(action,state,kind){\n  return action;',failure:'Staff booking guard accepted forged calendar action'},
    {name:'Customer intake route allows approve_booking',file:'demo.js',before:"['missed_call','message',"+"'details']",after:"['missed_call','message','details','approve_booking']",failure:'Customer intake route accepted approve_booking event'},
  ];
  for(const mutation of mutations){
    const dir=fs.mkdtempSync(path.join(ROOT,'.break-source-'));
    try{
      for(const name of ['demo.js','engine.js','config.json'])fs.copyFileSync(path.join(ROOT,name),path.join(dir,name));
      const target=path.join(dir,mutation.file);const original=fs.readFileSync(target,'utf8');
      assert.equal(original.split(mutation.before).length,2,'mutation target must occur exactly once');
      fs.writeFileSync(target,original.replace(mutation.before,mutation.after));
      console.log('\nMUTATION '+mutation.name);
      for(const command of ['build','check']){
        console.log('COMMAND (isolated source copy): node demo.js '+command);
        const r=cp.spawnSync(process.execPath,['demo.js',command],{cwd:dir,encoding:'utf8'});if(r.error)throw r.error;
        process.stdout.write(r.stdout||'');process.stdout.write(r.stderr||'');console.log('CHILD_EXIT_CODE='+r.status);
        assert.equal(r.status,command==='build'?0:1,mutation.name+' '+command+' exit code');
        if(command==='check')assert.ok(r.stdout.includes('FAIL: Missing expected exception: '+mutation.failure),mutation.name+' must identify the broken runtime layer');
      }
      console.log('EXPECTED FAILURE OBSERVED: '+mutation.failure);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
  for(const [name,bytes]of originals)assert.deepEqual(fs.readFileSync(path.join(ROOT,name)),bytes,'break changed original '+name);
  console.log('\nBREAK PASS 3/3 mutations rejected; original source and generated files unchanged');
}
try{
  const command=process.argv[2];
  if(command==='build'){
    save('scenarios.json',fixtures());save('workflow.json',makeWorkflow());const w=read('workflow.json');
    const result=read('scenarios.json').map(s=>runScenario(s,w,true));save('output/transcripts.json',result);
    console.log('\nBUILD '+w.nodes.length+' nodes; '+result.length+' offline scenarios; no network adapters called');
  }else if(command==='check')check(process.argv[3]==='--workflow'?JSON.parse(fs.readFileSync(process.argv[4],'utf8')):undefined);
  else if(command==='break')breakDemo();
  else if(command==='simulate')read('scenarios.json').forEach(s=>runScenario(s,read('workflow.json'),true));
  else throw new Error('Usage: node demo.js build|check|break|simulate');
}catch(e){console.log('FAIL: '+e.message);process.exitCode=1;}
