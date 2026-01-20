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

// Tăng giới hạn dung lượng cho body-parser và express
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use(express.static(path.join(__dirname, '../frontend')));

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/luckyhub';
mongoose.connect(MONGO_URI)
  .then(() => console.log('Kết nối MongoDB thành công!'))
  .catch(err => console.log('Lỗi kết nối MongoDB:', err));

// --- ĐỊNH NGHĨA SCHEMA (GIỮ NGUYÊN) ---

const groupSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  description: String,
  permissions: {
    note: { type: Boolean, default: false },
    message: { type: Boolean, default: false }
  }
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
  if (!userId || userId === 'null' || userId === null) {
    return res.status(401).json({ message: 'Chưa đăng nhập.' });
  }
  req.userId = userId;
  next();
}

async function adminOnly(req, res, next) {
  const user = await User.findById(req.userId).populate('group');
  if (!user || !user.group || user.group.name !== 'Quản trị viên') {
    return res.status(403).json({ message: 'Chỉ quản trị viên mới được phép.' });
  }
  next();
}

async function ensureDefaultGroupsAndHLVAI() {
  const adminGroup = await Group.findOneAndUpdate({ name: 'Quản trị viên' }, { description: 'Quản trị hệ thống' }, { upsert: true, new: true });
  await Group.findOneAndUpdate({ name: 'Hội viên' }, { description: 'Người dùng thông thường' }, { upsert: true, new: true });
  let hlvai = await User.findOne({ username: 'hlvai' });
  if (!hlvai) {
    hlvai = new User({
      username: 'hlvai', password: 'hlvai', fullname: 'HLV AI',
      birthday: new Date('2000-01-01'), height: 170, gender: 'Khác', group: adminGroup._id
    });
    await hlvai.save();
    console.log('Đã tạo user HLV AI');
  }
}

// --- ROUTES AUTH & ADMIN ---

app.post('/dangky', async (req, res) => {
    let { username, password, fullname, birthday, height, gender } = req.body;
    username = username.toLowerCase();
    try {
        const userExist = await User.findOne({ username });
        if (userExist) return res.status(400).json({ message: 'Tên đăng nhập đã tồn tại.' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const memberGroup = await Group.findOne({ name: 'Hội viên' });
        const user = new User({ username, password: hashedPassword, fullname, birthday, height, gender, group: memberGroup?._id });
        await user.save();
        res.status(201).json({ message: 'Đăng ký thành công!' });
    } catch (err) { res.status(500).json({ message: 'Lỗi máy chủ.' }); }
});

app.post('/dangnhap', async (req, res) => {
    let { username, password } = req.body;
    username = username.toLowerCase();
    try {
        const user = await User.findOne({ username }).populate('group');
        if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ message: 'Sai thông tin.' });
        res.json({ user: { _id: user._id, username: user.username, fullname: user.fullname, group: user.group, gender: user.gender, height: user.height, birthday: user.birthday } });
    } catch (err) { res.status(500).json({ message: 'Lỗi máy chủ.' }); }
});

app.get('/adminreset', async (req, res) => {
    try {
        const adminGroup = await Group.findOne({ name: 'Quản trị viên' });
        const hashedPassword = await bcrypt.hash('admin', 10);
        await User.findOneAndUpdate({ username: 'admin' }, { password: hashedPassword, fullname: 'Quản trị viên', birthday: new Date('1990-01-01'), height: 170, gender: 'Nam', group: adminGroup?._id }, { upsert: true });
        res.json({ message: 'Đã reset admin.' });
    } catch (err) { res.status(500).send('Lỗi'); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

// --- ROUTES CHỈ SỐ SỨC KHỎE ---

app.post('/api/body-metrics', auth, async (req, res) => {
  try {
    const metric = new BodyMetric({ ...req.body, userId: req.userId });
    await metric.save();
    res.json({ message: 'Lưu chỉ số thành công!', metric });
  } catch (err) { res.status(500).json({ message: 'Lỗi lưu chỉ số.' }); }
});

app.get('/api/body-metrics/latest-with-previous', auth, async (req, res) => {
  try {
    const metrics = await BodyMetric.find({ userId: req.userId }).sort({ ngayKiemTra: -1 }).limit(2);
    res.json({ latest: metrics[0] || null, previous: metrics[1] || null });
  } catch (err) { res.status(500).json({ message: 'Lỗi lấy dữ liệu.' }); }
});

app.get('/api/body-metrics/all', auth, async (req, res) => {
  try {
    const metrics = await BodyMetric.find({ userId: req.userId }).sort({ ngayKiemTra: 1 });
    res.json(metrics);
  } catch (err) { res.status(500).json({ message: 'Lỗi lấy dữ liệu.' }); }
});

// --- GEMINI AI - CẬP NHẬT URL VÀ MODEL ---

app.post('/api/body-metrics/analyze-image', auth, async (req, res) => {
  try {
    const { imageBase64, fullname, gender, height, age, prompt } = req.body;
    const finalPrompt = prompt || `phân tích ảnh chỉ số cho ${fullname}, JSON only.`;
    const base64 = imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
    
    // Sử dụng v1beta và gemini-1.5-flash để ổn định nhất
    const geminiRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: finalPrompt }, { inlineData: { mimeType: "image/png", data: base64 } }] }] },
      { headers: { 'Content-Type': 'application/json' } }
    );
    res.json(geminiRes.data);
  } catch (err) {
    console.error("Lỗi Gemini Analyze:", err.response?.data || err.message);
    res.status(500).json({ message: 'Lỗi AI.' });
  }
});

