const express = require('express');
const app = express();
app.use(express.json());

const EVOLUTION_URL = 'https://evolution-api-production-16f18.up.railway.app';
const EVOLUTION_KEY = 'botclinica2025';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const INSTANCE = 'botclinica';
const CLINIC_UID = 'fMi67Aq1QzfM9Xhnj7eH2vJBTe92';
const FIREBASE_PROJECT = 'botclinica-60b6f';
const FB_KEY = 'AIzaSyAwYQq-ddQT8fBFytQYF5bgY5geL3SM2Ew';
const BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

const conversations = {};
const schedulingStates = {};
let clinicCache = null;
let lastFetch = 0;

// ── HELPERS ──
function parseTimeM(s){const[h,m]=s.split(':');return+h*60+ +m;}
function formatTimeM(m){return`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;}
function formatPhone(jid){return'+'+jid.replace('@s.whatsapp.net','').replace('@c.us','');}
function aptId(docId,date,time){return`${date}_${docId}_${time.replace(':','')}`;}

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

// ── INTENT DETECTION ──
function detectIntent(text){
  const t=text.toLowerCase();
  if(['cancelar','desmarcar','não posso','nao posso','não vou poder','nao vou poder','cancelamento','desmarca','cancela','não quero mais','nao quero mais','desistir'].some(k=>t.includes(k)))return'cancel';
  if(['remarcar','remarca','reagendar','mudar data','mudar horário','adiar','outro dia','outra data'].some(k=>t.includes(k)))return'reschedule';
  if(['agendar','marcar consulta','quero consulta','preciso consulta','marcar horário','disponibilidade','quero marcar'].some(k=>t.includes(k)))return'schedule';
  if(['confirmar','confirmo','confirmar consulta'].some(k=>t.includes(k)))return'confirm';
  if(['atendente','humano','pessoa','recepcionista','falar com alguém','falar com um'].some(k=>t.includes(k)))return'human';
  return'general';
}

// ── FIREBASE ──
async function fbGet(path){
  try{const r=await fetch(`${BASE}/${path}?key=${FB_KEY}`);return r.json();}
  catch(e){console.error('fbGet:',e.message);return{};}
}

async function fbPatch(path,body){
  try{
    const r=await fetch(`${BASE}/${path}?key=${FB_KEY}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!r.ok){const e=await r.text();console.error(`❌ PATCH [${r.status}]: ${e.slice(0,200)}`);return null;}
    return r.json();
  }catch(e){console.error('fbPatch:',e.message);return null;}
}

async function getClinicData(){
  const now=Date.now();
  if(clinicCache&&now-lastFetch<5*60*1000)return clinicCache;
  try{
    const cData=await fbGet(`clinicas/${CLINIC_UID}`);
    const f=cData.fields||{};
    const clinic={name:f.clinicName?.stringValue||'Clínica',phone:f.phone?.stringValue||'',hours:f.hours?.stringValue||'',botName:f.botName?.stringValue||'Sofia'};
    const dData=await fbGet(`clinicas/${CLINIC_UID}/medicos`);
    const doctors=(dData.documents||[]).map(d=>{
      const fi=d.fields||{};
      const schedDays=(fi.schedDays?.arrayValue?.values||[]).map(v=>parseInt(v.integerValue||v.doubleValue||0));
      return{
        id:d.name.split('/').pop(),name:fi.name?.stringValue||'',spec:fi.spec?.stringValue||'',
        days:fi.days?.stringValue||'',times:fi.times?.stringValue||'',preco:fi.preco?.stringValue||'',
        active:fi.active?.booleanValue!==false,schedDays,
        schedStart:fi.schedStart?.stringValue||'',schedEnd:fi.schedEnd?.stringValue||'',
        schedDuration:parseInt(fi.schedDuration?.integerValue||fi.schedDuration?.doubleValue||30),
        schedLunchStart:fi.schedLunchStart?.stringValue||'',schedLunchEnd:fi.schedLunchEnd?.stringValue||'',
      };
    }).filter(d=>d.active&&d.name);
    clinicCache={clinic,doctors};lastFetch=now;
    const profile=doctors.length===1?'single':'multi';
    console.log(`📋 ${clinic.name} | Perfil: ${profile} médico | Médicos: ${doctors.map(d=>d.name).join(', ')}`);
    return clinicCache;
  }catch(e){console.error('getClinicData:',e.message);return clinicCache||{clinic:{name:'Clínica',botName:'Sofia'},doctors:[]};}
}

