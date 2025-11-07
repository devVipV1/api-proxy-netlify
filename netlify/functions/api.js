const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const router = express.Router();

// Lấy các biến môi trường từ Netlify
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const CATBOX_HASH = process.env.CATBOX_USER_HASH;

// --- CẤU HÌNH ---
// Giờ đây có thể tăng số lượng vì không còn bước kiểm tra tốn thời gian
const DEFAULT_PROXY_COUNT = 1000;
const MAX_PROXY_COUNT = 2000;

// --- CÁC HÀM HỖ TRỢ ---

/**
 * Lấy danh sách proxy từ ProxyScrape.
 */
async function getProxyList() {
    try {
        const response = await axios.get('https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity_level=elite_proxy,anonymous');
        return response.data.split('\r\n').filter(p => p); // Tách chuỗi thành mảng và loại bỏ dòng trống
    } catch (error) {
        console.error('Lỗi khi lấy danh sách proxy:', error.message);
        throw new Error('Không thể lấy danh sách proxy từ nguồn.');
    }
}

/**
 * Tải nội dung file lên Catbox.me.
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
        const response = await axios.post('https://catbox.moe/user/api.php', form, { headers: form.getHeaders() });
        if (response.status === 200 && response.data) {
            return response.data;
        } else {
            throw new Error(`Catbox API trả về status ${response.status}`);
        }
    } catch (error) {
        console.error('Lỗi khi tải file lên Catbox:', error.message);
        throw new Error('Không thể tải file lên Catbox.me.');
    }
}

// --- CÁC ENDPOINTS CỦA API ---

/**
 * Endpoint /: Hiển thị hướng dẫn sử dụng dưới dạng JSON
 */
router.get('/', (req, res) => {
    res.json({
        api_name: "Proxy Scraper API",
        description: "API lấy danh sách proxy thô và tải lên Catbox.me (không kiểm tra proxy sống).",
        endpoints: {
            proxy: {
                path: "/proxy",
                method: "GET",
                parameters: {
                    count: `(Tùy chọn) Số lượng proxy muốn lấy. Mặc định: ${DEFAULT_PROXY_COUNT}. Tối đa: ${MAX_PROXY_COUNT}.`,
                    key: "(Bắt buộc) Khóa API để xác thực."
                },
                example: `/proxy?count=500&key=your_secret_key`
            }
        }
    });
});

/**
 * Endpoint /proxy: Lấy proxy và trả về link file
 */
router.get('/proxy', async (req, res) => {
    const { key, count } = req.query;

    // 1. Xác thực API Key
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
        return res.status(401).json({ success: false, message: 'Lỗi xác thực: API key không hợp lệ.' });
    }

    let desiredCount = parseInt(count, 10) || DEFAULT_PROXY_COUNT;
    if (desiredCount > MAX_PROXY_COUNT) desiredCount = MAX_PROXY_COUNT;

    try {
        // 2. Lấy danh sách proxy thô
        const rawProxies = await getProxyList();
        console.log(`Đã lấy được ${rawProxies.length} proxy thô.`);

        if (rawProxies.length === 0) {
            return res.status(503).json({ success: false, message: 'Nguồn cung cấp không trả về proxy nào.' });
        }

        // 3. Lấy đủ số lượng yêu cầu (không cần kiểm tra)
        const proxiesToUpload = rawProxies.slice(0, desiredCount);

        // 4. Tải file lên và trả kết quả
        const fileContent = proxiesToUpload.join('\n');
        const catboxUrl = await uploadToCatbox(fileContent);
        
        console.log(`Tải lên thành công ${proxiesToUpload.length} proxy.`);

        res.json({
            success: true,
            message: `Đã lấy và tải lên thành công ${proxiesToUpload.length} proxy.`,
            proxy_count: proxiesToUpload.length,
            url: catboxUrl
        });

    } catch (error) {
        console.error('Lỗi trong quá trình xử lý /proxy:', error);
        res.status(500).json({ success: false, message: error.message || 'Đã xảy ra lỗi không xác định.' });
    }
});

// Gắn router vào đường dẫn gốc
app.use('/', router);

// Xuất handler cho Netlify
module.exports.handler = serverless(app);
