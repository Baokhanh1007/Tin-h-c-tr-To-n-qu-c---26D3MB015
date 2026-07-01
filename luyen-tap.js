// ============================================================
//  luyen-tap.js — Logic phân hệ "Luyện tập"
//  Vanilla JS + Firebase Firestore (Modular SDK v12.15.0)
// ============================================================

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  onSnapshot,
  query,
  where,
  serverTimestamp,
  Timestamp,
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// ------------------------------------------------------------
// 1. CẤU HÌNH FIREBASE — dùng chung config với auth-guard.js
// ------------------------------------------------------------
const firebaseConfig = {
  apiKey:            "AIzaSyC-Y0wIv3YYvIdupGIjrtVylIvn7e0Yh0o",
  authDomain:        "tinht-9b5de.firebaseapp.com",
  projectId:         "tinht-9b5de",
  storageBucket:     "tinht-9b5de.firebasestorage.app",
  messagingSenderId: "197453039484",
  appId:             "1:197453039484:web:7ac38f6ca7d0178c06c6f9",
  measurementId:     "G-9FVLBG0TST"
};

// auth-guard.js đã gọi initializeApp() trước đó — tránh khởi tạo trùng lặp
const firebaseApp = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const examResultsCollection = collection(db, "exam_results");
// Collection lưu URL PDF đáp án — mỗi document dùng examId làm ID, field "pdfUrl"
const answerPdfsCollection = collection(db, "answer_pdfs");

// ------------------------------------------------------------
// 2. DỮ LIỆU CẤU HÌNH ĐỀ THI (MOCK DATA)
// ------------------------------------------------------------
// type: "tf"   -> câu Đúng/Sai   (2 phương án: dung, sai)
// type: "abcd" -> câu trắc nghiệm 4 phương án (A, B, C, D)
const EXAMS = [
  {
    examId: "exam001",
    title: "Tập hợp",
    subject: "Toán - Đại số 10",
    chapter: "Chương I: Đại số 10",
    pdfFile: "https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf",
    answerKeyFile: "dap-an-tap-hop.pdf",
    durationMinutes: 15,
    questions: [
      { id: 1, type: "tf" },
      { id: 2, type: "tf" },
      { id: 3, type: "tf" },
      { id: 4, type: "tf" },
      { id: 5, type: "tf" }
    ],
    correctAnswers: {
      1: "dung",
      2: "sai",
      3: "dung",
      4: "dung",
      5: "sai"
    }
  },
  {
    examId: "exam002",
    title: "Hệ bất phương trình bậc nhất hai ẩn",
    subject: "Toán - Đại số 10",
    chapter: "Chương I: Đại số 10",
    pdfFile: "https://www.africau.edu/images/default/sample.pdf",
    durationMinutes: 25,
    questions: [
      { id: 1, type: "tf" },
      { id: 2, type: "tf" },
      { id: 3, type: "tf" },
      { id: 4, type: "tf" },
      { id: 5, type: "abcd" },
      { id: 6, type: "abcd" },
      { id: 7, type: "abcd" },
      { id: 8, type: "abcd" },
      { id: 9, type: "abcd" },
      { id: 10, type: "abcd" }
    ],
    correctAnswers: {
      1: "dung",
      2: "dung",
      3: "sai",
      4: "dung",
      5: "A",
      6: "C",
      7: "B",
      8: "D",
      9: "A",
      10: "C"
    }
  }
];

// Cây thư mục: Chương -> Bài học -> examId tương ứng (null = chưa có đề)
const CHAPTER_TREE = [
  {
    name: "Chương I: Đại số 10",
    lessons: [
      { name: "Tập hợp", examId: "exam001" },
      { name: "Hệ bất phương trình bậc nhất hai ẩn", examId: "exam002" }
    ]
  },
  {
    name: "Chương II: Hình học 10",
    lessons: [
      { name: "Vector", examId: null },
      { name: "Tích vô hướng của hai vector", examId: null }
    ]
  }
];

function getExamById(examId) {
  return EXAMS.find(function (e) { return e.examId === examId; }) || null;
}

