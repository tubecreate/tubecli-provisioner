# TubeCLI Provisioner

Service nhỏ chạy 24/7: nhận job qua HTTP → SSH vào server mới thuê → chạy
`curl install.sh | bash` để cài TubeCLI tự động → callback kết quả về web.

## Deploy trên Zeabur

1. Add Service → Deploy from GitHub → chọn repo này (Zeabur tự build Dockerfile)
2. Đặt biến môi trường (tab Variable):
   - `PROVISIONER_SECRET` — chuỗi bí mật, PHẢI trùng với secret cùng tên bên web Cloudflare
   - `TUBECLI_PORT` — mặc định `5295`
3. Bật Networking → tạo domain public → copy URL
4. Bên web Cloudflare đặt secret `PROVISIONER_URL` = URL đó

## Env

| Biến | Bắt buộc | Mặc định |
|---|---|---|
| PROVISIONER_SECRET | ✅ | — |
| TUBECLI_PORT | | 5295 |
| PORT | | 8080 (Zeabur tự cấp) |
