/**
 * Phân loại lỗi cho vòng lặp upload.
 *
 * Vòng lặp upload bọc mỗi task trong một `try/catch` riêng và phần lớn catch
 * chỉ ghi log rồi chạy tiếp — cố ý, để một cái tooltip không đóng được không
 * giết cả lượt tám video. Nhưng có những lỗi không phải trục trặc vặt, và
 * những chỗ mà chạy tiếp còn hại hơn dừng. Đây là chỗ gom lại cách phân biệt.
 */

/**
 * Browser hoặc trang đã đóng — không còn gì để thao tác nữa.
 *
 * Lỗi này khác mọi lỗi khác ở một điểm: nó không thuộc về riêng bước đang
 * chạy. Nhưng từng `catch` chỉ nhìn thấy phần việc của mình nên đều kết luận
 * "bước này hỏng, bỏ qua", và lượt chạy lết tiếp qua cả chuỗi bước còn lại —
 * mỗi bước hỏng vì đúng một lý do — tới tận khâu bấm Post. Phiên 2026-09-10
 * của user73412133517231 đi trọn sáu bước như thế trong 14 mili-giây, để lại
 * một log trông như hỏng sáu chỗ khác nhau trong khi chỉ hỏng đúng một chỗ:
 * cửa sổ bị đóng lúc 16:30:53.
 *
 * Chỉ nhận đúng hai cách Playwright diễn đạt việc này. Nới rộng hơn là nguy
 * hiểm theo chiều ngược lại: hết giờ chờ hay mất mạng là chuyện đáng thử lại,
 * dừng lượt vì chúng thì mỗi trục trặc thoáng qua lại giết một lượt chạy.
 */
export function isBrowserGone(error) {
    return /Target closed|has been closed/i.test(String(error?.message ?? ''));
}

/**
 * Không đặt được lịch trong khi lượt chạy đã cam kết không đăng ngay.
 *
 * Lớp lỗi riêng vì cùng một lý do đã sinh ra MusicNotResolvedError: khâu lên
 * lịch nằm trong một `catch` chỉ ghi log rồi chạy tiếp thẳng xuống bấm Post.
 * Bật hẹn giờ đăng, hoặc kênh còn loạt lịch cũ chưa chạy tới, đều có nghĩa
 * "không video nào được đăng ngay" — đặt lịch hỏng mà vẫn bấm Post là làm đúng
 * cái việc bị cấm. Đăng rồi thì không rút lại được, còn dừng lượt thì chạy lại
 * được.
 */
export class ScheduleNotSetError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ScheduleNotSetError';
    }
}