// ------------------------------------------------------------
// 3. TRẠNG THÁI TOÀN CỤC
// ------------------------------------------------------------
var currentExam = null;          // Đề thi đang được xem/làm
var selectedAnswers = {};        // { questionId: "dung" | "sai" | "A" | "B" | "C" | "D" }
var countdownIntervalId = null;  // ID của setInterval đếm ngược
var remainingSeconds = 0;
var examTotalSeconds = 0;
var examStartTimestamp = null;   // Date lúc bấm "Bắt đầu"
var currentExamResults = [];     // Cache toàn bộ bản ghi exam_results của đề đang xem (realtime)
var unsubscribeResultsListener = null; // Hàm hủy lắng nghe onSnapshot hiện tại
var isSubmitting = false;        // Chống double-submit
var answerPdfUrlCache = {};      // { examId: pdfUrl } — cache lại để không gọi Firestore lặp lại trong 1 phiên

// ------------------------------------------------------------
// 4. CHỜ window.__currentUser SẴN SÀNG (được set bất đồng bộ bởi auth-guard.js)
// ------------------------------------------------------------
function waitForCurrentUser() {
  return new Promise(function (resolve) {
    if (window.__currentUser && window.__currentUser.uid) {
      resolve(window.__currentUser);
      return;
    }
    var checkInterval = setInterval(function () {
      if (window.__currentUser && window.__currentUser.uid) {
        clearInterval(checkInterval);
        resolve(window.__currentUser);
      }
    }, 150);
  });
}

