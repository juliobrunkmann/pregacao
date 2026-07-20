// =====================================================================
// netlify/functions/gerar.js
// Proxy seguro para a API da Anthropic.
// A chave fica APENAS aqui, na variável de ambiente ANTHROPIC_API_KEY
// do Netlify — nunca é exposta no navegador.
// Repassa o streaming (SSE) da Anthropic direto para o cliente.
// Netlify Functions v2 (formato Web Request/Response).
// =====================================================================

export default async (req) => {
  // Só aceita POST
  if (req.method !== 'POST') {
    return json({ error: { message: 'Método não permitido' } }, 405);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(
      {
        error: {
          message:
            'Chave da API não configurada no servidor. Defina a variável de ambiente ANTHROPIC_API_KEY no painel do Netlify.',
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
  const maxTokens = body.max_tokens || 4000;

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
