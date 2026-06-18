const express = require('express');
const app = express();
app.use(express.json());

const EVOLUTION_URL = 'https://evolution-api-production-16f18.up.railway.app';
const EVOLUTION_KEY = 'botclinica2025';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FIREBASE_KEY = process.env.FIREBASE_SERVICE_KEY; // JSON string da service account
const INSTANCE = 'botclinica';
const CLINIC_UID = 'fMi67Aq1QzfM9Xhnj7eH2vJBTe92';
const FIREBASE_PROJECT = 'botclinica-60b6f';

const SYSTEM_PROMPT = `Você é Sofia, assistente virtual da Clínica Saúde Total.
Atenda pacientes pelo WhatsApp com cordialidade e simpatia.

CLÍNICA: Clínica Saúde Total
TELEFONE: (31) 3333-4444
HORÁRIOS: Segunda a Sexta: 8h às 18h | Sábado: 8h às 12h

MÉDICOS E ESPECIALIDADES:
- Dra. Ana Silva — Dermatologia — Terças e Quintas — Consulta: R$ 250,00
- Dr. Carlos Mendes — Cardiologia — Segundas e Quartas — Consulta: R$ 350,00
- Dra. Fernanda Lima — Clínica Geral — Seg a Sex — Consulta: R$ 180,00

INSTRUÇÕES:
- Cumprimente o paciente na primeira mensagem
- Ajude a agendar consultas
- Informe valores quando perguntado
- Para emergências, informe o telefone da clínica
- Se não souber, diga que vai verificar com um atendente

Responda em português brasileiro, de forma breve (máximo 3 frases).
Não use markdown ou asteriscos. Use linguagem natural com emojis ocasionais.`;

// Histórico de conversa por número
const conversations = {};

// Firebase REST API helpers
async function getFirebaseToken() {
  if (!FIREBASE_KEY) return null;
  try {
    const serviceAccount = JSON.parse(FIREBASE_KEY);
    const now = Math.floor(Date.now() / 1000);
    const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = btoa(JSON.stringify({
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    }));
    // Use Google's token endpoint with service account
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${payload}.sig`
      })
    });
    const data = await res.json();
    return data.access_token;
  } catch (e) {
    return null;
  }
}

async function saveToFirebase(phone, name, lastMsg, status, msgs) {
  try {
    // Use Firestore REST API with API key (simpler approach)
    const apiKey = 'AIzaSyAwYQq-ddQT8fBFytQYF5bgY5geL3SM2Ew';
    const baseUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
    const docPath = `clinicas/${CLINIC_UID}/conversas/${phone.replace(/[^a-zA-Z0-9]/g, '_')}`;
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

    const res = await fetch(`${baseUrl}/${docPath}?key=${apiKey}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      console.log('✅ Firebase salvo!');
    } else {
      const err = await res.text();
      console.log('⚠️ Firebase erro:', err.slice(0, 200));
    }
  } catch (e) {
    console.error('❌ Firebase save error:', e.message);
  }
}

function formatPhone(jid) {
  const num = jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
  return `+${num}`;
}

function formatName(jid) {
  const num = jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
  return `+${num.slice(0, 2)} (${num.slice(2, 4)}) ${num.slice(4, 9)}-${num.slice(9)}`;
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
    const name = body?.data?.pushName || formatName(from);
    const now = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    console.log(`📩 ${name} (${phone}): ${text}`);

    // Histórico
    if (!conversations[from]) conversations[from] = [];
    conversations[from].push({ role: 'user', content: text });
    if (conversations[from].length > 20) {
      conversations[from] = conversations[from].slice(-20);
    }

    // Salva mensagem do paciente no Firebase
    const msgsForDB = conversations[from].map((m, i) => ({
      f: m.role === 'user' ? 'p' : 'b',
      t: m.content,
      h: now
    }));
    await saveToFirebase(phone, name, text, 'bot', msgsForDB);

    // Chama Claude
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: conversations[from],
      }),
    });

    const claudeData = await claudeRes.json();
    const reply = claudeData.content?.[0]?.text;
    if (!reply) { console.log('❌ Sem resposta Claude'); return; }

    console.log(`🤖 Sofia: ${reply}`);
    conversations[from].push({ role: 'assistant', content: reply });

    // Salva resposta do bot no Firebase
    const msgsWithReply = [...msgsForDB, { f: 'b', t: reply, h: now }];
    const isHuman = reply.toLowerCase().includes('transferir') || reply.toLowerCase().includes('atendente');
    await saveToFirebase(phone, name, reply, isHuman ? 'human' : 'bot', msgsWithReply);

    // Envia resposta via Evolution API
    await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_KEY },
      body: JSON.stringify({ number: from, text: reply }),
    });

    console.log('✅ Mensagem enviada!');
  } catch (err) {
    console.error('❌ Erro:', err.message);
  }
}

app.post('/webhook', (req, res) => { res.status(200).send('OK'); processMessage(req.body); });
app.post('/webhook/*', (req, res) => { res.status(200).send('OK'); processMessage(req.body); });
app.get('/', (req, res) => res.json({ status: '✅ Webhook BotClínica online!', clinica: 'Clínica Saúde Total', uid: CLINIC_UID }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook rodando na porta ${PORT}`));
