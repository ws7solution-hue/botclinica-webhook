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
function parseTimeM(str){const[h,m]=str.split(':');return+h*60+ +m;}
function formatTimeM(m){return`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;}
function formatPhone(jid){return'+'+jid.replace('@s.whatsapp.net','').replace('@c.us','');}

function parseDateFromText(text){
  const t=text.toLowerCase();
  const today=new Date();
  if(t.includes('hoje'))return today.toISOString().slice(0,10);
  if(t.includes('amanhã')||t.includes('amanha')){const d=new Date(today);d.setDate(d.getDate()+1);return d.toISOString().slice(0,10);}
  const days=['domingo','segunda','terça','quarta','quinta','sexta','sábado','sabado'];
  for(let i=0;i<8;i++){
    const name=days[i];const idx=i>6?6:i;
    if(t.includes(name)){const d=new Date(today);const diff=(idx-d.getDay()+7)%7||7;d.setDate(d.getDate()+diff);return d.toISOString().slice(0,10);}
  }
  const m=text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
  if(m){const y=m[3]||today.getFullYear();return`${y}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;}
  return null;
}

function generateSlots(doc,date){
  if(!doc.schedStart||!doc.schedEnd||!doc.schedDays||!doc.schedDays.length)return[];
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

// ── FIREBASE ──
async function fbPatch(path,body){
  const url=`${BASE}/${path}?key=${FB_KEY}`;
  try{
    const res=await fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!res.ok){
      const err=await res.text();
      console.error(`❌ Firestore PATCH failed [${res.status}]: ${err.slice(0,300)}`);
      return null;
    }
    const data=await res.json();
    return data;
  }catch(e){console.error('❌ fbPatch error:',e.message);return null;}
}

async function fbGet(path){
  try{
    const res=await fetch(`${BASE}/${path}?key=${FB_KEY}`);
    return res.json();
  }catch(e){console.error('❌ fbGet error:',e.message);return{};}
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
        id:d.name.split('/').pop(),
        name:fi.name?.stringValue||'',spec:fi.spec?.stringValue||'',
        days:fi.days?.stringValue||'',times:fi.times?.stringValue||'',preco:fi.preco?.stringValue||'',
        active:fi.active?.booleanValue!==false,
        schedDays,schedStart:fi.schedStart?.stringValue||'',schedEnd:fi.schedEnd?.stringValue||'',
        schedDuration:parseInt(fi.schedDuration?.integerValue||fi.schedDuration?.doubleValue||30),
        schedLunchStart:fi.schedLunchStart?.stringValue||'',schedLunchEnd:fi.schedLunchEnd?.stringValue||'',
      };
    }).filter(d=>d.active&&d.name);
    clinicCache={clinic,doctors};
    lastFetch=now;
    console.log(`📋 Clínica: ${clinic.name} | Médicos: ${doctors.map(d=>d.name).join(', ')}`);
    return clinicCache;
  }catch(e){console.error('❌ getClinicData:',e.message);return clinicCache||{clinic:{name:'Clínica',botName:'Sofia'},doctors:[]};}
}

async function getBookedSlots(docId,date){
  try{
    const data=await fbGet(`clinicas/${CLINIC_UID}/agendamentos`);
    return(data.documents||[]).map(d=>{
      const f=d.fields||{};
      return{id:d.name.split('/').pop(),docId:f.docId?.stringValue||'',date:f.date?.stringValue||'',time:f.time?.stringValue||'',status:f.status?.stringValue||''};
    }).filter(a=>a.docId===docId&&a.date===date&&a.status!=='cancelled');
  }catch(e){return[];}
}

