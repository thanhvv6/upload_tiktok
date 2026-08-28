const pad = (value) => String(value).padStart(2, '0');

/**
 * Mọi mốc lịch đều rơi vào bội số 5 phút.
 *
 * Không phải để cho đẹp: ô giờ của TikTok là một time picker, và trong 4490 lần
 * điền được ghi lại thì phút chỉ từng nhận bội số của 5. Phút lẻ là giá trị
 * chưa từng được gửi đi lần nào, mà nhánh điền qua picker lại bỏ qua im lặng
 * khi không tìm thấy dòng phút cần chọn.
 */
export const SCHEDULE_SLOT_MINUTES = 5;

/**
 * Làm tròn LÊN mốc 5 phút gần nhất. Luôn lên, không bao giờ xuống: đặt lịch
 * sớm hơn mốc đã hẹn là sai hướng, muộn hơn vài phút thì vô hại.
 *
 * Cố tình dùng đơn vị cố định 5 phút chứ không phải interval. Làm tròn theo
 * interval trên lưới đồng hồ tuyệt đối sẽ đá vào nhịp của loạt: loạt 9:15 /
 * 9:25 / 9:35 với interval 10 bị kéo 9:35 thành 9:40. Còn mốc neo là bội số 5
 * và interval (5/10/15) cũng là bội số 5, nên neo + k×interval vốn đã là bội số
 * 5 -- làm tròn ở đây thành vô hại, và nhịp được giữ nguyên.
 */
const ceilToSlot = (timeMs) => {
    const unit = SCHEDULE_SLOT_MINUTES * 60 * 1000;
    return new Date(Math.ceil(timeMs / unit) * unit);
};

export function computeNextScheduledTime({ index, lastScheduledTime, intervalMinutes = 10, now = new Date() }) {
    if (index < 3) return null;
    const stepMin = Number(intervalMinutes) || 10;
    const stepMs = stepMin * 60 * 1000;
    const TWENTY_MINUTES_IN_MS = 20 * 60 * 1000;

    const baseTime = index === 3 || !lastScheduledTime
        ? new Date(now.getTime() + TWENTY_MINUTES_IN_MS)
        : new Date(lastScheduledTime.getTime() + stepMs);

    return new Date(Math.ceil(baseTime.getTime() / stepMs) * stepMs);
}

/**
 * Mốc kế tiếp của một loạt lịch: mốc cuối + đúng một interval.
 *
 * `minLeadMinutes` > 0 thì mốc kế tiếp nào còn quá sát hiện tại sẽ bị bỏ qua
 * bằng cách cộng thêm nguyên nhịp, chứ không phải rời khỏi nhịp. Loạt cũ đang ở
 * 9:15/9:30/9:45 mà chạy lúc 9:16 sẽ ra 9:45 -- nhịp cũ, chỉ bỏ mốc không kịp --
 * thay vì 10:00 như khi lấy now + 20 phút làm mốc gốc mới.
 */
export function computeAutoIncrementTime({ lastScheduledTime, intervalMinutes = 5, now = new Date(), minLeadMinutes = 0 }) {
    const stepMin = Number(intervalMinutes) || 5;
    const stepMs = stepMin * 60 * 1000;
    const TWENTY_MINUTES_IN_MS = 20 * 60 * 1000;

    let baseTime = lastScheduledTime
        ? lastScheduledTime.getTime() + stepMs
        : now.getTime() + TWENTY_MINUTES_IN_MS;

    // Nhảy thẳng tới nhịp hợp lệ đầu tiên thay vì cộng dồn từng bước: một loạt
    // trễ vài ngày sẽ cần hàng nghìn vòng lặp mới thoát.
    const earliest = now.getTime() + minLeadMinutes * 60 * 1000;
    if (lastScheduledTime && baseTime < earliest) {
        baseTime += Math.ceil((earliest - baseTime) / stepMs) * stepMs;
    }

    return ceilToSlot(baseTime);
}

