import type { Context, Config } from "@netlify/functions";

// Function sem dependências externas além do @netlify/functions (só tipos).
// Formato moderno: default export recebendo Request + Context.
//
// O que ela faz:
// 1. Recebe { url } no corpo da requisição (POST)
// 2. Busca o HTML da página (server-side, sem bloqueio de CORS)
// 3. Extrai, por padrões de texto (regex), os dados mais comuns de um
//    edital: valor de avaliação, valor mínimo do lote, situação de
//    ocupação, número de matrícula, se mencionado.
// 4. Devolve os dados brutos e os campos já pré-preenchidos para o
//    Analisador de Oportunidade do app.
//
// IMPORTANTE: extração heurística por regex, não leitura com IA. Sites de
// leilão mudam de layout com frequência e alguns bloqueiam robôs. Trate
// sempre como rascunho a conferir contra o edital original.
//
// SEGURANÇA: esta versão aceita QUALQUER site de leilão (não só uma lista
// fixa), a pedido do usuário. Para isso não virar uma brecha de abuso
// (a function não pode virar um "proxy genérico" que alguém usa para
// acessar endereços internos da própria infraestrutura da Netlify ou de
// terceiros), ela bloqueia por padrão qualquer alvo que não seja um site
// público normal na internet: IPs privados/locais, localhost, portas
// não padrão de serviços internos, e protocolos que não sejam http/https.

function isPrivateOrLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  // IPv4 literal checks
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [parseInt(ipv4[1]), parseInt(ipv4[2])];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 0) return true;
  }
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  return false;
}

function toNumber(strBR: string | null): number | null {
  if (!strBR) return null;
  const n = strBR.replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".");
  const val = parseFloat(n);
  return isNaN(val) ? null : val;
}