// ------------------------------------------------------------
// 5. ĐIỀU HƯỚNG MÀN HÌNH (Screen 1 / 2 / 3)
// ------------------------------------------------------------
function showScreen(screenNumber) {
  var screens = ["screen1", "screen2", "screen3"];
  screens.forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (id === "screen" + screenNumber) {
      el.classList.remove("d-none");
    } else {
      el.classList.add("d-none");
    }
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ------------------------------------------------------------
// 6. MÀN HÌNH 1 — RENDER CÂY THƯ MỤC (ACCORDION)
// ------------------------------------------------------------
function renderChapterTree() {
  var container = document.getElementById("chapterAccordion");
  if (!container) return;
  container.innerHTML = "";

  CHAPTER_TREE.forEach(function (chapter, chapterIndex) {
    var chapterCollapseId = "chapterCollapse" + chapterIndex;
    var headingId = "chapterHeading" + chapterIndex;

    var item = document.createElement("div");
    item.className = "accordion-item";

    var lessonsHtml = "";
    chapter.lessons.forEach(function (lesson) {
      var exam = lesson.examId ? getExamById(lesson.examId) : null;
      if (exam) {
        // Dropdown Bootstrap thay cho badge số câu — 2 lựa chọn: vào làm bài / xem đáp án PDF.
        // Không còn click vào toàn bộ hàng nữa, nên bỏ data-exam-id/handler ở div ngoài.
        var dropdownId = "lessonMenu_" + exam.examId;
        lessonsHtml +=
          '<div class="lt-lesson-row">' +
            '<span class="lt-lesson-name"><i class="bi bi-file-earmark-text me-2"></i>' + lesson.name + "</span>" +
            '<div class="dropdown lt-lesson-actions">' +
              '<button class="btn lt-btn-lesson-menu dropdown-toggle" type="button" id="' + dropdownId + '" ' +
                'data-bs-toggle="dropdown" aria-expanded="false">' +
                '<i class="bi bi-list-check me-1"></i>' + exam.questions.length + " câu" +
              "</button>" +
              '<ul class="dropdown-menu dropdown-menu-end lt-dropdown-menu" aria-labelledby="' + dropdownId + '">' +
                '<li><a class="dropdown-item lt-dropdown-item" href="#" data-action="enter-exam" data-exam-id="' + exam.examId + '">' +
                  '<i class="bi bi-pencil-square me-2"></i>Vào làm bài thi</a></li>' +
                '<li><a class="dropdown-item lt-dropdown-item" href="#" data-action="view-answer" data-exam-id="' + exam.examId + '">' +
                  '<i class="bi bi-journal-text me-2"></i>Xem đáp án (PDF)</a></li>' +
              "</ul>" +
            "</div>" +
          "</div>";
      } else {
        lessonsHtml +=
          '<div class="lt-lesson-row lt-lesson-disabled">' +
            '<span class="lt-lesson-name"><i class="bi bi-file-earmark-text me-2"></i>' + lesson.name + "</span>" +
            '<span class="lt-lesson-badge lt-badge-soon">Sắp ra mắt</span>' +
          "</div>";
      }
    });

    item.innerHTML =
      '<h2 class="accordion-header" id="' + headingId + '">' +
        '<button class="accordion-button ' + (chapterIndex === 0 ? "" : "collapsed") + '" type="button" ' +
          'data-bs-toggle="collapse" data-bs-target="#' + chapterCollapseId + '" ' +
          'aria-expanded="' + (chapterIndex === 0 ? "true" : "false") + '" aria-controls="' + chapterCollapseId + '">' +
          '<i class="bi bi-folder-fill lt-chapter-icon"></i>' + chapter.name +
        "</button>" +
      "</h2>" +
      '<div id="' + chapterCollapseId + '" class="accordion-collapse collapse ' + (chapterIndex === 0 ? "show" : "") + '" ' +
        'aria-labelledby="' + headingId + '" data-bs-parent="#chapterAccordion">' +
        '<div class="accordion-body">' + lessonsHtml + "</div>" +
      "</div>";

    container.appendChild(item);
  });

  // Gắn sự kiện bằng event delegation trên container (an toàn khi accordion render lại nhiều lần,
  // không tạo nhiều listener trùng lặp trên từng item con).
  if (!container.dataset.lessonMenuBound) {
    container.addEventListener("click", handleLessonMenuClick);
    container.dataset.lessonMenuBound = "true";
  }
}

// Xử lý click vào 2 mục trong dropdown của mỗi bài học (Vào làm bài / Xem đáp án PDF)
function handleLessonMenuClick(event) {
  var target = event.target.closest("[data-action]");
  if (!target) return;

  event.preventDefault();
  var action = target.getAttribute("data-action");
  var examId = target.getAttribute("data-exam-id");
  if (!examId) return;

  if (action === "enter-exam") {
    selectExam(examId);
  } else if (action === "view-answer") {
    openAnswerPdf(examId);
  }
}

// Mở PDF đáp án của bài học trong Modal — URL PDF được đọc động từ Firestore
// (collection "answer_pdfs", document ID = examId, field "pdfUrl"), có cache trong phiên làm việc.
async function openAnswerPdf(examId) {
  var exam = getExamById(examId);
  if (!exam) return;

  var titleEl = document.getElementById("answerPdfModalTitle");
  var frameEl = document.getElementById("answerPdfFrame");
  var openNewTabEl = document.getElementById("answerPdfOpenNewTab");
  var loadingEl = document.getElementById("answerPdfLoading");
  var errorEl = document.getElementById("answerPdfError");

  if (titleEl) titleEl.textContent = "Đáp án — " + exam.title;

  // Mở modal ngay, hiện trạng thái đang tải trong lúc chờ Firestore trả về
  var modalEl = document.getElementById("answerPdfModal");
  var modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  if (frameEl) frameEl.src = "";
  if (loadingEl) loadingEl.classList.remove("d-none");
  if (errorEl) errorEl.classList.add("d-none");
  modal.show();

  try {
    var pdfUrl = await getAnswerPdfUrl(examId);

    if (!pdfUrl) {
      if (loadingEl) loadingEl.classList.add("d-none");
      if (errorEl) errorEl.classList.remove("d-none");
      return;
    }

    if (frameEl) frameEl.src = pdfUrl;
    if (openNewTabEl) openNewTabEl.href = pdfUrl;
    if (loadingEl) loadingEl.classList.add("d-none");
  } catch (error) {
    console.error("Lỗi khi tải URL PDF đáp án từ Firestore:", error);
    if (loadingEl) loadingEl.classList.add("d-none");
    if (errorEl) errorEl.classList.remove("d-none");
  }
}

// Lấy URL PDF đáp án theo examId.
// Ưu tiên 1: cache trong phiên làm việc.
// Ưu tiên 2: file cục bộ khai báo sẵn trong EXAMS (answerKeyFile) — dùng cho demo, không cần Firestore.
// Ưu tiên 3: query Firestore (collection "answer_pdfs", document ID = examId, field "pdfUrl").
async function getAnswerPdfUrl(examId) {
  if (answerPdfUrlCache[examId]) {
    return answerPdfUrlCache[examId];
  }

  var exam = getExamById(examId);
  if (exam && exam.answerKeyFile) {
    answerPdfUrlCache[examId] = exam.answerKeyFile;
    return exam.answerKeyFile;
  }

  var docRef = doc(answerPdfsCollection, examId);
  var docSnap = await getDoc(docRef);

  if (!docSnap.exists()) {
    return null;
  }

  var pdfUrl = docSnap.data().pdfUrl;
  if (!pdfUrl) return null;

  answerPdfUrlCache[examId] = pdfUrl;
  return pdfUrl;
}

// ------------------------------------------------------------
// 7. MÀN HÌNH 2 — DASHBOARD BÀI THI
// ------------------------------------------------------------
function selectExam(examId) {
  var exam = getExamById(examId);
  if (!exam) return;

  currentExam = exam;
  selectedAnswers = {};

  document.getElementById("dashSubject").textContent = exam.subject;
  document.getElementById("dashTitle").textContent = exam.title;
  document.getElementById("dashQuestionCount").textContent = exam.questions.length;
  document.getElementById("dashDuration").textContent = exam.durationMinutes;

  showScreen(2);
  subscribeToExamResults(exam.examId);
}

// Lắng nghe realtime toàn bộ kết quả của đề thi hiện tại (chỉ 1 điều kiện equality -> không cần composite index)
function subscribeToExamResults(examId) {
  if (typeof unsubscribeResultsListener === "function") {
    unsubscribeResultsListener();
    unsubscribeResultsListener = null;
  }

  var resultsQuery = query(examResultsCollection, where("examId", "==", examId));

  unsubscribeResultsListener = onSnapshot(resultsQuery, function (snapshot) {
    currentExamResults = [];
    snapshot.forEach(function (docSnap) {
      var data = docSnap.data();
      data._docId = docSnap.id;
      currentExamResults.push(data);
    });

    renderStatisticsTab();
    renderRankingTab();
    renderHistoryTab();
  }, function (error) {
    console.error("Lỗi lắng nghe exam_results:", error);
  });
}

// ---------- TAB THỐNG KÊ ----------
function renderStatisticsTab() {
  var firstAttempts = currentExamResults.filter(function (r) { return r.isFirstAttempt === true; });

  var totalCandidates = firstAttempts.length;
  var avgScore = 0;
  var maxScore = 0;
  var avgTimeSeconds = 0;

  if (totalCandidates > 0) {
    var sumScore = 0;
    var sumTime = 0;
    firstAttempts.forEach(function (r) {
      sumScore += r.score || 0;
      sumTime += r.timeTakenSeconds || 0;
      if ((r.score || 0) > maxScore) maxScore = r.score;
    });
    avgScore = sumScore / totalCandidates;
    avgTimeSeconds = sumTime / totalCandidates;
  }

  document.getElementById("statTotalCandidates").textContent = totalCandidates;
  document.getElementById("statAvgScore").textContent = avgScore.toFixed(2);
  document.getElementById("statMaxScore").textContent = maxScore.toFixed(2);
  document.getElementById("statAvgTime").textContent = formatSecondsToClock(Math.round(avgTimeSeconds));

  renderDistributionTable(firstAttempts, totalCandidates);
}

function renderDistributionTable(firstAttempts, totalCandidates) {
  var tbody = document.getElementById("distributionTableBody");
  if (!tbody) return;

  var levels = [
    { label: "Giỏi", range: "8.0 - 10", min: 8, max: 10.01 },
    { label: "Khá", range: "6.5 - 7.9", min: 6.5, max: 8 },
    { label: "Trung bình", range: "5.0 - 6.4", min: 5, max: 6.5 },
    { label: "Yếu", range: "Dưới 5.0", min: -1, max: 5 }
  ];

  tbody.innerHTML = "";

  levels.forEach(function (level) {
    var count = firstAttempts.filter(function (r) {
      var s = r.score || 0;
      return s >= level.min && s < level.max;
    }).length;

    var percent = totalCandidates > 0 ? ((count / totalCandidates) * 100).toFixed(1) : "0.0";

    var tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + level.label + "</td>" +
      "<td>" + level.range + "</td>" +
      "<td>" + count + "</td>" +
      "<td>" + percent + "%</td>";
    tbody.appendChild(tr);
  });
}

// ---------- TAB BẢNG XẾP HẠNG ----------
function renderRankingTab() {
  var tbody = document.getElementById("rankingTableBody");
  if (!tbody) return;

  var ranked = currentExamResults
    .filter(function (r) { return r.isFirstAttempt === true; })
    .slice()
    .sort(function (a, b) {
      if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
      return (a.timeTakenSeconds || 0) - (b.timeTakenSeconds || 0);
    });

  if (ranked.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center lt-empty-row">Chưa có dữ liệu xếp hạng</td></tr>';
    return;
  }

  var currentUid = window.__currentUser ? window.__currentUser.uid : null;

  tbody.innerHTML = "";
  ranked.slice(0, 50).forEach(function (r, index) {
    var rank = index + 1;
    var rankBadgeClass = "lt-rank-badge";
    if (rank === 1) rankBadgeClass += " lt-rank-1";
    else if (rank === 2) rankBadgeClass += " lt-rank-2";
    else if (rank === 3) rankBadgeClass += " lt-rank-3";

    var tr = document.createElement("tr");
    if (currentUid && r.userId === currentUid) {
      tr.classList.add("lt-you-row");
    }

    tr.innerHTML =
      '<td><span class="' + rankBadgeClass + '">' + rank + "</span></td>" +
      "<td>" + escapeHtml(r.username || r.userEmail || "Ẩn danh") + "</td>" +
      "<td><strong>" + (r.score || 0).toFixed(2) + "</strong></td>" +
      "<td>" + formatSecondsToClock(r.timeTakenSeconds || 0) + "</td>" +
      "<td>" + formatTimestamp(r.submittedAt) + "</td>";
    tbody.appendChild(tr);
  });
}

// ---------- TAB LỊCH SỬ LÀM BÀI ----------
function renderHistoryTab() {
  var tbody = document.getElementById("historyTableBody");
  if (!tbody) return;

  var currentUid = window.__currentUser ? window.__currentUser.uid : null;

  var myAttempts = currentExamResults
    .filter(function (r) { return r.userId === currentUid; })
    .slice()
    .sort(function (a, b) {
      var ta = a.submittedAt && a.submittedAt.toMillis ? a.submittedAt.toMillis() : 0;
      var tb = b.submittedAt && b.submittedAt.toMillis ? b.submittedAt.toMillis() : 0;
      return tb - ta;
    });

  if (myAttempts.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center lt-empty-row">Bạn chưa làm bài thi này lần nào</td></tr>';
    return;
  }

  tbody.innerHTML = "";
  myAttempts.forEach(function (r, index) {
    var attemptNumber = myAttempts.length - index;
    var tr = document.createElement("tr");
    tr.innerHTML =
      "<td>Lần " + attemptNumber + (r.isFirstAttempt ? ' <span class="lt-lesson-badge">Tính xếp hạng</span>' : "") + "</td>" +
      "<td><strong>" + (r.score || 0).toFixed(2) + "</strong></td>" +
      "<td>" + formatTimestamp(r.submittedAt) + "</td>" +
      '<td><button class="lt-btn-delete-history" disabled title="Kết quả đã lưu vĩnh viễn"><i class="bi bi-eye me-1"></i>Đã lưu</button></td>';
    tbody.appendChild(tr);
  });
}

// ------------------------------------------------------------
// 8. MÀN HÌNH 3 — PHÒNG THI
// ------------------------------------------------------------
function enterExamRoom() {
  if (!currentExam) return;

  document.getElementById("waitTitle").textContent = currentExam.title;
  document.getElementById("waitQuestionCount").textContent = currentExam.questions.length;
  document.getElementById("waitDuration").textContent = currentExam.durationMinutes;

  document.getElementById("examWaiting").classList.remove("d-none");
  document.getElementById("examRoomSplit").classList.add("d-none");

  showScreen(3);
}

function startExam() {
  if (!currentExam) return;

  selectedAnswers = {};

  document.getElementById("examPdfFrame").src = currentExam.pdfFile;
  document.getElementById("totalQuestionCount").textContent = currentExam.questions.length;
  document.getElementById("answeredCount").textContent = "0";

  renderAnswerSheet();

  document.getElementById("examWaiting").classList.add("d-none");
  document.getElementById("examRoomSplit").classList.remove("d-none");

  examTotalSeconds = currentExam.durationMinutes * 60;
  remainingSeconds = examTotalSeconds;
  examStartTimestamp = new Date();

  startCountdown();
}

// Tự động sinh lưới câu hỏi trắc nghiệm theo cấu hình từng đề
function renderAnswerSheet() {
  var tbody = document.getElementById("answerSheetBody");
  tbody.innerHTML = "";

  currentExam.questions.forEach(function (q) {
    var tr = document.createElement("tr");
    tr.setAttribute("data-question-id", q.id);

    var optionsHtml = "";
    if (q.type === "tf") {
      optionsHtml =
        '<div class="lt-options-row">' +
          '<button type="button" class="lt-option-btn lt-option-true" data-question-id="' + q.id + '" data-value="dung">Đúng</button>' +
          '<button type="button" class="lt-option-btn lt-option-false" data-question-id="' + q.id + '" data-value="sai">Sai</button>' +
        "</div>";
    } else {
      ["A", "B", "C", "D"].forEach(function (letter) {
        optionsHtml +=
          '<button type="button" class="lt-option-btn" data-question-id="' + q.id + '" data-value="' + letter + '">' + letter + "</button>";
      });
      optionsHtml = '<div class="lt-options-row">' + optionsHtml + "</div>";
    }

    tr.innerHTML =
      '<td class="lt-question-label">Câu ' + q.id + "</td>" +
      "<td>" + optionsHtml + "</td>";

    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".lt-option-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var questionId = parseInt(btn.getAttribute("data-question-id"), 10);
      var value = btn.getAttribute("data-value");
      selectAnswer(questionId, value);
    });
  });
}