// Hẹn giờ đăng (setting toàn cục): TikTok chỉ nhận lịch trong vòng 10 ngày và
// từ chối mốc quá sát hiện tại, nên số phút người dùng nhập bị kẹp hai đầu.
//
// Sàn 15 phút, và nó đã được thử ở mức thấp hơn rồi hỏng. Hạ xuống 10 thì lượt
// chạy thật xin mốc 13:30 trong khi TikTok đề xuất 13:35: time picker treo 30
// giây (lần duy nhất trong 4524 lượt, gần như chắc chắn vì TikTok khoá những
// dòng dưới ngưỡng), gõ tay vào thì TikTok báo lỗi, phải sửa tay thành 13:35.
//
// 15 cũng chính là quy tắc của TikTok: giờ nó tự đề xuất khi mở form luôn nằm
// trong dải 14,9-19,9 phút (511 mẫu), tức "now + 15 rồi làm tròn lên mốc 5".
// computeDelayedFirstTime bên dưới làm đúng như vậy.
//
// Đừng nhầm với schedule_interval: khoảng cách giữa các video vẫn để 10 phút
// được, đó là con số khác. Trong 4490 lịch đã đặt, lead chưa bao giờ rơi vào
// dải 10-15 phút -- vùng đó chưa từng chạy được.
export const POST_DELAY_MIN_MINUTES = 15;
export const POST_DELAY_MAX_MINUTES = 10 * 24 * 60;

/**
 * Mốc chờ đọc từ TikTok Studio mà xa hơn ngần này thì chắc chắn là đọc hỏng.
 *
 * TikTok không nhận lịch quá 10 ngày, nên không dòng nào trên trang Content có
 * thể nằm xa hơn thế. Cộng thêm một ngày dung sai cho lệch múi giờ và đồng hồ
 * máy. Không có trần này thì một mốc rác trở thành neo, và mọi video mới lặng lẽ
 * xếp hàng sau nó.
 */
export const STUDIO_MAX_PENDING_DAYS = 11;

/**
 * Mức lead tối thiểu code tự bảo đảm khi chọn mốc trong một loạt đã có.
 *
 * Khác hẳn POST_DELAY_MIN_MINUTES: con số kia là giới hạn dưới của ô cài đặt,
 * do người dùng quyết; con số này là hàng rào kỹ thuật để TikTok chịu nhận mốc.
 * Trộn hai thứ làm một chính là lỗi của mốc "now + 20 phút" cũ.
 *
 * Bằng 15 cho khớp sàn của ô cài đặt: cùng một ràng buộc của TikTok thì không
 * có lý do gì hai đường lại chừa biên khác nhau. Từng để 10 và TikTok đã từ
 * chối một mốc thật -- xem ghi chú ở POST_DELAY_MIN_MINUTES.
 *
 * Mốc được tính lúc điền form còn TikTok kiểm lúc bấm đăng; đo trên log thì
 * khoảng đó là 11s (p50), 22s (p99), 97s (max). Việc làm tròn lên mốc 5 phút
 * thường bù thêm 0-5 phút nữa, nên biên thực tế rộng hơn 15 một chút.
 */
export const SCHEDULE_MIN_LEAD_MINUTES = 15;

/**
 * Mốc cho video đầu tiên khi bật hẹn giờ đăng: now + số phút đã cài, giữ một
 * cái sàn rồi làm tròn lên mốc 5 phút.
 *
 * Sàn ở đây là POST_DELAY_MIN_MINUTES (15 phút), sát hơn mốc 20 phút mà
 * computeNextScheduledTime còn giữ. Được phép sát hơn vì mốc này được tính ngay
 * trước khi điền vào form, tức là sau khi video đã upload xong, nên 15 phút là
 * 15 phút thật tính từ lúc gửi -- khác hàm kia, vốn tính từ một thời điểm còn
 * cách lúc gửi vài phút xử lý video.
 *
 * Không nhận interval nữa: mốc đầu chỉ phụ thuộc số phút đã hẹn, còn khoảng
 * cách giữa các video là việc của computeAutoIncrementTime.
 */
export function computeDelayedFirstTime({ delayMinutes, now = new Date() }) {

    const requestedMinutes = Number(delayMinutes);
    const safeMinutes = Number.isFinite(requestedMinutes)
        ? Math.min(Math.max(requestedMinutes, 0), POST_DELAY_MAX_MINUTES)
        : 0;

    const baseTime = Math.max(
        now.getTime() + safeMinutes * 60 * 1000,
        now.getTime() + POST_DELAY_MIN_MINUTES * 60 * 1000
    );

    return ceilToSlot(baseTime);
}

