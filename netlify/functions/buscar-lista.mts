import type { Context, Config } from "@netlify/functions";

// netlify/functions/buscar-lista.mts
//
// Diferente da analisar-lote.mts (que lê UM lote específico), esta function
// varre uma PÁGINA DE RESULTADOS DE BUSCA (a página que aparece depois que
// você já filtrou por cidade/bairro/estado no site do leiloeiro) e tenta
// extrair todos os lotes listados nela, de uma vez.
//
// Fluxo pretendido:
// 1. Você vai no site do leilão que preferir (Caixa, Sodré Santoro, Mega
//    Leilões etc.) e faz a busca por região usando os filtros do PRÓPRIO
//    site (isso é importante: cada site tem filtros diferentes, e tentar
//    adivinhar a URL de busca de cada um seria pouco confiável).
// 2. Copia o link da página de RESULTADOS (não de um lote específico).
// 3. Cola aqui. Esta function varre essa página e devolve uma lista de
//    candidatos: título aproximado, preço encontrado, link do lote.
//
// LIMITAÇÃO HONESTA: a extração é heurística (baseada em padrões de HTML
// comuns: links com preço em R$ por perto). Sites que carregam a lista via
// JavaScript (React/Vue client-side, sem HTML pronto no servidor) podem não
// funcionar, porque esta function só vê o HTML bruto, não o que o navegador
// renderiza depois. Nesse caso ela vai devolver poucos ou nenhum resultado,
// e vai avisar isso explicitamente.

function isPrivateOrLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [parseInt(ipv4[1]), parseInt(ipv4[2])];
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
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

interface Candidate {
  title: string;
  url: string;
  price: number | null;
  ocupacao: "desocupado" | "ocupado" | "nao_identificado";
  quick_score?: number;
  full_score?: number;
  avaliacao?: number | null;
  lance_minimo?: number | null;
  desconto_pct?: number | null;
  praca?: string | null;
  scan_status?: "ok" | "falhou";
}

async function scanLoteIndividual(url: string): Promise<Partial<Candidate>> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return { scan_status: "falhou" };

    const html = await resp.text();
    const clean = html.replace(/\s+/g, " ");

    const priceMatches: number[] = [];
    const r = /R\$\s?([\d.]{4,12},\d{2})/gi;
    let m: RegExpExecArray | null;
    while ((m = r.exec(clean)) !== null) {
      const v = toNumber(m[1]);
      if (v && v > 1000) priceMatches.push(v);
    }
    const uniquePrices = [...new Set(priceMatches)].sort((a, b) => b - a);

    let ocupacao: Candidate["ocupacao"] = "nao_identificado";
    if (/im[oó]vel\s+desocupado/i.test(clean)) ocupacao = "desocupado";
    else if (/im[oó]vel\s+ocupado/i.test(clean)) ocupacao = "ocupado";

    let praca: string | null = null;
    if (/2[ºo°]?\s*leil[ãa]o|segunda\s+pra[çc]a/i.test(clean)) praca = "2";
    else if (/1[ºo°]?\s*leil[ãa]o|primeira\s+pra[çc]a/i.test(clean)) praca = "1";

    const avaliacao = uniquePrices[0] || null;
    const lanceMinimo = uniquePrices.length > 1 ? uniquePrices[uniquePrices.length - 1] : null;

    return { avaliacao, lance_minimo: lanceMinimo, ocupacao, praca, scan_status: "ok" };
  } catch {
    return { scan_status: "falhou" };
  }
}

