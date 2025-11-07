const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const router = express.Router();

// Lấy các biến môi trường từ Netlify
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const CATBOX_HASH = process.env.CATBOX_USER_HASH;

// --- CẤU HÌNH ĐỂ TRÁNH TIMEOUT ---
const DEFAULT_PROXY_COUNT = 100; // Giảm số lượng mặc định
const MAX_PROXY_COUNT = 200;     // Đặt giới hạn tối đa để đảm bảo không bị quá tải
const PROXY_CHECK_TIMEOUT = 5000; // 5 giây timeout cho mỗi lần kiểm tra proxy

// --- CÁC HÀM HỖ TRỢ ---

/**
 * Lấy và xáo trộn danh sách proxy từ ProxyScrape.
 */
async function getProxyList() {
    try {
        const response = await axios.get('https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity_level=elite_proxy,anonymous');
        const proxies = response.data.split('\r\n').filter(p => p);
        // Xáo trộn mảng proxy để tăng cơ hội tìm thấy proxy sống sớm
        for (let i = proxies.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [proxies[i], proxies[j]] = [proxies[j], proxies[i]];
        }
        return proxies;
    } catch (error) {
        console.error('Lỗi khi lấy danh sách proxy:', error.message);
        throw new Error('Không thể lấy danh sách proxy từ nguồn.');
    }
}

/**
 * Kiểm tra xem một proxy có "sống" hay không.
 * @param {string} proxy - Proxy dạng "ip:port"
 * @returns {Promise<boolean>} - Trả về true nếu sống, ngược lại false.
 */
async function isProxyLive(proxy) {
    try {
        await axios.get('https://httpbin.org/ip', {
            proxy: {
                host: proxy.split(':')[0],
                port: parseInt(proxy.split(':')[1], 10),
                protocol: 'http'
            },
            timeout: PROXY_CHECK_TIMEOUT
        });
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Tải nội dung file lên Catbox.me.
 * @param {string} fileContent - Nội dung file.
 * @returns {Promise<string>} - URL của file đã tải lên.
 */
async function uploadToCatbox(fileContent) {
    if (!CATBOX_HASH) {
        throw new Error('CATBOX_USER_HASH chưa được cấu hình trong biến môi trường.');
    }
    try {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('userhash', CATBOX_HASH);
        form.append('fileToUpload', Buffer.from(fileContent), {
            filename: 'proxies.txt',
            contentType: 'text/plain',
        });

        const response = await axios.post('https://catbox.moe/user/api.php', form, {
            headers: form.getHeaders(),
        });

        if (response.status === 200 && response.data) {
            return response.data;
        } else {
            throw new Error(`Catbox API trả về status ${response.status}`);
        }
    } catch (error) {
        console.error('Lỗi khi tải file lên Catbox:', error.message);
        throw new Error(`Không thể tải file lên Catbox.me.`);
    }
}

// --- CÁC ENDPOINTS CỦA API ---

/**
 * Endpoint /: Hiển thị hướng dẫn sử dụng dưới dạng JSON
 */
router.get('/', (req, res) => {
    res.json({
        api_name: "Live Proxy Generator API",
        description: "API tạo danh sách proxy sống và tải lên Catbox.me.",
        endpoints: {
            home: {
                path: "/",
                description: "Hiển thị hướng dẫn sử dụng này."
            },
            proxy: {
                path: "/proxy",
                method: "GET",
                description: "Tạo và lấy link file chứa proxy sống.",
                parameters: {
                    count: `(Tùy chọn) Số lượng proxy muốn lấy. Mặc định: ${DEFAULT_PROXY_COUNT}. Tối đa: ${MAX_PROXY_COUNT}.`,
                    key: "(Bắt buộc) Khóa API để xác thực."
                },
                example: `/proxy?count=50&key=your_secret_key`
            }
        }
    });
});

/**
 * Endpoint /proxy: Tạo và trả về link file proxy
 */
router.get('/proxy', async (req, res) => {
    const { key, count } = req.query;

    if (!ADMIN_KEY || key !== ADMIN_KEY) {
        return res.status(401).json({ success: false, message: 'Lỗi xác thực: API key không hợp lệ.' });
    }

    let desiredCount = parseInt(count, 10) || DEFAULT_PROXY_COUNT;
    if (desiredCount > MAX_PROXY_COUNT) {
        desiredCount = MAX_PROXY_COUNT; // Áp dụng giới hạn tối đa
    }

    try {
        const rawProxies = await getProxyList();
        console.log(`Đã lấy ${rawProxies.length} proxy thô. Bắt đầu tìm ${desiredCount} proxy sống...`);

        const liveProxies = [];
        // Tối ưu: Chỉ kiểm tra cho đến khi đủ số lượng yêu cầu
        for (const proxy of rawProxies) {
            if (liveProxies.length >= desiredCount) {
                console.log('Đã tìm đủ số lượng proxy sống yêu cầu.');
                break; // Dừng lại ngay khi đã đủ
            }
            if (await isProxyLive(proxy)) {
                liveProxies.push(proxy);
            }
        }

        if (liveProxies.length === 0) {
            return res.status(503).json({ success: false, message: 'Không tìm thấy proxy nào hoạt động tại thời điểm này. Vui lòng thử lại sau.' });
        }

        const fileContent = liveProxies.join('\n');
        console.log(`Tìm thấy ${liveProxies.length} proxy. Đang tải file lên Catbox.me...`);
        const catboxUrl = await uploadToCatbox(fileContent);
        console.log(`Tải lên thành công: ${catboxUrl}`);

        res.json({
            success: true,
            message: `Đã tìm thấy và tải lên ${liveProxies.length} proxy sống.`,
            proxy_count: liveProxies.length,
            url: catboxUrl
        });

    } catch (error) {
        console.error('Lỗi trong quá trình xử lý /proxy:', error);
        res.status(500).json({ success: false, message: error.message || 'Đã xảy ra lỗi không xác định.' });
    }
});

// Cấu hình để chạy trên Netlify
app.use('/.netlify/functions/api', router);
module.exports.handler = serverless(app);
