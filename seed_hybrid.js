const mysql = require('mysql2/promise');

async function seed() {
    console.log("⏳ Bắt đầu nạp dữ liệu Lai vào hệ thống phân tán...");

    // 5 mã cổ phiếu thật với giá khởi điểm
    const hotStocks = [
        { symbol: 'AAPL', price: 189.84 },
        { symbol: 'BTC', price: 62500.12 },
        { symbol: 'FPT', price: 116.50 },
        { symbol: 'MSFT', price: 410.20 },
        { symbol: 'VNM', price: 67.20 }
    ];

    const config = { host: 'localhost', user: 'root', password: 'root', database: 'stock_db' };

    try {
        // Tạo kết nối đến 2 Site
        const connSite1 = await mysql.createConnection({ ...config, port: 3301 });
        const connSite2 = await mysql.createConnection({ ...config, port: 3302 });

        console.log("✅ Đã kết nối thành công đến cả 2 Site MySQL.");

        // SQL Tạo bảng chuẩn BTO
        const createTableSQL = `
            CREATE TABLE IF NOT EXISTS Stock_Ticker (
                Symbol VARCHAR(10) PRIMARY KEY,
                CurrentPrice DECIMAL(18, 2) NOT NULL,
                R_TS BIGINT DEFAULT 0,
                W_TS BIGINT DEFAULT 0
            )
        `;

        await connSite1.query(createTableSQL);
        await connSite2.query(createTableSQL);

        // Xóa dữ liệu cũ (nếu có) để nạp lại từ đầu cho sạch
        await connSite1.query('TRUNCATE TABLE Stock_Ticker');
        await connSite2.query('TRUNCATE TABLE Stock_Ticker');

        // Phân mảnh ngang (Fragmentation) và Nạp dữ liệu
        let site1Count = 0;
        let site2Count = 0;

        for (let stock of hotStocks) {
            // Luật phân mảnh: Ký tự đầu từ A-M vào Site 1, N-Z vào Site 2
            if (stock.symbol.charAt(0).toUpperCase() <= 'M') {
                await connSite1.query(
                    'INSERT INTO Stock_Ticker (Symbol, CurrentPrice) VALUES (?, ?)',
                    [stock.symbol, stock.price]
                );
                site1Count++;
            } else {
                await connSite2.query(
                    'INSERT INTO Stock_Ticker (Symbol, CurrentPrice) VALUES (?, ?)',
                    [stock.symbol, stock.price]
                );
                site2Count++;
            }
        }

        console.log(`✅ Đã nạp phân mảnh thành công!`);
        console.log(`   -> Site 1 (A-M): chứa ${site1Count} mã (Ví dụ: AAPL, BTC, FPT, MSFT)`);
        console.log(`   -> Site 2 (N-Z): chứa ${site2Count} mã (Ví dụ: VNM)`);

        await connSite1.end();
        await connSite2.end();
        
    } catch (error) {
        console.error("❌ Có lỗi xảy ra trong quá trình nạp dữ liệu:", error);
    }
}

seed();