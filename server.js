const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors({
    origin: '*', // ou especifique 'http://sankhya.nxboats.com.br' se preferir mais seguro
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

const SANKHYA_URL = 'http://sankhya2.nxboats.com.br:8180';

// Servir HTML
app.use('/pages', express.static(path.join(__dirname, 'pages')));
app.use('/style', express.static(path.join(__dirname, 'style')));
app.use(express.static(path.join(__dirname, 'public'))); // ou 'pages'


// LOGIN
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

        // CONSULTAR CODPARC
        const consultaCodparc = await axios.post(`${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`, {
            serviceName: "DbExplorerSP.executeQuery",
            requestBody: {
                sql: `SELECT CODVEND as CODPARC FROM TSIUSU WHERE NOMEUSU = UPPER('${usuario}')`,
                outputType: "json"
            }
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Cookie': `JSESSIONID=${jsessionid}`
            }
        });

        const codparc = consultaCodparc.data.responseBody?.rows?.[0]?.[0];
        if (!codparc) throw new Error("CODPARC não encontrado");

        res.json({ sucesso: true, session: jsessionid, usuario, senha, codparc });
    } catch (err) {
        res.status(401).json({ erro: 'Falha no login' });
    }
});

// --- inicio IA NXCopilot ---
// ===== AÇÕES INTELIGENTES NO CHAT =====
const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const GEMINI_MODEL = "gemini-1.5-flash";

// Helper: criar axios com timeout decente
const axiosInstance = axios.create({ timeout: 20000, validateStatus: () => true });

// Helper: login no Sankhya e retorna JSESSIONID
async function sankhyaLogin(usuario, senha) {
  const r = await axiosInstance.post(
    `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
    {
      serviceName: "MobileLoginSP.login",
      requestBody: { NOMUSU: { "$": usuario.toUpperCase() }, INTERNO: { "$": senha }, KEEPCONNECTED: { "$": "S" } }
    },
    { headers: { "Content-Type": "application/json" } }
  );
  const jsessionid = r.data?.responseBody?.jsessionid?.["$"];
  if (!jsessionid) throw new Error("Falha no login Sankhya");
  return jsessionid;
}

// Helper: executa SQL e retorna `rows`
async function sankhyaSQL(jsessionid, sql) {
  const payload = {
    serviceName: "DbExplorerSP.executeQuery",
    requestBody: { sql, outputType: "json" }
  };
  const r = await axiosInstance.post(
    `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
    payload,
    { headers: { "Content-Type": "application/json", "Cookie": `JSESSIONID=${jsessionid}` } }
  );
  if (!r.data?.responseBody?.rows) return [];
  return r.data.responseBody.rows;
}

// Helpers: parsing rápido (pt-BR)
function extrairNunota(texto) {
  const m = texto.match(/pedido\s*(n[úu]mero)?\s*([0-9]{4,})|nunota\s*([0-9]{4,})/i);
  return m ? (m[2] || m[3]) : null;
}
function extrairDataBR(texto) {
  // aceita 01/09/2025 ou 2025-09-01
  const m1 = texto.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m1) return `${m1[1]}/${m1[2]}/${m1[3]}`;
  const m2 = texto.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return `${m2[3]}/${m2[2]}/${m2[1]}`;
  return null;
}

// Classificador simples de intenção (regras)
function detectarIntencao(msg) {
  const t = msg.toLowerCase();

  // contagens
  if (t.includes("do mês") || t.includes("deste mês") || t.includes("mês atual")) return { intent: "contar_pedidos_mes" };
  if (t.includes("atrasad")) return { intent: "listar_atrasados" };
  if (t.includes("no prazo") || t.includes("em dia")) return { intent: "listar_no_prazo" };
  if (t.includes("a vencer") || t.includes("vencer")) return { intent: "listar_a_vencer" };

  // gráficos / séries
  if (t.includes("vendas por mês") || t.includes("vendas mensais") || t.includes("valor por mês"))
    return { intent: "serie_vendas_mes" };
  if (t.includes("pedidos por mês") || t.includes("quantidade por mês"))
    return { intent: "serie_pedidos_mes" };

  // por NUNOTA
  if (t.includes("produto") && (t.includes("pedido") || t.includes("nunota"))) return { intent: "produtos_por_pedido" };
  if (t.includes("imprimir") && (t.includes("pedido") || t.includes("nunota"))) return { intent: "imprimir_pedido" };
  if ((t.includes("alterar") || t.includes("mudar") || t.includes("editar")) && t.includes("entrega"))
    return { intent: "editar_data_pedido" };

  // financeiro
  if (t.includes("financeiro") || t.includes("parcelas") || t.includes("a pagar"))
    return { intent: "listar_financeiro" };

  return { intent: "fallback" };
}

