/**
 * site_server.js — BTO Data Manager (dùng chung cho cả 3 Site)
 * ═══════════════════════════════════════════════════════════════
 * Chạy:
 *   node site_server.js 3001   → Site 1 (Fragment A–H), MySQL :3301
 *   node site_server.js 3002   → Site 2 (Fragment I–P), MySQL :3302
 *   node site_server.js 3003   → Site 3 (Fragment Q–Z), MySQL :3303
 *
 * Implements: Özsu & Valduriez Algorithm 5.5 — BTO-SC
 * ═══════════════════════════════════════════════════════════════
 */

const express = require('express');
const http    = require('http');
const mysql   = require('mysql2/promise');
const chalk   = require('chalk');

const app  = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── PORT & IDENTITY ───────────────────────────────────────────────────────────
const PORT      = parseInt(process.argv[2]) || 3001;
const SITE_NUM  = PORT - 3000;                  // 1, 2, or 3
const DB_PORT   = 3300 + SITE_NUM;              // 3301, 3302, 3303
const SITE_NAME = `SITE ${SITE_NUM}`;

const FRAGMENT_MAP = { 1: 'A–C', 2: 'D–N', 3: 'O–Z' };
const FRAGMENT     = FRAGMENT_MAP[SITE_NUM] || '?';

// ── DATABASE POOL ─────────────────────────────────────────────────────────────
const pool = mysql.createPool({
    host:             'localhost',
    user:             'root',
    password:         'root',
    database:         'stock_db',
    port:             DB_PORT,
    waitForConnections: true,
    connectionLimit:  100,
    queueLimit:       0,
});

// ── IN-MEMORY PREPARE BUFFER ──────────────────────────────────────────────────
// { ts: { symbol, type, newPrice } }
const prepared = {};

// ── STATS (for dashboard) ─────────────────────────────────────────────────────
const stats = {
    commits:  0,
    aborts:   0,
    prepared: 0,
    online:   true,
    startTime: Date.now(),
};

// ── HELPER: broadcast to coordinator's SSE if needed ─────────────────────────
// (Coordinator will pull stats via GET /stats)

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINT: GET /stats  — dashboard polling
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/stats', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT Symbol, CurrentPrice, R_TS, W_TS FROM Stock_Ticker ORDER BY Symbol'
        );
        return res.json({
            site:      SITE_NAME,
            fragment:  FRAGMENT,
            port:      PORT,
            dbPort:    DB_PORT,
            online:    true,
            commits:   stats.commits,
            aborts:    stats.aborts,
            prepared:  Object.keys(prepared).length,
            uptime:    Math.floor((Date.now() - stats.startTime) / 1000),
            stocks:    rows,
        });
    } catch {
        return res.json({ site: SITE_NAME, online: false, commits: stats.commits, aborts: stats.aborts, stocks: [] });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1: PREPARE — BTO-SC Algorithm 5.5
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/prepare', async (req, res) => {
    const { ts, type, symbol, newPrice } = req.body;

    try {
        const [rows] = await pool.query(
            'SELECT * FROM Stock_Ticker WHERE Symbol = ?', [symbol]
        );
        const stock = rows[0];

        if (!stock) {
            return res.status(404).json({ status: 'ERROR', message: `${symbol} not found at ${SITE_NAME}` });
        }

        // ── BTO RULE 1: READ ──────────────────────────────────────────────────
        if (type === 'READ') {
            if (ts < stock.W_TS) {
                stats.aborts++;
                console.log(chalk.red(
                    `[ABORT][${SITE_NAME}] READ too late: TS(${ts}) < W_TS(${stock.W_TS}) | ${symbol}`
                ));
                return res.status(409).json({
                    status: 'ABORT',
                    reason: 'Read too late',
                    detail: `ts(${ts}) < wts(${stock.W_TS})`,
                });
            }
        }

        // ── BTO RULE 2: WRITE ─────────────────────────────────────────────────
        else if (type === 'WRITE') {
            if (ts < stock.R_TS || ts < stock.W_TS) {
                stats.aborts++;
                console.log(chalk.red(
                    `[ABORT][${SITE_NAME}] WRITE too late: TS(${ts}) vs R_TS(${stock.R_TS}) W_TS(${stock.W_TS}) | ${symbol}`
                ));
                return res.status(409).json({
                    status: 'ABORT',
                    reason: 'Write too late',
                    detail: `ts(${ts}) < rts(${stock.R_TS}) or wts(${stock.W_TS})`,
                });
            }
            req.body.newPrice = parseFloat(newPrice).toFixed(2);
        }

        // ── PASS → buffer ─────────────────────────────────────────────────────
        prepared[ts] = req.body;
        stats.prepared++;
        console.log(chalk.yellow(
            `[PREPARED][${SITE_NAME}] ${symbol} | type:${type} | TS:${ts}`
        ));
        return res.status(200).json({ status: 'READY' });

    } catch (err) {
        console.error(chalk.red(`[ERROR][${SITE_NAME}] ${err.message}`));
        return res.status(500).json({ status: 'ERROR', message: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2A: COMMIT
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/commit', async (req, res) => {
    const { ts } = req.body;
    const tx = prepared[ts];

    if (!tx) {
        return res.status(400).json({ status: 'ERROR', message: 'No prepared tx found' });
    }

    try {
        if (tx.type === 'READ') {
            await pool.query(
                'UPDATE Stock_Ticker SET R_TS = GREATEST(R_TS, ?) WHERE Symbol = ?',
                [ts, tx.symbol]
            );
        } else if (tx.type === 'WRITE') {
            await pool.query(
                'UPDATE Stock_Ticker SET CurrentPrice = ?, W_TS = ? WHERE Symbol = ?',
                [tx.newPrice, ts, tx.symbol]
            );
        }

        delete prepared[ts];
        stats.commits++;

        console.log(chalk.green(
            `[COMMIT][${SITE_NAME}] ${tx.symbol} | type:${tx.type}${tx.type === 'WRITE' ? ` | price:${tx.newPrice}` : ''} | TS:${ts}`
        ));
        return res.status(200).json({ status: 'ACK' });

    } catch (err) {
        console.error(chalk.red(`[FATAL][${SITE_NAME}] Commit error: ${err.message}`));
        return res.status(500).json({ status: 'ERROR' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2B: ABORT
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/abort', (req, res) => {
    const { ts } = req.body;
    if (prepared[ts]) {
        delete prepared[ts];
        console.log(chalk.gray(`[ROLLBACK][${SITE_NAME}] Cleaned tx TS:${ts}`));
    }
    return res.status(200).json({ status: 'ACK' });
});

// ── START ─────────────────────────────────────────────────────────────────────
const server = http.createServer(app);
server.maxConnections = 10000;
server.listen(PORT, () => {
    console.log(chalk.cyan.bold(`\n🚀 [${SITE_NAME}] Data Manager — Fragment ${FRAGMENT}`));
    console.log(chalk.cyan(`   HTTP Port : ${PORT}`));
    console.log(chalk.cyan(`   MySQL Port: ${DB_PORT}`));
    console.log(chalk.gray(`   BTO-SC Algorithm 5.5 — Özsu & Valduriez\n`));
});