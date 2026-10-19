const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { getPool } = require('../db');
const logger = require('../services/logger');

// Khớp cột TaiKhoan.TenDangNhap NVARCHAR(100) — dài hơn sẽ bị lỗi truncation
const DAI_TOI_DA_TEN_DANG_NHAP = 100;

function laLoiTrungUnique(err, tenIndex) {
  if (!err || (err.number !== 2601 && err.number !== 2627)) return false;
  // SQL Server ghi tên index/vị trí vi phạm vào message
  return String(err.message || '').includes(tenIndex);
}

// ---- Logic thuần, không đụng DB (để test được) ----

// Trích email + tên đăng nhập gợi ý từ Google profile.
// Ưu tiên email (ổn định, ít khi đổi) — thiếu email mới rơi về displayName.
function layThongTuGoogle(profile) {
  const email = (profile.emails?.[0]?.value || '').trim() || null;
  const tenGoiY = (profile.displayName || '').trim() || null;
  const chon = (giaTri) => (giaTri && giaTri.length <= DAI_TOI_DA_TEN_DANG_NHAP ? giaTri : null);
  const tenDangNhap = chon(email) || chon(tenGoiY);
  return { email, tenDangNhap };
}

// "Điền nếu thiếu, đồng bộ nếu đổi": so sánh với giá trị HIỆN TẠI trong DB.
// Giá trị cũ là NULL (điền) hay khác giá trị Google (đồng bộ) đều cho cờ = true.
function tinhThongTinCanDongBo(profile, taiKhoan) {
  const { email, tenDangNhap } = layThongTuGoogle(profile);
  const hienTaiEmail = taiKhoan?.Email ?? null;
  const hienTaiTen = taiKhoan?.TenDangNhap ?? null;
  return {
    email,
    tenDangNhap,
    canDongBoEmail: Boolean(email) && email !== hienTaiEmail,
    canDongBoTen: Boolean(tenDangNhap) && tenDangNhap !== hienTaiTen,
  };
}

// ---- Logic đụng DB ----

// TenDangNhap là unique index một phần: email Google có thể đã bị một tài khoản
// thường (admin tạo qua /auth/dang-yk) chiếm mất. Nếu bị chiếm thì bỏ ghi
// TenDangNhap (giữ NULL) chứ không để lỗi unique làm hỏng cả luồng đăng nhập.
// idLoaiTru: Id của chính bản ghi cần loại (0 khi chưa có bản ghi — Id IDENTITY >= 1).
async function tenDangNhapDaBiChiem(pool, tenDangNhap, idLoaiTru) {
  const r = await pool
    .request()
    .input('t', tenDangNhap)
    .input('id', idLoaiTru)
    .query('SELECT COUNT(*) AS cnt FROM TaiKhoan WHERE TenDangNhap = @t AND Id <> @id');
  return r.recordset[0].cnt > 0;
}

// Đăng nhập lại bằng tài khoản Google đã có: điền Email/TenDangNhap nếu đang NULL,
// đồng bộ nếu trên Google đã đổi. Không có gì khác thì trả về nguyên trạng, không UPDATE thừa.
async function dongBoThongTinGoogle(pool, profile, taiKhoan) {
  const { email, tenDangNhap, canDongBoEmail, canDongBoTen } =
    tinhThongTinCanDongBo(profile, taiKhoan);
  if (!canDongBoEmail && !canDongBoTen) return taiKhoan;

  // @ten/@email = NULL nghĩa là GIỮ NGUYÊN giá trị cũ (COALESCE bên dưới)
  let ten = null;
  if (canDongBoTen) {
    if (await tenDangNhapDaBiChiem(pool, tenDangNhap, taiKhoan.Id)) {
      logger.warn(
        `TenDangNhap "${tenDangNhap}" đã bị tài khoản khác chiếm, bỏ qua đồng bộ TenDangNhap cho TaiKhoan ${taiKhoan.Id}`,
      );
    } else {
      ten = tenDangNhap;
    }
  }

  try {
    const r = await pool
      .request()
      .input('id', taiKhoan.Id)
      .input('ten', ten)
      .input('email', canDongBoEmail ? email : null)
      .query(
        `UPDATE TaiKhoan
         SET TenDangNhap = COALESCE(@ten, TenDangNhap),
             Email       = COALESCE(@email, Email)
         OUTPUT INSERTED.*
         WHERE Id = @id`,
      );
    return r.recordset[0] || taiKhoan;
  } catch (err) {
    // Trùng unique khi UPDATE (hai yêu cầu chạy song song) -> bỏ qua, vẫn đăng nhập được
    if (!laLoiTrungUnique(err, 'UQ_TaiKhoan_TenDangNhap')) throw err;
    logger.warn(`Trùng TenDangNhap "${ten}" khi đồng bộ TaiKhoan ${taiKhoan.Id}, bỏ qua`);
    return taiKhoan;
  }
}