// Formatações
function fmtBRL(n) {
  const v = Number(n || 0);
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// Rota do chat com ações inteligentes
app.post("/api/ai/chat", async (req, res) => {
  try {
    const { message, usuario, senha, codparc, history } = req.body || {};
    if (!message || !usuario || !senha) {
      return res.status(400).json({ erro: "Parâmetros ausentes (message, usuario, senha)." });
    }

    const { intent } = detectarIntencao(message);

    // Algumas intenções precisam de NUNOTA/data
    const nunota = extrairNunota(message);
    const dataBR = extrairDataBR(message);

    // Para intents que leem dados, vamos ao banco
    if (["contar_pedidos_mes", "listar_atrasados", "listar_no_prazo", "listar_a_vencer",
         "serie_vendas_mes", "serie_pedidos_mes", "produtos_por_pedido", "listar_financeiro"].includes(intent)) {
      const jsession = await sankhyaLogin(usuario, senha);

      // Despacho por intenção
      if (intent === "contar_pedidos_mes") {
        const sql = `
          SELECT COUNT(CAB.NUNOTA) AS QTD
          FROM TGFCAB CAB
          JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
          WHERE PAR.CODPARC = ${codparc}
            AND TO_CHAR(DTNEG,'MM/YYYY') = TO_CHAR(SYSDATE,'MM/YYYY')
        `;
        const rows = await sankhyaSQL(jsession, sql);
        const qtd = rows?.[0]?.[0] || 0;
        return res.json({
          reply: `Você tem ${qtd} pedidos emitidos neste mês.`,
          data: { table: { columns: ["Pedidos do mês"], rows: [[qtd]] } }
        });
      }

      if (intent === "listar_atrasados") {
        // Top 8 atrasados, ordenados por previsão mais antiga
        const sql = `
          SELECT CAB.NUNOTA,
                 TO_CHAR(CAB.DTNEG,'DD/MM/YYYY') AS DTNEG,
                 NVL(TO_CHAR(CAB.DTPREVENT,'DD/MM/YYYY'),'SEM PREV.') AS PREVISAO
          FROM TGFCAB CAB
          JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
          WHERE PAR.CODPARC = ${codparc}
            AND CAB.DTPREVENT < SYSDATE
            AND EXISTS (SELECT 1 FROM TGFITE I WHERE I.NUNOTA = CAB.NUNOTA AND (I.QTDNEG - I.QTDENTREGUE) <> 0)
          ORDER BY CAB.DTPREVENT ASC FETCH FIRST 8 ROWS ONLY
        `;
        const rows = await sankhyaSQL(jsession, sql);
        const table = {
          columns: ["NUNOTA", "Emissão", "Previsão"],
          rows: rows.map(r => [r[0], r[1], r[2]])
        };
        const countSql = `
          SELECT COUNT(DISTINCT CAB.NUNOTA)
          FROM TGFCAB CAB JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
          WHERE PAR.CODPARC = ${codparc} AND (CAB.DTPREVENT < SYSDATE OR CAB.DTPREVENT IS NULL)
        `;
        const c = await sankhyaSQL(jsession, countSql);
        const total = c?.[0]?.[0] || table.rows.length;
        return res.json({ reply: `Encontrei ${total} pedidos atrasados. Mostrando os primeiros ${table.rows.length}.`, data: { table } });
      }

      if (intent === "listar_no_prazo") {
        const sql = `
          SELECT CAB.NUNOTA,
                 TO_CHAR(CAB.DTNEG,'DD/MM/YYYY') AS DTNEG,
                 NVL(TO_CHAR(CAB.DTPREVENT,'DD/MM/YYYY'),'SEM PREV.') AS PREVISAO
          FROM TGFCAB CAB
          JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
          WHERE PAR.CODPARC = ${codparc}
            AND NVL(CAB.DTPREVENT, SYSDATE+365) >= SYSDATE
            AND EXISTS (SELECT 1 FROM TGFITE I WHERE I.NUNOTA = CAB.NUNOTA AND (I.QTDNEG - I.QTDENTREGUE) <> 0)
          ORDER BY CAB.DTPREVENT ASC FETCH FIRST 8 ROWS ONLY
        `;
        const rows = await sankhyaSQL(jsession, sql);
        const table = { columns: ["NUNOTA", "Emissão", "Previsão"], rows: rows.map(r => [r[0], r[1], r[2]]) };
        return res.json({ reply: `Alguns pedidos dentro do prazo:`, data: { table } });
      }

      if (intent === "listar_a_vencer") {
        const sql = `
          SELECT CAB.NUNOTA,
                 TO_CHAR(CAB.DTNEG,'DD/MM/YYYY') AS DTNEG,
                 NVL(TO_CHAR(CAB.DTPREVENT,'DD/MM/YYYY'),'SEM PREV.') AS PREVISAO
          FROM TGFCAB CAB
          JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
          WHERE PAR.CODPARC = ${codparc}
            AND CAB.DTPREVENT BETWEEN SYSDATE AND SYSDATE + 10
            AND EXISTS (SELECT 1 FROM TGFITE I WHERE I.NUNOTA = CAB.NUNOTA AND (I.QTDNEG - I.QTDENTREGUE) <> 0)
          ORDER BY CAB.DTPREVENT ASC FETCH FIRST 8 ROWS ONLY
        `;
        const rows = await sankhyaSQL(jsession, sql);
        const table = { columns: ["NUNOTA", "Emissão", "Previsão"], rows: rows.map(r => [r[0], r[1], r[2]]) };
        return res.json({ reply: `Pedidos que vencem nos próximos 10 dias:`, data: { table } });
      }

      if (intent === "serie_vendas_mes") {
        const sql = `
          SELECT SUM(CAB.VLRNOTA) as VALOR,
                 TO_CHAR(TRUNC(CAB.DTNEG, 'MM'), 'MM/YYYY') AS MES
          FROM TGFCAB CAB
          JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
          WHERE CAB.TIPMOV = 'O'
            AND CAB.STATUSNOTA = 'L'
            AND CAB.DTNEG > TRUNC(SYSDATE - 365)
            AND PAR.CODPARC = ${codparc}
          GROUP BY TRUNC(CAB.DTNEG, 'MM'), PAR.CODPARC
          ORDER BY TRUNC(CAB.DTNEG, 'MM')
        `;
        const rows = await sankhyaSQL(jsession, sql);
        const series = rows.map(r => ({ mes: r[1], valor: Number(r[0]) || 0 }));
        return res.json({ reply: `Segue a série de vendas mensais (últimos 12 meses).`, data: { series } });
      }

      if (intent === "serie_pedidos_mes") {
        const sql = `
          SELECT COUNT(DISTINCT CAB.NUNOTA) as VALOR,
                 TO_CHAR(TRUNC(CAB.DTNEG, 'MM'), 'MM/YYYY') AS MES
          FROM TGFCAB CAB
          JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
          WHERE CAB.TIPMOV = 'O'
            AND CAB.STATUSNOTA = 'L'
            AND CAB.DTNEG > TRUNC(SYSDATE - 365)
            AND PAR.CODPARC = ${codparc}
          GROUP BY TRUNC(CAB.DTNEG, 'MM'), PAR.CODPARC
          ORDER BY TRUNC(CAB.DTNEG, 'MM')
        `;
        const rows = await sankhyaSQL(jsession, sql);
        const series = rows.map(r => ({ mes: r[1], valor: Number(r[0]) || 0 }));
        return res.json({ reply: `Quantidade de pedidos por mês (últimos 12 meses).`, data: { series } });
      }

      if (intent === "produtos_por_pedido") {
        if (!nunota) return res.json({ reply: "Qual o NUNOTA do pedido? Ex.: 'produtos do pedido 123456'." });
        const sql = `
          SELECT ITE.NUNOTA,
                 PRO.CODPROD || ' - ' || PRO.DESCRPROD AS PRODUTO,
                 ITE.QTDNEG - ITE.QTDENTREGUE AS QTDLIQ,
                 ITE.VLRTOT,
                 CASE WHEN ITE.PENDENTE = 'S' THEN 'PENDENTE' ELSE 'PARCIAL' END AS STATUS,
                 NVL(TO_CHAR(ITE.AD_DTENTREGA,'DD/MM/YYYY'),'SEM PREV.') AS AD_DTENTREGA
          FROM TGFITE ITE
          JOIN TGFCAB CAB ON CAB.NUNOTA = ITE.NUNOTA
          LEFT JOIN TGFPRO PRO ON PRO.CODPROD = ITE.CODPROD
          WHERE ITE.NUNOTA = ${nunota}
          ORDER BY ITE.VLRTOT DESC FETCH FIRST 10 ROWS ONLY
        `;
        const rows = await sankhyaSQL(jsession, sql);
        if (!rows.length) return res.json({ reply: `Não encontrei itens para o pedido ${nunota}.` });
        const table = {
          columns: ["Produto", "Qtd Liq", "Valor", "Status", "Prev Entrega"],
          rows: rows.map(r => [r[1], Number(r[2]) || 0, fmtBRL(r[3]), r[4], r[5]])
        };
        return res.json({ reply: `Itens do pedido ${nunota}:`, data: { table } });
      }

      if (intent === "listar_financeiro") {
        const sql = `
          SELECT TO_CHAR(FIN.DTVENC,'DD/MM/YYYY') AS VENC,
                 FIN.VLRDESDOB,
                 NVL(FIN.VLRBAIXA,0) AS BAIXA,
                 CASE
                    WHEN FIN.DTVENC < SYSDATE AND FIN.DHBAIXA IS NULL THEN 'ATRASADO'
                    WHEN FIN.DTVENC > SYSDATE AND FIN.DHBAIXA IS NULL THEN 'A PAGAR'
                    WHEN FIN.DHBAIXA IS NOT NULL THEN 'PAGO'
                 END AS STATUS
          FROM TGFFIN FIN
          JOIN TGFPAR PAR ON PAR.CODPARC = FIN.CODPARC
          WHERE PAR.CODPARC = ${codparc}
            AND FIN.CODTIPTIT <> 29
          ORDER BY FIN.DTVENC DESC FETCH FIRST 12 ROWS ONLY
        `;
        const rows = await sankhyaSQL(jsession, sql);
        const table = { columns: ["Vencimento", "Valor", "Baixa", "Status"], rows: rows.map(r => [r[0], fmtBRL(r[1]), fmtBRL(r[2]), r[3]]) };
        return res.json({ reply: "Últimas parcelas:", data: { table } });
      }
    }

    // Intenções que ALTERAM dados: pedem confirmação
    if (intent === "editar_data_pedido") {
      const n = nunota || "(faltando NUNOTA)";
      const d = dataBR || "(faltando data)";
      return res.json({
        reply: `Você quer alterar a data de entrega do pedido ${n} para ${d}, confere?`,
        confirmationRequired: true,
        action: { type: "editar_pedido", nunota: nunota, novaDataEntrega: dataBR }
      });
    }
    if (intent === "imprimir_pedido") {
      if (!nunota) return res.json({ reply: "Qual NUNOTA do pedido para imprimir? Ex.: 'imprimir pedido 123456'." });
      return res.json({
        reply: `Posso gerar o PDF do pedido ${nunota}. Deseja prosseguir?`,
        confirmationRequired: true,
        action: { type: "imprimir_pedido", nunota }
      });
    }

    // Fallback: usa o Gemini para responder genericamente
    const systemPrompt = `
Você é um assistente do Portal do Fornecedor NX Boats. Responda em pt-BR, de forma objetiva.
Se a pergunta parecer pedir listagens numéricas ou por NUNOTA, diga como o usuário pode pedir (ex.: "produtos do pedido 123456").
    `.trim();

    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: systemPrompt });
    const geminiHistory = Array.isArray(history)
      ? history.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }))
      : [];
    const chat = model.startChat({ history: geminiHistory });
    const prefix = `Usuário: ${usuario} | CODPARC: ${codparc}\nPergunta: `;
    const r = await chat.sendMessage(prefix + message);
    const reply = r.response?.text?.() || "Não consegui gerar resposta agora.";
    return res.json({ reply });
  } catch (err) {
    console.error("Falha /api/ai/chat:", err?.response?.data || err.message);
    return res.status(500).json({ erro: "Falha na IA", detalhe: err?.response?.data || err.message });
  }
});