async function scanComConcorrenciaLimitada<T>(
  items: T[],
  worker: (item: T) => Promise<Partial<Candidate>>,
  maxConcorrencia: number
): Promise<Partial<Candidate>[]> {
  const results: Partial<Candidate>[] = new Array(items.length);
  let nextIndex = 0;
  async function runNext(): Promise<void> {
    const i = nextIndex++;
    if (i >= items.length) return;
    results[i] = await worker(items[i]);
    return runNext();
  }
  const workers = Array.from({ length: Math.min(maxConcorrencia, items.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response("", { status: 200 });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método não permitido." }), {
      status: 405,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  let targetUrl: string | undefined;
  let deepScan = false;
  try {
    const body = await req.json();
    targetUrl = body.url;
    deepScan = !!body.deepScan;
  } catch {
    return new Response(JSON.stringify({ error: "Corpo da requisição inválido." }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return new Response(JSON.stringify({ error: "Envie uma URL válida." }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
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
    return new Response(JSON.stringify({ error: "Este endereço não é permitido por segurança." }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  let html: string;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
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

    if (resp.url) {
      const finalHost = new URL(resp.url).hostname;
      if (isPrivateOrLocalHost(finalHost)) {
        return new Response(JSON.stringify({ error: "Este endereço não é permitido por segurança." }), {
          status: 400,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
    }

    if (!resp.ok) {
      return new Response(
        JSON.stringify({ success: false, error: `O site respondeu com status ${resp.status}.` }),
        { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    html = await resp.text();
  } catch (e) {
    const isAbort = e instanceof Error && e.name === "AbortError";
    return new Response(
      JSON.stringify({
        success: false,
        error: isAbort ? "O site demorou demais para responder." : "Não foi possível acessar essa URL.",
      }),
      { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }

  // ---------- extração de múltiplos lotes ----------
  const anchorRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const priceRegex = /R\$\s?([\d.]{4,12},\d{2})/;

  const candidatesRaw: Candidate[] = [];
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = anchorRegex.exec(html)) !== null && count < 4000) {
    count++;
    const href = m[1];
    const innerHtmlRaw = m[2];
    const innerText = innerHtmlRaw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    const priceMatch = innerText.match(priceRegex);
    if (!priceMatch) continue;

    const price = toNumber(priceMatch[1]);
    if (!price || price < 5000) continue;

    let absoluteUrl: string;
    try {
      absoluteUrl = new URL(href, targetUrl).toString();
    } catch {
      continue;
    }

    if (!/^https?:\/\//i.test(absoluteUrl)) continue;

    let title = innerText.replace(priceMatch[0], "").trim();
    title = title.replace(/\s{2,}/g, " ").slice(0, 140);
    if (!title) title = "(sem título identificado)";

    let ocupacao: Candidate["ocupacao"] = "nao_identificado";
    if (/desocupad/i.test(innerText)) ocupacao = "desocupado";
    else if (/\bocupad/i.test(innerText)) ocupacao = "ocupado";

    candidatesRaw.push({ title, url: absoluteUrl, price, ocupacao });
  }

  const seen = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of candidatesRaw) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    deduped.push(c);
  }

  const pricesOnly = deduped.map(c => c.price).filter((p): p is number => !!p).sort((a,b)=>a-b);
  function percentileRank(price: number | null): number {
    if (!price || pricesOnly.length === 0) return 50;
    const idx = pricesOnly.findIndex(p => p >= price);
    const rank = idx === -1 ? pricesOnly.length : idx;
    return (rank / pricesOnly.length) * 100;
  }
  for (const c of deduped) {
    const pricePercentile = percentileRank(c.price);
    let score = 100 - pricePercentile;
    if (c.ocupacao === "desocupado") score += 12;
    else if (c.ocupacao === "ocupado") score -= 15;
    c.quick_score = Math.max(0, Math.min(100, Math.round(score)));
  }

  deduped.sort((a, b) => (b.quick_score || 0) - (a.quick_score || 0));

  let results = deduped.slice(0, 40);

  const DEEP_SCAN_LIMIT = 10;
  let deepScanAviso = "";
  if (deepScan && results.length > 0) {
    const toScan = results.slice(0, DEEP_SCAN_LIMIT);
    const scanned = await scanComConcorrenciaLimitada(
      toScan.map(c => c.url),
      scanLoteIndividual,
      4
    );

    let scanFalhas = 0;
    toScan.forEach((c, i) => {
      const s = scanned[i];
      if (s.scan_status === "falhou" || !s.avaliacao) {
        scanFalhas++;
        c.scan_status = "falhou";
        return;
      }
      c.avaliacao = s.avaliacao ?? null;
      c.lance_minimo = s.lance_minimo ?? c.price;
      c.ocupacao = s.ocupacao ?? c.ocupacao;
      c.praca = s.praca ?? null;
      c.scan_status = "ok";

      const aval = c.avaliacao || 0;
      const lance = c.lance_minimo || c.price || 0;
      const desconto = aval > 0 ? ((aval - lance) / aval) * 100 : 0;
      c.desconto_pct = Math.round(desconto * 10) / 10;

      let scoreFin = 50;
      if (desconto >= 50) scoreFin = 100;
      else if (desconto >= 35) scoreFin = 85;
      else if (desconto >= 20) scoreFin = 65;
      else if (desconto >= 10) scoreFin = 45;
      else scoreFin = 25;

      let scoreOcup = 60;
      if (c.ocupacao === "desocupado") scoreOcup = 90;
      else if (c.ocupacao === "ocupado") scoreOcup = 30;

      const scorePraca = c.praca === "2" ? 65 : c.praca === "1" ? 50 : 55;

      c.full_score = Math.round(scoreFin * 0.55 + scoreOcup * 0.30 + scorePraca * 0.15);
    });

    const comFullScore = results.filter(c => typeof c.full_score === "number");
    const semFullScore = results.filter(c => typeof c.full_score !== "number");
    comFullScore.sort((a, b) => (b.full_score || 0) - (a.full_score || 0));
    semFullScore.sort((a, b) => (b.quick_score || 0) - (a.quick_score || 0));
    results = [...comFullScore, ...semFullScore];

    if (scanFalhas > 0) {
      deepScanAviso = ` ${scanFalhas} de ${toScan.length} lotes não puderam ser abertos individualmente (site bloqueou ou não respondeu a tempo) — esses continuam ordenados pela pré-triagem simples.`;
    }
  }

  return new Response(
    JSON.stringify({
      success: true,
      total_encontrado: results.length,
      deep_scan_usado: deepScan,
      candidatos: results,
      aviso:
        results.length === 0
          ? "Nenhum lote foi reconhecido nesta página. Isso costuma acontecer quando o site carrega a lista via JavaScript (o conteúdo não vem pronto no HTML). Tente copiar o link de um lote individual e usar o Analisador de Oportunidade normal."
          : deepScan
          ? `Ordenado por desconto real (avaliação vs. lance mínimo) + ocupação, calculado abrindo cada um dos ${Math.min(DEEP_SCAN_LIMIT, results.length)} melhores candidatos individualmente.${deepScanAviso} Ainda assim, é uma pontuação parcial — não substitui a due diligence completa (jurídico, débitos, vistoria) do Analisador de Oportunidade.`
          : "Ordenado por uma pré-pontuação simples (preço relativo dentro desta busca + menção a desocupado) — é só uma triagem para decidir por onde começar, não é uma nota de risco real. Toque em 'Analisar' em qualquer item para a avaliação completa, ou use a busca com pontuação real (mais lenta, porém mais precisa).",
    }),
    { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
  );
};

export const config: Config = {
  path: "/.netlify/functions/buscar-lista",
};
