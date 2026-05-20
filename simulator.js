/**
 * simulator_v2.js  ─  Yahoo-Finance-derived Realistic BTO Simulator
 * ═══════════════════════════════════════════════════════════════════
 * Đọc giá lịch sử từ ./data/stock_history.csv (sinh bởi generate_data.js)
 * Replay như "dòng chảy giá thực tế" qua hệ thống BTO.
 *
 * CHIẾN LƯỢC ĐẠT ABORT RATE HỢP LÝ:
 *   • TPS thấp  (10–50)  → nhiều symbol khác nhau → ít conflict → abort ~15–35%
 *   • TPS cao   (100–500)→ tập trung 1–2 symbol hot → conflict tăng → abort ~50–75%
 *   • Mỗi symbol có "tick pool" riêng, replay tuần tự → giá hợp lý, không random
 *   • Mix 70% WRITE / 30% READ → READ conflict khi ts < W_TS, tự nhiên hơn
 *
 * Chạy: node simulator_v2.js
 * ═══════════════════════════════════════════════════════════════════
 */

const axios = require('axios');
const fs    = require('fs');
const chalk = require('chalk');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const COORDINATOR_URL = 'http://localhost:3000/api/transaction';
const CSV_INPUT       = './data/stock_history.csv';
const CSV_OUTPUT      = './benchmark_results.csv';
const REQUEST_TIMEOUT = 3000; // ms

// Kịch bản benchmark: [tps, durationSeconds, symbolStrategy]
// symbolStrategy: 'spread' = 5 mã đều | 'hot1' = 1 mã | 'hot2' = 2 mã
const SCENARIOS = [
    { tps:  10, duration: 5, strategy: 'spread' }, // Tải thấp → spread → ít conflict
    { tps:  50, duration: 5, strategy: 'spread' }, // Bắt đầu thấy conflict
    { tps: 100, duration: 5, strategy: 'hot2'   }, // Tập trung 2 mã → conflict rõ
    { tps: 200, duration: 5, strategy: 'hot1'   }, // 1 mã nóng → conflict cao
    { tps: 500, duration: 5, strategy: 'hot1'   }, // Bão hòa BTO
];

const HOT_SYMBOL_1 = 'FPT';  // Site 1 — nhiều WRITE tranh nhau
const HOT_SYMBOL_2 = 'AAPL'; // Site 1 — thêm symbol để tăng variability
const ALL_SYMBOLS  = ['AAPL', 'MSFT', 'BTC', 'FPT', 'VNM'];

// ── LOAD PRICE DATA ───────────────────────────────────────────────────────────
function loadPriceData(csvPath) {
    const raw = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    raw.shift(); // bỏ header

    // Tạo pool ticks cho từng symbol: { AAPL: [price, price, ...], ... }
    const pools = {};
    for (const symbol of ALL_SYMBOLS) pools[symbol] = [];

    for (const line of raw) {
        const [date, symbol, tick, price] = line.split(',');
        if (pools[symbol]) {
            pools[symbol].push(parseFloat(price));
        }
    }

    // Cursor để replay tuần tự (không lặp lại)
    const cursors = {};
    for (const sym of ALL_SYMBOLS) cursors[sym] = 0;

    return { pools, cursors };
}

// Lấy giá tiếp theo theo thứ tự lịch sử, vòng lại khi hết
function nextPrice(pools, cursors, symbol) {
    const pool = pools[symbol];
    const idx  = cursors[symbol] % pool.length;
    cursors[symbol]++;
    return pool[idx].toFixed(2);
}

// ── TRANSACTION SENDER ────────────────────────────────────────────────────────
async function sendTransaction(symbol, price, pools, cursors) {
    // 70% WRITE, 30% READ — đúng thực tế stock platform
    const isRead = Math.random() < 0.30;
    const payload = {
        symbol,
        type:     isRead ? 'READ' : 'WRITE',
        newPrice: isRead ? undefined : nextPrice(pools, cursors, symbol),
    };

    try {
        await axios.post(COORDINATOR_URL, payload, { timeout: REQUEST_TIMEOUT });
        return 'COMMIT';
    } catch (err) {
        if (err.response?.status === 409) return 'BTO_ABORT'; // BTO rule violation
        if (err.code === 'ECONNREFUSED')  return 'SYS_ERROR'; // node down
        if (err.code === 'ECONNABORTED')  return 'SYS_ERROR'; // timeout
        return 'SYS_ERROR';
    }
}