// --- FIM IA NXCopilot ---





//CONSULTA SQL

async function consultaSQL(usuario, senha, sql) {
    // Login
    const loginResponse = await axios.post(
        `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
        {
            serviceName: "MobileLoginSP.login",
            requestBody: {
                NOMUSU: { "$": usuario },
                INTERNO: { "$": senha },
                KEEPCONNECTED: { "$": "S" }
            }
        },
        { headers: { 'Content-Type': 'application/json' } }
    );

    const sessionId = loginResponse.data.responseBody?.jsessionid?.["$"];
    if (!sessionId) throw new Error("Falha no login para consulta SQL");

    const consulta = {
        serviceName: "DbExplorerSP.executeQuery",
        requestBody: {
            sql,
            outputType: "json"
        }
    };

    const response = await axios.post(
        `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
        consulta,
        {
            headers: {
                'Content-Type': 'application/json',
                'Cookie': `JSESSIONID=${sessionId}`
            }
        }
    );

    return response.data.responseBody?.rows.map(row => ({
        VALOR: parseInt(row[0]),
        MES: row[1]
    })) || [];
}


// PEDIDOS
app.post('/api/pedidos', async (req, res) => {
    const { usuario, senha, codparc } = req.body;
    if (!usuario || !senha || !codparc) {
        return res.status(400).json({ erro: "Credenciais ausentes" });
    }

    try {
        // Login na API Sankhya
        const loginResponse = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
            {
                serviceName: "MobileLoginSP.login",
                requestBody: {
                    NOMUSU: { "$": usuario },
                    INTERNO: { "$": senha },
                    KEEPCONNECTED: { "$": "S" }
                }
            },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const sessionId = loginResponse.data.responseBody?.jsessionid?.["$"];

        // Consulta SQL
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

        const consulta = {
            serviceName: "DbExplorerSP.executeQuery",
            requestBody: {
                sql,
                outputType: "json"
            }
        };

        const response = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
            consulta,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `JSESSIONID=${sessionId}`
                }
            }
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

// PRODUTOS
app.post('/api/produtos', async (req, res) => {
    const { usuario, senha, codparc } = req.body;

    if (!usuario || !senha || !codparc) {
        return res.status(400).json({ erro: 'Credenciais ausentes. Faça login novamente.' });
    }

    try {
        // Faz o login com os dados recebidos
        const loginResponse = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
            {
                serviceName: "MobileLoginSP.login",
                requestBody: {
                    NOMUSU: { "$": usuario },
                    INTERNO: { "$": senha },
                    KEEPCONNECTED: { "$": "S" }
                }
            },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const jsessionid = loginResponse.data.responseBody?.jsessionid?.["$"];
        if (!jsessionid) throw new Error("Erro ao obter sessão.");

        // Consulta SQL
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

        const consulta = {
            serviceName: "DbExplorerSP.executeQuery",
            requestBody: {
                sql,
                outputType: "json"
            }
        };

        const response = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
            consulta,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `JSESSIONID=${jsessionid}`
                }
            }
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

// NOVA ROTA PARA LISTAR TODOS OS PRODUTOS
app.post('/api/produtos/all', async (req, res) => {
    const { usuario, senha, codparc } = req.body;

    if (!usuario || !senha || !codparc) {
        return res.status(400).json({ erro: 'Credenciais ausentes. Faça login novamente.' });
    }

    try {
        // Faz o login com os dados recebidos
        const loginResponse = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
            {
                serviceName: "MobileLoginSP.login",
                requestBody: {
                    NOMUSU: { "$": usuario },
                    INTERNO: { "$": senha },
                    KEEPCONNECTED: { "$": "S" }
                }
            },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const jsessionid = loginResponse.data.responseBody?.jsessionid?.["$"];
        if (!jsessionid) throw new Error("Erro ao obter sessão.");

        // Consulta SQL (Todos os produtos)
        const sql = `
            SELECT
                PRO.CODPROD || ' - ' || PRO.DESCRPROD AS PRODUTO,
                SUM(ITE.QTDNEG - ITE.QTDENTREGUE) AS QTDLIQ,
                SUM(ITE.VLRTOT) AS VALOR_TOTAL,
                CASE 
                    WHEN ITE.PENDENTE = 'S' THEN 'PENDENTE' 
                    ELSE 'PARCIAL' 
                END AS STATUS,
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

        const consulta = {
            serviceName: "DbExplorerSP.executeQuery",
            requestBody: {
                sql,
                outputType: "json"
            }
        };

        const response = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
            consulta,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `JSESSIONID=${jsessionid}`
                }
            }
        );

        // O mapeamento aqui precisa corresponder exatamente à ordem das colunas na sua consulta SQL.
        // Sua consulta tem 6 colunas, então o índice vai de 0 a 5.
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

//Card 1
app.get('/api/pedidos-mes', async (req, res) => {
    const { usuario, senha, codparc } = req.query;
    if (!usuario || !senha || !codparc) {
        return res.status(400).json({ erro: "Credenciais ausentes" });
    }

    try {
        // Realiza o login
        const loginResponse = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
            {
                serviceName: "MobileLoginSP.login",
                requestBody: {
                    NOMUSU: { "$": usuario },
                    INTERNO: { "$": senha },
                    KEEPCONNECTED: { "$": "S" }
                }
            },
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

        const consulta = {
            serviceName: "DbExplorerSP.executeQuery",
            requestBody: {
                sql,
                outputType: "json"
            }
        };

        const response = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
            consulta,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `JSESSIONID=${sessionId}`
                }
            }
        );

        const quantidade = response.data.responseBody?.rows?.[0]?.[0] || 0;
        res.json({ quantidade });

    } catch (error) {
        console.error("Erro ao buscar pedidos do mês:", error.message);
        res.status(500).json({ erro: "Erro ao buscar pedidos do mês" });
    }
});
//Card 2
app.get('/api/pedidos-atrasados', async (req, res) => {
    const { usuario, senha, codparc } = req.query;
    if (!usuario || !senha || !codparc) {
        return res.status(400).json({ erro: "Credenciais ausentes" });
    }

    try {
        // Realiza o login
        const loginResponse = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
            {
                serviceName: "MobileLoginSP.login",
                requestBody: {
                    NOMUSU: { "$": usuario },
                    INTERNO: { "$": senha },
                    KEEPCONNECTED: { "$": "S" }
                }
            },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const sessionId = loginResponse.data.responseBody?.jsessionid?.["$"];

        const sql = `
             
            SELECT 
                COUNT(DISTINCT CAB.NUNOTA) AS QTD
            FROM TGFCAB CAB
            LEFT JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
            WHERE PAR.CODVEND = ${codparc} 
            AND CAB.PENDENTE = 'S'
            AND CAB.TIPMOV = 'O'
            AND (CAB.DTPREVENT < SYSDATE OR CAB.DTPREVENT IS NULL)
        `;

        const consulta = {
            serviceName: "DbExplorerSP.executeQuery",
            requestBody: {
                sql,
                outputType: "json"
            }
        };

        const response = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
            consulta,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `JSESSIONID=${sessionId}`
                }
            }
        );

        const quantidade = response.data.responseBody?.rows?.[0]?.[0] || 0;
        res.json({ quantidade });

    } catch (error) {
        console.error("Erro ao buscar pedidos do atrasados:", error.message);
        res.status(500).json({ erro: "Erro ao buscar pedidos do atrasdos" });
    }
});
//Card 3
app.get('/api/pedidos-prazo', async (req, res) => {
    const { usuario, senha, codparc } = req.query;
    if (!usuario || !senha || !codparc) {
        return res.status(400).json({ erro: "Credenciais ausentes" });
    }

    try {
        // Realiza o login
        const loginResponse = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
            {
                serviceName: "MobileLoginSP.login",
                requestBody: {
                    NOMUSU: { "$": usuario },
                    INTERNO: { "$": senha },
                    KEEPCONNECTED: { "$": "S" }
                }
            },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const sessionId = loginResponse.data.responseBody?.jsessionid?.["$"];

        const sql = `
            SELECT 
                COUNT(DISTINCT CAB.NUNOTA) AS QTD
            FROM TGFCAB CAB
            LEFT JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
            WHERE PAR.CODVEND = ${codparc} 
            AND (CAB.DTPREVENT >= SYSDATE)
        `;

        const consulta = {
            serviceName: "DbExplorerSP.executeQuery",
            requestBody: {
                sql,
                outputType: "json"
            }
        };

        const response = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
            consulta,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `JSESSIONID=${sessionId}`
                }
            }
        );

        const quantidade = response.data.responseBody?.rows?.[0]?.[0] || 0;
        res.json({ quantidade });

    } catch (error) {
        console.error("Erro ao buscar pedidos no prazo:", error.message);
        res.status(500).json({ erro: "Erro ao buscar pedidos no prazo" });
    }
});
// card 4
app.get('/api/pedidos-vencer', async (req, res) => {
    const { usuario, senha, codparc } = req.query;
    if (!usuario || !senha || !codparc) {
        return res.status(400).json({ erro: "Credenciais ausentes" });
    }

    try {
        // Realiza o login
        const loginResponse = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
            {
                serviceName: "MobileLoginSP.login",
                requestBody: {
                    NOMUSU: { "$": usuario },
                    INTERNO: { "$": senha },
                    KEEPCONNECTED: { "$": "S" }
                }
            },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const sessionId = loginResponse.data.responseBody?.jsessionid?.["$"];

        const sql = `
            SELECT 
                COUNT(DISTINCT CAB.NUNOTA) AS QTD
            FROM TGFCAB CAB
            LEFT JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
            WHERE PAR.CODVEND = ${codparc} 
            AND (CAB.DTPREVENT >= SYSDATE-10)
        `;

        const consulta = {
            serviceName: "DbExplorerSP.executeQuery",
            requestBody: {
                sql,
                outputType: "json"
            }
        };

        const response = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
            consulta,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `JSESSIONID=${sessionId}`
                }
            }
        );

        const quantidade = response.data.responseBody?.rows?.[0]?.[0] || 0;
        res.json({ quantidade });

    } catch (error) {
        console.error("Erro ao buscar pedidos a vencer:", error.message);
        res.status(500).json({ erro: "Erro ao buscar pedidos a vencer" });
    }
});
// grafico 1
app.post('/api/grafico-vendas', async (req, res) => {
    const { usuario, senha, codparc } = req.body;
    if (!usuario || !senha || !codparc) {
        return res.status(400).json({ erro: "Credenciais ausentes" });
    }

    try {
        // Login na API Sankhya
        const loginResponse = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
            {
                serviceName: "MobileLoginSP.login",
                requestBody: {
                    NOMUSU: { "$": usuario },
                    INTERNO: { "$": senha },
                    KEEPCONNECTED: { "$": "S" }
                }
            },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const sessionId = loginResponse.data.responseBody?.jsessionid?.["$"];

        // Consulta SQL
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

        const consulta = {
            serviceName: "DbExplorerSP.executeQuery",
            requestBody: {
                sql,
                outputType: "json"
            }
        };

        const response = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
            consulta,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `JSESSIONID=${sessionId}`
                }
            }
        );

        const dados = response.data.responseBody?.rows.map(row => ({
            valor: parseFloat(row[0]),
            mes: row[1]
        })) || [];

        res.json(dados);
    } catch (error) {
        console.error("Erro ao buscar dados do gráfico:", error.message);
        res.status(500).json({ erro: "Erro ao buscar dados do gráfico" });
    }
});
// GREFICO 2
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
        const resultados = dados.map(row => ({
            mes: row.MES,
            valor: row.VALOR
        }));

        res.json(resultados);
    } catch (err) {
        console.error("Erro ao buscar pedidos por mês:", err);
        res.status(500).json({ erro: "Erro ao buscar dados" });
    }
});
// pedidos por nunota
app.get('/api/produtos-por-pedido', async (req, res) => {
    const { usuario, senha, nunota } = req.query;

    if (!usuario || !senha || !nunota) {
        return res.status(400).json({ erro: 'Parâmetros ausentes.' });
    }

    try {
        // Faz login
        const loginResponse = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
            {
                serviceName: "MobileLoginSP.login",
                requestBody: {
                    NOMUSU: { "$": usuario },
                    INTERNO: { "$": senha },
                    KEEPCONNECTED: { "$": "S" }
                }
            },
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
            WHERE ITE.NUNOTA = ${nunota}
        `;

        const consulta = {
            serviceName: "DbExplorerSP.executeQuery",
            requestBody: {
                sql,
                outputType: "json"
            }
        };

        const response = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
            consulta,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `JSESSIONID=${jsessionid}`
                }
            }
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


// pedidos por nunota
app.get('/api/pedido-comprador', async (req, res) => {
    const { usuario, senha, comprador } = req.query;

    if (!usuario || !senha || !comprador) {
        return res.status(400).json({ erro: 'Parâmetros ausentes.' });
    }

    try {
        // Faz login
        const loginResponse = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
            {
                serviceName: "MobileLoginSP.login",
                requestBody: {
                    NOMUSU: { "$": usuario },
                    INTERNO: { "$": senha },
                    KEEPCONNECTED: { "$": "S" }
                }
            },
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
            WHERE PAR.CODVEND = ${comprador}
            AND CAB.TIPMOV = 'C'
            AND CAB.PENDENTE = 'S'
        `;
//todo
        const consulta = {
            serviceName: "DbExplorerSP.executeQuery",
            requestBody: {
                sql,
                outputType: "json"
            }
        };

        const response = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
            consulta,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `JSESSIONID=${jsessionid}`
                }
            }
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


app.post('/api/financeiro', async (req, res) => {
    const { usuario, senha, codparc } = req.body;

    if (!usuario || !senha || !codparc) {
        return res.status(400).json({ erro: 'Credenciais ausentes. Faça login novamente.' });
    }

    try {
        // LOGIN
        const loginResponse = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
            {
                serviceName: "MobileLoginSP.login",
                requestBody: {
                    NOMUSU: { "$": usuario },
                    INTERNO: { "$": senha },
                    KEEPCONNECTED: { "$": "S" }
                }
            },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const jsessionid = loginResponse.data.responseBody?.jsessionid?.["$"];
        if (!jsessionid) throw new Error("Erro ao obter sessão.");

        // CONSULTA SQL
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

        const consulta = {
            serviceName: "DbExplorerSP.executeQuery",
            requestBody: {
                sql,
                outputType: "json"
            }
        };

        const response = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
            consulta,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `JSESSIONID=${jsessionid}`
                }
            }
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

app.post('/api/editar-pedido', async (req, res) => {
    const { usuario, senha, nunota, novaDataEntrega, novaObs } = req.body;
    console.log("➡️ Dados recebidos do front:", req.body);

    if (!usuario || !senha || !nunota || !novaDataEntrega) {
        return res.status(400).json({ erro: "Campos obrigatórios ausentes: usuario, senha, nunota, novaDataEntrega" });
    }

    try {
        // Login direto via MobileLoginSP.login para obter JSESSIONID
        const loginResponse = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
            {
                serviceName: "MobileLoginSP.login",
                requestBody: {
                    NOMUSU: { "$": usuario },
                    INTERNO: { "$": senha },
                    KEEPCONNECTED: { "$": "S" }
                }
            },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const jsessionid = loginResponse.data.responseBody?.jsessionid?.["$"];
        if (!jsessionid) throw new Error("Erro ao obter sessão.");

        // Ajustar formato da data para DD/MM/YYYY se necessário
        const [ano, mes, dia] = novaDataEntrega.split("-");
        const dataFormatada = `${dia}/${mes}/${ano}`;

        const payload = {
            serviceName: "DatasetSP.save",
            requestBody: {
                entityName: "CabecalhoNota",
                fields: ["DTPREVENT", "AD_OBSFORNDT"],
                records: [
                    {
                        pk: { NUNOTA: nunota },
                        values: {
                            "0": dataFormatada,
                            "1": novaObs || ""
                        }
                    }
                ]
            }
        };

        const editarResponse = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=DatasetSP.save&outputType=json`,
            payload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `JSESSIONID=${jsessionid}`
                }
            }
        );

        res.status(200).json({ sucesso: true, dados: editarResponse.data });
    } catch (error) {
        console.error("Erro ao editar pedido:", JSON.stringify(error?.response?.data || error.message, null, 2));
        res.status(500).json({ erro: "Erro ao editar pedido", detalhes: error?.response?.data || error.message });
    }
});

