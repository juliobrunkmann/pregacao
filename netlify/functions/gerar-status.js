// =====================================================================
// netlify/functions/gerar-status.js
// Consulta o progresso/resultado de um job de geração iniciado por
// /api/gerar-iniciar (Background Function). Leitura simples e rápida
// no Blobs — não tem nada de pesado aqui, é só um GET de status.
//
//   GET /api/gerar-status?id=job_xxx
//     -> { status: 'pending'|'streaming'|'done'|'error', text, meta, ... }
//     -> 404 se o job não existir (ainda não foi criado, ou expirou)
// =====================================================================

import { getStore } from '@netlify/blobs';

export default async (req) => {
  if (req.method !== 'GET') {
    return json({ error: 'Método não permitido' }, 405);
  }

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) {
    return json({ error: 'Parâmetro "id" ausente.' }, 400);
  }

  const store = getStore({ name: 'pregacoes-jobs', consistency: 'strong' });
  const job = await store.get(id, { type: 'json' });

  if (!job) {
    return json({ status: 'not_found' }, 404);
  }

  // Os campos que começam com "_" são estado interno usado só pelo
  // gerar-iniciar.js/gerar-continuar-cron.js pra saber como continuar a
  // geração (prompt completo, tokens, etc.) — não precisam (nem devem)
  // voltar pro cliente a cada poll.
  const { _prompt, _maxTokens, _model, _fatia, _continuar, ...paraCliente } = job;
  return json(paraCliente);
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export const config = {
  path: '/api/gerar-status',
};
