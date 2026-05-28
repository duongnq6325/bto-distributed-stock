/**
 * seed_realistic.js — Nạp dữ liệu vào 3 Sites
 * ═══════════════════════════════════════════════
 * Fragmentation:
 *   A–H → Site 1 :3301  (AAPL, BTC)
 *   I–P → Site 2 :3302  (FPT, MSFT)
 *   Q–Z → Site 3 :3303  (VNM)
 */

const mysql = require('mysql2/promise');
const chalk = require('chalk');

const SITES = [
    { name: 'Site 1', port: 3301, fragment: 'A–C', symbols: ['AAPL', 'BTC'] },
    { name: 'Site 2', port: 3302, fragment: 'D–N', symbols: ['FPT', 'MSFT'] },
    { name: 'Site 3', port: 3303, fragment: 'O–Z', symbols: ['VNM'] },
];

const PRICES = {
    AAPL: 223.19,
    BTC:  85187.00,
    FPT:  118.50,
    MSFT: 378.80,
    VNM:  68.50,
};

const CREATE_SQL = `
    CREATE TABLE IF NOT EXISTS Stock_Ticker (
        Symbol       VARCHAR(10)    PRIMARY KEY,
        CurrentPrice DECIMAL(18,2)  NOT NULL,
        R_TS         BIGINT         DEFAULT 0 COMMENT 'Max Read Timestamp — BTO',
        W_TS         BIGINT         DEFAULT 0 COMMENT 'Max Write Timestamp — BTO'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function seed() {
    console.log(chalk.yellow.bold('\n╔════════════════════════════════════════════╗'));
    console.log(chalk.yellow.bold('║   BTO SEED — 3-Site Horizontal Fragment    ║'));
    console.log(chalk.yellow.bold('╚════════════════════════════════════════════╝\n'));

    for (const site of SITES) {
        let conn;
        try {
            conn = await mysql.createConnection({
                host: 'localhost', user: 'root', password: 'root',
                database: 'stock_db', port: site.port,
            });

            await conn.query(CREATE_SQL);
            await conn.query('TRUNCATE TABLE Stock_Ticker');

            for (const symbol of site.symbols) {
                await conn.query(
                    'INSERT INTO Stock_Ticker (Symbol, CurrentPrice, R_TS, W_TS) VALUES (?, ?, 0, 0)',
                    [symbol, PRICES[symbol]]
                );
                console.log(chalk.green(
                    `  ✓ ${site.name} (:${site.port}) ← ${symbol.padEnd(6)} $${String(PRICES[symbol]).padStart(10)}`
                ));
            }

            const [rows] = await conn.query('SELECT COUNT(*) as c FROM Stock_Ticker');
            console.log(chalk.gray(`    └─ ${rows[0].c} records in ${site.name} (Fragment ${site.fragment})\n`));

        } catch (err) {
            console.error(chalk.red(`  ✗ ${site.name} (:${site.port}) — ${err.message}`));
        } finally {
            if (conn) await conn.end();
        }
    }

    console.log(chalk.green.bold('  ✨ Seed complete! System ready.\n'));
    console.log(chalk.gray('  Start order:'));
    console.log(chalk.gray('    1. node coordinator.js'));
    console.log(chalk.gray('    2. node site_server.js 3001'));
    console.log(chalk.gray('    3. node site_server.js 3002'));
    console.log(chalk.gray('    4. node site_server.js 3003'));
    console.log(chalk.gray('    5. Open http://localhost:3000\n'));
}

seed();