async function bookSlot(docId,docName,patientName,patientPhone,date,time){
  const aptId=`${date}_${docId}_${time.replace(':','')}`;
  console.log(`📅 Salvando agendamento: ${aptId}`);
  console.log(`   Paciente: ${patientName} | Tel: ${patientPhone} | ${date} ${time}`);
  const result=await fbPatch(`clinicas/${CLINIC_UID}/agendamentos/${aptId}`,{
    fields:{
      docId:{stringValue:docId},docName:{stringValue:docName},
      patientName:{stringValue:patientName},patientPhone:{stringValue:patientPhone||''},
      date:{stringValue:date},time:{stringValue:time},
      status:{stringValue:'confirmed'},createdAt:{stringValue:new Date().toISOString()}
    }
  });
  if(result){console.log(`✅ Agendamento salvo: ${aptId}`);}
  else{console.error(`❌ Falha ao salvar agendamento: ${aptId}`);}
  return result;
}

async function saveConversation(phone,name,lastMsg,status,msgs){
  try{
    const docId=phone.replace(/[^a-zA-Z0-9]/g,'_');
    const now=new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    await fbPatch(`clinicas/${CLINIC_UID}/conversas/${docId}`,{
      fields:{
        name:{stringValue:name},phone:{stringValue:phone},last:{stringValue:lastMsg},
        time:{stringValue:now},status:{stringValue:status},
        msgs:{arrayValue:{values:msgs.slice(-20).map(m=>({mapValue:{fields:{f:{stringValue:m.f},t:{stringValue:m.t},h:{stringValue:m.h||now}}}}))}},
        updatedAt:{stringValue:new Date().toISOString()}
      }
    });
  }catch(e){console.error('Save conv:',e.message);}
}

function buildPrompt(clinic,doctors){
  const docList=doctors.length>0
    ?doctors.map(d=>{
      let l=`- ${d.name}`;
      if(d.spec)l+=` (${d.spec})`;
      if(d.preco)l+=` — Consulta: ${d.preco}`;
      if(d.schedDays&&d.schedDays.length){
        const dn=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
        l+=` — Atende: ${d.schedDays.map(i=>dn[i]).join(', ')} das ${d.schedStart} às ${d.schedEnd}`;
      }else if(d.days)l+=` — ${d.days}`;
      return l;
    }).join('\n')
    :'Nenhum médico cadastrado ainda.';
  return`Você é ${clinic.botName}, assistente virtual da ${clinic.name}.
Objetivo: agendar consultas e encantar os pacientes.

CLÍNICA: ${clinic.name}${clinic.phone?'\nTELEFONE: '+clinic.phone:''}${clinic.hours?'\nHORÁRIOS: '+clinic.hours:''}

MÉDICOS:
${docList}

REGRAS:
1. Fale APENAS dos médicos listados — nunca invente outros
2. Para agendar: colete médico → data → horário → nome do paciente
3. Sempre termine com pergunta de ação
4. Para emergências: "Vou conectar com nossa equipe agora!"

Responda em português, máx 3 frases. Sem markdown. Emojis com moderação.`;
}

