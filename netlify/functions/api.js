const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const router = express.Router();

// Lấy API key từ biến môi trường của Netlify
const ADMIN_KEY = process.env.ADMIN_API_KEY;

// --- CÁC HÀM HỖ TRỢ ---

/**
 * Lấy danh sách proxy từ nhiều nguồn khác nhau.
 * Chúng ta sẽ sử dụng API của ProxyScrape vì nó miễn phí và dễ sử dụng.
 */
async function getProxyList() {
    try {
        // API của ProxyScrape để lấy danh sách proxy HTTP.
        const response = await axios.get('https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity_level=elite_proxy,anonymous');
        return response.data.split('\r\n').filter(p => p); // Tách chuỗi thành mảng và loại bỏ các dòng trống
    } catch (error) {
        console.error('Lỗi khi lấy danh sách proxy:', error.message);
        return [];
    }
}

/**
 * Kiểm tra xem một proxy có "sống" hay không bằng cách thử kết nối đến một trang web.
 * @param {string} proxy - Proxy có định dạng "ip:port"
 * @returns {Promise<string|null>} - Trả về proxy nếu sống, ngược lại trả về null.
 */
async function checkProxy(proxy) {
    try {
        // Chúng ta sẽ thử kết nối đến httpbin.org để kiểm tra IP
        // Đặt timeout thấp (ví dụ: 5 giây) để tránh chờ đợi quá lâu
        await axios.get('https://httpbin.org/ip', {
            proxy: {
                host: proxy.split(':')[0],
                port: parseInt(proxy.split(':')[1], 10),
                protocol: 'http'
            },
            timeout: 5000
        });
        // Nếu request thành công, proxy được coi là "sống"
        return proxy;
    } catch (error) {
        // Bất kỳ lỗi nào (timeout, connection refused, v.v.) đều có nghĩa là proxy không hoạt động
        return null;
    }
}

/**
 * Tải nội dung file lên Catbox.me.
 * API của Catbox yêu cầu một request multipart/form-data.
 * @param {string} fileContent - Nội dung của file cần tải lên.
 * @returns {Promise<string>} - URL của file đã được tải lên.
 */
async function uploadToCatbox(fileContent) {
    try {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        // Thêm userhash để liên kết file với tài khoản của bạn
        form.append('userhash', 'a2896c8479106acc8846e2d7d');
        form.append('fileToUpload', Buffer.from(fileContent), {
            filename: 'proxies.txt',
            contentType: 'text/plain',
        });

        const response = await axios.post('https://catbox.moe/user/api.php', form, {
            headers: form.getHeaders(),
        });

        if (response.status === 200 && response.data) {
            return response.data; // API Catbox trả về trực tiếp URL
        } else {
            throw new Error(`Lỗi tải lên Catbox: Status ${response.status}`);
        }
    } catch (error) {
        console.error('Lỗi khi tải file lên Catbox:', error.message);
        throw new Error('Không thể tải file lên Catbox.me.');
    }
}


// --- CÁC ENDPOINTS CỦA API ---

/**
 * Endpoint /home: Hiển thị hướng dẫn sử dụng
 */
router.get('/home', (req, res) => {
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
                    <li><code>count</code> (tùy chọn): Số lượng proxy sống bạn muốn nhận. Mặc định là 1000. Ví dụ: <code>/proxy?count=500</code>.</li>
                    <li><code>key</code> (bắt buộc): Khóa API để xác thực. Ví dụ: <code>/proxy?key=your_secret_key</code>.</li>
                </ul>
            </li>
        </ul>
        <h3>Ví dụ:</h3>
        <p><code>/api/proxy?count=200&key=your_secret_key</code></p>
        <h3>Kết quả trả về (thành công):</h3>
        <pre>
{
  "success": true,
  "message": "Đã tạo thành công 200 proxy sống.",
  "proxy_count": 200,
  "url": "https://files.catbox.moe/xxxxxx.txt"
}
        </pre>
        <h3>Kết quả trả về (thất bại):</h3>
        <pre>
{
  "success": false,
  "message": "Thông báo lỗi."
}
        </pre>
    `);
});

/**
 * Endpoint /proxy: Tạo và trả về link file proxy
 */
router.get('/proxy', async (req, res) => {
    const { key, count } = req.query;

    // 1. Xác thực API Key
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
        return res.status(401).json({
            success: false,
            message: 'Lỗi xác thực: API key không hợp lệ hoặc bị thiếu.'
        });
    }

    const desiredCount = parseInt(count, 10) || 1000;

    try {
        // 2. Lấy danh sách proxy thô
        console.log('Bắt đầu lấy danh sách proxy...');
        const rawProxies = await getProxyList();
        if (rawProxies.length === 0) {
            return res.status(500).json({ success: false, message: 'Không thể lấy được danh sách proxy từ nguồn.' });
        }
        console.log(`Đã lấy được ${rawProxies.length} proxy thô.`);

        // 3. Kiểm tra proxy song song để tăng tốc độ
        console.log('Bắt đầu kiểm tra proxy...');
        const checkPromises = rawProxies.map(p => checkProxy(p));
        const results = await Promise.all(checkPromises);
        
        // Lọc ra những proxy sống và lấy đủ số lượng yêu cầu
        const liveProxies = results.filter(p => p !== null).slice(0, desiredCount);
        console.log(`Tìm thấy ${liveProxies.length} proxy sống.`);

        if (liveProxies.length === 0) {
            return res.status(500).json({ success: false, message: 'Không tìm thấy proxy nào hoạt động tại thời điểm này.' });
        }

        // 4. Tạo nội dung file và tải lên Catbox
        const fileContent = liveProxies.join('\n');
        console.log('Đang tải file lên Catbox.me...');
        const catboxUrl = await uploadToCatbox(fileContent);
        console.log(`Tải lên thành công: ${catboxUrl}`);

        // 5. Trả về kết quả cho người dùng
        res.json({
            success: true,
            message: `Đã tạo thành công ${liveProxies.length} proxy sống.`,
            proxy_count: liveProxies.length,
            url: catboxUrl
        });

    } catch (error) {
        console.error('Lỗi trong quá trình xử lý /proxy:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Đã xảy ra lỗi không xác định trên server.'
        });
    }
});

// Cấu hình để chạy trên Netlify
app.use('/.netlify/functions/api', router);
module.exports.handler = serverless(app);
