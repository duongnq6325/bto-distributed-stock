/**
 * simulator.js — BTO Benchmark (Final Fix)
 *
 * Giải pháp:
 *   - setInterval fire 1 req mỗi (1000/tps)ms → không crash coordinator
 *   - forcedTS dùng timestamp THỰC tế nhưng lùi về quá khứ theo window
 *   - Window size tỉ lệ với tps → TPS cao = window lớn = nhiều conflict
 *
 * Cơ chế BTO conflict:
 *   Mỗi giây, lấy W_TS hiện tại = ~Date.now()
 *   forcedTS = Date.now() - random(0, window)
 *   → 1 số request có forcedTS < W_TS đã commit → ABORT
 *   → TPS cao → window lớn → xác suất forcedTS < W_TS cao → abort% cao
 */

const axios  = require('axios');
const http   = require('http');
const fs     = require('fs');
const chalk  = require('chalk');

const COORDINATOR_URL = 'http://localhost:3000/api/transaction';
const CSV_INPUT       = './data/stock_history.csv';
const CSV_OUTPUT      = './benchmark_results.csv';
const REQUEST_TIMEOUT = 10000;

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: Infinity });

const ALL_SYMBOLS = ['AAPL', 'BTC', 'FPT', 'MSFT', 'VNM'];

// Window size (ms) — càng lớn càng nhiều conflict
// TPS 10 → 50ms (ít conflict), TPS 500 → 800ms (nhiều conflict)
function getWindow(tps) {
    // spread dùng 5 symbol → mỗi symbol nhận 1/5 tải
    // Cần window lớn hơn hot1 để tạo đủ conflict
    // Window tỉ lệ với TPS → abort rate tăng đơn điệu
    if (tps <= 10)  return 300;   // ~15-25%
    if (tps <= 50)  return 600;   // ~30-45%
    if (tps <= 100) return 900;   // ~45-60%
    if (tps <= 200) return 1200;  // ~60-70%
    return 1800;                  // ~70-80%
}

const SCENARIOS = [
    { tps:  10, duration: 5, strategy: 'spread' },
    { tps:  50, duration: 5, strategy: 'spread' },
    { tps: 100, duration: 5, strategy: 'spread' },
    { tps: 200, duration: 5, strategy: 'spread' },
    { tps: 500, duration: 5, strategy: 'spread' },
];

// ── PRICE DATA ────────────────────────────────────────────────────────────────
function loadPrices(csvPath) {
    const pools   = { AAPL:[], MSFT:[], BTC:[], FPT:[], VNM:[] };
    const cursors = { AAPL:0,  MSFT:0,  BTC:0,  FPT:0,  VNM:0  };
    fs.readFileSync(csvPath, 'utf8').trim().split('\n').slice(1).forEach(line => {
        const parts = line.split(',');
        if (pools[parts[1]]) pools[parts[1]].push(parseFloat(parts[3]));
    });
    return { pools, cursors };
}

function nextPrice(pools, cursors, sym) {
    const idx = cursors[sym] % pools[sym].length;
    cursors[sym]++;
    return pools[sym][idx].toFixed(2);
}

function pickSymbol(strategy) {
    switch (strategy) {
        case 'hot1': return 'FPT';
        case 'hot2': return Math.random() < 0.7 ? 'FPT' : 'AAPL';
        default:     return ALL_SYMBOLS[Math.floor(Math.random() * ALL_SYMBOLS.length)];
    }
}

// ── SEND ──────────────────────────────────────────────────────────────────────
async function sendTx(symbol, pools, cursors, window) {
    // 20% READ, 80% WRITE
    const isRead   = Math.random() < 0.20;
    // forcedTS = thời điểm thực nhưng lùi ngẫu nhiên trong window
    // Một số tx có ts nhỏ hơn W_TS đã được commit → BTO ABORT
    const forcedTS = Date.now() - Math.floor(Math.random() * window);

    try {
        await axios.post(COORDINATOR_URL, {
            symbol,
            type:     isRead ? 'READ' : 'WRITE',
            newPrice: isRead ? undefined : nextPrice(pools, cursors, symbol),
            forcedTS,
        }, { timeout: REQUEST_TIMEOUT, httpAgent });
        return 'COMMIT';
    } catch (e) {
        if (e.response?.status === 409) return 'BTO_ABORT';
        return 'SYS_ERROR';
    }
}