// ── SCHEDULING ──
async function handleScheduling(from,text,doctors){
  const state=schedulingStates[from]||null;
  const t=text.toLowerCase();
  const wantsSchedule=['agendar','marcar','consulta','horário','disponível','disponibilidade','quero agendar'].some(k=>t.includes(k));

  if(!state&&wantsSchedule){
    if(!doctors.length)return null;
    if(doctors.length===1){
      schedulingStates[from]={step:'choosing_date',docId:doctors[0].id,docName:doctors[0].name};
      return`Ótimo! Vou agendar com ${doctors[0].name} 😊 Qual data você prefere? (ex: segunda, amanhã, 25/06)`;
    }
    schedulingStates[from]={step:'choosing_doctor'};
    return`Ótimo! Temos:\n${doctors.map((d,i)=>`${i+1}. ${d.name} — ${d.spec}`).join('\n')}\n\nQual você prefere?`;
  }

  if(state?.step==='choosing_doctor'){
    const doc=doctors.find(d=>d.name.split(' ').some(p=>t.includes(p.toLowerCase())))||doctors.find((_,i)=>t.includes(String(i+1)));
    if(doc){
      schedulingStates[from]={step:'choosing_date',docId:doc.id,docName:doc.name};
      return`${doc.name}! 😊 Qual data você prefere? (ex: segunda, amanhã, 25/06)`;
    }
    return null;
  }

  if(state?.step==='choosing_date'){
    const date=parseDateFromText(text);
    if(date){
      const doc=doctors.find(d=>d.id===state.docId);
      if(!doc){delete schedulingStates[from];return null;}
      const allSlots=generateSlots(doc,date);
      if(allSlots.length>0){
        const booked=await getBookedSlots(state.docId,date);
        const bookedTimes=booked.map(b=>b.time);
        const free=allSlots.filter(s=>!bookedTimes.includes(s));
        if(free.length===0){return`Todos os horários de ${doc.name} nesta data estão ocupados. Que tal outra data? 😊`;}
        schedulingStates[from]={...state,step:'choosing_time',date};
        return`Horários disponíveis com ${doc.name}:\n${free.slice(0,6).join(' · ')}\n\nQual prefere?`;
      } else {
        // No schedule configured, ask for preferred time
        schedulingStates[from]={...state,step:'choosing_time_free',date};
        const[y,mo,d2]=date.split('-');
        return`Qual horário você prefere para ${d2}/${mo}? (ex: 9h, 14h30)`;
      }
    }
    return null;
  }

  if(state?.step==='choosing_time'||state?.step==='choosing_time_free'){
    const timeMatch=text.match(/(\d{1,2})[h:](\d{0,2})/);
    const numMatch=text.match(/\b(\d{1,2})\b/);
    let time=null;
    if(timeMatch){const h=String(timeMatch[1]).padStart(2,'0');const m=String(timeMatch[2]||'00').padStart(2,'0');time=`${h}:${m}`;}
    else if(numMatch){time=`${String(numMatch[1]).padStart(2,'0')}:00`;}
    if(time){
      schedulingStates[from]={...state,step:'getting_name',time};
      return`Ótimo! ${time} anotado 😊 Para confirmar, me diga seu nome completo.`;
    }
    return null;
  }

  if(state?.step==='getting_name'){
    const name=text.trim();
    if(name.length>2){
      const phone=formatPhone(from);
      const[y,mo,d2]=state.date.split('-');
      await bookSlot(state.docId,state.docName,name,phone,state.date,state.time);
      delete schedulingStates[from];
      return`✅ Agendado! ${name}, sua consulta com ${state.docName} está confirmada para ${d2}/${mo} às ${state.time}. Enviaremos um lembrete! 😊`;
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
    console.log(`📩 ${name}: ${text}`);
    const{clinic,doctors}=await getClinicData();
    const schedulingReply=await handleScheduling(from,text,doctors);
    if(!conversations[from])conversations[from]=[];
    conversations[from].push({role:'user',content:text});
    if(conversations[from].length>20)conversations[from]=conversations[from].slice(-20);
    let reply;
    if(schedulingReply){
      reply=schedulingReply;
      conversations[from].push({role:'assistant',content:reply});
    }else{
      const res=await fetch('https://api.anthropic.com/v1/messages',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},
        body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1000,system:buildPrompt(clinic,doctors),messages:conversations[from]}),
      });
      const data=await res.json();
      reply=data.content?.[0]?.text;
      if(!reply){console.log('❌ No Claude reply');return;}
      conversations[from].push({role:'assistant',content:reply});
    }
    console.log(`🤖 ${clinic.botName}: ${reply}`);
    const isHuman=reply.includes('equipe')||reply.includes('atendente')||reply.includes('transferir');
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
app.get('/',(req,res)=>res.json({status:'✅ BotClínica online!',uid:CLINIC_UID}));
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`🚀 Webhook porta ${PORT}`));