export function getScheduleHintText(meta = {}) {
    return [
        meta.placeholder,
        meta.ariaLabel,
        meta.label,
        meta.name,
        // meta.id, // Exclude ID to avoid matching autogenerated prefixes like :rc4:
        meta.value
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

export function inferScheduleFieldKind(meta = {}) {
    const hint = getScheduleHintText(meta);
    if (!hint) return 'unknown';

    // Priority 1: explicitly mentions date/time words
    if (/\b(date|day|ngay)\b/.test(hint)) return 'date';
    if (/\b(time|hour|minute|gio)\b/.test(hint)) return 'time';

    // Priority 2: Looks like a Date pattern (YYYY-MM-DD, MM/DD/YYYY, etc.)
    if (/\d{4}[-.]\d{2}[-.]\d{2}/.test(hint) || /\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}/.test(hint)) {
        return 'date';
    }

    // Priority 3: Looks like a Time pattern (HH:mm)
    if (/\b(am|pm)\b/.test(hint) || /\b\d{1,2}:\d{2}\b/.test(hint)) {
        return 'time';
    }

    return 'unknown';
}


export function formatScheduleValue(date, kind, meta = {}) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        throw new Error('Invalid schedule date');
    }

    const hint = getScheduleHintText(meta);
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = date.getHours();
    const minutes = pad(date.getMinutes());

    if (kind === 'time') {
        if (/\b(am|pm)\b/.test(hint)) {
            const hour12 = hours % 12 || 12;
            const meridiem = hours >= 12 ? 'PM' : 'AM';
            return `${hour12}:${minutes} ${meridiem}`;
        }

        return `${pad(hours)}:${minutes}`;
    }

    if (kind === 'date') {
        if (/dd\s*\/\s*mm/.test(hint)) return `${day}/${month}/${year}`;
        if (/mm\s*\/\s*dd/.test(hint) || hint.includes('/')) return `${month}/${day}/${year}`;
        if (hint.includes('.')) return `${year}.${month}.${day}`;
        return `${year}-${month}-${day}`;
    }

    throw new Error(`Unsupported schedule field kind: ${kind}`);
}

export function sortScheduleInputs(inputs = []) {
    return [...inputs].sort((a, b) => {
        if ((a.top ?? 0) !== (b.top ?? 0)) return (a.top ?? 0) - (b.top ?? 0);
        return (a.left ?? 0) - (b.left ?? 0);
    });
}

/**
 * Attempts to parse a date and time string from TikTok inputs back into a Date object.
 */
export function parseScheduleValue(dateStr, timeStr, now = new Date()) {
    if (!dateStr || !timeStr) return null;

    try {
        // Try to parse date (expected YYYY-MM-DD or DD/MM/YYYY or MM/DD/YYYY)
        let year, month, day;
        if (dateStr.includes('-')) {
            [year, month, day] = dateStr.split('-').map(Number);
        } else if (dateStr.includes('/')) {
            const parts = dateStr.split('/').map(Number);
            if (parts[0] > 12) { // Likely DD/MM/YYYY
                [day, month, year] = parts;
            } else { // Likely MM/DD/YYYY
                [month, day, year] = parts;
            }
        } else if (dateStr.includes('.')) {
            [year, month, day] = dateStr.split('.').map(Number);
        }

        // Try to parse time (expected HH:mm or HH:mm AM/PM)
        let hours, minutes;
        const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i);
        if (!timeMatch) return null;

        hours = parseInt(timeMatch[1], 10);
        minutes = parseInt(timeMatch[2], 10);
        const meridiem = timeMatch[3];

        if (meridiem) {
            if (meridiem.toUpperCase() === 'PM' && hours < 12) hours += 12;
            if (meridiem.toUpperCase() === 'AM' && hours === 12) hours = 0;
        }

        // Build every field at once. Setting them one by one on top of today's
        // date overflows whenever today's day-of-month does not exist in the
        // target month -- on Aug 31, setMonth(September) lands on Oct 1, which
        // pushed the whole schedule a month out for runs just before midnight.
        const date = new Date(
            year || now.getFullYear(),
            month ? month - 1 : now.getMonth(),
            day || now.getDate(),
            hours,
            minutes,
            0,
            0
        );

        return date;
    } catch (e) {
        console.error('Error parsing schedule value:', e);
        return null;
    }
}

const MONTH_ABBREVIATIONS = [
    'jan', 'feb', 'mar', 'apr', 'may', 'jun',
    'jul', 'aug', 'sep', 'oct', 'nov', 'dec'
];

