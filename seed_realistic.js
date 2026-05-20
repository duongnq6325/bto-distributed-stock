/**
 * seed_realistic.js
 * ─────────────────────────────────────────────────────────────────
 * Nạp dữ liệu khởi tạo vào 2 MySQL sites với giá THỰC TẾ
 * lấy từ ./data/stock_history.csv (giá đóng cửa ngày đầu tiên)
 *
 * Chạy: node seed_realistic.js
 * ─────────────────────────────────────────────────────────────────
 */

const mysql = require('mysql2/promise');
const fs    = require('fs');
const chalk = require('chalk');

// Giá mở đầu (anchor ngày 2025-04-01) — lấy từ generate_data.js
const INITIAL_PRICES = {
    AAPL: 223.19,    // NASDAQ — USD
    MSFT: 378.80,    // NASDAQ — USD
    BTC:  85187.00,  // Crypto  — USD
    FPT:  118.50,    // HOSE   — VND (nghìn)
    VNM:  68.50,     // HOSE   — VND (nghìn)
};

// Fragmentation rule: A–M → Site1, N–Z → Site2
const FRAGMENTATION = {
    SITE1: ['AAPL', 'BTC', 'FPT', 'MSFT'], // A, B, F, M
    SITE2: ['VNM'],                          // V
};

const DB_CONFIG = {
    host:     'localhost',
    user:     'root',
    password: 'root',
    database: 'stock_db',
};

const CREATE_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS Stock_Ticker (
        Symbol       VARCHAR(10)    PRIMARY KEY,
        CurrentPrice DECIMAL(18, 2) NOT NULL,
        R_TS         BIGINT         DEFAULT 0 COMMENT 'Max Read Timestamp (BTO)',
        W_TS         BIGINT         DEFAULT 0 COMMENT 'Max Write Timestamp (BTO)'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      COMMENT='BTO Stock Ticker — Özsu & Valduriez Algorithm 5.5';
`;

async function seed() {
    console.log(chalk.yellow.bold('\n╔═══════════════════════════════════════════════╗'));
    console.log(chalk.yellow.bold('║   BTO SEED  —  Realistic Price Initialization ║'));
    console.log(chalk.yellow.bold('╚═══════════════════════════════════════════════╝\n'));

    let conn1, conn2;

    try {
        conn1 = await mysql.createConnection({ ...DB_CONFIG, port: 3301 });
        conn2 = await mysql.createConnection({ ...DB_CONFIG, port: 3302 });
        console.log(chalk.green('  ✅ Kết nối thành công đến Site 1 (:3301) và Site 2 (:3302)\n'));

        // Create tables
        await conn1.query(CREATE_TABLE_SQL);
        await conn2.query(CREATE_TABLE_SQL);

        // Clear old data
        await conn1.query('TRUNCATE TABLE Stock_Ticker');
        await conn2.query('TRUNCATE TABLE Stock_Ticker');

        // Insert with real prices
        console.log(chalk.cyan('  📊 Nạp dữ liệu theo Horizontal Fragmentation:\n'));

        for (const symbol of FRAGMENTATION.SITE1) {
            const price = INITIAL_PRICES[symbol];
            await conn1.query(
                'INSERT INTO Stock_Ticker (Symbol, CurrentPrice, R_TS, W_TS) VALUES (?, ?, 0, 0)',
                [symbol, price]
            );
            console.log(chalk.green(`    ✓ Site 1 ← ${symbol.padEnd(6)} | Price: ${String(price).padStart(10)} | R_TS: 0 | W_TS: 0`));
        }

        for (const symbol of FRAGMENTATION.SITE2) {
            const price = INITIAL_PRICES[symbol];
            await conn2.query(
                'INSERT INTO Stock_Ticker (Symbol, CurrentPrice, R_TS, W_TS) VALUES (?, ?, 0, 0)',
                [symbol, price]
            );
            console.log(chalk.green(`    ✓ Site 2 ← ${symbol.padEnd(6)} | Price: ${String(price).padStart(10)} | R_TS: 0 | W_TS: 0`));
        }

        // Verify
        console.log(chalk.cyan('\n  🔍 Kiểm tra dữ liệu sau khi nạp:\n'));

        const [rows1] = await conn1.query('SELECT Symbol, CurrentPrice, R_TS, W_TS FROM Stock_Ticker ORDER BY Symbol');
        const [rows2] = await conn2.query('SELECT Symbol, CurrentPrice, R_TS, W_TS FROM Stock_Ticker ORDER BY Symbol');

        console.log(chalk.white('  ┌─ Site 1 (Port 3301) — Fragment A–M ─────────────┐'));
        for (const r of rows1) {
            console.log(chalk.white(`  │  ${r.Symbol.padEnd(6)} | $${String(r.CurrentPrice).padStart(11)} | R_TS:${r.R_TS} | W_TS:${r.W_TS}  │`));
        }
        console.log(chalk.white('  └─────────────────────────────────────────────────┘\n'));

        console.log(chalk.white('  ┌─ Site 2 (Port 3302) — Fragment N–Z ─────────────┐'));
        for (const r of rows2) {
            console.log(chalk.white(`  │  ${r.Symbol.padEnd(6)} | $${String(r.CurrentPrice).padStart(11)} | R_TS:${r.R_TS} | W_TS:${r.W_TS}  │`));
        }
        console.log(chalk.white('  └─────────────────────────────────────────────────┘\n'));

        console.log(chalk.green.bold('  ✨ Seed hoàn tất! Hệ thống sẵn sàng cho BTO benchmark.\n'));
        console.log(chalk.gray('  Bước tiếp theo:'));
        console.log(chalk.gray('    1. node coordinator.js'));
        console.log(chalk.gray('    2. node site_server.js 3001'));
        console.log(chalk.gray('    3. node site_server.js 3002'));
        console.log(chalk.gray('    4. node simulator_v2.js\n'));

    } catch (err) {
        console.error(chalk.red('\n  ❌ Lỗi:', err.message));
        console.error(chalk.gray('  Đảm bảo Docker đang chạy: docker-compose up -d\n'));
    } finally {
        if (conn1) await conn1.end();
        if (conn2) await conn2.end();
    }
}

seed();