app.post('/api/imprimir-pedido', async (req, res) => {
    const { usuario, senha, nunota } = req.body;

    try {
        // LOGIN
        const loginResponse = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
            {
                serviceName: "MobileLoginSP.login",
                requestBody: {
                    NOMUSU: { "$": usuario },
                    INTERNO: { "$": senha },
                    KEEPCONNECTED: { "$": "S" }
                }
            },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const jsessionid = loginResponse.data.responseBody?.jsessionid?.["$"];
        if (!jsessionid) throw new Error("Erro ao obter sessão");

        // GERA RELATÓRIO
        const gerarRelatorioPayload = {
            serviceName: "VisualizadorRelatorios.visualizarRelatorio",
            requestBody: {
                relatorio: {
                    nuRfe: "1", // ID do relatório
                    isApp: "N",
                    nuApp: 1,
                    parametros: {
                        parametro: [
                            {
                                classe: "java.math.BigDecimal",
                                nome: "NUNOTA",
                                valor: nunota
                            }
                        ]
                    }
                }
            }
        };

        const gerarResp = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=VisualizadorRelatorios.visualizarRelatorio&outputType=json`,
            gerarRelatorioPayload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `JSESSIONID=${jsessionid}`
                }
            }
        );

        const chaveArquivo = gerarResp.data?.responseBody?.chave?.valor;

        if (!chaveArquivo) {
            console.log("🛑 Falha ao obter chave do arquivo.");
            return res.status(500).json({ erro: "Falha ao obter chave do arquivo." });
        }

        // DOWNLOAD
        const downloadResp = await axios.get(
            `${SANKHYA_URL}/mge/visualizadorArquivos.mge?hidemail=S&download=S&chaveArquivo=${chaveArquivo}`,
            {
                headers: {
                    'Cookie': `JSESSIONID=${jsessionid}`
                },
                responseType: 'arraybuffer'
            }
        );

        // ENVIA BINÁRIO
        res.setHeader('Content-Type', 'application/pdf');
        res.send(downloadResp.data);

    } catch (error) {
        console.error("❌ Erro ao gerar ou baixar relatório:", error?.response?.data || error.message);
        res.status(500).json({ erro: "Erro ao gerar ou baixar o relatório" });
    }
});

// INFORMAÇÕES DO FORNECEDOR
app.post('/api/conta', async (req, res) => {
    const { usuario, senha, codparc } = req.body;

    if (!usuario || !senha || !codparc) {
        return res.status(400).json({ erro: 'Credenciais ausentes. Faça login novamente.' });
    }

    try {
        // LOGIN
        const loginResponse = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
            {
                serviceName: "MobileLoginSP.login",
                requestBody: {
                    NOMUSU: { "$": usuario },
                    INTERNO: { "$": senha },
                    KEEPCONNECTED: { "$": "S" }
                }
            },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const jsessionid = loginResponse.data.responseBody?.jsessionid?.["$"];
        if (!jsessionid) throw new Error("Erro ao obter sessão.");

        // SQL
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
            FROM
                TGFPAR PAR
                LEFT JOIN TSIEND ENDR ON ENDR.CODEND = PAR.CODEND
                LEFT JOIN TSIBAI BAI ON BAI.CODBAI = PAR.CODBAI
                LEFT JOIN TSICID CID ON CID.CODCID = PAR.CODCID
                LEFT JOIN TSIUFS UFS ON UFS.CODUF = PAR.AD_CODUFVENDA
            WHERE PAR.CODVEND = ${codparc}
        `;

        const consulta = {
            serviceName: "DbExplorerSP.executeQuery",
            requestBody: {
                sql,
                outputType: "json"
            }
        };

        const response = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
            consulta,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `JSESSIONID=${jsessionid}`
                }
            }
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

app.post('/api/contatos', async (req, res) => {
    const { usuario, senha, codparc } = req.body;

    if (!usuario || !senha || !codparc) {
        return res.status(400).json({ erro: 'Credenciais ausentes. Faça login novamente.' });
    }

    try {
        // LOGIN
        const loginResponse = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=MobileLoginSP.login&outputType=json`,
            {
                serviceName: "MobileLoginSP.login",
                requestBody: {
                    NOMUSU: { "$": usuario },
                    INTERNO: { "$": senha },
                    KEEPCONNECTED: { "$": "S" }
                }
            },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const jsessionid = loginResponse.data.responseBody?.jsessionid?.["$"];
        if (!jsessionid) throw new Error("Erro ao obter sessão.");

        // SQL atualizado
        const sql = `
            SELECT
                CTT.NOMECONTATO,
                CTT.CELULAR,
                CTT.EMAIL
            FROM
                TGFPAR PAR
                LEFT JOIN TGFCTT CTT ON (CTT.CODPARC = PAR.CODPARC)
            WHERE PAR.CODVEND = ${codparc}
              AND NVL(CTT.NOMECONTATO, ' ') <> ' '
              AND NVL(CTT.EMAIL, ' ') <> ' '
        `;

        const consulta = {
            serviceName: "DbExplorerSP.executeQuery",
            requestBody: {
                sql,
                outputType: "json"
            }
        };

        const response = await axios.post(
            `${SANKHYA_URL}/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json`,
            consulta,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `JSESSIONID=${jsessionid}`
                }
            }
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

// Redireciona '/' para a página de login
app.get('/', (req, res) => {
    res.redirect('/pages/login.html');
});

app.listen(3000, '0.0.0.0', () => console.log("Servidor rodando em http://localhost:3000"));

