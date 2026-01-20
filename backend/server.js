require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const multer = require('multer');

// --- SỬ DỤNG SDK GOOGLE AI MỚI NHẤT ---
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(cors());

// Giới hạn dung lượng ảnh
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Đường dẫn frontend (Lưu ý: Nếu server.js nằm trong backend/, dùng ../../frontend)
app.use(express.static(path.join(__dirname, '../frontend')));

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/luckyhub';
mongoose.connect(MONGO_URI)
  .then(() => console.log(`[${new Date().toLocaleString()}] DB: Kết nối thành công!`))
  .catch(err => console.log(`[${new Date().toLocaleString()}] DB Error:`, err));

// --- CẤU HÌNH GEMINI ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- MODELS DATABASE ---
const groupSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  description: String,
  permissions: { note: { type: Boolean, default: false }, message: { type: Boolean, default: false } }
});
const Group = mongoose.model('Group', groupSchema);

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    fullname: { type: String, required: true },
    birthday: { type: Date, required: true },
    height: { type: Number, required: true },
    gender: { type: String, required: true },
    group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },
    avatar: { type: String }
});
const User = mongoose.model('User', userSchema);

const bodyMetricSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  ngayKiemTra: { type: Date, required: true },
  canNang: Number,
  tiLeMoCoThe: Number,
  luongKhoangChat: Number,
  chiSoNuoc: Number,
  luongCoBap: Number,
  chiSoCanDoi: Number,
  nangLuong: Number,
  tuoiSinhHoc: Number,
  moNoiTang: Number,
  phanTichBienDong: String,
  note: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});
const BodyMetric = mongoose.model('BodyMetric', bodyMetricSchema);

const messageSchema = new mongoose.Schema({
  from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  image: { type: String },
  createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

// --- MIDDLEWARE ---
function auth(req, res, next) {
  const userId = req.headers['x-user-id'];
  if (!userId || userId === 'null') return res.status(401).json({ message: 'Chưa đăng nhập.' });
  req.userId = userId;
  next();
}

// --- HÀM GỌI AI THÔNG MINH (Tự sửa lỗi 404) ---
async function analyzeWithFallback(prompt, base64Image) {
    // Danh sách các model từ ưu tiên cao đến thấp
    const modelNames = ["gemini-1.5-flash-latest", "gemini-1.5-flash", "gemini-1.5-pro"];
    
    for (const modelName of modelNames) {
        try {
            console.log(`[${new Date().toLocaleString()}] AI: Đang thử model ${modelName}...`);
            const model = genAI.getGenerativeModel({ model: modelName });
            
            const result = await model.generateContent([
                prompt,
                { inlineData: { data: base64Image, mimeType: "image/jpeg" } }
            ]);
            
            const response = await result.response;
            const text = response.text();
            console.log(`[${new Date().toLocaleString()}] AI: Thành công với ${modelName}!`);
            return text;
        } catch (error) {
            console.error(`[${new Date().toLocaleString()}] AI: Model ${modelName} lỗi:`, error.message);
            // Nếu lỗi 404 thì mới thử model tiếp theo, nếu lỗi khác thì dừng
            if (!error.message.includes("404")) break;
        }
    }
    return null;
}

// --- ROUTES ---

// 1. Phân tích ảnh InBody
app.post('/api/body-metrics/analyze-image', auth, async (req, res) => {
  try {
    const { imageBase64, fullname, gender, height, age } = req.body;
    const prompt = `Trích xuất dữ liệu InBody cho: ${fullname}, ${gender}, ${height}cm, ${age} tuổi. Trả về JSON: can_nang, ti_le_mo_co_the, khoang_chat, nuoc, co_bap, can_doi, nang_luong, tuoi_sinh_hoc, mo_noi_tang. Chỉ trả về JSON, không giải thích.`;
    const base64 = imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
    
    const aiText = await analyzeWithFallback(prompt, base64);
    if (!aiText) return res.status(500).json({ message: 'AI đang bận, Hoàn thử lại sau nhé.' });

    res.json({ candidates: [{ content: { parts: [{ text: aiText }] } }] });
  } catch (err) { res.status(500).json({ message: 'Lỗi server' }); }
});

// 2. Chat bữa ăn
app.post('/api/chat/send-meal', auth, async (req, res) => {
  try {
    const { to, imageBase64 } = req.body;
    await new Message({ from: req.userId, to, content: '[Hình ảnh bữa ăn]', image: imageBase64 }).save();

    const user = await User.findById(req.userId);
    const prompt = `Đây là bữa ăn của hội viên ${user.fullname}. Hãy phân tích calo sơ bộ và đưa ra lời khuyên dinh dưỡng ngắn gọn, thân thiện.`;
    const base64 = imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, "");

    let aiReply = await analyzeWithFallback(prompt, base64);
    if (!aiReply) aiReply = "HLV AI hiện đang bảo trì, Hoàn thử lại sau ít phút.";

    const hlvai = await User.findOne({ username: 'hlvai' });
    if (hlvai) {
        await new Message({ from: hlvai._id, to: req.userId, content: aiReply }).save();
    }
    res.json({ message: 'Gửi thành công', aiReply });
  } catch (err) { res.status(500).json({ message: 'Lỗi server' }); }
});

// 3. Đăng nhập
app.post('/dangnhap', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username: username?.toLowerCase() }).populate('group');
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ message: 'Sai thông tin' });
    res.json({ message: 'OK', user });
});

// Các API phụ khác (History, Profile...)
app.get('/api/chat/history/:userId', auth, async (req, res) => {
    const { userId } = req.params;
    const hlvai = await User.findOne({ username: 'hlvai' });
    const msgs = await Message.find({
        $or: [{ from: req.userId, to: userId }, { from: userId, to: req.userId }, hlvai ? { from: hlvai._id, to: req.userId } : {}]
    }).sort({ createdAt: -1 }).limit(50).lean();
    res.json(msgs);
});

// Khởi tạo HLV AI và Group nếu chưa có
async function initDB() {
    await Group.findOneAndUpdate({ name: 'Quản trị viên' }, { name: 'Quản trị viên' }, { upsert: true });
    const memberGroup = await Group.findOneAndUpdate({ name: 'Hội viên' }, { name: 'Hội viên' }, { upsert: true });
    if (!await User.findOne({ username: 'hlvai' })) {
        await new User({ username: 'hlvai', password: '1', fullname: 'HLV AI', birthday: new Date(), height: 0, gender: 'AI', group: memberGroup._id }).save();
    }
}
initDB();

const PORT = 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`[${new Date().toLocaleString()}] SERVER RUNNING ON PORT ${PORT}`));