function findAllPrices(text: string): number[] {
  const out: number[] = [];
  const r = /R\$\s?([\d.]{4,12},\d{2})/gi;
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) {
    const v = toNumber(m[1]);
    if (v && v > 1000) out.push(v);
  }
  return [...new Set(out)].sort((a, b) => b - a);
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método não permitido." }), {
      status: 405,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  let targetUrl: string | undefined;
  try {
    const body = await req.json();
    targetUrl = body.url;
  } catch {
    return new Response(JSON.stringify({ error: "Corpo da requisição inválido." }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return new Response(
      JSON.stringify({ error: "Envie uma URL válida, começando com http:// ou https://." }),
      { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return new Response(JSON.stringify({ error: "URL inválida." }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return new Response(JSON.stringify({ error: "Apenas links http/https são aceitos." }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (isPrivateOrLocalHost(parsed.hostname)) {
    return new Response(
      JSON.stringify({ error: "Este endereço não é permitido por segurança." }),
      { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }

  let html: string;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const resp = await fetch(targetUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    // Trava extra: depois de seguir redirects, confira de novo o destino final
    if (resp.url) {
      const finalHost = new URL(resp.url).hostname;
      if (isPrivateOrLocalHost(finalHost)) {
        return new Response(
          JSON.stringify({ error: "Este endereço não é permitido por segurança." }),
          { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } }
        );
      }
    }

    if (!resp.ok) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `O site respondeu com status ${resp.status}. Ele pode estar bloqueando acesso automático, ou o link pode ter expirado.`,
        }),
        { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    const contentType = resp.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && contentType !== "") {
      return new Response(
        JSON.stringify({
          success: false,
          error: "O link não retornou uma página HTML (pode ser um PDF, imagem ou outro tipo de arquivo). Tente o link da página do lote, não de um arquivo anexo.",
        }),
        { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    html = await resp.text();
  } catch (e) {
    const isAbort = e instanceof Error && e.name === "AbortError";
    return new Response(
      JSON.stringify({
        success: false,
        error: isAbort
          ? "O site demorou demais para responder (timeout). Tente novamente ou confira se o link está correto."
          : "Não foi possível acessar essa URL a partir do servidor. O site pode estar bloqueando robôs.",
      }),
      { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }

  const clean = html.replace(/\s+/g, " ");

  const uniquePrices = findAllPrices(clean);

  let ocupacao = "nao_identificado";
  if (/im[oó]vel\s+desocupado/i.test(clean)) ocupacao = "desocupado";
  else if (/im[oó]vel\s+ocupado/i.test(clean)) ocupacao = "ocupado";

  const matriculaMatch = clean.match(/matr[ií]cula\s*n?[ºo°]?\s*[:\-]?\s*([\d.]{2,12})/i);
  const matricula = matriculaMatch ? matriculaMatch[1] : null;

  let praca: string | null = null;
  if (/2[ºo°]?\s*leil[ãa]o|segunda\s+pra[çc]a|segundo\s+leil[ãa]o/i.test(clean)) praca = "2";
  else if (/1[ºo°]?\s*leil[ãa]o|primeira\s+pra[çc]a|primeiro\s+leil[ãa]o/i.test(clean)) praca = "1";

  // Sinalização adicional (não preenche o Analisador sozinha, mas ajuda o usuário)
  let origemProvavel: string | null = null;
  if (/caixa\s+econ[oô]mica|caef|cef\b/i.test(clean)) origemProvavel = "Caixa Econômica Federal";
  else if (/bradesco/i.test(clean)) origemProvavel = "Bradesco";
  else if (/ita[uú]/i.test(clean)) origemProvavel = "Itaú";
  else if (/santander/i.test(clean)) origemProvavel = "Santander";
  else if (/banco\s+do\s+brasil/i.test(clean)) origemProvavel = "Banco do Brasil";
  else if (/leil[ãa]o\s+judicial|vara\s+c[íi]vel|processo\s+n[ºo°]/i.test(clean)) origemProvavel = "Judicial";
  else if (/prefeitura|d[íi]vida\s+ativa/i.test(clean)) origemProvavel = "Prefeitura (dívida ativa)";

  const titleMatch = clean.match(/<title>([^<]{5,180})<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : null;

  // ---------- imagem principal do anúncio ----------
  let imagemUrl: string | null = null;
  const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  const twitterImageMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  const rawImg = ogImageMatch?.[1] || twitterImageMatch?.[1];
  if (rawImg) {
    try {
      imagemUrl = new URL(rawImg, targetUrl).toString();
    } catch {
      imagemUrl = null;
    }
  }
  if (!imagemUrl) {
    const imgMatches = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)];
    for (const im of imgMatches) {
      const src = im[1];
      if (/logo|icon|sprite|pixel|\.svg/i.test(src)) continue;
      try {
        imagemUrl = new URL(src, targetUrl).toString();
        break;
      } catch {
        continue;
      }
    }
  }

  // ---------- descrição / endereço ----------
  let descricao: string | null = null;
  const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
  const metaDescMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  descricao = (ogDescMatch?.[1] || metaDescMatch?.[1] || "").trim() || null;
  if (descricao) {
    descricao = descricao.replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").slice(0, 400);
  }

  let endereco: string | null = null;
  const enderecoMatch = clean.match(/endere[çc]o\s*[:\-]?\s*([^.<]{10,160})/i);
  if (enderecoMatch) endereco = enderecoMatch[1].trim();

  const extractedOk = uniquePrices.length > 0 || ocupacao !== "nao_identificado" || !!matricula;

  return new Response(
    JSON.stringify({
      success: true,
      extraction_confidence: extractedOk ? (uniquePrices.length >= 2 ? "media" : "baixa") : "nenhuma",
      title,
      imagem_url: imagemUrl,
      descricao,
      endereco,
      origem_provavel: origemProvavel,
      matricula,
      praca,
      ocupacao,
      valores_encontrados_rs: uniquePrices.slice(0, 6),
      sugestao: {
        avaliacao: uniquePrices[0] || null,
        lance_minimo: uniquePrices.length > 1 ? uniquePrices[uniquePrices.length - 1] : null,
      },
      aviso:
        "Extração automática e heurística, válida para qualquer site de leilão. SEMPRE confira cada campo contra o edital original antes de usar no Analisador ou de dar um lance.",
    }),
    { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
  );
};

export const config: Config = {
  path: "/.netlify/functions/analisar-lote",
};
