require("dotenv").config();
const bcrypt = require("bcrypt");
const { getPool } = require("../src/db");

async function seed() {
  const pool = await getPool();

  const daCoAdmin = await pool
    .request()
    .query(`SELECT COUNT(*) AS cnt FROM TaiKhoan WHERE TenDangNhap = 'admin'`);

  if (daCoAdmin.recordset[0].cnt > 0) {
    console.log("Tài khoản admin đã tồn tại, bỏ qua seed.");
    process.exit(0);
  }

  const hash = await bcrypt.hash("admin", 10);
  const emailAdmin = process.env.SEED_ADMIN_EMAIL || "admin@hrms.local";
  await pool
    .request()
    .input("hash", hash)
    .input("email", emailAdmin)
    .query(
      `INSERT INTO TaiKhoan (TenDangNhap, Email, MatKhau, VaiTro)
       VALUES ('admin', @email, @hash, 'admin')`,
    );

  console.log("Seed hoàn tất — đăng nhập bằng: admin / admin");
  console.log(`Email khôi phục mật khẩu của admin: ${emailAdmin}`);
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed thất bại:", err);
  process.exit(1);
});
