import test from 'node:test';
import assert from 'node:assert/strict';

import { isBrowserGone, ScheduleNotSetError } from '../run-errors.js';

// --- isBrowserGone: chép nguyên văn từ automation.log ---
//
// Vế "phải dừng" lấy từ phiên 2026-09-10 của user73412133517231, lúc cửa sổ
// Chromium bị đóng giữa chừng: sáu bước liên tiếp cùng ném ra một trong những
// thông điệp này trong 14 mili-giây, và cả sáu đều bị nuốt.

const TERMINAL_MESSAGES = [
    'page.waitForTimeout: Target page, context or browser has been closed',
    'page.waitForSelector: Target page, context or browser has been closed',
    'page.$: Target page, context or browser has been closed',
    'locator.waitFor: Target page, context or browser has been closed',
    'browserContext.newPage: Target page, context or browser has been closed',
    'elementHandle.isVisible: Target closed'
];

// Vế "phải chạy tiếp" cũng lấy từ log thật. Đây là những trục trặc đáng thử
// lại; dừng lượt vì chúng thì mỗi cú nghẽn mạng thoáng qua lại giết một lượt.
const RETRYABLE_MESSAGES = [
    'locator.waitFor: Timeout 15000ms exceeded.',
    'No visible schedule inputs found',
    'elementHandle.click: Timeout 30000ms exceeded.',
    'page.goto: net::ERR_INTERNET_DISCONNECTED',
    'Upload page components not found. Page might be too slow or blocked.',
    'Search input not found in the Sounds panel.'
];

test('isBrowserGone nhận ra mọi cách Playwright báo trang đã đóng', () => {
    for (const message of TERMINAL_MESSAGES) {
        assert.equal(isBrowserGone(new Error(message)), true, `bỏ sót: ${message}`);
    }
});

test('isBrowserGone không dừng lượt vì những lỗi đáng thử lại', () => {
    for (const message of RETRYABLE_MESSAGES) {
        assert.equal(isBrowserGone(new Error(message)), false, `dừng nhầm: ${message}`);
    }
});

test('isBrowserGone chịu được thứ không phải Error', () => {
    for (const value of [null, undefined, 42, {}, 'Target closed']) {
        assert.doesNotThrow(() => isBrowserGone(value), `ném lỗi với ${String(value)}`);
    }
    // Chuỗi trần không có .message nên không khớp — chỗ gọi luôn đưa vào Error.
    assert.equal(isBrowserGone(null), false);
    assert.equal(isBrowserGone({ message: 'Target closed' }), true);
});

// --- ScheduleNotSetError ---

test('ScheduleNotSetError là Error và tự nhận diện được', () => {
    const err = new ScheduleNotSetError('không đặt được lịch cho video 2');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof ScheduleNotSetError);
    assert.equal(err.name, 'ScheduleNotSetError');
    assert.equal(err.message, 'không đặt được lịch cho video 2');
});

test('ScheduleNotSetError không bị isBrowserGone nhận nhầm', () => {
    // Hai chốt chặn phải tách bạch: lỗi lên lịch dừng lượt theo đường riêng
    // của nó, không đi nhờ đường của lỗi browser-đã-đóng.
    assert.equal(isBrowserGone(new ScheduleNotSetError('No visible schedule inputs found')), false);
});
