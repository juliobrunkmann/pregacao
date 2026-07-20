// =====================================================================
// netlify/functions/_lib/geracao.js
// Lógica compartilhada entre gerar-iniciar.js (dispara a 1ª fatia) e
// gerar-continuar-cron.js (continua as fatias seguintes). Ver o
// comentário no topo de gerar-iniciar.js para o histórico completo do
// porquê desse desenho existe.
// =====================================================================

// Margem de segurança bem abaixo do corte de ~25-30s observado ao vivo
// numa única execução de function nesta conta/plano.
export const TEMPO_MAX_POR_CHAMADA_MS = 15000;
// Cada leitura individual do stream é limitada a isso — garante que a
// checagem do tempo total roda com frequência, mesmo que uma leitura
// específica demore, em vez de arriscar estourar o limite da chamada
// esperando um único read() que não retorna.
export const TEMPO_MAX_POR_LEITURA_MS = 5000;
// Trava de segurança: no máximo essa quantidade de fatias (cada uma
// processada por um tick do cron, de ~1 em 1 minuto — ver
// gerar-continuar-cron.js). 30 fatias ≈ 30 minutos — dá bastante margem
// mesmo pro pior caso observado em teste real (60min/Profunda, que às
// vezes o modelo gera de forma mais verbosa que o normal e demora mais
// fatias pra concluir). Se mesmo assim estourar esse limite, o job NÃO
// é descartado — gerar-continuar-cron.js finaliza com o texto acumulado
// até ali, marcado como truncado, em vez de perder tudo com um erro.
export const MAX_FATIAS = 30;

// -----------------------------------------------------------------------
// ÍNDICE DE PENDÊNCIAS — evita que o cron precise vasculhar TODO o
// histórico de pregações já geradas a cada tick (1 em 1 minuto, pra
// sempre) só pra descobrir se alguma está pendente. Sem isso, o custo do
// tick ocioso cresce sem limite conforme mais pregações vão sendo
// geradas ao longo dos meses — foi medido em produção que isso sozinho
// poderia estourar o orçamento mensal de créditos do Netlify em poucos
// meses de uso normal, mesmo a geração em si sendo barata.
//
// A chave abaixo guarda só uma lista pequena com os IDs das pregações
// que ainda estão em aberto (status "streaming"). Uma pregação concluída
// (ou com erro) sai da lista — fica "fechada". O tick do cron lê só essa
// lista (1 leitura pequena e rápida); se estiver vazia, ele encerra na
// hora sem tocar em nenhum job individual. O custo do tick ocioso fica
// constante pra sempre, não importa quantas pregações já foram geradas.
export const CHAVE_INDICE_PENDENTES = '_indice_pendentes';

export async function obterPendentes(store) {
  let indice;
  try {
    indice = await store.get(CHAVE_INDICE_PENDENTES, { type: 'json' });
  } catch (e) {
    indice = null;
  }
  return Array.isArray(indice) ? indice : [];
}

export async function adicionarPendente(store, jobId) {
  const lista = await obterPendentes(store);
  if (!lista.includes(jobId)) {
    lista.push(jobId);
    await store.setJSON(CHAVE_INDICE_PENDENTES, lista);
  }
}

export async function removerPendente(store, jobId) {
  const lista = await obterPendentes(store);
  const nova = lista.filter((id) => id !== jobId);
  if (nova.length !== lista.length) {
    await store.setJSON(CHAVE_INDICE_PENDENTES, nova);
  }
}

// Lê o próximo pedaço do stream com um limite de tempo — se demorar demais,
// devolve um marcador de timeout em vez de ficar esperando indefinidamente,
// pra quem chamou poder reavaliar quanto tempo ainda resta na fatia atual.
export function lerComTimeout(reader, timeoutMs) {
  return Promise.race([
    reader.read(),
    new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), timeoutMs)),
  ]);
}

// Remove um bloco de código markdown (```html ... ``` ou ``` ... ```) que a
// IA às vezes adiciona por conta própria em volta do HTML gerado.
export function limparBlocoCodigo(texto) {
  if (!texto) return texto;
  let t = texto.trim();
  t = t.replace(/^```(?:html)?\s*\n?/i, '');
  t = t.replace(/\n?```\s*$/, '');
  return t;
}

// Gera UMA fatia da resposta: chama a Anthropic (com streaming) e lê por
// até TEMPO_MAX_POR_CHAMADA_MS. Se já existe texto acumulado de fatias
// anteriores, continua a partir dali — via uma mensagem "user" extra
// pedindo pra continuar (não dá pra usar "prefill" terminando a conversa
// com uma mensagem do assistant: esse modelo não aceita e responde com
// "This model does not support assistant message prefill. The
// conversation must end with a user message.").
//
// Retorna { textoNovo, stopReason, cortadoPorTempo, erro }
//   - erro: mensagem de erro amigável, se algo deu errado ao contatar a API
//   - cortadoPorTempo: true se a fatia acabou por tempo (ainda não terminou)
//   - stopReason: motivo real de parada da Anthropic quando termina de
//     verdade ('end_turn', 'max_tokens', etc.)
export async function gerarUmaFatia({ apiKey, model, maxTokens, prompt, acumulado }) {
  const messages = [{ role: 'user', content: prompt }];
  if (acumulado) {
    messages.push({ role: 'assistant', content: acumulado });
    messages.push({
      role: 'user',
      content:
        'Continue a resposta exatamente de onde parou. Não repita nenhum trecho já escrito, não adicione introduções, comentários ou observações sobre a continuação — apenas continue o texto a partir da última palavra ou tag HTML inacabada, como se nunca tivesse parado, até completar a pregação por inteiro.',
    });
  }

  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, messages }),
    });
  } catch (e) {
    return { textoNovo: '', stopReason: null, cortadoPorTempo: false, erro: 'Falha ao contatar a API da Anthropic: ' + e.message };
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    let msg = 'Erro ' + anthropicRes.status + ' na API da Anthropic.';
    try {
      const parsed = JSON.parse(errText);
      if (parsed?.error?.message) msg = parsed.error.message;
    } catch (e) {}
    return { textoNovo: '', stopReason: null, cortadoPorTempo: false, erro: msg };
  }

  const reader = anthropicRes.body.getReader();
  const decoder = new TextDecoder();
  let textoNovo = '';
  let sseBuffer = '';
  let stopReason = null;
  let cortadoPorTempo = false;
  const inicio = Date.now();

  try {
    while (true) {
      const restante = TEMPO_MAX_POR_CHAMADA_MS - (Date.now() - inicio);
      if (restante <= 0) {
        cortadoPorTempo = true;
        try { await reader.cancel(); } catch (e) {}
        break;
      }

      const resultado = await lerComTimeout(reader, Math.min(restante, TEMPO_MAX_POR_LEITURA_MS));
      if (resultado.__timeout) continue;
      const { done, value } = resultado;
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            textoNovo += parsed.delta.text;
          } else if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) {
            stopReason = parsed.delta.stop_reason;
          }
        } catch (e) {}
      }
    }
  } catch (e) {
    // Conexão caiu no meio da fatia — trata como "cortado por tempo" pra
    // tentar de novo na próxima fatia, em vez de perder tudo.
    cortadoPorTempo = true;
  }

  return { textoNovo, stopReason, cortadoPorTempo, erro: null };
}