// Xử lý khi học sinh click chọn đáp án
function selectAnswer(questionId, value) {
  selectedAnswers[questionId] = value;

  // Bỏ active toàn bộ nút của câu này, sau đó gán active cho nút vừa chọn
  var row = document.querySelector('tr[data-question-id="' + questionId + '"]');
  if (row) {
    row.querySelectorAll(".lt-option-btn").forEach(function (b) {
      b.classList.remove("active");
    });
    var selectedBtn = row.querySelector('.lt-option-btn[data-value="' + value + '"]');
    if (selectedBtn) selectedBtn.classList.add("active");
  }

  updateProgressStatus();
}

function updateProgressStatus() {
  var answeredCount = Object.keys(selectedAnswers).length;
  document.getElementById("answeredCount").textContent = answeredCount;
}

// ---------- ĐỒNG HỒ ĐẾM NGƯỢC ----------
function startCountdown() {
  if (countdownIntervalId) clearInterval(countdownIntervalId);
  updateTimerDisplay();

  countdownIntervalId = setInterval(function () {
    remainingSeconds -= 1;

    if (remainingSeconds <= 0) {
      remainingSeconds = 0;
      updateTimerDisplay();
      clearInterval(countdownIntervalId);
      countdownIntervalId = null;
      // Hết giờ -> tự động nộp bài cưỡng bách, không cần xác nhận
      finalizeSubmission();
      return;
    }

    updateTimerDisplay();
  }, 1000);
}

