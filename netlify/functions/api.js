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
const DEFAULT_PROXY_COUNT = 100;
const MAX_PROXY_COUNT = 200;
const PROXY_CHECK_TIMEOUT = 6000; // Timeout cho mỗi lần kiểm tra proxy

// --- CÁC HÀM HỖ TRỢ ---

/**
 * Lấy danh sách proxy từ ProxyScrape.
 */
async function getProxyList() {
    try {
        const response = await axios.get('https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity_level=elite_proxy,anonymous');
        return response.data.split('\r\n').filter(p => p);
    } catch (error) {
        console.error('Lỗi khi lấy danh sách proxy:', error.message);
        throw new Error('Không thể lấy danh sách proxy từ nguồn.');
    }
}

/**
 * Kiểm tra một proxy và trả về chính nó nếu sống, hoặc null nếu chết.
 * @param {string} proxy - Proxy dạng "ip:port"
 * @returns {Promise<string|null>}
 */
async function checkProxy(proxy) {
    try {
        await axios.get('https://httpbin.org/ip', {
            proxy: {
                host: proxy.split(':')[0],
                port: parseInt(proxy.split(':')[1], 10),
                protocol: 'http'
            },
            timeout: PROXY_CHECK_TIMEOUT
        });
        return proxy; // Trả về proxy nếu request thành công
    } catch (error) {
        return null; // Trả về null nếu có lỗi (timeout, connection failed, etc.)
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
        api_name: "Live Proxy Generator API",
        description: "API tạo danh sách proxy sống và tải lên Catbox.me.",
        status: "Hoạt động ổn định.",
        endpoints: {
            proxy: {
                path: "/proxy",
                method: "GET",
                parameters: {
                    count: `(Tùy chọn) Số lượng proxy. Mặc định: ${DEFAULT_PROXY_COUNT}. Tối đa: ${MAX_PROXY_COUNT}.`,
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
    if (desiredCount > MAX_PROXY_COUNT) desiredCount = MAX_PROXY_COUNT;

    try {
        // 1. Lấy danh sách proxy thô
        const rawProxies = await getProxyList();
        console.log(`Đã lấy ${rawProxies.length} proxy thô. Bắt đầu kiểm tra song song...`);

        // 2. TẠO MỘT LOẠT "LỜI HỨA" ĐỂ KIỂM TRA PROXY SONG SONG
        // Lấy một lượng proxy lớn hơn số lượng cần tìm để tăng khả năng thành công
        const proxiesToCheck = rawProxies.slice(0, desiredCount * 4); // Kiểm tra gấp 4 lần số lượng cần
        const checkPromises = proxiesToCheck.map(proxy => checkProxy(proxy));

        // 3. CHỜ TẤT CẢ CÁC LỜI HỨA HOÀN THÀNH
        const results = await Promise.all(checkPromises);

        // 4. LỌC RA NHỮNG PROXY SỐNG TỪ KẾT QUẢ
        const liveProxies = results.filter(proxy => proxy !== null).slice(0, desiredCount);

        console.log(`Kiểm tra hoàn tất. Tìm thấy ${liveProxies.length} proxy sống.`);

        if (liveProxies.length === 0) {
            return res.status(503).json({ success: false, message: 'Không tìm thấy proxy nào hoạt động tại thời điểm này. Vui lòng thử lại sau.' });
        }

        // 5. Tải file lên và trả kết quả
        const fileContent = liveProxies.join('\n');
        const catboxUrl = await uploadToCatbox(fileContent);
        
        res.json({
            success: true,
            message: `Đã tìm thấy và tải lên ${liveProxies.length} proxy sống.`,
            proxy_count: liveProxies.length,
            url: catboxUrl
        });

    } catch (error) {
        console.error('Lỗi nghiêm trọng trong quá trình xử lý /proxy:', error);
        res.status(500).json({ success: false, message: error.message || 'Đã xảy ra lỗi không xác định.' });
    }
});

// Gắn router vào đường dẫn gốc
app.use('/', router);

// Xuất handler cho Netlify
module.exports.handler = serverless(app);
