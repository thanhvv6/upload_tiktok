/**
 * Danh sách nhạc của một profile.
 *
 * Cột `profiles.music_search` vốn giữ đúng một từ khoá tìm nhạc. Nay nó giữ cả
 * danh sách, mỗi bài một dòng, và mỗi video trong lượt chạy lấy bài kế tiếp
 * theo thứ tự. Giữ nguyên kiểu cột TEXT nghĩa là mọi giá trị cũ — một dòng duy
 * nhất — vẫn đọc ra đúng một bài như trước, không cần chuyển đổi dữ liệu.
 */

/**
 * Tách chuỗi cấu hình thành danh sách bài, giữ nguyên thứ tự người dùng nhập.
 *
 * Nhận cả dấu `|` bên cạnh ký tự xuống dòng: file CSV import khai mỗi profile
 * trên một dòng, nên không nhét được nhiều dòng vào ô `music_search`; `|` là
 * cách khai nhiều bài trong một ô, và cũng là dấu phân tách mà khâu import
 * đang dùng sẵn cho cột account_id.
 */
export function parseMusicList(text) {
    if (typeof text !== 'string') return [];
    return text
        .split(/[\n\r|]+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

/**
 * Đưa con trỏ về trong phạm vi `count` phần tử.
 *
 * Dùng chung cho cả hai cách chọn nhạc: chạy trên danh sách music_search, và
 * chạy trên số mục đang hiện trong tab Favorites của TikTok. Bên favorites chỉ
 * biết số lượng chứ không có mảng, nên phép quay vòng phải tách riêng ra đây
 * thay vì nằm trong pickMusicAt — hai chỗ mà quay vòng lệch nhau thì bật/tắt
 * tuỳ chọn favorites sẽ làm nhảy bài.
 *
 * Con trỏ âm, NaN hay rác đều được coi như 0: một giá trị hỏng trong DB không
 * đáng để làm chết lượt chạy.
 */
export function wrapIndex(count, cursor) {
    if (!Number.isFinite(count) || count <= 0) return 0;
    const position = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
    return position % Math.floor(count);
}

/**
 * Bài dành cho video thứ `index` của chuỗi chạy, quay vòng khi hết danh sách.
 *
 * Con trỏ được lưu xuống DB và tăng dần qua từng lượt chạy, nên nó lớn hơn độ
 * dài danh sách là chuyện bình thường; phép chia dư đưa nó về lại đầu danh sách.
 */
export function pickMusicAt(list, index) {
    if (!Array.isArray(list) || list.length === 0) return null;
    return list[wrapIndex(list.length, index)];
}

/**
 * Con trỏ cho video kế tiếp.
 *
 * Kéo về trong phạm vi danh sách trước khi lưu, để giá trị trong DB không lớn
 * dần vô hạn qua hàng nghìn video và vẫn đọc được bằng mắt khi soi DB.
 */
export function nextMusicIndex(list, index) {
    if (!Array.isArray(list) || list.length === 0) return 0;
    return wrapIndex(list.length, wrapIndex(list.length, index) + 1);
}

/**
 * Chuẩn hoá một chuỗi tên nhạc để đem so sánh.
 *
 * Về chữ thường và biến mọi thứ không phải chữ hoặc số thành khoảng trắng, nên
 * `"Siren's Song - Gilang Galang"` và `Siren's Song` + `04:00 · Gilang Galang`
 * cùng rút về những từ như nhau. Dùng \p{L}\p{N} chứ không phải a-z0-9 để tên
 * tiếng Việt có dấu không bị băm vụn.
 *
 * Phải áp dụng cho CẢ HAI vế của phép so sánh, nếu không thì dấu nháy, dấu gạch
 * hay dấu chấm giữa sẽ tạo ra khác biệt giả.
 */
export function normalizeMusicText(text) {
    if (typeof text !== 'string') return '';
    return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Kết quả tìm kiếm trên TikTok có đúng bài người dùng khai không?
 *
 * TikTok trả về nhiều bài trùng tên của những ca sĩ khác nhau — tìm
 * "Siren's Song - Gilang Galang" thì trong ba kết quả đầu có một bài cùng tên
 * của Purrple Cat. Lấy đại kết quả đầu là đăng nhầm nhạc, nên phải đối chiếu.
 *
 * Luật: mọi từ trong chuỗi người dùng khai phải có mặt trong tên bài cộng phần
 * mô tả của kết quả. So theo từng từ trọn vẹn chứ không phải chuỗi con, để
 * "song" không khớp bừa vào "songbird". Phần mô tả có kèm thời lượng
 * ("04:00 · Gilang Galang") nhưng những từ thừa đó vô hại: luật chỉ đòi các từ
 * của người dùng phải có, không đòi hai bên bằng nhau — nhờ vậy cùng một bài ở
 * nhiều bản cắt dài ngắn khác nhau đều khớp.
 */
export function musicEntryMatches(entry, title, desc) {
    const wanted = normalizeMusicText(entry).split(' ').filter(Boolean);
    if (wanted.length === 0) return false;
    const found = new Set(
        normalizeMusicText(`${title || ''} ${desc || ''}`).split(' ').filter(Boolean)
    );
    return wanted.every((word) => found.has(word));
}
