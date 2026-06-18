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

// Caches
const conversations = {};
const schedulingStates = {}; // phone -> {step, docId, docName, date}
let clinicCache = null;
let lastFetch = 0;

// ── HELPERS ──────────────────────────────────────────
function parseTimeM(str) { const [h, m] = str.split(':'); return +h * 60 + +m; }
function formatTimeM(mins) { return `${String(Math.floor(mins/60)).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`; }
function formatPhone(jid) { return '+' + jid.replace('@s.whatsapp.net','').replace('@c.us',''); }
function todayStr() { return new Date().toISOString().slice(0,10); }
function tomorrowStr() { const d=new Date();d.setDate(d.getDate()+1);return d.toISOString().slice(0,10); }

function parseDateFromText(text) {
  const t = text.toLowerCase();
  const today = new Date();
  if (t.includes('hoje')) return todayStr();
  if (t.includes('amanhã') || t.includes('amanha')) return tomorrowStr();
  const days = ['domingo','segunda','terça','quarta','quinta','sexta','sábado','sabado'];
  for (let i = 0; i < days.length; i++) {
    if (t.includes(days[i])) {
      const d = new Date();
      const diff = (i - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + diff);
      return d.toISOString().slice(0,10);
    }
  }
  // DD/MM or DD/MM/YYYY
  const match = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
  if (match) {
    const year = match[3] || new Date().getFullYear();
    return `${year}-${String(match[2]).padStart(2,'0')}-${String(match[1]).padStart(2,'0')}`;
  }
  return null;
}

function generateSlots(doc, date) {
  if (!doc.schedStart || !doc.schedEnd || !doc.schedDays || !doc.schedDays.length) return [];
  const dow = new Date(date + 'T12:00:00').getDay();
  if (!doc.schedDays.includes(dow)) return [];
  const dur = doc.schedDuration || 30;
  const end = parseTimeM(doc.schedEnd);
  const ls = doc.schedLunchStart ? parseTimeM(doc.schedLunchStart) : null;
  const le = doc.schedLunchEnd ? parseTimeM(doc.schedLunchEnd) : null;
  let cur = parseTimeM(doc.schedStart);
  const slots = [];
  while (cur + dur <= end) {
    if (ls && le && cur >= ls && cur < le) { cur = le; continue; }
    slots.push(formatTimeM(cur));
    cur += dur;
  }
  return slots;
}

