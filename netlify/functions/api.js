const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const router = express.Router();

// Lấy các biến môi trường từ Netlify
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const CATBOX_HASH = process.env.CATBOX_USER_HASH;

// --- CÁC HÀM HỖ TRỢ ---

/**
 * Lấy danh sách proxy từ ProxyScrape.
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
            timeout: 7000 // Tăng timeout lên một chút để có kết quả ổn định hơn
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
            throw new Error(`Catbox API trả về status ${response.status} với nội dung: ${response.data}`);
        }
    } catch (error) {
        console.error('Lỗi khi tải file lên Catbox:', error.message);
        throw new Error(`Không thể tải file lên Catbox.me. Chi tiết: ${error.message}`);
    }
}

// --- CÁC ENDPOINTS CỦA API ---

/**
 * Endpoint /: Hiển thị hướng dẫn sử dụng (trang chủ)
 */
router.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`
        <h1>API Tạo Proxy</h1>
        <p>API này cung cấp proxy HTTP "sống" và tải chúng lên Catbox.me.</p>
        <h2>Cách sử dụng:</h2>
        <h3>Endpoint: <code>/proxy</code></h3>
        <ul>
            <li><strong>Phương thức:</strong> <code>GET</code></li>
            <li><strong>Tham số (Query Parameters):</strong>
                <ul>
                    <li><code>count</code> (tùy chọn): Số lượng proxy sống bạn muốn nhận. Mặc định là 1000. Tối đa 2000.</li>
                    <li><code>key</code> (bắt buộc): Khóa API để xác thực.</li>
                </ul>
            </li>
        </ul>
        <h3>Ví dụ:</h3>
        <p><code>/proxy?count=200&key=your_secret_key</code></p>
        <h3>Kết quả trả về (thành công):</h3>
        <pre>{
  "success": true,
  "message": "Đã tìm thấy và tải lên 200 proxy sống.",
  "proxy_count": 200,
  "url": "https://files.catbox.moe/xxxxxx.txt"
}</pre>
    `);
});

/**
 * Endpoint /proxy: Tạo và trả về link file proxy
 */
router.get('/proxy', async (req, res) => {
    const { key, count } = req.query;

    if (!ADMIN_KEY || key !== ADMIN_KEY) {
        return res.status(401).json({ success: false, message: 'Lỗi xác thực: API key không hợp lệ.' });
    }

    let desiredCount = parseInt(count, 10) || 1000;
    if (desiredCount > 2000) desiredCount = 2000; // Giới hạn số lượng để tránh timeout

    try {
        const rawProxies = await getProxyList();
        console.log(`Đã lấy được ${rawProxies.length} proxy thô. Bắt đầu tìm ${desiredCount} proxy sống...`);

        const liveProxies = [];
        // Tối ưu: Chỉ kiểm tra cho đến khi đủ số lượng yêu cầu
        for (const proxy of rawProxies) {
            if (await isProxyLive(proxy)) {
                liveProxies.push(proxy);
                console.log(`Tìm thấy proxy sống: ${proxy} (${liveProxies.length}/${desiredCount})`);
            }
            if (liveProxies.length >= desiredCount) {
                console.log('Đã tìm đủ số lượng proxy sống yêu cầu.');
                break; // Dừng lại khi đã đủ
            }
        }

        if (liveProxies.length === 0) {
            return res.status(503).json({ success: false, message: 'Không tìm thấy proxy nào hoạt động tại thời điểm này.' });
        }

        const fileContent = liveProxies.join('\n');
        console.log('Đang tải file lên Catbox.me...');
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

// Cấu hình để chạy trên Netlify với URL gọn hơn
// Đường dẫn gốc '/' sẽ được xử lý bởi router này
app.use('/', router);
module.exports.handler = serverless(app);
