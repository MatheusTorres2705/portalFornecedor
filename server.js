// server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors({
  origin: '*', // ajuste para seu domínio em produção
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

const SANKHYA_URL = 'http://sankhya2.nxboats.com.br:8180';

// Servir estáticos
app.use('/pages', express.static(path.join(__dirname, 'pages')));
app.use('/style', express.static(path.join(__dirname, 'style')));
app.use(express.static(path.join(__dirname, 'public')));

// =====================================================
// LOGIN (retorna sessão e CODPARC do usuário)
// =====================================================
app.post('/api/login', async (req, res) => {
  const { usuario, senha } = req.body;
  if (!usuario || !senha) return res.status(400).json({ erro: 'Usuário e senha são obrigatórios.' });

  try {
    // LOGIN
    const response = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
      {
        serviceName: "MobileLoginSP.login",
        requestBody: {
          NOMUSU: { "$": usuario.toUpperCase() },
          INTERNO: { "$": senha },
          KEEPCONNECTED: { "$": "S" }
        }
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const jsessionid = response.data.responseBody?.jsessionid?.["$"];
    if (!jsessionid) throw new Error("Login inválido");

    // CONSULTA CODPARC (ajuste conforme seu dicionário)
    const consultaCodparc = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
      {
        serviceName: "DbExplorerSP.executeQuery",
        requestBody: {
          sql: `SELECT CODVEND as CODPARC FROM TSIUSU WHERE NOMEUSU = UPPER('${usuario}')`,
          outputType: "json"
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Cookie': `JSESSIONID=${jsessionid}`
        }
      }
    );

    const codparc = consultaCodparc.data.responseBody?.rows?.[0]?.[0];
    if (!codparc) throw new Error("CODPARC não encontrado");

    res.json({ sucesso: true, session: jsessionid, usuario, senha, codparc });
  } catch (err) {
    res.status(401).json({ erro: 'Falha no login' });
  }
});

// =====================================================
// ===== IA NXCopilot (foco COMPRAS com a sua VIEW) ====
// =====================================================
const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const GEMINI_MODEL = "gemini-1.5-flash";

// axios com timeout (usado nas helpers)
const axiosInstance = axios.create({ timeout: 20000, validateStatus: () => true });

// Login Sankhya → JSESSIONID
async function sankhyaLogin(usuario, senha) {
  const r = await axiosInstance.post(
    `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
    {
      serviceName: "MobileLoginSP.login",
      requestBody: {
        NOMUSU: { "$": String(usuario || "").toUpperCase() },
        INTERNO: { "$": String(senha || "") },
        KEEPCONNECTED: { "$": "S" }
      }
    },
    { headers: { "Content-Type": "application/json" } }
  );
  const jsessionid = r.data?.responseBody?.jsessionid?.["$"];
  if (!jsessionid) throw new Error("Falha no login Sankhya");
  return jsessionid;
}

// Executa SELECT e retorna rows (array de arrays)
async function sankhyaSQL(jsessionid, sql) {
  const payload = { serviceName: "DbExplorerSP.executeQuery", requestBody: { sql, outputType: "json" } };
  const r = await axiosInstance.post(
    `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
    payload,
    { headers: { "Content-Type": "application/json", Cookie: `JSESSIONID=${jsessionid}` } }
  );
  return r.data?.responseBody?.rows || [];
}

// Executa UPDATE
async function sankhyaExecUpdate(jsessionid, sqlUpdate) {
  const payload = { serviceName: "DbExplorerSP.executeUpdate", requestBody: { sql: { "$": sqlUpdate } } };
  const r = await axiosInstance.post(
    `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeUpdate&outputType=json`,
    payload,
    { headers: { "Content-Type": "application/json", Cookie: `JSESSIONID=${jsessionid}` } }
  );
  if (r.status !== 200) throw new Error(`Erro execUpdate HTTP ${r.status}`);
  return true;
}