// ── ANTI DOUBLE BOOKING ──
async function isSlotTaken(docId,date,time){
  // Check directly by document ID — fastest and most reliable
  const id=aptId(docId,date,time);
  const data=await fbGet(`clinicas/${CLINIC_UID}/agendamentos/${id}`);
  if(data.fields){
    const status=data.fields.status?.stringValue||'confirmed';
    if(status!=='cancelled'){
      console.log(`🔒 Slot OCUPADO: ${id}`);
      return true;
    }
  }
  return false;
}

async function getBookedTimes(docId,date){
  try{
    const data=await fbGet(`clinicas/${CLINIC_UID}/agendamentos`);
    return(data.documents||[])
      .map(d=>({docId:d.fields?.docId?.stringValue||'',date:d.fields?.date?.stringValue||'',time:d.fields?.time?.stringValue||'',status:d.fields?.status?.stringValue||'confirmed'}))
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
  }catch(e){return[];}
}

async function cancelApt(id){
  const r=await fbPatch(`clinicas/${CLINIC_UID}/agendamentos/${id}`,{fields:{status:{stringValue:'cancelled'},cancelledAt:{stringValue:new Date().toISOString()}}});
  if(r)console.log(`✅ Cancelado: ${id}`);
  return!!r;
}

async function bookSlot(docId,docName,patientName,patientPhone,date,time){
  // FINAL CHECK before saving — prevents race condition
  const taken=await isSlotTaken(docId,date,time);
  if(taken)return'taken';
  const id=aptId(docId,date,time);
  console.log(`📅 Salvando: ${patientName} | ${docName} | ${date} ${time}`);
  const r=await fbPatch(`clinicas/${CLINIC_UID}/agendamentos/${id}`,{
    fields:{docId:{stringValue:docId},docName:{stringValue:docName},patientName:{stringValue:patientName},patientPhone:{stringValue:patientPhone||''},date:{stringValue:date},time:{stringValue:time},status:{stringValue:'confirmed'},createdAt:{stringValue:new Date().toISOString()}}
  });
  if(r){console.log(`✅ Agendamento salvo: ${id}`);return'ok';}
  console.error(`❌ Falha ao salvar: ${id}`);return'error';
}

async function saveConversation(phone,name,lastMsg,status,msgs){
  try{
    const docId=phone.replace(/[^a-zA-Z0-9]/g,'_');
    const now=new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    await fbPatch(`clinicas/${CLINIC_UID}/conversas/${docId}`,{
      fields:{name:{stringValue:name},phone:{stringValue:phone},last:{stringValue:lastMsg},time:{stringValue:now},status:{stringValue:status},
        msgs:{arrayValue:{values:msgs.slice(-20).map(m=>({mapValue:{fields:{f:{stringValue:m.f},t:{stringValue:m.t},h:{stringValue:m.h||now}}}}))}},
        updatedAt:{stringValue:new Date().toISOString()}}
    });
  }catch(e){console.error('saveConv:',e.message);}
}

// ── PROMPT — adapts to single vs multi doctor ──
function buildPrompt(clinic,doctors){
  const isSingle=doctors.length===1;
  const doc=isSingle?doctors[0]:null;
  const docList=doctors.length>0
    ?doctors.map(d=>{
      let l=`- ${d.name}`;
      if(d.spec)l+=` (${d.spec})`;
      // Price shown at confirmation step only, not here
      if(d.schedDays?.length){const dn=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];l+=` — Atende: ${d.schedDays.map(i=>dn[i]).join(', ')} das ${d.schedStart} às ${d.schedEnd}`;}
      else if(d.days)l+=` — ${d.days}`;
      return l;
    }).join('\n'):'Nenhum médico cadastrado.';

  const intro=isSingle
    ?`Você é ${clinic.botName}, assistente virtual ${doc.name.startsWith('Dra')?'da':'do'} ${doc.name} (${doc.spec||clinic.name}).`
    :`Você é ${clinic.botName}, assistente virtual da ${clinic.name}.`;

  return`${intro}
Objetivo: agendar consultas, cancelar, remarcar e informar os pacientes.

CLÍNICA: ${clinic.name}${clinic.phone?'\nTELEFONE: '+clinic.phone:''}${clinic.hours?'\nHORÁRIOS: '+clinic.hours:''}

${isSingle?`MÉDICO:\n${docList}`:('MÉDICOS:\n'+docList)}

REGRAS ABSOLUTAS:
1. Fale APENAS dos médicos listados — NUNCA invente outros
2. CANCELAR → pergunte qual consulta cancelar, NÃO agende nada novo
3. REMARCAR → cancele a atual e agende uma nova
4. Para agendar → colete: ${isSingle?'data e horário':'médico, data e horário'} e nome do paciente
5. Sempre termine com uma pergunta de ação
6. Para dúvidas complexas → "Vou conectar você com nossa equipe!"

Resposta em português, máx 3 frases. Sem markdown. Emojis com moderação.`;
}