app.post('/api/chat/send-meal', auth, async (req, res) => {
  try {
    const { to, imageBase64 } = req.body;
    const fromUser = await User.findById(req.userId);
    const mealMsg = new Message({ from: req.userId, to, content: '[Hình ảnh bữa ăn]', image: imageBase64 });
    await mealMsg.save();

    const latestMetric = await BodyMetric.findOne({ userId: req.userId }).sort({ ngayKiemTra: -1 });
    let metricsText = latestMetric ? `Cân nặng: ${latestMetric.canNang}, Mỡ: ${latestMetric.tiLeMoCoThe}%` : '';
    
    const prompt = `đây là bữa ăn của ${fromUser.fullname} (${metricsText}). Tư vấn ngắn gọn, dễ hiểu.`;
    const base64 = imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
    
    let geminiReply = '';
    try {
      // URL này dùng v1beta để tránh lỗi 404 cho model flash
      const geminiRes = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: "image/png", data: base64 } }] }] },
        { headers: { 'Content-Type': 'application/json' } }
      );
      geminiReply = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'AI bận.';
    } catch (err) {
      console.error("Lỗi Quota Gemini:", err.response?.data || err.message);
      geminiReply = 'HLV AI hiện đang hết lượt tư vấn (Quota Exceeded). Hãy đợi khoảng 1 phút rồi thử lại nhé!';
    }

    const hlvaiUser = await User.findOne({ username: 'hlvai' });
    if (hlvaiUser) {
      await new Message({ from: hlvaiUser._id, to: req.userId, content: geminiReply }).save();
    }
    res.json({ message: 'Thành công', aiReply: geminiReply });
  } catch (err) { res.status(500).json({ message: 'Lỗi.' }); }
});

// --- CHAT & PROFILE (GIỮ NGUYÊN) ---

app.get('/api/chat/users', auth, async (req, res) => {
  let users = await User.find().populate('group');
  users = users.filter(u => u._id.toString() !== req.userId && u.fullname !== 'HLV AI');
  res.json(users.map(u => ({ _id: u._id, fullname: u.fullname, username: u.username, group: u.group?.name })));
});

app.get('/api/chat/history/:userId', auth, async (req, res) => {
  const { userId } = req.params;
  const hlvai = await User.findOne({ username: 'hlvai' });
  const messages = await Message.find({
    $or: [
      { from: req.userId, to: userId }, { from: userId, to: req.userId },
      hlvai ? { from: hlvai._id, to: req.userId } : {},
      hlvai ? { from: hlvai._id, to: userId } : {}
    ]
  }).sort({ createdAt: -1 }).lean();
  res.json(messages);
});

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public/static/avatar/')),
  filename: (req, file, cb) => cb(null, req.userId + path.extname(file.originalname))
});
const uploadAvatar = multer({ storage: avatarStorage });

app.get('/api/account/profile', auth, async (req, res) => res.json(await User.findById(req.userId).select('-password')));
app.post('/api/account/avatar', auth, uploadAvatar.single('avatar'), async (req, res) => {
  const fs = require('fs');
  const base64 = fs.readFileSync(req.file.path, { encoding: 'base64' });
  const user = await User.findByIdAndUpdate(req.userId, { avatar: `data:${req.file.mimetype};base64,${base64}` }, { new: true });
  fs.unlinkSync(req.file.path);
  res.json(user);
});

ensureDefaultGroupsAndHLVAI();
app.listen(3001, '0.0.0.0', () => console.log(`🚀 Server on 3001`));
