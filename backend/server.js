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
  phanTichBienDong: String,
  note: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});
const BodyMetric = mongoose.model('BodyMetric', bodyMetricSchema);

// Model tin nhắn giữa người dùng
const messageSchema = new mongoose.Schema({
  from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  image: { type: String },
  createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

// Middleware xác thực đơn giản (giả lập, cần thay bằng JWT/session thực tế)
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
  let hlvai = await User.findOne({ username: 'hlvai' });
  if (!hlvai) {
    hlvai = new User({
      username: 'hlvai',
      password: 'hlvai',
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

// Phân tích ảnh chỉ số bằng Gemini
app.post('/api/body-metrics/analyze-image', auth, async (req, res) => {
  try {
    const { imageBase64, fullname, gender, height, age, lastMetrics, prompt } = req.body;
    let finalPrompt = prompt;
    if (!finalPrompt) {
      finalPrompt = `đây là hình ảnh ghi chỉ số sức khỏe của ${fullname}, giới tính ${gender}, chiều cao ${height} cm, tuổi ${age}. hãy phân tích chỉ số sức khỏe và chỉ trả về kết quả dưới dạng JSON, không giải thích, không mô tả, không markdown, không thêm bất kỳ ký tự nào ngoài JSON.`;
      if (lastMetrics) {
        finalPrompt += `\nChỉ số gần nhất: ${JSON.stringify(lastMetrics)}`;
      }
    }
    const base64 = imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
    const geminiRes = await axios.post(
      process.env.GEMINI_API_URL,
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
      {
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': process.env.GEMINI_API_KEY
        }
      }
    );
    res.json(geminiRes.data);
  } catch (err) {
    console.error('Gemini error:', err.response?.data || err.message);
    res.status(500).json({ message: 'Lỗi khi phân tích ảnh chỉ số.' });
  }
});

// API gửi ảnh bữa ăn, nhận tư vấn từ Gemini
app.post('/api/chat/send-meal', auth, async (req, res) => {
  try {
    const { to, imageBase64 } = req.body;
    const fromUser = await User.findById(req.userId);
    const prompt = `đây là bữa ăn của ${fromUser.fullname}. hãy phân tích và tư vấn ngắn gọn, dễ hiểu.`;
    const base64 = imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
    const geminiRes = await axios.post(
      process.env.GEMINI_API_URL,
      {
        contents: [
          {
            parts: [
              { text: prompt },
              { inlineData: { mimeType: "image/png", data: base64 } }
            ]
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': process.env.GEMINI_API_KEY
        }
      }
    );
    const geminiReply =
      geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.json({ aiReply: geminiReply });
  } catch (err) {
    console.error('Gemini error:', err.response?.data || err.message);
    res.status(500).json({ message: 'Lỗi máy chủ khi gửi bữa ăn.' });
  }
});

// Gọi hàm này khi khởi động server
ensureDefaultGroupsAndHLVAI();

// Khởi động server
const PORT = 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Máy chủ đang chạy tại cổng ${PORT}`);
});