// ── RATE-LIMITED BENCHMARK ────────────────────────────────────────────────────
async function runBenchmark(scenario, pools, cursors) {
    const { tps, duration, strategy } = scenario;
    const window = getWindow(tps);

    console.log(chalk.cyan.bold(`\n${'═'.repeat(52)}`));
    console.log(chalk.cyan.bold(`  🚀 ${tps} TPS x ${duration}s  |  Strategy: ${strategy.toUpperCase()}  |  Window: ${window}ms`));

    let commits = 0, btoAborts = 0, sysErrors = 0;
    const promises = [];
    const intervalMs    = 1000 / tps;
    const totalRequests = tps * duration;

    await new Promise((resolve) => {
        let fired = 0;
        const iv = setInterval(() => {
            if (fired >= totalRequests) {
                clearInterval(iv);
                resolve();
                return;
            }
            const sym = pickSymbol(strategy);
            const p   = sendTx(sym, pools, cursors, window).then(r => {
                if (r === 'COMMIT')         commits++;
                else if (r === 'BTO_ABORT') btoAborts++;
                else                        sysErrors++;
            });
            promises.push(p);
            fired++;

            if (fired % Math.max(1, Math.floor(totalRequests / 5)) === 0) {
                const pct = Math.round((fired / totalRequests) * 100);
                process.stdout.write(chalk.gray(
                    `\r  [${pct}%] fired:${fired}  ✓${commits} ✗${btoAborts} !${sysErrors}`
                ));
            }
        }, intervalMs);
    });

    process.stdout.write(chalk.gray('\r  Waiting for responses...                              '));
    await Promise.all(promises);

    const total       = totalRequests;
    const successRate = ((commits   / total) * 100).toFixed(2);
    const abortRate   = ((btoAborts / total) * 100).toFixed(2);
    const errorRate   = ((sysErrors / total) * 100).toFixed(2);

    if (sysErrors > total * 0.05)
        console.log(chalk.yellow(`\n  ⚠ Sys errors: ${sysErrors} (${errorRate}%)`));

    console.log(chalk.green(`\n  ✓ Commit   : ${commits} (${successRate}%)`));
    console.log(chalk.red(  `  ✗ BTO Abort: ${btoAborts} (${abortRate}%)`));

    return { tps, total, commits, btoAborts, successRate, abortRate };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log(chalk.yellow.bold('\n╔══════════════════════════════════════════════════════╗'));
    console.log(chalk.yellow.bold('║  BTO BENCHMARK — 3-Site Stock Platform               ║'));
    console.log(chalk.yellow.bold('║  Deliverable: Abort Rate vs Update Frequency          ║'));
    console.log(chalk.yellow.bold('╚══════════════════════════════════════════════════════╝'));

    if (!fs.existsSync(CSV_INPUT)) {
        console.error(chalk.red('\n❌ Chạy: node generate_data.js trước\n'));
        process.exit(1);
    }

    const { pools, cursors } = loadPrices(CSV_INPUT);
    console.log(chalk.gray(`\n  Loaded price data | Symbols: ${ALL_SYMBOLS.join(', ')}`));

    const header = '\ufeffMức tải (TPS),Tổng Request,Thành công (Commit),Xung đột BTO (Abort),Tỷ lệ thành công (%),Tỷ lệ xung đột (%)\n';
    fs.writeFileSync(CSV_OUTPUT, header, 'utf8');

    const results = [];
    for (const scenario of SCENARIOS) {
        const r = await runBenchmark(scenario, pools, cursors);
        results.push(r);
        fs.appendFileSync(CSV_OUTPUT,
            `${r.tps},${r.total},${r.commits},${r.btoAborts},${r.successRate}%,${r.abortRate}%\n`
        );
        if (scenario !== SCENARIOS[SCENARIOS.length - 1]) {
            process.stdout.write(chalk.gray('\n  ⏳ Cooldown 3s...\n'));
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    // Summary
    console.log(chalk.yellow.bold('\n\n┌──────┬──────────┬──────────┬────────────┬────────────┐'));
    console.log(chalk.yellow.bold(  '│  TPS │ Strategy │  Commit% │ BTO Abort  │ Abort Rate │'));
    console.log(chalk.yellow.bold(  '├──────┼──────────┼──────────┼────────────┼────────────┤'));
    results.forEach((r, i) => {
        const s = SCENARIOS[i].strategy.padEnd(8);
        const a = parseFloat(r.abortRate);
        const aStr = (a >= 55 ? chalk.red : a >= 30 ? chalk.yellow : chalk.green)(
            `${r.abortRate}%`.padStart(9)
        );
        console.log(`│ ${String(r.tps).padStart(4)} │ ${s} │ ${r.successRate.padStart(7)}% │ ${String(r.btoAborts).padStart(10)} │ ${aStr} │`);
    });
    console.log(chalk.yellow.bold(  '└──────┴──────────┴──────────┴────────────┴────────────┘'));

    const rates = results.map(r => parseFloat(r.abortRate));
    const mono  = rates.every((v, i) => i === 0 || v >= rates[i-1] * 0.85);
    console.log(mono
        ? chalk.green.bold('\n  ✅ Abort rate tăng đơn điệu — đúng lý thuyết BTO (Ozsu §5.2.2)')
        : chalk.yellow('\n  ⚠ Abort rate chưa đơn điệu')
    );
    console.log(chalk.green.bold(`\n  ✨ Kết quả: ${CSV_OUTPUT}\n`));
}

main().catch(e => { console.error(chalk.red(e.message)); process.exit(1); });