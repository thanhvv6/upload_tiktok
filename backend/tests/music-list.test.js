import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parseMusicList,
    pickMusicAt,
    nextMusicIndex,
    wrapIndex,
    normalizeMusicText,
    musicEntryMatches
} from '../music-list.js';

test('parseMusicList treats a single line as a one-song list', () => {
    assert.deepEqual(parseMusicList('Chill Lofi Beat'), ['Chill Lofi Beat']);
});

test('parseMusicList splits on newlines and keeps the order typed', () => {
    assert.deepEqual(
        parseMusicList('bai mot\nbai hai\nbai ba'),
        ['bai mot', 'bai hai', 'bai ba']
    );
});

test('parseMusicList accepts pipes so one CSV cell can hold several songs', () => {
    assert.deepEqual(parseMusicList('bai mot|bai hai'), ['bai mot', 'bai hai']);
});

test('parseMusicList drops blank lines and surrounding spaces', () => {
    assert.deepEqual(
        parseMusicList('  bai mot  \n\n\r\n   \n bai hai\n'),
        ['bai mot', 'bai hai']
    );
});

test('parseMusicList returns an empty list for empty or non-string values', () => {
    for (const value of ['', '   ', '\n\n', null, undefined, 42]) {
        assert.deepEqual(parseMusicList(value), [], `failed for ${JSON.stringify(value)}`);
    }
});

test('parseMusicList keeps a repeated song, since repeating is a valid schedule', () => {
    assert.deepEqual(parseMusicList('bai mot\nbai hai\nbai mot'), ['bai mot', 'bai hai', 'bai mot']);
});

test('pickMusicAt walks the list one video at a time', () => {
    const list = ['a', 'b', 'c'];
    assert.equal(pickMusicAt(list, 0), 'a');
    assert.equal(pickMusicAt(list, 1), 'b');
    assert.equal(pickMusicAt(list, 2), 'c');
});

test('pickMusicAt wraps back to the first song once the list runs out', () => {
    const list = ['a', 'b', 'c'];
    assert.equal(pickMusicAt(list, 3), 'a');
    assert.equal(pickMusicAt(list, 4), 'b');
    assert.equal(pickMusicAt(list, 10), 'b');
});

test('pickMusicAt returns null when there is no song configured', () => {
    assert.equal(pickMusicAt([], 0), null);
    assert.equal(pickMusicAt(null, 0), null);
});

test('pickMusicAt treats a broken cursor as the start of the list', () => {
    const list = ['a', 'b'];
    for (const cursor of [-5, NaN, undefined, null, 'x']) {
        assert.equal(pickMusicAt(list, cursor), 'a', `failed for ${String(cursor)}`);
    }
});

test('nextMusicIndex advances and folds back inside the list', () => {
    const list = ['a', 'b', 'c'];
    assert.equal(nextMusicIndex(list, 0), 1);
    assert.equal(nextMusicIndex(list, 1), 2);
    assert.equal(nextMusicIndex(list, 2), 0);
});

test('nextMusicIndex keeps a saved cursor small over many runs', () => {
    const list = ['a', 'b', 'c'];
    let cursor = 0;
    for (let video = 0; video < 100; video++) {
        cursor = nextMusicIndex(list, cursor);
        assert.ok(cursor >= 0 && cursor < list.length, `cursor escaped the list: ${cursor}`);
    }
});

test('nextMusicIndex stays at zero when no song is configured', () => {
    assert.equal(nextMusicIndex([], 3), 0);
    assert.equal(nextMusicIndex(null, 3), 0);
});