// ── SCHEDULING FLOW ──
async function handleFlow(from,text,doctors,phone){
  const state=schedulingStates[from]||null;
  const intent=detectIntent(text);
  const t=text.toLowerCase();
  const isSingle=doctors.length===1;

  console.log(`🎯 Intent: ${intent} | State: ${state?.step||'none'} | Perfil: ${isSingle?'single':'multi'}`);

  // ── CANCEL ──
  if(intent==='cancel'&&(!state||state.step==='idle')){
    const apts=await getPatientAppointments(phone);
    if(!apts.length){delete schedulingStates[from];return`Não encontrei consultas agendadas para o seu número. Posso ajudar com outra coisa? 😊`;}
    if(apts.length===1){
      const a=apts[0];const[,mo,d2]=a.date.split('-');
      schedulingStates[from]={step:'confirm_cancel',aptId:a.id,apt:a};
      return`Encontrei sua consulta: ${a.docName} em ${d2}/${mo} às ${a.time}. Confirma o cancelamento? (responda SIM)`;
    }
    schedulingStates[from]={step:'choosing_cancel',apts};
    return`Encontrei ${apts.length} consultas:\n${apts.map((a,i)=>{const[,mo,d2]=a.date.split('-');return`${i+1}. ${a.docName} — ${d2}/${mo} às ${a.time}`;}).join('\n')}\n\nQual deseja cancelar?`;
  }
  if(state?.step==='choosing_cancel'){
    const num=parseInt(t.match(/\d/)?.[0]||'0');
    if(num>=1&&num<=state.apts.length){
      const a=state.apts[num-1];const[,mo,d2]=a.date.split('-');
      schedulingStates[from]={step:'confirm_cancel',aptId:a.id,apt:a};
      return`Consulta: ${a.docName} — ${d2}/${mo} às ${a.time}. Confirma cancelamento? (SIM/NÃO)`;
    }
    return null;
  }
  if(state?.step==='confirm_cancel'){
    if(['sim','s','confirmo','pode'].some(k=>t.includes(k))){
      const ok=await cancelApt(state.aptId);
      delete schedulingStates[from];
      const[,mo,d2]=state.apt.date.split('-');
      return ok?`✅ Consulta cancelada! ${state.apt.docName} em ${d2}/${mo} às ${state.apt.time} foi removida. Posso ajudar com mais alguma coisa?`:`Tive dificuldade ao cancelar. Por favor ligue para a clínica.`;
    }
    if(['não','nao','n'].some(k=>t===k||t.startsWith(k+' '))){delete schedulingStates[from];return`Entendido! Sua consulta está mantida. 😊`;}
    return`Responda SIM para cancelar ou NÃO para manter.`;
  }

  // ── RESCHEDULE ──
  if(intent==='reschedule'&&(!state||state.step==='idle')){
    const apts=await getPatientAppointments(phone);
    if(!apts.length){
      schedulingStates[from]={step:isSingle?'choosing_date':'choosing_doctor',docId:isSingle?doctors[0].id:null,docName:isSingle?doctors[0].name:null};
      return isSingle?`Vou agendar uma consulta com ${doctors[0].name}! Qual data prefere?`:`Para qual médico gostaria de agendar?\n${doctors.map((d,i)=>`${i+1}. ${d.name}`).join('\n')}`;
    }
    if(apts.length===1){
      const a=apts[0];const[,mo,d2]=a.date.split('-');
      schedulingStates[from]={step:'reschedule_date',aptId:a.id,apt:a,docId:a.docId,docName:a.docName};
      return`Remarcando: ${a.docName} de ${d2}/${mo} às ${a.time}. Qual a nova data?`;
    }
    schedulingStates[from]={step:'choosing_reschedule',apts};
    return`Qual consulta remarcar?\n${apts.map((a,i)=>{const[,mo,d2]=a.date.split('-');return`${i+1}. ${a.docName} — ${d2}/${mo} às ${a.time}`;}).join('\n')}`;
  }
  if(state?.step==='choosing_reschedule'){
    const num=parseInt(t.match(/\d/)?.[0]||'0');
    if(num>=1&&num<=state.apts.length){
      const a=state.apts[num-1];const[,mo,d2]=a.date.split('-');
      schedulingStates[from]={step:'reschedule_date',aptId:a.id,apt:a,docId:a.docId,docName:a.docName};
      return`Remarcando: ${a.docName} de ${d2}/${mo} às ${a.time}. Qual a nova data?`;
    }
    return null;
  }
  if(state?.step==='reschedule_date'){
    const date=parseDateFromText(text);
    if(date){
      const doc=doctors.find(d=>d.id===state.docId);
      const allSlots=doc?generateSlots(doc,date):[];
      if(allSlots.length>0){
        const booked=await getBookedTimes(state.docId,date);
        const free=allSlots.filter(s=>!booked.includes(s));
        if(!free.length)return`Todos os horários de ${state.docName} nesta data estão ocupados. Outra data?`;
        await cancelApt(state.aptId);
        schedulingStates[from]={step:'choosing_time',docId:state.docId,docName:state.docName,date};
        return`Horários disponíveis:\n${free.slice(0,6).join(' · ')}\n\nQual prefere?`;
      }
      await cancelApt(state.aptId);
      schedulingStates[from]={step:'choosing_time_free',docId:state.docId,docName:state.docName,date};
      const[,mo,d2]=date.split('-');
      return`Consulta anterior cancelada. Qual horário prefere em ${d2}/${mo}?`;
    }
    return null;
  }

  // ── SCHEDULE ──
  if(intent==='schedule'&&(!state||state.step==='idle')){
    if(!doctors.length)return null;
    if(isSingle){
      schedulingStates[from]={step:'choosing_date',docId:doctors[0].id,docName:doctors[0].name};
      return`Ótimo! Vou agendar com ${doctors[0].name} 😊 Qual data você prefere? (ex: segunda, amanhã, 25/06)`;
    }
    schedulingStates[from]={step:'choosing_doctor'};
    return`Temos:\n${doctors.map((d,i)=>`${i+1}. ${d.name} — ${d.spec}`).join('\n')}\n\nQual médico prefere?`;
  }
  if(state?.step==='choosing_doctor'){
    const doc=doctors.find(d=>d.name.split(' ').some(p=>t.includes(p.toLowerCase())))||doctors.find((_,i)=>t.includes(String(i+1)));
    if(doc){schedulingStates[from]={step:'choosing_date',docId:doc.id,docName:doc.name};return`${doc.name}! 😊 Qual data prefere?`;}
    return null;
  }
  if(state?.step==='choosing_date'){
    const date=parseDateFromText(text);
    if(date){
      const doc=doctors.find(d=>d.id===state.docId);
      if(!doc){delete schedulingStates[from];return null;}
      const allSlots=generateSlots(doc,date);
      if(allSlots.length>0){
        const booked=await getBookedTimes(state.docId,date);
        const free=allSlots.filter(s=>!booked.includes(s));
        if(!free.length)return`Todos os horários de ${doc.name} nesta data estão ocupados. Outra data? 😊`;
        schedulingStates[from]={...state,step:'choosing_time',date};
        return`Horários disponíveis com ${doc.name}:\n${free.slice(0,6).join(' · ')}\n\nQual prefere?`;
      }
      schedulingStates[from]={...state,step:'choosing_time_free',date};
      const[,mo,d2]=date.split('-');
      return`Qual horário prefere em ${d2}/${mo}?`;
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
      const doc=doctors.find(d=>d.id===state.docId);
      // LUNCH BREAK VALIDATION — never allow lunch hours
      if(doc&&doc.schedLunchStart&&doc.schedLunchEnd){
        const tMin=parseTimeM(time);
        const lsMin=parseTimeM(doc.schedLunchStart);
        const leMin=parseTimeM(doc.schedLunchEnd);
        if(tMin>=lsMin&&tMin<leMin){
          return`Este é o horário de almoço de ${doc.name}. Por favor escolha um horário antes das ${doc.schedLunchStart} ou após as ${doc.schedLunchEnd}. 😊`;
        }
      }
      // Validate slot still free (race condition protection)
      if(state.step==='choosing_time'){
        const taken=await isSlotTaken(state.docId,state.date,time);
        if(taken){
          const booked=await getBookedTimes(state.docId,state.date);
          const allSlots=doc?generateSlots(doc,state.date):[];
          const free=allSlots.filter(s=>!booked.includes(s));
          if(free.length)return`Infelizmente ${time} acabou de ser reservado. Horários ainda disponíveis:\n${free.slice(0,5).join(' · ')}\n\nQual prefere?`;
          return`Todos os horários acabaram de ser reservados. Gostaria de escolher outro dia?`;
        }
      }
      // Show price at penultimate step (just before asking the name)
      const priceMsg=doc&&doc.preco?`\n💰 Valor da consulta: ${doc.preco}.`:'';
      schedulingStates[from]={...state,step:'getting_name',time};
      return`✅ ${time} reservado!${priceMsg}\n\nQual é o seu nome completo para confirmar? 😊`;
    }
    return null;
  }

  if(state?.step==='getting_name'){
    const name=text.trim();
    if(name.length>2){
      // FINAL CHECK — anti double booking antes de salvar
      const taken=await isSlotTaken(state.docId,state.date,state.time);
      if(taken){
        delete schedulingStates[from];
        return`Puxa, ${state.time} acabou de ser reservado por outra pessoa! Gostaria de escolher outro horário?`;
      }
      const result=await bookSlot(state.docId,state.docName,name,phone,state.date,state.time);
      delete schedulingStates[from];
      const[,mo,d2]=state.date.split('-');
      if(result==='ok')return`✅ Agendado! ${name}, sua consulta com ${state.docName} está confirmada para ${d2}/${mo} às ${state.time}. Enviaremos um lembrete! 😊`;
      if(result==='taken')return`Esse horário acabou de ser reservado. Gostaria de escolher outro?`;
      return`Tive uma dificuldade técnica. Por favor ligue para a clínica: ${clinicCache?.clinic?.phone||'nosso telefone'} 🙏`;
    }
    return null;
  }
  return null;
}

