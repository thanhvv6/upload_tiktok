// Cookie dán/import ở dạng chuỗi "name=value; name=value" không mang hạn dùng.
//
// Nếu tiêm nguyên như vậy, Playwright coi chúng là cookie phiên và GHI ĐÈ cookie
// persistent đang có trong user-data-dir — phiên đăng nhập biến mất ngay khi
// đóng browser, lần chạy sau lại phải đăng nhập.
//
// Đo trực tiếp trên máy: sau một lần tiêm chuỗi thô, sessionid trên đĩa từ
// persistent (còn hạn 6 tiếng) tụt xuống SESSION-ONLY. Ở thời điểm phát hiện,
// 56/57 profile đang ở trạng thái session-only vì lỗi này.

/**
 * Hạn mặc định gán cho cookie import ở dạng chuỗi.
 *
 * Chọn 180 ngày để khớp với hạn TikTok thực sự cấp: đo trên một profile đăng
 * nhập trọn vẹn, sessionid sống tới 2027-02-17, tức khoảng 6 tháng. Đặt ngắn
 * hơn thì phần tiêm sẽ rút ngắn chính phiên mà TikTok còn chấp nhận, và profile
 * nào nằm im quá hạn đó sẽ bị Chrome vứt cookie dù nó vẫn dùng được.
 *
 * Con số này chỉ nói với Chrome giữ cookie bao lâu. Trình duyệt gửi lên máy chủ
 * đúng cặp name=value, nên nó không hề ảnh hưởng tới việc TikTok có công nhận
 * phiên hay không.
 */
export const IMPORTED_COOKIE_TTL_DAYS = 180;

/**
 * Đọc chuỗi cookie thành đối tượng cho Playwright, có gán hạn dùng rõ ràng.
 */
export function parseCookieHeader(raw, now = Date.now(), ttlDays = IMPORTED_COOKIE_TTL_DAYS) {
    if (!raw || typeof raw !== 'string') return [];

    const expires = Math.floor((now + ttlDays * 24 * 60 * 60 * 1000) / 1000);

    return raw
        .split(';')
        .map((part) => {
            const equalIdx = part.indexOf('=');
            if (equalIdx === -1) return null;
            const name = part.substring(0, equalIdx).trim();
            const value = part.substring(equalIdx + 1).trim();
            if (!name) return null;
            return { name, value, domain: '.tiktok.com', path: '/', expires };
        })
        .filter(Boolean);
}

/** Tên cookie giữ phiên đăng nhập TikTok. */
export const SESSION_COOKIE = 'sessionid';

function isTikTokCookie(cookie) {
    return typeof cookie?.domain === 'string' && cookie.domain.includes('tiktok');
}

/**
 * Trong user-data-dir đã có sẵn một phiên TikTok đang sống chưa?
 *
 * Dùng làm điều kiện chặn việc tiêm cookie: cookie nằm trong folder luôn mới
 * hơn bản chụp trong DB, vì DB chỉ được ghi lúc đăng nhập qua luồng tự động,
 * còn folder được Chrome cập nhật sau mỗi phiên. Tiêm đè lên nó chỉ có thể
 * thay một phiên mới bằng một bản cũ hơn.
 *
 * Cookie phiên (expires -1) vẫn tính là đang sống: nó có mặt trong context nên
 * dùng được cho lượt chạy này, và khi duyệt TikTok sẽ tự cấp lại kèm hạn.
 */
export function hasLiveTikTokSession(cookies = [], now = Date.now()) {
    const session = cookies.find(
        (c) => isTikTokCookie(c) && c.name === SESSION_COOKIE && c.value
    );
    if (!session) return false;

    if (typeof session.expires === 'number' && session.expires > 0) {
        return session.expires * 1000 > now;
    }
    return true;
}