// ==== Parsing pt-BR
function extrairNunota(texto) {
  if (!texto) return null;
  const mHash = texto.match(/#\s*(\d{3,})/);
  if (mHash) return mHash[1];
  const m = texto.match(/pedido\s*(?:n[úu]mero)?\s*(\d{3,})|nunota\s*(\d{3,})/i);
  return m ? (m[1] || m[2]) : null;
}
function extrairDataBR(texto) {
  if (!texto) return null;
  const m1 = texto.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m1) return `${m1[1]}/${m1[2]}/${m1[3]}`;
  const m2 = texto.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return `${m2[3]}/${m2[2]}/${m2[1]}`;
  return null;
}
function extrairCodprod(texto) {
  if (!texto) return null;
  const tag = texto.match(/\b([A-Z0-9][A-Z0-9\-_\.]{2,})\b/i);
  if (tag) return tag[1].toUpperCase();
  const num = texto.match(/codprod\s*[:\-]?\s*([A-Z0-9\-_\.]+)/i);
  return num ? num[1].toUpperCase() : null;
}
function toISODateBR(br) {
  const m = (br||'').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
function fmtBRL(n) {
  const v = Number(n || 0);
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// ==== Classificador de intenção (insensível a acentos)
function norm(s){
  return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
}
function detectarIntencao(msg) {
  const t = norm(msg);
  const has = (...xs)=> xs.some(x => t.includes(x));

  // Compras (VIEW)
  if (has('necessidad','reposicao','repor','sugest','comprar')) return { intent: 'necessidades_compra' };
  if (has('critic','cobertura','estoque minimo','seguranca','safety stock')) return { intent: 'itens_criticos' };
  if (has('status','posicao') && has('item','produto')) return { intent: 'status_item' };

  // Pedidos
  if (has('atrasad','vencid')) return { intent: 'pedidos_atrasados' };
  if (has('aberto','pendente','em aberto')) return { intent: 'pedidos_abertos' };
  if (has('recebid','entregue')) return { intent: 'pedidos_recebidos' };
  if (has('detalh','itens') && has('pedido','nunota','#')) return { intent: 'produtos_por_pedido' };
  if (has('alterar','mudar','editar') && has('previs','entrega')) return { intent: 'editar_previsao_pedido' };

  // Séries
  if (has('pedidos por mes','quantidade por mes')) return { intent: 'serie_pedidos_mes' };
  if (has('gastos por mes','compras por mes','valor por mes')) return { intent: 'serie_gastos_mes' };

  return { intent: 'fallback' };
}

// ============== SQL (usando a SUA VIEW) =================
// Estrutura esperada da view (colunas relevantes):
// CODPROD, DESCRPROD, LEADTIME, ESTOQUE, COMPRAPEN, EMPENHO,
// GIRODIARIO, COBERTURA, DTRUPTURA, DTMELHORPED, NECESSIDADE, NIVEL, CODGRUPOPROD, ...
function sqlViewNecessidades({ limitar = 20 }) {
  return `
    SELECT CODPROD, DESCRPROD, CODGRUPOPROD, ESTOQUE, GIRODIARIO, COBERTURA, LEADTIME,
           COMPRAPEN, EMPENHO, NECESSIDADE, DTRUPTURA, DTMELHORPED, NIVEL
    FROM VW_NX_ANALISE_COMPRAS
    WHERE NECESSIDADE > 0
    ORDER BY NECESSIDADE DESC, COBERTURA ASC
    FETCH FIRST ${limitar} ROWS ONLY
  `;
}
function sqlViewCriticos({ limitar = 20 }) {
  return `
    SELECT CODPROD, DESCRPROD, CODGRUPOPROD, ESTOQUE, GIRODIARIO, COBERTURA, LEADTIME,
           COMPRAPEN, EMPENHO, NECESSIDADE, DTRUPTURA, DTMELHORPED, NIVEL
    FROM VW_NX_ANALISE_COMPRAS
    WHERE COBERTURA < LEADTIME
    ORDER BY COBERTURA ASC, NECESSIDADE DESC
    FETCH FIRST ${limitar} ROWS ONLY
  `;
}
function sqlViewStatus(codprod) {
  return `
    SELECT CODPROD, DESCRPROD, ESTOQUE, GIRODIARIO, COBERTURA, LEADTIME,
           COMPRAPEN, EMPENHO, NECESSIDADE, DTRUPTURA, DTMELHORPED, NIVEL
    FROM VW_NX_ANALISE_COMPRAS
    WHERE CODPROD = '${codprod}'
  `;
}

// ======= Pedidos (mantidos como estavam, base TGFCAB/TGFITE)
function sqlPedidosBase({ status, limitar = 20, comprador = null }) {
  const filtroComprador = comprador ? `AND NVL(CAB.AD_COMPRADOR,'---') = '${comprador}'` : '';
  let where = `CAB.TIPMOV = 'C' ${filtroComprador}`;
  if (status === 'ATRASADOS') where += ` AND NVL(CAB.DTPREVENT, SYSDATE-1) < TRUNC(SYSDATE) AND CAB.STATUSNOTA <> 'L'`;
  if (status === 'ABERTOS') where += ` AND CAB.STATUSNOTA <> 'L'`;
  if (status === 'RECEBIDOS') where += ` AND CAB.STATUSNOTA = 'L'`;

  return `
    SELECT
      CAB.NUNOTA,
      PAR.RAZAOSOCIAL,
      TO_CHAR(CAB.DTNEG,'DD/MM/YYYY') AS EMISSAO,
      NVL(TO_CHAR(CAB.DTPREVENT,'DD/MM/YYYY'),'SEM PREV.') AS PREVISAO,
      SUM(ITE.VLRTOT) AS TOTAL
    FROM TGFCAB CAB
    JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
    JOIN TGFITE ITE ON ITE.NUNOTA = CAB.NUNOTA
    WHERE ${where}
    GROUP BY CAB.NUNOTA, PAR.RAZAOSOCIAL, CAB.DTNEG, CAB.DTPREVENT
    ORDER BY CAB.DTPREVENT NULLS FIRST, CAB.DTNEG DESC
    FETCH FIRST ${limitar} ROWS ONLY
  `;
}
function sqlItensDoPedido(nunota) {
  return `
    SELECT 
      ITE.CODPROD || ' - ' || PRO.DESCRPROD AS PRODUTO,
      ITE.QTDNEG - ITE.QTDENTREGUE AS QTD_PEND,
      ITE.CODVOL,
      ITE.VLRTOT,
      NVL(TO_CHAR(ITE.AD_DTENTREGA,'DD/MM/YYYY'),'SEM PREV.') AS PREV_ITEM
    FROM TGFITE ITE
    LEFT JOIN TGFPRO PRO ON PRO.CODPROD = ITE.CODPROD
    WHERE ITE.NUNOTA = ${Number(nunota)}
    ORDER BY (ITE.QTDNEG - ITE.QTDENTREGUE) DESC
  `;
}

// ================== Rota do chat ==================
app.post("/api/ai/chat", async (req, res) => {
  try {
    const { message, usuario, senha, history, comprador: compradorRaw } = req.body || {};
    if (!message || !usuario || !senha) {
      return res.status(400).json({ erro: "Parâmetros ausentes (message, usuario, senha)." });
    }

    const comprador = (compradorRaw || "").toString().toUpperCase().trim() || null;
    const { intent } = detectarIntencao(message);

    const nunota = extrairNunota(message);
    const dataBR = extrairDataBR(message);
    const codprod = extrairCodprod(message);

    // Intenções que acessam base
    if ([
      "necessidades_compra", "itens_criticos", "status_item",
      "pedidos_atrasados", "pedidos_abertos", "pedidos_recebidos",
      "produtos_por_pedido", "serie_pedidos_mes", "serie_gastos_mes"
    ].includes(intent)) {

      const jsession = await sankhyaLogin(usuario, senha);

      // === Necessidades (VIEW)
      if (intent === "necessidades_compra") {
        const rows = await sankhyaSQL(jsession, sqlViewNecessidades({ limitar: 20 }));
        const table = {
          columns: ["Cod", "Descrição", "Família", "Estoque", "Cons./Dia", "Cob.(d)", "LT(d)", "Em Trâns.", "Empenho", "Nec.", "Ruptura", "Melhor Ped.", "Nível"],
          rows: rows.map(r => [
            r[0], r[1], r[2],
            Number(r[3]), Number(r[4]), Number(r[5]), Number(r[6]),
            Number(r[7]), Number(r[8]), Number(r[9]),
            r[10] ? String(r[10]).slice(0,10) : '—',
            r[11] ? String(r[11]).slice(0,10) : '—',
            r[12]
          ])
          .filter(r => Number(r[9]) > 0) // só necessidade > 0
          .sort((a,b)=> Number(b[9]) - Number(a[9])) // ordena por NEC.
          .slice(0, 15)
        };
        return res.json({
          reply: `Sugestões de compra (top ${table.rows.length})${comprador ? ` — ${comprador}` : ""}:`,
          data: { table }
        });
      }

      // === Itens críticos (VIEW)
      if (intent === "itens_criticos") {
        const rows = await sankhyaSQL(jsession, sqlViewCriticos({ limitar: 20 }));
        const table = {
          columns: ["Cod", "Descrição", "Família", "Estoque", "Cons./Dia", "Cob.(d)", "LT(d)", "Em Trâns.", "Empenho", "Nec.", "Ruptura", "Melhor Ped.", "Nível"],
          rows: rows.map(r => [
            r[0], r[1], r[2],
            Number(r[3]), Number(r[4]), Number(r[5]), Number(r[6]),
            Number(r[7]), Number(r[8]), Number(r[9]),
            r[10] ? String(r[10]).slice(0,10) : '—',
            r[11] ? String(r[11]).slice(0,10) : '—',
            r[12]
          ])
        };
        return res.json({
          reply: `Itens críticos (cobertura < lead time)${comprador ? ` — ${comprador}` : ""}:`,
          data: { table }
        });
      }

      // === Status do item (VIEW)
      if (intent === "status_item") {
        if (!codprod) return res.json({ reply: "Qual o código do produto? Ex.: status do item PRO-001" });
        const rows = await sankhyaSQL(jsession, sqlViewStatus(codprod));
        if (!rows.length) return res.json({ reply: `Não encontrei o produto ${codprod}.` });
        const r = rows[0];
        const table = {
          columns: ["Cod", "Descrição", "Estoque", "Cons./Dia", "Cob.(d)", "LT(d)", "Em Trâns.", "Empenho", "Nec.", "Ruptura", "Melhor Ped.", "Nível"],
          rows: [[
            r[0], r[1],
            Number(r[2]), Number(r[3]), Number(r[4]), Number(r[5]),
            Number(r[6]), Number(r[7]), Number(r[8]),
            r[9] ? String(r[9]).slice(0,10) : '—',
            r[10] ? String(r[10]).slice(0,10) : '—',
            r[11]
          ]]
        };
        return res.json({ reply: `Status do item ${codprod}:`, data: { table } });
      }

      // === Pedidos
      if (intent === "pedidos_atrasados" || intent === "pedidos_abertos" || intent === "pedidos_recebidos") {
        const tipo = intent === "pedidos_atrasados" ? 'ATRASADOS' : (intent === "pedidos_recebidos" ? 'RECEBIDOS' : 'ABERTOS');
        const rows = await sankhyaSQL(jsession, sqlPedidosBase({ status: tipo, limitar: 30, comprador }));
        const table = {
          columns: ["NUNOTA", "Fornecedor", "Emissão", "Previsão", "Total"],
          rows: rows.map(r => [r[0], r[1], r[2], r[3], fmtBRL(r[4])])
        };
        return res.json({ reply: `Pedidos ${tipo.toLowerCase()}${comprador ? ` — ${comprador}` : ""}:`, data: { table } });
      }

      // === Itens do pedido
      if (intent === "produtos_por_pedido") {
        if (!nunota) return res.json({ reply: "Qual o NUNOTA do pedido? Ex.: itens do pedido #101567" });
        const rows = await sankhyaSQL(jsession, sqlItensDoPedido(nunota));
        if (!rows.length) return res.json({ reply: `Não encontrei itens para o pedido #${nunota}.` });
        const table = {
          columns: ["Produto", "Qtd pendente", "Un", "Valor", "Prev Entrega"],
          rows: rows.map(r => [r[0], Number(r[1]), r[2], fmtBRL(r[3]), r[4]])
        };
        return res.json({ reply: `Itens do pedido #${nunota}:`, data: { table } });
      }

      // === Séries (simples)
      if (intent === "serie_pedidos_mes") {
        const sql = `
          SELECT COUNT(DISTINCT CAB.NUNOTA) AS QTD, TO_CHAR(TRUNC(CAB.DTNEG,'MM'),'MM/YYYY') AS MES
          FROM TGFCAB CAB
          WHERE CAB.TIPMOV='C' ${comprador ? `AND NVL(CAB.AD_COMPRADOR,'---')='${comprador}'` : ""}
            AND CAB.DTNEG > TRUNC(ADD_MONTHS(SYSDATE,-12),'MM')
          GROUP BY TRUNC(CAB.DTNEG,'MM')
          ORDER BY TRUNC(CAB.DTNEG,'MM')
        `;
        const rows = await sankhyaSQL(jsession, sql);
        const series = rows.map(r => ({ mes: r[1], valor: Number(r[0]) || 0 }));
        return res.json({ reply: `Pedidos/mês${comprador ? ` — ${comprador}` : ""} (12m):`, data: { series } });
      }

      if (intent === "serie_gastos_mes") {
        const sql = `
          SELECT SUM(ITE.VLRTOT) AS VALOR, TO_CHAR(TRUNC(CAB.DTNEG,'MM'),'MM/YYYY') AS MES
          FROM TGFCAB CAB JOIN TGFITE ITE ON ITE.NUNOTA = CAB.NUNOTA
          WHERE CAB.TIPMOV='C' ${comprador ? `AND NVL(CAB.AD_COMPRADOR,'---')='${comprador}'` : ""}
            AND CAB.DTNEG > TRUNC(ADD_MONTHS(SYSDATE,-12),'MM')
          GROUP BY TRUNC(CAB.DTNEG,'MM')
          ORDER BY TRUNC(CAB.DTNEG,'MM')
        `;
        const rows = await sankhyaSQL(jsession, sql);
        const series = rows.map(r => ({ mes: r[1], valor: Number(r[0]) || 0 }));
        return res.json({ reply: `Gastos/mês${comprador ? ` — ${comprador}` : ""} (12m):`, data: { series } });
      }
    }

    // === Alterar previsão (confirmação)
    if (intent === "editar_previsao_pedido") {
      const n = nunota || "(faltando NUNOTA)";
      const d = dataBR || "(faltando data)";
      return res.json({
        reply: `Confirma alterar a previsão do pedido #${n} para ${d}?`,
        confirmationRequired: true,
        action: { type: "editar_previsao_pedido", nunota, novaData: dataBR }
      });
    }

    // === Fallback (Gemini opcional)
    const systemPrompt = `
Você é um copiloto de COMPRAS da NX Boats. Responda em pt-BR, objetivo e prático.
Nunca diga "não tenho acesso". Se faltar dado, peça o que falta (usuário, senha, NUNOTA) ou sugira: /criticos, /necessidades, /atrasados, /itens 101567, /previsao 101234 10/09/2025.
Foque em: itens críticos, necessidades, pedidos (atrasados/abertos/recebidos), itens do pedido e alteração de previsão.
`.trim();

    if (!process.env.GOOGLE_API_KEY) {
      return res.json({ reply: `Posso listar *itens críticos*, *necessidades de compra*, *pedidos atrasados/abertos/recebidos*, *itens do pedido #N* e *alterar previsão do #N*.` });
    }

    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: systemPrompt });
    const geminiHistory = Array.isArray(history)
      ? history.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }))
      : [];
    const chat = model.startChat({ history: geminiHistory });
    const prefix = `Comprador: ${comprador || "(não informado)"}\nPergunta: `;
    const r = await chat.sendMessage(prefix + message);
    const reply = r.response?.text?.() || "Não consegui gerar resposta agora.";
    return res.json({ reply });

  } catch (err) {
    console.error("Falha /api/ai/chat:", err?.response?.data || err.message);
    return res.status(500).json({ erro: "Falha na IA", detalhe: err?.response?.data || err.message });
  }
});