test('six songs at four videos a run: run two starts on song 5 and wraps past song 6', () => {
    const list = parseMusicList('bai 1\nbai 2\nbai 3\nbai 4\nbai 5\nbai 6');

    let cursor = 0;
    const run = () => {
        const played = [];
        for (let video = 0; video < 4; video++) {
            played.push(pickMusicAt(list, cursor));
            cursor = nextMusicIndex(list, cursor);
        }
        return played;
    };

    assert.deepEqual(run(), ['bai 1', 'bai 2', 'bai 3', 'bai 4']);
    assert.deepEqual(run(), ['bai 5', 'bai 6', 'bai 1', 'bai 2']);
    assert.deepEqual(run(), ['bai 3', 'bai 4', 'bai 5', 'bai 6']);
    // Ba lượt bốn video đi trọn hai vòng danh sách sáu bài, nên con trỏ về lại
    // đúng vạch xuất phát — không bài nào bị bỏ, không bài nào dùng thừa lượt.
    assert.equal(cursor, 0);
});

test('a five-video run over ten songs continues where the previous run stopped', () => {
    const list = Array.from({ length: 10 }, (_, i) => `bai ${i + 1}`);

    const run = (start, videoCount) => {
        let cursor = start;
        const played = [];
        for (let video = 0; video < videoCount; video++) {
            played.push(pickMusicAt(list, cursor));
            cursor = nextMusicIndex(list, cursor);
        }
        return { played, cursor };
    };

    const first = run(0, 5);
    assert.deepEqual(first.played, ['bai 1', 'bai 2', 'bai 3', 'bai 4', 'bai 5']);

    const second = run(first.cursor, 5);
    assert.deepEqual(second.played, ['bai 6', 'bai 7', 'bai 8', 'bai 9', 'bai 10']);

    const third = run(second.cursor, 2);
    assert.deepEqual(third.played, ['bai 1', 'bai 2']);
});

// --- wrapIndex: phép quay vòng dùng chung cho danh sách và cho tab Favorites ---

test('wrapIndex folds a cursor into the item count', () => {
    assert.equal(wrapIndex(6, 0), 0);
    assert.equal(wrapIndex(6, 5), 5);
    assert.equal(wrapIndex(6, 6), 0);
    assert.equal(wrapIndex(6, 13), 1);
});

test('wrapIndex treats a missing or broken count as nothing to pick', () => {
    for (const count of [0, -3, NaN, undefined, null, 'x']) {
        assert.equal(wrapIndex(count, 4), 0, `failed for ${String(count)}`);
    }
});

test('wrapIndex treats a broken cursor as the start', () => {
    for (const cursor of [-5, NaN, undefined, null, 'x']) {
        assert.equal(wrapIndex(4, cursor), 0, `failed for ${String(cursor)}`);
    }
});

test('wrapIndex drives the favorites tab the same way it drives the song list', () => {
    // Tab Favorites chỉ cho biết số mục, không có mảng — nhưng con trỏ phải đi
    // đúng nhịp như khi chạy trên danh sách, để bật/tắt tuỳ chọn không nhảy bài.
    const favouriteCount = 3;
    let cursor = 0;
    const visited = [];
    for (let video = 0; video < 7; video++) {
        visited.push(wrapIndex(favouriteCount, cursor));
        cursor = wrapIndex(favouriteCount, cursor + 1);
    }
    assert.deepEqual(visited, [0, 1, 2, 0, 1, 2, 0]);
});

// --- normalizeMusicText ---

test('normalizeMusicText reduces punctuation and case to plain words', () => {
    assert.equal(normalizeMusicText("Siren's Song - Gilang Galang"), 'siren s song gilang galang');
    assert.equal(normalizeMusicText('04:00 · Gilang Galang'), '04 00 gilang galang');
});

test('normalizeMusicText keeps Vietnamese letters intact', () => {
    assert.equal(normalizeMusicText('Yêu Thích — Mùa Hạ'), 'yêu thích mùa hạ');
});

