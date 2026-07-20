// =====================================================================
// netlify/edge-functions/gerar.js
// Proxy seguro para a API da Anthropic — roda como Edge Function.
// A chave fica APENAS aqui, na variável de ambiente ANTHROPIC_API_KEY
// do Netlify — nunca é exposta no navegador.
// Repassa o streaming (SSE) da Anthropic direto para o cliente.
//
// Por que Edge Function (Deno) em vez de Function normal (Lambda):
// Functions síncronas normais têm um limite fixo de 60s de execução,
// contando o tempo TOTAL (incluindo espera de rede) — pregações longas
// (ex: "Profunda", 60 min) podem levar mais que isso pra terminar de
// ser geradas via streaming, e a function normal era morta no meio,
// cortando a mensagem. Edge Functions são limitadas por tempo de CPU
// (não por tempo total de espera), e este proxy é só I/O (fetch +
// repassar bytes) — não gasta CPU esperando a Anthropic responder.
// =====================================================================

export default async (req) => {
  // Só aceita POST
  if (req.method !== 'POST') {
    return json({ error: { message: 'Método não permitido' } }, 405);
  }

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return json(
      {
        error: {
          message:
            'Chave da API não configurada no servidor. Defina a variável de ambiente ANTHROPIC_API_KEY no painel do Netlify (escopo Runtime/Functions).',
        },
      },
      500
    );
  }

  // Lê o corpo enviado pelo navegador
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: { message: 'Corpo da requisição inválido (JSON esperado).' } }, 400);
  }

  const prompt = body && body.prompt;
  if (!prompt || typeof prompt !== 'string') {
    return json({ error: { message: 'Prompt ausente na requisição.' } }, 400);
  }

  const model = body.model || 'claude-sonnet-4-6';
  // Piso generoso — o cliente já manda um valor calculado pelo modo/profundidade,
  // isso aqui é só um fallback caso venha ausente.
  const maxTokens = body.max_tokens || 6000;

  // Chama a Anthropic com streaming
  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (e) {
    return json({ error: { message: 'Falha ao contatar a API da Anthropic: ' + e.message } }, 502);
  }

  // Se a Anthropic retornou erro, repassa o corpo do erro (JSON) ao cliente
  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return new Response(errText, {
      status: anthropicRes.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  // Repassa o stream SSE bruto — o cliente já sabe parsear "data: ..."
  return new Response(anthropicRes.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export const config = {
  path: '/api/gerar',
};