// Confirmar alteração de previsão (usado pelo front)
app.post("/api/ai/confirmar-previsao", async (req, res) => {
  try {
    const { usuario, senha, nunota, novaData } = req.body || {};
    if (!usuario || !senha || !nunota || !novaData) {
      return res.status(400).json({ erro: "Parâmetros ausentes (usuario, senha, nunota, novaData)." });
    }
    const iso = toISODateBR(novaData);
    if (!iso) return res.status(400).json({ erro: "Data inválida. Use dd/mm/aaaa." });

    const jsession = await sankhyaLogin(usuario, senha);
    const sqlUpdate = `UPDATE TGFCAB SET DTPREVENT = TO_DATE('${novaData}','DD/MM/YYYY') WHERE NUNOTA = ${Number(nunota)}`;
    await sankhyaExecUpdate(jsession, sqlUpdate);

    return res.json({ ok: true, reply: `Previsão do pedido #${nunota} atualizada para ${novaData}.` });
  } catch (err) {
    console.error("Falha confirmar-previsao:", err?.response?.data || err.message);
    return res.status(500).json({ erro: "Falha ao atualizar previsão", detalhe: err?.response?.data || err.message });
  }
});

// =====================================================
// ====== DEMAIS ROTAS (mantidas do seu backend) =======
// =====================================================

