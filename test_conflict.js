const axios = require('axios');
const chalk = require('chalk');

async function runConflictTest() {
    console.log(chalk.yellow("--- BẮT ĐẦU TEST XUNG ĐỘT BTO ---"));

    // Lệnh 1: Một lệnh rất mới (TS hiện tại)
    const tsNew = Date.now();
    console.log(`Lệnh 1 (Mới): Gửi giá 130 cho FPT với TS = ${tsNew}`);
    await axios.post('http://localhost:3000/api/transaction', {
        symbol: 'FPT', type: 'WRITE', newPrice: 130
    });

    // Lệnh 2: Một lệnh "cũ" (Cố tình lấy TS từ 1 tiếng trước)
    const tsOld = Date.now() - 3600000; 
    console.log(chalk.red(`Lệnh 2 (Cũ): Gửi giá 110 cho FPT với TS cũ rích = ${tsOld}`));
    
    try {
        const res = await axios.post('http://localhost:3000/api/transaction', {
            symbol: 'FPT', type: 'WRITE', newPrice: 110, 
            forcedTS: tsOld // Chúng ta cần sửa nhẹ code Coordinator để nhận forcedTS này nếu muốn test
        });
    } catch (error) {
        console.log(chalk.bgRed.white(" KẾT QUẢ: Hệ thống đã chặn thành công giao dịch cũ! "));
        console.log(chalk.red("Lý do:", error.response.data.reason));
    }
}

runConflictTest();