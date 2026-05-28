/**
 * coordinator.js — BTO Transaction Manager (3 Sites)
 * ═══════════════════════════════════════════════════
 * Fragmentation:
 *   A–H → Site 1 (:3001)  AAPL, BTC
 *   I–P → Site 2 (:3002)  FPT, MSFT
 *   Q–Z → Site 3 (:3003)  VNM
 * ═══════════════════════════════════════════════════
 */

const express = require('express');
const { exec } = require('child_process');
const axios   = require('axios');
const chalk   = require('chalk');
const path    = require('path');
const http    = require('http');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3000;

const siteAgent = new http.Agent({ keepAlive: true, maxSockets: Infinity });

const SITES = {
    SITE1: 'http://localhost:3001',
    SITE2: 'http://localhost:3002',
    SITE3: 'http://localhost:3003',
};

const SITE_META = {
    SITE1: { fragment: 'A–C', symbols: ['AAPL','BTC'] },
    SITE2: { fragment: 'D–N', symbols: ['FPT','MSFT'] },
    SITE3: { fragment: 'O–Z', symbols: ['VNM'] },
};

function getTargetSite(symbol) {
    const c = symbol.charAt(0).toUpperCase();
    if (c <= 'C') return SITES.SITE1;
    if (c <= 'N') return SITES.SITE2;
    return SITES.SITE3;
}

// ── GLOBAL STATS ──────────────────────────────────────────────────────────────
const globalStats = {
    totalTx: 0, commits: 0, aborts: 0, errors: 0,
    startTime: Date.now(),
    recentTx: [],
};

const sseClients = [];
function pushEvent(data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach(res => { try { res.write(payload); } catch {} });
    globalStats.recentTx.unshift(data);
    if (globalStats.recentTx.length > 50) globalStats.recentTx.pop();
}

app.get('/events', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();
    sseClients.push(res);
    req.on('close', () => {
        const i = sseClients.indexOf(res);
        if (i !== -1) sseClients.splice(i, 1);
    });
});

app.get('/api/stats', (req, res) => {
    const uptime    = Math.floor((Date.now() - globalStats.startTime) / 1000);
    const abortRate = globalStats.totalTx > 0
        ? ((globalStats.aborts / globalStats.totalTx) * 100).toFixed(1) : '0.0';
    res.json({ ...globalStats, uptime, abortRate });
});

app.get('/api/sites', async (req, res) => {
    const results = await Promise.all(Object.entries(SITES).map(async ([key, url]) => {
        try {
            const r = await axios.get(`${url}/stats`, { timeout: 1500, httpAgent: siteAgent });
            return { key, ...r.data, online: true };
        } catch {
            return { key, online: false, site: key,
                fragment: SITE_META[key].fragment,
                port: parseInt(url.split(':')[2]),
                commits: 0, aborts: 0, stocks: [] };
        }
    }));
    res.json(results);
});