// Função utilitária para SELECT simples (usada nos gráficos)
async function consultaSQL(usuario, senha, sql) {
  const loginResponse = await axios.post(
    `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
    {
      serviceName: "MobileLoginSP.login",
      requestBody: { NOMUSU: { "$": usuario }, INTERNO: { "$": senha }, KEEPCONNECTED: { "$": "S" } }
    },
    { headers: { 'Content-Type': 'application/json' } }
  );
  const sessionId = loginResponse.data.responseBody?.jsessionid?.["$"];
  if (!sessionId) throw new Error("Falha no login para consulta SQL");

  const response = await axios.post(
    `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
    { serviceName: "DbExplorerSP.executeQuery", requestBody: { sql, outputType: "json" } },
    { headers: { 'Content-Type': 'application/json', 'Cookie': `JSESSIONID=${sessionId}` } }
  );

  return response.data.responseBody?.rows.map(row => ({
    VALOR: parseInt(row[0]),
    MES: row[1]
  })) || [];
}

// ------------------ PEDIDOS ------------------
app.post('/api/pedidos', async (req, res) => {
  const { usuario, senha, codparc } = req.body;
  if (!usuario || !senha || !codparc) {
    return res.status(400).json({ erro: "Credenciais ausentes" });
  }

  try {
    const loginResponse = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
      {
        serviceName: "MobileLoginSP.login",
        requestBody: { NOMUSU: { "$": usuario }, INTERNO: { "$": senha }, KEEPCONNECTED: { "$": "S" } }
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const sessionId = loginResponse.data.responseBody?.jsessionid?.["$"];

    const sql = `
      SELECT 
        CAB.NUNOTA,
        TO_CHAR(CAB.DTNEG,'DD/MM/YYYY') AS DTNEG,
        SUM(ITE.QTDNEG - ITE.QTDENTREGUE) AS QTDLIQ,
        CAB.VLRNOTA,
        CASE 
            WHEN SUM(ITE.QTDNEG - ITE.QTDENTREGUE) = 0 THEN 'ENTREGUE'
            WHEN CAB.DTPREVENT < SYSDATE THEN 'ATRASADO'
            ELSE 'PENDENTE'
        END AS STATUS,
        NVL(TO_CHAR(CAB.DTPREVENT, 'DD/MM/YYYY'),'SEM PREV.') AS AD_DTENTREGA
      FROM TGFCAB CAB
      INNER JOIN TGFITE ITE ON CAB.NUNOTA = ITE.NUNOTA
      LEFT JOIN TGFPRO PRO ON PRO.CODPROD = ITE.CODPROD
      LEFT JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
      WHERE PAR.CODPARC = ${codparc}
      GROUP BY CAB.NUNOTA, CAB.DTNEG, CAB.VLRNOTA, CAB.DTPREVENT
      ORDER BY CAB.DTNEG DESC
    `;

    const response = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
      { serviceName: "DbExplorerSP.executeQuery", requestBody: { sql, outputType: "json" } },
      { headers: { 'Content-Type': 'application/json', 'Cookie': `JSESSIONID=${sessionId}` } }
    );

    const pedidos = response.data.responseBody?.rows.map(row => ({
      NUNOTA: row[0],
      DTNEG: row[1],
      QTDLIQ: row[2],
      VLRNOTA: row[3],
      STATUS: row[4],
      AD_DTENTREGA: row[5],
    })) || [];

    res.json(pedidos);
  } catch (error) {
    console.error("Erro ao buscar pedidos:", error.message);
    res.status(500).json({ erro: "Erro ao buscar pedidos" });
  }
});

// ------------------ PRODUTOS (TOP 15 pendentes) ------------------
app.post('/api/produtos', async (req, res) => {
  const { usuario, senha, codparc } = req.body;

  if (!usuario || !senha || !codparc) {
    return res.status(400).json({ erro: 'Credenciais ausentes. Faça login novamente.' });
  }

  try {
    const loginResponse = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
      {
        serviceName: "MobileLoginSP.login",
        requestBody: { NOMUSU: { "$": usuario }, INTERNO: { "$": senha }, KEEPCONNECTED: { "$": "S" } }
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const jsessionid = loginResponse.data.responseBody?.jsessionid?.["$"];
    if (!jsessionid) throw new Error("Erro ao obter sessão.");

    const sql = `
      SELECT *
      FROM (
        SELECT 
          ITE.NUNOTA,
          PRO.CODPROD || ' - ' || PRO.DESCRPROD AS PRODUTO,
          ITE.QTDNEG - ITE.QTDENTREGUE AS QTDLIQ,
          ITE.VLRTOT,
          CASE WHEN ITE.PENDENTE = 'S' THEN 'PENDENTE' ELSE 'PARCIAL' END AS STATUS,
          NVL(TO_CHAR(ITE.AD_DTENTREGA, 'DD/MM/YYYY'),'SEM PREV.') AS AD_DTENTREGA,
          'http://sankhya.nxboats.com.br:8180/mge/Produto@IMAGEM@CODPROD='||PRO.CODPROD||'.dbimage' AS IMAGEM
        FROM TGFITE ITE
        INNER JOIN TGFCAB CAB ON CAB.NUNOTA = ITE.NUNOTA
        LEFT JOIN TGFPRO PRO ON PRO.CODPROD = ITE.CODPROD
        LEFT JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
        WHERE PAR.CODPARC = ${codparc} 
          AND ITE.QTDNEG - ITE.QTDENTREGUE <> 0
        ORDER BY CAB.DTNEG DESC , ITE.VLRTOT DESC
      )
      WHERE ROWNUM <= 15
    `;

    const response = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
      { serviceName: "DbExplorerSP.executeQuery", requestBody: { sql, outputType: "json" } },
      { headers: { 'Content-Type': 'application/json', 'Cookie': `JSESSIONID=${jsessionid}` } }
    );

    const produtos = response.data.responseBody?.rows.map(row => ({
      NUNOTA: row[0],
      PRODUTO: row[1],
      QTDLIQ: row[2],
      VLRTOT: row[3],
      STATUS: row[4],
      AD_DTENTREGA: row[5],
      IMAGEM: row[6]
    })) || [];

    res.json(produtos);
  } catch (err) {
    console.error("Erro ao buscar produtos:", err.message);
    res.status(500).json({ erro: 'Erro ao buscar produtos', detalhes: err.message });
  }
});