// ── FIREBASE ─────────────────────────────────────────
async function fbGet(path) {
  const r = await fetch(`${BASE}/${path}?key=${FB_KEY}`);
  return r.json();
}
async function fbPatch(path, body) {
  await fetch(`${BASE}/${path}?key=${FB_KEY}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
}

async function getClinicData() {
  const now = Date.now();
  if (clinicCache && now - lastFetch < 5*60*1000) return clinicCache;
  try {
    const cData = await fbGet(`clinicas/${CLINIC_UID}`);
    const f = cData.fields || {};
    const clinic = {
      name: f.clinicName?.stringValue || 'Clínica',
      phone: f.phone?.stringValue || '',
      hours: f.hours?.stringValue || '',
      botName: f.botName?.stringValue || 'Sofia',
    };
    const dData = await fbGet(`clinicas/${CLINIC_UID}/medicos`);
    const doctors = (dData.documents || []).map(d => {
      const fi = d.fields || {};
      const schedDays = fi.schedDays?.arrayValue?.values?.map(v => parseInt(v.integerValue || v.doubleValue || 0)) || [];
      return {
        id: d.name.split('/').pop(),
        name: fi.name?.stringValue || '',
        spec: fi.spec?.stringValue || '',
        days: fi.days?.stringValue || '',
        times: fi.times?.stringValue || '',
        preco: fi.preco?.stringValue || '',
        active: fi.active?.booleanValue !== false,
        schedDays, schedStart: fi.schedStart?.stringValue || '',
        schedEnd: fi.schedEnd?.stringValue || '',
        schedDuration: parseInt(fi.schedDuration?.integerValue || fi.schedDuration?.doubleValue || 30),
        schedLunchStart: fi.schedLunchStart?.stringValue || '',
        schedLunchEnd: fi.schedLunchEnd?.stringValue || '',
      };
    }).filter(d => d.active && d.name);
    clinicCache = { clinic, doctors };
    lastFetch = now;
    console.log(`📋 ${clinic.name} | Médicos: ${doctors.map(d=>d.name).join(', ')}`);
    return clinicCache;
  } catch (e) {
    console.error('Firebase fetch error:', e.message);
    return clinicCache || { clinic:{name:'Clínica',botName:'Sofia'}, doctors:[] };
  }
}

async function getBookedSlots(docId, date) {
  try {
    const data = await fbGet(`clinicas/${CLINIC_UID}/agendamentos`);
    return (data.documents || [])
      .map(d => ({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields||{}).map(([k,v])=>[k,v.stringValue||v.booleanValue||''])) }))
      .filter(a => a.docId === docId && a.date === date && a.status !== 'cancelled');
  } catch { return []; }
}

async function bookSlot(docId, docName, patientName, patientPhone, date, time) {
  const aptId = `${date}_${docId}_${time.replace(':','')}`;
  await fbPatch(`clinicas/${CLINIC_UID}/agendamentos/${aptId}`, {
    fields: {
      docId:{stringValue:docId}, docName:{stringValue:docName},
      patientName:{stringValue:patientName}, patientPhone:{stringValue:patientPhone||''},
      date:{stringValue:date}, time:{stringValue:time},
      status:{stringValue:'confirmed'}, createdAt:{stringValue:new Date().toISOString()}
    }
  });
}

async function saveConversation(phone, name, lastMsg, status, msgs) {
  try {
    const docId = phone.replace(/[^a-zA-Z0-9]/g, '_');
    const now = new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    await fbPatch(`clinicas/${CLINIC_UID}/conversas/${docId}`, {
      fields: {
        name:{stringValue:name}, phone:{stringValue:phone},
        last:{stringValue:lastMsg}, lastMsg:{stringValue:lastMsg},
        time:{stringValue:now}, status:{stringValue:status},
        msgs:{arrayValue:{values:msgs.slice(-20).map(m=>({mapValue:{fields:{f:{stringValue:m.f},t:{stringValue:m.t},h:{stringValue:m.h||now}}}}))}},
        updatedAt:{stringValue:new Date().toISOString()}
      }
    });
  } catch (e) { console.error('Save conv error:', e.message); }
}

// ── PROMPT BUILDER ────────────────────────────────────
function buildPrompt(clinic, doctors) {
  const docList = doctors.length > 0
    ? doctors.map(d => {
        let line = `- ${d.name}`;
        if (d.spec) line += ` (${d.spec})`;
        if (d.preco) line += ` — Consulta: ${d.preco}`;
        if (d.schedDays && d.schedDays.length) {
          const dayNames = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
          line += ` — Atende: ${d.schedDays.map(i=>dayNames[i]).join(', ')} das ${d.schedStart} às ${d.schedEnd}`;
        } else if (d.days) {
          line += ` — ${d.days}`;
        }
        return line;
      }).join('\n')
    : '- Nenhum médico cadastrado ainda.';

  return `Você é ${clinic.botName}, assistente virtual da ${clinic.name}.
Seu objetivo é agendar consultas e encantar os pacientes.

CLÍNICA: ${clinic.name}
${clinic.phone ? 'TELEFONE: ' + clinic.phone : ''}
${clinic.hours ? 'HORÁRIOS: ' + clinic.hours : ''}

MÉDICOS DISPONÍVEIS:
${docList}

REGRAS IMPORTANTES:
1. Fale APENAS dos médicos listados acima — nunca invente outros
2. Para agendar: pergunte qual médico, depois a data preferida
3. Sempre termine com uma pergunta de ação
4. Ao informar valor, contextualize: "...um investimento na sua saúde ❤️"
5. Para emergências diga: "Vou conectar você com nossa equipe agora!"

Responda em português, máximo 3 frases. Sem markdown. Emojis com moderação.`;
}

// ── SCHEDULING FLOW ───────────────────────────────────
async function handleScheduling(from, text, doctors, clinic) {
  const state = schedulingStates[from] || null;
  const t = text.toLowerCase();

  // Wants to schedule?
  const wantsSchedule = ['agendar','marcar','consulta','horário','disponível'].some(k => t.includes(k));

  if (!state && wantsSchedule) {
    if (doctors.length === 0) return null;
    if (doctors.length === 1) {
      schedulingStates[from] = { step: 'choosing_date', docId: doctors[0].id, docName: doctors[0].name };
      return `Ótimo! Vou agendar com ${doctors[0].name} 😊 Qual data você prefere? (ex: segunda, 20/06, amanhã)`;
    }
    schedulingStates[from] = { step: 'choosing_doctor' };
    const list = doctors.map((d,i) => `${i+1}. ${d.name} — ${d.spec}`).join('\n');
    return `Ótimo! Temos os seguintes médicos disponíveis:\n${list}\n\nQual você prefere?`;
  }

  if (state && state.step === 'choosing_doctor') {
    const doc = doctors.find(d => t.includes(d.name.split(' ')[0].toLowerCase()) || t.includes(d.name.split(' ').pop().toLowerCase())) 
      || doctors.find((_,i) => t.includes(String(i+1)));
    if (doc) {
      schedulingStates[from] = { step: 'choosing_date', docId: doc.id, docName: doc.name };
      return `${doc.name} disponível! 😊 Qual data você prefere? (ex: segunda, 20/06, amanhã)`;
    }
    return null;
  }

  if (state && state.step === 'choosing_date') {
    const date = parseDateFromText(text);
    if (date) {
      const doc = doctors.find(d => d.id === state.docId);
      if (!doc) { delete schedulingStates[from]; return null; }
      const allSlots = generateSlots(doc, date);
      if (allSlots.length === 0) {
        const dayNames = ['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
        const dow = new Date(date+'T12:00:00').getDay();
        if (!doc.schedDays || !doc.schedDays.includes(dow)) {
          return `${doc.name} não atende ${dayNames[dow]}. Que tal escolher outro dia? 😊`;
        }
        return `Não há horários configurados para esta data. Tente outro dia!`;
      }
      const booked = await getBookedSlots(state.docId, date);
      const bookedTimes = booked.map(b => b.time);
      const freeSlots = allSlots.filter(s => !bookedTimes.includes(s));
      if (freeSlots.length === 0) {
        return `Todos os horários de ${doc.name} nesta data estão ocupados. Que tal outra data? 😊`;
      }
      schedulingStates[from] = { ...state, step: 'choosing_time', date };
      const slotList = freeSlots.slice(0, 6).join(' · ');
      return `${doc.name} tem estes horários disponíveis:\n${slotList}\n\nQual prefere?`;
    }
    return null;
  }

  if (state && state.step === 'choosing_time') {
    const doc = doctors.find(d => d.id === state.docId);
    const allSlots = doc ? generateSlots(doc, state.date) : [];
    const timeMatch = text.match(/(\d{1,2})[h:](\d{0,2})/);
    if (timeMatch) {
      const h = String(timeMatch[1]).padStart(2,'0');
      const m = String(timeMatch[2]||'00').padStart(2,'0');
      const time = `${h}:${m}`;
      if (allSlots.includes(time)) {
        schedulingStates[from] = { ...state, step: 'getting_name', time };
        return `Ótimo! ${time} anotado 😊 Para confirmar, me diga seu nome completo.`;
      }
    }
    // Try to match partial like "9" or "14"
    const numMatch = text.match(/\b(\d{1,2})\b/);
    if (numMatch) {
      const h = String(numMatch[1]).padStart(2,'0');
      const time = allSlots.find(s => s.startsWith(h+':'));
      if (time) {
        schedulingStates[from] = { ...state, step: 'getting_name', time };
        return `Ótimo! ${time} anotado 😊 Para confirmar, me diga seu nome completo.`;
      }
    }
    return null;
  }

  if (state && state.step === 'getting_name') {
    const name = text.trim();
    if (name.length > 2) {
      const doc = doctors.find(d => d.id === state.docId);
      const dateStr = state.date;
      const [year,month,day] = dateStr.split('-');
      await bookSlot(state.docId, state.docName, name, formatPhone(from), dateStr, state.time);
      delete schedulingStates[from];
      return `✅ Agendado! ${name}, sua consulta com ${state.docName} está confirmada para ${day}/${month} às ${state.time}. Enviaremos um lembrete! 😊`;
    }
    return null;
  }

  return null;
}

// ── PROCESS MESSAGE ───────────────────────────────────
async function processMessage(body) {
  try {
    if (body?.data?.key?.fromMe) return;
    if (body?.data?.key?.remoteJid?.includes('@g.us')) return;

    const text = body?.data?.message?.conversation || body?.data?.message?.extendedTextMessage?.text;
    const from = body?.data?.key?.remoteJid;
    if (!from || !text) return;

    const phone = formatPhone(from);
    const name = body?.data?.pushName || phone;
    const now = new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});

    console.log(`📩 ${name}: ${text}`);

    const { clinic, doctors } = await getClinicData();

    // Try scheduling flow first
    const schedulingReply = await handleScheduling(from, text, doctors, clinic);

    if (!conversations[from]) conversations[from] = [];
    conversations[from].push({ role:'user', content:text });
    if (conversations[from].length > 20) conversations[from] = conversations[from].slice(-20);

    let reply;
    if (schedulingReply) {
      reply = schedulingReply;
      conversations[from].push({ role:'assistant', content:reply });
    } else {
      // Use Claude for general conversation
      const systemPrompt = buildPrompt(clinic, doctors);
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},
        body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1000,system:systemPrompt,messages:conversations[from]}),
      });
      const claudeData = await claudeRes.json();
      reply = claudeData.content?.[0]?.text;
      if (!reply) { console.log('❌ No Claude reply'); return; }
      conversations[from].push({ role:'assistant', content:reply });
    }

    console.log(`🤖 ${clinic.botName}: ${reply}`);

    const isHuman = reply.includes('equipe') || reply.includes('atendente') || reply.includes('transferir');
    const msgs = conversations[from].map(m => ({f:m.role==='user'?'p':'b',t:m.content,h:now}));
    await saveConversation(phone, name, reply, isHuman?'human':'bot', msgs);

    await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCE}`, {
      method:'POST',
      headers:{'Content-Type':'application/json',apikey:EVOLUTION_KEY},
      body:JSON.stringify({number:from,text:reply}),
    });
    console.log('✅ Sent!');
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

app.post('/webhook', (req,res)=>{res.status(200).send('OK');processMessage(req.body);});
app.post('/webhook/*',(req,res)=>{res.status(200).send('OK');processMessage(req.body);});
app.get('/',(req,res)=>res.json({status:'✅ BotClínica online!',uid:CLINIC_UID}));

const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log(`🚀 Webhook porta ${PORT}`));
