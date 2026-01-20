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
  .then(() => console.log(`[${new Date().toLocaleString()}] Kết nối MongoDB thành công!`))
  .catch(err => console.log(`[${new Date().toLocaleString()}] Lỗi kết nối MongoDB:`, err));

// Định nghĩa schema nhóm người dùng (thêm trường permissions)
const groupSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  description: String,
  permissions: {
    note: { type: Boolean, default: false },
    message: { type: Boolean, default: false }
  }
});
const Group = mongoose.model('Group', groupSchema);

// Định nghĩa schema người dùng
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

// Model chỉ số sức khỏe
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
  phanTichBienDong: String, // Phân tích sự thay đổi (text hoặc json)
  note: { type: String, default: '' }, // Ghi chú cho từng chỉ số
  createdAt: { type: Date, default: Date.now }
});
const BodyMetric = mongoose.model('BodyMetric', bodyMetricSchema);

// Model tin nhắn giữa người dùng
const messageSchema = new mongoose.Schema({
  from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  image: { type: String }, // base64 hoặc url ảnh, optional
  createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

// Middleware xác thực đơn giản
function auth(req, res, next) {
  const userId = req.headers['x-user-id'];
  if (!userId || userId === 'null' || userId === null) {
    console.error(`[${new Date().toLocaleString()}] AUTH ERROR: Thiếu x-user-id`);
    return res.status(401).json({ message: 'Chưa đăng nhập hoặc userId không hợp lệ.' });
  }
  req.userId = userId;
  next();
}

// Middleware kiểm tra admin
async function adminOnly(req, res, next) {
  const user = await User.findById(req.userId).populate('group');
  if (!user || !user.group || user.group.name !== 'Quản trị viên') {
    console.warn(`[${new Date().toLocaleString()}] ACCESS DENIED: User ${req.userId} thử truy cập quyền Admin`);
    return res.status(403).json({ message: 'Chỉ quản trị viên mới được phép.' });
  }
  next();
}

// Khi khởi động, đảm bảo có 2 group mặc định và user HLV AI
async function ensureDefaultGroupsAndHLVAI() {
  const adminGroup = await Group.findOneAndUpdate(
    { name: 'Quản trị viên' },
    { name: 'Quản trị viên', description: 'Quản trị hệ thống' },
    { upsert: true, new: true }
  );
  const memberGroup = await Group.findOneAndUpdate(
    { name: 'Hội viên' },
    { name: 'Hội viên', description: 'Người dùng thông thường' },
    { upsert: true, new: true }
  );
  // Tạo user HLV AI nếu chưa có
  let hlvai = await User.findOne({ username: 'hlvai' });
  if (!hlvai) {
    hlvai = new User({
      username: 'hlvai',
      password: await bcrypt.hash('hlvai_secret_key_2026', 10),
      fullname: 'HLV AI',
      birthday: new Date('2000-01-01'),
      height: 170,
      gender: 'Khác',
      group: adminGroup ? adminGroup._id : undefined
    });
    await hlvai.save();
    console.log(`[${new Date().toLocaleString()}] Đã tạo user HLV AI thành công.`);
  }
}

// --- HÀM GỌI GEMINI MỚI (Flash 2.0 Lite) ---
async function callGemini(prompt, base64Image = null) {
    const model = "gemini-2.0-flash-lite"; // Bản 2.0 mới, cực nhanh và free nhiều
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    const parts = [{ text: prompt }];
    if (base64Image) {
        parts.push({
            inlineData: {
                mimeType: "image/png",
                data: base64Image
            }
        });
    }

    console.log(`[${new Date().toLocaleString()}] AI REQUEST: Đang gọi model ${model}...`);
    
    const response = await axios.post(url, {
        contents: [{ parts }]
    }, {
        headers: { 'Content-Type': 'application/json' }
    });

    const aiText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log(`[${new Date().toLocaleString()}] AI RESPONSE: Phản hồi thành công.`);
    return aiText;
}

// Đăng ký
app.post('/dangky', async (req, res) => {
    let { username, password, fullname, birthday, height, gender } = req.body;
    console.log(`[${new Date().toLocaleString()}] REGISTER: Thử đăng ký user ${username}`);
    if (!username || !password || !fullname || !birthday || !height || !gender) {
        return res.status(400).json({ message: 'Vui lòng nhập đầy đủ thông tin.' });
    }
    username = username.toLowerCase();
    try {
        const userExist = await User.findOne({ username });
        if (userExist) {
            return res.status(400).json({ message: 'Tên đăng nhập đã tồn tại.' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const memberGroup = await Group.findOne({ name: 'Hội viên' });
        const user = new User({
            username,
            password: hashedPassword,
            fullname,
            birthday,
            height,
            gender,
            group: memberGroup ? memberGroup._id : undefined
        });
        await user.save();
        console.log(`[${new Date().toLocaleString()}] REGISTER SUCCESS: User ${username} đã đăng ký.`);
        res.status(201).json({ message: 'Đăng ký thành công!' });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi máy chủ. Vui lòng thử lại sau.' });
    }
});

// Đăng nhập
app.post('/dangnhap', async (req, res) => {
    let { username, password } = req.body;
    console.log(`[${new Date().toLocaleString()}] LOGIN: User ${username} đang đăng nhập...`);
    if (!username || !password) {
        return res.status(400).json({ message: 'Vui lòng nhập tên đăng nhập và mật khẩu.' });
    }
    username = username.toLowerCase();
    try {
        const user = await User.findOne({ username }).populate('group');
        if (!user) {
            return res.status(400).json({ message: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
        }
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
        }
        console.log(`[${new Date().toLocaleString()}] LOGIN SUCCESS: ${user.fullname} đã vào hệ thống.`);
        res.json({
            message: 'Đăng nhập thành công!',
            user: {
                _id: user._id,
                username: user.username,
                fullname: user.fullname,
                group: user.group,
                gender: user.gender,
                height: user.height,
                birthday: user.birthday
            }
        });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi máy chủ. Vui lòng thử lại sau.' });
    }
});

// Route reset admin
app.get('/adminreset', async (req, res) => {
    try {
        const adminGroup = await Group.findOne({ name: 'Quản trị viên' });
        let admin = await User.findOne({ username: 'admin' });
        const hashedPassword = await bcrypt.hash('admin', 10);
        if (admin) {
            admin.password = hashedPassword;
            admin.fullname = 'Quản trị viên';
            admin.birthday = new Date('1990-01-01');
            admin.height = 170;
            admin.gender = 'Nam';
            admin.group = adminGroup ? adminGroup._id : undefined;
            await admin.save();
        } else {
            admin = new User({
                username: 'admin',
                password: hashedPassword,
                fullname: 'Quản trị viên',
                birthday: new Date('1990-01-01'),
                height: 170,
                gender: 'Nam',
                group: adminGroup ? adminGroup._id : undefined
            });
            await admin.save();
        }
        console.log(`[${new Date().toLocaleString()}] ADMIN RESET: Đã đưa tài khoản admin về mặc định.`);
        res.json({ message: 'Đã reset tài khoản quản trị về mặc định (admin/admin).' });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi máy chủ. Vui lòng thử lại sau.' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Lưu chỉ số mới
app.post('/api/body-metrics', auth, async (req, res) => {
  try {
    const { ngayKiemTra, canNang, tiLeMoCoThe, luongKhoangChat, chiSoNuoc, luongCoBap, chiSoCanDoi, nangLuong, tuoiSinhHoc, moNoiTang, phanTichBienDong } = req.body;
    console.log(`[${new Date().toLocaleString()}] METRIC: User ${req.userId} lưu chỉ số mới.`);
    const metric = new BodyMetric({
      userId: req.userId,
      ngayKiemTra,
      canNang,
      tiLeMoCoThe,
      luongKhoangChat,
      chiSoNuoc,
      luongCoBap,
      chiSoCanDoi,
      nangLuong,
      tuoiSinhHoc,
      moNoiTang,
      phanTichBienDong
    });
    await metric.save();
    res.json({ message: 'Lưu chỉ số thành công!', metric });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi máy chủ khi lưu chỉ số.' });
  }
});

// Lấy chỉ số mới nhất
app.get('/api/body-metrics/latest-with-previous', auth, async (req, res) => {
  try {
    const metrics = await BodyMetric.find({ userId: req.userId }).sort({ ngayKiemTra: -1 }).limit(2);
    res.json({ latest: metrics[0] || null, previous: metrics[1] || null });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi máy chủ khi lấy chỉ số.' });
  }
});

// Lấy toàn bộ lịch sử
app.get('/api/body-metrics/all', auth, async (req, res) => {
  try {
    const metrics = await BodyMetric.find({ userId: req.userId }).sort({ ngayKiemTra: 1 });
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi máy chủ khi lấy lịch sử chỉ số.' });
  }
});

// Phân tích ảnh chỉ số bằng Gemini (CẬP NHẬT MODEL MỚI)
app.post('/api/body-metrics/analyze-image', auth, async (req, res) => {
  try {
    const { imageBase64, fullname, gender, height, age, lastMetrics, prompt } = req.body;
    console.log(`[${new Date().toLocaleString()}] AI ANALYZE IMAGE: Đang phân tích ảnh cho ${fullname}`);

    let finalPrompt = prompt || `đây là hình ảnh ghi chỉ số sức khỏe của ${fullname}, giới tính ${gender}, chiều cao ${height} cm, tuổi ${age}. hãy phân tích chỉ số sức khỏe và chỉ trả về kết quả dưới dạng JSON, không giải thích, không mô tả, không markdown, không thêm bất kỳ ký tự nào ngoài JSON. Ví dụ: {"cân_nặng": 48.6, "tỉ_lệ_mỡ_cơ_thể": 29.6, "khoáng_chất": 2.1, "nước": 51.7, "cơ_bắp": 32.1, "cân_đối": null, "năng_lượng": 989, "tuổi_sinh_học": 53, "mỡ_nội_tạng": 5.5}`;
    
    if (lastMetrics && !prompt) {
        finalPrompt += `\nChỉ số gần nhất: ${JSON.stringify(lastMetrics)}`;
    }

    const base64 = imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
    
    // Gọi hàm AI mới
    const aiResponseText = await callGemini(finalPrompt, base64);
    
    // Giữ nguyên cấu trúc trả về cũ để Frontend không lỗi
    res.json({
        candidates: [{
            content: {
                parts: [{ text: aiResponseText }]
            }
        }]
    });
  } catch (err) {
    console.error(`[${new Date().toLocaleString()}] AI ERROR:`, err.message);
    res.status(500).json({ message: 'Lỗi khi phân tích ảnh chỉ số.' });
  }
});

// --- ADMIN USERS ROUTES ---
app.get('/admin/users', auth, adminOnly, async (req, res) => {
  const users = await User.find().populate('group');
  res.json(users);
});

app.get('/admin/users/:id', auth, adminOnly, async (req, res) => {
  const user = await User.findById(req.params.id).populate('group');
  res.json(user);
});

app.put('/admin/users/:id', auth, adminOnly, async (req, res) => {
  const { fullname, birthday, height, gender, group } = req.body;
  console.log(`[${new Date().toLocaleString()}] ADMIN UPDATE: Cập nhật user ID ${req.params.id}`);
  const user = await User.findByIdAndUpdate(req.params.id, { fullname, birthday, height, gender, group }, { new: true });
  res.json(user);
});

app.delete('/admin/users/:id', auth, adminOnly, async (req, res) => {
  console.log(`[${new Date().toLocaleString()}] ADMIN DELETE: Xóa user ID ${req.params.id}`);
  await User.findByIdAndDelete(req.params.id);
  res.json({ message: 'Đã xóa user.' });
});

// --- CHAT SYSTEM ---
app.get('/api/chat/users', auth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.userId).populate('group');
    let users = await User.find().populate('group');
    
    if (currentUser.group && (currentUser.group.name === 'Quản trị viên' || currentUser.group.permissions?.message)) {
      users = users.filter(u => u._id.toString() !== req.userId && u.fullname !== 'HLV AI');
    } else {
      users = users.filter(u => u._id.toString() !== req.userId && (u.group?.name === 'Quản trị viên' || u.group?.permissions?.message));
    }
    res.json(users.map(u => ({ _id: u._id, fullname: u.fullname, username: u.username, group: u.group?.name })));
  } catch (err) {
    res.status(500).json({ message: 'Lỗi lấy danh sách chat.' });
  }
});

app.post('/api/chat/send', auth, async (req, res) => {
  try {
    const { to, content } = req.body;
    console.log(`[${new Date().toLocaleString()}] CHAT: Từ ${req.userId} đến ${to}`);
    const msg = new Message({ from: req.userId, to, content });
    await msg.save();
    res.json({ message: 'Đã gửi.', msg });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi gửi tin nhắn.' });
  }
});

app.get('/api/chat/history/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;
    const hlvaiUser = await User.findOne({ username: 'hlvai' });
    const hlvaiId = hlvaiUser ? hlvaiUser._id.toString() : null;

    const messages = await Message.find({
      $or: [
        { from: req.userId, to: userId },
        { from: userId, to: req.userId },
        hlvaiId ? { from: hlvaiId, to: req.userId } : {},
        hlvaiId ? { from: hlvaiId, to: userId } : {}
      ]
    }).sort({ createdAt: -1 }).lean();

    const userIds = [...new Set(messages.map(m => m.from.toString()))];
    const users = await User.find({ _id: { $in: userIds } });
    const userMap = {};
    users.forEach(u => { userMap[u._id.toString()] = u.fullname; });
    messages.forEach(m => { m.from_fullname = userMap[m.from.toString()] || ''; });

    res.json(messages);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi lấy lịch sử chat.' });
  }
});

// Gửi ảnh bữa ăn + Tư vấn AI (CẬP NHẬT MODEL MỚI)
app.post('/api/chat/send-meal', auth, async (req, res) => {
  try {
    const { to, imageBase64 } = req.body;
    console.log(`[${new Date().toLocaleString()}] MEAL ANALYZE: Nhận ảnh bữa ăn từ ${req.userId}`);
    
    const fromUser = await User.findById(req.userId);
    const mealMsg = new Message({ from: req.userId, to, content: '[Hình ảnh bữa ăn]', image: imageBase64 });
    await mealMsg.save();

    const latestMetric = await BodyMetric.findOne({ userId: req.userId }).sort({ ngayKiemTra: -1 });
    let metricsText = latestMetric ? `Cân nặng: ${latestMetric.canNang}, Tỉ lệ mỡ: ${latestMetric.tiLeMoCoThe}%` : 'Chưa có chỉ số';

    const prompt = `đây là bữa ăn của ${fromUser.fullname} với các chỉ số: ${metricsText}. Hãy phân tích bữa ăn và tư vấn cách ăn hợp lý. Trả lời ngắn gọn, đơn giản.`;
    const base64 = imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, "");

    let geminiReply = '';
    try {
      geminiReply = await callGemini(prompt, base64);
    } catch (err) {
        console.error("AI Error:", err.message);
        geminiReply = 'HLV AI hiện đang bận, Hoàn vui lòng thử lại sau nhé!';
    }

    const hlvaiUser = await User.findOne({ username: 'hlvai' });
    if (hlvaiUser) {
      await new Message({ from: hlvaiUser._id, to: req.userId, content: geminiReply }).save();
    }

    res.json({ message: 'Thành công', aiReply: geminiReply });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi xử lý bữa ăn.' });
  }
});

// --- ACCOUNT SETTINGS ---
app.get('/api/account/profile', auth, async (req, res) => {
  const user = await User.findById(req.userId).select('-password');
  res.json(user);
});

app.put('/api/account/profile', auth, async (req, res) => {
  const { fullname, birthday, height, gender } = req.body;
  console.log(`[${new Date().toLocaleString()}] PROFILE UPDATE: User ${req.userId}`);
  const user = await User.findByIdAndUpdate(req.userId, { fullname, birthday, height, gender }, { new: true }).select('-password');
  res.json(user);
});

// Gọi khởi tạo
ensureDefaultGroupsAndHLVAI();

const PORT = 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[${new Date().toLocaleString()}] SERVER RUNNING: Máy chủ LuckyHub đang chạy tại cổng ${PORT}`);
});
