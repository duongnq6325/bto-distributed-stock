const express = require('express');
const axios = require('axios');
const chalk = require('chalk');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Cổng của Coordinator (Mặt tiền tiếp khách)
const PORT = 3000;

// Cấu hình danh bạ các Site (Data Managers)
const SITES = {
    SITE1: 'http://localhost:3001', // Chứa phân mảnh A-M
    SITE2: 'http://localhost:3002'  // Chứa phân mảnh N-Z
};

/**
 * MỤC ĐÍCH: Tính trong suốt phân mảnh (Fragmentation Transparency).
 * Hàm này định tuyến giao dịch đến đúng Site dựa trên chữ cái đầu của mã CK.
 */
function getTargetSite(symbol) {
    const firstLetter = symbol.charAt(0).toUpperCase();
    return (firstLetter <= 'M') ? SITES.SITE1 : SITES.SITE2;
}

// --- API TIẾP NHẬN GIAO DỊCH TỪ NGƯỜI DÙNG ---
// Hàm tiện ích tạo độ trễ (Đặt ở ngoài hoặc trong app.post đều được)
// Hàm tiện ích tạo độ trễ (Giúp quản lý async/await mượt mà hơn setTimeout)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.post('/api/transaction', async (req, res) => {
    // FIX 1: Ưu tiên nhận forcedTS từ Simulator để tạo xung đột cưỡng bách theo đúng đề bài
    const { symbol, type, newPrice, forcedTS } = req.body;
    const ts = forcedTS || Date.now(); 
    const targetSite = getTargetSite(symbol);
    console.log(chalk.gray(`[TM] TS:${ts} | ${type} | ${symbol} → ${targetSite}`));
    const randomDelay = Math.floor(Math.random() * 150);

    // Trì hoãn ngẫu nhiên giả lập jitter mạng
    await delay(randomDelay);

    try {
        // PHA 1: PREPARE
        const prepareRes = await axios.post(`${targetSite}/prepare`, {
            ts, type, symbol, newPrice
        }, { timeout: 3000 }); 

        if (prepareRes.status === 200 && prepareRes.data.status === 'READY') {
            // PHA 2: COMMIT
            await axios.post(`${targetSite}/commit`, { ts }, { timeout: 3000 });
            console.log(chalk.green(`[COMMIT] ✓ ${symbol} | TS:${ts}`));
            return res.status(200).json({ status: 'SUCCESS' });
        }
        
        return res.status(500).json({ status: 'ERROR', message: 'Site not ready' });

    } catch (error) {
        // ==============================================================
        // KỊCH BẢN FAILURE (NODE SẬP) - ĐÃ FIX Ở BƯỚC TRƯỚC
        // ==============================================================
        if (error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED' || !error.response) {
            const siteName = targetSite.includes('3002') ? "Site 2" : "Site 1";
            console.log(chalk.red.bold(`\n[CRITICAL] ${siteName} Offline. Initiating 2PC Global Abort...`));
            return res.status(500).json({ status: 'ERROR', message: `${siteName} sập nguồn.` });
        }

        // ==============================================================
        // FIX 3: TÁCH BỆNH - TRẢ VỀ 409 CHUẨN KHI VI PHẠM BTO 
        // ==============================================================
        if (error.response && error.response.status === 409) {
            await axios.post(`${targetSite}/abort`, { ts }).catch(() => {});
            console.log(chalk.red(`[ABORT] ✗ ${symbol} | TS:${ts} | BTO violation`));
            return res.status(409).json({ 
                status: 'ABORT', 
                reason: error.response.data.reason 
            });
        }

        return res.status(500).json({ status: 'ERROR', message: error.message });
    }
});
app.listen(PORT, () => {
    console.log(chalk.cyan.bold(`\n🌟 TỔNG TƯ LỆNH (Coordinator) ĐÃ SẴN SÀNG TẠI CỔNG ${PORT} 🌟`));
    console.log(chalk.cyan(`Cổng khách hàng: http://localhost:${PORT}/api/transaction`));
});