// Chọn symbol theo strategy
function pickSymbol(strategy, allSymbols) {
    switch (strategy) {
        case 'hot1':   return HOT_SYMBOL_1;
        case 'hot2':   return Math.random() < 0.7 ? HOT_SYMBOL_1 : HOT_SYMBOL_2;
        case 'spread':
        default:       return allSymbols[Math.floor(Math.random() * allSymbols.length)];
    }
}

// ── BENCHMARK RUNNER ──────────────────────────────────────────────────────────
async function runBenchmark(scenario, pools, cursors) {
    const { tps, duration, strategy } = scenario;

    console.log(chalk.cyan.bold(`\n${'═'.repeat(55)}`));
    console.log(chalk.cyan.bold(`  🚀 TPS: ${tps} req/s × ${duration}s  |  Strategy: ${strategy.toUpperCase()}`));
    console.log(chalk.cyan.bold(`${'═'.repeat(55)}`));

    let commits   = 0;
    let btoAborts = 0;
    let sysErrors = 0;

    // Chỗ 1 — Giảm timeout để lỗi nhanh hơn, không queue lâu
const REQUEST_TIMEOUT = 3000; // đổi từ 8000 → 3000

// Chỗ 2 — Thêm strategy 'hot1' cho 500 TPS nhưng bắn theo batch nhỏ
// Tìm hàm runBenchmark, thay vòng for bên trong:
for (let sec = 1; sec <= duration; sec++) {
    // Chia 500 req thành 5 batch × 100ms thay vì 1 lúc
    const batchSize = Math.min(tps, 100);
    const numBatches = Math.ceil(tps / batchSize);
    
    for (let b = 0; b < numBatches; b++) {
        const batch = Array.from({ length: batchSize }, () => {
            const sym = pickSymbol(strategy, ALL_SYMBOLS);
            return sendTransaction(sym, null, pools, cursors);
        });
        const results = await Promise.all(batch);
        results.forEach(r => {
            if (r === 'COMMIT')     commits++;
            else if (r === 'BTO_ABORT') btoAborts++;
            else                    sysErrors++;
        });
        // Delay nhỏ giữa các batch để timestamp thực sự overlap
        if (b < numBatches - 1) await new Promise(r => setTimeout(r, 80));
    }
    process.stdout.write(`\r  Giây ${sec}/${duration}`);
}

    const total       = tps * duration;
    const successRate = ((commits   / total) * 100).toFixed(2);
    const abortRate   = ((btoAborts / total) * 100).toFixed(2);
    const errorRate   = ((sysErrors / total) * 100).toFixed(2);

    // Color-coded result
    const abortNum = parseFloat(abortRate);
    const abortColored = abortNum < 40
        ? chalk.green(`${abortRate}%`)
        : abortNum < 70
            ? chalk.yellow(`${abortRate}%`)
            : chalk.red(`${abortRate}%`);

    console.log(`\n`);
    console.log(chalk.white(`  Tổng request : ${chalk.bold(total)}`));
    console.log(chalk.green(`  ✓ Commit      : ${commits}  (${successRate}%)`));
    console.log(chalk.red(  `  ✗ BTO Abort   : ${btoAborts}  (`) + abortColored + chalk.red(')'));
    console.log(chalk.gray( `  ! Sys Error   : ${sysErrors}  (${errorRate}%)`));

    return { tps, total, commits, btoAborts, sysErrors, successRate, abortRate };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log(chalk.yellow.bold('\n╔══════════════════════════════════════════════════════╗'));
    console.log(chalk.yellow.bold('║   BTO BENCHMARK  —  Yahoo Finance Derived Dataset    ║'));
    console.log(chalk.yellow.bold('║   Özsu & Valduriez Algorithm 5.5 (BTO-SC)            ║'));
    console.log(chalk.yellow.bold('╚══════════════════════════════════════════════════════╝'));

    // Load price data
    if (!fs.existsSync(CSV_INPUT)) {
        console.error(chalk.red(`\n❌ Không tìm thấy ${CSV_INPUT}`));
        console.error(chalk.red('   Hãy chạy: node generate_data.js trước\n'));
        process.exit(1);
    }

    const { pools, cursors } = loadPriceData(CSV_INPUT);
    const totalTicks = Object.values(pools).reduce((s, p) => s + p.length, 0);
    console.log(chalk.gray(`\n  📂 Đã load ${totalTicks} price ticks từ ${CSV_INPUT}`));
    console.log(chalk.gray(`  📋 Symbols: ${ALL_SYMBOLS.join(', ')}\n`));

    // Init CSV output
    const csvHeader = '\ufeffMức tải (TPS),Tổng Request,Thành công (Commit),BTO Abort,Lỗi hệ thống,Tỷ lệ thành công (%),Tỷ lệ BTO Abort (%)\n';
    fs.writeFileSync(CSV_OUTPUT, csvHeader, 'utf8');

    // Run all scenarios
    const results = [];
    for (const scenario of SCENARIOS) {
        const result = await runBenchmark(scenario, pools, cursors);
        results.push(result);

        // Write to CSV immediately
        const line = `${result.tps},${result.total},${result.commits},${result.btoAborts},${result.sysErrors},${result.successRate}%,${result.abortRate}%\n`;
        fs.appendFileSync(CSV_OUTPUT, line, 'utf8');

        // Cool-down giữa các scenarios
        if (scenario !== SCENARIOS[SCENARIOS.length - 1]) {
            process.stdout.write(chalk.gray('\n  ⏳ Cooldown 3s...'));
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    // Summary table
    console.log(chalk.yellow.bold('\n\n┌─────────────────────────────────────────────────────┐'));
    console.log(chalk.yellow.bold('│                    TỔNG KẾT BENCHMARK                │'));
    console.log(chalk.yellow.bold('├──────┬──────────┬──────────┬────────────┬────────────┤'));
    console.log(chalk.yellow.bold('│  TPS │ Strategy │  Commit% │ BTO Abort% │ Sys Error% │'));
    console.log(chalk.yellow.bold('├──────┼──────────┼──────────┼────────────┼────────────┤'));

    for (const r of results) {
        const strat = SCENARIOS.find(s => s.tps === r.tps)?.strategy || '';
        const abortN = parseFloat(r.abortRate);
        const abortStr = abortN > 60
            ? chalk.red(r.abortRate.padStart(9) + '%')
            : abortN > 35
                ? chalk.yellow(r.abortRate.padStart(9) + '%')
                : chalk.green(r.abortRate.padStart(9) + '%');
        const errorN = parseFloat(((r.sysErrors / r.total) * 100).toFixed(2));
        const errorStr = errorN > 5 ? chalk.red(`${errorN.toFixed(2)}%`.padStart(9)) : `${errorN.toFixed(2)}%`.padStart(9);

        console.log(
            `│ ${String(r.tps).padStart(4)} │ ${strat.padEnd(8)} │ ${r.successRate.padStart(7)}% │ ${abortStr.padStart(10)} │ ${errorStr} │`
        );
    }
    console.log(chalk.yellow.bold('└──────┴──────────┴──────────┴────────────┴────────────┘'));

    console.log(chalk.green.bold(`\n  ✨ Kết quả đã ghi vào: ${CSV_OUTPUT}`));
    console.log(chalk.gray(`  📖 Lý thuyết: "the penalty of deadlock freedom is potential restart`));
    console.log(chalk.gray(`     numerous times" — Özsu & Valduriez, Principles of DDB, §5.2.2\n`));
}

main().catch(err => {
    console.error(chalk.red('\n❌ Lỗi:', err.message));
    process.exit(1);
});
