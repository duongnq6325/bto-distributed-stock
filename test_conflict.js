const axios = require('axios');
const chalk = require('chalk');

async function runConflictTest() {
    console.log(chalk.yellow("\n--- BẮT ĐẦU TEST XUNG ĐỘT BTO ---"));

    const tsNew = Date.now();
    const tsOld = tsNew - 3600000; // Cố tình lùi lại 1 tiếng trước

    try {
        // Lệnh 1: Thực thi lệnh hợp lệ với mốc thời gian mới
        console.log(chalk.cyan(`Lệnh 1 (Mới): Gửi giá 130 cho FPT với TS = ${tsNew}`));
        const res1 = await axios.post('http://localhost:3000/api/transaction', {
            symbol: 'FPT', 
            type: 'WRITE', 
            newPrice: 130,
            forcedTS: tsNew // Ép coordinator dùng mốc thời gian này
        });
        console.log(chalk.green(` -> Lệnh 1 thành công: ${JSON.stringify(res1.data)}`));

        // Tạo khoảng trễ nhỏ 200ms bảo đảm DB của Site 2 đã ghi nhận xong W_TS = tsNew
        await new Promise(resolve => setTimeout(resolve, 200));

        // Lệnh 2: Thực thi lệnh muộn (Mốc thời gian cũ hơn W_TS hiện tại trong DB)
        console.log(chalk.red(`Lệnh 2 (Cũ): Gửi giá 110 cho FPT với TS cũ rích = ${tsOld}`));
        const res2 = await axios.post('http://localhost:3000/api/transaction', {
            symbol: 'FPT', 
            type: 'WRITE', 
            newPrice: 110, 
            forcedTS: tsOld // Giao dịch này bắt buộc phải bị BTO từ chối
        });
        
        console.log(chalk.bgYellow.black(" CẢNH BÁO: Lệnh cũ không bị chặn! Kiểm tra lại logic BTO ở Site Server. "));
    } catch (error) {
        if (error.response && error.response.status === 409) {
            console.log(chalk.bgGreen.white("\n KẾT QUẢ TEST: Hệ thống chặn thành công giao dịch cũ theo đúng luật BTO! "));
            console.log(chalk.green(` Chi tiết lỗi trả về: [409] ${error.response.data.reason}\n`));
        } else {
            console.log(chalk.bgRed.white("\n XẢY RA LỖI HỆ THỐNG KHÁC: "));
            console.error(error.message);
        }
    }
}

runConflictTest();