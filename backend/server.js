require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const multer = require('multer');

// --- QUAN TRỌNG: KHAI BÁO THƯ VIỆN GOOGLE AI MỚI ---
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(cors());

// Tăng giới hạn dung lượng để nhận ảnh chất lượng cao
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use(express.static(path.join(__dirname, '../frontend')));

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/luckyhub';
mongoose.connect(MONGO_URI)
  .then(() => console.log(`[${new Date().toLocaleString()}] DB: Kết nối MongoDB thành công!`))
  .catch(err => console.log(`[${new Date().toLocaleString()}] DB Error:`, err));

// --- CẤU HÌNH AI SDK (Thay thế cho axios cũ) ---
// Khởi tạo Gemini với API Key từ file .env
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Sử dụng model "gemini-1.5-flash" - Đây là bản ổn định nhất, ít lỗi 429 nhất cho tài khoản Free
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- CÁC MODELS DATABASE (Giữ nguyên) ---
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

// --- MIDDLEWARES ---
function auth(req, res, next) {
  const userId = req.headers['x-user-id'];
  if (!userId || userId === 'null') return res.status(401).json({ message: 'Chưa đăng nhập.' });
  req.userId = userId;
  next();
}

async function adminOnly(req, res, next) {
  const user = await User.findById(req.userId).populate('group');
  if (!user || !user.group || user.group.name !== 'Quản trị viên') {
    return res.status(403).json({ message: 'Cần quyền quản trị.' });
  }
  next();
}

// --- HÀM XỬ LÝ AI CHUYÊN DỤNG (Dùng SDK mới) ---
async function analyzeImageWithGemini(prompt, base64Image) {
    try {
        console.log(`[${new Date().toLocaleString()}] AI: Đang gửi yêu cầu tới Google...`);
        
        // Chuẩn bị dữ liệu ảnh đúng chuẩn SDK
        const imagePart = {
            inlineData: {
                data: base64Image,
                mimeType: "image/png"
            },
        };

        // Gọi AI bằng hàm generateContent (Thay vì axios.post)
        const result = await model.generateContent([prompt, imagePart]);
        const response = await result.response;
        const text = response.text();
        
        console.log(`[${new Date().toLocaleString()}] AI: Thành công!`);
        return text;
    } catch (error) {
        console.error(`[${new Date().toLocaleString()}] AI Error:`, error.message);
        return null; // Trả về null để xử lý lỗi ở ngoài
    }
}

// --- CÁC ROUTES ---

// 1. Khởi tạo dữ liệu mặc định
async function ensureDefaultGroupsAndHLVAI() {
  await Group.findOneAndUpdate({ name: 'Quản trị viên' }, { name: 'Quản trị viên', description: 'Admin' }, { upsert: true });
  const memberGroup = await Group.findOneAndUpdate({ name: 'Hội viên' }, { name: 'Hội viên', description: 'User' }, { upsert: true });
  
  if (!await User.findOne({ username: 'hlvai' })) {
    await new User({
      username: 'hlvai',
      password: await bcrypt.hash('hlvai_secret', 10),
      fullname: 'HLV AI',
      birthday: new Date(), height: 0, gender: 'AI',
      group: memberGroup._id
    }).save();
    console.log('Đã tạo user HLV AI');
  }
}

// 2. API Đăng ký
app.post('/dangky', async (req, res) => {
    let { username, password, fullname, birthday, height, gender } = req.body;
    try {
        if (await User.findOne({ username: username.toLowerCase() })) return res.status(400).json({ message: 'Tên tồn tại' });
        const user = new User({
            username: username.toLowerCase(),
            password: await bcrypt.hash(password, 10),
            fullname, birthday, height, gender,
            group: (await Group.findOne({ name: 'Hội viên' }))?._id
        });
        await user.save();
        res.status(201).json({ message: 'Đăng ký thành công' });
    } catch (e) { res.status(500).json({ message: 'Lỗi server' }); }
});

// 3. API Đăng nhập
app.post('/dangnhap', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username: username?.toLowerCase() }).populate('group');
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ message: 'Sai thông tin đăng nhập' });
        }
        console.log(`[${new Date().toLocaleString()}] LOGIN: ${user.fullname} đã đăng nhập.`);
        res.json({ message: 'OK', user });
    } catch (e) { res.status(500).json({ message: 'Lỗi server' }); }
});