// ------------------ PRODUTOS (todos) ------------------
app.post('/api/produtos/all', async (req, res) => {
  const { usuario, senha, codparc } = req.body;

  if (!usuario || !senha || !codparc) {
    return res.status(400).json({ erro: 'Credenciais ausentes. Faça login novamente.' });
  }

  try {
    const loginResponse = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
      {
        serviceName: "MobileLoginSP.login",
        requestBody: { NOMUSU: { "$": usuario }, INTERNO: { "$": senha }, KEEPCONNECTED: { "$": "S" } }
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const jsessionid = loginResponse.data.responseBody?.jsessionid?.["$"];
    if (!jsessionid) throw new Error("Erro ao obter sessão.");

    const sql = `
      SELECT
        PRO.CODPROD || ' - ' || PRO.DESCRPROD AS PRODUTO,
        SUM(ITE.QTDNEG - ITE.QTDENTREGUE) AS QTDLIQ,
        SUM(ITE.VLRTOT) AS VALOR_TOTAL,
        CASE WHEN ITE.PENDENTE = 'S' THEN 'PENDENTE' ELSE 'PARCIAL' END AS STATUS,
        COALESCE(TO_CHAR(ITE.AD_DTENTREGA, 'DD/MM/YYYY'), 'SEM PREV.') AS AD_DTENTREGA,
        'http://sankhya.nxboats.com.br:8180/mge/Produto@IMAGEM@CODPROD=' || PRO.CODPROD || '.dbimage' AS IMAGEM
      FROM TGFITE ITE
      INNER JOIN TGFCAB CAB ON CAB.NUNOTA = ITE.NUNOTA
      LEFT JOIN TGFPRO PRO ON PRO.CODPROD = ITE.CODPROD
      LEFT JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
      WHERE PAR.CODPARC = ${codparc}
        AND (ITE.QTDNEG - ITE.QTDENTREGUE) <> 0
      GROUP BY 
        PRO.CODPROD, PRO.DESCRPROD,
        CASE WHEN ITE.PENDENTE = 'S' THEN 'PENDENTE' ELSE 'PARCIAL' END,
        TO_CHAR(ITE.AD_DTENTREGA, 'DD/MM/YYYY')
      ORDER BY 
        MAX(CAB.DTNEG) DESC,
        SUM(ITE.VLRTOT) DESC
    `;

    const response = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
      { serviceName: "DbExplorerSP.executeQuery", requestBody: { sql, outputType: "json" } },
      { headers: { 'Content-Type': 'application/json', 'Cookie': `JSESSIONID=${jsessionid}` } }
    );

    const produtos = response.data.responseBody?.rows.map(row => ({
      PRODUTO: row[0],
      QTDLIQ: row[1],
      VLRTOT: row[2],
      STATUS: row[3],
      AD_DTENTREGA: row[4],
      IMAGEM: row[5]
    })) || [];

    res.json(produtos);
  } catch (err) {
    console.error("Erro ao buscar todos os produtos:", err.message);
    res.status(500).json({ erro: 'Erro ao buscar todos os produtos', detalhes: err.message });
  }
});

// ------------------ Cards/KPIs ------------------
app.get('/api/pedidos-mes', async (req, res) => {
  const { usuario, senha, codparc } = req.query;
  if (!usuario || !senha || !codparc) {
    return res.status(400).json({ erro: "Credenciais ausentes" });
  }
  try {
    const loginResponse = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
      { serviceName: "MobileLoginSP.login", requestBody: { NOMUSU: { "$": usuario }, INTERNO: { "$": senha }, KEEPCONNECTED: { "$": "S" } } },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const sessionId = loginResponse.data.responseBody?.jsessionid?.["$"];
    const sql = `
      SELECT COUNT(CAB.NUNOTA) AS QTD
      FROM TGFCAB CAB
      LEFT JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
      WHERE PAR.CODVEND = ${codparc}
        AND TO_CHAR(DTNEG, 'MM/YYYY') = TO_CHAR(SYSDATE,'MM/YYYY')
    `;
    const response = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
      { serviceName: "DbExplorerSP.executeQuery", requestBody: { sql, outputType: "json" } },
      { headers: { 'Content-Type': 'application/json', 'Cookie': `JSESSIONID=${sessionId}` } }
    );
    const quantidade = response.data.responseBody?.rows?.[0]?.[0] || 0;
    res.json({ quantidade });
  } catch (error) {
    console.error("Erro ao buscar pedidos do mês:", error.message);
    res.status(500).json({ erro: "Erro ao buscar pedidos do mês" });
  }
});

app.get('/api/pedidos-atrasados', async (req, res) => {
  const { usuario, senha, codparc } = req.query;
  if (!usuario || !senha || !codparc) {
    return res.status(400).json({ erro: "Credenciais ausentes" });
  }
  try {
    const loginResponse = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
      { serviceName: "MobileLoginSP.login", requestBody: { NOMUSU: { "$": usuario }, INTERNO: { "$": senha }, KEEPCONNECTED: { "$": "S" } } },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const sessionId = loginResponse.data.responseBody?.jsessionid?.["$"];
    const sql = `
      SELECT COUNT(DISTINCT CAB.NUNOTA) AS QTD
      FROM TGFCAB CAB
      LEFT JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
      WHERE PAR.CODVEND = ${codparc} 
        AND CAB.PENDENTE = 'S'
        AND CAB.TIPMOV = 'O'
        AND (CAB.DTPREVENT < SYSDATE OR CAB.DTPREVENT IS NULL)
    `;
    const response = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
      { serviceName: "DbExplorerSP.executeQuery", requestBody: { sql, outputType: "json" } },
      { headers: { 'Content-Type': 'application/json', 'Cookie': `JSESSIONID=${sessionId}` } }
    );
    const quantidade = response.data.responseBody?.rows?.[0]?.[0] || 0;
    res.json({ quantidade });
  } catch (error) {
    console.error("Erro ao buscar pedidos do atrasados:", error.message);
    res.status(500).json({ erro: "Erro ao buscar pedidos do atrasados" });
  }
});

app.get('/api/pedidos-prazo', async (req, res) => {
  const { usuario, senha, codparc } = req.query;
  if (!usuario || !senha || !codparc) {
    return res.status(400).json({ erro: "Credenciais ausentes" });
  }
  try {
    const loginResponse = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
      { serviceName: "MobileLoginSP.login", requestBody: { NOMUSU: { "$": usuario }, INTERNO: { "$": senha }, KEEPCONNECTED: { "$": "S" } } },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const sessionId = loginResponse.data.responseBody?.jsessionid?.["$"];
    const sql = `
      SELECT COUNT(DISTINCT CAB.NUNOTA) AS QTD
      FROM TGFCAB CAB
      LEFT JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
      WHERE PAR.CODVEND = ${codparc} 
        AND (CAB.DTPREVENT >= SYSDATE)
    `;
    const response = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
      { serviceName: "DbExplorerSP.executeQuery", requestBody: { sql, outputType: "json" } },
      { headers: { 'Content-Type': 'application/json', 'Cookie': `JSESSIONID=${sessionId}` } }
    );
    const quantidade = response.data.responseBody?.rows?.[0]?.[0] || 0;
    res.json({ quantidade });
  } catch (error) {
    console.error("Erro ao buscar pedidos no prazo:", error.message);
    res.status(500).json({ erro: "Erro ao buscar pedidos no prazo" });
  }
});

