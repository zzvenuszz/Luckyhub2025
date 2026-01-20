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
    console.error('Chưa đăng nhập hoặc userId không hợp lệ - thiếu x-user-id');
    return res.status(401).json({ message: 'Chưa đăng nhập hoặc userId không hợp lệ.' });
  }
  req.userId = userId;
  next();
}

// Middleware kiểm tra admin
async function adminOnly(req, res, next) {
  const user = await User.findById(req.userId).populate('group');
  if (!user || !user.group || user.group.name !== 'Quản trị viên') {
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
      password: 'hlvai', // Không dùng để đăng nhập
      fullname: 'HLV AI',
      birthday: new Date('2000-01-01'),
      height: 170,
      gender: 'Khác',
      group: adminGroup ? adminGroup._id : undefined
    });
    await hlvai.save();
    console.log('Đã tạo user HLV AI');
  }
}

// Đăng ký
app.post('/dangky', async (req, res) => {
    let { username, password, fullname, birthday, height, gender } = req.body;
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
        res.status(201).json({ message: 'Đăng ký thành công!' });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi máy chủ. Vui lòng thử lại sau.' });
    }
});

// Đăng nhập
app.post('/dangnhap', async (req, res) => {
    let { username, password } = req.body;
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
        res.json({ message: 'Đã reset tài khoản quản trị về mặc định (admin/admin).' });
    } catch (err) {
        res.status(500).json({ message: 'Lỗi máy chủ. Vui lòng thử lại sau.' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Lưu chỉ số mới và phân tích biến động
app.post('/api/body-metrics', auth, async (req, res) => {
  try {
    const { ngayKiemTra, canNang, tiLeMoCoThe, luongKhoangChat, chiSoNuoc, luongCoBap, chiSoCanDoi, nangLuong, tuoiSinhHoc, moNoiTang, phanTichBienDong } = req.body;
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

// Lấy chỉ số mới nhất và chỉ số liền trước đó
app.get('/api/body-metrics/latest-with-previous', auth, async (req, res) => {
  try {
    const metrics = await BodyMetric.find({ userId: req.userId }).sort({ ngayKiemTra: -1 }).limit(2);
    const latest = metrics[0] || null;
    const previous = metrics[1] || null;
    res.json({ latest, previous });
  } catch (err) {
    console.error('Lỗi khi lấy chỉ số mới nhất và trước đó:', err);
    res.status(500).json({ message: 'Lỗi máy chủ khi lấy chỉ số.' });
  }
});

// Lấy toàn bộ lịch sử chỉ số sức khỏe của user
app.get('/api/body-metrics/all', auth, async (req, res) => {
  try {
    const metrics = await BodyMetric.find({ userId: req.userId }).sort({ ngayKiemTra: 1 });
    res.json(metrics);
  } catch (err) {
    console.error('Lỗi khi lấy toàn bộ lịch sử chỉ số:', err);
    res.status(500).json({ message: 'Lỗi máy chủ khi lấy lịch sử chỉ số.' });
  }
});

// Lấy chỉ số theo tháng cho user
app.get('/api/body-metrics/by-month', auth, async (req, res) => {
  try {
    const { year, month } = req.query;
    if (!year || !month) return res.status(400).json({ message: 'Thiếu tham số year hoặc month.' });
    const start = new Date(Number(year), Number(month) - 1, 1);
    const end = new Date(Number(year), Number(month), 1);
    const metrics = await BodyMetric.find({
      userId: req.userId,
      ngayKiemTra: { $gte: start, $lt: end }
    }).sort({ ngayKiemTra: 1 });
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi máy chủ khi lấy chỉ số theo tháng.' });
  }
});

// Phân tích ảnh chỉ số bằng Gemini
app.post('/api/body-metrics/analyze-image', auth, async (req, res) => {
  try {
    const { imageBase64, fullname, gender, height, age, lastMetrics, prompt } = req.body;
    let finalPrompt = prompt;
    if (!finalPrompt) {
      finalPrompt = `đây là hình ảnh ghi chỉ số sức khỏe của ${fullname}, giới tính ${gender}, chiều cao ${height} cm, tuổi ${age}. hãy phân tích chỉ số sức khỏe và chỉ trả về kết quả dưới dạng JSON, không giải thích, không mô tả, không markdown, không thêm bất kỳ ký tự nào ngoài JSON. Ví dụ: {"cân_nặng": 48.6, "tỉ_lệ_mỡ_cơ_thể": 29.6, "khoáng_chất": 2.1, "nước": 51.7, "cơ_bắp": 32.1, "cân_đối": null, "năng_lượng": 989, "tuổi_sinh_học": 53, "mỡ_nội_tạng": 5.5}`;
      if (lastMetrics) {
        finalPrompt += `\nChỉ số gần nhất: ${JSON.stringify(lastMetrics)}`;
      }
    }
    const base64 = imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
    
    // Sử dụng URL từ .env
    const geminiRes = await axios.post(
      `${process.env.GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [
              { text: finalPrompt },
              { inlineData: { mimeType: "image/png", data: base64 } }
            ]
          }
        ]
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    res.json(geminiRes.data);
  } catch (err) {
    console.error("Lỗi Analyze-image:", err.response?.data || err.message);
    res.status(500).json({ message: 'Lỗi khi phân tích ảnh chỉ số.' });
  }
});

// API quản trị viên: quản lý user
app.get('/admin/users', auth, adminOnly, async (req, res) => {
  const users = await User.find().populate('group');
  res.json(users);
});
app.get('/admin/users/:id', auth, adminOnly, async (req, res) => {
  const user = await User.findById(req.params.id).populate('group');
  if (!user) return res.status(404).json({ message: 'Không tìm thấy user.' });
  res.json(user);
});
app.put('/admin/users/:id', auth, adminOnly, async (req, res) => {
  const { fullname, birthday, height, gender, group } = req.body;
  const adminGroup = await Group.findOne({ name: 'Quản trị viên' });
  const userToUpdate = await User.findById(req.params.id);
  if (userToUpdate && userToUpdate._id.toString() === req.userId) {
    const adminCount = await User.countDocuments({ group: adminGroup._id });
    if (adminCount === 1 && group !== String(adminGroup._id)) {
      return res.status(400).json({ message: 'Không thể chuyển nhóm. Hệ thống phải có ít nhất 1 quản trị viên.' });
    }
  }
  const user = await User.findByIdAndUpdate(req.params.id, { fullname, birthday, height, gender, group }, { new: true });
  res.json(user);
});
app.delete('/admin/users/:id', auth, adminOnly, async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.json({ message: 'Đã xóa user.' });
});
app.post('/admin/users/:id/reset-password', auth, adminOnly, async (req, res) => {
  const { newPassword } = req.body;
  const hashed = await bcrypt.hash(newPassword, 10);
  await User.findByIdAndUpdate(req.params.id, { password: hashed });
  res.json({ message: 'Đã reset mật khẩu.' });
});
app.get('/admin/users/:id/metrics', auth, adminOnly, async (req, res) => {
  const metrics = await BodyMetric.find({ userId: req.params.id }).sort({ ngayKiemTra: 1 });
  res.json(metrics);
});
app.put('/admin/users/:userId/metrics/:metricId/note', auth, async (req, res) => {
  const user = await User.findById(req.userId).populate('group');
  const targetUser = await User.findById(req.params.userId).populate('group');
  if (!user || !targetUser) return res.status(404).json({ message: 'Không tìm thấy user.' });
  const isAdmin = user.group && user.group.name === 'Quản trị viên';
  const canNote = user.group && user.group.permissions?.note;
  if (!isAdmin && !canNote) {
    return res.status(403).json({ message: 'Bạn không có quyền ghi chú cho chỉ số này.' });
  }
  const { note } = req.body;
  const metric = await BodyMetric.findByIdAndUpdate(req.params.metricId, { note }, { new: true });
  if (!metric) return res.status(404).json({ message: 'Không tìm thấy chỉ số.' });
  res.json({ message: 'Đã cập nhật ghi chú.', metric });
});
app.delete('/admin/users/:userId/metrics/:metricId', auth, adminOnly, async (req, res) => {
  try {
    const { userId, metricId } = req.params;
    const metric = await BodyMetric.findOneAndDelete({ _id: metricId, userId });
    if (!metric) return res.status(404).json({ message: 'Không tìm thấy chỉ số.' });
    res.json({ message: 'Đã xóa chỉ số thành công.' });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi máy chủ khi xóa chỉ số.' });
  }
});

// API quản trị viên: quản lý group
app.get('/admin/groups', auth, adminOnly, async (req, res) => {
  const groups = await Group.find();
  res.json(groups);
});
app.post('/admin/groups', auth, adminOnly, async (req, res) => {
  const { name, description, permissions } = req.body;
  const group = new Group({ name, description, permissions });
  await group.save();
  res.json(group);
});
app.put('/admin/groups/:id', auth, adminOnly, async (req, res) => {
  const { name, description, permissions } = req.body;
  const group = await Group.findByIdAndUpdate(
    req.params.id,
    { name, description, ...(permissions && { permissions }) },
    { new: true }
  );
  res.json(group);
});
app.delete('/admin/groups/:id', auth, adminOnly, async (req, res) => {
  await Group.findByIdAndDelete(req.params.id);
  res.json({ message: 'Đã xóa group.' });
});

// API lấy danh sách người dùng có thể chat
app.get('/api/chat/users', auth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.userId).populate('group');
    if (!currentUser) return res.status(401).json({ message: 'Không tìm thấy user.' });
    let users = [];
    if (currentUser.group && (currentUser.group.name === 'Quản trị viên' || currentUser.group.permissions?.message)) {
      users = await User.find().populate('group');
      users = users.filter(u => u._id.toString() !== req.userId && u.fullname !== 'HLV AI');
    } else if (currentUser.group && currentUser.group.name === 'Hội viên') {
      users = await User.find().populate('group');
      users = users.filter(u => u._id.toString() !== req.userId && (u.group?.name === 'Quản trị viên' || u.group?.permissions?.message));
    }
    res.json(users.map(u => ({ _id: u._id, fullname: u.fullname, username: u.username, group: u.group?.name })));
  } catch (err) {
    res.status(500).json({ message: 'Lỗi máy chủ khi lấy danh sách user chat.' });
  }
});

// API gửi tin nhắn
app.post('/api/chat/send', auth, async (req, res) => {
  try {
    const { to, content } = req.body;
    if (!to || !content) return res.status(400).json({ message: 'Thiếu thông tin.' });
    const fromUser = await User.findById(req.userId).populate('group');
    const toUser = await User.findById(to).populate('group');
    if (!fromUser || !toUser) return res.status(400).json({ message: 'Người gửi hoặc người nhận không tồn tại.' });
    if (fromUser.group?.name === 'Hội viên' && toUser.group?.name === 'Hội viên') {
      return res.status(403).json({ message: 'Hội viên không thể nhắn tin với hội viên khác.' });
    }
    const msg = new Message({ from: req.userId, to, content });
    await msg.save();
    res.json({ message: 'Đã gửi tin nhắn.', msg });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi máy chủ khi gửi tin nhắn.' });
  }
});

// API lấy lịch sử chat giữa hai người
app.get('/api/chat/history/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;
    const skip = parseInt(req.query.skip) || 0;
    const limit = parseInt(req.query.limit) || 1000;
    const hlvaiUser = await User.findOne({ username: 'hlvai' });
    const hlvaiId = hlvaiUser ? hlvaiUser._id.toString() : null;
    const messages = await Message.find({
      $or: [
        { from: req.userId, to: userId },
        { from: userId, to: req.userId },
        hlvaiId ? { from: hlvaiId, to: req.userId } : {},
        hlvaiId ? { from: hlvaiId, to: userId } : {},
        { from: req.userId, to: userId, image: { $exists: true, $ne: null } },
        { from: userId, to: req.userId, image: { $exists: true, $ne: null } }
      ]
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
    const userIds = [...new Set(messages.map(m => m.from.toString()))];
    const users = await User.find({ _id: { $in: userIds } });
    const userMap = {};
    users.forEach(u => { userMap[u._id.toString()] = u.fullname; });
    messages.forEach(m => { m.from_fullname = userMap[m.from.toString()] || ''; });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi máy chủ khi lấy lịch sử chat.' });
  }
});

// API đếm tổng số tin nhắn
app.get('/api/chat/history/:userId/count', auth, async (req, res) => {
  try {
    const { userId } = req.params;
    const hlvaiUser = await User.findOne({ username: 'hlvai' });
    const hlvaiId = hlvaiUser ? hlvaiUser._id.toString() : null;
    const count = await Message.countDocuments({
      $or: [
        { from: req.userId, to: userId },
        { from: userId, to: req.userId },
        hlvaiId ? { from: hlvaiId, to: req.userId } : {},
        hlvaiId ? { from: hlvaiId, to: userId } : {},
        { from: req.userId, to: userId, image: { $exists: true, $ne: null } },
        { from: userId, to: req.userId, image: { $exists: true, $ne: null } }
      ]
    });
    res.json(count);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi máy chủ khi đếm tin nhắn.' });
  }
});

// API gửi ảnh bữa ăn, nhận tư vấn từ Gemini
app.post('/api/chat/send-meal', auth, async (req, res) => {
  try {
    const { to, imageBase64 } = req.body;
    if (!to || !imageBase64) return res.status(400).json({ message: 'Thiếu thông tin.' });
    const fromUser = await User.findById(req.userId).populate('group');
    const toUser = await User.findById(to).populate('group');
    if (!fromUser || !toUser) return res.status(400).json({ message: 'Người gửi hoặc người nhận không tồn tại.' });
    if (fromUser.group?.name === 'Hội viên' && toUser.group?.name === 'Hội viên') {
      return res.status(403).json({ message: 'Hội viên không thể nhắn tin với hội viên khác.' });
    }
    const mealMsg = new Message({ from: req.userId, to, content: '[Hình ảnh bữa ăn]', image: imageBase64 });
    await mealMsg.save();
    const latestMetric = await BodyMetric.findOne({ userId: req.userId }).sort({ ngayKiemTra: -1 });
    let metricsText = latestMetric ? `Cân nặng: ${latestMetric.canNang ?? '-'}, Tỉ lệ mỡ: ${latestMetric.tiLeMoCoThe ?? '-'}, Khoáng chất: ${latestMetric.luongKhoangChat ?? '-'}, Nước: ${latestMetric.chiSoNuoc ?? '-'}, Cơ bắp: ${latestMetric.luongCoBap ?? '-'}, Cân đối: ${latestMetric.chiSoCanDoi ?? '-'}, Năng lượng: ${latestMetric.nangLuong ?? '-'}, Tuổi sinh học: ${latestMetric.tuoiSinhHoc ?? '-'}, Mỡ nội tạng: ${latestMetric.moNoiTang ?? '-'}` : '';
    
    const prompt = `đây là bữa ăn của ${fromUser.fullname} với các chỉ số cơ thể như sau: ${metricsText}. Hãy phân tích bữa ăn và tư vấn cách ăn hợp lý. Trả lời ngắn gọn, đơn giản, dễ hiểu cho người bình thường.\nLưu ý: Trong một số trường hợp, chỉ số khoáng chất còn được gọi là khối lượng xương.`;
    const base64 = imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
    
    let geminiReply = '';
    try {
      const geminiRes = await axios.post(
        `${process.env.GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`,
        {
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { mimeType: "image/png", data: base64 } }
            ]
          }]
        },
        { headers: { 'Content-Type': 'application/json' } }
      );
      geminiReply = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Không có phản hồi từ AI.';
    } catch (err) {
      console.error("Lỗi Gemini:", err.response?.data || err.message);
      geminiReply = 'Lỗi khi phân tích bữa ăn với AI hoặc hết hạn mức.';
    }
    const hlvaiUser = await User.findOne({ username: 'hlvai' });
    if (hlvaiUser) {
      const aiMsg = new Message({ from: hlvaiUser._id, to: req.userId, content: geminiReply });
      await aiMsg.save();
      if (toUser.group?.name === 'Quản trị viên') {
        const aiMsgToAdmin = new Message({ from: hlvaiUser._id, to: toUser._id, content: geminiReply });
        await aiMsgToAdmin.save();
      }
    }
    res.json({ message: 'Đã gửi bữa ăn và nhận tư vấn.', mealMsg, aiReply: geminiReply });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi máy chủ khi gửi bữa ăn.' });
  }
});

// Cấu hình multer để upload avatar
const avatarStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, 'public/static/avatar/'));
  },
  filename: function (req, file, cb) {
    cb(null, req.userId + path.extname(file.originalname));
  }
});
const uploadAvatar = multer({ storage: avatarStorage });

// API: Lấy thông tin cá nhân
app.get('/api/account/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) return res.status(404).json({ message: 'Không tìm thấy user.' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi máy chủ khi lấy thông tin cá nhân.' });
  }
});

// API: Cập nhật thông tin cá nhân
app.put('/api/account/profile', auth, async (req, res) => {
  try {
    const { fullname, birthday, height, gender } = req.body;
    const user = await User.findByIdAndUpdate(
      req.userId,
      { fullname, birthday, height, gender },
      { new: true }
    ).select('-password');
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi máy chủ khi cập nhật thông tin cá nhân.' });
  }
});

// API: Upload avatar
app.post('/api/account/avatar', auth, uploadAvatar.single('avatar'), async (req, res) => {
  try {
    const fs = require('fs');
    const mimeType = req.file.mimetype;
    const base64 = fs.readFileSync(req.file.path, { encoding: 'base64' });
    const dataUrl = `data:${mimeType};base64,${base64}`;
    const user = await User.findByIdAndUpdate(
      req.userId,
      { avatar: dataUrl },
      { new: true }
    ).select('-password');
    fs.unlinkSync(req.file.path);
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi máy chủ khi upload avatar.' });
  }
});

// API: Đổi mật khẩu
app.put('/api/account/password', auth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ msg: 'Không tìm thấy user.' });
    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) return res.status(400).json({ msg: 'Mật khẩu cũ không đúng' });
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ msg: 'Đổi mật khẩu thành công' });
  } catch (err) {
    res.status(500).json({ msg: 'Lỗi máy chủ khi đổi mật khẩu.' });
  }
});

// API: Xóa avatar
app.delete('/api/account/avatar', auth, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.userId,
      { avatar: '' },
      { new: true }
    ).select('-password');
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi máy chủ khi xóa avatar.' });
  }
});

ensureDefaultGroupsAndHLVAI();

const PORT = 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Máy chủ đang chạy tại cổng ${PORT}`);
});