function updateTimerDisplay() {
  var display = document.getElementById("timerDisplay");
  var progressBar = document.getElementById("timerProgressBar");
  if (!display) return;

  display.textContent = formatSecondsToClock(remainingSeconds);

  var percent = examTotalSeconds > 0 ? (remainingSeconds / examTotalSeconds) * 100 : 0;
  if (progressBar) progressBar.style.width = percent + "%";

  if (remainingSeconds <= 60) {
    display.classList.add("lt-timer-danger");
  } else {
    display.classList.remove("lt-timer-danger");
  }
}

function stopCountdown() {
  if (countdownIntervalId) {
    clearInterval(countdownIntervalId);
    countdownIntervalId = null;
  }
}

// ------------------------------------------------------------
// 9. NỘP BÀI — CHẤM ĐIỂM — LƯU FIRESTORE
// ------------------------------------------------------------
function openSubmitConfirmModal() {
  var modalEl = document.getElementById("confirmSubmitModal");
  var modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  modal.show();
}

function gradeExam() {
  var totalQuestions = currentExam.questions.length;
  var correctCount = 0;

  currentExam.questions.forEach(function (q) {
    var userAnswer = selectedAnswers[q.id];
    var correctAnswer = currentExam.correctAnswers[q.id];
    if (userAnswer && userAnswer === correctAnswer) {
      correctCount += 1;
    }
  });

  var score = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 10 * 100) / 100 : 0;
  var timeTakenSeconds = Math.max(0, examTotalSeconds - remainingSeconds);

  return {
    totalQuestions: totalQuestions,
    correctCount: correctCount,
    score: score,
    timeTakenSeconds: timeTakenSeconds
  };
}