// Chưa có -> tạo mới TaiKhoan, CHƯA gắn NhanVienId (admin/HR gắn thủ công
// sau đó qua màn hình Quản trị > Tài khoản)
async function taoTaiKhoanGoogle(pool, profile) {
  const { email, tenDangNhap } = layThongTuGoogle(profile);

  let ten = tenDangNhap;
  if (ten && (await tenDangNhapDaBiChiem(pool, ten, 0))) {
    logger.warn(`TenDangNhap "${ten}" đã tồn tại, tạo tài khoản Google với TenDangNhap NULL`);
    ten = null;
  }

  const chen = (giaTriTen) =>
    pool
      .request()
      .input('id', profile.id)
      .input('ten', giaTriTen)
      .input('email', email)
      .query(
        `INSERT INTO TaiKhoan (TenDangNhap, Email, VaiTro, NhaCungCapOAuth, MaNguoiDungOAuth)
         OUTPUT INSERTED.*
         VALUES (@ten, @email, 'nhan_vien', 'google', @id)`,
      );

  try {
    return (await chen(ten)).recordset[0];
  } catch (err) {
    if (laLoiTrungUnique(err, 'UQ_TaiKhoan_OAuth')) {
      // Hai luồng gọi callback cùng lúc cho cùng 1 Google account ->
      // luồng kia đã tạo trước, lấy lại bản ghi của luồng đó
      const r = await pool
        .request()
        .input('id', profile.id)
        .query(
          `SELECT * FROM TaiKhoan WHERE NhaCungCapOAuth = 'google' AND MaNguoiDungOAuth = @id`,
        );
      if (r.recordset[0]) return r.recordset[0];
    }
    if (laLoiTrungUnique(err, 'UQ_TaiKhoan_TenDangNhap') && ten !== null) {
      logger.warn(`Trùng TenDangNhap "${ten}" khi tạo tài khoản Google, tạo lại không cần TenDangNhap`);
      return (await chen(null)).recordset[0];
    }
    throw err;
  }
}

async function timHoacTaoTaiKhoanTuOAuth(profile) {
  const pool = await getPool();
  const existing = await pool
    .request()
    .input('id', profile.id)
    .query(
      `SELECT * FROM TaiKhoan WHERE NhaCungCapOAuth = 'google' AND MaNguoiDungOAuth = @id`,
    );
  const taiKhoan = existing.recordset[0];
  if (taiKhoan) return dongBoThongTinGoogle(pool, profile, taiKhoan);
  return taoTaiKhoanGoogle(pool, profile);
}

// Chỉ đăng ký strategy khi đã cấu hình đủ client ID/secret — nếu không,
// `new GoogleStrategy()` sẽ throw ngay lúc khởi động và backend chết oan
// chỉ vì chưa cần dùng Google OAuth.
const daCauHinhGoogle = Boolean(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
);

if (daCauHinhGoogle) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: '/auth/google/callback',
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const taiKhoan = await timHoacTaoTaiKhoanTuOAuth(profile);
          done(null, taiKhoan);
        } catch (err) {
          done(err);
        }
      }
    )
  );
}

module.exports = passport;
module.exports.daCauHinhGoogle = daCauHinhGoogle;
module.exports.layThongTuGoogle = layThongTuGoogle;
module.exports.tinhThongTinCanDongBo = tinhThongTinCanDongBo;
module.exports.timHoacTaoTaiKhoanTuOAuth = timHoacTaoTaiKhoanTuOAuth;