function readMonthAndDay(datePart) {
    const monthIndex = MONTH_ABBREVIATIONS.findIndex(
        (abbr) => new RegExp(`\\b${abbr}`, 'i').test(datePart)
    );

    if (monthIndex >= 0) {
        // "Jul 13", "13 Jul", "July 13" — ngày là số 1-2 chữ số duy nhất còn lại.
        const dayMatch = datePart.match(/\b(\d{1,2})\b/);
        if (!dayMatch) return null;
        return { month: monthIndex, day: Number(dayMatch[1]) };
    }

    // Dạng thuần số, năm đã được cắt bỏ trước đó: "07/13", "13/07", "-07-13".
    const numbers = datePart.split(/\D+/).filter(Boolean).map(Number);
    if (numbers.length < 2) return null;

    // Số đầu > 12 thì chỉ có thể là ngày (DD/MM), ngược lại theo mặc định
    // en-US của TikTok Studio là MM/DD.
    return numbers[0] > 12
        ? { month: numbers[1] - 1, day: numbers[0] }
        : { month: numbers[0] - 1, day: numbers[1] };
}

/**
 * Đọc nhãn trạng thái "đã lên lịch" trên TikTok Studio Content thành Date.
 *
 * Không dùng `new Date(text)` được: nhãn của TikTok thường bỏ năm khi lịch nằm
 * trong năm hiện tại, và V8 mặc định năm 2001 cho chuỗi kiểu "Jul 13, 3:30 PM",
 * đẩy toàn bộ lịch nối tiếp về quá khứ 25 năm.
 */
export function parseStudioScheduleLabel(text, now = new Date()) {
    if (!text || typeof text !== 'string') return null;

    const cleaned = text
        .replace(/scheduled\s*(for)?/i, ' ')
        .replace(/đã\s*lên\s*lịch/i, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return null;

    const timeMatch = cleaned.match(/(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i);
    if (!timeMatch) return null;

    let hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const meridiem = timeMatch[3];
    if (meridiem) {
        if (meridiem.toUpperCase() === 'PM' && hours < 12) hours += 12;
        if (meridiem.toUpperCase() === 'AM' && hours === 12) hours = 0;
    }
    if (hours > 23 || minutes > 59) return null;

    const datePart = `${cleaned.slice(0, timeMatch.index)} ${cleaned.slice(timeMatch.index + timeMatch[0].length)}`
        .replace(/,/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const explicitYearMatch = datePart.match(/\b(20\d{2})\b/);
    const withoutYear = explicitYearMatch
        ? datePart.replace(explicitYearMatch[0], ' ').replace(/\s+/g, ' ').trim()
        : datePart;

    const monthDay = readMonthAndDay(withoutYear);
    if (!monthDay) return null;
    const { month, day } = monthDay;
    if (!(month >= 0 && month <= 11) || !(day >= 1 && day <= 31)) return null;

    const build = (year) => {
        const date = new Date(year, month, day, hours, minutes, 0, 0);
        // Ngày không tồn tại (31/02, 29/02 năm thường) bị Date tự tràn sang
        // tháng sau — loại bỏ thay vì trả về mốc sai.
        if (date.getMonth() !== month || date.getDate() !== day) return null;
        return date;
    };

    if (explicitYearMatch) return build(Number(explicitYearMatch[1]));

    // Nhãn thiếu năm chỉ có thể là một mốc quanh hiện tại: TikTok cho hẹn xa
    // nhất 10 ngày, còn lịch đã trễ thì nằm lại trong quá khứ gần. Nên chọn năm
    // đưa mốc GẦN hiện tại nhất, xét cả năm trước và năm sau.
    //
    // Cách cũ mặc định đẩy sang năm sau khi mốc lùi quá một tuần, nên một lịch
    // trễ 8 ngày bị đọc thành năm sau và kéo cả loạt đăng đi gần 365 ngày. Đối
    // xứng lại cũng vá luôn chiều ngược: nhãn "Dec 27" đọc vào đầu tháng 1 giờ
    // ra tháng 12 vừa rồi, chứ không phải tháng 12 gần một năm nữa.
    const candidates = [
        build(now.getFullYear() - 1),
        build(now.getFullYear()),
        build(now.getFullYear() + 1)
    ].filter(Boolean);
    if (candidates.length === 0) return null;

    const distance = (date) => Math.abs(date.getTime() - now.getTime());
    return candidates.reduce((best, candidate) =>
        distance(candidate) < distance(best) ? candidate : best
    );
}
