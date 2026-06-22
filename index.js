const express = require('express');
const app = express();
app.use(express.json());

const EVOLUTION_URL = 'https://evolution-api-production-16f18.up.railway.app';
const EVOLUTION_KEY = 'botclinica2025';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const INSTANCE = 'botclinica';
const CLINIC_UID = 'fMi67Aq1QzfM9Xhnj7eH2vJBTe92';
const FB_PROJECT = 'botclinica-60b6f';
const FB_KEY = 'AIzaSyAwYQq-ddQT8fBFytQYF5bgY5geL3SM2Ew';
const BASE = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

// In-memory state (scheduling flow only — conversations persisted on Firebase)
const schedulingStates = {};
let clinicCache = null;
let lastFetch = 0;

// ── HELPERS ──────────────────────────────────────────────────────────────────
function parseTimeM(s){const[h,m]=s.split(':');return+h*60+ +m;}
function formatTimeM(m){return`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;}
function formatPhone(jid){return'+'+jid.replace('@s.whatsapp.net','').replace('@c.us','');}
function aptId(docId,date,time){return`${date}_${docId}_${time.replace(':','')}`;}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

function parseDateFromText(text){
  const t=text.toLowerCase();
  const today=new Date();
  if(t.includes('hoje'))return today.toISOString().slice(0,10);
  if(t.includes('amanhã')||t.includes('amanha')){const d=new Date(today);d.setDate(d.getDate()+1);return d.toISOString().slice(0,10);}
  const dayMap={domingo:0,segunda:1,'terça':2,terca:2,quarta:3,quinta:4,sexta:5,'sábado':6,sabado:6};
  for(const[name,idx]of Object.entries(dayMap)){
    if(t.includes(name)){const d=new Date(today);const diff=(idx-d.getDay()+7)%7||7;d.setDate(d.getDate()+diff);return d.toISOString().slice(0,10);}
  }
  const m=text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
  if(m){const y=m[3]||today.getFullYear();return`${y}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;}
  return null;
}

function generateSlots(doc,date){
  if(!doc.schedStart||!doc.schedEnd||!doc.schedDays?.length)return[];
  const dow=new Date(date+'T12:00:00').getDay();
  if(!doc.schedDays.includes(dow))return[];
  const dur=doc.schedDuration||30;
  const end=parseTimeM(doc.schedEnd);
  const ls=doc.schedLunchStart?parseTimeM(doc.schedLunchStart):null;
  const le=doc.schedLunchEnd?parseTimeM(doc.schedLunchEnd):null;
  let cur=parseTimeM(doc.schedStart);
  const slots=[];
  while(cur+dur<=end){
    if(ls&&le&&cur>=ls&&cur<le){cur=le;continue;}
    slots.push(formatTimeM(cur));cur+=dur;
  }
  return slots;
}

// ── INTENT ───────────────────────────────────────────────────────────────────
function detectIntent(text){
  const t=text.toLowerCase();
  if(['cancelar','desmarcar','não posso','nao posso','cancelamento','desmarca','cancela','não quero mais','desistir'].some(k=>t.includes(k)))return'cancel';
  if(['remarcar','remarca','reagendar','mudar data','mudar horário','adiar','outro dia','outra data'].some(k=>t.includes(k)))return'reschedule';
  if(['agendar','marcar consulta','quero consulta','preciso consulta','marcar horário','disponibilidade','quero marcar'].some(k=>t.includes(k)))return'schedule';
  if(['atendente','humano','pessoa','recepcionista','falar com alguém','falar com um'].some(k=>t.includes(k)))return'human';
  return'general';
}

// ── FIREBASE ─────────────────────────────────────────────────────────────────
async function fbGet(path,retries=2){
  for(let i=0;i<=retries;i++){
    try{
      const r=await fetch(`${BASE}/${path}?key=${FB_KEY}`);
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      return r.json();
    }catch(e){
      if(i===retries){console.error(`fbGet failed [${path}]:`,e.message);return{};}
      await sleep(1000*(i+1));
    }
  }
}