test('normalizeMusicText joins a name whose marks arrive separated', () => {
    // Cùng một cái tên, hai dạng Unicode: dạng gộp và dạng tách rời (NFD, thứ
    // macOS dùng cho tên file). Dấu tách rời là \p{Mn}, nên trước khi có NFKC
    // nó bị biến thành khoảng trắng và cắt đôi từ.
    assert.equal(normalizeMusicText('ばら色の朝'.normalize('NFD')), 'ばら色の朝');
    assert.equal(
        normalizeMusicText('ばら色の朝'.normalize('NFD')),
        normalizeMusicText('ばら色の朝'.normalize('NFC'))
    );
    assert.equal(normalizeMusicText('Yêu Thích'.normalize('NFD')), 'yêu thích');
});

test('normalizeMusicText folds full-width and half-width spellings together', () => {
    assert.equal(normalizeMusicText('Ｓａｔｏ Ｈａｒｕｋｉ'), 'sato haruki');
    assert.equal(normalizeMusicText('ﾊﾞﾗ色の朝'), normalizeMusicText('バラ色の朝'));
});

test('normalizeMusicText keeps a Japanese title whole, since it has no spaces', () => {
    // Không có dấu cách nên cả tên bài là MỘT từ — lệch một chữ là khác hẳn,
    // đúng thứ giữ cho 古道の足音 không bị nhận nhầm thành 里道の足音.
    assert.equal(normalizeMusicText('里道の足音 - Sato Haruki'), '里道の足音 sato haruki');
    assert.equal(normalizeMusicText('波光る浜辺'), '波光る浜辺');
});

test('normalizeMusicText survives non-string input', () => {
    for (const value of [null, undefined, 42, {}]) {
        assert.equal(normalizeMusicText(value), '', `failed for ${String(value)}`);
    }
});

// --- musicEntryMatches: đối chiếu với kết quả thật quét được từ TikTok ---
//
// Search "Siren's Song - Gilang Galang" trong panel Sounds trả về đúng ba kết
// quả dưới đây. Kết quả thứ ba trùng tên bài nhưng KHÁC ca sĩ — đúng cái bẫy
// khiến việc lấy bừa kết quả đầu là sai.

const REAL_RESULTS = [
    { title: "Siren's Song", desc: '04:00 · Gilang Galang' },
    { title: "Siren's Song", desc: '00:17 · Gilang Galang' },
    { title: "Siren's Song", desc: '01:00 · Purrple Cat' }
];

test('musicEntryMatches accepts the versions by the right artist', () => {
    const entry = "Siren's Song - Gilang Galang";
    assert.equal(musicEntryMatches(entry, REAL_RESULTS[0].title, REAL_RESULTS[0].desc), true);
    assert.equal(musicEntryMatches(entry, REAL_RESULTS[1].title, REAL_RESULTS[1].desc), true);
});

test('musicEntryMatches rejects the same title by a different artist', () => {
    const entry = "Siren's Song - Gilang Galang";
    assert.equal(musicEntryMatches(entry, REAL_RESULTS[2].title, REAL_RESULTS[2].desc), false);
});

test('the first matching result is the 04:00 version, not the Purrple Cat one', () => {
    const entry = "Siren's Song - Gilang Galang";
    const hit = REAL_RESULTS.find((r) => musicEntryMatches(entry, r.title, r.desc));
    assert.deepEqual(hit, REAL_RESULTS[0]);
});

test('musicEntryMatches ignores case differences the user typed', () => {
    // Dữ liệu thật của anh có dòng gõ thường hết.
    assert.equal(musicEntryMatches('digital dawn - gilang galang', 'Digital Dawn', '02:41 · Gilang Galang'), true);
});

test('musicEntryMatches catches the missing letter in a mistyped artist', () => {
    // 11 profile đang khai "Gilang Glang" thiếu chữ a — luật này bắt được.
    assert.equal(
        musicEntryMatches('The Moments We Cherish - Gilang Glang', 'The Moments We Cherish', '03:12 · Gilang Galang'),
        false
    );
    assert.equal(
        musicEntryMatches('The Moments We Cherish - Gilang Galang', 'The Moments We Cherish', '03:12 · Gilang Galang'),
        true
    );
});

test('musicEntryMatches compares whole words, not substrings', () => {
    assert.equal(musicEntryMatches('song - artist', 'Songbird', '01:00 · Artistry'), false);
});

