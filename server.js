const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

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
                sql: `SELECT CODPARC FROM TSIUSU WHERE NOMEUSU = UPPER('${usuario}')`,
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
            WHERE PAR.CODPARC = ${codparc}
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
            WHERE PAR.CODPARC = ${codparc} 
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
            WHERE PAR.CODPARC = ${codparc} 
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
            WHERE PAR.CODPARC = ${codparc} 
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
          AND PAR.CODPARC = ${codparc}
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
          AND PAR.CODPARC = ${codparc}
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
            WHERE PAR.CODPARC = ${codparc}
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
            WHERE PAR.CODPARC = ${codparc}
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
            WHERE PAR.CODPARC = ${codparc}
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