// 4. API Phân tích ảnh chỉ số (Sử dụng hàm AI mới)
app.post('/api/body-metrics/analyze-image', auth, async (req, res) => {
  try {
    const { imageBase64, fullname, gender, height, age } = req.body;
    
    const prompt = `Bạn là trợ lý y tế. Hãy trích xuất dữ liệu từ ảnh kết quả đo InBody của: ${fullname}, ${gender}, ${height}cm, ${age} tuổi.
    Yêu cầu tuyệt đối: Chỉ trả về 1 JSON duy nhất, không markdown. Các trường cần lấy: "can_nang", "ti_le_mo_co_the", "khoang_chat", "nuoc", "co_bap", "can_doi", "nang_luong", "tuoi_sinh_hoc", "mo_noi_tang". Giá trị là số (number).`;
    
    const base64 = imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
    
    const aiText = await analyzeImageWithGemini(prompt, base64);
    
    if (!aiText) return res.status(500).json({ message: 'AI đang bận, vui lòng thử lại sau.' });

    // Trả về đúng cấu trúc Frontend mong đợi
    res.json({ candidates: [{ content: { parts: [{ text: aiText }] } }] });

  } catch (err) {
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// 5. API Chat Bữa ăn (Sử dụng hàm AI mới)
app.post('/api/chat/send-meal', auth, async (req, res) => {
  try {
    const { to, imageBase64 } = req.body;
    console.log(`[${new Date().toLocaleString()}] MEAL: Nhận ảnh từ ${req.userId}`);
    
    // Lưu tin nhắn ảnh
    await new Message({ from: req.userId, to, content: '[Hình ảnh bữa ăn]', image: imageBase64 }).save();

    // Lấy thông tin user
    const fromUser = await User.findById(req.userId);
    const latestMetric = await BodyMetric.findOne({ userId: req.userId }).sort({ ngayKiemTra: -1 });
    const info = latestMetric ? `Cân nặng ${latestMetric.canNang}kg, mỡ ${latestMetric.tiLeMoCoThe}%` : 'Chưa có chỉ số';

    // Tạo prompt
    const prompt = `Đây là bữa ăn của hội viên (${info}). Hãy đóng vai HLV dinh dưỡng: ước lượng calo và đưa ra lời khuyên ngắn gọn, thân thiện.`;
    const base64 = imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
    
    // Gọi AI
    let reply = await analyzeImageWithGemini(prompt, base64);
    if (!reply) reply = "Hiện tại HLV AI đang quá tải, bạn hãy thử lại sau ít phút nhé!";

    // Lưu tin nhắn trả lời của AI
    const hlvai = await User.findOne({ username: 'hlvai' });
    if (hlvai) {
        await new Message({ from: hlvai._id, to: req.userId, content: reply }).save();
    }

    res.json({ message: 'Đã gửi', aiReply: reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Lỗi xử lý bữa ăn.' });
  }
});

// 6. Các API phụ trợ (Profile, History, Avatar...)
app.get('/api/account/profile', auth, async (req, res) => {
  const user = await User.findById(req.userId).select('-password');
  res.json(user);
});

app.put('/api/account/profile', auth, async (req, res) => {
    const user = await User.findByIdAndUpdate(req.userId, req.body, { new: true });
    res.json(user);
});

// Upload Avatar
const uploadAvatar = multer({ storage: multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public/static/avatar/')),
  filename: (req, file, cb) => cb(null, req.userId + path.extname(file.originalname))
})});
app.post('/api/account/avatar', auth, uploadAvatar.single('avatar'), async (req, res) => {
    const fs = require('fs');
    const base64 = fs.readFileSync(req.file.path, { encoding: 'base64' });
    const user = await User.findByIdAndUpdate(req.userId, { avatar: `data:${req.file.mimetype};base64,${base64}` }, { new: true });
    fs.unlinkSync(req.file.path);
    res.json(user);
});

// Lịch sử chat
app.get('/api/chat/history/:userId', auth, async (req, res) => {
    const { userId } = req.params;
    const hlvai = await User.findOne({ username: 'hlvai' });
    const hlvId = hlvai ? hlvai._id.toString() : null;
    
    const msgs = await Message.find({
        $or: [
            { from: req.userId, to: userId }, { from: userId, to: req.userId },
            hlvId ? { from: hlvId, to: req.userId } : {}, hlvId ? { from: hlvId, to: userId } : {}
        ]
    }).sort({ createdAt: -1 }).limit(100).lean();

    const uIds = [...new Set(msgs.map(m => m.from.toString()))];
    const users = await User.find({ _id: { $in: uIds } });
    const map = {}; users.forEach(u => map[u._id] = u.fullname);
    msgs.forEach(m => m.from_fullname = map[m.from] || 'Người dùng');
    
    res.json(msgs);
});

app.get('/api/chat/users', auth, async (req, res) => {
    const currentUser = await User.findById(req.userId).populate('group');
    let users = await User.find().populate('group');
    // Logic lọc user chat như cũ
    if (currentUser.group?.name === 'Quản trị viên' || currentUser.group?.permissions?.message) {
        users = users.filter(u => u._id.toString() !== req.userId && u.fullname !== 'HLV AI');
    } else {
        users = users.filter(u => u._id.toString() !== req.userId && (u.group?.name === 'Quản trị viên' || u.group?.permissions?.message));
    }
    res.json(users.map(u => ({ _id: u._id, fullname: u.fullname, group: u.group?.name })));
});

// API Lưu chỉ số
app.post('/api/body-metrics', auth, async (req, res) => {
    const metric = new BodyMetric({ ...req.body, userId: req.userId });
    await metric.save();
    res.json({ message: 'Lưu thành công', metric });
});
app.get('/api/body-metrics/latest-with-previous', auth, async (req, res) => {
    const metrics = await BodyMetric.find({ userId: req.userId }).sort({ ngayKiemTra: -1 }).limit(2);
    res.json({ latest: metrics[0] || null, previous: metrics[1] || null });
});
app.get('/api/body-metrics/all', auth, async (req, res) => {
    const metrics = await BodyMetric.find({ userId: req.userId }).sort({ ngayKiemTra: 1 });
    res.json(metrics);
});

// Admin routes (tóm gọn)
app.get('/admin/users', auth, adminOnly, async (req, res) => res.json(await User.find().populate('group')));
app.delete('/admin/users/:id', auth, adminOnly, async (req, res) => { await User.findByIdAndDelete(req.params.id); res.json({message:'Deleted'}); });

// Khởi tạo và chạy server
ensureDefaultGroupsAndHLVAI();
const PORT = 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[${new Date().toLocaleString()}] SERVER SẴN SÀNG TẠI CỔNG ${PORT}`);
});