test('musicEntryMatches refuses an empty entry rather than matching everything', () => {
    for (const entry of ['', '   ', null, undefined]) {
        assert.equal(musicEntryMatches(entry, 'Anything', '00:10 · Someone'), false, `failed for ${String(entry)}`);
    }
});

test('musicEntryMatches handles a result whose fields are missing', () => {
    assert.equal(musicEntryMatches('some song', null, undefined), false);
});

// --- Tên bài tiếng Nhật: kết quả thật quét từ panel Sounds ---
//
// Bảy bài của Sato Haruki được tìm thử trên profile user373253976869; những
// dòng dưới đây chép nguyên văn tiêu đề và mô tả TikTok trả về. Đáng chú ý:
// TikTok ghi tên ca sĩ bằng romaji chứ không phải chữ Nhật, nên tên ca sĩ khai
// theo romaji là khớp; và có một bài TRÙNG TÊN 山霧の朝 của ca sĩ khác — đúng
// cái bẫy mà phép đối chiếu sinh ra để tránh.

const REAL_JAPANESE_RESULTS = [
    { title: '里道の足音', desc: '00:29 · Sato Haruki' },
    { title: '春光の町', desc: '00:27 · Sato Haruki' },
    { title: '山川のふるさと', desc: '00:35 · Sato Haruki' },
    { title: '古里の青空', desc: '00:28 · Sato Haruki' },
    { title: '山霧の朝', desc: '00:28 · Sato Haruki' },
    { title: '波光る浜辺', desc: '00:27 · Sato Haruki' },
    { title: '夕霞の村', desc: '00:43 · Sato Haruki' }
];

test('musicEntryMatches finds each Japanese title among the real results', () => {
    for (const song of REAL_JAPANESE_RESULTS) {
        const entry = `${song.title} - Sato Haruki`;
        const hit = REAL_JAPANESE_RESULTS.find((r) => musicEntryMatches(entry, r.title, r.desc));
        assert.deepEqual(hit, song, `sai bài cho "${entry}"`);
    }
});

test('musicEntryMatches rejects the same Japanese title by a different artist', () => {
    // Tìm 山霧の朝 trả về cả bài của 7n7e đứng ngay sau bài của Sato Haruki.
    assert.equal(musicEntryMatches('山霧の朝 - Sato Haruki', '山霧の朝', '01:00 · 7n7e'), false);
});

test('musicEntryMatches rejects a Japanese title that differs by one character', () => {
    // 古道の足音 và 里道の足音 khác đúng một chữ kanji; cả hai cùng ra trong một
    // lần tìm, nên nhận nhầm là đăng sai nhạc.
    assert.equal(
        musicEntryMatches('里道の足音 - Sato Haruki', '古道の足音 ・ Footsteps on the Old Road', '01:00 · Lo-Fi 1992'),
        false
    );
});

test('musicEntryMatches still matches a Japanese entry written without the dash', () => {
    // Dấu gạch chỉ là ký tự phân tách trong mắt phép chuẩn hoá, không phải cú pháp.
    for (const entry of ['里道の足音 - Sato Haruki', '里道の足音 Sato Haruki', '里道の足音・Sato Haruki']) {
        assert.equal(musicEntryMatches(entry, '里道の足音', '00:29 · Sato Haruki'), true, `failed for ${entry}`);
    }
});

test('musicEntryMatches survives a Japanese entry pasted in the decomposed form', () => {
    // Anh dán tên bài từ Finder ra thì chuỗi ở dạng NFD, còn TikTok trả về dạng
    // gộp — trước khi có NFKC thì hai bên không bao giờ gặp nhau và cả lượt chạy
    // dừng lại mà không rõ vì sao.
    const entry = 'ばら色の朝 - Sato Haruki'.normalize('NFD');
    assert.equal(musicEntryMatches(entry, 'ばら色の朝', '00:30 · Sato Haruki'), true);
});