app.get('/api/pedidos-vencer', async (req, res) => {
  const { usuario, senha, codparc } = req.query;
  if (!usuario || !senha || !codparc) {
    return res.status(400).json({ erro: "Credenciais ausentes" });
  }
  try {
    const loginResponse = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
      { serviceName: "MobileLoginSP.login", requestBody: { NOMUSU: { "$": usuario }, INTERNO: { "$": senha }, KEEPCONNECTED: { "$": "S" } } },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const sessionId = loginResponse.data.responseBody?.jsessionid?.["$"];
    const sql = `
      SELECT COUNT(DISTINCT CAB.NUNOTA) AS QTD
      FROM TGFCAB CAB
      LEFT JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
      WHERE PAR.CODVEND = ${codparc} 
        AND (CAB.DTPREVENT >= SYSDATE-10)
    `;
    const response = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
      { serviceName: "DbExplorerSP.executeQuery", requestBody: { sql, outputType: "json" } },
      { headers: { 'Content-Type': 'application/json', 'Cookie': `JSESSIONID=${sessionId}` } }
    );
    const quantidade = response.data.responseBody?.rows?.[0]?.[0] || 0;
    res.json({ quantidade });
  } catch (error) {
    console.error("Erro ao buscar pedidos a vencer:", error.message);
    res.status(500).json({ erro: "Erro ao buscar pedidos a vencer" });
  }
});

// ------------------ Gráficos ------------------
app.post('/api/grafico-vendas', async (req, res) => {
  const { usuario, senha, codparc } = req.body;
  if (!usuario || !senha || !codparc) {
    return res.status(400).json({ erro: "Credenciais ausentes" });
  }
  try {
    const loginResponse = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
      { serviceName: "MobileLoginSP.login", requestBody: { NOMUSU: { "$": usuario }, INTERNO: { "$": senha }, KEEPCONNECTED: { "$": "S" } } },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const sessionId = loginResponse.data.responseBody?.jsessionid?.["$"];
    const sql = `
      SELECT 
        SUM(CAB.VLRNOTA) as VALOR,
        TO_CHAR(TRUNC(CAB.DTNEG, 'MM'), 'MM/YYYY') AS MES
      FROM TGFCAB CAB
      INNER JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
      WHERE CAB.TIPMOV = 'O'
        AND CAB.STATUSNOTA = 'L'
        AND CAB.DTNEG > TRUNC(SYSDATE - 365)
        AND PAR.CODVEND = ${codparc}
      GROUP BY TRUNC(CAB.DTNEG, 'MM'), PAR.CODPARC
      ORDER BY TRUNC(CAB.DTNEG, 'MM')
    `;
    const response = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
      { serviceName: "DbExplorerSP.executeQuery", requestBody: { sql, outputType: "json" } },
      { headers: { 'Content-Type': 'application/json', 'Cookie': `JSESSIONID=${sessionId}` } }
    );
    const dados = response.data.responseBody?.rows.map(row => ({ valor: parseFloat(row[0]), mes: row[1] })) || [];
    res.json(dados);
  } catch (error) {
    console.error("Erro ao buscar dados do gráfico:", error.message);
    res.status(500).json({ erro: "Erro ao buscar dados do gráfico" });
  }
});

app.get("/api/pedidos-por-mes", async (req, res) => {
  const { usuario, senha, codparc } = req.query;
  try {
    const sql = `
      SELECT 
        COUNT(DISTINCT CAB.NUNOTA) as VALOR,
        TO_CHAR(TRUNC(CAB.DTNEG, 'MM'), 'MM/YYYY') AS MES
      FROM TGFCAB CAB
      INNER JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
      WHERE CAB.TIPMOV = 'O'
        AND CAB.STATUSNOTA = 'L'
        AND CAB.DTNEG > TRUNC(SYSDATE - 365)
        AND PAR.CODVEND = ${codparc}
      GROUP BY TRUNC(CAB.DTNEG, 'MM'), PAR.CODPARC
      ORDER BY TRUNC(CAB.DTNEG, 'MM')
    `;
    const dados = await consultaSQL(usuario, senha, sql);
    const resultados = dados.map(row => ({ mes: row.MES, valor: row.VALOR }));
    res.json(resultados);
  } catch (err) {
    console.error("Erro ao buscar pedidos por mês:", err);
    res.status(500).json({ erro: "Erro ao buscar dados" });
  }
});

// ------------------ Itens por pedido ------------------
app.get('/api/produtos-por-pedido', async (req, res) => {
  const { usuario, senha, nunota } = req.query;

  if (!usuario || !senha || !nunota) {
    return res.status(400).json({ erro: 'Parâmetros ausentes.' });
  }

  try {
    const loginResponse = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
      { serviceName: "MobileLoginSP.login", requestBody: { NOMUSU: { "$": usuario }, INTERNO: { "$": senha }, KEEPCONNECTED: { "$": "S" } } },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const jsessionid = loginResponse.data.responseBody?.jsessionid?.["$"];
    if (!jsessionid) throw new Error("Falha no login");

    const sql = `
      SELECT 
        ITE.NUNOTA,
        PRO.CODPROD || ' - ' || PRO.DESCRPROD AS PRODUTO,
        ITE.QTDNEG - ITE.QTDENTREGUE AS QTDLIQ,
        ITE.VLRTOT,
        CASE WHEN ITE.PENDENTE = 'S' THEN 'PENDENTE' ELSE 'PARCIAL' END AS STATUS,
        NVL(TO_CHAR(ITE.AD_DTENTREGA, 'DD/MM/YYYY'),'SEM PREV.') AS AD_DTENTREGA,
        'http://sankhya.nxboats.com.br:8180/mge/Produto@IMAGEM@CODPROD='||PRO.CODPROD||'.dbimage' AS IMAGEM
      FROM TGFITE ITE
      INNER JOIN TGFCAB CAB ON CAB.NUNOTA = ITE.NUNOTA
      LEFT JOIN TGFPRO PRO ON PRO.CODPROD = ITE.CODPROD
      WHERE ITE.NUNOTA = ${Number(nunota)}
    `;

    const response = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
      { serviceName: "DbExplorerSP.executeQuery", requestBody: { sql, outputType: "json" } },
      { headers: { 'Content-Type': 'application/json', 'Cookie': `JSESSIONID=${jsessionid}` } }
    );

    const produtos = response.data.responseBody?.rows.map(row => ({
      NUNOTA: row[0],
      PRODUTO: row[1],
      QTDLIQ: row[2],
      VLRTOT: row[3],
      STATUS: row[4],
      AD_DTENTREGA: row[5],
      IMAGEM: row[6]
    })) || [];

    res.json(produtos);
  } catch (error) {
    console.error("Erro ao buscar produtos do pedido:", error.message);
    res.status(500).json({ erro: "Erro ao buscar produtos do pedido" });
  }
});

