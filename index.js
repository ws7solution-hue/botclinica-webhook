const express = require('express');
const app = express();
app.use(express.json());

const EVOLUTION_URL = 'https://evolution-api-production-16f18.up.railway.app';
const EVOLUTION_KEY = 'botclinica2025';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const INSTANCE = 'botclinica';

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
- Ajude a agendar consultas (pergunte especialidade desejada e data preferida)
- Confirme agendamentos existentes quando perguntado
- Informe valores das consultas quando perguntado
- Para emergências, informe o telefone da clínica
- Se não souber responder algo específico, diga que vai verificar com um atendente

Responda em português brasileiro, de forma breve e direta (máximo 3 frases).
Não use markdown ou asteriscos. Use linguagem natural de WhatsApp com emojis ocasionais.`;

const conversations = {};

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

    console.log(`📩 De ${from}: ${text}`);

    if (!conversations[from]) conversations[from] = [];
    conversations[from].push({ role: 'user', content: text });
    if (conversations[from].length > 10) {
      conversations[from] = conversations[from].slice(-10);
    }

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
    if (!reply) { console.log('❌ Sem resposta Claude:', claudeData); return; }

    console.log(`🤖 Sofia: ${reply}`);
    conversations[from].push({ role: 'assistant', content: reply });

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

// Aceita qualquer rota POST que comece com /webhook
app.post('/webhook', (req, res) => { res.status(200).send('OK'); processMessage(req.body); });
app.post('/webhook/*', (req, res) => { res.status(200).send('OK'); processMessage(req.body); });
app.get('/', (req, res) => res.json({ status: 'Webhook BotClínica online! ✅', clinica: 'Clínica Saúde Total' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook rodando na porta ${PORT}`));