async function finalizeSubmission() {
  if (isSubmitting || !currentExam) return;
  isSubmitting = true;
  stopCountdown();

  // Đóng modal xác nhận nếu đang mở
  var confirmModalEl = document.getElementById("confirmSubmitModal");
  var confirmModalInstance = bootstrap.Modal.getInstance(confirmModalEl);
  if (confirmModalInstance) confirmModalInstance.hide();

  var user = await waitForCurrentUser();
  var gradeResult = gradeExam();

  // Xác định lần làm đầu tiên hay không dựa trên cache realtime đã lắng nghe
  var hasPreviousAttempt = currentExamResults.some(function (r) {
    return r.userId === user.uid;
  });
  var isFirstAttempt = !hasPreviousAttempt;

  var resultRecord = {
    userId: user.uid,
    userEmail: user.email,
    username: user.username || (user.email ? user.email.split("@")[0] : "Học sinh"),
    examId: currentExam.examId,
    examTitle: currentExam.title,
    totalQuestions: gradeResult.totalQuestions,
    correctCount: gradeResult.correctCount,
    score: gradeResult.score,
    timeTakenSeconds: gradeResult.timeTakenSeconds,
    isFirstAttempt: isFirstAttempt,
    submittedAt: serverTimestamp()
  };

  try {
    await addDoc(examResultsCollection, resultRecord);
  } catch (error) {
    console.error("Lỗi khi lưu kết quả bài thi vào Firestore:", error);
    alert("Đã xảy ra lỗi khi lưu kết quả bài thi. Vui lòng kiểm tra kết nối mạng và thử lại.");
    isSubmitting = false;
    return;
  }

  showResultModal(gradeResult, isFirstAttempt, resultRecord, user);
  isSubmitting = false;
}