// ------------------ Pedidos por comprador ------------------
app.get('/api/pedido-comprador', async (req, res) => {
  const { usuario, senha, comprador } = req.query;

  if (!usuario || !senha || !comprador) {
    return res.status(400).json({ erro: 'Parâmetros ausentes.' });
  }

  try {
    const loginResponse = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
      { serviceName: "MobileLoginSP.login", requestBody: { NOMUSU: { "$": usuario }, INTERNO: { "$": senha }, KEEPCONNECTED: { "$": "S" } } },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const jsessionid = loginResponse.data.responseBody?.jsessionid?.["$"];
    if (!jsessionid) throw new Error("Falha no login");

    const sql = `
      SELECT 
        CAB.NUNOTA,
        PAR.CODPARC || ' - ' || PAR.NOMEPARC AS NOMEFOR,
        CAB.VLRNOTA AS VALOR,
        CASE WHEN CAB.PENDENTE = 'S' THEN 'PENDENTE' ELSE 'PARCIAL' END AS STATUS,
        NVL(TO_CHAR(CAB.DTPREVENT, 'DD/MM/YYYY'),'SEM PREV.') AS AD_DTENTREGA,
        CAB.DTPREVENT - SYSDATE AS DIASATRASO
      FROM TGFITE ITE
      INNER JOIN TGFCAB CAB ON CAB.NUNOTA = ITE.NUNOTA
      LEFT JOIN TGFPRO PRO ON PRO.CODPROD = ITE.CODPROD
      JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
      WHERE NVL(CAB.AD_COMPRADOR,'---') = '${comprador}'
        AND CAB.TIPMOV = 'C'
        AND CAB.PENDENTE = 'S'
    `;

    const response = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
      { serviceName: "DbExplorerSP.executeQuery", requestBody: { sql, outputType: "json" } },
      { headers: { 'Content-Type': 'application/json', 'Cookie': `JSESSIONID=${jsessionid}` } }
    );

    const produtos = response.data.responseBody?.rows.map(row => ({
      NUNOTA: row[0],
      FORNECEDOR: row[1],
      VALOR: row[2],
      STATUS: row[3],
      AD_DTENTREGA: row[4],
      DIASATRASO: row[5]
    })) || [];

    res.json(produtos);
  } catch (error) {
    console.error("Erro ao buscar produtos do pedido:", error.message);
    res.status(500).json({ erro: "Erro ao buscar produtos do pedido" });
  }
});

// ------------------ Financeiro ------------------
app.post('/api/financeiro', async (req, res) => {
  const { usuario, senha, codparc } = req.body;

  if (!usuario || !senha || !codparc) {
    return res.status(400).json({ erro: 'Credenciais ausentes. Faça login novamente.' });
  }

  try {
    const loginResponse = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
      { serviceName: "MobileLoginSP.login", requestBody: { NOMUSU: { "$": usuario }, INTERNO: { "$": senha }, KEEPCONNECTED: { "$": "S" } } },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const jsessionid = loginResponse.data.responseBody?.jsessionid?.["$"];
    if (!jsessionid) throw new Error("Erro ao obter sessão.");

    const sql = `
      SELECT
        FIN.NUMNOTA,
        FIN.NUFIN,
        TO_CHAR(FIN.DTNEG, 'DD/MM/YYYY') AS DTNEG,
        TO_CHAR(FIN.DTVENC, 'DD/MM/YYYY') AS DTVENC,
        TO_CHAR(FIN.DHBAIXA, 'DD/MM/YYYY') AS DHBAIXA,
        FIN.VLRDESDOB,
        NVL(FIN.VLRBAIXA, 0) AS VLRBAIXA,
        FIN.CODTIPTIT || ' - ' || NVL(TIT.DESCRTIPTIT, 'SEM TIPO') AS TIPTITLO,
        CASE
          WHEN FIN.DTVENC < SYSDATE AND FIN.DHBAIXA IS NULL THEN 'ATRASADO'
          WHEN FIN.DTVENC > SYSDATE AND FIN.DHBAIXA IS NULL THEN 'A PAGAR'
          WHEN FIN.DHBAIXA IS NOT NULL THEN 'PAGO'
        END AS STATUS
      FROM TGFFIN FIN
      INNER JOIN TGFPAR PAR ON PAR.CODPARC = FIN.CODPARC
      LEFT JOIN TGFTIT TIT ON TIT.CODTIPTIT = FIN.CODTIPTIT
      WHERE PAR.CODVEND = ${codparc}
        AND FIN.CODTIPTIT <> 29
      ORDER BY FIN.DTVENC DESC
    `;

    const response = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
      { serviceName: "DbExplorerSP.executeQuery", requestBody: { sql, outputType: "json" } },
      { headers: { 'Content-Type': 'application/json', 'Cookie': `JSESSIONID=${jsessionid}` } }
    );

    const parcelas = response.data.responseBody?.rows.map(row => ({
      NUMNOTA: row[0],
      NUFIN: row[1],
      DTNEG: row[2],
      DTVENC: row[3],
      DHBAIXA: row[4],
      VLRDESDOB: parseFloat(row[5] || 0),
      VLRBAIXA: parseFloat(row[6] || 0),
      TIPTITLO: row[7],
      STATUS: row[8]
    })) || [];

    res.json(parcelas);
  } catch (err) {
    console.error("Erro ao buscar financeiro:", err.message);
    res.status(500).json({ erro: 'Erro ao buscar financeiro', detalhes: err.message });
  }
});