// ── PROCESS MESSAGE ──
async function processMessage(body){
  try{
    if(body?.data?.key?.fromMe)return;
    if(body?.data?.key?.remoteJid?.includes('@g.us'))return;
    const text=body?.data?.message?.conversation||body?.data?.message?.extendedTextMessage?.text;
    const from=body?.data?.key?.remoteJid;
    if(!from||!text)return;
    const phone=formatPhone(from);
    const name=body?.data?.pushName||phone;
    const now=new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    console.log(`\n📩 ${name} (${phone}): ${text}`);
    const{clinic,doctors}=await getClinicData();
    const flowReply=await handleFlow(from,text,doctors,phone);
    if(!conversations[from])conversations[from]=[];
    conversations[from].push({role:'user',content:text});
    if(conversations[from].length>20)conversations[from]=conversations[from].slice(-20);
    let reply;
    if(flowReply){
      reply=flowReply;
      conversations[from].push({role:'assistant',content:reply});
    }else{
      const res=await fetch('https://api.anthropic.com/v1/messages',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},
        body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:500,system:buildPrompt(clinic,doctors),messages:conversations[from]}),
      });
      const data=await res.json();
      reply=data.content?.[0]?.text;
      if(!reply){console.log('❌ No Claude reply');return;}
      conversations[from].push({role:'assistant',content:reply});
    }
    console.log(`🤖 ${clinic.botName}: ${reply}`);
    const isHuman=detectIntent(text)==='human'||reply.includes('equipe')||reply.includes('transferir');
    const msgs=conversations[from].map(m=>({f:m.role==='user'?'p':'b',t:m.content,h:now}));
    await saveConversation(phone,name,reply,isHuman?'human':'bot',msgs);
    await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCE}`,{
      method:'POST',headers:{'Content-Type':'application/json',apikey:EVOLUTION_KEY},
      body:JSON.stringify({number:from,text:reply}),
    });
    console.log('✅ Sent!');
  }catch(err){console.error('❌ Error:',err.message);}
}

app.post('/webhook',(req,res)=>{res.status(200).send('OK');processMessage(req.body);});
app.post('/webhook/*',(req,res)=>{res.status(200).send('OK');processMessage(req.body);});
app.get('/',(req,res)=>res.json({status:'✅ BotClínica v3.0',uid:CLINIC_UID}));
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`🚀 BotClínica v3.0 porta ${PORT}`));
