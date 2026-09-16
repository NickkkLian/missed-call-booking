/* Shared verbatim by the n8n Code node and the offline simulator. */
function bookingEngine(state, event, config) {
  const fail = m => { throw new Error(m); };
  const testPhone = p => /^\+1[2-9]\d{2}55501\d{2}$/.test(p || '');
  const now = Date.parse(event.at);
  if (!Number.isFinite(now) || !event.id || typeof event.id !== 'string') fail('event id and ISO time required');
  for (const k of ['duplicateMinutes','reminderMinutes','stopMinutes','escalateMinutes']) {
    if (!Number.isFinite(config[k]) || config[k] <= 0) fail('invalid configuration '+k);
  }
  if(config.stopMinutes<=config.reminderMinutes) fail('stopMinutes must exceed reminderMinutes');
  state.contacts ||= {}; state.seen ||= {}; state.log ||= []; state.sequence ||= 0;
  const actions=[];
  const log=(phone,text)=>state.log.push({at:event.at,phone,text});
  if(state.seen[event.id]) {log(event.phone||'', 'Ignored replay '+event.id);return {state,actions};}
  state.seen[event.id]=true;
  const hours = () => {
    const parts = new Intl.DateTimeFormat('en-US',{timeZone:config.timezone,weekday:'short',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now));
    const val=t=>parts.find(p=>p.type===t)?.value;
    return config.businessDays.includes(val('weekday')) && Number(val('hour'))>=config.openHour && Number(val('hour'))<config.closeHour;
  };
  const draft=(c,purpose,text)=>{
    const id='msg-'+(++state.sequence);
    c.messages.push({id,purpose,text,revision:c.revision,status:'needs_staff_approval',createdAt:now});
    log(c.phone,'DRAFT '+id+': '+text);return id;
  };
  const invalidate=c=>{ for(const m of c.messages)if(m.status==='needs_staff_approval')m.status='cancelled'; };
  const tick = c => {
    if(c.status==='opted_out')return;
    if(c.status==='waiting_customer' && c.lastSentAt!==null){
      const elapsed=(now-c.lastSentAt)/60000;
      if(elapsed>=config.stopMinutes){c.status='closed_no_reply';invalidate(c);log(c.phone,'Closed after no reply');}
      else if(elapsed>=config.reminderMinutes&&!c.reminderCreated){
        c.reminderCreated=true;draft(c,'reminder','One reminder: reply on WhatsApp if you still need help. Reply STOP to opt out.');
      }
    }
    if(c.status==='awaiting_staff' && now-c.requestedAt>=config.escalateMinutes*60000&&!c.escalated){
      c.escalated=true;log(c.phone,'STAFF ESCALATION: request still unconfirmed');
      // Internal queue entry only. Sending a notification would need its own approval.
    }
  };
  if(event.type==='tick'){
    if(event.actor!=='timer')fail('tick requires trusted timer');
    for(const c of Object.values(state.contacts))tick(c);
    return {state,actions};
  }
  if(!testPhone(event.phone))fail('demo accepts reserved test phone numbers only');
  if(!['customer','staff','adapter'].includes(event.actor))fail('untrusted actor');
  const phone=event.phone;
  const c=state.contacts[phone] ||= {phone,status:'new',revision:0,messages:[],lastMissedAt:null,lastSentAt:null,reminderCreated:false,escalated:false,lastEventAt:0,calendar:null};
  // STOP dominates queued actions and stale timestamps. Consent is never reset by a missed call.
  if(event.actor==='customer' && event.type==='message' && String(event.text||'').trim().toUpperCase()==='STOP'){
    c.status='opted_out';invalidate(c);log(phone,'STOP: cancelled queued messages; future contact blocked');return {state,actions};
  }
  if(now<c.lastEventAt){log(phone,'Rejected out-of-order event');return {state,actions};}
  c.lastEventAt=now;
  if(c.status==='opted_out'){log(phone,'Suppressed: opted out');return {state,actions};}
  tick(c);
  if(event.actor==='customer' && event.type==='missed_call'){
    if(c.lastMissedAt!==null&&now-c.lastMissedAt<config.duplicateMinutes*60000){log(phone,'Suppressed duplicate missed call');return {state,actions};}
    c.lastMissedAt=now;
    if(!['new','closed_no_reply'].includes(c.status)){log(phone,'Existing conversation retained');return {state,actions};}
    c.status='waiting_customer';c.reminderCreated=false;c.lastSentAt=null;
    const note=hours()?'':' We are outside business hours; staff will review when open.';
    draft(c,'initial',`We missed your call. Tell us your issue, name, address and callback or visit preference on WhatsApp: https://wa.me/${config.whatsappPhone.slice(1)}.${note} Reply STOP to opt out.`);
  }else if(event.actor==='customer' && event.type==='details'){
    if(c.calendar){log(phone,'Existing calendar request locked; ask staff to change it');return {state,actions};}
    const d=event.details||{};let reason='';
    const postal=String(d.postal||'').toUpperCase().replace(/\s/g,'');
    if(!String(d.name||'').trim()||!String(d.issue||'').trim())reason='name and issue required';
    else if(!['callback','visit'].includes(d.preference))reason='choose callback or visit';
    else if(!/^\d{1,5} [A-Za-z][A-Za-z0-9 ]{3,60}$/.test(d.address||''))reason='invalid address format';
    else if(!/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/.test(postal))reason='invalid postal code format';
    else if(!config.servicePostalPrefixes.includes(postal.slice(0,3)))reason='outside service area';
    c.revision++;invalidate(c);c.escalated=false;c.approval=null;
    if(reason){c.status='needs_details';draft(c,'clarification',reason+'. Please correct the details.');log(phone,'Request blocked: '+reason);}
    else{
      c.details={name:String(d.name).trim(),issue:String(d.issue).trim(),address:d.address,postal,preference:d.preference};
      c.status='awaiting_staff';c.requestedAt=now;
      log(phone,'REQUEST revision '+c.revision+': '+JSON.stringify(c.details)+'; no slot promised');
    }
  }else if(event.actor==='staff'&&event.type==='approve_message'){
    const m=c.messages.find(m=>m.id===event.messageId);
    if(!m||m.status!=='needs_staff_approval'||m.revision!==c.revision){log(phone,'Rejected stale/replayed message approval');return {state,actions};}
    if(!event.approved||event.approved!==true){m.status='rejected';log(phone,'Message rejected by staff');return {state,actions};}
    m.status='sent_simulated';m.approvedBy='staff';m.approvedAt=event.at;
    if(m.purpose==='initial')c.lastSentAt=now;
    actions.push({kind:m.purpose==='initial'?'sms':'whatsapp',phone,text:m.text,messageId:m.id,revision:c.revision,approved:true});
    log(phone,'SEND '+m.purpose+': '+m.text);
  }else if(event.actor==='staff'&&event.type==='approve_booking'){
    if(c.status!=='awaiting_staff'||event.revision!==c.revision||event.approved!==true){log(phone,'Rejected stale, absent or negative booking approval');return {state,actions};}
    const start=Date.parse(event.start),end=Date.parse(event.end);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<=now||end<=start){log(phone,'Rejected invalid appointment time');return {state,actions};}
    c.approval={revision:c.revision,actor:'staff',eventId:event.id};
    c.calendar={key:'booking-'+phone.slice(1)+'-r'+c.revision,revision:c.revision,start:event.start,end:event.end,status:'pending'};
    c.status='calendar_pending';
    actions.push({kind:'calendar',phone,revision:c.revision,approved:true,approvalId:event.id,bookingKey:c.calendar.key,start:event.start,end:event.end,details:c.details});
    log(phone,'CALENDAR REQUEST approved by staff for revision '+c.revision);
  }else if(event.actor==='adapter'&&event.type==='calendar_result'){
    if(c.status!=='calendar_pending'||event.bookingKey!==c.calendar?.key){log(phone,'Ignored stale calendar result');return {state,actions};}
    if(event.success===true&&typeof event.providerEventId==='string'&&event.providerEventId){
      c.calendar.status='confirmed';c.calendar.providerEventId=event.providerEventId;c.status='booked';
      draft(c,'confirmation',`Staff confirmed your ${c.details.preference} request for ${c.calendar.start}.`);
    }else{c.calendar.status='failed';c.status='calendar_failed';log(phone,'STAFF ACTION: calendar write failed; no customer confirmation');}
  }else if(event.actor==='customer'&&event.type==='message'){
    log(phone,'Message received. Collect structured details through the intake form; no free-text inference.');
  }else{log(phone,'Rejected event for this actor: '+event.type);}
  return {state,actions};
}

function approvalGuard(action,state,kind){
  const c=state.contacts?.[action.phone];
  if(!c||c.status==='opted_out'||action.approved!==true)throw new Error('staff approval missing');
  if(kind==='calendar'){
    if(action.kind!=='calendar'||c.status!=='calendar_pending'||c.approval?.actor!=='staff'||c.approval.revision!==action.revision||c.revision!==action.revision||c.approval.eventId!==action.approvalId||c.calendar?.key!==action.bookingKey)throw new Error('booking approval does not match current request');
  }else{
    const m=c.messages.find(m=>m.id===action.messageId);
    if(!m||m.approvedBy!=='staff'||m.status!=='sent_simulated'||m.revision!==c.revision||m.text!==action.text||action.revision!==c.revision)throw new Error('message approval does not match current draft');
  }
  return action;
}

if(typeof module!=='undefined')module.exports={bookingEngine,approvalGuard};
