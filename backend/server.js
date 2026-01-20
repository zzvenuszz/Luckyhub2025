require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const axios = require('axios');
const multer = require('multer');

const app = express();
app.use(cors());

// Tăng giới hạn dung lượng để nhận ảnh Base64
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use(express.static(path.join(__dirname, '../frontend')));

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/luckyhub';
mongoose.connect(MONGO_URI)
  .then(() => console.log('Kết nối MongoDB thành công!'))
  .catch(err => console.log('Lỗi kết nối MongoDB:', err));

// --- SCHEMAS (GIỮ NGUYÊN CẤU TRÚC CỦA HOÀN) ---
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

async function ensureDefaultGroupsAndHLVAI() {
  const adminGroup = await Group.findOneAndUpdate({ name: 'Quản trị viên' }, { description: 'Quản trị viên' }, { upsert: true, new: true });
  await Group.findOneAndUpdate({ name: 'Hội viên' }, { description: 'Hội viên' }, { upsert: true, new: true });
  let hlvai = await User.findOne({ username: 'hlvai' });
  if (!hlvai) {
    hlvai = new User({ username: 'hlvai', password: 'hlvai', fullname: 'HLV AI', birthday: new Date('2000-01-01'), height: 170, gender: 'Khác', group: adminGroup._id });
    await hlvai.save();
  }
}

// --- GEMINI CORE FUNCTION (Sử dụng Model có sẵn trong danh sách của Hoàn) ---
async function callGeminiAI(prompt, base64Image = null) {
  // Dựa vào list của Hoàn, gemini-2.0-flash-lite là model tiết kiệm Quota nhất
  const modelName = "gemini-2.0-flash-lite"; 
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  
  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        ...(base64Image ? [{ inlineData: { mimeType: "image/png", data: base64Image } }] : [])
      ]
    }]
  };

  const response = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
  return response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
}

// --- ROUTES ---
app.post('/dangnhap', async (req, res) => {
    let { username, password } = req.body;
    try {
        const user = await User.findOne({ username: username.toLowerCase() }).populate('group');
        if (user && await bcrypt.compare(password, user.password)) {
            res.json({ user: { _id: user._id, fullname: user.fullname, group: user.group } });
        } else res.status(400).json({ message: 'Sai thông tin.' });
    } catch (err) { res.status(500).json({ message: 'Lỗi.' }); }
});

app.post('/api/body-metrics/analyze-image', auth, async (req, res) => {
  try {
    const { imageBase64, prompt } = req.body;
    const base64 = imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
    const result = await callGeminiAI(prompt || "Phân tích ảnh chỉ số, JSON only.", base64);
    // Trả về đúng format mà Frontend cũ của Hoàn đang chờ
    res.json({ candidates: [{ content: { parts: [{ text: result }] } }] });
  } catch (err) {
    console.error("Lỗi AI:", err.response?.data || err.message);
    res.status(500).json({ message: 'Lỗi AI.' });
  }
});

app.post('/api/chat/send-meal', auth, async (req, res) => {
  try {
    const { to, imageBase64 } = req.body;
    const fromUser = await User.findById(req.userId);
    const mealMsg = new Message({ from: req.userId, to, content: '[Hình ảnh bữa ăn]', image: imageBase64 });
    await mealMsg.save();

    const base64 = imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
    let geminiReply = "";
    try {
      geminiReply = await callGeminiAI(`Đây là bữa ăn của ${fromUser.fullname}. Tư vấn ngắn gọn.`, base64);
    } catch (err) {
      geminiReply = "HLV AI đang hết lượt tư vấn. Hoàn vui lòng thử lại sau 1 phút nhé!";
    }

    const hlvaiUser = await User.findOne({ username: 'hlvai' });
    if (hlvaiUser) await new Message({ from: hlvaiUser._id, to: req.userId, content: geminiReply }).save();
    res.json({ message: 'Thành công', aiReply: geminiReply });
  } catch (err) { res.status(500).json({ message: 'Lỗi.' }); }
});

// Các route phụ trợ khác giữ nguyên
app.get('/api/chat/history/:userId', auth, async (req, res) => {
    const messages = await Message.find({ $or: [{ from: req.userId, to: req.params.userId }, { from: req.params.userId, to: req.userId }] }).sort({ createdAt: -1 });
    res.json(messages);
});

ensureDefaultGroupsAndHLVAI();
app.listen(3001, '0.0.0.0', () => console.log(`🚀 Server on 3001`));