function computeLiveRank(user, gradeResult, isFirstAttempt) {
  if (!isFirstAttempt) return null;

  var firstAttempts = currentExamResults.filter(function (r) {
    return r.isFirstAttempt === true && r.userId !== user.uid;
  });

  // Chèn kết quả vừa nộp vào danh sách tạm để tính hạng ngay lập tức
  firstAttempts.push({
    userId: user.uid,
    score: gradeResult.score,
    timeTakenSeconds: gradeResult.timeTakenSeconds
  });

  firstAttempts.sort(function (a, b) {
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    return (a.timeTakenSeconds || 0) - (b.timeTakenSeconds || 0);
  });

  var rankIndex = firstAttempts.findIndex(function (r) {
    return r.userId === user.uid && r.score === gradeResult.score && r.timeTakenSeconds === gradeResult.timeTakenSeconds;
  });

  return rankIndex >= 0 ? rankIndex + 1 : null;
}

function showResultModal(gradeResult, isFirstAttempt, resultRecord, user) {
  document.getElementById("resultCorrectCount").textContent = gradeResult.correctCount + "/" + gradeResult.totalQuestions;
  document.getElementById("resultScore").textContent = gradeResult.score.toFixed(2);
  document.getElementById("resultTime").textContent = formatSecondsToClock(gradeResult.timeTakenSeconds);

  var rankEl = document.getElementById("resultRank");
  var noteEl = document.getElementById("resultNote");

  if (isFirstAttempt) {
    var rank = computeLiveRank(user, gradeResult, isFirstAttempt);
    rankEl.textContent = rank ? "#" + rank : "--";
    noteEl.textContent = "Đây là lần làm bài đầu tiên của bạn — kết quả đã được tính vào Bảng xếp hạng chung.";
  } else {
    rankEl.textContent = "Không xếp hạng";
    noteEl.textContent = "Bạn đã làm bài thi này trước đó, nên lần làm này không được tính vào Bảng xếp hạng chung. Kết quả vẫn được lưu đầy đủ trong Lịch sử làm bài.";
  }

  var modalEl = document.getElementById("resultModal");
  var modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  modal.show();
}

