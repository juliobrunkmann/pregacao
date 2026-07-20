// =====================================================================
// netlify/functions/historico.js
// Histórico de pregações usando Netlify Blobs.
// Cada pregação vira um blob (conteúdo completo) + uma entrada no índice.
//
//   POST   /api/historico          -> salva uma pregação  (corpo JSON)
//   GET    /api/historico          -> lista o índice (metadados, sem conteúdo)
//   GET    /api/historico?id=XXX   -> retorna uma pregação completa
//   DELETE /api/historico?id=XXX   -> exclui uma pregação
//
// Netlify Functions v2 (formato Web Request/Response).
// =====================================================================

import { getStore } from '@netlify/blobs';

const INDICE = '__indice';

export default async (req) => {
  // Consistência forte: uma pregação recém-salva aparece na lista na hora.
  const store = getStore({ name: 'pregacoes', consistency: 'strong' });
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  try {
    // -------------------------------------------------------------
    // SALVAR
    // -------------------------------------------------------------
    if (req.method === 'POST') {
      let body;
      try {
        body = await req.json();
      } catch (e) {
        return json({ error: 'Corpo inválido (JSON esperado).' }, 400);
      }

      const conteudo = (body.conteudo || '').trim();
      if (!conteudo) {
        return json({ error: 'Conteúdo da pregação ausente.' }, 400);
      }

      const novoId = 'preg_' + Date.now();
      const dataISO = new Date().toISOString();

      const registro = {
        id: novoId,
        data: dataISO,
        tema: (body.tema || 'Sem tema').toString().slice(0, 300),
        publico: (body.publico || '').toString().slice(0, 500),
        modo: body.modo === 'pocket' ? 'pocket' : 'completa',
        tempo: body.tempo || null,
        ocasiao: body.ocasiao || null,
        profundidade: body.profundidade || null,
        contexto: (body.contexto || '').toString().slice(0, 2000),
        conteudo, // HTML completo da pregação
      };

      // Salva o registro completo
      await store.setJSON(novoId, registro);

      // Atualiza o índice (metadados leves, sem o conteúdo)
      const indice = await lerIndice(store);
      indice.unshift({
        id: registro.id,
        data: registro.data,
        tema: registro.tema,
        publico: registro.publico,
        modo: registro.modo,
        tempo: registro.tempo,
        ocasiao: registro.ocasiao,
        profundidade: registro.profundidade,
      });
      await store.setJSON(INDICE, indice);

      return json({ ok: true, id: registro.id, data: registro.data });
    }

    // -------------------------------------------------------------
    // VER UMA PREGAÇÃO COMPLETA
    // -------------------------------------------------------------
    if (req.method === 'GET' && id) {
      const registro = await store.get(id, { type: 'json' });
      if (!registro) {
        return json({ error: 'Pregação não encontrada.' }, 404);
      }
      return json(registro);
    }

    // -------------------------------------------------------------
    // LISTAR O ÍNDICE
    // -------------------------------------------------------------
    if (req.method === 'GET') {
      const indice = await lerIndice(store);
      return json({ ok: true, pregacoes: indice });
    }

    // -------------------------------------------------------------
    // EXCLUIR
    // -------------------------------------------------------------
    if (req.method === 'DELETE' && id) {
      await store.delete(id);
      const indice = await lerIndice(store);
      const novoIndice = indice.filter((p) => p.id !== id);
      await store.setJSON(INDICE, novoIndice);
      return json({ ok: true });
    }

    return json({ error: 'Requisição não suportada.' }, 400);
  } catch (e) {
    return json({ error: 'Erro no histórico: ' + e.message }, 500);
  }
};

async function lerIndice(store) {
  const indice = await store.get(INDICE, { type: 'json' });
  return Array.isArray(indice) ? indice : [];
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export const config = {
  path: '/api/historico',
};