async function fbPatch(path,body){
  try{
    const r=await fetch(`${BASE}/${path}?key=${FB_KEY}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!r.ok){const e=await r.text();console.error(`PATCH [${r.status}]:`,e.slice(0,150));return null;}
    return r.json();
  }catch(e){console.error('fbPatch:',e.message);return null;}
}

// ── CLINIC DATA (30s cache) ───────────────────────────────────────────────────
async function getClinicData(){
  const now=Date.now();
  if(clinicCache&&now-lastFetch<30000)return clinicCache;
  try{
    const[cData,dData]=await Promise.all([
      fbGet(`clinicas/${CLINIC_UID}`),
      fbGet(`clinicas/${CLINIC_UID}/medicos`)
    ]);
    const f=cData.fields||{};
    const clinic={
      name:f.clinicName?.stringValue||'Clínica',
      phone:f.phone?.stringValue||'',
      hours:f.hours?.stringValue||'',
      botName:f.botName?.stringValue||'Sofia',
    };
    const doctors=(dData.documents||[]).map(d=>{
      const fi=d.fields||{};
      const schedDays=(fi.schedDays?.arrayValue?.values||[]).map(v=>parseInt(v.integerValue||v.doubleValue||0));
      return{
        id:d.name.split('/').pop(),
        name:fi.name?.stringValue||'',
        spec:fi.spec?.stringValue||'',
        bot:fi.bot?.stringValue||clinic.botName,
        tone:fi.tone?.stringValue||'cordial',
        days:fi.days?.stringValue||'',
        times:fi.times?.stringValue||'',
        preco:fi.preco?.stringValue||'',
        active:fi.active?.booleanValue!==false,
        schedDays,
        schedStart:fi.schedStart?.stringValue||'',
        schedEnd:fi.schedEnd?.stringValue||'',
        schedDuration:parseInt(fi.schedDuration?.integerValue||fi.schedDuration?.doubleValue||30),
        schedLunchStart:fi.schedLunchStart?.stringValue||'',
        schedLunchEnd:fi.schedLunchEnd?.stringValue||'',
      };
    }).filter(d=>d.active&&d.name);
    if(!doctors.length){console.warn('⚠️ Nenhum médico ativo encontrado!');}
    clinicCache={clinic,doctors};
    lastFetch=now;
    console.log(`📋 ${clinic.name} | ${doctors.length} médico(s): ${doctors.map(d=>`${d.name} (bot: ${d.bot})`).join(', ')}`);
    return clinicCache;
  }catch(e){
    console.error('getClinicData:',e.message);
    if(clinicCache)return clinicCache; // use stale cache on error
    return{clinic:{name:'Clínica',botName:'Sofia'},doctors:[]};
  }
}

// ── CONVERSATION HISTORY (persisted on Firebase) ──────────────────────────────
async function loadHistory(phone){
  try{
    const key=phone.replace(/[^a-zA-Z0-9]/g,'_');
    const data=await fbGet(`clinicas/${CLINIC_UID}/conv_history/${key}`);
    if(!data.fields)return[];
    return(data.fields.msgs?.arrayValue?.values||[]).map(v=>({
      role:v.mapValue?.fields?.role?.stringValue||'user',
      content:v.mapValue?.fields?.content?.stringValue||''
    })).filter(m=>m.content);
  }catch{return[];}
}

async function saveHistory(phone,history){
  try{
    const key=phone.replace(/[^a-zA-Z0-9]/g,'_');
    await fbPatch(`clinicas/${CLINIC_UID}/conv_history/${key}`,{
      fields:{
        msgs:{arrayValue:{values:history.slice(-20).map(m=>({
          mapValue:{fields:{role:{stringValue:m.role},content:{stringValue:m.content}}}
        }))}},
        updatedAt:{stringValue:new Date().toISOString()}
      }
    });
  }catch(e){console.error('saveHistory:',e.message);}
}

// ── PROMPTS ───────────────────────────────────────────────────────────────────
const TONE_DESC={
  cordial:'cordial, acolhedora e simpática — use linguagem calorosa e emojis com moderação',
  formal:'formal e profissional — use linguagem objetiva e respeitosa, sem emojis, trate por "senhor/senhora"',
  descontraido:'descontraída e próxima — use linguagem informal e emojis frequentes',
};

function buildDoctorPrompt(clinic,doc){
  const gender=doc.name.startsWith('Dra')?'a':'o';
  const tone=TONE_DESC[doc.tone]||TONE_DESC.cordial;
  const dn=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const days=doc.schedDays?.length?doc.schedDays.map(i=>dn[i]).join(', '):doc.days||'consulte a clínica';
  const hours=doc.schedStart&&doc.schedEnd?`${doc.schedStart} às ${doc.schedEnd}`:doc.times||'consulte a clínica';

  return`Você é ${doc.bot}, assistente virtual exclusiv${gender} d${gender} ${doc.name}.

IDENTIDADE: Você se chama ${doc.bot}. Nunca revele que é uma IA. Nunca diga que é Sofia ou qualquer outro nome.
TOM: Seja ${tone}.

MÉDICO: ${doc.name} — ${doc.spec||'Medicina'}
CLÍNICA: ${clinic.name}${clinic.phone?'\nTELEFONE: '+clinic.phone:''}${clinic.hours?'\nFUNCIONAMENTO: '+clinic.hours:''}
DIAS DE ATENDIMENTO: ${days}
HORÁRIOS: ${hours}

INSTRUÇÕES:
1. Apresente-se como ${doc.bot} na primeira mensagem
2. Responda sobre ${doc.name} e ${doc.spec||'esta especialidade'}
3. Para agendar: pergunte a data → mostre horários → confirme nome
4. NUNCA mencione outros médicos ou especialidades
5. Para dúvidas médicas complexas: encaminhe ao médico pessoalmente
6. Para emergências: oriente a ligar para o SAMU 192 ou ir a UPA

Responda em português. Máximo 3 frases curtas. ${doc.tone==='formal'?'Sem emojis.':doc.tone==='descontraido'?'Use emojis livremente.':'Emojis com moderação.'}`;
}

function buildClinicPrompt(clinic,doctors){
  const list=doctors.map((d,i)=>`${i+1}. ${d.name} — ${d.spec}`).join('\n');
  return`Você é ${clinic.botName}, recepcionista virtual da ${clinic.name}.

CLÍNICA: ${clinic.name}${clinic.phone?'\nTELEFONE: '+clinic.phone:''}${clinic.hours?'\nHORÁRIOS: '+clinic.hours:''}

MÉDICOS DISPONÍVEIS:
${list}

INSTRUÇÕES:
1. Apresente-se e pergunte com qual especialidade/médico o paciente quer falar
2. Após o paciente escolher, informe que está transferindo para o assistente daquele médico
3. Seja cordial e profissional
4. Para emergências: oriente SAMU 192

Responda em português. Máximo 3 frases. Emojis com moderação.`;
}

// ── BOOKING ───────────────────────────────────────────────────────────────────
async function isSlotTaken(docId,date,time){
  const data=await fbGet(`clinicas/${CLINIC_UID}/agendamentos/${aptId(docId,date,time)}`);
  return!!(data.fields&&data.fields.status?.stringValue!=='cancelled');
}

async function getBookedTimes(docId,date){
  try{
    const data=await fbGet(`clinicas/${CLINIC_UID}/agendamentos`);
    return(data.documents||[])
      .map(d=>({docId:d.fields?.docId?.stringValue,date:d.fields?.date?.stringValue,time:d.fields?.time?.stringValue,status:d.fields?.status?.stringValue}))
      .filter(a=>a.docId===docId&&a.date===date&&a.status!=='cancelled')
      .map(a=>a.time);
  }catch{return[];}
}

async function getPatientAppointments(phone){
  try{
    const today=new Date().toISOString().slice(0,10);
    const data=await fbGet(`clinicas/${CLINIC_UID}/agendamentos`);
    return(data.documents||[]).map(d=>{
      const f=d.fields||{};
      return{id:d.name.split('/').pop(),docId:f.docId?.stringValue||'',docName:f.docName?.stringValue||'',patientName:f.patientName?.stringValue||'',patientPhone:f.patientPhone?.stringValue||'',date:f.date?.stringValue||'',time:f.time?.stringValue||'',status:f.status?.stringValue||'confirmed'};
    }).filter(a=>(a.patientPhone===phone||a.patientPhone===phone.replace('+',''))&&a.date>=today&&a.status!=='cancelled')
    .sort((a,b)=>a.date===b.date?a.time.localeCompare(b.time):a.date.localeCompare(b.date));
  }catch{return[];}
}

async function cancelApt(id){
  return!!(await fbPatch(`clinicas/${CLINIC_UID}/agendamentos/${id}`,{fields:{status:{stringValue:'cancelled'},cancelledAt:{stringValue:new Date().toISOString()}}}));
}

async function registerPatient(patientName,patientPhone,docName,date,time){
  try{
    if(!patientPhone)return;
    const key=patientPhone.replace(/[^0-9]/g,'');
    const existing=await fbGet(`clinicas/${CLINIC_UID}/pacientes/${key}`);
    const f=existing.fields||{};
    const visits=(f.visits?.integerValue||0)+1;
    const lastVisit=f.lastVisit?.stringValue||'';
    await fbPatch(`clinicas/${CLINIC_UID}/pacientes/${key}`,{
      fields:{
        name:{stringValue:patientName},phone:{stringValue:patientPhone},
        visits:{integerValue:String(visits)},
        lastVisit:{stringValue:date},lastDoctor:{stringValue:docName},
        firstVisit:{stringValue:lastVisit||date},
        updatedAt:{stringValue:new Date().toISOString()}
      }
    });
    console.log(`👤 Paciente registrado: ${patientName} (${visits} visita${visits>1?'s':''})`);
  }catch(e){console.error('registerPatient:',e.message);}
}

async function bookSlot(docId,docName,patientName,patientPhone,date,time){
  if(await isSlotTaken(docId,date,time))return'taken';
  const id=aptId(docId,date,time);
  console.log(`📅 Agendando: ${patientName} | ${docName} | ${date} ${time}`);
  const r=await fbPatch(`clinicas/${CLINIC_UID}/agendamentos/${id}`,{
    fields:{docId:{stringValue:docId},docName:{stringValue:docName},patientName:{stringValue:patientName},patientPhone:{stringValue:patientPhone||''},date:{stringValue:date},time:{stringValue:time},status:{stringValue:'confirmed'},createdAt:{stringValue:new Date().toISOString()}}
  });
  if(r){
    console.log(`✅ Salvo: ${id}`);
    registerPatient(patientName,patientPhone,docName,date,time);
    return'ok';
  }
  return'error';
}

async function saveConversation(phone,name,lastMsg,status){
  try{
    const docId=phone.replace(/[^a-zA-Z0-9]/g,'_');
    const now=new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    await fbPatch(`clinicas/${CLINIC_UID}/conversas/${docId}`,{
      fields:{name:{stringValue:name},phone:{stringValue:phone},last:{stringValue:lastMsg},time:{stringValue:now},status:{stringValue:status},updatedAt:{stringValue:new Date().toISOString()}}
    });
  }catch(e){console.error('saveConv:',e.message);}
}

// ── SCHEDULING FLOW ───────────────────────────────────────────────────────────
async function handleFlow(from,text,doctors,phone){
  const state=schedulingStates[from]||null;
  const intent=detectIntent(text);
  const t=text.toLowerCase();
  const isSingle=doctors.length===1;

  // ── CANCEL ──
  if(intent==='cancel'&&(!state||state.step==='idle')){
    const apts=await getPatientAppointments(phone);
    if(!apts.length)return`Não encontrei consultas agendadas para o seu número. Posso ajudar com outra coisa? 😊`;
    if(apts.length===1){
      const a=apts[0];const[,mo,d2]=a.date.split('-');
      schedulingStates[from]={step:'confirm_cancel',aptId:a.id,apt:a};
      return`Encontrei: ${a.docName} em ${d2}/${mo} às ${a.time}. Confirma o cancelamento? (SIM ou NÃO)`;
    }
    schedulingStates[from]={step:'choosing_cancel',apts};
    return`Suas consultas:\n${apts.map((a,i)=>{const[,mo,d2]=a.date.split('-');return`${i+1}. ${a.docName} — ${d2}/${mo} às ${a.time}`;}).join('\n')}\n\nQual deseja cancelar?`;
  }
  if(state?.step==='choosing_cancel'){
    const num=parseInt(t.match(/\d/)?.[0]||'0');
    if(num>=1&&num<=state.apts.length){
      const a=state.apts[num-1];const[,mo,d2]=a.date.split('-');
      schedulingStates[from]={step:'confirm_cancel',aptId:a.id,apt:a};
      return`${a.docName} — ${d2}/${mo} às ${a.time}. Confirma? (SIM ou NÃO)`;
    }
    return null;
  }
  if(state?.step==='confirm_cancel'){
    if(['sim','s','confirmo','pode','cancelar'].some(k=>t===k||t.startsWith(k+' ')||t.endsWith(' '+k))){
      const ok=await cancelApt(state.aptId);
      delete schedulingStates[from];
      const[,mo,d2]=state.apt.date.split('-');
      return ok?`✅ Consulta cancelada! ${state.apt.docName} em ${d2}/${mo} às ${state.apt.time} foi removida. Posso ajudar com mais alguma coisa?`:`Tive dificuldade ao cancelar. Por favor ligue: ${clinicCache?.clinic?.phone||'para a clínica'}.`;
    }
    if(['não','nao','n'].some(k=>t===k||t.startsWith(k+' '))){delete schedulingStates[from];return`Entendido! Consulta mantida. 😊`;}
    return`Responda SIM para cancelar ou NÃO para manter.`;
  }

  // ── RESCHEDULE ──
  if(intent==='reschedule'&&(!state||state.step==='idle')){
    const apts=await getPatientAppointments(phone);
    if(!apts.length){
      if(isSingle){schedulingStates[from]={step:'choosing_date',docId:doctors[0].id,docName:doctors[0].name,selectedDoc:doctors[0]};}
      else{schedulingStates[from]={step:'choosing_doctor'};}
      return isSingle?`Vou agendar com ${doctors[0].name}! Qual data prefere?`:`Para qual médico gostaria de agendar?\n${doctors.map((d,i)=>`${i+1}. ${d.name} — ${d.spec}`).join('\n')}`;
    }
    if(apts.length===1){
      const a=apts[0];const[,mo,d2]=a.date.split('-');
      const doc=doctors.find(d=>d.id===a.docId);
      schedulingStates[from]={step:'reschedule_date',aptId:a.id,apt:a,docId:a.docId,docName:a.docName,selectedDoc:doc||null};
      return`Remarcando: ${a.docName} de ${d2}/${mo} às ${a.time}. Qual a nova data?`;
    }
    schedulingStates[from]={step:'choosing_reschedule',apts};
    return`Qual consulta remarcar?\n${apts.map((a,i)=>{const[,mo,d2]=a.date.split('-');return`${i+1}. ${a.docName} — ${d2}/${mo} às ${a.time}`;}).join('\n')}`;
  }
  if(state?.step==='choosing_reschedule'){
    const num=parseInt(t.match(/\d/)?.[0]||'0');
    if(num>=1&&num<=state.apts.length){
      const a=state.apts[num-1];const[,mo,d2]=a.date.split('-');
      const doc=doctors.find(d=>d.id===a.docId);
      schedulingStates[from]={step:'reschedule_date',aptId:a.id,apt:a,docId:a.docId,docName:a.docName,selectedDoc:doc||null};
      return`Remarcando: ${a.docName} de ${d2}/${mo} às ${a.time}. Qual a nova data?`;
    }
    return null;
  }
  if(state?.step==='reschedule_date'){
    const date=parseDateFromText(text);
    if(date){
      const doc=state.selectedDoc||doctors.find(d=>d.id===state.docId);
      const allSlots=doc?generateSlots(doc,date):[];
      if(allSlots.length>0){
        const booked=await getBookedTimes(state.docId,date);
        const free=allSlots.filter(s=>!booked.includes(s));
        if(!free.length)return`Todos os horários de ${state.docName} nesta data estão ocupados. Outra data?`;
        await cancelApt(state.aptId);
        schedulingStates[from]={step:'choosing_time',docId:state.docId,docName:state.docName,date,selectedDoc:doc};
        return`Horários disponíveis:\n${free.slice(0,6).join(' · ')}\n\nQual prefere?`;
      }
      await cancelApt(state.aptId);
      schedulingStates[from]={step:'choosing_time_free',docId:state.docId,docName:state.docName,date,selectedDoc:doc};
      const[,mo,d2]=date.split('-');
      return`Consulta cancelada. Qual horário prefere em ${d2}/${mo}?`;
    }
    return null;
  }

  // ── DOCTOR SELECTION (multi-clinic entry point) ──
  if(!state||state.step==='idle'){
    // Check if patient is mentioning a doctor or specialty
    const doc=doctors.find(d=>
      t.includes(d.name.split(' ').pop().toLowerCase())||
      t.includes(d.name.split(' ')[0].toLowerCase())||
      (d.spec&&t.includes(d.spec.toLowerCase().split(' ')[0]))
    );
    if(doc&&!isSingle){
      // Patient mentioned a doctor → switch to that doctor's bot
      schedulingStates[from]={step:'idle',selectedDoc:doc};
      const gender=doc.name.startsWith('Dra')?'a':'o';
      return`Olá! Sou ${doc.bot}, assistente d${gender} ${doc.name}. 😊 Como posso ajudar?`;
    }
  }

  // ── SCHEDULE ──
  if(intent==='schedule'&&(!state||state.step==='idle')){
    if(!doctors.length)return null;
    if(isSingle){
      schedulingStates[from]={step:'choosing_date',docId:doctors[0].id,docName:doctors[0].name,selectedDoc:doctors[0]};
      return`Ótimo! Vou agendar com ${doctors[0].name} 😊 Qual data prefere? (ex: segunda, amanhã, 25/06)`;
    }
    schedulingStates[from]={step:'choosing_doctor'};
    return`Com qual médico você gostaria de agendar?\n${doctors.map((d,i)=>`${i+1}. ${d.name} — ${d.spec}`).join('\n')}`;
  }
  if(state?.step==='choosing_doctor'){
    const doc=doctors.find(d=>
      d.name.split(' ').some(p=>t.includes(p.toLowerCase()))||
      (d.spec&&t.includes(d.spec.toLowerCase().split(' ')[0]))
    )||doctors.find((_,i)=>t.includes(String(i+1)));
    if(doc){
      const gender=doc.name.startsWith('Dra')?'a':'o';
      schedulingStates[from]={step:'choosing_date',docId:doc.id,docName:doc.name,selectedDoc:doc};
      // Introduce the doctor's bot
      return`Perfeito! Transferindo para ${doc.bot}, assistente d${gender} ${doc.name}...\n\nOlá! Sou ${doc.bot}! 😊 Qual data prefere para sua consulta com ${doc.name.split(' ')[0]}?`;
    }
    return null;
  }
  if(state?.step==='choosing_date'){
    const date=parseDateFromText(text);
    if(date){
      const doc=state.selectedDoc||doctors.find(d=>d.id===state.docId);
      if(!doc){delete schedulingStates[from];return null;}
      const allSlots=generateSlots(doc,date);
      if(allSlots.length>0){
        const booked=await getBookedTimes(state.docId,date);
        const free=allSlots.filter(s=>!booked.includes(s));
        if(!free.length)return`Todos os horários de ${doc.name.split(' ')[0]} nesta data estão ocupados. Outra data? 😊`;
        schedulingStates[from]={...state,step:'choosing_time',date};
        return`Horários disponíveis com ${doc.name.split(' ')[0]}:\n${free.slice(0,6).join(' · ')}\n\nQual prefere?`;
      }
      schedulingStates[from]={...state,step:'choosing_time_free',date};
      const[,mo,d2]=date.split('-');
      return`Qual horário prefere em ${d2}/${mo}? (ex: 9h, 14h30)`;
    }
    return null;
  }
  if(state?.step==='choosing_time'||state?.step==='choosing_time_free'){
    const tm=text.match(/(\d{1,2})[h:](\d{0,2})/);
    const nm=text.match(/\b(\d{1,2})\b/);
    let time=null;
    if(tm)time=`${String(tm[1]).padStart(2,'0')}:${String(tm[2]||'00').padStart(2,'0')}`;
    else if(nm)time=`${String(nm[1]).padStart(2,'0')}:00`;
    if(time){
      const doc=state.selectedDoc||doctors.find(d=>d.id===state.docId);
      // Lunch block
      if(doc?.schedLunchStart&&doc?.schedLunchEnd){
        const tMin=parseTimeM(time),ls=parseTimeM(doc.schedLunchStart),le=parseTimeM(doc.schedLunchEnd);
        if(tMin>=ls&&tMin<le)return`Este é o horário de almoço. Escolha antes das ${doc.schedLunchStart} ou após as ${doc.schedLunchEnd}. 😊`;
      }
      // Double booking check
      if(state.step==='choosing_time'){
        if(await isSlotTaken(state.docId,state.date,time)){
          const booked=await getBookedTimes(state.docId,state.date);
          const allSlots=doc?generateSlots(doc,state.date):[];
          const free=allSlots.filter(s=>!booked.includes(s));
          if(free.length)return`${time} acabou de ser reservado. Horários livres:\n${free.slice(0,5).join(' · ')}\n\nQual prefere?`;
          return`Todos os horários foram reservados. Gostaria de outro dia?`;
        }
      }
      // Show price before asking name
      const priceMsg=doc?.preco?`\n💰 Valor da consulta: ${doc.preco}.`:'';
      schedulingStates[from]={...state,step:'getting_name',time};
      return`✅ ${time} reservado!${priceMsg}\n\nQual é o seu nome completo para confirmar? 😊`;
    }
    return null;
  }
  if(state?.step==='getting_name'){
    const name=text.trim();
    if(name.length>2){
      if(await isSlotTaken(state.docId,state.date,state.time)){
        delete schedulingStates[from];
        return`Puxa, ${state.time} foi reservado agora! Gostaria de outro horário?`;
      }
      const result=await bookSlot(state.docId,state.docName,name,phone,state.date,state.time);
      const doc=state.selectedDoc;
      const botName=doc?.bot||clinicCache?.clinic?.botName||'Sofia';
      delete schedulingStates[from];
      const[,mo,d2]=state.date.split('-');
      // Keep selectedDoc in state after booking (for continued conversation)
      if(doc)schedulingStates[from]={step:'idle',selectedDoc:doc};
      if(result==='ok')return`✅ Agendado! ${name}, sua consulta com ${state.docName} está confirmada para ${d2}/${mo} às ${state.time}. Enviarei um lembrete! 😊`;
      if(result==='taken')return`Esse horário acabou de ser reservado. Gostaria de outro?`;
      return`Tive uma dificuldade técnica. Por favor ligue: ${clinicCache?.clinic?.phone||'para a clínica'} 🙏`;
    }
    return null;
  }
  return null;
}

// ── PROCESS MESSAGE ───────────────────────────────────────────────────────────
async function processMessage(body){
  try{
    if(body?.data?.key?.fromMe)return;
    if(body?.data?.key?.remoteJid?.includes('@g.us'))return;
    const text=body?.data?.message?.conversation||body?.data?.message?.extendedTextMessage?.text;
    const from=body?.data?.key?.remoteJid;
    if(!from||!text)return;

    const phone=formatPhone(from);
    const pushName=body?.data?.pushName||phone;
    const now=new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    console.log(`\n📩 ${pushName} (${phone}): ${text}`);

    // Load clinic data (30s cache, with retry)
    const{clinic,doctors}=await getClinicData();

    // Check if doctors loaded correctly
    if(!doctors.length){
      console.warn('⚠️ Zero médicos — retrying Firebase...');
      clinicCache=null; // force refresh
      await getClinicData();
    }

    // Try scheduling flow first
    const flowReply=await handleFlow(from,text,doctors,phone);

    // Load conversation history from Firebase
    let history=await loadHistory(phone);
    history.push({role:'user',content:text});
    if(history.length>20)history=history.slice(-20);

    let reply;
    if(flowReply){
      reply=flowReply;
      history.push({role:'assistant',content:reply});
    }else{
      // Determine which prompt to use based on selected doctor
      const state=schedulingStates[from];
      const selectedDoc=state?.selectedDoc||(doctors.length===1?doctors[0]:null);

      let systemPrompt;
      if(selectedDoc){
        systemPrompt=buildDoctorPrompt(clinic,selectedDoc);
        console.log(`🤖 Usando persona: ${selectedDoc.bot} (${selectedDoc.name})`);
      }else{
        systemPrompt=buildClinicPrompt(clinic,doctors);
        console.log(`🏥 Usando persona: ${clinic.botName} (recepcionista)`);
      }

      const res=await fetch('https://api.anthropic.com/v1/messages',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},
        body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:500,system:systemPrompt,messages:history}),
      });
      const data=await res.json();
      reply=data.content?.[0]?.text;
      if(!reply){console.log('❌ No Claude reply:',JSON.stringify(data));return;}
      history.push({role:'assistant',content:reply});
    }

    const botName=(schedulingStates[from]?.selectedDoc?.bot)||(doctors.length===1?doctors[0]?.bot:null)||clinic.botName;
    console.log(`🤖 ${botName}: ${reply}`);

    // Persist history to Firebase (async, don't await)
    saveHistory(phone,history);

    // Save conversation to Firebase dashboard
    const isHuman=detectIntent(text)==='human'||reply.includes('equipe')||reply.includes('transferir');
    saveConversation(phone,pushName,reply,isHuman?'human':'bot');

    // Send reply via Evolution API
    await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCE}`,{
      method:'POST',
      headers:{'Content-Type':'application/json',apikey:EVOLUTION_KEY},
      body:JSON.stringify({number:from,text:reply}),
    });
    console.log('✅ Enviado!');

  }catch(err){
    console.error('❌ processMessage error:',err.message);
  }
}

app.post('/webhook',(req,res)=>{res.status(200).send('OK');processMessage(req.body);});
app.post('/webhook/*',(req,res)=>{res.status(200).send('OK');processMessage(req.body);});
app.get('/',(req,res)=>res.json({status:'✅ BotClínica v4.0',features:['multi-bot-persona','persistent-history','anti-double-booking','lunch-block']}));

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`🚀 BotClínica v4.0 porta ${PORT}`));