// ── TRANSACTION — NO DELAY, BTO conflict xảy ra tự nhiên ─────────────────────
app.post('/api/transaction', async (req, res) => {
    const { symbol, type, newPrice, forcedTS } = req.body;
    const ts         = forcedTS ? parseInt(forcedTS) : Date.now();
    const targetSite = getTargetSite(symbol);

    globalStats.totalTx++;

    // KHÔNG có randomDelay — delay là nguyên nhân ERR_BAD_RESPONSE ở TPS cao
    // BTO conflict xảy ra tự nhiên: nhiều tx cùng WRITE 1 symbol → ts < W_TS

    const axiosOpts = { timeout: 5000, httpAgent: siteAgent };

    try {
        const prepRes = await axios.post(`${targetSite}/prepare`,
            { ts, type, symbol, newPrice }, axiosOpts);

        if (prepRes.status === 200 && prepRes.data.status === 'READY') {
            await axios.post(`${targetSite}/commit`, { ts }, axiosOpts);
            globalStats.commits++;
            console.log(chalk.green(`[COMMIT] ✓ ${symbol} | TS:${ts}`));
            pushEvent({ ts, symbol, type, newPrice,
                site: targetSite.split(':')[2],
                time: new Date().toISOString(), result: 'COMMIT' });
            return res.status(200).json({ status: 'SUCCESS' });
        }

        globalStats.errors++;
        return res.status(500).json({ status: 'ERROR', message: 'Site not ready' });

    } catch (error) {

        if (error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED' || !error.response) {
            const siteName = targetSite.includes('3003') ? 'Site 3'
                           : targetSite.includes('3002') ? 'Site 2' : 'Site 1';
            console.log(chalk.red.bold(`\n[CRITICAL] ${siteName} Offline. Initiating 2PC Global Abort...`));
            globalStats.errors++;
            pushEvent({ symbol, type, site: targetSite.split(':')[2],
                time: new Date().toISOString(), result: 'NODE_DOWN' });
            return res.status(500).json({ status: 'ERROR', message: `${siteName} is offline` });
        }

        if (error.response?.status === 409) {
            await axios.post(`${targetSite}/abort`, { ts },
                { ...axiosOpts, timeout: 3000 }).catch(() => {});
            globalStats.aborts++;
            console.log(chalk.red(`[ABORT] ✗ ${symbol} | TS:${ts} | ${error.response.data.reason}`));
            pushEvent({ ts, symbol, type,
                site: targetSite.split(':')[2],
                time: new Date().toISOString(),
                result: 'BTO_ABORT',
                reason: error.response.data.reason });
            return res.status(409).json({ status: 'ABORT', reason: error.response.data.reason });
        }

        globalStats.errors++;
        return res.status(500).json({ status: 'ERROR', message: error.message });
    }
});


// ── API: BENCHMARK RESULTS ────────────────────────────────────────────────────
app.get('/api/benchmark', (req, res) => {
    const csvPath = require('path').join(__dirname, 'benchmark_results.csv');
    const fs2 = require('fs');
    if (!fs2.existsSync(csvPath))
        return res.json({ rows: [], message: 'Chua co du lieu — chay node simulator.js truoc' });
    try {
        const lines = fs2.readFileSync(csvPath, 'utf8')
            .replace(/^\uFEFF/, '').trim().split('\n');
        const rows = lines.slice(1).map(line => {
            const c = line.split(',');
            return { tps: parseInt(c[0]), total: parseInt(c[1]),
                commit: parseInt(c[2]), abort: parseInt(c[3]),
                successPct: parseFloat(c[4]), abortPct: parseFloat(c[5]) };
        }).filter(r => !isNaN(r.tps));
        res.json({ rows, updatedAt: fs2.statSync(csvPath).mtime });
    } catch(e) { res.json({ rows: [], message: e.message }); }
});


// ── API: KILL / RESTART SITE (docker) ────────────────────────────────────────
app.post('/api/site/:action/:num', (req, res) => {
    const { action, num } = req.params;
    if (!['1','2','3'].includes(num))
        return res.status(400).json({ error: 'Invalid site number' });
    if (!['kill','restart'].includes(action))
        return res.status(400).json({ error: 'Invalid action' });

    const container = `bto_site${num}`;
    const cmd       = action === 'kill'
        ? `docker stop ${container}`
        : `docker start ${container}`;

    console.log(chalk[action === 'kill' ? 'red' : 'green'].bold(
        `[DASHBOARD] ${action.toUpperCase()} Site ${num} → ${cmd}`
    ));

    exec(cmd, (err, stdout, stderr) => {
        if (err) {
            console.error(chalk.red(`[DOCKER ERROR] ${err.message}`));
            return res.status(500).json({ ok: false, error: err.message });
        }
        res.json({ ok: true, container, action, output: stdout.trim() });
    });
});

const server = http.createServer(app);
server.maxConnections = 10000;
server.listen(PORT, () => {
    console.log(chalk.cyan.bold(`\n${'═'.repeat(55)}`));
    console.log(chalk.cyan.bold(`  BTO COORDINATOR — Transaction Manager`));
    console.log(chalk.cyan.bold(`${'═'.repeat(55)}`));
    console.log(chalk.cyan(`  API      : http://localhost:${PORT}/api/transaction`));
    console.log(chalk.cyan(`  Dashboard: http://localhost:${PORT}/`));
    console.log(chalk.gray(`  Fragment  : A–C→:3001 | D–N→:3002 | O–Z→:3003`));
    console.log(chalk.cyan.bold(`${'═'.repeat(55)}\n`));
});