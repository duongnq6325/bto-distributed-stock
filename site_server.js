const express = require('express');
const mysql = require('mysql2/promise');
const chalk = require('chalk'); // Để in log màu

const app = express();
app.use(express.json());

// 1. Nhận Port từ lệnh chạy (Mặc định 3001)
const PORT = process.argv[2] || 3001;
const DB_PORT = (PORT == 3001) ? 3301 : 3302;
const SITE_NAME = `SITE ${PORT == 3001 ? '1' : '2'}`;

// 2. Khởi tạo Connection Pool (Chống sập khi tải cao)
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'root',
    database: 'stock_db',
    port: DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// 3. Bộ nhớ đệm lưu các giao dịch đang ở trạng thái PREPARE (Chờ Commit)
// Cấu trúc: { "timestamp_id": { symbol, type, newPrice } }
const preparedTransactions = {};
// --- PHA 1: PREPARE (Kiểm tra luật BTO) ---
app.post('/prepare', async (req, res) => {
    // ts: Nhãn thời gian của giao dịch (đóng vai trò là Transaction ID)
    // type: 'READ' hoặc 'WRITE'
    const { ts, type, symbol, newPrice } = req.body;

    try {
        const [rows] = await pool.query('SELECT * FROM Stock_Ticker WHERE Symbol = ?', [symbol]);
        const stock = rows[0];

        if (!stock) return res.status(404).json({ status: 'ERROR', message: 'Mã không tồn tại ở Site này' });

        // LUẬT 1: NẾU LÀ LỆNH ĐỌC (READ)
        if (type === 'READ') {
            // Đọc dữ liệu quá khứ mà đã có ai ghi đè tương lai rồi -> HỦY
            if (ts < stock.W_TS) {
                console.log(chalk.red(`[ABORT] Lỗi Đọc: TS(${ts}) < W_TS(${stock.W_TS}) tại ${symbol}`));
                return res.status(409).json({ status: 'ABORT', reason: 'Read too late' });
            }
        } 
        
        // LUẬT 2: NẾU LÀ LỆNH GHI (WRITE)
        else if (type === 'WRITE') {
            // Ghi dữ liệu vào quá khứ mà đã có ai đọc hoặc ghi ở tương lai rồi -> HỦY
            if (ts < stock.R_TS || ts < stock.W_TS) {
                console.log(chalk.red(`[ABORT] Lỗi Ghi: TS(${ts}) vi phạm R_TS(${stock.R_TS})/W_TS(${stock.W_TS}) tại ${symbol}`));
                return res.status(409).json({ status: 'ABORT', reason: 'Write too late' });
            }
            
            // Ép kiểu chuẩn tài chính để tránh lỗi sai số dấu phẩy động (Floating-point error)
            req.body.newPrice = parseFloat(newPrice).toFixed(2);
        }

        // Nếu qua được các cửa ải trên -> Hợp lệ. Lưu vào bộ nhớ đệm, chờ Coordinator chốt hạ.
        preparedTransactions[ts] = req.body;
        
        console.log(chalk.yellow(`[PREPARED] Giao dịch ${ts} cho mã ${symbol} hợp lệ. Chờ Commit...`));
        return res.status(200).json({ status: 'READY' });

    } catch (error) {
        console.error(chalk.red(`[ERROR] ${error.message}`));
        return res.status(500).json({ status: 'ERROR' });
    }
});
// --- PHA 2A: COMMIT (Ghi chính thức vào Database) ---
app.post('/commit', async (req, res) => {
    const { ts } = req.body;
    const tx = preparedTransactions[ts];

    if (!tx) return res.status(400).json({ status: 'ERROR', message: 'Không tìm thấy giao dịch Prepared' });

    try {
        if (tx.type === 'READ') {
            // Cập nhật nhãn thời gian Đọc (Chỉ tăng lên, không giảm đi)
            await pool.query(
                'UPDATE Stock_Ticker SET R_TS = GREATEST(R_TS, ?) WHERE Symbol = ?',
                [ts, tx.symbol]
            );
        } else if (tx.type === 'WRITE') {
            // Cập nhật Giá mới và nhãn thời gian Ghi
            await pool.query(
                'UPDATE Stock_Ticker SET CurrentPrice = ?, W_TS = ? WHERE Symbol = ?',
                [tx.newPrice, ts, tx.symbol]
            );
        }

        // Xóa khỏi bộ nhớ đệm
        delete preparedTransactions[ts];
        
        console.log(chalk.green(`[COMMIT] Giao dịch ${ts} thành công! Đã update DB.`));
        return res.status(200).json({ status: 'ACK' }); // Acknowledged

    } catch (error) {
        console.error(chalk.red(`[FATAL] Lỗi lúc Commit: ${error.message}`));
        return res.status(500).json({ status: 'ERROR' });
    }
});

// --- PHA 2B: ABORT (Hủy bỏ giao dịch) ---
app.post('/abort', (req, res) => {
    const { ts } = req.body;
    
    if (preparedTransactions[ts]) {
        delete preparedTransactions[ts]; // Xóa dấu vết, coi như chưa có gì xảy ra
        console.log(chalk.gray(`[ROLLBACK] Đã dọn dẹp giao dịch ${ts} khỏi bộ đệm.`));
    }
    
    return res.status(200).json({ status: 'ACK' });
});
app.listen(PORT, () => {
    console.log(chalk.cyan(`🚀 [${SITE_NAME}] Data Manager is running on port ${PORT}`));
    console.log(chalk.cyan(`🔌 Connected to MySQL on port ${DB_PORT}`));
});