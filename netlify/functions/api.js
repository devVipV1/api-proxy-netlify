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
const DEFAULT_PROXY_COUNT = 1000;
const MAX_PROXY_COUNT = 5000; // Có thể tăng giới hạn vì có nhiều nguồn hơn

// DANH SÁCH CÁC NGUỒN CUNG CẤP PROXY
const PROXY_SOURCES = [
    'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
    'https://openproxylist.xyz/http.txt',
    'https://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/master/http.txt'
];

// --- CÁC HÀM HỖ TRỢ ---

/**
 * Lấy danh sách proxy từ nhiều nguồn một cách song song.
 */
async function getProxyList() {
    // Tạo một mảng các "lời hứa" (promise) để gọi đến tất cả các nguồn
    const fetchPromises = PROXY_SOURCES.map(url => axios.get(url, { timeout: 7000 }));

    // Sử dụng Promise.allSettled để chờ tất cả các yêu cầu hoàn thành, dù thành công hay thất bại
    const results = await Promise.allSettled(fetchPromises);

    let allProxies = [];
    results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value.data) {
            // Nếu yêu cầu thành công, thêm các proxy vào danh sách chung
            const proxies = result.value.data.split(/\r?\n/).filter(p => p);
            allProxies.push(...proxies);
            console.log(`Lấy thành công ${proxies.length} proxy từ nguồn #${index + 1}`);
        } else {
            // Nếu yêu cầu thất bại, ghi log lỗi
            console.warn(`Lỗi khi lấy proxy từ nguồn #${index + 1}: ${result.reason.message}`);
        }
    });

    // Sử dụng Set để tự động loại bỏ các proxy trùng lặp và sau đó chuyển lại thành mảng
    return [...new Set(allProxies)];
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
        api_name: "Multi-Source Proxy Scraper API",
        description: "API lấy danh sách proxy thô từ nhiều nguồn và tải lên Catbox.me.",
        endpoints: {
            proxy: {
                path: "/proxy",
                method: "GET",
                parameters: {
                    count: `(Tùy chọn) Số lượng proxy muốn lấy. Mặc định: ${DEFAULT_PROXY_COUNT}. Tối đa: ${MAX_PROXY_COUNT}.`,
                    key: "(Bắt buộc) Khóa API để xác thực."
                },
                example: `/proxy?count=2000&key=your_secret_key`
            }
        }
    });
});

/**
 * Endpoint /proxy: Lấy proxy và trả về link file
 */
router.get('/proxy', async (req, res) => {
    const { key, count } = req.query;

    if (!ADMIN_KEY || key !== ADMIN_KEY) {
        return res.status(401).json({ success: false, message: 'Lỗi xác thực: API key không hợp lệ.' });
    }

    let desiredCount = parseInt(count, 10) || DEFAULT_PROXY_COUNT;
    if (desiredCount > MAX_PROXY_COUNT) desiredCount = MAX_PROXY_COUNT;

    try {
        const allProxies = await getProxyList();
        console.log(`Tổng cộng lấy được ${allProxies.length} proxy duy nhất từ các nguồn.`);

        if (allProxies.length === 0) {
            return res.status(503).json({ success: false, message: 'Tất cả các nguồn proxy đều không phản hồi. Vui lòng thử lại sau.' });
        }

        const proxiesToUpload = allProxies.slice(0, desiredCount);
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