// ------------------ Editar pedido (DatasetSP.save) ------------------
app.post('/api/editar-pedido', async (req, res) => {
  const { usuario, senha, nunota, novaDataEntrega, novaObs } = req.body;
  if (!usuario || !senha || !nunota || !novaDataEntrega) {
    return res.status(400).json({ erro: "Campos obrigatórios ausentes: usuario, senha, nunota, novaDataEntrega" });
  }
  try {
    const loginResponse = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
      { serviceName: "MobileLoginSP.login", requestBody: { NOMUSU: { "$": usuario }, INTERNO: { "$": senha }, KEEPCONNECTED: { "$": "S" } } },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const jsessionid = loginResponse.data.responseBody?.jsessionid?.["$"];
    if (!jsessionid) throw new Error("Erro ao obter sessão.");

    const [ano, mes, dia] = novaDataEntrega.split("-");
    const dataFormatada = `${dia}/${mes}/${ano}`;

    const payload = {
      serviceName: "DatasetSP.save",
      requestBody: {
        entityName: "CabecalhoNota",
        fields: ["DTPREVENT", "AD_OBSFORNDT"],
        records: [
          { pk: { NUNOTA: nunota }, values: { "0": dataFormatada, "1": novaObs || "" } }
        ]
      }
    };

    const editarResponse = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=DatasetSP.save&outputType=json`,
      payload,
      { headers: { 'Content-Type': 'application/json', 'Cookie': `JSESSIONID=${jsessionid}` } }
    );

    res.status(200).json({ sucesso: true, dados: editarResponse.data });
  } catch (error) {
    console.error("Erro ao editar pedido:", JSON.stringify(error?.response?.data || error.message, null, 2));
    res.status(500).json({ erro: "Erro ao editar pedido", detalhes: error?.response?.data || error.message });
  }
});

// ------------------ Imprimir pedido (PDF) ------------------
app.post('/api/imprimir-pedido', async (req, res) => {
  const { usuario, senha, nunota } = req.body;

  try {
    const loginResponse = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
      { serviceName: "MobileLoginSP.login", requestBody: { NOMUSU: { "$": usuario }, INTERNO: { "$": senha }, KEEPCONNECTED: { "$": "S" } } },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const jsessionid = loginResponse.data.responseBody?.jsessionid?.["$"];
    if (!jsessionid) throw new Error("Erro ao obter sessão");

    const gerarRelatorioPayload = {
      serviceName: "VisualizadorRelatorios.visualizarRelatorio",
      requestBody: {
        relatorio: {
          nuRfe: "1", // ajuste para o RFE correto
          isApp: "N",
          nuApp: 1,
          parametros: {
            parametro: [{ classe: "java.math.BigDecimal", nome: "NUNOTA", valor: nunota }]
          }
        }
      }
    };

    const gerarResp = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=VisualizadorRelatorios.visualizarRelatorio&outputType=json`,
      gerarRelatorioPayload,
      { headers: { 'Content-Type': 'application/json', 'Cookie': `JSESSIONID=${jsessionid}` } }
    );

    const chaveArquivo = gerarResp.data?.responseBody?.chave?.valor;
    if (!chaveArquivo) return res.status(500).json({ erro: "Falha ao obter chave do arquivo." });

    const downloadResp = await axios.get(
      `${SANKHYA_URL}/mge/visualizadorArquivos.mge?hidemail=S&download=S&chaveArquivo=${chaveArquivo}`,
      { headers: { 'Cookie': `JSESSIONID=${jsessionid}` }, responseType: 'arraybuffer' }
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.send(downloadResp.data);
  } catch (error) {
    console.error("Erro ao gerar/baixar relatório:", error?.response?.data || error.message);
    res.status(500).json({ erro: "Erro ao gerar/baixar relatório" });
  }
});

// ------------------ Dados da conta ------------------
app.post('/api/conta', async (req, res) => {
  const { usuario, senha, codparc } = req.body;

  if (!usuario || !senha || !codparc) {
    return res.status(400).json({ erro: 'Credenciais ausentes. Faça login novamente.' });
  }

  try {
    const loginResponse = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
      { serviceName: "MobileLoginSP.login", requestBody: { NOMUSU: { "$": usuario }, INTERNO: { "$": senha }, KEEPCONNECTED: { "$": "S" } } },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const jsessionid = loginResponse.data.responseBody?.jsessionid?.["$"];
    if (!jsessionid) throw new Error("Erro ao obter sessão.");

    const sql = `
      SELECT
        PAR.NOMEPARC,
        PAR.TIPPESSOA,
        PAR.RAZAOSOCIAL,
        PAR.TELEFONE,
        PAR.CGC_CPF,
        ENDR.NOMEEND,
        BAI.NOMEBAI,
        CID.NOMECID,
        UFS.UF,
        PAR.CEP
      FROM TGFPAR PAR
      LEFT JOIN TSIEND ENDR ON ENDR.CODEND = PAR.CODEND
      LEFT JOIN TSIBAI BAI ON BAI.CODBAI = PAR.CODBAI
      LEFT JOIN TSICID CID ON CID.CODCID = PAR.CODCID
      LEFT JOIN TSIUFS UFS ON UFS.CODUF = PAR.AD_CODUFVENDA
      WHERE PAR.CODVEND = ${codparc}
    `;

    const response = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
      { serviceName: "DbExplorerSP.executeQuery", requestBody: { sql, outputType: "json" } },
      { headers: { 'Content-Type': 'application/json', 'Cookie': `JSESSIONID=${jsessionid}` } }
    );

    const row = response.data.responseBody?.rows?.[0];
    if (!row) return res.status(404).json({ erro: "Parceiro não encontrado." });

    const dados = {
      NOMEPARC: row[0],
      TIPPESSOA: row[1],
      RAZAOSOCIAL: row[2],
      TELEFONE: row[3],
      CGC_CPF: row[4],
      NOMEEND: row[5],
      NOMEBAI: row[6],
      NOMECID: row[7],
      UF: row[8],
      CEP: row[9]
    };

    res.json(dados);
  } catch (err) {
    console.error("Erro ao buscar dados da conta:", err.message);
    res.status(500).json({ erro: 'Erro ao buscar dados da conta', detalhes: err.message });
  }
});

// ------------------ Contatos ------------------
app.post('/api/contatos', async (req, res) => {
  const { usuario, senha, codparc } = req.body;

  if (!usuario || !senha || !codparc) {
    return res.status(400).json({ erro: 'Credenciais ausentes. Faça login novamente.' });
  }

  try {
    const loginResponse = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
      { serviceName: "MobileLoginSP.login", requestBody: { NOMUSU: { "$": usuario }, INTERNO: { "$": senha }, KEEPCONNECTED: { "$": "S" } } },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const jsessionid = loginResponse.data.responseBody?.jsessionid?.["$"];
    if (!jsessionid) throw new Error("Erro ao obter sessão.");

    const sql = `
      SELECT CTT.NOMECONTATO, CTT.CELULAR, CTT.EMAIL
      FROM TGFPAR PAR
      LEFT JOIN TGFCTT CTT ON (CTT.CODPARC = PAR.CODPARC)
      WHERE PAR.CODVEND = ${codparc}
        AND NVL(CTT.NOMECONTATO, ' ') <> ' '
        AND NVL(CTT.EMAIL, ' ') <> ' '
    `;

    const response = await axios.post(
      `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
      { serviceName: "DbExplorerSP.executeQuery", requestBody: { sql, outputType: "json" } },
      { headers: { 'Content-Type': 'application/json', 'Cookie': `JSESSIONID=${jsessionid}` } }
    );

    const contatos = response.data.responseBody?.rows.map(row => ({
      nome: row[0],
      telefone: row[1],
      email: row[2]
    })) || [];

    res.json(contatos);
  } catch (err) {
    console.error("Erro ao buscar contatos:", err.message);
    res.status(500).json({ erro: 'Erro ao buscar contatos', detalhes: err.message });
  }
});

// ------------------ Root ------------------
app.get('/', (req, res) => {
  res.redirect('/pages/login.html');
});

// ------------------ Start ------------------
app.listen(3000, '0.0.0.0', () => console.log("Servidor rodando em http://localhost:3000"));
