const express = require('express');
const app = express();
app.use(express.json());

const EVOLUTION_URL = 'https://evolution-api-production-16f18.up.railway.app';
const EVOLUTION_KEY = 'botclinica2025';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const INSTANCE = 'botclinica';
const CLINIC_UID = 'fMi67Aq1QzfM9Xhnj7eH2vJBTe92';
const FIREBASE_PROJECT = 'botclinica-60b6f';
const FIREBASE_API_KEY = 'AIzaSyAwYQq-ddQT8fBFytQYF5bgY5geL3SM2Ew';

const conversations = {};
let clinicCache = null;
let lastFetch = 0;

// Fetch clinic data + doctors from Firebase REST API
async function getClinicData() {
  const now = Date.now();
  if (clinicCache && now - lastFetch < 5 * 60 * 1000) return clinicCache; // cache 5min

  try {
    const base = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

    // Fetch clinic config
    const cRes = await fetch(`${base}/clinicas/${CLINIC_UID}?key=${FIREBASE_API_KEY}`);
    const cData = await cRes.json();
    const fields = cData.fields || {};
    const clinic = {
      name: fields.clinicName?.stringValue || 'Clínica',
      phone: fields.phone?.stringValue || '',
      hours: fields.hours?.stringValue || 'Seg-Sex: 8h-18h',
      botName: fields.botName?.stringValue || 'Sofia',
    };

    // Fetch doctors
    const dRes = await fetch(`${base}/clinicas/${CLINIC_UID}/medicos?key=${FIREBASE_API_KEY}`);
    const dData = await dRes.json();
    const doctors = (dData.documents || [])
      .map(d => {
        const f = d.fields || {};
        return {
          name: f.name?.stringValue || '',
          spec: f.spec?.stringValue || '',
          days: f.days?.stringValue || '',
          times: f.times?.stringValue || '',
          preco: f.preco?.stringValue || '',
          active: f.active?.booleanValue !== false,
        };
      })
      .filter(d => d.active && d.name);

    clinicCache = { clinic, doctors };
    lastFetch = now;
    console.log(`📋 Clínica: ${clinic.name} | Médicos: ${doctors.map(d=>d.name).join(', ')}`);
    return clinicCache;
  } catch (e) {
    console.error('❌ Firebase fetch error:', e.message);
    return clinicCache || { clinic: { name: 'Clínica', botName: 'Sofia', phone: '', hours: '' }, doctors: [] };
  }
}

function buildPrompt(clinic, doctors) {
  const docList = doctors.length > 0
    ? doctors.map(d => `- ${d.name}${d.spec ? ' — ' + d.spec : ''}${d.days ? ' — ' + d.days : ''}${d.times ? ' — ' + d.times : ''}${d.preco ? ' — Consulta: ' + d.preco : ''}`).join('\n')
    : '- Nenhum médico cadastrado ainda.';

  return `Você é ${clinic.botName}, assistente virtual da ${clinic.name}.
Seu objetivo é agendar consultas e encantar os pacientes com atendimento caloroso e ágil.

CLÍNICA: ${clinic.name}
${clinic.phone ? 'TELEFONE: ' + clinic.phone : ''}
${clinic.hours ? 'HORÁRIOS: ' + clinic.hours : ''}

MÉDICOS DISPONÍVEIS:
${docList}

REGRAS:
1. Sempre termine com uma pergunta de ação ("Qual data prefere?" / "Posso agendar pra você?")
2. Ao informar valor, contextualize positivamente ("...um investimento na sua saúde ❤️")
3. Quando o paciente confirmar interesse, pergunte nome e data preferida
4. Para emergências ou dúvidas complexas, diga: "Vou conectar você com nossa equipe agora!"
5. Fale APENAS dos médicos listados acima — não invente nenhum

ESTILO: Calorosa, empática, profissional. Como uma recepcionista atenciosa.
Responda em português brasileiro, máximo 3 frases. Sem markdown ou asteriscos. Emojis com moderação.`;
}

async function saveToFirebase(phone, name, lastMsg, status, msgs) {
  try {
    const base = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
    const docId = phone.replace(/[^a-zA-Z0-9]/g, '_');
    const now = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    const body = {
      fields: {
        name: { stringValue: name },
        phone: { stringValue: phone },
        last: { stringValue: lastMsg },
        lastMsg: { stringValue: lastMsg },
        time: { stringValue: now },
        status: { stringValue: status },
        msgs: {
          arrayValue: {
            values: msgs.slice(-20).map(m => ({
              mapValue: {
                fields: {
                  f: { stringValue: m.f },
                  t: { stringValue: m.t },
                  h: { stringValue: m.h || now }
                }
              }
            }))
          }
        },
        updatedAt: { stringValue: new Date().toISOString() }
      }
    };

    await fetch(`${base}/clinicas/${CLINIC_UID}/conversas/${docId}?key=${FIREBASE_API_KEY}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    console.log('✅ Firebase salvo!');
  } catch (e) {
    console.error('❌ Firebase save error:', e.message);
  }
}

function formatPhone(jid) {
  const num = jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
  return '+' + num;
}

async function processMessage(body) {
  try {
    if (body?.data?.key?.fromMe) return;
    if (body?.data?.key?.remoteJid?.includes('@g.us')) return;

    const text =
      body?.data?.message?.conversation ||
      body?.data?.message?.extendedTextMessage?.text ||
      body?.data?.message?.imageMessage?.caption;

    const from = body?.data?.key?.remoteJid;
    if (!from || !text) return;

    const phone = formatPhone(from);
    const name = body?.data?.pushName || phone;
    const now = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    console.log(`📩 ${name}: ${text}`);

    // Get real clinic data from Firebase
    const { clinic, doctors } = await getClinicData();
    const systemPrompt = buildPrompt(clinic, doctors);

    // Conversation history
    if (!conversations[from]) conversations[from] = [];
    conversations[from].push({ role: 'user', content: text });
    if (conversations[from].length > 20) conversations[from] = conversations[from].slice(-20);

    // Save patient message
    const msgs = conversations[from].map(m => ({ f: m.role === 'user' ? 'p' : 'b', t: m.content, h: now }));
    await saveToFirebase(phone, name, text, 'bot', msgs);

    // Call Claude
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, system: systemPrompt, messages: conversations[from] }),
    });

    const claudeData = await claudeRes.json();
    const reply = claudeData.content?.[0]?.text;
    if (!reply) { console.log('❌ Sem resposta Claude'); return; }

    console.log(`🤖 ${clinic.botName}: ${reply}`);
    conversations[from].push({ role: 'assistant', content: reply });

    const isHuman = reply.includes('equipe') || reply.includes('atendente') || reply.includes('transferir');
    const msgsWithReply = [...msgs, { f: 'b', t: reply, h: now }];
    await saveToFirebase(phone, name, reply, isHuman ? 'human' : 'bot', msgsWithReply);

    // Send reply via Evolution API
    await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_KEY },
      body: JSON.stringify({ number: from, text: reply }),
    });

    console.log('✅ Enviado!');
  } catch (err) {
    console.error('❌ Erro:', err.message);
  }
}

app.post('/webhook', (req, res) => { res.status(200).send('OK'); processMessage(req.body); });
app.post('/webhook/*', (req, res) => { res.status(200).send('OK'); processMessage(req.body); });
app.get('/', (req, res) => res.json({ status: '✅ Webhook BotClínica online!', uid: CLINIC_UID }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook rodando na porta ${PORT}`));