function backToDashboardFromResult() {
  var resultModalEl = document.getElementById("resultModal");
  var modal = bootstrap.Modal.getInstance(resultModalEl);
  if (modal) modal.hide();

  // Reset trạng thái phòng thi
  stopCountdown();
  selectedAnswers = {};
  document.getElementById("examRoomSplit").classList.add("d-none");
  document.getElementById("examWaiting").classList.remove("d-none");

  showScreen(2);
}

// ------------------------------------------------------------
// 10. TIỆN ÍCH ĐỊNH DẠNG
// ------------------------------------------------------------
function formatSecondsToClock(totalSeconds) {
  totalSeconds = Math.max(0, Math.round(totalSeconds || 0));
  var minutes = Math.floor(totalSeconds / 60);
  var seconds = totalSeconds % 60;
  var mm = minutes < 10 ? "0" + minutes : String(minutes);
  var ss = seconds < 10 ? "0" + seconds : String(seconds);
  return mm + ":" + ss;
}

function formatTimestamp(ts) {
  if (!ts) return "--";
  var date;
  if (ts instanceof Timestamp) {
    date = ts.toDate();
  } else if (ts.toDate) {
    date = ts.toDate();
  } else {
    return "--";
  }
  var dd = String(date.getDate()).padStart(2, "0");
  var mm = String(date.getMonth() + 1).padStart(2, "0");
  var yyyy = date.getFullYear();
  var hh = String(date.getHours()).padStart(2, "0");
  var min = String(date.getMinutes()).padStart(2, "0");
  return hh + ":" + min + " - " + dd + "/" + mm + "/" + yyyy;
}

function escapeHtml(text) {
  var div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ------------------------------------------------------------
// 11. GẮN SỰ KIỆN KHỞI TẠO TRANG
// ------------------------------------------------------------
document.addEventListener("DOMContentLoaded", function () {
  renderChapterTree();
  showScreen(1);

  document.getElementById("btnBackToScreen1").addEventListener("click", function () {
    if (typeof unsubscribeResultsListener === "function") {
      unsubscribeResultsListener();
      unsubscribeResultsListener = null;
    }
    currentExam = null;
    showScreen(1);
  });

  document.getElementById("btnEnterExamRoom").addEventListener("click", enterExamRoom);

  document.getElementById("btnBackToScreen2FromWaiting").addEventListener("click", function () {
    showScreen(2);
  });

  document.getElementById("btnStartExam").addEventListener("click", startExam);

  document.getElementById("btnSubmitExam").addEventListener("click", openSubmitConfirmModal);

  document.getElementById("btnConfirmFinish").addEventListener("click", finalizeSubmission);

  document.getElementById("btnBackFromResult").addEventListener("click", backToDashboardFromResult);

  // Đăng nhập tên tài khoản lên navbar (dự phòng nếu auth-guard.js chưa kịp xử lý)
  waitForCurrentUser().then(function (user) {
    var nameEl = document.getElementById("nav-name");
    if (nameEl) nameEl.textContent = user.username;
  });

  // Xóa src của iframe PDF đáp án khi modal đóng lại — tránh PDF vẫn nằm trong bộ nhớ/tải ngầm
  var answerPdfModalEl = document.getElementById("answerPdfModal");
  if (answerPdfModalEl) {
    answerPdfModalEl.addEventListener("hidden.bs.modal", function () {
      var frameEl = document.getElementById("answerPdfFrame");
      var loadingEl = document.getElementById("answerPdfLoading");
      var errorEl = document.getElementById("answerPdfError");
      if (frameEl) frameEl.src = "";
      if (loadingEl) loadingEl.classList.add("d-none");
      if (errorEl) errorEl.classList.add("d-none");
    });
  }
});